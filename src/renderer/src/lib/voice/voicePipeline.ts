// Pure voice-input logic — no DOM/audio/worker deps, so the decisions that
// matter most (where transcribed text goes, whether a dictated command may run,
// whether an LLM "correction" is trustworthy) are fully unit-testable.

import {
  DEFAULT_VOICE_SETTINGS,
  type VoiceSettings,
  type VoiceMode,
  type InjectionPlan,
  type TranscriptResult,
} from './voiceTypes'

/** Agent terminals take natural-language dictation; plain shells take commands. */
export function resolveVoiceMode(agentDetected: boolean): VoiceMode {
  return agentDetected ? 'agent' : 'shell'
}

/** The main (non-modifier) key of a combo, lowercased — what to watch for on release. */
export function pushToTalkMainKey(combo: string): string {
  const parts = combo.split('+')
  return (parts[parts.length - 1] || '').toLowerCase()
}

/**
 * Map a key-event type + mode to a recording intent.
 * - hold:   keydown → 'start', keyup → 'stop' (true push-to-talk)
 * - toggle: keydown → 'toggle', keyup → ignored
 */
export function pushToTalkIntent(eventType: string, mode: 'hold' | 'toggle'): 'start' | 'stop' | 'toggle' | null {
  if (mode === 'toggle') return eventType === 'keydown' ? 'toggle' : null
  if (eventType === 'keydown') return 'start'
  if (eventType === 'keyup') return 'stop'
  return null
}

/**
 * Decide what to do with a finished transcript. Agent mode injects the text
 * (optionally auto-submitting); shell mode NEVER auto-submits and (by default)
 * asks for confirmation, because mis-transcribed shell commands are dangerous.
 */
export function prepareInjection(text: string, mode: VoiceMode, settings: VoiceSettings): InjectionPlan {
  const clean = text.trim()
  if (mode === 'agent') {
    return { text: clean, autoSubmit: settings.autoSubmitInAgent && clean.length > 0, needsConfirm: false }
  }
  return { text: clean, autoSubmit: false, needsConfirm: settings.confirmBeforeRunInShell }
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * Guard for the STT→LLM correction stage. The research is explicit: naive LLM
 * cleanup HALLUCINATES and can rewrite already-correct text ("algorithms" →
 * "Al Gore"). Only accept a correction that is plausibly GROUNDED in the ASR
 * output — bounded length change AND substantial token overlap with the
 * original transcript or one of the N-best hypotheses. Otherwise keep the raw
 * transcript. Returns true only when the correction is safe to use.
 */
export function shouldAcceptCorrection(original: string, corrected: string, nbest: string[] = []): boolean {
  const o = original.trim()
  const c = corrected.trim()
  if (!c) return false
  if (c === o) return false // nothing changed → nothing to accept
  const candidates = [o, ...nbest.map((s) => s.trim())].filter(Boolean)
  if (candidates.length === 0) return false

  // Length guard: corrected length within 0.5x..2x of some candidate.
  const lenOk = candidates.some((cand) => {
    if (cand.length === 0) return false
    const ratio = c.length / cand.length
    return ratio >= 0.5 && ratio <= 2
  })
  if (!lenOk) return false

  // Token-overlap guard: corrected shares >= 40% of its tokens with a candidate.
  const ctok = tokenize(c)
  if (ctok.length === 0) return false
  return candidates.some((cand) => {
    const set = new Set(tokenize(cand))
    const shared = ctok.filter((t) => set.has(t)).length
    return shared / ctok.length >= 0.4
  })
}

/**
 * Turn a finished transcript into a concrete plan: resolve the mode, run the
 * (constrained) correction if enabled, then decide injection. The corrector is
 * injected so this stays pure and testable without an LLM. This is the seam the
 * audio hook calls once it has text.
 */
export function processVoiceResult(
  result: TranscriptResult,
  opts: {
    agentDetected: boolean
    settings: VoiceSettings
    correct?: (text: string, nbest: string[]) => string | null
  },
): { mode: VoiceMode; plan: InjectionPlan } {
  const mode = resolveVoiceMode(opts.agentDetected)
  const nbest = result.nbest ?? []
  let text = result.text
  if (opts.settings.correctionEnabled && opts.correct) {
    text = applyCorrection(result.text, opts.correct(result.text, nbest), nbest)
  } else {
    text = result.text.trim()
  }
  return { mode, plan: prepareInjection(text, mode, opts.settings) }
}

/** Pick the final text: the correction if it passed the guard, else the raw transcript. */
export function applyCorrection(original: string, corrected: string | null | undefined, nbest: string[] = []): string {
  if (corrected && shouldAcceptCorrection(original, corrected, nbest)) return corrected.trim()
  return original.trim()
}

/** Coerce persisted/untrusted voice settings into a valid object (drop junk, cap lengths). */
export function sanitizeVoiceSettings(raw: unknown): VoiceSettings {
  const r = (raw ?? {}) as Partial<Record<keyof VoiceSettings, unknown>>
  const d = DEFAULT_VOICE_SETTINGS
  const str = (v: unknown, fallback: string, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : fallback)
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
  return {
    enabled: bool(r.enabled, d.enabled),
    engine: r.engine === 'cloud' ? 'cloud' : 'local',
    model: str(r.model, d.model),
    pushToTalkKey: str(r.pushToTalkKey, d.pushToTalkKey, 50),
    pushToTalkMode: r.pushToTalkMode === 'toggle' ? 'toggle' : 'hold',
    autoSubmitInAgent: bool(r.autoSubmitInAgent, d.autoSubmitInAgent),
    correctionEnabled: bool(r.correctionEnabled, d.correctionEnabled),
    confirmBeforeRunInShell: bool(r.confirmBeforeRunInShell, d.confirmBeforeRunInShell),
    cloudEndpoint: str(r.cloudEndpoint, d.cloudEndpoint, 500),
  }
}

/**
 * Linear-resample mono PCM to 16kHz (what Whisper expects). Pure + allocation-
 * light; good enough for speech (we are not doing hi-fi audio).
 */
export function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === 16000 || input.length === 0) return input
  const ratio = inputRate / 16000
  const outLen = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio
    const i0 = Math.floor(idx)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = idx - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}
