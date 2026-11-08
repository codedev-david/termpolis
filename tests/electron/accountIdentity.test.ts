// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess, SpawnOptions } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CHECK_TIMEOUT_MS, checkEnv, claudeSignedInNow, codexAccountRead, codexSignedInNow, codexVendorExe, findOnPath,
  isDeadShim, resolveCli, runCli,
} from '../../src/main/accountIdentity'
import type { CheckDeps, Spawner } from '../../src/main/accountIdentity'
import { accountFs } from '../../src/main/accountFs'
import type { AccountFs } from '../../src/main/accountFs'

let root: string

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tp-acctid-')))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

/** A child process stand-in: what a test script writes to stdout, and what was sent on stdin. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  sent: string[] = []
  killed = false
  constructor() {
    super()
    this.stdin.on('data', (d: Buffer) => this.sent.push(...d.toString().split('\n').filter(Boolean)))
  }
  kill(): boolean {
    this.killed = true
    // A killed process closes, as a real one would: an answer already given must stay the answer.
    setImmediate(() => this.emit('close', null))
    return true
  }
  /** Print and exit with `code`. */
  finish(out: string, code: number | null, err = 'a warning nobody reads'): void {
    if (out) this.stdout.write(out)
    if (err) this.stderr.write(err)
    setImmediate(() => this.emit('close', code))
  }
}

interface Call { file: string; args: readonly string[]; opts: SpawnOptions; child: FakeChild }

/** `onSpawn` runs once the caller has attached its listeners; `onSetup` at once, for a script
 *  that must hear what the caller writes the moment it starts. */
function spawner(onSpawn: (c: Call) => void, onSetup?: (c: Call) => void): { spawn: Spawner; calls: Call[] } {
  const calls: Call[] = []
  const spawn: Spawner = (file, args, opts) => {
    const child = new FakeChild()
    const call = { file, args, opts, child }
    calls.push(call)
    onSetup?.(call)
    setImmediate(() => onSpawn(call))
    return child as unknown as ChildProcess
  }
  return { spawn, calls }
}

/** A spawner whose child is the fake app server below. */
function serving(opts: Parameters<typeof appServer>[1]): { spawn: Spawner; calls: Call[] } {
  return spawner(() => {}, (c) => appServer(c, opts))
}

