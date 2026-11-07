// The hidden sign-in session (the in-app account UI, §3): the CLI's own login, run by main in a PTY
// of its own. It is never a Termpolis terminal: not in the terminal manager's list, the store or a
// workspace, so no MCP tool, poller, phone, swarm or prompt auto-answer can see it, and nothing it
// prints is logged. The sheet shows its steps (readSignInScreen) and sends the user's own choices;
// only this module writes to the PTY, and only:
//
//   a pick    on the option the user clicked, still on screen, moved to with ↑/↓ and entered only
//             once agy shows the highlight on it (type, look, then Enter, as the switch types);
//   a code    where the CLI shows its code field, never kept, logged or shown again (the CLI's
//             echo of it is masked wherever its screen is shown);
//   agy's     /logout, and /login where its box comes back with no sign-in screen: the user's "Switch
//   switch    all" click is the consent for both, which sign the computer user's one agy out and in;
//   keys      the fallback's "Let me type here", while the user has it on.
//
// A Claude Code or Codex sign-in is confirmed by the CLI's status command, not by its screen alone.
// agy has none: its own success words, then its input box back, are its confirmation. Every
// session ends, with its process tree, on success, on cancel, after SIGN_IN_TIMEOUT_MS, when the
// window that started it goes away, and at quit (endSignIns).
import { randomUUID } from 'crypto'
import { TerminalScreen } from '../shared/terminalScreen'
import type { ScreenSize } from '../shared/terminalScreen'
import { SIGN_IN_TIMEOUT_MS, SIGN_IN_UNKNOWN_MS, isSignInPage, readSignInScreen, signInText } from '../shared/signInScreens'
import type { SignInInput, SignInPhase, SignInScreen, SignInState } from '../shared/signInScreens'
import { ACCOUNT_AGENT_LABEL } from '../shared/agentAccounts'
import type { AccountAgent } from '../shared/agentAccounts'
import { AGY_SIGNED_IN, EXIT_COMMAND } from '../shared/accountSwitch'
import { redactSecrets } from '../shared/appLog'
import { EXIT_CONFIRM_MS, atIdleBox, typeIntoBox, waitFor } from './accountSwitch'
import type { SwitchIO } from './accountSwitch'
import { shownEmail } from './agySwitch'

/** The PTY a session runs in: node-pty's, as far as a session uses it. */
export interface PtyLike {
  readonly pid: number
  write(data: string): void
  kill(): void
  onData(cb: (data: string) => void): unknown
  onExit(cb: (e: { exitCode: number }) => void): unknown
}

export interface PtySpawnOptions {
  name: string
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
}

export interface SessionDeps {
  spawn: (file: string, args: string[] | string, opts: PtySpawnOptions) => PtyLike
  /** Ends the process tree under `pid`, while its root lives (processTree.ts). */
  killTree: (pid: number) => void
  send: (s: SignInState) => void
  /** Opens an address in the user's browser (shell.openExternal). */
  openExternal: (url: string) => void
  now: () => number
  sleep: (ms: number) => Promise<void>
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (h: unknown) => void
}

export type Confirmed = { email: string | null; plan?: string } | { signedOut: true } | { error: string }

export interface SessionSpec {
  accountId: string
  agent: AccountAgent
  /** One session per profile at a time; agy's, one for the computer user. */
  key: string
  /** The CLI, by its resolved path, and its arguments: no shell reads them. */
  file: string
  args: string[] | string
  env: Record<string, string>
  cwd: string
  mode: 'sign-in' | 'agy-switch'
  /** For the log, which holds labels and phases only. */
  label: string
  /** Who started it (the window's web contents): its sessions end when it goes. */
  owner?: unknown
  /** Claude Code and Codex: the CLI's own status command, once it says it is done. */
  confirm?: () => Promise<Confirmed>
  /** agy's switch: agy is signed in again, its box back; the email its header shows, if any. */
  onAgySignedIn?: (email: string | null) => void
}

export type InputResult = { ok: true } | { ok: false; why: string }

