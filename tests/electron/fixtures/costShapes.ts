// Text built to make one regex or walk of the key detectors do the most work per character. Each of
// these took seconds or minutes to screen (a screen of the end of an answer runs on the main thread,
// twice per job) at 1,000 to 100,000 characters, and takes milliseconds now. keyMaterial.test.ts and
// linkedScreenCost.test.ts both screen them. Keys are fresh random base64 and never printed.
import { generateKeyPairSync, randomBytes } from 'crypto'

const QUIET_MS = 4
let calibRows: string[] | null = null
let measured = { at: 0, factor: 1, work: 0 }
const B64_CHARS = new Uint8Array(128)
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=') B64_CHARS[c.charCodeAt(0)] = 1
/** A fixed piece of plain work that calls none of the detectors, and is written as they are (a loop over the characters of each
 *  line with a table lookup, then a regex and a replace per line): the end of a 4,000-line log has the length of its base64 runs
 *  added up and its BEGIN lines read. Measured, it slows down under coverage and under load as the detectors do (5 to 8 times,
 *  as the detectors' screen of the same lines does), which is what a bound needs to follow. */
function calibrationWork(rows: string[]): number {
  let n = 0
  for (const line of rows) {
    let run = 0
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i)
      if (c < 128 && B64_CHARS[c] === 1) run++
      else {
        if (run >= 16) n += run
        run = 0
      }
    }
    if (/-----BEGIN [A-Z ]+-----/.test(line)) n += line.replace(/\d+/g, '0').trim().length
  }
  return n
}
/** How much slower than a quiet laptop this process runs the detectors right now. Coverage's instrumentation (six to eight times
 *  for loops over characters) and a loaded runner slow every screen alike, and a bound that fits a quiet machine fails a busy one.
 *  The detectors are not what is timed (a regression of their own, all of them five times slower, would then widen the bounds that
 *  should catch it): a fixed piece of plain work like theirs (`calibrationWork`, about `QUIET_MS` ms on a quiet laptop) is, best of
 *  five, and its ratio to that is the factor a bound is multiplied by (never under 1); redone at most every 5 s. A text that makes
 *  a detector quadratic costs a hundred times a bound, not five. */
