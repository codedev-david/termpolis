import { describe, it, expect } from 'vitest'
import {
  resolveVoiceMode,
  prepareInjection,
  shouldAcceptCorrection,
  applyCorrection,
  processVoiceResult,
  sanitizeVoiceSettings,
  resampleTo16k,
  pushToTalkIntent,
  pushToTalkMainKey,
  audioRms,
  isNoSpeech,
  normalizeAudioGain,
  computeDisplayLevel,
  analyzeCapture,
  SILENCE_RMS_THRESHOLD,
  MIN_SPEECH_SECONDS,
  RELIABLE_SPEECH_RMS,
  SPEECH_DYNAMIC_RATIO,
} from '../../src/renderer/src/lib/voice/voicePipeline'
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from '../../src/renderer/src/lib/voice/voiceTypes'
import { matchesKeybinding } from '../../src/renderer/src/lib/keybindings'

const settings = (over: Partial<VoiceSettings> = {}): VoiceSettings => ({ ...DEFAULT_VOICE_SETTINGS, ...over })

describe('voicePipeline', () => {
  describe('resolveVoiceMode', () => {
    it('maps an active agent to dictation, a plain shell to command mode', () => {
      expect(resolveVoiceMode(true)).toBe('agent')
      expect(resolveVoiceMode(false)).toBe('shell')
    })
  })

  describe('push-to-talk hold vs toggle', () => {
    it('mainKey returns the lowercased non-modifier key (for matching key release)', () => {
      expect(pushToTalkMainKey('Ctrl+Shift+L')).toBe('l')
      expect(pushToTalkMainKey('Ctrl+Shift+Space')).toBe('space')
    })
    it('hold mode: keydown starts recording, keyup stops it (true push-to-talk)', () => {
      expect(pushToTalkIntent('keydown', 'hold')).toBe('start')
      expect(pushToTalkIntent('keyup', 'hold')).toBe('stop')
    })
    it('toggle mode: keydown flips, keyup is ignored', () => {
      expect(pushToTalkIntent('keydown', 'toggle')).toBe('toggle')
      expect(pushToTalkIntent('keyup', 'toggle')).toBeNull()
    })
  })

  describe('prepareInjection', () => {
    it('agent mode injects text and auto-submits only when enabled', () => {
      expect(prepareInjection('  fix the bug  ', 'agent', settings({ autoSubmitInAgent: true })))
        .toEqual({ text: 'fix the bug', autoSubmit: true, needsConfirm: false })
      expect(prepareInjection('fix the bug', 'agent', settings({ autoSubmitInAgent: false })))
        .toEqual({ text: 'fix the bug', autoSubmit: false, needsConfirm: false })
    })

    it('agent mode never auto-submits empty text', () => {
      expect(prepareInjection('   ', 'agent', settings({ autoSubmitInAgent: true })))
        .toEqual({ text: '', autoSubmit: false, needsConfirm: false })
    })

    it('shell mode NEVER auto-submits and asks to confirm by default', () => {
      expect(prepareInjection('rm -rf build', 'shell', settings()))
        .toEqual({ text: 'rm -rf build', autoSubmit: false, needsConfirm: true })
    })

    it('shell mode can drop the confirm gate if the user opts out', () => {
      expect(prepareInjection('ls', 'shell', settings({ confirmBeforeRunInShell: false })))
        .toEqual({ text: 'ls', autoSubmit: false, needsConfirm: false })
    })
  })

  describe('shouldAcceptCorrection (constrained — gross-divergence guard)', () => {
    it('rejects an empty or unchanged correction', () => {
      expect(shouldAcceptCorrection('git commit', '')).toBe(false)
      expect(shouldAcceptCorrection('git commit', 'git commit')).toBe(false)
    })

    it('accepts a close, grounded single-word fix', () => {
      expect(shouldAcceptCorrection('git comit', 'git commit')).toBe(true)
    })

    it('accepts a correction grounded in an N-best hypothesis', () => {
      expect(shouldAcceptCorrection('cd sorce', 'cd source', ['cd source'])).toBe(true)
    })

    it('rejects a wholesale hallucination (length blows up)', () => {
      expect(shouldAcceptCorrection('ls', 'I think we should refactor the entire codebase now')).toBe(false)
    })

    it('rejects an unrelated rewrite (no token overlap)', () => {
      expect(shouldAcceptCorrection('cat readme', 'the weather is nice today')).toBe(false)
    })

    // NOTE: a coarse token/length guard cannot catch subtle phonetic
    // over-corrections (e.g. "algorithms" -> "Al Gore rhythms" share stopwords).
    // That is by design — the real protection for dangerous text is
    // confirm-before-run (shell) and the agent's own context (agent mode).
  })

  describe('applyCorrection', () => {
    it('uses the correction when it passes the guard', () => {
      expect(applyCorrection('git comit', 'git commit')).toBe('git commit')
    })
    it('falls back to the raw transcript when the correction is untrustworthy', () => {
      expect(applyCorrection('ls', 'I think we should refactor everything in this repo')).toBe('ls')
    })
    it('falls back when there is no correction', () => {
      expect(applyCorrection('  npm test ', null)).toBe('npm test')
    })
  })

  describe('sanitizeVoiceSettings', () => {
    it('returns defaults for empty/garbage input', () => {
      expect(sanitizeVoiceSettings(undefined)).toEqual(DEFAULT_VOICE_SETTINGS)
      expect(sanitizeVoiceSettings(null)).toEqual(DEFAULT_VOICE_SETTINGS)
      expect(sanitizeVoiceSettings(42)).toEqual(DEFAULT_VOICE_SETTINGS)
    })

    it('coerces an unknown Groq model to the default, keeps a valid one', () => {
      expect(sanitizeVoiceSettings({ groqModel: 'banana' }).groqModel).toBe(DEFAULT_VOICE_SETTINGS.groqModel)
      expect(sanitizeVoiceSettings({ groqModel: 'whisper-large-v3' }).groqModel).toBe('whisper-large-v3')
      expect(sanitizeVoiceSettings({ groqModel: 'whisper-large-v3-turbo' }).groqModel).toBe('whisper-large-v3-turbo')
    })

    it('migrates a stale persisted local model id to the default Groq model', () => {
      // A session.json from a pre-Groq build may still carry a local whisper id —
      // it must fall back to the default Groq model, never persist as-is.
      expect(sanitizeVoiceSettings({ groqModel: 'whisper-base.en' }).groqModel).toBe(DEFAULT_VOICE_SETTINGS.groqModel)
    })

    it('requires explicit consent (never silently defaults it to true)', () => {
      expect(sanitizeVoiceSettings({}).consentAccepted).toBe(false)
      expect(sanitizeVoiceSettings({ consentAccepted: true }).consentAccepted).toBe(true)
      expect(sanitizeVoiceSettings({ consentAccepted: 'yes' }).consentAccepted).toBe(false)
    })

    it('defaults push-to-talk mode to hold, preserves an explicit toggle', () => {
      expect(sanitizeVoiceSettings({ pushToTalkMode: 'banana' }).pushToTalkMode).toBe('hold')
      expect(sanitizeVoiceSettings({}).pushToTalkMode).toBe('hold')
      expect(sanitizeVoiceSettings({ pushToTalkMode: 'toggle' }).pushToTalkMode).toBe('toggle')
    })

    it('ignores non-boolean flags and caps oversized strings', () => {
      const out = sanitizeVoiceSettings({ enabled: 'yes', inputDeviceId: 'd'.repeat(9999), pushToTalkKey: 'k'.repeat(9999) })
      expect(out.enabled).toBe(false) // 'yes' is not a boolean → default
      expect(out.inputDeviceId.length).toBeLessThanOrEqual(200)
      expect(out.pushToTalkKey.length).toBeLessThanOrEqual(50)
    })

    it('default push-to-talk uses a Shift-safe key (a letter — not Shift+punctuation/digit, which matchesKeybinding cannot match)', () => {
      const last = DEFAULT_VOICE_SETTINGS.pushToTalkKey.split('+').pop() ?? ''
      expect(last).toMatch(/^[A-Za-z]$/)
    })

    it('the default push-to-talk hotkey actually matches its key event (activation works)', () => {
      const ev = { ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, key: 'L' } as unknown as KeyboardEvent
      expect(matchesKeybinding(ev, DEFAULT_VOICE_SETTINGS.pushToTalkKey)).toBe(true)
      // The previously-broken 'Ctrl+Shift+Period' default could never match: Shift
      // turns '.' into '>', so e.key is never "period".
      const broken = { ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, key: '>' } as unknown as KeyboardEvent
      expect(matchesKeybinding(broken, 'Ctrl+Shift+Period')).toBe(false)
    })

    it('preserves valid values', () => {
      const out = sanitizeVoiceSettings({ enabled: true, autoSubmitInAgent: true, pushToTalkKey: 'Ctrl+Shift+;' })
      expect(out.enabled).toBe(true)
      expect(out.autoSubmitInAgent).toBe(true)
      expect(out.pushToTalkKey).toBe('Ctrl+Shift+;')
    })
  })

  describe('processVoiceResult', () => {
    it('agent terminal: injects dictation, no confirm', () => {
      const { mode, plan } = processVoiceResult({ text: 'add a retry loop' }, { agentDetected: true, settings: settings() })
      expect(mode).toBe('agent')
      expect(plan).toEqual({ text: 'add a retry loop', autoSubmit: false, needsConfirm: false })
    })

    it('shell terminal: requires confirm, never auto-submits', () => {
      const { mode, plan } = processVoiceResult({ text: 'rm -rf node_modules' }, { agentDetected: false, settings: settings() })
      expect(mode).toBe('shell')
      expect(plan.needsConfirm).toBe(true)
      expect(plan.autoSubmit).toBe(false)
    })

    it('applies a grounded correction when enabled', () => {
      const { plan } = processVoiceResult(
        { text: 'git comit', nbest: [] },
        { agentDetected: true, settings: settings({ correctionEnabled: true }), correct: () => 'git commit' },
      )
      expect(plan.text).toBe('git commit')
    })

    it('ignores a hallucinated correction and keeps the raw transcript', () => {
      const { plan } = processVoiceResult(
        { text: 'ls' },
        {
          agentDetected: true,
          settings: settings({ correctionEnabled: true }),
          correct: () => 'we should probably rewrite this whole project from scratch',
        },
      )
      expect(plan.text).toBe('ls')
    })

    it('skips correction entirely when disabled', () => {
      const correct = () => 'SHOULD NOT BE CALLED'
      const { plan } = processVoiceResult(
        { text: '  hello  ' },
        { agentDetected: true, settings: settings({ correctionEnabled: false }), correct },
      )
      expect(plan.text).toBe('hello')
    })
  })

  describe('resampleTo16k', () => {
    it('is a no-op at 16kHz or for empty input', () => {
      const a = new Float32Array([0.1, 0.2, 0.3])
      expect(resampleTo16k(a, 16000)).toBe(a)
      const empty = new Float32Array(0)
      expect(resampleTo16k(empty, 48000)).toBe(empty)
    })

    it('downsamples 32kHz to roughly half the samples', () => {
      const input = new Float32Array(8).map((_, i) => i / 8)
      const out = resampleTo16k(input, 32000)
      expect(out.length).toBe(4)
    })

    it('upsamples 8kHz to roughly double the samples', () => {
      const input = new Float32Array([0, 0.5, 1, 0.5])
      const out = resampleTo16k(input, 8000)
      expect(out.length).toBe(8)
    })

    it('downsampling AVERAGES each window (anti-alias) rather than decimating', () => {
      // 48k -> 16k is a 3:1 box average. Naive decimation would return [1] (just
      // the first sample of the window); the anti-aliased filter returns the mean.
      const input = new Float32Array([1, 0, 0, 1, 0, 0])
      const out = resampleTo16k(input, 48000)
      expect(out.length).toBe(2)
      expect(out[0]).toBeCloseTo(1 / 3, 5)
      expect(out[1]).toBeCloseTo(1 / 3, 5)
    })

    it('handles 44.1kHz (a non-integer 2.756:1 ratio — a common real mic rate) without NaN', () => {
      // 1s @ 44.1k -> 16000 samples; the fractional window bounds must stay valid.
      const input = new Float32Array(44100)
      for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 200 * i) / 44100)
      const out = resampleTo16k(input, 44100)
      expect(out.length).toBe(16000)
      expect(out.every((v) => Number.isFinite(v))).toBe(true)
      // A pure tone resamples to roughly the same amplitude band, not silence.
      expect(audioRms(out)).toBeGreaterThan(0.1)
    })
  })

  describe('audioRms', () => {
    it('is 0 for empty or silent input, and the amplitude for a DC signal', () => {
      expect(audioRms(new Float32Array(0))).toBe(0)
      expect(audioRms(new Float32Array(100))).toBe(0)
      expect(audioRms(new Float32Array([0.5, 0.5, 0.5]))).toBeCloseTo(0.5, 6)
    })
    it('computes RMS of a mixed signal', () => {
      expect(audioRms(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(1, 6)
      expect(audioRms(new Float32Array([0.3, -0.3]))).toBeCloseTo(0.3, 6)
    })
  })

  describe('isNoSpeech (the anti-hallucination gate)', () => {
    const ONE_SEC = 16000
    it('flags pure silence as no-speech (Whisper would hallucinate a phrase here)', () => {
      expect(isNoSpeech(new Float32Array(ONE_SEC), 16000)).toBe(true)
    })
    it('flags mic-floor noise below the threshold as no-speech', () => {
      const noise = new Float32Array(ONE_SEC)
      for (let i = 0; i < noise.length; i++) noise[i] = (i % 5 - 2) * (SILENCE_RMS_THRESHOLD / 4)
      expect(audioRms(noise)).toBeLessThan(SILENCE_RMS_THRESHOLD)
      expect(isNoSpeech(noise, 16000)).toBe(true)
    })
    it('flags a too-short buffer as no-speech (a key tap, not an utterance)', () => {
      const tiny = new Float32Array(Math.floor(MIN_SPEECH_SECONDS * 16000) - 1).fill(0.5)
      expect(isNoSpeech(tiny, 16000)).toBe(true)
    })
    it('does NOT flag a real, sufficiently-loud utterance as no-speech', () => {
      const speech = new Float32Array(ONE_SEC)
      for (let i = 0; i < speech.length; i++) speech[i] = 0.2 * Math.sin((2 * Math.PI * 180 * i) / 16000)
      expect(audioRms(speech)).toBeGreaterThan(SILENCE_RMS_THRESHOLD)
      expect(isNoSpeech(speech, 16000)).toBe(false)
    })
    it('respects the sample rate when checking minimum duration', () => {
      // 0.25s of audio: speech at 16k (>0.2s), but no-speech at 48k (<0.2s).
      const quarterSecAt16k = new Float32Array(4000).fill(0.2)
      expect(isNoSpeech(quarterSecAt16k, 16000)).toBe(false)
      expect(isNoSpeech(quarterSecAt16k, 48000)).toBe(true)
    })
  })

  describe('normalizeAudioGain', () => {
    it('boosts quiet audio toward the target RMS', () => {
      const quiet = new Float32Array(1000)
      for (let i = 0; i < quiet.length; i++) quiet[i] = 0.01 * Math.sin(i)
      const out = normalizeAudioGain(quiet, 0.08)
      expect(audioRms(out)).toBeGreaterThan(audioRms(quiet) * 2)
      expect(audioRms(out)).toBeCloseTo(0.08, 2)
    })
    it('never attenuates audio already at/above the target (returns it unchanged)', () => {
      const loud = new Float32Array(1000)
      for (let i = 0; i < loud.length; i++) loud[i] = 0.5 * Math.sin(i)
      expect(normalizeAudioGain(loud, 0.08)).toBe(loud)
    })
    it('caps the gain so near-silence is not blown up to full scale', () => {
      const veryQuiet = new Float32Array(1000)
      for (let i = 0; i < veryQuiet.length; i++) veryQuiet[i] = 0.0005 * Math.sin(i)
      const out = normalizeAudioGain(veryQuiet, 0.08, 10) // maxGain 10
      expect(audioRms(out)).toBeCloseTo(audioRms(veryQuiet) * 10, 4)
    })
    it('returns silent/empty input unchanged and never exceeds [-1,1]', () => {
      const silent = new Float32Array(10)
      expect(normalizeAudioGain(silent)).toBe(silent)
      const clippy = new Float32Array([0.9, -0.9, 0.05])
      const out = normalizeAudioGain(clippy, 0.9)
      for (const v of out) expect(Math.abs(v)).toBeLessThanOrEqual(1)
    })
  })

  describe('computeDisplayLevel (live meter mapping)', () => {
    it('is 0 for silence/invalid and clamps to [0,1]', () => {
      expect(computeDisplayLevel(0)).toBe(0)
      expect(computeDisplayLevel(-1)).toBe(0)
      expect(computeDisplayLevel(Number.NaN)).toBe(0)
      expect(computeDisplayLevel(0.15)).toBeCloseTo(1, 5)
      expect(computeDisplayLevel(1)).toBe(1) // clamped, never > 1
    })
    it('is monotonic — louder audio reads higher on the meter', () => {
      expect(computeDisplayLevel(0.02)).toBeGreaterThan(computeDisplayLevel(0.005))
      expect(computeDisplayLevel(0.08)).toBeGreaterThan(computeDisplayLevel(0.02))
    })
    it('lifts quiet-but-real speech to a clearly-visible level (sqrt curve)', () => {
      expect(computeDisplayLevel(RELIABLE_SPEECH_RMS)).toBeGreaterThan(0.2)
    })
  })

  describe('analyzeCapture (speech vs silence vs steady noise)', () => {
    const SR = 16000
    const make = (n: number, fn: (i: number) => number): Float32Array => {
      const a = new Float32Array(n)
      for (let i = 0; i < n; i++) a[i] = fn(i)
      return a
    }

    it('classifies true silence as silent (Whisper would hallucinate here)', () => {
      expect(analyzeCapture(new Float32Array(SR), SR).verdict).toBe('silent')
    })

    it('classifies a too-short tap as silent', () => {
      const tiny = new Float32Array(Math.floor(MIN_SPEECH_SECONDS * SR) - 1).fill(0.3)
      expect(analyzeCapture(tiny, SR).verdict).toBe('silent')
    })

    it('classifies steady mid-level hum as NOISE — the dead-zone that produced "the"', () => {
      // Flat ~0.005-RMS tone: ABOVE the raw silence gate, but no speech dynamics.
      const hum = make(SR, (i) => 0.007 * Math.sin((2 * Math.PI * 120 * i) / SR))
      const a = analyzeCapture(hum, SR)
      expect(a.rms).toBeGreaterThan(SILENCE_RMS_THRESHOLD) // would pass a raw RMS gate
      expect(a.dynamicRatio).toBeLessThan(SPEECH_DYNAMIC_RATIO)
      expect(a.verdict).toBe('noise')
    })

    it('classifies dynamic, syllable-like audio as SPEECH even when quiet', () => {
      // Quiet bursts with gaps (3Hz on/off envelope) → high dynamic range → speech.
      const speech = make(SR, (i) => {
        const on = Math.sin((2 * Math.PI * 3 * i) / SR) > 0 ? 1 : 0.02
        return 0.01 * on * Math.sin((2 * Math.PI * 180 * i) / SR)
      })
      const a = analyzeCapture(speech, SR)
      expect(a.dynamicRatio).toBeGreaterThan(SPEECH_DYNAMIC_RATIO)
      expect(a.verdict).toBe('speech')
    })

    it('accepts clearly-loud audio as speech regardless of flatness', () => {
      const loud = make(SR, (i) => 0.2 * Math.sin((2 * Math.PI * 180 * i) / SR))
      expect(analyzeCapture(loud, SR).verdict).toBe('speech')
    })

    it('does NOT drop continuous, normal-volume speech with few pauses (false-negative guard)', () => {
      // Flat, normal-volume tone at RMS ~0.025 — like reading a sentence without
      // gaps: low dynamicRatio, peak below the loud cutoff, but clearly above the
      // reliable-speech RMS, so it must be accepted, never gated as noise.
      const cont = make(SR, (i) => 0.035 * Math.sin((2 * Math.PI * 180 * i) / SR))
      const a = analyzeCapture(cont, SR)
      expect(a.rms).toBeGreaterThan(RELIABLE_SPEECH_RMS)
      expect(a.dynamicRatio).toBeLessThan(SPEECH_DYNAMIC_RATIO) // flat...
      expect(a.verdict).toBe('speech') // ...but accepted via the overall-RMS escape hatch
    })

    it('a NaN/Infinity-poisoned buffer yields a FINITE level (no "level NaN"), never crashes', () => {
      const bad = new Float32Array(SR).fill(0.1)
      bad[10] = Number.NaN
      bad[20] = Number.POSITIVE_INFINITY
      const a = analyzeCapture(bad, SR)
      expect(Number.isFinite(a.rms)).toBe(true)
      expect(Number.isFinite(computeDisplayLevel(a.rms))).toBe(true)
    })
  })

  describe('push-to-talk intent edge cases', () => {
    it('hold mode ignores non key-down/up events (returns null)', () => {
      expect(pushToTalkIntent('blur', 'hold')).toBeNull()
    })
    it('toggle mode ignores key-up; only key-down toggles', () => {
      expect(pushToTalkIntent('keyup', 'toggle')).toBeNull()
      expect(pushToTalkIntent('keydown', 'toggle')).toBe('toggle')
    })
    it('hold mode maps key-down to start and key-up to stop', () => {
      expect(pushToTalkIntent('keydown', 'hold')).toBe('start')
      expect(pushToTalkIntent('keyup', 'hold')).toBe('stop')
    })
    it('pushToTalkMainKey returns the last segment lowercased, "" for an empty combo', () => {
      expect(pushToTalkMainKey('Ctrl+Shift+L')).toBe('l')
      expect(pushToTalkMainKey('')).toBe('')
    })
  })

  describe('audio helper edge branches', () => {
    it('resampleTo16k upsamples a sub-16kHz input (linear interpolation path)', () => {
      const out = resampleTo16k(new Float32Array([0, 1, 0, 1]), 8000)
      expect(out.length).toBeGreaterThan(4) // 8k -> 16k roughly doubles the samples
      for (const v of out) expect(Number.isFinite(v)).toBe(true)
    })

    it('resampleTo16k returns the input unchanged when already at 16kHz', () => {
      const input = new Float32Array([0.1, 0.2])
      expect(resampleTo16k(input, 16000)).toBe(input)
    })

    it('normalizeAudioGain caps the boost for near-silent audio (maxGain branch)', () => {
      const quiet = new Float32Array(1000).fill(0.0005) // far below target → gain would exceed maxGain
      const out = normalizeAudioGain(quiet, 0.08, 40)
      // Capped at 40x: 0.0005 * 40 = 0.02, never clipped to 1.
      expect(out[0]).toBeCloseTo(0.02, 5)
    })

    it('normalizeAudioGain returns input unchanged when already at/above target', () => {
      const loud = new Float32Array(10).fill(0.5)
      expect(normalizeAudioGain(loud, 0.08)).toBe(loud)
    })
  })
})
