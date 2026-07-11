// Offline recall benchmark (real bge model) — the DEFENSIBILITY GATE for retrieval quality.
//
// This file does two jobs:
//   1. GATE (WP-A): measure the PRODUCTION-DEFAULT retrieval config over a labeled corpus and
//      FAIL THE BUILD if nDCG@10 / recall@10 / MRR drop below (a) absolute floors or (b) a
//      committed baseline (regression guard). This is what makes "retrieval works" checkable
//      instead of a claim — it runs in CI via the model-present job (see .github/workflows/test.yml).
//   2. DIAGNOSTIC (WP-B input): log the recall delta of each dormant retrieval tier
//      (graph-fusion / taste) so the decision to enable a tier is backed by a number, not a vibe.
//
// The corpus is 12 separable topic clusters (4 docs each) + a bridge case (a fix semantically
// distant from its bug but linked by a typed edge) + reinforced backend topics (taste). Relevance
// judgments are the query's topic cluster. Metrics come from the pure, unit-tested recallMetrics.
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
  _setQuantizeForTests,
  _isVectorStoreQuantizedForTests,
} from '../../src/main/swarmMemory'
import { _resetEmbedderForTests } from '../../src/main/localEmbedder'
import { hasBundledModel } from './_modelFixture'
import { evaluate, meanRecallAtK, meanNdcgAtK, mrr, type RankedQuery } from '../../src/main/recallMetrics'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

// The committed baseline the gate regresses against. Written once from a measured run, then
// tracked in git; a drop beyond EPSILON on any headline metric fails the build.
const BASELINE_PATH = path.join(__dirname, 'fixtures', 'recall-baseline.json')
const EPSILON = 0.04 // tolerance for embedder/platform nondeterminism on the headline metrics

interface Doc { tag: string; topic: string; text: string }

