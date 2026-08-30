/**
 * Launch-sequence timing.
 *
 * The agent launch flow used to be a chain of blind sleeps: wait 4,000 ms for the shell, type a
 * no-op newline to flush partial init, wait another 500 ms, then type the agent command. That is
 * 4.5 seconds of doing nothing, paid on every launch whether the shell was ready in 300 ms or not —
 * measured as roughly half of the ~9 s it took Claude Code to start responding.
 *
 * This module replaces the guess with the condition it was standing in for, and re-bases the timers
 * that were tuned against it.
 */

/**
 * When the agent command used to be typed, measured from the launch click: `setTimeout(4000)` for
 * shell init, then a nested `setTimeout(500)` after the no-op newline.
 *
 * Every downstream timer in the launch flow — the trust-prompt confirmation, the launch spinner —
 * was tuned against a command that always landed at this moment. They are re-expressed relative to
 * the command via `afterCommandDelay`, so typing it earlier moves them with it instead of silently
 * widening the gap.
 */
export const LEGACY_COMMAND_AT_MS = 4500

/**
 * Convert a delay that used to be measured from the launch click into the equivalent delay measured
 * from the moment the command is typed, preserving the gap it always had.
 *
 * This is the whole safety story for the trust-prompt Enter. That Enter is blind — it is sent on a
 * timer whether or not a prompt is actually showing — and it was tuned to land 4.5 s after the
 * command. Speeding up the launch without this would stretch that to as much as 8.5 s, opening a
 * much larger window for a stray Enter to land somewhere it was never meant to (Claude may already
 * be mid-response by then). Re-basing keeps the command→Enter relationship byte-identical to the
 * behaviour that is known to work, so a faster launch cannot disturb auto-trust.
 */
export function afterCommandDelay(fromLaunchMs: number): number {
  return Math.max(0, fromLaunchMs - LEGACY_COMMAND_AT_MS)
}

/**
 * The blind shell wait this replaces, now serving as the ceiling. Kept at its original value so the
 * worst case is byte-identical to the behaviour it supersedes.
 */
export const SHELL_READY_CEILING_MS = 4000

/**
 * How long the shell must stay silent before we call it idle. Long enough to bridge the gaps inside
 * a shell's own start-up chatter, short enough that it is noise next to the seconds it replaces.
 */
export const SHELL_QUIET_MS = 150

export interface ShellReadyOpts {
  /** Only output from this terminal counts — a busy neighbour must not release this launch. */
  terminalId: string
  /** Subscribe to PTY output; returns an unsubscribe. Usually `window.termpolis.onTerminalData`. */
  subscribe: (cb: (id: string, data: string) => void) => () => void
  /** How long the shell must stay silent after speaking before we call it idle at a prompt. */
  quietMs: number
  /** Hard upper bound — the old blind wait, kept so this can only ever fire earlier, never later. */
  ceilingMs: number
}

/**
 * Resolve when the shell looks ready for input: it has emitted something, and has then been quiet
 * for `quietMs`. Resolves `'ceiling'` instead if that never happens within `ceilingMs`.
 *
 * This is a heuristic, deliberately. There is no shell-integration marker anywhere in this app — no
 * OSC 633 sequence is emitted or parsed — so nothing can give a deterministic "the prompt is now
 * showing" answer. The ceiling is what makes the heuristic safe to depend on: the worst case is
 * exactly the blind wait this replaced, so a shell whose output pattern we misjudge loses the
 * speed-up and nothing else. It never resolves LATE, only early.
 *
 * Fail-open in the same spirit: if there is nothing to subscribe to, degrade to the plain ceiling
 * wait rather than letting a launch fail over an optimisation.
 */
export function waitForShellReady(opts: ShellReadyOpts): Promise<'quiet' | 'ceiling'> {
  const { terminalId, subscribe, quietMs, ceilingMs } = opts
  return new Promise((resolve) => {
    let settled = false
    let quietTimer: ReturnType<typeof setTimeout> | null = null
    let unsubscribe: (() => void) | null = null

    const settle = (how: 'quiet' | 'ceiling'): void => {
      /* v8 ignore next -- unreachable by construction, kept as the invariant it asserts: whichever
         path settles first clears the OTHER timer and unsubscribes, and the listener refuses to
         re-arm once settled, so there is no second caller. Removing the guard would make that a
         property of three separate call sites instead of one. */
      if (settled) return
      settled = true
      if (quietTimer !== null) clearTimeout(quietTimer)
      clearTimeout(ceilingTimer)
      if (unsubscribe) { try { unsubscribe() } catch { /* nothing left to clean up */ } }
      resolve(how)
    }

    const ceilingTimer = setTimeout(() => settle('ceiling'), ceilingMs)

    try {
      unsubscribe = subscribe((id, _data) => {
        if (settled || id !== terminalId) return
        // Restart the window on every chunk: a shell mid-init emits in bursts, and the gap between
        // bursts is exactly what distinguishes "still starting" from "waiting at a prompt".
        if (quietTimer !== null) clearTimeout(quietTimer)
        quietTimer = setTimeout(() => settle('quiet'), quietMs)
      })
    } catch {
      // No output stream available (no IPC bridge, teardown mid-launch) — the ceiling still holds,
      // which is precisely the behaviour this replaced.
    }
  })
}
