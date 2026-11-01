import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The paths compressToolResult and retrieveFull take when something goes wrong, which the happy-path
 * suites never reach: a compressor that returns more than it was given, one that throws, and every kind
 * of failed redemption. Fail-open is the rule on both sides: the agent gets the pretty-printed original,
 * or a clear message, and nothing here ever throws into the request.
 */

const mode = vi.hoisted(() => ({ compressor: 'real' as 'real' | 'inflate' | 'throw' }))
vi.mock('../../src/main/headroom/compressors', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/headroom/compressors')>()
  return {
    ...real,
    compressArray: (...args: Parameters<typeof real.compressArray>) => {
      if (mode.compressor === 'throw') throw new Error('compressor blew up')
      if (mode.compressor === 'inflate') return { text: 'padding '.repeat(20_000) }
      return real.compressArray(...args)
    },
  }
})

const { compressToolResult, retrieveFull } = await import('../../src/main/headroom/compressToolResult')
const { ccrStash, ccrPut, resetCcr, CCR_MAX_ENTRIES } = await import('../../src/main/headroom/ccrStore')
const { resetLedger, summarizeSavings } = await import('../../src/main/headroom/savingsLedger')
const { resetProxyLedger } = await import('../../src/main/headroomProxy/proxyLedger')

/** An array big enough to be worth compressing at the default tier. */
const rows = Array.from({ length: 300 }, (_, i) => ({ id: i, file: `src/module${i}.ts`, line: i * 3, text: `match number ${i} in a reasonably long line of source` }))

describe('compressToolResult fails open', () => {
  beforeEach(() => { mode.compressor = 'real'; resetCcr(); resetLedger(); resetProxyLedger() })

  it('compresses an array when the compressor behaves', () => {
    expect(compressToolResult('code_search', rows).length).toBeLessThan(JSON.stringify(rows, null, 2).length)
  })

  it('returns the pretty-printed original when the compressor returns more than it was given: it never inflates', () => {
    mode.compressor = 'inflate'
    expect(compressToolResult('code_search', rows)).toBe(JSON.stringify(rows, null, 2))
    expect(summarizeSavings().cumulative.events).toBe(0) // and counts no saving it did not make
  })

  it('returns the pretty-printed original when the compressor throws', () => {
    mode.compressor = 'throw'
    expect(() => compressToolResult('code_search', rows)).not.toThrow()
    expect(compressToolResult('code_search', rows)).toBe(JSON.stringify(rows, null, 2))
  })

  it('does not let a string result of retrieve_full reach the compressor at all', () => {
    mode.compressor = 'throw'
    expect(compressToolResult('retrieve_full', 'a\nb')).toBe('a\nb')
  })
})

describe('retrieveFull reports every kind of failed redemption', () => {
  beforeEach(() => { mode.compressor = 'real'; resetCcr(); resetLedger(); resetProxyLedger() })

  const failures = (): { misses: number; bad: number; unknown: number; expired: number } => {
    const c = summarizeSavings().cumulative
    return { misses: c.retrieveMisses, bad: c.retrieveBadTokens, unknown: c.retrieveUnknownTokens, expired: c.retrieveExpired }
  }

  it('a handle that has the shape of ours and was never issued is unknown, not lost content', async () => {
    const out = await retrieveFull('hr_0000000000000000') as { error: string }
    expect(out.error).toBe('expired')
    expect(failures()).toEqual({ misses: 0, bad: 0, unknown: 1, expired: 0 })
  })

  it('a handle that could never have been minted is a bad token', async () => {
    const out = await retrieveFull('not-a-token') as { error: string }
    expect(out.error).toBe('expired')
    expect(failures()).toEqual({ misses: 0, bad: 1, unknown: 0, expired: 0 })
  })

  it('a handle whose content this store held and then evicted is a miss, the one that should never happen', async () => {
    const first = ccrStash('first')
    for (let i = 0; i < CCR_MAX_ENTRIES; i++) ccrStash(`fill-${i}`)
    const out = await retrieveFull(first) as { error: string }
    expect(out.error).toBe('expired')
    expect(failures()).toEqual({ misses: 1, bad: 0, unknown: 0, expired: 0 })
  })

  it('a handle whose content the disk cap aged out is expired: working as designed, not a defect', async () => {
    const fs = await import('fs')
    const os = await import('os')
    const path = await import('path')
    const { setCcrDir, _setCcrLimits, ccrStats, CCR_MAX_BYTES, CCR_MAX_ENTRY_BYTES } = await import('../../src/main/headroom/ccrStore')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-expired-'))
    try {
      setCcrDir(dir)
      const doomed = ccrStash({ v: 'x'.repeat(400) }) // oldest and fattest: first out
      for (let i = 0; i < CCR_MAX_ENTRIES + 5; i++) ccrPut(`hr_${i.toString(16).padStart(16, '0')}`, i)
      // A cap just under what is stored, so the next write trims the oldest entry and stops.
      _setCcrLimits(ccrStats().diskBytes - 1, CCR_MAX_ENTRY_BYTES)
      ccrPut(`hr_${'ff'.repeat(8)}`, 1)
      const out = await retrieveFull(doomed) as { error: string }
      expect(out.error).toBe('expired')
      expect(failures()).toEqual({ misses: 0, bad: 0, unknown: 0, expired: 1 })
      _setCcrLimits(CCR_MAX_BYTES, CCR_MAX_ENTRY_BYTES)
    } finally {
      resetCcr()
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  it('still resolves what is held, and counts nothing against it', async () => {
    ccrPut('hr_00000000000000aa', 'the original', 'proxy')
    expect(await retrieveFull('hr_00000000000000aa')).toBe('the original')
    expect(failures()).toEqual({ misses: 0, bad: 0, unknown: 0, expired: 0 })
  })
})