// 12 separable topic clusters, 4 docs each = 48 labeled docs. Distinct enough that a paraphrased
// natural-language query for one topic should recall its 4 docs in the top-10.
const CORPUS: Doc[] = [
  { tag: 'auth1', topic: 'auth', text: 'Incoming API requests are authenticated by validating the JWT bearer token in the middleware layer.' },
  { tag: 'auth2', topic: 'auth', text: 'User sessions are stored server-side and expire after twenty-four hours of inactivity.' },
  { tag: 'auth3', topic: 'auth', text: 'OAuth refresh tokens are rotated every time the service mints a new access token.' },
  { tag: 'auth4', topic: 'auth', text: 'Failed login attempts are rate-limited to five per minute per source address.' },

  { tag: 'db1', topic: 'db', text: 'The users table enforces a unique index on the lowercased email column.' },
  { tag: 'db2', topic: 'db', text: 'Database schema migrations are applied automatically during each deployment.' },
  { tag: 'db3', topic: 'db', text: 'The Postgres connection pool is capped at twenty concurrent connections.' },
  { tag: 'db4', topic: 'db', text: 'Soft-deleted rows keep a deleted_at timestamp and are excluded by a default query scope.' },

  { tag: 'ui1', topic: 'ui', text: 'The sidebar collapses into a hamburger menu on narrow mobile viewports.' },
  { tag: 'ui2', topic: 'ui', text: 'Dark mode automatically follows the operating system colour-scheme preference.' },
  { tag: 'ui3', topic: 'ui', text: 'Primary buttons use a four pixel corner radius and a solid accent fill.' },
  { tag: 'ui4', topic: 'ui', text: 'Toast notifications auto-dismiss after four seconds unless the pointer is hovering them.' },

  { tag: 'build1', topic: 'build', text: 'Continuous integration runs the vitest suite before packaging the app with electron-builder.' },
  { tag: 'build2', topic: 'build', text: 'The coverage gate fails the build below ninety percent line coverage.' },
  { tag: 'build3', topic: 'build', text: 'The release workflow code-signs the Windows installer with the EV certificate.' },
  { tag: 'build4', topic: 'build', text: 'Tree-sitter WASM grammars are copied into resources during the build step.' },

  { tag: 'voice1', topic: 'voice', text: 'Speech input is transcribed through the Groq cloud Whisper API, opt-in and off by default.' },
  { tag: 'voice2', topic: 'voice', text: 'The microphone button stays disabled until a valid Groq API key is connected.' },
  { tag: 'voice3', topic: 'voice', text: 'Tap-or-hold on the hotkey is the default push-to-talk interaction for dictation.' },
  { tag: 'voice4', topic: 'voice', text: 'A background-energy gate suppresses phantom transcripts when the microphone hears only noise.' },

  { tag: 'perf1', topic: 'perf', text: 'Embeddings are packed into a single contiguous Float32Array for cache-friendly cosine scans.' },
  { tag: 'perf2', topic: 'perf', text: 'An HNSW graph makes nearest-neighbour search sub-linear beyond fifty thousand vectors.' },
  { tag: 'perf3', topic: 'perf', text: 'Terminal output is throttled with a per-frame byte budget to keep the UI responsive.' },
  { tag: 'perf4', topic: 'perf', text: 'Off-screen terminals in a split defer their rendering until they become visible.' },

  { tag: 'git1', topic: 'git', text: 'The git panel shows staged and unstaged files with M/A/D status indicators.' },
  { tag: 'git2', topic: 'git', text: 'Committing from the panel writes the message and refreshes the working-tree status.' },
  { tag: 'git3', topic: 'git', text: 'The current branch name is parsed from the shell prompt on every command.' },
  { tag: 'git4', topic: 'git', text: 'A diff viewer renders git diff output with green and red syntax highlighting.' },

  { tag: 'swarm1', topic: 'swarm', text: 'A dedicated conductor agent decomposes a task and assigns subtasks to the best-suited agent.' },
  { tag: 'swarm2', topic: 'swarm', text: 'Swarm agents coordinate through a shared message bus with typed task and result messages.' },
  { tag: 'swarm3', topic: 'swarm', text: 'The swarm dashboard shows tasks in kanban columns and live per-agent token burn.' },
  { tag: 'swarm4', topic: 'swarm', text: 'Spawned swarm terminals are hidden from the sidebar and driven entirely over MCP.' },

  { tag: 'sec1', topic: 'security', text: 'Outbound prompts are scanned against seventy secret patterns and redacted before they leave.' },
  { tag: 'sec2', topic: 'security', text: 'An egress audit records which remote hosts each agent process opened connections to.' },
  { tag: 'sec3', topic: 'security', text: 'The MCP server binds to loopback only and rejects any request without the bearer token.' },
  { tag: 'sec4', topic: 'security', text: 'A watcher flags reads of sensitive files such as dotenv, PEM keys, and cloud credentials.' },

  { tag: 'test1', topic: 'testing', text: 'Unit tests are written test-first: a failing test, then the minimal code to pass it.' },
  { tag: 'test2', topic: 'testing', text: 'Playwright end-to-end specs launch the real Electron app and click through the UI.' },
  { tag: 'test3', topic: 'testing', text: 'Flaky wall-clock tests are made deterministic by injecting an explicit timestamp.' },
  { tag: 'test4', topic: 'testing', text: 'Coverage is enforced as a hard gate so no commit can drop below the branch threshold.' },

  { tag: 'net1', topic: 'network', text: 'The updater fetches release metadata over HTTPS and verifies the installer signature.' },
  { tag: 'net2', topic: 'network', text: 'Requests that time out are retried with exponential backoff up to five attempts.' },
  { tag: 'net3', topic: 'network', text: 'A captive-portal check pings a known endpoint before assuming the network is online.' },
  { tag: 'net4', topic: 'network', text: 'Large downloads stream to a temp file and are atomically renamed on completion.' },

  { tag: 'docs1', topic: 'docs', text: 'The public documentation site is two static pages generated without a build step.' },
  { tag: 'docs2', topic: 'docs', text: 'A sync script keeps the marketing version and MCP tool count matching the latest release.' },
  { tag: 'docs3', topic: 'docs', text: 'Every feature section on the site is audited against the README each release.' },
  { tag: 'docs4', topic: 'docs', text: 'Keyboard shortcuts are listed in a dedicated table in both the README and the docs page.' },

  // Bridge case (WP-B / fusion diagnostic): the fix is semantically distant from the bug but linked.
  { tag: 'bug1', topic: 'bridge', text: 'Scrolling up to earlier output stops responding once the window is maximized to fullscreen.' },
  { tag: 'fix1', topic: 'bridge', text: 'Redirecting wheel events to the normal buffer and guarding the alternate-screen switch restored it.' },
]

