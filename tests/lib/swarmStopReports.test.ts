// What the swarm tells the conductor of a stopped worker, once per stop (src/renderer/src/lib/swarmStopReports.ts):
// the report with the worker's task, a stop forgotten after quiet reads or work, and a stop carried across a
// restart, which only work ends (R4). The swarm bus is a stub: messages are what the conductor would read.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  CARRIED_WORKING_READS, READS_TO_CLEAR, _resetStopReportsForTest, carryIfStopped, carryWorkerStop, isStopCarried, noteWorkerStatus, reportWorkerStop, setSwarmWorkingAgain, stopMark,
} from '../../src/renderer/src/lib/swarmStopReports'

const W = { terminalId: 'w1', agentName: 'Claude', role: 'Build UI' }
const LIMIT = { status: 'blocked' as const, summary: 'usage limit reached (resets 3pm)' }
const IDLE = { status: 'idle' as const, summary: 'Waiting at prompt' }
const WORKING = { status: 'working' as const, summary: 'Thinking' }

let sendMessage: ReturnType<typeof vi.fn>
let tasks: Array<{ id: string; title: string; assignedTo: string; status: string }>
const sent = (): string[] => sendMessage.mock.calls.map((c) => c[3] as string)

beforeEach(() => {
  _resetStopReportsForTest()
  tasks = []
  sendMessage = vi.fn(async () => ({ success: true }))
  ;(window as unknown as { swarmAPI: unknown }).swarmAPI = { getTasks: vi.fn(async () => ({ success: true, data: tasks })), sendMessage }
})
afterEach(() => {
  delete (window as unknown as { swarmAPI?: unknown }).swarmAPI
})

describe('noteWorkerStatus: once per stop', () => {
  it('says nothing of a worker that shows no stop and never did', async () => {
    await noteWorkerStatus(W, IDLE)
    await noteWorkerStatus(W, WORKING)
    expect(sent()).toEqual([])
  })

  it('reports a stop once, though it is read again and again', async () => {
    await noteWorkerStatus(W, LIMIT)
    await noteWorkerStatus(W, LIMIT)
    await noteWorkerStatus(W, LIMIT)
    expect(sent()).toHaveLength(1)
    expect(sent()[0]).toContain('Claude (Build UI, terminal w1) is blocked: usage limit reached (resets 3pm).')
    expect(sent()[0]).toContain('close its terminal, then give its task to another installed agent')
  })

  it('forgets a stop after enough reads without it, and reports the next one as new', async () => {
    await noteWorkerStatus(W, LIMIT)
    // One quiet read is not enough: the screen can flicker (a resized worker's screen is blank for a moment).
    for (let i = 0; i < READS_TO_CLEAR - 1; i++) await noteWorkerStatus(W, IDLE)
    await noteWorkerStatus(W, LIMIT)
    expect(sent()).toHaveLength(1)
    for (let i = 0; i < READS_TO_CLEAR; i++) await noteWorkerStatus(W, IDLE)
    await noteWorkerStatus(W, LIMIT)
    expect(sent()).toHaveLength(2)
  })

  it('ends a stop when the worker is seen at work, tells the hook, and survives a hook that throws', async () => {
    const hook = vi.fn(async () => { throw new Error('bridge missing') })
    setSwarmWorkingAgain(hook)
    await noteWorkerStatus(W, LIMIT)
    await expect(noteWorkerStatus(W, WORKING)).resolves.toBeUndefined()
    expect(hook).toHaveBeenCalledWith(W)
    await noteWorkerStatus(W, LIMIT)
    expect(sent()).toHaveLength(2)
    setSwarmWorkingAgain(null)
  })
})

