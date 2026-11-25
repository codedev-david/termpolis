// THE PROOF. Real git, real repo, real hook, real `git commit`.
//
// Every other test in this feature is a unit test against an injected fake. None of them can
// tell you whether git actually ABORTS. This one runs `git commit` for real against a staged
// diff carrying a secret and asserts the commit does not happen — which is the only claim the
// feature actually makes.
//
// It also pins the two properties that decide whether this is safe to ship at all:
//   - it FAILS OPEN (a missing scanner / missing node must never wedge someone's commit), and
//   - it is HONEST (`--no-verify` bypasses it; we do not pretend otherwise).
//
// Secret samples use repeated characters: they satisfy the rule regexes while failing entropy
// heuristics, so GitHub push protection will not block this file.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { installHooks, uninstallHooks, hookStatus, hookFileKind, unsafeHook, shieldHooksAllowed, shieldHooksVerdict, type HookDeps, type HookPaths } from '../../src/main/gitHooks'

const AWS_KEY = 'AKIA' + 'A'.repeat(16)

const realDeps: HookDeps = {
  readFile: (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } },
  writeFile: (p, d) => fs.writeFileSync(p, d, 'utf8'),
  exists: (p) => fs.existsSync(p),
  chmod: (p, m) => { try { fs.chmodSync(p, m) } catch { /* windows */ } },
  remove: (p) => { try { fs.rmSync(p, { force: true }) } catch { /* ignore */ } },
  fileKind: (p) => hookFileKind(() => fs.lstatSync(p)),
}

const SCANNER = path.resolve(__dirname, '../../src/mcp-adapter/termpolis-githook.cjs')

let gitAvailable = true
beforeAll(() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' })
  } catch {
    gitAvailable = false
  }
})

const repos: string[] = []
afterEach(() => {
  for (const r of repos.splice(0)) {
    try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

/** A real, throwaway git repo with the Commit Shield hooks installed. */
function makeRepo(scriptPath = SCANNER): { dir: string; paths: HookPaths } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-e2e-'))
  repos.push(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@example.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })

  const hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: dir }).toString().trim()
  const abs = path.resolve(dir, hooksDir)
  fs.mkdirSync(abs, { recursive: true })

  return { dir, paths: { hooksDir: abs, nodePath: process.execPath, scriptPath } }
}

function stage(dir: string, file: string, content: string): void {
  fs.writeFileSync(path.join(dir, file), content, 'utf8')
  execFileSync('git', ['add', file], { cwd: dir })
}

/** Run `git commit` and report what actually happened. */
function commit(dir: string, msg = 'test', extra: string[] = []): { ok: boolean; out: string } {
  try {
    execFileSync('git', ['commit', '-m', msg, ...extra], { cwd: dir, stdio: 'pipe' })
    return { ok: true, out: '' }
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer }
    return { ok: false, out: (err.stdout?.toString() || '') + (err.stderr?.toString() || '') }
  }
}

const countCommits = (dir: string): number => {
  try {
    return execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, stdio: 'pipe' }).toString().trim() as unknown as number
  } catch {
    return 0 // no commits yet
  }
}