/** A PATH with `name.exe` (Windows) or `name` (elsewhere) in it. */
function cliOnPath(name: string, file = process.platform === 'win32' ? `${name}.exe` : name): Record<string, string> {
  const dir = join(root, 'bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), '')
  return { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD', USERPROFILE: root, HOME: root }
}

function deps(env: Record<string, string>, spawn: Spawner, extra: Partial<CheckDeps> = {}): CheckDeps {
  return { cwd: root, env, spawn, ...extra }
}

describe('findOnPath and resolveCli', () => {
  it('finds a CLI on PATH, trying each PATHEXT extension in each folder on Windows', () => {
    const a = join(root, 'a')
    const b = join(root, 'b')
    mkdirSync(a)
    mkdirSync(b)
    writeFileSync(join(b, 'codex.cmd'), '')
    writeFileSync(join(b, 'codex.exe'), '')
    const env = { Path: `"${a}";relative;;${b}`, PATHEXT: '.EXE;.CMD' }
    expect(findOnPath('codex', env, 'win32')).toBe(join(b, 'codex.exe'))
    expect(findOnPath('codex', { PATH: b }, 'win32')).toBe(join(b, 'codex.exe'))
    expect(findOnPath('claude', env, 'win32')).toBeNull()
    expect(findOnPath('codex', {}, 'win32')).toBeNull()
    // A folder named like the CLI is not the CLI.
    mkdirSync(join(a, 'claude.exe'))
    expect(findOnPath('claude', { PATH: a }, 'win32')).toBeNull()
  })

  it('splits PATH on colons elsewhere, with no extensions', () => {
    const seen: string[] = []
    const fsx: AccountFs = { ...accountFs, stat: (p) => { seen.push(p); return p === join('/opt/bin', 'claude') ? ({ isFile: () => true } as never) : null } }
    expect(findOnPath('claude', { PATH: '/usr/bin:/opt/bin' }, 'linux', fsx)).toBe(join('/opt/bin', 'claude'))
    expect(seen).toEqual([join('/usr/bin', 'claude'), join('/opt/bin', 'claude')])
  })

  it('finds the vendor codex.exe an npm shim runs, beside it or hoisted, x64 or arm64 (R20)', () => {
    const shim = join(root, 'npm', 'codex.cmd')
    const nested = join(root, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin')
    const hoisted = join(root, 'npm', 'node_modules', '@openai', 'codex-win32-arm64', 'vendor', 'aarch64-pc-windows-msvc', 'bin')
    expect(codexVendorExe(shim, 'x64')).toBeNull()
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'codex.exe'), '')
    mkdirSync(hoisted, { recursive: true })
    writeFileSync(join(hoisted, 'codex.exe'), '')
    expect(codexVendorExe(shim, 'x64')).toBe(join(nested, 'codex.exe'))
    expect(codexVendorExe(shim, 'arm64')).toBe(join(hoisted, 'codex.exe'))
  })

  it('runs an exe as it is, a shim\'s vendor exe for Codex, and otherwise the shim', () => {
    const bin = join(root, 'npm')
    mkdirSync(bin)
    for (const f of ['codex.cmd', 'claude.cmd']) writeFileSync(join(bin, f), '')
    const env = { PATH: bin, PATHEXT: '.CMD' }
    expect(resolveCli('codex', { env, platform: 'win32', arch: 'x64' })).toEqual({ kind: 'shim', file: join(bin, 'codex.cmd') })
    expect(resolveCli('claude', { env, platform: 'win32' })).toEqual({ kind: 'shim', file: join(bin, 'claude.cmd') })
    const vendor = join(bin, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin')
    mkdirSync(vendor, { recursive: true })
    writeFileSync(join(vendor, 'codex.exe'), '')
    expect(resolveCli('codex', { env, platform: 'win32', arch: 'x64' })).toEqual({ kind: 'exe', file: join(vendor, 'codex.exe') })
    writeFileSync(join(bin, 'claude.com'), '')
    expect(resolveCli('claude', { env: { PATH: bin, PATHEXT: '.COM;.CMD' }, platform: 'win32' })).toEqual({ kind: 'exe', file: join(bin, 'claude.com') })
    expect(resolveCli('claude', { env: { PATH: join(root, 'none') }, platform: 'win32' })).toBeNull()
    const fsx: AccountFs = { ...accountFs, stat: (p) => (p === join('/usr/local/bin', 'codex') ? ({ isFile: () => true } as never) : null) }
    expect(resolveCli('codex', { env: { PATH: '/usr/local/bin' }, platform: 'darwin', fsx })).toEqual({ kind: 'exe', file: join('/usr/local/bin', 'codex') })
  })

  // 1.54.6: Claude Code's move to its native install renamed npm's claude.exe away and left
  // claude.cmd, so Sign in ran a shim that failed with "'…claude.exe' is not recognized".
  const SHIM = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n'
  const NODE_SHIM = '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\nendLocal & "%_prog%"  "%dp0%\\node_modules\\x\\cli.js" %*\r\n'

  it('passes over an npm shim whose program is gone, for the next CLI on PATH', () => {
    const npm = join(root, 'npm')
    const local = join(root, 'local')
    mkdirSync(npm)
    mkdirSync(local)
    writeFileSync(join(npm, 'claude.cmd'), SHIM)
    const env = { PATH: `${npm};${local}`, PATHEXT: '.EXE;.CMD' }
    expect(isDeadShim(join(npm, 'claude.cmd'))).toBe(true)
    expect(resolveCli('claude', { env, platform: 'win32' })).toBeNull()
    writeFileSync(join(local, 'claude.exe'), '')
    expect(resolveCli('claude', { env, platform: 'win32' })).toEqual({ kind: 'exe', file: join(local, 'claude.exe') })
    const bin = join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'claude.exe'), '')
    expect(isDeadShim(join(npm, 'claude.cmd'))).toBe(false)
    expect(resolveCli('claude', { env, platform: 'win32' })).toEqual({ kind: 'shim', file: join(npm, 'claude.cmd') })
  })

  it('reads a shim\'s last %dp0% path as its program, and counts one it can\'t read as alive', () => {
    const npm = join(root, 'npm')
    mkdirSync(join(npm, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(npm, 'x.cmd'), NODE_SHIM)
    expect(isDeadShim(join(npm, 'x.cmd'))).toBe(true)
    writeFileSync(join(npm, 'node_modules', 'x', 'cli.js'), '')
    expect(isDeadShim(join(npm, 'x.cmd'))).toBe(false)
    writeFileSync(join(npm, 'plain.cmd'), '@node "C:\\elsewhere\\cli.js" %*')
    expect(isDeadShim(join(npm, 'plain.cmd'))).toBe(false)
    expect(isDeadShim(join(npm, 'missing.cmd'))).toBe(false)
    // A scanner holding the shim (EBUSY) must not fail Sign in: alive, like an unreadable one.
    const busy = { readText: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) } } as unknown as Parameters<typeof isDeadShim>[1]
    expect(isDeadShim(join(npm, 'x.cmd'), busy)).toBe(false)
  })

  it('looks on the process\'s own PATH by default', () => {
    expect(() => resolveCli('claude')).not.toThrow()
  })

  it('spawns for real when no spawner is given: a missing program is an error, never a hang', async () => {
    const r = await runCli({ kind: 'exe', file: join(root, 'no-such-cli.exe') }, [], {}, { cwd: root })
    expect(r).toMatchObject({ code: null, timedOut: false, error: 'ENOENT' })
  })
})

