// The swarm restart offer (src/renderer/src/lib/swarmRestart.ts, §9 with R4, R7, R16): which
// accounts a worker that ran out of usage can be restarted on, what the conductor is told at each
// step and in which words, the clock that reassigns an unanswered offer, and the restart itself,
// through the switch main runs (accounts:switch), faked here at the bridge. The store is the app's
// own.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  LOCK_RECHECK_MS, RESTART_WAIT_MS, _resetSwarmRestartForTest, clearSwarmRestarts, closedBeforeMessage, declineRestart, failureText, freshMessage, installSwarmRestart,
  noteConductorClosed, noteWorkerSwitched, offerConductorRun, offerRestart, offerTitle, offeredMessage, pruneSwarmRestarts, restartOn, restartTargets, restartedMessage,
  signInTargets, signInThenRestart, withdrawFromOffer, withdrawnMessage, workerBlocker,
} from '../../src/renderer/src/lib/swarmRestart'
import type { RestartDeps, SwarmRestartGroup } from '../../src/renderer/src/lib/swarmRestart'
import { _resetLimitWatchForTest, noteSwarmStop } from '../../src/renderer/src/lib/limitWatch'
import { _resetStopReportsForTest, carryWorkerStop, isStopCarried, noteWorkerStatus, setSwarmWorkingAgain } from '../../src/renderer/src/lib/swarmStopReports'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import type { AccountRowView, AccountsView } from '../../src/shared/agentAccounts'
import type { SwitchOutcome } from '../../src/shared/accountSwitch'
import type { TerminalSession } from '../../src/renderer/src/types'

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0)
const LIMIT = { status: 'blocked' as const, summary: 'usage limit reached (resets 3pm)' }
const WORDS = "You've hit your session limit · resets 3pm"

function row(over: Partial<AccountRowView>): AccountRowView {
  return {
    id: 'acc_m', agent: 'claude', label: 'personal', profile: null, folder: '/h/.claude', isDefault: true, autoOffer: true, order: 0,
    connect: true, origin: 'adopted', folderExists: true, shares: [], lastEmail: 'a@example.test',
    connection: { server: true, hook: true, allow: true }, bypassReady: true, terminals: 0, recopyAvailable: false, ...over,
  }
}
const MAIN = row({})
const CODEDEV = row({ id: 'acc_c', label: 'codedev', profile: '/h/.claude-codedev', isDefault: false, order: 1, lastEmail: 'c@example.test' })
const WORK = row({ id: 'acc_w', label: 'work', profile: '/h/.claude-work', isDefault: false, order: 2, autoOffer: false, lastEmail: 'w@example.test' })
const view = (accounts: AccountRowView[], over: Partial<AccountsView> = {}): AccountsView => ({
  accounts, preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [],
  advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h', ...over,
})

function worker(id: string, over: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id, name: `Claude (${id})`, color: '', shellType: 'powershell', cwd: '/repo', fontSize: 13, theme: 'dark', fontFamily: 'mono',
    isSwarm: true, hidden: true, swarmAgent: 'claude', agentAccountId: 'acc_m', ...over,
  }
}
const W1 = { terminalId: 'w1', agentName: 'Claude', role: 'Build UI' }
const W2 = { terminalId: 'w2', agentName: 'Claude', role: 'Tests' }

let deps: RestartDeps
let outcomes: SwitchOutcome[]
let tasks: Array<{ id: string; title?: string; assignedTo: string; status: string }>

