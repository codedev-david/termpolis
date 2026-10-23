// The swarm restart offer (src/renderer/src/lib/swarmRestart.ts, §9 with R4, R7, R16): which
// accounts a worker that ran out of usage can be restarted on, what the conductor is told at each
// step and in which words, the clock that reassigns an unanswered offer, and the restart itself,
// through the switch main runs (accounts:switch), faked here at the bridge. The store is the app's
// own.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  LOCK_RECHECK_MS, RESTART_WAIT_MS, _resetSwarmRestartForTest, declineRestart, freshMessage, installSwarmRestart, noteWorkerSwitched, offerConductorRun, offerRestart,
  offerTitle, offeredMessage, restartOn, restartTargets, restartedMessage, workerBlocker,
} from '../../src/renderer/src/lib/swarmRestart'
import type { RestartDeps, SwarmRestartGroup } from '../../src/renderer/src/lib/swarmRestart'
import { _resetLimitWatchForTest, noteSwarmStop } from '../../src/renderer/src/lib/limitWatch'
import { _resetStopReportsForTest, noteWorkerStatus } from '../../src/renderer/src/lib/swarmStopReports'
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

  it('leaves it to the report when the only way out turns out signed out, and survives a record that fails', async () => {
    deps = makeDeps()
    ;(deps.accounts.check as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, data: { ...CODEDEV, identity: { email: null, signedIn: false, checkedAt: NOW, source: 'auth-status' } } })
    ;(deps.accounts.noteLimit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('registry locked'))
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

  it('stops the moment the user acts', async () => {
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    useTerminalStore.setState({ accountsView: view([{ ...MAIN, autoOffer: false }, CODEDEV]) })
    // The first click counts, though the restart then asks once more (R17).
    await restartOn('g1', 'acc_c', deps)
    expect(groups()[0].phase.kind).toBe('confirm')
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS * 2)
    expect(messages()).toHaveLength(1)
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
    [{ kind: 'busy' } as SwitchOutcome, 'Claude Code is working. Stop it and switch?'],
    [{ kind: 'agent-alive' } as SwitchOutcome, 'Claude Code didn\'t exit'],
    [{ kind: 'asks-user', what: 'Bypass Permissions mode' } as SwitchOutcome, 'codedev is asking something only you can answer'],
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

  it('reassigns when the account picked isn\'t registered any more, or something else relaunches the worker', async () => {
    await offered()
    await restartOn('g1', 'acc_gone', deps)
    expect(messages()[1]).toBe(reassignOf(W1, TASK1))
    expect((groups()[0].phase as { lines: string[] }).lines[0]).toBe('Claude (Build UI): that account isn\'t registered any more, so it wasn\'t restarted: the conductor reassigns its task.')
    useTerminalStore.setState({ swarmRestarts: [], relaunching: { w1: 'model' } })
    await offerRestart(W1, LIMIT, () => WORDS, deps)
    await restartOn(groups()[0].id, 'acc_c', deps)
    expect((groups()[0].phase as { lines: string[] }).lines[0]).toBe('Claude (Build UI): something else is relaunching it, so it wasn\'t restarted: the conductor reassigns its task.')
    expect(deps.accounts.switchAccount).not.toHaveBeenCalled()
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

  it('offers nothing, as v1.54.0, when no other account is a way out, or the only one is signed out; the limit is recorded', async () => {
    useTerminalStore.setState({ accountsView: view([{ ...MAIN, lastEmail: null }, { ...CODEDEV, bypassReady: false }]) })
    expect(await offerConductorRun(SESSION_WORDS, 'acc_m', deps)).toBe(false)
    expect(deps.accounts.noteLimit).toHaveBeenCalledWith('acc_m', expect.not.objectContaining({ email: expect.anything() }))
    useTerminalStore.setState({ accountsView: view([MAIN, CODEDEV]) })
    ;(deps.accounts.check as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, data: { ...CODEDEV, identity: { email: null, signedIn: false, checkedAt: NOW, source: 'auth-status' } } })
    ;(deps.accounts.noteLimit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('locked'))
    expect(await offerConductorRun(SESSION_WORDS, 'acc_m', deps)).toBe(false)
    expect(groups()).toEqual([])
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

  it('does nothing for a switch that didn\'t run, or for a terminal that is no worker', async () => {
    await noteWorkerSwitched('w1', { kind: 'busy' }, deps)
    await noteWorkerSwitched('nope', { kind: 'switched', resumed: true }, deps)
    expect(messages()).toEqual([])
  })
})
