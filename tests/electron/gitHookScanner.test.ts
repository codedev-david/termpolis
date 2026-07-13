// The STANDALONE git-hook scanner (src/mcp-adapter/termpolis-githook.cjs).
//
// This is the half of the Commit Shield that has to work with Termpolis CLOSED: git
// spawns a plain `node` process, so there is no Electron, no bundler, no MCP, no HTTP.
// A hook that only protects you while the app happens to be running is worse than no
// hook, because you would still believe you had one.
//
// Two invariants carry the whole feature, and both are pinned here:
//   1. Only a POSITIVE secret match may ever exit 1. Every internal error — no git, no
//      repo, git exploded, unreadable settings, a thrown exception, a nonsense argv —
//      exits 0. A security net must never wedge a commit for a reason unrelated to
//      secrets.
//   2. The toggle fails SECURE while errors fail OPEN. They are different axes: a
//      missing/corrupt settings file means "scan" (commitShield defaults ON, matching
//      initAiSecurity), but a missing git means "allow".
//
// NOTE: secret samples use repeated characters on purpose — they satisfy the rule
// regexes while failing entropy heuristics, so GitHub push protection won't block this
// test file (see reference_secret_scanner_test_gotcha).
import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const require_ = createRequire(import.meta.url)
const HOOK_PATH = join(process.cwd(), 'src', 'mcp-adapter', 'termpolis-githook.cjs')

interface Hit {
  rule: string
  label: string
  sample: string
  file: string
  line: number
}
interface ScanRes {
  hitCount: number
  hits: Hit[]
  scannedBytes: number
}
interface Settings {
  commitShield: boolean
}
interface Deps {
  git?: (args: string[]) => string
  readSettings?: () => Settings
  stderr?: (msg: string) => void
  cwd?: string
}

const hook = require_(HOOK_PATH) as {
  main: (argv: string[], deps?: Deps) => number
  scanDiffText: (text: unknown) => ScanRes
  readSettings: (file?: string) => Settings
  userDataDir: () => string
  settingsPath: () => string
  formatBlock: (res: ScanRes, mode: string) => string
  redactSample: (s: string) => string
  GIT_ARGS: Record<string, string[]>
}

// Entropy-free stand-ins: they match the rule regexes, but no scanner will ever
// mistake them for a live credential.
const AWS_KEY = 'AKIA' + 'A'.repeat(16)
const AWS_KEY_2 = 'AKIA' + 'B'.repeat(16)
const OPENAI_KEY = 'sk-' + 'a'.repeat(24)

const STAGED = 'diff --cached --no-color --no-ext-diff'
const UNPUSHED = 'log -p --no-color --not --remotes'

/** A fake git that answers only the exact argv the scanner is expected to run, and
 *  records every call so we can prove pre-push never peeks at the staged diff. */
function fakeGit(map: Record<string, string>) {
  const calls: string[][] = []
  const git = (args: string[]): string => {
    calls.push(args)
    const key = args.join(' ')
    if (key in map) return map[key]
    throw new Error('unexpected git call: ' + key)
  }
  return { git, calls }
}

/** Settings are ALWAYS injected: the real reader would read this machine's
 *  %APPDATA%\Termpolis\ai-security-settings.json and make the suite depend on
 *  whatever the developer happens to have toggled. */
const ON: Settings = { commitShield: true }

function capture() {
  let out = ''
  return { stderr: (m: string) => { out += m }, get text() { return out } }
}

const stagedDiff = (body: string) =>
  `diff --git a/.env b/.env\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/.env\n@@ -0,0 +1,1 @@\n${body}`

