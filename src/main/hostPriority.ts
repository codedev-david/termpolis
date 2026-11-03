// hostPriority.ts: a background host lowers ITS OWN scheduling priority (1.54.5 hotfix).
//
// DECIDED (David, 2026-11-03): nothing in Termpolis ever sets ANOTHER process's priority, and main never
// changes its own (main is the thread that echoes keystrokes, and children inherit it). Instead each background
// host lowers itself as the first thing it does when it starts as a forked utility process: the memory host,
// the proc host, the Headroom proxy entry and the remote bridge entry. On Windows a child process inherits a
// below-normal parent's priority class, so the git commands the proc host starts run below normal as well,
// which is the point: they are background reads that must never compete with a typing echo.
//
// Always the calling process (pid 0), never a number that came from somewhere else. Best effort: a refusal is
// swallowed. Kill switch: TERMPOLIS_NO_HOST_PRIORITY=1 restores today's behaviour.
//
// The os module is a parameter because vi.mock cannot replace a Node builtin (it is a silent no-op), so the
// tests count calls through a fake. The default is the real module.
import * as nodeOs from 'os'

export interface HostPriorityOs {
  setPriority(pid: number, priority: number): void
  constants: { priority?: { PRIORITY_BELOW_NORMAL?: number } }
}

export interface HostPriorityDeps {
  os?: HostPriorityOs
  env?: NodeJS.ProcessEnv
}

export type HostPriorityResult = 'lowered' | 'disabled' | 'failed' | 'unsupported'

let testDeps: HostPriorityDeps | null = null

/** Test seam: what lowerHostPriority() uses when a host calls it with no arguments, which is how every host does. */
export function __setHostPriorityDepsForTests(deps: HostPriorityDeps | null): void {
  testDeps = deps
}

/** Lower this process to below-normal priority, once per call. Never throws. */
export function lowerHostPriority(deps?: HostPriorityDeps): HostPriorityResult {
  const d = deps ?? testDeps ?? {}
  const off = (d.env ?? process.env).TERMPOLIS_NO_HOST_PRIORITY
  if (off === '1' || off === 'true') return 'disabled'
  try {
    const os = d.os ?? nodeOs
    const level = os.constants?.priority?.PRIORITY_BELOW_NORMAL
    if (typeof level !== 'number') return 'unsupported'
    os.setPriority(0, level)
    return 'lowered'
  } catch {
    return 'failed'
  }
}
