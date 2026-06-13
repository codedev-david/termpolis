// Types + defaults for terminal voice input. LOCAL on-device Whisper
// (whisper-base.en via Transformers.js / onnxruntime-web) is the reliable
// default; managed cloud STT is an opt-in "turbo". Dictation drives the AI
// agents directly (agent mode); raw shell commands are NEVER auto-run
// (shell mode → confirm-before-run), and any LLM cleanup is CONSTRAINED.

export type VoiceEngineKind = 'local' | 'cloud'

export interface VoiceSettings {
  /** Master toggle. Off by default — opt-in feature. */
  enabled: boolean
  /** 'local' (on-device Whisper, default) or 'cloud' (opt-in turbo). */
  engine: VoiceEngineKind
  /** Local model id (ONNX, Transformers.js-loadable). */
  model: string
  /** Preferred microphone (MediaDeviceInfo.deviceId); '' = system default. */
  inputDeviceId: string
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

// Whisper-base.en (q8 ONNX) — the ENGLISH-ONLY model we BUNDLE and serve offline.
// Small (~77MB), runs on the wasm CPU backend in a few hundred ms for a short
// utterance. We deliberately ship the `.en` variant, NOT the multilingual
// `whisper-base`: the multilingual model auto-detects language on every clip and,
// on marginal audio, mis-detects and hallucinates — and it's measurably less
// accurate for English dictation (the English-only model also punctuates better).
// "Bigger" is the wrong axis here: a larger model would be much slower on the
// single-thread WASM CPU path without fixing hallucination, which is a no-speech
// problem, not a capacity one (see isNoSpeech). Distil-large-v3.5 is more accurate
// but ~0.5-1GB — too heavy to bundle for an opt-in feature; the Cloud engine is
// the opt-in path to higher accuracy. Only ids in BUNDLED_LOCAL_MODELS load
// (others — including a stale persisted 'whisper-base' — are coerced to this
// default in sanitizeVoiceSettings) because the worker is offline: it can ONLY
// load what ships in resources/models.
export const BUNDLED_LOCAL_MODELS = ['whisper-base.en'] as const

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: false,
  engine: 'local',
  model: 'whisper-base.en',
  inputDeviceId: '',
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
  /** Optionally pre-load the model so the first transcription isn't a cold start.
   *  Idempotent; safe to call while the user is still speaking. */
  warm?(): Promise<void>
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
