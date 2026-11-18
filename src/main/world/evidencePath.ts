// An evidence path an agent gives world_annotate, made safe: an absolute path inside the project root
// becomes repository-relative (forward slashes), one outside it is dropped, and a relative one that
// climbs out of the root with ".." is refused. Paths are compared by real path (a junction or an 8.3
// name leads to the same place) and, on Windows, ignoring case. Node only.
import * as fsp from 'node:fs/promises'
import { isAbsolute, posix, relative, resolve, win32 } from 'node:path'
import { isInside } from './folderSafety'

export const EVIDENCE_PATH_ESCAPES = 'An evidence path must stay inside the project folder.'

export interface EvidencePathDeps {
  realpath?: (p: string) => Promise<string>
  isWindows?: boolean
}

/** The same place by its real path, or null for a path that does not exist (yet). */
async function real(p: string, realpath: (p: string) => Promise<string>): Promise<string | null> {
  try {
    return await realpath(p)
  } catch {
    return null
  }
}

const slashes = (p: string): string => p.split('\\').join('/')

/**
 * The ref to store, or null when the path is outside the root (or there is no root to place it in).
 * `root` is null for a design, which has no folder: only a relative ref can be kept then.
 * Throws EVIDENCE_PATH_ESCAPES for a relative ref that leaves the root.
 */
export async function evidenceRef(ref: string, root: string | null, deps: EvidencePathDeps = {}): Promise<string | null> {
  const isWindows = deps.isWindows ?? process.platform === 'win32'
  const realpath = deps.realpath ?? ((p: string) => fsp.realpath(p))
  const absolute = isAbsolute(ref) || win32.isAbsolute(ref)
  if (!absolute) {
    const clean = posix.normalize(slashes(ref))
    if (clean === '..' || clean.startsWith('../')) throw new Error(EVIDENCE_PATH_ESCAPES)
    if (root === null) return clean
    return keep(true, root, resolve(root, clean), realpath, isWindows)
  }
  // A Windows-style path on another system names nothing here.
  if (root === null || (!isWindows && !isAbsolute(ref))) return null
  return keep(false, root, resolve(ref), realpath, isWindows)
}

/**
 * `target` relative to the root when it is inside it, else null (or a refusal for a relative ref).
 * A target that exists is judged by its real path alone, so a link inside the root that leads out is
 * outside; one that does not exist (yet) is judged as written, against the root's real path and its own.
 */
async function keep(isRelative: boolean, root: string, target: string, realpath: (p: string) => Promise<string>, isWindows: boolean): Promise<string | null> {
  const lexRoot = resolve(root)
  const realRoot = (await real(lexRoot, realpath)) ?? lexRoot
  const realTarget = await real(target, realpath)
  let rel: string | null = null
  if (realTarget !== null) {
    rel = isInside(realRoot, realTarget, isWindows) ? relative(realRoot, realTarget) : null
  } else if (isInside(realRoot, target, isWindows)) {
    rel = relative(realRoot, target)
  } else if (isInside(lexRoot, target, isWindows)) {
    rel = relative(lexRoot, target)
  }
  if (rel === null) return isRelative ? fail() : null
  return rel === '' ? null : slashes(rel)
}

function fail(): never {
  throw new Error(EVIDENCE_PATH_ESCAPES)
}