/** The PTY's size: wide, so an address wraps less where the screen shows it. */
export const SIGN_IN_SIZE: ScreenSize = { cols: 120, rows: 40 }
/** How often a session's screen is read. */
export const TICK_MS = 500
/** How long agy's sign-in screen gets to show after /logout, before /login is typed. */
export const AGY_SIGN_IN_SHOW_MS = 10_000
/** How long the highlight gets to move after each arrow key. */
export const PICK_MOVE_MS = 1500
/** What a session keeps of the CLI's output, at most. */
export const MAX_OUTPUT = 1_000_000

const DOWN = '\u001b[B'
const UP = '\u001b[A'

/** What a code or a value typed for the CLI may be: printable, with no space, at most 2 KB. */
const PASTED = /^[\x21-\x7e]{1,2048}$/
/** A CLI's prompt for a code or a value, drawn again after one went in: it asks again. */
const ASKS_AGAIN = /Paste code here|paste the authorization code|Paste the authorization code below|Enter the authorization code|project id\.\.\./
/** How long after an answer a prompt still on screen counts as asked again, not redrawn as it works. */
export const ANSWER_SETTLE_MS = 3000

type AgyStage = 'start' | 'logging-out' | 'logging-in' | 'signing-in' | 'signed-in' | 'exiting'

interface Session {
  id: string
  spec: SessionSpec
  /** What it was started with: what ends it, whoever ends it. */
  deps: SessionDeps
  pty: PtyLike
  screen: TerminalScreen
  /** The CLI's output, its tail; `total` counts all of it. */
  raw: string
  total: number
  phase: SignInPhase
  sent: string
  startedAt: number
  unknownSince: number | null
  /** Where the output stood, and when, as a code or a value went in: its field shows again only
   *  once the CLI draws its prompt again after it. */
  answered: { at: number; when: number } | null
  /** The question a pick answered, and where the output stood at its Enter. */
  picked: { question: string; at: number } | null
  /** The fallback's "Let me type here". */
  live: boolean
  /** The question a pick couldn't be driven on: shown as it is, for the user, until agy moves on. */
  stuckOn: string | null
  busy: boolean
  ended: boolean
  exited: boolean
  exitCode: number | null
  confirming: boolean
  stage: AgyStage
  stageAt: number
  /** agy's switch: where the output stood when /logout or /login went in. */
  signInFrom: number
  timer: unknown
}

const sessions = new Map<string, Session>()
/** What the user typed for each session's CLI (a code, a project): masked wherever its screen is
 *  shown, and dropped the moment the session ends. */
const typedBy = new Map<string, string[]>()

const DONE: InputResult = { ok: true }
const no = (why: string): InputResult => ({ ok: false, why })

/** A session's output from the absolute offset `from` on. */
function from(s: Session, at: number): string {
  return s.raw.slice(Math.max(0, s.raw.length - (s.total - at)))
}

/** The CLI's screen, as a switch's helpers read a terminal's (accountSwitch.ts). */
function ioOf(s: Session, deps: SessionDeps): SwitchIO {
  return {
    output: () => ({ raw: s.raw, end: s.total }),
    outputFrom: (_id, at) => from(s, at),
    end: () => s.total,
    size: () => SIGN_IN_SIZE,
    write: (_id, data) => { if (!s.ended) s.pty.write(data) },
    sleep: deps.sleep,
    now: deps.now,
  }
}

/** What the screen shows now, read as the CLI's sign-in. */
function current(s: Session): SignInScreen {
  return readSignInScreen(s.spec.agent, { lines: s.screen.lines(), text: signInText(s.raw), title: s.screen.title })
}

const escapeRe = (c: string): string => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `text` with what the user typed for the CLI masked (where the screen wraps it over rows too). */
function maskTyped(s: Session, text: string): string {
  let out = text
  for (const t of typedBy.get(s.id) ?? []) {
    out = out.replace(new RegExp(t.split('').map(escapeRe).join('\\n?'), 'g'), (m) => m.replace(/[^\n]/g, '•'))
  }
  return out
}

/** The screen as the user may see it: what they typed for the CLI masked, and secrets redacted. */
function masked(s: Session): string[] {
  const rows = s.screen.lines()
  while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop()
  return maskTyped(s, rows.join('\n')).split('\n').map(redactSecrets)
}

/** A code or a value went in, and its field is still what the screen shows: the CLI is at work on
 *  it, until it draws its prompt again a while after (it asks again) or shows something else. */