describe('checkEnv', () => {
  const base = {
    PATH: '/bin', HOME: '/home/me', USERPROFILE: 'C:\\Users\\me', ANTHROPIC_API_KEY: 'a'.repeat(30), CLAUDE_CODE_OAUTH_TOKEN: 'b'.repeat(30),
    OPENAI_API_KEY: 'c'.repeat(30), CODEX_API_KEY: 'd'.repeat(30), HTTPS_PROXY: 'http://p', CLAUDE_CONFIG_DIR: '/elsewhere', CODEX_HOME: '/elsewhere',
    TERMPOLIS_TEST_AGENT_HOME: '', LANG: 'en_US.UTF-8',
  }

  it('keeps only what a CLI needs, never a key, a token or a proxy, plus the account\'s variable', () => {
    const env = checkEnv('claude', '/home/me/.claude-codedev', base)
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/me', USERPROFILE: 'C:\\Users\\me', LANG: 'en_US.UTF-8', NO_COLOR: '1', CLAUDE_CONFIG_DIR: '/home/me/.claude-codedev' })
    expect(checkEnv('codex', '/h', base).CODEX_HOME).toBe('/h')
  })

  it('DELETES the variable for the default profile, never sets it empty (R24)', () => {
    const env = checkEnv('claude', null, base)
    expect('CLAUDE_CONFIG_DIR' in env).toBe(false)
    expect('CODEX_HOME' in checkEnv('codex', null, base)).toBe(false)
  })

  it('points HOME and USERPROFILE at a test run\'s scratch home, so a test can never reach a real sign-in', () => {
    const env = checkEnv('claude', null, { ...base, TERMPOLIS_TEST_AGENT_HOME: '/tmp/scratch' })
    expect(env.HOME).toBe('/tmp/scratch')
    expect(env.USERPROFILE).toBe('/tmp/scratch')
  })
})

