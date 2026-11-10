import { describe, it, expect } from 'vitest'
import {
  decideSwitch, messageCost, emptyEconomy, isWarm, warmKey, PROFILES, TTL_5M, TTL_1H, HAIKU_MAX_CTX,
  type Economy,
} from '../../src/shared/switchEconomics'

const NOW = 1_000_000_000
const econ = (ctx: number, warm: Economy['warm'] = {}, ttlMs = TTL_5M): Economy => ({ ctx, warm, ttlMs })

describe('switchEconomics', () => {
  it('emptyEconomy starts cold on the 5 minute cache', () => {
    expect(emptyEconomy()).toEqual({ ctx: 0, warm: {}, ttlMs: TTL_5M })
  })

  it('isWarm follows the cache lifetime', () => {
    const e = econ(1000, { 'opus:medium': NOW - 60_000 })
    expect(isWarm(e, 'opus', NOW)).toBe(true)
    expect(isWarm(e, 'sonnet', NOW)).toBe(false)
    expect(isWarm(econ(1000, { 'opus:medium': NOW - TTL_5M }), 'opus', NOW)).toBe(false)
    expect(isWarm(econ(1000, { 'opus:medium': NOW - 10 * 60_000 }, TTL_1H), 'opus', NOW)).toBe(true)
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
      .toEqual({ model: 'sonnet', effort: null, switched: false, reason: 'same', saving: 0 })
  })

  it('moves down when the cheaper model pays for the re-read', () => {
    const d = decideSwitch({ current: 'opus', want: 'haiku', confidence: 0.4, economy: econ(20_000), now: NOW })
    expect(d.model).toBe('haiku')
    expect(d.switched).toBe(true)
    expect(d.reason).toBe('cheaper')
    expect(d.saving).toBeGreaterThan(0)
  })

  it('stays when the warm cache beats the cheaper price', () => {
    const d = decideSwitch({ current: 'opus', want: 'sonnet', confidence: 0.9, economy: econ(150_000, { 'opus:medium': NOW - 1_000 }), now: NOW })
    expect(d).toEqual({ model: 'opus', effort: null, switched: false, reason: 'switch-costs-more', saving: 0 })
  })

  it('never picks haiku for a conversation past its limit', () => {
    const big = econ(HAIKU_MAX_CTX + 1)
    expect(decideSwitch({ current: 'opus', want: 'haiku', confidence: 1, economy: big, now: NOW }).reason).toBe('too-big-for-haiku')
    // already on haiku: the message goes up to sonnet instead, gated like any up-switch
    expect(decideSwitch({ current: 'haiku', want: 'haiku', confidence: 1, economy: big, now: NOW }).reason).toBe('context-too-big')
    const warmSonnet = econ(HAIKU_MAX_CTX + 1, { 'sonnet:high': NOW - 1_000 })
    expect(decideSwitch({ current: 'haiku', want: 'haiku', confidence: 1, economy: warmSonnet, now: NOW }))
      .toMatchObject({ model: 'sonnet', switched: true, reason: 'needs-stronger' })
  })

  it('moves up only when sure enough and the re-read is affordable', () => {
    expect(decideSwitch({ current: 'haiku', want: 'opus', confidence: 0.5, economy: econ(1_000), now: NOW }).reason).toBe('not-sure-enough')
    expect(decideSwitch({ current: 'sonnet', want: 'opus', confidence: 0.9, economy: econ(160_000), now: NOW }).reason).toBe('context-too-big')
    const up = decideSwitch({ current: 'sonnet', want: 'opus', confidence: 0.9, economy: econ(160_000, { 'opus:medium': NOW - 1_000 }), now: NOW })
    expect(up).toMatchObject({ model: 'opus', switched: true, reason: 'needs-stronger' })
    expect(up.saving).toBeGreaterThan(0) // opus is warm, sonnet is not: the move even saves
    const cold = decideSwitch({ current: 'haiku', want: 'sonnet', confidence: 0.6, economy: econ(1_000), now: NOW })
    expect(cold.model).toBe('sonnet')
    expect(cold.saving).toBeLessThan(0) // a stronger model costs more
  })

  it('warmKey names the cache of a model and effort, the default when none is named', () => {
    expect(warmKey('opus')).toBe('opus:medium')
    expect(warmKey('sonnet', null)).toBe('sonnet:high')
    expect(warmKey('haiku', 'low')).toBe('haiku:low')
    const e = econ(1000, { 'opus:high': NOW - 1_000 })
    expect(isWarm(e, 'opus', NOW, 'high')).toBe(true)
    expect(isWarm(e, 'opus', NOW)).toBe(false) // another effort is another cache
  })

  it('messageCost scales the output with the effort', () => {
    const high = messageCost('opus', 0, 0, PROFILES.opus, 'high')
    expect(messageCost('opus', 0, 0, PROFILES.opus)).toBe(high)
    expect(messageCost('opus', 0, 0, PROFILES.opus, 'low')).toBeLessThan(high)
    expect(messageCost('opus', 0, 0, PROFILES.opus, 'max')).toBeGreaterThan(high)
  })

  it('a lighter effort on the same model must pay for its re-read', () => {
    // small context: the lower effort saves output and the re-read is cheap
    const d = decideSwitch({ current: 'opus', want: 'opus', confidence: 0.9, economy: econ(5_000, { 'opus:high': NOW - 1_000 }), now: NOW, currentEffort: 'high', wantEffort: 'low' })
    expect(d).toMatchObject({ model: 'opus', effort: 'low', switched: true, reason: 'lighter' })
    expect(d.saving).toBeGreaterThan(0)
    // a big warm conversation: re-reading it at the new effort costs more than the thinking saved
    const big = decideSwitch({ current: 'opus', want: 'opus', confidence: 0.9, economy: econ(170_000, { 'opus:high': NOW - 1_000 }), now: NOW, currentEffort: 'high', wantEffort: 'medium' })
    expect(big).toEqual({ model: 'opus', effort: 'high', switched: false, reason: 'switch-costs-more', saving: 0 })
  })

  it('more effort on the same model is gated like a move up', () => {
    const up = decideSwitch({ current: 'sonnet', want: 'sonnet', confidence: 0.9, economy: econ(10_000), now: NOW, currentEffort: 'medium', wantEffort: 'xhigh' })
    expect(up).toMatchObject({ model: 'sonnet', effort: 'xhigh', switched: true, reason: 'more-thought' })
    expect(decideSwitch({ current: 'sonnet', want: 'sonnet', confidence: 0.4, economy: econ(10_000), now: NOW, wantEffort: 'max' }).reason).toBe('not-sure-enough')
    expect(decideSwitch({ current: 'sonnet', want: 'sonnet', confidence: 0.9, economy: econ(160_000), now: NOW, wantEffort: 'max' }).reason).toBe('context-too-big')
  })

  it('no effort asked: the same model keeps its effort, another model takes its default', () => {
    expect(decideSwitch({ current: 'opus', want: 'opus', confidence: 1, economy: econ(1_000), now: NOW, currentEffort: 'high' }))
      .toMatchObject({ model: 'opus', effort: 'high', switched: false, reason: 'same' })
    // the default effort named explicitly is the same request as none
    expect(decideSwitch({ current: 'opus', want: 'opus', confidence: 1, economy: econ(1_000), now: NOW, wantEffort: 'medium' }).reason).toBe('same')
    const down = decideSwitch({ current: 'opus', want: 'haiku', confidence: 1, economy: econ(1_000), now: NOW, currentEffort: 'max' })
    expect(down).toMatchObject({ model: 'haiku', effort: 'medium', reason: 'cheaper' })
  })
})
