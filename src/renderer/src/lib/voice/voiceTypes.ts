// Types + defaults for terminal voice input. Per the researched recommendation:
// LOCAL Distil-Whisper (Transformers.js / onnxruntime-web) is the reliable
// default; managed cloud STT is an opt-in "turbo". Dictation drives the AI
// agents directly (agent mode); raw shell commands are NEVER auto-run
// (shell mode → confirm-before-run), and any LLM cleanup is CONSTRAINED.

export type VoiceEngineKind = 'local' | 'cloud'

export interface VoiceSettings {
  /** Master toggle. Off by default — opt-in feature. */
  enabled: boolean
  /** 'local' (Distil-Whisper, default) or 'cloud' (opt-in turbo). */
  engine: VoiceEngineKind
  /** Local model id (ONNX, Transformers.js-loadable). */
  model: string
  /** Push-to-talk combo (rebindable). */
  pushToTalkKey: string
  /** 'hold' = hold the combo to record, release to send (true push-to-talk);
   *  'toggle' = tap to start, tap again to stop (hands-free for long dictation). */
  pushToTalkMode: 'hold' | 'toggle'
  /** In an AI-agent terminal, append Enter so the prompt submits automatically. */
  autoSubmitInAgent: boolean
  /** Run the constrained STT→LLM cleanup stage on the transcript. */
  correctionEnabled: boolean
  /** Never auto-run dictated SHELL commands — insert and wait for the user. */
  confirmBeforeRunInShell: boolean
  /** Opt-in cloud STT endpoint (only used when engine === 'cloud'). */
  cloudEndpoint: string
}

// Whisper-base (q8 ONNX) — the model we BUNDLE and serve offline. Small (~77MB),
// runs on the wasm CPU backend in a few hundred ms for a short utterance, and is
// plenty accurate for dictating natural-language prompts to the AI agents (which
// absorb minor errors). Distil-large-v3.5 is more accurate but ~0.5-1GB — too
// heavy to bundle for an opt-in feature. Only ids in BUNDLED_LOCAL_MODELS load
// (others are coerced to this default in sanitizeVoiceSettings) because the
// worker is offline — it can ONLY load what ships in resources/models.
export const BUNDLED_LOCAL_MODELS = ['whisper-base'] as const

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: false,
  engine: 'local',
  model: 'whisper-base',
  pushToTalkKey: 'Ctrl+Shift+L', // letter, so Shift doesn't mutate it (matchesKeybinding compares e.key)
  pushToTalkMode: 'hold',
  autoSubmitInAgent: false,
  correctionEnabled: true,
  confirmBeforeRunInShell: true,
  cloudEndpoint: '',
}

export type VoiceMode = 'agent' | 'shell'

export interface TranscriptResult {
  text: string
  /** Alternative hypotheses — the grounding signal for constrained correction. */
  nbest?: string[]
}

export interface VoiceEngine {
  readonly kind: VoiceEngineKind
  /** Transcribe 16kHz mono PCM (Float32, [-1,1]) to text (+ optional N-best). */
  transcribe(pcm16k: Float32Array): Promise<TranscriptResult>
  /** Free model/worker resources. */
  dispose(): void
}

export interface InjectionPlan {
  /** Text to write into the active terminal. */
  text: string
  /** Append a carriage return (submit). */
  autoSubmit: boolean
  /** Show the confirm-before-run affordance (shell mode). */
  needsConfirm: boolean
}
