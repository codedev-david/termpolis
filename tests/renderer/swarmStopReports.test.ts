import { describe, it, expect, vi, beforeEach } from 'vitest'
import { noteWorkerStatus } from '../../src/renderer/src/lib/swarmStopReports'

// GitHub #36 item 5: a worker a usage limit or a menu stopped is reported to the conductor once per
// stop, not on every read of its screen.

const LIMIT = { status: 'blocked' as const, summary: 'usage limit reached (resets 3:04 PM)' }
const MENU = { status: 'blocked' as const, summary: 'waiting on a menu: Codex asks whether to switch to a model that uses fewer credits' }
const WORKING = { status: 'working' as const, summary: 'Working' }

let n = 0
/** A worker of its own: the module remembers each terminal's stop. */
const worker = () => ({ terminalId: `w${++n}`, agentName: 'Codex', role: 'Tests' })

beforeEach(() => {
  ;(window as any).swarmAPI = {
    sendMessage: vi.fn().mockResolvedValue({ success: true }),
    getTasks: vi.fn().mockResolvedValue({ success: true, data: [] }),
  }
})

describe('noteWorkerStatus', () => {
  it('tells the conductor once when a usage limit stops a worker, however often it is read', async () => {
    const w = worker()
    for (let i = 0; i < 5; i++) await noteWorkerStatus(w, LIMIT)
    expect(window.swarmAPI.sendMessage).toHaveBeenCalledTimes(1)
    // To the conductor, not to all: swarm_read_messages marks a broadcast read for every reader,
    // so a Claude worker reading the bus first took it. And the worker is to be closed first: a
    // Claude Code that waits out its limit carries on by itself, on a task now someone else's.
    expect(window.swarmAPI.sendMessage).toHaveBeenCalledWith(
      'system',
      'conductor',
      'info',
      `Codex (Tests, terminal ${w.terminalId}) is blocked: usage limit reached (resets 3:04 PM). ` +
        'Close its terminal, then give its task to another installed agent.',
    )
  })

  it('tells it once while only the reset time redraws: the same stop, counting down', async () => {
    const w = worker()
    await noteWorkerStatus(w, { status: 'blocked', summary: 'usage limit reached (resets in 4h 59m)' })
    await noteWorkerStatus(w, { status: 'blocked', summary: 'usage limit reached (resets in 4h 58m)' })
    await noteWorkerStatus(w, { status: 'blocked', summary: 'usage limit reached' })
    expect(window.swarmAPI.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('tells it again when the worker stops again after getting going', async () => {
    const w = worker()
    await noteWorkerStatus(w, LIMIT)
    await noteWorkerStatus(w, WORKING)
    await noteWorkerStatus(w, LIMIT)
    expect(window.swarmAPI.sendMessage).toHaveBeenCalledTimes(2)
  })

  it('tells it when what stops the worker changes: a menu, then the limit', async () => {
    const w = worker()
    await noteWorkerStatus(w, MENU)
    await noteWorkerStatus(w, MENU)
    await noteWorkerStatus(w, LIMIT)
    expect(window.swarmAPI.sendMessage).toHaveBeenCalledTimes(2)
    expect((window.swarmAPI.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][3]).toContain('is blocked: waiting on a menu: Codex asks')
  })

  // A menu takes a key press, and the worker carries on with what it did so far. Closed, it lost
  // that, and a Codex started in its place opened on the same update offer.
  it('tells the conductor to answer a menu, not to close the worker', async () => {
    const w = worker()
    await noteWorkerStatus(w, MENU)
    expect((window.swarmAPI.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][3]).toBe(
      `Codex (Tests, terminal ${w.terminalId}) is blocked: waiting on a menu: Codex asks whether to switch to a model that uses fewer credits. ` +
        'Answer it as STEP 6 says, without submit: "Keep current model" is the second option (Down, then Enter: \\u001b[B\\r). ' +
        'Then send its task again with submit=true if it never got it. Give its task to another installed agent only if the menu stays.',
    )
  })

  it("names the answer to Codex's update offer: skip it until the next version", async () => {
    const w = worker()
    await noteWorkerStatus(w, { status: 'blocked', summary: 'waiting on a menu: Codex offers to update itself' })
    const sent = (window.swarmAPI.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][3] as string
    expect(sent).toContain('"Skip until next version" is the third option (Down, Down, then Enter: \\u001b[B\\u001b[B\\r)')
    expect(sent).not.toMatch(/Close its terminal/)
  })

  it('tells it to answer a menu it has no answer for, as the agent shows it', async () => {
    const w = worker()
    await noteWorkerStatus(w, { status: 'blocked', summary: 'waiting on a menu: something new' })
    expect((window.swarmAPI.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][3]).toContain(
      'is blocked: waiting on a menu: something new. Answer it as STEP 6 says, without submit: read it with read_output first.',
    )
  })

  it('names the task assigned to the worker, when one is', async () => {
    const w = worker()
    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: [
        { id: 'done-1', title: 'Old', assignedTo: w.terminalId, status: 'completed' },
        { id: 'other', title: 'Not its', assignedTo: 'someone-else', status: 'in_progress' },
        { id: 't7', title: 'Write the tests', assignedTo: w.terminalId, status: 'in_progress' },
      ],
    })
    await noteWorkerStatus(w, LIMIT)
    expect((window.swarmAPI.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][3]).toBe(
      `Codex (Tests, terminal ${w.terminalId}) is blocked: usage limit reached (resets 3:04 PM). Its task is "Write the tests" (taskId t7). ` +
        'Close its terminal, then give its task to another installed agent.',
    )
  })

  it('reports no stop for what is not a limit or a menu: a restart, a question, work', async () => {
    const w = worker()
    await noteWorkerStatus(w, { status: 'blocked', summary: 'Codex needs restart' })
    await noteWorkerStatus(w, { status: 'waiting_for_input', summary: 'Allow?' })
    await noteWorkerStatus(w, WORKING)
    expect(window.swarmAPI.sendMessage).not.toHaveBeenCalled()
    expect(window.swarmAPI.getTasks).not.toHaveBeenCalled()
  })

  it('still reports when the tasks can\'t be read, and doesn\'t throw when the message can\'t be sent', async () => {
    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ipc down')).mockResolvedValueOnce({ success: false })
    await noteWorkerStatus(worker(), LIMIT)
    await noteWorkerStatus(worker(), LIMIT)
    expect(window.swarmAPI.sendMessage).toHaveBeenCalledTimes(2)
    ;(window.swarmAPI.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('bus down'))
    await expect(noteWorkerStatus(worker(), LIMIT)).resolves.toBeUndefined()
  })
})
