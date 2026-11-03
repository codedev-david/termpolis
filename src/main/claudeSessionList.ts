// claudeSessionList.ts
//
// The async, remembered twin of listSessionFiles (transcriptWatchers/claudeCodeWatcher.ts), for the
// one caller that asks again and again: the solo-session reflection pass. listSessionFiles lists a
// Claude Code project folder with a SYNC readdirSync and then one SYNC statSync per transcript, and
// a folder holds a transcript for every session ever run in it: 3,675 of them is 641 to 964 ms in a
// single block of the main thread (the thread that echoes every keystroke), paid on every pass.
//
// What this does instead:
//   - everything is async, so the thread is free between the stats;
//   - the listing is remembered per folder, keyed on the FOLDER's own mtime (it changes when a
//     transcript is created, deleted or renamed, not when one is appended to);
//   - while the folder is unchanged, only the newest LIST_RECHECK transcripts are statted again (the
//     ones being written to), instead of all of them;
//   - when the folder changed, it is listed again but only the names it did not know are statted;
//   - every LIST_FULL_REFRESH_MS every transcript is looked at again.
//
// The one thing it can miss, by design: an OLD transcript (not among the newest few) appended to in
// place without the folder changing, for at most LIST_FULL_REFRESH_MS. The synchronous
// listSessionFiles is left exactly as it was for the caller that cannot afford that (attaching a
// watcher to a terminal picks ONE file for the life of the terminal).

import * as fs from 'fs'
import * as path from 'path'
import { CLAUDE_PROJECTS_DIR, mangleCwd } from './transcriptWatchers/claudeCodeWatcher'
import { resolvePathWithinRoot } from './transcriptWatchers/baseWatcher'

/** The transcripts statted again on every look at an unchanged folder: the newest ones, which are the ones being written to. */
export const LIST_RECHECK = 8
/** How long the remembered mtimes of the older transcripts are trusted before every one is statted again. */
export const LIST_FULL_REFRESH_MS = 3 * 60_000
/** Folders remembered (least recently used goes first): a big one is about 1 MB. */
export const LIST_MAX_DIRS = 16
const STAT_CONCURRENCY = 16

/** The three async calls the listing makes, injectable so a test can count them. */
export interface ListFs {
  stat(p: string): Promise<{ mtimeMs: number; isDirectory(): boolean }>
  readdir(p: string): Promise<string[]>
  /** The same algorithm as the synchronous fs.realpathSync (see claudeCwdAsync). */
  realpath(p: string): Promise<string>
}

export interface ListOptions {
  /** Where Claude Code keeps its projects. Default: ~/.claude/projects. */
  projectsDir?: string
  now?: () => number
  fs?: ListFs
  /** Return only the newest this many (the caller reads five). Default: all of them, as listSessionFiles does. */
  limit?: number
}

const realFs: ListFs = {
  stat: (p) => fs.promises.stat(p),
  readdir: (p) => fs.promises.readdir(p),
  // fs.realpath with a callback is the JS algorithm that realpathSync is: it keeps a Windows short name
  // and the case as given, which is how Claude Code names the folder. fs.promises.realpath is the NATIVE
  // one (GetFinalPathNameByHandle) and would expand both, and find no folder.
  realpath: (p) => new Promise<string>((resolve, reject) => fs.realpath(p, (err, resolved) => (err ? reject(err) : resolve(resolved)))),
}

/** claudeCwd, off the main thread: every link on the way resolved; a folder that can't be read, or none, as given. */
export async function claudeCwdAsync(cwd: string, io: ListFs = realFs): Promise<string> {
  if (!cwd) return cwd
  try {
    return await io.realpath(cwd)
  } catch {
    return cwd
  }
}

/** Refuse an entry that escapes the projects folder (what listSessionFiles checks for each one). */
export function entryWithinRoot(root: string, full: string): boolean {
  try {
    resolvePathWithinRoot(root, full)
    return true
  } catch {
    return false
  }
}

interface Entry {
  name: string
  mtimeMs: number
}

interface Folder {
  /** The folder's own mtime when it was last looked at. */
  dirMtimeMs: number
  /** Its transcripts, newest first. */
  entries: Entry[]
  /** When every transcript's mtime was last looked at (the clock of the window above). */
  fullAt: number
}

const folders = new Map<string, Folder>()
const inflight = new Map<string, Promise<Entry[]>>()

