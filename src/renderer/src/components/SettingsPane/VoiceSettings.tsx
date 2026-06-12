import { useTerminalStore } from '../../store/terminalStore'

function Toggle({ on, onClick, testid, label }: { on: boolean; onClick: () => void; testid: string; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      data-testid={testid}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors mt-0.5 flex-shrink-0 ${on ? 'bg-[#0078d4]' : 'bg-[#555]'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${on ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
    </button>
  )
}

export function VoiceSettings() {
  const v = useTerminalStore((s) => s.voiceSettings)
  const set = useTerminalStore((s) => s.setVoiceSettings)

  return (
    <div className="flex flex-col gap-4" data-testid="voice-settings">
      <div className="flex items-start gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]">
        <Toggle on={v.enabled} onClick={() => set({ enabled: !v.enabled })} testid="voice-enable-toggle" label="Toggle voice input" />
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Enable voice input</span>
          <span className="text-xs text-[#9ca3af] leading-relaxed">
            {v.pushToTalkMode === 'hold' ? 'Hold' : 'Tap'} <kbd className="bg-[#3c3c3c] px-1 rounded">{v.pushToTalkKey}</kbd> in a
            terminal to dictate{v.pushToTalkMode === 'hold' ? ' (release to send)' : ' (tap again to stop)'}. In an AI-agent
            terminal the transcript is sent as a prompt; in a plain shell it is inserted and you confirm before it runs.
            Local, on-device transcription by default — nothing leaves your machine.
          </span>
        </div>
      </div>

      <fieldset disabled={!v.enabled} className={v.enabled ? '' : 'opacity-50'}>
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            Engine
            <select
              data-testid="voice-engine-select"
              value={v.engine}
              onChange={(e) => set({ engine: e.target.value === 'cloud' ? 'cloud' : 'local' })}
              className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm w-64 focus:outline-none"
            >
              <option value="local">Local — Whisper (English, offline, private)</option>
              <option value="cloud">Cloud — turbo (sends audio off-device)</option>
            </select>
          </label>

          {v.engine === 'local' ? (
            <div className="flex flex-col gap-1 text-sm">
              <span>Local model</span>
              <div
                data-testid="voice-model-display"
                className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm flex items-center gap-2"
              >
                <i className="fa-solid fa-microphone-lines text-[#82aaff] text-[11px]" />
                <span className="font-mono text-[#e0e0e0]">{v.model}</span>
                <span className="text-[10px] text-[#9ca3af]">English · on-device · bundled (~77 MB)</span>
              </div>
              <span className="text-xs text-[#9ca3af]">
                Ships with the app and transcribes fully offline. It is tuned for English dictation; for the
                highest accuracy, switch the engine to Cloud turbo (which sends audio off-device).
              </span>
            </div>
          ) : (
            <label className="flex flex-col gap-1 text-sm">
              Cloud STT endpoint
              <input
                data-testid="voice-endpoint-input"
                placeholder="https://your-stt-endpoint/transcribe"
                value={v.cloudEndpoint}
                onChange={(e) => set({ cloudEndpoint: e.target.value })}
                className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-none"
              />
            </label>
          )}

          <label className="flex flex-col gap-1 text-sm">
            Push-to-talk hotkey
            <input
              data-testid="voice-hotkey-input"
              value={v.pushToTalkKey}
              onChange={(e) => set({ pushToTalkKey: e.target.value })}
              className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm w-48 focus:outline-none font-mono"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            Activation
            <select
              data-testid="voice-mode-select"
              value={v.pushToTalkMode}
              onChange={(e) => set({ pushToTalkMode: e.target.value === 'toggle' ? 'toggle' : 'hold' })}
              className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm w-72 focus:outline-none"
            >
              <option value="hold">Hold to talk — release to send (push-to-talk)</option>
              <option value="toggle">Tap to start, tap again to stop (hands-free)</option>
            </select>
          </label>

          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <Toggle on={v.autoSubmitInAgent} onClick={() => set({ autoSubmitInAgent: !v.autoSubmitInAgent })} testid="voice-autosubmit-toggle" label="Toggle auto-submit in agent terminals" />
            <span className="flex flex-col gap-0.5">
              <span>Auto-submit dictation in AI-agent terminals</span>
              <span className="text-xs text-[#9ca3af]">Append Enter so the prompt sends as soon as you finish speaking.</span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <Toggle on={v.correctionEnabled} onClick={() => set({ correctionEnabled: !v.correctionEnabled })} testid="voice-correction-toggle" label="Toggle transcript correction" />
            <span className="flex flex-col gap-0.5">
              <span>Constrained LLM cleanup</span>
              <span className="text-xs text-[#9ca3af]">Lightly correct the transcript, but only when the result stays grounded in what was heard (no hallucinated rewrites).</span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <Toggle on={v.confirmBeforeRunInShell} onClick={() => set({ confirmBeforeRunInShell: !v.confirmBeforeRunInShell })} testid="voice-confirm-toggle" label="Toggle confirm before running shell commands" />
            <span className="flex flex-col gap-0.5">
              <span>Confirm before running dictated shell commands</span>
              <span className="text-xs text-[#9ca3af]">Strongly recommended — a mis-heard command is inserted for review, never run automatically.</span>
            </span>
          </label>
        </div>
      </fieldset>
    </div>
  )
}
