// @vitest-environment node
//
// Launching an agent on an account (§6): accounts:launch-line builds the line a launch types and
// records the account as main's own (§6.1), and every line typed into a terminal is watched for a
// change of account by hand, which never flags the line main built (R1). Same sandbox as
// accountsIpc.test.ts: a scratch home under TERMPOLIS_TEST_AGENT_HOME, never a real profile.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync } from 'fs'
import { join } from 'path'
import {
  OWN_LINE_MS, _resetTerminalAccountsForTest, claudeSessionOf, forgetTerminalAccount, isAccountChangedByHand,
  isTerminalAccountConnected, launchAccountOf, noteAgentStart, noteTerminalAccount, noteTerminalSession, noteTypedInput,
  registerAccountsIpc, terminalAccountId, terminalAgentStart, terminalSessionId,
} from '../../src/main/accountsIpc'
import type { AccountsIpcDeps } from '../../src/main/accountsIpc'
import { ACCOUNTS_IPC } from '../../src/shared/agentAccounts'
import type { AddAccountResult, LaunchLineResult } from '../../src/shared/agentAccounts'
import { shQuote } from '../../src/shared/shellQuote'
import { loadAccounts } from '../../src/main/agentAccounts'
import { createSandbox, writeJson, writeText } from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'

let sb: Sandbox
let handlers: Map<string, (e: unknown, input?: unknown) => unknown>
let sent: Array<{ channel: string; payload: any }>
let clock: number
let ends: Map<string, number>

function deps(over: Partial<AccountsIpcDeps> = {}): AccountsIpcDeps {
  return {
    paths: () => sb.paths,
    runtime: () => ({ ...sb.rt, hookShell: 'sh' }),
    integrationConnected: () => true,
    pickFolder: async () => null,
    send: (channel, payload) => { sent.push({ channel, payload }) },
    checkCwd: () => sb.root,
    env: {},
    now: () => clock,
    outputEnd: (id) => ends.get(id) ?? 0,
    ...over,
  }
}

function register(over: Partial<AccountsIpcDeps> = {}): void {
  handlers = new Map()
  registerAccountsIpc({ handle: (ch, fn) => { handlers.set(ch, fn) } }, deps(over))
}

async function call<T = any>(channel: string, input?: unknown): Promise<{ success: boolean; data?: T; error?: string }> {
  return (await handlers.get(channel)!(null, input)) as { success: boolean; data?: T; error?: string }
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

const line = (input: Record<string, unknown>): Promise<LaunchLineResult> =>
  ok<LaunchLineResult>(ACCOUNTS_IPC.launchLine, { terminalId: 't1', agent: 'claude', shellType: 'gitbash', command: 'claude', ...input })

beforeEach(() => {
  sb = createSandbox()
  sent = []
  clock = 1_000_000
  ends = new Map()
  _resetTerminalAccountsForTest()
  register()
})

afterEach(() => {
  _resetTerminalAccountsForTest()
  sb.dispose()
})

/** The default Claude profile, and a second one, made by Add: both registered. */
async function twoClaude(): Promise<{ main: string; b: string; bDir: string }> {
  mkdirSync(join(sb.paths.claudeDir, 'projects'), { recursive: true })
  writeJson(sb.paths.claudeJson, { oauthAccount: { emailAddress: 'a@example.test' } })
  const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'b', folder: 'new', copy: false })
  const doc = loadAccounts(sb.paths.userData)
  if (!doc.ok) throw new Error(doc.error)
  const main = doc.doc.file.accounts.find((a) => a.agent === 'claude' && a.profile === null)!.id
  return { main, b: r.account.id, bDir: r.account.profile! }
}

