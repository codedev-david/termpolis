import { describe, it, expect } from 'vitest'
import { FORGET_FROM, OutputFanout, formatGapMarker } from '../../src/main/remoteBridge/outputFanout'

describe('OutputFanout', () => {
  it('delivers nothing to a device that never subscribed', () => {
    const f = new OutputFanout()
    f.ingest('t1', { output: 'hello', nextOffset: 5, missed: 0 })
    expect(f.drain('phone')).toEqual([])
  })

  it('delivers output for a subscribed terminal', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'hello', nextOffset: 5, missed: 0 })
    expect(f.drain('phone')).toEqual([{ terminalId: 't1', chunk: 'hello', missed: 0, marker: null, replaceFrom: null }])
  })

  it('drains exactly once', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'hello', nextOffset: 5, missed: 0 })
    f.drain('phone')
    expect(f.drain('phone')).toEqual([])
  })

  it('does not deliver terminals the device did not subscribe to', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.ingest('t2', { output: 'other', nextOffset: 5, missed: 0 })
    expect(f.drain('phone')).toEqual([])
  })

  it('fans the same output out to two devices independently', () => {
    const f = new OutputFanout()
    f.subscribe('a', 't1')
    f.subscribe('b', 't1')
    f.ingest('t1', { output: 'x', nextOffset: 1, missed: 0 })
    expect(f.drain('a')).toHaveLength(1)
    expect(f.drain('b')).toHaveLength(1)
  })

  it('propagates a missed count from the source slice', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'tail', nextOffset: 999, missed: 4200 })
    expect(f.drain('phone')[0].missed).toBe(4200)
  })

  it('evicts oldest chars past capacity and reports them as missed', () => {
    const f = new OutputFanout(10)
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'abcdefgh', nextOffset: 8, missed: 0 })
    f.ingest('t1', { output: 'ijklmn', nextOffset: 14, missed: 0 })

    const drained = f.drain('phone')
    const text = drained.map((d) => d.chunk).join('')
    const missed = drained.reduce((n, d) => n + d.missed, 0)

    expect(text.length).toBeLessThanOrEqual(10)
    expect(text.endsWith('ijklmn')).toBe(true)
    expect(missed).toBe(4)
  })

  it('stops delivering after unsubscribe', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.unsubscribe('phone', 't1')
    f.ingest('t1', { output: 'x', nextOffset: 1, missed: 0 })
    expect(f.drain('phone')).toEqual([])
  })

  it('drops all state for a revoked device', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'x', nextOffset: 1, missed: 0 })
    f.dropDevice('phone')
    expect(f.drain('phone')).toEqual([])
  })
})

describe('outputFanout — gap markers', () => {
  it('renders no marker when nothing was lost', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'all of it', nextOffset: 9, missed: 0 })
    expect(f.drain('phone')[0].marker).toBeNull()
  })

  it('renders a marker naming the amount when output was lost', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'tail', nextOffset: 999, missed: 4300 })
    const [chunk] = f.drain('phone')
    expect(chunk.missed).toBe(4300)
    expect(chunk.marker).toContain('4.2 KB')
    expect(chunk.marker).toContain('skipped')
  })

  it('reports small losses in chars rather than a misleading 0.0 KB', () => {
    expect(formatGapMarker(37)).toContain('37 chars')
    expect(formatGapMarker(37)).not.toContain('KB')
  })

  it('marks the chunk that eviction actually damaged', () => {
    const f = new OutputFanout(10)
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'abcdefgh', nextOffset: 8, missed: 0 })
    f.ingest('t1', { output: 'ijklmn', nextOffset: 14, missed: 0 })
    const drained = f.drain('phone')
    // 14 chars into a 10-char buffer: 4 evicted, and the surviving head says so.
    expect(drained[0].marker).toContain('4 chars')
    expect(drained.map((d) => d.chunk).join('')).toBe('efghijklmn')
  })

  // Two eviction shapes, and only one of them was exercised above. When the head
  // chunk fits ENTIRELY inside the overshoot it is dropped whole; when it straddles
  // the boundary it is sliced. Getting the whole-drop arm wrong loses a chunk's
  // worth of `missed` accounting, so the gap marker would understate the loss.
  it('drops a whole head chunk when it fits inside the overshoot, then slices the next', () => {
    const f = new OutputFanout(10)
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'abcd', nextOffset: 4, missed: 0 })
    f.ingest('t1', { output: 'efghijklmnop', nextOffset: 16, missed: 0 })

    const drained = f.drain('phone')
    const text = drained.map((d) => d.chunk).join('')
    const missed = drained.reduce((n, d) => n + d.missed, 0)

    expect(text).toBe('ghijklmnop')
    expect(text.length).toBe(10)
    expect(missed).toBe(6) // 'abcd' dropped whole + 'ef' sliced off the next
  })

  it('ignores an empty slice with nothing missed', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: '', nextOffset: 0, missed: 0 })
    expect(f.drain('phone')).toEqual([])
  })

  // A gap with no text still has to reach the device: 'nothing new, and you also
  // lost 40 chars' is information, and dropping it hides the loss entirely.
  it('delivers a slice that is empty but reports a loss', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: '', nextOffset: 40, missed: 40 })
    const [chunk] = f.drain('phone')
    expect(chunk.missed).toBe(40)
    expect(chunk.marker).toContain('40 chars')
  })

  // An empty chunk WITH an anchor is not nothing: the phone truncates its copy
  // to the anchor. It is how a screen that got shorter -- a menu closing, a
  // cleared line -- reaches the phone, and dropping it here left the old lines
  // showing under the new screen until something happened to draw over them.
  it('delivers an empty slice that takes text away', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: '', nextOffset: 9, missed: 0, replaceFrom: 4 })
    expect(f.drain('phone')).toEqual([
      { terminalId: 't1', chunk: '', missed: 0, replaceFrom: 4, marker: null },
    ])
  })

  it('keeps one queue per device across repeated subscribes', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'first', nextOffset: 5, missed: 0 })
    f.subscribe('phone', 't2') // same device, second terminal: must not reset the queue
    f.ingest('t2', { output: 'second', nextOffset: 6, missed: 0 })
    expect(f.drain('phone').map((c) => c.chunk)).toEqual(['first', 'second'])
  })
})

