// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  _resetTerminalAccountsForTest, accountSettingsEnv, codexHomeFor, connectedProfileTargets, forgetTerminalAccount,
  isAccountChangedByHand, isTerminalAccountConnected, noteTerminalAccount, noteTypedInput, registerAccountsIpc, resolveAccountTarget, resolveLaunchTarget,
  terminalAccountId, terminalsOnAccount, unofferedLoginIn,
} from '../../src/main/accountsIpc'
import type { AccountsIpcDeps } from '../../src/main/accountsIpc'
import { ACCOUNTS_IPC } from '../../src/shared/agentAccounts'
import type { AccountIdentity, AccountRowView, AccountsView, AddAccountResult, AgentAccount } from '../../src/shared/agentAccounts'
import type { IdentityCheck } from '../../src/main/accountIdentity'
import { accountFs } from '../../src/main/accountFs'
import { loadAccounts } from '../../src/main/agentAccounts'
import type { AccountsDoc } from '../../src/main/agentAccounts'
import type { AccountFs } from '../../src/main/accountFs'
import { CLAUDE_ALLOW_RULES } from '../../src/main/agentMcpRegistry'
import { createSandbox, readJson, writeJson, writeLedger, writeText } from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'

let sb: Sandbox
let handlers: Map<string, (e: unknown, input?: unknown) => unknown>
let sent: Array<{ channel: string; payload: any }>
let picks: Array<string | null>
let connected: boolean
let checks: Array<{ agent: string; profile: string | null }>
let checkAnswer: IdentityCheck
let timers: Map<number, () => void>
let clock: number

const SECRET = 'sk-ant-' + 'a'.repeat(40)

function deps(over: Partial<AccountsIpcDeps> = {}): AccountsIpcDeps {
  return {
    paths: () => sb.paths,
    runtime: () => ({ ...sb.rt, hookShell: 'sh' }),
    integrationConnected: () => connected,
    pickFolder: async () => picks.shift() ?? null,
    send: (channel, payload) => { sent.push({ channel, payload }) },
    checkCwd: () => sb.root,
    env: {},
    now: () => clock,
    signedInNow: async (agent, profile) => {
      checks.push({ agent, profile })
      return checkAnswer
    },
    setInterval: (fn) => {
      const id = timers.size + 1
      timers.set(id, fn)
      return id
    },
    clearInterval: (h) => { timers.delete(h as number) },
    ...over,
  }
}

function register(over: Partial<AccountsIpcDeps> = {}): void {
  handlers = new Map()
  registerAccountsIpc({ handle: (ch, fn) => { handlers.set(ch, fn) } }, deps(over))
}

async function call<T = any>(channel: string, input?: unknown): Promise<{ success: boolean; data?: T; error?: string }> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return (await fn(null, input)) as { success: boolean; data?: T; error?: string }
}

async function ok<T = any>(channel: string, input?: unknown): Promise<T> {
  const r = await call<T>(channel, input)
  if (!r.success) throw new Error(`${channel} failed: ${r.error}`)
  return r.data as T
}

async function fails(channel: string, input?: unknown): Promise<string> {
  const r = await call(channel, input)
  if (r.success) throw new Error(`${channel} should have failed`)
  return r.error as string
}

beforeEach(() => {
  sb = createSandbox()
  sent = []
  picks = []
  connected = false
  checks = []
  checkAnswer = { identity: { email: 'b@example.test', signedIn: true, checkedAt: 1, source: 'auth-status', plan: 'max' } }
  timers = new Map()
  clock = 1_000_000
  _resetTerminalAccountsForTest()
  register()
})

afterEach(() => {
  _resetTerminalAccountsForTest()
  sb.dispose()
})

function mainClaude(): string {
  const main = sb.paths.claudeDir
  for (const d of ['projects', 'commands', 'skills', 'agents']) mkdirSync(join(main, d), { recursive: true })
  writeJson(join(main, 'settings.json'), { model: 'opus', env: { ANTHROPIC_API_KEY: SECRET }, permissions: { allow: [...CLAUDE_ALLOW_RULES] } })
  writeJson(sb.paths.claudeJson, { oauthAccount: { emailAddress: 'a@example.test' }, primaryApiKey: SECRET })
  return main
}

function grant(): void {
  writeLedger(sb, { consent: 'granted' })
  connected = true
}

async function list(): Promise<AccountsView> {
  return ok<AccountsView>(ACCOUNTS_IPC.list)
}

describe('every channel answers in the IPC envelope', () => {
  it('registers every channel the renderer calls', () => {
    const events: string[] = [ACCOUNTS_IPC.terminalAccount, ACCOUNTS_IPC.switchProgress, ACCOUNTS_IPC.signInState]
    const expected = Object.values(ACCOUNTS_IPC).filter((c) => !events.includes(c)).sort()
    expect([...handlers.keys()].sort()).toEqual(expected)
  })

  it('reports a rejection that isn\'t an Error by its text', async () => {
    register({ pickFolder: async () => { throw 'the dialog was refused' } })
    expect(await fails(ACCOUNTS_IPC.pickFolder, { agent: 'claude' })).toBe('the dialog was refused')
  })

  it('works with its own clock, env and timers when none are given', async () => {
    // A sign-in session's PTY that runs nothing: its timer is the real one.
    const pty = { pid: 0, write: () => undefined, kill: () => undefined, onData: () => undefined, onExit: () => undefined }
    register({ now: undefined, env: undefined, setInterval: undefined, clearInterval: undefined, signInSpawn: () => pty, signInCli: (_a, args) => ({ file: 'claude', args }) })
    mainClaude()
    const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'b', folder: 'new', copy: false })
    const { sessionId } = await ok<{ sessionId: string }>(ACCOUNTS_IPC.signInStart, { accountId: r.account.id })
    expect(await ok(ACCOUNTS_IPC.signInInput, { sessionId, kind: 'cancel' })).toEqual({ ok: true })
    expect((await list()).accounts).toHaveLength(2)
  })

  it('moves each Claude account into the folder its login sits in, and saves it (1.54.6)', async () => {
    mainClaude() // the default profile holds a@example.test
    const other = join(sb.home, '.claude-other')
    mkdirSync(other, { recursive: true })
    writeJson(join(other, '.claude.json'), { oauthAccount: { emailAddress: 'b@example.test' } })
    const acc = (id: string, label: string, email: string, profile: string | null): AgentAccount =>
      ({ id, agent: 'claude', label, email, profile, autoOffer: true, order: 0, connect: true, origin: 'adopted', links: [] })
    writeJson(join(sb.paths.userData, 'agent-accounts.json'), {
      version: 1, chooser: true, preferred: {}, cooldownSec: {}, limits: {}, identity: {},
      accounts: [acc('acc_000000000001', 'b', 'b@example.test', null), acc('acc_000000000002', 'a', 'a@example.test', other)],
    })
    // Terminals run in a folder: each follows its folder to the account that now has it.
    noteTerminalAccount('t-default', 'acc_000000000001')
    noteTerminalAccount('t-other', 'acc_000000000002')
    noteTerminalAccount('t-none', null)
    noteTerminalAccount('t-gone', 'acc_00000000dead')
    const rows = (await list()).accounts.map((r) => [r.label, r.profile])
    expect([terminalAccountId('t-default'), terminalAccountId('t-other'), terminalAccountId('t-none'), terminalAccountId('t-gone')])
      .toEqual(['acc_000000000002', 'acc_000000000001', null, 'acc_00000000dead'])
    expect(sent.filter((s) => s.channel === ACCOUNTS_IPC.terminalAccount).map((s) => s.payload)).toEqual([
      { terminalId: 't-default', accountId: 'acc_000000000002', byHand: false },
      { terminalId: 't-other', accountId: 'acc_000000000001', byHand: false },
    ])
    expect(rows).toEqual(expect.arrayContaining([['b', other], ['a', null]]))
    const saved = loadAccounts(sb.paths.userData)
    expect(saved.ok && saved.doc.file.accounts.map((a) => [a.label, a.profile])).toEqual([['b', other], ['a', null]])
    // Settled: the next list reads it as it is.
    expect((await list()).accounts.map((r) => [r.label, r.profile])).toEqual(rows)
  })

  it('still lists the accounts, unmoved, when the moves cannot be saved', async () => {
    mainClaude() // the default profile holds a@example.test
    const other = join(sb.home, '.claude-other')
    mkdirSync(other, { recursive: true })
    writeJson(join(other, '.claude.json'), { oauthAccount: { emailAddress: 'b@example.test' } })
    const acc = (id: string, label: string, email: string, profile: string | null): AgentAccount =>
      ({ id, agent: 'claude', label, email, profile, autoOffer: true, order: 0, connect: true, origin: 'adopted', links: [] })
    writeJson(join(sb.paths.userData, 'agent-accounts.json'), {
      version: 1, chooser: true, preferred: {}, cooldownSec: {}, limits: {}, identity: {},
      accounts: [acc('acc_000000000001', 'b', 'b@example.test', null), acc('acc_000000000002', 'a', 'a@example.test', other)],
    })
    // OneDrive or a scanner holds agent-accounts.json.
    const fsx: AccountFs = { ...accountFs, writePrivate: () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }) } }
    register({ fsx })
    noteTerminalAccount('t-default', 'acc_000000000001')
    expect((await list()).accounts.map((r) => [r.label, r.profile])).toEqual(expect.arrayContaining([['b', null], ['a', other]]))
    expect(terminalAccountId('t-default')).toBe('acc_000000000001')
  })

  it('reads a missing input as empty, and turns a thrown error into { success: false }', async () => {
    expect(await fails(ACCOUNTS_IPC.add)).toBe('unknown agent')
    expect(await fails(ACCOUNTS_IPC.add, 'not an object')).toBe('unknown agent')
    writeText(join(sb.paths.userData, 'agent-accounts.json'), '{ broken')
    expect(await fails(ACCOUNTS_IPC.list)).toBe('agent-accounts.json is not valid JSON, so Termpolis left it as it is')
    expect(await fails(ACCOUNTS_IPC.update, { id: 'x' })).toBe('agent-accounts.json is not valid JSON, so Termpolis left it as it is')
  })
})

