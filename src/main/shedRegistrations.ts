// shedRegistrations.ts -- v1.54.5: what the event-loop governor (loopGovernor.ts) may pause in the files the other
// hotfix lanes own. Lane G registered its own three (updater.scheduledCheck, learningSignals.gitPoll,
// headroomProxy.cooldownRestart); everything here is from GOVERNOR-REGISTRATIONS.md section 3, wired in one place so a
// test can count every pause and resume.
//
// Registered here (pause = optional background work stands down; resume never bursts):
//   watchGates           every lane-M run gate: code re-index, git-dot repaint, workflow file-trigger passes, transcript
//                        tail reads. A gate keeps its dirty flag while paused; on resume the gates restart one
//                        WATCH_RESUME_STAGGER_MS apart and each dirty one runs its handler once.
//   memoryHost.retry     lane C's memory-host start retry waits SHED_RETRY_WAIT_MS more instead of forking now.
//   transcript.locate    the 1.5 s look for a Claude session file that does not exist yet (claudeCodeWatcher).
//   workflowTriggers.git the git-ref checks of the trigger supervisor's tick (never cron or time triggers).
// Registered elsewhere through the same registry:
//   memoryIndexer.tick   memoryIndexer.ts startIndexer (createShedGate: a skipped pass is made up once, 60 s after calm).
// Waits, not registrations (work already running holds at its next boundary until SHED ends, capped):
//   ingestRuntime quiet() (every conversation-ingest slice boundary) and the memory:reflect-session handler.
//
// NOT registered, on purpose: anything on the typing path (PTY pump, ptyCoalescer, echo, terminal:write), the phone's
// keystroke/output/status pumps and the relay keepalive, MCP submit polls and SSE keepalive, a user-visible submit or
// workflow run in progress, per-call timeouts, the quit path, history/ledger durability writes, the crash heartbeat
// (its write is already off the main thread through offMainFiles, and skipping it would change the crash-loop uptime
// report for no gain), compactSelfShard (one IPC message every 30 min; the work runs in the memory host at below-normal
// priority) and lane B's typing trace (an instrument that stops when the loop struggles would hide its own data).
import { registerShed as defaultRegister, type ShedHooks } from './loopGovernor'

/** On SHED end the watch gates restart this far apart (a dirty gate runs one handler as it restarts). */
export const WATCH_RESUME_STAGGER_MS = 250
/** While shed, a memory-host start retry that comes due waits this much longer, then asks again. */
export const SHED_RETRY_WAIT_MS = 15_000

export interface ShedTargets {
  setWatchGatesPaused(paused: boolean, opts?: { staggerMs?: number }): void
  setMemoryRetryGovernor(fn: ((ctx: { attempt: number }) => number) | null): void
  setClaudeLocatePaused(paused: boolean): void
  setTriggerGitChecksPaused(paused: boolean): void
}

/** The names this module registers, in order (the diagnostics block lists the registry's names). */
export const SHED_REGISTRATION_NAMES = ['watchGates', 'memoryHost.retry', 'transcript.locate', 'workflowTriggers.git'] as const

/** Register every pausable above. Returns one function that unregisters them all. Never throws (fails open: a
 *  registration that cannot be made leaves that job running as in 1.54.4). */
export function registerShedTargets(
  t: ShedTargets,
  register: (name: string, hooks: ShedHooks) => () => void = defaultRegister,
): () => void {
  const hooks: Record<(typeof SHED_REGISTRATION_NAMES)[number], ShedHooks> = {
    watchGates: {
      pause: () => t.setWatchGatesPaused(true),
      resume: () => t.setWatchGatesPaused(false, { staggerMs: WATCH_RESUME_STAGGER_MS }),
    },
    'memoryHost.retry': {
      pause: () => t.setMemoryRetryGovernor(() => SHED_RETRY_WAIT_MS),
      // Back to "go": a retry that was put off asks again within SHED_RETRY_WAIT_MS and then starts (no burst: one host).
      resume: () => t.setMemoryRetryGovernor(null),
    },
    'transcript.locate': {
      pause: () => t.setClaudeLocatePaused(true),
      resume: () => t.setClaudeLocatePaused(false),
    },
    'workflowTriggers.git': {
      pause: () => t.setTriggerGitChecksPaused(true),
      resume: () => t.setTriggerGitChecksPaused(false),
    },
  }
  const offs: Array<() => void> = []
  for (const name of SHED_REGISTRATION_NAMES) {
    try { offs.push(register(name, hooks[name])) } catch { /* that job keeps running unpaused */ }
  }
  return () => {
    for (const off of offs) { try { off() } catch { /* best effort */ } }
  }
}
