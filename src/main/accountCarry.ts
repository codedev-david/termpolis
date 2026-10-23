// Carrying one Claude Code conversation to another account's profile (§7.2 step 6, R25), so the
// agent can resume it there by its id. A transcript is not a credential: every file goes through
// the accounts fs seam all the same. Nothing is needed when the two profiles share `projects/`
// (by default they do, through a link).
//
// The transcript is found by its id, one folder down (`<projects>/<folder>/<id>.jsonl`), and goes
// to the folder of the same name under the target: no folder name is worked out from the cwd, so
// a worktree's own folder, and a shell that reports no cwd, change nothing. An older copy already
// at the target is replaced only when it is older and no longer than the one carried; any other is
// kept beside it (`<id>.jsonl.bak-<time>`), so a round trip never resumes a stale copy.
import { join } from 'path'
import { isSessionId } from '../shared/accountSwitch'
import { accountFs } from './accountFs'
import type { AccountFs } from './accountFs'

export interface FoundTranscript {
  /** The projects folder it was found in. */
  projects: string
  /** Its folder there (the cwd's, as Claude Code named it). */
  folder: string
  mtimeMs: number
  size: number
}

export type CarryResult =
  /** Nothing to carry: the target sees the same projects folder. */
  | { kind: 'shared' }
  /** No transcript of that id in any of the profiles looked in. */
  | { kind: 'not-found' }
  /** Copied in; `kept` names the copy that was there, kept beside it. */
  | { kind: 'carried'; kept?: string }

/** The newest `<id>.jsonl` one folder down in any of `projectsDirs`, or null. */
export function findTranscript(projectsDirs: readonly string[], id: string, fsx: AccountFs = accountFs): FoundTranscript | null {
  if (!isSessionId(id)) throw new Error('not a session id')
  let best: FoundTranscript | null = null
  for (const projects of projectsDirs) {
    let folders
    try { folders = fsx.readDir(projects) } catch { continue }
    for (const f of folders) {
      if (!f.isDirectory()) continue
      const s = fsx.stat(join(projects, f.name, `${id}.jsonl`))
      if (s && s.isFile() && (!best || s.mtimeMs > best.mtimeMs)) best = { projects, folder: f.name, mtimeMs: s.mtimeMs, size: s.size }
    }
  }
  return best
}

/** The files of `from` into `to`, for a session's subagent transcripts: plain files only, never
 *  through a link, each copied where `to` has none or an older one. */
function copyFolder(from: string, to: string, fsx: AccountFs): void {
  if (!fsx.exists(to)) fsx.mkdir(to)
  for (const e of fsx.readDir(from)) {
    const src = join(from, e.name)
    const dst = join(to, e.name)
    if (e.isDirectory()) copyFolder(src, dst, fsx)
    else if (e.isFile()) {
      // A file gone since the folder was listed is left out.
      const s = fsx.stat(src)
      const there = fsx.stat(dst)
      if (s && (!there || there.mtimeMs < s.mtimeMs)) fsx.copyFile(src, dst)
    }
  }
}

/**
 * Makes session `id` resumable in `targetProjects`: from the newest copy in `sourceProjects`. The
 * target's own copy counts as the source when it is the newest, so nothing is carried then.
 */
export function carryTranscript(sourceProjects: readonly string[], targetProjects: string, id: string, now: number, fsx: AccountFs = accountFs): CarryResult {
  const real = (p: string): string => fsx.realpath(p) ?? p
  const target = real(targetProjects)
  const found = findTranscript(sourceProjects, id, fsx)
  if (!found) return { kind: 'not-found' }
  if (real(found.projects) === target) return { kind: 'shared' }
  if (!fsx.exists(targetProjects)) fsx.mkdir(targetProjects)
  const folder = join(targetProjects, found.folder)
  if (!fsx.exists(folder)) fsx.mkdir(folder)
  const dst = join(folder, `${id}.jsonl`)
  const there = fsx.stat(dst)
  let kept: string | undefined
  if (there && !(there.mtimeMs <= found.mtimeMs && there.size <= found.size)) {
    kept = `${id}.jsonl.bak-${now}`
    fsx.rename(dst, join(folder, kept))
  }
  fsx.copyFile(join(found.projects, found.folder, `${id}.jsonl`), dst)
  const sub = join(found.projects, found.folder, id)
  if (fsx.stat(sub)?.isDirectory()) copyFolder(sub, join(folder, id), fsx)
  return kept ? { kind: 'carried', kept } : { kind: 'carried' }
}