describe('accounts:list', () => {
  it('shows nothing for a user who added no account (D13)', async () => {
    const v = await list()
    expect(v).toMatchObject({ accounts: [], preferred: {}, chooser: true, hidden: {}, integrationConnected: false, importAvailable: false, drift: [] })
    expect(v.advice).toEqual({ stopFailureHooks: [], authOverrides: [] })
    expect(v.home).toBe(sb.home)
    expect(existsSync(join(sb.paths.userData, 'agent-accounts.json'))).toBe(false)
  })

  it('never puts a .claude.json key, or any config file, in the view (R12)', async () => {
    mainClaude()
    await ok(ACCOUNTS_IPC.add, { agent: 'claude', label: 'codedev', folder: 'new', copy: true })
    const text = JSON.stringify(await list())
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('primaryApiKey')
  })
})

describe('accounts:add, Claude Code with a new folder', () => {
  it('makes ~/.claude-<slug>, lists the main profile too, and leaves it unconnected unless asked', async () => {
    mainClaude()
    const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'Code Dev', email: 'b@example.test', folder: 'new' })
    const dir = join(sb.home, '.claude-code-dev')
    expect(r.account).toMatchObject({ label: 'Code Dev', email: 'b@example.test', profile: dir, folder: dir, isDefault: false, connect: false, origin: 'created', folderExists: true })
    expect(r.account.shares.sort()).toEqual(['agents', 'commands', 'projects', 'skills'])
    expect(r.copied).toEqual(['settings.json'])
    expect(r.leftOut).toEqual(['env'])
    expect(r.changes).toEqual([])
    expect(r.notes).toEqual(['Your main Claude Code profile is listed too, as main.'])
    expect(r.accountsShLines).toBeUndefined()
    const v = await list()
    expect(v.accounts.map((a) => [a.label, a.isDefault, a.order, a.lastEmail])).toEqual([['main', true, 0, 'a@example.test'], ['Code Dev', false, 1, null]])
    expect(v.accounts[0].email).toBe('a@example.test')
    expect(lstatSync(join(dir, 'projects')).isSymbolicLink()).toBe(true)
  })

  it('connects the new profile, with Agent Integration on and Connect ticked', async () => {
    mainClaude()
    grant()
    const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'codedev', folder: 'new', connect: true, share: ['projects'], copy: false })
    expect(r.account.connect).toBe(true)
    expect(r.changes.map((c) => c.what)).toEqual(['MCP server', 'Tool permissions', 'SessionStart memory hook'])
    expect(readJson(join(sb.home, '.claude-codedev', '.claude.json')).mcpServers.termpolis).toBeTruthy()
    expect(r.account.connection).toEqual({ server: true, hook: true, allow: true })
    expect(r.account.shares).toEqual(['projects'])
  })

  it('records the wish but writes nothing while Agent Integration is off', async () => {
    mainClaude()
    const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'codedev', folder: 'new', connect: true })
    expect(r.account.connect).toBe(true)
    expect(r.changes).toEqual([])
    expect(existsSync(join(sb.home, '.claude-codedev', '.claude.json'))).toBe(false)
  })

  it('shows the accounts.sh lines when that file exists', async () => {
    mainClaude()
    writeText(join(sb.paths.claudeDir, 'accounts.sh'), 'ACCOUNTS=(personal)\ndeclare -A ACCOUNT_DIR=(\n  [personal]=".claude"\n)\nDEFAULT_ACCOUNT=personal\n')
    const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'foo', email: 'f@example.test', folder: 'new', copy: false })
    expect(r.accountsShLines).toEqual([
      'ACCOUNTS=(personal foo)   # add foo',
      '  [foo]="f@example.test"   # in ACCOUNT_EMAIL',
      '  [foo]=".claude-foo"   # in ACCOUNT_DIR',
    ])
  })

  it('refuses a bad name, email, or a name already taken, before making any folder', async () => {
    mainClaude()
    expect(await fails(ACCOUNTS_IPC.add, { agent: 'claude', label: '' })).toBe('give the account a name: 1 to 40 characters')
    expect(await fails(ACCOUNTS_IPC.add, { agent: 'claude', label: 'x', email: 'nope' })).toBe('that email address isn\'t a plain address')
    expect(await fails(ACCOUNTS_IPC.add, { agent: 'claude', label: '日本', folder: 'new' })).toBe('the name gives no folder name: use letters or digits')
    await ok(ACCOUNTS_IPC.add, { agent: 'claude', label: 'dev', folder: 'new', copy: false })
    expect(await fails(ACCOUNTS_IPC.add, { agent: 'claude', label: 'DEV', folder: 'new' })).toBe('Claude Code already has an account named DEV')
    expect(readdirSync(sb.home).filter((n) => n.startsWith('.claude-')).sort()).toEqual(['.claude-dev'])
    // A main profile named "main" already pushes the listed one to "main 2".
  })

  it('says where a half-made folder was left', async () => {
    mainClaude()
    const fsx: AccountFs = {
      ...accountFs,
      removeEmptyDir: () => { throw new Error('busy') },
      rename: () => { throw new Error('rename failed') },
    }
    register({ fsx })
    const e = await fails(ACCOUNTS_IPC.add, { agent: 'claude', label: 'half', folder: 'new', copy: false })
    expect(e).toMatch(/^rename failed\. Some of it is still in ~[\\/]\.claude-half\.partial-[0-9a-f]{6}$/)
  })

  it('rolls the folder back when the registry can\'t take the account', async () => {
    mainClaude()
    let saves = 0
    const fsx: AccountFs = {
      ...accountFs,
      writePrivate: (p, text) => {
        if (p.endsWith('agent-accounts.json') && ++saves === 1) throw new Error('disk full')
        accountFs.writePrivate(p, text)
      },
    }
    register({ fsx })
    expect(await fails(ACCOUNTS_IPC.add, { agent: 'claude', label: 'rb', folder: 'new', copy: false })).toBe('agent-accounts.json could not be saved (error)')
    expect(existsSync(join(sb.home, '.claude-rb'))).toBe(false)
  })

  it('names a listed main profile "main 2" when "main" is taken', async () => {
    mainClaude()
    await ok(ACCOUNTS_IPC.add, { agent: 'agy', label: 'main' })
    writeJson(join(sb.paths.userData, 'agent-accounts.json'), {
      version: 1,
      accounts: [{ id: 'acc_000000000009', agent: 'claude', label: 'Main', profile: join(sb.home, '.claude-x'), links: [] }],
    })
    const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'other', folder: 'new', copy: false })
    expect(r.notes?.[0]).toBe('Your main Claude Code profile is listed too, as main 2.')
  })
})