function makeDeps(over: Partial<RestartDeps> = {}): RestartDeps {
  return {
    store: useTerminalStore.getState,
    swarm: {
      getTasks: vi.fn(async () => ({ success: true, data: tasks as never })),
      sendMessage: vi.fn(async () => ({ success: true }) as never),
    },
    accounts: {
      switchAccount: vi.fn(async () => ({ success: true as const, data: outcomes.shift() ?? { kind: 'switched' as const, resumed: true } })),
      check: vi.fn(async (id: string) => ({ success: true as const, data: { ...MAIN, id, identity: { email: `${id}@example.test`, signedIn: true, checkedAt: NOW, source: 'auth-status' as const } } })),
      noteLimit: vi.fn(async () => ({ success: true as const, data: undefined })),
      // Main's own view: the renderer's copy as it stands, unless a test says main knows more.
      list: vi.fn(async () => ({ success: true as const, data: useTerminalStore.getState().accountsView as AccountsView })),
      limitLook: vi.fn(async () => ({ success: true as const, data: { turned: false } as never })),
    },
    termpolis: { claudeTrustWorkspace: vi.fn(async () => ({ success: true })) as never, memoryPrepareCodexContext: vi.fn(async () => ({ success: true, data: null })) as never },
    primerEnabled: () => false,
    now: () => NOW,
    newId: () => `g${useTerminalStore.getState().swarmRestarts.length + 1}`,
    focused: () => true,
    notify: vi.fn(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    ...over,
  }
}

const messages = (): string[] => (deps.swarm.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[3] as string)
const groups = (): SwarmRestartGroup[] => useTerminalStore.getState().swarmRestarts
/** v1.54.0's report of a worker's limit, word for word, with its task when one is assigned to it. */
const reassignOf = (w: typeof W1, task?: { id: string; title: string }): string =>
  `${w.agentName} (${w.role}, terminal ${w.terminalId}) is blocked: ${LIMIT.summary}.${task ? ` Its task is "${task.title}" (taskId ${task.id}).` : ''} ` +
  'Check its screen with read_output first: if the limit is there, close its terminal, then give its task to another installed agent.'
const TASK1 = { id: 'task-1', title: 'Build it' }

beforeEach(() => {
  vi.useFakeTimers()
  _resetSwarmRestartForTest()
  _resetLimitWatchForTest()
  _resetStopReportsForTest()
  outcomes = []
  tasks = []
  ;(window as any).swarmAPI = { getTasks: vi.fn(async () => ({ success: true, data: tasks })), sendMessage: vi.fn(async () => ({ success: true })) }
  useTerminalStore.setState({ terminals: [worker('w1'), worker('w2')], accountsView: view([MAIN, CODEDEV, WORK]), accountsByHand: {}, relaunching: {}, swarmRestarts: [] })
  deps = makeDeps()
  // The reports go to the bus the store's swarm loop uses: the same one.
  ;(window as any).swarmAPI = deps.swarm
})

afterEach(() => {
  vi.useRealTimers()
  useTerminalStore.setState({ terminals: [], accountsView: null, accountsByHand: {}, relaunching: {}, swarmRestarts: [] })
  delete (window as any).swarmAPI
})

describe('workerBlocker: who can take a swarm worker over (rule 8, R16)', () => {
  it('needs the account connected, its profile holding Termpolis\'s server, with Agent Integration on', () => {
    const v = view([])
    expect(workerBlocker(MAIN, v)).toBeNull()
    expect(workerBlocker(CODEDEV, v)).toBeNull()
    expect(workerBlocker(MAIN, view([], { integrationConnected: false }))).toBe('not-connected')
    expect(workerBlocker({ ...CODEDEV, connect: false }, v)).toBe('not-connected')
    expect(workerBlocker({ ...CODEDEV, connection: null }, v)).toBe('not-connected')
    expect(workerBlocker({ ...CODEDEV, connection: { server: false, hook: true, allow: true } }, v)).toBe('not-connected')
    // The default profile is connected through Agent Integration itself.
    expect(workerBlocker({ ...MAIN, connect: false }, v)).toBeNull()
  })

  it('needs Claude Code to skip its bypass-permissions warning there; Codex has none', () => {
    expect(workerBlocker({ ...CODEDEV, bypassReady: false }, view([]))).toBe('bypass')
    expect(workerBlocker({ ...CODEDEV, agent: 'codex', bypassReady: false }, view([]))).toBeNull()
  })
})

describe('signInTargets: the accounts a worker could be restarted on once signed in (UI addendum 2.3)', () => {
  const session = { scope: 'account' as const, window: 'session' as const }
  const limited = { accountId: 'acc_m', email: 'a@example.test' }
  const out = { acc_c: { kind: 'signed-out' as const } }

  it('names the accounts the sign-in check found signed out, and no signed-in one', () => {
    expect(signInTargets(view([MAIN, CODEDEV, WORK]), 'claude', limited, NOW, out, session).map((t) => t.row.id)).toEqual(['acc_c'])
    expect(signInTargets(view([MAIN, CODEDEV, WORK]), 'claude', limited, NOW, { acc_c: { kind: 'signed-in', email: 'c@example.test' } }, session)).toEqual([])
    expect(signInTargets(view([MAIN, CODEDEV, WORK]), 'claude', limited, NOW, {}, session)).toEqual([])
  })

  it('leaves out one a worker could not run on once signed in: not connected, no bypass ready, or the work account', () => {
    expect(signInTargets(view([MAIN, { ...CODEDEV, connect: false }]), 'claude', limited, NOW, out, session)).toEqual([])
    expect(signInTargets(view([MAIN, { ...CODEDEV, bypassReady: false }]), 'claude', limited, NOW, out, session)).toEqual([])
    expect(signInTargets(view([MAIN, { ...WORK, id: 'acc_c' }]), 'claude', limited, NOW, out, session)).toEqual([])
  })

  it('leaves out one that is out of usage on the very model the worker hit', () => {
    const modelOut = { ...CODEDEV, limit: { seenAt: NOW - 1000, resetsAt: NOW + 3_600_000, text: "You've hit your Opus limit", scope: 'model' as const, model: 'Opus' } }
    const onOpus = { scope: 'model' as const, window: 'weekly' as const, model: 'Opus' }
    expect(signInTargets(view([MAIN, modelOut]), 'claude', limited, NOW, out, onOpus)).toEqual([])
    expect(signInTargets(view([MAIN, modelOut]), 'claude', limited, NOW, out, session).map((t) => t.row.id)).toEqual(['acc_c'])
  })
})

describe('restartTargets', () => {
  const session = { scope: 'account' as const, window: 'session' as const }

  it('offers the chooser\'s ways out that can take a worker over, never the work account (D14)', () => {
    const t = restartTargets(view([MAIN, CODEDEV, WORK]), 'claude', { accountId: 'acc_m', email: 'a@example.test' }, NOW, {}, session)
    expect(t.map((x) => x.row.id)).toEqual(['acc_c'])
    const blocked = restartTargets(view([MAIN, { ...CODEDEV, bypassReady: false }]), 'claude', { accountId: 'acc_m', email: 'a@example.test' }, NOW, {}, session)
    expect(blocked).toEqual([])
    const signedOut = restartTargets(view([MAIN, CODEDEV]), 'claude', { accountId: 'acc_m', email: 'a@example.test' }, NOW, { acc_c: { kind: 'signed-out' } }, session)
    expect(signedOut).toEqual([])
    // R23: the same sign-in is no way out.
    const same = restartTargets(view([MAIN, { ...CODEDEV, lastEmail: 'a@example.test' }]), 'claude', { accountId: 'acc_m', email: 'a@example.test' }, NOW, {}, session)
    expect(same).toEqual([])
  })

  it('skips an account out of usage on the very model the worker ran out on (R15), not on another', () => {
    const opus = { scope: 'model' as const, window: 'weekly' as const, model: 'Opus' }
    const limit = (text: string) => ({ seenAt: NOW, resetsAt: NOW + 3_600_000, text, scope: 'model' as const })
    const on = (text: string) => restartTargets(view([MAIN, { ...CODEDEV, limit: limit(text) }]), 'claude', { accountId: 'acc_m', email: 'a@example.test' }, NOW, {}, opus)
    expect(on("You've hit your Opus limit")).toEqual([])
    expect(on("You've hit your Sonnet limit").map((x) => x.row.id)).toEqual(['acc_c'])
    expect(restartTargets(view([MAIN, { ...CODEDEV, limit: limit("You've hit your Opus limit") }]), 'claude', { accountId: 'acc_m', email: 'a@example.test' }, NOW, {}, session).map((x) => x.row.id)).toEqual(['acc_c'])
  })
})

describe('what the conductor is told (§9, R16)', () => {
  it('says each step in the design\'s words', () => {
    expect(offeredMessage(W1, LIMIT.summary)).toBe(
      'Claude (Build UI, terminal w1) is blocked: usage limit reached (resets 3pm). Termpolis is offering to restart it on another Claude account, ' +
        'where it keeps its conversation and its task. Don\'t close it or give its task to another agent yet: system will post again.',
    )
    expect(restartedMessage(W1)).toBe(
      'Claude (Build UI, terminal w1) was restarted on another account and resumed its conversation. It is waiting at its prompt: ' +
        'send it \'Continue your task.\' with submit=true (STEP 5).',
    )
    expect(freshMessage(W1)).toBe(
      'Claude (Build UI, terminal w1) restarted on another account without its conversation. Send it its task again with submit=true and the same taskId (STEP 5).',
    )
  })

  it('titles an offer for one worker or several', () => {
    const v = view([MAIN])
    expect(offerTitle({ accountId: 'acc_m', workers: [{ ...W1, summary: '' }] }, v)).toBe('Claude (Build UI), a swarm worker, ran out of usage on personal.')
    expect(offerTitle({ accountId: 'acc_m', workers: [{ ...W1, summary: '' }, { ...W2, summary: '' }] }, v)).toBe("2 of the swarm's workers ran out of usage on personal.")
    expect(offerTitle({ accountId: 'acc_gone', workers: [{ ...W1, summary: '' }, { ...W2, summary: '' }] }, null)).toBe("2 of the swarm's workers ran out of usage.")
  })
})

describe('offerRestart: when it takes a worker\'s limit over', () => {
  it('offers the restart, tells the conductor to wait, and records the limit with the sign-in it hit (R23)', async () => {
    tasks = [{ id: 'task-1', assignedTo: 'w1', status: 'in_progress' }, { id: 'task-0', assignedTo: 'w1', status: 'completed' }]
    expect(await offerRestart(W1, LIMIT, () => WORDS, deps)).toBe(true)
    expect(groups()).toEqual([{
      id: 'g1', agent: 'claude', accountId: 'acc_m', words: WORDS, resetsAt: expect.any(Number),
      workers: [{ ...W1, summary: LIMIT.summary, taskId: 'task-1' }], targets: ['acc_c'], phase: { kind: 'offered' },
    }])
    expect(messages()).toEqual([offeredMessage(W1, LIMIT.summary)])
    expect(deps.accounts.noteLimit).toHaveBeenCalledWith('acc_m', { text: WORDS, resetsAt: groups()[0].resetsAt, scope: 'account', window: 'session', email: 'a@example.test' })
    // Asked once whether codedev is signed in now: no other account is a way out to ask about.
    expect(deps.accounts.check).toHaveBeenCalledTimes(1)
    expect(deps.accounts.check).toHaveBeenCalledWith('acc_c')
    expect(deps.notify).not.toHaveBeenCalled()
  })

  it('reuses a sign-in answer under a minute old, says the detector\'s summary when it has no words, and notifies an unfocused window', async () => {
    useTerminalStore.setState({ accountsView: view([MAIN, { ...CODEDEV, identity: { email: 'c@example.test', signedIn: true, checkedAt: NOW - 1000, source: 'auth-status' } }]) })
    deps = makeDeps({ focused: () => false })
    ;(window as any).swarmAPI = deps.swarm
    expect(await offerRestart(W1, LIMIT, undefined, deps)).toBe(true)
    expect(deps.accounts.check).not.toHaveBeenCalled()
    expect(groups()[0].words).toBe(LIMIT.summary)
    expect(deps.notify).toHaveBeenCalledWith('Claude Code ran out of usage in the swarm', 'Claude (Build UI), a swarm worker, ran out of usage on personal.', expect.any(Function))
    ;(deps.notify as ReturnType<typeof vi.fn>).mock.calls[0][2]()
  })

  it.each([
    ['no accounts view', { accountsView: null }],
    ['a worker the store has no terminal for', { terminals: [] }],
    ['the conductor\'s terminal', { terminals: [worker('w1', { isConductor: true })] }],
    ['a worker whose agent main never recorded', { terminals: [worker('w1', { swarmAgent: undefined })] }],
    ['an Antigravity CLI worker: its one sign-in is every agy terminal\'s', { terminals: [worker('w1', { swarmAgent: 'agy' })] }],
    ['a worker on no account Termpolis knows', { terminals: [worker('w1', { agentAccountId: undefined })] }],
    ['a worker whose account a line typed there changed', { accountsByHand: { w1: true as const } }],
    ['a worker on an account no longer registered', { terminals: [worker('w1', { agentAccountId: 'acc_gone' })] }],
    ['a worker on another agent\'s account', { terminals: [worker('w1', { swarmAgent: 'codex' })] }],
  ])('leaves %s to v1.54.0\'s report', async (_name, state) => {
    useTerminalStore.setState(state as never)
    expect(await offerRestart(W1, LIMIT, () => WORDS, deps)).toBe(false)
    expect(groups()).toEqual([])
    expect(messages()).toEqual([])
  })

  it('leaves it to v1.54.0\'s report when no other account is a way out, before asking anything (D13)', async () => {
    useTerminalStore.setState({ accountsView: view([MAIN, WORK]) })
    expect(await offerRestart(W1, LIMIT, () => WORDS, deps)).toBe(false)
    expect(deps.accounts.check).not.toHaveBeenCalled()
    // The limit is the account's all the same.
    expect(deps.accounts.noteLimit).toHaveBeenCalledTimes(1)
    expect(messages()).toEqual([])
  })

  it('offers the sign-in when the only way out turns out signed out, and survives a record that fails', async () => {
    deps = makeDeps()
    ;(deps.accounts.check as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, data: { ...CODEDEV, identity: { email: null, signedIn: false, checkedAt: NOW, source: 'auth-status' } } })
    ;(deps.accounts.noteLimit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('registry locked'))
    expect(await offerRestart(W1, LIMIT, () => WORDS, deps)).toBe(true)
    expect(groups()[0]).toMatchObject({ targets: [], signIn: ['acc_c'] })
  })

  it('leaves it to the report when the only account signed out could not take the worker over once signed in', async () => {
    deps = makeDeps()
    useTerminalStore.setState({ accountsView: view([MAIN, { ...CODEDEV, connect: false }, WORK]) })
    ;(deps.accounts.check as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, data: { ...CODEDEV, identity: { email: null, signedIn: false, checkedAt: NOW, source: 'auth-status' } } })
    expect(await offerRestart(W1, LIMIT, () => WORDS, deps)).toBe(false)
    expect(groups()).toEqual([])
  })

  it('puts a second worker that runs out on the same account into the offer open for it', async () => {
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    tasks = [{ id: 'task-2', assignedTo: 'w2', status: 'pending' }]
    expect(await offerRestart(W2, LIMIT, () => WORDS, deps)).toBe(true)
    expect(groups()).toHaveLength(1)
    expect(groups()[0].workers.map((w) => [w.terminalId, w.taskId])).toEqual([['w1', undefined], ['w2', 'task-2']])
    expect(messages()).toEqual([offeredMessage(W1, LIMIT.summary), offeredMessage(W2, LIMIT.summary)])
    // The same worker again: nothing more.
    expect(await offerRestart(W2, LIMIT, () => WORDS, deps)).toBe(true)
    expect(messages()).toHaveLength(2)
  })

  it('makes one offer of two workers that run out on the same account at the same moment', async () => {
    const [a, b] = await Promise.all([offerRestart(W1, LIMIT, () => WORDS, deps), offerRestart(W2, LIMIT, () => WORDS, deps)])
    expect([a, b]).toEqual([true, true])
    expect(groups()).toHaveLength(1)
    expect(groups()[0].workers.map((w) => w.terminalId).sort()).toEqual(['w1', 'w2'])
  })

  it('keeps a worker with no task it can name: the bus\'s task list failing names none', async () => {
    ;(deps.swarm.getTasks as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('bus down'))
    expect(await offerRestart(W1, LIMIT, () => WORDS, deps)).toBe(true)
    expect(groups()[0].workers[0].taskId).toBeUndefined()
  })

  it('opens a new offer for a stop on an account whose offer is already being answered', async () => {
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    useTerminalStore.getState().putSwarmRestart({ ...groups()[0], phase: { kind: 'restarting', targetId: 'acc_c' } })
    expect(await offerRestart(W2, LIMIT, () => WORDS, deps)).toBe(true)
    expect(groups().map((g) => g.workers.map((w) => w.terminalId))).toEqual([['w1'], ['w2']])
  })

  it('leaves a worker to the report when the offer it was joining went while its task was looked up', async () => {
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    ;(deps.swarm.getTasks as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      useTerminalStore.setState({ swarmRestarts: [] })
      return { success: true, data: [] }
    })
    expect(await offerRestart(W2, LIMIT, () => WORDS, deps)).toBe(false)
    expect(groups()).toEqual([])
  })

  it('records a limit with no reset time, and no sign-in for a profile that names none', async () => {
    useTerminalStore.setState({ accountsView: view([{ ...MAIN, lastEmail: null }, CODEDEV]) })
    expect(await offerRestart(W1, { status: 'blocked', summary: 'usage limit reached' }, () => WORDS, deps)).toBe(true)
    expect(deps.accounts.noteLimit).toHaveBeenCalledWith('acc_m', { text: WORDS, resetsAt: null, scope: 'account', window: 'session' })
    expect(groups()[0].resetsAt).toBeNull()
  })

  it('survives a message that can\'t be posted', async () => {
    ;(deps.swarm.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('bus down'))
    expect(await offerRestart(W1, LIMIT, () => WORDS, deps)).toBe(true)
  })
})