const tmpDirs: string[] = []
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'githook-'))
  tmpDirs.push(d)
  return d
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!
    try { rmSync(d, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

describe('termpolis-githook — CLI contract', () => {
  it('pre-commit scans exactly what `git commit` will capture', () => {
    expect(hook.GIT_ARGS['pre-commit']).toEqual(['diff', '--cached', '--no-color', '--no-ext-diff'])
  })

  it('pre-push scans exactly what `git push` will send', () => {
    expect(hook.GIT_ARGS['pre-push']).toEqual(['log', '-p', '--no-color', '--not', '--remotes'])
  })

  it('exits 1 on a staged AWS key so git ABORTS the commit', () => {
    const g = fakeGit({ [STAGED]: stagedDiff(`+AWS_ACCESS_KEY_ID=${AWS_KEY}\n`) })
    const err = capture()
    expect(hook.main(['pre-commit'], { git: g.git, readSettings: () => ON, stderr: err.stderr })).toBe(1)
  })

  it('names the rule that fired, counts the hits, and points at file:line', () => {
    const g = fakeGit({ [STAGED]: stagedDiff(`+AWS_ACCESS_KEY_ID=${AWS_KEY}\n`) })
    const err = capture()
    hook.main(['pre-commit'], { git: g.git, readSettings: () => ON, stderr: err.stderr })
    expect(err.text).toContain('AWS Access Key ID')
    expect(err.text).toContain('1 secret')
    expect(err.text).toContain('.env:1')
  })

  it('tells the user plainly that --no-verify bypasses the hook (their machine, their call)', () => {
    const g = fakeGit({ [STAGED]: stagedDiff(`+AWS_ACCESS_KEY_ID=${AWS_KEY}\n`) })
    const err = capture()
    hook.main(['pre-commit'], { git: g.git, readSettings: () => ON, stderr: err.stderr })
    expect(err.text).toContain('git commit --no-verify')
  })

  it('NEVER prints the secret it found — only a redacted sample', () => {
    const g = fakeGit({ [STAGED]: stagedDiff(`+AWS_ACCESS_KEY_ID=${AWS_KEY}\n`) })
    const err = capture()
    hook.main(['pre-commit'], { git: g.git, readSettings: () => ON, stderr: err.stderr })
    expect(err.text).not.toContain(AWS_KEY)
    expect(err.text).toContain('AKIA')
  })

  it('BLOCKS a staged password assignment that has no token shape at all', () => {
    // `DB_PASSWORD=hunter2hunter2` carries no vendor prefix and no entropy signature — only the
    // NAME gives it away. The named rules are what let the commit shield see it; before them,
    // a line like this sailed straight into history.
    const g = fakeGit({ [STAGED]: stagedDiff('+DB_PASSWORD=hunter2hunter2\n') })
    const err = capture()
    expect(hook.main(['pre-commit'], { git: g.git, readSettings: () => ON, stderr: err.stderr })).toBe(1)
    expect(err.text).toContain('git commit --no-verify')
  })

  it('exits 0 on a clean staged diff', () => {
    const g = fakeGit({ [STAGED]: '+const answer = 42\n' })
    const err = capture()
    expect(hook.main(['pre-commit'], { git: g.git, readSettings: () => ON, stderr: err.stderr })).toBe(0)
    expect(err.text).toBe('')
  })

  it('exits 0 on an EMPTY diff (nothing staged)', () => {
    const g = fakeGit({ [STAGED]: '' })
    expect(hook.main(['pre-commit'], { git: g.git, readSettings: () => ON, stderr: capture().stderr })).toBe(0)
  })

  it('pre-push scans the UNPUSHED patch, not the staged diff', () => {
    // The staged diff is dirty and the unpushed patch is clean: a pre-push run that
    // wrongly reached for `diff --cached` would exit 1 here.
    const g = fakeGit({
      [STAGED]: `+AWS_ACCESS_KEY_ID=${AWS_KEY}\n`,
      [UNPUSHED]: 'commit abc123\n+const answer = 42\n',
    })
    expect(hook.main(['pre-push'], { git: g.git, readSettings: () => ON, stderr: capture().stderr })).toBe(0)
    expect(g.calls).toEqual([['log', '-p', '--no-color', '--not', '--remotes']])
  })

  it('pre-push blocks a secret that is already in history but not yet on a remote', () => {
    const g = fakeGit({ [UNPUSHED]: `commit deadbeef\n+++ b/config.ts\n@@ -1 +1,2 @@\n+const key = "${OPENAI_KEY}"\n` })
    const err = capture()
    expect(hook.main(['pre-push'], { git: g.git, readSettings: () => ON, stderr: err.stderr })).toBe(1)
    expect(err.text).toContain('OpenAI API key')
    expect(err.text).toContain('git push --no-verify')
  })
})

describe('termpolis-githook — FAIL OPEN on every internal error', () => {
  const failOpen = (why: string, git: (args: string[]) => string) =>
    it('exits 0 when ' + why, () => {
      const err = capture()
      expect(hook.main(['pre-commit'], { git, readSettings: () => ON, stderr: err.stderr })).toBe(0)
      expect(err.text).toBe('')
    })

  failOpen('git is not on PATH (ENOENT)', () => {
    const e: NodeJS.ErrnoException = new Error('spawnSync git ENOENT')
    e.code = 'ENOENT'
    throw e
  })
  failOpen('this is not a git repository', () => {
    throw new Error('fatal: not a git repository (or any of the parent directories): .git')
  })
  failOpen('git exits non-zero for any other reason', () => {
    throw Object.assign(new Error('Command failed: git diff'), { status: 128 })
  })
  failOpen('git output blows the maxBuffer', () => {
    throw Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' })
  })
  failOpen('git returns null instead of text', () => null as unknown as string)

  it('exits 0 when the settings reader itself throws', () => {
    const g = fakeGit({ [STAGED]: `+AWS_ACCESS_KEY_ID=${AWS_KEY}\n` })
    const boom = () => { throw new Error('EACCES') }
    expect(hook.main(['pre-commit'], { git: g.git, readSettings: boom, stderr: capture().stderr })).toBe(0)
  })

  it('exits 0 (never crashes) on an unknown mode, and never runs git', () => {
    const g = fakeGit({})
    expect(hook.main(['pre-rebase'], { git: g.git, readSettings: () => ON, stderr: capture().stderr })).toBe(0)
    expect(g.calls).toEqual([])
  })

  it('exits 0 on a MISSING mode (empty argv)', () => {
    expect(hook.main([], { git: fakeGit({}).git, readSettings: () => ON, stderr: capture().stderr })).toBe(0)
  })

  it('exits 0 on a garbage argv (undefined / non-string / prototype key) and never runs git', () => {
    const g = fakeGit({})
    const deps = { git: g.git, readSettings: () => ON, stderr: capture().stderr }
    expect(hook.main(undefined as unknown as string[], deps)).toBe(0)
    expect(hook.main([undefined as unknown as string], deps)).toBe(0)
    expect(hook.main(['constructor'], deps)).toBe(0)
    expect(hook.main(['toString'], deps)).toBe(0)
    expect(hook.main(['__proto__'], deps)).toBe(0)
    // A bare `GIT_ARGS[mode]` lookup would resolve `constructor`/`toString`/`__proto__`
    // off Object.prototype and hand a *function* to git as its argv. The outer catch
    // would swallow the resulting TypeError and still exit 0 — so the exit code alone
    // cannot see the bug. The call log can.
    expect(g.calls).toEqual([])
  })

  it('still blocks when git hands back a Buffer instead of a string', () => {
    const g = () => Buffer.from(`+AWS_ACCESS_KEY_ID=${AWS_KEY}\n`) as unknown as string
    expect(hook.main(['pre-commit'], { git: g, readSettings: () => ON, stderr: capture().stderr })).toBe(1)
  })
})

describe('termpolis-githook — the commitShield toggle (fails SECURE)', () => {
  it('exits 0 without scanning when commitShield is explicitly false', () => {
    const g = fakeGit({ [STAGED]: `+AWS_ACCESS_KEY_ID=${AWS_KEY}\n` })
    const err = capture()
    expect(hook.main(['pre-commit'], { git: g.git, readSettings: () => ({ commitShield: false }), stderr: err.stderr })).toBe(0)
    expect(g.calls).toEqual([])
    expect(err.text).toBe('')
  })

  it('reads commitShield:false out of a real settings file', () => {
    const p = join(scratch(), 'ai-security-settings.json')
    // Other keys in the file are none of the hook's business — it reads commitShield and
    // nothing else. (`redactionEnabled` used to sit here; that setting no longer exists.)
    writeFileSync(p, JSON.stringify({ auditEnabled: true, commitShield: false }))
    expect(hook.readSettings(p).commitShield).toBe(false)
  })

  it('reads commitShield:true out of a real settings file', () => {
    const p = join(scratch(), 'ai-security-settings.json')
    writeFileSync(p, JSON.stringify({ commitShield: true }))
    expect(hook.readSettings(p).commitShield).toBe(true)
  })

  it('an ABSENT commitShield key means ON — existing installs get the protection', () => {
    const p = join(scratch(), 'ai-security-settings.json')
    writeFileSync(p, JSON.stringify({ auditEnabled: true, strictGeminiPaidOnly: false }))
    expect(hook.readSettings(p).commitShield).toBe(true)
  })

  it('a MISSING settings file means ON (fresh install is protected)', () => {
    expect(hook.readSettings(join(scratch(), 'nope.json')).commitShield).toBe(true)
  })

  it('CORRUPT settings JSON means ON — a broken file must not silently disarm the shield', () => {
    const p = join(scratch(), 'ai-security-settings.json')
    writeFileSync(p, '{ this is not: json ]]')
    expect(hook.readSettings(p).commitShield).toBe(true)
  })

  it('non-object settings JSON (array / primitive / null) means ON', () => {
    const dir = scratch()
    for (const [name, body] of [['a.json', '[1,2,3]'], ['b.json', '42'], ['c.json', 'null'], ['d.json', '"str"']]) {
      const p = join(dir, name)
      writeFileSync(p, body)
      expect(hook.readSettings(p).commitShield).toBe(true)
    }
  })

  it('still SCANS (and blocks) when the settings file is missing or corrupt', () => {
    const dir = scratch()
    const corrupt = join(dir, 'corrupt.json')
    writeFileSync(corrupt, 'not json {{{')
    const g = fakeGit({ [STAGED]: `+AWS_ACCESS_KEY_ID=${AWS_KEY}\n` })
    // missing file
    expect(hook.main(['pre-commit'], {
      git: g.git,
      readSettings: () => hook.readSettings(join(dir, 'absent.json')),
      stderr: capture().stderr,
    })).toBe(1)
    // corrupt file
    expect(hook.main(['pre-commit'], {
      git: g.git,
      readSettings: () => hook.readSettings(corrupt),
      stderr: capture().stderr,
    })).toBe(1)
  })
})

describe('termpolis-githook — userData dir, computed without Electron', () => {
  const origPlatform = process.platform
  const origAppData = process.env.APPDATA
  const origXdg = process.env.XDG_CONFIG_HOME
  const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p })
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform })
    restore('APPDATA', origAppData)
    restore('XDG_CONFIG_HOME', origXdg)
  })

  it('win32 → %APPDATA%\\Termpolis', () => {
    setPlatform('win32')
    process.env.APPDATA = 'C:\\Users\\x\\AppData\\Roaming'
    expect(hook.userDataDir().replace(/\\/g, '/')).toBe('C:/Users/x/AppData/Roaming/Termpolis')
  })

  it('darwin → ~/Library/Application Support/Termpolis', () => {
    setPlatform('darwin')
    expect(hook.userDataDir().replace(/\\/g, '/')).toContain('Library/Application Support/Termpolis')
  })

  it('linux → $XDG_CONFIG_HOME/Termpolis when set', () => {
    setPlatform('linux')
    process.env.XDG_CONFIG_HOME = '/custom/cfg'
    expect(hook.userDataDir().replace(/\\/g, '/')).toBe('/custom/cfg/Termpolis')
  })

  it('linux → ~/.config/Termpolis when XDG_CONFIG_HOME is unset', () => {
    setPlatform('linux')
    delete process.env.XDG_CONFIG_HOME
    expect(hook.userDataDir().replace(/\\/g, '/')).toContain('.config/Termpolis')
  })

  it('settingsPath is ai-security-settings.json inside userData', () => {
    expect(hook.settingsPath().replace(/\\/g, '/')).toBe(hook.userDataDir().replace(/\\/g, '/') + '/ai-security-settings.json')
  })
})

