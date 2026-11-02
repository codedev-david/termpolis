// The swarm restart offers (§9, the in-app account UI §2.6): one card per agent's account that ran
// out, in the limit chooser's card frame, with the accounts its workers can be restarted on ("3 of
// the swarm's workers ran out of usage on personal" [Restart all on codedev]). It shows inside the
// swarm dashboard while that is open, at the top of each of its workers' panes on screen, and
// otherwise at the window's bottom right. Buttons only: it takes no key, and it covers nothing, so
// the swarm and the terminals go on under it while the user decides. What each button does, and
// what the conductor is told, is swarmRestart.ts's.
import { useEffect } from 'react'
import { declineRestart, installSwarmRestart, liveRestartDeps, offerTitle, restartOn, signInThenRestart, RESTART_WAIT_MS } from '../../lib/swarmRestart'
import { runConductorOn } from '../../lib/conductorManager'
import { isTerminalVisible } from '../../lib/limitWatch'
import type { RestartDeps, SwarmRestartGroup } from '../../lib/swarmRestart'
import { useTerminalStore } from '../../store/terminalStore'
import type { AccountsView } from '../../../../shared/agentAccounts'
import { SMALL_BUTTON as BUTTON, SMALL_PRIMARY as PRIMARY, STOP_CARD } from './ui'

const minutes = Math.round(RESTART_WAIT_MS / 60_000)
/** No offers: for a store that holds none (a dashboard's or a pane's tests mock one). */
const NONE: readonly SwarmRestartGroup[] = []

function Offer({ g, view, deps }: { g: SwarmRestartGroup; view: AccountsView | null; deps: () => RestartDeps }) {
  const label = (id: string): string => view?.accounts.find((r) => r.id === id)?.label ?? 'that account'
  const one = g.workers.length === 1
  const decline = (): void => { void declineRestart(g.id, deps()) }
  // The conductor's offer runs it again (conductorManager.ts); a worker's restarts it in place.
  const run = (id: string, confirmed = false): void => {
    void (g.conductor ? runConductorOn(g.id, id, confirmed) : restartOn(g.id, id, deps(), confirmed))
  }
  // A signed-out account is a way out once it is signed in: its sheet opens here, and the restart goes on after it.
  const signIn = (id: string): void => {
    if (!g.conductor) return signInThenRestart(g.id, id, deps())
    useTerminalStore.getState().openSignInSheet(id, () => { void runConductorOn(g.id, id) }, { doneLabel: `Run the conductor again on ${label(id)}` })
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
            {(g.signIn ?? []).map((id) => (
              <button key={`sign-in-${id}`} type="button" className={BUTTON} onClick={() => signIn(id)} data-testid="swarm-restart-sign-in">
                Sign in to {label(id)} and {g.conductor ? 'run the conductor again' : one ? 'restart' : 'restart all'}
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
    <div role="status" data-testid="swarm-restart-offer" data-phase={g.phase.kind} className={STOP_CARD}>
      <div className="flex items-start gap-2">
        <i className="fa-solid fa-hourglass-half text-[#e5c07b] mt-0.5" aria-hidden="true"></i>
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
            <i className="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        )}
      </div>
      {body}
    </div>
  )
}

/** Whether any of the offer's workers is on screen, where its pane shows the card. */
function onScreen(g: SwarmRestartGroup, s: Parameters<typeof isTerminalVisible>[0]): boolean {
  return g.workers.some((w) => isTerminalVisible(s, w.terminalId))
}

/** The offers at the window's bottom right: the ones not shown elsewhere now. `dashboardOpen`: the
 *  swarm dashboard is open, and shows them all. It always looks for stopped workers meanwhile. */
export function SwarmRestartOffers({ deps = liveRestartDeps, dashboardOpen = false }: { deps?: () => RestartDeps; dashboardOpen?: boolean }) {
  const groups = useTerminalStore((s) => s.swarmRestarts)
  const view = useTerminalStore((s) => s.accountsView)
  const terminals = useTerminalStore((s) => s.terminals)
  const viewMode = useTerminalStore((s) => s.viewMode)
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId)
  const paneTree = useTerminalStore((s) => s.paneTree)
  const showSettings = useTerminalStore((s) => s.showSettings)
  // Offered from the swarm's loop while the app runs, where main can switch accounts.
  useEffect(() => (window.accounts?.switchAccount ? installSwarmRestart(deps) : undefined), [deps])
  const screen = { terminals, viewMode, activeTerminalId, paneTree, showSettings }
  const shown = dashboardOpen ? [] : groups.filter((g) => !onScreen(g, screen))
  if (shown.length === 0) return null
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-[420px] max-w-[92vw]" data-testid="swarm-restart-offers">
      {shown.map((g) => <Offer key={g.id} g={g} view={view} deps={deps} />)}
    </div>
  )
}

/** Every offer, inside the swarm dashboard. */
export function SwarmRestartList({ deps = liveRestartDeps }: { deps?: () => RestartDeps }) {
  const groups = useTerminalStore((s) => s.swarmRestarts ?? NONE)
  const view = useTerminalStore((s) => s.accountsView ?? null)
  if (groups.length === 0) return null
  return (
    <div className="px-5 py-2 flex flex-col gap-2 border-b border-[#3c3c3c]" data-testid="swarm-restart-list">
      {groups.map((g) => <Offer key={g.id} g={g} view={view} deps={deps} />)}
    </div>
  )
}

/** The offer a stopped worker is in, at the top of its pane. */
export function SwarmRestartPaneCard({ terminalId, deps = liveRestartDeps }: { terminalId: string; deps?: () => RestartDeps }) {
  const g = useTerminalStore((s) => (s.swarmRestarts ?? NONE).find((x) => x.workers.some((w) => w.terminalId === terminalId)))
  const view = useTerminalStore((s) => s.accountsView ?? null)
  if (!g) return null
  return (
    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 w-[min(560px,92%)]" data-testid="swarm-restart-pane">
      <Offer g={g} view={view} deps={deps} />
    </div>
  )
}
