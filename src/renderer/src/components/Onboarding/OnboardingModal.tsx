import { useEffect, useState } from 'react'

// Shown once on first launch. Walks new users through a 4-step orientation tour
// (welcome → API keys → first agent or swarm → security + crash-report opt-in)
// and persists the seen flag + telemetry choice to localStorage. The Help drawer
// has a "Show tour again" link that flips the seen flag back off so the user
// can revisit it without clearing app data.
const SEEN_KEY = 'termpolis.onboarding.seen.v1'
export const TELEMETRY_KEY = 'termpolis.telemetry.optIn'

const TOTAL_STEPS = 4

export function hasSeenOnboarding(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === '1' } catch { return false }
}

export function getTelemetryOptIn(): boolean {
  try { return localStorage.getItem(TELEMETRY_KEY) === '1' } catch { return false }
}

/** Reset the seen flag so the tour reopens on next mount. Used by the Help drawer. */
export function resetOnboarding(): void {
  try { localStorage.removeItem(SEEN_KEY) } catch {}
}

export function OnboardingModal({ onDone }: { onDone: () => void }) {
  const [telemetry, setTelemetry] = useState(true)
  const [step, setStep] = useState(1)

  useEffect(() => {
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
    try { window.termpolis?.setTelemetryOptIn?.(telemetry) } catch {}
    onDone()
  }

  const skip = () => {
    try {
      localStorage.setItem(SEEN_KEY, '1')
      localStorage.setItem(TELEMETRY_KEY, telemetry ? '1' : '0')
    } catch {}
    try { window.termpolis?.setTelemetryOptIn?.(telemetry) } catch {}
    onDone()
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80">
      <div
        className="bg-[#252526] border border-[#3c3c3c] rounded-xl shadow-2xl w-[600px] p-7 flex flex-col gap-5"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-labelledby="onboarding-title"
      >
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-[#22D3EE]/15 flex items-center justify-center">
            <i className="fa-solid fa-terminal text-[#22D3EE] text-xl"></i>
          </div>
          <div className="flex-1">
            <h2 id="onboarding-title" className="text-lg font-semibold text-[#d4d4d4]">Welcome to Termpolis</h2>
            <p className="text-xs text-[#9ca3af]">Secure AI-Assisted Development</p>
          </div>
          <div className="text-[11px] text-[#9ca3af]" aria-label={`Step ${step} of ${TOTAL_STEPS}`}>
            Step {step} of {TOTAL_STEPS}
          </div>
        </div>

        {/* Progress dots */}
        <div className="flex items-center gap-1.5" role="tablist" aria-label="Onboarding progress">
          {[1, 2, 3, 4].map(n => (
            <button
              key={n}
              role="tab"
              aria-selected={step === n}
              aria-label={`Go to step ${n}`}
              onClick={() => setStep(n)}
              className={`h-1.5 flex-1 rounded-full transition-colors ${
                n === step ? 'bg-[#22D3EE]' : n < step ? 'bg-[#22D3EE]/40' : 'bg-[#3c3c3c]'
              }`}
            />
          ))}
        </div>

        {/* Step content */}
        <div className="min-h-[260px] flex flex-col gap-3 text-sm text-[#d4d4d4] leading-relaxed">
          {step === 1 && (
            <div className="flex flex-col gap-3">
              <h3 className="text-base font-medium text-[#22D3EE]">What Termpolis is</h3>
              <p>
                Termpolis is a terminal that knows how to launch and coordinate AI coding
                agents (Claude Code, Codex, Gemini CLI, Qwen Code) in one window. Each agent
                runs in its own pane; you can drive one at a time or orchestrate a swarm of
                them.
              </p>
              <p>
                Termpolis itself doesn't talk to any cloud — there's no Termpolis account,
                no telemetry by default, no data leaving your machine until you ask an agent
                to do something.
              </p>
              <ul className="text-xs text-[#9ca3af] list-disc pl-5 space-y-1">
                <li>Press <kbd className="bg-[#3c3c3c] px-1 py-0.5 rounded text-[10px] text-[#999]">Ctrl+K</kbd> to open the command palette.</li>
                <li>Press <kbd className="bg-[#3c3c3c] px-1 py-0.5 rounded text-[10px] text-[#999]">Ctrl+/</kbd> any time to open Help.</li>
                <li>Right-click a terminal tab for per-pane actions.</li>
              </ul>
            </div>
          )}

          {step === 2 && (
            <div className="flex flex-col gap-3">
              <h3 className="text-base font-medium text-[#22D3EE]">Set an API key (one-time)</h3>
              <p>
                Each AI agent is a separate CLI tool with its own credentials. Termpolis
                doesn't ask for or store API keys — set one in your shell and the agent
                picks it up.
              </p>
              <div className="text-xs bg-[#1e1e1e] border border-[#3c3c3c] rounded p-2.5 space-y-1.5">
                <div><span className="text-[#22D3EE]">Anthropic (Claude Code):</span> <code className="text-[#d4d4d4]">ANTHROPIC_API_KEY</code></div>
                <div><span className="text-[#22D3EE]">OpenAI (Codex):</span> <code className="text-[#d4d4d4]">OPENAI_API_KEY</code></div>
                <div><span className="text-[#22D3EE]">Google AI Studio:</span> <code className="text-[#d4d4d4]">GEMINI_API_KEY</code></div>
                <div><span className="text-[#22D3EE]">Alibaba DashScope:</span> <code className="text-[#d4d4d4]">DASHSCOPE_API_KEY</code></div>
              </div>
              <p className="text-xs text-[#9ca3af]">
                Pick one provider to start — you don't need all four. Add the export to
                your <code>~/.bashrc</code>, <code>~/.zshrc</code>, or PowerShell profile,
                restart Termpolis, and the env var is inherited everywhere.
              </p>
              <p className="text-[11px] text-[#9ca3af] italic">
                Full guide:&nbsp;
                <a href="https://termpolis.com/docs.html#api-keys" target="_blank" rel="noopener noreferrer" className="underline hover:text-[#22D3EE]">
                  termpolis.com/docs.html#api-keys
                </a>
              </p>
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col gap-3">
              <h3 className="text-base font-medium text-[#22D3EE]">Launch your first agent (or swarm)</h3>
              <p>
                In the sidebar, the <strong>AI Agents</strong> section has a one-click
                launcher for each supported CLI. A green check means it's installed; a red
                X means it isn't (click for the npm install command).
              </p>
              <ul className="text-xs text-[#bbb] list-disc pl-5 space-y-1">
                <li><strong>Single agent:</strong> click an agent in the AI Agents row → a fresh terminal opens with that agent ready. Type your task in plain English.</li>
                <li><strong>Multi-agent swarm:</strong> press <kbd className="bg-[#3c3c3c] px-1 rounded text-[10px]">Ctrl+Shift+S</kbd> → describe the task → a Claude Code conductor decomposes it and assigns subtasks to the right agents.</li>
              </ul>
              <p className="text-xs text-[#9ca3af]">
                Not sure which to use? <strong>Single agent</strong> for iteration and
                debugging, <strong>swarm</strong> for parallelizable specs.
              </p>
            </div>
          )}

          {step === 4 && (
            <div className="flex flex-col gap-4">
              <h3 className="text-base font-medium text-[#22D3EE]">Security &amp; crash reports</h3>
              <p className="text-xs text-[#bbb] leading-relaxed">
                Open <strong>Settings → Security</strong> for the AI Security Center:
                pre-paste secret scanner, sensitive-file watcher, per-agent egress audit,
                and Strict Mode for Gemini's free OAuth tier. Everything in there runs
                locally.
              </p>

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
                    Helps us fix the bugs we can't see. No terminal contents, file paths, or
                    personal data are collected — only error stack traces and the app version.
                    Change this any time in Settings.
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
            </div>
          )}
        </div>

        {/* Footer nav */}
        <div className="flex items-center justify-between border-t border-[#3c3c3c] pt-4">
          <button
            onClick={skip}
            className="text-xs text-[#9ca3af] hover:text-[#d4d4d4] underline"
            aria-label="Skip the tour"
          >
            Skip tour
          </button>
          <div className="flex items-center gap-2">
            {step > 1 && (
              <button
                onClick={() => setStep(s => Math.max(1, s - 1))}
                className="px-4 py-1.5 text-sm rounded-lg border border-[#3c3c3c] text-[#d4d4d4] hover:bg-[#37373d]"
              >
                Back
              </button>
            )}
            {step < TOTAL_STEPS && (
              <button
                onClick={() => setStep(s => Math.min(TOTAL_STEPS, s + 1))}
                className="px-4 py-1.5 text-sm rounded-lg bg-[#22D3EE]/20 text-[#22D3EE] hover:bg-[#22D3EE]/30 font-medium"
              >
                Next
              </button>
            )}
            {step === TOTAL_STEPS && (
              <button
                onClick={finish}
                className="px-5 py-1.5 text-sm rounded-lg bg-[#22D3EE]/20 text-[#22D3EE] hover:bg-[#22D3EE]/30 font-medium"
              >
                Get started
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