interface Query { text: string; answer: string[] }

// Paraphrased queries with PER-QUERY relevance judgments — each names the specific doc(s) that
// actually answer it (not the whole topic cluster). Queries deliberately avoid the corpus wording
// so this measures semantic recall, not keyword overlap. This is the honest IR setup: "did the
// retriever surface the memory that answers THIS question, and how high did it rank it".
const CORE_QUERIES: Query[] = [
  { text: 'how do we confirm a request comes from a signed-in user', answer: ['auth1'] },
  { text: 'how long until an idle login session expires', answer: ['auth2'] },
  { text: 'what happens to a refresh token when a new access token is minted', answer: ['auth3'] },
  { text: 'how are repeated failed login attempts throttled', answer: ['auth4'] },
  { text: 'what stops two accounts registering the same email address', answer: ['db1'] },
  { text: 'how do database schema changes get applied to each environment', answer: ['db2'] },
  { text: 'how many connections can talk to the database at once', answer: ['db3'] },
  { text: 'how are removed records kept around instead of being truly deleted', answer: ['db4'] },
  { text: 'how does the layout change on a narrow phone screen', answer: ['ui1'] },
  { text: 'how does the app decide between a light and dark appearance', answer: ['ui2'] },
  { text: 'when do the little popup notifications go away on their own', answer: ['ui4'] },
  { text: 'what runs before the app gets packaged for a release', answer: ['build1'] },
  { text: 'what makes the build fail when tests are not covered enough', answer: ['build2'] },
  { text: 'how do the parser grammars end up inside the build', answer: ['build4'] },
  { text: 'how does speaking to the app get turned into text', answer: ['voice1'] },
  { text: 'why might dictation not pick up my voice at all', answer: ['voice4'] },
  { text: 'what is the gesture to start push to talk dictation', answer: ['voice3'] },
  { text: 'how is nearest-neighbour search kept fast on a large store', answer: ['perf2'] },
  { text: 'what keeps a flood of terminal output from freezing the window', answer: ['perf3'] },
  { text: 'how do I commit my staged changes from inside the app', answer: ['git2'] },
  { text: 'where can I see which git branch I am currently on', answer: ['git3'] },
  { text: 'how is a code diff shown with colours', answer: ['git4'] },
  { text: 'how does one task get split across several different models', answer: ['swarm1'] },
  { text: 'how do the parallel agents send each other messages', answer: ['swarm2'] },
  { text: 'where do I watch how many tokens each agent is burning', answer: ['swarm3'] },
  { text: 'how are secrets stopped from reaching the cloud model', answer: ['sec1'] },
  { text: 'can I see which remote hosts an agent opened connections to', answer: ['sec2'] },
  { text: 'what stops another machine from reaching the local tool server', answer: ['sec3'] },
  { text: 'what is the discipline for writing tests in this project', answer: ['test1'] },
  { text: 'how are the full UI flows exercised end to end', answer: ['test2'] },
  { text: 'how does the app update itself without installing something tampered', answer: ['net1'] },
  { text: 'what happens to a network request that times out', answer: ['net2'] },
  { text: 'how does the website version stay current with the latest release', answer: ['docs2'] },
  { text: 'where are the keyboard shortcuts written down', answer: ['docs4'] },
]

