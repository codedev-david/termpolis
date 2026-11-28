import { useCallback, useEffect, useRef, useState } from 'react'
import { createVoiceEngine } from '../lib/voice/voiceEngines'
import { processVoiceResult, resampleTo16k, analyzeCapture, computeDisplayLevel, normalizeAudioGain, isNoSpeechTranscript, isHallucinatedFiller, type CaptureAnalysis } from '../lib/voice/voicePipeline'
import type { VoiceEngine } from '../lib/voice/voiceTypes'
import { useTerminalStore } from '../store/terminalStore'

export type VoiceStatus = 'idle' | 'listening' | 'transcribing' | 'error'
export interface VoiceConfirm {
  text: string
}

/** The longest one recording runs before it stops by itself and is transcribed. */
export const MAX_RECORDING_MS = 5 * 60 * 1000
/** Shown when the mic's track ends mid-recording (unplugged). SIGNED OFF 2026-11-27 (signoff-decisions.md). */
export const MIC_DISCONNECTED_MESSAGE = 'The microphone was disconnected. Plug it back in, or choose another one in Settings → Voice.'
/** The notice when a recording reaches MAX_RECORDING_MS. SIGNED OFF 2026-11-27 (signoff-decisions.md) (B10). */
export const RECORDING_CAP_MESSAGE = 'Recording stopped at the 5-minute limit. What you said up to then was transcribed.'

/** What useVoiceInput hands its caller. */
export interface VoiceInputControls {
  status: VoiceStatus
  listening: boolean
  level: number
  lastCapture: CaptureAnalysis | null
  confirm: VoiceConfirm | null
  errorMsg: string | null
  /** Information, not an error: the 5-minute cap stopped the recording. Show it quietly, whatever the
   *  status. The next start() and cancel() clear it. */
  notice: string | null
  toggle: () => void
  start: () => Promise<void>
  stop: () => Promise<void>
  /** Abandons whatever is in flight: a mic still starting, a recording (its audio is dropped, not
   *  transcribed) and a transcription (its text, or error, never arrives). An error on show stays;
   *  the cap notice goes. */
  cancel: () => void
  confirmRun: (submit: boolean) => void
  cancelConfirm: () => void
  clearError: () => void
  dispose: () => void
}

function describeVoiceError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? '')
  return msg || 'Voice transcription failed.'
}

/** User-facing guidance when the capture held no usable speech — includes the
 *  measured level so a failure is legible (and reportable) instead of silent. */
function noSpeechMessage(a: CaptureAnalysis): string {
  const lvl = a.peak.toFixed(4)
  if (a.verdict === 'noise') {
    return `Heard background noise, not speech (level ${lvl}). Move closer or speak up, or pick your microphone in Settings → Voice.`
  }
  return `No speech detected (level ${lvl}). Hold the key, speak, then release — and watch the level meter. If it didn't move, choose your microphone in Settings → Voice.`
}

/**
 * Voice dictation for one terminal. Tap the push-to-talk key to start/stop
 * listening; on stop the captured audio is resampled to 16kHz and transcribed
 * by the configured engine, then routed by the (tested) pipeline: agent
 * terminals get the text injected; plain shells surface a confirm-before-run
 * bar so a mis-heard command never executes on its own.
 *
 * NOTE: audio capture (getUserMedia/AudioContext) needs a real browser/Electron
 * runtime + microphone — it is exercised by manual/e2e smoke testing, not the
 * headless unit suite. The transcription→action decision (processVoiceResult)
 * and the engines are unit-tested separately.
 */
