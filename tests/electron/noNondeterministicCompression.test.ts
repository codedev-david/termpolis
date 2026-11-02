import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

// CACHE SAFETY GUARD (build-failing). The compression TRANSFORM path must be a pure
// function of its input: identical bytes in → identical bytes out, forever. A wall-clock
// read or RNG anywhere in it would make the compressed request body vary run-to-run,
// busting Anthropic's deterministic prompt cache on EVERY request — the exact failure
// mode of the rejected v1.29.0 timeout-gated image path. This locks the invariant at the
// source so a future edit can't quietly reintroduce it (small stores never catch it).
//
// proxySupervisor.ts is exempt: its Date.now drives restart/backoff timing, not a content
// transform. receiptStore.ts is exempt: it makes the key and salt that sign an exported receipt, which is
// the one place randomness is the point, and nothing the proxy child imports reaches it (the child-imports
// test holds that). Nothing else in these two dirs may read a clock or randomness.

const ROOTS = [
  join(__dirname, '..', '..', 'src', 'main', 'headroom'),
  join(__dirname, '..', '..', 'src', 'main', 'headroomProxy'),
]
const EXEMPT = new Set(['proxySupervisor.ts', 'receiptStore.ts'])
// Every way a clock or a random number gets into a module: the usual calls, a bare Date() call, a computed
// member (Date['now'], performance['now']), the random calls of node's and the web's crypto, and the uptime.
// The last line is the bare words. A pattern for the CALL is blind to an alias taken once at module scope
// (`const clock = Date.now`, `const D = Date`, `const rnd = Math.random`) and read later under another name, so the
// objects themselves may not appear in these modules at all: nothing here has a use for the global Date, for
// Math.random, for performance, for globalThis or for Intl (whose formatters read the current time).
// noNondeterministicCompressionRuntime.test.ts is the other half: it runs the code under counters installed
// before the code is first evaluated, so an alias taken at load is a counted one.
const FORBIDDEN = new RegExp([
  String.raw`\bDate\.now\s*\(`, String.raw`\bnew Date\s*\(`, String.raw`\bDate\s*\(`, String.raw`\bDate\s*\[`,
  String.raw`\bMath\.random\s*\(`, String.raw`\bperformance\.now\s*\(`, String.raw`\bperformance\s*\[`, String.raw`\bprocess\.hrtime\b`,
  String.raw`\brandomUUID\b`, String.raw`\brandomBytes\b`, String.raw`\brandomInt\b`, String.raw`\brandomFill(?:Sync)?\b`,
  String.raw`\bgetRandomValues\b`, String.raw`\bcrypto\.random`, String.raw`\buptime\s*\(`,
  String.raw`\[\s*['"\x60]now['"\x60]\s*\]`,
  String.raw`\bDate\b`, String.raw`\bMath\s*(?:\.\s*random\b|\[)`, String.raw`\bperformance\b`, String.raw`\bglobalThis\b`, String.raw`\bIntl\b`,
].join('|'))

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...tsFiles(p))
    else if (e.endsWith('.ts') && !e.endsWith('.d.ts')) out.push(p)
  }
  return out
}

