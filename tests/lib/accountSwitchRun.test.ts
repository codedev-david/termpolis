// Switching a terminal's account in place (src/renderer/src/lib/accountSwitchRun.ts, the in-app
// account UI §2.2): the run the account menu, the limit card and a sign-in start; what the pane
// shows meanwhile (the overlay's steps from main's progress), then the toast with Switch back or
// the error card, each card's buttons, the busy agent's queue, and New terminal on <account>.
// Main's switch is the deps' mock.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AccountRowView, AccountsView } from '../../src/shared/agentAccounts'
import type { SwitchOutcome, SwitchProgress } from '../../src/shared/accountSwitch'
import type { TerminalSession } from '../../src/renderer/src/types'

vi.mock('../../src/renderer/src/lib/agentLaunch', async (orig) => ({ ...(await orig<object>()), launchAgents: vi.fn() }))
vi.mock('../../src/renderer/src/lib/swarmRestart', async (orig) => ({
  ...(await orig<object>()),
  noteWorkerSwitched: vi.fn(async () => undefined),
  liveRestartDeps: vi.fn(() => ({ live: true })),
}))

import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { launchAgents } from '../../src/renderer/src/lib/agentLaunch'
import { liveRestartDeps, noteWorkerSwitched } from '../../src/renderer/src/lib/swarmRestart'
import {
  QUEUE_POLL_MS, TOAST_MS, actOnRun, cardFor, endpoint, installSwitchQueue, liveRunDeps, newTerminalOn, processQueue, queueSwitch,
  startSwitch, stepLabels, stepsAt, toastFor,
} from '../../src/renderer/src/lib/accountSwitchRun'
import type { RunDeps, SwitchRun } from '../../src/renderer/src/lib/accountSwitchRun'

function row(over: Partial<AccountRowView>): AccountRowView {
  return {
    id: 'acc_a', agent: 'claude', label: 'personal', profile: null, folder: '/h/.claude', isDefault: true, autoOffer: true,
    order: 0, connect: true, origin: 'adopted', folderExists: true, shares: [], lastEmail: 'a@example.test',
    connection: { server: true, hook: true, allow: true }, bypassReady: true, terminals: 0, recopyAvailable: false, ...over,
  }
}

function view(accounts: AccountRowView[]): AccountsView {
  return {
    accounts, preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [],
    advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h',
  }
}

const A = row({ id: 'acc_a', label: 'personal', color: '#22D3EE' })
const B = row({ id: 'acc_b', label: 'codedev', profile: '/h/.claude-b', folder: '/h/.claude-b', isDefault: false, order: 1 })
const CX = row({ id: 'cx', agent: 'codex', label: 'cx' })
const T: TerminalSession = { id: 't1', name: 'Claude Code', color: '#D97706', shellType: 'gitbash', cwd: '/repo', fontSize: 13, theme: 'dark', fontFamily: 'mono', agentCommand: 'claude', agentAccountId: 'acc_a' }
const st = useTerminalStore.getState

function deps(over: { outcome?: SwitchOutcome; check?: unknown; progress?: SwitchProgress[] } = {}) {
  let listener: ((p: SwitchProgress) => void) | null = null
  const off = vi.fn()
  const d = {
    accounts: {
      switchAccount: vi.fn(async () => {
        for (const p of over.progress ?? []) listener?.(p)
        return { success: true as const, data: over.outcome ?? { kind: 'switched' as const, resumed: true } }
      }),
      check: vi.fn(async () => ({ success: true as const, data: (over.check ?? { ...B, identity: { email: 'b@x', signedIn: true, checkedAt: 1, source: 'auth-status' } }) as AccountRowView })),
      onSwitchProgress: vi.fn((cb: (p: SwitchProgress) => void) => { listener = cb; return off }),
      list: vi.fn(async () => ({ success: true as const, data: st().accountsView! })),
      limitLook: vi.fn(async () => ({ success: true as const, data: { live: true, status: { status: 'idle' } } })),
    },
    termpolis: {
      claudeTrustWorkspace: vi.fn(async () => ({ success: true })),
      memoryPrepareCodexContext: vi.fn(async () => ({ success: true, data: { developerInstructions: null } })),
      createTerminal: vi.fn(async () => ({ success: true })),
    },
    primerEnabled: () => true,
    now: () => 1_000,
    newId: () => 'new-1',
  }
  return { d: d as unknown as RunDeps, raw: d, off }
}

