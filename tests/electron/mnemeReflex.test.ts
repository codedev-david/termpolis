import { describe, it, expect, vi } from 'vitest'
import { onTaskComplete, onSessionEpisode, taskToTurns, type CompletedTask, type ReflexDeps } from '../../src/main/mnemeReflex'
import type { Lesson, Episode } from '../../src/main/mnemeReflect'

// The substance gate (lessonSubstance.ts) refuses a lesson that says nothing, so the stubbed lessons here say
// something: a rule with two identifiers scores 4. NARRATION scores below 1 and is never stored.
const SUBSTANCE = 'Never call `app.quit()` from the `will-quit` handler because it re-enters the quit sequence.'
const NARRATION = "I'll start with the failing spec and then look through the logs."

const lesson = (o: Partial<Lesson> = {}): Lesson => ({
  memoryType: 'procedural',
  kind: 'fact',
  content: SUBSTANCE,
  entities: [],
  importance: 0.8,
  links: [],
  ...o,
})

function deps(over: Partial<ReflexDeps> = {}): ReflexDeps {
  return {
    distill: vi.fn().mockResolvedValue([lesson()]),
    write: vi.fn().mockResolvedValue({ id: 'mem-1' }),
    recordOutcome: vi.fn(),
    now: 1000,
    ...over,
  }
}