describe.skipIf(!gitAvailable)('Commit Shield — REAL git end to end', () => {
  it('BLOCKS a real `git commit` whose staged diff carries a secret', () => {
    const { dir, paths } = makeRepo()
    installHooks(paths, realDeps)

    stage(dir, 'config.env', `AWS_ACCESS_KEY_ID=${AWS_KEY}\n`)
    const r = commit(dir)

    expect(r.ok).toBe(false) // git ABORTED — this is the whole feature
    expect(r.out).toMatch(/AWS Access Key ID|secret/i)
    expect(Number(countCommits(dir))).toBe(0) // and nothing landed in history
  }, 30_000)

  it('ALLOWS a clean commit — it does not just block everything', () => {
    const { dir, paths } = makeRepo()
    installHooks(paths, realDeps)

    stage(dir, 'app.ts', 'export const answer = 42\n')
    const r = commit(dir)

    expect(r.ok).toBe(true)
    expect(Number(countCommits(dir))).toBe(1)
  }, 30_000)

  it('blocks the secret, then allows the same commit once the secret is removed', () => {
    const { dir, paths } = makeRepo()
    installHooks(paths, realDeps)

    stage(dir, 'config.env', `AWS_ACCESS_KEY_ID=${AWS_KEY}\n`)
    expect(commit(dir).ok).toBe(false)

    stage(dir, 'config.env', 'AWS_ACCESS_KEY_ID=<from-vault>\n')
    expect(commit(dir).ok).toBe(true)
    expect(Number(countCommits(dir))).toBe(1)
  }, 30_000)

  it('FAILS OPEN when the scanner is missing — an uninstalled Termpolis must never wedge git', () => {
    // The single most dangerous failure mode: a hook left behind by an app that is gone.
    const { dir, paths } = makeRepo(path.join(os.tmpdir(), 'no-such-scanner-xyz.cjs'))
    installHooks(paths, realDeps)

    stage(dir, 'config.env', `AWS_ACCESS_KEY_ID=${AWS_KEY}\n`)
    const r = commit(dir)

    expect(r.ok).toBe(true) // allowed through — unprotected, but never broken
  }, 30_000)

  it('is honest: --no-verify bypasses it (the user owns their machine)', () => {
    const { dir, paths } = makeRepo()
    installHooks(paths, realDeps)

    stage(dir, 'config.env', `AWS_ACCESS_KEY_ID=${AWS_KEY}\n`)
    expect(commit(dir).ok).toBe(false)
    expect(commit(dir, 'bypass', ['--no-verify']).ok).toBe(true)
  }, 30_000)

  it('uninstall really removes the gate — a secret commits again afterwards', () => {
    const { dir, paths } = makeRepo()
    installHooks(paths, realDeps)
    stage(dir, 'config.env', `AWS_ACCESS_KEY_ID=${AWS_KEY}\n`)
    expect(commit(dir).ok).toBe(false)

    uninstallHooks(paths, realDeps)
    expect(hookStatus(paths, realDeps)['pre-commit']).toBe('absent')

    expect(commit(dir).ok).toBe(true)
  }, 30_000)

  // #1. The scanner runs in the repository being committed. A relative PATH entry names a folder inside it, so a bare
  // `git` would start the one planted there (measured: Node 24 on Windows runs tools\git.exe for PATH=tools;...). The
  // stand-in records that it ran; the scanner must start the real git, scan the real diff, and block the secret.
  it('starts the real git by its full path, never a git planted in the repository behind a relative PATH entry', () => {
    const { dir } = makeRepo()
    stage(dir, 'config.env', `AWS_ACCESS_KEY_ID=${AWS_KEY}\n`)
    const tools = path.join(dir, 'tools')
    fs.mkdirSync(tools)
    const marker = path.join(dir, 'planted-git-ran')
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `tools${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}` }
    delete env.Path // one spelling, so the relative entry is the one Node and the scanner both read
    if (process.platform === 'win32') {
      // The stand-in has to be a real .exe: node itself, under the name git.exe, with a preload that records it ran.
      const planted = path.join(tools, 'git.exe')
      try { fs.linkSync(process.execPath, planted) } catch { fs.copyFileSync(process.execPath, planted) }
      const preload = path.join(dir, 'record.cjs')
      fs.writeFileSync(preload, `if (require('path').basename(process.execPath).toLowerCase() === 'git.exe') require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`)
      env.NODE_OPTIONS = `--require "${preload.replace(/\\/g, '/')}"`
    } else {
      fs.writeFileSync(path.join(tools, 'git'), `#!/bin/sh\necho ran > '${marker}'\nexit 0\n`, { mode: 0o755 })
    }
    // The premise, on this machine: a bare `git` with this PATH, in this folder, starts the planted one. (Not with
    // `--version`: node answers that before any --require preload runs, so the stand-in would not record itself.)
    try { execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, env, stdio: 'pipe' }) } catch { /* the stand-in fails; it ran */ }
    expect(fs.existsSync(marker), 'the planted git runs for a bare `git` here').toBe(true)
    fs.rmSync(marker)

    const r = spawnSync(process.execPath, [SCANNER, 'pre-commit'], { cwd: dir, env, encoding: 'utf8' })
    expect(fs.existsSync(marker)).toBe(false) // the planted git never ran
    expect(r.status).toBe(1) // the real git's staged diff was scanned, and the secret blocks
    expect(r.stderr).toMatch(/AWS Access Key ID/)
  }, 30_000)

  // #36 (WPS M7). With real git: the repository's own core.hooksPath pointing outside it is refused, and the places a
  // shield belongs (the git folder, husky's .husky, a linked worktree's common hooks) are allowed.
  it("refuses a hooks folder the repository's own config puts outside it, with real git's answers", async () => {
    const { dir } = makeRepo()
    const run = (cwd: string) => async (args: string[]): Promise<string> =>
      execFileSync('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args], { cwd, stdio: 'pipe' }).toString()
    const where = (cwd: string): string => path.resolve(cwd, execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd }).toString().trim())
    const allowed = (cwd: string): Promise<boolean> =>
      shieldHooksAllowed({ repo: cwd, hooksDir: where(cwd), git: run(cwd), readFile: readText, path, platform: process.platform, realpath: (p) => fs.promises.realpath(p) })

    expect(await allowed(dir)).toBe(true) // .git/hooks
    execFileSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: dir })
    expect(await allowed(dir)).toBe(true)
    execFileSync('git', ['config', 'core.hooksPath', '../elsewhere'], { cwd: dir })
    expect(where(dir)).toBe(path.resolve(dir, '../elsewhere'))
    expect(await allowed(dir)).toBe(false)
    execFileSync('git', ['config', '--unset', 'core.hooksPath'], { cwd: dir })

    stage(dir, 'app.ts', 'export const x = 1\n')
    expect(commit(dir).ok).toBe(true)
    const wt = path.join(dir, '..', path.basename(dir) + '-wt')
    repos.push(wt)
    execFileSync('git', ['worktree', 'add', '-q', wt], { cwd: dir })
    expect(await allowed(wt)).toBe(true) // the main repository's .git/hooks, through the common dir
  }, 30_000)

  it('does not destroy a pre-existing foreign hook — it still runs, and still gates the commit', () => {
    const { dir, paths } = makeRepo()
    // Someone already has husky/lint-staged. Blowing it away would be unforgivable.
    const foreign = path.join(paths.hooksDir, 'pre-commit')
    fs.writeFileSync(foreign, '#!/bin/sh\necho "FOREIGN_HOOK_RAN"\nexit 0\n', 'utf8')
    try { fs.chmodSync(foreign, 0o755) } catch { /* windows */ }

    installHooks(paths, realDeps)
    stage(dir, 'app.ts', 'export const x = 1\n')
    const r = commit(dir)

    expect(r.ok).toBe(true)
    expect(r.out + fs.readFileSync(foreign, 'utf8')).toContain('FOREIGN_HOOK_RAN')

    // …and our shield is still armed on top of theirs.
    stage(dir, 'config.env', `AWS_ACCESS_KEY_ID=${AWS_KEY}\n`)
    expect(commit(dir, 'secret').ok).toBe(false)
  }, 30_000)
})

