import { readdirSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve, sep } from 'path'

import type { DirectoryEntry, DirectoryListing } from './protocol'

/**
 * Lists a desktop folder for the phone's remote picker, rooted at the desktop
 * home and unable to climb above it.
 *
 * This is bridge-local filesystem access, NOT a new MCP tool -- the agent-facing
 * tool-description budget is nearly full, and the phone is the only caller. It is
 * also deliberately TIGHTER than completionService's `isPathAllowed` (which
 * permits home OR cwd): a remote device browsing for a working folder has no
 * business reaching a cwd outside the user's home, and `createTerminal` already
 * accepts an arbitrary cwd, so the picker is where that reach is fenced.
 *
 * Every path returned is real (symlinks resolved) and proven to sit under the
 * home root, so a phone that only ever echoes these paths back -- to descend or
 * to launch -- cannot be talked into escaping. A requested path that does not
 * exist, cannot be read, or resolves outside home falls back to the root rather
 * than erroring: the picker must always render SOMETHING selectable.
 */
export function listHomeDirectory(rawPath?: string): DirectoryListing {
  const root = homeRoot()
  const target = resolveWithin(root, rawPath)
  return {
    path: target,
    parent: target === root ? null : dirname(target),
    entries: childDirectories(root, target),
  }
}

/** The canonical desktop home. realpath so a symlinked home (e.g. macOS
 *  `/var` -> `/private/var`) compares equal to the paths readdir hands back;
 *  if that fails for any reason, the raw home still fences correctly. */
function homeRoot(): string {
  const home = homedir()
  try {
    return realpathSync(home)
  } catch {
    return home
  }
}

/** Resolves a requested path to a real directory under `root`, or `root` itself
 *  when the request is absent, unreadable, not a directory, or escapes home. */
function resolveWithin(root: string, rawPath?: string): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return root
  try {
    const real = realpathSync(resolve(root, rawPath))
    if (within(root, real) && statSync(real).isDirectory()) return real
  } catch {
    // ENOENT, permission, or a broken symlink -- fall through to root.
  }
  return root
}

/** The subdirectories of `target`, symlinks resolved and each proven to stay
 *  under `root`, sorted by name. A folder that cannot be read yields none rather
 *  than throwing -- the level above it stays browsable. */
function childDirectories(root: string, target: string): DirectoryEntry[] {
  let names: string[]
  try {
    names = readdirSync(target)
  } catch {
    return []
  }

  const entries: DirectoryEntry[] = []
  for (const name of names) {
    try {
      // realpath follows a directory symlink to its target; a symlink pointing
      // outside home resolves outside root and is dropped here, and the real
      // path is what we store so descending into it stays contained.
      const real = realpathSync(join(target, name))
      if (within(root, real) && statSync(real).isDirectory()) {
        entries.push({ name, path: real })
      }
    } catch {
      // A broken or unreadable entry is simply not offered.
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries
}

/** True when `candidate` is `root` or sits beneath it. The trailing separator
 *  stops `/home/bob-secret` from passing as under `/home/bob`. */
function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep)
}