describe('the clock (R16)', () => {
  it('reassigns a worker nobody answered for in five minutes, as v1.54.0 does, and takes it off the offer', async () => {
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    await offerRestart(W2, LIMIT, () => WORDS, deps)
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS - 1)
    expect(messages()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(messages()[2]).toBe(reassignOf(W1))
    expect(messages()[3]).toBe(reassignOf(W2))
    expect(groups()).toEqual([])
  })

  it('keeps the rest of the offer for a worker that joined later', async () => {
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    await vi.advanceTimersByTimeAsync(60_000)
    await offerRestart(W2, LIMIT, () => WORDS, deps)
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS - 60_000)
    expect(messages()).toEqual([offeredMessage(W1, LIMIT.summary), offeredMessage(W2, LIMIT.summary), reassignOf(W1)])
    expect(groups()[0].workers.map((w) => w.terminalId)).toEqual(['w2'])
  })

  it('never tells the conductor to reassign while a relaunch holds the worker: it looks again', async () => {
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    useTerminalStore.setState({ relaunching: { w1: 'account' } })
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS + LOCK_RECHECK_MS * 3)
    expect(messages()).toHaveLength(1)
    useTerminalStore.setState({ relaunching: {} })
    await vi.advanceTimersByTimeAsync(LOCK_RECHECK_MS)
    expect(messages()[1]).toBe(reassignOf(W1))
  })

  it("stops the moment the user acts, and an unanswered question runs a clock of its own", async () => {
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    useTerminalStore.setState({ accountsView: view([{ ...MAIN, autoOffer: false }, CODEDEV]) })
    // The first click counts, though the restart then asks once more (R17).
    await restartOn('g1', 'acc_c', deps)
    expect(groups()[0].phase.kind).toBe('confirm')
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS - 1000)
    expect(messages()).toHaveLength(1)
    // An unanswered question ends like an unanswered offer: the conductor is told as v1.54.0 told it.
    await vi.advanceTimersByTimeAsync(2000)
    expect(messages()[1]).toBe(reassignOf(W1))
    expect(groups()).toEqual([])
  })

  it("lets a question that is answered in time go on without the clock", async () => {
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    useTerminalStore.setState({ accountsView: view([{ ...MAIN, autoOffer: false }, CODEDEV]) })
    await restartOn('g1', 'acc_c', deps)
    await restartOn('g1', 'acc_c', deps, true)
    expect(deps.accounts.switchAccount).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS * 2)
    expect(messages().filter((m) => m === reassignOf(W1))).toHaveLength(0)
  })

  it('lets go of each worker\'s timer at the user\'s first click, and when it declines', async () => {
    const clearTimer = vi.fn((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
    deps = makeDeps({ clearTimer })
    ;(window as any).swarmAPI = deps.swarm
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    await offerRestart(W2, LIMIT, () => WORDS, deps)
    await restartOn('g1', 'acc_c', deps)
    expect(clearTimer).toHaveBeenCalledTimes(2)
    useTerminalStore.setState({ swarmRestarts: [] })
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    await declineRestart(groups()[0].id, deps)
    expect(clearTimer).toHaveBeenCalledTimes(3)
  })

  it('does nothing for an offer that is gone', async () => {
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    useTerminalStore.setState({ swarmRestarts: [] })
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS)
    expect(messages()).toHaveLength(1)
  })
})

describe('declineRestart', () => {
  it('reassigns every worker of the offer as v1.54.0 does, and takes the offer down', async () => {
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    await offerRestart(W2, LIMIT, () => WORDS, deps)
    await declineRestart('g1', deps)
    expect(messages().slice(2)).toEqual([reassignOf(W1), reassignOf(W2)])
    expect(groups()).toEqual([])
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS)
    expect(messages()).toHaveLength(4)
  })

  it('takes down an offer that is done, telling nothing more, and ignores one that is gone', async () => {
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    useTerminalStore.getState().putSwarmRestart({ ...groups()[0], phase: { kind: 'done', lines: [] } })
    await declineRestart('g1', deps)
    expect(groups()).toEqual([])
    await declineRestart('g1', deps)
    expect(messages()).toHaveLength(1)
  })
})