beforeEach(() => {
  // A done switch's toast has a timer: each test's go with its fake clock, never into the next.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.mocked(launchAgents).mockClear()
  vi.mocked(noteWorkerSwitched).mockClear()
  useTerminalStore.setState({
    terminals: [T], activeTerminalId: 't1', accountsView: view([A, B, CX]), switchRuns: {}, queuedSwitches: {}, relaunching: {},
    signInSheet: null, memoryNotice: null,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the words', () => {
  it('names each endpoint with its colour, else the agent\'s', () => {
    expect(endpoint(A)).toEqual({ id: 'acc_a', label: 'personal', color: '#22D3EE' })
    expect(endpoint(B).color).toBe('#D97706')
  })

  it('says the three steps, the last a new session when one was asked for', () => {
    const to = endpoint(B)
    expect(stepLabels({ agent: 'claude', to })).toEqual(['Ending this session', 'Starting Claude Code on codedev', 'Resuming your conversation'])
    expect(stepLabels({ agent: 'codex', to, fresh: true })[2]).toBe('Starting a new session')
  })

  it('puts main\'s progress on the steps', () => {
    expect(stepsAt('exiting')).toEqual(['working', 'pending', 'pending'])
    expect(stepsAt('confirming')).toEqual(['working', 'pending', 'pending'])
    expect(stepsAt('carrying')).toEqual(['done', 'working', 'pending'])
    expect(stepsAt('typing')).toEqual(['done', 'working', 'pending'])
    expect(stepsAt('waiting')).toEqual(['done', 'done', 'working'])
  })

  it('says what a success did, and where an old conversation is', () => {
    const run = { agent: 'claude' as const, to: endpoint(B), from: endpoint(A) }
    expect(toastFor({ kind: 'switched', resumed: true }, run)).toBe('Claude Code is on codedev now. Conversation resumed.')
    expect(toastFor({ kind: 'fresh', why: 'not-found' }, run)).toBe('Claude Code is on codedev now, in a new session: codedev can\'t see this conversation. The old one is still in Past AI Sessions, on personal.')
    expect(toastFor({ kind: 'fresh', why: 'not-found' }, { ...run, from: null })).toBe('Claude Code is on codedev now, in a new session: codedev can\'t see this conversation. The old one is still in Past AI Sessions.')
    expect(toastFor({ kind: 'fresh', why: 'no-session' }, run)).toBe('Claude Code is on codedev now, in a new session: it named no conversation to resume.')
    expect(toastFor({ kind: 'fresh', why: 'asked' }, run)).toBe('Claude Code is on codedev now, in a new session.')
  })
})

describe('cardFor: what a switch that didn\'t finish says, and what comes next', () => {
  const run = { agent: 'claude' as const, to: endpoint(B), from: endpoint(A) }
  const kinds = (o: SwitchOutcome, worker = false) => cardFor(o, run, worker)?.actions.map((a) => a.kind)

  it('has no card for a switch that finished, or waits for a busy agent', () => {
    expect(cardFor({ kind: 'switched', resumed: true }, run, false)).toBeNull()
    expect(cardFor({ kind: 'fresh', why: 'asked' }, run, false)).toBeNull()
    expect(cardFor({ kind: 'busy' }, run, false)).toBeNull()
  })

  it('says what happened and what the terminal shows now, in a sentence each', () => {
    expect(cardFor({ kind: 'unknown-exit' }, run, false)).toMatchObject({ what: 'Termpolis couldn\'t tell whether Claude Code is still running, so it typed nothing.', now: 'Claude Code is as you left it, on personal.' })
    expect(cardFor({ kind: 'exit-unconfirmed' }, run, false)).toMatchObject({ what: 'Claude Code didn\'t confirm it exited, so Termpolis typed nothing more.', now: 'Claude Code may still be running here, on personal.' })
    expect(cardFor({ kind: 'agent-alive' }, run, false)).toMatchObject({ now: 'Claude Code is still running here, on personal.' })
    expect(cardFor({ kind: 'didnt-start', line: 'x' }, run, false)).toMatchObject({ what: 'The account line never showed in the terminal, so nothing was entered.', now: 'The shell is at its prompt: Claude Code has exited.' })
    expect(cardFor({ kind: 'resume-not-found' }, run, false)).toMatchObject({ what: 'codedev can\'t see this conversation.', now: 'The shell is at its prompt, and the conversation is still on personal.' })
    expect(cardFor({ kind: 'sign-in' }, run, false)).toMatchObject({ what: 'codedev\'s sign-in has expired.', now: 'Claude Code shows its sign-in screen in the terminal, and Termpolis answers none of it.' })
    expect(cardFor({ kind: 'asks-user', what: 'q' }, run, false)).toMatchObject({ what: 'codedev is asking something only you can answer.', now: 'Answer it in the terminal.' })
    expect(cardFor({ kind: 'no-outcome' }, run, false)).toMatchObject({ what: 'Nothing showed in the terminal within 30 seconds.', now: 'Look at the terminal.' })
    expect(cardFor({ kind: 'refused', why: 'no line for this shell' }, run, false)).toMatchObject({ what: 'Termpolis didn\'t switch: no line for this shell.', now: 'Nothing was typed.' })
    expect(cardFor({ kind: 'unknown-exit' }, { ...run, from: null }, false)?.now).toBe('Claude Code is as you left it, on the account it was on.')
  })

  it('offers a way on for each, New terminal on the account except to a swarm worker', () => {
    expect(kinds({ kind: 'unknown-exit' })).toEqual(['retry', 'exited', 'new-terminal', 'close'])
    expect(kinds({ kind: 'exit-unconfirmed' })).toEqual(['retry', 'exited', 'new-terminal', 'close'])
    expect(kinds({ kind: 'agent-alive' })).toEqual(['retry', 'new-terminal', 'close'])
    expect(kinds({ kind: 'didnt-start', line: 'x' })).toEqual(['exited', 'new-terminal', 'close'])
    expect(kinds({ kind: 'resume-not-found' })).toEqual(['fresh', 'new-terminal', 'close'])
    expect(kinds({ kind: 'sign-in' })).toEqual(['sign-in-and-continue', 'sign-in', 'close'])
    expect(kinds({ kind: 'asks-user', what: 'q' })).toEqual(['close'])
    expect(kinds({ kind: 'no-outcome' })).toEqual(['retry', 'close'])
    expect(kinds({ kind: 'refused', why: 'x' })).toEqual(['retry', 'new-terminal', 'close'])
    expect(kinds({ kind: 'refused', why: 'x' }, true)).toEqual(['retry', 'close'])
    expect(kinds({ kind: 'unknown-exit' }, true)).toEqual(['retry', 'exited', 'close'])
    expect(cardFor({ kind: 'resume-not-found' }, run, false)?.actions[0].label).toBe('Start a new session on codedev')
    expect(cardFor({ kind: 'agent-alive' }, run, false)?.actions[1].label).toBe('New terminal on codedev')
  })
})

describe('startSwitch', () => {
  it('runs nothing for a terminal, agent or account it doesn\'t know, or another agent\'s account', async () => {
    const { d, raw } = deps()
    await startSwitch('nope', 'acc_b', {}, d)
    await startSwitch('t1', 'gone', {}, d)
    await startSwitch('t1', 'cx', {}, d)
    useTerminalStore.setState({ terminals: [{ ...T, agentCommand: undefined }] })
    await startSwitch('t1', 'acc_b', {}, d)
    useTerminalStore.setState({ terminals: [T], accountsView: null })
    await startSwitch('t1', 'acc_b', {}, d)
    expect(raw.accounts.check).not.toHaveBeenCalled()
    expect(raw.accounts.switchAccount).not.toHaveBeenCalled()
    expect(st().switchRuns).toEqual({})
  })

  it('checks the target\'s sign-in, shows the steps as main reports them, and ends with the toast and Switch back', async () => {
    const { d, raw, off } = deps({ progress: [{ terminalId: 'other', step: 'waiting' }, { terminalId: 't1', step: 'typing' }] })
    const seen: SwitchRun[] = []
    // Each new state of the run, as the pane would draw it.
    const unsub = useTerminalStore.subscribe((s) => { if (s.switchRuns.t1 && s.switchRuns.t1 !== seen[seen.length - 1]) seen.push(s.switchRuns.t1) })
    await startSwitch('t1', 'acc_b', {}, d)
    unsub()
    expect(raw.accounts.check).toHaveBeenCalledWith('acc_b')
    expect(seen.map((r) => [r.status, r.steps.join()])).toEqual([
      ['checking', 'pending,pending,pending'],
      ['running', 'working,pending,pending'],
      // Another terminal's progress moves nothing here.
      ['running', 'done,working,pending'],
      ['done', 'done,done,done'],
    ])
    expect(raw.accounts.switchAccount).toHaveBeenCalledWith({ terminalId: 't1', targetId: 'acc_b', shellType: 'gitbash', reason: 'by hand' })
    expect(st().switchRuns.t1).toMatchObject({
      from: { id: 'acc_a', label: 'personal' }, to: { id: 'acc_b', label: 'codedev' },
      toast: { text: 'Claude Code is on codedev now. Conversation resumed.', until: 1_000 + TOAST_MS, back: 'acc_a' },
    })
    // The terminal is free again, the progress listener gone, and the accounts read anew.
    expect(st().relaunching).toEqual({})
    expect(off).toHaveBeenCalled()
    expect(raw.accounts.list).toHaveBeenCalled()
    expect(noteWorkerSwitched).not.toHaveBeenCalled()
  })

  it('drops the toast at its time, but never a switch that took its place', async () => {
    vi.useFakeTimers()
    const { d } = deps()
    await startSwitch('t1', 'acc_b', {}, d)
    expect(st().switchRuns.t1.status).toBe('done')
    await vi.advanceTimersByTimeAsync(TOAST_MS - 1)
    expect(st().switchRuns.t1.status).toBe('done')
    await vi.advanceTimersByTimeAsync(1)
    expect(st().switchRuns).toEqual({})
    // A second switch whose toast shows when the first one's time comes: it stays.
    await startSwitch('t1', 'acc_a', {}, d)
    const first = st().switchRuns.t1
    useTerminalStore.setState({ switchRuns: { t1: { ...first, toast: { ...first.toast!, until: first.toast!.until + 5 } } } })
    await vi.advanceTimersByTimeAsync(TOAST_MS)
    expect(st().switchRuns.t1).toBeDefined()
    // And none at all when it went already.
    useTerminalStore.setState({ switchRuns: {} })
    await startSwitch('t1', 'acc_b', {}, d)
    useTerminalStore.setState({ switchRuns: {} })
    await vi.advanceTimersByTimeAsync(TOAST_MS)
    expect(st().switchRuns).toEqual({})
  })

  it('runs no second switch on a terminal while one runs, and none while a model change types there', async () => {
    const { d, raw } = deps()
    useTerminalStore.setState({ switchRuns: { t1: { terminalId: 't1', agent: 'claude', from: null, to: endpoint(B), reason: 'by hand', status: 'running', steps: ['working', 'pending', 'pending'], answers: {} } } })
    await startSwitch('t1', 'acc_b', {}, d)
    expect(raw.accounts.check).not.toHaveBeenCalled()
    useTerminalStore.setState({ switchRuns: {}, relaunching: { t1: 'model' } })
    await startSwitch('t1', 'acc_b', {}, d)
    expect(raw.accounts.check).not.toHaveBeenCalled()
    expect(st().switchRuns.t1).toMatchObject({ status: 'failed', card: { what: 'A model change or another switch is already running here.', now: 'Nothing was typed.', actions: [{ kind: 'retry' }, { kind: 'close' }] } })
    expect(st().relaunching).toEqual({ t1: 'model' })
  })

  it('types nothing toward a signed-out target: its card offers the sign-in, then the switch', async () => {
    const { d, raw } = deps({ check: { ...B, lastEmail: null, identity: { email: null, signedIn: false, checkedAt: 1, source: 'auth-status' } } })
    await startSwitch('t1', 'acc_b', {}, d)
    expect(raw.accounts.switchAccount).not.toHaveBeenCalled()
    expect(st().relaunching).toEqual({})
    expect(st().switchRuns.t1).toMatchObject({ status: 'failed', card: { what: 'codedev is signed out.', now: 'Nothing was typed.', actions: [{ kind: 'sign-in-and-switch', label: 'Sign in to codedev and switch' }, { kind: 'close' }] } })
  })

  it('asks before switching to a target whose sign-in it can\'t tell', async () => {
    // Neither the agent nor the profile names one.
    useTerminalStore.setState({ accountsView: view([A, { ...B, lastEmail: null }, CX]) })
    const { d, raw } = deps({ check: { ...B, lastEmail: null } })
    await startSwitch('t1', 'acc_b', {}, d)
    expect(raw.accounts.switchAccount).not.toHaveBeenCalled()
    expect(st().switchRuns.t1.card).toEqual({
      what: 'Termpolis couldn\'t tell whether codedev is signed in: Claude Code gave no answer.', now: 'Nothing was typed.',
      actions: [{ kind: 'anyway', label: 'Switch anyway' }, { kind: 'sign-in-and-switch', label: 'Sign in to codedev and switch' }, { kind: 'close', label: 'Close' }],
    })
  })

  it('takes a sign-in it was handed without asking, and a new session when that was the answer', async () => {
    const { d, raw } = deps({ outcome: { kind: 'fresh', why: 'asked' } })
    await startSwitch('t1', 'acc_b', { known: { kind: 'signed-in', email: null }, answers: { assumeExited: true, fresh: true }, reason: 'limit' }, d)
    expect(raw.accounts.check).not.toHaveBeenCalled()
    expect(raw.accounts.switchAccount).toHaveBeenCalledWith(expect.objectContaining({ assumeExited: true, fresh: true, reason: 'limit' }))
    expect(st().switchRuns.t1).toMatchObject({ status: 'done', fresh: true, toast: { text: 'Claude Code is on codedev now, in a new session.' } })
  })

  it('leaves no Switch back for a terminal whose account it didn\'t know', async () => {
    useTerminalStore.setState({ terminals: [{ ...T, agentAccountId: undefined }] })
    const { d } = deps()
    await startSwitch('t1', 'acc_b', {}, d)
    expect(st().switchRuns.t1).toMatchObject({ from: null, toast: { back: null } })
  })

  it('queues the switch when the agent got to work meanwhile, and shows nothing on the pane', async () => {
    useTerminalStore.setState({ queuedSwitches: { t1: { targetId: 'acc_b', reason: 'old' } } })
    const { d } = deps({ outcome: { kind: 'busy' } })
    await startSwitch('t1', 'acc_b', { reason: 'by hand' }, d)
    expect(st().switchRuns).toEqual({})
    expect(st().queuedSwitches).toEqual({ t1: { targetId: 'acc_b', reason: 'by hand' } })
  })

  it('turns a failure into its card, the step at work marked failed', async () => {
    const { d } = deps({ outcome: { kind: 'agent-alive' }, progress: [{ terminalId: 't1', step: 'typing' }] })
    await startSwitch('t1', 'acc_b', {}, d)
    expect(st().switchRuns.t1).toMatchObject({ status: 'failed', steps: ['done', 'failed', 'pending'], card: { now: 'Claude Code is still running here, on personal.' } })
    expect(st().relaunching).toEqual({})
  })

  it('tells a swarm worker\'s conductor how it went, and offers a worker no new terminal', async () => {
    const W: TerminalSession = { ...T, id: 'w1', agentCommand: undefined, isSwarm: true, swarmAgent: 'claude' }
    useTerminalStore.setState({ terminals: [W] })
    const { d } = deps({ outcome: { kind: 'unknown-exit' } })
    await startSwitch('w1', 'acc_b', {}, d)
    expect(noteWorkerSwitched).toHaveBeenCalledWith('w1', { kind: 'unknown-exit' }, { live: true })
    expect(liveRestartDeps).toHaveBeenCalled()
    expect(st().switchRuns.w1.card?.actions.map((a) => a.kind)).toEqual(['retry', 'exited', 'close'])
  })
})

describe('actOnRun: a card\'s or a toast\'s buttons', () => {
  const failed = (over: Partial<SwitchRun> = {}): SwitchRun => ({
    terminalId: 't1', agent: 'claude', from: endpoint(A), to: endpoint(B), reason: 'limit', status: 'failed',
    steps: ['failed', 'pending', 'pending'], answers: {}, card: { what: 'w', now: 'n', actions: [] }, ...over,
  })
  const put = (run: SwitchRun) => useTerminalStore.setState({ switchRuns: { t1: run } })

  it('does nothing without a run', async () => {
    const { d, raw } = deps()
    await actOnRun('t1', 'retry', d)
    expect(raw.accounts.switchAccount).not.toHaveBeenCalled()
  })

  it('switches again on the user\'s word that the agent exited, signed in as already checked', async () => {
    put(failed())
    const { d, raw } = deps()
    await actOnRun('t1', 'exited', d)
    expect(raw.accounts.check).not.toHaveBeenCalled()
    expect(raw.accounts.switchAccount).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'acc_b', assumeExited: true, reason: 'limit' }))
    expect(st().switchRuns.t1.status).toBe('done')
  })

  it('tries again from the start, sign-in check and all', async () => {
    put(failed())
    const { d, raw } = deps()
    await actOnRun('t1', 'retry', d)
    expect(raw.accounts.check).toHaveBeenCalledWith('acc_b')
    expect(raw.accounts.switchAccount).toHaveBeenCalledWith({ terminalId: 't1', targetId: 'acc_b', shellType: 'gitbash', reason: 'limit' })
  })

  it('starts a new session on the target, or switches anyway', async () => {
    put(failed())
    const { d, raw } = deps({ outcome: { kind: 'fresh', why: 'asked' } })
    await actOnRun('t1', 'fresh', d)
    expect(raw.accounts.switchAccount).toHaveBeenLastCalledWith(expect.objectContaining({ assumeExited: true, fresh: true }))
    put(failed())
    await actOnRun('t1', 'anyway', d)
    expect(raw.accounts.check).not.toHaveBeenCalled()
    expect(raw.accounts.switchAccount).toHaveBeenLastCalledWith({ terminalId: 't1', targetId: 'acc_b', shellType: 'gitbash', reason: 'limit' })
  })

  it('switches back to where the terminal was, from the toast', async () => {
    put(failed({ status: 'done', card: undefined, toast: { text: 't', until: 5, back: 'acc_a' } }))
    const { d, raw } = deps()
    await actOnRun('t1', 'back', d)
    expect(raw.accounts.switchAccount).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'acc_a', reason: 'switch back' }))
  })

  it('has no Switch back when it didn\'t know where the terminal was', async () => {
    const run = failed({ status: 'done', card: undefined, toast: { text: 't', until: 5, back: null } })
    put(run)
    const { d, raw } = deps()
    await actOnRun('t1', 'back', d)
    expect(raw.accounts.switchAccount).not.toHaveBeenCalled()
    expect(st().switchRuns.t1).toBe(run)
    put(failed({ toast: undefined }))
    await actOnRun('t1', 'back', d)
    expect(raw.accounts.switchAccount).not.toHaveBeenCalled()
  })

  it('opens the sign-in sheet, alone or with the switch after it', async () => {
    put(failed())
    const { d, raw } = deps()
    await actOnRun('t1', 'sign-in', d)
    expect(st().switchRuns).toEqual({})
    expect(st().signInSheet).toEqual({ accountId: 'acc_b' })
    put(failed())
    await actOnRun('t1', 'sign-in-and-switch', d)
    expect(st().switchRuns).toEqual({})
    const then = st().signInSheet?.then
    expect(st().signInSheet?.accountId).toBe('acc_b')
    then!()
    await vi.waitFor(() => expect(st().switchRuns.t1?.status).toBe('done'))
    // The sheet's sign-in is the check.
    expect(raw.accounts.check).not.toHaveBeenCalled()
    expect(raw.accounts.switchAccount).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'acc_b', reason: 'limit' }))
  })

  it('opens a new terminal on the target, when both are still there', async () => {
    put(failed())
    const { d, raw } = deps()
    await actOnRun('t1', 'new-terminal', d)
    expect(st().switchRuns).toEqual({})
    expect(raw.termpolis.createTerminal).toHaveBeenCalled()
    expect(st().activeTerminalId).toBe('new-1')
    put(failed({ to: { id: 'gone', label: 'gone', color: '#fff' } }))
    raw.termpolis.createTerminal.mockClear()
    await actOnRun('t1', 'new-terminal', d)
    expect(raw.termpolis.createTerminal).not.toHaveBeenCalled()
    expect(st().switchRuns).toEqual({})
  })

  it('closes', async () => {
    put(failed())
    await actOnRun('t1', 'close', deps().d)
    expect(st().switchRuns).toEqual({})
  })
})

