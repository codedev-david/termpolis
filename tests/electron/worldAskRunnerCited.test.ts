import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/world/askContext', () => ({
  buildAskPrompt: () => ({ prompt: 'P', labels: { E1: { kind: 'file', ref: 'src/a.ts' }, E2: { kind: 'symbol', ref: 'b1' } } }),
  summarize: () => 's'
}))

import { createAskRunner } from '../../src/main/world/askRunner'
import type { AskRequest } from '../../src/shared/world/types'

const REQ: AskRequest = { askId: 'a1', root: 'C:/repo', question: 'q', selection: [], cameraRegion: [], summary: '' }
const run = async (output: string) => {
  const runner = createAskRunner({
    exec: (async () => ({ ok: true, output, primerChars: 0 })) as never,
    execDeps: {} as never,
    agent: () => 'claude',
    runEnv: async () => ({ env: {} }),
    primer: async () => null,
    client: { get: async () => ({ buildings: [], edges: [], districts: [], layers: { plan: [] } }), read: async () => ({ items: [], evidence: [] }) } as never
  })
  return runner.ask(REQ)
}

describe('askRunner cited labels', () => {
  it('cited holds the labels whose [E<n>] markers appear in the answer text, once each', async () => {
    const res = await run('See [E1] and again [E1], also [E7] which is unknown.')
    expect(res).toMatchObject({ ok: true, cited: { E1: { kind: 'file', ref: 'src/a.ts' } } })
    expect(Object.keys((res as { cited: object }).cited)).toEqual(['E1'])
  })
  it('cited is empty when the answer cites nothing', async () => {
    expect(await run('No markers.')).toMatchObject({ ok: true, cited: {} })
  })
})
