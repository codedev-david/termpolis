import { describe, expect, it } from 'vitest'
import { CARGO_LABELS, CARGO_OF_KIND, cargoLabel, cargoOf } from '../../src/main/world/cargoTypes'

describe('world cargo types', () => {
  it('maps a line to a human cargo type by the first boundary it crosses, an import to code', () => {
    expect(cargoOf([])).toBe('code')
    expect(cargoOf(['env', 'ipc'])).toBe('settings')
    expect(cargoOf(['spawn'])).toBe('jobs')
    expect(cargoOf(['http-out'])).toBe('requests')
  })

  it('collapses every boundary kind into a few types, each with legend words', () => {
    const types = new Set(Object.values(CARGO_OF_KIND))
    expect(types.size).toBeLessThanOrEqual(8)
    for (const t of [...types, 'code']) expect(CARGO_LABELS[t]).toMatch(/^[A-Z]/)
  })

  it('words a code-derived key, and keeps a model-written key as it is', () => {
    expect(cargoLabel('settings')).toBe('Settings from the environment')
    expect(cargoLabel('code')).toBe('Code')
    expect(cargoLabel('orders')).toBe('orders')
    expect(cargoLabel('toString')).toBe('toString')
  })
})
