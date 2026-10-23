// The usage-limit chooser's watch (§8, ask mode), the renderer's side. App.tsx's 2 s loop hands it
// each agent terminal Termpolis launched whose screen changed; main judges the screen beside its
// buffer (accounts:limit-look, limitLook.ts) with what it knows of the agent there: live or gone
// (R5), a turn taken or not (R4). This keeps the stop each terminal shows, records a new one against
// the account it hit, and decides what the user sees: the chooser in limit mode, or a one-line
// banner. Never for the conductor's terminal (R22, terminalAgent), and never for a swarm worker,
// whose stops go to the conductor (noteSwarmStop: item 8's seam).
//
// One prompt per stop: a stop is a terminal's limit (or menu) from the first look that shows it
// until the agent is seen at work or two looks in a row show no stop (as the swarm's reports,
// swarmStopReports.ts). A limit counts only once the agent took a turn since it was started: one
// before that is the old limit of a session resumed there, drawn again (R4), and it is remembered
// as the terminal's stop, so the turn after it, if it stops too, is a new one.
import { stopKind } from '../../../shared/agentStatusDetector'
import type { AgentStatusResult } from '../../../shared/agentStatusDetector'
import { limitKindOf, parseResetsAt, resetTextOf, stopKey, untilText } from '../../../shared/accountLimits'
import type { LimitKind, LimitLook } from '../../../shared/accountLimits'
import { ACCOUNT_AGENT_LABEL } from '../../../shared/agentAccounts'
import type { AccountAgent, AccountsView } from '../../../shared/agentAccounts'
import type { AccountsAPI, PaneNode, TerminalSession } from '../types'
import { READS_TO_CLEAR, noteWorkerStatus } from './swarmStopReports'
import type { StopOffer, SwarmWorker } from './swarmStopReports'

/** A limit the chooser offers a way out of: the account that ran out, the terminals it stopped. */
export interface LimitContext {
  agent: AccountAgent
  /** The account that ran out, as main recorded the first terminal's; null when it knows none. */
  accountId: string | null
  /** The terminals it stopped, the dialog's own first. */
  terminals: string[]
  /** The CLI's own words. */
  words: string
  /** When it lifts, as the CLI said. */
  resetsAt: number | null
  kind: LimitKind
}

/** A one-line banner (§8.4): 'single', an agent with one account out of usage until its reset;
 *  'choose', the chooser couldn't open by itself (focus, or switched off) and opens from here;
 *  'menu', an agent waits on a menu, which only the user answers. */
export interface LimitBanner {
  id: string
  kind: 'single' | 'choose' | 'menu'
  ctx: LimitContext
}

/** No key typed for this long, and the chooser may open in front of the terminals. */
export const KEY_QUIET_MS = 2000

/** What each terminal last showed: its stop's key, the start it showed under and whether the agent
 *  had taken a turn there, and how many looks in a row since showed no stop. */
const stops = new Map<string, { key: string; startAt: number | null; turned: boolean; clear: number }>()

export type LimitNote =
  | { kind: 'none' }
  | { kind: 'limit'; ctx: LimitContext }
  | { kind: 'menu'; ctx: LimitContext }

/**
 * What a look at a terminal of `agent` means: a new limit, a new menu, or nothing. Nothing counts
 * while the agent there is gone (R5) or isn't this terminal's agent, and no limit or menu before the
 * agent took a turn (R4).
 */
