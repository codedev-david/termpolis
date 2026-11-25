import { describe, it, expect } from 'vitest'
import {
  decideSwitch, messageCost, emptyEconomy, isWarm, warmKey, PROFILES, TTL_5M, TTL_1H, PRICE, BY_PRICE, ratesAt,
  CACHE_WRITE, type Economy,
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

  it("prices are Anthropic's first-party rates of 2026-11-03, cache reads a share per family", () => {
    expect(PRICE).toEqual({
      haiku: { in: 0.1, out: 0.5, cacheRead: 0.1, long: { above: 100_000, in: 0.5, out: 2.5 } },
      sonnet: { in: 2, out: 10, cacheRead: 0.05 },
      opus: { in: 4, out: 20, cacheRead: 0.05 },
      fable: { in: 8, out: 40, cacheRead: 0.025 },
    })
    expect(CACHE_WRITE).toBe(1.25)
    // Cheapest first, by what each one costs: Fable is the dearest, so nothing steps up to it.
    expect(BY_PRICE).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
  })

  it('ratesAt: Haiku bills a prompt past 100K tokens at its long-prompt rates; the others have one card', () => {
    expect(ratesAt('haiku', 100_000)).toEqual({ in: 0.1, out: 0.5 })
    expect(ratesAt('haiku', 100_001)).toEqual({ in: 0.5, out: 2.5 })
    expect(ratesAt('opus', 900_000)).toEqual({ in: 4, out: 20 })
    expect(ratesAt('fable', 0)).toEqual({ in: 8, out: 40 })
  })

  it('messageCost prices reads, writes, growth and output', () => {
    // haiku, empty context: only the growth write and the output.
    expect(messageCost('haiku', 0, 0, PROFILES.haiku)).toBeCloseTo((0.1 * 1_500 * 1.25 + 0.5 * 800) / 1e6, 12)
    // a warm cache reads at the family's share (0.05x on Opus), a cold one writes at 1.25x
    const warm = messageCost('opus', 10_000, 10_000, PROFILES.haiku)
    const cold = messageCost('opus', 10_000, 0, PROFILES.haiku)
    expect(cold).toBeGreaterThan(warm)
    expect(warm).toBeCloseTo((4 * (500 + 500 + 1_875) + 20 * 800) / 1e6, 12)
    // Fable reads its cache at 0.025x
    expect(messageCost('fable', 10_000, 10_000, { turns: 1, out: 0, grow: 0 })).toBeCloseTo((8 * 250) / 1e6, 12)
    // negative context and a cached figure outside 0..ctx clamp
    expect(messageCost('haiku', -5, 0, PROFILES.haiku)).toBe(messageCost('haiku', 0, 0, PROFILES.haiku))
    expect(messageCost('opus', 10_000, 99_999, PROFILES.haiku)).toBe(warm)
    expect(messageCost('opus', 10_000, -3, PROFILES.haiku)).toBe(cold)
    expect(messageCost('opus', 0, 0, { turns: 0, out: 0, grow: 0 })).toBe(0)
  })

  it('messageCost bills a Haiku message whose prompt passes 100K at the long-prompt rates', () => {
    // 98.5K of context plus the 1.5K it adds reaches 100K exactly: still the short card.
    expect(messageCost('haiku', 98_500, 98_500, PROFILES.haiku))
      .toBeCloseTo((0.1 * (9_850 + 9_850 + 1_875) + 0.5 * 800) / 1e6, 12)
    // 150K: every token of it at 0.50 in and 2.50 out, the cache shares unchanged.
    expect(messageCost('haiku', 150_000, 150_000, PROFILES.haiku))
      .toBeCloseTo((0.5 * (15_000 + 15_000 + 1_875) + 2.5 * 800) / 1e6, 12)
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

  it('a big conversation does not move to a cold Haiku: the long-prompt re-read costs more than it saves', () => {
    // Haiku 5.5 holds 1M tokens, so there is no size limit; the price is what stops it.
    const big = econ(150_000, { 'opus:medium': NOW - 1_000 })
    expect(decideSwitch({ current: 'opus', want: 'haiku', confidence: 1, economy: big, now: NOW }))
      .toEqual({ model: 'opus', effort: null, switched: false, reason: 'switch-costs-more', saving: 0 })
    // Under 100K the same move pays for its re-read.
    const mid = econ(50_000, { 'opus:medium': NOW - 1_000 })
    expect(decideSwitch({ current: 'opus', want: 'haiku', confidence: 1, economy: mid, now: NOW })).toMatchObject({ model: 'haiku', reason: 'cheaper' })
    // Already on Haiku with a big conversation: it is not pushed up to Sonnet.
    expect(decideSwitch({ current: 'haiku', want: 'haiku', confidence: 1, economy: econ(500_000), now: NOW }).reason).toBe('same')
  })

  it('Fable is above Opus: a step from Fable to Opus is a step down, and must pay for its re-read', () => {
    const small = decideSwitch({ current: 'fable', want: 'opus', confidence: 1, economy: econ(20_000), now: NOW })
    expect(small).toMatchObject({ model: 'opus', effort: 'medium', reason: 'cheaper', switched: true })
    expect(small.saving).toBeGreaterThan(0)
    const warmBig = econ(400_000, { 'fable:high': NOW - 1_000 })
    expect(decideSwitch({ current: 'fable', want: 'opus', confidence: 1, economy: warmBig, now: NOW }).reason).toBe('switch-costs-more')
    expect(warmKey('fable')).toBe('fable:high')
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
