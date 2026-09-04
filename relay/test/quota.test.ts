import { describe, it, expect } from 'vitest'
import {
  TokenBucket,
  ByteBudget,
  MAX_FRAME_BYTES,
  CONNECTION_BYTE_BUDGET,
  resolveByteBudget,
} from '../src/quota'
import { byteLength } from '../src/wire'

describe('token bucket', () => {
  it('allows a burst up to capacity then refuses', () => {
    const b = new TokenBucket(3, 0)
    expect([b.take(0), b.take(0), b.take(0), b.take(0)]).toEqual([true, true, true, false])
  })

  it('refills over time but never banks more than capacity', () => {
    const b = new TokenBucket(2, 1 / 1000) // one token per second
    expect(b.take(0)).toBe(true)
    expect(b.take(0)).toBe(true)
    expect(b.take(0)).toBe(false)
    expect(b.take(1000)).toBe(true)
    // A long idle must not bank an unbounded burst: after any gap the ceiling is
    // still `capacity`, so an attacker cannot wait an hour and then flood.
    expect(b.take(1_000_000)).toBe(true)
    expect(b.take(1_000_000)).toBe(true)
    expect(b.take(1_000_000)).toBe(false)
  })

  it('does not go backwards when a clock reading regresses', () => {
    const b = new TokenBucket(2, 1 / 1000)
    expect(b.take(5000)).toBe(true)
    // A Durable Object can be evicted and revived, and a clock that reads BACKWARDS
    // across that boundary must not subtract tokens or push `last` into the future
    // -- that would throttle an innocent connection permanently.
    expect(b.take(1000)).toBe(true)
    expect(b.take(1000)).toBe(false)
    expect(b.take(6000)).toBe(true)
  })

  it('treats a zero-capacity bucket as closed', () => {
    expect(new TokenBucket(0, 1).take(0)).toBe(false)
  })
})

describe('byte budget', () => {
  it('spends down to exactly the limit and then refuses', () => {
    const b = new ByteBudget(100)
    expect(b.spend(60)).toBe(true)
    expect(b.spend(40)).toBe(true)
    expect(b.spend(1)).toBe(false)
  })

  it('refuses a single spend larger than the whole budget', () => {
    expect(new ByteBudget(100).spend(101)).toBe(false)
  })

  it('does not consume the budget on a refused spend', () => {
    const b = new ByteBudget(100)
    expect(b.spend(101)).toBe(false)
    // A refused spend that still debited would let a caller drain the budget with
    // requests that were never served.
    expect(b.spend(100)).toBe(true)
  })

  it('allows a zero-byte spend without consuming anything', () => {
    const b = new ByteBudget(1)
    expect(b.spend(0)).toBe(true)
    expect(b.spend(1)).toBe(true)
  })
})

describe('frame cap', () => {
  const FANOUT_CAPACITY_CHARS = 262_144 // outputFanout.ts DEFAULT_CAPACITY_CHARS

  it('leaves real headroom above the desktop fan-out capacity', () => {
    // A full drain is CHARS, and reaches the wire as JSON-escaped, UTF-8 encoded,
    // sealed BYTES -- always more, sometimes several times more. A cap merely
    // equal to the fan-out capacity would reject ordinary terminal output.
    expect(MAX_FRAME_BYTES).toBeGreaterThan(FANOUT_CAPACITY_CHARS * 3)
  })

  it('stays small enough to bound what one frame can cost the relay', () => {
    expect(MAX_FRAME_BYTES).toBeLessThanOrEqual(2 * 1024 * 1024)
  })
})

describe('frame measurement', () => {
  it('measures an ArrayBuffer and a view over one', () => {
    const buf = new ArrayBuffer(8)
    expect(byteLength(buf)).toBe(8)
    expect(byteLength(new Uint8Array(buf, 2))).toBe(6)
    // A DataView is a view too -- measuring it as its whole backing buffer would
    // over-count, and failing to recognise it would under-count.
    expect(byteLength(new DataView(buf, 4))).toBe(4)
  })

  it('measures a string in UTF-8 bytes, not characters', () => {
    // The cap is a wire-byte cap. Counting characters would let a multi-byte
    // string past a limit it actually exceeds.
    expect(byteLength('abc')).toBe(3)
    expect(byteLength('€')).toBe(3)
  })

  it('fails closed on anything it cannot measure', () => {
    // An unmeasurable frame must be REFUSED, not waved through. Returning 0 here
    // would make every unrecognised shape a free pass around the size cap -- and
    // a runtime change is exactly how an unrecognised shape would appear.
    for (const odd of [null, undefined, {}, 42, new Blob(['x'])]) {
      expect(byteLength(odd)).toBe(Number.MAX_SAFE_INTEGER)
    }
  })
})

describe('byte budget resolution', () => {
  it('uses a positive override', () => {
    expect(resolveByteBudget('4194304')).toBe(4194304)
  })

  it('falls back to the compiled-in budget for anything not a positive number', () => {
    // Number(undefined) is NaN and Number('') is 0 -- both would sail through a
    // naive `?? DEFAULT`, and a NaN budget passes every comparison it is used in,
    // so the limit would exist and enforce nothing.
    for (const bad of [undefined, '', 'abc', '0', '-1', 'Infinity']) {
      expect(resolveByteBudget(bad)).toBe(CONNECTION_BYTE_BUDGET)
    }
  })
})
