import { useCallback, useEffect, useRef, useState } from 'react'
import { createVoiceEngine, type WorkerLike } from '../lib/voice/voiceEngines'
import { processVoiceResult, resampleTo16k } from '../lib/voice/voicePipeline'
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

  const transcribe = useCallback(async (pcm16k: Float32Array) => {
    setStatus('transcribing')
    try {
      // Make sure we have the localhost asset base before building the engine —
      // the mount fetch may not have resolved on the very first dictation.
      let base = assetBaseRef.current
      if (!base) {
        const res = await window.termpolis?.getVoiceAssetBase?.()
        if (res?.success && typeof res.data === 'string') { base = res.data; assetBaseRef.current = base }
      }
      if (!engineRef.current) engineRef.current = createVoiceEngine(settingsRef.current, { assetBase: base })
      const result = await engineRef.current.transcribe(pcm16k)
      const { plan } = processVoiceResult(result, { agentDetected: agentRef.current, settings: settingsRef.current })
      if (!plan.text) { setStatus('idle'); return }
      if (plan.needsConfirm) setConfirm({ text: plan.text })
      else inject(plan.text, plan.autoSubmit)
      setStatus('idle')
    } catch (e) {
      setErrorMsg(describeVoiceError(e))
      setStatus('error')
    }
  }, [inject])

  const stop = useCallback(async () => {
    // Mic still coming up: request cancellation so the in-flight start() tears
    // the stream down instead of entering a stuck "listening" state.
    if (startingRef.current && !listeningRef.current) {
      cancelStartRef.current = true
      setStatus('idle')
      return
    }
    if (!listeningRef.current) return
    listeningRef.current = false
    const ctx = audioCtxRef.current
    const chunks = pcmChunksRef.current
    pcmChunksRef.current = []
    const sampleRate = ctx?.sampleRate ?? 48000
    cleanupCapture()
    if (chunks.length === 0) { setStatus('idle'); return }
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const merged = new Float32Array(total)
    let off = 0
    for (const c of chunks) { merged.set(c, off); off += c.length }
    await transcribe(resampleTo16k(merged, sampleRate))
  }, [cleanupCapture, transcribe])

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
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
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
      const ctx = new AudioContext()
      audioCtxRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      const processor = ctx.createScriptProcessor(4096, 1, 1)
      processorRef.current = processor
      pcmChunksRef.current = []
      processor.onaudioprocess = (e) => {
        pcmChunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)))
      }
      source.connect(processor)
      processor.connect(ctx.destination)
      listeningRef.current = true
      startingRef.current = false
      setStatus('listening')
    } catch {
      startingRef.current = false
      setErrorMsg('Microphone access was blocked or no mic was found. Check your OS microphone privacy settings.')
      setStatus('error')
    }
  }, [])

  const toggle = useCallback(() => {
    if (listeningRef.current || startingRef.current) void stop()
    else void start()
  }, [start, stop])

  const confirmRun = useCallback((submit: boolean) => {
    if (confirm) inject(confirm.text, submit)
    setConfirm(null)
  }, [confirm, inject])

  const cancelConfirm = useCallback(() => setConfirm(null), [])

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
