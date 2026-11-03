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
}

export const MAIN_THREAD_CODE = /[\\/]src[\\/]main[\\/]/

const SPAWNERS = ['spawn', 'exec', 'execFile', 'fork', 'execSync', 'spawnSync', 'execFileSync'] as const
const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom')

let armed = false
let counts: Counts = { sync: {}, spawn: {} }
let attribution: RegExp = MAIN_THREAD_CODE
let installed: Array<() => void> = []

/** The call stack of whoever called a patched function, without the patch's own frames. */
function callerStack(): string {
  const prev = Error.stackTraceLimit
  Error.stackTraceLimit = 40
  const stack = new Error().stack ?? ''
  Error.stackTraceLimit = prev
  return stack
}

function bump(kind: 'sync' | 'spawn', name: string): void {
  if (!armed) return
  if (!attribution.test(callerStack())) return
  counts[kind][name] = (counts[kind][name] ?? 0) + 1
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
  installed.push(() => { target[name] = original })
}

/** Patch fs and child_process. Idempotent; undo with uninstall(). Runs when this file is imported. */
export function install(): void {
  if (installed.length > 0) return
  const f = fs as unknown as Record<string, unknown>
  for (const name of Object.keys(f)) {
    if (name.endsWith('Sync') && name.length > 4) patch(f, name, 'sync')
  }
  const c = cp as unknown as Record<string, unknown>
  for (const name of SPAWNERS) patch(c, name, 'spawn')
  syncBuiltinESMExports()
}

export function uninstall(): void {
  for (const undo of installed.reverse()) undo()
  installed = []
  armed = false
  syncBuiltinESMExports()
}

/** Start counting from zero. */
export function arm(): void {
  counts = { sync: {}, spawn: {} }
  armed = true
}

/** Stop counting and return what was counted. */
export function disarm(): Counts {
  armed = false
  return snapshot()
}

export function snapshot(): Counts {
  return { sync: { ...counts.sync }, spawn: { ...counts.spawn } }
}

/** Which stacks count (default: frames in src/main). A control test narrows it to itself. */
export function setAttribution(pattern: RegExp | null): void {
  attribution = pattern ?? MAIN_THREAD_CODE
}

export function total(c: Counts = counts): number {
  return Object.values(c.sync).reduce((a, b) => a + b, 0) + Object.values(c.spawn).reduce((a, b) => a + b, 0)
}

/** What a hot path did that it must not: `existsSync x3, execFile x1`; '' when it did nothing. */
export function describeCounts(c: Counts = counts): string {
  return [...Object.entries(c.sync), ...Object.entries(c.spawn)].map(([k, v]) => `${k} x${v}`).join(', ')
}

/** Count a process creation that does not go through child_process (a fake node-pty). */
export function countSpawn(name: string): void {
  if (armed) counts.spawn[name] = (counts.spawn[name] ?? 0) + 1
}

install()