const readText = (p: string): Promise<string | null> => fs.promises.readFile(p, 'utf8').then((t) => t, () => null)

/** A git that reads no global or system config, so a core.hooksPath on the machine running the tests cannot decide
 *  what these tests assert. */
const ISOLATED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-e2e-config-'))
const ISOLATED_CONFIG = path.join(ISOLATED_DIR, 'gitconfig')
fs.writeFileSync(ISOLATED_CONFIG, '')
afterAll(() => fs.rmSync(ISOLATED_DIR, { recursive: true, force: true }))
const isolatedEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: ISOLATED_CONFIG, GIT_CONFIG_NOSYSTEM: '1' }
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, env: isolatedEnv, stdio: 'pipe' }).toString()
const hooksOf = (cwd: string): string => path.resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'hooks']).trim())
const factsIn = (cwd: string, hooksDir = hooksOf(cwd)): Parameters<typeof shieldHooksVerdict>[0] => ({
  repo: cwd,
  hooksDir,
  git: async (args) => git(cwd, ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args]),
  readFile: readText,
  path,
  platform: process.platform,
  realpath: (p) => fs.promises.realpath(p),
})
const allowedIn = (cwd: string, hooksDir = hooksOf(cwd)): Promise<boolean> => shieldHooksAllowed(factsIn(cwd, hooksDir))

/** A throwaway folder, cleaned after each test. */
function scratch(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  repos.push(dir)
  return dir
}

/** A repository with one commit. */
function committedRepo(prefix = 'shield-e2e-repo-'): string {
  const dir = scratch(prefix)
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 't@example.test'])
  git(dir, ['config', 'user.name', 'Test'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  git(dir, ['add', 'a.txt'])
  git(dir, ['commit', '-q', '-m', 'one'])
  return dir
}

/** Whether this machine lets the test make a symbolic link to a file. Windows needs Developer Mode or an elevated
 *  shell for one; a junction (a folder link) needs neither. Decided here, at load: vitest reads runIf before any
 *  beforeAll runs. */
const canSymlinkFile = ((): boolean => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-e2e-symlink-probe-'))
  try {
    fs.writeFileSync(path.join(dir, 'target'), 'x')
    fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), 'file')
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})()

