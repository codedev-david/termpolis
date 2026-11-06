import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { FORGET_FROM, OutputFanout, formatGapMarker, type DrainedChunk } from '../../src/main/remoteBridge/outputFanout'
import { ScreenFlattener } from '../../src/main/remoteBridge/screenFlattener'

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

// ── One screen instead of the edits a device missed ──────────────────────────────────────────────────
//
// A queue is a list of whole-region edits, and a device that is away for ten seconds is owed 156,449 chars of
// them for a 2.5 KB screen. Nothing on the wire acknowledges any of it. So a device that has been away, or has
// fallen behind, is sent the SCREEN instead: ONE chunk behind a forget (see `FORGET_FROM`), in the numbering
// every later edit applies to (src/main/remoteBridge/phoneResync.ts).

/** The chunks a drain returned, as the two fields a phone acts on plus who they are for. */
function shapes(chunks: DrainedChunk[]) {
  return chunks.map(({ terminalId, chunk, replaceFrom }) => ({ terminalId, chunk, replaceFrom }))
}

describe('reseeding a device', () => {
  it('replaces everything queued for one terminal with ONE screen, behind a forget', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'a', nextOffset: 1, missed: 0, replaceFrom: 3 })
    f.ingest('t1', { output: 'b', nextOffset: 2, missed: 0, replaceFrom: 4 })
    f.ingest('t1', { output: 'c', nextOffset: 3, missed: 0, replaceFrom: 5 })

    f.reseed('phone', 't1', { replaceFrom: 100, text: 'the screen' })

    expect(shapes(f.drain('phone'))).toEqual([
      { terminalId: 't1', chunk: '', replaceFrom: FORGET_FROM },
      { terminalId: 't1', chunk: 'the screen', replaceFrom: 100 },
    ])
  })

  it('leaves what is queued for the device\'s other terminals alone, and in order', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.subscribe('phone', 't2')
    f.ingest('t1', { output: 'a1', nextOffset: 1, missed: 0, replaceFrom: 1 })
    f.ingest('t2', { output: 'b1', nextOffset: 1, missed: 0, replaceFrom: 1 })
    f.ingest('t1', { output: 'a2', nextOffset: 2, missed: 0, replaceFrom: 2 })
    f.ingest('t2', { output: 'b2', nextOffset: 2, missed: 0, replaceFrom: 2 })

    f.reseed('phone', 't1', { replaceFrom: 0, text: 'screen of one' })

    expect(shapes(f.drain('phone'))).toEqual([
      { terminalId: 't2', chunk: 'b1', replaceFrom: 1 },
      { terminalId: 't2', chunk: 'b2', replaceFrom: 2 },
      { terminalId: 't1', chunk: '', replaceFrom: FORGET_FROM },
      { terminalId: 't1', chunk: 'screen of one', replaceFrom: 0 },
    ])
  })

  it('touches no other device\'s queue', () => {
    const f = new OutputFanout()
    f.subscribe('away', 't1')
    f.subscribe('here', 't1')
    f.ingest('t1', { output: 'edit', nextOffset: 1, missed: 0, replaceFrom: 1 })
    f.reseed('away', 't1', { replaceFrom: 0, text: 'screen' })
    expect(shapes(f.drain('here'))).toEqual([{ terminalId: 't1', chunk: 'edit', replaceFrom: 1 }])
  })

  it('is a forget and a screen even when there was nothing queued, and the screen starts at 0', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.reseed('phone', 't1', { replaceFrom: 0, text: 'screen' })
    expect(shapes(f.drain('phone'))).toEqual([
      { terminalId: 't1', chunk: '', replaceFrom: FORGET_FROM },
      { terminalId: 't1', chunk: 'screen', replaceFrom: 0 },
    ])
  })

  it('queues nothing for a device that is not watching the terminal, and takes nothing from it', () => {
    // The watch list is the `read` check. A reseed that skipped it would be a way to be sent a terminal's
    // screen without the grant to read it.
    const f = new OutputFanout()
    f.subscribe('phone', 't2')
    f.ingest('t2', { output: 'kept', nextOffset: 1, missed: 0, replaceFrom: 1 })
    f.reseed('phone', 't1', { replaceFrom: 0, text: 'SECRET=hunter2' })
    f.reseed('stranger', 't1', { replaceFrom: 0, text: 'SECRET=hunter2' })
    expect(shapes(f.drain('phone'))).toEqual([{ terminalId: 't2', chunk: 'kept', replaceFrom: 1 }])
    expect(f.drain('stranger')).toEqual([])
  })

  it('holds the screen to the same ceiling as everything else', () => {
    const f = new OutputFanout(10)
    f.subscribe('phone', 't1')
    f.reseed('phone', 't1', { replaceFrom: 0, text: 'abcdefghijklmn' })
    const [chunk, ...rest] = f.drain('phone')
    expect(rest).toEqual([])
    expect(chunk.chunk).toBe('efghijklmn')
    expect(chunk.missed).toBe(4)
  })
})

