// Main-process IPC: MEMORY, CODE GRAPH and the PRIMER.
//
// These exercise the HANDLERS in src/main/index.ts — their plumbing, validation,
// fallback arms and error paths — not the brain itself. Every memory module the
// handlers lean on (swarmMemory, memoryGraph, contextPrimer, codeGraph, the mneme
// learning layer, the metrics ledger) is mocked, so each test controls exactly what
// comes back and asserts what the handler DID with it: the shape it returned, the
// args it forwarded, the metric it recorded, the file it wrote, or the
// {success:false,error} it degraded to.
//
// The electron mock + `invoke(channel, args)` harness mirrors security.test.ts.
// `invoke` here is variadic so a handler's own default parameter (`opts = {}`) can
// be reached by calling it with no args at all.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Harness
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

const USER_DATA = require('os').tmpdir()

const {
  mockShowOpenDialog, mockShowSaveDialog, mockStartMcpServer, mockStartIndexer, mockSubscribeEvents, fsMock,
} = vi.hoisted(() => {
  const fsm = {
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => '{}'),
    readdirSync: vi.fn(() => [] as string[]),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
    statSync: vi.fn(() => ({ mtimeMs: Date.now(), size: 0, isDirectory: () => false, isFile: () => true })),
    chmodSync: vi.fn(),
    rmSync: vi.fn(),
    watch: vi.fn(() => ({ close: vi.fn() })),
    // The code-graph sweep MUST read through this, not readFileSync — see the reader tests below.
    promises: { readFile: vi.fn(async () => '{}') },
  }
  return {
    mockShowOpenDialog: vi.fn(),
    mockShowSaveDialog: vi.fn(),
    mockStartMcpServer: vi.fn(() => ({ close: vi.fn() })),
    mockStartIndexer: vi.fn(),
    mockSubscribeEvents: vi.fn(),
    fsMock: fsm,
  }
})

vi.mock('fs', () => ({ ...fsMock, default: fsMock }))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => USER_DATA),
    getVersion: vi.fn(() => '1.25.3'),
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: () => true,
    setName: vi.fn(),
    setAppUserModelId: vi.fn(),
    on: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    disableHardwareAcceleration: vi.fn(),
    isPackaged: false,
    quit: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => { ipcHandlers.set(channel, handler) }),
    on: vi.fn(),
  },
  BrowserWindow: MockBrowserWindow,
  clipboard: { writeText: vi.fn(), readText: vi.fn(() => ''), write: vi.fn() },
  dialog: {
    showSaveDialog: mockShowSaveDialog,
    showOpenDialog: mockShowOpenDialog,
    showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
  },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => ({})) },
  nativeImage: { createFromPath: vi.fn(() => ({})) },
  globalShortcut: { register: vi.fn(), unregisterAll: vi.fn() },
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}))

// --- infrastructure the memory handlers don't care about -------------------
vi.mock('../../src/main/sentry', () => ({ initMainSentry: vi.fn() }))
vi.mock('../../src/main/terminalManager', () => ({
  spawnTerminal: vi.fn(), killTerminal: vi.fn(), writeToTerminal: vi.fn(),
  resizeTerminal: vi.fn(), killAll: vi.fn(), getTerminalCwd: vi.fn(), getTerminalCwdAsync: vi.fn(async () => ''), getTerminalPid: vi.fn(),
  computeWindowsPty: vi.fn(() => ({})),
}))
vi.mock('../../src/main/sessionStore', () => ({ loadSession: vi.fn(() => ({ terminals: [] })), saveSession: vi.fn() }))
vi.mock('../../src/main/historyStore', () => ({ appendCommand: vi.fn(), searchHistory: vi.fn(() => []) }))
vi.mock('../../src/main/configFileManager', () => ({ readConfigFile: vi.fn(), writeConfigFile: vi.fn() }))
vi.mock('../../src/main/completionService', () => ({
  listPathEntries: vi.fn(() => []), listPathCommands: vi.fn(() => []), listEnvVars: vi.fn(() => []),
}))
vi.mock('../../src/main/shellDetector', () => ({ detectAvailableShells: vi.fn(async () => []) }))
vi.mock('../../src/main/mcpServer', () => ({
  startMcpServer: mockStartMcpServer, stopMcpServer: vi.fn(),
  getMcpAuthToken: vi.fn(() => 'fake-token'), getMcpPort: vi.fn(() => 9315),
  initAuditLog: vi.fn(), awaitMcpPortBound: vi.fn(() => Promise.resolve(9315)),
}))
vi.mock('../../src/main/swarmManager', () => ({
  sendMessage: vi.fn(), readMessages: vi.fn(() => []), getAllMessages: vi.fn(() => []),
  createTask: vi.fn(), listTasks: vi.fn(() => []), updateTask: vi.fn(), clearSwarm: vi.fn(),
}))
vi.mock('../../src/main/agentEventBus', () => ({
  initEventBus: vi.fn(), query: vi.fn(() => []), subscribe: mockSubscribeEvents, publish: vi.fn(),
  getRingSize: vi.fn(() => 0), getDroppedCount: vi.fn(() => 0), shutdownEventBus: vi.fn(),
}))
vi.mock('../../src/main/transcriptWatchers', () => ({
  attachWatcher: vi.fn(), detachWatchers: vi.fn(), detachAll: vi.fn(),
}))
vi.mock('../../src/main/contextPinStore', () => ({
  initContextPinStore: vi.fn(), listPins: vi.fn(() => []), addPin: vi.fn(),
  removePin: vi.fn(), updatePin: vi.fn(), clearPins: vi.fn(),
}))
vi.mock('../../src/main/autoUpdater', () => ({ initAutoUpdater: vi.fn() }))
vi.mock('../../src/main/agentCommandSanitizer', () => ({ sanitizeAgentCommand: vi.fn((c: string) => c) }))
vi.mock('../../src/main/localEmbedder', () => ({ isEmbedderReady: vi.fn(() => true), setWorkerSpawner: vi.fn() }))
vi.mock('../../src/main/embedWorker', () => ({ createWorkerTransport: vi.fn() }))
vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-uuid') }))

// --- the memory brain: fully mocked, so the handlers are what's under test --
//
// v1.26: index.ts talks to the store through memoryClient (the store itself now lives in a
// utilityProcess), so THAT is what gets mocked. Every proxied call is ASYNC in the real client and
// the mock mirrors that — a mock answering synchronously where production returns a Promise would
// hide exactly the bug class this port is about (a Promise is truthy; `.map`/spread/`>` on one
// misbehaves silently). The pure helpers stay sync, as memoryClient re-exports them.
const mem = vi.hoisted(() => ({
  // memoryClient-only surface (lifecycle + the batched calls)
  startMemoryHost: vi.fn(async () => 'host'),
  setMemoryHostSpawner: vi.fn(),
  createMemoryHostTransport: vi.fn(),
  stopMemoryHost: vi.fn(),
  memoryHostMode: vi.fn(() => 'host'),
  memoryHostPid: vi.fn(() => 4242),
  // The graph lives in the memory process with the store — so these are ASYNC, like every other
  // proxied read. They were the last thing still being read from the in-main module (a singleton
  // that is never initialised there), which is why the dashboard reported an empty graph.
  graphStats: vi.fn(async () => ({ nodes: 5, edges: 9 })),
  graphRelationStats: vi.fn(async () => ({ explains: 2, follows: 1 })),
  exportGraphEdges: vi.fn(async () => ''),
  importGraphEdges: vi.fn(async () => 0),
  exportMemorySnapshot: vi.fn(async () => ''),
  importMemorySnapshot: vi.fn(async () => ({ imported: 0 })),
  memoryKnownHashes: vi.fn(async () => [] as string[]),
  weaveNeighboursBatch: vi.fn(async () => ({ w1: [{ id: 'w2', score: 0.9 }] }) as Record<string, any[]>),

  initSwarmMemory: vi.fn(),
  memoryWrite: vi.fn(async (i: any) => ({ id: 'm1', memoryType: 'semantic', ...i })),
  memorySearch: vi.fn(async () => [] as any[]),
  memoryRelated: vi.fn(async () => [{ id: 'r1' }]),
  memoryLink: vi.fn(async () => ({ ok: true })),
  memoryGraphQuery: vi.fn(async () => ({ nodes: [], edges: [] })),
  memoryFeedback: vi.fn(async () => ({ ok: true })),
  memoryList: vi.fn(async () => [{ id: 'l1' }]),
  memoryCount: vi.fn(async () => 42),
  memoryClear: vi.fn(async () => {}),
  memoryHasHash: vi.fn(async () => false),
  memoryStats: vi.fn(async () => ({ total: 7 })),
  memoryDashboardStats: vi.fn(async () => ({ total: 7, byType: {} })),
  memoryGraphSample: vi.fn(async () => ({ nodes: [{ id: 'n1' }], edges: [] })),
  memoryRecentActivity: vi.fn(async () => [{ day: '2026-07-12', count: 3 }]),
  embeddingsReady: vi.fn(async () => true),
  memorySourceById: vi.fn(async () => 'claude'),
  memoryDelete: vi.fn(async () => {}),
  consolidationCandidates: vi.fn(async () => [{ id: 'c1' }]),
  // The real client resolves to a SYNC comparator, rebuilt in main over the shipped matrix.
  consolidationSimOf: vi.fn(async () => () => 0.9),
  memoryPatchProjects: vi.fn(async () => 0),
  normalizeProjectSlug: vi.fn((p: string) => (p || '').split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() || ''),
  memoryLessons: vi.fn(async () => [] as any[]),
  memoryPruneCodePath: vi.fn(async () => 0),
  warmProbeEmbeddings: vi.fn(async () => true),
  compactSelfShard: vi.fn(async () => ({ compacted: false, before: 0, after: 0 })),
  setMemoryScrubber: vi.fn(),
  weaveCandidates: vi.fn(async () => [{ id: 'w1' }]),
  weaveNeighbours: vi.fn(async () => [{ id: 'w2' }]),
  backfillCodeRefs: vi.fn(async () => {}),
  symbolHistory: vi.fn(async () => [{ id: 'h1', content: 'hist', importance: 0.5, ts: 1, memoryType: 'procedural' }]),
  memoryArchive: vi.fn(async () => {}),
  searchArchive: vi.fn(async () => [{ id: 'a1' }]),
  getSyncStatus: vi.fn(async () => ({ enabled: false })),
  setSyncDir: vi.fn(async () => ({ enabled: true })),
  reloadMemoryFromSync: vi.fn(async () => {}),
  setSyncPassphrase: vi.fn(async () => ({ ok: true })),
  disableSyncEncryption: vi.fn(async () => ({ ok: true })),
  enableLocalEncryption: vi.fn(async () => ({ ok: true })),
  disableEncryption: vi.fn(async () => ({ ok: true })),
  persistMemoryIndex: vi.fn(async () => {}),
  entityDedupHash: vi.fn((n: string, key?: string) => `edh:${n}:${key ?? ''}`),
  projectKeyOf: vi.fn((p: string) => `pk:${p}`),
  // v1.25.5 — int8 vector quantization (the RAM/exactness dial).
  vectorRamStats: vi.fn(async () => ({
    vectors: 1000, dim: 384, quantized: false,
    ramBytes: 1000 * 384 * 4, ramBytesFloat: 1000 * 384 * 4, ramBytesInt8: 1000 * 384,
  })),
  setVectorQuantization: vi.fn(async (on: boolean) => ({
    vectors: 1000, dim: 384, quantized: on,
    ramBytes: 1000 * 384 * (on ? 1 : 4), ramBytesFloat: 1000 * 384 * 4, ramBytesInt8: 1000 * 384,
  })),
}))
vi.mock('../../src/main/memoryClient', () => mem) // what index.ts + brainIpc import now
vi.mock('../../src/main/swarmMemory', () => mem)

const graph = vi.hoisted(() => ({
  // Counts relations in place. The dashboard used to call getAllEdges(), which built a fresh flat
  // copy of every edge in the graph purely to tally it — garbage, on the thread that pumps the PTY.
  graphRelationStats: vi.fn(() => ({}) as Record<string, number>),
  graphStats: vi.fn(() => ({ nodes: 0, edges: 0 })),
}))
vi.mock('../../src/main/memoryGraph', () => graph)

const primer = vi.hoisted(() => ({
  buildContextPrimer: vi.fn(async () => null as string | null),
  DEFAULT_PRIMER_LIMIT: 10,
}))
vi.mock('../../src/main/contextPrimer', () => primer)

const cg = vi.hoisted(() => ({
  initCodeGraph: vi.fn(),
  buildCodeGraph: vi.fn(async () => ({ symbols: 12, edges: 5 })),
  reindexWatchedChange: vi.fn(),
  codeExplore: vi.fn(() => ({ symbols: [] })),
  codeCallers: vi.fn(() => [{ name: 'caller' }]),
  codeCallees: vi.fn(() => [{ name: 'callee' }]),
  codeImpact: vi.fn(() => [{ name: 'a' }, { name: 'b' }]),
  codeSymbols: vi.fn(() => [{ name: 'sym' }]),
  codeGraphStats: vi.fn(() => ({ symbols: 3, edges: 1 })),
  graphKeyForRoot: vi.fn((r: string) => `key:${r}`),
  resolveCodeRefs: vi.fn(() => [{ symbol: 'foo', file: 'a.ts' }]),
  resolveToken: vi.fn(() => ({ symbols: [{ id: 's1', name: 'foo', file: 'a.ts', extra: 'dropped' }], files: ['a.ts'] })),
  ALL_REPOS: '__ALL_REPOS__',
}))
vi.mock('../../src/main/codeGraph', () => cg)

const ledger = vi.hoisted(() => ({
  initMetrics: vi.fn(),
  recordMetric: vi.fn(),
  metricsSummary: vi.fn(() => ({ recalls: 1 })),
}))
vi.mock('../../src/main/metricsLedger', () => ledger)

