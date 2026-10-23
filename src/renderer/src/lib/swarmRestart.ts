// The swarm restart offer (§9, item 8): a swarm worker that ran out of usage is offered a restart
// on another account of its agent, in place, before the conductor gives its task away. Ask mode
// only: the user picks the account, in a panel that never takes a key (SwarmRestartOffers.tsx),
// grouped by the account that ran out ("3 of the swarm's workers ran out of usage on personal",
// [Restart all on codedev]). Nothing is typed into a worker before the user picks.
//
// Offered only where it can work (§8.3, R16): a Claude Code or Codex worker on an account Termpolis
// knows, and another account of that agent that is a way out (limitTargets: offered automatically,
// so never the work account, D14; not out of usage; signed in now, to another sign-in), connected,
// so the worker keeps Termpolis's tools (rule 8), and for Claude Code, whose worker runs with
// --dangerously-skip-permissions, one that skips the bypass warning (R16). Otherwise the conductor
// is told as in v1.54.0, word for word (swarmStopReports.ts), and nothing else changes (D13).
//
// The conductor is told, one message per stop: at the stop, to wait; after the restart, that the
// worker resumed its conversation and waits at its prompt, or started without it (Codex's path
// (c)); when the user declines, a restart fails, or no answer comes in RESTART_WAIT_MS, v1.54.0's
// close-and-reassign. The clock stops the moment the user acts, and close-and-reassign never goes
// while the worker's relaunch lock is held (R16). A restart is refused once the conductor closed
// the worker or gave its task to another (R16), and a restarted worker's stop is carried, so the
// same limit drawn again by the resumed session is no new one until it took a turn (R4).
//
// The conductor's own limit (P2) ends its `claude -p`: the swarm loop never sees it, its run
// script's report does (conductorManager.ts). Where a Claude Code account is a way out, the same
// card offers to run the conductor again there (offerConductorRun), which conductorManager does.
import { v4 as uuid } from 'uuid'
import { ACCOUNT_AGENT_LABEL, isProfileAgent } from '../../../shared/agentAccounts'
import type { AccountRowView, AccountsView, ProfileAgent } from '../../../shared/agentAccounts'
import { limitKindOf, limitTargets, parseResetsAt, resetTextOf } from '../../../shared/accountLimits'
import type { LimitKind, LimitTarget, TargetCheck } from '../../../shared/accountLimits'
import type { AgentStatusResult } from '../../../shared/agentStatusDetector'
import type { SwitchOutcome } from '../../../shared/accountSwitch'
import { checkSignIn, outcomeView, runSwitch } from './accountSwitchFlow'
import { workerBlocker } from './accountsView'
import type { SwitchDeps } from './accountSwitchFlow'
import { recentCheck } from './limitChooser'
import { osNotify, setSwarmStopOffer } from './limitWatch'
import { carryIfStopped, carryWorkerStop, reportWorkerStop } from './swarmStopReports'
import type { SwarmWorker } from './swarmStopReports'
import type { AccountsAPI, SwarmAPI, TerminalSession } from '../types'
import { isAutoPrimerEnabled } from '../hooks/useAutoPrimer'
import { useTerminalStore } from '../store/terminalStore'

/** How long the offer waits for the user before the conductor is told to reassign (§9). */
export const RESTART_WAIT_MS = 5 * 60_000
/** While a relaunch holds a worker when its time is up, how often it looks again. */
export const LOCK_RECHECK_MS = 5000

/** A worker the offer is for, as it stopped. */
export interface RestartWorker extends SwarmWorker {
  /** The detector's summary of its stop, as v1.54.0's report says it. */
  summary: string
  /** The open task assigned to it when it stopped: its restart is refused once that changed. */
  taskId?: string
}

export type RestartPhase =
  /** The panel offers its accounts. */
  | { kind: 'offered' }
  /** The user picked one; carrying the conversations off an account not offered automatically
   *  asks once more (R17). */
  | { kind: 'confirm'; targetId: string; question: string }
  | { kind: 'restarting'; targetId: string }
  /** How each worker's restart went, one line each. */
  | { kind: 'done'; lines: string[] }

/** One offer: the workers of one agent that ran out on one account, and the accounts that are a way
 *  out, in failover order; or, `conductor`, the swarm's conductor, which has no workers here. */
