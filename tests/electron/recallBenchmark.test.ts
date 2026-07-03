// Offline recall benchmark (real bge model). Measures whether each retrieval option
// actually improves recall — the evidence that decides if graph-fusion / taste-boost
// are worth enabling for ALL callers, or should stay agent-opt-in / off. Fair setup:
// 6 topic clusters (relevant = the query's topic), PLUS one "bridge" case where a fix
// is semantically distant from its bug but linked by a typed edge (fusion should
// recover it) with a distractor edge (noise), PLUS reinforced backend topics (taste).
// It logs a metrics table (BENCH| lines) and asserts only robust, deterministic
// properties so the numeric verdict is read from the log, not baked into a flaky assert.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  initSwarmMemory,
  memoryWrite,
  memoryLink,
  memoryFeedback,
  memorySearch,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setAdaptForTests,
} from '../../src/main/swarmMemory'
import { _resetEmbedderForTests } from '../../src/main/localEmbedder'
import { hasBundledModel } from './_modelFixture'
import { meanRecallAtK, mrr, type RankedQuery } from '../../src/main/recallMetrics'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

const CORPUS: Array<{ tag: string; topic: string; text: string }> = [
  { tag: 'auth1', topic: 'auth', text: 'Incoming requests are authenticated by validating the JWT in the middleware layer.' },
  { tag: 'auth2', topic: 'auth', text: 'User sessions are stored server-side and expire after twenty-four hours of inactivity.' },
  { tag: 'auth3', topic: 'auth', text: 'OAuth refresh tokens are rotated every time they mint a new access token.' },
  { tag: 'db1', topic: 'db', text: 'The users table enforces a unique index on the email column.' },
  { tag: 'db2', topic: 'db', text: 'Schema migrations are applied automatically during each deployment.' },
  { tag: 'db3', topic: 'db', text: 'The Postgres connection pool is capped at twenty concurrent connections.' },
  { tag: 'ui1', topic: 'ui', text: 'The sidebar collapses into a hamburger menu on narrow viewports.' },
  { tag: 'ui2', topic: 'ui', text: 'Dark mode automatically follows the operating system colour preference.' },
  { tag: 'ui3', topic: 'ui', text: 'Primary buttons use a four pixel corner radius and a solid fill.' },
  { tag: 'build1', topic: 'build', text: 'Continuous integration runs the vitest suite before packaging with electron-builder.' },
  { tag: 'build2', topic: 'build', text: 'The coverage gate fails the build below ninety percent line coverage.' },
  { tag: 'build3', topic: 'build', text: 'The release workflow code-signs the Windows installer with the EV certificate.' },
  { tag: 'voice1', topic: 'voice', text: 'Speech input is transcribed through the Groq cloud Whisper API.' },
  { tag: 'voice2', topic: 'voice', text: 'The microphone button stays disabled until a valid API key is connected.' },
  { tag: 'voice3', topic: 'voice', text: 'Tap-or-hold is the default push-to-talk interaction for dictation.' },
  { tag: 'perf1', topic: 'perf', text: 'Embeddings are packed into a single contiguous Float32Array for cache-friendly scans.' },
  { tag: 'perf2', topic: 'perf', text: 'An HNSW graph makes nearest-neighbour search sub-linear beyond fifty thousand vectors.' },
  { tag: 'perf3', topic: 'perf', text: 'Int8 scalar quantization cuts the vector memory footprint roughly fourfold.' },
  { tag: 'bug1', topic: 'bridge', text: 'Scrolling up to earlier output stops responding once the window is maximized to fullscreen.' },
  { tag: 'fix1', topic: 'bridge', text: 'Redirecting wheel events to the normal buffer and guarding the alternate-screen switch restored it.' },
]

const QUERIES: Array<{ text: string; topics: string[] }> = [
  { text: 'how are incoming requests verified as coming from a logged-in user', topics: ['auth'] },
  { text: 'where is the data schema defined and how does it get updated', topics: ['db'] },
  { text: 'how does the layout adapt to small screens and the colour theme', topics: ['ui'] },
  { text: 'what runs in the pipeline when we ship a release', topics: ['build'] },
  { text: 'how does dictation and the talk button work', topics: ['voice'] },
  { text: 'how is vector search kept fast while using little memory', topics: ['perf'] },
  { text: 'why does the scrollback freeze when the terminal is full screen', topics: ['bridge'] },
]

