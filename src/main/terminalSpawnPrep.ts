// What opening a terminal needs from the file system, looked up on the thread pool instead of on the main thread.
//
// spawnTerminal (terminalManager.ts) used to ask for it synchronously: existsSync on the working folder, and
// existsSync (+ mkdirSync + writeFileSync the first time) on the shell's integration file. It runs from a
// person's click and from an agent's create_terminal call, on the thread that echoes every keystroke, where
// one such call has been measured at up to 1.5 s on a busy Windows laptop. A caller asks prepareSpawn() first and
// hands the answer to spawnTerminal, which then makes no file call at all (the click, create_terminal and workflow
// paths all do). A caller that does not (a test; a spawner wired without a prepare) gets the synchronous lookups.

import { promises as fsp } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { app } from 'electron'
import { logToApp } from './appLog'
import { detectShellKind, integrationDisabled, integrationFile, integrationFileSet, INTEGRATION_FILES, type IntegrationFile } from './shellIntegration'

export interface SpawnPrep {
  /** The folder the shell starts in: the one asked for when it exists, else the home folder. */
  cwd: string
  /** The shell's integration file (PowerShell's script, cmd's doskey macros, zsh's .zshenv, fish's file), or null for a shell that has none
   *  or where it could not be written. */
  integrationScript: string | null
}

/** Where each integration file was last put on disk this run, by file name (absent: not yet). Shared with
 *  terminalManager's synchronous fallback, so the two never write one twice. */
export const integrationScriptState: Record<string, string> = {}

export const INTEGRATION_SCRIPT_NAME = INTEGRATION_FILES.powershell.name

let tempCount = 0
/** A temp name beside `path`, its own for every write: concurrent writers (two terminals opening at once) never share one. */
export const wholeFileTempName = (path: string): string =>
  `${path}.${process.pid}.${++tempCount}.${Math.random().toString(36).slice(2, 8)}.tmp`

/**
 * Windows refuses a rename with one of these while another process has either file open: a shell reading the old file
 * as it starts, or a scanner reading the temp file just written (the classic case, on a fresh .ps1). It usually lets
 * go within milliseconds, so the rename is tried again (RENAME_RETRIES times, RENAME_RETRY_MS apart, as graceful-fs
 * does). Still refused: the old file is whole, so it stays (an older copy beats no integration and an error in spawn).
 * With no old file, a second temp file is written and its rename tried once, and only then is the content written
 * straight to the file, under the integration lock below, so no spawn can read it half written.
 */
export const RENAME_REFUSED = new Set(['EPERM', 'EBUSY', 'EACCES'])
export const RENAME_RETRIES = 4
export const RENAME_RETRY_MS = 50

export const isRenameRefused = (e: unknown): boolean => RENAME_REFUSED.has(String((e as NodeJS.ErrnoException)?.code))

/** 'written': the file now holds the content. 'kept': every rename was refused and the old file stayed, so the
 *  content is not on disk yet and a later spawn should try again. */
export type WholeFileResult = 'written' | 'kept'

export interface WholeFileIo {
  writeFile: (path: string, content: string) => unknown
  rename: (from: string, to: string) => unknown
  rm: (path: string) => unknown
  exists: (path: string) => boolean | Promise<boolean>
  sleep: (ms: number) => unknown
}

