import { describe, expect, it } from 'vitest'
import { STAGE_WORDS, stageWord } from '../../../src/renderer/src/world/engine/stageWords'

describe('stageWords (signoff B11)', () => {
  it('turns each known stage id into its words', () => {
    expect(stageWord('structure')).toBe('Listing files')
    expect(stageWord('boundaries')).toBe('Reading files')
    expect(stageWord('grouping')).toBe('Grouping files')
    expect(stageWord('status')).toBe('Checking changes')
    expect(stageWord('labelling')).toBe('Naming parts')
    expect(stageWord('cloning')).toBe('Cloning')
    expect(Object.keys(STAGE_WORDS).sort()).toEqual(['boundaries', 'cloning', 'grouping', 'labelling', 'status', 'structure'])
  })

  it('reads any other id as "Mapping", an inherited property name too', () => {
    expect(stageWord('layout')).toBe('Mapping')
    expect(stageWord('labels')).toBe('Mapping')
    expect(stageWord('')).toBe('Mapping')
    expect(stageWord('constructor')).toBe('Mapping')
    expect(stageWord('toString')).toBe('Mapping')
    expect(stageWord('__proto__')).toBe('Mapping')
  })

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(STAGE_WORDS)).toBe(true)
  })
})