describe('what a device has queued, counted', () => {
  it('is chunks and chars, per device', () => {
    const f = new OutputFanout()
    f.subscribe('a', 't1')
    f.subscribe('b', 't1')
    f.ingest('t1', { output: 'abc', nextOffset: 3, missed: 0, replaceFrom: 1 })
    f.ingest('t1', { output: 'de', nextOffset: 5, missed: 0, replaceFrom: 4 })
    expect(f.queuedFor('a')).toEqual({ chunks: 2, chars: 5 })
    f.drain('a')
    expect(f.queuedFor('a')).toEqual({ chunks: 0, chars: 0 })
    expect(f.queuedFor('b')).toEqual({ chunks: 2, chars: 5 })
  })

  it('is nothing for a device that was never seen', () => {
    expect(new OutputFanout().queuedFor('ghost')).toEqual({ chunks: 0, chars: 0 })
  })
})

describe('a device that falls behind', () => {
  const SCREEN = { replaceFrom: 40, text: 'the whole screen' }

  function lagging(limit = 3) {
    const f = new OutputFanout(1_000_000, { collapseAfter: limit, screenOf: () => SCREEN })
    f.subscribe('phone', 't1')
    return f
  }

  const edit = (f: OutputFanout, i: number, terminalId = 't1') =>
    f.ingest(terminalId, { output: `edit ${i}`, nextOffset: i, missed: 0, replaceFrom: 100 + i })

  it('is held to the limit: the chunk that passes it turns the queue into ONE screen', () => {
    const f = lagging()
    for (let i = 0; i < 3; i += 1) edit(f, i)
    expect(f.queuedFor('phone').chunks).toBe(3)
    edit(f, 3)
    expect(f.queuedFor('phone').chunks).toBe(2)
    expect(shapes(f.drain('phone'))).toEqual([
      { terminalId: 't1', chunk: '', replaceFrom: FORGET_FROM },
      { terminalId: 't1', chunk: 'the whole screen', replaceFrom: 40 },
    ])
  })

  it('goes on queueing edits behind the screen, and collapses again when they pass the limit', () => {
    const f = lagging()
    for (let i = 0; i < 4; i += 1) edit(f, i)
    edit(f, 4)
    expect(f.queuedFor('phone').chunks).toBe(3)
    expect(shapes(f.drain('phone')).map((c) => c.chunk)).toEqual(['', 'the whole screen', 'edit 4'])
    for (let i = 0; i < 40; i += 1) {
      edit(f, i)
      expect(f.queuedFor('phone').chunks).toBeLessThanOrEqual(3)
    }
  })

  it('counts one terminal at a time: another one\'s chunks neither trigger it nor are taken by it', () => {
    const f = lagging()
    f.subscribe('phone', 't2')
    for (let i = 0; i < 3; i += 1) edit(f, i, 't2')
    for (let i = 0; i < 3; i += 1) edit(f, i, 't1')
    // Six chunks in the queue, but no terminal over the limit of three.
    expect(f.queuedFor('phone').chunks).toBe(6)
    edit(f, 3, 't1')
    const drained = shapes(f.drain('phone'))
    expect(drained.filter((c) => c.terminalId === 't2').map((c) => c.chunk)).toEqual(['edit 0', 'edit 1', 'edit 2'])
    expect(drained.filter((c) => c.terminalId === 't1').map((c) => c.chunk)).toEqual(['', 'the whole screen'])
  })

  it('collapses for the device that is behind and for no other', () => {
    const f = lagging()
    f.subscribe('keeping up', 't1')
    for (let i = 0; i < 4; i += 1) {
      edit(f, i)
      // The one keeping up is drained every time, so it never has more than a chunk or two.
      expect(f.drain('keeping up')).toHaveLength(1)
    }
    expect(f.queuedFor('phone').chunks).toBe(2)
  })

  it('reports no loss: what the replaced edits missed came before a whole new screen', () => {
    const f = lagging()
    f.ingest('t1', { output: 'x', nextOffset: 1, missed: 700, replaceFrom: 100 })
    for (let i = 0; i < 3; i += 1) edit(f, i)
    expect(f.drain('phone').every((c) => c.missed === 0 && c.marker === null)).toBe(true)
  })

  it('falls back to evicting the head when the terminal has no screen to give', () => {
    const f = new OutputFanout(10, { collapseAfter: 2, screenOf: () => null })
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'abcdefgh', nextOffset: 8, missed: 0 })
    f.ingest('t1', { output: 'ijklmn', nextOffset: 14, missed: 0 })
    f.ingest('t1', { output: 'o', nextOffset: 15, missed: 0 })
    const drained = f.drain('phone')
    expect(drained.map((c) => c.chunk).join('')).toBe('fghijklmno')
    expect(drained[0].marker).toContain('5 chars')
  })

  it('is today\'s fan-out when it is given no screen source', () => {
    // CONTROL: the same sixty edits, nothing collapsed.
    const f = new OutputFanout(1_000_000)
    f.subscribe('phone', 't1')
    for (let i = 0; i < 60; i += 1) edit(f, i)
    expect(f.queuedFor('phone').chunks).toBe(60)
  })

  it('collapses past sixteen chunks of a terminal unless told otherwise', () => {
    const f = new OutputFanout(1_000_000, { screenOf: () => SCREEN })
    f.subscribe('phone', 't1')
    for (let i = 0; i < 16; i += 1) edit(f, i)
    expect(f.queuedFor('phone').chunks).toBe(16)
    edit(f, 16)
    expect(f.queuedFor('phone').chunks).toBe(2)
  })
})

