// Launching an agent from the sidebar or a shortcut on an account (§6.3, launchAgentProfile): main
// names the account first, so its proxy step-aside, folder trust and Codex prepare are that
// account's profile's, then builds the line, which is what gets typed; the terminal records both.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/renderer/src/lib/testAgents', () => ({
  resolveAgentCommand: (cmd: string) => cmd,
  testDelay: (_ms: number) => 0,
}))
vi.mock('../../src/renderer/src/lib/terminalDefaults', () => ({
  getTerminalDefaults: () => ({ fontSize: 14, theme: 'dark', fontFamily: 'monospace' }),
  agentTerminalName: (profileName: string) => profileName,
}))
vi.mock('../../src/renderer/src/hooks/useAutoPrimer', () => ({ isAutoPrimerEnabled: () => true }))
vi.mock('../../src/renderer/src/hooks/useAutoCodeIndex', () => ({ autoIndexRepo: () => Promise.resolve() }))

import { DEFAULT_AI_PROFILES, launchAgentProfile } from '../../src/renderer/src/lib/aiProfiles'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { answerLaunchAsk } from '../../src/renderer/src/lib/launchAsk'
import type { ShellInfo } from '../../src/renderer/src/types'

const shells: ShellInfo[] = [{ type: 'powershell', label: 'PowerShell', executable: 'powershell.exe' }]
const [claude, codex, gemini] = DEFAULT_AI_PROFILES

let addTerminal: ReturnType<typeof vi.fn>
let setLaunchingAgent: ReturnType<typeof vi.fn>
let accounts: { launchAccount: ReturnType<typeof vi.fn>; launchLine: ReturnType<typeof vi.fn> }

const api = (): Record<string, ReturnType<typeof vi.fn>> => (window as never as { termpolis: Record<string, ReturnType<typeof vi.fn>> }).termpolis
const typed = (): string[] => api().writeToTerminal.mock.calls.map((c) => String(c[1]))
const createdId = (): string => String(api().createTerminal.mock.calls[0][0])

beforeEach(() => {
  addTerminal = vi.fn((t) => useTerminalStore.setState({ terminals: [...useTerminalStore.getState().terminals, t] }))
  setLaunchingAgent = vi.fn()
  useTerminalStore.setState({ terminals: [] })
  useTerminalStore.getState().setMemoryNotice(null)
  ;(window as never as { termpolis: unknown }).termpolis = {
    pickDirectory: vi.fn().mockResolvedValue({ success: true, data: '/repo' }),
    createTerminal: vi.fn().mockResolvedValue({ success: true }),
    writeToTerminal: vi.fn(),
    onTerminalData: vi.fn(() => () => undefined),
    memoryPreparePrimerFile: vi.fn().mockResolvedValue({ success: true, data: { file: null, count: 0 } }),
    memoryPrepareCodexContext: vi.fn().mockResolvedValue({ success: true, data: { developerInstructions: 'Use the memory tools.', approvals: 0 } }),
    claudeTrustWorkspace: vi.fn().mockResolvedValue({ success: true, data: { changed: true, keys: [] } }),
  }
  accounts = {
    launchAccount: vi.fn(async () => ({ success: true, data: { accountId: 'acc_b' } })),
    launchLine: vi.fn(async (req: { command: string; terminalId: string }) => ({
      success: true, data: { line: `& { $env:X = 'b'; ${req.command} }`, accountId: 'acc_b', explicit: true, sessionId: 's-1' },
    })),
  }
  ;(window as never as { accounts: unknown }).accounts = accounts
})

afterEach(() => { delete (window as { accounts?: unknown }).accounts })