function stillAnswered(s: Session, deps: SessionDeps, screen: SignInScreen): boolean {
  const a = s.answered
  if (a === null) return false
  const field = screen.kind === 'browser' || screen.kind === 'code-wanted' || screen.kind === 'text-wanted'
  if (field && !(deps.now() - a.when >= ANSWER_SETTLE_MS && ASKS_AGAIN.test(signInText(from(s, a.at))))) return true
  s.answered = null
  return false
}

function phaseOf(s: Session, screen: SignInScreen): SignInPhase {
  const opens = (url: string | null): boolean => !!url && isSignInPage(s.spec.agent, url)
  switch (screen.kind) {
    case 'browser': return { kind: 'browser', url: screen.url, canOpen: opens(screen.url), codeField: screen.codeField }
    case 'code-wanted': return { kind: 'code-wanted', url: screen.url, canOpen: opens(screen.url) }
    case 'device-code': return { kind: 'device-code', code: screen.code, url: screen.url, canOpen: opens(screen.url) }
    case 'choose': return { kind: 'choose', question: screen.question, detail: screen.detail, options: screen.options, selected: screen.selected }
    case 'text-wanted': return { kind: 'text-wanted', label: screen.label }
    case 'working': return { kind: 'working' }
    default: return { kind: 'starting' }
  }
}

/** A sign-in screen of agy's, as opposed to its box, its trust question or its work. */
function agySignInShown(screen: SignInScreen): boolean {
  if (screen.kind === 'choose') return !/trust/i.test(screen.question)
  return screen.kind === 'browser' || screen.kind === 'code-wanted' || screen.kind === 'text-wanted'
}

function show(s: Session, deps: SessionDeps, phase: SignInPhase): void {
  const sent = JSON.stringify(phase)
  if (s.ended || sent === s.sent) return
  s.sent = sent
  s.phase = phase
  deps.send({ sessionId: s.id, accountId: s.spec.accountId, agent: s.spec.agent, phase })
}

/** Ends a session: its timer, its process tree while its root lives, what the user typed. */
function end(s: Session, deps: SessionDeps): void {
  if (s.ended) return
  s.ended = true
  deps.clearInterval(s.timer)
  if (!s.exited) {
    try { deps.killTree(s.pty.pid) } catch { /* gone already */ }
    try { s.pty.kill() } catch { /* gone already */ }
  }
  typedBy.delete(s.id)
  sessions.delete(s.id)
}

function fail(s: Session, deps: SessionDeps, message: string, timeout = false): void {
  // The CLI's sentence is the sheet's main line: it is masked like the screen under it, in case the CLI repeats the code or a key.
  show(s, deps, { kind: 'error', message: redactSecrets(maskTyped(s, message)), details: masked(s), ...(timeout ? { timeout: true } : {}) })
  console.log(`[accounts] sign-in for ${s.spec.label}: error${timeout ? ' (timed out)' : ''}`)
  end(s, deps)
}

function succeed(s: Session, deps: SessionDeps, email: string | null, plan?: string): void {
  show(s, deps, { kind: 'success', email, ...(plan ? { plan } : {}) })
  console.log(`[accounts] sign-in for ${s.spec.label}: signed in`)
  end(s, deps)
}

/** A screen this can't read: as it was, until SIGN_IN_UNKNOWN_MS have passed; then the screen
 *  itself, which the user can type into once they say so. */
function unknown(s: Session, deps: SessionDeps, force = false): void {
  const now = deps.now()
  if (s.unknownSince === null) s.unknownSince = now
  if (force || now - s.unknownSince >= SIGN_IN_UNKNOWN_MS || s.phase.kind === 'unknown') {
    if (force) s.unknownSince = now - SIGN_IN_UNKNOWN_MS
    show(s, deps, { kind: 'unknown', screen: masked(s), typing: s.live })
  }
}

/** The CLI said it is done: its status command says whether it is signed in now. */
async function confirm(s: Session, deps: SessionDeps): Promise<void> {
  s.confirming = true
  show(s, deps, { kind: 'confirming' })
  const name = ACCOUNT_AGENT_LABEL[s.spec.agent]
  let r: Confirmed
  try {
    r = await (s.spec.confirm as () => Promise<Confirmed>)()
  } catch (e) {
    r = { error: e instanceof Error ? e.message : String(e) }
  }
  if ('error' in r) return fail(s, deps, `Termpolis couldn't confirm the sign-in: ${r.error}`)
  if ('signedOut' in r) return fail(s, deps, `${name} said it signed in, but its status still says signed out`)
  succeed(s, deps, r.email, r.plan)
}