const mneme = vi.hoisted(() => ({
  // memoryAnomalyLog
  initAnomalyLog: vi.fn(), getAnomalies: vi.fn(() => [{ e: 'anom' }]), anomalyCount: vi.fn(() => 3),
  // memoryIndexer
  stopIndexer: vi.fn(),
  // conversation / code ingest
  runConversationIngest: vi.fn(async () => ({ chunksWritten: 4, truncated: false })),
  runCodeIngest: vi.fn(async () => ({ filesIndexed: 2 })),
  discoverRepoFiles: vi.fn(() => ['a.ts']),
  // codeWatch
  ensureRepoWatch: vi.fn(), stopRepoWatches: vi.fn(), fsBackedWatchDeps: vi.fn(() => ({ watch: vi.fn() })),
  // brainIpc
  buildBrainArchive: vi.fn(() => Buffer.from('ZIPDATA')),
  mergeBrainArchive: vi.fn(() => ({ ok: true, memoriesImported: 5, edgesImported: 2, restored: ['competence'] })),
  realBrainFs: vi.fn(() => ({ read: vi.fn(), write: vi.fn(), sizeOrZero: vi.fn() })),
  // learning layer
  distillEpisode: vi.fn(async () => [{ content: 'lesson' }]),
  isHighValueEpisode: vi.fn(() => false),
  makeHeadlessDistiller: vi.fn(() => vi.fn()),
  onTaskComplete: vi.fn(async () => ({ fired: false, lessons: 0, written: [] })),
  onSessionEpisode: vi.fn(async () => ({ fired: true, lessons: 2, written: ['w1'] })),
  reflectSoloSession: vi.fn(async () => ({ fired: true, lessons: 2 })),
  readSessionTranscript: vi.fn(() => [{ role: 'user', text: 'hi' }]),
  initCompetence: vi.fn(), recordOutcome: vi.fn(),
  assessCompetence: vi.fn(() => ({ domain: 'termpolis', confidence: 0.4 })),
  competenceSummary: vi.fn(() => 'weak at flaky tests'),
  competenceRecords: vi.fn(() => [] as any[]),
  initIdentity: vi.fn(), identitySummary: vi.fn(() => 'I am the termpolis brain'),
  findGaps: vi.fn(() => [{ domain: 'gap' }]),
  curiosityPrompts: vi.fn(() => ['what breaks CI?']),
  runConsolidation: vi.fn(), runSummarization: vi.fn(async () => {}),
  runWeave: vi.fn(),
  poolLessons: vi.fn(() => [{ content: 'pooled', corroboration: 2 }]),
  toAgentLesson: vi.fn((m: any) => ({ source: m.source, content: m.content })),
  detectConflictsNli: vi.fn(async () => [{
    a: { source: 'claude', content: 'always X', extra: 'dropped' },
    b: { source: 'codex', content: 'never X', extra: 'dropped' },
  }]),
  auditMemory: vi.fn(),
  proactiveQuery: vi.fn((t: string) => (t ? `signals:${t}` : '')),
  proactiveSignals: vi.fn((t: string) => (t ? [t] : [])),
  codeLocate: vi.fn(() => [{ file: 'a.ts', score: 1, why: [] }]),
}))
vi.mock('../../src/main/memoryAnomalyLog', () => ({
  initAnomalyLog: mneme.initAnomalyLog, getAnomalies: mneme.getAnomalies, anomalyCount: mneme.anomalyCount,
}))
vi.mock('../../src/main/memoryIndexer', () => ({ startIndexer: mockStartIndexer, stopIndexer: mneme.stopIndexer }))
vi.mock('../../src/main/conversationIngest', () => ({ runConversationIngest: mneme.runConversationIngest }))
vi.mock('../../src/main/codeIngest', () => ({ runCodeIngest: mneme.runCodeIngest, discoverRepoFiles: mneme.discoverRepoFiles }))
vi.mock('../../src/main/codeWatch', () => ({
  ensureRepoWatch: mneme.ensureRepoWatch, stopRepoWatches: mneme.stopRepoWatches, fsBackedWatchDeps: mneme.fsBackedWatchDeps,
}))
vi.mock('../../src/main/brainIpc', () => ({
  buildBrainArchive: mneme.buildBrainArchive, mergeBrainArchive: mneme.mergeBrainArchive, realBrainFs: mneme.realBrainFs,
}))
vi.mock('../../src/main/mnemeReflect', () => ({ distillEpisode: mneme.distillEpisode, isHighValueEpisode: mneme.isHighValueEpisode }))
vi.mock('../../src/main/mnemeDistiller', () => ({ makeHeadlessDistiller: mneme.makeHeadlessDistiller }))
vi.mock('../../src/main/mnemeReflex', () => ({ onTaskComplete: mneme.onTaskComplete, onSessionEpisode: mneme.onSessionEpisode }))
vi.mock('../../src/main/mnemeSession', () => ({ reflectSoloSession: mneme.reflectSoloSession }))
vi.mock('../../src/main/liveTranscript', () => ({ readSessionTranscript: mneme.readSessionTranscript }))
vi.mock('../../src/main/mnemeCompetence', () => ({
  initCompetence: mneme.initCompetence, recordOutcome: mneme.recordOutcome,
  assessCompetence: mneme.assessCompetence, competenceSummary: mneme.competenceSummary,
  competenceRecords: mneme.competenceRecords,
}))
vi.mock('../../src/main/mnemeIdentity', () => ({ initIdentity: mneme.initIdentity, identitySummary: mneme.identitySummary }))
vi.mock('../../src/main/mnemeCuriosity', () => ({ findGaps: mneme.findGaps, curiosityPrompts: mneme.curiosityPrompts }))
vi.mock('../../src/main/mnemeConsolidateRun', () => ({ runConsolidation: mneme.runConsolidation, runSummarization: mneme.runSummarization }))
// WEAVE_NEIGHBOUR_K is a real export index.ts now reads (so the k it pre-fetches neighbours with
// cannot drift from the k runWeave uses). Omitting it here makes vitest's mock proxy THROW on access
// — inside the weave's best-effort catch, so the whole pass would silently do nothing.
vi.mock('../../src/main/mnemeWeave', () => ({ runWeave: mneme.runWeave, WEAVE_NEIGHBOUR_K: 6 }))
vi.mock('../../src/main/mnemeSociety', () => ({ poolLessons: mneme.poolLessons, toAgentLesson: mneme.toAgentLesson }))
vi.mock('../../src/main/nliContradict', () => ({ detectConflictsNli: mneme.detectConflictsNli }))
vi.mock('../../src/main/memoryAudit', () => ({ auditMemory: mneme.auditMemory }))
vi.mock('../../src/main/mnemeRetrieval', () => ({ proactiveQuery: mneme.proactiveQuery, proactiveSignals: mneme.proactiveSignals }))
vi.mock('../../src/main/codeLocate', () => ({ codeLocate: mneme.codeLocate }))

// mnemePrimerAugment is REAL on purpose: memoryPrimer's contract is that the brain's
// self-competence / curiosity / identity actually land in the primer it hands the agent.

function invoke(channel: string, ...args: any[]) {
  const handler = ipcHandlers.get(channel)
  if (!handler) throw new Error(`No handler for ${channel}`)
  return handler({}, ...args)
}

/** The MCP tool handler object index.ts hands to startMcpServer (memory_* / code_* tools). */
let mcp: any
/** The idle-indexer options (run / fastRun) index.ts hands to startIndexer. */
let indexer: any
/** The agent-event subscriber index.ts registers on the event bus. */
let eventFeed: Function

// index.ts registers these ONCE at startup, so they are captured here rather than
// read from mock.calls (which every test's clearAllMocks() wipes).
beforeAll(async () => {
  vi.resetModules()
  await import('../../src/main/index')
  await new Promise((resolve) => setTimeout(resolve, 50))
  mcp = mockStartMcpServer.mock.calls[0]?.[0]
  indexer = mockStartIndexer.mock.calls[0]?.[0]

  // The sensitive-file watcher subscribes to the same bus (and gets in first), so pick
  // index.ts's own live-feed subscriber by what only it does: forward to the renderer.
  for (const [cb] of mockSubscribeEvents.mock.calls as [Function][]) {
    mockWebContents.send.mockClear()
    try { cb({ kind: 'probe', summary: '' }) } catch { /* not the one */ }
    if (mockWebContents.send.mock.calls.some((c) => c[0] === 'agentActivity:event')) {
      eventFeed = cb
      break
    }
  }
  mockWebContents.send.mockClear()
})

it('registers the memory brain with the MCP server, the indexer and the event bus', () => {
  expect(mcp).toBeTruthy()
  expect(indexer).toBeTruthy()
  expect(typeof eventFeed).toBe('function')
})

beforeEach(() => {
  vi.clearAllMocks()
  // Re-arm the defaults vi.clearAllMocks() strips (it clears implementations set via
  // the vi.fn(impl) constructor form only for *Once* impls, but resets call history —
  // re-stating the ones tests rely on keeps every test independent of ordering).
  mem.memoryWrite.mockImplementation(async (i: any) => ({ id: 'm1', memoryType: 'semantic', ...i }))
  mem.memorySearch.mockResolvedValue([])
  mem.memoryList.mockReturnValue([{ id: 'l1' }])
  mem.memoryCount.mockReturnValue(42)
  mem.memoryStats.mockReturnValue({ total: 7 })
  mem.memoryDashboardStats.mockReturnValue({ total: 7, byType: {} })
  mem.memoryGraphSample.mockReturnValue({ nodes: [{ id: 'n1' }], edges: [] })
  mem.memoryRecentActivity.mockReturnValue([{ day: '2026-07-12', count: 3 }])
  mem.embeddingsReady.mockReturnValue(true)
  mem.memorySourceById.mockReturnValue('claude')
  mem.normalizeProjectSlug.mockImplementation((p: string) => (p || '').split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() || '')
  mem.memoryLessons.mockReturnValue([])
  mem.searchArchive.mockReturnValue([{ id: 'a1' }])
  mem.symbolHistory.mockReturnValue([{ id: 'h1', content: 'hist', importance: 0.5, ts: 1, memoryType: 'procedural' }])
  mem.entityDedupHash.mockImplementation((n: string, key?: string) => `edh:${n}:${key ?? ''}`)
  mem.projectKeyOf.mockImplementation((p: string) => `pk:${p}`)
  mem.memoryRelated.mockReturnValue([{ id: 'r1' }])
  mem.memoryGraphQuery.mockReturnValue({ nodes: [], edges: [] })
  mem.memoryFeedback.mockReturnValue({ ok: true })
  mem.consolidationCandidates.mockReturnValue([{ id: 'c1' }])
  mem.consolidationSimOf.mockReturnValue(() => 0.9)
  mem.weaveCandidates.mockReturnValue([{ id: 'w1' }])
  mem.weaveNeighbours.mockReturnValue([{ id: 'w2' }])
  graph.graphRelationStats.mockReturnValue({})
  graph.graphStats.mockReturnValue({ nodes: 0, edges: 0 })
  primer.buildContextPrimer.mockResolvedValue(null)
  cg.buildCodeGraph.mockResolvedValue({ symbols: 12, edges: 5 })
  cg.codeExplore.mockReturnValue({ symbols: [] })
  cg.codeCallers.mockReturnValue([{ name: 'caller' }])
  cg.codeCallees.mockReturnValue([{ name: 'callee' }])
  cg.codeImpact.mockReturnValue([{ name: 'a' }, { name: 'b' }])
  cg.codeSymbols.mockReturnValue([{ name: 'sym' }])
  cg.codeGraphStats.mockReturnValue({ symbols: 3, edges: 1 })
  cg.graphKeyForRoot.mockImplementation((r: string) => `key:${r}`)
  cg.resolveCodeRefs.mockReturnValue([{ symbol: 'foo', file: 'a.ts' }])
  cg.resolveToken.mockReturnValue({ symbols: [{ id: 's1', name: 'foo', file: 'a.ts', extra: 'dropped' }], files: ['a.ts'] })
  ledger.metricsSummary.mockReturnValue({ recalls: 1 })
  mneme.getAnomalies.mockReturnValue([{ e: 'anom' }])
  mneme.anomalyCount.mockReturnValue(3)
  mneme.runConversationIngest.mockResolvedValue({ chunksWritten: 4, truncated: false })
  mneme.runCodeIngest.mockResolvedValue({ filesIndexed: 2 })
  mneme.discoverRepoFiles.mockReturnValue(['a.ts'])
  mneme.buildBrainArchive.mockReturnValue(Buffer.from('ZIPDATA'))
  mneme.mergeBrainArchive.mockReturnValue({ ok: true, memoriesImported: 5, edgesImported: 2, restored: ['competence'] })
  mneme.realBrainFs.mockReturnValue({ read: vi.fn(), write: vi.fn(), sizeOrZero: vi.fn() })
  mneme.distillEpisode.mockResolvedValue([{ content: 'lesson' }])
  mneme.isHighValueEpisode.mockReturnValue(false)
  mneme.onSessionEpisode.mockResolvedValue({ fired: true, lessons: 2, written: ['w1'] })
  mneme.reflectSoloSession.mockResolvedValue({ fired: true, lessons: 2 })
  mneme.readSessionTranscript.mockReturnValue([{ role: 'user', text: 'hi' }])
  mneme.assessCompetence.mockReturnValue({ domain: 'termpolis', confidence: 0.4 })
  mneme.competenceSummary.mockReturnValue('weak at flaky tests')
  mneme.competenceRecords.mockReturnValue([])
  mneme.identitySummary.mockReturnValue('I am the termpolis brain')
  mneme.findGaps.mockReturnValue([{ domain: 'gap' }])
  mneme.curiosityPrompts.mockReturnValue(['what breaks CI?'])
  mneme.poolLessons.mockReturnValue([{ content: 'pooled', corroboration: 2 }])
  mneme.toAgentLesson.mockImplementation((m: any) => ({ source: m.source, content: m.content }))
  mneme.detectConflictsNli.mockResolvedValue([{
    a: { source: 'claude', content: 'always X', extra: 'dropped' },
    b: { source: 'codex', content: 'never X', extra: 'dropped' },
  }])
  mneme.proactiveQuery.mockImplementation((t: string) => (t ? `signals:${t}` : ''))
  mneme.proactiveSignals.mockImplementation((t: string) => (t ? [t] : []))
  mneme.codeLocate.mockReturnValue([{ file: 'a.ts', score: 1, why: [] }])
  mneme.runSummarization.mockResolvedValue(undefined)
  fsMock.readFileSync.mockReturnValue('{}')
  fsMock.readdirSync.mockReturnValue([])
  fsMock.existsSync.mockReturnValue(false)
  fsMock.statSync.mockReturnValue({ mtimeMs: Date.now(), size: 0, isDirectory: () => false, isFile: () => true })
  fsMock.writeFileSync.mockImplementation(() => {})
  fsMock.unlinkSync.mockImplementation(() => {})
  fsMock.mkdirSync.mockImplementation(() => {})
})