describe('runCli', () => {
  it('collects stdout and the start of stderr, and gives the exit code', async () => {
    const { spawn, calls } = spawner((c) => {
      c.child.stderr.write('e'.repeat(5000))
      c.child.finish('hello', 3, 'more, past the cap')
    })
    const r = await runCli({ kind: 'exe', file: '/bin/x' }, ['a'], { PATH: '/bin' }, deps({}, spawn))
    expect(r).toEqual({ code: 3, stdout: 'hello', stderr: 'e'.repeat(4096), timedOut: false })
    expect(calls[0]).toMatchObject({ file: '/bin/x', args: ['a'], opts: { cwd: root, env: { PATH: '/bin' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] } })
  })

  it('caps what it keeps of stdout', async () => {
    const { spawn } = spawner((c) => {
      for (let i = 0; i < 6; i++) c.child.stdout.write('x'.repeat(64 * 1024))
      c.child.finish('', 0)
    })
    const r = await runCli({ kind: 'exe', file: '/x' }, [], {}, deps({}, spawn))
    expect(r.stdout.length).toBeLessThanOrEqual(320 * 1024)
    expect(r.stdout.length).toBeGreaterThanOrEqual(256 * 1024)
  })

  it('reports a CLI that couldn\'t start, by its code', async () => {
    const { spawn } = spawner((c) => c.child.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' })))
    expect(await runCli({ kind: 'exe', file: '/x' }, [], {}, deps({}, spawn))).toEqual({ code: null, stdout: '', stderr: '', timedOut: false, error: 'ENOENT' })
    const { spawn: s2 } = spawner((c) => c.child.emit('error', new Error('no code')))
    expect((await runCli({ kind: 'exe', file: '/x' }, [], {}, deps({}, s2))).error).toBe('could not start')
    const throwing: Spawner = () => { throw Object.assign(new Error('bad'), { code: 'EINVAL' }) }
    expect(await runCli({ kind: 'exe', file: '/x' }, [], {}, deps({}, throwing))).toEqual({ code: null, stdout: '', stderr: '', timedOut: false, error: 'EINVAL' })
    const throwsPlain: Spawner = () => { throw new Error('bad') }
    expect((await runCli({ kind: 'exe', file: '/x' }, [], {}, deps({}, throwsPlain))).error).toBe('could not start')
  })

  it('kills a CLI that takes too long', async () => {
    const { spawn, calls } = spawner(() => { /* never answers */ })
    const r = await runCli({ kind: 'exe', file: '/x' }, [], {}, deps({}, spawn, { timeoutMs: 20 }))
    expect(r).toEqual({ code: null, stdout: '', stderr: '', timedOut: true })
    expect(calls[0].child.killed).toBe(true)
    expect(CHECK_TIMEOUT_MS).toBe(15_000)
  })

  it('survives a kill that throws, and answers once', async () => {
    const { spawn, calls } = spawner((c) => {
      c.child.kill = () => { throw new Error('gone') }
    })
    const r = await runCli({ kind: 'exe', file: '/x' }, [], {}, deps({}, spawn, { timeoutMs: 20 }))
    expect(r.timedOut).toBe(true)
    calls[0].child.emit('close', 0)
  })

  it('runs a Windows shim through cmd /d /s /c with fixed arguments, the profile in the env', async () => {
    const { spawn, calls } = spawner((c) => c.child.finish('ok', 0))
    const env = { COMSPEC: 'C:\\Windows\\System32\\cmd.exe', CLAUDE_CONFIG_DIR: "C:\\Users\\O'Brien & Co\\.claude-x" }
    await runCli({ kind: 'shim', file: 'C:\\npm\\claude.cmd' }, ['auth', 'status', '--json'], env, deps({}, spawn, { platform: 'win32' }))
    expect(calls[0].file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(calls[0].args).toEqual(['/d', '/s', '/c', '""C:\\npm\\claude.cmd" auth status --json"'])
    expect(calls[0].opts.windowsVerbatimArguments).toBe(true)
    const { spawn: s2, calls: c2 } = spawner((c) => c.child.finish('', 0))
    await runCli({ kind: 'shim', file: 'C:\\npm\\codex.cmd' }, ['login', 'status'], { ComSpec: 'C:\\cmd.exe' }, deps({}, s2, { platform: 'win32' }))
    expect(c2[0].file).toBe('C:\\cmd.exe')
    const { spawn: s3, calls: c3 } = spawner((c) => c.child.finish('', 0))
    await runCli({ kind: 'shim', file: 'C:\\npm\\codex.cmd' }, ['login', 'status'], {}, deps({}, s3, { platform: 'win32' }))
    expect(c3[0].file).toBe('cmd.exe')
  })

  it('refuses a shim whose path cmd would read specially, or an argument that isn\'t plain', async () => {
    const { spawn, calls } = spawner(() => {})
    for (const file of ['C:\\100%\\claude.cmd', 'C:\\a&b\\claude.cmd', 'C:\\a"b\\claude.cmd', 'C:\\a!b\\x.cmd']) {
      const r = await runCli({ kind: 'shim', file }, ['auth'], {}, deps({}, spawn, { platform: 'win32' }))
      expect(r.error).toBe('the CLI is installed in a folder Termpolis can\'t run it from safely')
    }
    const r = await runCli({ kind: 'shim', file: 'C:\\npm\\claude.cmd' }, ['a b'], {}, deps({}, spawn, { platform: 'win32' }))
    expect(r.error).toBe('the CLI is installed in a folder Termpolis can\'t run it from safely')
    expect(calls).toHaveLength(0)
  })

  it('runs a shim directly where there is no cmd to need', async () => {
    const { spawn, calls } = spawner((c) => c.child.finish('', 0))
    await runCli({ kind: 'shim', file: '/usr/local/bin/claude' }, ['x'], {}, deps({}, spawn, { platform: 'linux' }))
    expect(calls[0].file).toBe('/usr/local/bin/claude')
  })
})

describe('claudeSignedInNow', () => {
  const env = (): Record<string, string> => cliOnPath('claude')

  it('reads `claude auth status --json`: signed in, with the email and plan', async () => {
    const { spawn, calls } = spawner((c) => c.child.finish(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'me@example.test', subscriptionType: 'max' }), 0))
    const r = await claudeSignedInNow('/p/.claude-x', deps(env(), spawn))
    expect(r).toMatchObject({ identity: { email: 'me@example.test', signedIn: true, plan: 'max', source: 'auth-status' } })
    expect(calls[0].args).toEqual(['auth', 'status', '--json'])
    expect((calls[0].opts.env as Record<string, string>).CLAUDE_CONFIG_DIR).toBe('/p/.claude-x')
    expect(calls[0].opts.stdio).toEqual(['ignore', 'pipe', 'pipe'])
  })

  it('reads signed out from exit 1, with no email, for the default profile with the variable deleted', async () => {
    const { spawn, calls } = spawner((c) => c.child.finish('{\n  "loggedIn": false,\n  "authMethod": "none"\n}\n', 1))
    const r = await claudeSignedInNow(null, deps(env(), spawn))
    expect(r).toMatchObject({ identity: { email: null, signedIn: false, source: 'auth-status' } })
    expect('identity' in r && 'plan' in r.identity).toBe(false)
    expect('CLAUDE_CONFIG_DIR' in (calls[0].opts.env as Record<string, string>)).toBe(false)
  })

  it('never takes a sign-in as live when the exit code says otherwise, and never takes an odd email', async () => {
    const { spawn } = spawner((c) => c.child.finish(JSON.stringify({ loggedIn: true, email: 'me@example.test' }), 1))
    expect(await claudeSignedInNow(null, deps(env(), spawn))).toMatchObject({ identity: { signedIn: false, email: null } })
    const { spawn: s2 } = spawner((c) => c.child.finish(JSON.stringify({ loggedIn: true, email: "x'@y", subscriptionType: '' }), 0))
    const r = await claudeSignedInNow(null, deps(env(), s2))
    expect(r).toMatchObject({ identity: { signedIn: true, email: null } })
    expect('identity' in r && 'plan' in r.identity).toBe(false)
  })

  it('says so when Claude Code can\'t be found, started, read or waited for', async () => {
    const { spawn } = spawner((c) => c.child.finish('{}', 0))
    expect(await claudeSignedInNow(null, deps({ PATH: join(root, 'none') }, spawn))).toEqual({ error: 'Claude Code isn\'t installed where Termpolis can find it (not on PATH)' })
    expect(await claudeSignedInNow(null, deps(env(), spawn))).toEqual({ error: 'Claude Code\'s answer couldn\'t be read' })
    const { spawn: s2 } = spawner((c) => c.child.finish('Not logged in. Run claude auth login to authenticate.', 1))
    expect(await claudeSignedInNow(null, deps(env(), s2))).toEqual({ error: 'Claude Code\'s answer couldn\'t be read' })
    const { spawn: s3 } = spawner((c) => c.child.finish('[1, 2]', 0))
    expect(await claudeSignedInNow(null, deps(env(), s3))).toEqual({ error: 'Claude Code\'s answer couldn\'t be read' })
    const { spawn: s4 } = spawner((c) => c.child.finish('{ not json }', 0))
    expect(await claudeSignedInNow(null, deps(env(), s4))).toEqual({ error: 'Claude Code\'s answer couldn\'t be read' })
    const { spawn: s5 } = spawner((c) => c.child.emit('error', Object.assign(new Error('x'), { code: 'EACCES' })))
    expect(await claudeSignedInNow(null, deps(env(), s5))).toEqual({ error: 'Claude Code couldn\'t be started (EACCES)' })
    const { spawn: s6 } = spawner(() => {})
    expect(await claudeSignedInNow(null, deps(env(), s6, { timeoutMs: 20 }))).toEqual({ error: 'Claude Code took longer than 15 s to answer' })
  })

  it('uses the process env when none is given', async () => {
    const { spawn } = spawner((c) => c.child.finish('{}', 0))
    const r = await claudeSignedInNow(null, { cwd: root, spawn })
    expect(r).toHaveProperty('error')
  })
})

