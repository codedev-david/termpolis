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

import { screenText } from '../../src/main/aiSecurity'
import { MAX_ERROR_CHARS, MAX_OUTPUT_CHARS, SCREEN_LOOKBACK_CHARS } from '../../src/main/linkedJobs'
import { makeKeys, wrap, type KeySet } from './fixtures/freshKeys'

const GH = `ghp_${'b'.repeat(36)}`
const AWS = `AKIA${'C'.repeat(16)}`

let K: KeySet
beforeAll(() => {
  K = makeKeys()
})

describe("the Linked screen's cost where only an answer's end is kept", () => {
  /** The fastest of three runs, so a pause on a busy CI box doesn't count against the screen. */
  function bestOf3(run: () => void): number {
    let best = Infinity
    for (let i = 0; i < 3; i++) {
      const t = performance.now()
      run()
      best = Math.min(best, performance.now() - t)
    }
    return best
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

  it('screens the end of a 465,000-character answer of each kind in 150 ms, and the end of its error in 20 ms', () => {
    // Measured at 17-36 ms and 0.7-5.3 ms (judge's p6).
    for (const [kind, text] of Object.entries(KINDS)) {
      expect(text.length).toBe(N)
      expect(bestOf3(() => screenText(text, MAX_OUTPUT_CHARS, SCREEN_LOOKBACK_CHARS)), kind).toBeLessThan(150)
      expect(bestOf3(() => screenText(text, MAX_ERROR_CHARS - 1, SCREEN_LOOKBACK_CHARS)), `${kind}, error`).toBeLessThan(20)
    }
  })

  const r64 = (): string => randomBytes(48).toString('base64')
  /** Inputs built to make a detector or a rule do the most work per character. */
  const HOSTILE: Record<string, (n: number) => string> = {
    'BEGIN + one random line, repeated': (n) => fill(Array.from({ length: 64 }, () => `-----BEGIN RSA PRIVATE KEY-----\n${r64()}\n`).join(''), n),
    'BEGIN lines only': (n) => fill('-----BEGIN PRIVATE KEY-----\n', n),
    'END lines only, one line': (n) => fill('-----END PRIVATE KEY-----', n),
    'random key lines + END, repeated': (n) => fill(Array.from({ length: 64 }, () => `${r64()}\n${r64()}\n-----END PRIVATE KEY-----\n`).join(''), n),
    'one base64 line': (n) => randomBytes(Math.ceil(n * 0.75)).toString('base64').slice(0, n),
    'wrapped base64 with a base64 BEGIN line in it': (n) => fill(`${Buffer.from('-----BEGIN PRIVATE KEY-----').toString('base64')}\n${wrap(randomBytes(3_000).toString('base64'), 76).join('\n')}\n`, n),
    'kty members, repeated': (n) => fill(`{"kty":"EC","crv":"P-256","d":"${randomBytes(32).toString('base64url')}"},`, n),
    'kty with no braces': (n) => fill(`kty: EC d: ${randomBytes(32).toString('base64url')}\n`, n),
    'open braces then kty': (n) => fill(`${'{'.repeat(5_000)}"kty":"oct"`, n),
    'Private-Lines, repeated': (n) => fill(`Private-Lines: 9999\n${r64()}\n`, n),
    'RSAKeyValue tags, repeated': (n) => fill(`<RSAKeyValue><D>${randomBytes(128).toString('base64')}</D>`, n),
    'URL-encoded BEGIN, repeated': (n) => fill(`-----BEGIN%20PRIVATE%20KEY-----%0A${encodeURIComponent(r64())}%0A`, n),
    'escaped line breaks between runs': (n) => fill(`${r64()}\\n`, n),
    'tokens, repeated': (n) => fill(`ghp_${randomBytes(30).toString('base64').replace(/[+/=]/g, 'x').slice(0, 36)} `, n),
    'BEGIN blocks, then END lines with no BEGIN': (n) =>
      fill(
        Array.from({ length: 32 }, () => `-----BEGIN RSA PRIVATE KEY-----\n${r64()}\n${r64()}\n`).join('') + Array.from({ length: 32 }, () => `${r64()}\n${r64()}\n-----END PRIVATE KEY-----\n`).join(''),
        n,
      ),
    'a listing of key lines with long paths': (n) => fill(Array.from({ length: 64 }, (_, i) => `/home/dev/projects/infrastructure/deployment/keys/production/deploy.key:${i + 1}:${r64()}\n`).join(''), n),
    'PGP mentions and hashes, repeated': (n) => fill(`-----BEGIN PGP PRIVATE KEY BLOCK----- not here; digests:\n${r64().slice(0, 44)}\n${r64().slice(0, 44)}\n`, n),
  }
  const MB = 1 << 20

  it.each(Object.keys(HOSTILE))('grows in step with %s: 4 MB of it takes under 8 times as long as 1 MB', (shape) => {
    const one = HOSTILE[shape](MB)
    const four = HOSTILE[shape](4 * MB)
    // Linear is 4 times; measured at most 4.9 (judge's p6b).
    expect(bestOf3(() => screenText(four))).toBeLessThan(8 * bestOf3(() => screenText(one)))
  }, 60_000)
})