const metricsOfType = (t: string) => ledger.recordMetric.mock.calls.map((c) => c[0]).filter((m: any) => m.t === t)

// ===========================================================================
// memory:write
// ===========================================================================
describe('memory:write', () => {
  it('writes the entry and returns it', async () => {
    mem.memoryWrite.mockResolvedValueOnce({ id: 'e9', memoryType: 'procedural' })
    const r = await invoke('memory:write', { agentId: 'claude', kind: 'lesson', content: 'x', tags: ['t'], taskId: 'task-1' })
    expect(r).toEqual({ success: true, data: { id: 'e9', memoryType: 'procedural' } })
    expect(mem.memoryWrite).toHaveBeenCalledWith({
      agentId: 'claude', kind: 'lesson', content: 'x', tags: ['t'], taskId: 'task-1',
    })
  })

  it('defaults a missing kind to "note" rather than writing undefined', async () => {
    await invoke('memory:write', { agentId: 'a', kind: '', content: 'c' })
    expect(mem.memoryWrite).toHaveBeenCalledWith(expect.objectContaining({ kind: 'note' }))
  })

  it('records a successful write in the metrics ledger, carrying the memoryType', async () => {
    mem.memoryWrite.mockResolvedValueOnce({ id: 'e1', memoryType: 'episodic' })
    await invoke('memory:write', { agentId: 'a', kind: 'note', content: 'c' })
    expect(metricsOfType('write')).toEqual([expect.objectContaining({ ok: true, memoryType: 'episodic' })])
  })

  it('returns {success:false} AND records a failed write when the store throws', async () => {
    mem.memoryWrite.mockRejectedValueOnce(new Error('disk full'))
    const r = await invoke('memory:write', { agentId: 'a', kind: 'note', content: 'c' })
    expect(r).toEqual({ success: false, error: 'disk full' })
    expect(metricsOfType('write')).toEqual([expect.objectContaining({ ok: false })])
  })

  it('still returns the entry when the metrics ledger itself throws (metrics are best-effort)', async () => {
    ledger.recordMetric.mockImplementationOnce(() => { throw new Error('ledger down') })
    const r = await invoke('memory:write', { agentId: 'a', kind: 'note', content: 'c' })
    expect(r.success).toBe(true)
    expect(r.data.id).toBe('m1')
  })
})

// ===========================================================================
// memory:search
// ===========================================================================
describe('memory:search', () => {
  it('forwards every filter and returns the hits', async () => {
    mem.memorySearch.mockResolvedValueOnce([{ id: 'h1', score: 0.9 }])
    const r = await invoke('memory:search', { query: 'flaky test', limit: 3, agentId: 'codex', kind: 'lesson', taskId: 't1' })
    expect(r).toEqual({ success: true, data: [{ id: 'h1', score: 0.9 }] })
    expect(mem.memorySearch).toHaveBeenCalledWith({
      query: 'flaky test', limit: 3, agentId: 'codex', kind: 'lesson', taskId: 't1',
    })
  })

  it('records a recall metric carrying the hit count and top score', async () => {
    mem.memorySearch.mockResolvedValueOnce([{ id: 'h1', score: 0.81 }, { id: 'h2', score: 0.4 }])
    await invoke('memory:search', { query: 'q' })
    expect(metricsOfType('recall')).toEqual([expect.objectContaining({ hits: 2, topScore: 0.81 })])
  })

  it('records topScore 0 — not undefined — when nothing was recalled', async () => {
    mem.memorySearch.mockResolvedValueOnce([])
    await invoke('memory:search', { query: 'nothing matches' })
    expect(metricsOfType('recall')).toEqual([expect.objectContaining({ hits: 0, topScore: 0 })])
  })

  it('records embedder availability alongside the recall', async () => {
    mem.embeddingsReady.mockReturnValue(false)
    await invoke('memory:search', { query: 'q' })
    expect(metricsOfType('embed')).toEqual([expect.objectContaining({ available: false })])
    mem.embeddingsReady.mockReturnValue(true)
  })

  // FIXED in v1.25.6. `path` was hardcoded to 'vector', so a UI search that had fallen back to
  // keyword (embedder down) was still booked as a VECTOR recall. The Memory dashboard exists to
  // PROVE the brain works — a proof dashboard that flatters itself is worse than no dashboard.
  it('books a keyword fallback as keyword, not as a vector recall', async () => {
    mem.embeddingsReady.mockReturnValue(false)
    await invoke('memory:search', { query: 'q' })
    expect(metricsOfType('recall')).toEqual([expect.objectContaining({ path: 'keyword' })])
    mem.embeddingsReady.mockReturnValue(true)
  })

  it('books a real vector recall as vector', async () => {
    mem.embeddingsReady.mockReturnValue(true)
    await invoke('memory:search', { query: 'q' })
    expect(metricsOfType('recall')).toEqual([expect.objectContaining({ path: 'vector' })])
  })

  it('the recall and embed metrics can never disagree about the embedder', async () => {
    // They describe the same moment. Reading embeddingsReady() twice allowed them to contradict.
    mem.embeddingsReady.mockReturnValue(false)
    await invoke('memory:search', { query: 'q' })
    expect(metricsOfType('recall')[0]).toMatchObject({ path: 'keyword' })
    expect(metricsOfType('embed')[0]).toMatchObject({ available: false })
    mem.embeddingsReady.mockReturnValue(true)
  })

  it('degrades to {success:false,error} when the search throws', async () => {
    mem.memorySearch.mockRejectedValueOnce(new Error('index corrupt'))
    expect(await invoke('memory:search', { query: 'q' })).toEqual({ success: false, error: 'index corrupt' })
  })
})

// ===========================================================================
// memory:list / count / clear / stats
// ===========================================================================
describe('memory:list', () => {
  it('forwards limit / agentId / kind / since', async () => {
    const r = await invoke('memory:list', { limit: 5, agentId: 'a', kind: 'fact', since: 123 })
    expect(r).toEqual({ success: true, data: [{ id: 'l1' }] })
    expect(mem.memoryList).toHaveBeenCalledWith({ limit: 5, agentId: 'a', kind: 'fact', since: 123 })
  })

  it('tolerates being called with no options at all', async () => {
    const r = await invoke('memory:list')
    expect(r.success).toBe(true)
    expect(mem.memoryList).toHaveBeenCalledWith({ limit: undefined, agentId: undefined, kind: undefined, since: undefined })
  })

  it('degrades to {success:false,error} when the store throws', async () => {
    mem.memoryList.mockImplementationOnce(() => { throw new Error('bad since') })
    expect(await invoke('memory:list', { since: NaN })).toEqual({ success: false, error: 'bad since' })
  })
})

describe('memory:count / memory:clear / memory:stats', () => {
  it('count returns the store count', async () => {
    expect(await invoke('memory:count')).toEqual({ success: true, data: 42 })
  })

  it('clear wipes the store and returns success with no payload', async () => {
    const r = await invoke('memory:clear')
    expect(mem.memoryClear).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ success: true, data: undefined })
  })

  it('stats returns the store stats', async () => {
    expect(await invoke('memory:stats')).toEqual({ success: true, data: { total: 7 } })
  })
})

// ===========================================================================
// memory:metrics — the Memory & Learning dashboard's proof numbers
// ===========================================================================
describe('memory:metrics', () => {
  // The graph lives in the MEMORY PROCESS, with the store. Read it from the in-main module and you
  // get an honest report on an empty singleton: "Connections mapped: 0 — 0 nodes, 0 relation types",
  // drawn over a 4.4 MB memory-graph.jsonl the child is still appending to. That shipped in v1.26.0.
  it('reads the graph from the memory process, not the in-main module', async () => {
    const r = await invoke('memory:metrics')
    expect(mem.graphStats).toHaveBeenCalled()
    expect(mem.graphRelationStats).toHaveBeenCalled()
    expect(r.data.graph).toEqual({ nodes: 5, edges: 9, byRelation: { explains: 2, follows: 1 } })
  })

  // The failure mode this handler's OWN comment warns about, one line above the bug: an un-awaited
  // proxy call sits in the payload as a Promise. `gs.nodes` is then undefined and byRelation
  // structured-clones to {} — a dashboard reporting an empty brain, with nothing thrown anywhere.
  it('AWAITS the graph reads — a Promise in the payload is an empty dashboard', async () => {
    const r = await invoke('memory:metrics')
    expect(typeof r.data.graph.nodes).toBe('number')
    expect(typeof r.data.graph.edges).toBe('number')
    expect(r.data.graph.byRelation).not.toBeInstanceOf(Promise)
    expect(Object.keys(r.data.graph.byRelation)).not.toEqual([])
  })

  // The dashboard is read on demand (tab open / Refresh), never on a timer — so the one thing this
  // must never do is build a throwaway copy of the whole edge set to count it. Counting happens in
  // the child now, in place, and only the tallies cross the wire.
  it('counts relations without shipping the edge set across the process boundary', async () => {
    const r = await invoke('memory:metrics')
    expect(mem.graphRelationStats).toHaveBeenCalled()
    expect(r.data.graph).not.toHaveProperty('edgeList')
    expect((mem as Record<string, unknown>).getAllEdges).toBeUndefined()
  })

  it('surfaces the STRUCTURAL code graph across all repos — a separate store from the memory graph', async () => {
    const r = await invoke('memory:metrics')
    expect(cg.codeGraphStats).toHaveBeenCalledWith('__ALL_REPOS__')
    expect(r.data.codeGraph).toEqual({ symbols: 3, edges: 1 })
    expect(r.data.store).toEqual({ total: 7, byType: {} })
    expect(r.data.ledger).toEqual({ recalls: 1, embedUp: true }) // embedUp is the LIVE embedder probe, added by the handler
    expect(r.data.recentActivity).toEqual([{ day: '2026-07-12', count: 3 }])
    expect(mem.memoryRecentActivity).toHaveBeenCalledWith(14)
  })

  it('reports the LIVE embedder state on the tile, not a stale historical embedUp (v1.27.5)', async () => {
    // The field bug: after an upgrade the ledger's last recorded embed event was a stale `false`, so
    // the tile read "down — keyword fallback" over a brain that was actually serving semantic hits.
    // The handler now overrides embedUp with a fresh embeddingsReady() probe; the historical window
    // (embedRecentUp/Total) is left untouched.
    ledger.metricsSummary.mockReturnValue({ recalls: 20, embedUp: false, embedRecentUp: 12, embedRecentTotal: 20 })
    mem.embeddingsReady.mockReturnValue(true) // the embedder is actually UP right now
    const r = await invoke('memory:metrics')
    expect(r.data.ledger.embedUp).toBe(true)       // live truth wins over the stale last event
    expect(r.data.ledger.embedRecentUp).toBe(12)   // ...but the historical window is preserved
    expect(mem.embeddingsReady).toHaveBeenCalled()
  })

  it('returns the 8 busiest competence domains, most-attempted first, and only the display fields', async () => {
    const records = Array.from({ length: 9 }, (_, i) => ({
      domain: `d${i}`, attempts: i, confidence: 0.5, secret: 'not-for-the-ui',
    }))
    mneme.competenceRecords.mockReturnValueOnce(records)
    const r = await invoke('memory:metrics')
    expect(r.data.competence).toHaveLength(8)
    expect(r.data.competence[0]).toEqual({ domain: 'd8', attempts: 8, confidence: 0.5 })
    expect(r.data.competence.at(-1)).toEqual({ domain: 'd1', attempts: 1, confidence: 0.5 })
    // d0 (fewest attempts) fell off the end, and no extra fields leaked through
    expect(r.data.competence.map((c: any) => c.domain)).not.toContain('d0')
  })

  it('does not mutate the caller\'s competence records while sorting', async () => {
    const records = [{ domain: 'a', attempts: 1, confidence: 0.1 }, { domain: 'b', attempts: 9, confidence: 0.2 }]
    mneme.competenceRecords.mockReturnValueOnce(records)
    await invoke('memory:metrics')
    expect(records.map((r) => r.domain)).toEqual(['a', 'b']) // the .slice() before .sort() is load-bearing
  })

  it('degrades to {success:false,error} when a stats source throws', async () => {
    mem.graphStats.mockRejectedValueOnce(new Error('graph unreadable'))
    expect(await invoke('memory:metrics')).toEqual({ success: false, error: 'graph unreadable' })
  })
})

// ===========================================================================
// memory:host-status — is the brain actually in its own process?
// ===========================================================================
// v1.26.1 shipped this handler calling memoryHostPid() without importing it. A free identifier is a
// ReferenceError, the try/catch swallowed it, and the panel — whose only job was to prove the
// process split had worked — silently reported "unknown" forever. Nothing typechecked main, so the
// build never saw `Cannot find name 'memoryHostPid'`; and the panel's own tests mock
// `window.termpolis`, so they never reached this handler. Both halves were tested. The seam was not.
describe('memory:host-status', () => {
  it('reports the mode and the pid of the memory process', async () => {
    expect(await invoke('memory:host-status')).toEqual({ success: true, data: { mode: 'host', pid: 4242 } })
  })

  it('reports the DEGRADED fallback honestly — the whole reason the panel exists', async () => {
    mem.memoryHostMode.mockReturnValueOnce('inproc')
    mem.memoryHostPid.mockReturnValueOnce(undefined)
    // pid null, not undefined: `undefined` is dropped by structured clone, and the panel would then
    // read a payload with no `pid` key at all rather than one that says "there is no child".
    expect(await invoke('memory:host-status')).toEqual({ success: true, data: { mode: 'inproc', pid: null } })
  })
})

// ===========================================================================
// memory:graph-sample / memory:deep-search / memory:anomalies
// ===========================================================================
describe('memory:graph-sample', () => {
  it('forwards the requested limit', async () => {
    const r = await invoke('memory:graph-sample', { limit: 25 })
    expect(mem.memoryGraphSample).toHaveBeenCalledWith({ limit: 25 })
    expect(r.data).toEqual({ nodes: [{ id: 'n1' }], edges: [] })
  })

  it('passes an undefined limit through when called with no options', async () => {
    await invoke('memory:graph-sample')
    expect(mem.memoryGraphSample).toHaveBeenCalledWith({ limit: undefined })
  })

  it('degrades to {success:false,error} when sampling throws', async () => {
    mem.memoryGraphSample.mockImplementationOnce(() => { throw new Error('no graph') })
    expect(await invoke('memory:graph-sample')).toEqual({ success: false, error: 'no graph' })
  })
})