/** Test seam. */
export function resetSessionListCache(): void {
  folders.clear()
  inflight.clear()
}

function remember(dir: string, folder: Folder): void {
  folders.delete(dir)
  folders.set(dir, folder)
  while (folders.size > LIST_MAX_DIRS) {
    const oldest = folders.keys().next()
    if (oldest.done) break
    folders.delete(oldest.value)
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

async function statEntry(dir: string, root: string, name: string, io: ListFs): Promise<Entry | null> {
  const full = path.join(dir, name)
  if (!entryWithinRoot(root, full)) return null
  try {
    return { name, mtimeMs: (await io.stat(full)).mtimeMs }
  } catch {
    return null // vanished, or unreadable: as in listSessionFiles, it is simply not there
  }
}

const newestFirst = (a: Entry, b: Entry): number => b.mtimeMs - a.mtimeMs

/** The folder did not change: only the newest few can have moved. */
async function recheckNewest(entries: Entry[], dir: string, root: string, io: ListFs): Promise<Entry[]> {
  const looked = await Promise.all(entries.slice(0, LIST_RECHECK).map((e) => statEntry(dir, root, e.name, io)))
  return [...looked.filter((e): e is Entry => e !== null), ...entries.slice(LIST_RECHECK)].sort(newestFirst)
}

async function compute(dir: string, root: string, dirMtimeMs: number, io: ListFs, now: number): Promise<Entry[]> {
  const cached = folders.get(dir)
  // A clock that went backwards (age < 0) closes the window rather than trusting the cache for ever.
  const age = cached ? now - cached.fullAt : -1
  const windowOpen = cached !== undefined && age >= 0 && age < LIST_FULL_REFRESH_MS

  if (cached && windowOpen && cached.dirMtimeMs === dirMtimeMs) {
    const entries = await recheckNewest(cached.entries, dir, root, io)
    remember(dir, { dirMtimeMs, entries, fullAt: cached.fullAt })
    return entries
  }

  let names: string[]
  try {
    names = await io.readdir(dir)
  } catch {
    return [] // gone between the stat and the listing
  }
  // The folder changed (or nothing is remembered, or the window closed). Inside the window a name
  // already known keeps its remembered mtime unless it is one of the newest few; outside it, every
  // transcript is statted.
  const known = new Map<string, Entry>()
  const newest = new Set<string>()
  if (cached && windowOpen) {
    for (const e of cached.entries) known.set(e.name, e)
    for (const e of cached.entries.slice(0, LIST_RECHECK)) newest.add(e.name)
  }
  const looked = await mapLimit(
    names.filter((n) => n.endsWith('.jsonl')),
    STAT_CONCURRENCY,
    async (name): Promise<Entry | null> => {
      const old = known.get(name)
      return old && !newest.has(name) ? old : statEntry(dir, root, name, io)
    },
  )
  const entries = looked.filter((e): e is Entry => e !== null).sort(newestFirst)
  remember(dir, { dirMtimeMs, entries, fullAt: cached && windowOpen ? cached.fullAt : now })
  return entries
}

/**
 * Every transcript of a working folder, newest first: what listSessionFiles returns, without a
 * synchronous fs call and without a stat of every file on every look (see the top of this file).
 */
export async function listSessionFilesAsync(cwd: string, opts: ListOptions = {}): Promise<string[]> {
  const root = opts.projectsDir ?? CLAUDE_PROJECTS_DIR
  const io = opts.fs ?? realFs
  const clock = opts.now ?? Date.now
  if (!cwd) return []
  const mangled = mangleCwd(await claudeCwdAsync(cwd, io))
  if (!mangled) return []

  const dir = path.join(root, mangled)
  let st: { mtimeMs: number; isDirectory(): boolean }
  try {
    st = await io.stat(dir)
  } catch {
    return []
  }
  if (!st.isDirectory()) return []

  // Callers that arrive together share ONE pass over the files.
  let pending = inflight.get(dir)
  if (!pending) {
    const mine: Promise<Entry[]> = compute(dir, root, st.mtimeMs, io, clock()).finally(() => {
      if (inflight.get(dir) === mine) inflight.delete(dir)
    })
    inflight.set(dir, mine)
    pending = mine
  }
  const entries = await pending
  const wanted = opts.limit === undefined ? entries : entries.slice(0, Math.max(0, opts.limit))
  return wanted.map((e) => path.join(dir, e.name))
}
