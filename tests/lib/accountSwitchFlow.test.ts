// The account switch dialog's logic (src/renderer/src/lib/accountSwitchFlow.ts, §7): which accounts
// a terminal can move to, what a switch asks first (D14, R30), whether the target is signed in now
// (§4.4), the target prepared as a launch would be before main runs the switch, what each outcome
// says, and "New terminal on <account>" (§7.4).
import { describe, it, expect, vi } from 'vitest'
import {
  checkSignIn, hasManyAccounts, openOnAccount, openOtherAgent, runSwitch, terminalAgent,
} from '../../src/renderer/src/lib/accountSwitchFlow'
import { freshCommand } from '../../src/shared/launchCarry'
import type { AccountRowView, AccountsView } from '../../src/shared/agentAccounts'
import type { SwitchOutcome } from '../../src/shared/accountSwitch'
import type { TerminalSession } from '../../src/renderer/src/types'

function row(over: Partial<AccountRowView>): AccountRowView {
  return {
    id: 'acc_a', agent: 'claude', label: 'personal', profile: null, folder: '/h/.claude', isDefault: true, autoOffer: true,
    order: 0, connect: true, origin: 'adopted', folderExists: true, shares: [], lastEmail: null, connection: null, bypassReady: false,
    terminals: 0, recopyAvailable: false, ...over,
  }
}

function view(accounts: AccountRowView[]): AccountsView {
  return {
    accounts, preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [],
    advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h',
  }
}

const A = row({ id: 'acc_a', label: 'personal', email: 'a@example.test', lastEmail: 'a@example.test' })
const B = row({ id: 'acc_b', label: 'codedev', profile: '/h/.claude-b', folder: '/h/.claude-b', isDefault: false, email: 'b@example.test', lastEmail: 'b@example.test', order: 1 })
const W = row({ id: 'acc_w', label: 'work', profile: '/h/.claude-w', folder: '/h/.claude-w', isDefault: false, autoOffer: false, connect: false, order: 2 })
const term: TerminalSession = { id: 't1', name: 'Claude Code — repo', color: '#D97706', shellType: 'gitbash', cwd: '/repo', fontSize: 13, theme: 'dark', fontFamily: 'mono', agentCommand: 'claude' }

describe('terminalAgent', () => {
  it('is the agent Termpolis launched, never the conductor\'s', () => {
    expect(terminalAgent(term)).toBe('claude')
    expect(terminalAgent({ agentCommand: 'codex -m x' })).toBe('codex')
    expect(terminalAgent({ agentCommand: 'claude', isConductor: true })).toBeNull()
    expect(terminalAgent({})).toBeNull()
    expect(terminalAgent(undefined)).toBeNull()
  })
})

describe('checkSignIn (§4.4)', () => {
  const ans = (data: unknown) => ({ check: vi.fn(async () => ({ success: true as const, data: data as AccountRowView })) })

  it('takes the agent\'s own answer', async () => {
    expect(await checkSignIn(ans({ ...B, identity: { email: 'b@example.test', signedIn: true, checkedAt: 1, source: 'auth-status' } }), B)).toEqual({ kind: 'signed-in', email: 'b@example.test' })
    expect(await checkSignIn(ans({ ...B, identity: { email: null, signedIn: false, checkedAt: 1, source: 'auth-status' } }), B)).toEqual({ kind: 'signed-out' })
  })

  it('falls back to who the profile last signed in as when the agent can\'t be asked, and says why', async () => {
    const refused = { check: vi.fn(async () => ({ success: false as const, error: 'A Termpolis terminal is running on codedev' })) }
    expect(await checkSignIn(refused, B)).toEqual({ kind: 'signed-in', email: 'b@example.test', note: 'A Termpolis terminal is running on codedev' })
    const silent = ans({ ...B, identity: { email: null, signedIn: null, checkedAt: 1, source: 'auth-status' } })
    expect(await checkSignIn(silent, B)).toEqual({ kind: 'signed-in', email: 'b@example.test', note: 'Claude Code gave no answer' })
    expect(await checkSignIn(ans(undefined), B)).toEqual({ kind: 'signed-in', email: 'b@example.test', note: 'Claude Code gave no answer' })
  })

  it('can\'t tell when neither knows', async () => {
    const thrown = { check: vi.fn(async () => { throw new Error('ipc gone') }) }
    expect(await checkSignIn(thrown, W)).toEqual({ kind: 'unknown', why: 'ipc gone' })
    const odd = { check: vi.fn(async () => { throw 'odd' }) }
    expect(await checkSignIn(odd, W)).toEqual({ kind: 'unknown', why: 'odd' })
  })
})