// I1 on a real disk. Every write follows a link, so a hook file that links outside the repository would put the
// shield and an exec bit into whatever it names (a shell profile). Install and uninstall leave a link alone.
describe.skipIf(!gitAvailable)('Commit Shield — a hook file that is a link, on a real disk (I1)', () => {
  function outsideTarget(): { file: string; bytes: string } {
    const file = path.join(scratch('shield-e2e-outside-'), 'profile.sh')
    const bytes = '#!/bin/sh\n# the person\'s own file, outside the repository\nexport KEEP=1\n'
    fs.writeFileSync(file, bytes)
    return { file, bytes }
  }

  it('a pre-commit hard-linked to a file outside the repository is never written, and uninstall leaves it', () => {
    const { paths } = makeRepo()
    const target = outsideTarget()
    const hook = path.join(paths.hooksDir, 'pre-commit')
    fs.linkSync(target.file, hook)
    expect(unsafeHook(paths, realDeps)).toEqual({ name: 'pre-commit', kind: 'link' })
    expect(installHooks(paths, realDeps)).toEqual(['pre-push'])
    expect(fs.readFileSync(target.file, 'utf8')).toBe(target.bytes)
    // Our block in the shared file (written by someone else): uninstall still does not touch it.
    const ours = fs.readFileSync(path.join(paths.hooksDir, 'pre-push'), 'utf8')
    fs.writeFileSync(target.file, ours)
    expect(uninstallHooks(paths, realDeps)).toEqual(['pre-push'])
    expect(fs.readFileSync(target.file, 'utf8')).toBe(ours)
    expect(fs.existsSync(hook)).toBe(true)
  }, 30_000)

  it.runIf(canSymlinkFile)('a pre-commit that is a symbolic link outside the repository is never written, and uninstall leaves it (runs where this machine allows a file symlink)', () => {
    const { paths } = makeRepo()
    const target = outsideTarget()
    const hook = path.join(paths.hooksDir, 'pre-commit')
    fs.symlinkSync(target.file, hook, 'file')
    expect(unsafeHook(paths, realDeps)).toEqual({ name: 'pre-commit', kind: 'link' })
    expect(installHooks(paths, realDeps)).toEqual(['pre-push'])
    expect(fs.readFileSync(target.file, 'utf8')).toBe(target.bytes)
    const ours = fs.readFileSync(path.join(paths.hooksDir, 'pre-push'), 'utf8')
    fs.writeFileSync(target.file, ours)
    expect(uninstallHooks(paths, realDeps)).toEqual(['pre-push'])
    expect(fs.readFileSync(target.file, 'utf8')).toBe(ours)
    // A link that leads nowhere is still a link: install never creates the file it names.
    fs.rmSync(target.file)
    expect(installHooks(paths, realDeps)).toEqual(['pre-push'])
    expect(fs.existsSync(target.file)).toBe(false)
  }, 30_000)

  it('a hooks folder that is a junction (a folder symlink off Windows) to a folder outside the repository is refused', async () => {
    const repo = committedRepo()
    const outside = scratch('shield-e2e-outside-hooks-')
    const hooks = hooksOf(repo)
    fs.rmSync(hooks, { recursive: true, force: true })
    fs.symlinkSync(outside, hooks, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await allowedIn(repo, hooks)).toBe(false)
    // The same folder, really inside: allowed (the refusal is the link's, not the folder's).
    fs.rmSync(hooks, { recursive: true, force: true })
    expect(await allowedIn(repo, hooks)).toBe(true)
  }, 30_000)
})