describe('termpolis-githook — scanDiffText', () => {
  it('finds BOTH secrets when the same rule fires twice (regex lastIndex must not leak)', () => {
    const text = `+++ b/.env\n@@ -0,0 +1,2 @@\n+A=${AWS_KEY}\n+B=${AWS_KEY_2}\n`
    const res = hook.scanDiffText(text)
    expect(res.hitCount).toBe(2)
    expect(res.hits.map((h) => h.rule)).toEqual(['aws_access_key', 'aws_access_key'])
    expect(res.hits.map((h) => h.line)).toEqual([1, 2])
  })

  it('finds the same secret twice when it is duplicated verbatim', () => {
    const res = hook.scanDiffText(`+a=${AWS_KEY}\n+b=${AWS_KEY}\n`)
    expect(res.hitCount).toBe(2)
  })

  it('is IDEMPOTENT across scans', () => {
    const text = `+AWS_ACCESS_KEY_ID=${AWS_KEY}\n`
    const first = hook.scanDiffText(text)
    const second = hook.scanDiffText(text)
    const third = hook.scanDiffText(text)
    expect(first.hitCount).toBe(1)
    expect(second).toEqual(first)
    expect(third).toEqual(first)
  })

  it('neither depends on nor mutates the SHARED rule table (regexes are cloned per scan)', () => {
    // secretRules.cjs is a module singleton: the hook and every other consumer in the
    // process hold the SAME RegExp objects, and every rule is /g — so every rule carries
    // a lastIndex. Used directly, a lastIndex left behind by anyone else makes exec()
    // start mid-string and silently SKIP the secret at the top of the diff.
    //
    // (A plain "scan the same text twice" test canNOT catch this: exec() resets lastIndex
    // to 0 on its way to returning null, so a fully-drained loop always cleans up after
    // itself. Dirtying the shared table is the only way to see the bug.)
    const rules = require_(join(process.cwd(), 'src', 'mcp-adapter', 'secretRules.cjs')) as {
      id: string
      pattern: RegExp
    }[]
    const aws = rules.find((r) => r.id === 'aws_access_key')!
    aws.pattern.lastIndex = 9999 // some other consumer left the shared regex dirty
    try {
      const res = hook.scanDiffText(`+++ b/.env\n@@ -0,0 +1 @@\n+AWS_ACCESS_KEY_ID=${AWS_KEY}\n`)
      expect(res.hitCount).toBe(1) // found it anyway => we scanned with a clone
      expect(aws.pattern.lastIndex).toBe(9999) // and never touched the shared object
    } finally {
      aws.pattern.lastIndex = 0
    }
  })

  it('attributes a NAMED-rule hit (env_secret) to its file and line like any other', () => {
    const res = hook.scanDiffText(stagedDiff('+DB_PASSWORD=hunter2hunter2\n'))
    const hit = res.hits.find((h) => h.rule === 'env_secret')
    expect(hit).toBeDefined()
    expect(hit!.file).toBe('.env')
    expect(hit!.line).toBe(1)
  })

  it('returns a clean result for empty / non-string input', () => {
    for (const v of ['', null, undefined, 42, {}]) {
      const res = hook.scanDiffText(v)
      expect(res.hitCount).toBe(0)
      expect(res.hits).toEqual([])
    }
  })

  it('attributes a hit to the file and NEW-file line number from the hunk header', () => {
    const text = [
      'diff --git a/src/config.ts b/src/config.ts',
      'index 1111111..2222222 100644',
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -10,3 +10,4 @@ export const cfg = {',
      ' const a = 1',
      ' const b = 2',
      `+const key = "${OPENAI_KEY}"`,
      ' const c = 3',
      '',
    ].join('\n')
    const res = hook.scanDiffText(text)
    expect(res.hitCount).toBe(1)
    expect(res.hits[0].file).toBe('src/config.ts')
    expect(res.hits[0].line).toBe(12) // 10, 11 are context; the added line is 12
  })

  it('attributes across MULTIPLE files in one diff', () => {
    const text = [
      'diff --git a/a.env b/a.env',
      '+++ b/a.env',
      '@@ -0,0 +1 @@',
      `+AWS_ACCESS_KEY_ID=${AWS_KEY}`,
      'diff --git a/b.ts b/b.ts',
      '+++ b/b.ts',
      '@@ -0,0 +1 @@',
      `+const k = "${OPENAI_KEY}"`,
      '',
    ].join('\n')
    const res = hook.scanDiffText(text)
    expect(res.hits.map((h) => h.file).sort()).toEqual(['a.env', 'b.ts'])
  })

  it('survives a diff with no hunk headers at all (attribution degrades, scan does not)', () => {
    const res = hook.scanDiffText(`some raw text ${AWS_KEY} with no diff structure`)
    expect(res.hitCount).toBe(1)
    expect(res.hits[0].file).toBe('')
    expect(res.hits[0].line).toBe(0)
  })

  it('handles CRLF diffs', () => {
    const res = hook.scanDiffText(`+++ b/.env\r\n@@ -0,0 +1 @@\r\n+AWS_ACCESS_KEY_ID=${AWS_KEY}\r\n`)
    expect(res.hitCount).toBe(1)
    expect(res.hits[0].file).toBe('.env')
    expect(res.hits[0].line).toBe(1)
  })

  it('handles a HUGE diff without exploding, and still sees a secret on the last line', () => {
    const filler: string[] = ['diff --git a/big.ts b/big.ts', '+++ b/big.ts', '@@ -0,0 +1,20001 @@']
    for (let i = 0; i < 20000; i++) filler.push(`+  const value${i} = ${i} // padded padded padded padded padded`)
    filler.push(`+AWS_ACCESS_KEY_ID=${AWS_KEY}`)
    const text = filler.join('\n')
    expect(text.length).toBeGreaterThan(1_000_000)
    const res = hook.scanDiffText(text)
    expect(res.hitCount).toBe(1)
    expect(res.hits[0].file).toBe('big.ts')
    expect(res.scannedBytes).toBe(text.length)
  })

  it('redactSample shows first-4 + last-2 only, and masks short matches entirely', () => {
    expect(hook.redactSample(AWS_KEY)).toBe('AKIA…AA')
    expect(hook.redactSample('short')).toBe('****')
    expect(hook.redactSample('12345678')).toBe('****')
  })
})

describe('termpolis-githook — formatBlock', () => {
  const res = (): ScanRes => hook.scanDiffText(`+++ b/.env\n@@ -0,0 +1,2 @@\n+A=${AWS_KEY}\n+B=${OPENAI_KEY}\n`)

  it('de-duplicates rule labels and pluralises the count', () => {
    const dupes = hook.scanDiffText(`+a=${AWS_KEY}\n+b=${AWS_KEY_2}\n`)
    const msg = hook.formatBlock(dupes, 'pre-commit')
    expect(msg).toContain('2 secrets')
    expect(msg.match(/AWS Access Key ID/g)!.length).toBeLessThan(4) // listed once in the summary, not N times
  })

  it('lists every rule that fired', () => {
    const msg = hook.formatBlock(res(), 'pre-commit')
    expect(msg).toContain('AWS Access Key ID')
    expect(msg).toContain('OpenAI API key')
  })

  it('says commit for pre-commit and push for pre-push', () => {
    expect(hook.formatBlock(res(), 'pre-commit')).toContain('git commit --no-verify')
    expect(hook.formatBlock(res(), 'pre-push')).toContain('git push --no-verify')
  })

  it('never leaks a raw secret into the message', () => {
    const msg = hook.formatBlock(res(), 'pre-commit')
    expect(msg).not.toContain(AWS_KEY)
    expect(msg).not.toContain(OPENAI_KEY)
  })

  it('caps the per-hit list so a 500-secret .env dump cannot spam the terminal', () => {
    const lines = ['+++ b/.env', '@@ -0,0 +1,500 @@']
    for (let i = 0; i < 500; i++) lines.push(`+K${i}=AKIA${'A'.repeat(15)}${String.fromCharCode(65 + (i % 26))}`)
    const many = hook.scanDiffText(lines.join('\n'))
    expect(many.hitCount).toBeGreaterThan(100)
    const msg = hook.formatBlock(many, 'pre-commit')
    expect(msg.split('\n').length).toBeLessThan(30)
    expect(msg).toContain('more')
  })
})

// The point of the whole file: this must work in a plain `node` process with Termpolis
// closed. These spawn the real script — if it ever grew an `require('electron')`, an
// import of the bundled main process, or an HTTP call to the app, they would fail.
describe('termpolis-githook — standalone process invariants', () => {
  const noGitEnv = (home: string) => {
    const env: Record<string, string> = {}
    // Drop PATH entirely (case-insensitively — Windows uses `Path`) so the child cannot
    // find `git`. That is the "git not on PATH" failure the hook must survive.
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !/^path$/i.test(k)) env[k] = v
    }
    env.PATH = home
    env.APPDATA = home
    env.HOME = home
    env.USERPROFILE = home
    env.XDG_CONFIG_HOME = home
    return env
  }

  const runReal = (args: string[]) => {
    const home = scratch()
    const r = spawnSync(process.execPath, [HOOK_PATH, ...args], {
      encoding: 'utf-8',
      timeout: 30000,
      env: noGitEnv(home),
      cwd: home, // not a git repo either
    })
    return { status: r.status, stderr: r.stderr || '', stdout: r.stdout || '' }
  }

  it('runs under plain node (no Electron) and exits 0 when git is not on PATH', () => {
    const r = runReal(['pre-commit'])
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })

  it('exits 0 for pre-push with no git and no repo', () => {
    expect(runReal(['pre-push']).status).toBe(0)
  })

  it('exits 0 with no arguments at all', () => {
    expect(runReal([]).status).toBe(0)
  })

  it('exits 0 on a nonsense mode', () => {
    expect(runReal(['--help']).status).toBe(0)
  })

  it('exits 1 from a REAL node process when a secret is staged', () => {
    // Drives main() through a require() in a plain node process — the exact way the
    // installed hook shim will call it — so the exit-1 contract is proven end to end
    // without depending on a git binary being present.
    const dir = scratch()
    const driver = join(dir, 'drive.cjs')
    writeFileSync(
      driver,
      'const hook = require(' + JSON.stringify(HOOK_PATH) + ')\n' +
        'process.exitCode = hook.main([process.argv[2]], {\n' +
        '  git: () => "+++ b/.env\\n@@ -0,0 +1 @@\\n+AWS_ACCESS_KEY_ID=' + AWS_KEY + '\\n",\n' +
        '  readSettings: () => ({ commitShield: true }),\n' +
        '})\n',
    )
    const r = spawnSync(process.execPath, [driver, 'pre-commit'], { encoding: 'utf-8', timeout: 30000 })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('AWS Access Key ID')
    expect(r.stderr).not.toContain(AWS_KEY)
  })

  it('carries no dependency on Electron, the app bundle, or the network', () => {
    const src = readFileSync(HOOK_PATH, 'utf8')
    expect(src).not.toMatch(/require\(['"]electron['"]\)/)
    expect(src).not.toMatch(/require\(['"](?:http|https|net|node:http|node:https|node:net)['"]\)/)
    expect(src).not.toMatch(/\.\.\/main\//)
    // and it must never hand a diff to a shell
    expect(src).not.toMatch(/execSync|shell:\s*true/)
    expect(src).toMatch(/shell:\s*false/)
  })

  it('shares one rule table with the app (loaded straight from secretRules.cjs)', () => {
    const rules = require_(join(process.cwd(), 'src', 'mcp-adapter', 'secretRules.cjs')) as { id: string }[]
    const src = readFileSync(HOOK_PATH, 'utf8')
    expect(src).toMatch(/require\(['"]\.\/secretRules(?:\.cjs)?['"]\)/)
    // Exactly the app's table — 97 rules. secretRulesSync.test.ts proves the two are identical;
    // this pins the COUNT here too, because a hook that silently carried a shorter table would
    // still pass every other test in this file while quietly missing secrets.
    expect(rules.length).toBe(97)
  })
})
