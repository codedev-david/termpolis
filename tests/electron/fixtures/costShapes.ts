// Text built to make one regex or walk of the key detectors do the most work per character. Each of
// these took seconds or minutes to screen (a screen of the end of an answer runs on the main thread,
// twice per job) at 1,000 to 100,000 characters, and takes milliseconds now. keyMaterial.test.ts and
// linkedScreenCost.test.ts both screen them. Keys are fresh random base64 and never printed.
import { randomBytes } from 'crypto'

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
}
