import { describe, expect, it } from 'vitest'
import { defaultBuildAgent } from '../../../src/renderer/src/components/World/buildAgent'

const BUILT_IN = ['claude', 'codex', 'gemini']
const claude = { id: 'claude', command: 'claude' }
const opus = { id: 'opus-claude', command: 'claude --model opus' }
const work = { id: 'work-claude', command: 'claude --model sonnet' }

describe('defaultBuildAgent', () => {
  it('prefers the profile of the agent in the active terminal', () => {
    const terminals = [{ id: 't1', agentCommand: 'claude --model sonnet' }, { id: 't2', agentCommand: 'claude --model opus' }]
    expect(defaultBuildAgent([claude, opus, work], BUILT_IN, terminals, 't1')).toBe('work-claude')
  })

  it('else the newest terminal that runs one of them, skipping plain shells and other agents', () => {
    const terminals = [{ id: 't1', agentCommand: 'claude --model opus' }, { id: 't2', agentCommand: 'codex' }, { id: 't3' }]
    expect(defaultBuildAgent([claude, opus], BUILT_IN, terminals, 't3')).toBe('opus-claude')
    expect(defaultBuildAgent([claude, opus], BUILT_IN, terminals, null)).toBe('opus-claude')
  })

  it('else a Claude Code profile the user added, else the built-in one', () => {
    expect(defaultBuildAgent([claude, opus], BUILT_IN, [{ id: 't1' }], undefined)).toBe('opus-claude')
    expect(defaultBuildAgent([claude], BUILT_IN, [], 'gone')).toBe('claude')
  })

  it('nothing to offer gives no default', () => {
    expect(defaultBuildAgent([], BUILT_IN, [{ id: 't1', agentCommand: 'claude' }], 't1')).toBeUndefined()
  })
})
