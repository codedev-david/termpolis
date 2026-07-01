import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assembleEpisode } from '../../src/main/mnemeEpisode'
import { distillEpisode } from '../../src/main/mnemeReflect'
import { groundEpisode } from '../../src/main/mnemeGround'
import {
  initSwarmMemory,
  memoryWrite,
  memoryList,
  memorySearch,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'

// The proof that Mneme actually LEARNS: an episode (an error that got fixed) is
// reflected into a distilled, typed, grounded lesson written to the REAL store,
// and a LATER query recalls it. This composes the real modules against the real
// append-only store — no mocks. Runs model-free (keyword recall) so it's always on.
describe('Mneme end-to-end learning loop (real store, deterministic)', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-loop-'))
    _resetForTests()
    initSwarmMemory(tmp)
    _setEmbeddingsAvailable(false)
  })
  afterEach(() => {
    _resetForTests()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('learns a lesson from an episode and recalls it in a later query', async () => {
    // 1) An episode happens: an error was hit and then fixed.
    const episode = assembleEpisode({
      id: 'task-101',
      project: 'termpolis',
      source: 'claude',
      turns: [
        { role: 'user', content: 'Error: cannot find module `bge-small` when loading the embedder' },
        {
          role: 'assistant',
          content:
            'Fixed it — the embedder model files were not bundled; I added them to extraResources in `package.json`. Tests pass now.',
        },
      ],
      outcome: { kind: 'test', success: true },
    })

    // 2) Reflect + ground: distill deterministically and write into the real store.
    const res = await groundEpisode(episode, {
      distill: (ep) => distillEpisode(ep),
      write: (input) => memoryWrite(input),
    })
    expect(res.lessons).toBeGreaterThan(0)
    expect(res.written.length).toBe(res.lessons)

    // 3) The lesson is now a grounded, typed memory in the store.
    const lesson = memoryList({ limit: 100 }).find((m) => m.memoryType === 'procedural')
    expect(lesson).toBeDefined()
    expect(lesson!.originEpisode).toBe('task-101')
    expect(lesson!.importance).toBeGreaterThan(0.6)
    expect(lesson!.content).toMatch(/cannot find module/i)

    // 4) A LATER, differently-worded query surfaces the learned lesson.
    const hits = await memorySearch({ query: 'embedder module not bundled', limit: 5 })
    expect(hits.some((h) => h.memoryType === 'procedural' && h.originEpisode === 'task-101')).toBe(true)
  })

  it('survives across a restart — the lesson is still recalled after reload', async () => {
    const episode = assembleEpisode({
      id: 'task-202',
      project: 'termpolis',
      turns: [
        { role: 'user', content: 'the request keeps failing with ETIMEDOUT' },
        { role: 'assistant', content: 'Fixed by adding an exponential backoff retry in `client.ts`.' },
      ],
      outcome: { kind: 'commit', success: true },
    })
    await groundEpisode(episode, { distill: (ep) => distillEpisode(ep), write: (input) => memoryWrite(input) })

    // Simulate a restart: drop in-memory state, reload from disk.
    _resetForTests()
    initSwarmMemory(tmp)
    _setEmbeddingsAvailable(false)

    const hits = await memorySearch({ query: 'retry backoff timeout client', limit: 5 })
    expect(hits.some((h) => h.originEpisode === 'task-202' && h.memoryType === 'procedural')).toBe(true)
  })
})