/** An app server that answers initialize with `version` and account/read with `account`. */
function appServer(call: Call, opts: { version?: string | null; account?: unknown; error?: boolean; noise?: boolean } = {}): void {
  const { child } = call
  child.stderr.write('WARNING: proceeding, even though we could not create PATH aliases\n')
  child.stdin.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n').filter(Boolean)) {
      const msg = JSON.parse(line)
      if (msg.id === 1) {
        const ua = opts.version === null ? undefined : `termpolis/${opts.version ?? '0.153.4'} (Windows 10.0; x86_64) unknown`
        if (opts.noise) {
          child.stdout.write('not json at all\n')
          child.stdout.write('{"method":"remoteControl/status/changed","params":{}}\n')
          child.stdout.write('{"id":99,"result":{"account":{"email":"wrong@example.test"}}}\n')
          child.stdout.write('{ broken json\n')
          child.stdout.write('[1]\n')
        }
        // Split across chunks, as a pipe may deliver it.
        const reply = JSON.stringify({ id: 1, result: { userAgent: ua, codexHome: '/h' } }) + '\n'
        child.stdout.write(reply.slice(0, 10))
        child.stdout.write(reply.slice(10))
      } else if (msg.id === 2) {
        if (opts.error) child.stdout.write(JSON.stringify({ id: 2, error: { code: -1, message: 'no' } }) + '\n')
        else child.stdout.write(JSON.stringify({ id: 2, result: { account: opts.account, requiresOpenaiAuth: true } }) + '\n')
      }
    }
  })
}

