import { describe, it, expect, vi } from 'vitest'
import { onTaskComplete, taskToTurns, type CompletedTask, type ReflexDeps } from '../../src/main/mnemeReflex'
import type { Lesson } from '../../src/main/mnemeReflect'

const lesson = (o: Partial<Lesson> = {}): Lesson => ({
  memoryType: 'procedural',
  kind: 'fact',
  content: 'x',
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
    expect(res).toEqual({ fired: true, lessons: 1, written: ['mem-1'] })
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
    expect(d.recordOutcome).toHaveBeenCalledTimes(1)
    expect(d.distill).not.toHaveBeenCalled()
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

  it('taskToTurns builds turns from task text (and handles missing parts)', () => {
    expect(taskToTurns({ id: 't', status: 'completed', title: 'T', description: 'D', result: 'R' })).toEqual([
      { role: 'user', content: 'T\nD' },
      { role: 'assistant', content: 'R' },
    ])
    expect(taskToTurns({ id: 't', status: 'completed', result: 'only result' })).toEqual([{ role: 'assistant', content: 'only result' }])
    expect(taskToTurns({ id: 't', status: 'completed' })).toEqual([])
  })
})
