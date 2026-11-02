// @vitest-environment node
//
// D11 (design §3.3, §11.1): the accounts code never opens a sign-in file. Two halves.
//
// 1. A source scan. No accounts module names a sign-in file or a credential folder anywhere but
//    accountFs.ts's deny-list, and none but accountFs.ts imports `fs`, so every file the accounts
//    code touches goes through that one seam.
// 2. A live tripwire. Every `fs` function is wrapped where it lives and the ESM bindings are
//    re-synced (module.syncBuiltinESMExports), so the modules under test call the wrappers. Not
//    vi.mock: Vitest can leave a Node builtin unmocked without a word, and a tripwire that never
//    fires passes for the wrong reason, so the first live test proves the wrappers are in the
//    path. Then a sign-in file sits in every profile (and ~/.ssh, ~/.aws, ~/.git-credentials),
//    and every accounts flow runs, from the Settings channels to agent integration's own connect
//    and disconnect over every profile and the uninstall-time disconnect. Not one path any of
//    them touched may be a sign-in file, and every decoy must be exactly as it was.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { createRequire, syncBuiltinESMExports } from 'module'
import { fileURLToPath } from 'url'
import { join, resolve } from 'path'
import { ACCOUNTS_IPC } from '../../src/shared/agentAccounts'
import type { AccountRowView, AccountsView, AddAccountResult } from '../../src/shared/agentAccounts'
import { _resetTerminalAccountsForTest, connectedProfileTargets, registerAccountsIpc } from '../../src/main/accountsIpc'
import type { AccountsIpcDeps } from '../../src/main/accountsIpc'
import { claudeSignedInNow, codexSignedInNow } from '../../src/main/accountIdentity'
import {
  bootAgentIntegration, disconnectAgentIntegration, getAgentIntegrationStatus, prepareCodexLaunch,
  removeCodexHomeTrust, setAgentIntegration, trustFolderForAgents,
} from '../../src/main/agentIntegrationManager'
import { runDisconnectAgentsCli } from '../../src/main/disconnectAgentsCli'
import { CLAUDE_ALLOW_RULES } from '../../src/main/agentMcpRegistry'
import { createSandbox, writeJson, writeLedger, writeText } from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'

const nodeRequire = createRequire(import.meta.url)
// The real module objects: what every `import … from 'fs'` in the code under test reads from.
const realFs = nodeRequire('fs') as Record<string, unknown> & typeof import('fs')
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

// Named here independently of accountFs.ts, so a mistake there can't hide here.
const SIGN_IN_FILES = ['.credentials.json', 'auth.json', 'oauth_creds.json', 'mcp-oauth-tokens.json', '.git-credentials']
const CREDENTIAL_FOLDERS = ['.ssh', '.aws']

function isSignInPath(p: string): boolean {
  const parts = resolve(p).split(/[\\/]+/).map((s) => s.toLowerCase())
  return SIGN_IN_FILES.includes(parts[parts.length - 1]) || parts.some((s) => CREDENTIAL_FOLDERS.includes(s))
}

// ── 1. The source scan ───────────────────────────────────────────────────────────────

/** Every accounts module, now and later: the main and shared ones by name, and whatever the
 *  renderer adds for accounts. */
function accountsModules(): string[] {
  const out: string[] = []
  const add = (dir: string, keep: (name: string) => boolean): void => {
    const full = join(ROOT, dir)
    if (!realFs.existsSync(full)) return
    for (const name of realFs.readdirSync(full)) if (keep(name)) out.push(join(full, name))
  }
  add('src/main', (n) => /^account.*\.ts$/i.test(n) || n === 'agentAccounts.ts' || n === 'agySwitch.ts' || n === 'signInSession.ts' || n === 'limitLook.ts')
  add('src/shared', (n) => n === 'agentAccounts.ts' || n === 'accountSwitch.ts' || n === 'accountLimits.ts' || n === 'signInScreens.ts')
  add('src/renderer/src/lib', (n) => /^(?:account|signIn).*\.ts$/i.test(n))
  add('src/renderer/src/components/Accounts', (n) => /\.tsx?$/.test(n))
  add('src/renderer/src/components/SettingsPane', (n) => /^Accounts.*\.tsx$/.test(n))
  return out.sort()
}

/** accountFs.ts with its two deny-list constants taken out: the one place the names belong. */
function withoutDenyList(file: string, text: string): string {
  if (!file.endsWith('accountFs.ts')) return text
  return text
    .replace(/export const CREDENTIAL_BASENAMES[\s\S]*?\n\]\n/, '')
    .replace(/const CREDENTIAL_FOLDERS[^\n]*\n/, '')
}

