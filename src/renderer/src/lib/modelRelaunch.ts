// Relaunches a terminal's agent process on a different model instead of
// hot-swapping in place. Claude Code (v2.1.153+) treats `/model <alias>` typed
// directly as "switch AND save as my new global default", rewriting
// ~/.claude/settings.json — so a per-terminal picker that types that command
// corrupts every other terminal's next launch. `--model` at launch is
// documented session-only, and each agent can resume a conversation, so this
// achieves a real per-terminal switch instead.
//
// Every step below was found wrong, and fixed, by driving the real CLIs (Claude Code 2.1.311,
// Antigravity CLI 1.4.x) through a real PTY:
//
//   - Ctrl+D is the wrong key. Antigravity ignores it (it prints "press ctrl+d again to exit"
//     and stays), and at a shell prompt it closes the terminal. Ctrl+C is harmless at a prompt
//     and, pressed three times, quits every agent we drive: the first clears typed text or
//     interrupts a turn, the second arms "press Ctrl+C again to exit", the third quits.
//   - A fixed wait after the keys is the wrong clock. Claude Code took 7-11 s to hand the prompt
//     back on a machine with SessionEnd hooks, and a command typed while it is still tearing
//     down is swallowed: no error, no relaunch, the terminal just sits at a bare prompt. So we
//     ask the OS (shellAlone: nothing runs in the terminal but its shell) and type only once it
//     says the agent is gone. If it never goes, nothing more is typed.
//   - "Continue the most recent conversation" is the wrong question (see agentResume.ts). Right
//     after launch it made Claude Code say "No conversation found to continue" and leave a bare
//     prompt, and it made Antigravity resume a conversation from another project. Both agents
//     print the exact conversation to resume as they exit, so we read that and resume it, or start
//     a new session when they print none.
//
// Only call this for a terminal AUTHORITATIVELY known to be running that agent (Termpolis itself
// launched it) — a heuristically output-detected "Claude-like" terminal might be a different
// program that the quit keys would not mean the same thing to.
//
// The sequence runs for seconds, and in that time anything else typing into the terminal (an account
// switch, a conductor's text, the phone, the user's keys) would land in the agent as it quits or on
// the shell's line under the relaunch. relaunchHeld wraps it in the terminal's relaunch lock: the
// store's half (the pane takes no keys, the pollers answer nothing, an account switch waits) and
// main's (MCP clients and the phone are refused, every write but this relaunch's own is dropped).
// An account switch moves the agent with its own steps (src/main/accountSwitch.ts) but decides
// "the agent has exited" from the same OS answer (shellAlone) and types into the same shell, whose
// account variable stays set: a model change keeps the account, an account change keeps the model.

import { MODEL_HELD } from '../../../shared/accountSwitch'
import { EXIT_CEILING_MS, EXIT_POLL_MS, BLIND_EXIT_WAIT_MS, PROMPT_SETTLE_MS, aloneNow, waitForExit } from '../../../shared/agentExit'
import type { ModelHold, ModelHoldRequest } from '../../../shared/accountSwitch'
import type { IpcResponse } from '../types'
import { providerForCommand, relaunchCommandFor, type ModelCatalog, type ModelProvider } from './modelCatalog'
import { hasStrictResumeHint, resumeTargetFrom, unsureResumeTarget } from './agentResume'
import { stripAnsi } from './exportTerminal'

const CTRL_C = '\x03'

/** Ctrl+C presses that quit an agent: clear/interrupt, arm "press again to exit", exit. */
export const QUIT_PRESSES = 3
/** Gap between presses: inside every agent's "press again" window (Codex's is about 1 s). */
export const QUIT_PRESS_GAP_MS = 400
// The clock the account switch waits with too (shared/agentExit.ts), under the names it always had here.
export { EXIT_POLL_MS, EXIT_CEILING_MS, BLIND_EXIT_WAIT_MS, PROMPT_SETTLE_MS }
/** After typing a resume of "the latest", how long a start that cannot work (nothing to continue)
 *  gets to fail. Measured: Claude Code takes about 4-5 s to print "No conversation found" and exit. */
export const RESUME_PROBE_MS = 8_000
/** How much terminal output BEFORE the quit to check for a hint, before concluding there was
 *  nothing to resume. An agent the user quit by hand a moment ago, still running its shutdown
 *  hooks, has already printed its hint, and so has a relaunch typed seconds ago (its `--resume <id>`
 *  is on the screen). */
export const LEAD_WINDOW = 8_192

export interface RelaunchIO {
  write: (data: string) => void
  sleep: (ms: number) => Promise<void>
  /** Clock for the exit ceiling; Date.now unless a test injects one. */
  now?: () => number
  /** Whether nothing runs in the terminal but its shell, as the OS tells: true once the agent has
   *  exited, false while it runs, null where main cannot tell. Absent or failing reads as null. */
  shellAlone?: () => Promise<boolean | null>
  /** Where the terminal's output stands now, or null when that can't be read. Taken just before the
   *  quit keys, so what the quit prints can be told from everything before it. */
  outputMark?: () => Promise<number | null>
  /** The output printed since `mark` (everything still retained when `mark` is null), as plain text,
   *  or null when it can't be read whole. Absent or failing reads as null. */
  outputSince?: (mark: number | null) => Promise<string | null>
}