describe('launchAgentProfile on an account', () => {
  it('asks for the account first, and runs Claude Code\'s writes and line on it', async () => {
    await launchAgentProfile(claude, { availableShells: shells, addTerminal, setLaunchingAgent })
    expect(accounts.launchAccount).toHaveBeenCalledWith('claude', null)
    const id = createdId()
    expect(api().createTerminal).toHaveBeenCalledWith(id, 'powershell', '/repo', undefined, true, 'acc_b', 'claude')
    expect(api().claudeTrustWorkspace).toHaveBeenCalledWith('/repo', 'acc_b')
    // The memory primer is prepared for that account too: main seeds only an account the user connected.
    expect(api().memoryPreparePrimerFile).toHaveBeenCalledWith(expect.any(String), '/repo', 'acc_b')
    expect(addTerminal).toHaveBeenCalledWith(expect.objectContaining({ id, agentCommand: 'claude', agentAccountId: 'acc_b' }))
    expect(accounts.launchLine).toHaveBeenCalledWith({ terminalId: id, agent: 'claude', shellType: 'powershell', command: 'claude', accountId: 'acc_b' })
    expect(typed()).toEqual(['\r', "& { $env:X = 'b'; claude }\r"])
    expect(useTerminalStore.getState().terminals[0]).toEqual(expect.objectContaining({ agentAccountId: 'acc_b', agentSessionId: 's-1' }))
  })

  it('launches on the account the sidebar\'s Launch on ▸ named', async () => {
    await launchAgentProfile(claude, { availableShells: shells, addTerminal, setLaunchingAgent, accountId: 'acc_w' })
    expect(accounts.launchAccount).toHaveBeenCalledWith('claude', 'acc_w')
  })

  it('prepares Codex in the account\'s own home, and builds its line with the instruction on it', async () => {
    await launchAgentProfile(codex, { availableShells: shells, addTerminal, setLaunchingAgent })
    expect(api().memoryPrepareCodexContext).toHaveBeenCalledWith('/repo', 'acc_b')
    expect(accounts.launchLine).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex', command: `codex -c "developer_instructions='Use the memory tools.'"` }))
  })

  it('records no session for a line that names none', async () => {
    accounts.launchLine.mockResolvedValueOnce({ success: true, data: { line: 'agy', accountId: 'acc_g', explicit: true } })
    await launchAgentProfile(gemini, { availableShells: shells, addTerminal, setLaunchingAgent })
    expect(typed()).toEqual(['\r', 'agy\r'])
    expect(useTerminalStore.getState().terminals[0].agentSessionId).toBeUndefined()
  })

  it('types nothing, and says why, when main refuses the line', async () => {
    accounts.launchLine.mockResolvedValueOnce({ success: false, error: 'cmd would expand a % or ! in the line' })
    await launchAgentProfile(claude, { availableShells: shells, addTerminal, setLaunchingAgent })
    expect(typed()).toEqual([])
    expect(useTerminalStore.getState().memoryNotice).toBe('⚠️ Termpolis didn\'t start Claude Code: cmd would expand a % or ! in the line')
    expect(setLaunchingAgent).toHaveBeenLastCalledWith(null)
  })

  it('makes every call as before accounts when the agent has none', async () => {
    accounts.launchAccount.mockResolvedValue({ success: true, data: { accountId: null } })
    accounts.launchLine.mockResolvedValue({ success: true, data: { line: 'claude', accountId: null, explicit: false } })
    await launchAgentProfile(claude, { availableShells: shells, addTerminal, setLaunchingAgent })
    // No account; the agent Termpolis watches there, which main marks only once it has two (R6).
    expect(api().createTerminal.mock.calls[0].slice(3)).toEqual([undefined, true, undefined, 'claude'])
    expect(api().claudeTrustWorkspace.mock.calls).toEqual([['/repo']])
    expect(api().memoryPreparePrimerFile.mock.calls[0]).toHaveLength(2)
    expect(addTerminal.mock.calls[0][0]).not.toHaveProperty('agentAccountId')
    expect(typed()).toEqual(['\r', 'claude\r'])
  })
})

describe('launchAgentProfile when the account it would go on is out of usage', () => {
  const NOW = Date.now()
  const row = (over: Record<string, unknown>) => ({
    id: 'acc_a', agent: 'claude', label: 'personal', profile: null, folder: '/h/.claude', isDefault: true, autoOffer: true, order: 0, connect: true,
    origin: 'adopted', folderExists: true, shares: [], lastEmail: 'a@example.test', connection: null, bypassReady: true, terminals: 0, recopyAvailable: false, ...over,
  })
  const view = (accounts: unknown[]) => ({ accounts, preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [], advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h' })
  const OUT = { seenAt: NOW - 1000, resetsAt: NOW + 3_600_000, text: "You've hit your session limit", scope: 'account' }

  beforeEach(() => {
    accounts.launchAccount.mockImplementation(async (_agent: string, requested: string | null) => ({ success: true, data: { accountId: requested ?? 'acc_a' } }))
    useTerminalStore.setState({
      accountsView: view([row({ limit: OUT }), row({ id: 'acc_b', label: 'codedev', profile: '/h/.claude-b', folder: '/h/.claude-b', isDefault: false, order: 1, lastEmail: 'b@example.test' })]) as never,
      launchAsk: null,
    })
  })
  afterEach(() => useTerminalStore.setState({ accountsView: null, launchAsk: null }))

  async function answered(choice: { kind: 'on'; accountId: string } | { kind: 'anyway' } | { kind: 'cancel' }): Promise<void> {
    const launching = launchAgentProfile(claude, { availableShells: shells, addTerminal, setLaunchingAgent })
    await vi.waitFor(() => expect(useTerminalStore.getState().launchAsk).not.toBeNull())
    answerLaunchAsk(choice)
    await launching
  }

  it('asks first, and launches on the account the user picks', async () => {
    await answered({ kind: 'on', accountId: 'acc_b' })
    expect(addTerminal.mock.calls[0][0]).toMatchObject({ agentAccountId: 'acc_b' })
    expect(api().createTerminal.mock.calls[0].slice(5)).toEqual(['acc_b', 'claude'])
  })

  it('launches on the account that is out of usage when the user says anyway', async () => {
    await answered({ kind: 'anyway' })
    expect(addTerminal.mock.calls[0][0]).toMatchObject({ agentAccountId: 'acc_a' })
  })

  it('makes no terminal at all when the user cancels, and clears the launching mark', async () => {
    await answered({ kind: 'cancel' })
    expect(api().createTerminal).not.toHaveBeenCalled()
    expect(addTerminal).not.toHaveBeenCalled()
    expect(setLaunchingAgent.mock.calls.map((c) => c[0])).toEqual(['Claude Code', null])
  })

  it('asks nothing when the account is one the user picked (Launch on ▸)', async () => {
    await launchAgentProfile(claude, { availableShells: shells, addTerminal, setLaunchingAgent, accountId: 'acc_a' })
    expect(useTerminalStore.getState().launchAsk).toBeNull()
    expect(addTerminal.mock.calls[0][0]).toMatchObject({ agentAccountId: 'acc_a' })
  })
})
