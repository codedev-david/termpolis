// File helpers shared by the world store, the source registry and the annotation store: a read or rename that waits
// out a file another program holds for a moment, and numbered `.bad` backups that keep the last few broken copies.
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

/** How many numbered broken copies of one file are kept (an old fixed-name `<file>.bad` is kept besides, never pruned). */
export const BAD_KEEP = 5
/** Names tried past the next free number before giving up (other processes taking numbers at the same moment). */
export const CLAIM_TRIES = 20
/** `<stamp>-<n>`: the stamp as toISOString writes it with ':' and '.' made '-', and n the backup's number for that file. */
const NUMBERED = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-(\d+)$/

export interface BackupDeps {
  now: () => number
  rename?: typeof fsp.rename
  /** Writes a copy's bytes (copyAside); fs writeFile when not given. */
  writeFile?: (file: string, data: Buffer) => Promise<void>
  /** Waits between tries on a held file; a timer when not given. */
  sleep?: Sleep
}

interface Backup { name: string; n: number }

const quiet = (): undefined => undefined
const none = (): null => null

/** The numbered backups of `file` in its folder, oldest (lowest number) first; [] when the folder cannot be listed. */
async function backupsOf(file: string): Promise<Backup[]> {
  const base = basename(file)
  const names = await fsp.readdir(dirname(file)).catch((): string[] => [])
  const out: Backup[] = []
  for (const name of names) {
    if (!name.startsWith(`${base}.`) || !name.endsWith('.bad')) continue
    const m = NUMBERED.exec(name.slice(base.length + 1, -'.bad'.length))
    if (m) out.push({ name, n: Number(m[1]) })
  }
  return out.sort((a, b) => a.n - b.n)
}

/**
 * Claims the next backup name of `file`, `<file>.<stamp>-<n>.bad` with n one past the highest number there, by creating
 * it empty with `wx`, so two processes never get the same name: the one that finds it taken tries the next number.
 * Resolves with the name, or null when none could be made. The number, not the clock, orders the backups, so a clock
 * that goes back never makes a new backup look old.
 */
async function claimBackup(file: string, deps: BackupDeps): Promise<string | null> {
  const have = await backupsOf(file)
  const stamp = new Date(deps.now()).toISOString().replace(/[:.]/g, '-')
  let n = have.length > 0 ? have[have.length - 1].n + 1 : 1
  for (let tries = 0; tries < CLAIM_TRIES; tries++, n++) {
    const target = `${file}.${stamp}-${n}.bad`
    try {
      await (await fsp.open(target, 'wx')).close()
      return target
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return null
    }
  }
  return null
}

/** Removes the oldest numbered backups of `file` until BAD_KEEP are left, never `made` (the one just written). */
async function pruneBackups(file: string, made: string): Promise<void> {
  const others = (await backupsOf(file)).filter((b) => b.name !== basename(made))
  for (const old of others.slice(0, Math.max(0, others.length - (BAD_KEEP - 1)))) {
    await fsp.rm(join(dirname(file), old.name), { force: true }).catch(quiet)
  }
}

/**
 * Moves a broken `file` aside to its next numbered backup (an earlier backup is never overwritten), the rename tried
 * again while the file is held, then prunes. Resolves true when the file was moved; false when it was not (it is left
 * where it was, and no empty backup is left behind), so a caller can refuse to write over it.
 */
export async function moveAside(file: string, deps: BackupDeps): Promise<boolean> {
  const rename = deps.rename ?? fsp.rename
  const target = await claimBackup(file, deps)
  if (target === null) return false
  try {
    // The claimed name is ours and empty: the rename replaces it.
    await retryLocked(() => rename(file, target), deps.sleep ?? sleepMs)
  } catch {
    await fsp.rm(target, { force: true }).catch(quiet)
    return false
  }
  await pruneBackups(file, target)
  return true
}

/**
 * Copies `file`, byte for byte and left in place, to its next numbered backup, unless a backup of it (the old fixed
 * name included) already holds exactly these bytes, so loading the same file again never pushes older backups out.
 * Resolves true when a backup holds the file's bytes (made now or already there), false when none could be made.
 */
export async function copyAside(file: string, deps: BackupDeps): Promise<boolean> {
  const write = deps.writeFile ?? fsp.writeFile
  const bytes = await retryLocked(() => fsp.readFile(file), deps.sleep ?? sleepMs).catch(none)
  if (bytes === null) return false
  const folder = dirname(file)
  for (const name of [`${basename(file)}.bad`, ...(await backupsOf(file)).map((b) => b.name)]) {
    const held = await fsp.readFile(join(folder, name)).catch(none)
    if (held !== null && held.equals(bytes)) return true
  }
  const target = await claimBackup(file, deps)
  if (target === null) return false
  try {
    await write(target, bytes)
  } catch {
    await fsp.rm(target, { force: true }).catch(quiet)
    return false
  }
  await pruneBackups(file, target)
  return true
}