describe('memory:deep-search (archive tier)', () => {
  it('searches the archive with a default limit of 20', async () => {
    const r = await invoke('memory:deep-search', { query: 'old bug' })
    expect(mem.searchArchive).toHaveBeenCalledWith('old bug', 20)
    expect(r.data).toEqual([{ id: 'a1' }])
  })

  it('coerces a missing query to the empty string instead of passing undefined', async () => {
    await invoke('memory:deep-search', {})
    expect(mem.searchArchive).toHaveBeenCalledWith('', 20)
  })

  it('honours an explicit limit and degrades on error', async () => {
    await invoke('memory:deep-search', { query: 'q', limit: 3 })
    expect(mem.searchArchive).toHaveBeenCalledWith('q', 3)
    mem.searchArchive.mockImplementationOnce(() => { throw new Error('archive gone') })
    expect(await invoke('memory:deep-search', { query: 'q' })).toEqual({ success: false, error: 'archive gone' })
  })
})

describe('memory:anomalies', () => {
  it('returns the anomalies plus the total, defaulting the limit to 100', async () => {
    const r = await invoke('memory:anomalies')
    expect(mneme.getAnomalies).toHaveBeenCalledWith(100)
    expect(r.data).toEqual({ anomalies: [{ e: 'anom' }], total: 3 })
  })

  it('honours an explicit limit', async () => {
    await invoke('memory:anomalies', { limit: 5 })
    expect(mneme.getAnomalies).toHaveBeenCalledWith(5)
  })

  it('degrades to {success:false,error} when the anomaly log throws', async () => {
    mneme.getAnomalies.mockImplementationOnce(() => { throw new Error('log locked') })
    expect(await invoke('memory:anomalies')).toEqual({ success: false, error: 'log locked' })
  })
})

// ===========================================================================
// memory:ingest-conversations / memory:ingest-code
// ===========================================================================
describe('memory:ingest-conversations', () => {
  it('returns the ingest stats', async () => {
    const r = await invoke('memory:ingest-conversations')
    expect(r).toEqual({ success: true, data: { chunksWritten: 4, truncated: false } })
  })

  it('wires the ingest deps to the real store, stamping ingest-authored edges', async () => {
    await invoke('memory:ingest-conversations')
    const deps = mneme.runConversationIngest.mock.calls[0][0]
    expect(deps.write).toBe(mem.memoryWrite)

    // v1.26 — THE trap. The ingest loop consumes membership as a SYNC predicate (`if
    // (deps.hasHash(h))`), and every store call is a Promise now. A Promise is TRUTHY, so wiring the
    // async proxy to `hasHash` would mark every chunk "already stored" and ingestion would silently
    // write NOTHING, forever, with no error anywhere. Pin BOTH halves: the batch is wired, and the
    // per-chunk sync predicate is NOT.
    expect(deps.hasHashes).toBe(mem.memoryKnownHashes)
    expect(deps.hasHash).toBeUndefined()

    deps.patchProjects([{ hash: 'h1', project: 'p' }])
    expect(mem.memoryPatchProjects).toHaveBeenCalledWith([{ hash: 'h1', project: 'p' }])
    deps.link('a', 'b', 'follows', 0.5, 99)
    expect(mem.memoryLink).toHaveBeenCalledWith({ from: 'a', to: 'b', relation: 'follows', weight: 0.5, ts: 99, createdBy: 'ingest' })
  })

  it('degrades to {success:false,error} when ingest throws', async () => {
    mneme.runConversationIngest.mockRejectedValueOnce(new Error('transcripts unreadable'))
    expect(await invoke('memory:ingest-conversations')).toEqual({ success: false, error: 'transcripts unreadable' })
  })
})

describe('memory:ingest-code', () => {
  it('refuses without a repoRoot — before any indexing happens', async () => {
    expect(await invoke('memory:ingest-code', {})).toEqual({ success: false, error: 'repoRoot required' })
    expect(await invoke('memory:ingest-code')).toEqual({ success: false, error: 'repoRoot required' })
    expect(mneme.runCodeIngest).not.toHaveBeenCalled()
  })

  it('ingests the repo AND rebuilds the structural code graph for that repo key', async () => {
    const r = await invoke('memory:ingest-code', { repoRoot: '/repos/termpolis' })
    expect(r.data).toEqual({ filesIndexed: 2, codeGraph: { symbols: 12, edges: 5 } })
    expect(mneme.runCodeIngest).toHaveBeenCalledWith(expect.anything(), { repoRoot: '/repos/termpolis' })
    expect(cg.buildCodeGraph).toHaveBeenCalledWith(expect.anything(), 'key:/repos/termpolis')
    // …and keeps the graph fresh by watching the repo
    expect(mneme.ensureRepoWatch).toHaveBeenCalledWith('/repos/termpolis', expect.anything())
  })

  it('wires the ingest deps and the graph builder to the real repo readers', async () => {
    await invoke('memory:ingest-code', { repoRoot: '/repos/x' })
    const ingestDeps = mneme.runCodeIngest.mock.calls[0][0]
    expect(ingestDeps.write).toBe(mem.memoryWrite)
    // Same trap as the transcript ingester: the sync per-chunk predicate must NOT be an async proxy.
    expect(ingestDeps.hasHashes).toBe(mem.memoryKnownHashes)
    expect(ingestDeps.hasHash).toBeUndefined()
    // prunePath is wrapped (the proxy resolves to a count, the dep is void) — assert it DELEGATES,
    // which pins the behaviour rather than the identity.
    await ingestDeps.prunePath('/repos/x/a.ts')
    expect(mem.memoryPruneCodePath).toHaveBeenCalledWith('/repos/x/a.ts')

    const graphDeps = cg.buildCodeGraph.mock.calls[0][0]
    expect(graphDeps.listFiles()).toEqual(['a.ts'])
    expect(mneme.discoverRepoFiles).toHaveBeenCalledWith('/repos/x')
    await expect(graphDeps.readFile('a.ts')).resolves.toBe('{}')
    // It must be a REAL async read. The sweep awaits this once per file, and an `await` on the
    // already-resolved promise that an async-wrapped readFileSync returns yields only a microtask —
    // which Node drains WITHOUT running the event loop. That made the whole sweep one unbroken 2.8s
    // block: no PTY, no IPC, "(Not Responding)". This test previously asserted readFileSync, which is
    // how the freeze shipped, so pin the property that actually matters in BOTH directions.
    expect(fsMock.promises.readFile).toHaveBeenCalledWith('a.ts', 'utf8')
    expect(fsMock.readFileSync).not.toHaveBeenCalledWith('a.ts', 'utf8')
  })

  it('keeps the graph FRESH: a watched source change re-indexes just those files', async () => {
    // A watcher that is wired but never re-indexes leaves a silently stale graph, so pin
    // the callback itself: it must forward the changed files AND a real file reader.
    await invoke('memory:ingest-code', { repoRoot: '/repos/x' })
    const [watchImpl, onChange] = mneme.fsBackedWatchDeps.mock.calls[0]
    expect(watchImpl).toBe(fsMock.watch) // the REAL fs watcher, not a stub

    onChange('/repos/x', ['a.ts', 'b.ts'])
    expect(cg.reindexWatchedChange).toHaveBeenCalledWith('/repos/x', ['a.ts', 'b.ts'], expect.any(Function))
    const readFile = cg.reindexWatchedChange.mock.calls[0][2] as (f: string) => Promise<string>
    await expect(readFile('a.ts')).resolves.toBe('{}')
    // Async read, not readFileSync — the watch path starves the loop exactly like the full sweep.
    expect(fsMock.promises.readFile).toHaveBeenCalledWith('a.ts', 'utf8')
    expect(fsMock.readFileSync).not.toHaveBeenCalledWith('a.ts', 'utf8')
  })

  it('still succeeds when the code graph blows up — a graph hiccup never fails a good ingest', async () => {
    cg.buildCodeGraph.mockRejectedValueOnce(new Error('parser exploded'))
    const r = await invoke('memory:ingest-code', { repoRoot: '/repos/x' })
    expect(r.success).toBe(true)
    expect(r.data).toEqual({ filesIndexed: 2, codeGraph: undefined })
  })

  it('degrades to {success:false,error} when the semantic ingest itself throws', async () => {
    mneme.runCodeIngest.mockRejectedValueOnce(new Error('git not found'))
    expect(await invoke('memory:ingest-code', { repoRoot: '/r' })).toEqual({ success: false, error: 'git not found' })
  })
})

// ===========================================================================
// code-graph:* IPC
// ===========================================================================
describe('code-graph:build', () => {
  it('refuses without a repoRoot', async () => {
    expect(await invoke('code-graph:build', {})).toEqual({ success: false, error: 'repoRoot required' })
    expect(await invoke('code-graph:build')).toEqual({ success: false, error: 'repoRoot required' })
    expect(cg.buildCodeGraph).not.toHaveBeenCalled()
  })

  it('builds the graph under the repo-scoped key', async () => {
    const r = await invoke('code-graph:build', { repoRoot: '/repos/y' })
    expect(r).toEqual({ success: true, data: { symbols: 12, edges: 5 } })
    expect(cg.buildCodeGraph).toHaveBeenCalledWith(expect.anything(), 'key:/repos/y')
  })

  it('indexes the repo\'s discovered files, read off disk', async () => {
    await invoke('code-graph:build', { repoRoot: '/repos/y' })
    const deps = cg.buildCodeGraph.mock.calls[0][0]
    expect(deps.listFiles()).toEqual(['a.ts'])
    expect(mneme.discoverRepoFiles).toHaveBeenCalledWith('/repos/y')
    await expect(deps.readFile('a.ts')).resolves.toBe('{}')
    expect(fsMock.promises.readFile).toHaveBeenCalledWith('a.ts', 'utf8')
    expect(fsMock.readFileSync).not.toHaveBeenCalledWith('a.ts', 'utf8')
  })

  it('degrades to {success:false,error} when the build throws', async () => {
    cg.buildCodeGraph.mockRejectedValueOnce(new Error('unsupported language'))
    expect(await invoke('code-graph:build', { repoRoot: '/r' })).toEqual({ success: false, error: 'unsupported language' })
  })
})

describe('code-graph read handlers', () => {
  it('stats returns the graph stats, and degrades on error', async () => {
    expect(await invoke('code-graph:stats')).toEqual({ success: true, data: { symbols: 3, edges: 1 } })
    cg.codeGraphStats.mockImplementationOnce(() => { throw new Error('no graph') })
    expect(await invoke('code-graph:stats')).toEqual({ success: false, error: 'no graph' })
  })

  it('explore forwards the query, and coerces a missing one to ""', async () => {
    await invoke('code-graph:explore', { query: 'parse' })
    expect(cg.codeExplore).toHaveBeenCalledWith('parse')
    await invoke('code-graph:explore')
    expect(cg.codeExplore).toHaveBeenLastCalledWith('')
  })

  it('explore degrades to {success:false,error}', async () => {
    cg.codeExplore.mockImplementationOnce(() => { throw new Error('boom') })
    expect(await invoke('code-graph:explore', { query: 'x' })).toEqual({ success: false, error: 'boom' })
  })

  it('search defaults the limit to 50 and passes an undefined query through', async () => {
    await invoke('code-graph:search')
    expect(cg.codeSymbols).toHaveBeenCalledWith(undefined, 50)
    await invoke('code-graph:search', { query: 'foo', limit: 5 })
    expect(cg.codeSymbols).toHaveBeenLastCalledWith('foo', 5)
  })

  it('search degrades to {success:false,error}', async () => {
    cg.codeSymbols.mockImplementationOnce(() => { throw new Error('index missing') })
    expect(await invoke('code-graph:search', { query: 'x' })).toEqual({ success: false, error: 'index missing' })
  })

  it('callers / impact forward the symbol name and coerce a missing one to ""', async () => {
    expect((await invoke('code-graph:callers', { name: 'foo' })).data).toEqual([{ name: 'caller' }])
    expect(cg.codeCallers).toHaveBeenCalledWith('foo')
    await invoke('code-graph:callers')
    expect(cg.codeCallers).toHaveBeenLastCalledWith('')

    expect((await invoke('code-graph:impact', { name: 'foo' })).data).toEqual([{ name: 'a' }, { name: 'b' }])
    expect(cg.codeImpact).toHaveBeenCalledWith('foo')
    await invoke('code-graph:impact')
    expect(cg.codeImpact).toHaveBeenLastCalledWith('')
  })

  it('callers / impact degrade to {success:false,error}', async () => {
    cg.codeCallers.mockImplementationOnce(() => { throw new Error('cg down') })
    expect(await invoke('code-graph:callers', { name: 'x' })).toEqual({ success: false, error: 'cg down' })
    cg.codeImpact.mockImplementationOnce(() => { throw new Error('cg down') })
    expect(await invoke('code-graph:impact', { name: 'x' })).toEqual({ success: false, error: 'cg down' })
  })
})

