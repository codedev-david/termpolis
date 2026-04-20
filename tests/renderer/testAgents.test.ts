import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolveAgentCommand, testDelay } from '../../src/renderer/src/lib/testAgents'

describe('resolveAgentCommand', () => {
  const origEnv = process.env.TERMPOLIS_TEST_AGENTS
  afterEach(() => {
    if (origEnv === undefined) delete process.env.TERMPOLIS_TEST_AGENTS
    else process.env.TERMPOLIS_TEST_AGENTS = origEnv
  })
  beforeEach(() => {
    delete process.env.TERMPOLIS_TEST_AGENTS
  })

  it('returns input unchanged when env not set', () => {
    expect(resolveAgentCommand('claude')).toBe('claude')
    expect(resolveAgentCommand('some-unknown')).toBe('some-unknown')
  })

  it('maps known test commands when env is set', () => {
    process.env.TERMPOLIS_TEST_AGENTS = '1'
    expect(resolveAgentCommand('claude')).toContain('mock-claude')
    expect(resolveAgentCommand('codex')).toContain('mock-codex')
    expect(resolveAgentCommand('gemini')).toContain('mock-gemini')
  })

  it('passes unknown commands through in test mode', () => {
    process.env.TERMPOLIS_TEST_AGENTS = '1'
    expect(resolveAgentCommand('mystery')).toBe('mystery')
  })
})

describe('testDelay', () => {
  const origEnv = process.env.TERMPOLIS_TEST_TIMING
  afterEach(() => {
    if (origEnv === undefined) delete process.env.TERMPOLIS_TEST_TIMING
    else process.env.TERMPOLIS_TEST_TIMING = origEnv
  })
  beforeEach(() => {
    delete process.env.TERMPOLIS_TEST_TIMING
  })

  it('returns unchanged when env not set', () => {
    expect(testDelay(1000)).toBe(1000)
  })

  it('scales down when env set with minimum of 50', () => {
    process.env.TERMPOLIS_TEST_TIMING = '1'
    expect(testDelay(1000)).toBe(100)
    expect(testDelay(10)).toBe(50) // floor at 50
  })
})
