import { describe, expect, it } from 'vitest'
import type { CompileStage } from '../../../src/main/world/compile'
import { STAGE_WORDS, stageWord } from '../../../src/renderer/src/world/engine/stageWords'

/** Every stage id main can send: the compiler's stages, and worldHost.ts's 'cloning'. */
type SentStage = CompileStage | 'cloning'
const SENT_STAGES = ['structure', 'boundaries', 'grouping', 'status', 'labelling', 'layout', 'cloning'] as const satisfies readonly SentStage[]
// A stage main gains and this list lacks fails the typecheck here, so it cannot reach the pane as "Mapping" unnoticed.
type Unlisted = Exclude<SentStage, (typeof SENT_STAGES)[number]>
const everyStageListed: [Unlisted] extends [never] ? true : false = true

describe('stageWords (signoff B11, COPY1 R1 M3)', () => {
  it('turns each known stage id into its words', () => {
    expect(stageWord('structure')).toBe('Listing files')
    expect(stageWord('boundaries')).toBe('Reading files')
    expect(stageWord('grouping')).toBe('Grouping files')
    expect(stageWord('status')).toBe('Checking changes')
    expect(stageWord('labelling')).toBe('Naming parts')
    expect(stageWord('layout')).toBe('Arranging')
    expect(stageWord('cloning')).toBe('Cloning')
    expect(Object.keys(STAGE_WORDS).sort()).toEqual(['boundaries', 'cloning', 'grouping', 'labelling', 'layout', 'status', 'structure'])
  })

  it('gives every stage main can send its own words, never the fallback', () => {
    expect(everyStageListed).toBe(true)
    for (const stage of SENT_STAGES) {
      expect(Object.prototype.hasOwnProperty.call(STAGE_WORDS, stage), stage).toBe(true)
      expect(stageWord(stage), stage).not.toBe('Mapping')
    }
  })

  it('reads any other id as "Mapping", an inherited property name too', () => {
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
