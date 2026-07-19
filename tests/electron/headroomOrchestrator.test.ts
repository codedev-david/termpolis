import { describe, it, expect, beforeEach } from 'vitest'
const { compressToolResult } = await import('../../src/main/headroom/compressToolResult')
import { setSettings, resetSettings } from '../../src/main/headroom/config'
import { resetCcr, ccrRetrieve } from '../../src/main/headroom/ccrStore'
import { resetLedger, summarizeSavings } from '../../src/main/headroom/savingsLedger'

const bigSearch = () => Array.from({ length: 100 }, (_, i) => ({ name: `sym${i}`, kind: 'function', file: 'src/a.ts', startLine: i, endLine: i + 5, lang: 'ts' }))
const pretty = (v: unknown) => JSON.stringify(v, null, 2)

describe('compressToolResult', () => {
  beforeEach(() => { resetSettings(); resetCcr(); resetLedger() })

  it('compresses a big code_search and records the saving', () => {
    const arr = bigSearch()
    const text = compressToolResult('code_search', arr)
    expect(text.length).toBeLessThan(pretty(arr).length)
    expect(text).toContain('retrieve_full')
    expect(summarizeSavings().session.netSaved).toBeGreaterThan(0)
  })

  it('stashes the full original so retrieve_full can recover it', () => {
    const arr = bigSearch()
    const text = compressToolResult('code_search', arr)
    const token = text.match(/hr_[a-z0-9]+/)![0]
    expect(ccrRetrieve(token)).toEqual(arr)
  })

  it('compresses a large object result (read_output) and offloads it reversibly', () => {
    const big = { output: Array.from({ length: 2000 }, (_, i) => `log line ${i}`).join('\n') }
    const text = compressToolResult('read_output', big)
    expect(text.length).toBeLessThan(pretty(big).length)
    expect(text).toContain('retrieve_full')
    const token = text.match(/hr_[a-z0-9]+/)![0]
    expect(ccrRetrieve(token)).toEqual(big)
  })

  it('passes memory_* through byte-identical (brain non-interference)', () => {
    const mem = [{ id: 'm1', content: 'x'.repeat(5000) }]
    expect(compressToolResult('memory_search', mem)).toBe(pretty(mem))
  })

  it('passes through when disabled', () => {
    setSettings({ enabled: false })
    const arr = bigSearch()
    expect(compressToolResult('code_search', arr)).toBe(pretty(arr))
  })

  it('passes through small results under the token floor', () => {
    const small = [{ name: 'a' }]
    expect(compressToolResult('code_search', small)).toBe(pretty(small))
  })

  it('passes through above the byte cap (perf guard)', () => {
    const huge = [{ blob: 'z'.repeat(4_100_000) }]
    expect(compressToolResult('code_search', huge)).toBe(pretty(huge))
  })

  it('is fail-open: a serialization error returns without throwing', () => {
    const circular: Record<string, unknown> = {}; circular.self = circular
    expect(() => compressToolResult('read_output', circular)).not.toThrow()
  })
})
