// projectKey.ts — one shared, stable, unique key for a repo/project, derived from its FULL path.
// Shared by the memory store (project scoping), the code graph (per-repo state), the context primer and
// main's primer cache, so the SAME repo resolves to the SAME key on every side — the join the
// memory<->code bridge relies on.
//
// `~/work/acme/api` and `~/work/globex/api` (same basename `api`) never collide. A bare name
// (no path separator) returns undefined: there's nothing to disambiguate on.
//
// WPA (Lumopolis 2.0): one folder reaches the app spelled several ways, and each spelling used to be its own
// key, so a note written from one terminal was missing from a search made from another. The canonical form:
//   - the ends trimmed and trailing separators dropped;
//   - read as a shell path first (shared/cwdPath normalizeShellPath, WPA fix M1): quotes taken off, a `file://` URI decoded,
//     and on Windows the Git Bash `/c/...`, Cygwin `/cygdrive/c/...` and WSL `/mnt/c/...` spellings read as the drive
//     `c:/...` (a bare one-letter root such as `/c` or `/r` is left as it is: it keeps the key it always had);
//   - every `\` a `/`, and a run of separators one (a leading `//` of a UNC share is kept);
//   - lowercased where the folder's file system ignores case (foldsCase, the one rule folderKey, the code index and the
//     watchers use, WP5 X03): on Windows always; on Linux never, so two folders differing only in case are two projects
//     (WP5 X02); on macOS unless the folder is on a case-sensitive volume (review S6). APFS ignores case unless it was
//     formatted otherwise, so a Mac folder folds case until learnCaseRule has asked its volume, once per folder per run,
//     and found it keeps case. Before WP5 every key was lowercased, and that key stays an alias (projectKeyAliases).
// An 8.3 short name (`C:\Users\DAVIDE~1\...`) cannot be told from its long name by its spelling. expandShortPath spells it
// out (async; only the parts that look short, each found by listing its folder: never realpath, which would also resolve
// junctions, symlinks and mapped drives into a different folder's key). The store expands a note's project and a search's
// project with it; main expands the Ask's folder before the primer cache keys it and before its reads (index.ts). A shell
// spelling (`/c/Users/DAVIDE~1/repo` from Git Bash) is read as its Windows path before the parts are looked up (WP5, review I6).
//
// Ruling (no migration): stored notes keep the key they were written with. A search matches the canonical key
// and the keys older spellings of the same folder were given (projectKeyAliases), so notes written from Git Bash,
// Cygwin, with doubled separators, under the short spelling a search was made with, or on Linux before WP5 kept the case,
// keep matching, and new writes get the canonical key.

import * as crypto from 'crypto'
import { promises as fsp } from 'fs'
import { normalizeShellPath } from '../shared/cwdPath'
import { foldsCase } from '../shared/caseFolding'

/** Whether a platform's file systems ignore case, so its keys are lowercased (WP5 X03: the rule folderKey uses too). */
export { foldsCase }

const hash = (s: string): string => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)

/** The trimmed path without its trailing separators, or '' for a bare name (nothing to key on). */
function pathPart(pathOrName: unknown): string {
  if (typeof pathOrName !== 'string') return ''
  const t = pathOrName.trim().replace(/[\\/]+$/, '')
  return t && /[\\/]/.test(t) ? t : ''
}

/** macOS folders learnCaseRule found on a volume that keeps case (canonical spelling, case kept): a path inside one keeps
 *  its case too. Learned this run; a run starts again from the platform rule until the folder is asked about. */
const caseKeptRoots = new Set<string>()
/** The answer for each spelling learnCaseRule was asked about, so a second ask makes no file system call. */
const caseLearned = new Map<string, Promise<boolean>>()
const CASE_LEARNED_MAX = 256

/** Whether a folder spelled `s` (canonical, case kept) folds case on `platform`: the platform rule, unless a Mac folder is
 *  inside one learnCaseRule found keeps case. */
function foldsCaseFor(s: string, platform: NodeJS.Platform): boolean {
  if (!foldsCase(platform)) return false
  if (platform !== 'darwin' || caseKeptRoots.size === 0) return true
  for (const r of caseKeptRoots) if (s === r || s.startsWith(r + '/')) return false
  return true
}

