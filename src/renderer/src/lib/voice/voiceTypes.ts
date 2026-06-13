// Types + defaults for terminal voice input. Transcription uses Groq's hosted
// Whisper API (cloud) — opt-in, OFF by default, with the API key stored in the
// OS keychain in the MAIN process (it never enters the renderer). Dictation
// drives the AI agents directly (agent mode); raw shell commands are NEVER
// auto-run (shell mode → confirm-before-run), and any LLM cleanup is CONSTRAINED.

export interface VoiceSettings {
  /** Master toggle. Off by default — opt-in feature. */
  enabled: boolean
  /** The user has accepted the disclosure that audio is sent to Groq for
   *  transcription. Required before voice can be enabled. */
  consentAccepted: boolean
  /** Groq Whisper model id (see GROQ_MODELS). */
  groqModel: string
  /** Preferred microphone (MediaDeviceInfo.deviceId); '' = system default. */
  inputDeviceId: string
  /** Activation combo (rebindable) — tapped or held depending on the mode. */
  pushToTalkKey: string
  /** How the activation combo drives recording:
   *  'tapOrHold' (default) = TAP the combo to start hands-free dictation and tap
   *    again to stop, OR HOLD it to talk and release to send — one key, both;
   *  'toggle' = tap the combo to start, tap it again to stop (no hold-to-talk);
   *  'tapSpace' = tap the combo to start, then press the send key (Spacebar by
   *    default, rebindable via sendKey) to stop and send. */
  pushToTalkMode: 'tapOrHold' | 'toggle' | 'tapSpace'
  /** The key that stops & sends dictation in 'tapSpace' mode (rebindable). A
   *  keybinding string like 'Space' or 'Enter', matched via matchesKeybinding. */
  sendKey: string
  /** In an AI-agent terminal, append Enter so the prompt submits automatically. */
  autoSubmitInAgent: boolean
  /** Run the constrained STT→LLM cleanup stage on the transcript. */
  correctionEnabled: boolean
  /** Never auto-run dictated SHELL commands — insert and wait for the user. */
  confirmBeforeRunInShell: boolean
}

// The Groq Whisper models we expose. Turbo is the default: fastest and cheapest
// (~$0.04/hr of audio), and accurate enough that the more expensive large-v3 is
// rarely worth the latency for dictation. The id must match a Groq model id.
export const GROQ_MODELS = [
  { id: 'whisper-large-v3-turbo', label: 'Turbo — fastest, ~$0.04/hr (recommended)' },
  { id: 'whisper-large-v3', label: 'Large v3 — most accurate, ~$0.11/hr' },
] as const

export const DEFAULT_GROQ_MODEL = 'whisper-large-v3-turbo'

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: false,
  consentAccepted: false,
  groqModel: DEFAULT_GROQ_MODEL,
  inputDeviceId: '',
  pushToTalkKey: 'Ctrl+Shift+L', // letter, so Shift doesn't mutate it (matchesKeybinding compares e.key)
  pushToTalkMode: 'tapOrHold',
  sendKey: 'Space',
  autoSubmitInAgent: false,
  correctionEnabled: true,
  confirmBeforeRunInShell: true,
}

export type VoiceMode = 'agent' | 'shell'

export interface TranscriptResult {
  text: string
  /** Alternative hypotheses — the grounding signal for constrained correction. */
  nbest?: string[]
}

export interface VoiceEngine {
  /** Transcribe 16kHz mono PCM (Float32, [-1,1]) to text (+ optional N-best). */
  transcribe(pcm16k: Float32Array): Promise<TranscriptResult>
  /** Optionally pre-load/warm the engine. No-op for the cloud engine; kept so the
   *  hook's warm-up call stays uniform. Idempotent. */
  warm?(): Promise<void>
  /** Free any resources. */
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