describe('the accounts source (D11)', () => {
  const files = accountsModules()

  it('scans every accounts module, the seam among them', () => {
    const names = files.map((f) => f.slice(ROOT.length + 1).replace(/\\/g, '/'))
    expect(names).toEqual(expect.arrayContaining([
      'src/main/accountFs.ts', 'src/main/accountIdentity.ts', 'src/main/accountProfiles.ts',
      'src/main/accountsIpc.ts', 'src/main/agentAccounts.ts', 'src/shared/agentAccounts.ts',
      'src/main/accountCarry.ts', 'src/main/accountSwitch.ts', 'src/shared/accountSwitch.ts', 'src/main/agySwitch.ts',
      // The hidden sign-in session and the screens it reads.
      'src/main/signInSession.ts', 'src/shared/signInScreens.ts',
    ]))
  })

  it('names no sign-in file or credential folder outside accountFs.ts\'s deny-list', () => {
    const found: string[] = []
    for (const f of files) {
      const text = withoutDenyList(f, realFs.readFileSync(f, 'utf-8')).toLowerCase()
      for (const n of SIGN_IN_FILES) if (text.includes(n)) found.push(`${f}: ${n}`)
      for (const d of CREDENTIAL_FOLDERS) if (new RegExp(`(^|[^\\w.-])\\${d}([\\\\/'"\`\\s]|$)`).test(text)) found.push(`${f}: ${d}`)
    }
    expect(found).toEqual([])
  })

  it('still finds the names in accountFs.ts\'s deny-list, so the scan can see them', () => {
    const seam = files.find((f) => f.endsWith('accountFs.ts')) as string
    const text = realFs.readFileSync(seam, 'utf-8')
    for (const n of SIGN_IN_FILES) expect(text).toContain(`'${n}'`)
    expect(withoutDenyList(seam, text)).not.toContain(`'${SIGN_IN_FILES[0]}'`)
  })

  it('opens files only through accountFs.ts: no other accounts module imports fs', () => {
    const importers: string[] = []
    for (const f of files) {
      if (f.endsWith('accountFs.ts')) continue
      const text = realFs.readFileSync(f, 'utf-8')
      if (/from\s+['"](node:)?fs(\/promises)?['"]|require\(\s*['"](node:)?fs(\/promises)?['"]\s*\)/.test(text)) importers.push(f)
    }
    expect(importers).toEqual([])
  })

  it('imports no electron in main or shared, so the uninstall-time disconnect can bundle the registry', () => {
    // resources/disconnect-agents.cjs runs in Electron's Node mode, where the electron API is not
    // there; agent integration reads the registry through these modules.
    const importers = files
      .filter((f) => !/[\\/]renderer[\\/]/.test(f))
      .filter((f) => /from\s+['"]electron['"]|require\(\s*['"]electron['"]\s*\)/.test(realFs.readFileSync(f, 'utf-8')))
    expect(importers).toEqual([])
  })
})

// ── 2. The live tripwire ─────────────────────────────────────────────────────────────

/** Functions that take two paths; every other one takes its path first, and its data after. */
const TWO_PATHS = new Set(['renameSync', 'rename', 'copyFileSync', 'copyFile', 'cpSync', 'cp', 'symlinkSync', 'symlink', 'linkSync', 'link'])

let recording = false
const touched: Array<{ fn: string; path: string }> = []
const originals = new Map<object, Map<string, unknown>>()

function pathOf(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (Buffer.isBuffer(v)) return v.toString('utf-8')
  if (v instanceof URL && v.protocol === 'file:') return fileURLToPath(v)
  return null
}

function recorder(name: string, label: string, original: (...a: unknown[]) => unknown): (...a: unknown[]) => unknown {
  return function (this: unknown, ...args: unknown[]): unknown {
    if (recording) {
      for (const a of args.slice(0, TWO_PATHS.has(name) ? 2 : 1)) {
        const p = pathOf(a)
        if (p !== null) touched.push({ fn: label, path: p })
      }
    }
    return original.apply(this, args)
  }
}

function wrapAll(target: Record<string, unknown>, prefix: string): void {
  const saved = new Map<string, unknown>()
  for (const [name, fn] of Object.entries(target)) {
    // camelCase functions are the API; PascalCase ones are classes (Stats, Dirent, ReadStream).
    if (typeof fn !== 'function' || !/^[a-z]/.test(name)) continue
    saved.set(name, fn)
    const original = fn as (...a: unknown[]) => unknown
    const wrapper = recorder(name, `${prefix}${name}`, original) as unknown as Record<string, unknown>
    // A function hung on another (realpathSync.native, which accountFs calls) is recorded too.
    for (const [k, v] of Object.entries(original as unknown as Record<string, unknown>)) {
      wrapper[k] = typeof v === 'function' ? recorder(name, `${prefix}${name}.${k}`, v as (...a: unknown[]) => unknown) : v
    }
    target[name] = wrapper
  }
  originals.set(target, saved)
}

function unwrapAll(): void {
  for (const [target, saved] of originals) for (const [name, fn] of saved) (target as Record<string, unknown>)[name] = fn
  originals.clear()
}

beforeAll(() => {
  wrapAll(realFs, 'fs.')
  wrapAll(realFs.promises as unknown as Record<string, unknown>, 'fs.promises.')
  syncBuiltinESMExports()
})

afterAll(() => {
  // The worker can run another file next: put the real functions back, in both module systems.
  unwrapAll()
  syncBuiltinESMExports()
})

let sb: Sandbox
let handlers: Map<string, (e: unknown, input?: unknown) => unknown>
let timers: Map<number, () => void>
let picks: string[]
const SECRET = 'sk-ant-' + 'a'.repeat(40)

/** A sign-in file's stand-in: its bytes and its mtime, checked again at the end. */
const decoys = new Map<string, { text: string; mtimeMs: number }>()

function decoy(file: string): void {
  writeText(file, 'a'.repeat(64))
  decoys.set(file, { text: realFs.readFileSync(file, 'utf-8'), mtimeMs: realFs.statSync(file).mtimeMs })
}

const noProcess = (): never => {
  throw new Error('this test starts no process')
}

function deps(): AccountsIpcDeps {
  const bin = join(sb.root, 'bin')
  return {
    paths: () => sb.paths,
    runtime: () => ({ ...sb.rt, hookShell: 'sh' }),
    integrationConnected: () => true,
    pickFolder: async () => picks.shift() ?? null,
    send: () => undefined,
    checkCwd: () => sb.root,
    // Each CLI is looked for on a PATH of the sandbox's own, found, and never started.
    env: { PATH: bin, PATHEXT: '.EXE;.CMD' },
    now: () => 1_000_000,
    signedInNow: (agent, profile, d) => (agent === 'claude'
      ? claudeSignedInNow(profile, { ...d, spawn: noProcess })
      : codexSignedInNow(profile, { ...d, spawn: noProcess })),
    setInterval: (fn) => {
      const id = timers.size + 1
      timers.set(id, fn)
      return id
    },
    // The hidden sign-in session's PTY: no process, only the words a CLI prints when it is done.
    signInSpawn: () => {
      let onData: (d: string) => void = () => undefined
      setTimeout(() => onData('Login successful\r\nSuccessfully logged in\r\n'), 0)
      return { pid: 0, write: () => undefined, kill: () => undefined, onData: (cb: (d: string) => void) => { onData = cb }, onExit: () => undefined }
    },
    clearInterval: (h) => { timers.delete(h as number) },
  }
}

async function ok<T = any>(channel: string, input?: unknown): Promise<T> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  const r = (await fn(null, input)) as { success: boolean; data?: T; error?: string }
  if (!r.success) throw new Error(`${channel} failed: ${r.error}`)
  return r.data as T
}

async function answered(channel: string, input?: unknown): Promise<void> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  await fn(null, input)
}

/** Every profile and secret store a real machine has, each holding a sign-in file. */
function seed(): void {
  const { home, paths } = sb
  for (const d of ['projects', 'commands', 'skills', 'agents', 'hooks', 'plugins']) realFs.mkdirSync(join(paths.claudeDir, d), { recursive: true })
  writeJson(join(paths.claudeDir, 'settings.json'), {
    model: 'opus', env: { ANTHROPIC_API_KEY: SECRET }, permissions: { allow: [...CLAUDE_ALLOW_RULES] },
    hooks: { StopFailure: [{ matcher: 'rate_limit', hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/auth-failover.sh' }] }] },
  })
  writeText(join(paths.claudeDir, 'CLAUDE.md'), '# notes\n')
  writeJson(paths.claudeJson, { oauthAccount: { emailAddress: 'a@example.test' }, primaryApiKey: SECRET })
  decoy(join(paths.claudeDir, '.credentials.json'))
  writeText(join(paths.claudeDir, 'accounts.sh'), [
    'ACCOUNTS=(personal codedev work)',
    'declare -A ACCOUNT_EMAIL=(',
    '  [personal]="a@example.test"',
    '  [codedev]="b@example.test"',
    '  [work]="w@example.test"',
    ')',
    'declare -A ACCOUNT_DIR=(',
    '  [personal]=".claude"',
    '  [codedev]=".claude-codedev"',
    '  [work]=".claude-work"',
    ')',
    'DEFAULT_ACCOUNT=personal',
    'FAILOVER_ORDER=(personal codedev)',
    'LIMIT_COOLDOWN=18000',
    '',
  ].join('\n'))
  writeText(join(paths.claudeDir, '.limited-codedev'), '1000\n')

  // Two profiles a user made by hand, each signed in by itself.
  for (const [name, email] of [['.claude-codedev', 'b@example.test'], ['.claude-work', 'w@example.test']] as const) {
    const dir = join(home, name)
    realFs.mkdirSync(dir, { recursive: true })
    sb.link(join(paths.claudeDir, 'projects'), join(dir, 'projects'))
    writeJson(join(dir, 'settings.json'), { model: 'sonnet', skipDangerousModePermissionPrompt: true, env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET } })
    writeJson(join(dir, '.claude.json'), { oauthAccount: { emailAddress: email }, primaryApiKey: SECRET })
    decoy(join(dir, '.credentials.json'))
  }
  // A link named like a sign-in file, which a share scan must not look through.
  sb.link(join(paths.claudeDir, 'commands'), join(home, '.claude-codedev', 'auth.json'))

  realFs.mkdirSync(join(paths.codexHome, 'sessions'), { recursive: true })
  writeText(join(paths.codexHome, 'config.toml'), [
    'model = "gpt-5"',
    '[mcp_servers.other]',
    'command = "x"',
    'env = { TOKEN = "' + 'a'.repeat(32) + '" }',
    '',
  ].join('\n'))
  decoy(join(paths.codexHome, 'auth.json'))
  decoy(join(paths.geminiDir, 'oauth_creds.json'))
  decoy(join(paths.geminiDir, 'mcp-oauth-tokens.json'))
  decoy(join(home, '.git-credentials'))
  decoy(join(home, '.ssh', 'id_ed25519'))
  decoy(join(home, '.aws', 'credentials'))

  // The CLIs, where a PATH lookup finds them: claude as an exe, codex as an npm shim with the
  // vendor exe it runs. None of them is ever started (noProcess).
  const bin = join(sb.root, 'bin')
  writeText(join(bin, 'claude.exe'), '')
  writeText(join(bin, 'codex.cmd'), '')
  writeText(join(bin, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'), '')
}

beforeEach(() => {
  sb = createSandbox()
  decoys.clear()
  touched.length = 0
  timers = new Map()
  picks = []
  _resetTerminalAccountsForTest()
  seed()
  writeLedger(sb, { consent: 'granted' })
  handlers = new Map()
  registerAccountsIpc({ handle: (ch, fn) => { handlers.set(ch, fn) } }, deps())
})

afterEach(() => {
  recording = false
  _resetTerminalAccountsForTest()
  sb.dispose()
})

function signInPathsTouched(): string[] {
  return touched.filter((t) => isSignInPath(t.path)).map((t) => `${t.fn} ${t.path}`)
}

function seen(p: string): boolean {
  const want = resolve(p).toLowerCase()
  return touched.some((t) => resolve(t.path).toLowerCase() === want)
}

describe('the live tripwire (D11)', () => {
  it('sees every fs call the accounts code makes, so a quiet run means something', async () => {
    recording = true
    // A sign-in file read straight through fs is caught...
    realFs.readFileSync(join(sb.paths.claudeDir, '.credentials.json'), 'utf-8')
    expect(signInPathsTouched()).toHaveLength(1)
    touched.length = 0
    // ...and so is what the accounts code reads through its own imports of fs: the registry
    // (accountFs), a profile's .claude.json (readClaudeJsonFields), and agent integration's
    // writes (agentConfigIO).
    await ok<AccountsView>(ACCOUNTS_IPC.list)
    expect(seen(join(sb.paths.userData, 'agent-accounts.json'))).toBe(true)
    picks.push(join(sb.home, '.claude-codedev'))
    await ok(ACCOUNTS_IPC.pickFolder, { agent: 'claude' })
    await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'codedev', folder: 'existing', connect: true })
    expect(seen(join(sb.home, '.claude-codedev', '.claude.json'))).toBe(true)
    expect(seen(join(sb.home, '.claude-codedev', 'settings.json'))).toBe(true)
    expect(signInPathsTouched()).toEqual([])
  })

  it('opens no sign-in file in any accounts flow, and leaves every one as it was', async () => {
    recording = true
    const list = (): Promise<AccountsView> => ok<AccountsView>(ACCOUNTS_IPC.list)
    await list()

    // Settings ▸ Accounts: import accounts.sh, adopt, create (Claude Code and Codex), label agy.
    await ok(ACCOUNTS_IPC.importPreview)
    await ok(ACCOUNTS_IPC.import, { connect: { codedev: true } })
    picks.push(join(sb.home, '.claude-work'))
    await ok(ACCOUNTS_IPC.pickFolder, { agent: 'claude' })
    await answered(ACCOUNTS_IPC.add, { agent: 'claude', label: 'work2', folder: 'existing' })
    const made = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'side', email: 's@example.test', folder: 'new', copy: true, connect: true, share: ['projects', 'commands', 'skills', 'agents', 'plugins', 'hooks'] })
    const codex = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'codex', label: 'second', folder: 'new', copy: true, connect: true })
    await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'agy', label: 'google', email: 'g@example.test' })

    let view = await list()
    const byLabel = (l: string): AccountRowView => view.accounts.find((a) => a.label === l) as AccountRowView
    const codedev = byLabel('codedev')
    const work = byLabel('work')

    // Each row's actions, in each state.
    await ok(ACCOUNTS_IPC.setConnect, { id: work.id, connect: true })
    await ok(ACCOUNTS_IPC.stripCopied, { id: work.id })
    await ok(ACCOUNTS_IPC.setConnect, { id: work.id, connect: false })
    await ok(ACCOUNTS_IPC.update, { id: codedev.id, label: 'codedev2', email: 'b2@example.test', autoOffer: false, color: '#112233' })
    await ok(ACCOUNTS_IPC.move, { id: codedev.id, by: -1 })
    await ok(ACCOUNTS_IPC.setPreferred, { agent: 'claude', id: codedev.id })
    await ok(ACCOUNTS_IPC.setChooser, { on: false })
    await ok(ACCOUNTS_IPC.hideAdvice, { which: 'hookAdvice' })
    await ok(ACCOUNTS_IPC.noteLimit, { id: codedev.id, text: 'You\'ve hit your weekly limit', window: 'weekly' })
    await ok(ACCOUNTS_IPC.clearLimit, { id: codedev.id })
    // "Signed in now": each CLI is found on PATH (the codex shim resolved to its vendor exe) and
    // never started.
    await answered(ACCOUNTS_IPC.check, { id: codedev.id })
    await answered(ACCOUNTS_IPC.check, { id: codex.account.id })
    // A sign-in, in the hidden session: each CLI found on PATH, started behind a PTY that runs no
    // process and says it signed in, then asked by its status command, never started either.
    for (const a of [made.account, codex.account]) {
      const { sessionId } = await ok<{ sessionId: string }>(ACCOUNTS_IPC.signInStart, { accountId: a.id })
      for (const fn of [...timers.values()]) fn()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await answered(ACCOUNTS_IPC.signInInput, { sessionId, kind: 'cancel' })
    }

    // Agent integration over every connected profile, then Disconnect and the uninstaller's.
    const rt = { ...sb.rt, hookShell: 'sh' as const, profiles: connectedProfileTargets(sb.paths) }
    setAgentIntegration(rt, { connect: true, primerHook: true })
    bootAgentIntegration(rt)
    getAgentIntegrationStatus(sb.paths)
    const work2 = join(sb.root, 'proj')
    realFs.mkdirSync(work2, { recursive: true })
    const claudeTarget = rt.profiles.find((t) => t.agent === 'claude')
    trustFolderForAgents(sb.paths, work2, null, claudeTarget)
    prepareCodexLaunch(sb.paths, work2, {}, codex.account.profile as string)
    removeCodexHomeTrust(sb.paths, codex.account.profile as string)
    view = await list()
    await ok(ACCOUNTS_IPC.remove, { id: byLabel('side').id })
    disconnectAgentIntegration(sb.paths)
    runDisconnectAgentsCli([sb.paths.userData], { ...process.env, HOME: sb.home }, { log: () => undefined, error: () => undefined, homedir: () => sb.home })
    await list()
    recording = false

    // A real run of every flow touched plenty, and none of it was a sign-in file.
    expect(touched.length).toBeGreaterThan(100)
    expect(signInPathsTouched()).toEqual([])
    for (const [file, was] of decoys) {
      expect(realFs.readFileSync(file, 'utf-8')).toBe(was.text)
      expect(realFs.statSync(file).mtimeMs).toBe(was.mtimeMs)
    }
    // Nor did any copy or link carry one into a profile Termpolis made.
    for (const dir of [made.account.profile, codex.account.profile] as string[]) {
      for (const name of realFs.readdirSync(dir)) expect(SIGN_IN_FILES).not.toContain(name.toLowerCase())
    }
  })
})
