import { useEffect, useState } from 'react'

// Shown once on first launch. Introduces the app, captures the crash-reporting
// opt-in, and links to the privacy policy. Persisted via localStorage so it
// never reappears unless the user clears app data.
const SEEN_KEY = 'termpolis.onboarding.seen.v1'
export const TELEMETRY_KEY = 'termpolis.telemetry.optIn'

export function hasSeenOnboarding(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === '1' } catch { return false }
}

export function getTelemetryOptIn(): boolean {
  try { return localStorage.getItem(TELEMETRY_KEY) === '1' } catch { return false }
}

export function OnboardingModal({ onDone }: { onDone: () => void }) {
  const [telemetry, setTelemetry] = useState(true)

  useEffect(() => {
    // Default to opt-in only if the user hasn't made a choice before. If a
    // previous session stored a value we respect it as the starting state.
    try {
      const stored = localStorage.getItem(TELEMETRY_KEY)
      if (stored !== null) setTelemetry(stored === '1')
    } catch {}
  }, [])

  const finish = () => {
    try {
      localStorage.setItem(SEEN_KEY, '1')
      localStorage.setItem(TELEMETRY_KEY, telemetry ? '1' : '0')
    } catch {}
    // Mirror the opt-in to the main process so Sentry/updater pings see it
    // immediately. Without this, the user has to relaunch before crash
    // reporting actually engages.
    try { window.termpolis?.setTelemetryOptIn?.(telemetry) } catch {}
    onDone()
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80">
      <div
        className="bg-[#252526] border border-[#3c3c3c] rounded-xl shadow-2xl w-[540px] p-7 flex flex-col gap-5"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-labelledby="onboarding-title"
      >
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-[#22D3EE]/15 flex items-center justify-center">
            <i className="fa-solid fa-terminal text-[#22D3EE] text-xl"></i>
          </div>
          <div>
            <h2 id="onboarding-title" className="text-lg font-semibold text-[#d4d4d4]">Welcome to Termpolis</h2>
            <p className="text-xs text-[#9ca3af]">The AI-native terminal for developers</p>
          </div>
        </div>

        <div className="flex flex-col gap-3 text-sm text-[#d4d4d4] leading-relaxed">
          <p>
            Termpolis manages terminal sessions, split panes, and AI coding agents (Claude, Codex,
            Gemini, Aider) in one window. A built-in MCP server lets those agents drive the
            terminals directly.
          </p>
          <ul className="text-xs text-[#9ca3af] list-disc pl-5 space-y-1">
            <li>Press <kbd className="bg-[#3c3c3c] px-1 py-0.5 rounded text-[10px] text-[#999]">Ctrl+K</kbd> to open the command palette.</li>
            <li>Press <kbd className="bg-[#3c3c3c] px-1 py-0.5 rounded text-[10px] text-[#999]">Ctrl+Shift+S</kbd> to open the swarm dashboard.</li>
            <li>Right-click any terminal tab for per-pane actions.</li>
          </ul>
        </div>

        <label className="flex items-start gap-3 p-3 rounded-lg border border-[#3c3c3c] bg-[#1e1e1e] cursor-pointer hover:border-[#22D3EE]/40">
          <input
            type="checkbox"
            checked={telemetry}
            onChange={e => setTelemetry(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-[#22D3EE]"
            aria-label="Send anonymous crash reports"
          />
          <span className="flex flex-col gap-1">
            <span className="text-xs font-medium text-[#d4d4d4]">Send anonymous crash reports</span>
            <span className="text-[11px] text-[#9ca3af]">
              Helps us fix the bugs we can't see. No terminal contents, file paths, or personal data
              are collected — only error stack traces and the app version. You can change this later
              in Settings.
            </span>
          </span>
        </label>

        <div className="flex items-center justify-between text-[11px] text-[#9ca3af]">
          <a
            href="https://github.com/codedev-david/termpolis/blob/main/PRIVACY.md"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-[#22D3EE]"
          >
            Privacy policy
          </a>
          <a
            href="https://github.com/codedev-david/termpolis/blob/main/TERMS.md"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-[#22D3EE]"
          >
            Terms of use
          </a>
          <a
            href="https://github.com/codedev-david/termpolis/blob/main/LICENSE"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-[#22D3EE]"
          >
            License
          </a>
        </div>

        <div className="flex justify-end">
          <button
            onClick={finish}
            className="px-5 py-2 text-sm rounded-lg bg-[#22D3EE]/20 text-[#22D3EE] hover:bg-[#22D3EE]/30 font-medium"
          >
            Get started
          </button>
        </div>
      </div>
    </div>
  )
}