const realIo: WholeFileIo = {
  writeFile: (p, c) => fsp.writeFile(p, c, 'utf8'),
  rename: (from, to) => fsp.rename(from, to),
  rm: (p) => fsp.rm(p, { force: true }),
  exists: (p) => fsp.access(p).then(() => true, () => false),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/**
 * One try through a fresh temp file beside `path`: true once it is renamed into place, false when every rename (1 +
 * `retries`) was refused. A failure writing the temp file is that failure, EPERM included, and is thrown: it is not a
 * refused rename. The temp file is removed unless it was renamed; when even that is refused (the scanner still holds
 * it) it is left for sweepStaleIntegrationTemps, and the failure that matters is the one reported.
 */
async function throughFreshTemp(path: string, content: string, retries: number, io: WholeFileIo): Promise<boolean> {
  const tmp = wholeFileTempName(path)
  let renamed = false
  try {
    await io.writeFile(tmp, content) // inside the try: a temp file cut short (a full disk) is removed below too
    for (let attempt = 0; ; attempt++) {
      try {
        await io.rename(tmp, path)
        renamed = true
        return true
      } catch (e) {
        if (!isRenameRefused(e)) throw e
        if (attempt >= retries) return false
        await io.sleep(RENAME_RETRY_MS)
      }
    }
  } finally {
    if (!renamed) {
      try { await io.rm(tmp) } catch { /* the temp file is still held: it is left, and the outcome above stands */ }
    }
  }
}

/**
 * Write `content` to `path` whole: to a temp file in the same folder, then renamed over it, so a shell starting while
 * another terminal rewrites the file reads the old one or the new one, never half of one. A refused rename is tried
 * again; still refused, it keeps a file that is there ('kept'). With none there (a fresh install) a second fresh temp
 * file is tried, and then the content is written straight to the file ('written'), so the first terminal still gets
 * its integration. That direct write is only safe because the caller holds the file's integration lock: no other
 * spawn reads or writes it until this resolves. Any other failure rejects with that failure.
 */
export async function writeWholeFile(path: string, content: string, io: Partial<WholeFileIo> = {}): Promise<WholeFileResult> {
  const all: WholeFileIo = { ...realIo, ...io }
  if (await throughFreshTemp(path, content, RENAME_RETRIES, all)) return 'written'
  if (await all.exists(path)) return 'kept'
  if (await throughFreshTemp(path, content, 0, all)) return 'written' // the first temp file may be the one a scanner holds
  await all.writeFile(path, content) // first run, nothing to keep: a direct write beats a terminal with no integration
  return 'written'
}

const refusalsLogged = new Set<string>()
/** Tell the app log, once per file per run, that a refused rename kept an old integration file. */
export function logRenameRefusal(path: string, log: (line: string) => void = (line) => logToApp('warn', 'main', [line])): void {
  if (refusalsLogged.has(path)) return
  refusalsLogged.add(path)
  log(`[shell integration] ${path} could not be replaced (the rename was refused ${RENAME_RETRIES + 1} times; another program has it open). The old copy stays, and the next terminal tries again.`)
}

/**
 * One prepare of each integration file at a time. Every Termpolis terminal opens from this one main process (a second
 * instance is turned away by the single-instance lock), so a promise chain per file is the whole lock. Its "is it
 * there?" check and its writes run under it: a spawn that arrives while a write is in flight waits for that write, and
 * finds the file present only once the write has finished and been recorded. The synchronous fallback
 * (ensureIntegrationScript in terminalManager.ts) cannot wait: it asks integrationFileBusy() and, while the lock is
 * held, opens its terminal without integration rather than read or write a file mid-write.
 *
 * Only the WAIT is time-limited, never the job. A spawn queued behind another prepare of the same file for
 * INTEGRATION_WAIT_MS gives up: it answers null (the terminal opens without integration) and its job is dropped. The
 * lock is not released then, because the write it waited behind may still land, and nothing may write beside it. While
 * the job running has outlasted a waiter like that, a spawn that arrives answers null at once rather than wait the whole
 * limit again; the next turn of the queue (the stuck job has settled) clears that.
 */
export interface IntegrationQueue {
  /** The last job queued for this file: the next one starts when it settles. */
  tail: Promise<unknown>
  /** A waiter gave up behind the job running now: a spawn that arrives answers null at once, until the next turn. */
  stalled: boolean
  /** The path the job just ahead recorded (written, or checked present): a job starting right behind it takes its word. */
  recorded?: string
}
const integrationLocks = new Map<string, IntegrationQueue>()

/** True while a prepare holds this integration file (by IntegrationFile name): its write may be on the thread pool now. */
export const integrationFileBusy = (name: string): boolean => integrationLocks.has(name)

/**
 * How long a spawn waits behind another prepare of the same integration file before it opens without integration.
 * A prepare takes milliseconds; a slow one on a busy laptop with a scanner about 2 s (one file call has been measured at
 * up to 1.5 s, and the rename retries pause 200 ms at most). 4 s lets that finish, while the stall this is for, a cloud
 * scan of a brand-new .ps1 holding the write for tens of seconds on a fresh install, costs each waiting terminal 4 s
 * instead of the whole stall (and every terminal restored at start-up waits it out side by side, not in series). The
 * timer is started only for a spawn that has to wait, is cleared when its turn comes, and is unref'd, so it never
 * delays a normal spawn, never fires once it is not needed and never keeps the app alive.
 */
export const INTEGRATION_WAIT_MS = 4_000

/**
 * Run `job` after every job queued before it for the same file, or answer `onWaitTooLong` if it has waited
 * INTEGRATION_WAIT_MS for them. A job that rejects rejects only its own caller: the next job runs all the same (`then(turn,
 * turn)`) and the lock is released either way (`then(release, release)`, which also handles the rejection, where a
 * `finally` would pass it on to a promise nobody awaits).
 */
export function underIntegrationLock<T>(
  name: string,
  job: (queue: IntegrationQueue) => Promise<T>,
  onWaitTooLong: T,
): Promise<T> {
  const ahead = integrationLocks.get(name)
  if (ahead?.stalled) return Promise.resolve(onWaitTooLong)
  const queue: IntegrationQueue = ahead ?? { tail: Promise.resolve(), stalled: false }
  let timer: ReturnType<typeof setTimeout> | undefined
  let gaveUp = false
  const turn = (): Promise<T> | undefined => {
    clearTimeout(timer)
    queue.stalled = false // whatever ran before this turn has settled
    return gaveUp ? undefined : job(queue)
  }
  const run = queue.tail.then(turn, turn)
  queue.tail = run
  integrationLocks.set(name, queue)
  const release = (): void => { if (queue.tail === run) integrationLocks.delete(name) }
  void run.then(release, release)
  if (!ahead) return run as Promise<T> // a free lock: nothing to wait for, so no timer
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => { gaveUp = true; queue.stalled = true; resolve(onWaitTooLong) }, INTEGRATION_WAIT_MS)
    timer.unref()
    run.then((v) => resolve(v as T), reject)
  })
}