describe('restartOn: the restart', () => {
  async function offered(): Promise<void> {
    tasks = [{ ...TASK1, assignedTo: 'w1', status: 'in_progress' }]
    await offerRestart(W1, LIMIT, () => WORDS, deps)
  }

  it('restarts the worker in place on the account picked, trusting its folder there first, and tells the conductor to continue it', async () => {
    await offered()
    await restartOn('g1', 'acc_c', deps)
    expect(deps.termpolis.claudeTrustWorkspace).toHaveBeenCalledWith('/repo', 'acc_c')
    expect(deps.accounts.switchAccount).toHaveBeenCalledWith({ terminalId: 'w1', targetId: 'acc_c', shellType: 'powershell', reason: 'usage limit, swarm worker' })
    expect(messages()[1]).toBe(restartedMessage(W1))
    expect(groups()[0].phase).toEqual({ kind: 'done', lines: ['Claude (Build UI): on codedev, its conversation resumed.'] })
    // The relaunch lock was held while it ran, and let go.
    expect(useTerminalStore.getState().relaunching).toEqual({})
  })

  it('holds the relaunch lock in the store while main switches', async () => {
    await offered()
    let held: unknown = null
    ;(deps.accounts.switchAccount as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      held = useTerminalStore.getState().relaunching.w1
      return { success: true, data: { kind: 'switched', resumed: true } }
    })
    await restartOn('g1', 'acc_c', deps)
    expect(held).toBe('account')
  })

  it('carries the worker\'s stop (R4): the resumed session\'s old limit tells the conductor nothing, until it took a turn', async () => {
    await offered()
    // The swarm loop had noted the stop already, which is what asked for the offer.
    await noteWorkerStatus(W1, LIMIT, () => true)
    await restartOn('g1', 'acc_c', deps)
    const sent = messages().length
    await noteWorkerStatus(W1, LIMIT)
    expect(messages()).toHaveLength(sent)
    ;(deps.accounts.limitLook as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, data: { turned: true } })
    await noteWorkerStatus(W1, LIMIT)
    expect(messages()[sent]).toBe(reassignOf(W1, TASK1))
  })

  it('reads no turn from a look that fails', async () => {
    await offered()
    await noteWorkerStatus(W1, LIMIT, () => true)
    await restartOn('g1', 'acc_c', deps)
    const sent = messages().length
    ;(deps.accounts.limitLook as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false, error: 'gone' })
    await noteWorkerStatus(W1, LIMIT)
    ;(deps.accounts.limitLook as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ipc down'))
    await noteWorkerStatus(W1, LIMIT)
    expect(messages()).toHaveLength(sent)
  })

  it('tells the conductor to send the task again when the worker restarted without its conversation (Codex\'s path (c))', async () => {
    await offered()
    outcomes = [{ kind: 'fresh', why: 'not-found' }]
    await restartOn('g1', 'acc_c', deps)
    expect(messages()[1]).toBe(freshMessage(W1))
    expect(groups()[0].phase).toEqual({ kind: 'done', lines: ['Claude (Build UI): on codedev, with a new session: the conductor sends its task again.'] })
  })

  it('starts a new session in place when the target can\'t see the conversation', async () => {
    await offered()
    outcomes = [{ kind: 'resume-not-found' }, { kind: 'fresh', why: 'asked' }]
    await restartOn('g1', 'acc_c', deps)
    expect((deps.accounts.switchAccount as ReturnType<typeof vi.fn>).mock.calls[1][0]).toMatchObject({ terminalId: 'w1', targetId: 'acc_c', assumeExited: true, fresh: true })
    expect(messages()[1]).toBe(freshMessage(W1))
  })

  it.each([
    [{ kind: 'busy' } as SwitchOutcome, 'Claude Code was working, so Termpolis typed nothing and left it as it was.'],
    [{ kind: 'agent-alive' } as SwitchOutcome, 'Claude Code didn\'t exit'],
    [{ kind: 'asks-user', what: 'Bypass Permissions mode' } as SwitchOutcome, 'codedev is asking something only a person can answer'],
    [{ kind: 'refused', why: 'a switch is already running in this terminal' } as SwitchOutcome, 'Termpolis didn\'t switch: a switch is already running in this terminal.'],
  ])('reassigns a worker whose restart failed (%o), saying why', async (outcome, words) => {
    await offered()
    outcomes = [outcome]
    await restartOn('g1', 'acc_c', deps)
    expect(messages()[1]).toBe(reassignOf(W1, TASK1))
    const done = groups()[0].phase as { kind: 'done'; lines: string[] }
    expect(done.lines[0]).toContain(words)
    expect(done.lines[0]).toMatch(/The conductor reassigns its task\.$/)
  })

  it('refuses once the conductor closed the worker, typing nothing and telling it nothing', async () => {
    await offered()
    noteConductorClosed('w1')
    useTerminalStore.setState({ terminals: [] })
    await restartOn('g1', 'acc_c', deps)
    expect(deps.accounts.switchAccount).not.toHaveBeenCalled()
    expect(messages()).toHaveLength(1)
    expect(groups()[0].phase).toEqual({ kind: 'done', lines: ['Claude (Build UI): the conductor closed it, so it wasn\'t restarted.'] })
  })

  it('refuses once the worker\'s task went to another agent, or is gone', async () => {
    await offered()
    tasks = [{ id: 'task-1', assignedTo: 'w9', status: 'in_progress' }]
    await restartOn('g1', 'acc_c', deps)
    expect(deps.accounts.switchAccount).not.toHaveBeenCalled()
    expect(groups()[0].phase).toEqual({ kind: 'done', lines: ['Claude (Build UI): its task went to another agent, so it wasn\'t restarted.'] })
    useTerminalStore.setState({ swarmRestarts: [] })
    _resetSwarmRestartForTest()
    tasks = [{ id: 'task-1', assignedTo: 'w1', status: 'in_progress' }]
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    tasks = []
    await restartOn(groups()[0].id, 'acc_c', deps)
    expect(deps.accounts.switchAccount).not.toHaveBeenCalled()
  })

  it('restarts all the same when the task list can\'t be read', async () => {
    await offered()
    ;(deps.swarm.getTasks as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('bus down'))
    await restartOn('g1', 'acc_c', deps)
    expect(deps.accounts.switchAccount).toHaveBeenCalled()
    ;(deps.swarm.getTasks as ReturnType<typeof vi.fn>).mockResolvedValue({ success: false, error: 'x' })
    useTerminalStore.setState({ swarmRestarts: [] })
    await offerRestart(W2, LIMIT, () => WORDS, deps)
    useTerminalStore.getState().putSwarmRestart({ ...groups()[0], workers: [{ ...groups()[0].workers[0], taskId: 'task-2' }] })
    await restartOn(groups()[0].id, 'acc_c', deps)
    expect(deps.accounts.switchAccount).toHaveBeenCalledTimes(2)
  })

  it("reassigns when the account picked isn't registered any more", async () => {
    await offered()
    await restartOn('g1', 'acc_gone', deps)
    expect(messages()[1]).toBe(reassignOf(W1, TASK1))
    expect((groups()[0].phase as { lines: string[] }).lines[0]).toBe("Claude (Build UI): that account isn't registered any more, so it wasn't restarted: the conductor reassigns its task.")
  })

  it("never tells the conductor to close a worker something else is relaunching (R16): it is offered again", async () => {
    useTerminalStore.setState({ swarmRestarts: [], relaunching: { w1: 'model' } })
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    await restartOn(groups()[0].id, 'acc_c', deps)
    expect(deps.accounts.switchAccount).not.toHaveBeenCalled()
    const all = groups()
    expect((all.find((g) => g.phase.kind === 'done')!.phase as { lines: string[] }).lines[0])
      .toBe("Claude (Build UI): something else is relaunching it, so it wasn't restarted. It is offered again once that is done.")
    const again = all.find((g) => g.phase.kind === 'offered')!
    expect(again.workers.map((w) => w.terminalId)).toEqual(['w1'])
    // Only the stop's own "wait" so far: no close.
    expect(messages()).toHaveLength(1)
    // The lock outlasts the clock: still no close ...
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS + LOCK_RECHECK_MS * 3)
    expect(messages()).toHaveLength(1)
    // ... and when it lets go, the conductor is told as v1.54.0 told it.
    useTerminalStore.setState({ relaunching: {} })
    await vi.advanceTimersByTimeAsync(LOCK_RECHECK_MS)
    expect(messages()[1]).toBe(reassignOf(W1))
  })

  it("does not close a worker something else relaunches when the user declines either (R16)", async () => {
    await offered()
    useTerminalStore.setState({ relaunching: { w1: 'account' } })
    await declineRestart('g1', deps)
    expect(messages()).toHaveLength(1)
    useTerminalStore.setState({ relaunching: {} })
    await vi.advanceTimersByTimeAsync(LOCK_RECHECK_MS)
    expect(messages()[1]).toBe(reassignOf(W1, TASK1))
  })

  it("does not tell the conductor to close a terminal that is gone: that it was closed, if the user closed it", async () => {
    await offered()
    useTerminalStore.setState({ terminals: useTerminalStore.getState().terminals.filter((t) => t.id !== 'w1') })
    await declineRestart('g1', deps)
    expect(messages().filter((m) => m.includes('close its terminal'))).toEqual([])
    expect(messages()).toHaveLength(2)
    expect(messages()[1]).toBe(closedBeforeMessage({ ...W1, taskId: 'task-1' }))
  })

  it("tells the conductor nothing of a terminal it closed itself", async () => {
    await offered()
    noteConductorClosed('w1')
    useTerminalStore.setState({ terminals: useTerminalStore.getState().terminals.filter((t) => t.id !== 'w1') })
    await declineRestart('g1', deps)
    expect(messages()).toHaveLength(1)
  })

  it('asks once more before carrying conversations off an account not offered automatically (R17)', async () => {
    useTerminalStore.setState({ accountsView: view([{ ...MAIN, autoOffer: false }, CODEDEV]) })
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    await restartOn('g1', 'acc_c', deps)
    expect(groups()[0].phase).toEqual({ kind: 'confirm', targetId: 'acc_c', question: 'personal isn\'t offered automatically. Carry this worker\'s conversation to codedev?' })
    expect(deps.accounts.switchAccount).not.toHaveBeenCalled()
    await restartOn('g1', 'acc_c', deps, true)
    expect(deps.accounts.switchAccount).toHaveBeenCalledTimes(1)
    // For several workers, it says so.
    useTerminalStore.setState({ swarmRestarts: [] })
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    await offerRestart(W2, LIMIT, () => WORDS, deps)
    await restartOn(groups()[0].id, 'acc_c', deps)
    expect((groups()[0].phase as { question: string }).question).toBe('personal isn\'t offered automatically. Carry these workers\' conversations to codedev?')
  })

  it('restarts every worker of the offer, each told apart', async () => {
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    await offerRestart(W2, LIMIT, () => WORDS, deps)
    outcomes = [{ kind: 'switched', resumed: true }, { kind: 'fresh', why: 'not-found' }]
    await restartOn('g1', 'acc_c', deps)
    expect(messages().slice(2).sort()).toEqual([freshMessage(W2), restartedMessage(W1)].sort())
  })

  it('does nothing for an offer that is gone or under way, and keeps nothing of one taken down meanwhile', async () => {
    await restartOn('nope', 'acc_c', deps)
    await offered()
    useTerminalStore.getState().putSwarmRestart({ ...groups()[0], phase: { kind: 'restarting', targetId: 'acc_c' } })
    await restartOn('g1', 'acc_c', deps)
    expect(deps.accounts.switchAccount).not.toHaveBeenCalled()
    useTerminalStore.getState().putSwarmRestart({ ...groups()[0], phase: { kind: 'offered' } })
    ;(deps.accounts.switchAccount as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      useTerminalStore.setState({ swarmRestarts: [] })
      return { success: true, data: { kind: 'switched', resumed: true } }
    })
    await restartOn('g1', 'acc_c', deps)
    expect(groups()).toEqual([])
  })
})

describe('installSwarmRestart', () => {
  it('is the offer the swarm\'s loop asks, until taken out', async () => {
    const off = installSwarmRestart(() => deps)
    await noteSwarmStop(W1, LIMIT, () => WORDS)
    expect(groups()).toHaveLength(1)
    expect(messages()).toEqual([offeredMessage(W1, LIMIT.summary)])
    off()
    await noteSwarmStop(W2, LIMIT)
    expect(messages()[1]).toBe(reassignOf(W2))
  })
})

