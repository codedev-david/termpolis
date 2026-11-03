// Switching a terminal's account in place, for the in-app account UI (§2.2). Main does the switch
// (accounts:switch, accountSwitch.ts, its every guard unchanged); this runs it for the account menu,
// the limit card and a sign-in a switch asked for, and keeps what the pane shows meanwhile (the
// store's switchRuns): the overlay's three steps, then a toast with Switch back, or an error card
// that says what happened and what the terminal shows now, with a next step. A busy agent's switch
// waits for its turn to end (the store's queuedSwitches): it never interrupts one.
import { ACCOUNT_AGENT_LABEL } from '../../../shared/agentAccounts'
import type { AccountAgent, AccountRowView } from '../../../shared/agentAccounts'
import type { SwitchOutcome, SwitchProgress } from '../../../shared/accountSwitch'
import type { AccountsAPI, TermpolisAPI, TerminalSession } from '../types'
import { v4 as uuid } from 'uuid'
import { useTerminalStore } from '../store/terminalStore'
import { isAutoPrimerEnabled } from '../hooks/useAutoPrimer'
import { launchAgents } from './agentLaunch'
import { checkSignIn, openOnAccount, runSwitch, terminalAgent } from './accountSwitchFlow'
import type { SignInCheck, SwitchAnswers } from './accountSwitchFlow'
import { AGENT_COLOR } from './accountsView'
import { refreshAccounts } from './accountsState'
import { liveRestartDeps, noteWorkerSwitched } from './swarmRestart'

export type StepState = 'pending' | 'working' | 'done' | 'failed'

export interface Endpoint {
  id: string
  label: string
  color: string
}

export type CardActionKind = 'exited' | 'retry' | 'fresh' | 'new-terminal' | 'sign-in' | 'sign-in-and-switch' | 'sign-in-and-continue' | 'anyway' | 'close'

export interface CardAction {
  kind: CardActionKind
  label: string
}

/** What a switch that didn't finish says: what happened and what the terminal shows now, in a
 *  sentence each, and what the user can do next. */
export interface ErrorCard {
  what: string
  now: string
  actions: CardAction[]
}

export interface SwitchRun {
  terminalId: string
  agent: AccountAgent
  from: Endpoint | null
  to: Endpoint
  reason: string
  status: 'checking' | 'running' | 'failed' | 'done'
  /** Ending this session; starting the agent on the account; resuming the conversation. */
  steps: [StepState, StepState, StepState]
  /** The answers it ran with, for Try again. */
  answers: SwitchAnswers
  /** The user confirmed carrying a conversation to or from an account that isn't offered
   *  automatically (D14, R17): a retry, a sign-in and a queued wait go on with it. */
  confirmed?: boolean
  /** The conversation a relaunch that landed on the sign-in screen was resuming: a new terminal on the
   *  account can pick it up once it is signed in (the terminal itself sits at the CLI's sign-in screen). */
  resumeId?: string
  /** A new session was asked for (the steps' last one says so). */
  fresh?: boolean
  card?: ErrorCard
  /** A success's words, until when they show, and the account Switch back goes to. */
  toast?: { text: string; until: number; back: string | null }
  /** When a key was last typed into the pane while it ran: the overlay says the keys are held. */
  heldAt?: number
}

/** A switch waiting for a busy agent to finish its turn. */
export interface QueuedSwitch {
  targetId: string
  reason: string
  /** The second confirmation (D14, R17), asked when the switch was queued. */
  confirmed?: boolean
}

/** How long the toast and its Switch back stay. */
export const TOAST_MS = 10_000
/** How often a queued switch looks whether its agent is done. */
export const QUEUE_POLL_MS = 2000

export interface RunDeps {
  accounts: Pick<AccountsAPI, 'switchAccount' | 'check' | 'onSwitchProgress' | 'list' | 'limitLook'>
  termpolis: Pick<TermpolisAPI, 'claudeTrustWorkspace' | 'memoryPrepareCodexContext' | 'createTerminal'>
  primerEnabled: () => boolean
  now: () => number
  newId: () => string
}

export function endpoint(r: AccountRowView): Endpoint {
  return { id: r.id, label: r.label, color: r.color ?? AGENT_COLOR[r.agent] }
}

const store = useTerminalStore.getState

