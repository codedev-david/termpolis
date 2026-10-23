// agy's guided account switch (scope for v1.55.0; facts in handoff verify-accounts154/agy-signin.md).
// agy keeps ONE Google sign-in for the computer user, in the OS keyring, so an agy "account" is a
// label, and moving to one signs every agy on this computer out and into it. The user asks for it,
// after a confirmation that says so (the dialog's). Then, one step per call:
//
//   sign-out  agy is exited only while it is live on screen, with its own /exit (R2), and its exit
//             hint gives the conversation's id; agy is started again and its own /logout typed in
//             its box, Enter only once the box shows it. Its sign-in screen comes next, or its box.
//   login     on the user's click only: /login, where agy showed its box and no sign-in screen.
//   check     one look: agy's box back after its sign-in screen means the user finished signing in.
//             Termpolis answers nothing on the sign-in (it decides which account and which method),
//             and never reads agy's keyring entry or token files to tell.
//   resume    agy exited again, and `agy --conversation=<id>` typed: the same conversation, by its
//             exact id, on the new sign-in.
//
// Wherever a step can't be driven safely, the outcome says what to type instead, in exact words,
// and the resume line still names the conversation's id. Each typing step holds the terminal's
// relaunch lock (accountSwitch.ts, R7); none is held while the user signs in.
import { EXIT_COMMAND, SIGN_IN_SCREEN, AGY_SIGNED_IN, relaunchCommand } from '../shared/accountSwitch'
import type { AgyStepOutcome, AgyStepRequest } from '../shared/accountSwitch'
import { familyOf } from '../shared/agentAccounts'
import type { ShellFamily } from '../shared/agentAccounts'
import {
  EXIT_CONFIRM_MS, LOCK_MS, OUTCOME_MS, atIdleBox, exitShown, indexOf, liveness, locks, look, plain, relaunchLockReason,
  typeAtPrompt, typeIntoBox, waitFor, watchOutcome,
} from './accountSwitch'
import { sinceStarted } from './mcpServer'
import type { AgentStartRecord, SwitchIO } from './accountSwitch'

/** How long agy gets to draw its box or its sign-in screen after it starts: it is slow to start. */
export const AGY_START_MS = 20_000
/** How long its sign-in screen gets to show after /logout or /login. */
export const SIGN_IN_SHOW_MS = 10_000

/** Variables that make agy sign in without its own Google sign-in: /logout signs nothing out then
 *  (agy's changelog). Names only; their values are never read. */
export const AGY_ENV_AUTH = ['GEMINI_API_KEY', 'AGY_ADC_AUTH'] as const

export interface AgyContext {
  io: SwitchIO
  /** Where agy was started in this terminal, when Termpolis typed it. */
  start?: AgentStartRecord
  /** Termpolis's environment, for AGY_ENV_AUTH's names. */
  env: Readonly<Record<string, string | undefined>>
  /** What main records once the conversation is back: every agy terminal is on the target now. */
  record: (r: { start: AgentStartRecord }) => void
}

/** An address agy's header shows in the screen's first rows ("name@example.com (Google AI Pro)"),
 *  for the user to read; null for none. Read loosely, and never to decide anything. */
export function shownEmail(rows: readonly string[]): string | null {
  for (const row of rows.slice(0, 10)) {
    const m = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/.exec(row)
    if (m) return m[0]
  }
  return null
}

/** agy's sign-in screen is on screen now. */
const signInShown = (io: SwitchIO, id: string): boolean => SIGN_IN_SCREEN.agy.test(look(io, id).lines.join('\n'))

/** The agy started at `mark` is up: its sign-in screen drawn since, or its idle box drawn since. The
 *  last frame the agy before it left, box and all, is still on screen above the prompt: no box of
 *  this one. */
function agyUp(io: SwitchIO, id: string, mark: number): 'sign-in' | 'box' | null {
  if (SIGN_IN_SCREEN.agy.test(plain(io.outputFrom(id, mark)))) return 'sign-in'
  const l = atIdleBox(io, id)
  return l && sinceStarted(l.raw, indexOf(l, mark), false, io.size(id), ['agy']).started ? 'box' : null
}

/** Holds the terminal for a typing step, and lets it go after, whatever happens. */
async function locked(io: SwitchIO, id: string, run: () => Promise<AgyStepOutcome>): Promise<AgyStepOutcome> {
  if (relaunchLockReason(id, io.now())) return { kind: 'refused', why: 'a switch is already running in this terminal' }
  locks.set(id, { until: io.now() + LOCK_MS, kind: 'account' })
  try {
    return await run()
  } catch (e) {
    return { kind: 'refused', why: e instanceof Error ? e.message : String(e) }
  } finally {
    locks.delete(id)
  }
}

/** Exits a live agy with its own /exit, or reads the hint of one gone already: the conversation's
 *  id, or what the user does instead. */
async function exitAgy(io: SwitchIO, id: string, start: AgentStartRecord | undefined, assumeExited: boolean): Promise<{ id: string | null } | AgyStepOutcome> {
  if (assumeExited) {
    const hint = liveness(io, id, 'agy', undefined)
    return { id: hint.state === 'gone' && hint.hint ? hint.hint.id : null }
  }
  const alive = liveness(io, id, 'agy', start)
  if (alive.state === 'unknown') return { kind: 'unknown-exit' }
  if (alive.state === 'gone') return { id: alive.hint?.id ?? null }
  const idle = atIdleBox(io, id)
  if (!idle) return { kind: 'do-it-yourself', say: 'agy isn\'t at its input: let it finish, or answer what it asks, then type /exit in agy and switch again.' }
  const mark = io.end(id)
  const typed = await typeIntoBox(io, id, EXIT_COMMAND.agy, idle)
  if (typed !== 'entered') return { kind: 'do-it-yourself', say: 'Termpolis couldn\'t type /exit into agy: type /exit in agy yourself, then switch again.' }
  const shown = await waitFor(io, EXIT_CONFIRM_MS, () => exitShown(io, id, 'agy', mark))
  if (!shown) return { kind: 'do-it-yourself', say: 'Termpolis couldn\'t confirm agy exited: type /exit in agy yourself, then switch again.' }
  return { id: shown.hint?.id ?? null }
}

