// The strongest form of the headline claim, proven with the REAL bge model: a
// lesson DISTILLED from one episode is recalled by a later query that shares no
// salient keywords with it — so a hit means real semantic embeddings surfaced the
// learned knowledge, something keyword search could never do.
//
// Gated on the real model (dev cache OR CI package-verify's resources/models — see
// _modelFixture); this is what un-gates semantic learning in CI.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { assembleEpisode } from '../../src/main/mnemeEpisode'
import { distillEpisode } from '../../src/main/mnemeReflect'
import { groundEpisode } from '../../src/main/mnemeGround'
import { initSwarmMemory, memoryWrite, memorySearch, _resetForTests, _setEmbeddingsAvailable } from '../../src/main/swarmMemory'
import { _resetEmbedderForTests, isEmbedderReady } from '../../src/main/localEmbedder'
import { hasBundledModel } from './_modelFixture'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-semantic-'))
  _resetForTests()
  _resetEmbedderForTests() // no injected backend → load the real model
  _setEmbeddingsAvailable(null) // probe the real embedder (do NOT force keyword mode)
  initSwarmMemory(tmp)
})
afterEach(() => {
  _resetForTests()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe.skipIf(!hasBundledModel)('Mneme — real-model semantic recall of a learned lesson', () => {
  it('recalls a distilled lesson from a paraphrase with no shared keywords', async () => {
    // Reflect an episode: a concurrency crash was diagnosed and fixed.
    const episode = assembleEpisode({
      id: 'task-sem',
      project: 'termpolis',
      source: 'claude',
      turns: [
        { role: 'user', content: 'the app keeps crashing when two terminals close at the very same moment' },
        {
          role: 'assistant',
          content:
            'Fixed the concurrent teardown crash by serializing terminal disposal behind a mutex, so two panes can never dispose the same pty at once. Tests pass now.',
        },
      ],
      outcome: { kind: 'test', success: true },
    })
    const res = await groundEpisode(episode, { distill: (ep) => distillEpisode(ep), write: (i) => memoryWrite(i) })
    expect(res.lessons).toBeGreaterThan(0)

    // A semantically-distant distractor, so a hit cannot be coincidence.
    await memoryWrite({ agentId: 'm', kind: 'note', content: 'The onboarding walkthrough uses a warm amber gradient with rounded illustration cards.', memoryType: 'semantic', importance: 0.5 })

    // Paraphrased query: "race condition / shutting down / tabs / simultaneously"
    // vs the lesson's "concurrent / dispose / terminals / mutex" — no salient overlap.
    const hits = await memorySearch({ query: 'how did we handle the race condition when shutting down tabs simultaneously?', limit: 5 })

    expect(isEmbedderReady()).toBe(true) // the real model actually loaded
    expect(hits.length).toBeGreaterThan(0)
    // The learned lesson must be surfaced — keyword search could not do this.
    const lesson = hits.find((h) => h.memoryType === 'procedural' && h.originEpisode === 'task-sem')
    expect(lesson).toBeDefined()
    // ...and it must rank above the unrelated amber-gradient distractor.
    const lessonRank = hits.findIndex((h) => h.originEpisode === 'task-sem')
    const distractorRank = hits.findIndex((h) => /amber gradient/i.test(h.content))
    if (distractorRank !== -1) expect(lessonRank).toBeLessThan(distractorRank)
  }, 60_000)
})