describe('newTerminalOn (§7.4)', () => {
  it('opens the agent on the account beside the terminal, and goes there', async () => {
    const { d, raw } = deps()
    const r = await newTerminalOn(T, B, d)
    expect(r).toEqual({ ok: true, id: 'new-1' })
    expect(raw.termpolis.createTerminal).toHaveBeenCalledWith('new-1', 'gitbash', '/repo', undefined, true, expect.anything(), expect.anything())
    expect(st().terminals.map((t) => t.id)).toEqual(['t1', 'new-1'])
    expect(launchAgents).toHaveBeenCalledWith([{ id: 'new-1', agentCommand: 'claude', cwd: '/repo', shellType: 'gitbash', agentAccountId: 'acc_b' }])
    expect(st().activeTerminalId).toBe('new-1')
  })

  it('says why it couldn\'t, and stays', async () => {
    const { d, raw } = deps()
    raw.termpolis.createTerminal.mockResolvedValueOnce({ success: false, error: 'no shell' } as never)
    expect(await newTerminalOn(T, B, d)).toEqual({ ok: false, error: 'Termpolis couldn\'t open the terminal: no shell' })
    expect(st().memoryNotice).toBe('Termpolis couldn\'t open the terminal: no shell')
    expect(st().activeTerminalId).toBe('t1')
  })
})

