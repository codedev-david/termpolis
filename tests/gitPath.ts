/**
 * Make `git` resolvable to the test suite regardless of which shell launched it.
 *
 * Four test files shell out to a real git (gitHookE2E, mainTailCoverage,
 * discoverRepoFilesFallback, codeIngest). They resolve it the way every child
 * process does: by scanning PATH. So whether they pass depends on something
 * that has nothing to do with the code under test — the PATH of whatever
 * launched vitest.
 *
 * That is not hypothetical. On this machine the persistent User PATH contains
 * `C:\Program Files\Git\bin`, git is installed and working, and Git Bash runs
 * the suite green — but a PowerShell session spawned by an AI coding tool
 * starts from a PATH that omits the User entries entirely. Same repo, same
 * commit, same git install, 12 failures that say `spawnSync git ENOENT`. The
 * suite was reporting on its launcher, not on the code.
 *
 * Fixing that by editing a shell profile only fixes the shell you edited. The
 * suite has to be correct under Git Bash, PowerShell, cmd, CI and any AI
 * terminal, so the knowledge of where git lives belongs here, in the harness,
 * where every runner picks it up for free.
 *
 * Everything below takes env/platform/exists as arguments rather than reading
 * globals, so the Windows paths are testable on a Linux CI runner and vice
 * versa — these functions must be correct on platforms this file will never be
 * executed on.
 */
import { existsSync } from 'node:fs'

export type ExistsFn = (p: string) => boolean
export type EnvLike = Record<string, string | undefined>

/** Executables that count as "git" on a given platform. */
export function gitBinaryNames(platform: string): string[] {
  // `git.cmd` matters for installs that ship only the shim (some scoop/winget
  // layouts), which a `git.exe`-only probe would walk straight past.
  return platform === 'win32' ? ['git.exe', 'git.cmd'] : ['git']
}

function sepFor(platform: string): string {
  return platform === 'win32' ? ';' : ':'
}

/**
 * Which key this particular env object spells PATH with.
 *
 * Node makes `process.env.PATH` work case-insensitively on Windows, but that
 * magic is on the real process.env only — the actual key there is usually
 * `Path`. Writing a fresh `PATH` key into a plain object would leave the
 * original `Path` in place and the change would silently do nothing.
 */
export function pathKey(env: EnvLike): string {
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') return k
  return 'PATH'
}

/** Split a PATH value into directories, dropping the empties and stray quotes Windows allows. */
export function splitPath(value: string | undefined, platform: string): string[] {
  return (value ?? '')
    .split(sepFor(platform))
    .map(s => s.trim().replace(/^"+|"+$/g, ''))
    .filter(Boolean)
}

/**
 * Join a directory and a filename for `platform`, NOT for the host.
 * path.join() would bake in the running machine's separator and turn a Windows
 * candidate into `C:\Program Files\Git\cmd/git.exe` when these tests run on Linux.
 */
export function childPath(dir: string, name: string, platform: string): string {
  const sep = platform === 'win32' ? '\\' : '/'
  return /[\\/]$/.test(dir) ? dir + name : dir + sep + name
}

/** First directory in `dirs` that actually contains a git executable. */
export function findGitDir(dirs: string[], platform: string, exists: ExistsFn): string | null {
  for (const dir of dirs) {
    for (const name of gitBinaryNames(platform)) {
      if (exists(childPath(dir, name, platform))) return dir
    }
  }
  return null
}

/** Places git plausibly lives, best hint first. Existence is checked by the caller. */
export function candidateGitDirs(env: EnvLike, platform: string): string[] {
  const out: string[] = []
  const push = (d: string | undefined): void => {
    if (d && d.trim()) out.push(d.replace(/[\\/]+$/, ''))
  }

  if (platform !== 'win32') {
    push('/usr/bin')
    push('/usr/local/bin')
    push('/opt/homebrew/bin') // Apple silicon Homebrew
    push('/opt/local/bin') // MacPorts
    return [...new Set(out)]
  }

  // Git for Windows exports EXEPATH (and git itself exports GIT_EXEC_PATH) into
  // every process it spawns, and those values name the REAL install directory.
  // That beats guessing at Program Files, which is wrong the moment someone
  // installs to D:\ or via scoop — and it is present even in the broken case
  // that motivated this file: EXEPATH was set while PATH had been stripped.
  for (const hint of [env.EXEPATH, env.GIT_EXEC_PATH]) {
    if (!hint) continue
    const root = hint.replace(/[\\/]+$/, '')
    push(root)
    push(root + '\\cmd')
    push(root + '\\bin')
    // The hint may already point AT bin/ or libexec/git-core, so climb one
    // level and try that directory's siblings too.
    const parent = root.replace(/[\\/][^\\/]+$/, '')
    if (parent && parent !== root) {
      push(parent + '\\cmd')
      push(parent + '\\bin')
    }
  }

  const localPrograms = env.LOCALAPPDATA ? env.LOCALAPPDATA + '\\Programs' : undefined
  for (const base of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)'], localPrograms]) {
    if (!base) continue
    // `cmd` before `bin`: cmd\git.exe is the launcher Git for Windows itself
    // puts on PATH for non-MSYS shells, while bin\git.exe is the MSYS build
    // intended for Git Bash. Both run, but prefer the one the installer meant.
    push(base + '\\Git\\cmd')
    push(base + '\\Git\\bin')
  }

  return [...new Set(out)]
}

export type EnsureResult =
  | { status: 'already-resolvable'; dir: string }
  | { status: 'prepended'; dir: string }
  | { status: 'unresolved'; dir: null }

/**
 * Ensure a git executable is reachable via `env`'s PATH, mutating it only when
 * it is not already. Returns what it did so callers can report honestly.
 */
export function ensureGitOnPath(
  env: EnvLike = process.env as EnvLike,
  platform: string = process.platform,
  exists: ExistsFn = existsSync,
): EnsureResult {
  const key = pathKey(env)
  const current = splitPath(env[key], platform)

  // Already fine — touch nothing. A shell that set PATH deliberately (a pinned
  // git version, a wrapper script) keeps whatever it chose.
  const already = findGitDir(current, platform, exists)
  if (already) return { status: 'already-resolvable', dir: already }

  const found = findGitDir(candidateGitDirs(env, platform), platform, exists)
  if (!found) return { status: 'unresolved', dir: null }

  const sep = sepFor(platform)
  env[key] = current.length ? found + sep + current.join(sep) : found
  return { status: 'prepended', dir: found }
}
