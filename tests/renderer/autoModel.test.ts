import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  claudeEffortArg, carriesModelOrEffort, autoLaunchArgs, unavailableModels, rememberUnavailable, UNAVAILABLE_KEY,
  watchModelUnavailable, seedAutoDefault, AUTO_OFFERED_KEY, unavailableNotice, skippedNotice, routedChipText, routedChipTitle,
} from '../../src/renderer/src/lib/autoModel'
import { AUTO_MODEL, defaultModelFor, getAgentModelDefaults, isUsableDefault, setAgentModelDefault } from '../../src/renderer/src/lib/agentModelDefaults'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { taskPromptArg } from '../../src/shared/taskRouter'

beforeEach(() => {
  localStorage.clear()
  useTerminalStore.getState().setMemoryNotice(null)
})

describe('Auto launch arguments', () => {
  it('Auto + task routes to a model and effort', () => {
    const a = autoLaunchArgs('find where X is defined', 'claude')
    expect(a).toMatchObject({ modelArg: ' --model haiku', effortArg: ' --effort low', decision: { rule: 'lookup' } })
    expect(autoLaunchArgs('', 'claude')).toMatchObject({ modelArg: ' --model opusplan', effortArg: ' --effort high' })
    expect(autoLaunchArgs(undefined, 'claude').decision?.rule).toBe('no-task')
  })

  it("user's own --model wins over Auto", () => {
    for (const cmd of ['claude --model opus', 'claude --model=opus', 'claude --effort high', 'claude --effort=low', 'claude --resume abc']) {
      expect(carriesModelOrEffort(cmd)).toBe(true)
      expect(autoLaunchArgs('find X', cmd)).toEqual({ modelArg: '', effortArg: '', decision: null })
    }
    expect(carriesModelOrEffort('claude --effortless')).toBe(false)
  })

  it('an effort Claude Code does not take is no argument', () => {
    expect(claudeEffortArg('max')).toBe(' --effort max')
    expect(claudeEffortArg('turbo')).toBe('')
    expect(claudeEffortArg(undefined)).toBe('')
  })

  it('unavailable model falls back to the profile default once and is remembered per account', () => {
    expect(unavailableModels('acc_a')).toEqual([])
    rememberUnavailable('acc_a', 'haiku')
    rememberUnavailable('acc_a', 'haiku')
    expect(unavailableModels('acc_a')).toEqual(['haiku'])
    expect(unavailableModels('acc_b')).toEqual([])
    const a = autoLaunchArgs('find where X is defined', 'claude', unavailableModels('acc_a'))
    expect(a).toMatchObject({ modelArg: '', effortArg: ' --effort low', skipped: 'haiku' })
    rememberUnavailable(undefined, 'opus')
    expect(unavailableModels(null)).toEqual(['opus'])
    expect(skippedNotice('haiku')).toContain('Haiku')
    expect(unavailableNotice('opusplan')).toContain('Opus Plan')
  })

  it('a stored list that is not one is ignored', () => {
    localStorage.setItem(UNAVAILABLE_KEY, '[1,2]')
    expect(unavailableModels('x')).toEqual([])
    localStorage.setItem(UNAVAILABLE_KEY, '{ broken')
    expect(unavailableModels('x')).toEqual([])
    localStorage.setItem(UNAVAILABLE_KEY, JSON.stringify({ x: ['haiku', 'gpt', 3], y: 'opus' }))
    expect(unavailableModels('x')).toEqual(['haiku'])
    expect(unavailableModels('y')).toEqual([])
  })

  it('a full storage just forgets', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    expect(() => rememberUnavailable('a', 'opus')).not.toThrow()
    spy.mockRestore()
    expect(unavailableModels('a')).toEqual([])
  })
})

