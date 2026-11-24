// @vitest-environment node
import { appendFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { relativePath, sanitizeText, type SanitizeContext } from '../../../src/shared/world/exportSanitize'

// The sanitizer runs over every string of a world in the main process, so a long string with no space in it (a
// minified bundle, a base64 blob, a run of slashes) must cost its length, not the square of it. This checks how the
// cost grows rather than how long it takes, so a slow or busy machine passes as long as the growth is linear: each
// shape is timed at n and at 8n characters, and the ratio is about 8 when the cost is linear and about 64 when it is
// quadratic. The timings are the fastest of several interleaved rounds after a warm-up, and a shape is measured again
// before it fails, so one slow round (a GC, another process) does not fail the test.

const B = '\\'
const win: SanitizeContext = { root: 'C:\\Users\\dev\\repo', home: 'C:\\Users\\dev', userData: 'C:\\Users\\dev\\AppData\\Roaming\\Termpolis' }
const posix: SanitizeContext = { root: '/home/dev/repo', home: '/home/dev', userData: '/home/dev/.config/Termpolis' }

/** Characters at the small size; the large one is eight times as many. Eight shapes at both: about 300 KB in all. */
const N = 4096
/** Linear is about 8, quadratic about 64. */
const LIMIT = 24
const ROUNDS = 5
const ATTEMPTS = 3

let seed = 7
const base64 = (n: number): string => {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let s = ''
  // The high bits: the low six of this generator repeat every 64 draws.
  while (s.length < n) s += a[(seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 25]
  return s
}
const repeat = (unit: string) => (n: number): string => unit.repeat(Math.ceil(n / unit.length)).slice(0, n)

type Shape = [name: string, run: (s: string) => string, make: (n: number) => string]
const shapes: Shape[] = [
  ['text: a minified token', (s) => sanitizeText(s, posix), repeat('a.b(c)&&d[e]=f/g*h;')],
  ['text: a base64 token', (s) => sanitizeText(s, posix), base64],
  ['text: a UNC token naming the home', (s) => sanitizeText(s, posix), (n) => B + B + 'h' + repeat('/home/dev/x')(n - 3)],
  ['text: a share path of folders named Users', (s) => sanitizeText(s, win), (n) => '//h' + repeat('/Users')(n - 3)],
  ['text: a run of dots', (s) => sanitizeText(s, win), repeat('.')],
  ['text: a run of backslashes', (s) => sanitizeText(s, win), repeat(B)],
  ['field: a run of slashes', (s) => relativePath(s, posix), repeat('/')],
  ['field: a run of backslashes', (s) => relativePath(s, win), repeat(B)],
]

/** The ratio of the fastest run at 8n to the fastest at n, the two sizes taking turns. */
function growth(run: (s: string) => string, small: string, large: string): number {
  run(small)
  run(large)
  let a = Infinity
  let b = Infinity
  for (let r = 0; r < ROUNDS; r++) {
    let t = performance.now()
    run(small)
    a = Math.min(a, performance.now() - t)
    t = performance.now()
    run(large)
    b = Math.min(b, performance.now() - t)
  }
  return b / Math.max(a, 0.01)
}

describe('sanitizer cost grows with the input, not its square', () => {
  it.each(shapes)('%s', (name, run, make) => {
    const small = make(N)
    const large = make(8 * N)
    const ratios: number[] = []
    for (let i = 0; i < ATTEMPTS; i++) {
      ratios.push(growth(run, small, large))
      if (ratios[ratios.length - 1] <= LIMIT) break
    }
    const ratio = Math.min(...ratios)
    // EXPORT_SANITIZE_COST_LOG names a file each ratio is added to, for reading the margin across runs.
    const log = process.env.EXPORT_SANITIZE_COST_LOG
    if (log) appendFileSync(log, `${name}\t${ratio.toFixed(2)}\n`)
    expect(ratio, `${name}: 8x the input took ${ratios.map((r) => r.toFixed(1)).join(', ')}x the time`).toBeLessThanOrEqual(LIMIT)
  }, 120_000)
})