describe.skipIf(!hasBundledModel)('recall benchmark — does each option actually improve recall? (real bge)', () => {
  let tmp: string
  const idByTag = new Map<string, string>()

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'))
    _resetForTests()
    _resetEmbedderForTests()
    _setEmbeddingsAvailable(null) // probe the real embedder
    initSwarmMemory(tmp)
    idByTag.clear()
    for (const m of CORPUS) {
      const e = await memoryWrite({ agentId: 'a', kind: 'fact', content: m.text })
      idByTag.set(m.tag, e.id)
    }
    // Bridge: fix1 is semantically distant from bug1 but solves it → fusion should
    // recover it. A distractor edge to an unrelated UI note tests fusion's precision.
    memoryLink({ from: idByTag.get('bug1')!, to: idByTag.get('fix1')!, relation: 'solved-by', weight: 0.9 })
    memoryLink({ from: idByTag.get('bug1')!, to: idByTag.get('ui1')!, relation: 'relates-to', weight: 0.5 })
    // Taste: the user "works on backend" → reinforce every auth + db memory.
    for (const t of ['auth1', 'auth2', 'auth3', 'db1', 'db2', 'db3']) memoryFeedback({ id: idByTag.get(t)!, helpful: true })
  })
  afterEach(() => {
    _setAdaptForTests(false)
    _resetForTests()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  const relevantFor = (topics: string[]): Set<string> =>
    new Set(CORPUS.filter((m) => topics.includes(m.topic)).map((m) => idByTag.get(m.tag)!))

  async function runConfig(cfg: { diversify?: boolean; fuseGraph?: boolean; adapt?: boolean }): Promise<{ r5: number; r10: number; mrr: number }> {
    _setAdaptForTests(!!cfg.adapt)
    const rq: RankedQuery[] = []
    for (const q of QUERIES) {
      const hits = await memorySearch({ query: q.text, limit: 10, diversify: cfg.diversify, fuseGraph: cfg.fuseGraph })
      rq.push({ rankedIds: hits.map((h) => h.id), relevant: relevantFor(q.topics) })
    }
    _setAdaptForTests(false)
    return { r5: meanRecallAtK(rq, 5), r10: meanRecallAtK(rq, 10), mrr: mrr(rq) }
  }

  it('measures recall@k + MRR for each retrieval option and reports the deltas', async () => {
    const baseline = await runConfig({})
    const gatediv = await runConfig({ diversify: true })
    const fusion = await runConfig({ diversify: true, fuseGraph: true })
    const taste = await runConfig({ diversify: true, adapt: true })
    const all = await runConfig({ diversify: true, fuseGraph: true, adapt: true })

    const row = (name: string, m: { r5: number; r10: number; mrr: number }): string =>
      `BENCH| ${name.padEnd(14)} recall@5=${m.r5.toFixed(3)} recall@10=${m.r10.toFixed(3)} mrr=${m.mrr.toFixed(3)}`
    // eslint-disable-next-line no-console
    console.log('\n' + [
      row('baseline', baseline),
      row('gate+div', gatediv),
      row('+fusion', fusion),
      row('+taste', taste),
      row('+all', all),
      `BENCH| delta fusion-vs-gatediv: recall@10 ${(fusion.r10 - gatediv.r10).toFixed(3)}, mrr ${(fusion.mrr - gatediv.mrr).toFixed(3)}`,
      `BENCH| delta taste-vs-gatediv:  recall@10 ${(taste.r10 - gatediv.r10).toFixed(3)}, mrr ${(taste.mrr - gatediv.mrr).toFixed(3)}`,
    ].join('\n'))

    // Robust, deterministic sanity assertions (the numeric VERDICT is read from the log):
    expect(baseline.r10).toBeGreaterThan(0)
    expect(gatediv.r10).toBeGreaterThan(0)
    // Enabling options must not COLLAPSE recall — a hard regression guard.
    expect(fusion.r10).toBeGreaterThanOrEqual(gatediv.r10 - 0.15)
    expect(taste.r10).toBeGreaterThanOrEqual(gatediv.r10 - 0.15)
  })
})
