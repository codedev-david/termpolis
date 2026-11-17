import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { lumopolisModel } from '../../../src/renderer/src/components/World/worldAgentModel'

const KEY = 'termpolis.agent.modelDefaults'
const defaults = (d: Record<string, string>): void => localStorage.setItem(KEY, JSON.stringify(d))
const settings = (data: unknown, success = true): void => {
  ;(window as any).termpolis = { worldSettingsGet: vi.fn(async () => (success ? { success, data } : { success, error: 'x' })) }
}

beforeEach(() => localStorage.clear())
afterEach(() => { delete (window as any).termpolis; localStorage.clear() })

describe('lumopolisModel', () => {
  it('sends the Default Models id of the Lumopolis agent', async () => {
    defaults({ claude: 'opus', codex: 'gpt-5.5-mini' })
    settings({ worldAgent: 'codex' })
    expect(await lumopolisModel()).toBe('gpt-5.5-mini')
  })

  it('"auto" or no default sends no model', async () => {
    defaults({ claude: 'auto' })
    settings({ worldAgent: 'claude' })
    expect(await lumopolisModel()).toBeUndefined()
    settings({ worldAgent: 'gemini' })
    expect(await lumopolisModel()).toBeUndefined()
  })

  it('falls back to Claude on a refused read, an unknown agent, a throw or no bridge call', async () => {
    defaults({ claude: 'opus', codex: 'gpt-5.5-mini' })
    settings(undefined, false)
    expect(await lumopolisModel()).toBe('opus')
    settings({ worldAgent: 'llama' })
    expect(await lumopolisModel()).toBe('opus')
    ;(window as any).termpolis = { worldSettingsGet: vi.fn(async () => { throw new Error('down') }) }
    expect(await lumopolisModel()).toBe('opus')
    ;(window as any).termpolis = {}
    expect(await lumopolisModel()).toBe('opus')
  })
})
