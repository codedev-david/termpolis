// Growth-rate guard for the linear-time tests of the code index and the world's parsers.
//
// A fixed time bound only catches a slow rule on a runner slower than the bound allows for, so these tests compare
// a rule against itself: reading an input of 8n characters takes about 8 times as long as reading one of n when the
// rule is linear, and about 64 times when it is quadratic. `linear` fails at a ratio of 24, which leaves a linear rule
// 3 times its ratio as headroom and a quadratic one 2.7 times.
//
// What keeps a loaded runner (other workers, v8 coverage, two cores) from failing a linear rule:
// - Both inputs are built and read once, untimed, before the clock starts, so JIT tiering and flattening the
//   concatenated input are paid there. The results of that read are checked there too, so no `expect` is timed.
// - The small input is timed as a block of reads in a row, as many as the last ratio (8 to 64), so both sides are
//   timed over windows of about the same length and allocate about as much. A single read of n fits in one slice of
//   the scheduler and so runs at full speed, while the read of 8n is preempted whenever the cores are shared, and
//   pays for the collections its larger results bring on: on two loaded cores with coverage on, one read of n against
//   one of 8n took linear rules to ratios of 21 to 24, and a fixed block of 8 reads still to 21.
// - The two sides are timed in turn, round after round, keeping the fastest of each. A burst of contention then
//   slows both sides or is discarded, instead of landing on one side only.
// - A read of n counts as no less than FLOOR_MS, so a read of a millisecond or two does not turn a collection into
//   a ratio. Every rule these tests guard took far longer than that at n before its fix.
// - A ratio under half the limit in two rounds in a row, from the second round on, passes at once (so at round 3 at
//   the earliest). Otherwise the check runs 5 rounds and compares. While the ratio is then at or over the limit, it
//   runs 5 rounds more at a time, keeping the fastest times so far, until the ratio is under the limit or RETRY_MS
//   (12 s) of re-measuring has gone by, which outlasts a load episode that slows every read of 8n for a few seconds.
//   A ratio of twice the limit fails at once, on any round from the fifth, as no linear rule comes near it; one still
//   at or over the limit when the time is up fails too. Timing tests run under TIMED, a 120 s timeout, so the
//   re-measuring never ends as a timeout.
//
// What can still let a superlinear rule through is that early pass: it decides on the fastest of 2 or 3 reads of n,
// and when load slowed every one of them, the ratio reads low. A quadratic rule measures 38 to 66 here, so it passes
// early only if its ratio reads at least 3.2 times too low in two rounds in a row. Three replays of the per-round times
// of linear checks on two loaded cores with coverage on (each check's running ratios scaled by q over its median ratio;
// 4300 checks from 20 runs, replayed twice, and 2150 from 10 more runs) agree on the order of magnitude: at q = 38, two
// rounds in a row let 1 check in a few hundred to a few thousand pass early (1 in 250, 1 in 2000 and 1 in 200), several
// times rarer than one round did; at q = 64, 1 in 1000 or fewer. A quadratic rule's n takes hundreds of milliseconds,
// and on the checks whose n took 10 ms or more the two-round rule let at most 2 of about 900 through at q = 38 (none of
// 450 in the third replay). Past the early pass, a superlinear rule fails however long it re-measures, since its
// fastest time at 8n never comes down to 24 times its time at n.
//
// TERMPOLIS_LINEAR_LOG names a file that each check appends one JSON line to (times, ratio, margin = limit / ratio,
// rounds, `first`, the ratio after the first 5 rounds when the check ran that far, and `trace`, the time of n and of
// 8n read in each round).
import { appendFileSync } from 'fs'
import { expect } from 'vitest'

const GROWTH = 8
const LIMIT = 24
const ROUNDS = 5
const RETRY_MS = 12_000
const CLEAR_AFTER = 2
const FLOOR_MS = 4
const MAX_REPS = GROWTH * GROWTH

// Where each timed result goes, so the call is not dropped as unused.
let sink: unknown

function time<T>(read: (input: T) => unknown, input: T, times: number): number {
  const start = performance.now()
  for (let k = 0; k < times; k++) sink = read(input)
  return performance.now() - start
}

/**
 * Asserts that `read(make(8 * n))` takes under 24 times as long as `read(make(n))`, which no quadratic rule does.
 * `check` asserts on the result of each size once, outside the timed runs.
 */
export function linear<T, R>(make: (n: number) => T, read: (input: T) => R, n: number, label = '', check?: (result: R, input: T) => void): void {
  const small = make(n)
  const large = make(GROWTH * n)
  const warm = [read(small), read(large)]
  if (check) {
    check(warm[0], small)
    check(warm[1], large)
  }
  let t1 = Infinity
  let t8 = Infinity
  let ratio = Infinity
  let rounds = 0
  let first = Infinity
  let reps = GROWTH
  let clear = 0
  const trace: number[][] = []
  let retryFrom = 0
  for (;;) {
    const a = time(read, small, reps) / reps
    const b = time(read, large, 1)
    trace.push([a, b])
    t1 = Math.min(t1, a)
    t8 = Math.min(t8, b)
    rounds++
    ratio = t8 / Math.max(t1, FLOOR_MS)
    reps = Math.min(MAX_REPS, Math.max(GROWTH, Math.round(t8 / t1)))
    if (rounds === ROUNDS) {
      first = ratio
      retryFrom = performance.now()
    }
    clear = rounds >= CLEAR_AFTER && ratio < LIMIT / 2 ? clear + 1 : 0
    if (clear === 2) break
    if (rounds >= ROUNDS && ratio >= 2 * LIMIT) break
    if (rounds % ROUNDS === 0 && (ratio < LIMIT || performance.now() - retryFrom >= RETRY_MS)) break
  }
  const log = process.env.TERMPOLIS_LINEAR_LOG
  if (log) appendFileSync(log, JSON.stringify({ test: expect.getState().currentTestName, label, n, t1, t8, ratio, margin: LIMIT / ratio, rounds, first, reps, trace }) + '\n')
  sink = undefined
  expect(ratio, `${label} n=${n}: ${t1.toFixed(1)} ms, 8n: ${t8.toFixed(1)} ms, ${rounds} rounds`).toBeLessThan(LIMIT)
}

/** The options of a describe holding timing tests: re-measuring can add RETRY_MS to a test's own time. */
export const TIMED = { timeout: 120_000 }

/** `unit` repeated to about n characters (at least once). */
export const fill = (unit: string, n: number): string => unit.repeat(Math.max(1, Math.floor(n / unit.length)))
