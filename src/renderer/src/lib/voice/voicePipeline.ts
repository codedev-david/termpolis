// Pure voice-input logic — no DOM/audio/worker deps, so the decisions that
// matter most (where transcribed text goes, whether a dictated command may run,
// whether an LLM "correction" is trustworthy) are fully unit-testable.

import {
  DEFAULT_VOICE_SETTINGS,
  GROQ_MODELS,
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

/**
 * True when a finished transcript contains NO real speech. Groq's hosted Whisper
 * (like every Whisper model) emits a bare filler token — most often a lone "." or
 * " ." — when the audio it receives has no intelligible speech (a mic capturing
 * only room tone / background noise). We must never paste that phantom into the
 * terminal. A transcript with no letter or digit is treated as no-speech.
 *
 * Deliberately conservative: ANY real word or number (even "you", "ok", "1") is
 * kept, so genuine dictation is never dropped — only pure punctuation/whitespace
 * (".", " . ", "...", "?!") is rejected. The capture-side gate (analyzeCapture)
 * stops most no-speech audio earlier; this is the backstop for audio that slips
 * past it yet still comes back empty from the model. Pure.
 */
export function isNoSpeechTranscript(text: string | null | undefined): boolean {
  return !/[\p{L}\p{N}]/u.test(text ?? '')
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
  // Only accept a Groq model id we actually offer; anything else (junk, or a
  // stale persisted local model id from an older build) falls back to the default.
  const groqModel = GROQ_MODELS.some((m) => m.id === r.groqModel) ? (r.groqModel as string) : d.groqModel
  return {
    enabled: bool(r.enabled, d.enabled),
    consentAccepted: bool(r.consentAccepted, d.consentAccepted),
    groqModel,
    inputDeviceId: str(r.inputDeviceId, d.inputDeviceId, 200),
    pushToTalkKey: str(r.pushToTalkKey, d.pushToTalkKey, 50),
    pushToTalkMode:
      r.pushToTalkMode === 'toggle' ? 'toggle' : r.pushToTalkMode === 'tapSpace' ? 'tapSpace' : 'hold',
    autoSubmitInAgent: bool(r.autoSubmitInAgent, d.autoSubmitInAgent),
    correctionEnabled: bool(r.correctionEnabled, d.correctionEnabled),
    confirmBeforeRunInShell: bool(r.confirmBeforeRunInShell, d.confirmBeforeRunInShell),
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
  // Skip non-finite samples (a glitched/dropped capture frame): a single NaN must
  // not poison the RMS into NaN — which would read as 'speech' and surface "NaN".
  for (let i = 0; i < pcm.length; i++) { const x = pcm[i]; if (Number.isFinite(x)) sum += x * x }
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

// ── Live capture instrumentation ──────────────────────────────────────────────
// The capture path was a black box for 8 releases: no way to SEE whether the mic
// was actually live, and a single RMS gate couldn't tell quiet speech from steady
// background noise. computeDisplayLevel drives the on-screen meter; analyzeCapture
// makes the speech/no-speech decision AND yields the numbers we surface, so a
// failure is legible ("level 0.004") instead of a silent phantom transcript.

/**
 * Map a raw RMS amplitude to a 0..1 meter level for display. Uses a sqrt curve so
 * quiet-but-real speech is clearly visible (linear would leave it a sliver), and
 * clamps to [0,1]. ~0.15 RMS ≈ full scale (a strong, close-mic voice). Pure.
 */
export function computeDisplayLevel(rms: number): number {
  if (!(rms > 0)) return 0
  const v = Math.sqrt(rms / 0.15)
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Meter tick marking where audio becomes reliably transcribable — aim above it. */
export const RELIABLE_SPEECH_RMS = 0.012

// Speech is dynamic: syllables and pauses make the loudest frame much louder than
// the quiet floor between words. Steady noise (fan/hum/mic-floor) is flat — peak ≈
// floor. This ratio separates them where a raw level gate can't, which is exactly
// the band just above SILENCE_RMS_THRESHOLD where Whisper hallucinates "the".
export const SPEECH_DYNAMIC_RATIO = 2.2
// Clearly-loud audio is accepted regardless of flatness (a held vowel can be flat).
export const LOUD_SPEECH_RMS = 0.05
const ANALYSIS_FRAME_SECONDS = 0.025

export type CaptureVerdict = 'speech' | 'silent' | 'noise'
export interface CaptureAnalysis {
  /** Overall RMS of the clip. */
  rms: number
  /** Loudest 25ms-frame RMS. */
  peak: number
  /** Low-percentile frame RMS — the "between words" floor. */
  floor: number
  /** peak / floor — high for speech, ≈1 for steady noise. */
  dynamicRatio: number
  durationSec: number
  verdict: CaptureVerdict
}

/**
 * Classify a captured clip as speech / silent / noise from its energy profile.
 * The bulletproof replacement for a bare RMS gate: it blocks BOTH true silence
 * AND steady background noise (the dead-zone that produced "the"), while NOT
 * rejecting genuine quiet speech (which still has a high dynamicRatio). Pure;
 * sampleRate only sets the frame + min-duration sizing.
 */
export function analyzeCapture(pcm: Float32Array, sampleRate = 16000): CaptureAnalysis {
  const durationSec = pcm.length / sampleRate
  const rms = audioRms(pcm)
  if (pcm.length < MIN_SPEECH_SECONDS * sampleRate) {
    return { rms, peak: rms, floor: rms, dynamicRatio: 1, durationSec, verdict: 'silent' }
  }
  const frameLen = Math.max(1, Math.floor(ANALYSIS_FRAME_SECONDS * sampleRate))
  const frames: number[] = []
  for (let i = 0; i + frameLen <= pcm.length; i += frameLen) {
    let sum = 0
    for (let j = i; j < i + frameLen; j++) { const x = pcm[j]; if (Number.isFinite(x)) sum += x * x }
    frames.push(Math.sqrt(sum / frameLen))
  }
  if (frames.length === 0) frames.push(rms)
  const sorted = [...frames].sort((a, b) => a - b)
  const peak = sorted[sorted.length - 1] ?? rms
  const floor = sorted[Math.floor(sorted.length * 0.2)] ?? sorted[0] ?? rms
  const dynamicRatio = peak / (floor + 1e-9)
  if (peak < SILENCE_RMS_THRESHOLD) {
    return { rms, peak, floor, dynamicRatio, durationSec, verdict: 'silent' }
  }
  // Flat (low dynamicRatio) AND not loud AND quiet OVERALL → noise. The rms guard
  // is the critical escape hatch: continuous, normal-volume speech has few pauses
  // (so a low dynamicRatio) yet a healthy overall RMS — without it, that speech
  // would be wrongly dropped as "noise". Genuine hum/fan sits below
  // RELIABLE_SPEECH_RMS and stays gated; anything at/above it is trusted as speech.
  if (dynamicRatio < SPEECH_DYNAMIC_RATIO && peak < LOUD_SPEECH_RMS && rms < RELIABLE_SPEECH_RMS) {
    return { rms, peak, floor, dynamicRatio, durationSec, verdict: 'noise' }
  }
  return { rms, peak, floor, dynamicRatio, durationSec, verdict: 'speech' }
}
