// The digests the primer built before 1.55.0 reordered it, as scenarios any version of buildContextPrimer
// can be run on. primerBaseline.test.ts compares each one with the text the 1.54 builder produced
// (fixtures/primerBaseline.json), so a change to the primer that was meant to leave a digest alone is
// caught as a changed byte, not argued about.
//
// Every scenario is built from nothing the 1.55 ordering acts on: no gated lesson, no note past the
// first three. Hits are plain objects with the fields a search result carries; the clock is fixed.
import { buildContextPrimer, type PrimerHit } from '../../src/main/contextPrimer'

export const NOW = 1_700_000_000_000
const HOUR = 3_600_000
const DAY = 86_400_000

const hit = (o: Record<string, unknown>): PrimerHit => o as unknown as PrimerHit
const long = (s: string): string => `${s} ${'detail '.repeat(30)}`
const gone = new Set(['C:/repos/termpolis/src/removed.ts'])
const fileExists = (p: string): boolean => !gone.has(p)

type Search = (opts: { query: string; limit?: number; project?: string }) => Promise<PrimerHit[]>

export interface Scenario {
  name: string
  build: () => Promise<string | null>
}

const scoped = (inProject: PrimerHit[], elsewhere: PrimerHit[]): Search => async (o) => (o.project ? inProject : elsewhere)

/** Fully disjoint wording per hit, so the diversity pass leaves them alone and the budget is what is measured. */
const distinct = (i: number): string => `relevant hit ${i} ` + Array.from({ length: 12 }, (_, j) => `tok${i}x${j}`).join(' ')