describe('accounts:recopy ("Re-copy from main profile")', () => {
  it('offers it once the main settings changed since the copy, then re-copies, reconnects, and stops offering', async () => {
    mainClaude()
    grant()
    // A second past the main files' writes: APFS keeps sub-millisecond mtimes, so a file written in
    // the same millisecond as a whole-ms Date.now() stamp would read as changed since the copy.
    clock = Date.now() + 1000
    const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'b', folder: 'new', connect: true })
    const rowOf = async (): Promise<AccountRowView> => (await list()).accounts.find((a) => a.id === r.account.id) as AccountRowView
    expect((await rowOf()).recopyAvailable).toBe(false)
    const later = new Date(clock + 5000)
    utimesSync(join(sb.paths.claudeDir, 'settings.json'), later, later)
    expect((await rowOf()).recopyAvailable).toBe(true)
    const profile = join(sb.home, '.claude-b')
    writeJson(join(profile, 'settings.json'), { model: 'haiku' })
    clock += 10_000
    const done = await ok(ACCOUNTS_IPC.recopy, { id: r.account.id })
    expect(done.copied).toEqual(['settings.json'])
    expect(done.leftOut).toEqual(['env'])
    // The fresh copy has Termpolis's entries stripped; connecting put them back.
    expect(done.changes.map((c: { what: string }) => c.what)).toContain('Tool permissions')
    const settings = readJson(join(profile, 'settings.json'))
    expect(settings.model).toBe('opus')
    expect(JSON.stringify(settings)).not.toContain(SECRET)
    expect(settings.permissions.allow).toEqual(expect.arrayContaining([...CLAUDE_ALLOW_RULES]))
    expect(done.account.recopyAvailable).toBe(false)
  })

  it('re-copies an unconnected profile without connecting it', async () => {
    mainClaude()
    clock = Date.now()
    const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'b', folder: 'new' })
    clock += 10_000
    const done = await ok(ACCOUNTS_IPC.recopy, { id: r.account.id })
    expect(done.changes).toEqual([])
    expect(readJson(join(sb.home, '.claude-b', 'settings.json')).permissions).toBeUndefined()
  })

  it('refuses an account that never started from a copy, an agy label, a missing folder and a broken main file', async () => {
    mainClaude()
    clock = Date.now()
    const plain = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'plain', folder: 'new', copy: false })
    expect(plain.account.recopyAvailable).toBe(false)
    expect(await fails(ACCOUNTS_IPC.recopy, { id: plain.account.id })).toBe('plain was never started from a copy of your main profile')
    const g = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'agy', label: 'g' })
    expect(await fails(ACCOUNTS_IPC.recopy, { id: g.account.id })).toBe('g was never started from a copy of your main profile')
    const b = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'b', folder: 'new' })
    writeText(join(sb.paths.claudeDir, 'settings.json'), '{ broken')
    expect(await fails(ACCOUNTS_IPC.recopy, { id: b.account.id })).toBe('the main profile\'s settings.json is not valid JSON')
    // A broken main file is never "newer": nothing to offer from a file that can't be copied? It
    // is still offered, so the user sees the reason when pressing it.
    const doc = readJson(join(sb.paths.userData, 'agent-accounts.json'))
    const entry = doc.accounts.find((a: { id: string }) => a.id === b.account.id)
    entry.profile = join(sb.home, '.claude-lost')
    writeJson(join(sb.paths.userData, 'agent-accounts.json'), doc)
    expect(await fails(ACCOUNTS_IPC.recopy, { id: b.account.id })).toBe('b\'s profile folder doesn\'t exist')
    expect((await list()).accounts.find((a) => a.id === b.account.id)?.recopyAvailable).toBe(false)
  })
})

describe('accounts:add, an existing folder', () => {
  it('adopts the folder picked in main\'s own dialog, and never takes a path from the renderer', async () => {
    mainClaude()
    const dir = join(sb.home, '.claude-work')
    mkdirSync(dir)
    sb.link(join(sb.paths.claudeDir, 'projects'), join(dir, 'projects'))
    expect(await fails(ACCOUNTS_IPC.add, { agent: 'claude', label: 'work', folder: 'existing', path: dir })).toBe('choose the folder first')
    picks.push(dir)
    const picked = await ok(ACCOUNTS_IPC.pickFolder, { agent: 'claude' })
    expect(picked).toEqual({ folder: `~${dir.slice(sb.home.length)}`, isDefault: false, shares: ['projects'], exists: true })
    const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'work', folder: 'existing', autoOffer: false })
    expect(r.account).toMatchObject({ profile: dir, origin: 'adopted', autoOffer: false, connect: false, shares: ['projects'] })
    // The pick is used once.
    expect(await fails(ACCOUNTS_IPC.add, { agent: 'claude', label: 'again', folder: 'existing' })).toBe('choose the folder first')
  })

  it('adopts the default folder as the default account (profile null), connected through Agent Integration', async () => {
    mainClaude()
    picks.push(sb.paths.claudeDir)
    expect(await ok(ACCOUNTS_IPC.pickFolder, { agent: 'claude' })).toMatchObject({ isDefault: true, shares: [], exists: true })
    const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'personal', folder: 'existing' })
    expect(r.account).toMatchObject({ profile: null, isDefault: true, connect: true })
    expect(r.notes).toBeUndefined()
  })

  it('reports a folder that can\'t be a profile, and a cancelled dialog', async () => {
    picks.push(sb.home)
    expect(await ok(ACCOUNTS_IPC.pickFolder, { agent: 'codex' })).toEqual({ folder: '~', error: 'your home folder itself can\'t be a profile' })
    expect(await fails(ACCOUNTS_IPC.add, { agent: 'codex', label: 'x', folder: 'existing' })).toBe('choose the folder first')
    expect(await ok(ACCOUNTS_IPC.pickFolder, {})).toEqual({ folder: null })
  })

  it('refuses at Add a folder another account took since it was picked', async () => {
    const dir = join(sb.home, '.claude-shared')
    mkdirSync(dir)
    picks.push(dir)
    await ok(ACCOUNTS_IPC.pickFolder, { agent: 'claude' })
    writeJson(join(sb.paths.userData, 'agent-accounts.json'), {
      version: 1, accounts: [{ id: 'acc_000000000001', agent: 'claude', label: 'first', profile: dir, links: [] }],
    })
    expect(await fails(ACCOUNTS_IPC.add, { agent: 'claude', label: 'second', folder: 'existing' })).toBe('first already uses that folder')
  })
})