// ---------------------------------------------------------------------------
// code-graph:locate — the issue->location predictor, and the deps index.ts wires
// into it (the code graph + the memory<->code bridge).
// ---------------------------------------------------------------------------
describe('code-graph:locate', () => {
  it('locates the sites for an issue, scoped to a project key and capped by limit', async () => {
    const r = await invoke('code-graph:locate', { issue: 'null deref in parse', projectKey: 'pk1', limit: 3 })
    expect(r).toEqual({ success: true, data: [{ file: 'a.ts', score: 1, why: [] }] })
    const [issue, , opts] = mneme.codeLocate.mock.calls[0]
    expect(issue).toBe('null deref in parse')
    expect(opts).toEqual({ limit: 3 })
  })

  it('coerces a missing issue to "" rather than passing undefined into the locator', async () => {
    await invoke('code-graph:locate', {})
    expect(mneme.codeLocate.mock.calls[0][0]).toBe('')
  })

  it('wires signals -> resolve -> history -> impact onto the real graph + bridge', async () => {
    await invoke('code-graph:locate', { issue: 'boom', projectKey: 'pk1' })
    const deps = mneme.codeLocate.mock.calls[0][1]

    expect(deps.signals('crash in foo')).toEqual(['crash in foo'])

    // resolve() must SHRINK graph symbols to the locator's contract (id/name/file only)
    expect(deps.resolve('foo')).toEqual({ symbols: [{ id: 's1', name: 'foo', file: 'a.ts' }], files: ['a.ts'] })
    expect(cg.resolveToken).toHaveBeenCalledWith('foo', 'pk1')

    // history() is the memory<->code bridge, scoped to the same project key
    expect(deps.history('foo')).toEqual([{ id: 'h1', content: 'hist', importance: 0.5, ts: 1, memoryType: 'procedural' }])
    expect(mem.symbolHistory).toHaveBeenCalledWith('foo', 'pk1')

    // impact() is a COUNT (blast-radius size), not the symbol list
    expect(deps.impact('foo')).toBe(2)
    expect(cg.codeImpact).toHaveBeenCalledWith('foo', 6, 'pk1')

    expect(typeof deps.now).toBe('number')
  })

  it('returns an empty list — never an exception — when the locator blows up', async () => {
    mneme.codeLocate.mockImplementationOnce(() => { throw new Error('locator exploded') })
    expect(await invoke('code-graph:locate', { issue: 'x' })).toEqual({ success: true, data: [] })
  })
})

// ===========================================================================
// brain:export / brain:import  (portable .zip, integrity-gated)
// ===========================================================================
describe('brain:export', () => {
  it('writes the archive the user picked and reports its size', async () => {
    mockShowSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/out/brain.zip' })
    const r = await invoke('brain:export')
    expect(r.data).toEqual({ canceled: false, path: '/out/brain.zip', bytes: 7 })
    expect(fsMock.writeFileSync).toHaveBeenCalledWith('/out/brain.zip', Buffer.from('ZIPDATA'))
    expect(mneme.buildBrainArchive).toHaveBeenCalledWith(USER_DATA, '1.25.3', expect.any(Number), expect.anything())
  })

  it('writes NOTHING when the user cancels the save dialog', async () => {
    mockShowSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: undefined })
    expect((await invoke('brain:export')).data).toEqual({ canceled: true })
    expect(mneme.buildBrainArchive).not.toHaveBeenCalled()
    expect(fsMock.writeFileSync).not.toHaveBeenCalled()
  })

  it('treats a dismissed dialog with no path as a cancel', async () => {
    mockShowSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '' })
    expect((await invoke('brain:export')).data).toEqual({ canceled: true })
    expect(fsMock.writeFileSync).not.toHaveBeenCalled()
  })

  it('degrades to {success:false,error} when the write fails', async () => {
    mockShowSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/out/brain.zip' })
    fsMock.writeFileSync.mockImplementationOnce(() => { throw new Error('EACCES') })
    expect(await invoke('brain:export')).toEqual({ success: false, error: 'EACCES' })
  })
})

describe('brain:import', () => {
  it('merges the archive and reloads the stores a fresh-machine import may have restored', async () => {
    mockShowOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/in/brain.zip'] })
    fsMock.readFileSync.mockReturnValueOnce(Buffer.from('ZIPDATA') as any)
    const r = await invoke('brain:import')
    expect(r.data).toEqual({ canceled: false, memoriesImported: 5, edgesImported: 2, restored: ['competence'] })
    expect(mneme.mergeBrainArchive).toHaveBeenCalledWith(USER_DATA, Buffer.from('ZIPDATA'), expect.anything())
    // the reload is what makes an import take effect NOW rather than after a restart
    expect(mneme.initCompetence).toHaveBeenCalledWith(USER_DATA)
    expect(mneme.initIdentity).toHaveBeenCalledWith(USER_DATA)
    expect(ledger.initMetrics).toHaveBeenCalledWith(USER_DATA)
    expect(cg.initCodeGraph).toHaveBeenCalledWith(USER_DATA)
  })

  it('reads nothing when the user cancels', async () => {
    mockShowOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect((await invoke('brain:import')).data).toEqual({ canceled: true })
    expect(mneme.mergeBrainArchive).not.toHaveBeenCalled()
  })

  it('treats an empty selection as a cancel', async () => {
    mockShowOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] })
    expect((await invoke('brain:import')).data).toEqual({ canceled: true })
    expect(mneme.mergeBrainArchive).not.toHaveBeenCalled()
  })

  it('surfaces the merge failure — a failed integrity check must NOT report success', async () => {
    mockShowOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/in/bad.zip'] })
    mneme.mergeBrainArchive.mockReturnValueOnce({ ok: false, error: 'manifest SHA mismatch' } as any)
    expect(await invoke('brain:import')).toEqual({ success: false, error: 'manifest SHA mismatch' })
    expect(mneme.initCompetence).not.toHaveBeenCalled()
  })

  it('falls back to a generic message when the merge fails without one', async () => {
    mockShowOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/in/bad.zip'] })
    mneme.mergeBrainArchive.mockReturnValueOnce({ ok: false } as any)
    expect(await invoke('brain:import')).toEqual({ success: false, error: 'Import failed' })
  })

  it('still reports the import when a store reload throws (reloads are best-effort)', async () => {
    mockShowOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/in/brain.zip'] })
    mneme.initCompetence.mockImplementationOnce(() => { throw new Error('competence file locked') })
    const r = await invoke('brain:import')
    expect(r.success).toBe(true)
    expect(r.data.memoriesImported).toBe(5)
    expect(cg.initCodeGraph).toHaveBeenCalled() // the later reloads still ran
  })

  it('degrades to {success:false,error} when the archive cannot be read', async () => {
    mockShowOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/in/gone.zip'] })
    fsMock.readFileSync.mockImplementationOnce(() => { throw new Error('ENOENT') })
    expect(await invoke('brain:import')).toEqual({ success: false, error: 'ENOENT' })
  })
})

// ===========================================================================
// memory:build-primer + the primer-size setting
// ===========================================================================
describe('memory:build-primer', () => {
  it('leads with the cwd\'s project and defaults the size to the user\'s primer limit', async () => {
    primer.buildContextPrimer.mockResolvedValueOnce('- [claude] did a thing')
    const r = await invoke('memory:build-primer', { query: 'what were we doing', cwd: 'C:/repos/Termpolis' })
    expect(r).toEqual({ success: true, data: '- [claude] did a thing' })
    expect(primer.buildContextPrimer).toHaveBeenCalledWith(mem.memorySearch, {
      query: 'what were we doing', limit: 10, project: 'termpolis',
    })
  })

  it('passes project: undefined (not "") when there is no cwd', async () => {
    await invoke('memory:build-primer', { query: 'q' })
    expect(primer.buildContextPrimer).toHaveBeenCalledWith(mem.memorySearch, {
      query: 'q', limit: 10, project: undefined,
    })
  })

  it('coerces a missing query to "" rather than passing undefined to the builder', async () => {
    await invoke('memory:build-primer', {})
    expect(primer.buildContextPrimer).toHaveBeenCalledWith(mem.memorySearch, expect.objectContaining({ query: '' }))
  })

  it('returns null and injects NOTHING when there is no relevant memory', async () => {
    primer.buildContextPrimer.mockResolvedValueOnce(null)
    const r = await invoke('memory:build-primer', { query: 'unheard-of topic' })
    expect(r).toEqual({ success: true, data: null })
    expect(metricsOfType('inject')).toEqual([]) // nothing was injected, so nothing is billed
  })

  it('records the injected token estimate for a primer it actually returns', async () => {
    primer.buildContextPrimer.mockResolvedValueOnce('x'.repeat(41))
    await invoke('memory:build-primer', { query: 'q' })
    expect(metricsOfType('inject')).toEqual([expect.objectContaining({ tokens: 11 })]) // ceil(41/4)
  })

  it('honours an explicit limit over the persisted primer size', async () => {
    await invoke('memory:build-primer', { query: 'q', limit: 3 })
    expect(primer.buildContextPrimer).toHaveBeenCalledWith(mem.memorySearch, expect.objectContaining({ limit: 3 }))
  })

  it('degrades to {success:false,error} when the builder throws', async () => {
    primer.buildContextPrimer.mockRejectedValueOnce(new Error('embedder unavailable'))
    expect(await invoke('memory:build-primer', { query: 'q' })).toEqual({ success: false, error: 'embedder unavailable' })
  })
})

describe('memory:get-primer-limit / memory:set-primer-limit', () => {
  // The real memorySettings module backs these (fs is stubbed, so it stays in-memory).
  // Restore the default afterwards — memory:build-primer reads the same setting.
  afterEach(async () => { await invoke('memory:set-primer-limit', { value: 10 }) })

  it('returns the current limit as a bare number', async () => {
    expect(await invoke('memory:get-primer-limit')).toEqual({ success: true, data: 10 })
  })

  it('clamps a too-small value up to the minimum', async () => {
    expect((await invoke('memory:set-primer-limit', { value: 0 })).data).toEqual({ primerLimit: 1, vectorQuantize: false })
    expect((await invoke('memory:set-primer-limit', { value: -99 })).data).toEqual({ primerLimit: 1, vectorQuantize: false })
  })

  it('clamps a too-large value down to the maximum', async () => {
    expect((await invoke('memory:set-primer-limit', { value: 9999 })).data).toEqual({ primerLimit: 50, vectorQuantize: false })
  })

  it('rounds a fractional value', async () => {
    expect((await invoke('memory:set-primer-limit', { value: 12.6 })).data).toEqual({ primerLimit: 13, vectorQuantize: false })
  })

  it('falls back to the default for junk and for a missing value', async () => {
    expect((await invoke('memory:set-primer-limit', { value: 'lots' })).data).toEqual({ primerLimit: 10, vectorQuantize: false })
    expect((await invoke('memory:set-primer-limit', {})).data).toEqual({ primerLimit: 10, vectorQuantize: false })
    expect((await invoke('memory:set-primer-limit')).data).toEqual({ primerLimit: 10, vectorQuantize: false })
  })

  it('a new limit is what the NEXT primer is built with', async () => {
    await invoke('memory:set-primer-limit', { value: 4 })
    expect((await invoke('memory:get-primer-limit')).data).toBe(4)
    await invoke('memory:build-primer', { query: 'q' })
    expect(primer.buildContextPrimer).toHaveBeenCalledWith(mem.memorySearch, expect.objectContaining({ limit: 4 }))
  })
})

// ===========================================================================
// memory:prepare-primer-file — the Claude launch primer.
//
// This is the file passed to `claude --append-system-prompt-file`. Its wording is
// load-bearing (v1.25.3): the system prompt is re-sent every request and therefore
// SURVIVES compaction, while the digest the agent loaded lives in the conversation
// and does NOT. If this instruction stops telling the agent to re-call memory_primer
// after a compaction, the agent silently loses its project memory mid-session and
// nothing in the app can tell.
// ===========================================================================
describe('memory:prepare-primer-file', () => {
  const writtenInstruction = () => String(fsMock.writeFileSync.mock.calls[0][1])

  it('writes NO file and seeds NOTHING when there is no relevant memory', async () => {
    primer.buildContextPrimer.mockResolvedValueOnce(null)
    const r = await invoke('memory:prepare-primer-file', { query: 'nothing known', cwd: '/repos/x' })
    expect(r).toEqual({ success: true, data: { file: null, count: 0 } })
    expect(fsMock.writeFileSync).not.toHaveBeenCalled()
    expect(metricsOfType('inject')).toEqual([])
  })

  it('coerces a missing query to "" rather than passing undefined to the builder', async () => {
    const r = await invoke('memory:prepare-primer-file', {})
    expect(primer.buildContextPrimer).toHaveBeenCalledWith(mem.memorySearch, {
      query: '', limit: 10, project: undefined,
    })
    expect(r.data).toEqual({ file: null, count: 0 })
  })

  it('writes the instruction file and counts the memories in the digest', async () => {
    primer.buildContextPrimer.mockResolvedValueOnce('Context:\n- [claude] one\n- [codex] two\nnot a memory line')
    const r = await invoke('memory:prepare-primer-file', { query: 'q', cwd: '/repos/termpolis' })
    expect(r.data.count).toBe(2) // only the "- [" lines are memories
    expect(String(r.data.file)).toMatch(/primers[\\/]primer-mock-uuid\.txt$/)
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(r.data.file, expect.any(String), 'utf8')
    expect(metricsOfType('inject')).toHaveLength(1)
  })

  it('tells the agent to LOAD memory via the MCP tools — the digest never goes inline', async () => {
    primer.buildContextPrimer.mockResolvedValueOnce('- [claude] the digest body')
    await invoke('memory:prepare-primer-file', { query: 'q', cwd: 'C:/repos/termpolis' })
    const instruction = writtenInstruction()
    expect(instruction).toContain('memory_primer')
    expect(instruction).toContain('memory_search')
    expect(instruction).toContain('(cwd "C:/repos/termpolis")')
    // The digest body must NOT be inlined into the system prompt (that's the whole design).
    expect(instruction).not.toContain('the digest body')
    // Background reference only — the agent must not resume or summarize past work unprompted.
    expect(instruction).toMatch(/background reference only/i)
    expect(instruction).toMatch(/do NOT resume past work/i)
    // Degrade gracefully where the MCP server isn't running.
    expect(instruction).toMatch(/unavailable, ignore this and proceed normally/i)
  })

  it('PINS the v1.25.3 compaction self-reprime: a compacted agent must re-call memory_primer', async () => {
    // The system prompt survives compaction; the loaded digest does not. Without this
    // sentence the agent quietly continues with its memory summarized away.
    primer.buildContextPrimer.mockResolvedValueOnce('- [claude] one')
    await invoke('memory:prepare-primer-file', { query: 'q' })
    const instruction = writtenInstruction()
    expect(instruction).toMatch(/compacted or summarized/i)
    expect(instruction).toMatch(/call memory_primer once more/i)
    expect(instruction).toMatch(/silently/i)
    // and it must not tell the agent to announce it / stop what it was doing
    expect(instruction).toMatch(/carry on with the task in hand/i)
  })

  it('omits the cwd hint entirely when launched without one', async () => {
    primer.buildContextPrimer.mockResolvedValueOnce('- [claude] one')
    await invoke('memory:prepare-primer-file', { query: 'q' })
    expect(writtenInstruction()).not.toContain('(cwd')
    expect(primer.buildContextPrimer).toHaveBeenCalledWith(mem.memorySearch, expect.objectContaining({ project: undefined }))
  })

  it('sweeps STALE primer files and leaves fresh ones alone', async () => {
    primer.buildContextPrimer.mockResolvedValueOnce('- [claude] one')
    fsMock.readdirSync.mockReturnValueOnce(['stale.txt', 'fresh.txt'] as any)
    const now = Date.now()
    fsMock.statSync.mockImplementation((p: any) => ({
      mtimeMs: String(p).includes('stale') ? now - 6 * 60_000 : now - 10_000,
      size: 0, isDirectory: () => false, isFile: () => true,
    }))
    await invoke('memory:prepare-primer-file', { query: 'q' })
    const unlinked = fsMock.unlinkSync.mock.calls.map((c) => String(c[0]))
    expect(unlinked).toHaveLength(1)
    expect(unlinked[0]).toContain('stale.txt')
  })

  it('keeps sweeping when one file cannot be stat-ed', async () => {
    primer.buildContextPrimer.mockResolvedValueOnce('- [claude] one')
    fsMock.readdirSync.mockReturnValueOnce(['ghost.txt', 'stale.txt'] as any)
    fsMock.statSync.mockImplementation((p: any) => {
      if (String(p).includes('ghost')) throw new Error('ENOENT')
      return { mtimeMs: Date.now() - 10 * 60_000, size: 0, isDirectory: () => false, isFile: () => true }
    })
    const r = await invoke('memory:prepare-primer-file', { query: 'q' })
    expect(fsMock.unlinkSync.mock.calls.map((c) => String(c[0]))[0]).toContain('stale.txt')
    expect(r.success).toBe(true)
  })

  it('still writes the primer when the sweep itself fails (an unreadable dir must not block a launch)', async () => {
    primer.buildContextPrimer.mockResolvedValueOnce('- [claude] one')
    fsMock.mkdirSync.mockImplementationOnce(() => { throw new Error('EEXIST') })
    fsMock.readdirSync.mockImplementationOnce(() => { throw new Error('EPERM') })
    const r = await invoke('memory:prepare-primer-file', { query: 'q' })
    expect(r.success).toBe(true)
    expect(r.data.count).toBe(1)
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1)
  })

  it('degrades to {success:false,error} when the primer file cannot be written', async () => {
    primer.buildContextPrimer.mockResolvedValueOnce('- [claude] one')
    fsMock.writeFileSync.mockImplementationOnce(() => { throw new Error('EROFS') })
    expect(await invoke('memory:prepare-primer-file', { query: 'q' })).toEqual({ success: false, error: 'EROFS' })
  })
})