describe('accounts:launch-line', () => {
  it('is the bare command, and records nothing, for an agent with no account (D13)', async () => {
    expect(await line({})).toEqual({ line: 'claude', accountId: null, explicit: false })
    expect(terminalAccountId('t1')).toBeUndefined()
    // A registry that can't be read is the same: the launch is today's.
    writeText(join(sb.paths.userData, 'agent-accounts.json'), '{ broken')
    expect(await line({ command: 'claude --model opus' })).toEqual({ line: 'claude --model opus', accountId: null, explicit: false })
  })

  it('names the default account by unsetting its variable once the agent has two, with a session id of its own', async () => {
    const { main } = await twoClaude()
    const r = await line({ accountId: main })
    expect(r.accountId).toBe(main)
    expect(r.explicit).toBe(true)
    expect(r.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.line).toBe(`unset CLAUDE_CONFIG_DIR && claude --session-id ${r.sessionId}`)
    expect(terminalAccountId('t1')).toBe(main)
  })

  it('sets the account\'s profile in each shell\'s own fail-closed form', async () => {
    const { b, bDir } = await twoClaude()
    const posix = await line({ accountId: b, command: 'claude --model opus' })
    expect(posix.line).toBe(`export CLAUDE_CONFIG_DIR='${bDir}' && claude --model opus --session-id ${posix.sessionId}`)
    const ps = await line({ accountId: b, shellType: 'powershell', command: 'claude' })
    expect(ps.line).toBe(`& { $env:CLAUDE_CONFIG_DIR = '${bDir}'; claude --session-id ${ps.sessionId} }`)
    const cmd = await line({ accountId: b, shellType: 'cmd', command: 'claude' })
    expect(cmd.line).toBe(`set "CLAUDE_CONFIG_DIR=${bDir}" && call claude --session-id ${cmd.sessionId}`)
  })

  it('Auto + task: the task goes last, quoted and cleaned, in every shell and with no account', async () => {
    expect((await line({ command: 'claude --model haiku --effort low', task: 'find where X is defined' })).line)
      .toBe('claude --model haiku --effort low "find where X is defined"')
    expect((await line({ task: '--continue $(rm -rf ~) "x"' })).line).toBe('claude "continue rm -rf ~ x"')
    expect((await line({ agent: 'codex', command: 'codex', task: 'hi' })).line).toBe('codex')
    const { b, bDir } = await twoClaude()
    const posix = await line({ accountId: b, command: 'claude --model haiku', task: 'list 100% of it!' })
    expect(posix.line).toBe(`export CLAUDE_CONFIG_DIR='${bDir}' && claude --model haiku --session-id ${posix.sessionId} "list 100 of it"`)
    const cmd = await line({ accountId: b, shellType: 'cmd', command: 'claude', task: 'what is this' })
    expect(cmd.line).toBe(`set "CLAUDE_CONFIG_DIR=${bDir}" && call claude --session-id ${cmd.sessionId} "what is this"`)
  })

  it('keeps a resume\'s own id, and gives a --continue none (it can\'t tell which session it takes)', async () => {
    const { b } = await twoClaude()
    const id = '3f2a9c1e-5b7d-4e8f-a012-3456789abcde'
    const resumed = await line({ accountId: b, command: `claude --resume ${id}` })
    expect(resumed.sessionId).toBe(id)
    expect(resumed.line.endsWith(`claude --resume ${id}`)).toBe(true)
    const cont = await line({ accountId: b, command: 'claude --continue' })
    expect(cont.sessionId).toBeUndefined()
    expect(cont.line.endsWith('claude --continue')).toBe(true)
  })

  it('launches on the preferred account when none is asked for, or the one asked for is gone', async () => {
    const { main, b } = await twoClaude()
    expect((await line({})).accountId).toBe(main)
    await ok(ACCOUNTS_IPC.setPreferred, { agent: 'claude', id: b })
    expect((await line({})).accountId).toBe(b)
    expect((await line({ accountId: 'acc_gone00000000' })).accountId).toBe(b)
    expect((await line({ accountId: main })).accountId).toBe(main)
  })

  it('names a lone account that isn\'t the default profile, and leaves a lone default one bare', async () => {
    // agy with one account: nothing changes (D13).
    await ok(ACCOUNTS_IPC.add, { agent: 'agy', label: 'personal', email: 'p@example.test' })
    const agy = await line({ agent: 'agy', command: 'agy' })
    expect(agy).toEqual(expect.objectContaining({ line: 'agy', explicit: false }))
    expect(agy.accountId).toMatch(/^acc_/)
    await ok(ACCOUNTS_IPC.add, { agent: 'agy', label: 'work', email: 'w@example.test' })
    // Two agy accounts: agy has no variable, so the line stays bare, but it is the account's.
    const two = await line({ agent: 'agy', command: 'agy', accountId: agy.accountId })
    expect(two).toEqual({ line: 'agy', accountId: agy.accountId, explicit: true })
    // In every shell: with nothing to set there is nothing to wrap, and PowerShell's `& { agy }`
    // would hide the launch from the audit, which reads `agy` at a line's start or after ; & |.
    for (const shellType of ['powershell', 'cmd', 'fish']) {
      expect(await line({ agent: 'agy', command: 'agy', accountId: agy.accountId, shellType })).toEqual({ line: 'agy', accountId: agy.accountId, explicit: true })
    }
  })

  it('names a Codex account by CODEX_HOME, its default profile by unsetting it, and gives Codex no session id', async () => {
    mkdirSync(join(sb.paths.codexHome, 'sessions'), { recursive: true })
    const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'codex', label: 'cb', folder: 'new', copy: false })
    const doc = loadAccounts(sb.paths.userData)
    if (!doc.ok) throw new Error(doc.error)
    const main = doc.doc.file.accounts.find((a) => a.agent === 'codex' && a.profile === null)!.id
    const codex = { agent: 'codex', command: 'codex -m gpt-5.5' }
    expect(await line({ ...codex, accountId: r.account.id })).toEqual({
      line: `export CODEX_HOME=${shQuote(r.account.profile!)} && codex -m gpt-5.5`, accountId: r.account.id, explicit: true,
    })
    expect(await line({ ...codex, accountId: main, shellType: 'powershell' })).toEqual({
      line: '& { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue; codex -m gpt-5.5 }', accountId: main, explicit: true,
    })
    expect(terminalSessionId('t1')).toBeUndefined()
  })

  it('names the account when it is the agent\'s only one and not its default profile', async () => {
    const { main, b, bDir } = await twoClaude()
    await ok(ACCOUNTS_IPC.remove, { id: main })
    const r = await line({ accountId: b })
    expect(r.explicit).toBe(true)
    expect(r.line.startsWith(`export CLAUDE_CONFIG_DIR='${bDir}' && claude --session-id `)).toBe(true)
  })

  it('refuses what it can\'t build, typing nothing', async () => {
    const { b } = await twoClaude()
    expect(await fails(ACCOUNTS_IPC.launchLine, { terminalId: 't', agent: 'claude', command: 42 })).toBe('there is no command to run')
    expect(await fails(ACCOUNTS_IPC.launchLine, { terminalId: 't', agent: 'claude', command: 'claude', accountId: b }))
      .toBe('Termpolis can\'t type an account line into that shell')
    expect(await fails(ACCOUNTS_IPC.launchLine, { agent: 'claude', command: 'claude' })).toBe('which terminal?')
    expect(await fails(ACCOUNTS_IPC.launchLine, { terminalId: 't', agent: 'nope', command: 'claude' })).toBe('unknown agent')
    expect(await fails(ACCOUNTS_IPC.launchLine, { terminalId: 't', agent: 'claude', command: '  ' })).toBe('there is no command to run')
    expect(await fails(ACCOUNTS_IPC.launchLine, { terminalId: 't', agent: 'claude', command: 'claude', shellType: 'fish', accountId: b }))
      .toBe('Termpolis can\'t type an account line into that shell')
    expect(await fails(ACCOUNTS_IPC.launchLine, { terminalId: 't', agent: 'claude', command: 'claude %x%', shellType: 'cmd', accountId: b }))
      .toBe('Termpolis won\'t type that line: cmd would expand a % or ! in the line')
    expect(terminalAccountId('t')).toBeUndefined()
  })
})