export interface SwarmRestartGroup {
  id: string
  conductor?: true
  agent: ProfileAgent
  /** The account that ran out. */
  accountId: string
  /** The CLI's own words. */
  words: string
  resetsAt: number | null
  workers: RestartWorker[]
  targets: string[]
  phase: RestartPhase
}

/** What the offer reads and changes in the store. */
export interface RestartStore {
  accountsView: AccountsView | null
  accountsByHand: Record<string, true>
  terminals: TerminalSession[]
  swarmAgents: readonly SwarmWorker[]
  relaunching: Record<string, 'account' | 'model' | 'sign-in'>
  swarmRestarts: SwarmRestartGroup[]
  putSwarmRestart: (g: SwarmRestartGroup) => void
  dropSwarmRestart: (id: string) => void
  beginRelaunch: (terminalId: string, kind: 'account' | 'model' | 'sign-in') => boolean
  endRelaunch: (terminalId: string) => void
}

export interface RestartDeps extends SwitchDeps {
  store: () => RestartStore
  swarm: Pick<SwarmAPI, 'getTasks' | 'sendMessage'>
  accounts: Pick<AccountsAPI, 'switchAccount' | 'check' | 'noteLimit' | 'limitLook'>
  now: () => number
  newId: () => string
  /** The window has the focus. */
  focused: () => boolean
  /** An OS notification, for an offer the window didn't show while it wasn't focused. */
  notify: (title: string, body: string, onClick: () => void) => void
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

// ── Which accounts a worker can be restarted on ──────────────────────────────────────────

export { workerBlocker }

/** The accounts a worker of `agent` that ran out on `limited` can be restarted on: a way out by the
 *  chooser's rules (limitTargets, with what each agent said of its sign-in in `checks`), that can
 *  take a worker over (workerBlocker), and not out of usage on the same model the worker hit (R15). */
export function restartTargets(
  view: AccountsView,
  agent: ProfileAgent,
  limited: { accountId: string; email: string | null },
  now: number,
  checks: Readonly<Record<string, TargetCheck>>,
  kind: LimitKind,
): LimitTarget[] {
  return limitTargets(view.accounts, agent, limited, now, checks).filter((t) =>
    t.state === 'available' && workerBlocker(t.row, view) === null && !outOnModel(t.row, kind))
}

/** The account is out of usage on the very model a model's limit names (R15). */
const outOnModel = (row: AccountRowView, kind: LimitKind): boolean =>
  kind.scope === 'model' && row.limit?.scope === 'model' && limitKindOf(row.limit.text).model === kind.model

/** The accounts the swarm's conductor can be run again on at its limit: Claude Code's ways out
 *  that skip the bypass-permissions warning its --dangerously-skip-permissions would open (R16).
 *  Its tools come from its own --mcp-config, so no connection is asked of them. */
export function conductorTargets(
  view: AccountsView,
  limited: { accountId: string; email: string | null },
  now: number,
  checks: Readonly<Record<string, TargetCheck>>,
  kind: LimitKind,
): LimitTarget[] {
  return limitTargets(view.accounts, 'claude', limited, now, checks).filter((t) => t.state === 'available' && t.row.bypassReady && !outOnModel(t.row, kind))
}

// ── What the conductor is told (§9, R16) ─────────────────────────────────────────────────

const who = (w: SwarmWorker): string => `${w.agentName} (${w.role}, terminal ${w.terminalId})`

/** At the stop, when the restart is offered. */
export function offeredMessage(w: SwarmWorker, summary: string): string {
  return `${who(w)} is blocked: ${summary}. Termpolis is offering to restart it on another ${w.agentName} account, where it keeps its conversation and its task. ` +
    'Don\'t close it or give its task to another agent yet: system will post again.'
}

/** After a restart that resumed the worker's conversation: it waits at its prompt, and nobody else
 *  tells it to go on. */
export function restartedMessage(w: SwarmWorker): string {
  return `${who(w)} was restarted on another account and resumed its conversation. It is waiting at its prompt: send it 'Continue your task.' with submit=true (STEP 5).`
}

/** After a restart without its conversation (Codex's path (c), or a Claude Code session the target
 *  couldn't find). */
export function freshMessage(w: SwarmWorker): string {
  return `${who(w)} restarted on another account without its conversation. Send it its task again with submit=true and the same taskId (STEP 5).`
}

async function tell(deps: RestartDeps, content: string): Promise<void> {
  try {
    await deps.swarm.sendMessage('system', 'conductor', 'info', content)
  } catch { /* the bus is the conductor's only ear: nothing else to tell it by */ }
}

/** v1.54.0's close-and-reassign, for a worker whose offer ended without a restart. */
const reassign = (w: RestartWorker): Promise<void> => reportWorkerStop(w, { status: 'blocked', summary: w.summary })

// ── The offer ──────────────────────────────────────────────────────────────────────────

/** Each offered worker's clock: when it runs out, the conductor reassigns the worker's task. */
const clocks = new Map<string, unknown>()

export function _resetSwarmRestartForTest(): void {
  clocks.clear()
}

function stopClock(terminalId: string, deps: RestartDeps): void {
  const h = clocks.get(terminalId)
  if (h === undefined) return
  deps.clearTimer(h)
  clocks.delete(terminalId)
}

function startClock(terminalId: string, ms: number, deps: RestartDeps): void {
  stopClock(terminalId, deps)
  clocks.set(terminalId, deps.setTimer(() => { void timeUp(terminalId, deps) }, ms))
}

/** A worker's time ran out with no answer: off the offer, and the conductor reassigns it. Never
 *  while a relaunch holds the worker: that is a restart under way. */
async function timeUp(terminalId: string, deps: RestartDeps): Promise<void> {
  clocks.delete(terminalId)
  const s = deps.store()
  const g = s.swarmRestarts.find((x) => x.phase.kind === 'offered' && x.workers.some((w) => w.terminalId === terminalId))
  if (!g) return
  if (s.relaunching[terminalId]) {
    startClock(terminalId, LOCK_RECHECK_MS, deps)
    return
  }
  const w = g.workers.find((x) => x.terminalId === terminalId) as RestartWorker
  const rest = g.workers.filter((x) => x.terminalId !== terminalId)
  if (rest.length > 0) s.putSwarmRestart({ ...g, workers: rest })
  else s.dropSwarmRestart(g.id)
  await reassign(w)
}

/** The open task the conductor assigned to the worker, if any. */
async function taskOf(terminalId: string, deps: RestartDeps): Promise<string | undefined> {
  try {
    const res = await deps.swarm.getTasks()
    const open = res.success && res.data ? res.data.find((t) => t.assignedTo === terminalId && t.status !== 'completed' && t.status !== 'failed') : undefined
    return open?.id
  } catch {
    return undefined
  }
}

/** The offer still open for an agent's account, if any. */
const openOffer = (s: RestartStore, agent: ProfileAgent, accountId: string): SwarmRestartGroup | undefined =>
  s.swarmRestarts.find((x) => x.phase.kind === 'offered' && x.agent === agent && x.accountId === accountId)

/** The worker joins the offer open for its account: false when none is open by the time its task
 *  is known (`known`, or asked for here). Nothing waits between the look and the change. */
async function joinOffer(worker: SwarmWorker, summary: string, agent: ProfileAgent, accountId: string, deps: RestartDeps, known?: { taskId?: string }): Promise<boolean> {
  const taskId = known ? known.taskId : await taskOf(worker.terminalId, deps)
  const g = openOffer(deps.store(), agent, accountId)
  if (!g) return false
  if (g.workers.some((w) => w.terminalId === worker.terminalId)) return true
  deps.store().putSwarmRestart({ ...g, workers: [...g.workers, { ...worker, summary, ...(taskId ? { taskId } : {}) }] })
  startClock(worker.terminalId, RESTART_WAIT_MS, deps)
  await tell(deps, offeredMessage(worker, summary))
  return true
}

/**
 * The swarm's 5 s loop found a new usage limit on a worker (swarmStopReports.ts, once per stop):
 * offer its restart on another account when one is a way out, telling the conductor to wait, and
 * answer true; else false, and the conductor is told as in v1.54.0. `words` reads the CLI's own
 * words for the limit off the screen. The limit is recorded against the account it hit, with the
 * sign-in it hit (§8.2, R23), whatever is offered.
 */
export async function offerRestart(worker: SwarmWorker, result: AgentStatusResult, words: (() => string | null) | undefined, deps: RestartDeps): Promise<boolean> {
  const s = deps.store()
  const view = s.accountsView
  const term = s.terminals.find((t) => t.id === worker.terminalId)
  const agent = term?.swarmAgent
  if (!view || !term || term.isConductor || !agent || !isProfileAgent(agent) || !term.agentAccountId || s.accountsByHand[term.id]) return false
  const own = view.accounts.find((r) => r.id === term.agentAccountId && r.agent === agent)
  if (!own) return false
  const now = deps.now()
  const said = words?.() ?? result.summary
  const reset = resetTextOf(result.summary)
  const resetsAt = reset === null ? null : parseResetsAt(reset, now)
  const kind = limitKindOf(said)
  void deps.accounts.noteLimit(own.id, { text: said, resetsAt, scope: kind.scope, window: kind.window, ...(own.lastEmail ? { email: own.lastEmail } : {}) })
    .catch(() => { /* the offer goes on without the record */ })
  if (openOffer(s, agent, own.id)) return joinOffer(worker, result.summary, agent, own.id, deps)
  const limited = { accountId: own.id, email: own.lastEmail }
  const candidates = restartTargets(view, agent, limited, now, {}, kind)
  if (candidates.length === 0) return false
  const checks = await signedInNow(candidates, now, deps)
  const targets = restartTargets(view, agent, limited, now, checks, kind)
  if (targets.length === 0) return false
  const taskId = await taskOf(worker.terminalId, deps)
  // Another worker on the account may have opened an offer meanwhile; nothing waits from here on.
  if (openOffer(deps.store(), agent, own.id)) return joinOffer(worker, result.summary, agent, own.id, deps, { taskId })
  const group: SwarmRestartGroup = {
    id: deps.newId(), agent, accountId: own.id, words: said, resetsAt,
    workers: [{ ...worker, summary: result.summary, ...(taskId ? { taskId } : {}) }],
    targets: targets.map((t) => t.row.id),
    phase: { kind: 'offered' },
  }
  deps.store().putSwarmRestart(group)
  startClock(worker.terminalId, RESTART_WAIT_MS, deps)
  await tell(deps, offeredMessage(worker, result.summary))
  if (!deps.focused()) deps.notify(`${ACCOUNT_AGENT_LABEL[agent]} ran out of usage in the swarm`, offerTitle(group, view), () => undefined)
  return true
}

/** Whether each account is signed in now (§4.4), each asked at once; an answer under a minute old
 *  stands (§3.4). */
async function signedInNow(candidates: readonly LimitTarget[], now: number, deps: RestartDeps): Promise<Record<string, TargetCheck>> {
  const checks: Record<string, TargetCheck> = {}
  await Promise.all(candidates.map(async (t) => {
    checks[t.row.id] = recentCheck(t.row, now) ?? await checkSignIn(deps.accounts, t.row)
  }))
  return checks
}

/** When a limit lifts, from the CLI's words: "... · resets 3pm (America/New_York)". */
function resetOfWords(words: string, now: number): number | null {
  const m = / · resets (.+)$/.exec(words)
  return m ? parseResetsAt(m[1], now) : null
}

/**
 * The conductor's `claude -p` exited at its usage limit (conductorLimitOf), in `words`, on
 * `accountId`, the account it ran on: offer to run it again on another account where one is a way
 * out (conductorTargets, each asked whether it is signed in now), and answer true. The limit is
 * recorded against its account all the same (§8.2, R23).
 */
export async function offerConductorRun(words: string, accountId: string | null, deps: RestartDeps): Promise<boolean> {
  const view = deps.store().accountsView
  const own = accountId ? view?.accounts.find((r) => r.id === accountId && r.agent === 'claude') : undefined
  if (!view || !own) return false
  const now = deps.now()
  const kind = limitKindOf(words)
  const resetsAt = resetOfWords(words, now)
  void deps.accounts.noteLimit(own.id, { text: words, resetsAt, scope: kind.scope, window: kind.window, ...(own.lastEmail ? { email: own.lastEmail } : {}) })
    .catch(() => { /* the offer goes on without the record */ })
  const limited = { accountId: own.id, email: own.lastEmail }
  const candidates = conductorTargets(view, limited, now, {}, kind)
  if (candidates.length === 0) return false
  const targets = conductorTargets(view, limited, now, await signedInNow(candidates, now, deps), kind)
  if (targets.length === 0) return false
  const group: SwarmRestartGroup = {
    id: deps.newId(), conductor: true, agent: 'claude', accountId: own.id, words, resetsAt, workers: [], targets: targets.map((t) => t.row.id), phase: { kind: 'offered' },
  }
  deps.store().putSwarmRestart(group)
  if (!deps.focused()) deps.notify('The swarm\'s conductor ran out of usage', offerTitle(group, view), () => undefined)
  return true
}

/** "3 of the swarm's workers ran out of usage on personal", or for one, which one; or the
 *  conductor. */
export function offerTitle(g: Pick<SwarmRestartGroup, 'workers' | 'accountId' | 'conductor'>, view: AccountsView | null): string {
  const label = view?.accounts.find((r) => r.id === g.accountId)?.label
  const on = label ? ` on ${label}` : ''
  if (g.conductor) return `The swarm's conductor ran out of usage${on}.`
  if (g.workers.length === 1) return `${g.workers[0].agentName} (${g.workers[0].role}), a swarm worker, ran out of usage${on}.`
  return `${g.workers.length} of the swarm's workers ran out of usage${on}.`
}

// ── The user's answer ──────────────────────────────────────────────────────────────────

/** The user declined (or closed the offer): the conductor reassigns each worker, as in v1.54.0. */
export async function declineRestart(groupId: string, deps: RestartDeps): Promise<void> {
  const s = deps.store()
  const g = s.swarmRestarts.find((x) => x.id === groupId)
  if (!g) return
  s.dropSwarmRestart(g.id)
  for (const w of g.workers) stopClock(w.terminalId, deps)
  if (g.phase.kind !== 'offered' && g.phase.kind !== 'confirm') return
  for (const w of g.workers) await reassign(w)
}

/**
 * The user picked an account: each worker of the offer is restarted on it, in place, with its own
 * command, and the conductor told how it went. Carrying the conversations off an account not
 * offered automatically asks once more first (R17), unless `confirmed`.
 */
export async function restartOn(groupId: string, targetId: string, deps: RestartDeps, confirmed = false): Promise<void> {
  const s = deps.store()
  const g = s.swarmRestarts.find((x) => x.id === groupId)
  if (!g || (g.phase.kind !== 'offered' && g.phase.kind !== 'confirm')) return
  // The user acted: no clock runs out on them now (R16).
  for (const w of g.workers) stopClock(w.terminalId, deps)
  const view = s.accountsView
  const target = view?.accounts.find((r) => r.id === targetId && r.agent === g.agent)
  const from = view?.accounts.find((r) => r.id === g.accountId)
  if (!confirmed && target && from && !from.autoOffer) {
    const question = `${from.label} isn't offered automatically. Carry ${g.workers.length === 1 ? 'this worker\'s conversation' : 'these workers\' conversations'} to ${target.label}?`
    s.putSwarmRestart({ ...g, phase: { kind: 'confirm', targetId, question } })
    return
  }
  s.putSwarmRestart({ ...g, phase: { kind: 'restarting', targetId } })
  const lines = await Promise.all(g.workers.map((w) => restartWorker(w, g.agent, target, deps)))
  const now = deps.store().swarmRestarts.find((x) => x.id === g.id)
  if (now) deps.store().putSwarmRestart({ ...now, phase: { kind: 'done', lines } })
}

/** One worker's restart, and what the conductor is told; the line the offer shows for it. */
async function restartWorker(w: RestartWorker, agent: ProfileAgent, target: AccountRowView | undefined, deps: RestartDeps): Promise<string> {
  const name = `${w.agentName} (${w.role})`
  const s = deps.store()
  const term = s.terminals.find((t) => t.id === w.terminalId)
  // The conductor moved on without it: it closed the worker, or gave its task to another (R16).
  if (!term) return `${name}: the conductor closed it, so it wasn't restarted.`
  if (w.taskId) {
    let moved = false
    try {
      const res = await deps.swarm.getTasks()
      moved = res.success && !!res.data && res.data.find((t) => t.id === w.taskId)?.assignedTo !== w.terminalId
    } catch { /* not known to have moved */ }
    if (moved) return `${name}: its task went to another agent, so it wasn't restarted.`
  }
  if (!target) {
    await reassign(w)
    return `${name}: that account isn't registered any more, so it wasn't restarted: the conductor reassigns its task.`
  }
  if (!s.beginRelaunch(w.terminalId, 'account')) {
    await reassign(w)
    return `${name}: something else is relaunching it, so it wasn't restarted: the conductor reassigns its task.`
  }
  let outcome: SwitchOutcome
  try {
    outcome = await runSwitch(term, agent, target, {}, deps, 'usage limit, swarm worker')
    // The target can't see the conversation: a new session in place, as Codex's path (c).
    if (outcome.kind === 'resume-not-found') outcome = await runSwitch(term, agent, target, { assumeExited: true, fresh: true }, deps, 'usage limit, swarm worker')
  } finally {
    deps.store().endRelaunch(w.terminalId)
  }
  if (outcome.kind === 'switched' || outcome.kind === 'fresh') {
    // The resumed session can draw the same limit again: no new stop until it took a turn (R4).
    carryWorkerStop(w.terminalId, w.summary, () => tookTurn(w.terminalId, deps))
    await tell(deps, outcome.kind === 'switched' ? restartedMessage(w) : freshMessage(w))
    return outcome.kind === 'switched'
      ? `${name}: on ${target.label}, its conversation resumed.`
      : `${name}: on ${target.label}, with a new session: the conductor sends its task again.`
  }
  await reassign(w)
  return `${name}: ${outcomeView(outcome, agent, target).text} The conductor reassigns its task.`
}

/** Main's word that the worker took a turn since its restart (a prompt entered in its box, or work
 *  seen): a limit it shows after that is a new one. */
async function tookTurn(terminalId: string, deps: RestartDeps): Promise<boolean> {
  try {
    const res = await deps.accounts.limitLook(terminalId)
    return res.success && res.data.turned
  } catch {
    return false
  }
}

/** A worker switched to another account by hand, from its chip in the swarm dashboard (T11): as
 *  after the offer's restart, it leaves any offer it was in, its clock stops, its stop is carried
 *  (R4), and the conductor is told it resumed or started without its conversation. */
export async function noteWorkerSwitched(terminalId: string, outcome: SwitchOutcome, deps: RestartDeps): Promise<void> {
  if (outcome.kind !== 'switched' && outcome.kind !== 'fresh') return
  const s = deps.store()
  const w = s.swarmAgents.find((a) => a.terminalId === terminalId)
  if (!w) return
  stopClock(terminalId, deps)
  for (const g of s.swarmRestarts) {
    if (g.phase.kind !== 'offered' || !g.workers.some((x) => x.terminalId === terminalId)) continue
    const rest = g.workers.filter((x) => x.terminalId !== terminalId)
    if (rest.length > 0) s.putSwarmRestart({ ...g, workers: rest })
    else s.dropSwarmRestart(g.id)
  }
  carryIfStopped(terminalId, () => tookTurn(terminalId, deps))
  const worker: SwarmWorker = { terminalId, agentName: w.agentName, role: w.role }
  await tell(deps, outcome.kind === 'switched' ? restartedMessage(worker) : freshMessage(worker))
}

// ── Installing it ──────────────────────────────────────────────────────────────────────

/** The offer's way to the rest of the app, read at each use: the store, main's bridges, the clock. */
export function liveRestartDeps(): RestartDeps {
  return {
    store: useTerminalStore.getState,
    swarm: window.swarmAPI,
    accounts: window.accounts!,
    termpolis: window.termpolis,
    primerEnabled: isAutoPrimerEnabled,
    now: Date.now,
    newId: uuid,
    focused: () => document.hasFocus(),
    notify: osNotify,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  }
}

/** The offer, in the swarm's 5 s loop (limitWatch.ts noteSwarmStop). Returns its removal. */
export function installSwarmRestart(deps: () => RestartDeps): () => void {
  setSwarmStopOffer((worker, result, words) => offerRestart(worker, result, words, deps()))
  return () => setSwarmStopOffer(null)
}
