// File helpers shared by the world store and the source registry: a read or rename that waits out a file another
// program holds for a moment, and a timestamped `.bad` backup that keeps the last few broken copies.
// This runs inside the world host utilityProcess: no Electron imports (worldHostImports.test.ts).
import * as fsp from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Windows reports a file that Defender, the indexer or a sync client has open as one of these. */
const LOCKED_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
/** Attempts in all; the waits between them are 100 ms times the attempt, about a second in all (as renameWithRetry). */
export const LOCKED_ATTEMPTS = 5

export type Sleep = (ms: number) => Promise<void>
export const sleepMs: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Runs `op`, running it again while it fails because the file is held, and throws any other error at once. */
export async function retryLocked<T>(op: () => Promise<T>, sleep: Sleep): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await op()
    } catch (e) {
      if (attempt >= LOCKED_ATTEMPTS || !LOCKED_CODES.has((e as NodeJS.ErrnoException).code ?? '')) throw e
      await sleep(100 * attempt)
    }
  }
}

/** How many broken copies of one file are kept. */
export const BAD_KEEP = 5
/** `<stamp>` as toISOString writes it with ':' and '.' made '-', plus `-<n>` when two land in the same millisecond. */
const STAMP = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z(-\d+)?$/

export interface BackupDeps {
  now: () => number
  rename?: typeof fsp.rename
}

/** The part of a backup's name between `<file>.` and `.bad`: '' for the old fixed name, else a stamp; null otherwise. */
const backupStamp = (base: string, name: string): string | null => {
  if (name === `${base}.bad`) return ''
  if (!name.startsWith(`${base}.`) || !name.endsWith('.bad')) return null
  const mid = name.slice(base.length + 1, -'.bad'.length)
  return STAMP.test(mid) ? mid : null
}

/**
 * Moves a broken `file` aside to `<file>.<stamp>.bad` so an earlier backup is never overwritten, then removes all but
 * the BAD_KEEP newest backups of that file (an old fixed-name `<file>.bad` counts as the oldest). Best effort: a
 * failure leaves the file where it was, and the caller reads it as absent either way.
 */
export async function moveAside(file: string, deps: BackupDeps): Promise<void> {
  const rename = deps.rename ?? fsp.rename
  const stamp = new Date(deps.now()).toISOString().replace(/[:.]/g, '-')
  try {
    let target = `${file}.${stamp}.bad`
    for (let n = 1; await exists(target); n++) target = `${file}.${stamp}-${n}.bad`
    await rename(file, target)
  } catch {
    return
  }
  await pruneBackups(file)
}

const exists = (path: string): Promise<boolean> => fsp.stat(path).then(() => true, () => false)

async function pruneBackups(file: string): Promise<void> {
  const base = basename(file)
  const folder = dirname(file)
  let names: string[]
  try {
    names = await fsp.readdir(folder)
  } catch {
    return
  }
  const ours = names
    .map((name) => ({ name, stamp: backupStamp(base, name) }))
    .filter((b): b is { name: string; stamp: string } => b.stamp !== null)
    // Names are unique, so no two stamps are equal.
    .sort((a, b) => (a.stamp < b.stamp ? -1 : 1))
  for (const old of ours.slice(0, Math.max(0, ours.length - BAD_KEEP))) {
    await fsp.rm(join(folder, old.name), { force: true }).catch(() => undefined)
  }
}
