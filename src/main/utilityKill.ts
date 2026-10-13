/** The part of Electron's UtilityProcess that stopping one needs. */
export interface KillableUtility {
  readonly pid: number | undefined
  kill(): boolean
  once(event: 'spawn', listener: () => void): unknown
}

/**
 * Stop a utilityProcess, including one that has not started yet.
 *
 * Until its 'spawn' event a utilityProcess has no pid, and kill() does nothing and returns false.
 * A stop that lands in that window, as the app's quit can, would leave the child running with no
 * owner, holding the app's stdout and stderr open. So a kill that comes too early waits for the
 * spawn. A child that never spawns has nothing to kill, and the listener just goes with it.
 */
export function killUtility(child: KillableUtility): void {
  try {
    if (child.pid === undefined) child.once('spawn', () => { try { child.kill() } catch { /* already gone */ } })
    else child.kill()
  } catch { /* already gone */ }
}
