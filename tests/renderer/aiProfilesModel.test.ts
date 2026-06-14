// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { launchAgentProfile } from '../../src/renderer/src/lib/aiProfiles'
import type { AIProfile } from '../../src/renderer/src/types'

describe('launchAgentProfile — single-agent model selection', () => {
  let writes: string[]
  beforeEach(() => {
    vi.useFakeTimers()
    writes = []
    ;(window as unknown as { termpolis: unknown }).termpolis = {
      pickDirectory: vi.fn(async () => ({ success: true, data: '/proj' })),
      createTerminal: vi.fn(async () => ({ success: true })),
      memoryPreparePrimerFile: vi.fn(async () => ({ success: false })),
      writeToTerminal: vi.fn((_id: string, data: string) => { writes.push(data) }),
    }
  })
  afterEach(() => { vi.useRealTimers() })

  const deps = () => ({ availableShells: [{ type: 'bash' }] as never, addTerminal: vi.fn(), setLaunchingAgent: vi.fn() })
  const profile = (over: Partial<AIProfile> = {}): AIProfile =>
    ({ id: 'claude', name: 'Claude', icon: '', command: 'claude', shell: 'bash', color: '#000', ...over })

  it('appends --model <alias> to a Claude launch when the profile pins a model', async () => {
    await launchAgentProfile(profile({ model: 'sonnet' }), deps())
    await vi.runAllTimersAsync()
    expect(writes.some(d => d.includes('--model sonnet'))).toBe(true)
  })

  it('does not append --model when no model is pinned', async () => {
    await launchAgentProfile(profile(), deps())
    await vi.runAllTimersAsync()
    expect(writes.some(d => d.includes('--model'))).toBe(false)
  })

  it('ignores an invalid / injecting model alias (no --model emitted)', async () => {
    await launchAgentProfile(profile({ model: 'evil; rm -rf /' }), deps())
    await vi.runAllTimersAsync()
    expect(writes.some(d => d.includes('--model'))).toBe(false)
  })
})