describe('mnemeReflex — task-completion reflex', () => {
  it('does nothing on a non-boundary status', async () => {
    const d = deps()
    const res = await onTaskComplete({ id: 't', status: 'in_progress' }, d)
    expect(res.fired).toBe(false)
    expect(d.recordOutcome).not.toHaveBeenCalled()
    expect(d.distill).not.toHaveBeenCalled()
  })

  it('records success + reflects a completed error→fix task', async () => {
    const d = deps()
    const task: CompletedTask = {
      id: 't1',
      status: 'completed',
      project: 'termpolis',
      title: 'build broke',
      result: 'Error: cannot find module foo. Fixed by adding it to package.json. Tests pass now.',
    }
    const res = await onTaskComplete(task, d)
    expect(res).toEqual({ fired: true, lessons: 1, written: ['mem-1'], skipped: 0 })
    expect(d.recordOutcome).toHaveBeenCalledWith('termpolis', true, 1000)
    expect(d.distill).toHaveBeenCalledTimes(1)
    const ep = (d.distill as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(ep.id).toBe('t1')
    expect(ep.outcome).toEqual({ kind: 'manual', success: true, detail: task.result })
  })

  it('records failure on a failed task', async () => {
    const d = deps()
    await onTaskComplete(
      { id: 't2', status: 'failed', project: 'app', title: 'thing', result: 'Error: it broke and stayed broken for a while here' },
      d,
    )
    expect(d.recordOutcome).toHaveBeenCalledWith('app', false, 1000)
    const ep = (d.distill as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(ep.outcome).toEqual({ kind: 'error', success: false, detail: 'Error: it broke and stayed broken for a while here' })
  })

  it('records competence but skips reflection for a thin task', async () => {
    const d = deps()
    const res = await onTaskComplete({ id: 't3', status: 'completed', title: 'ok' }, d)
    expect(res.fired).toBe(true)
    expect(res.lessons).toBe(0)
    expect(res.skipped).toBe(0)
    expect(d.recordOutcome).toHaveBeenCalledTimes(1)
    expect(d.distill).not.toHaveBeenCalled()
  })

  it('reports how many distilled lessons the substance gate refused, and stores none of them', async () => {
    const d = deps({ distill: vi.fn().mockResolvedValue([lesson(), lesson({ content: NARRATION }), lesson({ content: 'Fixed it.' })]) })
    const res = await onTaskComplete(
      { id: 't7', status: 'completed', project: 'p', title: 'x', result: 'Fixed a long enough thing to reflect on here now.' },
      d,
    )
    expect(res).toEqual({ fired: true, lessons: 3, written: ['mem-1'], skipped: 2 })
    expect(d.write).toHaveBeenCalledTimes(1)
  })

  it('has nothing skipped when it does not fire', async () => {
    expect(await onTaskComplete({ id: 't', status: 'in_progress' }, deps())).toEqual({ fired: false, lessons: 0, written: [], skipped: 0 })
  })

  it('falls back to the "general" domain when no project', async () => {
    const d = deps()
    await onTaskComplete({ id: 't4', status: 'completed', title: 'x', result: 'Fixed a long enough thing to be reflectable here now.' }, d)
    expect(d.recordOutcome).toHaveBeenCalledWith('general', true, 1000)
  })

  it('survives a recordOutcome failure', async () => {
    const d = deps({
      recordOutcome: vi.fn(() => {
        throw new Error('disk')
      }),
    })
    const res = await onTaskComplete(
      { id: 't5', status: 'completed', title: 'x', result: 'Fixed a long enough thing to reflect on here now.' },
      d,
    )
    expect(res.fired).toBe(true)
  })

  it('threads link + ensureEntity so a completed task mints entity edges', async () => {
    const link = vi.fn()
    const ensureEntity = vi.fn().mockImplementation(async (name: string) => `ent-${name}`)
    const d = deps({
      distill: vi.fn().mockResolvedValue([lesson({ entities: ['foo.ts'] })]),
      link,
      ensureEntity,
    })
    await onTaskComplete(
      { id: 't6', status: 'completed', project: 'p', title: 'x', result: 'Fixed a long enough thing to reflect on here now.' },
      d,
    )
    expect(ensureEntity).toHaveBeenCalledWith('foo.ts', 'p')
    expect(link).toHaveBeenCalledWith('mem-1', 'ent-foo.ts', 'refers-to')
  })

  it('taskToTurns builds turns from task text (and handles missing parts)', () => {
    expect(taskToTurns({ id: 't', status: 'completed', title: 'T', description: 'D', result: 'R' })).toEqual([
      { role: 'user', content: 'T\nD' },
      { role: 'assistant', content: 'R' },
    ])
    expect(taskToTurns({ id: 't', status: 'completed', result: 'only result' })).toEqual([{ role: 'assistant', content: 'only result' }])
    expect(taskToTurns({ id: 't', status: 'completed' })).toEqual([])
  })
})

const episode = (o: Partial<Episode> = {}): Episode => ({
  id: 's1',
  turns: [
    { role: 'user', text: 'the build is broken with a module error' },
    { role: 'assistant', text: 'fixed it by adding the dep; tests pass now' },
  ],
  ...o,
})

describe('mnemeReflex — solo-session reflex (onSessionEpisode)', () => {
  it('records competence AND reflects when the episode has a confident outcome', async () => {
    const d = deps()
    const res = await onSessionEpisode(episode({ project: 'termpolis', outcome: { kind: 'test', success: true } }), d)
    expect(res).toEqual({ fired: true, lessons: 1, written: ['mem-1'], skipped: 0 })
    expect(d.recordOutcome).toHaveBeenCalledWith('termpolis', true, 1000)
    expect(d.distill).toHaveBeenCalledTimes(1)
  })

  it('reports how many distilled lessons the substance gate refused', async () => {
    const d = deps({ distill: vi.fn().mockResolvedValue([lesson({ content: NARRATION }), lesson({ content: 'Next:' })]) })
    const res = await onSessionEpisode(episode({ project: 'p', outcome: { kind: 'test', success: true } }), d)
    expect(res).toEqual({ fired: true, lessons: 2, written: [], skipped: 2 })
    expect(d.write).not.toHaveBeenCalled()
  })

  it('reflects but records NO competence when the outcome is unknown (neutral session)', async () => {
    const d = deps()
    const res = await onSessionEpisode(episode({ project: 'termpolis' }), d)
    expect(res.fired).toBe(true)
    expect(res.lessons).toBe(1)
    expect(d.recordOutcome).not.toHaveBeenCalled()
    expect(d.distill).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a thin, non-reflectable episode', async () => {
    const d = deps()
    const res = await onSessionEpisode({ id: 's', turns: [{ role: 'user', text: 'hi' }] }, d)
    expect(res).toEqual({ fired: false, lessons: 0, written: [], skipped: 0 })
    expect(d.recordOutcome).not.toHaveBeenCalled()
    expect(d.distill).not.toHaveBeenCalled()
  })

  it('records a failed outcome and falls back to the "general" domain without a project', async () => {
    const d = deps()
    await onSessionEpisode(episode({ outcome: { kind: 'error', success: false } }), d)
    expect(d.recordOutcome).toHaveBeenCalledWith('general', false, 1000)
  })

  it('survives a recordOutcome failure and still reflects', async () => {
    const d = deps({
      recordOutcome: vi.fn(() => {
        throw new Error('disk')
      }),
    })
    const res = await onSessionEpisode(episode({ project: 'p', outcome: { kind: 'manual', success: true } }), d)
    expect(res.fired).toBe(true)
    expect(res.lessons).toBe(1)
  })

  it('threads link + ensureEntity so a solo session mints entity edges', async () => {
    const link = vi.fn()
    const ensureEntity = vi.fn().mockImplementation(async (name: string) => `ent-${name}`)
    const d = deps({
      distill: vi.fn().mockResolvedValue([lesson({ entities: ['bar.ts'] })]),
      link,
      ensureEntity,
    })
    await onSessionEpisode(episode({ project: 'p', outcome: { kind: 'test', success: true } }), d)
    expect(ensureEntity).toHaveBeenCalledWith('bar.ts', 'p')
    expect(link).toHaveBeenCalledWith('mem-1', 'ent-bar.ts', 'refers-to')
  })
})