describe('the queue: a busy agent\'s switch waits for its turn to end', () => {
  it('queues a switch', () => {
    queueSwitch('t1', 'acc_b')
    expect(st().queuedSwitches).toEqual({ t1: { targetId: 'acc_b', reason: 'by hand' } })
    queueSwitch('t1', 'acc_b', 'limit')
    expect(st().queuedSwitches.t1.reason).toBe('limit')
  })

  it('drops a switch whose terminal is gone, and keeps one whose agent is at work or can\'t be looked at', async () => {
    useTerminalStore.setState({ queuedSwitches: { gone: { targetId: 'acc_b', reason: 'r' }, t1: { targetId: 'acc_b', reason: 'r' } } })
    const { d, raw } = deps()
    raw.accounts.limitLook.mockResolvedValueOnce({ success: true, data: { live: true, status: { status: 'working' } } } as never)
    await processQueue(d)
    expect(st().queuedSwitches).toEqual({ t1: { targetId: 'acc_b', reason: 'r' } })
    raw.accounts.limitLook.mockResolvedValueOnce({ success: false, error: 'x' } as never)
    await processQueue(d)
    raw.accounts.limitLook.mockRejectedValueOnce(new Error('ipc gone'))
    await processQueue(d)
    expect(raw.accounts.switchAccount).not.toHaveBeenCalled()
    expect(st().queuedSwitches).toEqual({ t1: { targetId: 'acc_b', reason: 'r' } })
  })

  it('runs it once the agent is done, or its terminal no longer shows it live', async () => {
    useTerminalStore.setState({ queuedSwitches: { t1: { targetId: 'acc_b', reason: 'r' } } })
    const { d, raw } = deps()
    raw.accounts.limitLook.mockResolvedValueOnce({ success: true, data: { live: false, status: { status: 'working' } } } as never)
    await processQueue(d)
    expect(raw.accounts.switchAccount).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'acc_b', reason: 'r' }))
    expect(st().queuedSwitches).toEqual({})
    expect(st().switchRuns.t1.status).toBe('done')
  })

  it('looks every QUEUE_POLL_MS while something waits, one look at a time, until stopped', async () => {
    vi.useFakeTimers()
    const { d, raw } = deps()
    let release!: () => void
    raw.accounts.limitLook.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ success: true, data: { live: true, status: { status: 'working' } } } as never) }))
    const made = vi.fn(() => d)
    const stop = installSwitchQueue(made)
    await vi.advanceTimersByTimeAsync(QUEUE_POLL_MS)
    expect(made).not.toHaveBeenCalled()
    useTerminalStore.setState({ queuedSwitches: { t1: { targetId: 'acc_b', reason: 'r' } } })
    await vi.advanceTimersByTimeAsync(QUEUE_POLL_MS)
    expect(raw.accounts.limitLook).toHaveBeenCalledTimes(1)
    // A look still out: the next tick waits for it.
    await vi.advanceTimersByTimeAsync(QUEUE_POLL_MS)
    expect(raw.accounts.limitLook).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(QUEUE_POLL_MS)
    expect(raw.accounts.limitLook).toHaveBeenCalledTimes(2)
    stop()
    release()
    await vi.advanceTimersByTimeAsync(QUEUE_POLL_MS * 3)
    expect(raw.accounts.limitLook).toHaveBeenCalledTimes(2)
  })
})

