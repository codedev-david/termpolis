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
//   - every `\` a `/`, and a run of separators one (a leading `//` of a UNC share is kept);
//   - on Windows, the Git Bash spelling `/c/...` (and `/cygdrive/c/...`) is the drive `c:/...`;
//   - lowercased, on every platform (what the key always did, so every key written before this is unchanged;
//     on Linux two folders differing only in case share a key, as they always have).
// An 8.3 short name (`C:\Users\DAVIDE~1\...`) cannot be told from its long name by its spelling: the store and
// the primer expand it first with expandShortPath (async, one realpath, only when a part looks short).
//
// Ruling (no migration): stored notes keep the key they were written with. A search matches the canonical key
// and the keys older spellings of the same folder were given (projectKeyAliases), so notes written from Git Bash
// or with doubled separators keep matching, and new writes get the canonical key.

import * as crypto from 'crypto'
import { promises as fsp } from 'fs'

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
  const slashed = t.replace(/\\/g, '/')
  const unc = slashed.startsWith('//')
  let s = (unc ? '/' : '') + slashed.replace(/\/{2,}/g, '/')
  // Only `/c/<more>` is a Git Bash drive path: a bare `/c` (or a one-letter POSIX root folder `/r`) keeps the key it always had.
  if (platform === 'win32') s = s.replace(/^\/(?:cygdrive\/)?([a-zA-Z])(?=\/)/, '$1:')
  // pathPart kept only a spelling with a separator in it, and nothing above takes the last one out.
  return s.toLowerCase()
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
 *  Windows the key of the folder's Git Bash spelling (what a note written from a Git Bash terminal was given). Empty for a bare name. */
export function projectKeyAliases(pathOrName: string, platform: NodeJS.Platform = process.platform): string[] {
  const c = canonicalProjectPath(pathOrName, platform)
  if (!c) return []
  const keys = [hash(c), legacyProjectKeyOf(pathOrName) as string]
  // A canonical drive path always has a folder after the drive: a bare `c:` has no separator, so it has no key at all.
  const drive = platform === 'win32' ? /^([a-z]):(\/.*)$/.exec(c) : null
  if (drive) keys.push(hash(`/${drive[1]}${drive[2]}`))
  return [...new Set(keys)]
}

const SHORT_PART = /(^|[\\/])[^\\/]*~\d[^\\/]*(?=[\\/]|$)/

/** Whether a Windows path has a part that looks like an 8.3 short name, so it is worth one realpath. Sync, no I/O: callers use it
 *  to await expandShortPath only when it can change something. */
export function hasShortPart(pathOrName: unknown, platform: NodeJS.Platform = process.platform): boolean {
  return typeof pathOrName === 'string' && platform === 'win32' && SHORT_PART.test(pathOrName)
}

/** The long form of a Windows path that has an 8.3 short part (`DAVIDE~1`), resolved by one realpath; any other path, any
 *  other platform, or a path that cannot be resolved comes back as it was. Never throws. */
export async function expandShortPath(
  pathOrName: string,
  platform: NodeJS.Platform = process.platform,
  realpath: (p: string) => Promise<string> = (p) => fsp.realpath(p),
): Promise<string> {
  if (!hasShortPart(pathOrName, platform)) return pathOrName
  try {
    const long = await realpath(pathOrName.trim())
    return typeof long === 'string' && long ? long : pathOrName
  } catch {
    return pathOrName
  }
}