export function noteLook(terminalId: string, agent: AccountAgent, look: LimitLook, now: number): LimitNote {
  if (!look.live || look.agent !== agent) return { kind: 'none' }
  const kind = stopKind(look.status)
  const last = stops.get(terminalId)
  if (kind === null) {
    // It got going, or showed no stop for long enough: a stop after this is another one.
    if (last && (look.status.status === 'working' || ++last.clear >= READS_TO_CLEAR)) stops.delete(terminalId)
    return { kind: 'none' }
  }
  const key = stopKey(look.status.summary)
  if (last && last.key === key && last.startAt === look.startAt && (last.turned || !look.turned)) {
    last.clear = 0
    return { kind: 'none' }
  }
  stops.set(terminalId, { key, startAt: look.startAt, turned: look.turned, clear: 0 })
  if (!look.turned) return { kind: 'none' }
  const words = look.words ?? look.status.summary
  const reset = resetTextOf(look.status.summary)
  const ctx: LimitContext = {
    agent,
    accountId: look.byHand ? null : look.accountId,
    terminals: [terminalId],
    words,
    resetsAt: reset === null ? null : parseResetsAt(reset, now),
    kind: limitKindOf(words),
  }
  return kind === 'limit' ? { kind: 'limit', ctx } : { kind: 'menu', ctx }
}

/** Terminals closed since the last tick: their stops go with them. */
export function pruneStops(open: ReadonlySet<string>): void {
  for (const id of stops.keys()) if (!open.has(id)) stops.delete(id)
}

export function _resetLimitWatchForTest(): void {
  stops.clear()
  lastKeyAt = 0
  swarmOffer = null
}

// ── What the user sees ────────────────────────────────────────────────────────────────

/** Two prompts about the same account of the same agent are one (R22): grouped by account. */
export function sameGroup(a: LimitContext, b: LimitContext): boolean {
  return a.agent === b.agent && a.accountId === b.accountId
}

export type LimitAction =
  /** Nothing shows: the one-account banner was hidden for good. */
  | { kind: 'nothing' }
  /** A banner, new, or one the stop joined. */
  | { kind: 'banner'; banner: LimitBanner }
  /** The stop joined the chooser already open for its account. */
  | { kind: 'join' }
  /** The chooser opens, in limit mode. */
  | { kind: 'open'; ctx: LimitContext }

export interface DecideEnv {
  view: AccountsView | null
  /** The switch dialog is open, and for which limit, if it was opened for one. */
  dialog: { limit?: LimitContext } | null
  banners: readonly LimitBanner[]
  /** The focus rules allow a dialog in front of the terminals now (mayOpenChooser). */
  mayOpen: boolean
  newId: () => string
}

/**
 * Where a new stop goes (§8.4). A menu: its banner. A limit of an agent with one account (or none):
 * the one-line banner, unless hidden. Else it joins a prompt open for the same account; or the
 * chooser opens, when it is on, the focus rules allow it, and no other dialog is open; or a banner
 * opens it later.
 */
export function decideLimit(note: Exclude<LimitNote, { kind: 'none' }>, env: DecideEnv): LimitAction {
  const banner = (kind: LimitBanner['kind'], ctx: LimitContext): LimitAction => ({ kind: 'banner', banner: { id: env.newId(), kind, ctx } })
  if (note.kind === 'menu') return banner('menu', note.ctx)
  const ctx = note.ctx
  const accounts = env.view ? env.view.accounts.filter((r) => r.agent === ctx.agent) : []
  if (accounts.length <= 1) return env.view?.hidden.limitBanner ? { kind: 'nothing' } : banner('single', ctx)
  if (env.dialog?.limit && sameGroup(env.dialog.limit, ctx)) return { kind: 'join' }
  const waiting = env.banners.find((b) => b.kind === 'choose' && sameGroup(b.ctx, ctx))
  if (waiting) return { kind: 'banner', banner: { ...waiting, ctx: { ...waiting.ctx, terminals: [...waiting.ctx.terminals, ...ctx.terminals] } } }
  if (!env.view!.chooser || !env.mayOpen || env.dialog) return banner('choose', ctx)
  return { kind: 'open', ctx }
}

// ── The focus rules (§8.4): the chooser never takes keys meant for a terminal ──────────

/** When a key was last typed anywhere in the window (App.tsx's capture-phase listener). */
let lastKeyAt = 0

