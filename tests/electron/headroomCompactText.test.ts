import { describe, it, expect } from 'vitest'
const { compactText } = await import('../../src/main/headroom/compactText')

describe('compactText', () => {
  it('leaves small text untouched', () => {
    const r = compactText('a\nb\nc', { headLines: 10, tailLines: 10, maxChars: 1000 })
    expect(r).toEqual({ text: 'a\nb\nc', elided: false })
  })

  it('collapses runs of identical consecutive lines', () => {
    const r = compactText('x\nx\nx\ny', { headLines: 10, tailLines: 10, maxChars: 1000 })
    expect(r.text).toBe('x\n… (×2 identical lines)\ny')
    expect(r.elided).toBe(true)
  })

  it('applies a head/tail window when over the line budget', () => {
    const src = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n')
    const r = compactText(src, { headLines: 2, tailLines: 2, maxChars: 100000 })
    expect(r.elided).toBe(true)
    expect(r.text.startsWith('line0\nline1\n')).toBe(true)
    expect(r.text.endsWith('\nline98\nline99')).toBe(true)
    expect(r.text).toContain('lines elided')
  })
})
