import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createReprimeController,
  isAutoReprimeOnCompactionEnabled,
  setAutoReprimeOnCompactionEnabled,
  DEFAULT_REPRIME_QUIET_MS,
  DEFAULT_REPRIME_COOLDOWN_MS,
} from '../../src/renderer/src/lib/compactionReprime'
import { COMPACTION_PATTERN } from '../../src/renderer/src/lib/outputPatterns'

describe('COMPACTION_PATTERN', () => {
  it('matches the live Claude Code compaction markers', () => {
    expect(COMPACTION_PATTERN.test('✻ Compacting conversation… (2m 30s · ↑ 2.8k tokens)')).toBe(true)
    expect(COMPACTION_PATTERN.test('Compacting conversation')).toBe(true)
    expect(COMPACTION_PATTERN.test('compacting the context')).toBe(true)
    expect(COMPACTION_PATTERN.test('Compacted conversation')).toBe(true)
  })

  it('does not match unrelated output (avoids false re-primes)', () => {
    expect(COMPACTION_PATTERN.test('Running the test suite...')).toBe(false)
    expect(COMPACTION_PATTERN.test('compact disc')).toBe(false) // "compact" without conversation/context
    expect(COMPACTION_PATTERN.test('that was a great conversation')).toBe(false)
    expect(COMPACTION_PATTERN.test('git context switch')).toBe(false)
  })
})

describe('createReprimeController', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function make(overrides: Record<string, unknown> = {}) {
    const reprime = vi.fn()
    let clock = 0
    const ctrl = createReprimeController({
      reprime,
      isEnabled: () => true,
      hasAgent: () => true,
      now: () => clock,
      quietMs: 1000,
      cooldownMs: 10_000,
      ...overrides,
    })
    return { reprime, ctrl, setNow: (v: number) => { clock = v } }
  }

  it('re-primes once a compaction marker appears AND output goes quiet', () => {
    const { reprime, ctrl } = make()
    ctrl.onOutput('✻ Compacting conversation… 10%')
    expect(reprime).not.toHaveBeenCalled() // armed, still waiting for quiet
    vi.advanceTimersByTime(999)
    expect(reprime).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reprime).toHaveBeenCalledTimes(1)
  })

  it('debounces: the ticking progress bar keeps resetting the quiet timer', () => {
    const { reprime, ctrl } = make()
    ctrl.onOutput('Compacting conversation… 10%')
    vi.advanceTimersByTime(800)
    ctrl.onOutput('Compacting conversation… 40%') // redraw resets the timer
    vi.advanceTimersByTime(800)
    ctrl.onOutput('Compacting conversation… 80%')
    vi.advanceTimersByTime(999)
    expect(reprime).not.toHaveBeenCalled() // never sat quiet for the full 1000ms
    vi.advanceTimersByTime(1)
    expect(reprime).toHaveBeenCalledTimes(1)
  })

  it('does nothing without a compaction marker', () => {
    const { reprime, ctrl } = make()
    ctrl.onOutput('normal command output, nothing to see')
    vi.advanceTimersByTime(5000)
    expect(reprime).not.toHaveBeenCalled()
  })

  it('evaluates the enabled gate at FIRE time, not arm time', () => {
    let enabled = true
    const { reprime, ctrl } = make({ isEnabled: () => enabled })
    ctrl.onOutput('Compacting conversation…')
    enabled = false // user toggled it off during the compaction
    vi.advanceTimersByTime(1000)
    expect(reprime).not.toHaveBeenCalled()
  })

  it('never arms when no AI agent is present', () => {
    const { reprime, ctrl } = make({ hasAgent: () => false })
    ctrl.onOutput('Compacting conversation…')
    vi.advanceTimersByTime(5000)
    expect(reprime).not.toHaveBeenCalled()
  })

  it('enforces a cooldown so a lingering marker re-primes only once per compaction', () => {
    const { reprime, ctrl, setNow } = make()
    ctrl.onOutput('Compacting conversation…')
    vi.advanceTimersByTime(1000)
    expect(reprime).toHaveBeenCalledTimes(1)
    setNow(5000) // still within the 10s cooldown
    ctrl.onOutput('Compacting conversation…') // same marker still in scrollback
    vi.advanceTimersByTime(1000)
    expect(reprime).toHaveBeenCalledTimes(1) // suppressed
  })

  it('re-arms for a genuinely new compaction once the cooldown passes', () => {
    const { reprime, ctrl, setNow } = make()
    ctrl.onOutput('Compacting conversation…')
    vi.advanceTimersByTime(1000)
    expect(reprime).toHaveBeenCalledTimes(1)
    setNow(20_000) // past the 10s cooldown
    ctrl.onOutput('Compacting conversation…')
    vi.advanceTimersByTime(1000)
    expect(reprime).toHaveBeenCalledTimes(2)
  })

  it('dispose() cancels a pending re-prime', () => {
    const { reprime, ctrl } = make()
    ctrl.onOutput('Compacting conversation…')
    ctrl.dispose()
    vi.advanceTimersByTime(5000)
    expect(reprime).not.toHaveBeenCalled()
  })

  it('uses sane defaults when timings are not provided', () => {
    expect(DEFAULT_REPRIME_QUIET_MS).toBeGreaterThan(0)
    expect(DEFAULT_REPRIME_COOLDOWN_MS).toBeGreaterThan(DEFAULT_REPRIME_QUIET_MS)
    const reprime = vi.fn()
    const ctrl = createReprimeController({ reprime, isEnabled: () => true })
    ctrl.onOutput('Compacting conversation…')
    vi.advanceTimersByTime(DEFAULT_REPRIME_QUIET_MS)
    expect(reprime).toHaveBeenCalledTimes(1)
    ctrl.dispose()
  })
})

describe('auto-reprime-on-compaction setting', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to enabled', () => {
    expect(isAutoReprimeOnCompactionEnabled()).toBe(true)
  })

  it('persists disable and re-enable', () => {
    setAutoReprimeOnCompactionEnabled(false)
    expect(isAutoReprimeOnCompactionEnabled()).toBe(false)
    expect(localStorage.getItem('termpolis.memory.autoReprimeOnCompaction')).toBe('0')
    setAutoReprimeOnCompactionEnabled(true)
    expect(isAutoReprimeOnCompactionEnabled()).toBe(true)
  })
})