describe('Auto as a saved default', () => {
  it('is a usable Claude default that adds no model of its own', () => {
    expect(isUsableDefault('claude', AUTO_MODEL, null)).toBe(true)
    setAgentModelDefault('claude', AUTO_MODEL)
    expect(defaultModelFor('claude', null)).toEqual({ arg: '', auto: true })
    expect(defaultModelFor('claude --model opus', null)).toEqual({ arg: '' })
  })

  it('a new install starts on Auto', () => {
    expect(seedAutoDefault()).toBe('seeded')
    expect(getAgentModelDefaults().claude).toBe(AUTO_MODEL)
    expect(seedAutoDefault()).toBe('none')
  })

  it('an existing user is told once', () => {
    localStorage.setItem('termpolis.onboarding.seen.v1', '1')
    expect(seedAutoDefault()).toBe('offered')
    expect(useTerminalStore.getState().memoryNotice).toContain('Auto')
    expect(localStorage.getItem(AUTO_OFFERED_KEY)).toBe('1')
    expect(seedAutoDefault()).toBe('none')
    expect(getAgentModelDefaults().claude).toBeUndefined()
  })

  it('a user with a saved default is not switched', () => {
    setAgentModelDefault('claude', 'opus')
    expect(seedAutoDefault()).toBe('offered')
    expect(getAgentModelDefaults().claude).toBe('opus')
  })
})

describe('watchModelUnavailable', () => {
  function harness() {
    let cb: ((id: string, data: string) => void) | null = null
    const off = vi.fn()
    let fire: (() => void) | null = null
    const cleared: unknown[] = []
    const found = vi.fn()
    const stop = watchModelUnavailable({
      terminalId: 't1',
      subscribe: (c) => { cb = c; return off },
      onFound: found,
      setTimer: (fn) => { fire = fn; return 'h' },
      clearTimer: (h) => cleared.push(h),
    })
    return { emit: (id: string, d: string) => cb?.(id, d), off, found, stop, expire: () => fire?.(), cleared }
  }

  it('spots the message across chunks and colour codes, once', () => {
    const h = harness()
    h.emit('t2', "There's an issue with the selected model")
    expect(h.found).not.toHaveBeenCalled()
    h.emit('t1', "There's an issue with the \x1b[1mselec")
    h.emit('t1', 'ted model (haiku). It may not exist')
    expect(h.found).toHaveBeenCalledTimes(1)
    expect(h.off).toHaveBeenCalled()
    expect(h.cleared).toEqual(['h'])
    h.emit('t1', "There's an issue with the selected model")
    expect(h.found).toHaveBeenCalledTimes(1)
  })

  it("is not fooled by the echo of the user's own task", () => {
    const h = harness()
    h.emit('t1', 'claude --model haiku --effort low' + taskPromptArg('fix the issue with the selected model (haiku). It may not exist or you may not have access'))
    expect(h.found).not.toHaveBeenCalled()
  })

  it('stops watching after the window', () => {
    const h = harness()
    h.expire()
    expect(h.off).toHaveBeenCalled()
    h.emit('t1', 'you may not have access to it')
    expect(h.found).not.toHaveBeenCalled()
    h.stop()
    expect(h.off).toHaveBeenCalledTimes(1)
  })

  it('nothing to subscribe to is no watch', () => {
    const stop = watchModelUnavailable({ terminalId: 't', subscribe: () => { throw new Error('none') }, onFound: vi.fn() })
    expect(() => stop()).not.toThrow()
  })
})

describe('routed chip', () => {
  it('names model, effort and auto, and says why in words', () => {
    const d = { model: 'opusplan' as const, effort: 'high' as const, rule: 'no-task', confidence: 1 }
    expect(routedChipText(d)).toBe('Opus Plan · high · auto')
    expect(routedChipTitle(d)).toContain('no task given, so it plans first')
    expect(routedChipTitle(d)).toContain('full price')
    // A rule or model it has no words for is shown as is, never dropped.
    const odd = { model: 'x' as unknown as 'opus', effort: 'low' as const, rule: 'new-rule', confidence: 0 }
    expect(routedChipText(odd)).toBe('x · low · auto')
    expect(routedChipTitle(odd)).toContain('new-rule')
  })
})