/** The three steps' words. */
export function stepLabels(run: Pick<SwitchRun, 'agent' | 'to' | 'fresh'>): [string, string, string] {
  const name = ACCOUNT_AGENT_LABEL[run.agent]
  return ['Ending this session', `Starting ${name} on ${run.to.label}`, run.fresh ? 'Starting a new session' : 'Resuming your conversation']
}

/** Where main's progress puts the steps. */
export function stepsAt(step: SwitchProgress['step']): SwitchRun['steps'] {
  if (step === 'exiting' || step === 'confirming') return ['working', 'pending', 'pending']
  if (step === 'carrying' || step === 'typing') return ['done', 'working', 'pending']
  return ['done', 'done', 'working']
}

/** The steps as a failure leaves them: the one at work failed, the ones after it never ran. A run
 *  always has one at work (stepsAt). */
function failedAt(steps: SwitchRun['steps']): SwitchRun['steps'] {
  const at = steps.indexOf('working')
  return steps.map((s, i) => (i === at ? 'failed' : s)) as SwitchRun['steps']
}

const CLOSE: CardAction = { kind: 'close', label: 'Close' }
/** First on a card that asks whether the agent exited: the card's default focus is the safe one, never the
 *  answer that says it has (a stray Enter must not assert something nobody checked). */
const TRY_AGAIN: CardAction = { kind: 'retry', label: 'Try again' }
const SAY_ONLY_AT_PROMPT = ' Say it has exited only if the terminal is at its prompt.'

/** The card a switch that didn't finish shows, or null for one that did (or that waits, busy). */
export function cardFor(o: SwitchOutcome, run: Pick<SwitchRun, 'agent' | 'to' | 'from'>, worker: boolean): ErrorCard | null {
  const name = ACCOUNT_AGENT_LABEL[run.agent]
  const to = run.to.label
  const from = run.from?.label ?? 'the account it was on'
  const newTerminal: CardAction[] = worker ? [] : [{ kind: 'new-terminal', label: `New terminal on ${to}` }]
  switch (o.kind) {
    case 'switched':
    case 'fresh':
    case 'busy':
      return null
    // Where the operating system itself still showed a program running, the card says so before it offers the user's word
    // that the agent has exited: that word is for a terminal sitting at its prompt (SAFETY-R2-4).
    case 'unknown-exit':
      return {
        what: o.osSees ? 'The operating system still shows a program running in this terminal, so Termpolis typed nothing.' : `Termpolis couldn't tell whether ${name} is still running, so it typed nothing.`,
        now: `${name} is as you left it, on ${from}.${o.osSees ? SAY_ONLY_AT_PROMPT : ''}`,
        actions: [TRY_AGAIN, { kind: 'exited', label: 'It has exited, switch now' }, ...newTerminal, CLOSE],
      }
    case 'exit-unconfirmed':
      return {
        what: o.osSees ? `${name} didn't confirm it exited, and the operating system still shows a program running in this terminal, so Termpolis typed nothing more.` : `${name} didn't confirm it exited, so Termpolis typed nothing more.`,
        now: `${name} may still be running here, on ${from}.${o.osSees ? SAY_ONLY_AT_PROMPT : ''}`,
        actions: [TRY_AGAIN, { kind: 'exited', label: 'It has exited, switch now' }, ...newTerminal, CLOSE],
      }
    case 'agent-alive':
      return { what: `${name} didn't exit: the account line showed in its own input, so Termpolis took it back out.`, now: `${name} is still running here, on ${from}.`, actions: [{ kind: 'retry', label: 'Try again' }, ...newTerminal, CLOSE] }
    case 'didnt-start':
      // A shell of another kind took the line's place (one was started inside the terminal): there is no
      // line to try again, and nothing to type; a New terminal on the account carries the conversation on.
      if (o.otherShell) {
        return {
          what: 'This terminal\'s shell is of another kind than the one Termpolis types for (one was started inside it), so the account line was not entered.',
          now: `${name} has exited: the terminal is at that shell's prompt.`,
          actions: worker ? [{ kind: 'retry', label: 'Try again' }, CLOSE] : [...newTerminal, CLOSE],
        }
      }
      return { what: 'The account line never showed in the terminal, so nothing was entered.', now: `The shell is at its prompt: ${name} has exited.`, actions: [{ kind: 'exited', label: 'Try again' }, ...newTerminal, CLOSE] }
    case 'resume-not-found':
      return { what: `${to} can't see this conversation.`, now: `The shell is at its prompt, and the conversation is still on ${from}.`, actions: [{ kind: 'fresh', label: `Start a new session on ${to}` }, ...newTerminal, CLOSE] }
    case 'sign-in':
      return {
        what: `${to}'s sign-in has expired.`,
        now: `${name} shows its sign-in screen in the terminal, and Termpolis answers none of it.`,
        // Once it is signed in, the conversation goes on in a new terminal beside this one, which holds no
        // conversation while it sits at the sign-in screen (so no two agents write one transcript).
        actions: [...(worker ? [] : [{ kind: 'sign-in-and-continue' as const, label: o.sessionId ? `Sign in to ${to} and continue the conversation in a new terminal` : `Sign in to ${to} and open a new terminal` }]), { kind: 'sign-in', label: `Sign in to ${to}` }, CLOSE],
      }
    case 'asks-user':
      return { what: `${to} is asking something only you can answer.`, now: 'Answer it in the terminal.', actions: [CLOSE] }
    case 'no-outcome':
      return { what: 'Nothing showed in the terminal within 30 seconds.', now: 'Look at the terminal.', actions: [{ kind: 'retry', label: 'Try again' }, ...newTerminal, CLOSE] }
    default:
      return { what: `Termpolis didn't switch: ${o.why}.`, now: 'Nothing was typed.', actions: [{ kind: 'retry', label: 'Try again' }, ...newTerminal, CLOSE] }
  }
}