describe('accounts:add, Codex and agy', () => {
  it('makes a Codex home with sessions linked', async () => {
    mkdirSync(join(sb.paths.codexHome, 'sessions'), { recursive: true })
    const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'codex', label: 'work', folder: 'new', share: ['sessions', 'projects'] })
    expect(r.account).toMatchObject({ agent: 'codex', profile: join(sb.home, '.codex-work'), shares: ['sessions'] })
    expect(lstatSync(join(sb.home, '.codex-work', 'sessions')).isSymbolicLink()).toBe(true)
  })

  it('gives a new account the colour the Add wizard picked, and none for anything but #rrggbb', async () => {
    mainClaude()
    const c = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'tinted', folder: 'new', copy: false, color: '#7ee2a3' })
    expect(c.account.color).toBe('#7ee2a3')
    const g = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'agy', label: 'g', color: '#C678DD' })
    expect(g.account.color).toBe('#C678DD')
    const onDisk = (): unknown[] => (JSON.parse(readFileSync(join(sb.paths.userData, 'agent-accounts.json'), 'utf8')) as { accounts: Array<{ color?: string }> })
      .accounts.map((a) => a.color).filter((c) => c !== undefined)
    for (const [label, color] of [['plain', undefined], ['named', 'red'], ['short', '#abc'], ['script', 'url(javascript:x)'], ['num', 7]] as const) {
      const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'agy', label, color })
      expect(r.account.color).toBeUndefined()
      // Never written either, not even until the next save: the registry holds the good colours only.
      expect(onDisk()).toEqual(['#7ee2a3', '#C678DD'])
    }
  })

  it('keeps an agy account as a label only: a name and a Google email, no folder, nothing to connect', async () => {
    const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'agy', label: 'google', email: 'g@example.test', folder: 'new', connect: true })
    expect(r.account).toMatchObject({ agent: 'agy', label: 'google', email: 'g@example.test', profile: null, folder: null, isDefault: false, connect: false, origin: 'label', connection: null })
    expect(r.notes).toBeUndefined()
    expect(readdirSync(sb.home)).toEqual([])
    expect(await fails(ACCOUNTS_IPC.add, { agent: 'agy', label: 'Google' })).toBe('Gemini / Antigravity CLI already has an account named Google')
    const id = r.account.id
    expect(await fails(ACCOUNTS_IPC.setConnect, { id, connect: true })).toBe('the Antigravity CLI has no profile to connect')
    expect(await fails(ACCOUNTS_IPC.check, { id })).toMatch(/can't ask the Antigravity CLI/)
    expect(await fails(ACCOUNTS_IPC.signInStart, { accountId: id })).toBe('the Antigravity CLI signs in through its switch')
  })
})

describe('accounts:update, move, remove', () => {
  async function three(): Promise<AccountRowView[]> {
    mainClaude()
    await ok(ACCOUNTS_IPC.add, { agent: 'claude', label: 'b', folder: 'new', copy: false })
    await ok(ACCOUNTS_IPC.add, { agent: 'claude', label: 'c', folder: 'new', copy: false })
    return (await list()).accounts
  }

  it('renames, re-addresses, turns off offering automatically and colours an account', async () => {
    const [, b] = await three()
    const r = await ok<AccountRowView>(ACCOUNTS_IPC.update, { id: b.id, label: 'bee', email: 'bee@example.test', autoOffer: false, color: '#123abc' })
    expect(r).toMatchObject({ label: 'bee', email: 'bee@example.test', autoOffer: false, color: '#123abc' })
    const r2 = await ok<AccountRowView>(ACCOUNTS_IPC.update, { id: b.id, email: '', color: 'red' })
    expect(r2.email).toBeUndefined()
    expect(r2.color).toBeUndefined()
    expect(await fails(ACCOUNTS_IPC.update, { id: b.id, label: 'C' })).toBe('Claude Code already has an account named C')
    expect(await fails(ACCOUNTS_IPC.update, { id: b.id, label: ' ' })).toBe('give the account a name: 1 to 40 characters')
    expect(await fails(ACCOUNTS_IPC.update, { id: b.id, email: 'x' })).toBe('that email address isn\'t a plain address')
    expect(await fails(ACCOUNTS_IPC.update, { id: 'acc_ffffffffffff' })).toBe('that account isn\'t registered any more')
    // Fields left out are left as they are; a non-string email clears it.
    await ok(ACCOUNTS_IPC.update, { id: b.id, email: 'bee@example.test', color: '#000000' })
    const r3 = await ok<AccountRowView>(ACCOUNTS_IPC.update, { id: b.id, autoOffer: true })
    expect(r3).toMatchObject({ label: 'bee', email: 'bee@example.test', color: '#000000', autoOffer: true })
    expect((await ok<AccountRowView>(ACCOUNTS_IPC.update, { id: b.id, email: null })).email).toBeUndefined()
  })

  it('moves an account up or down its agent\'s order, and not past either end', async () => {
    const [a, b, c] = await three()
    let v = await ok<AccountsView>(ACCOUNTS_IPC.move, { id: c.id, by: -1 })
    expect(v.accounts.map((x) => x.label)).toEqual(['main', 'c', 'b'])
    v = await ok<AccountsView>(ACCOUNTS_IPC.move, { id: a.id, by: -1 })
    expect(v.accounts.map((x) => x.label)).toEqual(['main', 'c', 'b'])
    v = await ok<AccountsView>(ACCOUNTS_IPC.move, { id: a.id })
    expect(v.accounts.map((x) => x.label)).toEqual(['c', 'main', 'b'])
    expect(b.id).toBeTruthy()
  })

  it('removes an account: forgets it, takes Termpolis out of its profile, and leaves the folder', async () => {
    mainClaude()
    grant()
    const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'gone', folder: 'new', connect: true, copy: false })
    const id = r.account.id
    await ok(ACCOUNTS_IPC.setPreferred, { agent: 'claude', id })
    await ok(ACCOUNTS_IPC.noteLimit, { id, text: 'You\'ve hit your session limit · resets 3pm', resetsAt: clock + 1000 })
    const removed = await ok(ACCOUNTS_IPC.remove, { id })
    expect(removed.changes.map((c: { what: string }) => c.what).sort()).toEqual(['MCP server', 'SessionStart memory hook', 'Tool permissions'])
    const v = await list()
    expect(v.accounts.map((a) => a.label)).toEqual(['main'])
    expect(v.preferred).toEqual({})
    const saved = readJson(join(sb.paths.userData, 'agent-accounts.json'))
    expect(saved.limits).toEqual({})
    // The folder, its links and anything in it stay.
    expect(existsSync(join(sb.home, '.claude-gone', 'projects'))).toBe(true)
    expect(readJson(join(sb.home, '.claude-gone', '.claude.json')).mcpServers).toBeUndefined()
  })

  it('removes the default profile\'s account without touching the profile', async () => {
    const [a] = await three()
    grant()
    expect(await ok(ACCOUNTS_IPC.remove, { id: a.id })).toEqual({ changes: [] })
  })
})

describe('accounts:set-connect and strip-copied (consent per account)', () => {
  it('connects only with Agent Integration on, and disconnects whenever asked', async () => {
    mainClaude()
    const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'c', folder: 'new', copy: false })
    const id = r.account.id
    expect(await fails(ACCOUNTS_IPC.setConnect, { id, connect: true })).toBe('Turn on Agent Integration first')
    grant()
    const on = await ok(ACCOUNTS_IPC.setConnect, { id, connect: true })
    expect(on.account.connect).toBe(true)
    expect(on.changes.length).toBeGreaterThan(0)
    connected = false
    const off = await ok(ACCOUNTS_IPC.setConnect, { id, connect: false })
    expect(off.account.connect).toBe(false)
    expect(off.changes.map((c: { what: string }) => c.what)).toContain('MCP server')
    const main = (await list()).accounts.find((a) => a.isDefault) as AccountRowView
    expect(await fails(ACCOUNTS_IPC.setConnect, { id: main.id, connect: false })).toBe('the main profile is connected through Agent Integration')
  })

  it('records the choice even when the folder is gone, writing nothing', async () => {
    writeJson(join(sb.paths.userData, 'agent-accounts.json'), {
      version: 1, accounts: [{ id: 'acc_000000000001', agent: 'claude', label: 'gone', profile: join(sb.home, '.claude-gone'), links: [] }],
    })
    grant()
    expect(await ok(ACCOUNTS_IPC.setConnect, { id: 'acc_000000000001', connect: true })).toMatchObject({ changes: [], account: { connect: true, folderExists: false } })
  })

  it('removes the Termpolis entries a copied settings.json carries, and says the row has none left', async () => {
    mainClaude()
    const dir = join(sb.home, '.claude-copied')
    mkdirSync(dir)
    writeJson(join(dir, 'settings.json'), { permissions: { allow: [...CLAUDE_ALLOW_RULES] } })
    picks.push(dir)
    await ok(ACCOUNTS_IPC.pickFolder, { agent: 'claude' })
    const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'copied', folder: 'existing' })
    expect(r.account.connection).toEqual({ server: false, hook: false, allow: true })
    const s = await ok(ACCOUNTS_IPC.stripCopied, { id: r.account.id })
    expect(s.changes.map((c: { what: string }) => c.what)).toEqual(['Tool permissions'])
    expect(s.account.connection).toEqual({ server: false, hook: false, allow: false })
    const agy = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'agy', label: 'g' })
    expect(await fails(ACCOUNTS_IPC.stripCopied, { id: agy.account.id })).toBe('only a Claude Code profile has a settings.json to clean')
  })
})