describe('runSwitch', () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    accounts: { switchAccount: vi.fn(async () => ({ success: true as const, data: { kind: 'switched', resumed: true } as SwitchOutcome })) },
    termpolis: {
      claudeTrustWorkspace: vi.fn(async () => ({ success: true as const, data: { changed: true, keys: [] } })),
      memoryPrepareCodexContext: vi.fn(async () => ({ success: true as const, data: { developerInstructions: 'Use the memory tools.', approvals: 0 } })),
    },
    primerEnabled: () => true,
    ...over,
  }) as never as Parameters<typeof runSwitch>[4] & Record<string, any>

  it('trusts the folder in the target\'s profile before main switches Claude Code, awaited', async () => {
    const order: string[] = []
    const d = deps()
    d.termpolis.claudeTrustWorkspace.mockImplementation(async () => { order.push('trust'); return { success: true, data: { changed: true, keys: [] } } })
    d.accounts.switchAccount.mockImplementation(async () => { order.push('switch'); return { success: true, data: { kind: 'switched', resumed: true } } })
    expect(await runSwitch(term, 'claude', B, { stopBusy: true }, d, 'usage limit')).toEqual({ kind: 'switched', resumed: true })
    expect(order).toEqual(['trust', 'switch'])
    expect(d.termpolis.claudeTrustWorkspace).toHaveBeenCalledWith('/repo', 'acc_b')
    expect(d.accounts.switchAccount).toHaveBeenCalledWith({ terminalId: 't1', targetId: 'acc_b', shellType: 'gitbash', reason: 'usage limit', stopBusy: true })
  })

  it('prepares Codex in the target\'s home and hands main its instruction when it is shell-safe and memory loads', async () => {
    const d = deps()
    await runSwitch({ ...term, shellType: 'powershell' }, 'codex', B, {}, d)
    expect(d.termpolis.memoryPrepareCodexContext).toHaveBeenCalledWith('/repo', 'acc_b')
    expect(d.accounts.switchAccount).toHaveBeenCalledWith(expect.objectContaining({ instructions: 'Use the memory tools.', reason: 'by hand' }))
    const off = deps({ primerEnabled: () => false })
    await runSwitch(term, 'codex', B, {}, off)
    expect(off.accounts.switchAccount.mock.calls[0][0]).not.toHaveProperty('instructions')
    const unsafe = deps()
    unsafe.termpolis.memoryPrepareCodexContext.mockResolvedValue({ success: true, data: { developerInstructions: 'say "$(x)"', approvals: 0 } })
    await runSwitch(term, 'codex', B, {}, unsafe)
    expect(unsafe.accounts.switchAccount.mock.calls[0][0]).not.toHaveProperty('instructions')
  })

  it('switches without the preparation when it fails, or when there is no folder', async () => {
    const d = deps()
    d.termpolis.claudeTrustWorkspace.mockRejectedValue(new Error('locked'))
    d.termpolis.memoryPrepareCodexContext.mockRejectedValue(new Error('locked'))
    expect((await runSwitch(term, 'claude', B, {}, d)).kind).toBe('switched')
    expect((await runSwitch(term, 'codex', B, {}, d)).kind).toBe('switched')
    const failed = deps()
    failed.termpolis.memoryPrepareCodexContext.mockResolvedValue({ success: false, error: 'x' })
    await runSwitch(term, 'codex', B, {}, failed)
    expect(failed.accounts.switchAccount.mock.calls[0][0]).not.toHaveProperty('instructions')
    const noCwd = deps()
    await runSwitch({ ...term, cwd: '' }, 'claude', B, {}, noCwd)
    await runSwitch({ ...term, cwd: '' }, 'codex', B, {}, noCwd)
    expect(noCwd.termpolis.claudeTrustWorkspace).not.toHaveBeenCalled()
    expect(noCwd.termpolis.memoryPrepareCodexContext).not.toHaveBeenCalled()
  })

  it('turns main\'s refusal, or a failed call, into a refused outcome', async () => {
    const refused = deps()
    refused.accounts.switchAccount.mockResolvedValue({ success: false, error: 'switching accounts isn\'t available' })
    expect(await runSwitch(term, 'claude', B, {}, refused)).toEqual({ kind: 'refused', why: 'switching accounts isn\'t available' })
    const thrown = deps()
    thrown.accounts.switchAccount.mockRejectedValue(new Error('ipc closed'))
    expect(await runSwitch(term, 'claude', B, {}, thrown)).toEqual({ kind: 'refused', why: 'ipc closed' })
    const odd = deps()
    odd.accounts.switchAccount.mockRejectedValue('odd')
    expect(await runSwitch(term, 'agy', B, {}, odd)).toEqual({ kind: 'refused', why: 'odd' })
  })
})

