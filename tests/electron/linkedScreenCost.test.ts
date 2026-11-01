// What the Linked machines screen (aiSecurity.screenText) costs, with the key detectors in it: an
// answer is screened on the main thread, twice per job (before it leaves, and when it arrives), so
// the end of a long answer of each kind of text must screen in well under a frame of work, and
// inputs built to make a detector or a rule work hardest must cost in step with their length. Its
// own file, so its seconds of screening run beside the rest of the suite. Keys are made fresh in
// memory by each run (fixtures/freshKeys.ts); tokens are fake ('a'.repeat style).
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { randomBytes } from 'crypto'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))
// These tests screen megabytes, several times over. Their timing bounds are the assertions; a test's own timeout is only a guard
// against a hang, and a synchronous loop cannot be interrupted by it anyway: it fails the test afterwards, whatever the bounds
// say, and a slower runner than a laptop (the same file took 142 s of 120 s in a coverage run beside other work) failed on it.
vi.setConfig({ testTimeout: 600_000 })

import { maskForDisplay, screenText } from '../../src/main/aiSecurity'
import { MAX_ERROR_CHARS, MAX_OUTPUT_CHARS, SCREEN_LOOKBACK_CHARS } from '../../src/main/linkedJobs'
import { COST_SHAPES, within } from './fixtures/costShapes'
import { makeKeys, wrap, type KeySet } from './fixtures/freshKeys'

const GH = `ghp_${'b'.repeat(36)}`
const AWS = `AKIA${'C'.repeat(16)}`

let K: KeySet
beforeAll(() => {
  K = makeKeys()
})