/** What happened, so the caller can say so instead of leaving the picker showing a model that
 *  was never started. */
export type RelaunchOutcome =
  /** The relaunch command was typed at the shell prompt, resuming a conversation. */
  | 'relaunched'
  /** The agent was watched quitting and said nothing about resuming, so there was nothing to resume:
   *  a new session was started on the model. */
  | 'started-new'
  /** It could not be told which conversation to resume (and a wrong guess is worse than none), so a
   *  new session was started on the model. */
  | 'started-unsure'
  /** A resume left nothing running, so a new session was typed instead. */
  | 'started-fresh'
  /** Not a model this provider offers: nothing was sent. */
  | 'invalid'
  /** The terminal was not started by this agent's own command (a wrapper such as `claude-sandbox`).
   *  Restarting it as the bare agent would drop whatever the wrapper adds, a sandbox included, so
   *  nothing was sent. */
  | 'unsupported'
  /** The agent did not quit in time: the relaunch was NOT typed. */
  | 'still-running'

async function markNow(io: RelaunchIO): Promise<number | null> {
  if (!io.outputMark) return null
  try {
    return await io.outputMark()
  } catch {
    return null
  }
}

async function outputNow(io: RelaunchIO, mark: number | null): Promise<string | null> {
  if (!io.outputSince) return null
  try {
    return await io.outputSince(mark)
  } catch {
    return null
  }
}

async function quitAgent(io: RelaunchIO): Promise<void> {
  for (let i = 0; i < QUIT_PRESSES; i++) {
    // The gap goes BETWEEN presses; the exit wait that follows covers the rest.
    if (i > 0) await io.sleep(QUIT_PRESS_GAP_MS)
    io.write(CTRL_C)
  }
}

/**
 * Relaunch any supported agent on `modelId`, picking its conversation back up.
 * No-ops when the model isn't one the catalog actually offers for that provider,
 * so nothing unvalidated can reach the PTY.
 */
export async function relaunchAgentWithModel(
  provider: ModelProvider,
  modelId: string,
  catalog: ModelCatalog | null | undefined,
  io: RelaunchIO,
  /** What the terminal was started with: its flags (permission mode, approvals) carry over. */
  launchCommand?: string | null,
): Promise<RelaunchOutcome> {
  if (!relaunchCommandFor(provider, modelId, catalog, launchCommand)) return 'invalid'
  // The picker also appears for any command that merely STARTS with an agent's name (`claude-sandbox`,
  // `claudex`). Typing the bare agent in its place would silently swap the program for another.
  if (launchCommand?.trim() && providerForCommand(launchCommand) !== provider) return 'unsupported'

  // Only the shell is left: the agent already exited, and any key now would reach the shell.
  const before = await aloneNow(io)
  let mark: number | null = null
  const quit = before !== true
  if (quit) {
    mark = await markNow(io)
    await quitAgent(io)
    if (!(await waitForExit(io, before === false))) return 'still-running'
    await io.sleep(PROMPT_SETTLE_MS)
  }

  // What the agent printed as it exited names the conversation to resume. Reading it is only
  // conclusive if it is the quit we watched: the OS positively said the agent was running, the output
  // was marked before the keys, and it is read whole after. An agent that was already gone, or that
  // the OS could not see, may have printed its hint before the mark.
  const output = quit && mark === null ? null : await outputNow(io, quit ? mark : null)
  let resume = resumeTargetFrom(provider, output, before === false && mark !== null)

  // "Nothing to resume" is the one conclusion that abandons a conversation if it is wrong, so it gets
  // a second opinion from what the terminal showed just BEFORE the quit: a hint printed by an agent
  // that was already on its way out, or the `--resume <id>` of a switch typed moments ago. Only the
  // narrow test is used there: a running agent's own screen is full of ordinary words.
  if (resume.kind === 'none' && resume.reason === 'empty' && mark !== null) {
    const wider = await outputNow(io, Math.max(0, mark - LEAD_WINDOW))
    if (wider === null || hasStrictResumeHint(provider, wider)) resume = unsureResumeTarget(provider)
  }

  io.write(`${relaunchCommandFor(provider, modelId, catalog, launchCommand, resume)}\r`)
  if (resume.kind === 'none') return resume.reason === 'empty' ? 'started-new' : 'started-unsure'

  // A resume can still come up empty ("No conversation found to continue") and leave the shell at its
  // prompt, or name a conversation that is not there from this folder. That is likely when the target
  // is the agent's latest (a guess), or an id read from an agent that had ALREADY exited (the hint may
  // be old, and the folder may have changed since). If nothing is running after a start has had time
  // to fail, start a new session on the model that was asked for.
  if (resume.kind === 'id' && quit) return 'relaunched'
  await io.sleep(RESUME_PROBE_MS)
  if ((await aloneNow(io)) !== true) return 'relaunched'
  io.write(`${relaunchCommandFor(provider, modelId, catalog, launchCommand, { kind: 'none' })}\r`)
  return 'started-fresh'
}