// M2 on a real disk. A `.git` file names the git folder, and a `commondir` file in that folder names the common one:
// either can point at another repository, whose hooks folder is not this one's to write. git's own layouts pass.
describe.skipIf(!gitAvailable)("Commit Shield — a `.git` file that points at another repository's git folder (M2)", () => {
  const dotGitFile = (dir: string, gitdir: string): void => fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${gitdir}\n`)

  it('allows a plain repository, a linked worktree and a submodule', async () => {
    const repo = committedRepo()
    expect(await allowedIn(repo)).toBe(true)
    const wt = path.join(path.dirname(repo), path.basename(repo) + '-wt')
    repos.push(wt)
    git(repo, ['worktree', 'add', '-q', wt])
    expect(hooksOf(wt)).toBe(path.join(repo, '.git', 'hooks'))
    expect(await allowedIn(wt)).toBe(true)
    const lib = committedRepo('shield-e2e-lib-')
    git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'sub'])
    const sub = path.join(repo, 'sub')
    expect(hooksOf(sub)).toBe(path.join(repo, '.git', 'modules', 'sub', 'hooks'))
    expect(await allowedIn(sub)).toBe(true)
  }, 60_000)

  it("refuses a `.git` file naming another repository's git folder, its worktree's or its submodule's", async () => {
    const victim = committedRepo('shield-e2e-victim-')
    const wt = path.join(path.dirname(victim), path.basename(victim) + '-wt')
    repos.push(wt)
    git(victim, ['worktree', 'add', '-q', wt])
    const lib = committedRepo('shield-e2e-lib-')
    git(victim, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'sub'])
    const victimHooks = path.join(victim, '.git', 'hooks')

    for (const gitdir of [path.join(victim, '.git'), path.join(victim, '.git', 'worktrees', path.basename(wt)), path.join(victim, '.git', 'modules', 'sub')]) {
      const attacker = scratch('shield-e2e-attacker-')
      dotGitFile(attacker, gitdir)
      expect(hooksOf(attacker).startsWith(victim)).toBe(true) // git really does send the hooks there
      expect(await allowedIn(attacker), gitdir).toBe(false)
    }
    // A git folder inside the attacker's own tree whose commondir names the victim's: git takes the victim's hooks.
    const attacker = scratch('shield-e2e-attacker-')
    const inner = path.join(attacker, '.gitinner')
    fs.mkdirSync(inner)
    fs.writeFileSync(path.join(inner, 'HEAD'), 'ref: refs/heads/main\n')
    fs.writeFileSync(path.join(inner, 'commondir'), path.join(victim, '.git') + '\n')
    dotGitFile(attacker, inner)
    expect(hooksOf(attacker)).toBe(victimHooks)
    expect(await allowedIn(attacker)).toBe(false)
  }, 60_000)

  it('refuses a `git init --separate-git-dir` repository (it has no core.worktree to tell it from the attack)', async () => {
    const tree = scratch('shield-e2e-sep-')
    const gitDir = path.join(scratch('shield-e2e-sepdir-'), 'repo.git')
    git(tree, ['init', '-q', '--separate-git-dir', gitDir])
    expect(await allowedIn(tree)).toBe(false)
    // HOLD-A N2: and it is the git-folder refusal, not the core.hooksPath one.
    expect(await shieldHooksVerdict(factsIn(tree))).toBe('gitDirOutside')
    git(tree, ['config', 'core.hooksPath', '../elsewhere'])
    expect(await shieldHooksVerdict(factsIn(tree))).toBe('hooksPath')
  }, 30_000)
})

// M1 on a real disk. The hook runs node only by the full path it was installed with. Where that is gone it skips the
// scan with a line on stderr, and a node planted in the repository on a full PATH entry never runs.
describe.skipIf(!gitAvailable)('Commit Shield — node moved after install (M1)', () => {
  it('skips the scan with a stderr line and never runs a node planted on PATH inside the repository', () => {
    const { dir, paths } = makeRepo()
    const gone = path.join(path.dirname(dir), 'no-such-node-' + path.basename(dir), process.platform === 'win32' ? 'node.exe' : 'node')
    installHooks({ ...paths, nodePath: gone }, realDeps)
    const tools = path.join(dir, 'tools')
    fs.mkdirSync(tools)
    const marker = path.join(dir, 'planted-node-ran')
    // A shell script named node: git's sh runs it for a bare `node` on this PATH, Git for Windows' sh included.
    fs.writeFileSync(path.join(tools, 'node'), `#!/bin/sh\necho ran > '${marker.replace(/\\/g, '/')}'\nexit 0\n`, { mode: 0o755 })
    stage(dir, 'config.env', `AWS_ACCESS_KEY_ID=${AWS_KEY}\n`)
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${tools}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}` }
    delete env.Path
    const r = spawnSync('git', ['commit', '-m', 'moved node'], { cwd: dir, env, encoding: 'utf8' })
    expect(fs.existsSync(marker)).toBe(false) // the planted node never ran
    expect(r.status).toBe(0) // fail open: the commit goes through, unscanned
    expect(r.stderr).toContain(`Termpolis Commit Shield skipped: node was not found at ${gone.replace(/\\/g, '/')}. Protect this repository again in Termpolis.`)
  }, 30_000)
})
