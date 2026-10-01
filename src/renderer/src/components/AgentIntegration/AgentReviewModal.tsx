import { useState } from 'react'
import type { AgentIntegrationSetResult, AgentIntegrationStatus } from '../../../../shared/agentIntegration'
import { AgentWritesList, PRIMER_HOOK_LABEL } from './AgentWritesList'

// Asked once, at launch, of someone with no agent-integration answer on record: an upgrade from
// a version that changed the agents' configs without asking (legacy), or someone who saw the tour
// before it had an agent step. Asked too when the tour's answer could not be saved, even over an
// answer on record (the one a re-run tour meant to change): the tour has closed before main
// replies, so it can't say so itself. Never in the session the tour shows, whose first step
// answers it. Either button records an answer; one that could not be saved is asked again next
// launch. There is no Escape: for a legacy install the second button disconnects, which is too
// much for a key.

const UNSAVED_KEY = 'termpolis.agentIntegration.unsaved.v1'

/** Note whether main saved the agent answer just sent: one it didn't is asked again at the next
 *  launch. Never throws. */
export function noteAgentAnswerSaved(saved: boolean): void {
  try {
    if (saved) localStorage.removeItem(UNSAVED_KEY)
    else localStorage.setItem(UNSAVED_KEY, '1')
  } catch {}
}

function answerUnsaved(): boolean {
  try { return localStorage.getItem(UNSAVED_KEY) === '1' } catch { return false }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** The status to review, or null when there is nothing to ask. Never throws: when main can't
 *  be asked, nothing is. */
export async function agentReviewNeeded(onboardingSeen: boolean): Promise<AgentIntegrationStatus | null> {
  try {
    const res = await window.termpolis.agentIntegrationStatus()
    if (!res.success) return null
    const status = res.data
    if (answerUnsaved()) return status
    return status.consent === null && (status.legacyDetected || onboardingSeen) ? status : null
  } catch {
    return null
  }
}

export function AgentReviewModal({ status, onDone }: { status: AgentIntegrationStatus; onDone: () => void }) {
  const [primerHook, setPrimerHook] = useState(status.primerHook)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Already connected (by an earlier version, or granted): the choice is to keep it or undo it.
  const connected = status.legacyDetected || status.connected

  const answer = async (connect: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const res = await window.termpolis.agentIntegrationSet(connect ? { connect: true, primerHook } : { connect: false })
      if (!res.success) {
        setError(res.error)
      } else {
        // Main can act on an answer it then fails to save; unsaved, it is asked again next launch.
        const data: AgentIntegrationSetResult = res.data
        if (!data.saveError) {
          noteAgentAnswerSaved(true)
          onDone()
          return
        }
        setError(data.saveError)
      }
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80" data-testid="agent-review-modal">
      <div
        className="bg-[#252526] border border-[#3c3c3c] rounded-xl shadow-2xl w-[600px] max-h-[95vh] overflow-y-auto p-7 flex flex-col gap-4"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-review-title"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#22D3EE]/15 flex items-center justify-center">
            <i className="fa-solid fa-plug text-[#22D3EE]"></i>
          </div>
          <div>
            <h2 id="agent-review-title" className="text-lg font-semibold text-[#d4d4d4]">Termpolis and your coding agents</h2>
            <p className="text-xs text-[#9ca3af]">Asked once. Change it any time in Settings ▸ Agent Integration.</p>
          </div>
        </div>

        {status.legacyDetected ? (
          <p className="text-xs text-[#bbb] leading-relaxed" data-testid="agent-review-legacy">
            Earlier versions changed Claude Code, Codex and Gemini CLI settings without asking. This
            version already removed the wildcard permission that let agents run any Termpolis tool
            without asking, its duplicate Claude Code plugin, and trust for your home folder, and no
            longer writes AGENTS.md into projects. Staying connected keeps exactly the list below.
          </p>
        ) : (
          <p className="text-xs text-[#bbb] leading-relaxed" data-testid="agent-review-intro">
            Termpolis can connect to your coding agents, so they can use its memory and code search.
            Connecting writes exactly the list below, and only for agents installed on this machine.
          </p>
        )}

        <AgentWritesList status={status} />

        <label className="flex items-start gap-3 p-3 rounded-lg border border-[#3c3c3c] bg-[#1e1e1e] cursor-pointer hover:border-[#22D3EE]/40">
          <input
            type="checkbox"
            checked={primerHook}
            disabled={busy}
            onChange={e => setPrimerHook(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-[#22D3EE]"
            data-testid="agent-review-primer-hook"
          />
          <span className="text-xs font-medium text-[#d4d4d4]">{PRIMER_HOOK_LABEL}</span>
        </label>

        {error !== null && (
          <div
            className="flex items-start gap-3 p-3 rounded-lg border border-[#e06c75]/50 bg-[#1e1e1e]"
            role="alert"
            data-testid="agent-review-error"
          >
            <span className="flex flex-col gap-1 flex-1">
              <span className="text-xs text-[#e06c75]">
                Couldn&apos;t save your answer, so you&apos;ll be asked again next launch.
              </span>
              <span className="text-[11px] text-[#9ca3af] break-all">{error}</span>
            </span>
            <button
              onClick={onDone}
              className="px-3 py-1 text-xs rounded-lg border border-[#3c3c3c] text-[#d4d4d4] hover:bg-[#37373d]"
              data-testid="agent-review-close"
            >
              Close
            </button>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-[#3c3c3c] pt-4">
          <button
            onClick={() => { void answer(false) }}
            disabled={busy}
            className="px-4 py-1.5 text-sm rounded-lg border border-[#3c3c3c] text-[#d4d4d4] hover:bg-[#37373d] disabled:opacity-50"
            data-testid="agent-review-disconnect"
          >
            {connected ? 'Disconnect' : 'Not now'}
          </button>
          <button
            onClick={() => { void answer(true) }}
            disabled={busy}
            className="px-5 py-1.5 text-sm rounded-lg bg-[#22D3EE]/20 text-[#22D3EE] hover:bg-[#22D3EE]/30 font-medium disabled:opacity-50"
            data-testid="agent-review-connect"
          >
            {connected ? 'Keep connected' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  )
}
