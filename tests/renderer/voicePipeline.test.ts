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

    it('coerces an unknown engine to local and keeps a valid cloud choice', () => {
      expect(sanitizeVoiceSettings({ engine: 'banana' }).engine).toBe('local')
      expect(sanitizeVoiceSettings({ engine: 'cloud' }).engine).toBe('cloud')
    })

    it('defaults push-to-talk mode to hold, preserves an explicit toggle', () => {
      expect(sanitizeVoiceSettings({ pushToTalkMode: 'banana' }).pushToTalkMode).toBe('hold')
      expect(sanitizeVoiceSettings({}).pushToTalkMode).toBe('hold')
      expect(sanitizeVoiceSettings({ pushToTalkMode: 'toggle' }).pushToTalkMode).toBe('toggle')
    })

    it('ignores non-boolean flags and caps oversized strings', () => {
      const out = sanitizeVoiceSettings({ enabled: 'yes', model: 'm'.repeat(9999), cloudEndpoint: 'x'.repeat(9999) })
      expect(out.enabled).toBe(false) // 'yes' is not a boolean → default
      expect(out.model.length).toBeLessThanOrEqual(200)
      expect(out.cloudEndpoint.length).toBeLessThanOrEqual(500)
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
  })
})