describe('accounts:launch-account', () => {
  it('names the account a launch goes on before its line is built, recording nothing', async () => {
    const { main, b } = await twoClaude()
    expect(await ok(ACCOUNTS_IPC.launchAccount, { agent: 'claude' })).toEqual({ accountId: main })
    expect(await ok(ACCOUNTS_IPC.launchAccount, { agent: 'claude', accountId: b })).toEqual({ accountId: b })
    expect(await ok(ACCOUNTS_IPC.launchAccount, { agent: 'codex' })).toEqual({ accountId: null })
    expect(terminalAccountId('t1')).toBeUndefined()
    expect(await fails(ACCOUNTS_IPC.launchAccount, { agent: 'gemini' })).toBe('unknown agent')
    writeText(join(sb.paths.userData, 'agent-accounts.json'), '{ broken')
    expect(await ok(ACCOUNTS_IPC.launchAccount, { agent: 'claude' })).toEqual({ accountId: null })
  })

  it('keeps the Claude Code session each launch line starts or resumes, as main\'s own record', async () => {
    const { b } = await twoClaude()
    const r = await line({ accountId: b })
    expect(terminalSessionId('t1')).toBe(r.sessionId)
    await line({ accountId: b, command: 'claude --continue' })
    expect(terminalSessionId('t1')).toBeUndefined()
    // Not Claude Code: its record is left alone.
    noteTerminalSession('t1', 'kept')
    await ok(ACCOUNTS_IPC.add, { agent: 'agy', label: 'g' })
    await line({ agent: 'agy', command: 'agy' })
    expect(terminalSessionId('t1')).toBe('kept')
    forgetTerminalAccount('t1')
    expect(terminalSessionId('t1')).toBeUndefined()
  })
})

