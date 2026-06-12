// Pure voice-input logic — no DOM/audio/worker deps, so the decisions that
// matter most (where transcribed text goes, whether a dictated command may run,
// whether an LLM "correction" is trustworthy) are fully unit-testable.

import {
  DEFAULT_VOICE_SETTINGS,
  BUNDLED_LOCAL_MODELS,
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
  // The local engine is OFFLINE — it can only load a model we actually bundle.
  // Coerce any other id (e.g. a stale persisted remote model from an earlier
  // build, or junk) to the bundled default so it never silently fails to load.
  const modelRaw = str(r.model, d.model)
  const model = (BUNDLED_LOCAL_MODELS as readonly string[]).includes(modelRaw) ? modelRaw : d.model
  return {
    enabled: bool(r.enabled, d.enabled),
    engine: r.engine === 'cloud' ? 'cloud' : 'local',
    model,
    pushToTalkKey: str(r.pushToTalkKey, d.pushToTalkKey, 50),
    pushToTalkMode: r.pushToTalkMode === 'toggle' ? 'toggle' : 'hold',
    autoSubmitInAgent: bool(r.autoSubmitInAgent, d.autoSubmitInAgent),
    correctionEnabled: bool(r.correctionEnabled, d.correctionEnabled),
    confirmBeforeRunInShell: bool(r.confirmBeforeRunInShell, d.confirmBeforeRunInShell),
    cloudEndpoint: str(r.cloudEndpoint, d.cloudEndpoint, 500),
  }
}

/**
 * Resample mono PCM to 16kHz (what Whisper expects). Pure + allocation-light.
 * Downsampling AVERAGES each source window (a simple anti-alias box filter)
 * instead of naive every-Nth-sample decimation, which folds high-frequency
 * energy back into the speech band; upsampling uses linear interpolation. In
 * practice we now capture at 16kHz directly (see useVoiceInput), so this is a
 * correctness fallback for platforms that ignore the requested context rate.
 */
export function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === 16000 || input.length === 0) return input
  const ratio = inputRate / 16000
  const outLen = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(outLen)
  if (ratio > 1) {
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio)
      const end = Math.min(Math.floor((i + 1) * ratio), input.length)
      let sum = 0
      let n = 0
      for (let j = start; j < end; j++) {
        sum += input[j]
        n++
      }
      out[i] = n > 0 ? sum / n : input[Math.min(start, input.length - 1)]
    }
  } else {
    for (let i = 0; i < outLen; i++) {
      const idx = i * ratio
      const i0 = Math.floor(idx)
      const i1 = Math.min(i0 + 1, input.length - 1)
      const frac = idx - i0
      out[i] = input[i0] * (1 - frac) + input[i1] * frac
    }
  }
  return out
}

/** Root-mean-square amplitude of a PCM buffer in [0,1]. 0 for empty input. */
export function audioRms(pcm: Float32Array): number {
  if (pcm.length === 0) return 0
  let sum = 0
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i]
  return Math.sqrt(sum / pcm.length)
}

// Below this RMS, a captured buffer is silence or mic-floor noise, NOT speech.
// EVIDENCE (real whisper-base.en in headless Chromium): it transcribes genuine
// speech correctly down to RMS ~0.001, but on silence (RMS 0) and mic-floor
// noise (RMS ~0.0016) it HALLUCINATES canned filler ("you", "I'm sorry. What is
// that?"). 0.0025 sits above the observed noise-floor failures and well below
// any real captured utterance (raw mic, no AGC), so it cleanly separates the two.
export const SILENCE_RMS_THRESHOLD = 0.0025
// Shorter than this and it's a key-tap, not an utterance.
export const MIN_SPEECH_SECONDS = 0.2

/**
 * True when captured audio almost certainly contains NO speech (silence, noise
 * floor, or too short). The whole reason "I'm sorry. What is that?" appears is
 * that Whisper invents a phrase for no-speech audio — so the hook refuses to
 * transcribe when this returns true and tells the user, instead of injecting a
 * phantom transcript. Pure (sampleRate only sets the min-duration check).
 */
export function isNoSpeech(pcm: Float32Array, sampleRate = 16000): boolean {
  if (pcm.length < MIN_SPEECH_SECONDS * sampleRate) return true
  return audioRms(pcm) < SILENCE_RMS_THRESHOLD
}

/**
 * Boost quiet captured audio toward a target RMS so dictation level is
 * consistent regardless of mic gain / speaking distance. ONLY amplifies (never
 * attenuates — Whisper handles loud speech fine), caps the gain so we don't blow
 * up near-silence, and hard-clips to [-1,1]. Pure; returns the input unchanged
 * when it's empty, silent, or already at/above target. Whisper's mel feature
 * extractor is largely level-invariant, so this is belt-and-suspenders for
 * consistency rather than the core fix (which is the no-speech gate above).
 */
export function normalizeAudioGain(pcm: Float32Array, targetRms = 0.08, maxGain = 40): Float32Array {
  const rms = audioRms(pcm)
  if (rms === 0) return pcm
  let gain = targetRms / rms
  if (gain <= 1) return pcm
  if (gain > maxGain) gain = maxGain
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) {
    let v = pcm[i] * gain
    if (v > 1) v = 1
    else if (v < -1) v = -1
    out[i] = v
  }
  return out
}