// P2: the conductor's own limit ends its `claude -p`, which its run script reports.
describe('offerRestart: when the renderer\'s copy of the view is gone while the limit is recorded', () => {
  it('goes on with the view it started from: the offer is made all the same', async () => {
    ;(deps.accounts.noteLimit as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      useTerminalStore.setState({ accountsView: null })
      return { success: true as const, data: undefined }
    })
    ;(deps.accounts.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false as const, error: 'busy' })
    expect(await offerRestart(W1, LIMIT, () => WORDS, deps)).toBe(true)
    expect(groups()).toHaveLength(1)
    expect(groups()[0].accountId).toBe('acc_m')
  })
})

describe('offerConductorRun', () => {
  const SESSION_WORDS = "You've hit your session limit · resets 3pm (America/New_York)"

  it('offers to run the conductor again on a Claude Code account that is a way out and skips the bypass warning, recording its limit', async () => {
    useTerminalStore.setState({ accountsView: view([MAIN, { ...CODEDEV, connect: false, connection: null }, { ...WORK, autoOffer: true, id: 'acc_x', label: 'x', bypassReady: false, order: 3 }]) })
    expect(await offerConductorRun(SESSION_WORDS, 'acc_m', deps)).toBe(true)
    expect(groups()).toEqual([{
      id: 'g1', conductor: true, agent: 'claude', accountId: 'acc_m', words: SESSION_WORDS, resetsAt: expect.any(Number),
      workers: [], targets: ['acc_c'], phase: { kind: 'offered' },
    }])
    expect(deps.accounts.noteLimit).toHaveBeenCalledWith('acc_m', { text: SESSION_WORDS, resetsAt: groups()[0].resetsAt, scope: 'account', window: 'session', email: 'a@example.test' })
    // The conductor is told nothing: it is gone.
    expect(messages()).toEqual([])
    expect(offerTitle(groups()[0], view([MAIN]))).toBe('The swarm\'s conductor ran out of usage on personal.')
  })

  it('notifies an unfocused window, and reads no reset where the words give none', async () => {
    deps = makeDeps({ focused: () => false })
    expect(await offerConductorRun("You've reached your Fable limit.", 'acc_m', deps)).toBe(true)
    expect(groups()[0].resetsAt).toBeNull()
    expect(deps.notify).toHaveBeenCalledWith('The swarm\'s conductor ran out of usage', 'The swarm\'s conductor ran out of usage on personal.', expect.any(Function))
    ;(deps.notify as ReturnType<typeof vi.fn>).mock.calls[0][2]()
  })

  it.each([
    ['no account it ran on', null, view([MAIN, CODEDEV])],
    ['an account no longer registered', 'acc_gone', view([MAIN, CODEDEV])],
    ['no accounts view', 'acc_m', null],
  ])('offers nothing for %s', async (_name, accountId, v) => {
    useTerminalStore.setState({ accountsView: v })
    expect(await offerConductorRun(SESSION_WORDS, accountId, deps)).toBe(false)
    expect(deps.accounts.noteLimit).not.toHaveBeenCalled()
  })

  it('offers nothing, as v1.54.0, when no other account is a way out, even signed in; the limit is recorded', async () => {
    useTerminalStore.setState({ accountsView: view([{ ...MAIN, lastEmail: null }, { ...CODEDEV, bypassReady: false }]) })
    expect(await offerConductorRun(SESSION_WORDS, 'acc_m', deps)).toBe(false)
    expect(deps.accounts.noteLimit).toHaveBeenCalledWith('acc_m', expect.not.objectContaining({ email: expect.anything() }))
    expect(groups()).toEqual([])
  })

  it('offers the sign-in when the only way out turns out signed out, and survives a record that fails', async () => {
    useTerminalStore.setState({ accountsView: view([MAIN, CODEDEV]) })
    ;(deps.accounts.check as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, data: { ...CODEDEV, identity: { email: null, signedIn: false, checkedAt: NOW, source: 'auth-status' } } })
    ;(deps.accounts.noteLimit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('locked'))
    expect(await offerConductorRun(SESSION_WORDS, 'acc_m', deps)).toBe(true)
    expect(groups()[0]).toMatchObject({ conductor: true, targets: [], signIn: ['acc_c'] })
  })

  it('skips an account out of usage on the very model the conductor ran out on', async () => {
    useTerminalStore.setState({ accountsView: view([MAIN, { ...CODEDEV, limit: { seenAt: NOW, resetsAt: NOW + 3_600_000, text: "You've hit your Opus limit", scope: 'model' } }]) })
    expect(await offerConductorRun("You've hit your Opus limit · resets 3pm", 'acc_m', deps)).toBe(false)
  })
})

// T11: a worker switched by hand, from its chip in the swarm dashboard, takes the restart's path.
describe('noteWorkerSwitched', () => {
  beforeEach(() => {
    useTerminalStore.setState({ swarmAgents: [{ terminalId: 'w1', agentName: 'Claude', role: 'Build UI', status: 'blocked' }, { terminalId: 'w2', agentName: 'Claude', role: 'Tests', status: 'blocked' }] })
  })

  it('takes the worker off its offer, stops its clock, carries its stop and tells the conductor it resumed', async () => {
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    await offerRestart(W2, LIMIT, () => WORDS, deps)
    await noteWorkerStatus(W1, LIMIT, () => true)
    await noteWorkerSwitched('w1', { kind: 'switched', resumed: true }, deps)
    expect(groups()[0].workers.map((w) => w.terminalId)).toEqual(['w2'])
    expect(messages()[2]).toBe(restartedMessage(W1))
    // Carried: the same limit, redrawn, tells the conductor nothing.
    await noteWorkerStatus(W1, LIMIT)
    expect(messages()).toHaveLength(3)
    // Its clock is stopped; the other worker's still runs.
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS)
    expect(messages().slice(3)).toEqual([reassignOf(W2)])
  })

  it('takes the offer down with its last worker, and tells the conductor to send the task again after a new session', async () => {
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    useTerminalStore.getState().putSwarmRestart({ id: 'other', agent: 'codex', accountId: 'acc_x', words: '', resetsAt: null, workers: [{ ...W2, summary: '' }], targets: [], phase: { kind: 'done', lines: [] } })
    await noteWorkerSwitched('w1', { kind: 'fresh', why: 'asked' }, deps)
    expect(groups().map((g) => g.id)).toEqual(['other'])
    expect(messages()[1]).toBe(freshMessage(W1))
  })

  it('says a stop is carried while its worker has taken no turn since, and not once it has (N5)', async () => {
    expect(await isStopCarried('w1')).toBe(false)
    let took = false
    carryWorkerStop('w1', 'usage limit reached', async () => took)
    expect(await isStopCarried('w1')).toBe(true)
    took = true
    expect(await isStopCarried('w1')).toBe(false)
    // A stop nothing was carried for is a stop of the worker's own run.
    await noteWorkerStatus(W2, LIMIT)
    expect(await isStopCarried('w2')).toBe(false)
  })

  it('lets go of the worker\'s timer', async () => {
    const clearTimer = vi.fn((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
    deps = makeDeps({ clearTimer })
    ;(window as any).swarmAPI = deps.swarm
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    await noteWorkerSwitched('w1', { kind: 'switched', resumed: true }, deps)
    expect(clearTimer).toHaveBeenCalledTimes(1)
  })

  it("carries the stop of a worker switched by hand until it took a turn: the resumed session's old limit, drawn again after quiet reads, is no new stop (R4)", async () => {
    const off = installSwarmRestart(() => deps)
    const IDLE = { status: 'idle' as const, summary: 'Waiting at prompt' }
    await noteSwarmStop(W1, LIMIT)
    expect(messages()).toHaveLength(1)
    // The user switches the worker from its chip; the conductor is told it resumed.
    await noteWorkerSwitched('w1', { kind: 'switched', resumed: true }, deps)
    expect(messages()).toHaveLength(2)
    // The reads between the exit and the resume show no limit, and two of them end an ordinary stop ...
    await noteSwarmStop(W1, IDLE)
    await noteSwarmStop(W1, IDLE)
    // ... so the old limit the resumed session draws again would be told as a new one, unless it is carried.
    await noteSwarmStop(W1, LIMIT)
    expect(messages()).toHaveLength(2)
    expect(groups().filter((g) => g.phase.kind === 'offered')).toEqual([])
    off()
  })

  it('does nothing for a switch that didn\'t run, or for a terminal that is no worker', async () => {
    await noteWorkerSwitched('w1', { kind: 'busy' }, deps)
    await noteWorkerSwitched('nope', { kind: 'switched', resumed: true }, deps)
    expect(messages()).toEqual([])
  })
})

describe('round 1: what the offer does about the conductor, a stale view, a throwing offer and a closed worker', () => {
  const SESSION_WORDS = "You've hit your session limit · resets 3pm (America/New_York)"

  it("gives a worker that runs out beside the conductor's open card an offer of its own, which the conductor's clock never drops", async () => {
    expect(await offerConductorRun(SESSION_WORDS, 'acc_m', deps)).toBe(true)
    expect(groups().map((g) => [g.id, !!g.conductor, g.workers.length])).toEqual([['g1', true, 0]])
    expect(await offerRestart(W1, LIMIT, () => WORDS, deps)).toBe(true)
    // Two cards: the conductor's has no Restart button for a worker, and keeps its own.
    expect(groups().map((g) => [!!g.conductor, g.workers.map((w) => w.terminalId)])).toEqual([[true, []], [false, ['w1']]])
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS)
    expect(messages()[1]).toBe(reassignOf(W1))
    expect(groups().map((g) => !!g.conductor)).toEqual([true])
  })

  it("reads main's accounts after recording the limit, so the account that just ran out is no way out of the next stop", async () => {
    // w1 was restarted onto codedev; main now knows personal is out of usage until 3pm.
    useTerminalStore.setState({ terminals: [worker('w1', { agentAccountId: 'acc_c' }), worker('w2')] })
    const limited = { ...MAIN, limit: { seenAt: NOW, resetsAt: NOW + 3 * 3_600_000, text: WORDS, scope: 'account' as const } }
    ;(deps.accounts.list as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ success: true, data: view([limited, CODEDEV]) }))
    // The renderer's copy is as old as its last read: it still shows personal free.
    expect(useTerminalStore.getState().accountsView!.accounts[0].limit).toBeUndefined()
    expect(await offerRestart({ ...W1 }, LIMIT, () => WORDS, deps)).toBe(false)
    expect(deps.accounts.noteLimit).toHaveBeenCalledWith('acc_c', expect.objectContaining({ text: WORDS }))
    expect(useTerminalStore.getState().accountsView!.accounts[0].limit).toBeDefined()
    expect(groups()).toEqual([])
  })

  it('goes on with the view it had when main cannot be read, or the record fails', async () => {
    ;(deps.accounts.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ipc down'))
    ;(deps.accounts.noteLimit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ipc down'))
    expect(await offerRestart(W1, LIMIT, () => WORDS, deps)).toBe(true)
    useTerminalStore.setState({ swarmRestarts: [] })
    ;(deps.accounts.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false, error: 'x' })
    expect(await offerRestart(W1, LIMIT, () => WORDS, deps)).toBe(true)
  })

  it("tells the conductor as v1.54.0 did when the offer itself throws, and does not reject", async () => {
    await expect(noteWorkerStatus(W1, LIMIT, async () => { throw new Error('bridge missing') }, () => WORDS)).resolves.toBeUndefined()
    expect(messages()).toEqual([reassignOf(W1)])
    // The stop is the one recorded: the same read again is no new stop.
    await noteWorkerStatus(W1, LIMIT, async () => { throw new Error('bridge missing') }, () => WORDS)
    expect(messages()).toHaveLength(1)
  })

  it('never offers or closes through a worker the conductor already closed', async () => {
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    noteConductorClosed('w1')
    useTerminalStore.setState({ terminals: [worker('w2')] })
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS)
    expect(messages()).toHaveLength(1)
  })
})

