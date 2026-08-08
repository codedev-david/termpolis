// v1.26 step 2 — the memory brain moved into a utilityProcess, and src/main/index.ts now talks to it
// through memoryClient. Every store call is a PROMISE.
//
// Inside an async IPC handler that is a mechanical `await`. It is NOT mechanical at the four places
// where a store call is handed to something that consumes it SYNCHRONOUSLY:
//
//   runConsolidation(deps)  — SYNC. `const entries = deps.candidates()` then iterates it.
//   runSummarization(deps)  — async, but calls deps.candidates() synchronously and passes deps.simOf
//                             straight into the SYNC planMerges.
//   runWeave(deps)          — SYNC. Calls deps.neighbours(id, k) from INSIDE its candidate loop.
//   ingestConversations     — `if (deps.hasHash(h))`, once per chunk.
//
// A Promise is TRUTHY, has no `.length`, is not iterable, and compares NaN. So a naive `await`-proxy
// at those sites does not throw a visible error — it makes the pass quietly do NOTHING, or (worse)
// decide against garbage. And every one of those call sites is wrapped in `catch { /* best effort */ }`,
// so there is no log, no metric, and no failing test unless one is written to look.
//
// This file is that test. It drives the REAL index.ts indexer pass, with the REAL planners, against a
// REAL store served over the REAL RPC seam (a fake transport, structured-clone included).
//
// It then pins the failure modes directly. Each `MUTATION:` case runs a planner with the NAIVE deps
// and proves the outcome is silent nothing — which is what makes the green assertions above it mean
// something. (Every one of these was verified by reverting src/main/index.ts to the naive shape and
// confirming this file goes red; the fire-and-forget variants are caught by the unhandled-rejection
// suite further down, since with a HEALTHY host they are indistinguishable from the correct code.)

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import * as realFs from 'fs'
import * as os from 'os'
import * as path from 'path'

// ---------------------------------------------------------------------------
// Harness — everything heavy that index.ts pulls in at import / whenReady.
// The MEMORY stack (swarmMemory, memoryHost, memoryClient, memoryGraph, the mneme planners,
// brainIpc, brainExport, conversationIngest's knownHashes) is deliberately REAL.
// ---------------------------------------------------------------------------
const ipcHandlers = new Map<string, Function>()
const mockWebContents = { send: vi.fn(), executeJavaScript: vi.fn() }
const mockMainWindow = {
  minimize: vi.fn(), maximize: vi.fn(), unmaximize: vi.fn(),
  isMaximized: vi.fn(), isMinimized: vi.fn(() => false),
  restore: vi.fn(), focus: vi.fn(), close: vi.fn(), on: vi.fn(),
  loadURL: vi.fn(), loadFile: vi.fn(), webContents: mockWebContents,
}
function MockBrowserWindow() { return mockMainWindow }
MockBrowserWindow.prototype = {}

const USER_DATA = realFs.mkdtempSync(path.join(os.tmpdir(), 'plannerproxy-ud-'))

const { mockStartIndexer, mockRunConversationIngest, mockResolveCodeRefs } = vi.hoisted(() => ({
  mockStartIndexer: vi.fn(),
  // The real ingester would walk ~/.claude, ~/.codex … on the developer's actual disk. The pass under
  // test here is what happens AFTER the ingest, so stub it out and keep the run deterministic.
  mockRunConversationIngest: vi.fn(async () => ({ filesScanned: 0, chunksWritten: 0, chunksSkipped: 0, truncated: false })),
  mockResolveCodeRefs: vi.fn(() => [] as Array<{ file: string; symbol?: string; symbolId?: string }>),
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => USER_DATA),
    getVersion: vi.fn(() => '1.26.0'),
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: () => true,
    setName: vi.fn(), setAppUserModelId: vi.fn(), on: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    isPackaged: false, quit: vi.fn(),
  },
  ipcMain: { handle: vi.fn((c: string, h: Function) => { ipcHandlers.set(c, h) }), on: vi.fn() },
  BrowserWindow: MockBrowserWindow,
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn(), showMessageBox: vi.fn(async () => ({ response: 1 })) },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => ({})) },
  nativeImage: { createFromPath: vi.fn(() => ({})) },
  globalShortcut: { register: vi.fn(), unregisterAll: vi.fn() },
  // No OS keychain: the store stays honestly plaintext, so the assertions read real JSONL.
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  // memoryClient imports this statically. It must never be forked here — every test injects a transport.
  utilityProcess: { fork: () => { throw new Error('utilityProcess.fork must not be called in unit tests') } },
}))

