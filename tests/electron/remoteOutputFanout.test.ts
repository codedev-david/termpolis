import { describe, it, expect } from 'vitest'
import { OutputFanout, formatGapMarker } from '../../src/main/remoteBridge/outputFanout'

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
    expect(f.drain('phone')).toEqual([{ terminalId: 't1', chunk: 'hello', missed: 0, marker: null }])
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

  it('keeps one queue per device across repeated subscribes', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'first', nextOffset: 5, missed: 0 })
    f.subscribe('phone', 't2') // same device, second terminal: must not reset the queue
    f.ingest('t2', { output: 'second', nextOffset: 6, missed: 0 })
    expect(f.drain('phone').map((c) => c.chunk)).toEqual(['first', 'second'])
  })
})
