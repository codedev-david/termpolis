import { describe, it, expect } from 'vitest'
import { createStatusPump, type TerminalSnapshot } from '../../src/main/remoteStatusPump'
import type { AgentStatus, AgentStatusResult } from '../../src/shared/agentStatusDetector'
import { detectAgentStatus } from '../../src/shared/agentStatusDetector'

/** A hand-driven clock, the same shape the output pump's tests use. The point of
 *  a pump is WHEN it sends as much as what, and a real timer turns every one of
 *  those assertions into a race. */
function fakeTimers() {
  let pending: (() => void) | null = null
  let handle = 0
  let live = 0
  let lastDelay = -1
  const cleared: unknown[] = []
  return {
    get pendingCount() {
      return live
    },
    get lastDelay() {
      return lastDelay
    },
    cleared,
    setTimer(fn: () => void, ms: number) {
      live++
      pending = fn
      lastDelay = ms
      return ++handle
    },
    clearTimer(h: unknown) {
      cleared.push(h)
      live--
      pending = null
    },
    tick() {
      const fn = pending
      pending = null
      if (fn) live--
      fn?.()
    },
  }
}

/** A detector that answers from a lookup table rather than from the real rule
 *  set. The rules have their own tests; what this file is about is the pump's
 *  decisions -- when to detect, when to send, what to remember. */
function fakeWorld() {
  const terminals: Record<string, TerminalSnapshot> = {}
  const answers: Record<string, AgentStatusResult> = {}
  const sent: { terminalId: string; status: AgentStatus; summary: string }[] = []
  const detected: { output: string; name: string; previous: AgentStatus }[] = []
  return {
    terminals,
    answers,
    sent,
    detected,
    /** Set what a terminal's buffer holds, and what the detector will say of it. */
    say(terminalId: string, output: string, result: AgentStatusResult, name = 'claude') {
      terminals[terminalId] = { output, name }
      answers[output] = result
    },
    read: (terminalId: string) => terminals[terminalId] ?? null,
    detect: (output: string, name: string, previous: AgentStatus): AgentStatusResult => {
      detected.push({ output, name, previous })
      return answers[output] ?? { status: 'idle', summary: '' }
    },
    send: (terminalId: string, result: AgentStatusResult) => {
      sent.push({ terminalId, status: result.status, summary: result.summary })
    },
  }
}

function harness(intervalMs?: number) {
  const timers = fakeTimers()
  const world = fakeWorld()
  const pump = createStatusPump({
    read: world.read,
    detect: world.detect,
    send: world.send,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...(intervalMs === undefined ? {} : { intervalMs }),
  })
  return { pump, timers, world }
}

const THINKING: AgentStatusResult = { status: 'thinking', summary: 'Thinking' }
const WAITING: AgentStatusResult = { status: 'waiting_for_input', summary: 'Continue?' }