/** Claude Code's and Codex's login: plain lines and a code field. */
function loginTick(s: Session, deps: SessionDeps, screen: SignInScreen): void {
  if (screen.kind === 'error') return fail(s, deps, screen.message)
  if (screen.kind === 'done') return void confirm(s, deps)
  if (screen.kind === 'unknown') return unknown(s, deps)
  s.unknownSince = null
  if (stillAnswered(s, deps, screen)) return show(s, deps, { kind: 'working' })
  show(s, deps, phaseOf(s, screen))
}

/** Types `text` into the hidden agy's own box, as a switch types into an agent's (accountSwitch.ts):
 *  entered only once its box shows it. */
function intoAgyBox(s: Session, deps: SessionDeps, text: string): Promise<'entered' | 'not-shown' | 'held'> {
  const io = ioOf(s, deps)
  // Called on agy's idle box only (agy-ready reads the same screen the same way); were it gone,
  // nothing is typed.
  const idle = atIdleBox(io, s.id)
  return idle ? typeIntoBox(io, s.id, text, idle) : Promise.resolve('not-shown')
}

/** Types `text` into the hidden agy's box, then moves on to `next`. */
async function agyType(s: Session, deps: SessionDeps, text: string, next: AgyStage): Promise<void> {
  s.busy = true
  show(s, deps, { kind: 'signing-out' })
  try {
    s.signInFrom = ioOf(s, deps).end(s.id)
    const typed = await intoAgyBox(s, deps, text)
    if (s.ended) return
    if (typed !== 'entered') return fail(s, deps, `Termpolis couldn't type ${text} into agy`)
    s.stage = next
    s.stageAt = deps.now()
  } finally {
    s.busy = false
  }
}

/** agy is signed in again: the switch goes on with every agy terminal (onAgySignedIn), and the
 *  hidden agy is exited with its own /exit, or its tree ended. */
async function agyDone(s: Session, deps: SessionDeps): Promise<void> {
  s.stage = 'exiting'
  s.busy = true
  const email = shownEmail(s.screen.lines())
  try { s.spec.onAgySignedIn?.(email) } catch { /* the sign-in itself is done */ }
  show(s, deps, { kind: 'success', email })
  console.log(`[accounts] agy sign-in for ${s.spec.label}: signed in`)
  await intoAgyBox(s, deps, EXIT_COMMAND.agy)
  await waitFor(ioOf(s, deps), EXIT_CONFIRM_MS, () => s.exited)
  end(s, deps)
}

/** agy's switch: /logout in the hidden agy, then /login if its box comes back with no sign-in
 *  screen, then the user's own sign-in, relayed, until agy says it is done and shows its box. */
function agyTick(s: Session, deps: SessionDeps, screen: SignInScreen): void {
  const now = deps.now()
  if (s.stage === 'start') {
    if (screen.kind === 'agy-ready') return void agyType(s, deps, '/logout', 'logging-out')
    if (agySignInShown(screen)) s.stage = 'signing-in'
  } else if (s.stage === 'logging-out' || s.stage === 'logging-in') {
    if (agySignInShown(screen)) {
      s.stage = 'signing-in'
    } else if (screen.kind !== 'error' && screen.kind !== 'choose') {
      if (now - s.stageAt < AGY_SIGN_IN_SHOW_MS) return show(s, deps, { kind: 'signing-out' })
      if (s.stage === 'logging-out' && screen.kind === 'agy-ready') return void agyType(s, deps, '/login', 'logging-in')
      return unknown(s, deps, true)
    }
  }
  if (s.stage === 'signing-in' && AGY_SIGNED_IN.test(signInText(ioOf(s, deps).outputFrom(s.id, s.signInFrom)))) s.stage = 'signed-in'
  if (s.stage === 'signed-in' && screen.kind === 'agy-ready') return void agyDone(s, deps)
  if (screen.kind === 'error') return fail(s, deps, screen.message)
  if (screen.kind === 'unknown' || screen.kind === 'agy-ready') return unknown(s, deps)
  if (screen.kind === 'choose' && screen.question === s.stuckOn) return unknown(s, deps, true)
  s.stuckOn = null
  s.unknownSince = null
  // A pick went in: the same question, not drawn again since its Enter, is agy still at work on it.
  if (screen.kind === 'choose' && s.picked && s.picked.question === screen.question && s.picked.at === s.total) return show(s, deps, { kind: 'working' })
  if (stillAnswered(s, deps, screen)) return show(s, deps, { kind: 'working' })
  show(s, deps, phaseOf(s, screen))
}