describe('liveRunDeps', () => {
  it('is the preload\'s bridges, the memory setting, the clock and new ids', () => {
    const accounts = { switchAccount: vi.fn() }
    const termpolis = { createTerminal: vi.fn() }
    ;(window as unknown as { accounts: unknown }).accounts = accounts
    ;(window as unknown as { termpolis: unknown }).termpolis = termpolis
    const d = liveRunDeps()
    expect(d.accounts).toBe(accounts)
    expect(d.termpolis).toBe(termpolis)
    expect(typeof d.primerEnabled()).toBe('boolean')
    expect(Math.abs(d.now() - Date.now())).toBeLessThan(1000)
    expect(d.newId()).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe("the second confirmation (D14, R17): an account that isn't offered automatically", () => {
  const WK = row({ id: 'acc_w', label: 'work', profile: '/h/.claude-w', folder: '/h/.claude-w', isDefault: false, order: 2, autoOffer: false })
  beforeEach(() => {
    useTerminalStore.setState({ accountsView: view([A, B, WK]), terminals: [T] })
  })

  it("sends the user's yes with the switch, and never sends one the user didn't give", async () => {
    const { d, raw } = deps()
    await startSwitch('t1', 'acc_w', { confirmed: true }, d)
    expect(raw.accounts.switchAccount).toHaveBeenLastCalledWith(expect.objectContaining({ targetId: 'acc_w', confirmedCarry: true }))
    st().dropSwitchRun('t1')
    useTerminalStore.setState({ terminals: [T] })
    await startSwitch('t1', 'acc_b', {}, d)
    expect(raw.accounts.switchAccount.mock.calls[1][0]).not.toHaveProperty('confirmedCarry')
  })

  it('keeps the yes through Try again, a sign-in first, and a wait for a busy agent', async () => {
    const { d, raw } = deps({ outcome: { kind: 'no-outcome' } })
    await startSwitch('t1', 'acc_w', { confirmed: true }, d)
    expect(st().switchRuns.t1.confirmed).toBe(true)
    await actOnRun('t1', 'retry', d)
    expect(raw.accounts.switchAccount).toHaveBeenLastCalledWith(expect.objectContaining({ targetId: 'acc_w', confirmedCarry: true }))
    // A sign-in first: the sheet continuation carries the yes too.
    useTerminalStore.setState({ switchRuns: { t1: { ...st().switchRuns.t1, status: 'failed', card: { what: 'w', now: 'n', actions: [] } } } })
    await actOnRun('t1', 'sign-in-and-switch', d)
    st().signInSheet!.then!()
    await vi.waitFor(() => expect(raw.accounts.switchAccount).toHaveBeenCalledTimes(3))
    expect(raw.accounts.switchAccount).toHaveBeenLastCalledWith(expect.objectContaining({ targetId: 'acc_w', confirmedCarry: true }))
    // A busy agent: it waits in the queue with the yes, and the queue runs it with the yes.
    const busy = deps({ outcome: { kind: 'busy' } })
    st().dropSwitchRun('t1')
    await startSwitch('t1', 'acc_w', { confirmed: true }, busy.d)
    expect(st().queuedSwitches.t1).toEqual({ targetId: 'acc_w', reason: 'by hand', confirmed: true })
    const next = deps()
    next.raw.accounts.limitLook.mockResolvedValue({ success: true, data: { live: true, status: { status: 'idle' } } } as never)
    await processQueue(next.d)
    expect(next.raw.accounts.switchAccount).toHaveBeenLastCalledWith(expect.objectContaining({ targetId: 'acc_w', confirmedCarry: true }))
  })

  it('queues a switch with the yes, or without one', () => {
    queueSwitch('t1', 'acc_w', 'by hand', true)
    expect(st().queuedSwitches.t1).toEqual({ targetId: 'acc_w', reason: 'by hand', confirmed: true })
    queueSwitch('t1', 'acc_b')
    expect(st().queuedSwitches.t1).toEqual({ targetId: 'acc_b', reason: 'by hand' })
  })

  it("offers Switch back only between accounts that are offered automatically", async () => {
    const { d } = deps()
    // personal -> codedev: both are, so back goes to personal.
    await startSwitch('t1', 'acc_b', {}, d)
    expect(st().switchRuns.t1.toast?.back).toBe('acc_a')
    st().dropSwitchRun('t1')
    // personal -> work: back would carry a conversation off work, which a toast cannot ask.
    useTerminalStore.setState({ terminals: [T] })
    await startSwitch('t1', 'acc_w', { confirmed: true }, d)
    expect(st().switchRuns.t1.toast?.back).toBeNull()
    st().dropSwitchRun('t1')
    // work -> personal: the same, the other way.
    useTerminalStore.setState({ terminals: [{ ...T, agentAccountId: 'acc_w' }] })
    await startSwitch('t1', 'acc_a', { confirmed: true }, d)
    expect(st().switchRuns.t1.toast?.back).toBeNull()
  })
})

describe('a switch that landed on an expired sign-in has a way on (round 1)', () => {
  const SID = '3f2a9c1e-5b7d-4e8f-a012-3456789abcde'
  const run = { agent: 'claude' as const, to: endpoint(B), from: endpoint(A) }
  const kindsOf = (o: SwitchOutcome, worker = false): string[] => cardFor(o, run, worker)!.actions.map((a) => a.kind)

  it('offers to sign in and carry on in a new terminal, naming the conversation when it is known', () => {
    const withId = cardFor({ kind: 'sign-in', sessionId: SID }, run, false)!
    expect(withId.actions.map((a) => [a.kind, a.label])).toEqual([
      ['sign-in-and-continue', 'Sign in to codedev and continue the conversation in a new terminal'],
      ['sign-in', 'Sign in to codedev'],
      ['close', 'Close'],
    ])
    const without = cardFor({ kind: 'sign-in' }, run, false)!
    expect(without.actions[0]).toEqual({ kind: 'sign-in-and-continue', label: 'Sign in to codedev and open a new terminal' })
    // A swarm worker has no pane to continue in: it signs in and the conductor reassigns.
    expect(kindsOf({ kind: 'sign-in', sessionId: SID }, true)).toEqual(['sign-in', 'close'])
  })

  it('puts the safe answer first where the card asks whether the agent exited', () => {
    expect(kindsOf({ kind: 'unknown-exit' })).toEqual(['retry', 'exited', 'new-terminal', 'close'])
    expect(kindsOf({ kind: 'exit-unconfirmed' })).toEqual(['retry', 'exited', 'new-terminal', 'close'])
    // The shell is at its prompt there, so its "Try again" is the same asserted answer and stays first.
    expect(cardFor({ kind: 'didnt-start', line: 'x' }, run, false)!.actions[0]).toEqual({ kind: 'exited', label: 'Try again' })
  })

  async function signedOutRun() {
    useTerminalStore.setState({ accountsView: view([A, B]), terminals: [{ ...T, agentCommand: 'claude --model opus --dangerously-skip-permissions' }] })
    const { d, raw } = deps({ outcome: { kind: 'sign-in', sessionId: SID } })
    await startSwitch('t1', 'acc_b', {}, d)
    return { d, raw }
  }

  it('remembers the conversation the relaunch was resuming', async () => {
    await signedOutRun()
    expect(st().switchRuns.t1).toMatchObject({ status: 'failed', resumeId: SID })
    expect(st().switchRuns.t1.card!.actions[0].kind).toBe('sign-in-and-continue')
  })

  it('signs the account in from the sheet, then continues the conversation in a new terminal on it, its flags as they were', async () => {
    const { d, raw } = await signedOutRun()
    await actOnRun('t1', 'sign-in-and-continue', d)
    expect(st().switchRuns.t1).toBeUndefined()
    expect(st().signInSheet?.accountId).toBe('acc_b')
    expect(raw.termpolis.createTerminal).not.toHaveBeenCalled()
    st().signInSheet!.then!()
    await vi.waitFor(() => expect(raw.termpolis.createTerminal).toHaveBeenCalledTimes(1))
    const command = vi.mocked(launchAgents).mock.calls[0][0][0].agentCommand
    expect(command).toBe(`claude --model opus --dangerously-skip-permissions --resume ${SID}`)
    expect(raw.termpolis.createTerminal.mock.calls[0].slice(5)).toEqual(['acc_b', 'claude'])
    expect(st().terminals.find((t) => t.agentCommand === command)).toMatchObject({ agentAccountId: 'acc_b' })
  })

  it('opens a fresh session when no conversation was named', async () => {
    useTerminalStore.setState({ accountsView: view([A, B]), terminals: [T] })
    const { d, raw } = deps({ outcome: { kind: 'sign-in' } })
    await startSwitch('t1', 'acc_b', {}, d)
    expect(st().switchRuns.t1.resumeId).toBeUndefined()
    await actOnRun('t1', 'sign-in-and-continue', d)
    st().signInSheet!.then!()
    await vi.waitFor(() => expect(raw.termpolis.createTerminal).toHaveBeenCalledTimes(1))
    expect(vi.mocked(launchAgents).mock.calls[0][0][0].agentCommand).toBe('claude')
  })

  it('does nothing once the terminal or the account is gone when the sign-in ends', async () => {
    const { d, raw } = await signedOutRun()
    await actOnRun('t1', 'sign-in-and-continue', d)
    useTerminalStore.setState({ accountsView: view([A]) })
    st().signInSheet!.then!()
    await new Promise((r) => setTimeout(r, 0))
    expect(raw.termpolis.createTerminal).not.toHaveBeenCalled()
  })
})

describe('a queued switch while a model change holds the terminal (round 1)', () => {
  beforeEach(() => {
    useTerminalStore.setState({ accountsView: view([A, B]), terminals: [T], relaunching: {}, queuedSwitches: {}, switchRuns: {} })
  })

  it('waits for the next look instead of being deleted, and nothing is typed or shown meanwhile', async () => {
    const { d, raw } = deps()
    queueSwitch('t1', 'acc_b', 'by hand', true)
    expect(st().beginRelaunch('t1', 'model')).toBe(true)
    await processQueue(d)
    expect(raw.accounts.switchAccount).not.toHaveBeenCalled()
    expect(raw.accounts.check).not.toHaveBeenCalled()
    expect(st().queuedSwitches.t1).toEqual({ targetId: 'acc_b', reason: 'by hand', confirmed: true })
    expect(st().switchRuns.t1).toBeUndefined()
    // The model change is over: the next look runs it.
    st().endRelaunch('t1')
    await processQueue(d)
    expect(raw.accounts.switchAccount).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'acc_b', confirmedCarry: true }))
    expect(st().queuedSwitches).toEqual({})
  })

  it('keeps the queued switch when a start is refused because the terminal is held, and says Try again', async () => {
    const { d } = deps()
    queueSwitch('t1', 'acc_b')
    expect(st().beginRelaunch('t1', 'account')).toBe(true)
    await startSwitch('t1', 'acc_b', {}, d)
    // The refusal is the card's; the request is not lost with it.
    expect(st().queuedSwitches.t1).toEqual({ targetId: 'acc_b', reason: 'by hand' })
    expect(st().switchRuns.t1.card).toMatchObject({ what: 'A model change or another switch is already running here.', actions: [{ kind: 'retry', label: 'Try again' }, { kind: 'close' }] })
    // Try again once it is free runs the switch.
    st().endRelaunch('t1')
    const again = deps()
    await actOnRun('t1', 'retry', again.d)
    expect(again.raw.accounts.switchAccount).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'acc_b' }))
  })

  it('drops the queued switch only once it really starts', async () => {
    const { d, raw } = deps()
    queueSwitch('t1', 'acc_b')
    await startSwitch('t1', 'acc_b', {}, d)
    expect(raw.accounts.switchAccount).toHaveBeenCalledTimes(1)
    expect(st().queuedSwitches).toEqual({})
  })
})