vi.mock('../../src/main/sentry', () => ({ initMainSentry: vi.fn() }))
vi.mock('../../src/main/terminalManager', () => ({
  spawnTerminal: vi.fn(), writeToTerminal: vi.fn(), resizeTerminal: vi.fn(), killTerminal: vi.fn(),
  killAll: vi.fn(), getTerminal: vi.fn(), getAllTerminals: vi.fn(() => []), getOutputBuffer: vi.fn(() => ''),
  setMouseModeGuard: vi.fn(), onTerminalData: vi.fn(), onTerminalExit: vi.fn(),
}))
vi.mock('../../src/main/sessionStore', () => ({ loadSession: vi.fn(() => ({ terminals: [] })), loadRestoreSession: vi.fn(() => ({ terminals: [] })), saveSession: vi.fn() }))
vi.mock('../../src/main/historyStore', () => ({ appendCommand: vi.fn(), searchHistory: vi.fn(() => []) }))
vi.mock('../../src/main/configFileManager', () => ({ readConfigFile: vi.fn(), writeConfigFile: vi.fn() }))
vi.mock('../../src/main/completionService', () => ({ listPathEntries: vi.fn(() => []), listPathCommands: vi.fn(() => []), listEnvVars: vi.fn(() => []) }))
vi.mock('../../src/main/shellDetector', () => ({ detectAvailableShells: vi.fn(async () => []) }))
vi.mock('../../src/main/mcpServer', () => ({
  startMcpServer: vi.fn(() => ({ close: vi.fn() })), stopMcpServer: vi.fn(),
  getMcpAuthToken: vi.fn(() => 'tok'), getMcpPort: vi.fn(() => 9315),
  awaitMcpPortBound: vi.fn(async () => 9315), initAuditLog: vi.fn(),
}))
vi.mock('../../src/main/swarmManager', () => ({
  sendMessage: vi.fn(), readMessages: vi.fn(() => []), getAllMessages: vi.fn(() => []),
  createTask: vi.fn(), listTasks: vi.fn(() => []), updateTask: vi.fn(), clearSwarm: vi.fn(),
}))
vi.mock('../../src/main/agentEventBus', () => ({
  initEventBus: vi.fn(), query: vi.fn(() => []), subscribe: vi.fn(), publish: vi.fn(),
  getRingSize: vi.fn(() => 0), getDroppedCount: vi.fn(() => 0), shutdownEventBus: vi.fn(),
}))
vi.mock('../../src/main/transcriptWatchers', () => ({ attachWatcher: vi.fn(), detachWatchers: vi.fn(), detachAll: vi.fn() }))
vi.mock('../../src/main/contextPinStore', () => ({
  initContextPinStore: vi.fn(), listPins: vi.fn(() => []), addPin: vi.fn(),
  removePin: vi.fn(), updatePin: vi.fn(), clearPins: vi.fn(),
}))
vi.mock('../../src/main/autoUpdater', () => ({ initAutoUpdater: vi.fn() }))
vi.mock('../../src/main/agentCommandSanitizer', () => ({ sanitizeAgentCommand: vi.fn((c: string) => c) }))
vi.mock('../../src/main/localEmbedder', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), // keep EMBED_DIM real
  isEmbedderReady: vi.fn(() => true), setWorkerSpawner: vi.fn(),
}))
vi.mock('../../src/main/embedWorker', () => ({ createWorkerTransport: vi.fn() }))
vi.mock('uuid', () => ({ v4: vi.fn(() => `uuid-${Math.random().toString(36).slice(2)}`) }))
// Capture the indexer options instead of arming real timers — `run()` IS the pass under test.
vi.mock('../../src/main/memoryIndexer', () => ({ startIndexer: mockStartIndexer, stopIndexer: vi.fn() }))
vi.mock('../../src/main/conversationIngest', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), // knownHashes stays REAL
  runConversationIngest: mockRunConversationIngest,
}))
vi.mock('../../src/main/codeIngest', () => ({ runCodeIngest: vi.fn(async () => ({})), discoverRepoFiles: vi.fn(async () => []) }))
vi.mock('../../src/main/codeWatch', () => ({ ensureRepoWatch: vi.fn(), stopRepoWatches: vi.fn(), fsBackedWatchDeps: vi.fn(), reindexWatchedChange: vi.fn() }))
// The CODE graph stays in main and stays synchronous — that is exactly why runWeave's resolveCode dep
// is left alone. Stubbed so the bridge miner's resolution is deterministic.
vi.mock('../../src/main/codeGraph', () => ({
  initCodeGraph: vi.fn(), buildCodeGraph: vi.fn(async () => ({})), reindexWatchedChange: vi.fn(),
  codeExplore: vi.fn(() => []), codeCallers: vi.fn(() => []), codeCallees: vi.fn(() => []),
  codeImpact: vi.fn(() => []), codeSymbols: vi.fn(() => []), codeGraphStats: vi.fn(() => ({})),
  graphKeyForRoot: vi.fn((r: string) => `key:${r}`), resolveCodeRefs: mockResolveCodeRefs,
  resolveToken: vi.fn(() => ({ symbols: [], files: [] })), ALL_REPOS: Symbol('ALL_REPOS'),
}))
// Partial: swarmMemory itself calls initMemoryAudit() during init, so the real surface must survive.
vi.mock('../../src/main/memoryAudit', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  auditMemory: vi.fn(),
}))
vi.mock('../../src/main/memoryAnomalyLog', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  initAnomalyLog: vi.fn(),
}))

