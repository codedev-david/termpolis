// Shown when the user clicks the on-pane Voice button but Groq cloud
// transcription isn't connected yet. Voice dictation is Groq-only (local Whisper
// was removed in v1.13.0), so without a stored Groq key the microphone can't do
// anything — this gate explains that and routes the user to Settings → Voice to
// connect, instead of silently starting a capture that can only fail.

interface VoiceGroqGateProps {
  onOpenSettings: () => void
  onClose: () => void
}

export function VoiceGroqGate({ onOpenSettings, onClose }: VoiceGroqGateProps) {
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 animate-fadeIn"
      data-testid="voice-groq-gate"
    >
      <div className="bg-[#252526] rounded-lg shadow-xl border border-[#3c3c3c] w-[440px] max-h-[88vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#3c3c3c]">
          <h2 className="text-sm font-semibold flex items-center gap-2 text-[#e0e0e0]">
            <i className="fa-solid fa-microphone text-[#f55036]"></i>
            Voice typing needs Groq
          </h2>
          <button onClick={onClose} aria-label="Close" className="text-[#9ca3af] hover:text-white text-lg px-1">
            &times;
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-3 text-sm text-[#d4d4d4]">
          <p className="leading-relaxed">
            Voice dictation transcribes your speech with Groq&apos;s cloud API, which isn&apos;t connected yet.
          </p>
          <p className="text-xs text-[#9ca3af] leading-relaxed">
            Open <strong>Settings → Voice</strong> and connect Groq Turbo (a free API key) to use the microphone. Your
            key is stored in your OS keychain and never written to settings or logs.
          </p>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-[#3c3c3c]">
          <button
            data-testid="voice-groq-gate-dismiss"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded bg-[#3c3c3c] hover:bg-[#4a4a4a] text-[#e0e0e0]"
          >
            Not now
          </button>
          <button
            data-testid="voice-groq-gate-open-settings"
            onClick={onOpenSettings}
            className="px-4 py-1.5 text-sm rounded bg-[#0078d4] hover:bg-[#106ebe] text-white"
          >
            Open Voice Settings
          </button>
        </div>
      </div>
    </div>
  )
}
