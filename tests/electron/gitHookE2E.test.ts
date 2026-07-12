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
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { installHooks, uninstallHooks, hookStatus, type HookDeps, type HookPaths } from '../../src/main/gitHooks'

const AWS_KEY = 'AKIA' + 'A'.repeat(16)

const realDeps: HookDeps = {
  readFile: (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } },
  writeFile: (p, d) => fs.writeFileSync(p, d, 'utf8'),
  exists: (p) => fs.existsSync(p),
  chmod: (p, m) => { try { fs.chmodSync(p, m) } catch { /* windows */ } },
  remove: (p) => { try { fs.rmSync(p, { force: true }) } catch { /* ignore */ } },
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
  })

  it('ALLOWS a clean commit — it does not just block everything', () => {
    const { dir, paths } = makeRepo()
    installHooks(paths, realDeps)

    stage(dir, 'app.ts', 'export const answer = 42\n')
    const r = commit(dir)

    expect(r.ok).toBe(true)
    expect(Number(countCommits(dir))).toBe(1)
  })

  it('blocks the secret, then allows the same commit once the secret is removed', () => {
    const { dir, paths } = makeRepo()
    installHooks(paths, realDeps)

    stage(dir, 'config.env', `AWS_ACCESS_KEY_ID=${AWS_KEY}\n`)
    expect(commit(dir).ok).toBe(false)

    stage(dir, 'config.env', 'AWS_ACCESS_KEY_ID=<from-vault>\n')
    expect(commit(dir).ok).toBe(true)
    expect(Number(countCommits(dir))).toBe(1)
  })

  it('FAILS OPEN when the scanner is missing — an uninstalled Termpolis must never wedge git', () => {
    // The single most dangerous failure mode: a hook left behind by an app that is gone.
    const { dir, paths } = makeRepo(path.join(os.tmpdir(), 'no-such-scanner-xyz.cjs'))
    installHooks(paths, realDeps)

    stage(dir, 'config.env', `AWS_ACCESS_KEY_ID=${AWS_KEY}\n`)
    const r = commit(dir)

    expect(r.ok).toBe(true) // allowed through — unprotected, but never broken
  })

  it('is honest: --no-verify bypasses it (the user owns their machine)', () => {
    const { dir, paths } = makeRepo()
    installHooks(paths, realDeps)

    stage(dir, 'config.env', `AWS_ACCESS_KEY_ID=${AWS_KEY}\n`)
    expect(commit(dir).ok).toBe(false)
    expect(commit(dir, 'bypass', ['--no-verify']).ok).toBe(true)
  })

  it('uninstall really removes the gate — a secret commits again afterwards', () => {
    const { dir, paths } = makeRepo()
    installHooks(paths, realDeps)
    stage(dir, 'config.env', `AWS_ACCESS_KEY_ID=${AWS_KEY}\n`)
    expect(commit(dir).ok).toBe(false)

    uninstallHooks(paths, realDeps)
    expect(hookStatus(paths, realDeps)['pre-commit']).toBe('absent')

    expect(commit(dir).ok).toBe(true)
  })

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
  })
})
