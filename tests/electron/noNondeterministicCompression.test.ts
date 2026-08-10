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
// transform. Nothing else in these two dirs may read a clock or randomness.

const ROOTS = [
  join(__dirname, '..', '..', 'src', 'main', 'headroom'),
  join(__dirname, '..', '..', 'src', 'main', 'headroomProxy'),
]
const EXEMPT = new Set(['proxySupervisor.ts'])
const FORBIDDEN = /\bDate\.now\s*\(|\bMath\.random\s*\(|\bperformance\.now\s*\(|\bprocess\.hrtime\b|\bnew Date\s*\(/

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
})