// ===========================================================================
// memory:reflect-session — solo-session learning
// ===========================================================================
describe('memory:reflect-session', () => {
  it.each([
    ['terminalId', { cwd: '/r', agent: 'claude' }],
    ['cwd', { terminalId: 't1', agent: 'claude' }],
    ['agent', { terminalId: 't1', cwd: '/r' }],
  ])('does not fire when %s is missing', async (_missing, opts) => {
    const r = await invoke('memory:reflect-session', opts)
    expect(r).toEqual({ success: true, data: { fired: false, lessons: 0 } })
    expect(mneme.reflectSoloSession).not.toHaveBeenCalled()
  })

  it('reflects the session under the cwd\'s project slug and returns the result', async () => {
    const r = await invoke('memory:reflect-session', { terminalId: 't1', cwd: 'C:/repos/Termpolis', agent: 'claude' })
    expect(r).toEqual({ success: true, data: { fired: true, lessons: 2 } })
    expect(mneme.reflectSoloSession.mock.calls[0][0]).toEqual({
      terminalId: 't1', cwd: 'C:/repos/Termpolis', agent: 'claude', project: 'termpolis',
    })
  })

  it('reads the transcript through the live-transcript reader', async () => {
    await invoke('memory:reflect-session', { terminalId: 't1', cwd: '/r', agent: 'codex' })
    const deps = mneme.reflectSoloSession.mock.calls[0][1]
    expect(deps.readTranscript('/r', 'codex')).toEqual([{ role: 'user', text: 'hi' }])
    expect(mneme.readSessionTranscript).toHaveBeenCalledWith('/r', 'codex')
  })

  it('persists a per-terminal cursor so each pass only reflects the NEW turns', async () => {
    await invoke('memory:reflect-session', { terminalId: 't1', cwd: '/r', agent: 'claude' })
    const deps = mneme.reflectSoloSession.mock.calls[0][1]
    expect(deps.getCursor('term-cursor-1')).toBeUndefined()
    deps.setCursor('term-cursor-1', { count: 4, hash: 'abc' })
    expect(deps.getCursor('term-cursor-1')).toEqual({ count: 4, hash: 'abc' })
    expect(deps.getCursor('other-terminal')).toBeUndefined() // cursors are per-terminal
  })

  it('records a reflect metric only when lessons were actually distilled', async () => {
    await invoke('memory:reflect-session', { terminalId: 't1', cwd: '/r', agent: 'claude' })
    const deps = mneme.reflectSoloSession.mock.calls[0][1]

    expect(await deps.reflect({ id: 'ep1' })).toEqual({ fired: true, lessons: 2 })
    expect(metricsOfType('reflect')).toEqual([expect.objectContaining({ lessons: 2 })])

    ledger.recordMetric.mockClear()
    mneme.onSessionEpisode.mockResolvedValueOnce({ fired: true, lessons: 0, written: [] })
    expect(await deps.reflect({ id: 'ep2' })).toEqual({ fired: true, lessons: 0 })
    expect(metricsOfType('reflect')).toEqual([])

    ledger.recordMetric.mockClear()
    mneme.onSessionEpisode.mockResolvedValueOnce({ fired: false, lessons: 3, written: [] })
    expect(await deps.reflect({ id: 'ep3' })).toEqual({ fired: false, lessons: 3 })
    expect(metricsOfType('reflect')).toEqual([]) // didn't fire → nothing learned
  })

  it('wires the reflex deps to the real store, graph and code resolver', async () => {
    // v1.26: `link` is a SYNC void dep and memoryLink is a Promise now, so the reflector's edges are
    // COLLECTED during the pass and minted — awaited — after it returns. Calling link() in isolation
    // would therefore no longer prove the edge ever reaches the graph. Drive it through the planner,
    // which is the assertion that actually matters: by the time reflect() resolves, the edge is minted.
    mneme.onSessionEpisode.mockImplementationOnce(async (_ep: any, deps: any) => {
      deps.link('a', 'b', 'explains', 0.9)
      return { fired: true, lessons: 1 }
    })
    await invoke('memory:reflect-session', { terminalId: 't1', cwd: '/r', agent: 'claude' })
    await mneme.reflectSoloSession.mock.calls[0][1].reflect({ id: 'ep1' })
    expect(mem.memoryLink).toHaveBeenCalledWith({ from: 'a', to: 'b', relation: 'explains', weight: 0.9 })

    const reflexDeps = mneme.onSessionEpisode.mock.calls[0][1]

    await reflexDeps.distill({ id: 'ep1' })
    expect(mneme.distillEpisode).toHaveBeenCalledWith({ id: 'ep1' }, {}) // distiller OFF by default → no llm

    await reflexDeps.write({ agentId: 'a', kind: 'note', content: 'c' })
    expect(mem.memoryWrite).toHaveBeenCalledWith({ agentId: 'a', kind: 'note', content: 'c' })

    expect(reflexDeps.resolveCode(['foo'], '/repos/x')).toEqual([{ symbol: 'foo', file: 'a.ts' }])
    expect(cg.resolveCodeRefs).toHaveBeenCalledWith(['foo'], 'key:/repos/x')
    reflexDeps.resolveCode(['foo'])
    expect(cg.graphKeyForRoot).toHaveBeenLastCalledWith('') // no project → empty key, not undefined
    expect(reflexDeps.recordOutcome).toBe(mneme.recordOutcome)
  })

  it('mints an entity node for a named thing, scoped so the same name in two repos stays distinct', async () => {
    await invoke('memory:reflect-session', { terminalId: 't1', cwd: '/r', agent: 'claude' })
    await mneme.reflectSoloSession.mock.calls[0][1].reflect({ id: 'ep1' })
    const { ensureEntity } = mneme.onSessionEpisode.mock.calls[0][1]

    mem.memoryWrite.mockResolvedValueOnce({ id: 'ent-1' })
    expect(await ensureEntity('parseArgs', 'repo-a')).toBe('ent-1')
    expect(mem.memoryWrite).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'mneme', kind: 'fact', memoryType: 'entity', content: 'parseArgs',
      source: 'mneme', importance: 0.3, project: 'repo-a',
      hash: 'edh:parseArgs:pk:repo-a', // dedup hash scoped BY PROJECT KEY
    }))
  })

  it('mints an unscoped entity when no project is given, and skips blank names entirely', async () => {
    await invoke('memory:reflect-session', { terminalId: 't1', cwd: '/r', agent: 'claude' })
    await mneme.reflectSoloSession.mock.calls[0][1].reflect({ id: 'ep1' })
    const { ensureEntity } = mneme.onSessionEpisode.mock.calls[0][1]

    mem.memoryWrite.mockClear()
    mem.memoryWrite.mockResolvedValueOnce({ id: 'ent-2' })
    expect(await ensureEntity('  spaced  ')).toBe('ent-2')
    const arg = mem.memoryWrite.mock.calls[0][0]
    expect(arg.content).toBe('spaced') // trimmed
    expect(arg.hash).toBe('edh:spaced:') // no project → unscoped hash
    expect('project' in arg).toBe(false)

    mem.memoryWrite.mockClear()
    expect(await ensureEntity('   ')).toBeNull()
    expect(await ensureEntity('')).toBeNull()
    expect(mem.memoryWrite).not.toHaveBeenCalled() // a blank name must never mint a node
  })

  it('never breaks reflection when the entity write fails or returns nothing', async () => {
    await invoke('memory:reflect-session', { terminalId: 't1', cwd: '/r', agent: 'claude' })
    await mneme.reflectSoloSession.mock.calls[0][1].reflect({ id: 'ep1' })
    const { ensureEntity } = mneme.onSessionEpisode.mock.calls[0][1]

    mem.memoryWrite.mockRejectedValueOnce(new Error('store locked'))
    expect(await ensureEntity('foo')).toBeNull()

    mem.memoryWrite.mockResolvedValueOnce(undefined as any)
    expect(await ensureEntity('foo')).toBeNull()
  })

  it('degrades to {success:false,error} when reflection throws', async () => {
    mneme.reflectSoloSession.mockRejectedValueOnce(new Error('transcript unreadable'))
    const r = await invoke('memory:reflect-session', { terminalId: 't1', cwd: '/r', agent: 'claude' })
    expect(r).toEqual({ success: false, error: 'transcript unreadable' })
  })
})

// ===========================================================================
// MCP tool handlers — the memory_* / code_* tools the AGENTS call.
// (index.ts builds this handler object and hands it to startMcpServer.)
// ===========================================================================
describe('MCP memory tools', () => {
  it('memory_write returns the entry and records a successful write', async () => {
    mem.memoryWrite.mockResolvedValueOnce({ id: 'w1', memoryType: 'procedural' })
    const e = await mcp.memoryWrite({ agentId: 'claude', kind: 'lesson', content: 'c', tags: ['t'], taskId: 'k', project: 'p' })
    expect(e).toEqual({ id: 'w1', memoryType: 'procedural' })
    expect(mem.memoryWrite).toHaveBeenCalledWith({
      agentId: 'claude', kind: 'lesson', content: 'c', tags: ['t'], taskId: 'k', project: 'p',
    })
    expect(metricsOfType('write')).toEqual([expect.objectContaining({ ok: true, memoryType: 'procedural' })])
  })

  it('memory_write RETHROWS to the agent (never a silent success) and books the failure', async () => {
    mem.memoryWrite.mockRejectedValueOnce(new Error('store locked'))
    await expect(mcp.memoryWrite({ agentId: 'a', kind: 'note', content: 'c' })).rejects.toThrow('store locked')
    expect(metricsOfType('write')).toEqual([expect.objectContaining({ ok: false })])
  })

  it('memory_write defaults a missing kind to "note"', async () => {
    await mcp.memoryWrite({ agentId: 'a', content: 'c' })
    expect(mem.memoryWrite).toHaveBeenCalledWith(expect.objectContaining({ kind: 'note' }))
  })

  it('memory_search forwards the agent-facing gates (diversify + graph fusion)', async () => {
    mem.memorySearch.mockResolvedValueOnce([{ id: 's1', score: 0.7 }])
    const res = await mcp.memorySearch({ query: 'q', limit: 5, agentId: 'a', kind: 'lesson', taskId: 't', project: 'p', diversify: true, fuseGraph: true })
    expect(res).toEqual([{ id: 's1', score: 0.7 }])
    expect(mem.memorySearch).toHaveBeenCalledWith({
      query: 'q', limit: 5, agentId: 'a', kind: 'lesson', taskId: 't', project: 'p', diversify: true, fuseGraph: true,
    })
  })

  it('memory_search books the recall as a VECTOR path when the embedder is ready', async () => {
    mem.memorySearch.mockResolvedValueOnce([{ id: 's1', score: 0.7 }])
    await mcp.memorySearch({ query: 'q' })
    expect(metricsOfType('recall')).toEqual([expect.objectContaining({ path: 'vector', hits: 1, topScore: 0.7 })])
    expect(metricsOfType('embed')).toEqual([expect.objectContaining({ available: true })])
  })

  it('memory_search books it as a KEYWORD-path recall when the child embedder is down', async () => {
    mem.embeddingsReady.mockReturnValueOnce(false)
    mem.memorySearch.mockResolvedValueOnce([])
    await mcp.memorySearch({ query: 'q' })
    expect(metricsOfType('recall')).toEqual([expect.objectContaining({ path: 'keyword', hits: 0, topScore: 0 })])
    expect(metricsOfType('embed')).toEqual([expect.objectContaining({ available: false })])
  })

  // REGRESSION (v1.26.0 process split): the embedder moved into the memory utilityProcess, so main's
  // localEmbedder.isEmbedderReady() is ALWAYS false here. Reading it booked every agent recall as a
  // keyword fallback even while the child served a real semantic hit (cosine ~0.99) — the dashboard
  // then read "Embedding model: down — keyword fallback" over a perfectly working brain. The recall
  // path must reflect the CHILD's embedder, via the proxied embeddingsReady() the UI path already uses.
  it('memory_search trusts the child embedder, not main\'s always-false isEmbedderReady (post-split)', async () => {
    const { isEmbedderReady } = await import('../../src/main/localEmbedder')
    vi.mocked(isEmbedderReady).mockReturnValue(false) // the post-split reality inside main
    mem.embeddingsReady.mockReturnValue(true)          // the child actually has the model loaded
    mem.memorySearch.mockResolvedValueOnce([{ id: 's1', score: 0.994 }])
    await mcp.memorySearch({ query: 'q' })
    expect(metricsOfType('recall')).toEqual([expect.objectContaining({ path: 'vector' })])
    expect(metricsOfType('embed')).toEqual([expect.objectContaining({ available: true })])
    vi.mocked(isEmbedderReady).mockReturnValue(true)
  })

  it('memory_list forwards its filters', () => {
    expect(mcp.memoryList({ limit: 2, agentId: 'a', kind: 'note', since: 5 })).toEqual([{ id: 'l1' }])
    expect(mem.memoryList).toHaveBeenCalledWith({ limit: 2, agentId: 'a', kind: 'note', since: 5 })
  })

  it('memory_related and memory_graph forward their queries', () => {
    expect(mcp.memoryRelated({ id: 'm1', query: 'q', limit: 3 })).toEqual([{ id: 'r1' }])
    expect(mem.memoryRelated).toHaveBeenCalledWith({ id: 'm1', query: 'q', limit: 3 })

    expect(mcp.memoryGraph({ id: 'm1', query: 'q', relation: 'explains', depth: 2, limit: 9 })).toEqual({ nodes: [], edges: [] })
    expect(mem.memoryGraphQuery).toHaveBeenCalledWith({ id: 'm1', query: 'q', relation: 'explains', depth: 2, limit: 9 })
  })

  it('memory_link STAMPS the edge as agent-authored', () => {
    mcp.memoryLink({ from: 'a', to: 'b', relation: 'explains' })
    expect(mem.memoryLink).toHaveBeenCalledWith({ from: 'a', to: 'b', relation: 'explains', createdBy: 'agent' })
  })
})