/** A temp file older than this is a leftover (a write takes milliseconds): one a scanner held when it was to be removed. */
export const STALE_TEMP_MS = 60_000

/** A name wholeFileTempName gave a file named `base`: `<base>.<pid>.<n>.<up to 6 of [a-z0-9]>.tmp`. */
const isTempOf = (name: string, base: string): boolean =>
  name.startsWith(`${base}.`) && /^\d+\.\d+\.[a-z0-9]{0,6}\.tmp$/.test(name.slice(base.length + 1))

/**
 * Remove the temp files that refused writes left beside the integration files (a temp file the scanner still held
 * could not be removed then). Only names wholeFileTempName makes for an integration file, only in their folders, and
 * only ones older than STALE_TEMP_MS, so a write in flight now is never touched. Never rejects; answers what it removed.
 */
export async function sweepStaleIntegrationTemps(root: string, now: number = Date.now()): Promise<string[]> {
  const basesByDir = new Map<string, string[]>()
  for (const file of Object.values(INTEGRATION_FILES)) {
    for (const f of integrationFileSet(file, join(root, file.name))) {
      const dir = dirname(f.path)
      basesByDir.set(dir, [...(basesByDir.get(dir) ?? []), basename(f.path)])
    }
  }
  const removed: string[] = []
  for (const [dir, bases] of basesByDir) {
    let names: unknown
    try { names = await fsp.readdir(dir) } catch { continue } // not made yet
    if (!Array.isArray(names)) continue // not a listing: nothing here to sweep, and the sweep still never rejects
    for (const name of names as string[]) {
      if (!bases.some((b) => isTempOf(name, b))) continue
      const p = join(dir, name)
      try {
        if (now - (await fsp.stat(p)).mtimeMs < STALE_TEMP_MS) continue
        await fsp.rm(p, { force: true })
        removed.push(p)
      } catch { /* still held, or not a file: left for the next run */ }
    }
  }
  return removed
}

let tempSweep: Promise<string[]> | undefined
/** The sweep of leftover temp files, started by the first prepare that needs an integration file (undefined before it). */
export const integrationTempSweep = (): Promise<string[]> | undefined => tempSweep

/**
 * Put a shell's integration file on disk, once per app run, and again if something cleaned it up mid-session.
 * It goes in Termpolis's own data folder, never anywhere the user owns, and not the temp dir (PowerShell running
 * a script from %TEMP% is a pattern endpoint security flags). Null on any failure, which the caller reads as
 * "spawn exactly as before".
 */
export function ensureIntegrationScriptAsync(
  file: IntegrationFile = INTEGRATION_FILES.powershell,
  io: Partial<WholeFileIo> = {},
): Promise<string | null> {
  return underIntegrationLock(file.name, async (queue) => {
    const vouched = queue.recorded
    queue.recorded = undefined // said again below only if this job records the file too
    try {
      const known = integrationScriptState[file.name]
      const p = known ?? join(app.getPath('userData'), file.name)
      if (!tempSweep) tempSweep = sweepStaleIntegrationTemps(app.getPath('userData'))
      const set = integrationFileSet(file, p) // zsh's .zshenv brings three siblings; every other shell one file
      let present = false
      // The job just ahead in the queue recorded this file a moment ago (terminals restored at start-up queue up
      // together): checking it again would only add one more file call per terminal, one after another.
      if (known !== undefined && known === vouched) present = true
      else if (known !== undefined) {
        try { await Promise.all(set.map((f) => fsp.access(f.path))); present = true } catch { /* cleaned up mid-session: written again below */ }
      }
      let kept = false
      if (!present) {
        await fsp.mkdir(dirname(p), { recursive: true })
        for (const f of set) {
          if ((await writeWholeFile(f.path, f.content, io)) === 'kept') { kept = true; logRenameRefusal(f.path) }
        }
      }
      // An old copy kept by a refused rename is used, but not recorded as written: the next spawn tries again, so a
      // scanner that refuses once cannot freeze an old script (or zsh's four files half old, half new) for the run.
      if (kept) delete integrationScriptState[file.name]
      else { integrationScriptState[file.name] = p; queue.recorded = p }
      return p
    } catch {
      return null
    }
  }, null)
}

export async function prepareSpawn(cwd: string, executable: string): Promise<SpawnPrep> {
  let resolvedCwd: string
  try {
    await fsp.stat(cwd)
    resolvedCwd = cwd
  } catch {
    resolvedCwd = homedir()
  }
  const file = integrationDisabled() ? null : integrationFile(detectShellKind(executable))
  const script = file ? await ensureIntegrationScriptAsync(file) : null
  return { cwd: resolvedCwd, integrationScript: script }
}
