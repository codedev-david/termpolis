import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { onTaskComplete } from '../../src/main/mnemeReflex'
import { distillEpisode } from '../../src/main/mnemeReflect'
import {
  initSwarmMemory,
  memoryWrite,
  memoryList,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'
import {
  initCompetence,
  recordOutcome,
  assessCompetence,
  _resetCompetenceForTests,
} from '../../src/main/mnemeCompetence'

// End-to-end proof of the in-app reflex against the REAL store + REAL competence
// (previously only tested with fakes): a finishing task distills a grounded lesson
// into the store AND records self-competence. Uses the same real dependencies the
// index.ts wiring passes to onTaskComplete.
describe('Mneme reflex — real-store end-to-end', () => {
  let tmp: string
  const realDeps = () => ({
    distill: (ep: Parameters<typeof distillEpisode>[0]) => distillEpisode(ep),
    write: (i: Parameters<typeof memoryWrite>[0]) => memoryWrite(i),
    recordOutcome,
    now: Date.now(),
  })
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-reflex-'))
    _resetForTests()
    _resetCompetenceForTests()
    initSwarmMemory(tmp)
    initCompetence(tmp)
    _setEmbeddingsAvailable(false)
  })
  afterEach(() => {
    _resetForTests()
    _resetCompetenceForTests()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('a completed error→fix task grounds a lesson into the store and records competence', async () => {
    const res = await onTaskComplete(
      {
        id: 'task-1',
        status: 'completed',
        project: 'termpolis',
        title: 'fix the failing build',
        result: 'Error: cannot find module `foo` during build. Fixed by adding it to package.json. Tests pass now.',
      },
      realDeps(),
    )
    expect(res.fired).toBe(true)
    expect(res.lessons).toBeGreaterThan(0)

    const lesson = memoryList({ limit: 50 }).find((m) => m.memoryType === 'procedural' && m.originEpisode === 'task-1')
    expect(lesson).toBeDefined()
    expect(lesson!.content).toMatch(/cannot find module/i)
    expect(lesson!.importance).toBeGreaterThan(0.6)

    const comp = assessCompetence('termpolis')
    expect(comp.known).toBe(true)
    expect(comp.attempts).toBe(1)
    expect(comp.confidence).toBeGreaterThan(0)
  })

  it('a failed task records a failure in competence (confidence 0)', async () => {
    await onTaskComplete(
      { id: 'task-2', status: 'failed', project: 'app', title: 'attempt', result: 'Error: still broken after several attempts, giving up here.' },
      realDeps(),
    )
    const comp = assessCompetence('app')
    expect(comp.attempts).toBe(1)
    expect(comp.confidence).toBe(0)
    expect(comp.verdict).toBe('unproven')
  })

  it('does not fire for a non-boundary status', async () => {
    const res = await onTaskComplete({ id: 'task-3', status: 'in_progress', project: 'x', result: 'working on it' }, realDeps())
    expect(res.fired).toBe(false)
    expect(assessCompetence('x').known).toBe(false)
  })
})
