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

  /**
   * Start the launch, then drive the clock, THEN await it. The launch now waits for the shell to
   * look ready (or for the ceiling), so awaiting it before the fake clock moves would deadlock:
   * the promise is waiting on a timer that only `runAllTimersAsync` can fire.
   */
  const launched = async (p: AIProfile): Promise<void> => {
    const done = launchAgentProfile(p, deps())
    await vi.runAllTimersAsync()
    await done
  }
  const profile = (over: Partial<AIProfile> = {}): AIProfile =>
    ({ id: 'claude', name: 'Claude', icon: '', command: 'claude', shell: 'bash', color: '#000', ...over })

  it('appends --model <alias> to a Claude launch when the profile pins a model', async () => {
    await launched(profile({ model: 'sonnet' }))
    expect(writes.some(d => d.includes('--model sonnet'))).toBe(true)
  })

  it('does not append --model when no model is pinned', async () => {
    await launched(profile())
    expect(writes.some(d => d.includes('--model'))).toBe(false)
  })

  it('ignores an invalid / injecting model alias (no --model emitted)', async () => {
    await launched(profile({ model: 'evil; rm -rf /' }))
    expect(writes.some(d => d.includes('--model'))).toBe(false)
  })
})