/** One path's device and file id (lstat: a link is never followed). */
export type CaseProbeFs = (path: string) => Promise<{ dev: bigint | number; ino: bigint | number }>
const realCaseProbeFs: CaseProbeFs = (p) => fsp.lstat(p, { bigint: true })

/** `name` with each letter's case swapped, so it names the same entry only where the file system ignores case. */
const swapCase = (name: string): string => name.replace(/\p{L}/gu, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))

/**
 * Asks a Mac folder's volume whether it ignores case (review S6), as git does for core.ignorecase: the folder, or its
 * nearest ancestor with a letter in its name, looked up under its name with the case swapped is the same entry (same device
 * and file id) only where the volume ignores case. A volume that keeps case is remembered, so the folder and everything in
 * it keep their case in their keys from then on. Off macOS it answers the platform rule and touches nothing; a folder that
 * cannot be read, or has no letter anywhere in its path, keeps the platform rule. Resolves with whether the folder folds case.
 * Never rejects.
 */
export function learnCaseRule(pathOrName: string, platform: NodeJS.Platform = process.platform, fs: CaseProbeFs = realCaseProbeFs): Promise<boolean> {
  const c = canonicalProjectPath(pathOrName, 'linux') // the spelling with its case kept
  if (platform !== 'darwin' || !c) return Promise.resolve(c ? foldsCaseFor(c, platform) : foldsCase(platform))
  const known = caseLearned.get(c)
  if (known) return known
  const asked = (async (): Promise<boolean> => {
    // The folder, then each ancestor up to the root, until one has a letter in its name and can be looked up.
    for (let cur = c, cut = cur.lastIndexOf('/'); cut >= 0 && cur !== '/'; cur = cur.slice(0, cut) || '/', cut = cur.lastIndexOf('/')) {
      const swapped = swapCase(cur.slice(cut + 1))
      if (swapped === cur.slice(cut + 1)) continue
      const own = await fs(cur).catch(() => null)
      if (!own) continue
      const other = await fs(cur.slice(0, cut + 1) + swapped).catch(() => null)
      if (other && other.dev === own.dev && other.ino === own.ino) return true
      caseKeptRoots.add(cur)
      return false
    }
    return true // no letter to ask with, or nothing readable: the macOS rule
  })()
  caseLearned.set(c, asked)
  if (caseLearned.size > CASE_LEARNED_MAX) caseLearned.delete(caseLearned.keys().next().value as string)
  return asked
}

/** Forgets what learnCaseRule learned (tests). */
export function _resetCaseRuleForTests(): void {
  caseKeptRoots.clear()
  caseLearned.clear()
}

/** The canonical spelling of a project path (see the header), or '' for a bare name. */
export function canonicalProjectPath(pathOrName: string, platform: NodeJS.Platform = process.platform): string {
  const t = pathPart(pathOrName)
  if (!t) return ''
  // A bare one-letter root (`/c`, `/r`) would read as a drive root: it keeps the spelling, and so the key, it had before WPA.
  // Anything normalizeShellPath cannot read as a path (a relative fragment on Linux, `/usr/bin` on Windows) is keyed as given.
  const shell = /^\/[a-zA-Z]$/.test(t) ? null : normalizeShellPath(t, { platform })
  const slashed = (shell ?? t).replace(/\\/g, '/')
  const unc = slashed.startsWith('//')
  let s = (unc ? '/' : '') + slashed.replace(/\/{2,}/g, '/')
  s = s.replace(/\/+$/, '') // a drive root normalizeShellPath spelled `C:\` (from a bare `/c/` reading) loses its last separator
  // Only `/c/<more>` is a Git Bash drive path: a bare `/c` (or a one-letter POSIX root folder `/r`) keeps the key it always had.
  if (platform === 'win32') s = s.replace(/^\/(?:cygdrive\/)?([a-zA-Z])(?=\/)/, '$1:')
  // A drive with nothing after it has no separator left: no folder to key on.
  if (!/[\\/]/.test(s)) return ''
  return foldsCaseFor(s, platform) ? s.toLowerCase() : s
}

