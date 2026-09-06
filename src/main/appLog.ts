// appLog.ts (main)
//
// The app's own log, and the reason it exists: in a packaged build there IS no
// console. Everything Termpolis prints about itself -- which shell it picked, why a
// terminal failed to spawn, what the updater decided, which IPC handler threw --
// goes to a stdout nobody can see, so "it did something odd" has never been
// answerable without a dev build. This keeps the last few thousand of those lines in
// memory for the in-app viewer (default Ctrl+Shift+O) and mirrors them to a file in
// the user's profile so a crash still leaves evidence behind.
//
// Two rules shape the whole module:
//
//   1. LOGGING MUST NEVER BREAK THE THING IT LOGS. Every write is wrapped, every
//      failure is swallowed, and a bad level or an unserialisable argument degrades
//      to a string. A logger that can throw turns a cosmetic bug into a crash.
//   2. NOTHING SENSITIVE REACHES THE FILE. Redaction happens on write (shared/appLog),
//      not on read, so a secret never exists on disk to be leaked by a later copy.
//
// The formatting, redaction and ring buffer are pure and live in src/shared/appLog.ts;
// this file owns only the state and the fs.
import { appendFile, rename, stat } from 'fs/promises'
import { join } from 'path'
import {
  formatLogArgs,
  formatLogLine,
  pushLogEntry,
  type AppLogEntry,
  type AppLogLevel,
  type AppLogSource,
} from '../shared/appLog'

/** Rotate at 4 MiB. One rotation is kept (`app.log.old`), so the worst case on disk
 *  is ~8 MiB -- enough to survive a chatty session without becoming a disk-space
 *  question of its own. */
export const MAX_APP_LOG_FILE_BYTES = 4 * 1024 * 1024

/** The fs surface this module needs, so the file half is testable without touching a
 *  real disk and without vi.mock reaching into node internals. */
export interface AppLogFs {
  appendFile: (path: string, data: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  stat: (path: string) => Promise<{ size: number }>
}

const realFs: AppLogFs = {
  appendFile: (p, d) => appendFile(p, d, 'utf8'),
  rename: (a, b) => rename(a, b),
  stat: async (p) => ({ size: (await stat(p)).size }),
}

let ring: AppLogEntry[] = []
let logPath: string | null = null
let fsApi: AppLogFs = realFs
/** Bytes written since the last size check. Counted in-process so the common path
 *  costs no stat() -- the file is only measured when this crosses the cap. */
let bytesSinceCheck = 0
/** Serialises appends. Without it two concurrent appendFile calls can interleave
 *  mid-line and the file stops being parseable. */
let writeChain: Promise<void> = Promise.resolve()

/**
 * Point the log at a directory (Electron's userData).
 *
 * Called once from whenReady. Passing null writes no file, which is what tests get
 * and what any logging before app.getPath('userData') is available gets.
 *
 * It deliberately does NOT clear the ring. Console capture starts at module load --
 * well before Electron is ready -- and the lines printed during startup are exactly
 * the ones worth keeping when startup is what went wrong. Use clearAppLog() to empty
 * it.
 */
export function initAppLog(dir: string | null, deps: { fs?: AppLogFs } = {}): void {
  fsApi = deps.fs ?? realFs
  logPath = dir ? join(dir, 'app.log') : null
  bytesSinceCheck = 0
  writeChain = Promise.resolve()
}

/** Where the log file lives, for the viewer's "open folder" button. Null before init
 *  or when running without a userData directory. */
export function appLogFilePath(): string | null {
  return logPath
}

/** Rotate if the file has outgrown the cap. Failures are swallowed: a log that cannot
 *  rotate should keep appending, not stop logging. */
async function rotateIfNeeded(path: string): Promise<void> {
  if (bytesSinceCheck < MAX_APP_LOG_FILE_BYTES / 8) return
  bytesSinceCheck = 0
  try {
    const { size } = await fsApi.stat(path)
    if (size < MAX_APP_LOG_FILE_BYTES) return
    await fsApi.rename(path, `${path}.old`)
  } catch {
    /* no file yet, or a locked rename on Windows -- keep appending either way */
  }
}

/** Record one line. Synchronous into the ring (so the viewer is instant) and queued
 *  to the file (so a slow disk cannot stall the main thread). */
export function logToApp(level: AppLogLevel, source: AppLogSource, args: readonly unknown[], now = Date.now()): void {
  const entry: AppLogEntry = { t: now, level, source, msg: formatLogArgs(args) }
  pushLogEntry(ring, entry)
  const path = logPath
  if (!path) return
  const line = `${formatLogLine(entry)}\n`
  bytesSinceCheck += line.length
  writeChain = writeChain
    .then(async () => {
      await rotateIfNeeded(path)
      await fsApi.appendFile(path, line)
    })
    .catch(() => { /* disk full, permissions, profile on a dead network share */ })
}

/** The newest `limit` entries, oldest first (reading order). */
export function readAppLog(limit = 500): AppLogEntry[] {
  const n = Math.max(1, Math.min(Math.floor(limit) || 500, ring.length || 1))
  return ring.slice(-n)
}

/** Drop everything held in memory. The file is left alone on purpose -- it is the
 *  crash evidence, and "clear the view" should not destroy it. */
export function clearAppLog(): void {
  ring = []
}

/** The console methods this captures. `trace` and `dir` are left alone: they are
 *  debugging aids whose value is the live console formatting, not a log line. */
const CAPTURED: readonly AppLogLevel[] = ['debug', 'info', 'log', 'warn', 'error']

/** The minimum shape captureConsole needs -- narrower than lib.dom's Console so a
 *  test can pass a plain object. */
export type ConsoleLike = Record<AppLogLevel, (...args: unknown[]) => void>

/**
 * Mirror a console into the app log, returning an uninstall function.
 *
 * The original method is always called first and with the original arguments, so a
 * dev build's console is unchanged and nothing about existing debugging shifts. If
 * the mirror throws for any reason it is swallowed -- see rule 1 at the top.
 */
export function captureConsole(target: ConsoleLike, source: AppLogSource): () => void {
  const originals = new Map<AppLogLevel, (...args: unknown[]) => void>()
  for (const level of CAPTURED) {
    const original = target[level]
    if (typeof original !== 'function') continue
    originals.set(level, original)
    target[level] = (...args: unknown[]) => {
      original.apply(target, args)
      try {
        logToApp(level, source, args)
      } catch { /* never let logging break the caller */ }
    }
  }
  return () => {
    for (const [level, original] of originals) target[level] = original
  }
}