describe('codexAccountRead (R21)', () => {
  const cli = { kind: 'exe' as const, file: '/x/codex' }

  it('sends initialize, initialized and account/read {} only, and reads the email and plan', async () => {
    const { spawn, calls } = serving({ account: { type: 'chatgpt', email: 'me@example.test', planType: 'plus' }, noise: true })
    const r = await codexAccountRead(cli, { CODEX_HOME: '/h' }, deps({}, spawn))
    expect(r).toEqual({ email: 'me@example.test', plan: 'plus' })
    const sent = calls[0].child.sent.map((l) => JSON.parse(l))
    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'termpolis', version: '1' } } },
      { jsonrpc: '2.0', method: 'initialized' },
      { jsonrpc: '2.0', id: 2, method: 'account/read', params: {} },
    ])
    // Never a refresh, a login or a logout.
    expect(JSON.stringify(sent)).not.toMatch(/refreshToken|login|logout/)
    expect(calls[0].args).toEqual(['app-server'])
    expect(calls[0].opts.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(calls[0].child.killed).toBe(true)
  })

  it('reads a home with no account as no email, and an API-key account as no email', async () => {
    const { spawn } = serving({ account: null })
    expect(await codexAccountRead(cli, {}, deps({}, spawn))).toEqual({ email: null })
    const { spawn: s2 } = serving({ account: { type: 'apiKey' } })
    expect(await codexAccountRead(cli, {}, deps({}, s2))).toEqual({ email: null })
    const { spawn: s3 } = serving({ account: { type: 'chatgpt', email: 'bad', planType: '' } })
    expect(await codexAccountRead(cli, {}, deps({}, s3))).toEqual({ email: null })
  })

  it('asks no further when the Codex is too old, or its version unknown', async () => {
    for (const version of ['0.152.9', '0.0.1', null, 'x.y.z']) {
      const { spawn, calls } = serving({ version, account: null })
      expect(await codexAccountRead(cli, {}, deps({}, spawn))).toEqual({ error: 'this Codex is too old, or too new to be sure of, for Termpolis to ask its app server' })
      expect(calls[0].child.sent).toHaveLength(1)
    }
    const { spawn } = serving({ version: '1.0.0', account: null })
    expect(await codexAccountRead(cli, {}, deps({}, spawn))).toEqual({ email: null })
    const { spawn: s2 } = serving({ version: '0.153.0', account: null })
    expect(await codexAccountRead(cli, {}, deps({}, s2))).toEqual({ email: null })
  })

  it('reports an error reply, or a reply with no account, as no account', async () => {
    const { spawn } = serving({ error: true })
    expect(await codexAccountRead(cli, {}, deps({}, spawn))).toEqual({ error: 'Codex\'s app server gave no account' })
    const { spawn: s2 } = serving({ account: 'text' })
    expect(await codexAccountRead(cli, {}, deps({}, s2))).toEqual({ error: 'Codex\'s app server gave no account' })
    const { spawn: s3 } = serving({ account: undefined })
    expect(await codexAccountRead(cli, {}, deps({}, s3))).toEqual({ error: 'Codex\'s app server gave no account' })
  })

  it('gives up when the server stops, fails, never answers, or can\'t be written to', async () => {
    const { spawn } = spawner((c) => c.child.emit('close', 1))
    expect(await codexAccountRead(cli, {}, deps({}, spawn))).toEqual({ error: 'Codex\'s app server stopped before it answered' })
    const { spawn: s2 } = spawner((c) => c.child.emit('error', new Error('x')))
    expect(await codexAccountRead(cli, {}, deps({}, s2))).toEqual({ error: 'Codex\'s app server couldn\'t be started' })
    const { spawn: s3 } = spawner(() => {})
    expect(await codexAccountRead(cli, {}, deps({}, s3, { timeoutMs: 20 }))).toEqual({ error: 'Codex\'s app server took longer than 15 s to answer' })
    const writeFails: Spawner = (file, args, opts) => {
      const child = new FakeChild()
      child.stdin.write = () => { throw new Error('EPIPE') }
      child.kill = () => { throw new Error('gone') }
      void file; void args; void opts
      return child as unknown as ChildProcess
    }
    expect(await codexAccountRead(cli, {}, deps({}, writeFails))).toEqual({ error: 'Codex\'s app server stopped' })
    const throwing: Spawner = () => { throw new Error('EINVAL') }
    expect(await codexAccountRead(cli, {}, deps({}, throwing))).toEqual({ error: 'Codex\'s app server couldn\'t be started' })
    const { spawn: s4 } = spawner(() => {})
    expect(await codexAccountRead({ kind: 'shim', file: 'C:\\100%\\codex.cmd' }, {}, deps({}, s4, { platform: 'win32' })))
      .toEqual({ error: 'the CLI is installed in a folder Termpolis can\'t run it from safely' })
  })

  it('keeps no more than its cap of a server that never ends a line', async () => {
    const { spawn } = spawner((c) => {
      for (let i = 0; i < 6; i++) c.child.stdout.write('x'.repeat(64 * 1024))
      c.child.emit('close', 0)
    })
    expect(await codexAccountRead(cli, {}, deps({}, spawn))).toEqual({ error: 'Codex\'s app server stopped before it answered' })
  })
})