describe('launchAccountOf and claudeSessionOf', () => {
  it('falls back to the default profile, then the first account, when nothing is preferred', () => {
    const a = { id: 'acc_a', agent: 'codex', profile: '/h/.codex-a' } as any
    const d = { id: 'acc_d', agent: 'codex', profile: null } as any
    const doc = { file: { preferred: {} } } as any
    expect(launchAccountOf(doc, [a, d], undefined)).toBe(d)
    expect(launchAccountOf(doc, [a], 'acc_x')).toBe(a)
  })

  it('reads the session a Claude Code command starts', () => {
    const id = '3f2a9c1e-5b7d-4e8f-a012-3456789abcde'
    expect(claudeSessionOf('claude')).toEqual({ id: null, fresh: true })
    expect(claudeSessionOf(`claude -r ${id}`)).toEqual({ id, fresh: false })
    expect(claudeSessionOf(`claude --session-id ${id} --model opus`)).toEqual({ id, fresh: false })
    expect(claudeSessionOf('claude --resume')).toEqual({ id: null, fresh: false })
    expect(claudeSessionOf('claude -c')).toEqual({ id: null, fresh: false })
    expect(claudeSessionOf(`claude --resume ${id} --fork-session`)).toEqual({ id, fresh: false })
    expect(claudeSessionOf('claude --fork-session')).toEqual({ id: null, fresh: false })
  })
})

