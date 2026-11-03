// COUNTERS for what the Electron main thread must not do on a hot path (AC1): create a process, or
// make a synchronous file call. A test installs them once, arms them around the code under test and
// reads what was counted. Nothing here measures time.
//
// How it counts. The real `fs` and `child_process` modules are patched in place (every `*Sync`
// function of fs; spawn, exec, execFile, fork, execSync, spawnSync, execFileSync of child_process),
// so a call is seen however the code under test reaches it: `import { existsSync } from 'fs'`,
// `import * as fs`, `require('fs').writeFileSync` (aiSecurity does that) or a lazy `require` inside a
// function. vi.mock('fs') sees only the first two. The wrappers still call the real function.
//
// What counts. A call is attributed by its stack: it counts only when a frame of it lies in
// `src/main` (the code that runs on the main thread). The test runner's own file reads, the test's
// own set-up and Node's loader are not "the hot path" and are never counted. A test can swap the
// pattern (setAttribution) to prove with a control that the counters do see a call.
//
// Spawns that do not go through child_process (a fake node-pty, a fake utility process) are counted
// by the fake itself with countSpawn().
//
// IMPORT THIS FILE FIRST. Importing it installs the patch, and a module that was loaded earlier keeps
// the functions it got when it loaded (an externalised builtin is copied into the importing module),
// so it would never be seen. Every import after this one is.

import fs from 'fs'
import cp from 'child_process'
import { syncBuiltinESMExports } from 'module'

export interface Counts {
  /** `*Sync` calls, by function name. */
  sync: Record<string, number>
  /** Process creations, by function name (`pty.spawn` and `utilityProcess.fork` from the fakes). */
  spawn: Record<string, number>
  /** Where each counted call came from: `fn(arg) <- src/main/file.ts:line`, the innermost src/main frame of its stack.
   *  A failing assertion prints these (describeSites), so it names the line instead of only the function. */
  sites?: Record<string, number>
}

export const MAIN_THREAD_CODE = /[\\/]src[\\/]main[\\/]/

const SPAWNERS = ['spawn', 'exec', 'execFile', 'fork', 'execSync', 'spawnSync', 'execFileSync'] as const
const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom')

// One state for the whole worker, on globalThis: vi.resetModules() makes a new copy of this module, and the
// copy a vi.mock factory imports must count into the same counters as the copy the test file imported.
interface State { armed: boolean; counts: Counts; attribution: RegExp; installed: Array<() => void> }
/** A stack frame inside src/main: `at fn (C:\x\src\main\file.ts:12:3)` or `at C:\x\src\main\file.ts:12:3`; group 1 = path:line. */
const SITE_FRAME = /\(?((?:[A-Za-z]:)?[^()\s]*[\\/]src[\\/]main[\\/][^()\s]*?:\d+):\d+\)?\s*$/
const KEY = Symbol.for('termpolis.mainThreadCounters')
const g = globalThis as unknown as Record<symbol, State | undefined>
const S: State = (g[KEY] ??= { armed: false, counts: { sync: {}, spawn: {} }, attribution: MAIN_THREAD_CODE, installed: [] })

/** The call stack of whoever called a patched function, without the patch's own frames. */
function callerStack(): string {
  const prev = Error.stackTraceLimit
  Error.stackTraceLimit = 40
  const stack = new Error().stack ?? ''
  Error.stackTraceLimit = prev
  return stack
}

function bump(kind: 'sync' | 'spawn', name: string): void {
  if (!S.armed) return
  const stack = callerStack()
  if (!S.attribution.test(stack)) return
  S.counts[kind][name] = (S.counts[kind][name] ?? 0) + 1
  // The innermost frame inside src/main: the line that made the call (or the one that handed it a callback).
  for (const frame of stack.split('\n')) {
    const m = SITE_FRAME.exec(frame)
    if (!m) continue
    const where = `${name} <- ${m[1].replace(/^.*[\\/]src[\\/]main[\\/]/, 'src/main/').replace(/\\/g, '/')}`
    const sites = (S.counts.sites ??= {})
    sites[where] = (sites[where] ?? 0) + 1
    break
  }
}

function patch(target: Record<string, unknown>, name: string, kind: 'sync' | 'spawn'): void {
  const original = target[name]
  if (typeof original !== 'function') return
  const wrapper = function (this: unknown, ...args: unknown[]) {
    bump(kind, name)
    return (original as (...a: unknown[]) => unknown).apply(this, args)
  }
  const custom = (original as unknown as Record<symbol, unknown>)[PROMISIFY_CUSTOM]
  if (typeof custom === 'function') {
    ;(wrapper as unknown as Record<symbol, unknown>)[PROMISIFY_CUSTOM] = function (this: unknown, ...args: unknown[]) {
      bump(kind, name)
      return (custom as (...a: unknown[]) => unknown).apply(this, args)
    }
  }
  Object.defineProperty(wrapper, 'name', { value: name })
  target[name] = wrapper
  S.installed.push(() => { target[name] = original })
}

/** Patch fs and child_process. Idempotent; undo with uninstall(). Runs when this file is imported. */
export function install(): void {
  if (S.installed.length > 0) return
  const f = fs as unknown as Record<string, unknown>
  for (const name of Object.keys(f)) {
    if (name.endsWith('Sync') && name.length > 4) patch(f, name, 'sync')
  }
  const c = cp as unknown as Record<string, unknown>
  for (const name of SPAWNERS) patch(c, name, 'spawn')
  syncBuiltinESMExports()
}

export function uninstall(): void {
  for (const undo of S.installed.reverse()) undo()
  S.installed = []
  S.armed = false
  syncBuiltinESMExports()
}

/** Start counting from zero. */
export function arm(): void {
  S.counts = { sync: {}, spawn: {} }
  S.armed = true
}

/** Stop counting and return what was counted. */
export function disarm(): Counts {
  S.armed = false
  return snapshot()
}

export function snapshot(): Counts {
  return { sync: { ...S.counts.sync }, spawn: { ...S.counts.spawn }, sites: { ...(S.counts.sites ?? {}) } }
}

/** Which stacks count (default: frames in src/main). A control test narrows it to itself. */
export function setAttribution(pattern: RegExp | null): void {
  S.attribution = pattern ?? MAIN_THREAD_CODE
}

export function total(c: Counts = S.counts): number {
  return Object.values(c.sync).reduce((a, b) => a + b, 0) + Object.values(c.spawn).reduce((a, b) => a + b, 0)
}

/** What a hot path did that it must not: `existsSync x3, execFile x1`; '' when it did nothing. */
export function describeCounts(c: Counts = S.counts): string {
  return [...Object.entries(c.sync), ...Object.entries(c.spawn)].map(([k, v]) => `${k} x${v}`).join(', ')
}

/** The lines the counted calls came from, most frequent first: `existsSync <- src/main/foo.ts:42 x3`. */
export function describeSites(c: Counts = S.counts): string {
  return Object.entries(c.sites ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} x${v}`).join('; ')
}

/** Count a process creation that does not go through child_process (a fake node-pty). */
export function countSpawn(name: string): void {
  if (S.armed) S.counts.spawn[name] = (S.counts.spawn[name] ?? 0) + 1
}

install()
