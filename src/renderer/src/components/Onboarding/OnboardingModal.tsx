import { useEffect, useRef, useState } from 'react'
import type { AgentIntegrationStatus } from '../../../../shared/agentIntegration'
import { readConsentMirror, saveConsent } from '../../lib/sentry'
import { AgentConnectStep, type AgentChoice } from '../AgentIntegration/AgentConnectStep'
import { PrivacyChoices } from './PrivacyChoices'

// Shown once on first launch. Walks new users through a 6-step orientation tour
// (connect your coding agents → welcome → API keys → first agent or swarm → security →
// privacy choices) and persists the seen flag to localStorage. Leaving the tour, from
// any step, saves the choices exactly as shown: the agent choice from the first step
// (sent to main only when there is no answer on record or it changed; nothing is written
// to an agent's config before then) and the privacy choices from the last. So "Skip tour"
// (and Escape) closes it at once, and skipping a first run saves telemetry off and the
// agent choice shown on the first step. The Help drawer has a "Show tour again" link that
// flips the seen flag back off so the user can revisit it without clearing app data.
const SEEN_KEY = 'termpolis.onboarding.seen.v1'

const TOTAL_STEPS = 6
const PRIVACY_STEP = TOTAL_STEPS

export function hasSeenOnboarding(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === '1' } catch { return false }
}

/** Reset the seen flag so the tour reopens on next mount. Used by the Help drawer. */
export function resetOnboarding(): void {
  try { localStorage.removeItem(SEEN_KEY) } catch {}
}

/** The agent answer main has on record: null when there is none, or main can't be asked. */
async function readAgentStatus(): Promise<AgentIntegrationStatus | null> {
  try {
    const res = await window.termpolis.agentIntegrationStatus()
    return res.success && res.data.consent !== null ? res.data : null
  } catch {
    return null
  }
}

function sameChoice(choice: AgentChoice, status: AgentIntegrationStatus): boolean {
  return choice.connect === status.connected && (!choice.connect || choice.primerHook === status.primerHook)
}

/** Sends the first step's choice to main unless it is the answer already on record. Never
 *  throws: the tour has closed by then, and an answer main didn't take is asked at next launch. */
async function applyAgentChoice(
  choice: AgentChoice,
  edited: boolean,
  recorded: Promise<AgentIntegrationStatus | null> | null,
): Promise<void> {
  try {
    const status = await recorded
    // Left untouched, the step shows the answer on record (or would have, had main answered in time).
    if (status && (!edited || sameChoice(choice, status))) return
    await window.termpolis.agentIntegrationSet({ connect: choice.connect, primerHook: choice.primerHook })
  } catch {}
}

export function OnboardingModal({ onDone }: { onDone: () => void }) {
  // A first run shows both tiers off; "Show tour again" shows the choices already made.
  const [crash, setCrash] = useState(() => readConsentMirror().crash)
  const [usage, setUsage] = useState(() => readConsentMirror().usage)
  // Connected with the hook on, unless main has another answer on record. The step can be
  // answered before main replies, so a late reply never overwrites the user's own ticks.
  const [agents, setAgents] = useState<AgentChoice>({ connect: true, primerHook: true })
  const recorded = useRef<Promise<AgentIntegrationStatus | null> | null>(null)
  const edited = useRef(false)
  const [step, setStep] = useState(1)

  useEffect(() => {
    const read = readAgentStatus()
    recorded.current = read
    void read.then(status => {
      if (status && !edited.current) setAgents({ connect: status.connected, primerHook: status.primerHook })
    })
  }, [])

  const editAgents = (next: AgentChoice) => {
    edited.current = true
    setAgents(next)
  }

  const finish = () => {
    void saveConsent({ crash, usage })
    void applyAgentChoice(agents, edited.current, recorded.current)
    try { localStorage.setItem(SEEN_KEY, '1') } catch {}
    onDone()
  }

  // Re-bound every render so Escape (like Skip tour) saves the current choices.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80">
      <div
        className="bg-[#252526] border border-[#3c3c3c] rounded-xl shadow-2xl w-[600px] max-h-[95vh] overflow-y-auto p-7 flex flex-col gap-5"
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
          {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map(n => (
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
            <AgentConnectStep connect={agents.connect} primerHook={agents.primerHook} onChange={editAgents} />
          )}

          {step === 2 && (
            <div className="flex flex-col gap-3">
              <h3 className="text-base font-medium text-[#22D3EE]">What Termpolis is</h3>
              <p>
                Termpolis is a terminal that knows how to launch and coordinate AI coding
                agents (Claude Code, Codex, Gemini CLI) in one window. Each agent
                runs in its own pane; you can drive one at a time or orchestrate a swarm of
                them.
              </p>
              <p>
                There's no Termpolis account. Out of the box, Termpolis itself only checks
                GitHub for updates; each agent talks to its own provider, and crash reports
                and usage statistics stay off unless you turn them on at the end of this tour.
              </p>
              <ul className="text-xs text-[#9ca3af] list-disc pl-5 space-y-1">
                <li>Press <kbd className="bg-[#3c3c3c] px-1 py-0.5 rounded text-[10px] text-[#999]">Ctrl+K</kbd> to open the command palette.</li>
                <li>Press <kbd className="bg-[#3c3c3c] px-1 py-0.5 rounded text-[10px] text-[#999]">Ctrl+/</kbd> any time to open Help.</li>
                <li>Right-click a terminal tab for per-pane actions.</li>
              </ul>
            </div>
          )}

          {step === 3 && (
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
              </div>
              <p className="text-xs text-[#9ca3af]">
                Pick one provider to start — you don't need all three. Add the export to
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

          {step === 4 && (
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

          {step === 5 && (
            <div className="flex flex-col gap-3">
              <h3 className="text-base font-medium text-[#22D3EE]">Security</h3>
              <p>
                Open <strong>Settings → Security</strong> for the AI Security Center:
                pre-paste secret scanner, sensitive-file watcher, per-agent egress audit,
                and Strict Mode for Gemini's free OAuth tier. Everything in there runs
                locally.
              </p>
            </div>
          )}

          {step === PRIVACY_STEP && (
            <div className="flex flex-col gap-3">
              <h3 className="text-base font-medium text-[#22D3EE]">Your privacy choices</h3>
              <p className="text-xs text-[#bbb]">
                Both are off unless you tick them. Change either one any time in
                <strong> Settings → General → Privacy</strong>.
              </p>

              <PrivacyChoices
                crash={crash}
                usage={usage}
                onCrashChange={setCrash}
                onUsageChange={setUsage}
                slotTestId="onboarding-agent-integrations-slot"
              />

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
            onClick={finish}
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