function tick(s: Session, deps: SessionDeps): void {
  if (s.ended || s.busy || s.confirming) return
  if (deps.now() - s.startedAt >= SIGN_IN_TIMEOUT_MS) return fail(s, deps, 'The sign-in took longer than 10 minutes, so Termpolis stopped it.', true)
  const screen = current(s)
  if (s.spec.mode === 'agy-switch') agyTick(s, deps, screen)
  else loginTick(s, deps, screen)
}

function onExit(s: Session, deps: SessionDeps, code: number): void {
  s.exited = true
  s.exitCode = code
  if (s.ended || s.confirming) return
  const name = ACCOUNT_AGENT_LABEL[s.spec.agent]
  if (s.spec.mode === 'agy-switch') {
    if (s.stage !== 'exiting') fail(s, deps, 'agy closed before the sign-in finished')
    return
  }
  const screen = current(s)
  if (screen.kind === 'error') return fail(s, deps, screen.message)
  if (screen.kind === 'done' || code === 0) return void confirm(s, deps)
  // The sheet puts the agent's name before it ("Claude Code didn't sign in: ..."), so the sentence does not say it again (UI4-9).
  fail(s, deps, `it exited before it signed in (exit code ${code})`)
}

/**
 * Starts a sign-in: the CLI's own login in a PTY of its own. A session already running for the same
 * profile ends first: one at a time per profile.
 */
export function startSignInSession(spec: SessionSpec, deps: SessionDeps): { sessionId: string } {
  for (const other of [...sessions.values()]) if (other.spec.key === spec.key) end(other, deps)
  const pty = deps.spawn(spec.file, spec.args, { name: 'xterm-256color', cols: SIGN_IN_SIZE.cols, rows: SIGN_IN_SIZE.rows, cwd: spec.cwd, env: spec.env })
  const now = deps.now()
  const s: Session = {
    id: randomUUID(), spec, deps, pty, screen: new TerminalScreen(SIGN_IN_SIZE), raw: '', total: 0, phase: { kind: 'starting' }, sent: '',
    startedAt: now, unknownSince: null, answered: null, picked: null, live: false, stuckOn: null, busy: false, ended: false, exited: false,
    exitCode: null, confirming: false, stage: 'start', stageAt: now, signInFrom: 0, timer: null,
  }
  sessions.set(s.id, s)
  pty.onData((data: string) => {
    if (s.ended) return
    s.screen.write(data)
    s.raw += data
    s.total += data.length
    if (s.raw.length > MAX_OUTPUT) {
      // The tail, from a screen clear where there is one, so a replay of it draws what agy drew.
      const tail = s.raw.slice(-MAX_OUTPUT / 2)
      const clear = tail.indexOf('\u001b[2J')
      s.raw = clear < 0 ? tail : tail.slice(clear)
    }
  })
  pty.onExit((e: { exitCode: number }) => onExit(s, deps, e.exitCode))
  s.timer = deps.setInterval(() => tick(s, deps), TICK_MS)
  show(s, deps, { kind: 'starting' })
  return { sessionId: s.id }
}

/** Picks the option the user clicked, on agy's screen: moved to with ↑/↓, each move seen before the
 *  next, and entered only with the highlight on it and the question unchanged. Anything else stops
 *  with nothing entered, and the screen shown as it is. */