describe('preferred account, the chooser switch and the notices', () => {
  it('sets and clears the account new terminals launch on, refusing another agent\'s', async () => {
    const g = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'agy', label: 'g' })
    expect((await ok<AccountsView>(ACCOUNTS_IPC.setPreferred, { agent: 'agy', id: g.account.id })).preferred).toEqual({ agy: g.account.id })
    expect(await fails(ACCOUNTS_IPC.setPreferred, { agent: 'claude', id: g.account.id })).toBe('that account belongs to another agent')
    expect(await fails(ACCOUNTS_IPC.setPreferred, { agent: 'nope', id: g.account.id })).toBe('unknown agent')
    expect((await ok<AccountsView>(ACCOUNTS_IPC.setPreferred, { agent: 'agy', id: null })).preferred).toEqual({})
  })

  it('turns the chooser off and on, and hides a notice for good', async () => {
    expect((await ok<AccountsView>(ACCOUNTS_IPC.setChooser, { on: false })).chooser).toBe(false)
    expect((await ok<AccountsView>(ACCOUNTS_IPC.setChooser, {})).chooser).toBe(true)
    expect((await ok<AccountsView>(ACCOUNTS_IPC.hideAdvice, { which: 'hookAdvice' })).hidden).toEqual({ hookAdvice: true })
    expect((await ok<AccountsView>(ACCOUNTS_IPC.hideAdvice, { which: 'limitBanner' })).hidden).toEqual({ hookAdvice: true, limitBanner: true })
    expect(await fails(ACCOUNTS_IPC.hideAdvice, { which: 'other' })).toBe('unknown notice')
  })
})

