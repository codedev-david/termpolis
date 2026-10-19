import { describe, it, expect, vi } from 'vitest'
import { startSignIn } from '../../src/renderer/src/lib/accountSignIn'
import type { SignInIO } from '../../src/renderer/src/lib/accountSignIn'
import type { TerminalSession } from '../../src/renderer/src/types'

function io(over: Partial<SignInIO> = {}): SignInIO & { log: string[] } {
  const log: string[] = []
  const base: SignInIO = {
    newId: () => 't-sign',
    createTerminal: vi.fn(async (id, shell, cwd) => { log.push(`create ${id} ${shell} ${cwd}`); return { success: true } }),
    addTerminal: vi.fn((t: TerminalSession) => { log.push(`add ${t.name} agent=${String(t.agentCommand)}`) }),
    waitShellReady: vi.fn(async (_id, phase) => { log.push(`wait ${phase}`) }),
    write: vi.fn((id, data) => { log.push(`write ${id} ${JSON.stringify(data)}`) }),
    outputEnd: vi.fn(async () => { log.push('mark'); return 4321 }),
    watch: vi.fn(async (accountId, terminalId, mark) => { log.push(`watch ${accountId} ${terminalId} ${mark}`); return { success: true, data: { watching: true } } }),
    terminalDefaults: () => ({ fontSize: 14, theme: 'dark', fontFamily: 'mono' }),
  }
  return Object.assign({ ...base, ...over }, { log })
}

const REQ = {
  accountId: 'acc_000000000001',
  line: '& { $env:CLAUDE_CONFIG_DIR = \'C:\\Users\\me\\.claude-b\'; claude auth login --claudeai }',
  name: 'Sign in · Claude Code · b',
  shellType: 'powershell' as const,
  home: 'C:\\Users\\me',
  color: '#D97706',
}

describe('startSignIn: a visible terminal that runs the CLI\'s own sign-in command', () => {
  it('opens the terminal in the home folder, waits for its shell, marks the output, types the line, then watches', async () => {
    const x = io()
    expect(await startSignIn(REQ, x)).toEqual({ terminalId: 't-sign', watching: true })
    expect(x.log).toEqual([
      'create t-sign powershell C:\\Users\\me',
      'add Sign in · Claude Code · b agent=undefined',
      'wait ready',
      'write t-sign "\\r"',
      'wait echo',
      'mark',
      `write t-sign ${JSON.stringify(REQ.line + '\r')}`,
      'watch acc_000000000001 t-sign 4321',
    ])
  })

  it('never gives the sign-in terminal an agentCommand, so no poller answers its screens (R29)', async () => {
    const x = io()
    await startSignIn(REQ, x)
    const t = (x.addTerminal as ReturnType<typeof vi.fn>).mock.calls[0][0] as TerminalSession
    expect(t).toEqual({ id: 't-sign', name: REQ.name, color: REQ.color, shellType: 'powershell', cwd: REQ.home, fontSize: 14, theme: 'dark', fontFamily: 'mono' })
    expect('agentCommand' in t).toBe(false)
    expect(x.createTerminal).toHaveBeenCalledWith('t-sign', 'powershell', REQ.home)
  })

  it('types nothing, and adds no terminal, when the shell can\'t be opened', async () => {
    const x = io({ createTerminal: vi.fn(async () => ({ success: false, error: 'No shell available' })) })
    expect(await startSignIn(REQ, x)).toEqual({ error: 'No shell available' })
    expect(x.addTerminal).not.toHaveBeenCalled()
    expect(x.write).not.toHaveBeenCalled()
    expect(x.watch).not.toHaveBeenCalled()
  })

  it('still types the line when the watch can\'t start, and says so', async () => {
    const x = io({ watch: vi.fn(async () => ({ success: false, error: 'that account isn\'t registered any more' })) })
    expect(await startSignIn(REQ, x)).toEqual({ terminalId: 't-sign', watching: false, watchError: 'that account isn\'t registered any more' })
    expect(x.write).toHaveBeenLastCalledWith('t-sign', REQ.line + '\r')
    const y = io({ watch: vi.fn(async () => ({ success: true, data: { watching: false } })) })
    expect(await startSignIn(REQ, y)).toEqual({ terminalId: 't-sign', watching: false })
  })

  it('marks from the start when the output\'s end can\'t be read', async () => {
    const x = io({ outputEnd: vi.fn(async () => null) })
    await startSignIn(REQ, x)
    expect(x.watch).toHaveBeenCalledWith(REQ.accountId, 't-sign', 0)
  })
})