describe('what a restart that did not happen says of a worker (UI addendum 1)', () => {
  const outcomes: SwitchOutcome[] = [
    { kind: 'busy' }, { kind: 'unknown-exit' }, { kind: 'exit-unconfirmed' }, { kind: 'agent-alive' }, { kind: 'didnt-start', line: 'x' }, { kind: 'didnt-start', line: 'x', otherShell: true },
    { kind: 'resume-not-found' }, { kind: 'sign-in' }, { kind: 'asks-user', what: 'a menu' }, { kind: 'no-outcome' }, { kind: 'refused', why: 'no way' },
    { kind: 'switched', resumed: true }, { kind: 'fresh', why: 'asked' },
  ]

  it.each(outcomes)('%j: a statement, no question, no command to type, no terminal to look at', (o) => {
    for (const agent of ['claude', 'codex'] as const) {
      const text = failureText(o, agent, CODEDEV)
      expect(text).not.toMatch(/yourself|\/exit|\/quit|\/login|in the terminal|look at|\?/i)
      expect(text.length).toBeGreaterThan(10)
    }
  })

  it('shows it in the offer, with the conductor told to reassign, and no switch-again instruction', async () => {
    outcomes.length = 0
    const list: SwitchOutcome[] = [{ kind: 'exit-unconfirmed' }]
    ;(deps.accounts.switchAccount as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ success: true, data: list.shift() }))
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    await restartOn('g1', 'acc_c', deps)
    const line = (groups()[0].phase as { lines: string[] }).lines[0]
    expect(line).toBe("Claude (Build UI): Claude Code didn't confirm it exited, so Termpolis typed nothing more. The conductor reassigns its task.")
    expect(messages()[1]).toBe(reassignOf(W1))
  })

  it('names the worker when its sign-in lapsed, and where to sign it in', () => {
    expect(failureText({ kind: 'sign-in' }, 'codex', CODEDEV)).toBe("codedev's sign-in has expired, so Codex stopped at its sign-in screen. Sign it in again from its card in Settings ▸ Accounts.")
  })
})