/** The key of a project path: the canonical spelling, hashed. Undefined for a bare name. */
export function projectKeyOf(pathOrName: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const c = canonicalProjectPath(pathOrName, platform)
  return c ? hash(c) : undefined
}

/** The key this exact spelling was given before WPA (only `\` turned to `/`, then lowercased). */
export function legacyProjectKeyOf(pathOrName: string): string | undefined {
  const t = pathPart(pathOrName)
  return t ? hash(t.replace(/\\/g, '/').toLowerCase()) : undefined
}

/** Every key a note about this folder may carry: the canonical one first; on a platform that keeps case, the lowercased key
 *  every note had before WP5; the key this spelling had before WPA; and on Windows the keys of the folder's Git Bash and
 *  Cygwin spellings (what a note written from such a terminal was given before WPA). `spelledAs`, the spelling a caller was
 *  handed before expandShortPath spelled it out, adds that spelling's keys too, so a note written under the short spelling
 *  keeps matching (WP5, review I6). Empty for a bare name. */
export function projectKeyAliases(pathOrName: string, platform: NodeJS.Platform = process.platform, spelledAs?: unknown): string[] {
  const c = canonicalProjectPath(pathOrName, platform)
  if (!c) return []
  const keys = [hash(c), hash(c.toLowerCase()), legacyProjectKeyOf(pathOrName) as string]
  // A canonical drive path always has a folder after the drive: a bare `c:` has no separator, so it has no key at all.
  const drive = platform === 'win32' ? /^([a-z]):(\/.*)$/.exec(c) : null
  if (drive) keys.push(hash(`/${drive[1]}${drive[2]}`), hash(`/cygdrive/${drive[1]}${drive[2]}`))
  if (typeof spelledAs === 'string' && spelledAs !== pathOrName) keys.push(...projectKeyAliases(spelledAs, platform))
  return [...new Set(keys)]
}

const SHORT_PART = /(^|[\\/])[^\\/]*~\d[^\\/]*(?=[\\/]|$)/
const SHORT_SEGMENT = /~\d/

/** Whether a Windows path has a part that looks like an 8.3 short name, so it is worth expanding. Sync, no I/O: callers use
 *  it to await expandShortPath only when it can change something. */
export function hasShortPart(pathOrName: unknown, platform: NodeJS.Platform = process.platform): boolean {
  return typeof pathOrName === 'string' && platform === 'win32' && SHORT_PART.test(pathOrName)
}

/** What expandShortPath reads: a folder's names, and the file id of one path (lstat: a link is never followed). */
export interface ShortPathFs {
  readdir(dir: string): Promise<string[]>
  ino(path: string): Promise<bigint | number>
}

const realShortPathFs: ShortPathFs = {
  readdir: (dir) => fsp.readdir(dir),
  ino: async (p) => (await fsp.lstat(p, { bigint: true })).ino,
}

/** The most names of one folder whose file ids are compared before a short part is left as it is. */
export const SHORT_SCAN_MAX = 512

/** The long name, in `dir`, of the entry whose short name is `short`; null when none is found. */
async function longNameOf(dir: string, short: string, fs: ShortPathFs): Promise<string | null> {
  const target = await fs.ino(dir + short)
  if (!target) return null // a file system with no ids (0) cannot tell its entries apart
  const names = await fs.readdir(dir)
  const upper = short.toUpperCase()
  const exact = names.find((n) => n.toUpperCase() === upper)
  if (exact !== undefined) return exact // a long name that only looks short
  // Its short name is (mostly) its long name squeezed, uppercased and cut before the `~`: those are tried first.
  const base = short.slice(0, short.indexOf('~')).toUpperCase()
  const squeezed = (n: string): string => n.replace(/[\s.]/g, '').toUpperCase()
  const likely = names.filter((n) => squeezed(n).startsWith(base))
  const rest = names.filter((n) => !squeezed(n).startsWith(base))
  for (const n of [...likely, ...rest].slice(0, SHORT_SCAN_MAX)) {
    try { if (await fs.ino(dir + n) === target) return n } catch { /* gone, or not ours to read: the next one */ }
  }
  return null
}