describe('codexSignedInNow', () => {
  const env = (): Record<string, string> => cliOnPath('codex')

  /** Codex 0.153.4 prints its status words on stderr (verified in a signed-out temp home). */
  function codex(status: { out: string; code: number; stdout?: boolean }, server?: Parameters<typeof appServer>[1]): Spawner {
    return spawner((c) => {
      if (c.args[0] === 'login') {
        if (status.stdout) c.child.finish(status.out, status.code, '')
        else c.child.finish('', status.code, status.out)
      }
      else if (!server) c.child.emit('close', 1)
    }, (c) => {
      if (c.args[0] === 'app-server' && server) appServer(c, server)
    }).spawn
  }

  it('asks `codex login status`, then the app server for the email and plan', async () => {
    const r = await codexSignedInNow('/h/.codex-w', deps(env(), codex({ out: 'Logged in using ChatGPT\n', code: 0 }, { account: { email: 'me@example.test', planType: 'pro' } })))
    expect(r).toMatchObject({ identity: { email: 'me@example.test', plan: 'pro', signedIn: true, source: 'account-read' } })
  })

  it('stays signed in, with no email, when the app server can\'t tell', async () => {
    const r = await codexSignedInNow(null, deps(env(), codex({ out: 'Logged in using an API key - sk-***\n', code: 0 })))
    expect(r).toMatchObject({ identity: { email: null, signedIn: true, source: 'login-status' } })
    const r2 = await codexSignedInNow(null, deps(env(), codex({ out: 'Logged in using ChatGPT', code: 0 }, { account: null })))
    expect(r2).toMatchObject({ identity: { email: null, signedIn: true, source: 'account-read' } })
    expect('identity' in r2 && 'plan' in r2.identity).toBe(false)
  })

  it('reads "Not logged in" as signed out, without asking the app server', async () => {
    const { spawn, calls } = spawner((c) => c.child.finish('', 1, 'Not logged in\n'))
    const r = await codexSignedInNow(null, deps(env(), spawn))
    expect(r).toMatchObject({ identity: { email: null, signedIn: false, source: 'login-status' } })
    expect(calls.map((c) => c.args[0])).toEqual(['login'])
    expect('CODEX_HOME' in (calls[0].opts.env as Record<string, string>)).toBe(false)
  })

  it('says so when Codex can\'t be found, started, read or waited for', async () => {
    expect(await codexSignedInNow(null, deps({ PATH: join(root, 'none') }, codex({ out: '', code: 0 })))).toEqual({ error: 'Codex isn\'t installed where Termpolis can find it (not on PATH)' })
    expect(await codexSignedInNow(null, deps(env(), codex({ out: 'Error loading configuration: CODEX_HOME points to …', code: 1 })))).toEqual({ error: 'Codex\'s answer couldn\'t be read' })
    const { spawn } = spawner((c) => c.child.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' })))
    expect(await codexSignedInNow(null, deps(env(), spawn))).toEqual({ error: 'Codex couldn\'t be started (ENOENT)' })
    const { spawn: s2 } = spawner(() => {})
    expect(await codexSignedInNow(null, deps(env(), s2, { timeoutMs: 20 }))).toEqual({ error: 'Codex took longer than 15 s to answer' })
    // Exit 0 without the words is not a sign-in, nor a sign-out: Termpolis can't tell.
    expect(await codexSignedInNow(null, deps(env(), codex({ out: 'something else', code: 0 })))).toEqual({ error: 'Codex\'s answer couldn\'t be read' })
    // The words only count at the start of a line, and "Logged in" only with exit 0.
    expect(await codexSignedInNow(null, deps(env(), codex({ out: 'warning: Logged in using ChatGPT', code: 0 })))).toEqual({ error: 'Codex\'s answer couldn\'t be read' })
    expect(await codexSignedInNow(null, deps(env(), codex({ out: 'Logged in using ChatGPT', code: 1 })))).toEqual({ error: 'Codex\'s answer couldn\'t be read' })
  })

  it('reads the words on stdout as well, for a Codex that prints them there', async () => {
    const r = await codexSignedInNow(null, deps(env(), codex({ out: 'Logged in using ChatGPT\n', code: 0, stdout: true }, { account: null })))
    expect(r).toMatchObject({ identity: { signedIn: true } })
    const r2 = await codexSignedInNow(null, deps(env(), codex({ out: 'Not logged in\n', code: 1, stdout: true })))
    expect(r2).toMatchObject({ identity: { signedIn: false } })
  })

  it('uses the process env when none is given', async () => {
    const r = await codexSignedInNow(null, { cwd: root, spawn: codex({ out: '', code: 0 }) })
    expect(r).toBeTruthy()
  })
})