describe('OutputFanout.subscribedTerminals', () => {
  it('starts empty', () => {
    expect(new OutputFanout().subscribedTerminals()).toEqual([])
  })

  it('reports the union across devices, without duplicates', () => {
    // Main pumps a terminal if ANY phone is watching it. A per-device list would
    // make the caller do the union, and doing it twice is how the two drift.
    const f = new OutputFanout()
    f.subscribe('a', 't1')
    f.subscribe('a', 't2')
    f.subscribe('b', 't2')
    f.subscribe('b', 't3')
    expect(f.subscribedTerminals().sort()).toEqual(['t1', 't2', 't3'])
  })

  it('keeps a terminal while another device still watches it', () => {
    const f = new OutputFanout()
    f.subscribe('a', 't1')
    f.subscribe('b', 't1')
    f.unsubscribe('a', 't1')
    expect(f.subscribedTerminals()).toEqual(['t1'])
  })

  it('drops a terminal when its last subscriber leaves', () => {
    const f = new OutputFanout()
    f.subscribe('a', 't1')
    f.unsubscribe('a', 't1')
    expect(f.subscribedTerminals()).toEqual([])
  })

  it('drops every device on dropAll', () => {
    // Shutdown only. A subscription that outlives the bridge keeps main pumping
    // PTY output into a process that is no longer there.
    const f = new OutputFanout()
    f.subscribe('a', 't1')
    f.subscribe('b', 't2')
    f.dropAll()
    expect(f.subscribedTerminals()).toEqual([])
  })

  it('drops everything a revoked device was watching', () => {
    // Revoking has to stop the output, not just the requests. A terminal left in
    // the union would keep main serialising PTY output for a phone that is gone.
    const f = new OutputFanout()
    f.subscribe('a', 't1')
    f.subscribe('b', 't2')
    f.dropDevice('a')
    expect(f.subscribedTerminals()).toEqual(['t2'])
  })
})

describe('who is watching what', () => {
  it('names the devices subscribed to one terminal', () => {
    const f = new OutputFanout()
    f.subscribe('a', 't1')
    f.subscribe('b', 't1')
    f.subscribe('c', 't2')
    expect(f.subscribersOf('t1').sort()).toEqual(['a', 'b'])
    expect(f.subscribersOf('t2')).toEqual(['c'])
  })

  it('names nobody for a terminal nobody watches', () => {
    // The empty answer is the authorisation answer: a status push for an
    // unwatched terminal goes to no one rather than to everyone.
    const f = new OutputFanout()
    f.subscribe('a', 't1')
    expect(f.subscribersOf('t9')).toEqual([])
  })

  it('forgets a device the moment it is dropped', () => {
    const f = new OutputFanout()
    f.subscribe('a', 't1')
    f.dropDevice('a')
    expect(f.subscribersOf('t1')).toEqual([])
    expect(f.terminalsOf('a')).toEqual([])
  })

  it('names the terminals one device is watching', () => {
    const f = new OutputFanout()
    f.subscribe('a', 't1')
    f.subscribe('a', 't2')
    f.subscribe('b', 't3')
    expect(f.terminalsOf('a').sort()).toEqual(['t1', 't2'])
  })

  it('names nothing for a device that never subscribed', () => {
    expect(new OutputFanout().terminalsOf('ghost')).toEqual([])
  })

  it('drops a terminal from the device that unsubscribed and no other', () => {
    const f = new OutputFanout()
    f.subscribe('a', 't1')
    f.subscribe('b', 't1')
    f.unsubscribe('a', 't1')
    expect(f.subscribersOf('t1')).toEqual(['b'])
    expect(f.terminalsOf('a')).toEqual([])
  })
})

