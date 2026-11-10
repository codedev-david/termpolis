// v1.58.0: the proxy argument on a routed Codex line is Termpolis's own, not the user's options. A model relaunch
// keeps it with the user's flags; an account switch keeps the flags and leaves it out.
import { describe, it, expect } from 'vitest'
import { carryLaunchArgs, relaunchCommandFor, type ModelCatalog } from '../../src/renderer/src/lib/modelCatalog'
import { codexProxyArg, withoutInjected } from '../../src/shared/launchCarry'
import { carryForSwitch, relaunchCommand } from '../../src/shared/accountSwitch'

const URL = 'http://127.0.0.1:47853/termpolis-codex/term-7/backend-api/codex'
const PROXY = `-c "openai_base_url='${URL}'"`
const DEV = `-c "developer_instructions='Recall project memory first.'"`
const LINE = `codex -s read-only -a on-request ${DEV} ${PROXY}`
const CAT: ModelCatalog = {
  claude: { provider: 'claude', models: [], source: 'cli', fetchedAt: 1 },
  codex: { provider: 'codex', models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }], source: 'cli', fetchedAt: 1 },
  gemini: { provider: 'gemini', models: [], source: 'cli', fetchedAt: 1 },
}

describe('the Codex proxy argument', () => {
  it('is found exactly as typed, and only in its strict form', () => {
    expect(codexProxyArg(LINE)).toBe(PROXY)
    expect(codexProxyArg('codex')).toBeNull()
    expect(codexProxyArg(null)).toBeNull()
    expect(codexProxyArg(`codex -c "openai_base_url='https://evil.example/termpolis-codex/t/backend-api/codex'"`)).toBeNull()
    expect(withoutInjected(LINE)).toBe('codex -s read-only -a on-request')
  })

  it('does not cost the user their options on a model relaunch, and is typed again there', () => {
    const routed = `codex -s read-only -a on-request ${PROXY}`
    expect(carryLaunchArgs('codex', routed)).toEqual({ args: ['-s', 'read-only', '-a', 'on-request'], complete: true })
    expect(relaunchCommandFor('codex', 'gpt-5.6-sol', CAT, routed, { kind: 'latest' }))
      .toBe(`codex -s read-only -a on-request ${PROXY} --model gpt-5.6-sol resume --last`)
    // A Codex that was never routed relaunches as before.
    expect(relaunchCommandFor('codex', 'gpt-5.6-sol', CAT, 'codex -s read-only', { kind: 'none' })).toBe('codex -s read-only --model gpt-5.6-sol')
  })

  it('lets an account switch go ahead, keeping the user flags and leaving the proxy behind', () => {
    const carry = carryForSwitch('codex', LINE)
    expect(carry).toEqual({ ok: true, extra: ['-s', 'read-only', '-a', 'on-request'] })
    const line = relaunchCommand({ agent: 'codex', id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', extra: carry.ok ? carry.extra : [] })
    expect(line).toBe('codex -s read-only -a on-request resume 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b')
    expect(line).not.toContain('openai_base_url')
  })
})