/** A success's words: the conversation resumed, or a new session and where the old one still is. */
export function toastFor(o: Extract<SwitchOutcome, { kind: 'switched' | 'fresh' }>, run: Pick<SwitchRun, 'agent' | 'to' | 'from'>): string {
  const name = ACCOUNT_AGENT_LABEL[run.agent]
  const to = run.to.label
  // Where Termpolis saw no line start the agent (a history recall, a reverse search) or one the shell edited as it was typed,
  // its model and options could not be repeated: said, since a restriction can be among them (MODELS-R2-4).
  const unseen = o.unseenStart ? ` Its model and options were not carried: Termpolis didn't see how ${name} was started.` : ''
  if (o.kind === 'switched') return `${name} is on ${to} now. Conversation resumed.${unseen}`
  // A worktree the agent was started in that the new session did not go back into: said, since its files are not here (MODELS-R2-3).
  const left = (o.leftWorktree ? ` It started in the main folder, not in the worktree ${o.leftWorktree}.` : '') + unseen
  if (o.why === 'not-found') return `${name} is on ${to} now, in a new session: ${to} can't see this conversation. The old one is still in Past AI Sessions${run.from ? `, on ${run.from.label}` : ''}.${left}`
  if (o.why === 'no-session') return `${name} is on ${to} now, in a new session: it named no conversation to resume.${left}`
  return `${name} is on ${to} now, in a new session.${left}`
}

export function liveRunDeps(): RunDeps {
  return {
    accounts: window.accounts!,
    termpolis: window.termpolis,
    primerEnabled: isAutoPrimerEnabled,
    now: () => Date.now(),
    newId: uuid,
  }
}

export interface StartOptions {
  reason?: string
  answers?: SwitchAnswers
  /** The target's sign-in, already known: no check is run for it. */
  known?: SignInCheck
  /** The user said yes to the second question (D14, R17): this switch goes onto, or off, an account
   *  that isn't offered automatically. Main refuses it without that. */
  confirmed?: boolean
}

function put(run: SwitchRun): void {
  store().putSwitchRun(run)
}

/**
 * Switches the agent in `terminalId` to `targetId`, in place. It checks the target is signed in
 * (a signed-out one would relaunch into its sign-in screen), holds the terminal for the run, and
 * leaves the pane its toast or its error card. A busy agent waits in the queue instead.
 */
