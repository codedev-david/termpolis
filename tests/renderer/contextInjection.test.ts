import { describe, it, expect } from 'vitest'
import { buildInjectionPrompt, estimateTokens } from '../../src/renderer/src/lib/contextInjection'
import type { ContextPin } from '../../src/renderer/src/types'

const pin = (over: Partial<ContextPin> = {}): ContextPin => ({
  id: over.id ?? 'p1',
  createdAt: over.createdAt ?? 1000,
  label: over.label ?? 'Label',
  body: over.body ?? 'Body',
  source: over.source,
  tags: over.tags,
})

describe('buildInjectionPrompt', () => {
  it('returns empty when pins is empty', () => {
    const r = buildInjectionPrompt([])
    expect(r.prompt).toMatch(/Pinned context/)
    expect(r.includedPinIds).toEqual([])
    expect(r.omittedPinIds).toEqual([])
  })

  it('tolerates non-array input', () => {
    // @ts-expect-error — runtime defensive
    const r = buildInjectionPrompt(null)
    expect(r.prompt).toBe('')
  })

  it('includes header when provided', () => {
    const r = buildInjectionPrompt([pin({ label: 'A', body: 'body' })], { header: 'Resume auth work' })
    expect(r.prompt).toContain('Resume auth work')
  })

  it('renders pin label and body', () => {
    const r = buildInjectionPrompt([pin({ label: 'Key notes', body: 'stuff' })])
    expect(r.prompt).toContain('Key notes')
    expect(r.prompt).toContain('stuff')
  })

  it('includes metadata by default', () => {
    const r = buildInjectionPrompt([pin({ source: 'claude', tags: ['auth'] })])
    expect(r.prompt).toContain('source: claude')
    expect(r.prompt).toContain('tags: auth')
  })

  it('omits metadata when disabled', () => {
    const r = buildInjectionPrompt(
      [pin({ source: 'claude', tags: ['auth'] })],
      { includeMetadata: false },
    )
    expect(r.prompt).not.toContain('source:')
  })

  it('sorts by createdAt by default', () => {
    const r = buildInjectionPrompt([
      pin({ id: 'p2', label: 'B', createdAt: 200, body: 'two' }),
      pin({ id: 'p1', label: 'A', createdAt: 100, body: 'one' }),
    ])
    expect(r.prompt.indexOf('A')).toBeLessThan(r.prompt.indexOf('B'))
    expect(r.includedPinIds).toEqual(['p1', 'p2'])
  })

  it('preserves order when requested', () => {
    const r = buildInjectionPrompt(
      [
        pin({ id: 'p2', label: 'B', createdAt: 200, body: 'two' }),
        pin({ id: 'p1', label: 'A', createdAt: 100, body: 'one' }),
      ],
      { preserveOrder: true },
    )
    expect(r.includedPinIds).toEqual(['p2', 'p1'])
  })

  it('dedupes by id', () => {
    const r = buildInjectionPrompt([pin({ id: 'p1' }), pin({ id: 'p1' })])
    expect(r.includedPinIds).toEqual(['p1'])
  })

  it('filters invalid pins', () => {
    const r = buildInjectionPrompt([
      pin({ id: 'ok' }),
      // @ts-expect-error — runtime defensive
      { id: 42, label: 'no', body: 'no' },
      // @ts-expect-error — runtime defensive
      { id: 'x', label: 'no', body: 42 },
      // @ts-expect-error — runtime defensive
      null,
    ])
    expect(r.includedPinIds).toEqual(['ok'])
  })

  it('respects maxChars budget', () => {
    const big = 'x'.repeat(2000)
    const r = buildInjectionPrompt(
      [pin({ id: 'a', body: big }), pin({ id: 'b', body: big }), pin({ id: 'c', body: big })],
      { maxChars: 2500 },
    )
    expect(r.includedPinIds.length).toBeLessThan(3)
    expect(r.omittedPinIds.length).toBeGreaterThan(0)
    expect(r.prompt.length).toBeLessThanOrEqual(2500 + 500)
  })

  it('truncates first pin when even it exceeds budget', () => {
    const huge = 'y'.repeat(10_000)
    const r = buildInjectionPrompt([pin({ body: huge })], { maxChars: 500 })
    expect(r.includedPinIds).toHaveLength(1)
    expect(r.prompt).toContain('[truncated]')
  })

  it('ignores invalid maxChars <= 0', () => {
    const r = buildInjectionPrompt([pin()], { maxChars: 0 })
    expect(r.prompt).toContain('Body')
  })

  it('provides includedPinIds and totalChars', () => {
    const r = buildInjectionPrompt([pin()])
    expect(r.includedPinIds.length).toBe(1)
    expect(r.totalChars).toBe(r.prompt.length)
  })

  it('untitled label fallback', () => {
    const r = buildInjectionPrompt([pin({ label: '  ' })])
    expect(r.prompt).toContain('(untitled)')
  })
})

describe('estimateTokens', () => {
  it('returns 0 for empty result', () => {
    expect(estimateTokens({ prompt: '', includedPinIds: [], omittedPinIds: [], totalChars: 0 })).toBe(0)
  })

  it('divides chars by 4 and rounds up', () => {
    expect(estimateTokens({ prompt: 'x'.repeat(17), includedPinIds: [], omittedPinIds: [], totalChars: 17 })).toBe(5)
  })
})