describe.skipIf(!hasBundledModel)('recall benchmark — GATE (real bge, production-default config)', () => {
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
    memoryLink({ from: idByTag.get('bug1')!, to: idByTag.get('fix1')!, relation: 'solved-by', weight: 0.9 })
    memoryLink({ from: idByTag.get('bug1')!, to: idByTag.get('ui1')!, relation: 'relates-to', weight: 0.5 })
    for (const t of ['auth1', 'auth2', 'auth3', 'auth4', 'db1', 'db2', 'db3', 'db4']) memoryFeedback({ id: idByTag.get(t)!, helpful: true })
  })
  afterEach(() => {
    _setAdaptForTests(false)
    _resetForTests()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  const relevantFor = (tags: string[]): Set<string> =>
    new Set(tags.map((t) => idByTag.get(t)!))

  async function rankedFor(queries: Query[], cfg: { diversify?: boolean; fuseGraph?: boolean; adapt?: boolean }): Promise<RankedQuery[]> {
    _setAdaptForTests(!!cfg.adapt)
    const rq: RankedQuery[] = []
    for (const q of queries) {
      const hits = await memorySearch({ query: q.text, limit: 10, diversify: cfg.diversify, fuseGraph: cfg.fuseGraph })
      rq.push({ rankedIds: hits.map((h) => h.id), relevant: relevantFor(q.answer) })
    }
    _setAdaptForTests(false)
    return rq
  }

  it('meets the committed nDCG@10 / recall@10 / MRR floor and does not regress the baseline', async () => {
    // Production-default agent-facing config: gated recall + MMR diversify ON, no opt-in tiers.
    const rq = await rankedFor(CORE_QUERIES, { diversify: true })
    const summary = evaluate(rq, [1, 5, 10])
    const measured = {
      recall_at_10: round(summary.recallAtK[10]),
      ndcg_at_10: round(summary.ndcgAtK[10]),
      mrr: round(summary.mrr),
      recall_at_5: round(summary.recallAtK[5]),
      queries: CORE_QUERIES.length,
      docs: CORPUS.length,
    }
    console.log('\nBENCH-GATE| ' + JSON.stringify(measured))

    // Bootstrap: on the very first run, capture the measured numbers as the committed baseline.
    // Thereafter the file is tracked in git and this branch never runs — the gate is real.
    if (!fs.existsSync(BASELINE_PATH)) {
      fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true })
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(measured, null, 2) + '\n')
      console.log('BENCH-GATE| wrote initial baseline to ' + BASELINE_PATH)
    }

    // (a) Absolute floors — a platform-independent "clearly working" bar, set below the measured
    //     0.971 / 0.795 / 0.739 with margin for cross-platform embedder nondeterminism.
    expect(measured.recall_at_10).toBeGreaterThanOrEqual(0.90)
    expect(measured.ndcg_at_10).toBeGreaterThanOrEqual(0.70)
    expect(measured.mrr).toBeGreaterThanOrEqual(0.62)

    // (b) Non-regression vs the committed baseline — the real defense: a change that silently
    //     degrades recall/ranking beyond EPSILON fails CI.
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
    expect(measured.recall_at_10).toBeGreaterThanOrEqual(baseline.recall_at_10 - EPSILON)
    expect(measured.ndcg_at_10).toBeGreaterThanOrEqual(baseline.ndcg_at_10 - EPSILON)
    expect(measured.mrr).toBeGreaterThanOrEqual(baseline.mrr - EPSILON)
  })

  // Tier-1 (BB8): int8 vector quantization is ~4x less vector RAM. It's only worth shipping if it
  // keeps recall — this proves the two-stage int8 gather + float×int8 rescore holds parity with the
  // FLOAT baseline on the real bge model (measured: recall@10/recall@5 identical, nDCG/MRR within 0.001).
  it('int8 quantization holds recall parity with the float baseline', async () => {
    const qtmp = fs.mkdtempSync(path.join(os.tmpdir(), 'benchq-'))
    try {
      _resetForTests()
      _resetEmbedderForTests()
      _setEmbeddingsAvailable(null) // probe the real embedder
      _setQuantizeForTests(true)
      initSwarmMemory(qtmp)
      expect(_isVectorStoreQuantizedForTests()).toBe(true)
      const tagId = new Map<string, string>()
      for (const m of CORPUS) tagId.set(m.tag, (await memoryWrite({ agentId: 'a', kind: 'fact', content: m.text })).id)
      for (const t of ['auth1', 'auth2', 'auth3', 'auth4', 'db1', 'db2', 'db3', 'db4']) memoryFeedback({ id: tagId.get(t)!, helpful: true })

      _setAdaptForTests(false)
      const rq: RankedQuery[] = []
      for (const q of CORE_QUERIES) {
        const hits = await memorySearch({ query: q.text, limit: 10, diversify: true })
        rq.push({ rankedIds: hits.map((h) => h.id), relevant: new Set(q.answer.map((t) => tagId.get(t)!)) })
      }
      const summary = evaluate(rq, [1, 5, 10])
      const measured = { recall_at_10: round(summary.recallAtK[10]), ndcg_at_10: round(summary.ndcgAtK[10]), mrr: round(summary.mrr) }
      console.log('\nBENCH-GATE| int8 ' + JSON.stringify(measured))

      const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
      expect(measured.recall_at_10).toBeGreaterThanOrEqual(baseline.recall_at_10 - EPSILON)
      expect(measured.ndcg_at_10).toBeGreaterThanOrEqual(baseline.ndcg_at_10 - EPSILON)
      expect(measured.mrr).toBeGreaterThanOrEqual(baseline.mrr - EPSILON)
    } finally {
      _setQuantizeForTests(false)
      _resetForTests()
      try { fs.rmSync(qtmp, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  it('reports the recall delta of each dormant tier (WP-B decision input)', async () => {
    const avgHits = (rq: RankedQuery[]) => rq.reduce((s, q) => s + q.rankedIds.length, 0) / rq.length
    const score = (rq: RankedQuery[]) => ({ r10: meanRecallAtK(rq, 10), ndcg10: meanNdcgAtK(rq, 10), mrr: mrr(rq), hits: avgHits(rq) })
    const raw = score(await rankedFor(CORE_QUERIES, { diversify: false }))
    const gate = score(await rankedFor(CORE_QUERIES, { diversify: true }))
    const fusion = score(await rankedFor(CORE_QUERIES, { diversify: true, fuseGraph: true }))
    const taste = score(await rankedFor(CORE_QUERIES, { diversify: true, adapt: true }))
    const row = (n: string, m: { r10: number; ndcg10: number; mrr: number; hits: number }) =>
      `BENCH-TIER| ${n.padEnd(12)} recall@10=${m.r10.toFixed(3)} ndcg@10=${m.ndcg10.toFixed(3)} mrr=${m.mrr.toFixed(3)} avgHits=${m.hits.toFixed(1)}`
    console.log('\n' + [
      row('raw (no div)', raw),
      row('gate+div', gate),
      row('+fusion', fusion),
      row('+taste', taste),
      `BENCH-TIER| MMR cost: recall@10 ${(gate.r10 - raw.r10).toFixed(3)}, ndcg@10 ${(gate.ndcg10 - raw.ndcg10).toFixed(3)}`,
      `BENCH-TIER| delta fusion: recall@10 ${(fusion.r10 - gate.r10).toFixed(3)}, ndcg@10 ${(fusion.ndcg10 - gate.ndcg10).toFixed(3)}`,
      `BENCH-TIER| delta taste:  recall@10 ${(taste.r10 - gate.r10).toFixed(3)}, ndcg@10 ${(taste.ndcg10 - gate.ndcg10).toFixed(3)}`,
    ].join('\n'))
    // Non-collapse guard only here; the numeric verdict drives the WP-B enable/disable decision.
    expect(fusion.r10).toBeGreaterThanOrEqual(gate.r10 - 0.15)
    expect(taste.r10).toBeGreaterThanOrEqual(gate.r10 - 0.15)
  })
})

function round(n: number): number { return Math.round(n * 1000) / 1000 }