// ── The terminal's relaunch lock ───────────────────────────────────────────────────────

/** Main's half of the terminal's relaunch lock, where this preload has it. */
export interface ModelHoldBridge {
  modelHold: (req: ModelHoldRequest) => Promise<IpcResponse<ModelHold>>
  modelRelease: (terminalId: string, key: string) => Promise<unknown>
}

export interface HeldRelaunch {
  terminalId: string
  provider: ModelProvider
  modelId: string
  catalog: ModelCatalog | null | undefined
  /** What the terminal was started with (relaunchAgentWithModel). */
  launchCommand?: string | null
  /** The store's half of the lock: true once this relaunch holds the terminal there. */
  begin: () => boolean
  end: () => void
  main: ModelHoldBridge | null
  /** The terminal's writes (window.termpolis.writeToTerminal): each carries the key of main's hold,
   *  while there is one. */
  write: (id: string, data: string, key?: string) => void
  /** What the relaunch reads and waits with (terminalRelaunchIo). */
  io: Omit<RelaunchIO, 'write'>
}

/** How a held relaunch ended: the engine's outcome, or why the lock was refused and nothing was typed. */
export type HeldResult = { outcome: RelaunchOutcome } | { refused: string }

/**
 * The model picker's relaunch (relaunchAgentWithModel) holding the terminal's relaunch lock for its
 * whole run (R7): nothing is typed unless both halves are this relaunch's, and both are let go on every
 * outcome, a throw included (main's lapses by itself after MODEL_HOLD_MS). Main records the line this
 * relaunch types as the agent's start, so a later account switch relaunches the model picked here.
 */
export async function relaunchHeld(r: HeldRelaunch): Promise<HeldResult> {
  // A model the provider doesn't offer, or a command that isn't the plain agent, is the engine's to
  // refuse; neither is worth holding the terminal for.
  if (!relaunchCommandFor(r.provider, r.modelId, r.catalog, r.launchCommand)) return { outcome: 'invalid' }
  if (r.launchCommand?.trim() && providerForCommand(r.launchCommand) !== r.provider) return { outcome: 'unsupported' }
  if (!r.begin()) return { refused: MODEL_HELD }
  let key: string | null = null
  try {
    if (r.main) {
      const res = await r.main.modelHold({ terminalId: r.terminalId })
      if (!res.success) return { refused: res.error }
      key = res.data.key
    }
    const held = key
    const write = held ? (data: string) => r.write(r.terminalId, data, held) : (data: string) => r.write(r.terminalId, data)
    return { outcome: await relaunchAgentWithModel(r.provider, r.modelId, r.catalog, { ...r.io, write }, r.launchCommand) }
  } finally {
    if (r.main && key) r.main.modelRelease(r.terminalId, key).catch(() => { /* it lapses by itself (MODEL_HOLD_MS) */ })
    r.end()
  }
}

/** Main's hold for the picker, when this preload has one. */
export function modelHoldBridge(): ModelHoldBridge | null {
  const api = window.accounts
  return api && typeof api.modelHold === 'function' && typeof api.modelRelease === 'function' ? api : null
}

/**
 * What a relaunch of terminal `terminalId` reads and waits with, from the preload's bridge: the
 * OS's own answer to "has the agent really exited?" (without it the relaunch was typed on a timer,
 * into a Claude Code still shutting down), and what the agent prints as it exits, which names the
 * conversation to resume. The picker and the usage-limit card's model row share it.
 */
export function terminalRelaunchIo(terminalId: string): Omit<RelaunchIO, 'write'> {
  return {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    shellAlone: async () => {
      const res = await window.termpolis.terminalShellAlone?.(terminalId)
      return res?.success ? res.data : null
    },
    outputMark: async () => {
      const res = await window.termpolis.readTerminalBuffer?.(terminalId)
      const at = res?.success && res.data ? res.data.nextOffset : null
      // A mark that is not a real offset would read as "nothing was printed".
      return typeof at === 'number' && Number.isFinite(at) ? at : null
    },
    outputSince: async (mark) => {
      const res = await window.termpolis.readTerminalBuffer?.(terminalId, mark ?? undefined)
      if (!res?.success || !res.data) return null
      // Output that fell out of the buffer between the mark and now is output that was never
      // read: not conclusive, so report it as unreadable.
      if (mark !== null && res.data.missed > 0) return null
      // A cursor-forward is how a TUI draws a space: keep it as one, or the words of the exit
      // line run together.
      return stripAnsi(res.data.output.replace(/\x1b\[\d*C/g, ' '))
    },
  }
}
