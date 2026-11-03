// A counting wrapper around the REAL synchronous fs functions, for the counter-based proof that a
// hot path makes none of them ("0 readdirSync / statSync on the hot path").
//
// Two things make this work, both found by trying it:
//   1. vi.mock('fs') cannot do it: a module that does `import * as fs from 'fs'` keeps the real
//      builtin. The real functions are patched in place instead...
//   2. ...and the patch only reaches such a module after syncBuiltinESMExports(), which refreshes
//      the ES-module view of a builtin from its CommonJS exports. Without that call the patched
//      functions are counted 0 times, and a "0 sync calls" assertion passes for the wrong reason.
//
// Only calls whose first argument is a path under one of `under` are counted, so the test runner's
// own reads (it loads modules lazily) can never make a zero-count assertion flaky. Install the
// counter around the measured call only, and import every module under test BEFORE installing it.

import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { resolve } from 'node:path'

/** Every sync call that reads, lists or opens a path: the ones that block the thread for as long as the disk (and Defender) take. */
export const SYNC_FS_NAMES = [
  'statSync',
  'lstatSync',
  'readdirSync',
  'readFileSync',
  'openSync',
  'existsSync',
  'realpathSync',
  'accessSync',
  'opendirSync',
  'readlinkSync',
] as const

export interface SyncFsCounter {
  /** Calls per function name, for paths under `under`. */
  counts: Record<string, number>
  /** All of them. */
  total(): number
  /** Put the real functions back. Always call it (afterEach / finally). */
  restore(): void
}

const norm = (p: string): string => resolve(p).replace(/\\/g, '/').toLowerCase()

export function countSyncFs(under: string[]): SyncFsCounter {
  const roots = under.map(norm)
  const counts: Record<string, number> = {}
  const originals = new Map<string, unknown>()
  const target = fs as unknown as Record<string, unknown>

  const counted = (name: string, orig: (...a: unknown[]) => unknown) =>
    function (this: unknown, ...args: unknown[]) {
      const first = args[0]
      if (typeof first === 'string' && roots.some((r) => norm(first).startsWith(r))) counts[name] = (counts[name] ?? 0) + 1
      return orig.apply(this, args)
    }

  for (const name of SYNC_FS_NAMES) {
    const orig = target[name] as ((...a: unknown[]) => unknown) | undefined
    if (typeof orig !== 'function') continue
    originals.set(name, orig)
    const wrapped = counted(name, orig) as unknown as Record<string, unknown>
    // realpathSync.native is a separate function that a caller may use instead.
    const native = (orig as unknown as { native?: (...a: unknown[]) => unknown }).native
    if (name === 'realpathSync' && typeof native === 'function') wrapped.native = counted('realpathSync.native', native)
    target[name] = wrapped
  }
  syncBuiltinESMExports()

  return {
    counts,
    total: () => Object.values(counts).reduce((a, b) => a + b, 0),
    restore: () => {
      for (const [name, orig] of originals) target[name] = orig
      syncBuiltinESMExports()
    },
  }
}
