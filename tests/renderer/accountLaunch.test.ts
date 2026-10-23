// Launching an agent on an account, the renderer's side (src/renderer/src/lib/accountLaunch.ts):
// main names the account and builds the line; with no bridge, every launch is today's.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { accountLaunchLine, accountsBridge, launchAccountFor, launchTerminalArgs } from '../../src/renderer/src/lib/accountLaunch'
import type { AccountsBridge } from '../../src/renderer/src/lib/accountLaunch'

function bridge(over: Partial<Record<keyof AccountsBridge, unknown>> = {}): AccountsBridge {
  return {
    launchAccount: vi.fn(async () => ({ success: true, data: { accountId: 'acc_b' } })),
    launchLine: vi.fn(async (req: { command: string }) => ({ success: true, data: { line: `export X=1 && ${req.command}`, accountId: 'acc_b', explicit: true, sessionId: 's-1' } })),
    ...over,
  } as unknown as AccountsBridge
}

afterEach(() => { delete (window as { accounts?: unknown }).accounts })

describe('accountsBridge', () => {
  it('is the preload\'s accounts namespace when it has the launch methods, else none', () => {
    expect(accountsBridge()).toBeNull()
    ;(window as { accounts?: unknown }).accounts = { list: vi.fn() }
    expect(accountsBridge()).toBeNull()
    const api = bridge()
    ;(window as { accounts?: unknown }).accounts = api
    expect(accountsBridge()).toBe(api)
  })
})

describe('launchAccountFor', () => {
  it('asks main for the account of an account agent, by the command', async () => {
    const api = bridge()
    expect(await launchAccountFor('claude --model opus', 'acc_x', api)).toBe('acc_b')
    expect(api.launchAccount).toHaveBeenCalledWith('claude', 'acc_x')
    expect(await launchAccountFor('agy', undefined, api)).toBe('acc_b')
    expect(api.launchAccount).toHaveBeenLastCalledWith('agy', null)
  })

  it('names none for another command, no bridge, no accounts, or a failed answer', async () => {
    expect(await launchAccountFor('aider', undefined, bridge())).toBeUndefined()
    expect(await launchAccountFor(undefined, undefined, bridge())).toBeUndefined()
    expect(await launchAccountFor('claude', undefined, null)).toBeUndefined()
    expect(await launchAccountFor('claude')).toBeUndefined()
    expect(await launchAccountFor('codex', undefined, bridge({ launchAccount: vi.fn(async () => ({ success: true, data: { accountId: null } })) }))).toBeUndefined()
    expect(await launchAccountFor('codex', undefined, bridge({ launchAccount: vi.fn(async () => ({ success: false, error: 'no' })) }))).toBeUndefined()
    expect(await launchAccountFor('codex', undefined, bridge({ launchAccount: vi.fn(async () => { throw new Error('gone') }) }))).toBeUndefined()
  })
})

describe('accountLaunchLine', () => {
  it('types main\'s line, with the account and session main answered', async () => {
    const api = bridge()
    expect(await accountLaunchLine('t1', 'gitbash', 'node mock.cjs', 'claude', 'acc_b', api))
      .toEqual({ line: 'export X=1 && node mock.cjs', accountId: 'acc_b', sessionId: 's-1' })
    expect(api.launchLine).toHaveBeenCalledWith({ terminalId: 't1', agent: 'claude', shellType: 'gitbash', command: 'node mock.cjs', accountId: 'acc_b' })
    await accountLaunchLine('t1', 'cmd', 'codex', 'codex', undefined, api)
    expect(api.launchLine).toHaveBeenLastCalledWith(expect.objectContaining({ agent: 'codex', accountId: null }))
  })

  it('leaves out an account or session main didn\'t name', async () => {
    const api = bridge({ launchLine: vi.fn(async () => ({ success: true, data: { line: 'agy', accountId: null, explicit: false } })) })
    expect(await accountLaunchLine('t1', 'bash', 'agy', 'agy', undefined, api)).toEqual({ line: 'agy' })
  })

  it('types the command as it is for another command, or with no bridge', async () => {
    const api = bridge()
    expect(await accountLaunchLine('t1', 'bash', 'aider --x', 'aider', undefined, api)).toEqual({ line: 'aider --x' })
    expect(api.launchLine).not.toHaveBeenCalled()
    expect(await accountLaunchLine('t1', 'bash', 'claude', 'claude', undefined, null)).toEqual({ line: 'claude' })
    expect(await accountLaunchLine('t1', 'bash', 'claude', 'claude')).toEqual({ line: 'claude' })
  })

  it('refuses, naming the agent, when main refused or the call failed: nothing is typed then', async () => {
    const refusing = bridge({ launchLine: vi.fn(async () => ({ success: false, error: 'cmd would expand a % or ! in the line' })) })
    expect(await accountLaunchLine('t1', 'cmd', 'claude', 'claude', undefined, refusing))
      .toEqual({ refused: 'Termpolis didn\'t start Claude Code: cmd would expand a % or ! in the line' })
    const throwing = bridge({ launchLine: vi.fn(async () => { throw new Error('ipc closed') }) })
    expect(await accountLaunchLine('t1', 'bash', 'codex', 'codex', undefined, throwing)).toEqual({ refused: 'Termpolis didn\'t start Codex: ipc closed' })
    const odd = bridge({ launchLine: vi.fn(async () => { throw 'odd' }) })
    expect(await accountLaunchLine('t1', 'bash', 'agy', 'agy', undefined, odd)).toEqual({ refused: 'Termpolis didn\'t start Gemini / Antigravity CLI: odd' })
  })
})

describe('launchTerminalArgs', () => {
  it("passes the account and the agent Termpolis will watch there (R6), and nothing more than a call needs", () => {
    expect(launchTerminalArgs('acc_1', 'claude --model opus')).toEqual(['acc_1', 'claude'])
    expect(launchTerminalArgs(undefined, 'codex')).toEqual([undefined, 'codex'])
    expect(launchTerminalArgs(undefined, 'agy')).toEqual([undefined, 'agy'])
    // Not an account agent: no watch, and no argument at all without an account.
    expect(launchTerminalArgs('acc_1', 'aider')).toEqual(['acc_1'])
    expect(launchTerminalArgs(undefined, 'aider')).toEqual([])
    expect(launchTerminalArgs(undefined, undefined)).toEqual([])
  })
})