export function slowdown(): number {
  if (Date.now() - measured.at < 5_000) return measured.factor
  if (calibRows === null) {
    calibRows = Array.from({ length: 4_000 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog ${'AbCdEfGhIj'.repeat(i % 5)} -----BEGIN CERTIFICATE----- ${'QUJDREVGR0hJSktM'.repeat(i % 4)}`)
  }
  let best = Infinity
  let work = 0
  for (let i = 0; i < 5; i++) {
    const t = performance.now()
    work += calibrationWork(calibRows)
    best = Math.min(best, performance.now() - t)
  }
  measured = { at: Date.now(), factor: Math.max(1, best / QUIET_MS), work }
  return measured.factor
}
/** A bound in milliseconds, for this process right now. */
export const within = (ms: number): number => ms * slowdown()

/** How the screen is asked: the end it keeps, and whether an older doing computer cut the text. */
export interface CostAsk {
  keep?: number
  cutStart?: boolean
}

const BS = '\\'
const END = '-----END PRIVATE KEY-----'
const r64 = (): string => randomBytes(48).toString('base64')
const lines = (n: number): string => Array.from({ length: n }, r64).join('\n')
const fill = (unit: string, n: number): string => unit.repeat(Math.ceil(n / unit.length)).slice(0, n)
const ANSWER: CostAsk = { keep: 200_000 }
/** A real PKCS#8 key's lines (BEGIN, 12 body lines, END), made once: the paths that read a key's lines between its parts need a key that decodes. */
const REAL = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim().split('\n')

/** [text, how the screen is asked, the bound in ms]. The bounds are for what costs seconds, with room
 *  for a loaded runner and for coverage (which makes the detectors four or five times slower). */
export const COST_SHAPES: Record<string, [string, CostAsk, number]> = {
  'a run of backslashes under a key block': [`-----BEGIN PRIVATE KEY-----\n${lines(2)}\n${BS.repeat(60_000)}\n`, ANSWER, 500],
  'a run of backslashes after Private-Lines': [`Private-Lines: 9999\n${BS.repeat(60_000)}\n`, ANSWER, 500],
  'a run of backslashes in a legacy key header an older computer cut': [
    `-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,${BS.repeat(80_000)}\n\n${lines(2)}\n-----END RSA PRIVATE KEY-----\n`,
    { keep: 200_000, cutStart: true },
    500,
  ],
  // (1,000 is the most a partial line above key lines is read at: headAnchor reads at most 1,024)
  'a line of plus signs above key lines and an END line, in text an older computer cut': [`${'+'.repeat(1_000)}\n\n${lines(3)}\n${END}\n`, { keep: 200_000, cutStart: true }, 200],
  'the same as the end of an error': [`${'+'.repeat(1_000)}\n\n${lines(3)}\n${END}\n`, { keep: 3_999 }, 100],
  'unterminated key blocks, each ending in a run of plus signs': [fill(`-----BEGIN PRIVATE KEY-----\n${lines(2)}\n${'+'.repeat(590)}!\n`, 100_000), ANSWER, 1_000],
  'a line of plus signs and spaces above an END line': [`${lines(3)}\n${'+ '.repeat(50_000)}x\n${END}\n`, ANSWER, 500],
  'Private-Lines anchors with no line after them': [fill('Private-Lines: 9999//', 100_000), ANSWER, 1_000],
  'Private-Lines anchors, then a long run of letters': ['Private-Lines: 9999'.repeat(1_315) + 'a'.repeat(75_000), ANSWER, 500],
  // (an anchor line repeated, then a long stretch with no base64 in it: each anchor's search for its first private line began
  // where the last one ended and read the whole stretch again, so 8,000 anchors read 65,536 blanks 8,000 times: 3.2 seconds, and
  // 3.7 for line breaks, 4.1 for CRLF and 0.6 for ten thousand written-out line feeds)
  'Private-Lines anchors, then a long run of blanks': ['Private-Lines: 9999\n'.repeat(8_000) + ' '.repeat(65_536), ANSWER, 500],
  'Private-Lines anchors, then a long run of line breaks': ['Private-Lines: 9999\n'.repeat(8_000) + '\n'.repeat(65_536), ANSWER, 500],
  'Private-Lines anchors, then a long run of CRLF': ['Private-Lines: 9999\n'.repeat(8_000) + '\r\n'.repeat(32_768), ANSWER, 500],
  'Private-Lines anchors, then written-out line feeds': ['Private-Lines: 9999\n'.repeat(8_000) + (BS + 'u000a').repeat(10_000), ANSWER, 500],
  // (the first line of a text an older computer cut, above the blank line and key lines of a legacy encrypted key: the rule that reads
  // what its cut left of the headers took the joiners off the line's end with `[…]+$`, which cost n * n; 60,000 took 8 and 13 seconds)
  'a line of quotes at the start of a text an older computer cut, above key lines': [`${'"'.repeat(60_000)}x\n\n${lines(3)}\n-----END RSA PRIVATE KEY-----\n`, { keep: 200_000, cutStart: true }, 500],
  'a line of spaces at the start of a text an older computer cut, above key lines': [`${' '.repeat(60_000)}x\n\n${lines(3)}\n-----END RSA PRIVATE KEY-----\n`, { keep: 200_000, cutStart: true }, 500],
  // (a key whose block stopped at an uneven line, which is a long line of letters: the tail's lines were asked, line by line, whether two words
  // stood in them, with a regex that cost n * n in a run of letters; 60,000 letters took 15 seconds, in every mode)
  'a line of letters between the lines of a real key': [[...REAL.slice(0, 4), `${'Aa'.repeat(30_000)}x`, ...REAL.slice(4)].join('\n'), ANSWER, 500],
  // (a value's trailing whitespace is taken off with `\s+$`, retried from each blank of a run inside the value: 400,000 characters took 2.9 s)
  'RSAKeyValue members with a long run of whitespace inside their values': [`<RSAKeyValue><D>QUJDREVGR0hJSktMTU5PUA${' '.repeat(12_000)}QUJDREVGR0hJSktMTU5PUA</D></RSAKeyValue>\n`.repeat(33), ANSWER, 500],
}