// ---------------------------------------------------------------------------
// The REAL memory stack.
// ---------------------------------------------------------------------------
import {
  _resetForTests, _setEmbedFnForTests, memoryList as inprocList,
  initSwarmMemory as inprocInitSwarmMemory, memoryWrite as inprocWrite,
  consolidationSimOf as inprocConsolidationSimOf,
  consolidationCandidates as inprocConsolidationCandidates,
} from '../../src/main/swarmMemory'
import {
  startMemoryHost, stopMemoryHost, setMemoryHostSpawner, _resetMemoryClientForTests, memoryHostMode,
  memoryWrite, memoryList, memoryCount, consolidationCandidates, consolidationSimOf,
  weaveCandidates, weaveNeighboursBatch, weaveNeighbours, memoryArchive, searchArchive,
  exportMemorySnapshot,
  type MemoryHostTransport,
} from '../../src/main/memoryClient'
import { handleMessage, _resetHostForTests, type HostRequest, type HostResponse } from '../../src/main/memoryHost'
import { runConsolidation, runSummarization } from '../../src/main/mnemeConsolidateRun'
import { runWeave, WEAVE_NEIGHBOUR_K } from '../../src/main/mnemeWeave'
import { initMemoryGraph, getAllEdges, _resetGraphForTests } from '../../src/main/memoryGraph'
import { buildBrainArchive, mergeBrainArchive } from '../../src/main/brainIpc'
import { readZip } from '../../src/main/zipArchive'
import { EMBED_DIM } from '../../src/main/localEmbedder'

const DAY = 86_400_000

/** A real RPC boundary: the client's messages are structured-cloned into the REAL host dispatcher and
 *  the replies are cloned back. Same fake localEmbedder.test.ts / memoryHost.test.ts use.
 *  `failFns` makes named calls REJECT, which is how a real host behaves when it is unhealthy. */
function fakeHostTransport(opts: { failFns?: string[] } = {}): MemoryHostTransport {
  let msgCb: ((m: HostResponse) => void) | null = null
  let dead = false
  return {
    postMessage: (msg: HostRequest) => {
      if (dead) return
      const inbound = structuredClone(msg) // a payload that cannot cross a process boundary throws HERE
      if (inbound.kind === 'call' && opts.failFns?.includes(inbound.fn)) {
        queueMicrotask(() => {
          if (dead) return
          msgCb?.({ kind: 'result', id: inbound.id, ok: false, error: { name: 'Error', message: `memory host: ${inbound.fn} failed` } })
        })
        return
      }
      void (async () => {
        const res = await handleMessage(inbound)
        if (dead || !res) return
        msgCb?.(structuredClone(res))
      })()
    },
    onMessage: (cb) => { msgCb = cb },
    onExit: () => {},
    kill: () => { dead = true },
    pid: 5150,
  }
}

/** Deterministic unit vectors — cosine is then exactly 1 (same basis) or 0 (orthogonal). They must be
 *  EMBED_DIM wide: the packed store accepts nothing else, and a short vector falls out of the packed
 *  store entirely and silently scores 0. */
const unit = (i: number): number[] => { const v = new Array(EMBED_DIM).fill(0); v[i] = 1; return v }

/**
 * Every fixture states its OWN vector, with a `#vN` marker: same N ⇒ cosine 1, different N ⇒ cosine 0.
 * Unmarked content gets a private basis vector, so it is orthogonal to everything.
 *
 * This is deliberate. An embed fn that lumps all "uninteresting" text onto one vector makes every
 * fixture a near-duplicate of every other, and consolidation then quietly writes a rollup summary
 * nobody asked for — which is exactly the kind of accident that turns a precise assertion
 * ("these 4 survive") into a confusing one.
 */
let vecSeq = 0
const vecFor = new Map<string, number>()
function fixtureVector(text: string): number[] {
  const m = /#v(\d+)/.exec(text)
  if (m) return unit(Number(m[1]))
  if (!vecFor.has(text)) vecFor.set(text, 100 + vecSeq++)
  return unit(vecFor.get(text)!)
}

let tmp: string
const tmpDirs: string[] = []
let indexerOpts: { run: () => Promise<unknown>; fastRun: () => Promise<unknown> }
let windowCreatedAtBoot = 0

beforeAll(async () => {
  await import('../../src/main/index')
  await new Promise((r) => setTimeout(r, 50)) // let app.whenReady().then(...) run
  indexerOpts = mockStartIndexer.mock.calls[0][0]
  expect(typeof indexerOpts.run).toBe('function')
  // Captured BEFORE any beforeEach/afterEach clearAllMocks wipes the call history.
  windowCreatedAtBoot = mockMainWindow.loadURL.mock.calls.length + mockMainWindow.loadFile.mock.calls.length
})

beforeEach(async () => {
  tmp = realFs.mkdtempSync(path.join(os.tmpdir(), 'plannerproxy-'))
  tmpDirs.push(tmp)
  _resetForTests()
  _resetHostForTests()
  _resetGraphForTests()
  _resetMemoryClientForTests()
  initMemoryGraph(tmp)
  vecFor.clear()
  vecSeq = 0
  _setEmbedFnForTests(async (t: string) => fixtureVector(t))
  mockResolveCodeRefs.mockReturnValue([])
  setMemoryHostSpawner(() => fakeHostTransport())
  const mode = await startMemoryHost({ userDataPath: tmp })
  expect(mode).toBe('host') // every assertion below crosses a real serialization boundary
})