describe('hasManyAccounts', () => {
  it('is true only for an agent with more than one account', () => {
    expect(hasManyAccounts(view([A, B]), 'claude')).toBe(true)
    expect(hasManyAccounts(view([A]), 'claude')).toBe(false)
    expect(hasManyAccounts(view([A, B]), 'codex')).toBe(false)
    expect(hasManyAccounts(null, 'claude')).toBe(false)
    expect(hasManyAccounts(view([A, B]), null)).toBe(false)
  })
})

describe('openOnAccount (§7.4)', () => {
  const deps = () => ({
    createTerminal: vi.fn(async () => ({ success: true as const })),
    addTerminal: vi.fn(),
    launch: vi.fn(),
    newId: () => 't2',
  })

  it('opens the same agent beside the terminal, on the account, for a fresh session', async () => {
    const d = deps()
    expect(await openOnAccount(term, B, d as never)).toEqual({ ok: true, id: 't2' })
    expect(d.createTerminal).toHaveBeenCalledWith('t2', 'gitbash', '/repo', undefined, true, 'acc_b', 'claude')
    expect(d.addTerminal).toHaveBeenCalledWith(expect.objectContaining({ id: 't2', name: 'Claude Code — repo · codedev', cwd: '/repo', agentCommand: 'claude', agentAccountId: 'acc_b' }))
    expect(d.launch).toHaveBeenCalledWith([{ id: 't2', agentCommand: 'claude', cwd: '/repo', shellType: 'gitbash', agentAccountId: 'acc_b' }])
    await openOnAccount({ ...term, agentCommand: 'codex' }, B, d as never)
    expect(d.createTerminal).toHaveBeenLastCalledWith('t2', 'gitbash', '/repo', undefined, false, 'acc_b', 'codex')
  })

  it('says why, and adds nothing, when the terminal can\'t open', async () => {
    const failed = deps()
    failed.createTerminal.mockResolvedValue({ success: false, error: 'No shell available' } as never)
    expect(await openOnAccount(term, B, failed as never)).toEqual({ ok: false, error: 'Termpolis couldn\'t open the terminal: No shell available' })
    const thrown = deps()
    thrown.createTerminal.mockRejectedValue(new Error('gone'))
    expect(await openOnAccount(term, B, thrown as never)).toEqual({ ok: false, error: 'Termpolis couldn\'t open the terminal: gone' })
    const odd = deps()
    odd.createTerminal.mockRejectedValue('odd')
    expect(await openOnAccount(term, B, odd as never)).toEqual({ ok: false, error: 'Termpolis couldn\'t open the terminal: odd' })
    expect(failed.addTerminal).not.toHaveBeenCalled()
  })
})

describe('openOtherAgent (§8.4 Use another agent)', () => {
  const deps = () => ({
    createTerminal: vi.fn(async () => ({ success: true as const })),
    addTerminal: vi.fn(),
    launch: vi.fn(),
    newId: () => 't3',
  })

  it("opens the other agent beside the terminal, in its folder, on that agent's preferred account", async () => {
    const d = deps()
    expect(await openOtherAgent(term, 'codex', 'Codex', d as never)).toEqual({ ok: true, id: 't3' })
    expect(d.createTerminal).toHaveBeenCalledWith('t3', 'gitbash', '/repo', undefined, false, undefined, 'codex')
    expect(d.addTerminal).toHaveBeenCalledWith(expect.objectContaining({ id: 't3', name: 'Claude Code — repo · Codex', agentCommand: 'codex', cwd: '/repo' }))
    expect(d.addTerminal.mock.calls[0][0]).not.toHaveProperty('agentAccountId')
    expect(d.launch).toHaveBeenCalledWith([{ id: 't3', agentCommand: 'codex', cwd: '/repo', shellType: 'gitbash' }])
    await openOtherAgent({ ...term, agentCommand: 'codex' }, 'claude', 'Claude Code', d as never)
    expect(d.createTerminal).toHaveBeenLastCalledWith('t3', 'gitbash', '/repo', undefined, true, undefined, 'claude')
  })

  it('says why the terminal could not open, and opens nothing', async () => {
    const failed = deps()
    failed.createTerminal.mockResolvedValue({ success: false, error: 'No shell available' } as never)
    expect(await openOtherAgent(term, 'agy', 'agy', failed as never)).toEqual({ ok: false, error: "Termpolis couldn't open the terminal: No shell available" })
    const thrown = deps()
    thrown.createTerminal.mockRejectedValue(new Error('gone'))
    expect(await openOtherAgent(term, 'agy', 'agy', thrown as never)).toEqual({ ok: false, error: "Termpolis couldn't open the terminal: gone" })
    const odd = deps()
    odd.createTerminal.mockRejectedValue('odd')
    expect(await openOtherAgent(term, 'agy', 'agy', odd as never)).toEqual({ ok: false, error: "Termpolis couldn't open the terminal: odd" })
    expect(failed.addTerminal).not.toHaveBeenCalled()
    expect(failed.launch).not.toHaveBeenCalled()
  })
})