async function pick(s: Session, deps: SessionDeps, index: number, label: string): Promise<InputResult> {
  const p = s.phase
  if (p.kind !== 'choose') return no('there is nothing to choose now')
  if (!Number.isInteger(index) || index < 0 || index >= p.options.length || p.options[index] !== label) return no('that choice isn\'t on the screen now')
  s.busy = true
  const io = ioOf(s, deps)
  const same = (c: SignInScreen): c is Extract<SignInScreen, { kind: 'choose' }> =>
    c.kind === 'choose' && c.question === p.question && c.options.join('\n') === p.options.join('\n')
  const stuck = (): InputResult => {
    s.stuckOn = p.question
    unknown(s, deps, true)
    return no('the highlight didn\'t move to that choice, so Termpolis pressed nothing')
  }
  try {
    let at = p.selected
    for (let moves = 0; at !== index; moves++) {
      if (moves >= p.options.length) return stuck()
      s.pty.write(index > at ? DOWN : UP)
      const was = at
      const next = await waitFor(io, PICK_MOVE_MS, () => {
        const c = current(s)
        return same(c) && c.selected !== was ? c : null
      })
      if (s.ended) return no('the sign-in has ended')
      if (!next) return stuck()
      at = next.selected
    }
    const now = current(s)
    if (!same(now) || now.selected !== index) return stuck()
    s.picked = { question: p.question, at: s.total }
    show(s, deps, { kind: 'working' })
    s.pty.write('\r')
    return DONE
  } finally {
    s.busy = false
  }
}

/** Sends the user's input to a sign-in session. */
export async function signInInput(sessionId: string, input: SignInInput): Promise<InputResult> {
  const s = sessions.get(sessionId)
  if (!s || s.ended) return no('that sign-in has ended')
  const deps = s.deps
  const p = s.phase
  switch (input.kind) {
    case 'cancel':
      show(s, deps, { kind: 'cancelled' })
      console.log(`[accounts] sign-in for ${s.spec.label}: cancelled`)
      end(s, deps)
      return DONE
    case 'open': {
      const url = 'url' in p ? p.url : null
      // The address is main's own reading of the CLI's screen, never the renderer's.
      if (!url || !isSignInPage(s.spec.agent, url)) return no('that address isn\'t the provider\'s sign-in page')
      deps.openExternal(url)
      return DONE
    }
    case 'code': {
      const value = typeof input.value === 'string' ? input.value.trim() : ''
      const field = (p.kind === 'browser' && p.codeField) || p.kind === 'code-wanted'
      if (!field) return no('the CLI isn\'t asking for a code now')
      if (!PASTED.test(value)) return no('that doesn\'t look like a sign-in code')
      typedBy.set(s.id, [...(typedBy.get(s.id) ?? []), value])
      s.answered = { at: s.total, when: deps.now() }
      show(s, deps, { kind: 'working' })
      s.pty.write(value + '\r')
      return DONE
    }
    case 'text': {
      const value = typeof input.value === 'string' ? input.value.trim() : ''
      if (p.kind !== 'text-wanted') return no('the CLI isn\'t asking for that now')
      if (!PASTED.test(value)) return no('that can\'t be typed for it')
      typedBy.set(s.id, [...(typedBy.get(s.id) ?? []), value])
      s.answered = { at: s.total, when: deps.now() }
      show(s, deps, { kind: 'working' })
      s.pty.write(value + '\r')
      return DONE
    }
    case 'pick':
      return pick(s, deps, input.index, input.label)
    case 'live':
      if (p.kind !== 'unknown') return no('the screen is readable: use the sheet')
      s.live = input.on === true
      show(s, deps, { kind: 'unknown', screen: masked(s), typing: s.live })
      return DONE
    default:
      // keys: only while the user has "Let me type here" on.
      if (p.kind !== 'unknown' || !s.live) return no('typing here is off')
      if (typeof input.data !== 'string' || input.data.length === 0 || input.data.length > 256) return no('nothing to type')
      s.pty.write(input.data)
      return DONE
  }
}

/** Ends every session a window started: it went away. */
export function endSignInsOf(owner: unknown): void {
  for (const s of [...sessions.values()]) if (s.spec.owner === owner) end(s, s.deps)
}

/** Ends every session (quit). */
export function endSignIns(): void {
  for (const s of [...sessions.values()]) end(s, s.deps)
}

/** How many sessions run now. */
export function signInSessionCount(): number {
  return sessions.size
}

/** How many sessions hold something the user typed: none once they ended. */
export function _typedHeldForTest(): number {
  return typedBy.size
}

export function _resetSignInSessionsForTest(): void {
  sessions.clear()
  typedBy.clear()
}
