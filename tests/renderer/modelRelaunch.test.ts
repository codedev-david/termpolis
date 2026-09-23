import { describe, it, expect } from 'vitest'
import { relaunchAgentWithModel, relaunchClaudeWithModel } from '../../src/renderer/src/lib/modelRelaunch'
import type { ModelCatalog } from '../../src/renderer/src/lib/modelCatalog'

function fakeIo() {
  const writes: string[] = []
  const sleeps: number[] = []
  return {
    writes,
    sleeps,
    write: (data: string) => { writes.push(data) },
    sleep: async (ms: number) => { sleeps.push(ms) },
  }
}

describe('relaunchClaudeWithModel', () => {
  it('sends Ctrl+C, two Ctrl+D presses, then relaunches with --model and --continue', async () => {
    const io = fakeIo()
    await relaunchClaudeWithModel('sonnet', io)
    expect(io.writes).toEqual(['\x03', '\x04', '\x04', 'claude --model sonnet --continue\r'])
  })

  it('validates the alias the same way claudeModelArg does (no injection)', async () => {
    const io = fakeIo()
    await relaunchClaudeWithModel('sonnet; rm -rf /', io)
    expect(io.writes).toEqual([])
  })

  it('no-ops for an empty/placeholder alias', async () => {
    const io = fakeIo()
    await relaunchClaudeWithModel('', io)
    expect(io.writes).toEqual([])
  })

  it('waits between each keystroke with the documented timing', async () => {
    const io = fakeIo()
    await relaunchClaudeWithModel('opus', io)
    expect(io.sleeps).toEqual([150, 150, 1500])
  })

  it('builds the relaunch command for every valid Claude alias', async () => {
    for (const alias of ['fable', 'opus', 'sonnet', 'haiku']) {
      const io = fakeIo()
      await relaunchClaudeWithModel(alias, io)
      expect(io.writes[3]).toBe(`claude --model ${alias} --continue\r`)
    }
  })
})

const CAT: ModelCatalog = {
  claude: { provider: 'claude', models: [{ id: 'opus', label: 'Opus' }], source: 'builtin', fetchedAt: 0 },
  codex: { provider: 'codex', models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }], source: 'cli', fetchedAt: 1 },
  gemini: { provider: 'gemini', models: [{ id: 'gemini-3.8-flash-high', label: 'Flash' }], source: 'cli', fetchedAt: 1 },
}

describe('relaunchAgentWithModel', () => {
  it('exits Codex with a SINGLE Ctrl+D and resumes its last session', async () => {
    const io = fakeIo()
    await relaunchAgentWithModel('codex', 'gpt-5.6-sol', CAT, io)
    expect(io.writes).toEqual(['\x03', '\x04', 'codex --model gpt-5.6-sol resume --last\r'])
    // One gap before the chord, then the settle — no trailing gap after the last press.
    expect(io.sleeps).toEqual([150, 1500])
  })

  it('exits the Antigravity CLI with a single Ctrl+D and --continue', async () => {
    const io = fakeIo()
    await relaunchAgentWithModel('gemini', 'gemini-3.8-flash-high', CAT, io)
    expect(io.writes).toEqual(['\x03', '\x04', 'agy --model gemini-3.8-flash-high --continue\r'])
  })

  it('still sends two Ctrl+D for Claude', async () => {
    const io = fakeIo()
    await relaunchAgentWithModel('claude', 'opus', CAT, io)
    expect(io.writes).toEqual(['\x03', '\x04', '\x04', 'claude --model opus --continue\r'])
    expect(io.sleeps).toEqual([150, 150, 1500])
  })

  it('writes NOTHING when the model is not one the catalog offers', async () => {
    // The guard has to come before the exit sequence: killing the agent and then
    // failing to relaunch it would be strictly worse than doing nothing.
    for (const [p, id] of [['codex', 'gpt-9-imaginary'], ['claude', 'claude-opus-5-5'], ['gemini', '']] as const) {
      const io = fakeIo()
      await relaunchAgentWithModel(p, id, CAT, io)
      expect(io.writes).toEqual([])
      expect(io.sleeps).toEqual([])
    }
  })

  it('no-ops when no catalog has arrived for a discovered provider', async () => {
    const io = fakeIo()
    await relaunchAgentWithModel('codex', 'gpt-5.6-sol', null, io)
    expect(io.writes).toEqual([])
  })
})