describe('MCP memory_primer', () => {
  it('leads with the cwd project and asks for a bigger snippet than the launch primer', async () => {
    primer.buildContextPrimer.mockResolvedValueOnce('- [claude] digest')
    mneme.competenceSummary.mockReturnValueOnce('')
    mneme.curiosityPrompts.mockReturnValueOnce([])
    mneme.identitySummary.mockReturnValueOnce('')
    const out = await mcp.memoryPrimer({ query: 'what now', cwd: 'C:/repos/Termpolis', limit: 6 })
    expect(out).toEqual({ project: 'termpolis', primer: '- [claude] digest' })
    expect(primer.buildContextPrimer).toHaveBeenCalledWith(mem.memorySearch, {
      query: 'what now', limit: 6, maxSnippetChars: 600, project: 'termpolis', projectPath: 'C:/repos/Termpolis',
    })
  })

  it('synthesizes a project-scoped query when the agent supplies none', async () => {
    mneme.competenceSummary.mockReturnValueOnce('')
    mneme.curiosityPrompts.mockReturnValueOnce([])
    mneme.identitySummary.mockReturnValueOnce('')
    await mcp.memoryPrimer({ query: '   ', cwd: '/repos/termpolis' })
    expect(primer.buildContextPrimer).toHaveBeenCalledWith(mem.memorySearch, expect.objectContaining({
      query: 'recent work, decisions, conventions, and context for termpolis',
      limit: 10, // falls back to the persisted primer limit
    }))
  })

  it('falls back to a global query — and a null project — with no cwd at all', async () => {
    mneme.competenceSummary.mockReturnValueOnce('')
    mneme.curiosityPrompts.mockReturnValueOnce([])
    mneme.identitySummary.mockReturnValueOnce('')
    const out = await mcp.memoryPrimer({})
    expect(out.project).toBeNull()
    expect(primer.buildContextPrimer).toHaveBeenCalledWith(mem.memorySearch, expect.objectContaining({
      query: 'recent work, key decisions, and conventions',
      project: undefined, projectPath: undefined,
    }))
  })

  it('augments the digest with the brain\'s self-competence, open questions and identity', async () => {
    primer.buildContextPrimer.mockResolvedValueOnce('- [claude] digest')
    const records = [{ domain: 'd', attempts: 2, confidence: 0.3 }]
    mneme.competenceRecords.mockReturnValueOnce(records)
    const out = await mcp.memoryPrimer({ query: 'q', cwd: '/repos/x' })

    expect(out.primer).toContain('- [claude] digest')
    expect(out.primer).toContain('weak at flaky tests')
    expect(out.primer).toContain('what breaks CI?')
    expect(out.primer).toContain('I am the termpolis brain')
    expect(mneme.competenceSummary).toHaveBeenCalledWith(3)
    expect(mneme.findGaps).toHaveBeenCalledWith(records)
    expect(mneme.curiosityPrompts).toHaveBeenCalledWith([{ domain: 'gap' }], 2)
    expect(metricsOfType('inject')).toEqual([expect.objectContaining({ tokens: Math.ceil(out.primer.length / 4) })])
  })

  it('returns a null primer — and injects nothing — when the brain knows nothing yet', async () => {
    primer.buildContextPrimer.mockResolvedValueOnce(null)
    mneme.competenceSummary.mockReturnValueOnce('')
    mneme.curiosityPrompts.mockReturnValueOnce([])
    mneme.identitySummary.mockReturnValueOnce('')
    const out = await mcp.memoryPrimer({ query: 'q' })
    expect(out).toEqual({ project: null, primer: null })
    expect(metricsOfType('inject')).toEqual([])
  })
})

describe('MCP memory_feedback', () => {
  it('treats an unspecified verdict as helpful', async () => {
    await mcp.memoryFeedback({ id: 'm1', query: 'q' })
    expect(metricsOfType('feedback')).toEqual([expect.objectContaining({ helpful: true })])
    expect(mem.memoryFeedback).toHaveBeenCalledWith({ id: 'm1', helpful: undefined, query: 'q' })
  })

  // memorySourceById is an RPC now, so the author must be AWAITED. Un-awaited it is a Promise —
  // never === the reader's agentId — so every single feedback would book a cross-agent recall with
  // "[object Promise]" as the teaching agent. These three pin that in both directions.
  it('books CROSS-AGENT reuse when a helpful memory was authored by a DIFFERENT agent', async () => {
    mem.memorySourceById.mockResolvedValueOnce('claude')
    await mcp.memoryFeedback({ id: 'm1', helpful: true, agentId: 'codex' })
    expect(metricsOfType('cross_recall')).toEqual([expect.objectContaining({ author: 'claude', reader: 'codex' })])
  })

  it('does NOT book cross-agent reuse for an agent recalling its own memory', async () => {
    mem.memorySourceById.mockResolvedValueOnce('codex')
    await mcp.memoryFeedback({ id: 'm1', helpful: true, agentId: 'codex' })
    expect(metricsOfType('cross_recall')).toEqual([])
  })

  it('does NOT book cross-agent reuse for an unhelpful memory, or an unknown author', async () => {
    await mcp.memoryFeedback({ id: 'm1', helpful: false, agentId: 'codex' })
    expect(metricsOfType('feedback')).toEqual([expect.objectContaining({ helpful: false })])
    expect(metricsOfType('cross_recall')).toEqual([])
    expect(mem.memorySourceById).not.toHaveBeenCalled() // not even looked up

    mem.memorySourceById.mockResolvedValueOnce(undefined as any)
    await mcp.memoryFeedback({ id: 'm1', helpful: true, agentId: 'codex' })
    expect(metricsOfType('cross_recall')).toEqual([])
  })

  it('records the feedback even when the metrics ledger throws', async () => {
    ledger.recordMetric.mockImplementationOnce(() => { throw new Error('ledger down') })
    await expect(mcp.memoryFeedback({ id: 'm1', helpful: true })).resolves.toEqual({ ok: true })
    expect(mem.memoryFeedback).toHaveBeenCalled()
  })
})

describe('MCP memory_selfcheck / memory_pool / memory_conflicts', () => {
  it('selfcheck merges the domain assessment with the overall summary', () => {
    expect(mcp.memorySelfcheck({ domain: 'termpolis' })).toEqual({
      domain: 'termpolis', confidence: 0.4, summary: 'weak at flaky tests',
    })
    expect(mneme.assessCompetence).toHaveBeenCalledWith('termpolis')
  })

  it('pool draws on the LESSONS window (default 200) and labels an unattributable lesson "unknown"', async () => {
    // poolLessons takes an ARRAY — .map() on an un-awaited memoryLessons() would throw.
    mem.memoryLessons.mockResolvedValueOnce([
      { source: 'claude', content: 'a', memoryType: 'procedural', importance: 0.9 },
      { agentId: 'codex', content: 'b', memoryType: 'semantic', importance: 0.5 },
      { content: 'c' },
    ])
    await expect(mcp.memoryPool({})).resolves.toEqual([{ content: 'pooled', corroboration: 2 }])
    expect(mem.memoryLessons).toHaveBeenCalledWith(200)
    expect(mneme.poolLessons).toHaveBeenCalledWith([
      { source: 'claude', content: 'a', memoryType: 'procedural', importance: 0.9 },
      { source: 'codex', content: 'b', memoryType: 'semantic', importance: 0.5 },
      { source: 'unknown', content: 'c', memoryType: undefined, importance: undefined },
    ])
  })

  it('pool honours an explicit window size', async () => {
    await mcp.memoryPool({ limit: 25 })
    expect(mem.memoryLessons).toHaveBeenCalledWith(25)
  })

  it('conflicts returns only the two contradicting sides — read-only, nothing else leaks', async () => {
    mem.memoryLessons.mockResolvedValueOnce([{ source: 'claude', content: 'always X' }])
    const out = await mcp.memoryConflicts({})
    expect(out).toEqual([{ a: { source: 'claude', content: 'always X' }, b: { source: 'codex', content: 'never X' } }])
    expect(mem.memoryLessons).toHaveBeenCalledWith(200)
    expect(mneme.detectConflictsNli).toHaveBeenCalledWith([{ source: 'claude', content: 'always X' }])
  })
})

describe('MCP memory_anticipate', () => {
  it('returns nothing when the task text carries no usable signal — never a blind top-N', async () => {
    mneme.proactiveQuery.mockReturnValueOnce('')
    expect(await mcp.memoryAnticipate({ task: 'uh' })).toEqual([])
    expect(mem.memorySearch).not.toHaveBeenCalled()
  })

  it('over-fetches, then keeps only procedural or high-importance memories, capped at the limit', async () => {
    mem.memorySearch.mockResolvedValueOnce([
      { id: 'p', memoryType: 'procedural', importance: 0 },   // kept: procedural
      { id: 'h', memoryType: 'semantic', importance: 0.6 },   // kept: important enough
      { id: 'l', memoryType: 'semantic', importance: 0.59 },  // dropped: below the bar
      { id: 'u', memoryType: 'semantic' },                    // dropped: no importance at all
    ])
    const out = await mcp.memoryAnticipate({ task: 'fix the flaky test', limit: 2 })
    expect(out.map((m: any) => m.id)).toEqual(['p', 'h'])
    // the over-fetch (limit * 8) is what stops a just-below-top-N lesson being a false negative
    expect(mem.memorySearch).toHaveBeenCalledWith({ query: 'signals:fix the flaky test', limit: 16 })
  })

  it('defaults the limit to 5 (over-fetching 40) and truncates to it', async () => {
    mem.memorySearch.mockResolvedValueOnce(
      Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, memoryType: 'procedural' })),
    )
    const out = await mcp.memoryAnticipate({ task: 'x' })
    expect(out).toHaveLength(5)
    expect(mem.memorySearch).toHaveBeenCalledWith({ query: 'signals:x', limit: 40 })
  })

  it('handles an entirely missing task string', async () => {
    mneme.proactiveQuery.mockReturnValueOnce('')
    expect(await mcp.memoryAnticipate({})).toEqual([])
    expect(mneme.proactiveQuery).toHaveBeenCalledWith('')
  })
})

describe('MCP code_* tools', () => {
  it('explore / callers / callees / impact forward the symbol straight to the graph', () => {
    expect(mcp.codeExplore({ query: 'parse' })).toEqual({ symbols: [] })
    expect(cg.codeExplore).toHaveBeenCalledWith('parse')
    expect(mcp.codeCallers({ name: 'foo' })).toEqual([{ name: 'caller' }])
    expect(cg.codeCallers).toHaveBeenCalledWith('foo')
    expect(mcp.codeCallees({ name: 'foo' })).toEqual([{ name: 'callee' }])
    expect(cg.codeCallees).toHaveBeenCalledWith('foo')
    expect(mcp.codeImpact({ name: 'foo' })).toEqual([{ name: 'a' }, { name: 'b' }])
    expect(cg.codeImpact).toHaveBeenCalledWith('foo')
  })

  it('code_search defaults the limit to 50', () => {
    expect(mcp.codeSearch({ query: 'foo' })).toEqual([{ name: 'sym' }])
    expect(cg.codeSymbols).toHaveBeenCalledWith('foo', 50)
    mcp.codeSearch({ query: 'foo', limit: 5 })
    expect(cg.codeSymbols).toHaveBeenLastCalledWith('foo', 5)
  })

  it('code_locate runs UNSCOPED for agents (no project key) and honours the limit', async () => {
    await expect(mcp.codeLocate({ issue: 'crash', limit: 4 })).resolves.toEqual([{ file: 'a.ts', score: 1, why: [] }])
    const [issue, , opts] = mneme.codeLocate.mock.calls[0]
    expect(issue).toBe('crash')
    expect(opts).toEqual({ limit: 4 })
    // an agent's locate is cross-repo: resolveToken must be called with an undefined key
    mneme.codeLocate.mock.calls[0][1].resolve('foo')
    expect(cg.resolveToken).toHaveBeenCalledWith('foo', undefined)
  })
})

