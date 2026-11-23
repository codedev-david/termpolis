import { describe, it, expect } from 'vitest'
import { MAX_QUESTION_CHARS, cleanQuestion, questionFits } from '../../src/shared/world/askLimits'

describe('askLimits', () => {
  it('keeps the 4,000-character limit', () => {
    expect(MAX_QUESTION_CHARS).toBe(4000)
  })

  it('takes out every control character but tab, then trims', () => {
    expect(cleanQuestion('  a\u0000b\u0007c\u001bd\u007fe\u0085f\u009fg\nh\r\ti  ')).toBe('abcdefgh\ti')
    expect(cleanQuestion('\t')).toBe('')
    expect(cleanQuestion('Où est la mémoire ? 日本')).toBe('Où est la mémoire ? 日本')
  })

  it('fits a question that is not blank and not over the limit', () => {
    expect(questionFits('')).toBe(false)
    expect(questionFits('q')).toBe(true)
    expect(questionFits('x'.repeat(4000))).toBe(true)
    expect(questionFits('x'.repeat(4001))).toBe(false)
  })
})
