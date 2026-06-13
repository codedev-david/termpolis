import { useCallback, useEffect, useRef, useState } from 'react'
import { createVoiceEngine } from '../lib/voice/voiceEngines'
import { processVoiceResult, resampleTo16k, analyzeCapture, computeDisplayLevel, normalizeAudioGain, type CaptureAnalysis } from '../lib/voice/voicePipeline'
import type { VoiceEngine } from '../lib/voice/voiceTypes'
import { useTerminalStore } from '../store/terminalStore'

export type VoiceStatus = 'idle' | 'listening' | 'transcribing' | 'error'
export interface VoiceConfirm {
  text: string
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
export function useVoiceInput(terminalId: string, agentDetected: boolean) {
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
  const inject = useCallback((text: string, autoSubmit: boolean) => {
    if (!text) return
    window.termpolis.writeToTerminal(terminalId, text + (autoSubmit ? '\r' : ''))
  }, [terminalId])

  const cleanupCapture = useCallback(() => {
    if (levelTimerRef.current != null) {
      clearInterval(levelTimerRef.current)
      levelTimerRef.current = null
    }
    try { analyserRef.current?.disconnect() } catch { /* already gone */ }
    try { processorRef.current?.disconnect() } catch { /* already gone */ }
    try { audioCtxRef.current?.close() } catch { /* already closed */ }
    streamRef.current?.getTracks().forEach((t) => t.stop())
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

  const transcribe = useCallback(async (pcm16k: Float32Array) => {
    setStatus('transcribing')
    try {
      const engine = await ensureEngine()
      const result = await engine.transcribe(pcm16k)
      const { plan } = processVoiceResult(result, { agentDetected: agentRef.current, settings: settingsRef.current })
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
      focusActiveTerminal()
      return
    }
    if (!listeningRef.current) return
    listeningRef.current = false
    const ctx = audioCtxRef.current
    const chunks = pcmChunksRef.current
    pcmChunksRef.current = []
    const sampleRate = ctx?.sampleRate ?? 48000
    cleanupCapture()
    if (chunks.length === 0) { setStatus('idle'); focusActiveTerminal(); return }
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
      focusActiveTerminal()
      return
    }
    // Boost quiet (but real) capture toward a consistent level before transcribing.
    await transcribe(normalizeAudioGain(pcm16k))
  }, [cleanupCapture, transcribe, focusActiveTerminal])

  const start = useCallback(async () => {
    if (listeningRef.current || startingRef.current) return
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
        stream = await navigator.mediaDevices.getUserMedia({ audio: baseAudio })
      }
      // A stop() arrived while the mic was initialising — release it and bail
      // before we ever enter the listening state.
      if (cancelStartRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        startingRef.current = false
        cancelStartRef.current = false
        setStatus('idle')
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
      if (cancelStartRef.current) {
        cleanupCapture()
        startingRef.current = false
        cancelStartRef.current = false
        setStatus('idle')
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
      setStatus('listening')
    } catch {
      // Tear down any half-initialised capture so a throw mid-setup can't leave
      // the OS mic indicator on or an AudioContext open (the refs may already be
      // assigned by the time a node constructor throws).
      cleanupCapture()
      startingRef.current = false
      setErrorMsg('Microphone access was blocked or no mic was found. Check your OS microphone privacy settings.')
      setStatus('error')
    }
  }, [ensureEngine, cleanupCapture, startLevelLoop])

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

  const dispose = useCallback(() => {
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
    toggle,
    start,
    stop,
    confirmRun,
    cancelConfirm,
    clearError,
    dispose,
  }
}