describe('the advice cards', () => {
  it('finds a StopFailure hook in a registered profile, and names auth overrides by name only', async () => {
    mainClaude()
    writeJson(join(sb.paths.claudeDir, 'settings.json'), {
      hooks: { StopFailure: [{ matcher: 'rate_limit', hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/auth-failover.sh' }] }] },
      env: { ANTHROPIC_AUTH_TOKEN: SECRET, CLAUDE_CODE_USE_BEDROCK: '1' },
      apiKeyHelper: '/bin/key',
    })
    await ok(ACCOUNTS_IPC.add, { agent: 'claude', label: 'b', folder: 'new', copy: false })
    const b = join(sb.home, '.claude-b')
    writeJson(join(b, 'settings.json'), { hooks: { StopFailure: [{ type: 'command', command: `curl -H "Authorization: Bearer ${SECRET}" https://x` }] }, env: { CLAUDE_CODE_USE_VERTEX: 'false' } })
    register({ env: { ANTHROPIC_API_KEY: SECRET, CLAUDE_CODE_USE_FOUNDRY: 'true', CLAUDE_CODE_OAUTH_TOKEN: '  ' } })
    const v = await list()
    expect(v.advice.stopFailureHooks).toEqual([
      { label: 'main', command: 'bash ~/.claude/hooks/auth-failover.sh' },
      { label: 'b', command: 'a StopFailure hook' },
    ])
    expect(v.advice.authOverrides).toEqual([
      'ANTHROPIC_API_KEY (Termpolis\'s environment)',
      'CLAUDE_CODE_USE_FOUNDRY (Termpolis\'s environment)',
      'ANTHROPIC_AUTH_TOKEN (main\'s settings.json)',
      'CLAUDE_CODE_USE_BEDROCK (main\'s settings.json)',
      'apiKeyHelper (main\'s settings.json)',
    ])
    expect(JSON.stringify(v)).not.toContain(SECRET)
  })

  it('reads no advice from a settings.json that is missing, unreadable or shaped oddly', async () => {
    mainClaude()
    await ok(ACCOUNTS_IPC.add, { agent: 'claude', label: 'b', folder: 'new', copy: false })
    writeText(join(sb.paths.claudeDir, 'settings.json'), '')
    expect((await list()).advice).toEqual({ stopFailureHooks: [], authOverrides: [] })
    writeText(join(sb.paths.claudeDir, 'settings.json'), '{ broken')
    writeJson(join(sb.home, '.claude-b', 'settings.json'), { hooks: { StopFailure: [{ hooks: [{ command: '  ' }, 'x'] }, null] }, env: [] })
    expect((await list()).advice).toEqual({ stopFailureHooks: [], authOverrides: [] })
    writeJson(join(sb.home, '.claude-b', 'settings.json'), [1])
    writeJson(join(sb.paths.claudeDir, 'settings.json'), { hooks: [] })
    expect((await list()).advice).toEqual({ stopFailureHooks: [], authOverrides: [] })
  })
})

// A synthetic accounts.sh (never a real address in this repo).
const SH = `ACCOUNTS=(personal codedev work)
declare -A ACCOUNT_EMAIL=(
  [personal]="p@example.test"
  [codedev]="c@example.test"
  [work]="w@example.test"
)
DEFAULT_ACCOUNT=personal
declare -A ACCOUNT_DIR=(
  [personal]=".claude"
  [codedev]=".claude-codedev"
  [work]=".claude-work"
)
FAILOVER_ORDER=(personal codedev)
LIMIT_COOLDOWN=3600
`

describe('importing ~/.claude/accounts.sh', () => {
  beforeEach(() => {
    mainClaude()
    writeText(join(sb.paths.claudeDir, 'accounts.sh'), SH)
    for (const d of ['.claude-codedev', '.claude-work']) mkdirSync(join(sb.home, d))
    sb.link(join(sb.paths.claudeDir, 'projects'), join(sb.home, '.claude-codedev', 'projects'))
  })

  it('offers the import, previews it, and imports with the connects the user ticked (D14)', async () => {
    grant()
    const v0 = await list()
    expect(v0.importAvailable).toBe(true)
    expect(v0.drift).toEqual([
      'accounts.sh lists personal, which Termpolis hasn\'t imported.',
      'accounts.sh lists codedev, which Termpolis hasn\'t imported.',
      'accounts.sh lists work, which Termpolis hasn\'t imported.',
    ])
    const preview = await ok(ACCOUNTS_IPC.importPreview)
    expect(preview.rows.map((r: { key: string; autoOffer: boolean }) => [r.key, r.autoOffer])).toEqual([['personal', true], ['codedev', true], ['work', false]])
    const r = await ok(ACCOUNTS_IPC.import, { connect: { codedev: true } })
    expect(r.added).toBe(3)
    const rows: AccountRowView[] = r.view.accounts
    expect(rows.map((a) => [a.label, a.importedAs, a.isDefault, a.autoOffer, a.connect, a.origin])).toEqual([
      ['personal', 'personal', true, true, true, 'accounts-sh'],
      ['codedev', 'codedev', false, true, true, 'accounts-sh'],
      ['work', 'work', false, false, false, 'accounts-sh'],
    ])
    expect(rows[1].shares).toEqual(['projects'])
    expect(r.view.drift).toEqual([])
    // codedev was connected; work, not offered automatically, was not.
    expect(readJson(join(sb.home, '.claude-codedev', '.claude.json')).mcpServers.termpolis).toBeTruthy()
    expect(existsSync(join(sb.home, '.claude-work', '.claude.json'))).toBe(false)
    expect(readJson(join(sb.paths.userData, 'agent-accounts.json')).cooldownSec).toEqual({ claude: 3600 })
    // A second import adds nothing.
    expect((await ok(ACCOUNTS_IPC.import, {})).added).toBe(0)
  })

  it('imports only the rows asked for, and skips a name already taken', async () => {
    await ok(ACCOUNTS_IPC.add, { agent: 'agy', label: 'unrelated' })
    mkdirSync(join(sb.home, '.claude-elsewhere'))
    picks.push(join(sb.home, '.claude-elsewhere'))
    await ok(ACCOUNTS_IPC.pickFolder, { agent: 'claude' })
    await ok(ACCOUNTS_IPC.add, { agent: 'claude', label: 'Work', folder: 'existing' })
    const r = await ok(ACCOUNTS_IPC.import, { keys: ['work', 'codedev', 7] })
    expect(r.added).toBe(1)
    expect(r.view.accounts.filter((a: AccountRowView) => a.agent === 'claude').map((a: AccountRowView) => a.label)).toEqual(['main', 'Work', 'codedev'])
  })

  it('imports an account accounts.sh gives no email', async () => {
    writeText(join(sb.paths.claudeDir, 'accounts.sh'), 'ACCOUNTS=(solo)\ndeclare -A ACCOUNT_DIR=(\n  [solo]=".claude-solo"\n)\n')
    mkdirSync(join(sb.home, '.claude-solo'))
    const r = await ok(ACCOUNTS_IPC.import, {})
    expect(r.view.accounts.map((a: AccountRowView) => [a.label, a.email])).toEqual([['solo', undefined]])
  })

  it('reports an accounts.sh that disappeared, or never existed', async () => {
    const r = await ok(ACCOUNTS_IPC.importPreview)
    expect(r.rows).toHaveLength(3)
    sb.dispose()
    sb = createSandbox()
    register()
    expect(await fails(ACCOUNTS_IPC.importPreview)).toBe('~/.claude/accounts.sh doesn\'t exist')
    expect(await fails(ACCOUNTS_IPC.import, {})).toBe('~/.claude/accounts.sh doesn\'t exist')
  })

  it('shows the hook\'s .limited-<key> marker as a floor, only within the cooldown and only without drift (R13)', async () => {
    await ok(ACCOUNTS_IPC.import, {})
    const at = Math.floor(clock / 1000) - 60
    writeText(join(sb.paths.claudeDir, '.limited-codedev'), `${at}\n`)
    let v = await list()
    expect(v.accounts.find((a) => a.label === 'codedev')?.limitedOutside).toBe(at * 1000)
    clock += 3600 * 1000
    v = await list()
    expect(v.accounts.find((a) => a.label === 'codedev')?.limitedOutside).toBeUndefined()
    clock -= 3600 * 1000
    // A profile accounts.sh doesn't list: the hook would name the wrong account, so its markers are ignored.
    await ok(ACCOUNTS_IPC.add, { agent: 'claude', label: 'extra', folder: 'new', copy: false })
    v = await list()
    expect(v.accounts.find((a) => a.label === 'codedev')?.limitedOutside).toBeUndefined()
    expect(v.drift.some((l) => l.startsWith('extra isn\'t in accounts.sh'))).toBe(true)
  })
})

describe('accounts:check ("signed in now")', () => {
  it('asks the agent\'s own CLI and keeps its answer', async () => {
    mainClaude()
    const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'b', folder: 'new', copy: false })
    const row = await ok<AccountRowView>(ACCOUNTS_IPC.check, { id: r.account.id })
    expect(checks).toEqual([{ agent: 'claude', profile: join(sb.home, '.claude-b') }])
    expect(row.identity).toEqual(checkAnswer.identity as AccountIdentity)
    const main = (await list()).accounts.find((a) => a.isDefault) as AccountRowView
    await ok(ACCOUNTS_IPC.check, { id: main.id })
    expect(checks[1]).toEqual({ agent: 'claude', profile: null })
  })

  it('says why it couldn\'t check, and keeps nothing', async () => {
    mainClaude()
    const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'b', folder: 'new', copy: false })
    checkAnswer = { error: 'Claude Code took longer than 15 s to answer' }
    expect(await fails(ACCOUNTS_IPC.check, { id: r.account.id })).toBe('Claude Code took longer than 15 s to answer')
    expect(readJson(join(sb.paths.userData, 'agent-accounts.json')).identity).toEqual({})
  })

  it('never asks while a Termpolis terminal runs on that profile (R21), nor for a missing folder', async () => {
    mainClaude()
    const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'b', folder: 'new', copy: false })
    noteTerminalAccount('t1', r.account.id)
    expect(await fails(ACCOUNTS_IPC.check, { id: r.account.id })).toMatch(/^A Termpolis terminal is running on b/)
    expect(checks).toEqual([])
    writeJson(join(sb.paths.userData, 'agent-accounts.json'), {
      version: 1, accounts: [{ id: 'acc_000000000001', agent: 'codex', label: 'gone', profile: join(sb.home, '.codex-gone'), links: [] }],
    })
    expect(await fails(ACCOUNTS_IPC.check, { id: 'acc_000000000001' })).toBe('gone\'s profile folder doesn\'t exist')
  })

  it('runs the real status commands when none is injected', async () => {
    register({ signedInNow: undefined, env: { PATH: join(sb.root, 'no-bin') } })
    mainClaude()
    const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'b', folder: 'new', copy: false })
    expect(await fails(ACCOUNTS_IPC.check, { id: r.account.id })).toBe('Claude Code isn\'t installed where Termpolis can find it (not on PATH)')
    mkdirSync(join(sb.home, '.codex-c'))
    picks.push(join(sb.home, '.codex-c'))
    await ok(ACCOUNTS_IPC.pickFolder, { agent: 'codex' })
    const c = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'codex', label: 'c', folder: 'existing' })
    expect(await fails(ACCOUNTS_IPC.check, { id: c.account.id })).toBe('Codex isn\'t installed where Termpolis can find it (not on PATH)')
  })
})

describe('usage limits', () => {
  it('records a limit the chooser read, until its reset, and forgets it on "mark available"', async () => {
    const g = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'agy', label: 'g' })
    const id = g.account.id
    const row = await ok<AccountRowView>(ACCOUNTS_IPC.noteLimit, { id, text: '✕ You have exhausted\nyour quota.', resetsAt: clock + 60_000, scope: 'model', window: 'session', email: 'g@example.test' })
    expect(row.limit).toEqual({ seenAt: clock, resetsAt: clock + 60_000, text: '✕ You have exhausted your quota.', scope: 'model', window: 'session', email: 'g@example.test' })
    clock += 60_001
    expect((await list()).accounts[0].limit).toBeUndefined()
    clock -= 60_001
    expect((await ok<AccountRowView>(ACCOUNTS_IPC.clearLimit, { id })).limit).toBeUndefined()
    expect(await fails(ACCOUNTS_IPC.noteLimit, { id, text: ' ' })).toBe('that is not a usage limit')
    expect(await fails(ACCOUNTS_IPC.noteLimit, { id: 'acc_ffffffffffff', text: 'x' })).toBe('that account isn\'t registered any more')
  })

  it('falls back to the cooldown with no reset time, and keeps a weekly limit 7 days (R15)', async () => {
    const g = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'agy', label: 'g' })
    const id = g.account.id
    await ok(ACCOUNTS_IPC.noteLimit, { id, text: 'limit', resetsAt: 'soon', scope: 'bogus' })
    clock += 18000 * 1000 - 1
    expect((await list()).accounts[0].limit).toMatchObject({ resetsAt: null, scope: 'account' })
    clock += 2
    expect((await list()).accounts[0].limit).toBeUndefined()
    await ok(ACCOUNTS_IPC.noteLimit, { id, text: 'You\'ve hit your weekly limit', window: 'weekly' })
    clock += 6 * 86400 * 1000
    expect((await list()).accounts[0].limit).toBeDefined()
    clock += 86400 * 1000 + 1
    expect((await list()).accounts[0].limit).toBeUndefined()
  })
})