/** WPA fix round 2 (R-M4): expandShortPath remembers its answers, keyed by the input path, so a caller whose cwd is spelled
 *  short (every memorySearch, memoryWrite and memoryList in the host, every ask and warm in main) lists the folder once, not
 *  per call. Bounded: the least recently used path goes first past SHORT_MEMO_MAX. A found long form is kept SHORT_MEMO_HIT_MS
 *  (a short name can be handed to another folder once its own is gone), a path left short only SHORT_MEMO_MISS_MS (the folder
 *  may be made a moment later). One memo per file system, so a test's fake never sees the real one's answers. */
export const SHORT_MEMO_MAX = 64
export const SHORT_MEMO_HIT_MS = 10 * 60_000
export const SHORT_MEMO_MISS_MS = 30_000
interface ShortMemo { at: number; ttl: number; value: Promise<string> }
const shortMemos = new WeakMap<ShortPathFs, Map<string, ShortMemo>>()

/**
 * The long form of a Windows path with 8.3 short parts (`DAVIDE~1`): each part that looks short is replaced by the name of the
 * entry in its folder that has the same file id (WPA fix M7: a folder listing, never realpath, so a junction, a symlink or a
 * mapped drive in the path stays as it is). Any other path, any other platform, or a part that cannot be found leaves the path
 * as it was. The separators are kept as given, except that a shell spelling (Git Bash `/c/...`, Cygwin, WSL, a quoted path or
 * a `file://` URI) is read as its Windows path first, since the file system knows only that one (WP5, review I6), and a long
 * form found for it comes back spelled that way. Never throws.
 */
export async function expandShortPath(
  pathOrName: string,
  platform: NodeJS.Platform = process.platform,
  fs: ShortPathFs = realShortPathFs,
  now: () => number = Date.now,
): Promise<string> {
  if (!hasShortPart(pathOrName, platform)) return pathOrName
  let memo = shortMemos.get(fs)
  if (!memo) { memo = new Map(); shortMemos.set(fs, memo) }
  const at = now()
  const known = memo.get(pathOrName)
  memo.delete(pathOrName) // (re)inserted below: a Map keeps insertion order, so the first key is the least recently used
  if (known && at - known.at < known.ttl) { memo.set(pathOrName, known); return known.value }
  // A call made while the first is still scanning shares its promise. expandUncached never rejects.
  const entry: ShortMemo = { at, ttl: SHORT_MEMO_HIT_MS, value: expandUncached(pathOrName, fs) }
  memo.set(pathOrName, entry)
  if (memo.size > SHORT_MEMO_MAX) memo.delete(memo.keys().next().value as string)
  return entry.value.then((long) => { if (long === pathOrName) entry.ttl = SHORT_MEMO_MISS_MS; return long })
}

/** A Windows path a shell spelled (`/c/x`, `/cygdrive/c/x`, `/mnt/c/x`, quoted, `file://`), as the file system spells it; any
 *  other path as given. A UNC `//server/share` is already the file system's. */
const SHELL_SPELLED = /^(?:\/(?!\/)|["']|file:)/i
function fileSystemSpelling(p: string): string {
  return (SHELL_SPELLED.test(p) && normalizeShellPath(p, { platform: 'win32' })) || p
}

async function expandUncached(pathOrName: string, fs: ShortPathFs): Promise<string> {
  try {
    // Parts and the separators between them, alternating: ['C:', '\\', 'Users', '\\', 'DAVIDE~1', ...].
    const bits = fileSystemSpelling(pathOrName.trim()).split(/([\\/]+)/)
    let prefix = bits[0]
    for (let i = 1; i < bits.length; i += 2) {
      const sep = bits[i]
      let part = bits[i + 1] // a split with a captured separator always has a part after each one ('' after a trailing one)
      if (part && SHORT_SEGMENT.test(part)) {
        const long = await longNameOf(prefix + sep, part, fs)
        if (long === null) return pathOrName
        part = long
      }
      prefix += sep + part
    }
    return prefix
  } catch {
    return pathOrName
  }
}
