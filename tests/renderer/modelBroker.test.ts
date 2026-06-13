import { describe, it, expect } from 'vitest'
import {
  recommendTier,
  resolveModelFlag,
  tierCostRatio,
  estimateSavingsPct,
  brokerModel,
  claudeModelGuidance,
  AGENT_MODEL_TIERS,
} from '../../src/renderer/src/lib/modelBroker'

describe('modelBroker', () => {
  describe('recommendTier', () => {
    it('sends hard / architectural work to the premium model', () => {
      expect(recommendTier({ complexity: 4, tokenIntensity: 'low' })).toBe('premium')
      expect(recommendTier({ complexity: 5, tokenIntensity: 'high' })).toBe('premium')
    })
    it('sends trivial / boilerplate work to the cheapest model', () => {
      expect(recommendTier({ complexity: 1, tokenIntensity: 'low' })).toBe('economy')
      expect(recommendTier({ complexity: 2, tokenIntensity: 'high' })).toBe('economy')
    })
    it('keeps moderate work on the balanced model, but downshifts a token-heavy routine task', () => {
      expect(recommendTier({ complexity: 3, tokenIntensity: 'low' })).toBe('standard')
      expect(recommendTier({ complexity: 3, tokenIntensity: 'medium' })).toBe('standard')
      // big-but-routine → cheapest, where savings are largest
      expect(recommendTier({ complexity: 3, tokenIntensity: 'high' })).toBe('economy')
    })
  })

  describe('resolveModelFlag', () => {
    it('maps Claude tiers to its --model aliases', () => {
      expect(resolveModelFlag('claude', 'economy')).toBe('--model haiku')
      expect(resolveModelFlag('claude', 'standard')).toBe('--model sonnet')
      expect(resolveModelFlag('claude', 'premium')).toBe('--model opus')
    })
    it('returns no flag for an agent without model control (it runs its default)', () => {
      expect(resolveModelFlag('gemini', 'economy')).toBe('')
      expect(resolveModelFlag('codex', 'premium')).toBe('')
      expect(resolveModelFlag('unknown-agent', 'standard')).toBe('')
    })
  })

  describe('cost + savings', () => {
    it('reports each tier as a fraction of premium cost', () => {
      expect(tierCostRatio('claude', 'premium')).toBe(1)
      expect(tierCostRatio('claude', 'standard')).toBe(0.6)
      expect(tierCostRatio('claude', 'economy')).toBe(0.2)
      expect(tierCostRatio('gemini', 'economy')).toBe(1) // unknown → assume full cost
    })
    it('estimates whole-percent savings vs always running premium', () => {
      expect(estimateSavingsPct('claude', 'premium')).toBe(0)
      expect(estimateSavingsPct('claude', 'standard')).toBe(40)
      expect(estimateSavingsPct('claude', 'economy')).toBe(80)
    })
  })

  describe('brokerModel', () => {
    it('produces a tier, a Claude model flag, and a savings estimate for a simple task', () => {
      expect(brokerModel('claude', { complexity: 1, tokenIntensity: 'low' })).toEqual({
        tier: 'economy',
        modelFlag: '--model haiku',
        savingsPct: 80,
      })
    })
    it('keeps the premium model (no savings) for hard work', () => {
      expect(brokerModel('claude', { complexity: 5, tokenIntensity: 'low' })).toEqual({
        tier: 'premium',
        modelFlag: '--model opus',
        savingsPct: 0,
      })
    })
    it('recommends a tier but no flag for an agent without model control', () => {
      const d = brokerModel('gemini', { complexity: 1, tokenIntensity: 'low' })
      expect(d.tier).toBe('economy')
      expect(d.modelFlag).toBe('')
    })
  })

  describe('claudeModelGuidance', () => {
    it('mentions every Claude alias so the conductor can downshift', () => {
      const g = claudeModelGuidance()!
      expect(g).toContain('--model haiku')
      expect(g).toContain('--model sonnet')
      expect(g).toContain('--model opus')
      expect(g).toContain('ONLY optional flag')
    })
    it('stays in sync with the registry (built from AGENT_MODEL_TIERS, not hardcoded)', () => {
      expect(claudeModelGuidance()).toContain(`--model ${AGENT_MODEL_TIERS.claude.standard}`)
    })
  })
})