describe('the second confirmation for a worker on an account that is not offered automatically (D14, R17)', () => {
  it('travels with the restart that follows the question, and is never sent without it', async () => {
    useTerminalStore.setState({ accountsView: view([{ ...MAIN, autoOffer: false }, CODEDEV]) })
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    await restartOn('g1', 'acc_c', deps)
    expect(deps.accounts.switchAccount).not.toHaveBeenCalled()
    await restartOn('g1', 'acc_c', deps, true)
    expect(deps.accounts.switchAccount).toHaveBeenCalledWith(expect.objectContaining({ terminalId: 'w1', targetId: 'acc_c', confirmedCarry: true }))
  })

  it('is not sent for a worker on an account that is offered automatically', async () => {
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    await restartOn('g1', 'acc_c', deps)
    expect((deps.accounts.switchAccount as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toHaveProperty('confirmedCarry')
  })

  it('travels with the fresh-session retry too', async () => {
    useTerminalStore.setState({ accountsView: view([{ ...MAIN, autoOffer: false }, CODEDEV]) })
    outcomes.push({ kind: 'resume-not-found' }, { kind: 'fresh', why: 'asked' })
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    await restartOn('g1', 'acc_c', deps, true)
    const calls = (deps.accounts.switchAccount as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(expect.objectContaining({ fresh: true, assumeExited: true, confirmedCarry: true }))
  })
})

describe('a worker whose limit lifted while its offer was open (R16)', () => {
  const WORKING = { status: 'working' as const, summary: 'Thinking' }

  it('leaves the offer and its clock when it is read at work again, and the conductor is told there is nothing to wait for', async () => {
    const off = installSwarmRestart(() => deps)
    await noteSwarmStop(W1, LIMIT)
    await noteSwarmStop(W2, LIMIT)
    expect(groups()[0].workers.map((w) => w.terminalId)).toEqual(['w1', 'w2'])
    await noteSwarmStop(W1, WORKING)
    expect(groups()[0].workers.map((w) => w.terminalId)).toEqual(['w2'])
    expect(messages()[2]).toBe(withdrawnMessage(W1))
    // Its clock is gone: only the worker still on offer is told to be closed.
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS)
    expect(messages().slice(3)).toEqual([reassignOf(W2)])
    off()
  })

  it("takes the last worker's offer down with it, and says nothing for a worker that was on none", async () => {
    const off = installSwarmRestart(() => deps)
    await noteSwarmStop(W1, LIMIT)
    await noteSwarmStop(W1, WORKING)
    expect(groups()).toEqual([])
    expect(messages()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS)
    expect(messages()).toHaveLength(2)
    // A worker that never stopped, working: nothing to withdraw.
    await noteSwarmStop(W2, WORKING)
    expect(messages()).toHaveLength(2)
    off()
  })

  it('leaves an offer that is restarting its worker alone', async () => {
    const off = installSwarmRestart(() => deps)
    await noteSwarmStop(W1, LIMIT)
    useTerminalStore.getState().putSwarmRestart({ ...groups()[0], phase: { kind: 'restarting', targetId: 'acc_c' } })
    await noteSwarmStop(W1, WORKING)
    expect(groups()[0].workers.map((w) => w.terminalId)).toEqual(['w1'])
    expect(messages()).toHaveLength(1)
    off()
  })

  it('still ends the stop when no offer is installed, and when the hook throws', async () => {
    await noteWorkerStatus(W1, LIMIT)
    await noteWorkerStatus(W1, WORKING)
    await noteWorkerStatus(W1, LIMIT)
    expect(messages()).toHaveLength(2)
    setSwarmWorkingAgain(async () => { throw new Error('hook broke') })
    await expect(noteWorkerStatus(W1, WORKING)).resolves.toBeUndefined()
    await noteWorkerStatus(W1, LIMIT)
    expect(messages()).toHaveLength(3)
  })
})

// SWARM-R1 N1: a close-and-reassign deferred under a relaunch lock is cancelled with the rest of the worker's
// timers, and a worker taken off the swarm while on an offer is told to the conductor, which waits on Termpolis.
describe('a close-and-reassign that waits for a relaunch to let go of its worker (N1, R30)', () => {
  const closeAndReassign = (): string[] => messages().filter((m) => m.includes('close its terminal, then give its task to another installed agent'))
  const SWITCHED: SwitchOutcome = { kind: 'switched', resumed: true, sessionId: 'sess-1' }

  beforeEach(async () => {
    useTerminalStore.setState({ swarmAgents: [{ terminalId: 'w1', agentName: 'Claude', role: 'Build UI', status: 'blocked' }] })
    await offerRestart(W1, LIMIT, () => WORDS, deps)
  })

  it('does not fire once a hand switch that held the worker restarted it (declined under the lock)', async () => {
    useTerminalStore.getState().beginRelaunch('w1', 'account')
    await declineRestart(groups()[0].id, deps)
    useTerminalStore.getState().endRelaunch('w1')
    await noteWorkerSwitched('w1', SWITCHED, deps)
    await vi.advanceTimersByTimeAsync(LOCK_RECHECK_MS * 4)
    expect(closeAndReassign()).toEqual([])
    expect(messages()[messages().length - 1]).toBe(restartedMessage(W1))
  })

  it('does not fire once the 5 minutes ran out under the lock and the hand switch then restarted the worker', async () => {
    useTerminalStore.getState().beginRelaunch('w1', 'account')
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS + 100)
    useTerminalStore.getState().endRelaunch('w1')
    await noteWorkerSwitched('w1', SWITCHED, deps)
    await vi.advanceTimersByTimeAsync(LOCK_RECHECK_MS * 4)
    expect(closeAndReassign()).toEqual([])
  })

  it('does fire once, after the lock lets go, when that relaunch did not restart it (declined under the lock)', async () => {
    useTerminalStore.getState().beginRelaunch('w1', 'account')
    await declineRestart(groups()[0].id, deps)
    await vi.advanceTimersByTimeAsync(LOCK_RECHECK_MS * 3)
    expect(closeAndReassign()).toEqual([])
    useTerminalStore.getState().endRelaunch('w1')
    await vi.advanceTimersByTimeAsync(LOCK_RECHECK_MS * 3)
    expect(closeAndReassign()).toHaveLength(1)
  })

  it('does not fire for a worker that is at work again by itself while the close waited', async () => {
    useTerminalStore.getState().beginRelaunch('w1', 'account')
    await declineRestart(groups()[0].id, deps)
    await withdrawFromOffer(W1, deps)
    useTerminalStore.getState().endRelaunch('w1')
    await vi.advanceTimersByTimeAsync(LOCK_RECHECK_MS * 4)
    expect(closeAndReassign()).toEqual([])
  })

  it('keeps one waiting close for a worker, not one for each time it was asked', async () => {
    useTerminalStore.getState().beginRelaunch('w1', 'account')
    await declineRestart(groups()[0].id, deps)
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    await declineRestart(groups()[0].id, deps)
    useTerminalStore.getState().endRelaunch('w1')
    await vi.advanceTimersByTimeAsync(LOCK_RECHECK_MS * 4)
    expect(closeAndReassign()).toHaveLength(1)
  })
})

describe('a worker closed while it was on an offer (N7)', () => {
  const live = (...ids: string[]): ReadonlySet<string> => new Set(ids)
  const closedMessageOf = (w: typeof W1): string => closedBeforeMessage(w)

  beforeEach(async () => {
    useTerminalStore.setState({ swarmAgents: [{ terminalId: 'w1', agentName: 'Claude', role: 'Build UI', status: 'blocked' }, { terminalId: 'w2', agentName: 'Claude', role: 'Tests', status: 'blocked' }] })
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    await offerRestart(W2, LIMIT, () => WORDS, deps)
  })

  it('leaves the offer, stops its clock and tells the conductor it was closed, when the user closed its pane', async () => {
    useTerminalStore.setState({ terminals: [worker('w2')] })
    const clear = vi.spyOn(deps, 'clearTimer')
    await pruneSwarmRestarts(live('w2'), deps)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(groups()[0].workers.map((w) => w.terminalId)).toEqual(['w2'])
    expect(messages()[messages().length - 1]).toBe(closedMessageOf(W1))
    // Its clock is gone: the 5 minutes run out for w2 alone.
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS)
    expect(messages().filter((m) => m.includes('terminal w1')).length).toBe(2)
    expect(messages().filter((m) => m.includes('terminal w2') && m.includes('close its terminal'))).toHaveLength(1)
  })

  it('takes the offer down with its last worker', async () => {
    useTerminalStore.setState({ terminals: [] })
    await pruneSwarmRestarts(live(), deps)
    expect(groups()).toEqual([])
    expect(messages().filter((m) => m === closedMessageOf(W1) || m === closedMessageOf(W2))).toHaveLength(2)
  })

  it('takes a worker off an offer that is asking its question like one that is asking for the account', async () => {
    useTerminalStore.setState({ accountsView: view([{ ...MAIN, autoOffer: false }, CODEDEV, WORK]), swarmRestarts: [] })
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    await offerRestart(W2, LIMIT, () => WORDS, deps)
    await restartOn(groups()[0].id, 'acc_c', deps)
    expect(groups()[0].phase.kind).toBe('confirm')
    useTerminalStore.setState({ terminals: [worker('w2')] })
    await pruneSwarmRestarts(live('w2'), deps)
    expect(groups()[0].workers.map((w) => w.terminalId)).toEqual(['w2'])
    expect(groups()[0].phase.kind).toBe('confirm')
    expect(messages()[messages().length - 1]).toBe(closedMessageOf(W1))
  })

  it('tells the conductor nothing of a worker the conductor closed itself', async () => {
    noteConductorClosed('w1')
    useTerminalStore.setState({ terminals: [worker('w2')] })
    const before = messages().length
    await pruneSwarmRestarts(live('w2'), deps)
    expect(messages()).toHaveLength(before)
    expect(groups()[0].workers.map((w) => w.terminalId)).toEqual(['w2'])
  })

  it('leaves a restart under way, a finished offer and the conductor\'s offer alone', async () => {
    useTerminalStore.getState().putSwarmRestart({ ...groups()[0], id: 'under-way', phase: { kind: 'restarting', targetId: 'acc_c' } })
    useTerminalStore.getState().putSwarmRestart({ ...groups()[0], id: 'finished', phase: { kind: 'done', lines: ['x'] } })
    useTerminalStore.getState().putSwarmRestart({ id: 'cond', conductor: true, agent: 'claude', accountId: 'acc_m', words: WORDS, resetsAt: null, workers: [], targets: ['acc_c'], phase: { kind: 'offered' } })
    const before = groups().map((g) => g.id)
    await pruneSwarmRestarts(live('w1', 'w2'), deps)
    expect(groups().map((g) => g.id)).toEqual(before)
    await pruneSwarmRestarts(live(), deps)
    expect(groups().map((g) => g.id).sort()).toEqual(['cond', 'finished', 'under-way'])
  })

  it('tells the conductor when its close-and-reassign finds the worker gone, at a decline and at the end of the wait', async () => {
    useTerminalStore.setState({ terminals: [worker('w2')] })
    await declineRestart(groups()[0].id, deps)
    expect(messages()).toContain(closedMessageOf(W1))
    expect(messages()).toContain(reassignOf(W2))
    // The wait runs out for a worker closed meanwhile: told that, not to close it.
    await offerRestart(W2, LIMIT, () => WORDS, deps)
    useTerminalStore.setState({ terminals: [] })
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS)
    expect(messages()).toContain(closedMessageOf(W2))
    expect(messages().filter((m) => m === reassignOf(W2))).toHaveLength(1)
  })

  it('says why a restart of a closed worker did not happen, and tells the conductor unless it closed it', async () => {
    const id = groups()[0].id
    useTerminalStore.setState({ terminals: [worker('w2')] })
    await restartOn(id, 'acc_c', deps)
    expect(groups().find((g) => g.id === id)!.phase).toEqual({
      kind: 'done',
      lines: ['Claude (Build UI): it was closed, so it wasn\'t restarted.', 'Claude (Tests): on codedev, its conversation resumed.'],
    })
    expect(messages()).toContain(closedMessageOf(W1))
    // The conductor closed the other itself: its line says so, and it is told nothing.
    noteConductorClosed('w2')
    useTerminalStore.setState({ terminals: [] })
    useTerminalStore.getState().putSwarmRestart({ ...groups()[0], id: 'again', workers: [{ ...W2, summary: LIMIT.summary }], phase: { kind: 'offered' } })
    const n = messages().length
    await restartOn('again', 'acc_c', deps)
    expect(groups().find((g) => g.id === 'again')!.phase).toEqual({ kind: 'done', lines: ['Claude (Tests): the conductor closed it, so it wasn\'t restarted.'] })
    expect(messages()).toHaveLength(n)
  })

  it('names its task, when it had one, in what the conductor is told', () => {
    expect(closedBeforeMessage({ ...W1, taskId: 'task-1' })).toContain('taskId task-1')
    expect(closedBeforeMessage(W1)).not.toContain('taskId')
    expect(closedBeforeMessage(W1)).toContain('give it to another installed agent')
  })

  it('forgets the worker\'s offers and clocks when the swarm is cleared, and tells no one', async () => {
    const n = messages().length
    const clear = vi.spyOn(deps, 'clearTimer')
    clearSwarmRestarts(deps)
    expect(clear).toHaveBeenCalledTimes(2)
    expect(groups()).toEqual([])
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS)
    expect(messages()).toHaveLength(n)
  })
})

describe('the conductor\'s run-again offer reads main\'s accounts, as the worker offer does (N6)', () => {
  it('leaves out an account main already holds as out of usage', async () => {
    const out = { ...CODEDEV, limit: { seenAt: NOW - 1000, resetsAt: NOW + 3_600_000, text: "You've hit your session limit", scope: 'account' as const } }
    ;(deps.accounts.list as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, data: view([MAIN, out, WORK]) })
    expect(await offerConductorRun(WORDS, 'acc_m', deps)).toBe(false)
    expect(groups()).toEqual([])
  })

  it('records the limit before it reads the view, and uses the view it read', async () => {
    const order: string[] = []
    ;(deps.accounts.noteLimit as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('noteLimit'); return { success: true, data: undefined } })
    ;(deps.accounts.list as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('list'); return { success: true, data: view([MAIN, CODEDEV, WORK]) } })
    expect(await offerConductorRun(WORDS, 'acc_m', deps)).toBe(true)
    expect(order).toEqual(['noteLimit', 'list'])
    expect(groups()[0]).toMatchObject({ conductor: true, targets: ['acc_c'] })
  })

  it('offers nothing when the account it ran on is gone from main\'s accounts meanwhile', async () => {
    ;(deps.accounts.list as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, data: view([CODEDEV, WORK]) })
    expect(await offerConductorRun(WORDS, 'acc_m', deps)).toBe(false)
    expect(groups()).toEqual([])
  })

  it('goes on with the view it had when main cannot be read', async () => {
    ;(deps.accounts.list as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('gone'))
    ;(deps.accounts.noteLimit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('gone'))
    expect(await offerConductorRun(WORDS, 'acc_m', deps)).toBe(true)
    ;(deps.accounts.list as ReturnType<typeof vi.fn>).mockResolvedValue({ success: false, error: 'x' })
    useTerminalStore.setState({ swarmRestarts: [] })
    expect(await offerConductorRun(WORDS, 'acc_m', deps)).toBe(true)
  })
})

