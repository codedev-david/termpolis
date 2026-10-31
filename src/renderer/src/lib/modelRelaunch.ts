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

import { providerForCommand, relaunchCommandFor, type ModelCatalog, type ModelProvider } from './modelCatalog'
import { hasStrictResumeHint, resumeTargetFrom, unsureResumeTarget } from './agentResume'

const CTRL_C = '\x03'

/** Ctrl+C presses that quit an agent: clear/interrupt, arm "press again to exit", exit. */
export const QUIT_PRESSES = 3
/** Gap between presses: inside every agent's "press again" window (Codex's is about 1 s). */
export const QUIT_PRESS_GAP_MS = 400
/** Between "has it gone?" questions. On Windows each question also costs ~1 s on its own. */
export const EXIT_POLL_MS = 500
/** How long an agent gets to quit before we give up and leave the terminal alone. */
export const EXIT_CEILING_MS = 30_000
/** When the OS cannot tell, assume a slow teardown: too long only delays, too short loses the command. */
export const BLIND_EXIT_WAIT_MS = 12_000
/** After the OS says the agent is gone, the shell still has to draw its prompt. */
export const PROMPT_SETTLE_MS = 600
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

async function aloneNow(io: RelaunchIO): Promise<boolean | null> {
  if (!io.shellAlone) return null
  try {
    return await io.shellAlone()
  } catch {
    return null
  }
}

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
 * True once the agent is gone (or, where the OS never could say, once it is sane to guess); false if
 * it was still running at the ceiling. `osKnown`: the OS already answered "still running" once, so
 * it CAN tell, and a later failed query is a hiccup to ask again about rather than a reason to type
 * blind into an agent that may still be tearing down.
 */
async function waitForExit(io: RelaunchIO, osKnown: boolean): Promise<boolean> {
  const now = io.now ?? Date.now
  const deadline = now() + EXIT_CEILING_MS
  let known = osKnown
  for (;;) {
    await io.sleep(EXIT_POLL_MS)
    const alone = await aloneNow(io)
    if (alone === true) return true
    if (alone === false) known = true
    else if (!known) {
      await io.sleep(BLIND_EXIT_WAIT_MS)
      return true
    }
    if (now() >= deadline) return false
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
