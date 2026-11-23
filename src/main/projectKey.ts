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
//   - lowercased, on every platform (what the key always did, so every key written before this is unchanged;
//     on Linux two folders differing only in case share a key, as they always have).
// An 8.3 short name (`C:\Users\DAVIDE~1\...`) cannot be told from its long name by its spelling. expandShortPath spells it
// out (async; only the parts that look short, each found by listing its folder: never realpath, which would also resolve
// junctions, symlinks and mapped drives into a different folder's key). The store expands a note's project and a search's
// project with it; main expands the Ask's folder before the primer cache keys it and before its reads (index.ts).
//
// Ruling (no migration): stored notes keep the key they were written with. A search matches the canonical key
// and the keys older spellings of the same folder were given (projectKeyAliases), so notes written from Git Bash,
// Cygwin or with doubled separators keep matching, and new writes get the canonical key.

import * as crypto from 'crypto'
import { promises as fsp } from 'fs'
import { normalizeShellPath } from '../shared/cwdPath'

const hash = (s: string): string => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)

/** The trimmed path without its trailing separators, or '' for a bare name (nothing to key on). */
function pathPart(pathOrName: unknown): string {
  if (typeof pathOrName !== 'string') return ''
  const t = pathOrName.trim().replace(/[\\/]+$/, '')
  return t && /[\\/]/.test(t) ? t : ''
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
  return /[\\/]/.test(s) ? s.toLowerCase() : ''
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

/** Every key a note about this folder may carry: the canonical one first, then the key this spelling had before WPA, and on
 *  Windows the keys of the folder's Git Bash and Cygwin spellings (what a note written from such a terminal was given before
 *  WPA). Empty for a bare name. */
export function projectKeyAliases(pathOrName: string, platform: NodeJS.Platform = process.platform): string[] {
  const c = canonicalProjectPath(pathOrName, platform)
  if (!c) return []
  const keys = [hash(c), legacyProjectKeyOf(pathOrName) as string]
  // A canonical drive path always has a folder after the drive: a bare `c:` has no separator, so it has no key at all.
  const drive = platform === 'win32' ? /^([a-z]):(\/.*)$/.exec(c) : null
  if (drive) keys.push(hash(`/${drive[1]}${drive[2]}`), hash(`/cygdrive/${drive[1]}${drive[2]}`))
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
 * as it was. The separators are kept as given. Never throws.
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

async function expandUncached(pathOrName: string, fs: ShortPathFs): Promise<string> {
  try {
    // Parts and the separators between them, alternating: ['C:', '\\', 'Users', '\\', 'DAVIDE~1', ...].
    const bits = pathOrName.trim().split(/([\\/]+)/)
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
