// hostPriority.ts: a background host lowers ITS OWN scheduling priority (1.54.5 hotfix).
//
// DECIDED (David, 2026-11-03): nothing in Termpolis ever sets ANOTHER process's priority, and main never
// changes its own (main is the thread that echoes keystrokes, and children inherit it). Instead each background
// host lowers itself as the first thing it does when it starts as a forked utility process: the memory host and
// the proc host. On Windows a child process inherits a below-normal parent's priority class, so the git commands
// the proc host starts run below normal as well, which is the point: they are background reads that must never
// compete with a typing echo.
//
// NOT the Headroom proxy or the remote bridge (EDR-2, fixer round 1): the proxy carries every model reply an agent
// streams and the bridge carries what is typed on the phone, so both are what someone is waiting on. And the one
// interactive program the proc host runs, shellAlone's console-list helper, puts itself back to normal
// (src/mcp-adapter/termpolis-console-list.cjs), so a submit to an agent does not wait on a below-normal start.
//
// Always the calling process (pid 0), never a number that came from somewhere else. Best effort: a refusal is
// swallowed. Kill switch: TERMPOLIS_NO_HOST_PRIORITY=1 (or true) restores today's behaviour for every host; a
// comma list of host names (memory, proc) restores it for those alone.
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
  /** The calling host's name ('memory', 'proc'), which TERMPOLIS_NO_HOST_PRIORITY can list to leave it alone. */
  host?: string
}

export type HostPriorityResult = 'lowered' | 'disabled' | 'failed' | 'unsupported'

let testDeps: HostPriorityDeps | null = null

/** Test seam: what lowerHostPriority() uses when a host calls it with no arguments, which is how every host does. */
export function __setHostPriorityDepsForTests(deps: HostPriorityDeps | null): void {
  testDeps = deps
}

/** Lower this process to below-normal priority, once per call. Never throws. What the caller passes is laid over
 *  the test seam's deps, so a host that names itself still gets the seam's fake os in a test. */
export function lowerHostPriority(deps?: HostPriorityDeps): HostPriorityResult {
  const d: HostPriorityDeps = { ...testDeps, ...deps }
  const off = (d.env ?? process.env).TERMPOLIS_NO_HOST_PRIORITY
  if (off === '1' || off === 'true') return 'disabled'
  if (off && d.host && off.split(',').map((s) => s.trim()).includes(d.host)) return 'disabled'
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