export function noteKeyTyped(now: number): void {
  lastKeyAt = now
}

/** The chooser opens by itself only with the window focused, the stopped terminal on screen, and no
 *  key typed for KEY_QUIET_MS: otherwise a banner, which opens it. */
export function mayOpenChooser(f: { focused: boolean; visible: boolean; now: number }): boolean {
  return f.focused && f.visible && f.now - lastKeyAt >= KEY_QUIET_MS
}

function paneIds(node: PaneNode | null): string[] {
  if (!node) return []
  return node.type === 'terminal' ? [node.terminalId] : [...paneIds(node.children[0]), ...paneIds(node.children[1])]
}

/** Is the terminal on screen: its tab the active one, or a pane of the split, and Settings not over
 *  them all? */
export function isTerminalVisible(
  s: { terminals: readonly TerminalSession[]; viewMode: 'tabs' | 'split'; activeTerminalId: string | null; paneTree: PaneNode | null; showSettings: boolean },
  terminalId: string,
): boolean {
  const t = s.terminals.find((x) => x.id === terminalId)
  if (!t || t.hidden || s.showSettings) return false
  return s.viewMode === 'split' ? paneIds(s.paneTree).includes(terminalId) : s.activeTerminalId === terminalId
}

// ── A banner's words ──────────────────────────────────────────────────────────────────

/** What a banner says, and the account it is about. */
export function bannerText(b: LimitBanner, view: AccountsView | null, terminals: readonly TerminalSession[], now: number): string {
  const name = ACCOUNT_AGENT_LABEL[b.ctx.agent]
  if (b.kind === 'menu') {
    const where = terminals.find((t) => t.id === b.ctx.terminals[0])?.name
    return `${name} is waiting on a menu${where ? ` in ${where}` : ''}: answer it there.`
  }
  if (b.kind === 'single') {
    const until = untilText(b.ctx.resetsAt, now)
    return `${name} is out of usage${until ? ` ${until}` : ''}.`
  }
  const label = view?.accounts.find((r) => r.id === b.ctx.accountId)?.label
  const on = label ? ` on ${label}` : ''
  const n = b.ctx.terminals.length
  return n > 1 ? `${n} ${name} terminals ran out of usage${on}.` : `${name} ran out of usage${on}.`
}

/** What showLimit reads and changes in the store. */
export interface ShowStore {
  accountsView: AccountsView | null
  accountSwitch: { terminalId: string; limit?: LimitContext } | null
  limitBanners: LimitBanner[]
  terminals: TerminalSession[]
  viewMode: 'tabs' | 'split'
  activeTerminalId: string | null
  paneTree: PaneNode | null
  showSettings: boolean
  openLimitChooser: (ctx: LimitContext) => void
  joinLimitChooser: (terminalId: string) => void
  showLimitBanner: (banner: LimitBanner) => void
  dismissLimitBanner: (id: string) => void
}

export interface ShowDeps {
  store: () => ShowStore
  /** The window has the focus (document.hasFocus()). */
  focused: () => boolean
  now: () => number
  newId: () => string
  /** An OS notification: a stop the window didn't show while it wasn't focused. Its click brings
   *  the chooser up. */
  notify: (title: string, body: string, onClick: () => void) => void
}

/** A new stop, shown as decideLimit says: the chooser opened or joined, or a banner; and, for a
 *  chooser that couldn't open while the window was elsewhere, an OS notification that opens it. */
