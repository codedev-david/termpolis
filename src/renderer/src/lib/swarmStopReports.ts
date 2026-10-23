/**
 * Swarm stop reports: a worker a usage limit or a menu stopped (GitHub #36 item 5).
 *
 * A swarm runs for hours, and a worker that hits its plan's limit (Claude Pro, Codex's five-hour
 * limit, agy's quota) or waits on a menu (Codex's "switch model?") does nothing more until
 * someone acts. The swarm status poller (App.tsx) reads each worker's screen and hands every
 * status here; the first time a worker is stopped, and again only after it got going, or showed no
 * stop for two reads in a row, and stopped again, the conductor is told on the swarm bus, which the
 * dashboard's Messages tab shows too. For a limit, it is told to close the worker and give its task
 * to another installed agent; for a menu, to answer it, which a key press or two does, and the
 * worker keeps what it did so far. Either way it is told to look at the worker's screen with
 * read_output first: a report read off a screen can be wrong, and closing a worker on a wrong one
 * ends its task halfway.
 *
 * The report is addressed to the conductor. swarm_read_messages marks a broadcast read for every
 * reader at once, so a Claude worker that read the bus first would have taken it.
 *
 * From v1.55.0 a worker's usage limit can go to the swarm restart offer first (swarmRestart.ts,
 * §9), once per stop like a report; the offer then tells the conductor itself, or falls back here.
 */

import { menuAnswer, stopKind, type AgentStatusResult } from '../../../shared/agentStatusDetector'
import { stopKey } from '../../../shared/accountLimits'

export interface SwarmWorker {
  terminalId: string
  agentName: string
  role: string
}

/** What stopped each worker, while it is stopped, and how many reads in a row since showed no stop.
 *  `carried`: the stop the worker showed before Termpolis restarted it on another account, which
 *  the resumed session can draw again (R4). Only the worker read at work ends it, or the same stop
 *  seen once this says the worker took a turn since (a prompt the conductor sent it): then it is a
 *  new one. */
const stopped = new Map<string, { key: string; clear: number; carried?: () => Promise<boolean> }>()

/** Who may take a new usage limit over from the report (the swarm restart offer, §9): true when it
 *  did, and told the conductor itself. `words` reads the CLI's own words for the limit off the
 *  screen, when the offer needs them. */
export type StopOffer = (worker: SwarmWorker, result: AgentStatusResult, words?: () => string | null) => boolean | Promise<boolean>

/** How many reads in a row with no stop end one, the worker not read at work. A single read is no
 *  end: while ConPTY repaints a resized screen, a stopped worker reads idle for a moment, or thinking
 *  while no input box is drawn yet, and the read after it shows the same stop (MW1-3). The poller
 *  reads every 5 seconds; on real Claude Code screens such a moment lasted under a second. */
export const READS_TO_CLEAR = 2

export async function noteWorkerStatus(worker: SwarmWorker, result: AgentStatusResult, offer?: StopOffer, words?: () => string | null): Promise<void> {
  const kind = stopKind(result)
  const last = stopped.get(worker.terminalId)
  if (kind === null) {
    // It got going, or showed no stop for long enough: a stop after this is another one. A stop
    // carried across a restart ends only once the worker is at work.
    if (last && (result.status === 'working' || (!last.carried && ++last.clear >= READS_TO_CLEAR))) stopped.delete(worker.terminalId)
    return
  }
  const key = stopKey(result.summary)
  if (last && last.key === key && !(last.carried && (await last.carried()))) {
    last.clear = 0
    return
  }
  stopped.set(worker.terminalId, { key, clear: 0 })
  if (kind === 'limit' && offer && (await offer(worker, result, words))) return
  await reportWorkerStop(worker, result)
}

export function _resetStopReportsForTest(): void {
  stopped.clear()
}

/** A worker Termpolis restarted on another account (§9): the stop it showed is carried, so the same
 *  stop drawn again by the resumed session tells the conductor nothing, until the worker took a
 *  turn there (R4): read at work, or `turned` says so. */
export function carryWorkerStop(terminalId: string, summary: string, turned: () => Promise<boolean>): void {
  stopped.set(terminalId, { key: stopKey(summary), clear: 0, carried: turned })
}

/** v1.54.0's report of a stop to the conductor: for a limit, to close the worker and give its task
 *  to another installed agent; for a menu, to answer it. Sent also when the restart offer for a
 *  limit is declined, fails or has no answer in time (§9). */
export async function reportWorkerStop(worker: SwarmWorker, result: AgentStatusResult): Promise<void> {
  const kind = stopKind(result)
  // The conductor sent the task, so it knows which one this terminal has; when the task was
  // assigned to it, say which.
  let task = ''
  try {
    const res = await window.swarmAPI.getTasks()
    const open = res.success && res.data
      ? res.data.find((t) => t.assignedTo === worker.terminalId && t.status !== 'completed' && t.status !== 'failed')
      : undefined
    if (open) task = ` Its task is "${open.title}" (taskId ${open.id}).`
  } catch {}
  // A limit: closed first, since a Claude Code waiting out its limit carries on by itself once it
  // lifts, on a task that is someone else's by then. A menu: answered. Closed, the worker lost what
  // it had done, and a Codex started in its place opened on the same update offer.
  const answer = menuAnswer(result.summary)
  const todo = kind === 'limit'
    ? 'Check its screen with read_output first: if the limit is there, close its terminal, then give its task to another installed agent.'
    : `Check its screen with read_output first: if the menu is there, answer it as STEP 6 says, without submit${answer ? `: ${answer}` : ', with the keys its screen shows for the option to pick'}. ` +
      'Then send its task again with submit=true if it never got it. Give its task to another installed agent only if the menu stays.'
  try {
    await window.swarmAPI.sendMessage(
      'system',
      'conductor',
      'info',
      `${worker.agentName} (${worker.role}, terminal ${worker.terminalId}) is blocked: ${result.summary}.${task} ${todo}`,
    )
  } catch {}
}
