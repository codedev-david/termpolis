// Growth-rate guard for the linear-time tests of the code index and the world's parsers.
//
// A fixed time bound only catches a slow rule on a runner slower than the bound allows for, so these tests compare
// a rule against itself instead: reading 4n characters takes about 4 times as long as reading n when the rule is
// linear, and about 16 times when it is quadratic. `linear` asserts the ratio stays under 8. Below about 2 ms a
// timer and a stray collection decide the ratio, so n is first timed at no less than 2 ms; a quadratic rule is far
// past that at the sizes the tests use. Each size is timed at its best of a few runs, so a pause on a loaded runner
// does not count, and 4n is timed again only while it looks too slow.
import { expect } from 'vitest'

const RUNS = 3
const RATIO = 8
const FLOOR_MS = 2

function best(f: () => unknown, runs: number, under = 0): number {
  let t = Infinity
  for (let k = 0; k < runs && !(t < under); k++) {
    const s = performance.now()
    f()
    t = Math.min(t, performance.now() - s)
  }
  return t
}

/** Asserts that `f(4 * n)` takes under 8 times as long as `f(n)`, which a rule quadratic in the input never does. */
export function linear(f: (n: number) => unknown, n: number, label = ''): void {
  const t1 = Math.max(best(() => f(n), RUNS), FLOOR_MS)
  const t4 = best(() => f(4 * n), RUNS, RATIO * t1)
  expect(t4, `${label} n=${n}: ${t1.toFixed(1)} ms, 4n: ${t4.toFixed(1)} ms`).toBeLessThan(RATIO * t1)
}
