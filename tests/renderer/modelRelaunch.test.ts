import { describe, it, expect } from 'vitest'
import { relaunchClaudeWithModel } from '../../src/renderer/src/lib/modelRelaunch'

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
