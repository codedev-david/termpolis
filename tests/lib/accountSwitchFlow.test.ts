// The account switch dialog's logic (src/renderer/src/lib/accountSwitchFlow.ts, §7): which accounts
// a terminal can move to, what a switch asks first (D14, R30), whether the target is signed in now
// (§4.4), the target prepared as a launch would be before main runs the switch, what each outcome
// says, and "New terminal on <account>" (§7.4).
import { describe, it, expect, vi } from 'vitest'
import {
  checkSignIn, hasManyAccounts, openOnAccount, openOtherAgent, outcomeView, runSwitch, switchQuestions, switchTargets, terminalAgent,
} from '../../src/renderer/src/lib/accountSwitchFlow'
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

describe('switchTargets', () => {
  it('lists the agent\'s other accounts with their state, one with no folder blocked', () => {
    const gone = row({ ...B, id: 'acc_g', label: 'gone', folderExists: false })
    const codex = row({ id: 'acc_c', agent: 'codex', label: 'c' })
    const t = switchTargets(view([A, B, gone, codex]), 'claude', 'acc_a', 0)
    expect(t.map((x) => [x.account.id, x.state, x.blocked])).toEqual([
      ['acc_b', 'last signed in as b@example.test', null],
      ['acc_g', 'folder missing', 'gone\'s profile folder doesn\'t exist'],
    ])
  })

  it('lists every account when the terminal\'s own is unknown, and never blocks an agy label', () => {
    expect(switchTargets(view([A, B]), 'claude', undefined, 0)).toHaveLength(2)
    const g = row({ id: 'g', agent: 'agy', label: 'home', profile: null, folder: null, isDefault: false, folderExists: false })
    expect(switchTargets(view([g]), 'agy', undefined, 0)[0].blocked).toBeNull()
  })
})

describe('switchQuestions (D14, R30)', () => {
  it('asks a second confirmation onto or off an account not offered automatically', () => {
    expect(switchQuestions('claude', A, W)).toEqual([
      'work isn\'t offered automatically. Switch this terminal to work?',
      'work isn\'t connected to Termpolis. This conversation will lose Termpolis\'s tools and memory, and its earlier tool calls to them will fail.',
    ])
    expect(switchQuestions('claude', W, A)).toEqual(['This conversation is on work, which isn\'t offered automatically. Carry it to personal? (New terminal on personal starts a fresh session there instead.)'])
  })

  it('asks nothing between two ordinary connected accounts, or of the default profile, or of agy', () => {
    expect(switchQuestions('claude', A, B)).toEqual([])
    expect(switchQuestions('claude', undefined, row({ ...A, connect: false }))).toEqual([])
    expect(switchQuestions('agy', undefined, row({ agent: 'agy', isDefault: false, connect: false }))).toEqual([])
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

describe('outcomeView: what each outcome says', () => {
  const cases: Array<[SwitchOutcome, Partial<ReturnType<typeof outcomeView>>]> = [
    [{ kind: 'switched', resumed: true }, { tone: 'good', done: true, text: 'Now on codedev. Your conversation continues. Its first answer re-reads the whole conversation (no shared prompt cache).' }],
    [{ kind: 'switched', resumed: true, kept: 'x.jsonl.bak-1' }, { text: 'Now on codedev. Your conversation continues. Its first answer re-reads the whole conversation (no shared prompt cache). codedev had a newer copy of it, kept beside it as x.jsonl.bak-1.' }],
    [{ kind: 'fresh', why: 'not-found' }, { tone: 'warn', done: true, text: 'Claude Code can\'t carry this conversation to codedev, so a new session started there. Termpolis\'s memory still has what it learned.' }],
    [{ kind: 'fresh', why: 'no-session' }, { text: 'Claude Code named no conversation to resume, so a new session started on codedev.' }],
    [{ kind: 'fresh', why: 'asked' }, { text: 'A new session started on codedev.' }],
    [{ kind: 'busy' }, { text: 'Claude Code is working. Stop it and switch?', retry: { label: 'Stop it and switch', answers: { stopBusy: true } }, done: false }],
    [{ kind: 'unknown-exit' }, { retry: { label: 'It has exited, switch now', answers: { assumeExited: true } } }],
    [{ kind: 'exit-unconfirmed' }, { text: 'Termpolis couldn\'t confirm Claude Code exited, so it typed nothing more. Exit it yourself with /exit, then switch again.' }],
    [{ kind: 'agent-alive' }, { tone: 'bad', done: false }],
    [{ kind: 'didnt-start', line: 'L' }, { line: 'L', retry: { label: 'Try again', answers: { assumeExited: true } } }],
    [{ kind: 'resume-not-found' }, { text: 'codedev can\'t see that conversation.', retry: { label: 'Start a new session on codedev', answers: { assumeExited: true, fresh: true } } }],
    [{ kind: 'sign-in' }, { tone: 'bad', done: true }],
    [{ kind: 'asks-user', what: 'x' }, { tone: 'warn', done: true, text: 'codedev is asking something only you can answer: answer it in the terminal.' }],
    [{ kind: 'no-outcome' }, { done: true }],
    [{ kind: 'refused', why: 'no' }, { tone: 'bad', done: false, text: 'Termpolis didn\'t switch: no.' }],
  ]
  it.each(cases)('%j', (o, expected) => {
    expect(outcomeView(o, 'claude', B)).toEqual(expect.objectContaining(expected))
  })

  it('names Codex\'s own exit command', () => {
    expect(outcomeView({ kind: 'exit-unconfirmed' }, 'codex', B).text).toContain('Exit it yourself with /quit')
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