describe('freshCommand: a new terminal on an account is a new conversation (R8)', () => {
  const SID = '3f2a9c1e-5b7d-4e8f-a012-3456789abcde'

  it.each([
    ['claude', 'claude'],
    [`claude --resume ${SID}`, 'claude'],
    [`claude -r ${SID} --model opus`, 'claude --model opus'],
    ['claude --continue --dangerously-skip-permissions', 'claude --dangerously-skip-permissions'],
    ['claude -c', 'claude'],
    [`claude --session-id ${SID} --permission-mode plan`, 'claude --permission-mode plan'],
    [`claude --resume=${SID}`, 'claude'],
    ['claude --fork-session --verbose', 'claude --verbose'],
    ['claude --resume --verbose', 'claude --verbose'],
    [`codex resume ${SID}`, 'codex'],
    ['codex resume --last -m gpt-5.6-sol', 'codex -m gpt-5.6-sol'],
    [`codex -a never resume ${SID}`, 'codex -a never'],
    [`agy --conversation=${SID} --model m`, 'agy --model m'],
    ['agy --continue', 'agy'],
  ])('%s -> %s', (from, to) => {
    expect(freshCommand(from)).toBe(to)
  })

  it('leaves a command that is no agent\'s as it is (a test shim), and quotes that can be taken apart', () => {
    expect(freshCommand('node mock-codex.cjs')).toBe('node mock-codex.cjs')
    expect(freshCommand(`claude --resume ${SID} --append-system-prompt-file "C:/p.txt"`)).toBe('claude --append-system-prompt-file "C:/p.txt"')
  })

  it('gives up, rather than guess, on a command that picks a conversation and cannot be taken apart', () => {
    expect(freshCommand('claude --resume $(cat id) --model opus')).toBeNull()
    expect(freshCommand('claude --resume "a\\b"')).toBeNull()
    // Nothing to drop: the same text, though it cannot be split.
    expect(freshCommand('claude --model "a$b"')).toBe('claude --model "a$b"')
  })
})

describe('openOnAccount never carries the source\'s conversation to the new terminal (R8)', () => {
  const SID = '3f2a9c1e-5b7d-4e8f-a012-3456789abcde'
  const deps = () => ({ createTerminal: vi.fn(async () => ({ success: true as const })), addTerminal: vi.fn(), launch: vi.fn(), newId: () => 't2' })

  it.each([
    ['claude', `claude --resume ${SID}`, 'claude'],
    ['claude', 'claude --continue --model opus', 'claude --model opus'],
    ['codex', `codex resume ${SID}`, 'codex'],
    ['codex', 'codex resume --last', 'codex'],
    ['agy', `agy --conversation=${SID}`, 'agy'],
  ])('%s: %s starts %s', async (_agent, from, to) => {
    const d = deps()
    expect(await openOnAccount({ ...term, agentCommand: from }, B, d as never)).toEqual({ ok: true, id: 't2' })
    expect(d.launch).toHaveBeenCalledWith([expect.objectContaining({ id: 't2', agentCommand: to })])
    expect(d.addTerminal).toHaveBeenCalledWith(expect.objectContaining({ agentCommand: to }))
    expect(d.createTerminal.mock.calls[0][4]).toBe(to.startsWith('claude'))
  })

  it('opens nothing for a command that picks a conversation and cannot be taken apart, and says why', async () => {
    const d = deps()
    const r = await openOnAccount({ ...term, agentCommand: 'claude --resume $(cat id)' }, B, d as never)
    expect(r).toEqual({ ok: false, error: expect.stringContaining("can't start a new session") })
    expect(d.createTerminal).not.toHaveBeenCalled()
    expect(d.launch).not.toHaveBeenCalled()
  })
})