export const scenarios: Scenario[] = [
  {
    name: 'flat: two hits, no project',
    build: () =>
      buildContextPrimer(
        async () => [
          hit({ content: 'auth uses JWT middleware\nvalidated per request', source: 'claude', kind: 'message', score: 0.9 }),
          hit({ content: 'rate limiting via token bucket', source: 'code', kind: 'note', score: 0.7 }),
        ],
        { query: 'auth', now: NOW, fileExists },
      ),
  },
  {
    name: 'flat: a long tail trimmed by limit and snippet length',
    build: () =>
      buildContextPrimer(
        async () => Array.from({ length: 15 }, (_, i) => hit({ id: `f${i}`, content: distinct(i), source: i % 2 ? 'codex' : 'claude', kind: 'message', score: 0.95 - i * 0.02, ts: NOW - i * DAY })),
        { query: 'q', limit: 6, maxSnippetChars: 60, now: NOW, fileExists },
      ),
  },
  {
    name: 'flat: numbered contents where one is the head of another (content 1 / content 10)',
    build: () =>
      buildContextPrimer(
        async () => Array.from({ length: 12 }, (_, i) => hit({ id: `n${i + 1}`, content: `content ${i + 1}`, source: 'claude', kind: 'message', score: 0.9 - i * 0.01 })),
        { query: 'q', limit: 12, now: NOW, fileExists },
      ),
  },
  {
    name: 'project: its own hits lead, labelled, ahead of a higher-scoring global one',
    build: () =>
      buildContextPrimer(
        scoped(
          [hit({ id: 'p1', content: 'project decision about MCP ports', source: 'claude', kind: 'message', score: 0.6, project: 'termpolis' })],
          [hit({ id: 'g1', content: 'unrelated react tips', source: 'claude', kind: 'message', score: 0.95 })],
        ),
        { query: 'q', project: 'termpolis', now: NOW, fileExists },
      ),
  },
  {
    name: 'project: past conversations ahead of a higher-scoring code chunk',
    build: () =>
      buildContextPrimer(
        scoped(
          [
            hit({ id: 'c1', content: 'a code chunk from the repo', source: 'code', kind: 'note', score: 0.9, project: 'termpolis' }),
            hit({ id: 'm1', content: 'we decided to use HNSW', source: 'claude', kind: 'message', score: 0.5, project: 'termpolis' }),
          ],
          [],
        ),
        { query: 'q', project: 'termpolis', now: NOW, fileExists },
      ),
  },
  {
    name: 'project: a global hit that names the project is promoted into its block',
    build: () =>
      buildContextPrimer(
        scoped(
          [],
          [
            hit({ id: 'g2', content: 'random other-project note', source: 'claude', kind: 'message', score: 0.9 }),
            hit({ id: 'g1', content: 'in Termpolis the MCP server listens on 9315', source: 'claude', kind: 'message', score: 0.8 }),
          ],
        ),
        { query: 'q', project: 'termpolis', now: NOW, fileExists },
      ),
  },
  {
    name: 'project: numbered conversations (memory 1 / memory 10) keep every line',
    build: () =>
      buildContextPrimer(
        scoped(
          Array.from({ length: 12 }, (_, i) => hit({ id: `q${i + 1}`, content: `memory ${i + 1}`, source: 'claude', kind: 'message', score: 0.9 - i * 0.01, project: 'termpolis' })),
          [],
        ),
        { query: 'q', limit: 12, project: 'termpolis', now: NOW, fileExists },
      ),
  },
  {
    name: 'project: stale and live code chunks, ages, a codex and a gemini conversation',
    build: () =>
      buildContextPrimer(
        scoped(
          [
            hit({ id: 'a1', content: 'user: how do we ship?\n\nassistant: push a tag', source: 'claude', kind: 'message', score: 0.92, project: 'termpolis', ts: NOW - 2 * HOUR }),
            hit({ id: 'a2', content: 'C:/repos/termpolis/src/removed.ts:10-40\nexport const x = 1', source: 'code', kind: 'note', score: 0.9, project: 'termpolis', ts: NOW - 40 * DAY }),
            hit({ id: 'a3', content: 'C:/repos/termpolis/src/kept.ts:1-30\nexport const y = 2', source: 'code', kind: 'note', score: 0.85, project: 'termpolis', ts: NOW - 3 * DAY }),
            hit({ id: 'a4', content: 'user: why is the build red?\n\nassistant: the lint step', source: 'codex', kind: 'message', score: 0.8, project: 'termpolis', ts: NOW - 9 * DAY }),
            hit({ id: 'a5', content: 'user: what is the plan?\n\nassistant: ship it friday', source: 'gemini', kind: 'message', score: 0.7, project: 'termpolis', ts: NOW - 400 * DAY }),
            hit({ id: 'a6', content: 'we chose electron over tauri', source: 'claude', kind: 'decision', score: 0.65, project: 'termpolis', ts: NOW - 31 * DAY }),
          ],
          [
            hit({ id: 'b1', content: 'user: how do I use pnpm?\n\nassistant: pnpm install', source: 'claude', kind: 'message', score: 0.75, project: 'other', ts: NOW - 5 * DAY }),
            hit({ id: 'b2', content: 'a fact about another repo', source: 'claude', kind: 'fact', score: 0.55, project: 'other', ts: NOW - 20 * DAY }),
          ],
        ),
        { query: 'q', project: 'termpolis', projectPath: 'C:/repos/termpolis', now: NOW, fileExists },
      ),
  },
  {
    name: 'project: three notes lead, a conversation follows (the 1.55.0 saved-notes order)',
    build: () =>
      buildContextPrimer(
        scoped(
          [
            hit({ id: 'c1', content: 'a conversation about the cache', source: 'claude', agentId: 'claude-history', kind: 'message', score: 0.9, project: 'termpolis', ts: NOW - HOUR }),
            hit({ id: 'n1', content: 'Invalidate the cache on write, never on a timer', source: 'claude-notes', agentId: 'claude-notes', kind: 'fact', score: 0.7, project: 'termpolis', ts: NOW - 52 * DAY, tags: ['type:reference', 'note:a.md'] }),
            hit({ id: 'n2', content: 'Run the full suite, not only the touched files', source: 'claude-notes', agentId: 'claude-notes', kind: 'decision', score: 0.65, project: 'termpolis', ts: NOW - 10 * DAY, tags: ['type:feedback', 'note:b.md'] }),
            hit({ id: 'n3', content: 'The release goes out on a pushed tag', source: 'claude-notes', agentId: 'claude-notes', kind: 'note', score: 0.6, project: 'termpolis', ts: NOW - 3 * DAY, tags: ['type:project', 'note:c.md'] }),
            hit({ id: 'c2', content: 'another conversation about the cache', source: 'codex', agentId: 'codex-history', kind: 'message', score: 0.5, project: 'termpolis', ts: NOW - 6 * DAY }),
          ],
          [],
        ),
        { query: 'q', project: 'termpolis', now: NOW, fileExists },
      ),
  },
  {
    name: 'project: lessons the gate would not promote read and rank as they always did',
    build: () =>
      buildContextPrimer(
        scoped(
          [
            hit({ id: 'l1', content: 'Root cause found.', source: 'claude', agentId: 'mneme', kind: 'fact', memoryType: 'semantic', importance: 0.8, score: 0.95, project: 'termpolis', ts: NOW - DAY }),
            hit({ id: 'l2', content: 'Next: I will look at the build tomorrow and then update the plan', source: 'claude', agentId: 'mneme', kind: 'decision', memoryType: 'procedural', importance: 0.85, score: 0.9, project: 'termpolis', ts: NOW - 2 * DAY }),
            hit({ id: 'c1', content: 'a conversation about the build', source: 'claude', agentId: 'claude-history', kind: 'message', score: 0.8, project: 'termpolis', ts: NOW - 3 * DAY }),
            hit({ id: 'k1', content: 'a summary memory that is neither', source: 'claude', kind: 'note', memoryType: 'summary', importance: 0.7, score: 0.7, project: 'termpolis', tags: ['type:reference'] }),
          ],
          [],
        ),
        { query: 'q', project: 'termpolis', now: NOW, fileExists },
      ),
  },
  {
    name: 'lane: a recent hit joins a stale digest, the project block keeps the rest',
    build: () =>
      buildContextPrimer(
        scoped(
          [
            hit({ id: 'old1', content: long('a decision from three weeks ago'), source: 'claude', kind: 'message', score: 0.9, project: 'termpolis', ts: NOW - 22 * DAY }),
            hit({ id: 'old2', content: long('a note from five days ago'), source: 'code', kind: 'note', score: 0.85, project: 'termpolis', ts: NOW - 5 * DAY }),
          ],
          [],
        ),
        {
          query: 'q',
          project: 'termpolis',
          projectPath: 'C:/repos/termpolis',
          now: NOW,
          fileExists,
          recent: async () => [
            hit({ id: 'fresh1', content: long('shipped the shortcut icon fix an hour ago'), source: 'claude', kind: 'message', score: 0, project: 'termpolis', ts: NOW - HOUR }),
            hit({ id: 'fresh2', content: long('then wired the installer check'), source: 'claude', kind: 'message', score: 0, project: 'termpolis', ts: NOW - 3 * HOUR }),
            hit({ id: 'tiny', content: 'assistant: Now tests 8 and 9:', source: 'claude', kind: 'message', score: 0, project: 'termpolis', ts: NOW - 4 * HOUR }),
          ],
        },
      ),
  },
  {
    name: 'lane: a flat digest with a lane labels both blocks',
    build: () =>
      buildContextPrimer(
        async () => [
          hit({ id: 'old1', content: long('a decision from three weeks ago'), source: 'claude', kind: 'message', score: 0.9, project: 'termpolis', ts: NOW - 22 * DAY }),
        ],
        {
          query: 'q',
          now: NOW,
          fileExists,
          recent: async () => [hit({ id: 'fresh1', content: long('shipped the shortcut icon fix an hour ago'), source: 'claude', kind: 'message', score: 0, project: 'termpolis', ts: NOW - HOUR })],
        },
      ),
  },
  {
    name: 'lane: nothing from relevance, the lane alone',
    build: () =>
      buildContextPrimer(async () => [], {
        query: 'q',
        project: 'termpolis',
        now: NOW,
        fileExists,
        recent: async () => [hit({ id: 'fresh1', content: long('shipped the shortcut icon fix an hour ago'), source: 'claude', kind: 'message', score: 0, project: 'termpolis', ts: NOW - HOUR })],
      }),
  },
  {
    name: 'lane: a full lane spends from the same budget',
    build: () =>
      buildContextPrimer(
        scoped(
          Array.from({ length: 10 }, (_, i) => hit({ id: `s${i}`, content: distinct(i), source: 'claude', kind: 'message', score: 0.9 - i * 0.01, project: 'termpolis', ts: NOW - 10 * DAY })),
          [],
        ),
        {
          query: 'q',
          limit: 6,
          project: 'termpolis',
          now: NOW,
          fileExists,
          recent: async () => Array.from({ length: 5 }, (_, i) => hit({ id: `r${i}`, content: long(`fresh hit ${i}`), source: 'claude', kind: 'message', score: 0, project: 'termpolis', ts: NOW - HOUR })),
        },
      ),
  },
]
