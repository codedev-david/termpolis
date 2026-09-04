/** Largest frame the relay will forward.
 *
 *  NOT the same number as the desktop fan-out's capacity, and the difference
 *  matters. The fan-out holds 262_144 CHARS (DEFAULT_CAPACITY_CHARS in
 *  outputFanout.ts); a full drain of that becomes considerably more BYTES on the
 *  wire, because it is JSON-encoded first -- where a single ESC byte, which
 *  terminal output is full of, becomes the six characters  -- then UTF-8
 *  encoded, then sealed with a nonce, a counter and a 16-byte tag. Worst case is
 *  roughly a six-fold expansion.
 *
 *  1 MiB covers ordinary output with room to spare. It deliberately does NOT
 *  cover the pathological all-control-characters case: the desktop is responsible
 *  for splitting a drain that seals larger than this, because the alternative --
 *  sizing the relay for the worst case -- hands every connection a 1.6 MiB frame
 *  budget to abuse. */
export const MAX_FRAME_BYTES = 1024 * 1024

/** Frames per connection per second, and the burst allowance. A phone that is
 *  typing produces a few frames a second; 20/s with a burst of 40 sits far above
 *  any real use and far below what it takes to make the relay a useful amplifier. */
export const FRAME_RATE_PER_SEC = 20
export const FRAME_BURST = 40

/** Bytes one connection may forward before it is cut. 256 MiB is roughly a day of
 *  heavy terminal output; past it, something is wrong. */
export const CONNECTION_BYTE_BUDGET = 256 * 1024 * 1024

export class TokenBucket {
  private tokens: number
  private last = 0

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
  ) {
    this.tokens = capacity
  }

  /** Take one token, refilling for elapsed time first.
   *
   *  `elapsed` is clamped at zero and `last` never moves backwards: a Durable
   *  Object can be evicted and revived, and a clock that reads BACKWARDS across
   *  that boundary would otherwise subtract tokens and strand `last` in the
   *  future, throttling an innocent connection for as long as it lives. Refusing
   *  to move backwards is the safe direction -- the worst case is a peer briefly
   *  getting a slightly more generous refill than the wall clock earned. */
  take(now: number, cost = 1): boolean {
    const elapsed = Math.max(0, now - this.last)
    this.last = Math.max(this.last, now)
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs)
    if (this.tokens < cost) return false
    this.tokens -= cost
    return true
  }
}

export class ByteBudget {
  private spent = 0
  constructor(private readonly limit: number) {}

  /** Spend n bytes, or refuse without debiting. A refused spend that still
   *  debited would let a caller drain the budget with frames never forwarded. */
  spend(n: number): boolean {
    if (this.spent + n > this.limit) return false
    this.spent += n
    return true
  }
}

/** Per-connection byte budget, from an optional decimal-string override.
 *
 *  A pure function rather than a method so both branches are reachable from a unit
 *  test: the binding is always set under test (vitest.config.ts) and never set in
 *  production, so as a method one branch or the other was permanently untested.
 *  Anything not a positive finite number -- absent, empty, "abc", "0", "-1",
 *  "Infinity" -- falls back to the compiled-in budget rather than becoming a
 *  budget of NaN, which every comparison would silently pass. */
export function resolveByteBudget(raw: string | undefined): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : CONNECTION_BYTE_BUDGET
}