// The property: collapsing is invisible to the phone. Streams made of the flattener's OWN edits -- a made-up
// edit proves nothing about what the real ones compose to -- are queued three ways: whole (what a queue is),
// collapsing, and today's eviction. The phone is the rule 1.1.0 runs, copied from mobile/src/state/remoteStore.ts
// (remoteBlankTerminal.test.ts holds the test that reads that source and fails if this copy drifts).
describe('collapsing a lagging queue changes nothing the phone shows', () => {
  interface Copy {
    text: string
    end: number
  }

  const PHONE_CAP = 200_000

  it('models the phone that ships, not a copy that has drifted from it', () => {
    // `onPhone` below is the rule the 1.1.0 app in people's hands runs, copied because that module imports
    // react-native. The property is only worth anything while the copy IS that rule, so the source is read
    // and the lines it is made of are held against it -- the same guard remoteBlankTerminal.test.ts keeps.
    const store = fs
      .readFileSync(path.join(__dirname, '../../mobile/src/state/remoteStore.ts'), 'utf8')
      .replace(/\s+/g, ' ')
    expect(PHONE_CAP).toBe(200_000)
    expect(store).toContain('export const MAX_OUTPUT_CHARS = 200_000')
    expect(store).toContain("const gap = c.missed > 0 && c.marker !== null ? c.marker : ''")
    expect(store).toContain(
      'const keep = c.replaceFrom === null ? held.length : Math.min(held.length, Math.max(0, held.length - (heldEnd - c.replaceFrom)))',
    )
    expect(store).toContain('const joined = held.slice(0, keep) + gap + c.chunk')
    expect(store).toContain(
      'outputEnd[c.terminalId] = c.replaceFrom === null ? heldEnd + c.missed + c.chunk.length : c.replaceFrom + c.chunk.length',
    )
  })

  function onPhone(chunks: DrainedChunk[], from: Copy = { text: '', end: 0 }): Copy {
    let { text, end } = from
    for (const c of chunks) {
      const gap = c.missed > 0 && c.marker !== null ? c.marker : ''
      const keep =
        c.replaceFrom === null ? text.length : Math.min(text.length, Math.max(0, text.length - (end - c.replaceFrom)))
      const joined = text.slice(0, keep) + gap + c.chunk
      text = joined.length > PHONE_CAP ? joined.slice(joined.length - PHONE_CAP) : joined
      end = c.replaceFrom === null ? end + c.missed + c.chunk.length : c.replaceFrom + c.chunk.length
    }
    return { text, end }
  }

  /** mulberry32: the same stream for the same seed, on every machine. */
  function random(seed: number): () => number {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'build', 'passed', 'failed', 'src/main', 'index.ts', 'x'.repeat(24)]

  /** What a terminal does to a flattener: lines that scroll, a panel that repaints in place, a status line
   *  rewritten with colour, a clear, text with no newline. `wide` makes the lines long enough to push the
   *  settled text past the 32 KB the bridge keeps. */
  function frames(seed: number, count: number, wide = false): string[] {
    const r = random(seed)
    const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]
    const out: string[] = []
    let panel = 0
    for (let i = 0; i < count; i += 1) {
      const k = r()
      if (k < 0.3) {
        const words = Array.from({ length: wide ? 120 : 1 + Math.floor(r() * 7) }, () => pick(WORDS)).join(' ')
        out.push(`${words}\r\n`)
      } else if (k < 0.7) {
        const rows = 2 + Math.floor(r() * 4)
        let erase = ''
        for (let j = 0; j < panel; j += 1) erase += `\x1b[2K${j < panel - 1 ? '\x1b[1A' : ''}`
        if (panel > 0) erase += '\x1b[G'
        const lines = Array.from({ length: rows }, (_, j) => `${j === 0 ? 'Running' : `agent-${j}`} ${pick(WORDS)} ${Math.floor(r() * 100)}%`)
        out.push(`${erase}${lines.join('\r\n')}\r\n`)
        panel = rows + 1
      } else if (k < 0.9) {
        out.push(`\r\x1b[2K\x1b[3${1 + Math.floor(r() * 6)}m${pick(WORDS)} ${Math.floor(r() * 1000)}\x1b[0m`)
      } else if (k < 0.95) {
        out.push('\x1b[2J\x1b[H')
        panel = 0
      } else {
        out.push(`${pick(WORDS)} ${pick(WORDS)}`)
      }
    }
    return out
  }

  const SIZE = { cols: 40, rows: 8 }
  /** Between what a screen of these streams comes to (about 1.5 KB at most) and what all their edits come
   *  to (about 5 KB): only the OLD rule, evicting the head, ever reaches it. */
  const CEILING = 4_000
  /** The fan-out's own, for the stream that has to hold a whole 32 KB tail. */
  const DEFAULT_CEILING = 262_144
  const LIMIT = 16
  const SEEDS = [1, 2, 3, 4, 5, 6]

  /** One stream, queued three ways for a phone that is away the whole time -- or, when `drains` is given,
   *  that comes back now and then to take what is waiting. */
  async function run(seed: number, options: { wide?: boolean; drains?: boolean } = {}) {
    const flattener = new ScreenFlattener()
    const whole = new OutputFanout(Number.MAX_SAFE_INTEGER)
    const ceiling = options.wide ? DEFAULT_CEILING : CEILING
    const collapsing = new OutputFanout(ceiling, { screenOf: (id) => flattener.snapshot(id) })
    const evicting = new OutputFanout(ceiling)
    for (const f of [whole, collapsing, evicting]) f.subscribe('phone', 't1')
    const pace = random(seed * 31)
    let seenByWhole: Copy = { text: '', end: 0 }
    let seenByCollapsing: Copy = { text: '', end: 0 }
    let longest = 0
    let edits = 0
    for (const bytes of frames(seed, options.wide ? 260 : 120, options.wide)) {
      const edit = await flattener.feed('t1', bytes, SIZE)
      if (edit === null) continue
      edits += 1
      for (const f of [whole, collapsing, evicting]) {
        f.ingest('t1', { output: edit.text, nextOffset: 0, missed: 0, replaceFrom: edit.replaceFrom })
      }
      longest = Math.max(longest, collapsing.queuedFor('phone').chunks)
      if (options.drains && pace() < 0.03) {
        seenByWhole = onPhone(whole.drain('phone'), seenByWhole)
        seenByCollapsing = onPhone(collapsing.drain('phone'), seenByCollapsing)
      }
    }
    return {
      truth: flattener.snapshot('t1')!,
      whole: onPhone(whole.drain('phone'), seenByWhole),
      collapsed: onPhone(collapsing.drain('phone'), seenByCollapsing),
      evicted: onPhone(evicting.drain('phone')),
      longest,
      edits,
    }
  }

  it('the phone copy after the queue equals the copy after the collapsed queue, for random streams the real flattener made', async () => {
    let evictedDiffer = 0
    for (const seed of SEEDS) {
      const r = await run(seed)
      // The whole stream fits in the tail the bridge keeps, so every copy below is compared in full.
      expect(r.truth.replaceFrom).toBe(0)
      // Sanity: the flattener's edits, replayed one by one, ARE the screen.
      expect(r.whole.text).toBe(r.truth.text)
      // THE PROPERTY.
      expect(r.collapsed).toEqual(r.whole)
      // Counters: the queue never passed the limit, and the stream was long enough to collapse many times.
      expect(r.longest).toBeLessThanOrEqual(LIMIT)
      expect(r.edits).toBeGreaterThan(3 * LIMIT)
      if (r.evicted.text !== r.truth.text) evictedDiffer += 1
    }
    // CONTROL: evicting the head, which is what the queue did before, leaves the phone with a different
    // copy -- rows gone and a notice in their place -- for most of these streams.
    expect(evictedDiffer).toBeGreaterThanOrEqual(SEEDS.length - 1)
  }, 240_000)

  it('also when the phone comes back now and then to take what is waiting', async () => {
    for (const seed of SEEDS) {
      const r = await run(seed, { drains: true })
      expect(r.truth.replaceFrom).toBe(0)
      expect(r.collapsed).toEqual(r.whole)
      expect(r.collapsed.text).toBe(r.truth.text)
      expect(r.longest).toBeLessThanOrEqual(LIMIT)
    }
  }, 240_000)

  it('keeps the newest of a stream longer than the tail the bridge keeps, and none of the history above it', async () => {
    // The honest limit: past 32 KB of settled text the phone is left with the NEWEST of it -- what a phone
    // opening the terminal is shown, plus whatever settled since the last time its queue collapsed. Its
    // copy ends where the whole copy does, and is the end of it.
    const r = await run(11, { wide: true })
    expect(r.truth.replaceFrom).toBeGreaterThan(0)
    expect(r.collapsed.end).toBe(r.whole.end)
    expect(r.collapsed.text.endsWith(r.truth.text)).toBe(true)
    expect(r.whole.text.endsWith(r.collapsed.text)).toBe(true)
    expect(r.whole.text.length).toBeGreaterThan(r.collapsed.text.length)
    expect(r.longest).toBeLessThanOrEqual(LIMIT)
  }, 240_000)
})