// SWARM-R3-1: the login a profile holds decides which account it is. Main's gate for the second confirmation reads it from the profile's own
// .claude.json, as accounts.sh's account_for_email does.
describe('unofferedLoginIn: the account kept from the offers whose login a profile holds', () => {
  async function registry(): Promise<{ doc: AccountsDoc; main: AgentAccount; codedev: AgentAccount; work: AgentAccount; set: (a: AgentAccount, email: string | null) => void }> {
    mainClaude()
    grant()
    const b = (await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'codedev', folder: 'new', copy: false })).account
    const w = (await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'work', folder: 'new', copy: false })).account
    const main = (await list()).accounts.find((a) => a.isDefault) as AccountRowView
    await ok(ACCOUNTS_IPC.update, { id: main.id, email: 'a@example.test' })
    await ok(ACCOUNTS_IPC.update, { id: b.id, email: 'b@example.test' })
    await ok(ACCOUNTS_IPC.update, { id: w.id, email: 'w@example.test', autoOffer: false })
    const loaded = loadAccounts(sb.paths.userData)
    if (!loaded.ok) throw new Error(loaded.error)
    const doc = loaded.doc
    const find = (id: string): AgentAccount => doc.file.accounts.find((a) => a.id === id) as AgentAccount
    const set = (a: AgentAccount, email: string | null): void => {
      const file = a.profile === null ? sb.paths.claudeJson : join(a.profile, '.claude.json')
      writeJson(file, email === null ? {} : { oauthAccount: { emailAddress: email } })
    }
    return { doc, main: find(main.id), codedev: find(b.id), work: find(w.id), set }
  }

  it('names work for a profile signed in to work\'s email, whatever its own account is called', async () => {
    const { doc, main, codedev, work, set } = await registry()
    set(main, 'w@example.test')
    expect(unofferedLoginIn(doc, main, sb.home, accountFs)?.id).toBe(work.id)
    set(codedev, 'w@example.test')
    expect(unofferedLoginIn(doc, codedev, sb.home, accountFs)?.id).toBe(work.id)
  })

  it('reads the emails without regard to case, as accounts.sh does', async () => {
    const { doc, main, work, set } = await registry()
    set(main, 'W@Example.TEST')
    expect(unofferedLoginIn(doc, main, sb.home, accountFs)?.id).toBe(work.id)
  })

  it('names none for a profile that holds its own login, another account\'s that is offered, an unknown one, or none', async () => {
    const { doc, main, codedev, set } = await registry()
    set(main, 'a@example.test')
    expect(unofferedLoginIn(doc, main, sb.home, accountFs)).toBeUndefined()
    // Two profiles of one login that is offered: nothing is kept from the offers.
    set(main, 'b@example.test')
    expect(unofferedLoginIn(doc, main, sb.home, accountFs)).toBeUndefined()
    set(codedev, 'someone@else.test')
    expect(unofferedLoginIn(doc, codedev, sb.home, accountFs)).toBeUndefined()
    set(codedev, null)
    expect(unofferedLoginIn(doc, codedev, sb.home, accountFs)).toBeUndefined()
  })

  it('never names the account itself, which is read by its own flag', async () => {
    const { doc, work, set } = await registry()
    set(work, 'w@example.test')
    expect(unofferedLoginIn(doc, work, sb.home, accountFs)).toBeUndefined()
  })

  it('knows no login of an agy account or of another agent\'s', async () => {
    const { doc, work } = await registry()
    expect(unofferedLoginIn(doc, { ...work, agent: 'agy', profile: null }, sb.home, accountFs)).toBeUndefined()
  })
})

