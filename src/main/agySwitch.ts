// agy's switch-all (the in-app account UI, §2.4; facts in handoff verify-accounts154/agy-signin.md).
// agy keeps ONE Google sign-in for the computer user, in the OS keyring, so an agy "account" is a
// label, and moving to one moves every agy on this computer. The user asks for it, after a
// confirmation that says so. Then, for each agy terminal, these two steps, around the sign-in
// itself, which runs in main's hidden session (signInSession.ts) and never in a terminal:
//
//   exit    agy is exited only while it is live on screen and at its input, with its own /exit
//           (R2: no Ctrl+C, which stops a turn and kills agy), entered once its box shows it; its
//           exit hint gives the conversation's id. A turn at work is waited for (busy), never
//           interrupted.
//   resume  `agy --conversation=<id>` typed at the prompt, entered once it shows there: the same
//           conversation, by its exact id, on the new sign-in.
//
// Each step holds the terminal's relaunch lock while it types (accountSwitch.ts, R7). Where a step
// can't be driven safely, it says why and types nothing more: the user's terminal is never handed a
// command to type.
import { EXIT_COMMAND, carryForSwitch, relaunchCommand } from '../shared/accountSwitch'
import type { AgyStepOutcome, AgyStepRequest } from '../shared/accountSwitch'
import { familyOf } from '../shared/agentAccounts'
import {
  LOCK_MS, OUTCOME_MS, atIdleBox, exitConfirmed, liveness, livenessNow, locks, look, relaunchLockReason, typeAtPrompt, typeIntoBox, watchOutcome,
} from './accountSwitch'
import type { AgentStartRecord, OsMemo, SwitchIO } from './accountSwitch'

/** Variables that make agy sign in without its own Google sign-in: /logout signs nothing out then
 *  (agy's changelog). Names only; their values are never read. */
export const AGY_ENV_AUTH = ['GEMINI_API_KEY', 'AGY_ADC_AUTH'] as const

export interface AgyContext {
  io: SwitchIO
  /** Where agy was started in this terminal, when Termpolis typed it. */
  start?: AgentStartRecord
  /** Termpolis's environment, for AGY_ENV_AUTH's names. */
  env: Readonly<Record<string, string | undefined>>
  /** What main records once the conversation is typed again: agy's new start there. */
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

/** The agy env sign-in that makes a switch pointless here, by name; null for none. */
export function agyEnvAuth(env: Readonly<Record<string, string | undefined>>): string | null {
  return AGY_ENV_AUTH.find((name) => !!env[name]) ?? null
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

/** Exits a live agy with its own /exit, or reads the hint of one gone already: the conversation's id. */
async function exitAgy(io: SwitchIO, id: string, start: AgentStartRecord | undefined, assumeExited: boolean): Promise<AgyStepOutcome> {
  if (assumeExited) {
    const hint = liveness(io, id, 'agy', undefined)
    return { kind: 'exited', conversationId: hint.state === 'gone' && hint.hint ? hint.hint.id : null }
  }
  const os: OsMemo = { known: false }
  const alive = await livenessNow(io, id, 'agy', start, os)
  if (alive.state === 'unknown') return { kind: 'unknown-exit' }
  // Gone before Termpolis typed anything: the user quit it. The conversation its hint names is still told, but nothing
  // is brought back where agy was not running (SW2-9).
  if (alive.state === 'gone') return { kind: 'exited', conversationId: alive.hint?.id ?? null, alreadyGone: true }
  // At work, or asking something: its turn is waited for, never stopped.
  const idle = atIdleBox(io, id)
  if (!idle) return { kind: 'busy' }
  const mark = io.end(id)
  const typed = await typeIntoBox(io, id, EXIT_COMMAND.agy, idle)
  if (typed !== 'entered') return { kind: 'not-exited', why: 'Termpolis couldn\'t type /exit into agy\'s input, so it typed nothing more' }
  const shown = await exitConfirmed(io, id, 'agy', mark, os)
  if (!shown) return { kind: 'not-exited', why: 'agy didn\'t confirm it exited, so Termpolis typed nothing more' }
  return { kind: 'exited', conversationId: shown.hint?.id ?? null }
}

const NOT_TYPED: Readonly<Record<'agent-alive' | 'didnt-start' | 'mismatch', string>> = {
  'agent-alive': 'agy is running in this terminal again',
  'didnt-start': 'the line never showed in the terminal, so nothing was entered',
  mismatch: 'a shell of another kind runs in this terminal now (one started inside it)',
}

export async function runAgyStep(req: AgyStepRequest, ctx: AgyContext): Promise<AgyStepOutcome> {
  const { io } = ctx
  const id = req.terminalId
  const family = familyOf(req.shellType)
  if (!family) return { kind: 'refused', why: 'Termpolis can\'t type into this terminal\'s shell' }

  if (req.step === 'exit') {
    const env = agyEnvAuth(ctx.env)
    if (env) return { kind: 'refused', why: `agy signs in with ${env} from the environment here, so switching its sign-in changes nothing: change ${env} instead` }
    // What agy was started with is decided before anything is typed (carryForSwitch).
    const carry = carryForSwitch('agy', ctx.start?.commands[0])
    if (!carry.ok) return { kind: 'refused', why: carry.why }
    return locked(io, id, () => exitAgy(io, id, ctx.start, !!req.assumeExited))
  }

  // resume: the conversation by its id, at the shell's prompt, on the sign-in agy has now.
  const conversationId = req.conversationId ?? null
  return locked(io, id, async () => {
    // Its model and its other options come back with it (carryForSwitch), as in Claude Code's and Codex's.
    const carry = carryForSwitch('agy', ctx.start?.commands[0])
    if (!carry.ok) return { kind: 'refused', why: carry.why }
    const line = relaunchCommand({ agent: 'agy', id: conversationId, ...(carry.model ? { model: carry.model } : {}), extra: carry.extra })
    const at = io.end(id)
    // No wait outlasts the lock this step holds the terminal under (a very slow shell is given up on at its end, as the account
    // switch's is: MODELS-R3-4).
    const until = io.now() + LOCK_MS - 1000
    // The sign-in change between the two steps can take minutes, and anything may have happened to the terminal meanwhile: the user
    // quit agy by hand and started it again, or left a draft in a box that is still there. Where the receiver of a key is not proven to
    // be the shell, no sacrificial Enter is sent (it submits a draft), and no Esc (it declines a dialog): the first part of the line
    // is typed alone and looked at, as the account switch does where the user said the agent had exited (SW3-2).
    const typed = await typeAtPrompt(io, id, family, line, at, until, false)
    if (typed.outcome !== 'entered') return { kind: 'not-resumed', why: NOT_TYPED[typed.outcome] }
    ctx.record({ start: { at, commands: [line] } })
    const watched = await watchOutcome(io, id, 'agy', typed.enterAt, line, Math.min(until, io.now() + OUTCOME_MS))
    if (watched.seen === 'sign-in') return { kind: 'not-resumed', why: 'agy shows its sign-in in the terminal: it isn\'t signed in' }
    if (watched.seen !== 'switched') return { kind: 'not-resumed', why: 'agy didn\'t come back within 30 seconds' }
    const email = shownEmail(look(io, id).lines)
    // agy's own "not found, ignoring --conversation": a new conversation, which it started itself.
    const fresh = watched.notFound || conversationId === null
    return { kind: 'resumed', fresh, conversationId: fresh ? null : conversationId, ...(email ? { shownEmail: email } : {}) }
  })
}