describe('a stop carried across a restart (R4)', () => {
  it('is not forgotten by quiet reads, and not reported again while the worker took no turn', async () => {
    let took = false
    carryWorkerStop('w1', 'usage limit reached (resets 3pm)', async () => took)
    for (let i = 0; i < READS_TO_CLEAR * 3; i++) await noteWorkerStatus(W, IDLE)
    expect(await isStopCarried('w1')).toBe(true)
    await noteWorkerStatus(W, LIMIT)
    expect(sent()).toEqual([])
    // Once it has taken a turn, the same limit is a new stop.
    took = true
    expect(await isStopCarried('w1')).toBe(false)
    await noteWorkerStatus(W, LIMIT)
    expect(sent()).toHaveLength(1)
  })

  it('is ended by the worker seen at work for CARRIED_WORKING_READS reads in a row', async () => {
    carryWorkerStop('w1', 'usage limit reached (resets 3pm)', async () => false)
    for (let i = 0; i < CARRIED_WORKING_READS - 1; i++) await noteWorkerStatus(W, WORKING)
    expect(await isStopCarried('w1')).toBe(true)
    await noteWorkerStatus(W, WORKING)
    expect(await isStopCarried('w1')).toBe(false)
    await noteWorkerStatus(W, LIMIT)
    expect(sent()).toHaveLength(1)
  })

  // SWARM-R2 F6: the resumed session draws a frame that reads as work (its history half drawn, a repaint after a resize) before it
  // settles on its old limit. One such frame is no turn, and the limit drawn after it is still the one carried: the conductor is
  // not told to close the worker that was just restarted.
  it('is not ended by one frame that reads as work between two of its limit', async () => {
    carryWorkerStop('w1', 'usage limit reached (resets 3pm)', async () => false)
    await noteWorkerStatus(W, LIMIT)
    await noteWorkerStatus(W, WORKING)
    await noteWorkerStatus(W, LIMIT)
    expect(sent()).toEqual([])
    expect(await isStopCarried('w1')).toBe(true)
    // The run is counted afresh after it: one more frame at work, and still carried.
    await noteWorkerStatus(W, WORKING)
    expect(await isStopCarried('w1')).toBe(true)
    await noteWorkerStatus(W, LIMIT)
    expect(sent()).toEqual([])
  })

  it('does not count a quiet read between two at work as a run of them', async () => {
    carryWorkerStop('w1', 'usage limit reached (resets 3pm)', async () => false)
    await noteWorkerStatus(W, WORKING)
    await noteWorkerStatus(W, IDLE)
    await noteWorkerStatus(W, WORKING)
    expect(await isStopCarried('w1')).toBe(true)
    await noteWorkerStatus(W, WORKING)
    expect(await isStopCarried('w1')).toBe(false)
  })

  it('is carried by a worker switched by hand only if it shows a stop', async () => {
    carryIfStopped('w1', async () => false)
    expect(await isStopCarried('w1')).toBe(false)
    await noteWorkerStatus(W, LIMIT)
    carryIfStopped('w1', async () => false)
    expect(await isStopCarried('w1')).toBe(true)
  })
})

describe('reportWorkerStop: what the conductor reads', () => {
  it('names the task assigned to the worker that is still open, and none that is done or another\'s', async () => {
    tasks = [
      { id: 'old', title: 'Old', assignedTo: 'w1', status: 'completed' },
      { id: 'other', title: 'Other', assignedTo: 'w2', status: 'in_progress' },
      { id: 'mine', title: 'Build it', assignedTo: 'w1', status: 'in_progress' },
    ]
    await reportWorkerStop(W, LIMIT)
    expect(sent()[0]).toContain('Its task is "Build it" (taskId mine).')
    sendMessage.mockClear()
    tasks = [{ id: 'old', title: 'Old', assignedTo: 'w1', status: 'failed' }]
    await reportWorkerStop(W, LIMIT)
    expect(sent()[0]).not.toContain('Its task is')
  })

  it('goes on without a task when the bus cannot say, or throws', async () => {
    ;(window as unknown as { swarmAPI: { getTasks: unknown } }).swarmAPI.getTasks = vi.fn(async () => ({ success: false, error: 'x' }))
    await reportWorkerStop(W, LIMIT)
    expect(sent()[0]).not.toContain('Its task is')
    sendMessage.mockClear()
    ;(window as unknown as { swarmAPI: { getTasks: unknown } }).swarmAPI.getTasks = vi.fn(async () => { throw new Error('bus down') })
    await reportWorkerStop(W, LIMIT)
    expect(sent()).toHaveLength(1)
  })

  it('tells the conductor to answer a menu, with the keys its screen shows when no answer is known for it', async () => {
    await reportWorkerStop(W, { status: 'blocked', summary: 'waiting on a menu: something Termpolis has no answer for' })
    expect(sent()[0]).toContain('if the menu is there, answer it as STEP 6 says, without submit, with the keys its screen shows for the option to pick.')
    expect(sent()[0]).not.toContain('close its terminal')
  })

  it('does not reject when the bus is gone', async () => {
    sendMessage.mockRejectedValue(new Error('bus down'))
    await expect(reportWorkerStop(W, LIMIT)).resolves.toBeUndefined()
  })
})

// SWARM-R2 F3: the offer asks whether the stop it began for is still on record once its awaits are done.
describe('stopMark: the stop a worker is on, as a mark that changes when it ends or is replaced', () => {
  it('is none for a worker with no stop, the same while the same stop stays on, and another once it ended and a new one began', async () => {
    expect(stopMark('w1')).toBeUndefined()
    await noteWorkerStatus(W, LIMIT)
    const first = stopMark('w1')
    expect(first).toBeDefined()
    await noteWorkerStatus(W, LIMIT)
    expect(stopMark('w1')).toBe(first)
    await noteWorkerStatus(W, WORKING)
    expect(stopMark('w1')).toBeUndefined()
    await noteWorkerStatus(W, LIMIT)
    expect(stopMark('w1')).toBeDefined()
    expect(stopMark('w1')).not.toBe(first)
    expect(stopMark('w2')).toBeUndefined()
  })
})