// The screen for a phone that opens a terminal somebody else is already
// watching. Main has no reason to read that terminal again, so the whole screen
// has to go to that one device from here -- and to no other.
describe('seeding one device with a whole screen', () => {
  /** The two fields a phone acts on, in queue order. */
  function shapes(f: OutputFanout, deviceId: string) {
    return f.drain(deviceId).map(({ chunk, replaceFrom }) => ({ chunk, replaceFrom }))
  }

  it('queues the screen for the device that asked and for no other', () => {
    const f = new OutputFanout()
    f.subscribe('late', 't1')
    f.subscribe('early', 't1')
    f.seed('late', 't1', { replaceFrom: 0, text: 'the screen' }, false)
    expect(f.drain('late')).toEqual([
      { terminalId: 't1', chunk: '', missed: 0, replaceFrom: FORGET_FROM, marker: null },
      { terminalId: 't1', chunk: 'the screen', missed: 0, replaceFrom: 0, marker: null },
    ])
    expect(f.drain('early')).toEqual([])
  })

  it('replaces a whole copy with a screen that does not start at the beginning', () => {
    // Whatever numbering an old copy was kept in, and however many gap notices
    // the phone wrote into it: the screen behind a forget counts back to nothing.
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.seed('phone', 't1', { replaceFrom: 100, text: 'the screen' }, true)
    expect(shapes(f, 'phone')).toEqual([
      { chunk: '', replaceFrom: FORGET_FROM },
      { chunk: 'the screen', replaceFrom: 100 },
    ])
  })

  it('replaces a whole copy with a screen that starts at the beginning, too', () => {
    // Anchored at 0 it used to be left to truncate on its own, which kept a gap
    // notice's worth of the old copy's head for every notice the copy held --
    // asked to clear or not, since a screen from 0 is the whole screen.
    for (const clear of [true, false]) {
      const f = new OutputFanout()
      f.subscribe('phone', 't1')
      f.seed('phone', 't1', { replaceFrom: 0, text: 'the screen' }, clear)
      expect(shapes(f, 'phone')).toEqual([
        { chunk: '', replaceFrom: FORGET_FROM },
        { chunk: 'the screen', replaceFrom: 0 },
      ])
    }
  })

  it('draws over the end of a copy it was told to keep', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.seed('phone', 't1', { replaceFrom: 100, text: 'the screen' }, false)
    expect(shapes(f, 'phone')).toEqual([{ chunk: 'the screen', replaceFrom: 100 }])
  })

  it('queues behind output the device has not been sent yet', () => {
    // The backlog is what carries a kept copy across a dropped connection, so a
    // seed goes after it rather than in place of it.
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'backlog', nextOffset: 7, missed: 0, replaceFrom: 40 })
    f.seed('phone', 't1', { replaceFrom: 100, text: 'the screen' }, false)
    expect(shapes(f, 'phone')).toEqual([
      { chunk: 'backlog', replaceFrom: 40 },
      { chunk: 'the screen', replaceFrom: 100 },
    ])
  })

  it('seeds nothing for a device that is not watching the terminal', () => {
    // The watch list is the `read` check. A seed that skipped it would be a way
    // to be sent a terminal's screen without the grant to read it.
    const f = new OutputFanout()
    f.subscribe('phone', 't2')
    f.seed('phone', 't1', { replaceFrom: 0, text: 'SECRET=hunter2' }, true)
    f.seed('stranger', 't1', { replaceFrom: 0, text: 'SECRET=hunter2' }, true)
    expect(f.drain('phone')).toEqual([])
    expect(f.drain('stranger')).toEqual([])
  })

  it('holds a seed to the same ceiling as everything else', () => {
    const f = new OutputFanout(10)
    f.subscribe('phone', 't1')
    f.seed('phone', 't1', { replaceFrom: 0, text: 'abcdefghijklmn' }, false)
    const drained = f.drain('phone')
    // The forget went first, with the head of the screen it was for.
    expect(drained).toHaveLength(1)
    const [chunk] = drained
    expect(chunk.chunk).toBe('efghijklmn')
    expect(chunk.missed).toBe(4)
    expect(chunk.marker).toContain('4 chars')
  })
})

