import { describe, it, expect, vi, beforeEach } from 'vitest'
import { noteWorkerStatus } from '../../src/renderer/src/lib/swarmStopReports'

// GitHub #36 item 5: a worker a usage limit or a menu stopped is reported to the conductor once per
// stop, not on every read of its screen.

const LIMIT = { status: 'blocked' as const, summary: 'usage limit reached (resets 3:04 PM)' }
const MENU = { status: 'blocked' as const, summary: 'waiting on a menu: Codex asks whether to switch to a model that uses fewer credits' }
const WORKING = { status: 'working' as const, summary: 'Working' }
const IDLE = { status: 'idle' as const, summary: 'Waiting at prompt' }
const THINKING = { status: 'thinking' as const, summary: 'Analyzing and generating response...' }

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
        'Check its screen with read_output first: if the limit is there, close its terminal, then give its task to another installed agent.',
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

  // MW1-3: while ConPTY repaints a resized screen, a stopped worker reads idle for a moment, or
  // thinking while no input box is drawn yet, and the next read shows the same stop: told twice.
  it.each([
    ['idle', IDLE],
    ['thinking', THINKING],
  ])('tells it once when one read between shows no stop, %s as a resized screen redraws', async (_name, between) => {
    const w = worker()
    await noteWorkerStatus(w, LIMIT)
    await noteWorkerStatus(w, between)
    await noteWorkerStatus(w, LIMIT)
    expect(window.swarmAPI.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('tells it again when the worker stops again after two reads in a row with no stop', async () => {
    const w = worker()
    await noteWorkerStatus(w, LIMIT)
    await noteWorkerStatus(w, IDLE)
    await noteWorkerStatus(w, THINKING)
    await noteWorkerStatus(w, LIMIT)
    expect(window.swarmAPI.sendMessage).toHaveBeenCalledTimes(2)
  })

  it('counts the reads with no stop only in a row: a read of the stop between starts them over', async () => {
    const w = worker()
    await noteWorkerStatus(w, LIMIT)
    await noteWorkerStatus(w, IDLE)
    await noteWorkerStatus(w, LIMIT)
    await noteWorkerStatus(w, IDLE)
    await noteWorkerStatus(w, LIMIT)
    expect(window.swarmAPI.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('keeps each worker\'s reads apart: another worker read with no stop forgets nothing of this one', async () => {
    const w1 = worker()
    const w2 = worker()
    await noteWorkerStatus(w1, LIMIT)
    await noteWorkerStatus(w2, IDLE)
    await noteWorkerStatus(w2, IDLE)
    await noteWorkerStatus(w1, IDLE)
    await noteWorkerStatus(w1, LIMIT)
    expect(window.swarmAPI.sendMessage).toHaveBeenCalledTimes(1)
  })

  // Several Claude workers on one account hit the limit together, and the poller reads them in
  // turn: each stopped worker's reads with no stop are its own (MR2-3).
  it("keeps each stopped worker's count apart while several are stopped, read in turn", async () => {
    const w1 = worker()
    const w2 = worker()
    await noteWorkerStatus(w1, LIMIT)
    await noteWorkerStatus(w2, LIMIT)
    await noteWorkerStatus(w1, IDLE)
    await noteWorkerStatus(w2, IDLE)
    await noteWorkerStatus(w1, IDLE)
    await noteWorkerStatus(w1, LIMIT)
    // w1 showed no stop on two reads in a row of its own, so its stop after them is another one;
    // w2's one read between counts for w2 only, so w2 read stopped again is the same stop.
    await noteWorkerStatus(w2, LIMIT)
    expect(window.swarmAPI.sendMessage).toHaveBeenCalledTimes(3)
  })

  // Each stopped worker's one read with no stop, while its resized screen is drawn again, is no
  // end of its stop, whichever other stopped worker is read between (MW1-3, MR2-3).
  it('keeps a stopped worker stopped after one read of its own with no stop, another stopped worker read between', async () => {
    const w1 = worker()
    const w2 = worker()
    await noteWorkerStatus(w1, LIMIT)
    await noteWorkerStatus(w2, LIMIT)
    await noteWorkerStatus(w1, IDLE)
    await noteWorkerStatus(w2, IDLE)
    await noteWorkerStatus(w2, LIMIT)
    await noteWorkerStatus(w1, LIMIT)
    expect(window.swarmAPI.sendMessage).toHaveBeenCalledTimes(2)
  })

  // A new stop counts its reads with no stop from 0: the one read after the stop before it is not
  // one of them (MR2-3, MW2-2).
  it('counts the reads with no stop from a new stop on: one read before it does not count toward forgetting it', async () => {
    const w = worker()
    await noteWorkerStatus(w, LIMIT)
    await noteWorkerStatus(w, IDLE)
    await noteWorkerStatus(w, MENU)
    await noteWorkerStatus(w, IDLE)
    await noteWorkerStatus(w, MENU)
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
        'Check its screen with read_output first: if the menu is there, answer it as STEP 6 says, without submit: "Keep current model" is the second option (Down, then Enter: \\u001b[B\\r). ' +
        'Then send its task again with submit=true if it never got it. Give its task to another installed agent only if the menu stays.',
    )
  })

  // A false report is worse than a missed one: told to act on a stop alone, the conductor closed a
  // healthy worker (GitHub #36). Both reports have it look first.
  it('tells the conductor to confirm the stop with read_output before it closes, answers or reassigns anything', async () => {
    const w1 = worker()
    const w2 = worker()
    await noteWorkerStatus(w1, LIMIT)
    await noteWorkerStatus(w2, MENU)
    for (const [, , , content] of (window.swarmAPI.sendMessage as ReturnType<typeof vi.fn>).mock.calls as string[][]) {
      const look = content.indexOf('Check its screen with read_output first')
      expect(look).toBeGreaterThan(0)
      expect(content.search(/close its terminal|answer it as STEP 6|another installed agent/i)).toBeGreaterThan(look)
    }
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
      'is blocked: waiting on a menu: something new. Check its screen with read_output first: if the menu is there, answer it as STEP 6 says, without submit, with the keys its screen shows for the option to pick.',
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
        'Check its screen with read_output first: if the limit is there, close its terminal, then give its task to another installed agent.',
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