describe('compression path is clock/RNG-free (deterministic → cache-safe)', () => {
  it('has no Date.now / Math.random / performance.now / hrtime / new Date in the transform path', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const f of tsFiles(root)) {
        if (EXEMPT.has(f.split(/[\\/]/).pop() as string)) continue
        readFileSync(f, 'utf8')
          .split('\n')
          .forEach((ln, i) => {
            if (FORBIDDEN.test(ln)) offenders.push(`${f}:${i + 1}  ${ln.trim()}`)
          })
      }
    }
    expect(offenders).toEqual([])
  })

  it('actually covers the v1.34.0 transform modules, and none of them is exempt', () => {
    // A guard that silently stops scanning a file is worse than no guard. diffEncode emits wire
    // bytes and ccrStore mints the tokens embedded in them — both must stay in the swept set.
    const scanned = new Set(ROOTS.flatMap((r) => tsFiles(r)).map((f) => f.split(/[\\/]/).pop() as string))
    for (const f of ['diffEncode.ts', 'ccrStore.ts', 'wireCompress.ts', 'unifiedReceipt.ts', 'savingsLedger.ts']) {
      expect(scanned.has(f)).toBe(true)
      expect(EXEMPT.has(f)).toBe(false)
    }
  })

  it('sweeps the elision ledger, the stash metadata, the turn-shape parse and the stub-kind tally too', () => {
    // v1.55: these write or decide nothing on the wire, but the metadata rides every stash and the
    // tally reads the forwarded body, so a clock in any of them would be a clock in the transform's
    // neighbourhood. They must stay in the swept set and out of the exempt one.
    const scanned = new Set(ROOTS.flatMap((r) => tsFiles(r)).map((f) => f.split(/[\\/]/).pop() as string))
    for (const f of ['elisionLedger.ts', 'elisionMeta.ts', 'elisionStore.ts', 'elisionHealth.ts', 'wireTier.ts', 'forwardedKinds.ts', 'usageParse.ts', 'proxyLedger.ts']) {
      expect(scanned.has(f)).toBe(true)
      expect(EXEMPT.has(f)).toBe(false)
    }
  })
})

/**
 * The sweep above is only worth what its pattern catches. These are the forms a clock or a random number
 * could take, each of which an earlier, narrower pattern let through: it has to flag every one, and none
 * of the ordinary code that sits beside them.
 */
describe('the sweep pattern itself', () => {
  const FLAGGED = [
    'const t = Date.now()', 'const d = new Date()', 'const d = Date()', "const t = Date['now']()", 'const t = Date  [k]()',
    'const r = Math.random()', 'const t = performance.now()', "const t = performance['now']()", 'const t = process.hrtime()',
    'const t = process.hrtime.bigint()', 'const id = crypto.randomUUID()', "const b = randomBytes(8)", 'const n = randomInt(5)',
    'crypto.getRandomValues(new Uint8Array(4))', 'webcrypto.getRandomValues(a)', 'randomFillSync(buf)', 'const u = process.uptime()',
    'const u = os.uptime()', 'const k = globalThis[`now`]',
  ]
  // The aliases a call-shaped pattern cannot see: the clock or the generator is TAKEN at module scope and called
  // later under another name, so the line that reads it has no `Date.now(` in it. Each of these was planted in the
  // rewriter by a verifier and passed both this sweep and the runtime net before the bare words were added.
  const ALIASED = [
    'const clock = Date.now', 'const __D = Date', 'const rnd = Math.random', "const r = Math['random']",
    'const tick = performance.now.bind(performance)', "const stamp = Date['no' + 'w']", 'const fmt = new Intl.DateTimeFormat(\'en\')',
    'const g = globalThis', 'const { now } = Date', 'const T = typeof Date',
  ]
  const FINE = [
    'const hash = crypto.createHash(\'sha1\').update(s).digest(\'hex\')', 'const isoDate = format(x)', 'type DateLike = string',
    'const candidate = makeCandidate(text)', 'export function updateDate(x) {}', 'const knowledge = 1', 'const nowhere = 2',
    'const now = elisionRevision()', 'revision++',
    // Words that only contain the bare ones, and are ordinary code.
    'const performanceBudget = 3', 'const mathRandomFree = true', 'type DateRange = [number, number]', 'const globalThisIsNot = 1',
    'const internationalised = false', 'const Mathematics = 1',
  ]
  it.each(FLAGGED)('flags %s', (line) => { expect(FORBIDDEN.test(line)).toBe(true) })
  it.each(ALIASED)('flags the alias %s, where it is taken', (line) => { expect(FORBIDDEN.test(line)).toBe(true) })
  it.each(FINE)('lets %s through', (line) => { expect(FORBIDDEN.test(line)).toBe(false) })
})
