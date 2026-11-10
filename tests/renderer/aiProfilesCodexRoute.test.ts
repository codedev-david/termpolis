// @vitest-environment jsdom
// v1.58.0 Codex effort per message: the sidebar launch asks main for the proxy URL and adds it to the command.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { launchAgentProfile, codexCommandRoutes } from '../../src/renderer/src/lib/aiProfiles'
import type { AIProfile } from '../../src/renderer/src/types'

const URL = 'http://127.0.0.1:9999/termpolis-codex/x-1/backend-api/codex'

describe('Codex launch through the proxy', () => {
  let writes: string[]
  let createTerminal: ReturnType<typeof vi.fn>
  beforeEach(() => {
    vi.useFakeTimers()
    writes = []
    createTerminal = vi.fn(async () => ({ success: true, data: { codexBaseUrl: URL } }))
    ;(window as unknown as { termpolis: unknown }).termpolis = {
      pickDirectory: vi.fn(async () => ({ success: true, data: '/proj' })),
      createTerminal,
      memoryPreparePrimerFile: vi.fn(async () => ({ success: false })),
      writeToTerminal: vi.fn((_id: string, data: string) => { writes.push(data) }),
      getModelCatalog: vi.fn(async () => ({ success: false })),
    }
    localStorage.clear()
  })
  afterEach(() => { vi.useRealTimers() })

  const launched = async (p: AIProfile): Promise<void> => {
    const done = launchAgentProfile(p, { availableShells: [{ type: 'bash' }] as never, addTerminal: vi.fn(), setLaunchingAgent: vi.fn() })
    await vi.runAllTimersAsync()
    await done
  }
  const codex = (command = 'codex'): AIProfile => ({ id: 'codex', name: 'OpenAI Codex', icon: '', command, shell: 'bash', color: '#000' })
  const launchLine = (): string => writes.filter((d) => d.endsWith('\r')).pop() ?? ''

  it('asks for the route and adds the URL main hands back', async () => {
    await launched(codex())
    const args = createTerminal.mock.calls[0]
    expect(args[4]).toBe(false) // not a Claude terminal
    expect(args[7]).toBe(true) // its effort may be routed
    expect(args[8]).toBe(true) // codexRoute
    expect(launchLine()).toContain(`-c "openai_base_url='${URL}'"`)
  })

  it('a command that sets its own effort is routed only when every terminal is (not auto)', async () => {
    await launched(codex('codex -c model_reasoning_effort=high'))
    expect(createTerminal.mock.calls[0][7]).toBe(false)
    expect(createTerminal.mock.calls[0][8]).toBe(true)
  })

  it('adds nothing when main gives no URL or one that is not the proxy', async () => {
    createTerminal.mockResolvedValueOnce({ success: true })
    await launched(codex())
    expect(launchLine()).not.toContain('openai_base_url')
    writes = []
    createTerminal.mockResolvedValueOnce({ success: true, data: { codexBaseUrl: "http://evil.example/'; rm -rf /" } })
    await launched(codex())
    expect(launchLine()).not.toContain('openai_base_url')
  })

  it('does not ask when the command picks its own endpoint, provider or profile', async () => {
    await launched(codex('codex --profile work'))
    expect(createTerminal.mock.calls[0]).toHaveLength(7) // the plain launch: no route asked
    expect(launchLine()).not.toContain('openai_base_url')
  })
})

describe('codexCommandRoutes', () => {
  it('spots every way a command picks its own endpoint', () => {
    for (const c of [
      'codex -c openai_base_url=http://x', 'codex -c model_provider=azure', 'codex -c chatgpt_base_url=y',
      'codex --oss', 'codex --oss --yolo', 'codex --profile work', 'codex -p work', 'codex --profile=work',
    ]) expect(codexCommandRoutes(c)).toBe(true)
    for (const c of ['codex', 'codex --yolo', 'codex --model gpt-5.5', 'codex -c model_reasoning_effort=high', 'codex --ossify'])
      expect(codexCommandRoutes(c)).toBe(false)
  })
})
