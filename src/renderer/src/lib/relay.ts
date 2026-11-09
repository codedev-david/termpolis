// v1.55.0 relay: hand a long Claude session on to a fresh one at a cold-cache boundary (after a
// compaction the prompt cache is cold anyway, so a new session costs no extra cache write).
//
// The running agent writes a handoff note into Termpolis memory and replies with its id. Then the
// agent is quit the same way the model picker quits it (Ctrl+C x3, then the OS says only the shell
// is left), and a new session starts on the chosen model, told to read that note first. Nothing is
// timed by a fixed sleep: the id is polled for until a deadline, and the quit waits on shellAlone.
// If no id appears, nothing is quit: the agent keeps running and the caller says why.

import { waitForExit, PROMPT_SETTLE_MS } from '../../../shared/agentExit'
import { carriedLaunchArgs } from '../../../shared/launchCarry'
import type { ClaudeModelWord } from '../../../shared/taskRouter'
import { relaunchCommandFor, type ModelCatalog } from './modelCatalog'
import { QUIT_PRESSES, QUIT_PRESS_GAP_MS, type RelaunchIO } from './modelRelaunch'
import { stripAnsi } from './exportTerminal'

export const HANDOFF_PROMPT =
  'Write a handoff for a fresh session with memory_write: goal, done, next step, files, open questions. Reply only with its id.'
/** How long the agent gets to write the note and print its id. */
export const HANDOFF_WAIT_MS = 120_000
export const HANDOFF_POLL_MS = 1_000
/** Between the pasted prompt and its Enter, so the TUI reads the Enter as a keystroke (useAutoPrimer). */
export const RELAY_SUBMIT_SETTLE_MS = 150

const BP_START = '\x1b[200~'
const BP_END = '\x1b[201~'
// swarmMemory.ts writes ids as mem-<ms>-<seq>-<6 hex>.
const MEMORY_ID = /\bmem-\d{10,}-\d+-[0-9a-f]{6}\b/g

/** The last memory id in `text`, or null. The last one: the agent's reply comes after anything it echoed. */
export function handoffIdFrom(text: string | null): string | null {
  if (!text) return null
  const all = stripAnsi(text).match(MEMORY_ID)
  return all ? all[all.length - 1] : null
}

/** The new session's line: the agent's carried flags, the model when one is known, and the first prompt. */
export function relayLaunchLine(model: ClaudeModelWord | null, catalog: ModelCatalog | null | undefined, launchCommand: string | null | undefined, id: string): string {
  const head = model
    ? relaunchCommandFor('claude', model, catalog, launchCommand, { kind: 'none' })
    : ['claude', ...carriedLaunchArgs('claude', launchCommand)].join(' ')
  if (!head) return ''
  // No quotes, $, ` or ! inside: the same text is safe in bash, PowerShell and cmd.
  return `${head} "Continue from handoff ${id}: call memory_search for it first."`
}

export type RelayResult = { started: true; id: string } | { started: false; reason: string }

export interface RelayIO extends RelaunchIO {
  /** Set when the user cancels; checked between polls. */
  aborted?: () => boolean
}

/** Phase 1: ask for the handoff and wait for its id. Nothing is quit here. */
export async function requestHandoff(io: RelayIO): Promise<RelayResult> {
  const now = io.now ?? Date.now
  let mark: number | null = null
  try { mark = io.outputMark ? await io.outputMark() : null } catch { mark = null }
  io.write(`${BP_START}${HANDOFF_PROMPT}${BP_END}`)
  await io.sleep(RELAY_SUBMIT_SETTLE_MS)
  io.write('\r')
  const deadline = now() + HANDOFF_WAIT_MS
  while (now() < deadline) {
    if (io.aborted?.()) return { started: false, reason: 'The fresh session was cancelled; this one keeps running.' }
    await io.sleep(HANDOFF_POLL_MS)
    let text: string | null = null
    try { text = io.outputSince ? await io.outputSince(mark) : null } catch { text = null }
    const id = handoffIdFrom(text)
    if (id) return { started: true, id }
  }
  return { started: false, reason: 'No handoff id appeared within 2 minutes, so nothing was restarted; this session keeps running.' }
}

/** Phase 2: quit the agent and start the new session on the handoff. */
export async function launchFromHandoff(io: RelaunchIO, id: string, model: ClaudeModelWord | null, catalog: ModelCatalog | null | undefined, launchCommand?: string | null): Promise<RelayResult> {
  const line = relayLaunchLine(model, catalog, launchCommand, id)
  if (!line) return { started: false, reason: `That model can't be started here; the handoff is saved as ${id}.` }
  for (let i = 0; i < QUIT_PRESSES; i++) {
    if (i > 0) await io.sleep(QUIT_PRESS_GAP_MS)
    io.write('\x03')
  }
  if (!(await waitForExit(io, true))) return { started: false, reason: `Claude did not quit, so nothing was typed; the handoff is saved as ${id}.` }
  await io.sleep(PROMPT_SETTLE_MS)
  io.write(`${line}\r`)
  return { started: true, id }
}