describe('remote status pump', () => {
  it('sends a terminal its status the moment a phone subscribes', () => {
    // Not on the next tick. This fires when the user opens a terminal on the
    // phone, and a second of blank label on a screen they just tapped reads as
    // the feature being broken rather than as the feature being fast.
    const { pump, world, timers } = harness()
    world.say('t1', 'buffer', THINKING)

    pump.setSubscriptions(['t1'])

    expect(world.sent).toEqual([{ terminalId: 't1', status: 'thinking', summary: 'Thinking' }])
    expect(timers.pendingCount).toBe(0)
  })

  it('says nothing about a terminal with no buffer', () => {
    // Reporting `starting` off an empty string would be a guess printed as a
    // reading, and the phone has no way to tell the two apart.
    const { pump, world } = harness()

    pump.setSubscriptions(['ghost'])

    expect(world.sent).toEqual([])
    expect(world.detected).toEqual([])
  })

  it('re-detects on output, and sends only when the answer moved', () => {
    const { pump, world, timers } = harness()
    world.say('t1', 'first', THINKING)
    pump.setSubscriptions(['t1'])
    expect(world.sent).toHaveLength(1)

    // Same answer from different bytes: the phone already shows "Thinking", so a
    // second frame saying so is a wasted relay frame out of a burst budget the
    // user's typing also spends.
    world.say('t1', 'second', THINKING)
    pump.markDirty('t1')
    timers.tick()
    expect(world.sent).toHaveLength(1)

    world.say('t1', 'third', WAITING)
    pump.markDirty('t1')
    timers.tick()
    expect(world.sent).toEqual([
      { terminalId: 't1', status: 'thinking', summary: 'Thinking' },
      { terminalId: 't1', status: 'waiting_for_input', summary: 'Continue?' },
    ])
  })

  it('treats a changed summary under an unchanged status as news', () => {
    // "waiting_for_input" is the same state whether the question is "Continue?"
    // or "Overwrite main?" -- and the second is the one the user needs to read.
    const { pump, world, timers } = harness()
    world.say('t1', 'a', WAITING)
    pump.setSubscriptions(['t1'])

    world.say('t1', 'b', { status: 'waiting_for_input', summary: 'Overwrite main?' })
    pump.markDirty('t1')
    timers.tick()

    expect(world.sent.map((s) => s.summary)).toEqual(['Continue?', 'Overwrite main?'])
  })

  it('feeds the previous status back into the detector', () => {
    // The real detector takes it as a third argument and uses it to hold a state
    // that its own rules cannot re-derive from the tail alone.
    const { pump, world, timers } = harness()
    world.say('t1', 'a', THINKING)
    pump.setSubscriptions(['t1'])
    world.say('t1', 'b', WAITING)
    pump.markDirty('t1')
    timers.tick()

    expect(world.detected.map((d) => d.previous)).toEqual(['starting', 'thinking'])
  })

  it('coalesces a burst of output into one detection', () => {
    // A held key is one PTY write per character. Detecting per write would run a
    // regex sweep over the whole window per keystroke, on the thread that also
    // pumps every terminal in the app.
    const { pump, world, timers } = harness()
    world.say('t1', 'x', THINKING)
    pump.setSubscriptions(['t1'])
    world.detected.length = 0

    world.say('t1', 'y', WAITING)
    for (let i = 0; i < 50; i++) pump.markDirty('t1')
    expect(timers.pendingCount).toBe(1)
    timers.tick()

    expect(world.detected).toHaveLength(1)
  })

  it('waits a second between passes, not the output pump\'s 50 ms', () => {
    const { pump, world, timers } = harness()
    world.say('t1', 'x', THINKING)
    pump.setSubscriptions(['t1'])
    pump.markDirty('t1')
    expect(timers.lastDelay).toBe(1000)
  })

  it('ignores output from a terminal nobody is watching', () => {
    // The dirty set is filtered on the way in rather than at flush time: an idle
    // window with fifty terminals and one phone attached must not grow a
    // fifty-entry set, nor arm a timer for it.
    const { pump, world, timers } = harness()
    world.say('t9', 'busy', THINKING)

    pump.markDirty('t9')

    expect(timers.pendingCount).toBe(0)
    timers.tick()
    expect(world.sent).toEqual([])
  })

  it('re-announces a terminal that is subscribed to again', () => {
    // The phone coming back is a blank screen -- possibly a different phone --
    // so the unchanged answer is still news to it.
    const { pump, world, timers } = harness()
    world.say('t1', 'x', THINKING)
    pump.setSubscriptions(['t1'])
    pump.setSubscriptions([])
    pump.setSubscriptions(['t1'])

    expect(world.sent).toHaveLength(2)
    expect(timers.pendingCount).toBe(0)
  })

  it('drops a departing terminal from the pending pass', () => {
    const { pump, world, timers } = harness()
    world.say('t1', 'x', THINKING)
    world.say('t2', 'y', THINKING)
    pump.setSubscriptions(['t1', 't2'])
    world.sent.length = 0

    world.say('t1', 'x2', WAITING)
    pump.markDirty('t1')
    pump.setSubscriptions(['t2'])
    timers.tick()

    expect(world.sent).toEqual([])
  })

  it('forgets a closed terminal so a reused id starts clean', () => {
    // Ids are reused. A remembered answer under a dead one would suppress the new
    // terminal's first status as a duplicate of its predecessor's last.
    const { pump, world, timers } = harness()
    world.say('t1', 'x', THINKING)
    pump.setSubscriptions(['t1'])
    expect(world.sent).toHaveLength(1)

    pump.dropTerminal('t1')
    pump.markDirty('t1')
    timers.tick()

    expect(world.sent).toHaveLength(2)
    // The subscription itself deliberately survives: it is mirrored down from
    // the bridge, and clearing it here would leave the two out of step with no
    // message that ever puts them back.
    expect(world.sent[1]).toEqual({ terminalId: 't1', status: 'thinking', summary: 'Thinking' })
  })

  it('flushNow detects immediately and cancels the scheduled pass', () => {
    const { pump, world, timers } = harness()
    world.say('t1', 'x', THINKING)
    pump.setSubscriptions(['t1'])
    world.say('t1', 'y', WAITING)
    pump.markDirty('t1')

    pump.flushNow()

    expect(world.sent).toHaveLength(2)
    expect(timers.cleared).toHaveLength(1)
    expect(timers.pendingCount).toBe(0)
  })

  it('flushNow with nothing pending clears no timer', () => {
    const { pump, timers } = harness()
    pump.flushNow()
    expect(timers.cleared).toEqual([])
  })

  it('goes silent after stop, and stays silent', () => {
    // A pump still detecting into a bridge that has gone away is the shape of the
    // teardown hangs this project has already paid for once.
    const { pump, world, timers } = harness()
    world.say('t1', 'x', THINKING)
    pump.setSubscriptions(['t1'])
    pump.markDirty('t1')
    world.sent.length = 0

    pump.stop()

    expect(timers.cleared).toHaveLength(1)
    pump.setSubscriptions(['t1'])
    pump.markDirty('t1')
    timers.tick()
    expect(world.sent).toEqual([])
    expect(timers.pendingCount).toBe(0)
  })

  it('does not arm a second timer while one is already due', () => {
    const { pump, world, timers } = harness()
    world.say('t1', 'x', THINKING)
    world.say('t2', 'y', THINKING)
    pump.setSubscriptions(['t1', 't2'])

    pump.markDirty('t1')
    pump.markDirty('t2')

    expect(timers.pendingCount).toBe(1)
  })

  it('honours an injected interval', () => {
    const { pump, world, timers } = harness(25)
    world.say('t1', 'x', THINKING)
    pump.setSubscriptions(['t1'])
    pump.markDirty('t1')
    expect(timers.lastDelay).toBe(25)
  })

  it('drives the real detector end to end', () => {
    // Every other test here swaps the rule set out. This one keeps it, so the
    // wiring is checked against the function main actually passes in -- argument
    // order included, which no fake can catch.
    const timers = fakeTimers()
    const sent: { terminalId: string; status: AgentStatus; summary: string }[] = []
    const pump = createStatusPump({
      read: () => ({ output: 'Do you want to proceed?\n1. Yes\n2. No', name: 'claude' }),
      detect: detectAgentStatus,
      send: (terminalId, result) =>
        sent.push({ terminalId, status: result.status, summary: result.summary }),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    pump.setSubscriptions(['t1'])

    expect(sent).toHaveLength(1)
    expect(sent[0].status).toBe('waiting_for_input')
  })
})
