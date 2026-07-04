import { describe, it, expect } from 'vitest'
import { inferMemoryType, isLessonType } from '../../src/main/mnemeTypeInfer'

describe('inferMemoryType — read-time cognitive classification', () => {
  it('respects an explicit memoryType (reflection/mneme already typed it)', () => {
    expect(inferMemoryType({ kind: 'note', source: 'code', memoryType: 'semantic' })).toBe('semantic')
    expect(inferMemoryType({ kind: 'message', memoryType: 'summary' })).toBe('summary')
  })

  it('classifies code artifacts as entity (by source or code-index agent)', () => {
    expect(inferMemoryType({ kind: 'note', source: 'code', content: 'C:\\x.ts:1-9\ncode' })).toBe('entity')
    expect(inferMemoryType({ kind: 'note', agentId: 'code-index', content: 'body' })).toBe('entity')
  })

  it('classifies transcript/turn messages as episodic', () => {
    expect(inferMemoryType({ kind: 'message', source: 'claude', content: 'user: hi' })).toBe('episodic')
    expect(inferMemoryType({ kind: 'message', content: 'assistant: done' })).toBe('episodic')
  })

  it('classifies decisions and facts as semantic', () => {
    expect(inferMemoryType({ kind: 'decision', content: 'we chose X' })).toBe('semantic')
    expect(inferMemoryType({ kind: 'fact', content: 'store lives in appdata' })).toBe('semantic')
  })

  it('classifies a curated note as semantic (MCP default kind)', () => {
    expect(inferMemoryType({ kind: 'note', content: 'a distilled convention' })).toBe('semantic')
  })

  it('classifies a result as procedural only when it reads error→fix, else episodic', () => {
    expect(inferMemoryType({ kind: 'result', content: 'ENOENT error — fix: prepend git to PATH' })).toBe('procedural')
    expect(inferMemoryType({ kind: 'result', content: 'tool result' })).toBe('episodic')
    expect(inferMemoryType({ kind: 'result', content: 'tool error' })).toBe('episodic') // error without a fix stays episodic
  })

  it('prefers mneme rollup notes as summary', () => {
    expect(inferMemoryType({ kind: 'note', source: 'mneme', content: 'rollup of 12 memories' })).toBe('summary')
  })

  it('never returns "untyped" — an unknown kind falls back to episodic', () => {
    expect(inferMemoryType({ content: 'no kind at all' })).toBe('episodic')
    expect(inferMemoryType({ kind: 'weird-kind', content: 'x' })).toBe('episodic')
  })

  it('isLessonType marks only semantic + procedural as lessons', () => {
    expect(isLessonType('semantic')).toBe(true)
    expect(isLessonType('procedural')).toBe(true)
    expect(isLessonType('episodic')).toBe(false)
    expect(isLessonType('entity')).toBe(false)
    expect(isLessonType('summary')).toBe(false)
  })
})
