// Growth-rate guard for the linear-time tests of the code index and the world's parsers.
//
// A fixed time bound only catches a slow rule on a runner slower than the bound allows for, so these tests compare
// a rule against itself instead: reading an input of 4n characters takes about 4 times as long as reading one of n
// when the rule is linear, and about 16 times when it is quadratic. `linear` asserts the ratio stays under 8. Below
// about 8 ms a stray collection or the first large allocation decides the ratio (a linear read of a few ms has shown
// 7.6), so n counts as no less than 8 ms; every rule these tests guard took far longer than that at n before its fix,
// and 4n then had to stay under 64 ms. Each size is timed at its best of a few runs, so a pause on a
// loaded runner does not count, and 4n is timed again only while it looks too slow. The inputs are built before the
// clock starts.
import { expect } from 'vitest'

const RUNS = 3
const RATIO = 8
const FLOOR_MS = 8

function best(f: () => unknown, runs: number, under = 0): number {
  let t = Infinity
  for (let k = 0; k < runs && !(t < under); k++) {
    const s = performance.now()
    f()
    t = Math.min(t, performance.now() - s)
  }
  return t
}

/** Asserts that `read(make(4 * n))` takes under 8 times as long as `read(make(n))`, which no quadratic rule does. */
export function linear<T>(make: (n: number) => T, read: (input: T) => unknown, n: number, label = ''): void {
  const small = make(n)
  const large = make(4 * n)
  const t1 = Math.max(best(() => read(small), RUNS), FLOOR_MS)
  const t4 = best(() => read(large), RUNS, RATIO * t1)
  expect(t4, `${label} n=${n}: ${t1.toFixed(1)} ms, 4n: ${t4.toFixed(1)} ms`).toBeLessThan(RATIO * t1)
}

/** `unit` repeated to about n characters (at least once). */
export const fill = (unit: string, n: number): string => unit.repeat(Math.max(1, Math.floor(n / unit.length)))
