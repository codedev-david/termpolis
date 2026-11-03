// Reading a repository's refs WITHOUT a process and without a synchronous file call.
//
// The workflow trigger supervisor (workflow/triggers.ts) and the learning signals (learningSignals.ts) both look at
// where HEAD and a branch point, every 15 s, for every open repository. They used to do it with existsSync and
// readFileSync on the main thread: four or five synchronous file calls per repository per tick, each of which has been
// measured at 8-56 ms (p50) and up to 1.5 s (p99) on a busy Windows laptop where the endpoint scanner inspects every
// open. Ten repositories open is fifty such calls every 15 s, on the thread that echoes keystrokes.
//
// These are the same reads, in the same order, with the same answers, on the thread pool. The synchronous originals stay
// in workflow/triggers.ts (the tests that pin the git formats use them, and the injected fakes of the older tests are
// synchronous); `asAsync` lets a caller that only has the synchronous kind use the same code path.

import { join } from 'path'
import { promises as fsp } from 'fs'
import { forEachBufferLine } from './fileLines'

/** What the plumbing needs from a file system. */
export interface AsyncFsLike {
  exists(p: string): Promise<boolean>
  readText(p: string): Promise<string>
  readBytes(p: string): Promise<Uint8Array>
}

export const nodeAsyncFs: AsyncFsLike = {
  async exists(p) {
    try {
      await fsp.access(p)
      return true
    } catch {
      return false
    }
  },
  readText: (p) => fsp.readFile(p, 'utf8'),
  readBytes: (p) => fsp.readFile(p),
}

/** The synchronous kind (an older fake, a test) as the asynchronous one: same answers, one microtask later. */
export function asAsync(
  fs: { existsSync(p: string): boolean; readFileSync(p: string, enc?: unknown): string },
  readBytes: (p: string) => Uint8Array,
): AsyncFsLike {
  return {
    exists: async (p) => fs.existsSync(p),
    readText: async (p) => fs.readFileSync(p, 'utf8'),
    readBytes: async (p) => readBytes(p),
  }
}

/** Resolve the real git dir for a working tree. `.git` is usually a directory but is a FILE containing
 *  `gitdir: <path>` inside a worktree or submodule. */
export async function gitDirOfAsync(cwd: string, fs: AsyncFsLike): Promise<string | null> {
  const dotGit = join(cwd, '.git')
  if (!(await fs.exists(dotGit))) return null
  try {
    // A directory read as utf8 throws (EISDIR); that's the common, happy path.
    const text = await fs.readText(dotGit)
    const m = /^gitdir:\s*(.+)$/m.exec(text)
    if (!m) return dotGit
    const p = m[1].trim()
    return /^([A-Za-z]:[\\/]|[\\/])/.test(p) ? p : join(cwd, p)
  } catch {
    return dotGit
  }
}

/** The symbolic ref HEAD points at (e.g. `refs/heads/main`), or null when HEAD is detached or unreadable. */
export async function headRefAsync(gitDir: string, fs: AsyncFsLike): Promise<string | null> {
  try {
    const head = (await fs.readText(join(gitDir, 'HEAD'))).trim()
    const m = /^ref:\s*(.+)$/.exec(head)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

/** Resolve a ref to a sha: loose ref file first, then packed-refs (walked BY BYTES, see resolveRef in triggers.ts). */
export async function resolveRefAsync(gitDir: string, ref: string, fs: AsyncFsLike): Promise<string | null> {
  const loose = join(gitDir, ...ref.split('/'))
  if (await fs.exists(loose)) {
    try {
      const raw = (await fs.readText(loose)).trim()
      // A loose ref can itself be symbolic (rare, but legal).
      const sym = /^ref:\s*(.+)$/.exec(raw)
      if (sym) return await resolveRefAsync(gitDir, sym[1].trim(), fs)
      if (/^[0-9a-f]{7,64}$/i.test(raw)) return raw
    } catch {
      /* fall through to packed-refs */
    }
  }
  const packed = join(gitDir, 'packed-refs')
  if (!(await fs.exists(packed))) return null
  try {
    let found: string | null = null
    forEachBufferLine(Buffer.from(await fs.readBytes(packed)), (line) => {
      const t = line.trim()
      if (!t || t.startsWith('#') || t.startsWith('^')) return
      const sp = t.indexOf(' ')
      if (sp > 0 && t.slice(sp + 1).trim() === ref) {
        found = t.slice(0, sp)
        return false // stop scanning
      }
    })
    if (found) return found
  } catch {
    /* unreadable packed-refs — treat as unresolved */
  }
  return null
}

/** The ref a git trigger should follow, given its config (branch and remote as the workflow names them). */
export async function targetRefAsync(
  type: 'gitCommit' | 'gitPush' | string,
  cfg: { branch?: string; remote?: string },
  gitDir: string,
  fs: AsyncFsLike,
): Promise<string | null> {
  const branch = (cfg.branch ?? '').trim()
  if (type === 'gitCommit') {
    return branch ? `refs/heads/${branch}` : headRefAsync(gitDir, fs)
  }
  const remote = (cfg.remote ?? '').trim() || 'origin'
  const short = branch || ((await headRefAsync(gitDir, fs)) ?? '').replace(/^refs\/heads\//, '')
  return short ? `refs/remotes/${remote}/${short}` : null
}