describe('the typed-line watch (§6.1, R1)', () => {
  it('takes main\'s own line, once, as Termpolis\'s: no change by hand, and the agent\'s start recorded', async () => {
    const { b } = await twoClaude()
    const r = await line({ accountId: b })
    ends.set('t1', 4242)
    expect(noteTypedInput('t1', r.line + '\r', clock)).toBe('own')
    expect(isAccountChangedByHand('t1')).toBe(false)
    expect(terminalAgentStart('t1')).toEqual({ at: 4242, commands: [r.line], agent: 'claude', time: clock })
    expect(sent).toEqual([])
    // The same line typed again later is the user's: it does change the account by hand.
    expect(noteTypedInput('t1', r.line + '\r', clock)).toBe('by-hand')
    expect(isAccountChangedByHand('t1')).toBe(true)
    expect(sent).toEqual([{ channel: ACCOUNTS_IPC.terminalAccount, payload: { terminalId: 't1', accountId: b, byHand: true } }])
  })

  it('keeps main\'s line its own only for OWN_LINE_MS', async () => {
    const { b } = await twoClaude()
    const r = await line({ accountId: b })
    expect(noteTypedInput('t1', r.line + '\r', clock + OWN_LINE_MS)).toBe('by-hand')
  })

  it('records no start where main can\'t say where the output ends', async () => {
    register({ outputEnd: undefined })
    const { b } = await twoClaude()
    const r = await line({ accountId: b })
    expect(noteTypedInput('t1', r.line + '\r', clock)).toBe('own')
    expect(terminalAgentStart('t1')).toBeUndefined()
  })

  it('gathers keystrokes into the line, with Backspace, Ctrl+U, Ctrl+C and arrow keys taken into account', () => {
    expect(noteTypedInput('k', 'unset CLAUDE', clock)).toBeNull()
    expect(noteTypedInput('k', '_CONFIG_DIRX\x7f', clock)).toBeNull()
    expect(noteTypedInput('k', '\x1b[D\x1b[C\x1bOA\r', clock)).toBe('by-hand')
    expect(sent[0].payload).toEqual({ terminalId: 'k', accountId: null, byHand: true })
    // Erased before its Enter: nothing.
    expect(noteTypedInput('e', 'export CODEX_HOME=x\x15ls\r', clock)).toBeNull()
    expect(noteTypedInput('e', 'export CODEX_HOME=x\x03\r', clock)).toBeNull()
    expect(noteTypedInput('e', 'set CODEX_HOME=x\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\r', clock)).toBeNull()
    // Esc and a key in one write are Alt+key, which types nothing; a lone Esc, at a write's end.
    expect(noteTypedInput('e', '\x1bsswitch-now\r', clock)).toBe('by-hand')
    expect(noteTypedInput('f', 'x\x1b', clock)).toBeNull()
    expect(isAccountChangedByHand('e')).toBe(true)
    expect(isAccountChangedByHand('f')).toBe(false)
  })

  it('reads a paste of several lines line by line, and keeps a typed line no longer than 4 KB', () => {
    expect(noteTypedInput('p', 'cd repo\nexport CLAUDE_CONFIG_DIR=/x\nls\n', clock)).toBeNull()
    expect(isAccountChangedByHand('p')).toBe(true)
    expect(noteTypedInput('q', 'a'.repeat(5000) + ' unset CLAUDE_CONFIG_DIR\r', clock)).toBeNull()
    expect(isAccountChangedByHand('q')).toBe(false)
    expect(noteTypedInput('r', '   \r', clock)).toBeNull()
  })

  it('stops answering trust prompts in a terminal changed by hand, until main puts it on an account again (R9)', async () => {
    const { b } = await twoClaude()
    noteTerminalAccount('t2', b)
    expect(isTerminalAccountConnected(sb.paths, 't2')).toBe(false) // b isn't connected
    noteTerminalAccount('t3', null)
    expect(isTerminalAccountConnected(sb.paths, 't3')).toBe(true)
    noteTypedInput('t3', 'unset CLAUDE_CONFIG_DIR\r', clock)
    expect(isTerminalAccountConnected(sb.paths, 't3')).toBe(false)
    noteTerminalAccount('t3', null)
    expect(isAccountChangedByHand('t3')).toBe(false)
    expect(isTerminalAccountConnected(sb.paths, 't3')).toBe(true)
  })

  it('forgets everything about a terminal that closes', async () => {
    const { b } = await twoClaude()
    await line({ accountId: b })
    noteTypedInput('t1', 'export CODEX', clock)
    noteAgentStart('t1', { at: 1, commands: ['claude'] })
    noteTypedInput('t1', '\x15unset CODEX_HOME\r', clock)
    forgetTerminalAccount('t1')
    expect(terminalAccountId('t1')).toBeUndefined()
    expect(isAccountChangedByHand('t1')).toBe(false)
    expect(terminalAgentStart('t1')).toBeUndefined()
    // Its half-typed line went too.
    expect(noteTypedInput('t1', '_HOME=x\r', clock)).toBeNull()
  })
})
