import { useEffect, useState } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import { GROQ_MODELS } from '../../lib/voice/voiceTypes'
import { MicTester } from './MicTester'
import { GroqConnectModal } from './GroqConnectModal'

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
  const [showConnect, setShowConnect] = useState(false)
  const [connected, setConnected] = useState(false)
  const [hint, setHint] = useState('')

  const refreshStatus = () => {
    window.termpolis
      ?.groqGetKeyStatus?.()
      .then((res) => {
        if (res?.success && res.data) {
          setConnected(res.data.connected)
          setHint(res.data.hint)
        }
      })
      .catch(() => {
        /* leave as disconnected */
      })
  }
  useEffect(() => {
    refreshStatus()
  }, [])

  return (
    <div className="flex flex-col gap-4" data-testid="voice-settings">
      <div className="flex items-start gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]">
        <Toggle on={v.enabled} onClick={() => set({ enabled: !v.enabled })} testid="voice-enable-toggle" label="Toggle voice input" />
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Enable voice input</span>
          <span className="text-xs text-[#9ca3af] leading-relaxed">
            {v.pushToTalkMode === 'hold' ? 'Hold' : 'Tap'} <kbd className="bg-[#3c3c3c] px-1 rounded">{v.pushToTalkKey}</kbd> in a
            terminal to dictate{v.pushToTalkMode === 'hold' ? ' (release to send)' : v.pushToTalkMode === 'tapSpace' ? ' (Spacebar to send)' : ' (tap again to stop)'}. In an AI-agent
            terminal the transcript is sent as a prompt; in a plain shell it is inserted and you confirm before it runs.
            Transcription uses Groq's cloud Whisper API — your recorded audio is sent to Groq (opt-in, off by default).
          </span>
        </div>
      </div>

      <fieldset disabled={!v.enabled} className={v.enabled ? '' : 'opacity-50'}>
        <div className="flex flex-col gap-4">
          {/* Groq connection */}
          <div className="flex flex-col gap-1 text-sm" data-testid="groq-connection-card">
            <span>Groq transcription</span>
            {connected ? (
              <div className="bg-[#1e1e1e] border border-[#2d5a3d] rounded px-2 py-1.5 flex items-center gap-2">
                <i className="fa-solid fa-circle-check text-[#7ee2a3] text-[11px]" />
                <span className="text-[#e0e0e0]">Connected</span>
                {hint && <span className="font-mono text-[10px] text-[#9ca3af]">{hint}</span>}
                <span className="text-[10px] text-[#9ca3af]">· key in OS keychain</span>
                <button
                  type="button"
                  data-testid="groq-manage-btn"
                  onClick={() => setShowConnect(true)}
                  className="ml-auto px-2 py-0.5 text-[11px] rounded bg-[#3c3c3c] hover:bg-[#4a4a4a] text-[#e0e0e0]"
                >
                  Manage
                </button>
              </div>
            ) : (
              <div className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1.5 flex items-center gap-2">
                <i className="fa-solid fa-bolt text-[#f55036] text-[11px]" />
                <span className="text-[#9ca3af]">Not connected — add your Groq API key to use voice.</span>
                <button
                  type="button"
                  data-testid="groq-connect-open-btn"
                  onClick={() => setShowConnect(true)}
                  className="ml-auto px-2 py-0.5 text-[11px] rounded bg-[#0e639c] hover:bg-[#1177bb] text-white"
                >
                  Connect Groq…
                </button>
              </div>
            )}
            <span className="text-xs text-[#9ca3af]">
              Free tier covers everyday dictation; paid is ~$0.04/hr of audio. The key is stored encrypted in your OS
              keychain and used only in the background — it never lands in settings or logs.
            </span>
          </div>

          {/* Model */}
          <label className="flex flex-col gap-1 text-sm">
            Transcription model
            <select
              data-testid="voice-model-select"
              value={v.groqModel}
              onChange={(e) => set({ groqModel: e.target.value })}
              className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm w-72 focus:outline-none"
            >
              {GROQ_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <MicTester />

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
              onChange={(e) => {
                const m = e.target.value
                set({ pushToTalkMode: m === 'toggle' ? 'toggle' : m === 'tapSpace' ? 'tapSpace' : 'hold' })
              }}
              className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm w-72 focus:outline-none"
            >
              <option value="hold">Hold to talk — release to send (push-to-talk)</option>
              <option value="tapSpace">Tap to start, Spacebar to send (hands-free)</option>
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

      {showConnect && (
        <GroqConnectModal
          onClose={() => {
            setShowConnect(false)
            refreshStatus()
          }}
        />
      )}
    </div>
  )
}
