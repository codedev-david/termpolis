import { useCallback, useEffect, useRef, useState } from 'react'
import { createVoiceEngine, type WorkerLike } from '../lib/voice/voiceEngines'
import { processVoiceResult, resampleTo16k, isNoSpeech, normalizeAudioGain } from '../lib/voice/voicePipeline'
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

  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
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
  // The bundled model + ORT wasm are served by main over localhost; the worker
  // needs that base URL to load offline. Fetched once on mount (and re-fetched
  // lazily in transcribe() if it hasn't landed yet).
  const assetBaseRef = useRef<string>('')

  useEffect(() => {
    const p = window.termpolis?.getVoiceAssetBase?.()
    if (!p) return
    p.then((res) => {
      if (res?.success && typeof res.data === 'string') assetBaseRef.current = res.data
    }).catch(() => { /* surfaced as a load error on first transcribe */ })
  }, [])

  const inject = useCallback((text: string, autoSubmit: boolean) => {
    if (!text) return
    window.termpolis.writeToTerminal(terminalId, text + (autoSubmit ? '\r' : ''))
  }, [terminalId])

  const cleanupCapture = useCallback(() => {
    try { processorRef.current?.disconnect() } catch { /* already gone */ }
    try { audioCtxRef.current?.close() } catch { /* already closed */ }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    processorRef.current = null
    audioCtxRef.current = null
    streamRef.current = null
  }, [])

  // Resolve the localhost asset base (the mount fetch may not have landed on the
  // very first dictation) and lazily build the engine. Shared by warm-up (on
  // record start) and transcribe so both reuse the one worker.
  const ensureEngine = useCallback(async (): Promise<VoiceEngine> => {
    let base = assetBaseRef.current
    if (!base) {
      const res = await window.termpolis?.getVoiceAssetBase?.()
      if (res?.success && typeof res.data === 'string') { base = res.data; assetBaseRef.current = base }
    }
    if (!engineRef.current) engineRef.current = createVoiceEngine(settingsRef.current, { assetBase: base })
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
    // No-speech gate. Whisper INVENTS a phrase ("you", "I'm sorry. What is that?")
    // for silent/noise-only audio, so when the mic captured no actual speech we
    // tell the user and bail instead of injecting a phantom transcript.
    if (isNoSpeech(pcm16k)) {
      setErrorMsg('No speech detected — hold the key, speak, then release.')
      setStatus('error')
      focusActiveTerminal()
      return
    }
    // Boost quiet capture toward a consistent level before transcribing.
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
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
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
  }, [ensureEngine, cleanupCapture])

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

export type { WorkerLike }