describe('a worker hand-switched while the offer asks its question (GAPS)', () => {
  it('leaves the offer in its confirm phase like the offer\'s other phases', async () => {
    useTerminalStore.setState({ accountsView: view([{ ...MAIN, autoOffer: false }, CODEDEV, WORK]), swarmAgents: [{ terminalId: 'w1', agentName: 'Claude', role: 'Build UI', status: 'blocked' }, { terminalId: 'w2', agentName: 'Claude', role: 'Tests', status: 'blocked' }] })
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    await offerRestart(W2, LIMIT, () => WORDS, deps)
    await restartOn(groups()[0].id, 'acc_c', deps)
    expect(groups()[0].phase.kind).toBe('confirm')
    await noteWorkerSwitched('w1', { kind: 'switched', resumed: true }, deps)
    expect(groups()[0].workers.map((w) => w.terminalId)).toEqual(['w2'])
    expect(groups()[0].phase.kind).toBe('confirm')
  })

  it('takes a worker at work again off a question that was open for it, and tells the conductor', async () => {
    useTerminalStore.setState({ accountsView: view([{ ...MAIN, autoOffer: false }, CODEDEV, WORK]), swarmAgents: [{ terminalId: 'w1', agentName: 'Claude', role: 'Build UI', status: 'blocked' }] })
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    await restartOn(groups()[0].id, 'acc_c', deps)
    expect(groups()[0].phase.kind).toBe('confirm')
    await withdrawFromOffer(W1, deps)
    expect(groups()).toEqual([])
    expect(messages()[messages().length - 1]).toBe(withdrawnMessage(W1))
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS)
    expect(closeAndReassignCount()).toBe(0)
  })
})
const closeAndReassignCount = (): number => messages().filter((m) => m.includes('close its terminal, then give its task to another installed agent')).length

// WHOLE-R1-F2 / UI-R1-J (account-switcher-ui.md 2.3): the sign-in sheet opens from the swarm offer. An account that is
// signed out is a way out once it is signed in, so the offer names it with "Sign in to <it> and restart".
describe('the swarm offer and an account that is signed out (UI addendum 2.3)', () => {
  const signedOut = (...ids: string[]): void => {
    ;(deps.accounts.check as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => ({
      success: true as const,
      data: { ...MAIN, id, identity: { email: null, signedIn: !ids.includes(id), checkedAt: NOW, source: 'auth-status' as const } },
    }))
  }
  const stopped = async (): Promise<boolean> => {
    useTerminalStore.setState({ swarmAgents: [{ terminalId: 'w1', agentName: 'Claude', role: 'Build UI', status: 'blocked' }] })
    return offerRestart(W1, LIMIT, () => WORDS, deps)
  }

  it('is offered when the only other account is signed out: nothing to restart on yet, one to sign in to', async () => {
    signedOut('acc_c')
    expect(await stopped()).toBe(true)
    expect(groups()[0]).toMatchObject({ targets: [], signIn: ['acc_c'], phase: { kind: 'offered' } })
    expect(messages()).toEqual([offeredMessage(W1, LIMIT.summary)])
  })

  it('lists the signed-in accounts to restart on and the signed-out ones to sign in to, each apart', async () => {
    const third = row({ id: 'acc_t', label: 'third', profile: '/h/.claude-third', isDefault: false, order: 3, lastEmail: 't@example.test' })
    useTerminalStore.setState({ accountsView: view([MAIN, CODEDEV, third, WORK]) })
    signedOut('acc_t')
    expect(await stopped()).toBe(true)
    expect(groups()[0]).toMatchObject({ targets: ['acc_c'], signIn: ['acc_t'] })
  })

  it('is not offered when no other account is signed in or could be: the conductor is told as in v1.54.0', async () => {
    signedOut('acc_c')
    useTerminalStore.setState({ accountsView: view([MAIN, { ...CODEDEV, connect: false }, WORK]) })
    expect(await stopped()).toBe(false)
    expect(groups()).toEqual([])
  })

  it('leaves out a signed-out account a worker could not run on after signing in, and one out of usage or the same sign-in', async () => {
    const out = { ...CODEDEV, id: 'acc_o', label: 'out', limit: { seenAt: NOW - 1000, resetsAt: NOW + 3_600_000, text: "You've hit your session limit", scope: 'account' as const } }
    const unbypassed = { ...CODEDEV, id: 'acc_b', label: 'nobypass', bypassReady: false }
    const same = { ...CODEDEV, id: 'acc_s', label: 'same', lastEmail: MAIN.lastEmail }
    useTerminalStore.setState({ accountsView: view([MAIN, out, unbypassed, same, WORK]) })
    signedOut('acc_o', 'acc_b', 'acc_s')
    expect(await stopped()).toBe(false)
  })

  it('stops the clock while the user signs in, opens the sheet for that account, and restarts the worker when it finished', async () => {
    signedOut('acc_c')
    await stopped()
    signInThenRestart(groups()[0].id, 'acc_c', deps)
    expect(useTerminalStore.getState().signInSheet).toMatchObject({ accountId: 'acc_c', then: expect.any(Function), doneLabel: 'Restart it on codedev', cancelled: expect.any(Function) })
    // The 5 minutes pass with the sheet open: the conductor is not told to reassign.
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS * 2)
    expect(messages()).toEqual([offeredMessage(W1, LIMIT.summary)])
    // Signed in: the restart goes on.
    useTerminalStore.getState().signInSheet!.then!()
    await vi.advanceTimersByTimeAsync(10)
    expect(deps.accounts.switchAccount).toHaveBeenCalled()
    expect(messages()[messages().length - 1]).toBe(restartedMessage(W1))
  })

  it('names an account the view no longer holds as "that account" on the sheet\'s button', async () => {
    signedOut('acc_c')
    await stopped()
    useTerminalStore.setState({ accountsView: view([MAIN, WORK]) })
    signInThenRestart(groups()[0].id, 'acc_c', deps)
    expect(useTerminalStore.getState().signInSheet).toMatchObject({ accountId: 'acc_c', doneLabel: 'Restart it on that account' })
  })

  it('starts no clock when the sheet is closed after the offer went away or moved on', async () => {
    signedOut('acc_c')
    await stopped()
    const id = groups()[0].id
    signInThenRestart(id, 'acc_c', deps)
    const cancelled = useTerminalStore.getState().signInSheet!.cancelled!
    // The offer is restarting its workers now (something else began it), or is gone: nothing waits any more.
    useTerminalStore.getState().putSwarmRestart({ ...groups()[0], phase: { kind: 'restarting', targetId: 'acc_c' } })
    cancelled()
    useTerminalStore.getState().dropSwarmRestart(id)
    cancelled()
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS * 2)
    expect(messages()).toEqual([offeredMessage(W1, LIMIT.summary)])
  })

  it('runs the clock again when the sheet is closed without signing in', async () => {
    signedOut('acc_c')
    await stopped()
    signInThenRestart(groups()[0].id, 'acc_c', deps)
    useTerminalStore.getState().signInSheet!.cancelled!()
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS - 10)
    expect(messages()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(20)
    expect(messages()[messages().length - 1]).toBe(reassignOf(W1))
  })

  it('names all of the workers when it restarts several, and does nothing for an offer that is gone or past asking', async () => {
    signedOut('acc_c')
    useTerminalStore.setState({ swarmAgents: [{ terminalId: 'w1', agentName: 'Claude', role: 'Build UI', status: 'blocked' }, { terminalId: 'w2', agentName: 'Claude', role: 'Tests', status: 'blocked' }] })
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    await offerRestart(W2, LIMIT, () => WORDS, deps)
    const id = groups()[0].id
    signInThenRestart(id, 'acc_c', deps)
    expect(useTerminalStore.getState().signInSheet).toMatchObject({ accountId: 'acc_c', doneLabel: 'Restart all on codedev' })
    useTerminalStore.getState().closeSignInSheet()
    signInThenRestart('nope', 'acc_c', deps)
    expect(useTerminalStore.getState().signInSheet).toBeNull()
    useTerminalStore.getState().putSwarmRestart({ ...groups()[0], phase: { kind: 'restarting', targetId: 'acc_c' } })
    signInThenRestart(id, 'acc_c', deps)
    expect(useTerminalStore.getState().signInSheet).toBeNull()
  })

  it('is offered for the conductor\'s run-again card too, where its bypass is ready', async () => {
    signedOut('acc_c')
    useTerminalStore.setState({ accountsView: view([MAIN, CODEDEV, { ...MAIN, id: 'acc_n', label: 'nobypass', order: 3, isDefault: false, profile: '/h/.claude-n', bypassReady: false }, WORK]) })
    signedOut('acc_c', 'acc_n')
    expect(await offerConductorRun(WORDS, 'acc_m', deps)).toBe(true)
    expect(groups()[0]).toMatchObject({ conductor: true, targets: [], signIn: ['acc_c'] })
  })
})
