import { describe, it, expect } from 'vitest'
import { analyzeTask } from '../../src/renderer/src/lib/taskAnalyzer'

describe('taskAnalyzer', () => {
  describe('analyzeTask', () => {
    it('decomposes a multi-part task into multiple subtasks', () => {
      const result = analyzeTask('refactor the auth module, write tests, and update documentation')
      expect(result.subtasks.length).toBeGreaterThanOrEqual(3)
    })

    it('detects refactoring category', () => {
      const result = analyzeTask('refactor the user service')
      expect(result.subtasks.some(s => s.category === 'refactoring')).toBe(true)
    })

    it('detects testing category', () => {
      const result = analyzeTask('write unit tests for the parser module')
      expect(result.subtasks.some(s => s.category === 'testing')).toBe(true)
    })

    it('detects documentation category', () => {
      const result = analyzeTask('document the API endpoints')
      expect(result.subtasks.some(s => s.category === 'documentation')).toBe(true)
    })

    it('falls back to a general task for vague input', () => {
      const result = analyzeTask('do some stuff')
      expect(result.subtasks).toHaveLength(1)
      expect(result.subtasks[0].title).toBe('Implement task')
    })

    it('returns required fields on each subtask', () => {
      const result = analyzeTask('debug the login error')
      const sub = result.subtasks[0]
      expect(sub).toHaveProperty('title')
      expect(sub).toHaveProperty('description')
      expect(sub).toHaveProperty('category')
      expect(sub).toHaveProperty('complexity')
      expect(sub).toHaveProperty('tokenIntensity')
    })

    it('clamps complexity between 1 and 5', () => {
      // "comprehensive" adds +1 to complexity — but should not exceed 5
      const result = analyzeTask('comprehensive advanced complex refactoring of the entire system')
      for (const sub of result.subtasks) {
        expect(sub.complexity).toBeGreaterThanOrEqual(1)
        expect(sub.complexity).toBeLessThanOrEqual(5)
      }

      // "simple quick small minor" reduces complexity — but should not go below 1
      const result2 = analyzeTask('simple quick small minor documentation update')
      for (const sub of result2.subtasks) {
        expect(sub.complexity).toBeGreaterThanOrEqual(1)
        expect(sub.complexity).toBeLessThanOrEqual(5)
      }
    })

    it('computes totalComplexity as sum of subtask complexities', () => {
      const result = analyzeTask('refactor code, write tests, review for security')
      const expectedTotal = result.subtasks.reduce((sum, s) => sum + s.complexity, 0)
      expect(result.totalComplexity).toBe(expectedTotal)
    })
  })
})
