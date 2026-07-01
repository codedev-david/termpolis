import { describe, it, expect } from 'vitest'
import {
  normalizeKey,
  poolLessons,
  detectConflicts,
  type AgentLesson,
} from '../../src/main/mnemeSociety'

describe('mnemeSociety', () => {
  describe('normalizeKey — canonical match key for the "same" lesson across agents', () => {
    it('lowercases, collapses internal whitespace (spaces/tabs/newlines), and trims the ends', () => {
      expect(normalizeKey('  Rebuild   THE\tCache\n ')).toBe('rebuild the cache')
    })

    it('strips trailing sentence punctuation and any whitespace trailing with it', () => {
      expect(normalizeKey('Rebuild the cache.')).toBe('rebuild the cache')
      expect(normalizeKey('Rebuild the cache!!! ')).toBe('rebuild the cache')
      expect(normalizeKey('Rebuild the cache ?')).toBe('rebuild the cache')
      expect(normalizeKey('Rebuild the cache …')).toBe('rebuild the cache')
      expect(normalizeKey('Rebuild the cache,')).toBe('rebuild the cache')
    })

    it('preserves leading text and INTERNAL punctuation (only the tail is trimmed)', () => {
      expect(normalizeKey('Fix: the a.b.c path, then retry.')).toBe('fix: the a.b.c path, then retry')
    })

    it('maps drifted phrasings of one lesson to the SAME key, and distinct lessons to distinct keys', () => {
      expect(normalizeKey('Use HNSW for search.')).toBe(normalizeKey('use   hnsw for search'))
      expect(normalizeKey('use hnsw')).not.toBe(normalizeKey('use faiss'))
    })

    it('reduces all-whitespace / all-punctuation / empty content to an empty key', () => {
      expect(normalizeKey('   ')).toBe('')
      expect(normalizeKey('...')).toBe('')
      expect(normalizeKey('')).toBe('')
    })
  })

  describe('poolLessons — fuse the same lesson learned by different agents', () => {
    it('returns [] for empty input', () => {
      expect(poolLessons([])).toEqual([])
    })

    it('passes a single-source lesson through with NO corroboration boost', () => {
      const out = poolLessons([{ source: 'claude', content: 'Prefer async fs.', importance: 0.8 }])
      expect(out).toHaveLength(1)
      expect(out[0].sources).toEqual(['claude'])
      expect(out[0].corroboration).toBe(1)
      expect(out[0].content).toBe('Prefer async fs.')
      expect(out[0].importance).toBeCloseTo(0.8, 3) // *1.0 (corroboration 1)
    })

    it('defaults a missing importance to the neutral 0.5', () => {
      const out = poolLessons([{ source: 'claude', content: 'undated note' }])
      expect(out[0].importance).toBeCloseTo(0.5, 3)
    })

    it('keeps genuinely distinct lessons in separate groups', () => {
      const out = poolLessons([
        { source: 'claude', content: 'lesson one' },
        { source: 'codex', content: 'lesson two' },
      ])
      expect(out).toHaveLength(2)
    })

    it('fuses one lesson from three agents: distinct sources, corroboration=3, longest representative', () => {
      const out = poolLessons([
        { source: 'claude', content: 'Always rebuild the cache after a schema change' }, // 46 chars
        { source: 'codex', content: 'Always rebuild the cache after a schema change...' }, // longest → representative
        { source: 'gemini', content: 'always rebuild the cache after a schema change' }, // not longer
      ])
      expect(out).toHaveLength(1)
      expect(out[0].sources).toEqual(['claude', 'codex', 'gemini'])
      expect(out[0].corroboration).toBe(3)
      expect(out[0].content).toBe('Always rebuild the cache after a schema change...')
      // max(default 0.5) * (1 + min(0.3, 0.1*2)) = 0.5 * 1.2 = 0.6
      expect(out[0].importance).toBeCloseTo(0.6, 3)
    })

    it('treats the SAME source repeating as corroboration 1 (no boost) yet still keeps the longest wording', () => {
      const out = poolLessons([
        { source: 'claude', content: 'use hnsw', importance: 0.9 },
        { source: 'claude', content: 'Use HNSW.', importance: 0.4 }, // same source, same key, longer text
      ])
      expect(out).toHaveLength(1)
      expect(out[0].sources).toEqual(['claude'])
      expect(out[0].corroboration).toBe(1)
      expect(out[0].content).toBe('Use HNSW.')
      expect(out[0].importance).toBeCloseTo(0.9, 3) // max(0.9, 0.4) = 0.9, no boost
    })

    it('takes the MAX member importance across a group, not the first or last seen', () => {
      const out = poolLessons([
        { source: 'claude', content: 'shared lesson', importance: 0.3 },
        { source: 'codex', content: 'shared lesson', importance: 0.7 }, // the max
        { source: 'gemini', content: 'shared lesson', importance: 0.5 },
      ])
      expect(out[0].corroboration).toBe(3)
      expect(out[0].importance).toBeCloseTo(0.84, 3) // 0.7 * 1.2
    })

    it('boosts importance +10% per corroborating source and CAPS the factor at +30%', () => {
      const many = (n: number) =>
        poolLessons(
          Array.from({ length: n }, (_, i) => ({ source: `agent${i}`, content: 'x', importance: 0.5 })),
        )[0]
      expect(many(1).importance).toBeCloseTo(0.5, 3) // *1.0
      expect(many(2).importance).toBeCloseTo(0.55, 3) // *1.1
      expect(many(3).importance).toBeCloseTo(0.6, 3) // *1.2
      expect(many(4).importance).toBeCloseTo(0.65, 3) // *1.3 (min hits the cap exactly)
      expect(many(5).importance).toBeCloseTo(0.65, 3) // *1.3 (capped — same as 4)
      expect(many(9).importance).toBeCloseTo(0.65, 3) // still capped
    })

    it('clamps the boosted importance to at most 1.0', () => {
      const out = poolLessons([
        { source: 'claude', content: 'max lesson', importance: 1 },
        { source: 'codex', content: 'max lesson', importance: 1 },
      ])
      expect(out[0].corroboration).toBe(2)
      expect(out[0].importance).toBe(1) // 1.0 * 1.1 = 1.1 → clamped to 1.0
    })

    it('orders results by corroboration desc, then importance desc (tie-break)', () => {
      const out = poolLessons([
        { source: 'claude', content: 'low solo', importance: 0.2 }, // corr 1, imp 0.2
        { source: 'codex', content: 'high solo', importance: 0.95 }, // corr 1, imp 0.95
        { source: 'claude', content: 'team lesson', importance: 0.5 }, // corr 3
        { source: 'codex', content: 'team lesson', importance: 0.5 },
        { source: 'gemini', content: 'team lesson', importance: 0.5 },
      ])
      expect(out.map((p) => p.content)).toEqual(['team lesson', 'high solo', 'low solo'])
      expect(out.map((p) => p.corroboration)).toEqual([3, 1, 1])
    })

    it('carries an optional memoryType field through the AgentLesson input without disturbing pooling', () => {
      const out = poolLessons([
        { source: 'claude', content: 'procedural tip', memoryType: 'procedural', importance: 0.6 },
      ])
      expect(out).toHaveLength(1)
      expect(out[0].importance).toBeCloseTo(0.6, 3)
    })
  })

  describe('detectConflicts — surface contradictions ONLY across different agents', () => {
    const L = (source: string, content: string): AgentLesson => ({ source, content })

    it('reports a contradicting pair from two different sources', () => {
      const a = L('claude', 'always tabs')
      const b = L('codex', 'always spaces')
      expect(detectConflicts([a, b], () => true)).toEqual([{ a, b }])
    })

    it('never reports a pair from the SAME source, even when the predicate says they contradict', () => {
      const lessons = [L('claude', 'x'), L('claude', 'not x')]
      expect(detectConflicts(lessons, () => true)).toEqual([])
    })

    it('honors the injected predicate — non-contradicting pairs are dropped', () => {
      const lessons = [L('claude', 'use tabs'), L('codex', 'use spaces'), L('gemini', 'unrelated note')]
      const contradicts = (a: AgentLesson, b: AgentLesson) =>
        (a.content.includes('tabs') && b.content.includes('spaces')) ||
        (a.content.includes('spaces') && b.content.includes('tabs'))
      expect(detectConflicts(lessons, contradicts)).toEqual([{ a: lessons[0], b: lessons[1] }])
    })

    it('reports each unordered cross-source pair exactly once, in stable i<j order', () => {
      const lessons = [L('claude', 'a'), L('codex', 'b'), L('gemini', 'c')]
      expect(detectConflicts(lessons, () => true)).toEqual([
        { a: lessons[0], b: lessons[1] },
        { a: lessons[0], b: lessons[2] },
        { a: lessons[1], b: lessons[2] },
      ])
    })

    it('interleaves same-source skips with cross-source conflicts correctly', () => {
      const lessons = [
        L('claude', 'p'), // 0
        L('claude', 'q'), // 1 — same source as 0 → the (0,1) pair is skipped
        L('codex', 'r'), // 2
      ]
      expect(detectConflicts(lessons, () => true)).toEqual([
        { a: lessons[0], b: lessons[2] },
        { a: lessons[1], b: lessons[2] },
      ])
    })

    it('returns [] for empty or single-element input (no pairs to consider)', () => {
      expect(detectConflicts([], () => true)).toEqual([])
      expect(detectConflicts([L('claude', 'solo')], () => true)).toEqual([])
    })

    it('returns [] when no cross-source pair contradicts', () => {
      const lessons = [L('claude', 'a'), L('codex', 'b')]
      expect(detectConflicts(lessons, () => false)).toEqual([])
    })
  })
})
