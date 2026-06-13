import { useCallback, useEffect, useRef, useState } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import { computeDisplayLevel, RELIABLE_SPEECH_RMS } from '../../lib/voice/voicePipeline'

interface InputDevice {
  deviceId: string
  label: string
}

/**
 * Microphone picker + live "test mic" meter for Voice settings. This exists
 * because the #1 real-world voice failure is the OS default input device being
 * the wrong/muted/virtual one — and until now there was no way to SEE that. The
 * user picks a device and clicks Test; the bar must jump past the tick when they
 * speak. If it stays flat, that device isn't hearing them — pick another. All the
 * level math is the same pure code the in-terminal meter uses (computeDisplayLevel).
 */
export function MicTester() {
  const inputDeviceId = useTerminalStore((s) => s.voiceSettings.inputDeviceId)
  const set = useTerminalStore((s) => s.setVoiceSettings)

  const [devices, setDevices] = useState<InputDevice[]>([])
  const [testing, setTesting] = useState(false)
  const [level, setLevel] = useState(0)
  const [peak, setPeak] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const bufRef = useRef<Float32Array<ArrayBuffer> | null>(null)
  // Guards for the async startTest: in-flight (no double-start during the await
  // window) + cancelled (unmount or stop landed mid-acquire → release the late stream).
  const startingRef = useRef(false)
  const cancelledRef = useRef(false)

  const enumerate = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      const ins = all
        .filter((d) => d.kind === 'audioinput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }))
      setDevices(ins)
    } catch {
      /* enumeration unavailable in this environment */
    }
  }, [])

  useEffect(() => {
    void enumerate()
  }, [enumerate])

  const stopTest = useCallback(() => {
    if (timerRef.current != null) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    try { analyserRef.current?.disconnect() } catch { /* already gone */ }
    try { ctxRef.current?.close() } catch { /* already closed */ }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    analyserRef.current = null
    ctxRef.current = null
    streamRef.current = null
    setTesting(false)
    setLevel(0)
  }, [])

  // Tear the test mic down if the panel unmounts mid-test — and flag cancellation so
  // an in-flight startTest releases a stream that resolves AFTER unmount.
  useEffect(() => () => { cancelledRef.current = true; stopTest() }, [stopTest])

  const startTest = useCallback(async () => {
    if (startingRef.current || testing) return // no double-start during the async window
    startingRef.current = true
    cancelledRef.current = false
    setError(null)
    setPeak(0)
    try {
      const base: MediaTrackConstraints = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: inputDeviceId ? { ...base, deviceId: { exact: inputDeviceId } } : base,
        })
      } catch (e) {
        if (!inputDeviceId) throw e
        stream = await navigator.mediaDevices.getUserMedia({ audio: base })
      }
      // Unmounted / stopped while the mic was coming up — release it, don't build on it.
      if (cancelledRef.current) { stream.getTracks().forEach((t) => t.stop()); return }
      streamRef.current = stream
      // Permission is granted now → labels are populated; refresh the list.
      await enumerate()
      const ctx = new AudioContext()
      ctxRef.current = ctx
      await ctx.resume().catch(() => { /* best effort */ })
      if (cancelledRef.current) { stopTest(); return }
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      analyserRef.current = analyser
      setTesting(true)
      timerRef.current = setInterval(() => {
        const an = analyserRef.current
        if (!an) return
        const buf = bufRef.current && bufRef.current.length === an.fftSize
          ? bufRef.current
          : (bufRef.current = new Float32Array(an.fftSize))
        an.getFloatTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
        const lvl = computeDisplayLevel(Math.sqrt(sum / buf.length))
        setLevel(lvl)
        setPeak((p) => Math.max(p, lvl))
      }, 33)
    } catch {
      setError('Could not open the microphone. Check your OS microphone privacy settings and that a mic is connected.')
      setTesting(false)
    } finally {
      startingRef.current = false
    }
  }, [inputDeviceId, enumerate, testing, stopTest])

  const speechFloor = computeDisplayLevel(RELIABLE_SPEECH_RMS)
  const heard = peak >= speechFloor

  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="mic-tester">
      <label className="flex flex-col gap-1">
        Microphone
        <select
          data-testid="voice-device-select"
          value={inputDeviceId}
          onChange={(e) => set({ inputDeviceId: e.target.value })}
          className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm w-72 focus:outline-none"
        >
          <option value="">System default</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
          ))}
        </select>
      </label>

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="voice-test-mic-btn"
          onClick={() => (testing ? stopTest() : void startTest())}
          className={`text-xs px-2 py-1 rounded border whitespace-nowrap ${testing ? 'bg-[#c0392b] border-[#e74c3c] text-white' : 'bg-[#2d2d2d] border-[#3c3c3c] hover:bg-[#0e639c]'}`}
        >
          <i className={`fa-solid ${testing ? 'fa-stop' : 'fa-microphone'} mr-1`} />
          {testing ? 'Stop test' : 'Test microphone'}
        </button>
        <span className="relative inline-block h-2 w-40 rounded-full bg-[#ffffff1f] overflow-hidden" data-testid="voice-test-meter">
          <span
            data-testid="voice-test-meter-fill"
            className="absolute left-0 top-0 h-full rounded-full transition-[width] duration-75"
            style={{ width: `${Math.round(level * 100)}%`, backgroundColor: level >= speechFloor ? '#7ee787' : '#f0b86e' }}
          />
          <span className="absolute top-0 h-full w-px bg-white/70" style={{ left: `${speechFloor * 100}%` }} />
        </span>
        {testing && (
          <span className={`text-xs ${heard ? 'text-[#7ee787]' : 'text-[#9ca3af]'}`} data-testid="voice-test-status">
            {heard ? '✓ hearing you' : 'speak now…'}
          </span>
        )}
      </div>

      {error && <span className="text-xs text-[#ff8a8a]" data-testid="voice-test-error">{error}</span>}
      <span className="text-xs text-[#9ca3af]">
        Pick the mic you actually speak into and click Test — the bar should jump past the tick when you talk. If it
        stays flat, that device isn&apos;t hearing you; choose another.
      </span>
    </div>
  )
}