describe("the Linked screen's cost where only an answer's end is kept", () => {
  /** The fastest of three runs, so a pause on a busy CI box doesn't count against the screen; no more
   *  runs once one took longer than `giveUp` (a run that long is the answer already). */
  function bestOf3(run: () => void, giveUp = Infinity): number {
    let best = Infinity
    for (let i = 0; i < 3; i++) {
      const t = performance.now()
      run()
      best = Math.min(best, performance.now() - t)
      if (best > giveUp) break
    }
    return best
  }
  /** The fastest of three runs of each of two sizes of the same work, taken in turn (small, large, small, large, ...), so
   *  a stretch of load on a busy runner reaches both alike and cannot fall on the larger one alone: it once did, in a
   *  coverage run beside the whole Linked suite, and 4 MB took 5 times its usual 2 s while 1 MB took its usual 0.5 s, a
   *  ratio of 22 for linear work (best of three runs one size after the other cannot tell that from a quadratic). */
  function pair(small: () => void, large: () => void): [number, number] {
    let s = Infinity
    let l = Infinity
    for (let i = 0; i < 3; i++) {
      let t = performance.now()
      small()
      s = Math.min(s, performance.now() - t)
      t = performance.now()
      large()
      l = Math.min(l, performance.now() - t)
    }
    return [s, l]
  }
  const fill = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s.repeat(Math.ceil(n / s.length)).slice(0, n))
  const ROOT = join(__dirname, '..', '..')
  const read = (dir: string, ext: string): string =>
    readdirSync(join(ROOT, dir))
      .filter((f) => f.endsWith(ext))
      .map((f) => readFileSync(join(ROOT, dir, f), 'utf8'))
      .join('\n')
  /** An answer this long keeps its last 200,000 characters (linkedJobs' MAX_OUTPUT_CHARS). */
  const N = 465_000
  const KINDS: Record<string, string> = {}

  beforeAll(() => {
    const docs = `${read('.', '.md')}\n${read('docs', '.md')}`
    const code = read('src/main', '.ts')
    const lines = code.split('\n')
    const listing = lines.flatMap((l, i) => (l.includes('key') ? [`src\\main\\aiSecurity.ts:${i + 1}:${l}`] : [])).join('\n')
    const diff = lines.map((l, i) => (i % 40 === 0 ? `@@ -${i},40 +${i},40 @@\n+${l}` : `${i % 3 ? '+' : ' '}${l}`)).join('\n')
    const certs = Array.from({ length: 30 }, () => `-----BEGIN CERTIFICATE-----\n${wrap(randomBytes(900).toString('base64')).join('\n')}\n-----END CERTIFICATE-----`)
    const infra = [...Object.values(K.F).map((l) => l.join('\n')), JSON.stringify(K.J.ec), JSON.stringify(K.J.rsa), K.xml, `GITHUB_TOKEN=${GH}`, `AWS_ACCESS_KEY_ID=${AWS}`, ...certs, docs.slice(0, 20_000)].join('\n\n')
    Object.assign(KINDS, {
      prose: fill(docs, N),
      code: fill(code, N),
      'rg listing': fill(listing, N),
      diff: fill(diff, N),
      'key-heavy infra': fill(infra, N),
      'base64 dump': fill(wrap(randomBytes(400_000).toString('base64'), 76).join('\n'), N),
    })
  })

  it('screens the end of a 465,000-character answer of each kind in 300 ms, and the end of its error in 60 ms', () => {
    // Measured at 17-51 ms and 0.7-5.3 ms (judge's p6), and under coverage, which makes the detectors four
    // or five times slower, at 46-127 ms and 4-20 ms. The bounds are for a quiet laptop and are multiplied by
    // how much slower this process is right now (within); the shapes below, not these, catch a quadratic.
    for (const [kind, text] of Object.entries(KINDS)) {
      expect(text.length).toBe(N)
      expect(bestOf3(() => screenText(text, MAX_OUTPUT_CHARS, SCREEN_LOOKBACK_CHARS)), kind).toBeLessThan(within(300))
      expect(bestOf3(() => screenText(text, MAX_ERROR_CHARS - 1, SCREEN_LOOKBACK_CHARS)), `${kind}, error`).toBeLessThan(within(60))
    }
  })

  // The random bytes of the shapes below come from a fixed seed that each growth test starts again for each size, so a shape's
  // 1 MB text and its 4 MB text are made of the same units and differ in length alone. (With fresh units, a 43-character value
  // that held a run of 40 letters and digits made the screen of its 1 MB text 5.9 times dearer under coverage than another
  // value's, and a ratio of 4 times the text came out at 26 against a bound of 12 once in about five runs.) This seed gives the
  // kty shapes a value of letters and digits only (no - or _ to split it), the dearer kind to screen: the bound is judged on that.
  let seeded = 3
  const reseed = (): void => {
    seeded = 3
  }
  const rb = (n: number): Buffer => {
    const b = Buffer.alloc(n)
    for (let i = 0; i < n; i++) {
      seeded = (Math.imul(seeded, 1664525) + 1013904223) | 0
      b[i] = (seeded >>> 24) & 0xff
    }
    return b
  }
  const r64 = (): string => rb(48).toString('base64')
  /** Inputs that once cost more than their length (fix-r1 cost findings): BEGIN lines with no line
   *  break between them, each of whose blocks searched the rest of the line for its end, and an
   *  RSAKeyValue member left open over whitespace, whose regex tried every way of sharing it. */
  const ONE_LINE: Record<string, (n: number) => string> = {
    'BEGIN lines on one line': (n) => fill('-----BEGIN PRIVATE KEY----- ', n),
    'PGP, SSH2 and OpenVPN BEGIN lines on one line': (n) =>
      fill('-----BEGIN PGP PRIVATE KEY BLOCK----- ---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ---- -----BEGIN OpenVPN Static key V1----- ', n),
    'BEGIN lines and base64 runs on one line': (n) => fill(`-----BEGIN PRIVATE KEY----- ${r64()} `, n),
    'RSAKeyValue members left open over spaces': (n) => fill(`<RSAKeyValue><D>${' '.repeat(4_000)}`, n),
    'RSAKeyValue members left open over line breaks': (n) => fill(`<RSAKeyValue><P>${'\n'.repeat(3_000)}`, n),
  }

  it.each(Object.keys(ONE_LINE))('screens the end of 465,000 characters of %s in under a second, as both computers do, and its error in 100 ms', (shape) => {
    // Measured at 10-29 ms and 1-7 ms (fix-r1 x-cost1), about twice that under coverage; before the
    // fix, 5.9 s and 0.5 s, and an open member over 4,000 spaces 9 s a window. (Bounds for what
    // costs seconds, with room for a loaded runner: what an answer costs is the 150 ms test above's.)
    const text = ONE_LINE[shape](N)
    expect(bestOf3(() => screenText(text, MAX_OUTPUT_CHARS, SCREEN_LOOKBACK_CHARS))).toBeLessThan(within(1_000))
    expect(bestOf3(() => screenText(text, MAX_OUTPUT_CHARS, SCREEN_LOOKBACK_CHARS, true)), 'cut by an older doing computer').toBeLessThan(within(1_000))
    expect(bestOf3(() => screenText(text, MAX_ERROR_CHARS - 1, SCREEN_LOOKBACK_CHARS)), 'error').toBeLessThan(within(100))
  })

  const BS = '\\'
  const lines = (n: number): string => Array.from({ length: n }, r64).join('\n')
  /** Inputs aimed at what the round-1 fixes added: the rest of a key block whose lines stopped
   *  keeping one width, JSON-escaped base64, written-out breaks walked back over, legacy headers,
   *  newline constants and short last lines above END lines (fix-r1 x-cost-c4: x3.3-x4.4 for 4
   *  times the text, 465,000 characters in 85 ms at most and an error's end in 13). */
  const ROUND1: Record<string, (n: number) => string> = {
    'a block that stops early, then key lines and an END line, repeated': (n) => fill(`-----BEGIN PRIVATE KEY-----\n${lines(3)}\n${r64().slice(0, 30)}\n${lines(2)}\n-----END PRIVATE KEY-----\n`, n),
    'one block that stops early, then key lines with an END line every two': (n) => `-----BEGIN PRIVATE KEY-----\n${lines(3)}\n${r64().slice(0, 30)}\n${fill(`${lines(2)}\n-----END PRIVATE KEY-----\n`, n)}`,
    'blocks that stop early, then base64 to the next block': (n) => fill(`-----BEGIN PRIVATE KEY-----\n${lines(2)}\n  ${lines(40)}\n`, n),
    'BEGIN lines with escaped slashes, no closing quote': (n) => fill(`-----BEGIN PRIVATE KEY-----${BS}n${r64().split('/').join(`${BS}/`)}${BS}n`, n),
    'written-out breaks between short runs': (n) => fill(`ab${BS}u000acd<br>ef%0Agh&#xA;ij${BS}x0akl\`n`, n),
    'DEK-Info lines above END lines': (n) => fill(`DEK-Info: AES-128-CBC,${'A1'.repeat(16)}\n\n${lines(2)}\n-----END RSA PRIVATE KEY-----\n`, n),
    'END lines under a newline constant each': (n) => fill(`"${r64()}" + System.lineSeparator()\n-----END PRIVATE KEY-----\n`, n),
    'short lines above END lines': (n) => fill(`${r64()}\nAbCd\n-----END PRIVATE KEY-----\n`, n),
  }

  it.each(Object.keys(ROUND1))('screens the end of 465,000 characters of %s in under a second, as both computers do, and its error in 100 ms', (shape) => {
    // (as above: bounds for what costs seconds)
    const text = ROUND1[shape](N)
    expect(bestOf3(() => screenText(text, MAX_OUTPUT_CHARS, SCREEN_LOOKBACK_CHARS))).toBeLessThan(within(1_000))
    expect(bestOf3(() => screenText(text, MAX_OUTPUT_CHARS, SCREEN_LOOKBACK_CHARS, true)), 'cut by an older doing computer').toBeLessThan(within(1_000))
    expect(bestOf3(() => screenText(text, MAX_ERROR_CHARS - 1, SCREEN_LOOKBACK_CHARS)), 'error').toBeLessThan(within(100))
  })

  /** Inputs built to make a detector or a rule do the most work per character. */
  const HOSTILE: Record<string, (n: number) => string> = {
    ...ONE_LINE,
    ...ROUND1,
    'BEGIN + one random line, repeated': (n) => fill(Array.from({ length: 64 }, () => `-----BEGIN RSA PRIVATE KEY-----\n${r64()}\n`).join(''), n),
    'BEGIN lines only': (n) => fill('-----BEGIN PRIVATE KEY-----\n', n),
    'END lines only, one line': (n) => fill('-----END PRIVATE KEY-----', n),
    'random key lines + END, repeated': (n) => fill(Array.from({ length: 64 }, () => `${r64()}\n${r64()}\n-----END PRIVATE KEY-----\n`).join(''), n),
    'one base64 line': (n) => rb(Math.ceil(n * 0.75)).toString('base64').slice(0, n),
    'wrapped base64 with a base64 BEGIN line in it': (n) => fill(`${Buffer.from('-----BEGIN PRIVATE KEY-----').toString('base64')}\n${wrap(rb(3_000).toString('base64'), 76).join('\n')}\n`, n),
    'kty members, repeated': (n) => fill(`{"kty":"EC","crv":"P-256","d":"${rb(32).toString('base64url')}"},`, n),
    'kty with no braces': (n) => fill(`kty: EC d: ${rb(32).toString('base64url')}\n`, n),
    'open braces then kty': (n) => fill(`${'{'.repeat(5_000)}"kty":"oct"`, n),
    'Private-Lines, repeated': (n) => fill(`Private-Lines: 9999\n${r64()}\n`, n),
    'RSAKeyValue tags, repeated': (n) => fill(`<RSAKeyValue><D>${rb(128).toString('base64')}</D>`, n),
    'URL-encoded BEGIN, repeated': (n) => fill(`-----BEGIN%20PRIVATE%20KEY-----%0A${encodeURIComponent(r64())}%0A`, n),
    'escaped line breaks between runs': (n) => fill(`${r64()}\\n`, n),
    'tokens, repeated': (n) => fill(`ghp_${rb(30).toString('base64').replace(/[+/=]/g, 'x').slice(0, 36)} `, n),
    'BEGIN blocks, then END lines with no BEGIN': (n) =>
      fill(
        Array.from({ length: 32 }, () => `-----BEGIN RSA PRIVATE KEY-----\n${r64()}\n${r64()}\n`).join('') + Array.from({ length: 32 }, () => `${r64()}\n${r64()}\n-----END PRIVATE KEY-----\n`).join(''),
        n,
      ),
    'a listing of key lines with long paths': (n) => fill(Array.from({ length: 64 }, (_, i) => `/home/dev/projects/infrastructure/deployment/keys/production/deploy.key:${i + 1}:${r64()}\n`).join(''), n),
    'PGP mentions and hashes, repeated': (n) => fill(`-----BEGIN PGP PRIVATE KEY BLOCK----- not here; digests:\n${r64().slice(0, 44)}\n${r64().slice(0, 44)}\n`, n),
    'a run of backslashes under a key block': (n) => `-----BEGIN PRIVATE KEY-----\n${lines(2)}\n${BS.repeat(n)}\n`,
    'a run of backslashes after Private-Lines': (n) => `Private-Lines: 9999\n${BS.repeat(n)}\n`,
    'a line of plus signs above an END line': (n) => `${lines(3)}\n${'+'.repeat(n)}x\n-----END PRIVATE KEY-----\n`,
    'a line of plus signs and spaces above an END line': (n) => `${lines(3)}\n${'+ '.repeat(n >> 1)}x\n-----END PRIVATE KEY-----\n`,
  }
  const MB = 1 << 20

  it.each(Object.keys(COST_SHAPES))('%s is screened and masked in step with its length', (shape) => {
    // Each took seconds to minutes before (a run of 60,000 backslashes 3.6 s, 1,000 plus signs 1.2 s).
    const [text, ask, bound] = COST_SHAPES[shape]
    expect(bestOf3(() => screenText(text, ask.keep, SCREEN_LOOKBACK_CHARS, ask.cutStart), within(bound) * 4), shape).toBeLessThan(within(bound))
    expect(bestOf3(() => maskForDisplay(text), within(bound) * 4), `${shape}, masked`).toBeLessThan(within(bound))
  })

  it('masks BEGIN lines on one line in step with their number: 4 MB of them take under 12 times as long as 1 MB', () => {
    // Each BEGIN line is masked to the end of its line, which was looked for once per BEGIN. The line ends in a line
    // break, as a log's do: with none, the search never found one and was never repeated.
    const one = fill('-----BEGIN PRIVATE KEY----- ', MB) + '\nnext line'
    const four = fill('-----BEGIN PRIVATE KEY----- ', 4 * MB) + '\nnext line'
    expect(maskForDisplay(one)).toBe('[REDACTED:private_key]\nnext line')
    const [t1, t4] = pair(() => maskForDisplay(one), () => maskForDisplay(four))
    expect(t4, `1 MB ${t1.toFixed(0)} ms, 4 MB ${t4.toFixed(0)} ms`).toBeLessThan(12 * t1)
  })

  it.each(Object.keys(HOSTILE))('grows in step with %s: 4 MB of it takes under 12 times as long as 1 MB', (shape) => {
    reseed()
    const one = HOSTILE[shape](MB)
    reseed()
    const four = HOSTILE[shape](4 * MB)
    // Linear is 4 times; measured at most 4.9 (judge's p6b) and 7 on a loaded laptop; a quadratic is 16.
    const [t1, t4] = pair(() => screenText(one), () => screenText(four))
    expect(t4, `${shape}: 1 MB ${t1.toFixed(0)} ms, 4 MB ${t4.toFixed(0)} ms`).toBeLessThan(12 * t1)
  })

  // The worst the 256 KB reach of a BEGIN line can make a screen read: a mention of a private key about 256 KB before the cut and a
  // base64 line within 4 KB of it (that is what makes the key detectors search back), over the slowest text per character.
  // Measured at 0.4-0.6 s for an answer on a loaded laptop (main 0.04-0.12) and 0.19 s for an error's end.
  it.each([
    'RSAKeyValue tags, repeated',
    'URL-encoded BEGIN, repeated',
    'random key lines + END, repeated',
    'a block that stops early, then key lines and an END line, repeated',
    'BEGIN lines and base64 runs on one line',
    'kty members, repeated',
  ])('screens the end of an answer with a key mentioned 256 KB before the cut, over %s, in a second, and its error in 300 ms', (shape) => {
    const REACH = 262_144
    const head = '-----BEGIN PRIVATE KEY----- mentioned in prose\n'
    reseed()
    const body = HOSTILE[shape](REACH - 8 + 1 + MAX_OUTPUT_CHARS - head.length - 200)
    const at = REACH - 8 - head.length
    const text = `${head}${body.slice(0, at)}\n${rb(90).toString('base64')}\n${body.slice(at, at + MAX_OUTPUT_CHARS + 400)}`
    expect(text.length - MAX_OUTPUT_CHARS - text.indexOf('PRIVATE KEY'), 'the mention is about 256 KB before the cut').toBeGreaterThan(REACH - 1_000)
    expect(bestOf3(() => screenText(text, MAX_OUTPUT_CHARS, SCREEN_LOOKBACK_CHARS), within(1_000) * 4), shape).toBeLessThan(within(1_000))
    expect(bestOf3(() => screenText(text, MAX_ERROR_CHARS - 1, SCREEN_LOOKBACK_CHARS), within(300) * 4), `${shape}, error`).toBeLessThan(within(300))
  })
})