export function useVoiceInput(
  terminalId: string | null,
  agentDetected: boolean,
  opts?: { onTranscript?: (text: string) => void },
): VoiceInputControls {
  // Optional sink (Lumopolis Ask bar): the cleaned transcript goes here instead of a terminal.
  const sinkRef = useRef(opts?.onTranscript)
  sinkRef.current = opts?.onTranscript
  const voiceSettings = useTerminalStore((s) => s.voiceSettings)
  // After dictation stops, hand keyboard focus back to the active terminal's input
  // line so the user can immediately type or start another dictation — otherwise
  // focus is stranded on the mic button / Listening badge that was last clicked.
  const focusActiveTerminal = useTerminalStore((s) => s.focusActiveTerminal)
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [confirm, setConfirm] = useState<VoiceConfirm | null>(null)
  // Human-readable reason when status === 'error'. Surfaced in the UI so a failed
  // transcription is never silent (the old behaviour: "I talk and nothing shows up").
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Live input level (0..1) for the on-screen meter while listening, and the
  // analysis of the last captured clip (level + verdict) for diagnostics. These
  // turn the previously-invisible capture path into something the user can SEE.
  const [level, setLevel] = useState(0)
  const [lastCapture, setLastCapture] = useState<CaptureAnalysis | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  // AnalyserNode + timer drive the live level meter; refs so cleanup can stop them.
  const analyserRef = useRef<AnalyserNode | null>(null)
  const levelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const levelBufRef = useRef<Float32Array<ArrayBuffer> | null>(null)
  const pcmChunksRef = useRef<Float32Array[]>([])
  const engineRef = useRef<VoiceEngine | null>(null)
  // Refs so the async capture callbacks always read current values.
  const settingsRef = useRef(voiceSettings)
  settingsRef.current = voiceSettings
  const agentRef = useRef(agentDetected)
  agentRef.current = agentDetected
  const listeningRef = useRef(false)
  // getUserMedia is async, so there's a window between start() being called and
  // the mic actually coming up. `startingRef` marks that window; `cancelStartRef`
  // lets a stop() that lands inside it abort the pending start — otherwise the
  // stop no-ops and the mic gets stuck "listening" with no way to end it.
  const startingRef = useRef(false)
  const cancelStartRef = useRef(false)
  // Generations. A capture's number moves on with every start(), cancel() and dispose(): a start()
  // that finds it moved after an await was abandoned, and releases what it opened without setting
  // state. A transcription carries the number it began with and is dropped, with no state update and
  // no delivery, once that number has moved. cancel() always moves it. A new start() and dispose()
  // move it only with a sink (the Ask bar), where a late transcript would be asked on its own;
  // terminal dictation keeps delivering an earlier clip's text, as it always has.
  const captureGenRef = useRef(0)
  const transcribeGenRef = useRef(0)
  const capTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inject = useCallback((text: string, autoSubmit: boolean) => {
    if (!text || !terminalId) return
    window.termpolis.writeToTerminal(terminalId, text + (autoSubmit ? '\r' : ''))
  }, [terminalId])

  const cleanupCapture = useCallback(() => {
    if (levelTimerRef.current != null) {
      clearInterval(levelTimerRef.current)
      levelTimerRef.current = null
    }
    if (capTimerRef.current != null) {
      clearTimeout(capTimerRef.current)
      capTimerRef.current = null
    }
    try { analyserRef.current?.disconnect() } catch { /* already gone */ }
    try { processorRef.current?.disconnect() } catch { /* already gone */ }
    try { audioCtxRef.current?.close() } catch { /* already closed */ }
    streamRef.current?.getTracks().forEach((t) => { t.onended = null; t.stop() })
    analyserRef.current = null
    processorRef.current = null
    audioCtxRef.current = null
    streamRef.current = null
    setLevel(0)
  }, [])

  // Drive the live meter from the analyser at ~30fps while listening. setInterval
  // (not rAF) so a synchronous rAF stub in tests can't recurse, and updates state
  // only on a visible change to bound re-renders. With no audio (the jsdom test
  // path) the level reads 0 and the change-guard suppresses re-renders entirely.
  const startLevelLoop = useCallback(() => {
    const id = setInterval(() => {
      const an = analyserRef.current
      if (!an) return
      const buf = levelBufRef.current && levelBufRef.current.length === an.fftSize
        ? levelBufRef.current
        : (levelBufRef.current = new Float32Array(an.fftSize))
      an.getFloatTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
      const next = computeDisplayLevel(Math.sqrt(sum / buf.length))
      setLevel((prev) => (Math.abs(next - prev) > 0.03 ? next : prev))
    }, 33)
    levelTimerRef.current = id
  }, [])

  // Lazily build the engine; reused by warm-up (on record start) and transcribe.
  const ensureEngine = useCallback(async (): Promise<VoiceEngine> => {
    if (!engineRef.current) engineRef.current = createVoiceEngine(settingsRef.current)
    return engineRef.current
  }, [])

  const transcribe = useCallback(async (pcm16k: Float32Array, gen: number) => {
    setStatus('transcribing')
    try {
      const engine = await ensureEngine()
      if (transcribeGenRef.current !== gen) return
      const result = await engine.transcribe(pcm16k)
      if (transcribeGenRef.current !== gen) return
      // Groq/Whisper returns a phantom when the audio held no real speech — e.g.
      // a mic capturing only background noise. That's either a bare "." (no
      // letters) OR a stock caption filler WORD ("the", "you", "thank you"). NEVER
      // paste either; surface the same legible mic-pointing notice as the capture
      // gate so a failure is actionable instead of a mystery word in the prompt.
      if (isNoSpeechTranscript(result.text) || isHallucinatedFiller(result.text)) {
        setErrorMsg('Groq heard no speech — only background sound reached it. Check your microphone: Settings → Voice → Test microphone, and watch the level move while you talk.')
        setStatus('error')
        if (!sinkRef.current) focusActiveTerminal()
        return
      }
      const { plan } = processVoiceResult(result, { agentDetected: agentRef.current, settings: settingsRef.current })
      const sink = sinkRef.current
      if (sink) {
        // Sink mode: nothing is injected or confirmed, and focus stays put.
        setStatus('idle')
        if (plan.text) sink(plan.text)
        return
      }
      if (!plan.text) { setStatus('idle'); focusActiveTerminal(); return }
      if (plan.needsConfirm) {
        // Shell mode: keep focus on the confirm bar; we hand it back to the
        // terminal once the user resolves it (confirmRun / cancelConfirm).
        setConfirm({ text: plan.text })
        setStatus('idle')
        return
      }
      inject(plan.text, plan.autoSubmit)
      setStatus('idle')
      focusActiveTerminal()
    } catch (e) {
      if (transcribeGenRef.current !== gen) return
      setErrorMsg(describeVoiceError(e))
      setStatus('error')
    }
  }, [inject, focusActiveTerminal, ensureEngine])

  const stop = useCallback(async () => {
    // Mic still coming up: request cancellation so the in-flight start() tears
    // the stream down instead of entering a stuck "listening" state.
    if (startingRef.current && !listeningRef.current) {
      cancelStartRef.current = true
      setStatus('idle')
      if (!sinkRef.current) focusActiveTerminal()
      return
    }
    if (!listeningRef.current) return
    listeningRef.current = false
    const ctx = audioCtxRef.current
    const chunks = pcmChunksRef.current
    pcmChunksRef.current = []
    const sampleRate = ctx?.sampleRate ?? 48000
    cleanupCapture()
    if (chunks.length === 0) { setStatus('idle'); if (!sinkRef.current) focusActiveTerminal(); return }
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const merged = new Float32Array(total)
    let off = 0
    for (const c of chunks) { merged.set(c, off); off += c.length }
    const pcm16k = resampleTo16k(merged, sampleRate)
    // Speech/no-speech gate. Whisper INVENTS a phrase ("the", "you", "I'm sorry.
    // What is that?") for silent OR steady-noise audio, so we classify the clip by
    // its energy PROFILE — not just a raw level — and bail with the measured level
    // (never a phantom transcript) unless it actually contains speech. analyzeCapture
    // separates dynamic speech from flat hum even when both sit in the same level band.
    const analysis = analyzeCapture(pcm16k, 16000)
    setLastCapture(analysis)
    if (analysis.verdict !== 'speech') {
      setErrorMsg(noSpeechMessage(analysis))
      setStatus('error')
      if (!sinkRef.current) focusActiveTerminal()
      return
    }
    // Boost quiet (but real) capture toward a consistent level before transcribing.
    await transcribe(normalizeAudioGain(pcm16k), transcribeGenRef.current)
  }, [cleanupCapture, transcribe, focusActiveTerminal])
  // The cap timer outlives the render that set it, so it calls the current stop().
  const stopRef = useRef(stop)
  stopRef.current = stop

  // The mic went away mid-recording (unplugged, or the OS took it): end the capture, drop its audio,
  // and say so, rather than leave "listening" showing over a dead track.
  const micLost = useCallback(() => {
    listeningRef.current = false
    pcmChunksRef.current = []
    cleanupCapture()
    setErrorMsg(MIC_DISCONNECTED_MESSAGE)
    setStatus('error')
    if (!sinkRef.current) focusActiveTerminal()
  }, [cleanupCapture, focusActiveTerminal])

  const start = useCallback(async () => {
    if (listeningRef.current || startingRef.current) return
    const gen = ++captureGenRef.current
    if (sinkRef.current) transcribeGenRef.current++
    // cancel() or dispose() moved the generation on while this start waited.
    const superseded = () => captureGenRef.current !== gen
    const abandoned = () => cancelStartRef.current || superseded()
    setNotice(null)
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') {
      setErrorMsg('Microphone capture is not available in this environment.')
      setStatus('error')
      return
    }
    setErrorMsg(null) // fresh start — clear any prior failure
    startingRef.current = true
    cancelStartRef.current = false
    // Pre-load the model NOW so it loads while the mic comes up and the user
    // speaks — turning the old ~10s first-use "Transcribing…" wait into ~nothing.
    void ensureEngine().then((e) => e.warm?.()).catch(() => { /* surfaces on transcribe */ })
    try {
      // Capture raw mono mic audio. We deliberately disable the browser's adaptive
      // processing: echo-cancellation can SELF-CANCEL the user's voice (it treats
      // it as echo), and noise-suppression/AGC can gate quiet speech to silence —
      // and silent audio is exactly what makes Whisper hallucinate. We level the
      // audio ourselves (normalizeAudioGain) for deterministic, testable behavior.
      const baseAudio: MediaTrackConstraints = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      const wantId = settingsRef.current.inputDeviceId
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: wantId ? { ...baseAudio, deviceId: { exact: wantId } } : baseAudio,
        })
      } catch (devErr) {
        // The chosen mic may be unplugged/blocked — fall back to the system default
        // rather than failing outright, so a stale device id can't brick dictation.
        if (!wantId) throw devErr
        // Abandoned while the chosen mic failed: never open the default one.
        if (abandoned()) {
          startingRef.current = false
          cancelStartRef.current = false
          return
        }
        stream = await navigator.mediaDevices.getUserMedia({ audio: baseAudio })
      }
      // A stop(), cancel() or dispose() arrived while the mic was initialising —
      // release it and bail before an AudioContext exists or listening begins.
      if (abandoned()) {
        stream.getTracks().forEach((t) => t.stop())
        startingRef.current = false
        cancelStartRef.current = false
        if (!superseded()) setStatus('idle')
        return
      }
      streamRef.current = stream
      // Capture directly at 16kHz when the platform honors it (Chromium/Electron
      // do), so resampleTo16k is a no-op and there's no decimation/aliasing.
      let ctx: AudioContext
      try { ctx = new AudioContext({ sampleRate: 16000 }) } catch { ctx = new AudioContext() }
      audioCtxRef.current = ctx
      // Autoplay policy can start the context 'suspended' → onaudioprocess never
      // fires → we'd capture nothing. Resume before wiring the graph.
      await ctx.resume().catch(() => { /* best effort */ })
      // resume() is async, so a stop()/key-release can land DURING it too — not
      // just during getUserMedia. Re-check the cancel flag here or a quick
      // push-to-talk tap (release before the context is up) strands the mic in a
      // stuck "listening" state, which is the very failure this guard prevents.
      if (abandoned()) {
        // cancel() and dispose() already released the stream and context held in the refs.
        if (!superseded()) { cleanupCapture(); setStatus('idle') }
        startingRef.current = false
        cancelStartRef.current = false
        return
      }
      const source = ctx.createMediaStreamSource(stream)
      // Tap the source with an AnalyserNode to drive the live level meter. It's a
      // passive read (no onward connection needed) so it never affects capture.
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      analyserRef.current = analyser
      const processor = ctx.createScriptProcessor(4096, 1, 1)
      processorRef.current = processor
      pcmChunksRef.current = []
      processor.onaudioprocess = (e) => {
        pcmChunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)))
      }
      // A ScriptProcessor only runs when connected to the graph, but routing the
      // mic to ctx.destination would play it out the speakers (feedback + gives
      // echo-cancellation something to fight). Sink through a MUTED gain node so
      // it keeps pulling audio without any of it reaching the output.
      const sink = ctx.createGain()
      sink.gain.value = 0
      source.connect(processor)
      processor.connect(sink)
      sink.connect(ctx.destination)
      listeningRef.current = true
      startingRef.current = false
      setLastCapture(null)
      startLevelLoop()
      const tracks = stream.getTracks()
      const onEnded = () => {
        if (listeningRef.current && !superseded()) micLost()
      }
      tracks.forEach((t) => { t.onended = onEnded })
      // A recording cannot run on forever: at the cap it stops, and what was said is transcribed.
      capTimerRef.current = setTimeout(() => {
        capTimerRef.current = null
        setNotice(RECORDING_CAP_MESSAGE)
        void stopRef.current()
      }, MAX_RECORDING_MS)
      setStatus('listening')
      // The track can end before the handler is on it.
      if (tracks.some((t) => t.readyState === 'ended')) micLost()
    } catch {
      // Abandoned by cancel() or dispose() while getUserMedia failed: nothing is open, and no state is set.
      if (superseded()) {
        startingRef.current = false
        cancelStartRef.current = false
        return
      }
      // Tear down any half-initialised capture so a throw mid-setup can't leave
      // the OS mic indicator on or an AudioContext open (the refs may already be
      // assigned by the time a node constructor throws).
      cleanupCapture()
      startingRef.current = false
      setErrorMsg('Microphone access was blocked or no mic was found. Check your OS microphone privacy settings.')
      setStatus('error')
    }
  }, [ensureEngine, cleanupCapture, startLevelLoop, micLost])

  const toggle = useCallback(() => {
    if (listeningRef.current || startingRef.current) void stop()
    else void start()
  }, [start, stop])

  const confirmRun = useCallback((submit: boolean) => {
    if (confirm) inject(confirm.text, submit)
    setConfirm(null)
    focusActiveTerminal()
  }, [confirm, inject, focusActiveTerminal])

  const cancelConfirm = useCallback(() => { setConfirm(null); focusActiveTerminal() }, [focusActiveTerminal])

  const clearError = useCallback(() => setErrorMsg(null), [])

  // Abandon what is in flight, without a message (Esc, a typed question, another project).
  const cancel = useCallback((): void => {
    captureGenRef.current++
    transcribeGenRef.current++
    if (startingRef.current) cancelStartRef.current = true
    listeningRef.current = false
    pcmChunksRef.current = []
    cleanupCapture()
    setNotice(null)
    setStatus((s) => (s === 'error' ? s : 'idle'))
  }, [cleanupCapture])

  const dispose = useCallback(() => {
    captureGenRef.current++
    if (sinkRef.current) transcribeGenRef.current++
    if (startingRef.current) cancelStartRef.current = true
    listeningRef.current = false
    pcmChunksRef.current = []
    cleanupCapture()
    engineRef.current?.dispose()
    engineRef.current = null
  }, [cleanupCapture])

  // Tear down mic + worker when the terminal unmounts.
  useEffect(() => dispose, [dispose])

  return {
    status,
    listening: status === 'listening',
    level,
    lastCapture,
    confirm,
    errorMsg,
    notice,
    toggle,
    start,
    stop,
    cancel,
    confirmRun,
    cancelConfirm,
    clearError,
    dispose,
  }
}