describe('where a gap notice sits in a device\'s copy', () => {
  function watching() {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.subscribe('phone', 't2')
    return f
  }

  it('is nowhere for a copy that was never shown one', () => {
    const f = watching()
    f.ingest('t1', { output: 'all of it', nextOffset: 9, missed: 0, replaceFrom: 0 })
    f.drain('phone')
    expect(f.gapAt('phone', 't1')).toBeNull()
  })

  it('is where the chunk that carried the loss was anchored, once the device has been sent it', () => {
    const f = watching()
    f.ingest('t1', { output: 'tail', nextOffset: 9, missed: 4_300, replaceFrom: 120 })
    // Queued is not shown: a notice the phone has not drawn is not in its copy.
    expect(f.gapAt('phone', 't1')).toBeNull()
    f.drain('phone')
    expect(f.gapAt('phone', 't1')).toBe(120)
  })

  it('is the furthest one when the copy holds several', () => {
    const f = watching()
    f.ingest('t1', { output: 'a', nextOffset: 1, missed: 10, replaceFrom: 500 })
    f.ingest('t1', { output: 'b', nextOffset: 2, missed: 10, replaceFrom: 200 })
    f.drain('phone')
    expect(f.gapAt('phone', 't1')).toBe(500)
  })

  it('is unknown for a loss that came with no anchor, which no rewrite can be sure of', () => {
    const f = watching()
    f.ingest('t1', { output: '', nextOffset: 1, missed: 10, replaceFrom: 40 })
    f.ingest('t1', { output: '', nextOffset: 2, missed: 10 })
    f.drain('phone')
    expect(f.gapAt('phone', 't1')).toBe(Infinity)
  })

  it('is per terminal', () => {
    const f = watching()
    f.ingest('t1', { output: 'x', nextOffset: 1, missed: 10, replaceFrom: 7 })
    f.drain('phone')
    expect(f.gapAt('phone', 't1')).toBe(7)
    expect(f.gapAt('phone', 't2')).toBeNull()
  })

  it('goes when the phone is sent a forget: the screen behind it replaces the whole copy', () => {
    const f = watching()
    f.ingest('t1', { output: 'x', nextOffset: 1, missed: 10, replaceFrom: 7 })
    f.drain('phone')
    f.reseed('phone', 't1', { replaceFrom: 0, text: 'screen' })
    f.drain('phone')
    expect(f.gapAt('phone', 't1')).toBeNull()
  })

  it('is not left by a forget that itself carried the loss', () => {
    // A loss from before a whole screen is drawn into the copy and wiped by the screen behind it.
    const f = new OutputFanout(10)
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'abcd', nextOffset: 4, missed: 0 })
    f.ingest('t1', { output: 'efghijklmn', nextOffset: 14, missed: 0, replaceFrom: 0 })
    const drained = f.drain('phone')
    expect(drained[0]).toMatchObject({ replaceFrom: FORGET_FROM, missed: 4 })
    expect(f.gapAt('phone', 't1')).toBeNull()
  })

  it('goes when the device stops watching the terminal', () => {
    const f = watching()
    f.ingest('t1', { output: 'x', nextOffset: 1, missed: 10, replaceFrom: 7 })
    f.drain('phone')
    f.unsubscribe('phone', 't1')
    expect(f.gapAt('phone', 't1')).toBeNull()
    // And leaving a terminal nobody ever subscribed to harms nothing.
    f.unsubscribe('ghost', 't1')
  })

  it('is nowhere for a device it does not know', () => {
    expect(new OutputFanout().gapAt('ghost', 't1')).toBeNull()
  })
})