afterEach(() => {
  stopMemoryHost()
  _resetMemoryClientForTests()
  _resetHostForTests()
  _resetGraphForTests()
  _resetForTests()
  _setEmbedFnForTests(null)
  vi.clearAllMocks()
  mockRunConversationIngest.mockResolvedValue({ filesScanned: 0, chunksWritten: 0, chunksSkipped: 0, truncated: false })
  for (const d of tmpDirs.splice(0)) { try { realFs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 1. CONSOLIDATION — the pass must archive the RIGHT memories, and only those.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('consolidation through the proxy — the right memories are archived, the keepers survive', () => {
  const now = Date.now()

  /**
   * A discriminating fixture. planForget only touches EPISODIC/message chatter that is untagged,
   * edge-free, older than the 14-day floor, and whose decayScore (importance × 2^(-age/30d)) has
   * fallen under 0.15. Each keeper below fails exactly ONE of those clauses, so a planner that is
   * handed garbage cannot accidentally pass by forgetting nothing OR by forgetting everything.
   */
  async function seed(): Promise<Record<string, string>> {
    const ids: Record<string, string> = {}
    // FORGET: episodic, 60 days old, low importance → 0.2 × 2^-2 = 0.05 < 0.15
    ids.coldChatter = (await memoryWrite({ agentId: 'a', kind: 'note', memoryType: 'episodic', content: 'cold chatter about nothing', importance: 0.2, ts: now - 60 * DAY })).id
    ids.coldChatter2 = (await memoryWrite({ agentId: 'a', kind: 'message', content: 'more cold terminal noise', importance: 0.2, ts: now - 90 * DAY })).id
    // KEEP: too RECENT (inside the 14-day floor)
    ids.recent = (await memoryWrite({ agentId: 'a', kind: 'note', memoryType: 'episodic', content: 'fresh episodic note', importance: 0.2, ts: now - 1 * DAY })).id
    // KEEP: not episodic — a distilled lesson is never forgettable, however old
    ids.lesson = (await memoryWrite({ agentId: 'a', kind: 'note', memoryType: 'semantic', content: 'the distilled lesson', importance: 0.2, ts: now - 120 * DAY })).id
    // KEEP: TAGGED (curation signal)
    ids.tagged = (await memoryWrite({ agentId: 'a', kind: 'note', memoryType: 'episodic', content: 'old but tagged', importance: 0.2, ts: now - 60 * DAY, tags: ['keepme'] })).id
    // KEEP: high IMPORTANCE → 0.9 × 2^-2 = 0.225 > 0.15
    ids.important = (await memoryWrite({ agentId: 'a', kind: 'note', memoryType: 'episodic', content: 'old but important', importance: 0.9, ts: now - 60 * DAY })).id
    return ids
  }

  it('archives exactly the cold, low-value chatter — and NOTHING else', async () => {
    const ids = await seed()
    await expect(memoryCount()).resolves.toBe(6)

    await indexerOpts.run() // ← the REAL pass in src/main/index.ts

    const survivors = (await memoryList({ limit: 100 })).map((e) => e.id)
    // The two cold ones left the hot window...
    expect(survivors).not.toContain(ids.coldChatter)
    expect(survivors).not.toContain(ids.coldChatter2)
    // ...and every keeper is still here. (An `expect.not.toContain` alone would also pass if the
    // pass had archived EVERYTHING, which is the other way this can go catastrophically wrong.)
    expect(survivors).toContain(ids.recent)
    expect(survivors).toContain(ids.lesson)
    expect(survivors).toContain(ids.tagged)
    expect(survivors).toContain(ids.important)
    expect(survivors).toHaveLength(4)
  })

  it('ARCHIVES, never deletes — the forgotten memories are still recoverable', async () => {
    await seed()
    await indexerOpts.run()
    // v1.23 C6: forget = memoryArchive, so deep search must still find them. A tombstoning
    // memoryDelete would make this unrecoverable, and nothing else in the app would notice.
    const recovered = await searchArchive('chatter nothing', 10)
    expect(recovered.map((e) => e.content).join(' ')).toContain('cold chatter about nothing')
  })

  // ── THE MUTATION ────────────────────────────────────────────────────────────────────────────────
  // Everything above is only worth having if the naive port actually fails. It does — SILENTLY.
  it('MUTATION: the naive `candidates: () => client.consolidationCandidates(n)` archives NOTHING', async () => {
    await seed()
    const before = await memoryCount()
    const archived: string[] = []

    let threw: Error | null = null
    try {
      runConsolidation({
        // THE BUG: a Promise, not an array. planMerges' `for (i < entries.length)` sees `undefined`
        // and never loops; planForget's `entries.filter` then throws.
        candidates: () => consolidationCandidates(500) as never,
        simOf: () => 0,
        forget: (id) => { archived.push(id) },
        now: Date.now(),
      })
    } catch (e) { threw = e as Error }

    // It blows up — but index.ts wraps this whole block in `catch { /* best effort */ }`, so in
    // production the throw is swallowed and consolidation simply stops working, forever, in silence.
    expect(threw).toBeTruthy()
    expect(archived).toEqual([])                        // nothing planned
    await expect(memoryCount()).resolves.toBe(before)   // nothing archived
  })

  it('MUTATION: a naive async `simOf` makes planMerges throw — summarization silently stops', async () => {
    await seed()
    const cands = await consolidationCandidates(200)
    // THE BUG: consolidationSimOf() un-awaited is a Promise, not a comparator. planMerges calls it.
    const naiveSimOf = consolidationSimOf(200) as never
    await expect(
      runSummarization({ candidates: () => cands, simOf: naiveSimOf, write: memoryWrite, link: () => {}, now: Date.now() }),
    ).rejects.toThrow(/not a function/)
  })

  it('the rebuilt comparator is NUMERICALLY IDENTICAL to the in-process closure', async () => {
    // consolidationSimOf() returns a CLOSURE over the packed vectors and cannot cross a process
    // boundary; the host ships the pairwise matrix and the client rebuilds the comparator. "Rebuilt"
    // is only safe if it is the SAME function — so compare them pair-for-pair on real vectors.
    await memoryWrite({ agentId: 'x', kind: 'fact', content: 'a cat sat #v1' })    // → unit(1)
    await memoryWrite({ agentId: 'x', kind: 'fact', content: 'the cat ran #v1' })  // → unit(1), identical
    await memoryWrite({ agentId: 'x', kind: 'fact', content: 'dogs bark #v2' })    // → unit(2), orthogonal

    const proxied = await consolidationSimOf(200)
    const inproc = inprocConsolidationSimOf() // the fake host shares this process, so this IS the store
    const cands = inprocConsolidationCandidates(200)
    expect(cands.length).toBe(3)

    for (const a of cands) {
      for (const b of cands) {
        expect(proxied(a, b)).toBeCloseTo(inproc(a, b), 10)
      }
    }
    // …and it is genuinely discriminating, not uniformly zero (which would make the loop vacuous).
    expect(proxied(cands[0], cands[1])).toBeCloseTo(1, 5)
    expect(proxied(cands[0], cands[2])).toBeCloseTo(0, 5)
    expect(proxied(cands[0], { id: 'never-seen' } as never)).toBe(0) // unknown id → 0, as in-process
  })

  it('summarization writes a rollup + part-of edges when a real cluster exists', async () => {
    // planSummaries needs a cluster of >= 4 near-duplicates (cosine >= 0.92). Identical vectors give 1.0.
    for (let i = 0; i < 4; i++) {
      await memoryWrite({ agentId: 'a', kind: 'fact', content: `the parser report number ${i} #v1`, importance: 0.5, ts: now - i })
    }
    await indexerOpts.run()

    const summaries = (await memoryList({ limit: 100 })).filter((e) => e.memoryType === 'summary')
    expect(summaries).toHaveLength(1) // the comparator really did cluster them — a Promise could not

    // The `part-of` edges are minted through the collect-then-flush path, and they are really there.
    const partOf = getAllEdges().filter((e) => e.relation === 'part-of')
    expect(partOf.length).toBeGreaterThanOrEqual(3)
    expect(partOf.every((e) => e.to === summaries[0].id)).toBe(true)
    expect(partOf.every((e) => e.createdBy === 'consolidate')).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 2. THE WEAVE — the right edges, via PRE-FETCHED neighbours.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('the weave through the proxy — the right edges, from a pre-fetched neighbourhood', () => {
  async function seedWeave(): Promise<{ a: string; b: string; c: string }> {
    // Two embedding-near memories in one repo (cosine 1.0, over the 0.72 floor) and one orthogonal.
    const a = (await memoryWrite({ agentId: 'x', kind: 'fact', content: 'the parser handles nulls #v1', project: '/repos/alpha' })).id
    const b = (await memoryWrite({ agentId: 'x', kind: 'fact', content: 'the tokenizer skips nulls #v1', project: '/repos/alpha' })).id
    const c = (await memoryWrite({ agentId: 'x', kind: 'fact', content: 'dogs bark at the moon #v2', project: '/repos/alpha' })).id
    return { a, b, c }
  }

  it('mints an analogy edge between the near pair — and NOT to the orthogonal one', async () => {
    const { a, b, c } = await seedWeave()
    await indexerOpts.run()

    const woven = getAllEdges().filter((e) => e.createdBy === 'weave')
    expect(woven).toHaveLength(1)
    // Symmetric edge, canonicalized by id so A~B and B~A are one edge.
    const [from, to] = a < b ? [a, b] : [b, a]
    expect(woven[0]).toMatchObject({ from, to, relation: 'analogous-knowledge' })
    expect(woven[0].weight).toBeGreaterThanOrEqual(0.72)
    // The orthogonal memory is in no woven edge at all.
    expect(woven.some((e) => e.from === c || e.to === c)).toBe(false)
  })

  it('fetches the whole neighbourhood in ONE call, not one per candidate', async () => {
    await seedWeave()
    // 3 candidates → the naive proxy would be 3 round trips from inside runWeave's loop; at the real
    // 300-candidate budget it is 300 per idle pass. The batch is one message.
    const ids = (await weaveCandidates(300)).map((e) => e.id)
    const batch = await weaveNeighboursBatch(ids, WEAVE_NEIGHBOUR_K)
    expect(Object.keys(batch).sort()).toEqual([...ids].sort())
    // …and it is the SAME answer the per-id call gives, so the batch is a pure round-trip saving.
    for (const id of ids) {
      expect(batch[id]).toEqual(await weaveNeighbours(id, WEAVE_NEIGHBOUR_K))
    }
  })

  it('backfills code anchors — the deferred write really lands on the store', async () => {
    // The bridge miner: an entity memory with no codeRefs, whose name the code graph CAN resolve.
    const e = await memoryWrite({ agentId: 'mneme', kind: 'fact', memoryType: 'entity', content: 'parseConfig', project: '/repos/alpha' })
    mockResolveCodeRefs.mockReturnValue([{ file: 'src/main/config.ts', symbol: 'parseConfig' }])

    await indexerOpts.run()

    // backfillCodeRefs is collected during the (sync) pass and applied afterwards, awaited. Prove it
    // reached the store rather than being dropped on the floor.
    const stored = (await memoryList({ limit: 50 })).find((m) => m.id === e.id)
    expect(stored?.codeRefs).toEqual([{ file: 'src/main/config.ts', symbol: 'parseConfig' }])
    expect(mockResolveCodeRefs).toHaveBeenCalledWith(['parseConfig'], expect.anything())
  })

  // ── THE MUTATIONS ───────────────────────────────────────────────────────────────────────────────
  it('MUTATION: naive `neighbours: (id, k) => client.weaveNeighbours(id, k)` mints ZERO edges', async () => {
    await seedWeave()
    const cands = await weaveCandidates(300)
    let threw: Error | null = null
    const minted: string[] = []
    try {
      runWeave({
        candidates: () => cands,
        // THE BUG: a Promise. runWeave's `for (const n of ns)` cannot iterate it. The `try/catch`
        // around deps.neighbours() does NOT catch this — the throw is at the for-of, one line later.
        neighbours: (id: string, k: number) => weaveNeighbours(id, k) as never,
        link: (from, to, rel) => { minted.push(`${from}->${to}:${rel}`) },
      }, { maxPerPass: 200 })
    } catch (e) { threw = e as Error }

    expect(threw).toBeTruthy()
    expect(threw!.message).toMatch(/is not iterable|not a function/)
    expect(minted).toEqual([]) // …and index.ts's `catch { /* best effort */ }` would eat it whole
  })

  it('MUTATION: naive `candidates: () => client.weaveCandidates(n)` mints ZERO edges', async () => {
    await seedWeave()
    const minted: string[] = []
    let threw: Error | null = null
    try {
      runWeave({
        candidates: () => weaveCandidates(300) as never, // THE BUG: a Promise, not an array
        neighbours: () => [],
        link: (from, to, rel) => { minted.push(`${from}->${to}:${rel}`) },
      }, { maxPerPass: 200 })
    } catch (e) { threw = e as Error }
    expect(threw).toBeTruthy()
    expect(minted).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 2b. WHY THE EFFECTS ARE COLLECTED AND AWAITED, not fired and forgotten.
//
// The planners' side-effect deps (forget / link / backfillCodeRefs) are declared `=> void`, so the
// tempting port is `void memoryArchive(id)` — fire it, drop the handle, move on. With a HEALTHY host
// that looks identical: the write lands a microtask later and every assertion above still passes.
//
// It diverges the moment the store is NOT healthy. A dropped Promise that rejects is an
// **unhandled rejection in the Electron main process** — which is a crash, not a log line — and the
// planners are the one place guaranteed to touch the store when it is under stress (the idle pass
// runs right after a big ingest, and the memory host is exactly the thing that may have just died).
//
// Collect-then-`await`-in-a-try/catch is what makes a store failure a no-op instead of a crash. This
// is the test that says so.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('a store failure during the pass degrades — it never becomes an unhandled rejection', () => {
  /** Bring the store back up behind a host that REJECTS every mutation the planners perform. */
  async function restartWithFailingWrites(): Promise<void> {
    stopMemoryHost()
    _resetMemoryClientForTests()
    _resetHostForTests()
    _resetForTests()
    _setEmbedFnForTests(async (t: string) => fixtureVector(t))
    setMemoryHostSpawner(() => fakeHostTransport({ failFns: ['memoryArchive', 'memoryLink', 'backfillCodeRefs'] }))
    expect(await startMemoryHost({ userDataPath: tmp })).toBe('host')
  }

  it('the idle pass survives a store that rejects every write, and leaks no rejection', async () => {
    const rejections: unknown[] = []
    const onRejection = (r: unknown): void => { rejections.push(r) }
    process.on('unhandledRejection', onRejection)
    try {
      await restartWithFailingWrites()

      // Every effect path must actually FIRE, or the mutation it guards slips through:
      //   forget            → a cold episodic memory (decay plans an archive)
      //   summarization link→ a cluster of FOUR near-duplicates (planSummaries' minSize is 4, so a
      //                       pair mints no summary and therefore no `part-of` link at all)
      //   weave link        → those same four are embedding-near and repo-scoped
      //   backfillCodeRefs  → an entity whose name the code graph resolves
      const now = Date.now()
      await memoryWrite({ agentId: 'a', kind: 'note', memoryType: 'episodic', content: 'cold chatter', importance: 0.2, ts: now - 60 * DAY })
      for (let i = 0; i < 4; i++) {
        await memoryWrite({ agentId: 'x', kind: 'fact', content: `the parser report ${i} #v1`, importance: 0.5, project: '/repos/alpha' })
      }
      await memoryWrite({ agentId: 'mneme', kind: 'fact', memoryType: 'entity', content: 'parseConfig', project: '/repos/alpha' })
      mockResolveCodeRefs.mockReturnValue([{ file: 'src/main/config.ts', symbol: 'parseConfig' }])

      // The pass must COMPLETE. Every effect it plans will be refused by the store, and that is fine:
      // archiving, linking and backfilling are all best-effort by design.
      await expect(indexerOpts.run()).resolves.toBeTruthy()

      // Let anything that was fired-and-forgotten reject on its own time.
      await new Promise((r) => setTimeout(r, 30))

      // NOTHING may be left unhandled. `void memoryArchive(id)` / `void memoryLink(...)` /
      // `void backfillCodeRefs(...)` would each land here — one rejected promise, no catch, and in
      // the real main process that is an app-level crash on a background timer tick.
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 3. brainIpc — export/import must hit the REAL store, not an empty in-main one.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('brain export / import operates on the REAL store', () => {
  it('exports what the store actually holds (an empty in-main store would export nothing)', async () => {
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'BRAINMARKER alpha' })
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'BRAINMARKER beta' })

    const zip = await buildBrainArchive(tmp, '1.26.0', Date.now(), {
      read: () => null, sizeOrZero: () => 0, write: () => {},
    })
    const memoryEntry = readZip(zip).find((e) => e.name === 'memory.jsonl')!
    const jsonl = memoryEntry.data.toString('utf8')

    expect(jsonl).toContain('BRAINMARKER alpha')
    expect(jsonl).toContain('BRAINMARKER beta')
    // The manifest must count them, too — a zero-memory "successful" export is the silent failure.
    const manifest = JSON.parse(readZip(zip).find((e) => e.name === 'manifest.json')!.data.toString('utf8'))
    expect(manifest.memories).toBe(2)
  })

  it('the snapshot it exports is byte-identical to the store proxy\'s', async () => {
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'BRAINMARKER gamma' })
    const zip = await buildBrainArchive(tmp, '1.26.0', Date.now(), { read: () => null, sizeOrZero: () => 0, write: () => {} })
    const fromZip = readZip(zip).find((e) => e.name === 'memory.jsonl')!.data.toString('utf8')
    // export is now string[]; the zip entry is those lines, each newline-terminated (Buffer.concat).
    expect(fromZip).toBe((await exportMemorySnapshot()).map((l) => l + '\n').join(''))
  })

  it('imports INTO the real store — the merged memory is recallable afterwards', async () => {
    // A brain from "another machine".
    const foreign = { id: 'foreign-1', agentId: 'other', kind: 'note', content: 'IMPORTEDMARKER delta', ts: Date.now(), hash: 'fh1' }
    // The zip has to go through the builder — buildBrainZip hashes memory.jsonl into the manifest,
    // and importBrainZip verifies every one of those hashes before it applies anything.
    const { buildBrainZip } = await import('../../src/main/brainExport')
    const foreignZip = buildBrainZip({
      memorySnapshot: () => [JSON.stringify(foreign)],
      graphSnapshot: () => '',
      readFile: () => null,
      appVersion: '1.26.0',
      now: Date.now(),
    })

    const res = await mergeBrainArchive(tmp, foreignZip, { read: () => null, sizeOrZero: () => 9, write: () => {} })
    expect(res.ok).toBe(true)
    expect(res.memoriesImported).toBe(1) // NOT undefined — a sync `.imported` off a Promise would be

    // And it is really in the store, reachable through the proxy.
    const contents = (await memoryList({ limit: 50 })).map((e) => e.content)
    expect(contents).toContain('IMPORTEDMARKER delta')
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 4. THE MAIN THREAD DOES NOT BLOCK.  This is the whole point of the change.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('the main thread never builds the store', () => {
  it('src/main/index.ts imports NOTHING from ./swarmMemory', () => {
    // The one static fact that makes the rest true. index.ts used to import 46 symbols from the store;
    // a single re-added import would silently pull the 4,276 ms init back onto the main thread.
    const src = realFs.readFileSync(path.resolve(__dirname, '../../src/main/index.ts'), 'utf8')
    expect(src).not.toMatch(/from\s+'\.\/swarmMemory'/)
    expect(src).toMatch(/from\s+'\.\/memoryClient'/)
    // …and brainIpc, which imported exportMemorySnapshot/importMemorySnapshot DIRECTLY (they are not
    // among the 46) — left alone it would have exported an EMPTY brain and said it worked.
    const brain = realFs.readFileSync(path.resolve(__dirname, '../../src/main/brainIpc.ts'), 'utf8')
    expect(brain).not.toMatch(/from\s+'\.\/swarmMemory'/)
    expect(brain).toMatch(/exportMemorySnapshot.*importMemorySnapshot.*from\s+'\.\/memoryClient'/s)
  })

  /** Put a REAL store on disk, then wipe this process's copy of it. Anything that reads `tmp` after
   *  this and ends up with the marker in memory must have called initSwarmMemory — right here, on
   *  the main thread. That is the 4,276 ms this whole change exists to move. */
  async function seedStoreOnDiskThenForgetIt(): Promise<void> {
    _resetMemoryClientForTests()
    _resetHostForTests()
    _resetForTests()
    _setEmbedFnForTests(async () => null)
    inprocInitSwarmMemory(tmp)
    await inprocWrite({ agentId: 'a', kind: 'note', content: 'ONDISKMARKER content' })
    expect(inprocList().map((e) => e.content)).toContain('ONDISKMARKER content')
    _resetForTests() // main's in-process store: empty and uninitialised, but the JSONL is on disk
    expect(inprocList()).toHaveLength(0)
  }

  it('initSwarmMemory is NEVER called in this process when the host comes up', async () => {
    await seedStoreOnDiskThenForgetIt()

    // A transport that reports `ready` on its OWN, without running the real host dispatcher. So
    // nothing in this process loads the store — unless main does it, which is exactly what is banned.
    let initSent = false
    setMemoryHostSpawner((): MemoryHostTransport => {
      let cb: ((m: HostResponse) => void) | null = null
      return {
        postMessage: (msg: HostRequest) => {
          if (msg.kind === 'init') { initSent = true; queueMicrotask(() => cb?.({ kind: 'ready', pid: 1, entries: 1 })) }
        },
        onMessage: (c) => { cb = c }, onExit: () => {}, kill: () => {}, pid: 1,
      }
    })

    expect(await startMemoryHost({ userDataPath: tmp })).toBe('host')
    expect(initSent).toBe(true)          // the CHILD was told to build the store...
    expect(inprocList()).toHaveLength(0) // ...and MAIN never did. The store is not in this heap.
  })

  it('…and the same fixture DOES load it in main when the child cannot start (so the check is not vacuous)', async () => {
    await seedStoreOnDiskThenForgetIt()
    // The contrapositive. A spawner that fails degrades to the in-process store — and now the marker
    // IS in this process's heap, which is precisely the state the host mode above proves we avoid.
    setMemoryHostSpawner(() => null)
    expect(await startMemoryHost({ userDataPath: tmp })).toBe('inproc')
    expect(inprocList().map((e) => e.content)).toContain('ONDISKMARKER content')
  })

  it('whenReady does NOT wait for the store — handlers are live while the child is still loading', async () => {
    // A host that never reports ready: startMemoryHost's promise stays pending for the whole test.
    _resetMemoryClientForTests()
    setMemoryHostSpawner((): MemoryHostTransport => ({
      postMessage: () => { /* never answers — the child is still loading its 475MB store */ },
      onMessage: () => {}, onExit: () => {}, kill: () => {}, pid: 2,
    }))
    let settled = false
    void startMemoryHost({ userDataPath: tmp }).then(() => { settled = true })
    await new Promise((r) => setTimeout(r, 20))

    // Main did not block on it: the handshake is still outstanding...
    expect(settled).toBe(false)
    // ...yet the app is fully wired — every IPC handler is registered and the window was created.
    expect(ipcHandlers.size).toBeGreaterThan(50)
    expect(ipcHandlers.has('memory:search')).toBe(true)
    expect(windowCreatedAtBoot).toBeGreaterThan(0) // createWindow() ran at boot, ahead of the store
  })

  it('a store call made DURING startup queues on the handshake instead of failing', async () => {
    // The window paints immediately, so a memory call can (and does) arrive before the child is up.
    // It must wait for the handshake, not reject with "startMemoryHost() has not been called" — the
    // client checks `mode` only AFTER awaiting readyPromise, which is what makes non-blocking startup
    // possible at all.
    _resetMemoryClientForTests()
    _resetHostForTests()
    _resetForTests()
    _setEmbedFnForTests(async () => null)
    setMemoryHostSpawner(() => fakeHostTransport())

    const starting = startMemoryHost({ userDataPath: tmp }) // NOT awaited — exactly as index.ts does
    const early = memoryCount()                             // a call, right now, mid-handshake
    await expect(early).resolves.toBe(0)                    // resolved, not rejected
    await starting
    expect(memoryHostMode()).toBe('host')
  })
})
