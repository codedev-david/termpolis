// The real-PTY harness's wait scale (tests/electron/_realPty.ts): an idle machine keeps its waits, a busy one gets longer ones,
// and none gets more than four times (MODELS-R2-6).
import { describe, it, expect } from 'vitest'
import { loadScale, machineScale } from './_realPty'

describe('loadScale', () => {
  it('keeps the wait on an idle machine, and grows it with how late a timer fires, to four times at most', () => {
    expect(loadScale(0)).toBe(1)
    expect(loadScale(-5)).toBe(1)
    expect(loadScale(5)).toBe(1.5)
    expect(loadScale(10)).toBe(2)
    expect(loadScale(30)).toBe(4)
    expect(loadScale(5000)).toBe(4)
  })

  it('measures this machine once, between one and four', async () => {
    const first = await machineScale()
    expect(first).toBeGreaterThanOrEqual(1)
    expect(first).toBeLessThanOrEqual(4)
    expect(await machineScale()).toBe(first)
  })
})