/** After /logout or /login: agy's sign-in screen, or its box with none. */
async function afterSignOut(io: SwitchIO, id: string, conversationId: string | null, mark: number): Promise<AgyStepOutcome> {
  const shown = await waitFor(io, SIGN_IN_SHOW_MS, () => signInShown(io, id))
  if (shown) return { kind: 'signing-in', conversationId, mark }
  return atIdleBox(io, id) ? { kind: 'needs-login', conversationId, mark } : { kind: 'do-it-yourself', say: 'agy didn\'t show its sign-in: type /login in agy and sign in there.' }
}

export async function runAgyStep(req: AgyStepRequest, ctx: AgyContext): Promise<AgyStepOutcome> {
  const { io } = ctx
  const id = req.terminalId
  const family: ShellFamily | null = familyOf(req.shellType)
  if (!family) return { kind: 'refused', why: 'Termpolis can\'t type into this terminal\'s shell' }
  const conversationId = req.conversationId ?? null
  const resumeLine = relaunchCommand({ agent: 'agy', id: conversationId })

  if (req.step === 'check') {
    const l = look(io, id)
    const since = plain(io.outputFrom(id, req.mark ?? 0))
    const saw = SIGN_IN_SCREEN.agy.test(since) || AGY_SIGNED_IN.test(since)
    return saw && l.box >= 0 && !signInShown(io, id) ? { kind: 'signed-in' } : { kind: 'waiting' }
  }

  if (req.step === 'login') {
    return locked(io, id, async () => {
      const idle = atIdleBox(io, id)
      if (!idle) return { kind: 'do-it-yourself', say: 'Type /login in agy and sign in there.' }
      const mark = io.end(id)
      const typed = await typeIntoBox(io, id, '/login', idle)
      if (typed !== 'entered') return { kind: 'do-it-yourself', say: 'Termpolis couldn\'t type /login into agy: type /login in agy yourself and sign in there.' }
      return afterSignOut(io, id, conversationId, mark)
    })
  }

  if (req.step === 'sign-out') {
    const env = AGY_ENV_AUTH.find((name) => !!ctx.env[name])
    if (env) return { kind: 'refused', why: `agy signs in with ${env} from the environment here, so /logout signs nothing out: change ${env} instead` }
    return locked(io, id, async () => {
      const exited = await exitAgy(io, id, ctx.start, !!req.assumeExited)
      if ('kind' in exited) return exited
      // A new agy, only to sign out: its own /logout, typed in its box.
      const mark = io.end(id)
      const started = await typeAtPrompt(io, id, family, 'agy', mark)
      if (started.outcome !== 'entered') {
        return { kind: 'do-it-yourself', say: 'Termpolis couldn\'t start agy here: type agy, then /logout in it, and sign in again.', line: resumeLine }
      }
      const up = await waitFor(io, AGY_START_MS, () => agyUp(io, id, mark))
      if (up === 'sign-in') return { kind: 'signing-in', conversationId: exited.id, mark }
      const idle = up ? atIdleBox(io, id) : null
      if (!idle) return { kind: 'do-it-yourself', say: 'agy didn\'t come up: type /logout in agy once it shows its input, and sign in again.', line: relaunchCommand({ agent: 'agy', id: exited.id }) }
      const typed = await typeIntoBox(io, id, '/logout', idle)
      if (typed !== 'entered') return { kind: 'do-it-yourself', say: 'Termpolis couldn\'t type /logout into agy: type /logout in agy yourself, and sign in again.', line: relaunchCommand({ agent: 'agy', id: exited.id }) }
      return afterSignOut(io, id, exited.id, mark)
    })
  }

  // resume: agy exited again (signed in now, its box back), and the conversation by its id.
  return locked(io, id, async () => {
    const exited = await exitAgy(io, id, undefined, !!req.assumeExited)
    if ('kind' in exited) return { kind: 'do-it-yourself', say: `Type /exit in agy, then: ${resumeLine}`, line: resumeLine }
    const at = io.end(id)
    const typed = await typeAtPrompt(io, id, family, resumeLine, at)
    if (typed.outcome !== 'entered') return { kind: 'do-it-yourself', say: `Termpolis couldn't type the line: type ${resumeLine} in the terminal.`, line: resumeLine }
    ctx.record({ start: { at, commands: [resumeLine] } })
    const watched = await watchOutcome(io, id, 'agy', typed.enterAt, resumeLine, io.now() + OUTCOME_MS)
    if (watched.seen === 'sign-in') return { kind: 'do-it-yourself', say: 'agy is still signed out: sign in there, then it continues.' }
    if (watched.seen !== 'switched') return { kind: 'do-it-yourself', say: `agy didn't come back within 30 seconds: look at the terminal. The conversation resumes with ${resumeLine}.`, line: resumeLine }
    const email = shownEmail(look(io, id).lines)
    // agy's own "not found, ignoring --conversation": a new conversation, which it started itself.
    const fresh = watched.notFound || conversationId === null
    return { kind: 'switched', fresh, conversationId: fresh ? null : conversationId, ...(email ? { shownEmail: email } : {}) }
  })
}
