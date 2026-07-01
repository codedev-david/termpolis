import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createSessionReflectionController,
  isSoloLearningEnabled,
  setSoloLearningEnabled,
  DEFAULT_SESSION_IDLE_MS,
} from '../../src/renderer/src/lib/sessionReflection'

describe('createSessionReflectionController', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function make(overrides: Record<string, unknown> = {}) {
    const reflect = vi.fn()
    const ctrl = createSessionReflectionController({
      reflect,
      isEnabled: () => true,
      hasAgent: () => true,
      idleMs: 1000,
      ...overrides,
    })
    return { reflect, ctrl }
  }

  it('reflects once output has been idle for idleMs after activity', () => {
    const { reflect, ctrl } = make()
    ctrl.onOutput('the agent said something')
    expect(reflect).not.toHaveBeenCalled()
    vi.advanceTimersByTime(999)
    expect(reflect).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reflect).toHaveBeenCalledTimes(1)
  })

  it('debounces: continued output keeps resetting the idle timer', () => {
    const { reflect, ctrl } = make()
    ctrl.onOutput('chunk 1')
    vi.advanceTimersByTime(800)
    ctrl.onOutput('chunk 2')
    vi.advanceTimersByTime(800)
    ctrl.onOutput('chunk 3')
    vi.advanceTimersByTime(999)
    expect(reflect).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reflect).toHaveBeenCalledTimes(1)
  })

  it('does nothing without any activity', () => {
    const { reflect } = make()
    vi.advanceTimersByTime(5000)
    expect(reflect).not.toHaveBeenCalled()
  })

  it('does not accumulate activity when no agent is present', () => {
    const { reflect, ctrl } = make({ hasAgent: () => false })
    ctrl.onOutput('plain shell output')
    vi.advanceTimersByTime(5000)
    expect(reflect).not.toHaveBeenCalled()
  })

  it('evaluates the enabled gate at FIRE time, not activity time', () => {
    let enabled = true
    const { reflect, ctrl } = make({ isEnabled: () => enabled })
    ctrl.onOutput('agent output')
    enabled = false
    vi.advanceTimersByTime(1000)
    expect(reflect).not.toHaveBeenCalled()
  })

  it('flush() reflects immediately when there is pending activity', () => {
    const { reflect, ctrl } = make()
    ctrl.onOutput('agent output')
    ctrl.flush()
    expect(reflect).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5000)
    expect(reflect).toHaveBeenCalledTimes(1) // not double-fired
  })

  it('flush() is a no-op when there was no activity', () => {
    const { reflect, ctrl } = make()
    ctrl.flush()
    expect(reflect).not.toHaveBeenCalled()
  })

  it('reflects again only after fresh activity (one reflect per idle settle)', () => {
    const { reflect, ctrl } = make()
    ctrl.onOutput('a')
    vi.advanceTimersByTime(1000)
    expect(reflect).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5000)
    expect(reflect).toHaveBeenCalledTimes(1) // no new activity → no new reflect
    ctrl.onOutput('b')
    vi.advanceTimersByTime(1000)
    expect(reflect).toHaveBeenCalledTimes(2)
  })

  it('dispose() cancels a pending reflect', () => {
    const { reflect, ctrl } = make()
    ctrl.onOutput('agent output')
    ctrl.dispose()
    vi.advanceTimersByTime(5000)
    expect(reflect).not.toHaveBeenCalled()
  })

  it('uses a sane default idle interval', () => {
    expect(DEFAULT_SESSION_IDLE_MS).toBeGreaterThan(0)
    const reflect = vi.fn()
    const ctrl = createSessionReflectionController({ reflect, isEnabled: () => true })
    ctrl.onOutput('agent output')
    vi.advanceTimersByTime(DEFAULT_SESSION_IDLE_MS)
    expect(reflect).toHaveBeenCalledTimes(1)
    ctrl.dispose()
  })
})

describe('solo-session-learning setting', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to enabled', () => {
    expect(isSoloLearningEnabled()).toBe(true)
  })

  it('persists disable and re-enable', () => {
    setSoloLearningEnabled(false)
    expect(isSoloLearningEnabled()).toBe(false)
    expect(localStorage.getItem('termpolis.memory.learnFromSessions')).toBe('0')
    setSoloLearningEnabled(true)
    expect(isSoloLearningEnabled()).toBe(true)
    expect(localStorage.getItem('termpolis.memory.learnFromSessions')).toBe('1')
  })
})