// The phone draws a gap notice into its copy without counting it in the end
// mark it measures every anchor back from, so an anchor at 0 does not reach the
// start of a copy that holds one. A forget -- anchored past the end of any copy
// -- is what makes the next anchor replace all of it.
describe('starting a copy over', () => {
  function shapes(f: OutputFanout, deviceId: string) {
    return f.drain(deviceId).map(({ chunk, replaceFrom }) => ({ chunk, replaceFrom }))
  }

  it('anchors a forget where no copy reaches, in a number JSON carries exactly', () => {
    // The phone holds 200,000 chars at most; the anchor has to clear that by
    // more than any terminal will ever print, and arrive as the same number.
    expect(FORGET_FROM).toBe(Number.MAX_SAFE_INTEGER)
    expect(JSON.parse(JSON.stringify({ replaceFrom: FORGET_FROM })).replaceFrom).toBe(FORGET_FROM)
  })

  it('forgets the copy before an edit anchored at 0, on every device watching', () => {
    const f = new OutputFanout()
    f.subscribe('a', 't1')
    f.subscribe('b', 't1')
    f.subscribe('c', 't2')
    f.ingest('t1', { output: 'the screen', nextOffset: 10, missed: 0, replaceFrom: 0 })
    for (const id of ['a', 'b']) {
      expect(f.drain(id)).toEqual([
        { terminalId: 't1', chunk: '', missed: 0, replaceFrom: FORGET_FROM, marker: null },
        { terminalId: 't1', chunk: 'the screen', missed: 0, replaceFrom: 0, marker: null },
      ])
    }
    expect(f.drain('c')).toEqual([])
  })

  it('forgets the copy before an opening read that found the terminal empty', () => {
    // Clearing the phone is the whole point of that empty chunk, and an anchor
    // at 0 alone left a gap notice's worth of the old screen behind.
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: '', nextOffset: 0, missed: 0, replaceFrom: 0 })
    expect(shapes(f, 'phone')).toEqual([
      { chunk: '', replaceFrom: FORGET_FROM },
      { chunk: '', replaceFrom: 0 },
    ])
  })

  it('forgets nothing before an edit further in, or before plain output', () => {
    // Those are measured against the copy the phone holds, which is the point.
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'tail', nextOffset: 4, missed: 0, replaceFrom: 7 })
    f.ingest('t1', { output: 'more', nextOffset: 8, missed: 0 })
    f.ingest('t1', { output: 'again', nextOffset: 13, missed: 0, replaceFrom: null })
    expect(shapes(f, 'phone')).toEqual([
      { chunk: 'tail', replaceFrom: 7 },
      { chunk: 'more', replaceFrom: null },
      { chunk: 'again', replaceFrom: null },
    ])
  })

  it('keeps a forget only while the screen behind it is whole', () => {
    // Eviction takes the queue from its head. A forget that is still queued has
    // its screen intact behind it -- trimming stopped before reaching either.
    const f = new OutputFanout(10)
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'abcdefgh', nextOffset: 8, missed: 0 })
    f.ingest('t1', { output: 'ijklmnop', nextOffset: 16, missed: 0, replaceFrom: 0 })
    expect(shapes(f, 'phone')).toEqual([
      { chunk: 'gh', replaceFrom: null },
      { chunk: '', replaceFrom: FORGET_FROM },
      { chunk: 'ijklmnop', replaceFrom: 0 },
    ])
  })

  it('never leaves a forget queued without the screen it was for', () => {
    // Trimming that reaches a forget cuts into its screen next, which then has
    // nothing to anchor and is sent as plain output -- the forget went with it,
    // rather than staying behind to wipe the copy for a screen that is gone.
    const f = new OutputFanout(10)
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'abcdefgh', nextOffset: 8, missed: 0 })
    f.ingest('t1', { output: 'ijklmnopqrst', nextOffset: 20, missed: 0, replaceFrom: 0 })
    const drained = f.drain('phone')
    expect(drained.map(({ chunk, replaceFrom }) => ({ chunk, replaceFrom }))).toEqual([
      { chunk: 'klmnopqrst', replaceFrom: null },
    ])
    expect(drained[0].missed).toBe(10)
  })

  it('carries a loss from before a forget on the forget itself', () => {
    // Drawn into the copy and then wiped by the screen behind it: what was lost
    // came before a whole new screen, not out of it.
    const f = new OutputFanout(10)
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'abcd', nextOffset: 4, missed: 0 })
    f.ingest('t1', { output: 'efghijklmn', nextOffset: 14, missed: 0, replaceFrom: 0 })
    const drained = f.drain('phone')
    expect(drained).toEqual([
      {
        terminalId: 't1',
        chunk: '',
        missed: 4,
        replaceFrom: FORGET_FROM,
        marker: formatGapMarker(4),
      },
      { terminalId: 't1', chunk: 'efghijklmn', missed: 0, replaceFrom: 0, marker: null },
    ])
  })
})