export function showLimit(note: Exclude<LimitNote, { kind: 'none' }>, deps: ShowDeps): void {
  const s = deps.store()
  const now = deps.now()
  const visible = isTerminalVisible(s, note.ctx.terminals[0])
  const action = decideLimit(note, {
    view: s.accountsView, dialog: s.accountSwitch, banners: s.limitBanners,
    mayOpen: mayOpenChooser({ focused: deps.focused(), visible, now }), newId: deps.newId,
  })
  if (action.kind === 'join') return s.joinLimitChooser(note.ctx.terminals[0])
  if (action.kind === 'open') return s.openLimitChooser(action.ctx)
  if (action.kind === 'nothing') return
  const fresh = !s.limitBanners.some((b) => b.id === action.banner.id)
  s.showLimitBanner(action.banner)
  if (action.banner.kind !== 'choose' || !fresh || deps.focused()) return
  const id = action.banner.id
  deps.notify(`${ACCOUNT_AGENT_LABEL[note.ctx.agent]} ran out of usage`, bannerText(action.banner, s.accountsView, s.terminals, now), () => {
    const later = deps.store()
    const banner = later.limitBanners.find((b) => b.id === id) ?? action.banner
    later.dismissLimitBanner(id)
    later.openLimitChooser(banner.ctx)
  })
}

/** The OS notification, where the window can show one. Clicking it brings the window forward. */
export function osNotify(title: string, body: string, onClick: () => void): void {
  if (typeof Notification === 'undefined') return
  try {
    const n = new Notification(title, { body })
    n.onclick = () => {
      window.focus()
      onClick()
    }
  } catch { /* the banner is there */ }
}

// ── Swarm workers: item 8's seam ──────────────────────────────────────────────────────

/** The swarm restart offer (item 8, §9, swarmRestart.ts): given a worker's new usage limit, it
 *  offers to restart the worker on another account, and returns true when it took the stop over
 *  (the offer tells the conductor to wait). With none installed, or one that declines, the stop
 *  goes to the conductor as v1.54.0 sends it. */
export type SwarmStopOffer = StopOffer

let swarmOffer: SwarmStopOffer | null = null

export function setSwarmStopOffer(offer: SwarmStopOffer | null): void {
  swarmOffer = offer
}

/** A swarm worker's status, from the swarm's 5 s loop: the chooser never opens for a worker. A new
 *  limit, once per stop, goes to the restart offer when one is installed and takes it; else, with
 *  every other stop, to the conductor, as v1.54.0 sends it (swarmStopReports.ts). `words` reads
 *  the CLI's own words for it off the screen. */
export async function noteSwarmStop(worker: SwarmWorker, result: AgentStatusResult, words?: () => string | null): Promise<void> {
  await noteWorkerStatus(worker, result, swarmOffer ?? undefined, words)
}

// ── The look, and what follows it ─────────────────────────────────────────────────────

export interface WatchDeps {
  accounts: Pick<AccountsAPI, 'limitLook' | 'noteLimit'>
  now: () => number
  /** What follows a new stop: its record against the account, and what the user sees. */
  onLimit: (note: Exclude<LimitNote, { kind: 'none' }>) => void
}

/**
 * Looks at one agent terminal whose screen changed, for the 2 s loop: main's judgement of it, then
 * a new stop recorded against the account it hit (with the sign-in's email, R23) and handed on.
 * A look that fails is the next tick's to try.
 */
export async function watchTerminal(terminalId: string, agent: AccountAgent, view: AccountsView | null, deps: WatchDeps): Promise<void> {
  let look: LimitLook
  try {
    const res = await deps.accounts.limitLook(terminalId)
    if (!res.success) return
    look = res.data
  } catch {
    return
  }
  const note = noteLook(terminalId, agent, look, deps.now())
  if (note.kind === 'none') return
  const row = note.ctx.accountId ? view?.accounts.find((r) => r.id === note.ctx.accountId) : undefined
  if (note.kind === 'limit' && row) {
    const email = row.lastEmail ?? (agent === 'agy' ? row.email : undefined)
    const limit = { text: note.ctx.words, resetsAt: note.ctx.resetsAt, scope: note.ctx.kind.scope, window: note.ctx.kind.window, ...(email ? { email } : {}) }
    try { await deps.accounts.noteLimit(row.id, limit) } catch { /* the chooser still opens */ }
  }
  deps.onLimit(note)
}