export async function startSwitch(terminalId: string, targetId: string, opts: StartOptions = {}, deps: RunDeps = liveRunDeps()): Promise<void> {
  const s = store()
  const terminal = s.terminals.find((t) => t.id === terminalId)
  const view = s.accountsView
  const agent = terminalAgent(terminal)
  const target = view?.accounts.find((r) => r.id === targetId)
  if (!terminal || !view || !agent || !target || target.agent !== agent) return
  const existing = s.switchRuns[terminalId]
  if (existing && (existing.status === 'checking' || existing.status === 'running')) return
  const fromRow = terminal.agentAccountId ? view.accounts.find((r) => r.id === terminal.agentAccountId) : undefined
  const answers = opts.answers ?? {}
  const base: SwitchRun = {
    terminalId, agent, from: fromRow ? endpoint(fromRow) : null, to: endpoint(target), reason: opts.reason ?? 'by hand',
    status: 'checking', steps: ['pending', 'pending', 'pending'], answers, ...(answers.fresh ? { fresh: true } : {}),
    ...(opts.confirmed ? { confirmed: true } : {}),
  }
  put(base)
  if (!s.beginRelaunch(terminalId, 'account')) {
    // The queued switch, if there is one, is not given up with the refusal: it is the user's request, and the
    // terminal is held for a moment (a model change, another switch).
    return put({ ...base, status: 'failed', card: { what: 'A model change or another switch is already running here.', now: 'Nothing was typed.', actions: [TRY_AGAIN, CLOSE] } })
  }
  s.dropQueuedSwitch(terminalId)
  const signIn = opts.known ?? await checkSignIn(deps.accounts, target)
  if (signIn.kind !== 'signed-in') {
    store().endRelaunch(terminalId)
    return put({
      ...base,
      status: 'failed',
      card: signIn.kind === 'signed-out'
        ? { what: `${target.label} is signed out.`, now: 'Nothing was typed.', actions: [{ kind: 'sign-in-and-switch', label: `Sign in to ${target.label} and switch` }, CLOSE] }
        : { what: `Termpolis couldn't tell whether ${target.label} is signed in: ${signIn.why}.`, now: 'Nothing was typed.', actions: [{ kind: 'anyway', label: 'Switch anyway' }, { kind: 'sign-in-and-switch', label: `Sign in to ${target.label} and switch` }, CLOSE] },
    })
  }
  let run: SwitchRun = { ...base, status: 'running', steps: ['working', 'pending', 'pending'] }
  put(run)
  const off = deps.accounts.onSwitchProgress((p) => {
    if (p.terminalId !== terminalId) return
    run = { ...run, steps: stepsAt(p.step) }
    put(run)
  })
  let outcome: SwitchOutcome
  try {
    outcome = await runSwitch(terminal, agent, target, opts.confirmed ? { ...answers, confirmedCarry: true } : answers, deps, base.reason)
  } finally {
    off()
    store().endRelaunch(terminalId)
  }
  // A swarm worker's conductor is told how it went, as after the restart offer's (§9).
  if (terminal.isSwarm) void noteWorkerSwitched(terminalId, outcome, liveRestartDeps())
  void refreshAccounts(deps.accounts)
  if (outcome.kind === 'busy') {
    // It got to work meanwhile: the switch waits for the turn to end.
    store().dropSwitchRun(terminalId)
    store().queueSwitch(terminalId, { targetId, reason: base.reason, ...(opts.confirmed ? { confirmed: true } : {}) })
    return
  }
  if (outcome.kind === 'switched' || outcome.kind === 'fresh') {
    const until = deps.now() + TOAST_MS
    // Switch back is a switch like any other: onto, or off, an account that isn't offered
    // automatically it would need the second question (D14, R17), which a toast can't ask. The menu does.
    const back = fromRow && fromRow.autoOffer && target.autoOffer ? fromRow.id : null
    put({ ...run, status: 'done', steps: ['done', 'done', 'done'], toast: { text: toastFor(outcome, run), until, back } })
    // The toast goes at its time, wherever it shows (a pane, or a worker's line in the swarm
    // dashboard), unless another switch took its place meanwhile.
    setTimeout(() => {
      if (store().switchRuns[terminalId]?.toast?.until === until) store().dropSwitchRun(terminalId)
    }, TOAST_MS)
    return
  }
  put({
    ...run, status: 'failed', steps: failedAt(run.steps), card: cardFor(outcome, run, !!terminal.isSwarm) as ErrorCard,
    ...(outcome.kind === 'sign-in' && outcome.sessionId ? { resumeId: outcome.sessionId } : {}),
  })
}