describe('the lookups index.ts uses', () => {
  async function accountsFixture(): Promise<{ on: string; off: string; gone: string; agy: string }> {
    mainClaude()
    grant()
    const on = (await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'on', folder: 'new', connect: true, copy: false })).account.id
    const off = (await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'off', folder: 'new', copy: false })).account.id
    const agy = (await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'agy', label: 'g' })).account.id
    const doc = readJson(join(sb.paths.userData, 'agent-accounts.json'))
    doc.accounts.push({ id: 'acc_00000000000a', agent: 'claude', label: 'gone', profile: join(sb.home, '.claude-gone'), connect: true, links: [] })
    writeJson(join(sb.paths.userData, 'agent-accounts.json'), doc)
    return { on, off, gone: 'acc_00000000000a', agy }
  }

  // SAFETY-R3-3: the gates built on resolveAccountTarget (folder trust, the primer file, Codex's instructions) failed OPEN when the registry
  // could not be read: an account id it could not find was taken for "no account", the default profile, which is connected. The trust poller's
  // own gate (isTerminalAccountConnected) already failed closed under the same read failure, so the two disagreed.
  it('fails closed when the registry cannot be read: an account id it can no longer find is not connected, and no profile is named', async () => {
    const ids = await accountsFixture()
    const file = join(sb.paths.userData, 'agent-accounts.json')
    for (const [what, bad] of [['invalid JSON', '{ broken'], ['a version it does not know', JSON.stringify({ version: 2, accounts: [] })], ['an empty file', '']] as const) {
      writeText(file, bad)
      expect(resolveAccountTarget(sb.paths, ids.off), what).toEqual({ connected: false })
      expect(resolveAccountTarget(sb.paths, ids.on), what).toEqual({ connected: false })
      expect(resolveLaunchTarget(sb.paths, ids.on, 'claude'), what).toMatchObject({ connected: false })
      // And no id at all is still the default profile (D13), whatever the registry holds: a user who added nothing sees nothing change.
      expect(resolveAccountTarget(sb.paths, undefined), what).toEqual({ connected: true })
      expect(resolveAccountTarget(sb.paths, ''), what).toEqual({ connected: true })
      expect(resolveAccountTarget(sb.paths, 42), what).toEqual({ connected: true })
    }
  })

  it('still takes an id a readable registry does not hold for no account (D13)', async () => {
    await accountsFixture()
    expect(resolveAccountTarget(sb.paths, 'acc_ffffffffffff')).toEqual({ connected: true })
  })

  it('resolves an account to its profile, refusing one the user didn\'t connect or whose folder is gone (R9)', async () => {
    const ids = await accountsFixture()
    const main = (await list()).accounts.find((a) => a.isDefault) as AccountRowView
    expect(resolveAccountTarget(sb.paths, undefined)).toEqual({ connected: true })
    expect(resolveAccountTarget(sb.paths, 'acc_ffffffffffff')).toEqual({ connected: true })
    expect(resolveAccountTarget(sb.paths, main.id)).toMatchObject({ connected: true, account: { label: 'main' } })
    expect(resolveAccountTarget(sb.paths, main.id).target).toBeUndefined()
    expect(resolveAccountTarget(sb.paths, ids.on)).toMatchObject({
      connected: true, target: { agent: 'claude', dir: join(sb.home, '.claude-on'), claudeJson: join(sb.home, '.claude-on', '.claude.json'), accountId: ids.on },
    })
    expect(resolveAccountTarget(sb.paths, ids.off)).toMatchObject({ connected: false })
    expect(resolveAccountTarget(sb.paths, ids.gone)).toMatchObject({ connected: false })
    expect(resolveAccountTarget(sb.paths, ids.gone).target).toBeUndefined()
    expect(resolveAccountTarget(sb.paths, ids.agy)).toMatchObject({ connected: true })
    // A registry that cannot be read says nothing of the account: a write meant for it is not made (SAFETY-R3-3, below).
    writeText(join(sb.paths.userData, 'agent-accounts.json'), '{ broken')
    expect(resolveAccountTarget(sb.paths, ids.on)).toEqual({ connected: false })
  })

  it('says whether a terminal\'s account is connected, from main\'s own record of it', async () => {
    const ids = await accountsFixture()
    expect(isTerminalAccountConnected(sb.paths, 't-unknown')).toBe(true)
    expect(isTerminalAccountConnected(sb.paths, 42)).toBe(true)
    noteTerminalAccount('t-off', ids.off)
    noteTerminalAccount('t-on', ids.on)
    noteTerminalAccount('t-default', null)
    expect(isTerminalAccountConnected(sb.paths, 't-off')).toBe(false)
    expect(isTerminalAccountConnected(sb.paths, 't-on')).toBe(true)
    expect(isTerminalAccountConnected(sb.paths, 't-default')).toBe(true)
    expect(terminalAccountId('t-default')).toBeNull()
    expect(terminalAccountId('t-unknown')).toBeUndefined()
    expect(terminalsOnAccount(ids.on)).toBe(1)
    forgetTerminalAccount('t-on')
    expect(terminalsOnAccount(ids.on)).toBe(0)
  })

  it('fails closed for a terminal still on an account the user then removed (R9)', async () => {
    const ids = await accountsFixture()
    noteTerminalAccount('t-live', ids.on)
    expect(isTerminalAccountConnected(sb.paths, 't-live')).toBe(true)
    await ok(ACCOUNTS_IPC.remove, { id: ids.on })
    // The registry no longer has the account: Termpolis answers nothing in a profile it let go of, and
    // Disconnect would never take such an answer back.
    expect(isTerminalAccountConnected(sb.paths, 't-live')).toBe(false)
    // A terminal that never had an account, and one on the default profile, are as before.
    expect(isTerminalAccountConnected(sb.paths, 't-never')).toBe(true)
    noteTerminalAccount('t-default', null)
    expect(isTerminalAccountConnected(sb.paths, 't-default')).toBe(true)
  })

  it('applies the by-hand rule only once an account is registered (D13: a user who added none sees no change)', async () => {
    // No account registered at all: a variable typed by hand changes nothing about v1.54.0's trust answers.
    noteTypedInput('t-hand', 'export CLAUDE_CONFIG_DIR=/x/.claude-z\r', 1)
    expect(isAccountChangedByHand('t-hand')).toBe(true)
    expect(isTerminalAccountConnected(sb.paths, 't-hand')).toBe(true)
    // With accounts, an account Termpolis doesn't know is one it answers nothing in.
    await accountsFixture()
    expect(isTerminalAccountConnected(sb.paths, 't-hand')).toBe(false)
  })

  it('lists the connected profiles for agent integration\'s runtime', async () => {
    const ids = await accountsFixture()
    expect(connectedProfileTargets(sb.paths).map((t) => t.accountId)).toEqual([(await list()).accounts[0].id, ids.on])
    writeText(join(sb.paths.userData, 'agent-accounts.json'), '{ broken')
    expect(connectedProfileTargets(sb.paths)).toEqual([])
  })

  it('resolves a Codex account to its home, with no .claude.json, and removes one', async () => {
    mkdirSync(sb.paths.codexHome, { recursive: true })
    grant()
    picks.push(sb.paths.codexHome)
    expect(await ok(ACCOUNTS_IPC.pickFolder, { agent: 'codex' })).toMatchObject({ isDefault: true, folder: `~${sb.paths.codexHome.slice(sb.home.length)}` })
    const c = (await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'codex', label: 'x', folder: 'new', connect: true, copy: false })).account
    expect(resolveAccountTarget(sb.paths, c.id).target).toEqual({ agent: 'codex', dir: join(sb.home, '.codex-x'), accountId: c.id })
    const removed = await ok(ACCOUNTS_IPC.remove, { id: c.id })
    expect(removed.changes.map((r: { what: string }) => r.what)).toEqual(['MCP server'])
    // The main Codex profile was listed when x was added, and stays.
    expect((await list()).accounts.map((a) => [a.agent, a.label, a.isDefault])).toEqual([['codex', 'main', true]])
  })

  it('resolves a launch only to an account of the agent launched, so nothing is written into another agent\'s profile', async () => {
    const ids = await accountsFixture()
    mkdirSync(sb.paths.codexHome, { recursive: true })
    const cx = (await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'codex', label: 'cx', folder: 'new', connect: true, copy: false })).account.id
    // The agent's own account resolves as resolveAccountTarget does.
    expect(resolveLaunchTarget(sb.paths, ids.on, 'claude')).toEqual(resolveAccountTarget(sb.paths, ids.on))
    expect(resolveLaunchTarget(sb.paths, ids.off, 'claude')).toMatchObject({ connected: false })
    expect(resolveLaunchTarget(sb.paths, cx, 'codex').target).toEqual({ agent: 'codex', dir: join(sb.home, '.codex-cx'), accountId: cx })
    expect(resolveLaunchTarget(sb.paths, undefined, 'codex')).toEqual({ connected: true })
    // Another agent's account never does: a Claude profile is no CODEX_HOME, nor agy a Claude one.
    for (const [id, agent] of [[ids.on, 'codex'], [cx, 'claude'], [ids.agy, 'claude']] as const) {
      const r = resolveLaunchTarget(sb.paths, id, agent)
      expect(r.connected).toBe(false)
      expect(r.target).toBeUndefined()
    }
  })

  it('names the CODEX_HOME to take home-folder trust out of, and never falls back to the default for a missing one', async () => {
    const ids = await accountsFixture()
    mkdirSync(sb.paths.codexHome, { recursive: true })
    const cx = (await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'codex', label: 'cx', folder: 'new', copy: false })).account
    const codexMain = (await list()).accounts.find((a) => a.agent === 'codex' && a.isDefault) as AccountRowView
    expect(codexHomeFor(sb.paths, undefined)).toEqual({})
    expect(codexHomeFor(sb.paths, 'acc_ffffffffffff')).toEqual({})
    expect(codexHomeFor(sb.paths, codexMain.id)).toEqual({})
    // Not connected is fine here: taking trust out is what the user asked for, on that account.
    expect(codexHomeFor(sb.paths, cx.id)).toEqual({ home: join(sb.home, '.codex-cx') })
    expect(codexHomeFor(sb.paths, ids.on)).toEqual({ error: 'on is not a Codex account' })
    const doc = readJson(join(sb.paths.userData, 'agent-accounts.json'))
    doc.accounts.push({ id: 'acc_00000000000c', agent: 'codex', label: 'lost', profile: join(sb.home, '.codex-lost'), connect: true, links: [] })
    writeJson(join(sb.paths.userData, 'agent-accounts.json'), doc)
    expect(codexHomeFor(sb.paths, 'acc_00000000000c')).toEqual({ error: 'lost\'s profile folder doesn\'t exist' })
  })

  it('reads a Claude account\'s own settings.json env for the proxy decision', async () => {
    const ids = await accountsFixture()
    const main = (await list()).accounts.find((a) => a.isDefault) as AccountRowView
    expect(accountSettingsEnv(sb.paths, undefined)).toBeUndefined()
    expect(accountSettingsEnv(sb.paths, main.id)).toBeUndefined()
    expect(accountSettingsEnv(sb.paths, ids.agy)).toBeUndefined()
    expect(accountSettingsEnv(sb.paths, ids.gone)).toBeNull()
    expect(accountSettingsEnv(sb.paths, ids.on)).toBeNull()
    writeJson(join(sb.home, '.claude-on', 'settings.json'), { env: { ANTHROPIC_BASE_URL: 'http://gateway' } })
    expect(accountSettingsEnv(sb.paths, ids.on)).toEqual({ ANTHROPIC_BASE_URL: 'http://gateway' })
    writeJson(join(sb.home, '.claude-on', 'settings.json'), { env: 'x' })
    expect(accountSettingsEnv(sb.paths, ids.on)).toBeNull()
  })
})
