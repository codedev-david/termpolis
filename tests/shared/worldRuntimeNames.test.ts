import { describe, expect, it } from 'vitest'
import { cleanRuntimeNames, isRuntimeText, namesOfRuntimeText, runtimeText } from '../../src/shared/world/runtimeNames'

describe('runtime names', () => {
  it('keeps only fitting names, each once, at most 10', () => {
    expect(cleanRuntimeNames([' a ', 'a', 'b c', 'x'.repeat(65), 7, '', 'ok.name-1_2'])).toEqual(['a', 'ok.name-1_2'])
    expect(cleanRuntimeNames(Array.from({ length: 15 }, (_, i) => `n${i}`))).toHaveLength(10)
  })
  it('round-trips through the annotation text', () => {
    expect(runtimeText(['a', 'b'])).toBe('runtime:a,b')
    expect(isRuntimeText('runtime:a')).toBe(true)
    expect(isRuntimeText('Keeps data')).toBe(false)
    expect(namesOfRuntimeText('runtime:a, b ,bad name')).toEqual(['a', 'b'])
    expect(namesOfRuntimeText('runtime:')).toEqual([])
    expect(namesOfRuntimeText('plain')).toEqual([])
  })
})