/** A card's or a toast's button, for the terminal's last switch. */
export async function actOnRun(terminalId: string, kind: CardActionKind | 'back', deps: RunDeps = liveRunDeps()): Promise<void> {
  const s = store()
  const run = s.switchRuns[terminalId]
  if (!run) return
  const again = (opts: StartOptions): Promise<void> => {
    store().dropSwitchRun(terminalId)
    return startSwitch(terminalId, run.to.id, { reason: run.reason, ...(run.confirmed ? { confirmed: true } : {}), ...opts }, deps)
  }
  const signedIn: SignInCheck = { kind: 'signed-in', email: null }
  switch (kind) {
    case 'exited': return again({ answers: { assumeExited: true }, known: signedIn })
    case 'retry': return again({})
    case 'fresh': return again({ answers: { assumeExited: true, fresh: true }, known: signedIn })
    case 'anyway': return again({ known: signedIn })
    case 'back':
      if (!run.toast?.back) return
      store().dropSwitchRun(terminalId)
      return startSwitch(terminalId, run.toast.back, { reason: 'switch back' }, deps)
    case 'sign-in':
      s.dropSwitchRun(terminalId)
      return s.openSignInSheet(run.to.id)
    case 'sign-in-and-continue': {
      const terminal = s.terminals.find((t) => t.id === terminalId)
      s.dropSwitchRun(terminalId)
      // Signed in from the sheet, the conversation goes on in a new terminal on the account.
      return s.openSignInSheet(run.to.id, () => {
        const target = store().accountsView?.accounts.find((r) => r.id === run.to.id)
        if (terminal && target) void newTerminalOn(terminal, target, deps, run.resumeId)
      }, { doneLabel: `Open a new terminal on ${run.to.label}` })
    }
    case 'sign-in-and-switch':
      s.dropSwitchRun(terminalId)
      return s.openSignInSheet(run.to.id, () => { void startSwitch(terminalId, run.to.id, { reason: run.reason, known: signedIn, ...(run.confirmed ? { confirmed: true } : {}) }, deps) })
    case 'new-terminal': {
      const terminal = s.terminals.find((t) => t.id === terminalId)
      const target = s.accountsView?.accounts.find((r) => r.id === run.to.id)
      s.dropSwitchRun(terminalId)
      if (terminal && target) await newTerminalOn(terminal, target, deps)
      return
    }
    default:
      s.dropSwitchRun(terminalId)
  }
}

/** "New terminal on <account>" (§7.4): the same agent in the same folder, on the account, with a
 *  fresh session. Its own launch shows its own progress. */
export async function newTerminalOn(source: TerminalSession, target: AccountRowView, deps: RunDeps = liveRunDeps(), resume?: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const r = await openOnAccount(source, target, {
    createTerminal: deps.termpolis.createTerminal,
    addTerminal: store().addTerminal,
    launch: (targets) => launchAgents(targets),
    newId: deps.newId,
  }, resume)
  if (r.ok) store().setActiveTerminal(r.id)
  else store().setMemoryNotice(r.error)
  return r
}

/** Queues a switch for a busy agent: it runs once the agent is done with its turn. */
export function queueSwitch(terminalId: string, targetId: string, reason = 'by hand', confirmed = false): void {
  store().queueSwitch(terminalId, { targetId, reason, ...(confirmed ? { confirmed: true } : {}) })
}

/** One look at each queued switch: its terminal gone, it goes; its agent done, it runs. */
export async function processQueue(deps: RunDeps = liveRunDeps()): Promise<void> {
  const s = store()
  for (const [terminalId, q] of Object.entries(s.queuedSwitches)) {
    if (!s.terminals.some((t) => t.id === terminalId)) {
      store().dropQueuedSwitch(terminalId)
      continue
    }
    // Held by a model change or another switch: it looks again at the next tick, with the request kept.
    if (s.relaunching[terminalId]) continue
    try {
      const res = await deps.accounts.limitLook(terminalId)
      if (!res.success || (res.data.live && res.data.status.status === 'working')) continue
    } catch {
      continue
    }
    await startSwitch(terminalId, q.targetId, { reason: q.reason, ...(q.confirmed ? { confirmed: true } : {}) }, deps)
  }
}

/** Looks at the queue every QUEUE_POLL_MS while the app runs; returns the stop. */
export function installSwitchQueue(deps: () => RunDeps = liveRunDeps): () => void {
  let busy = false
  const timer = setInterval(() => {
    if (busy || Object.keys(store().queuedSwitches).length === 0) return
    busy = true
    void processQueue(deps()).finally(() => { busy = false })
  }, QUEUE_POLL_MS)
  return () => clearInterval(timer)
}
