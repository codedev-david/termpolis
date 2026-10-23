// The swarm restart offers (§9): one card per agent's account that ran out, at the window's bottom
// right, above the swarm dashboard, with the accounts its workers can be restarted on ("3 of the
// swarm's workers ran out of usage on personal" [Restart all on codedev]). Buttons only: it takes no
// key, and it covers nothing, so the swarm and the terminals go on under it while the user decides.
// What each button does, and what the conductor is told, is swarmRestart.ts's.
import { useEffect } from 'react'
import { declineRestart, installSwarmRestart, liveRestartDeps, offerTitle, restartOn, RESTART_WAIT_MS } from '../../lib/swarmRestart'
import { runConductorOn } from '../../lib/conductorManager'
import type { RestartDeps, SwarmRestartGroup } from '../../lib/swarmRestart'
import { useTerminalStore } from '../../store/terminalStore'
import type { AccountsView } from '../../../../shared/agentAccounts'

const BUTTON = 'text-xs px-2 py-1 rounded bg-[#2d2d2d] text-[#d4d4d4] hover:bg-[#3a3a3a]'
const PRIMARY = 'text-xs px-2 py-1 rounded bg-[#0e639c] text-white hover:bg-[#1177bb]'

const minutes = Math.round(RESTART_WAIT_MS / 60_000)

function Offer({ g, view, deps }: { g: SwarmRestartGroup; view: AccountsView | null; deps: () => RestartDeps }) {
  const label = (id: string): string => view?.accounts.find((r) => r.id === id)?.label ?? 'that account'
  const one = g.workers.length === 1
  const decline = (): void => { void declineRestart(g.id, deps()) }
  // The conductor's offer runs it again (conductorManager.ts); a worker's restarts it in place.
  const run = (id: string, confirmed = false): void => {
    void (g.conductor ? runConductorOn(g.id, id, confirmed) : restartOn(g.id, id, deps(), confirmed))
  }
  const done = g.phase.kind === 'done'
  let body: React.ReactNode
  switch (g.phase.kind) {
    case 'offered':
      body = (
        <>
          <div className="flex gap-2 flex-wrap">
            {g.targets.map((id) => (
              <button key={id} type="button" className={PRIMARY} onClick={() => run(id)} data-testid="swarm-restart-on">
                {g.conductor ? 'Run the conductor again' : one ? 'Restart it' : 'Restart all'} on {label(id)}
              </button>
            ))}
            {!g.conductor && <button type="button" className={BUTTON} onClick={decline} data-testid="swarm-restart-decline">Let the conductor reassign</button>}
          </div>
          <p className="text-[#9ca3af]">
            {g.conductor
              ? 'It resumes its conversation where that account can see it, or starts again with the same goal. The swarm\'s workers and tasks stay.'
              : `${one ? 'It keeps its conversation and its task' : 'They keep their conversations and their tasks'}. With no answer in ${minutes} minutes, the conductor gives ${one ? 'its task' : 'their tasks'} to another agent.`}
          </p>
        </>
      )
      break
    case 'confirm': {
      const { targetId, question } = g.phase
      body = (
        <>
          <p data-testid="swarm-restart-question">{question}</p>
          <div className="flex gap-2">
            <button type="button" className={PRIMARY} onClick={() => run(targetId, true)} data-testid="swarm-restart-confirm">{g.conductor ? 'Run it' : 'Restart'} on {label(targetId)}</button>
            <button type="button" className={BUTTON} onClick={decline} data-testid="swarm-restart-decline">Don&apos;t {g.conductor ? 'run it again' : 'restart'}</button>
          </div>
        </>
      )
      break
    }
    case 'restarting':
      body = <p data-testid="swarm-restart-running">{g.conductor ? 'Running the conductor again' : 'Restarting'} on {label(g.phase.targetId)}…</p>
      break
    default:
      body = (
        <ul data-testid="swarm-restart-done" className="list-disc pl-4">
          {g.phase.lines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      )
  }
  const closable = g.phase.kind !== 'restarting'
  return (
    <div role="status" data-testid="swarm-restart-offer" data-phase={g.phase.kind} className="bg-[#1f1f1f] border border-[#e5c07b]/60 rounded-lg p-3 flex flex-col gap-2 text-xs text-[#d4d4d4] shadow-lg">
      <div className="flex items-start gap-2">
        <i className="fa-solid fa-hourglass-half text-[#e5c07b] mt-0.5"></i>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-[#e0e0e0]">{offerTitle(g, view)}</p>
          <p className="text-[#9ca3af] truncate" title={g.words}>&ldquo;{g.words}&rdquo;</p>
        </div>
        {closable && (
          <button
            type="button"
            className="px-1.5 rounded hover:bg-white/10"
            aria-label={done || g.conductor ? 'Close' : 'Don\'t restart: the conductor reassigns'}
            title={done || g.conductor ? 'Close' : 'Don\'t restart: the conductor reassigns'}
            onClick={done ? () => useTerminalStore.getState().dropSwarmRestart(g.id) : decline}
            data-testid="swarm-restart-close"
          >
            <i className="fa-solid fa-xmark"></i>
          </button>
        )}
      </div>
      {body}
    </div>
  )
}

export function SwarmRestartOffers({ deps = liveRestartDeps }: { deps?: () => RestartDeps }) {
  const groups = useTerminalStore((s) => s.swarmRestarts)
  const view = useTerminalStore((s) => s.accountsView)
  // Offered from the swarm's loop while the app runs, where main can switch accounts.
  useEffect(() => (window.accounts?.switchAccount ? installSwarmRestart(deps) : undefined), [deps])
  if (groups.length === 0) return null
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-[420px] max-w-[92vw]" data-testid="swarm-restart-offers">
      {groups.map((g) => <Offer key={g.id} g={g} view={view} deps={deps} />)}
    </div>
  )
}
