import { describe, it, expect } from 'vitest'
import {
  decideSwitch, messageCost, emptyEconomy, isWarm, PROFILES, TTL_5M, TTL_1H, HAIKU_MAX_CTX,
  type Economy,
} from '../../src/shared/switchEconomics'

const NOW = 1_000_000_000
const econ = (ctx: number, warm: Economy['warm'] = {}, ttlMs = TTL_5M): Economy => ({ ctx, warm, ttlMs })

describe('switchEconomics', () => {
  it('emptyEconomy starts cold on the 5 minute cache', () => {
    expect(emptyEconomy()).toEqual({ ctx: 0, warm: {}, ttlMs: TTL_5M })
  })

  it('isWarm follows the cache lifetime', () => {
    const e = econ(1000, { opus: NOW - 60_000 })
    expect(isWarm(e, 'opus', NOW)).toBe(true)
    expect(isWarm(e, 'sonnet', NOW)).toBe(false)
    expect(isWarm(econ(1000, { opus: NOW - TTL_5M }), 'opus', NOW)).toBe(false)
    expect(isWarm(econ(1000, { opus: NOW - 10 * 60_000 }, TTL_1H), 'opus', NOW)).toBe(true)
  })

  it('messageCost prices reads, writes, growth and output', () => {
    // haiku, empty context: only the growth write and the output.
    expect(messageCost('haiku', 0, 0, PROFILES.haiku)).toBeCloseTo((1_500 * 1.25 + 5 * 800) / 1e6, 10)
    // a warm cache reads at 0.1x, a cold one writes at 1.25x
    const warm = messageCost('opus', 10_000, 10_000, PROFILES.haiku)
    const cold = messageCost('opus', 10_000, 0, PROFILES.haiku)
    expect(cold).toBeGreaterThan(warm)
    expect(warm).toBeCloseTo((5 * (1_000 + 1_000 + 1_875) + 25 * 800) / 1e6, 10)
    // negative context and a cached figure outside 0..ctx clamp
    expect(messageCost('haiku', -5, 0, PROFILES.haiku)).toBe(messageCost('haiku', 0, 0, PROFILES.haiku))
    expect(messageCost('opus', 10_000, 99_999, PROFILES.haiku)).toBe(warm)
    expect(messageCost('opus', 10_000, -3, PROFILES.haiku)).toBe(cold)
    expect(messageCost('opus', 0, 0, { turns: 0, out: 0, grow: 0 })).toBe(0)
  })

  it('stays when the message wants the model already running', () => {
    expect(decideSwitch({ current: 'sonnet', want: 'sonnet', confidence: 1, economy: econ(5_000), now: NOW }))
      .toEqual({ model: 'sonnet', switched: false, reason: 'same', saving: 0 })
  })

  it('moves down when the cheaper model pays for the re-read', () => {
    const d = decideSwitch({ current: 'opus', want: 'haiku', confidence: 0.4, economy: econ(20_000), now: NOW })
    expect(d.model).toBe('haiku')
    expect(d.switched).toBe(true)
    expect(d.reason).toBe('cheaper')
    expect(d.saving).toBeGreaterThan(0)
  })

  it('stays when the warm cache beats the cheaper price', () => {
    const d = decideSwitch({ current: 'opus', want: 'sonnet', confidence: 0.9, economy: econ(150_000, { opus: NOW - 1_000 }), now: NOW })
    expect(d).toEqual({ model: 'opus', switched: false, reason: 'switch-costs-more', saving: 0 })
  })

  it('never picks haiku for a conversation past its limit', () => {
    const big = econ(HAIKU_MAX_CTX + 1)
    expect(decideSwitch({ current: 'opus', want: 'haiku', confidence: 1, economy: big, now: NOW }).reason).toBe('too-big-for-haiku')
    // already on haiku: the message goes up to sonnet instead, gated like any up-switch
    expect(decideSwitch({ current: 'haiku', want: 'haiku', confidence: 1, economy: big, now: NOW }).reason).toBe('context-too-big')
    const warmSonnet = econ(HAIKU_MAX_CTX + 1, { sonnet: NOW - 1_000 })
    expect(decideSwitch({ current: 'haiku', want: 'haiku', confidence: 1, economy: warmSonnet, now: NOW }))
      .toMatchObject({ model: 'sonnet', switched: true, reason: 'needs-stronger' })
  })

  it('moves up only when sure enough and the re-read is affordable', () => {
    expect(decideSwitch({ current: 'haiku', want: 'opus', confidence: 0.5, economy: econ(1_000), now: NOW }).reason).toBe('not-sure-enough')
    expect(decideSwitch({ current: 'sonnet', want: 'opus', confidence: 0.9, economy: econ(160_000), now: NOW }).reason).toBe('context-too-big')
    const up = decideSwitch({ current: 'sonnet', want: 'opus', confidence: 0.9, economy: econ(160_000, { opus: NOW - 1_000 }), now: NOW })
    expect(up).toMatchObject({ model: 'opus', switched: true, reason: 'needs-stronger' })
    expect(up.saving).toBeGreaterThan(0) // opus is warm, sonnet is not: the move even saves
    const cold = decideSwitch({ current: 'haiku', want: 'sonnet', confidence: 0.6, economy: econ(1_000), now: NOW })
    expect(cold.model).toBe('sonnet')
    expect(cold.saving).toBeLessThan(0) // a stronger model costs more
  })
})