// ===========================================================================
// The idle indexer — how the brain feeds itself. index.ts owns these closures.
// ===========================================================================
describe('memory indexer passes', () => {
  const indexerOpts = () => indexer

  it('the full pass: pulls synced shards, ingests, persists the ANN index, then consolidates + weaves', async () => {
    const out = await indexerOpts().run()
    expect(out).toEqual({ written: 4, more: false })
    expect(mem.reloadMemoryFromSync).toHaveBeenCalled()
    expect(mneme.runConversationIngest).toHaveBeenCalledWith(expect.anything(), { maxChunks: 250 })
    expect(mem.persistMemoryIndex).toHaveBeenCalled()
    expect(mneme.runConsolidation).toHaveBeenCalled()
    expect(mneme.runSummarization).toHaveBeenCalled()
    expect(mneme.runWeave).toHaveBeenCalled()
    expect(mneme.auditMemory).toHaveBeenCalledWith(expect.objectContaining({ event: 'learn', kind: 'consolidate' }))
  })

  // v1.26 — THE PLANNER CONTRACT. runConsolidation and runWeave are SYNC and runSummarization hands
  // its deps to a sync planMerges: they call candidates()/simOf()/neighbours() and use the result
  // IMMEDIATELY. Every store call is a Promise now, so the deps handed to them must be sync closures
  // over ALREADY-RESOLVED data, and their side-effects (forget / link / backfill) must be COLLECTED
  // and applied afterwards. These assert both halves: the planner sees plain values, and the
  // decisions it makes actually land in the store.
  it('consolidation ARCHIVES cold memories — it must never hard-delete them', async () => {
    // The mocked planner stands in for the real one: it decides to forget c1, exactly where the real
    // runConsolidation would. That decision must reach memoryArchive — and never memoryDelete.
    mneme.runConsolidation.mockImplementationOnce((deps: any) => {
      expect(Array.isArray(deps.candidates())).toBe(true) // NOT a Promise
      expect(deps.candidates()).toEqual([{ id: 'c1' }])
      expect(deps.simOf()).toBe(0) // decay-only on the scheduled pass; merge is on-demand
      deps.forget('c1')
      return { mergedDuplicates: 0, decayedCold: 1 }
    })
    mneme.runSummarization.mockImplementationOnce(async (deps: any) => {
      expect(deps.candidates()).toEqual([{ id: 'c1' }]) // NOT a Promise
      expect(typeof deps.simOf).toBe('function')
      expect(deps.simOf({ id: 'c1' }, { id: 'c1' })).toBe(0.9) // a real NUMBER, not a Promise
      await deps.write({ agentId: 'a', kind: 'note', content: 'c' })
      deps.link('a', 'b', 'summarizes')
      return { summarized: 1 }
    })
    await indexerOpts().run()

    expect(mem.consolidationCandidates).toHaveBeenCalledWith(500)
    expect(mem.memoryArchive).toHaveBeenCalledWith('c1') // v1.23 C6: archive...
    expect(mem.memoryDelete).not.toHaveBeenCalled()      // ...never tombstone

    // The summariser's limit must match the matrix's, or the comparator would not know the entries
    // it is asked about (and would silently score them 0).
    expect(mem.consolidationCandidates).toHaveBeenCalledWith(200)
    expect(mem.consolidationSimOf).toHaveBeenCalledWith(200)
    expect(mem.memoryWrite).toHaveBeenCalledWith({ agentId: 'a', kind: 'note', content: 'c' })
    expect(mem.memoryLink).toHaveBeenCalledWith({ from: 'a', to: 'b', relation: 'summarizes', createdBy: 'consolidate' })
  })

  it('the weave draws bounded cross-repo analogies and backfills code anchors', async () => {
    mneme.runWeave.mockImplementationOnce((deps: any, opts: any) => {
      expect(opts).toEqual({ maxPerPass: 200, neighbourK: 6 })
      expect(deps.candidates()).toEqual([{ id: 'w1' }])              // NOT a Promise
      expect(deps.neighbours('w1')).toEqual([{ id: 'w2', score: 0.9 }]) // pre-fetched, sync
      expect(deps.neighbours('unknown-id')).toEqual([])              // an unseen id is [], never undefined
      expect(deps.resolveCode(['foo'], 'pk')).toEqual([{ symbol: 'foo', file: 'a.ts' }]) // code graph: still sync, still in main
      deps.link('a', 'b', 'analogous', 0.4)
      deps.backfillCodeRefs('m1', [{ symbol: 'foo' }])
      return { considered: 1, bridged: 1, codeAnalogies: 1, knowledgeAnalogies: 0, explains: 0, minted: 1 }
    })
    await indexerOpts().run()

    expect(mem.weaveCandidates).toHaveBeenCalledWith(300)
    // ONE batched neighbour call for the whole candidate set — not 300 round trips from inside the loop.
    expect(mem.weaveNeighboursBatch).toHaveBeenCalledWith(['w1'], 6)
    expect(mem.weaveNeighbours).not.toHaveBeenCalled()
    expect(cg.resolveCodeRefs).toHaveBeenCalledWith(['foo'], 'pk')
    // The deferred effects really are applied.
    expect(mem.memoryLink).toHaveBeenCalledWith({ from: 'a', to: 'b', relation: 'analogous', weight: 0.4, createdBy: 'weave' })
    expect(mem.backfillCodeRefs).toHaveBeenCalledWith('m1', [{ symbol: 'foo' }])
  })

  it('a consolidation or weave failure never loses the ingest that already succeeded', async () => {
    mneme.runConsolidation.mockImplementationOnce(() => { throw new Error('consolidation exploded') })
    mneme.runWeave.mockImplementationOnce(() => { throw new Error('weave exploded') })
    mem.reloadMemoryFromSync.mockImplementationOnce(() => { throw new Error('sync dir gone') })
    mem.persistMemoryIndex.mockImplementationOnce(() => { throw new Error('hnsw locked') })
    mneme.runConversationIngest.mockResolvedValueOnce({ chunksWritten: 9, truncated: true })
    await expect(indexerOpts().run()).resolves.toEqual({ written: 9, more: true })
  })

  it('the FAST pass re-reads only the ACTIVE session, and emits only SEALED chunks', async () => {
    expect(indexerOpts().fastIntervalMs).toBe(90_000)
    const out = await indexerOpts().fastRun()
    expect(out).toEqual({ written: 4, more: false })
    const [, opts] = mneme.runConversationIngest.mock.calls[0]
    expect(opts.maxChunks).toBe(250)
    expect(opts.chunkOptions).toEqual({ sealedOnly: true }) // a growing partial must not deposit a dup every 90s
    expect(opts.freshSinceTs).toBeGreaterThan(Date.now() - 11 * 60_000)
    expect(opts.freshSinceTs).toBeLessThanOrEqual(Date.now() - 10 * 60_000 + 1000)
    expect(mem.persistMemoryIndex).toHaveBeenCalled()
  })

  it('both passes stamp ingest-authored edges', async () => {
    await indexerOpts().run()
    mneme.runConversationIngest.mock.calls[0][0].link('a', 'b', 'follows', 0.2, 7)
    expect(mem.memoryLink).toHaveBeenCalledWith({ from: 'a', to: 'b', relation: 'follows', weight: 0.2, ts: 7, createdBy: 'ingest' })

    mem.memoryLink.mockClear()
    await indexerOpts().fastRun()
    mneme.runConversationIngest.mock.calls[1][0].link('c', 'd', 'follows', 0.3, 8)
    expect(mem.memoryLink).toHaveBeenCalledWith({ from: 'c', to: 'd', relation: 'follows', weight: 0.3, ts: 8, createdBy: 'ingest' })
  })
})

// ===========================================================================
// Auto-ingest of the live agent event feed into shared memory.
// ===========================================================================
describe('agent-event auto-ingest into memory', () => {
  const feed = (event: any) => eventFeed(event)

  it('writes a swarm message into memory, tagged with the agent that sent it', () => {
    feed({ kind: 'message', summary: 'found the bug', terminalId: 't1', agentType: 'claude', taskId: 'task-9' })
    expect(mem.memoryWrite).toHaveBeenCalledWith({
      agentId: 't1', kind: 'message', content: 'found the bug', tags: ['claude'], taskId: 'task-9',
    })
    expect(mockWebContents.send).toHaveBeenCalledWith('agentActivity:event', expect.objectContaining({ kind: 'message' }))
  })

  it('writes a tool_result as a "result" memory and omits an absent taskId key entirely', () => {
    feed({ kind: 'tool_result', summary: 'tests pass', agentType: 'codex' })
    const arg = mem.memoryWrite.mock.calls[0][0]
    expect(arg).toMatchObject({ agentId: 'codex', kind: 'result', content: 'tests pass', tags: ['codex'] })
    expect('taskId' in arg).toBe(false)
  })

  it('falls back to "unknown" when the event names no terminal or agent', () => {
    feed({ kind: 'message', summary: 's' })
    expect(mem.memoryWrite).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'unknown', tags: [] }))
  })

  it('ingests NOTHING for other event kinds, or a summary-less event', () => {
    feed({ kind: 'tool_call', summary: 'ran ls', terminalId: 't1' })
    feed({ kind: 'message', terminalId: 't1' })
    expect(mem.memoryWrite).not.toHaveBeenCalled()
  })

  it('survives a rejected memory write — the live feed must never throw', () => {
    mem.memoryWrite.mockRejectedValueOnce(new Error('store locked'))
    expect(() => feed({ kind: 'message', summary: 's', terminalId: 't1' })).not.toThrow()
  })
})

// --------------------------------------------------------------------------------------------
// Vector RAM + the int8 quantization toggle.
//
// v1.25.16 deleted this IPC along with the tiles it fed. That was half right. The tiles carried live
// PROCESS HEALTH — RSS, heap, GC pauses, event-loop percentiles — polled every 2 s off the thread
// that echoes the user's keystrokes, and they had to go. But the toggle's own numbers never needed
// any of that: `vectorRamStats()` multiplies a row count by a dimension. So the read is back, with
// the health stripped out, and the handler's job is now exactly one thing — hand the renderer enough
// to make an INFORMED choice, including the choice to leave it alone.
// --------------------------------------------------------------------------------------------
describe('memory:get-vector-ram', () => {
  it('returns live vector stats and the persisted choice', async () => {
    const res = await invoke('memory:get-vector-ram')
    expect(res.success).toBe(true)
    expect(res.data.vectors).toBe(1000)
    expect(res.data.dim).toBe(384)
    expect(res.data.quantized).toBe(false)
    expect(res.data.ramBytes).toBe(1000 * 384 * 4)
    expect(res.data.ramBytesFloat).toBe(1000 * 384 * 4)
    expect(res.data.ramBytesInt8).toBe(1000 * 384)
    expect(res.data.persisted).toBe(false)
  })

  // The whole point of the v1.25.16 amputation. A read the UI performs on tab-open must not drag
  // the state of the process off the thread that is trying to echo keystrokes.
  it('carries NO process health — no RSS, no heap, no GC, no event-loop percentiles', async () => {
    const res = await invoke('memory:get-vector-ram')
    expect(res.data.health).toBeUndefined()
    expect(Object.keys(res.data).sort()).toEqual(
      ['dim', 'persisted', 'quantized', 'ramBytes', 'ramBytesFloat', 'ramBytesInt8', 'vectors'],
    )
  })

  it('reports the error instead of throwing when the store cannot be read', async () => {
    mem.vectorRamStats.mockImplementationOnce(() => { throw new Error('store gone') })
    const res = await invoke('memory:get-vector-ram')
    expect(res).toEqual({ success: false, error: 'store gone' })
  })
})

describe('memory:set-vector-quantize', () => {
  // The persisted setting is REAL here (memorySettings is not mocked), and memory:set-primer-limit
  // asserts on the whole settings object — so put it back the way we found it.
  afterEach(async () => { await invoke('memory:set-vector-quantize', { value: false }) })

  it('turning it ON persists the choice AND rebuilds the packed store', async () => {
    const res = await invoke('memory:set-vector-quantize', { value: true })
    expect(res.success).toBe(true)
    expect(mem.setVectorQuantization).toHaveBeenCalledWith(true) // the store was actually rebuilt
    expect(res.data.quantized).toBe(true)
    expect(res.data.persisted).toBe(true)                        // …and the choice will survive restart
    expect(res.data.ramBytes).toBe(1000 * 384)                   // 1 B/component
  })

  it('the persisted choice is what the NEXT read reports', async () => {
    await invoke('memory:set-vector-quantize', { value: true })
    expect((await invoke('memory:get-vector-ram')).data.persisted).toBe(true)
  })

  it('turning it OFF restores exact floats — the de-implement path', async () => {
    await invoke('memory:set-vector-quantize', { value: true })
    const res = await invoke('memory:set-vector-quantize', { value: false })
    expect(mem.setVectorQuantization).toHaveBeenLastCalledWith(false)
    expect(res.data.quantized).toBe(false)
    expect(res.data.persisted).toBe(false)
    expect(res.data.ramBytes).toBe(1000 * 384 * 4) // back to 4 B/component
  })

  it('only a literal true enables it — junk must not silently quantize the brain', async () => {
    for (const junk of [undefined, null, 0, '', 'true', 1, {}]) {
      mem.setVectorQuantization.mockClear()
      await invoke('memory:set-vector-quantize', { value: junk as never })
      expect(mem.setVectorQuantization).toHaveBeenCalledWith(false)
    }
    await invoke('memory:set-vector-quantize')  // no args at all
    expect(mem.setVectorQuantization).toHaveBeenLastCalledWith(false)
  })

  it('reports a rebuild failure rather than lying that it worked', async () => {
    mem.setVectorQuantization.mockImplementationOnce(() => { throw new Error('rebuild failed') })
    const res = await invoke('memory:set-vector-quantize', { value: true })
    expect(res).toEqual({ success: false, error: 'rebuild failed' })
  })
})

// The freeze history is a different animal and it stays dead. Its detector named each stall by
// harvesting a V8 CPU profile ON THE MAIN THREAD — a ~1 s block at a 1.1 GB heap — from the very
// watchdog that reacted to blocking. See tests/electron/noMainThreadInstruments.test.ts.
it('never exposes the freeze-history IPC again', () => {
  expect(ipcHandlers.has('memory:get-stalls')).toBe(false)
})
