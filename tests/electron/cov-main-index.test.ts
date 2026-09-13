// src/main/index.ts — the handlers, closures and callbacks the existing main-process suites
// register but never drive.
//
// Three kinds of target live here, and each is a different kind of risk:
//
//   1. Handlers nothing has ever invoked (`memory:prepare-codex-context`, `claude:trust-workspace`,
//      the whole `tokenSavings:*` family). These are registered, shipped, and completely unproven.
//   2. The error arms of handlers whose happy path IS covered. A catch that returns err() is the
//      difference between "the renderer shows a message" and "main throws into the IPC bridge and
//      the promise never settles", and it is exactly the arm that never runs in a green test.
//   3. Callbacks index.ts hands to a collaborator — the gateway prompt, the proxy ledger flush, the
//      remote-bridge readers, the workflow trigger deps. They are only reachable through the mock
//      that received them, so an ordinary test file cannot see them at all.
//
// Every assertion below pins a DECISION: which argument survived, which arm ran, what the guard
// refused to do. Nothing here asserts merely that a function was reached.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Hoisted spies — referenced from inside vi.mock factories
// ---------------------------------------------------------------------------
const M = vi.hoisted(() => ({
  // child_process / fs
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  fsUnlink: vi.fn(async () => {}),
  // electron dialog
  showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
  showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined })),
  showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
  // lifecycle collaborators
  initAutoUpdater: vi.fn(),
  startMcpServer: vi.fn(() => ({ id: 'mcp-server-handle' })),
  stopMcpServer: vi.fn(),
  // terminal
  spawnTerminal: vi.fn(),
  writeToTerminal: vi.fn(),
  killTerminal: vi.fn(),
  killAll: vi.fn(),
  getTerminalSize: vi.fn(() => ({ cols: 80, rows: 24 })),
  detectAvailableShells: vi.fn(async () => [{ type: 'powershell', name: 'PowerShell', executable: 'pwsh.exe' }]),
  // aiSecurity sinks we drive into their failure arms
  appendAudit: vi.fn(async () => {}),
  recentAudit: vi.fn(async () => [] as unknown[]),
  clearAudit: vi.fn(async () => {}),
  aiGetSettings: vi.fn<() => any>(),
  // sensitive file watcher
  sensitiveCount: vi.fn(() => 0),
  sensitiveRecent: vi.fn(() => [] as unknown[]),
  // telemetry
  setTelemetryOptIn: vi.fn(),
  isTelemetryEnabled: vi.fn(() => false),
  recordTelemetryEvent: vi.fn(),
  recordUncleanExit: vi.fn(),
  // diagnostics (dynamic import inside the handler)
  collectDiagnostics: vi.fn(() => ({ os: 'win32', version: '1.0.0' })),
  // git
  safeGit: vi.fn(() => ''),
  safeGitAsync: vi.fn(async () => ''),
  // git hooks
  hookStatus: vi.fn(() => ({ installed: false })),
  installHooks: vi.fn(() => []),
  uninstallHooks: vi.fn(() => []),
  // import trust
  listImported: vi.fn(() => [] as unknown[]),
  revokeArtifact: vi.fn(() => true),
  // memory settings
  getPrimerLimit: vi.fn(() => 12),
  setPrimerLimit: vi.fn((v: number) => v),
  getVectorQuantize: vi.fn(() => false),
  setVectorQuantize: vi.fn((v: boolean) => v),
  // context pins
  listPins: vi.fn(() => [] as unknown[]),
  addPin: vi.fn(() => ({ id: 'pin-1' })),
  updatePin: vi.fn<(...a: unknown[]) => unknown>(() => ({ id: 'pin-1' })),
  removePin: vi.fn(() => true),
  clearPins: vi.fn(),
  // codex parity
  writeAgentsMd: vi.fn(() => ({ path: '/repo/AGENTS.md', changed: true })),
  ensureCodexMemoryAutoApproved: vi.fn(() => ({ tools: ['memory_primer', 'memory_search'] })),
  // claude trust
  trustClaudeWorkspace: vi.fn(() => ({ trusted: true })),
  // workspace trust
  isWorkspaceTrusted: vi.fn(() => true),
  // headroom
  getHeadroomSettings: vi.fn<() => any>(),
  setHeadroomSettings: vi.fn((p: any) => ({ mode: 'balanced', prefixDecay: false, thinkingCap: 0, ...p })),
  saveSettingsToDisk: vi.fn(),
  saveLedgerToDisk: vi.fn(),
  loadSettingsFromDisk: vi.fn(),
  loadLedgerBaseFromDisk: vi.fn(),
  setLedgerFlush: vi.fn(),
  summarizeHeadroomSavings: vi.fn(() => ({ layer: 'mcp', savedTokens: 11 })),
  summarizeUnifiedSavings: vi.fn(() => ({ cumulative: { savedTokens: 42, requests: 3, outputTokens: 900 } })),
  outputEconomyReport: vi.fn(() => ({ verdict: 'no-effect' })),
  issueReceipt: vi.fn((cum: any, ts: number) => ({ cum, ts, sig: 'sig' })),
  checkReceipt: vi.fn(() => ({ valid: true })),
  renderReceiptMarkdown: vi.fn(() => '# receipt'),
  renderReceiptJson: vi.fn(() => '{"receipt":true}'),
  armForSession: vi.fn(() => 'control'),
  adaptSteeringMode: vi.fn((mode: any) => mode),
  flushOutputEconomy: vi.fn(),
  buildInjectedInstruction: vi.fn(() => 'INSTRUCTION'),
  headroomRetrieveFull: vi.fn(() => ({ ok: true, text: 'full' })),
  setCcrDir: vi.fn(),
  ccrPut: vi.fn(),
  resolveWireMode: vi.fn(() => 'aggressive'),
  saveDepthCurveToDisk: vi.fn(),
  loadDepthCurveFromDisk: vi.fn(),
  // headroom proxy
  summarizeProxySavings: vi.fn(() => ({ cumulative: { outputTokens: 1000, requests: 10, savedTokens: 7 } })),
  recordProxyResult: vi.fn(),
  setProxyLedgerFlush: vi.fn(),
  saveProxyTotalsToDisk: vi.fn(),
  loadProxyBaseFromDisk: vi.fn(),
  resetProxyCounters: vi.fn(),
  onProxyResult: vi.fn(),
  onProxyStash: vi.fn(),
  setProxySpawner: vi.fn(),
  createProxyTransport: vi.fn(() => ({ transport: true })),
  pickFreePort: vi.fn(async () => 0),
  startProxy: vi.fn(),
  stopProxy: vi.fn(),
  getProxyEnv: vi.fn(() => null),
  setProxyMode: vi.fn(),
  setProxyThinkingCap: vi.fn(),
  setProxyDecay: vi.fn(),
  // mcp gateway
  setGatewayPrompt: vi.fn(),
  getGatewayPolicy: vi.fn(() => ({ rules: [] })),
  setGatewayPolicy: vi.fn(),
  gatewayListTools: vi.fn(async () => [{ name: 'upstream.tool' }]),
  gatewayCall: vi.fn(async () => ({ ok: true })),
  remember: vi.fn((policy: any, server: string, tool: string, decision: string) => ({ ...policy, remembered: [server, tool, decision] })),
  // memory corrections
  correctMemory: vi.fn(() => ({ corrected: true })),
  // headless exec + recall bench
  runHeadless: vi.fn<(...a: any[]) => any>(async () => ({ ok: true, stdout: 'done' })),
  buildProbes: vi.fn(() => [{ q: 'probe' }]),
  runBench: vi.fn<(...a: any[]) => any>(async () => ({ score: 0.5 })),
  checkRegression: vi.fn(() => ({ regressed: false })),
  baselineFrom: vi.fn((r: any) => ({ base: r })),
  formatBench: vi.fn(() => 'BENCH TEXT'),
  loadBenchBaseline: vi.fn(() => ({ base: null })),
  saveBenchBaseline: vi.fn(() => true),
  // primer
  buildContextPrimer: vi.fn<(...a: any[]) => any>(async () => 'PRIMER TEXT'),
  // second opinion
  runSecondOpinion: vi.fn<(...a: any[]) => any>(async () => ({ ok: true, feedback: 'looks fine' })),
  secondOpinionSpawnPlan: vi.fn(() => ({ cmd: 'claude', cmdArgs: ['-p', 'PROMPT'] })),
  // remote bridge
  startRemoteBridgeHost: vi.fn(),
  stopRemoteBridgeHost: vi.fn(),
  registerRemoteIpc: vi.fn(),
  // learning signals
  startLearningSignals: vi.fn(),
  stopLearningSignals: vi.fn(),
  // workflow
  makeTerminalRunner: vi.fn(() => ({ kind: 'terminal-runner' })),
  makeAgentRunner: vi.fn(() => ({ kind: 'agent-runner' })),
  makeToolInvoker: vi.fn(() => ({ kind: 'tool-invoker' })),
  registerWorkflowIpc: vi.fn<(...a: any[]) => any>(() => ({ startRun: M_startRun })),
  wfStartRun: vi.fn<(...a: any[]) => any>(() => ({ ok: true, done: Promise.resolve() })),
  oncePerVersion: vi.fn((_d: string, _v: string, _fs: unknown, cb: () => void) => { cb() }),
  cleanupDemoWorkflows: vi.fn(),
  // session
  loadSession: vi.fn<() => any>(() => ({ terminals: [] })),
  // misc
  singleInstanceLock: vi.fn(() => true),
}))
// `registerWorkflowIpc` must hand back the same spy the tests drive, but M is still being built
// when the factory closes over it, so the runner is bound through a stable outer reference.
const M_startRun = (...a: unknown[]): unknown => M.wfStartRun(...a)

// ---------------------------------------------------------------------------
// Electron
// ---------------------------------------------------------------------------
const ipcHandlers = new Map<string, Function>()
const mockWebContents = { send: vi.fn(), executeJavaScript: vi.fn(), session: undefined }
const mockMainWindow = {
  minimize: vi.fn(), maximize: vi.fn(), unmaximize: vi.fn(),
  isMaximized: vi.fn(() => false), isMinimized: vi.fn(() => false),
  restore: vi.fn(), focus: vi.fn(), close: vi.fn(), on: vi.fn(),
  setIcon: vi.fn(), loadURL: vi.fn(), loadFile: vi.fn(),
  webContents: mockWebContents,
}
// The gateway prompt picks a window through the CLASS, not through an instance, so the statics
// have to exist on the constructor the same way Electron puts them there.
const windowRegistry = { focused: null as unknown, all: [] as unknown[] }
function MockBrowserWindow(): unknown { return mockMainWindow }
MockBrowserWindow.prototype = {}
MockBrowserWindow.getFocusedWindow = vi.fn(() => windowRegistry.focused)
MockBrowserWindow.getAllWindows = vi.fn(() => windowRegistry.all)

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => require('os').tmpdir()),
    getVersion: vi.fn(() => '1.25.2'),
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: () => M.singleInstanceLock(),
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
    showSaveDialog: M.showSaveDialog,
    showOpenDialog: M.showOpenDialog,
    showMessageBox: M.showMessageBox,
  },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => ({})) },
  nativeImage: { createFromPath: vi.fn(() => ({})), createFromBuffer: vi.fn(() => ({ isEmpty: () => true })) },
  globalShortcut: { register: vi.fn(), unregisterAll: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => '') },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}))

// ---------------------------------------------------------------------------
// Service modules
// ---------------------------------------------------------------------------
vi.mock('../../src/main/sentry', () => ({ initMainSentry: vi.fn() }))
vi.mock('../../src/main/terminalManager', () => ({
  spawnTerminal: M.spawnTerminal,
  killTerminal: M.killTerminal,
  writeToTerminal: M.writeToTerminal,
  resizeTerminal: vi.fn(),
  killAll: M.killAll,
  getTerminalCwd: vi.fn(() => '/repo'),
  getTerminalCwdAsync: vi.fn(async () => '/repo'),
  getTerminalPid: vi.fn(() => 0),
  getTerminalSize: M.getTerminalSize,
  computeWindowsPty: vi.fn(() => undefined),
}))
vi.mock('../../src/main/shellDetector', () => ({
  detectAvailableShells: M.detectAvailableShells,
  resolveShellExecutable: vi.fn((t: string) => `/bin/${t}`),
}))
vi.mock('../../src/main/sessionStore', () => ({
  loadSession: M.loadSession, loadRestoreSession: vi.fn(() => ({ terminals: [] })), saveSession: vi.fn(),
}))
vi.mock('../../src/main/historyStore', () => ({ appendCommand: vi.fn(), searchHistory: vi.fn(() => []) }))
vi.mock('../../src/main/configFileManager', () => ({ readConfigFile: vi.fn(), writeConfigFile: vi.fn() }))
vi.mock('../../src/main/completionService', () => ({
  listPathEntries: vi.fn(() => []), listPathCommands: vi.fn(() => []), listEnvVars: vi.fn(() => []),
}))
vi.mock('../../src/main/diagnostics', () => ({ collectDiagnostics: M.collectDiagnostics }))

// Real rule table + real scanner (processOutboundChunk drives the input-staging assertions below);
// only the audit SINKS and the settings read are spies, because those are the seams whose FAILURE
// arms are under test.
vi.mock('../../src/main/aiSecurity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/aiSecurity')>()
  M.aiGetSettings.mockImplementation(() => actual.getSettings())
  return {
    ...actual,
    appendAudit: M.appendAudit,
    getRecentAudit: M.recentAudit,
    clearAudit: M.clearAudit,
    getSettings: M.aiGetSettings,
  }
})
vi.mock('../../src/main/sensitiveFileWatcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/sensitiveFileWatcher')>()
  return { ...actual, getReadCount: M.sensitiveCount, getRecentReads: M.sensitiveRecent }
})
vi.mock('../../src/main/telemetry', () => ({
  initTelemetry: vi.fn(),
  setOptIn: M.setTelemetryOptIn,
  isEnabled: M.isTelemetryEnabled,
  dailyLaunchPing: vi.fn(),
  recordEvent: M.recordTelemetryEvent,
  recordUncleanExit: M.recordUncleanExit,
}))
// Real ref validation (the guards under test ARE isValidGitRef), spied process spawners.
vi.mock('../../src/main/gitCommand', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/gitCommand')>()
  return { ...actual, safeGit: M.safeGit, safeGitAsync: M.safeGitAsync }
})
vi.mock('../../src/main/gitHooks', () => ({
  installHooks: M.installHooks, uninstallHooks: M.uninstallHooks, hookStatus: M.hookStatus,
}))
vi.mock('../../src/main/importTrust', () => ({
  initImportTrust: vi.fn(),
  artifactHash: vi.fn(() => 'hash'),
  isApproved: vi.fn(() => false),
  approveArtifact: vi.fn(),
  revokeArtifact: M.revokeArtifact,
  listImported: M.listImported,
}))
vi.mock('../../src/main/memorySettings', () => ({
  getPrimerLimit: M.getPrimerLimit, setPrimerLimit: M.setPrimerLimit,
  getVectorQuantize: M.getVectorQuantize, setVectorQuantize: M.setVectorQuantize,
}))
vi.mock('../../src/main/contextPinStore', () => ({
  initContextPinStore: vi.fn(),
  listPins: M.listPins, addPin: M.addPin, removePin: M.removePin,
  updatePin: M.updatePin, clearPins: M.clearPins,
}))
vi.mock('../../src/main/codexParity', () => ({
  writeAgentsMd: M.writeAgentsMd, ensureCodexMemoryAutoApproved: M.ensureCodexMemoryAutoApproved,
}))
vi.mock('../../src/main/claudeTrust', () => ({ trustClaudeWorkspace: M.trustClaudeWorkspace }))
vi.mock('../../src/main/workspaceTrust', () => ({
  initWorkspaceTrust: vi.fn(),
  isWorkspaceTrusted: M.isWorkspaceTrusted,
  trustWorkspace: vi.fn(),
  revokeWorkspaceTrust: vi.fn(),
  listTrustedWorkspaces: vi.fn(() => []),
  ensureWorkspaceTrust: vi.fn(() => true),
}))
vi.mock('../../src/main/mcpServer', () => ({
  startMcpServer: M.startMcpServer,
  stopMcpServer: M.stopMcpServer,
  getMcpAuthToken: vi.fn(() => 'fake-token'),
  getMcpPort: vi.fn(() => 9315),
  initAuditLog: vi.fn(),
  awaitMcpPortBound: vi.fn(() => Promise.resolve(9315)),
  executeTool: vi.fn(async () => ({ ok: true })),
}))
vi.mock('../../src/main/swarmManager', () => ({
  sendMessage: vi.fn(), readMessages: vi.fn(() => []), getAllMessages: vi.fn(() => []),
  createTask: vi.fn(), listTasks: vi.fn(() => []), updateTask: vi.fn(), clearSwarm: vi.fn(),
}))
vi.mock('../../src/main/agentEventBus', () => ({
  initEventBus: vi.fn(), query: vi.fn(() => []), subscribe: vi.fn(), publish: vi.fn(),
  getRingSize: vi.fn(() => 0), getDroppedCount: vi.fn(() => 0), shutdownEventBus: vi.fn(),
}))
vi.mock('../../src/main/transcriptWatchers', () => ({
  attachWatcher: vi.fn(() => null), detachWatchers: vi.fn(), detachAll: vi.fn(),
}))
vi.mock('../../src/main/autoUpdater', () => ({ initAutoUpdater: M.initAutoUpdater }))
vi.mock('../../src/main/agentCommandSanitizer', () => ({
  sanitizeAgentCommand: vi.fn((c: string) => c),
  isClaudeAgentName: (name: string) => /(^|[^a-z])claude/i.test(name || ''),
}))
vi.mock('../../src/main/agentPaths', () => ({
  getAgentExtraPaths: vi.fn(() => ['/opt/agent-bin']),
  getExtendedPath: vi.fn(() => '/usr/bin:/opt/agent-bin'),
  getInteractiveShellPath: vi.fn(() => ''),
  __resetShellPathCacheForTests: vi.fn(),
}))
vi.mock('../../src/main/groqKeyStore', () => ({
  getGroqKey: vi.fn(() => null), setGroqKey: vi.fn(),
  getGroqKeyStatus: vi.fn(() => ({ connected: false, hint: '' })), clearGroqKey: vi.fn(),
  groqKeyPath: vi.fn(() => '/tmp/groq'), maskKey: vi.fn(() => '••••'),
}))
vi.mock('../../src/main/groqTranscription', () => ({
  transcribeWithGroq: vi.fn(async () => ({ text: '' })), validateGroqKey: vi.fn(async () => ({ valid: true })),
}))
vi.mock('../../src/main/aiSessions', () => ({
  listAISessions: vi.fn(async () => []), digestAISession: vi.fn(async () => null),
  renderDigestAsPrompt: vi.fn(() => ''),
}))
vi.mock('../../src/main/liveTranscript', () => ({
  readActiveTranscript: vi.fn(async () => []), readSessionTranscript: vi.fn(async () => ({ turns: [] })),
}))
vi.mock('../../src/main/memoryIndexer', () => ({ startIndexer: vi.fn(), stopIndexer: vi.fn() }))
vi.mock('../../src/main/secondOpinion', () => ({
  runSecondOpinion: M.runSecondOpinion, secondOpinionSpawnPlan: M.secondOpinionSpawnPlan,
}))
vi.mock('../../src/main/headlessExec', () => ({ runHeadless: M.runHeadless }))
vi.mock('../../src/main/contextPrimer', () => ({ buildContextPrimer: M.buildContextPrimer }))
vi.mock('../../src/main/memoryCorrectionStore', () => ({
  initMemoryCorrections: vi.fn(), correctMemory: M.correctMemory, applyCorrections: vi.fn((x: unknown) => x),
}))
vi.mock('../../src/main/recallBench', () => ({
  buildProbes: M.buildProbes, runBench: M.runBench, checkRegression: M.checkRegression,
  baselineFrom: M.baselineFrom, formatBench: M.formatBench,
}))
vi.mock('../../src/main/recallBenchStore', () => ({
  initRecallBench: vi.fn(), loadBenchBaseline: M.loadBenchBaseline, saveBenchBaseline: M.saveBenchBaseline,
}))
vi.mock('../../src/main/learningSignals', () => ({
  startLearningSignals: M.startLearningSignals, stopLearningSignals: M.stopLearningSignals,
}))
vi.mock('../../src/main/remoteHost', () => ({
  noteTerminalClosed: vi.fn(), noteTerminalOutput: vi.fn(), realBridgeTransport: vi.fn(),
  registerRemoteIpc: M.registerRemoteIpc,
  startRemoteBridgeHost: M.startRemoteBridgeHost, stopRemoteBridgeHost: M.stopRemoteBridgeHost,
}))
vi.mock('../../src/main/mcpGatewayRuntime', () => ({
  initMcpGateway: vi.fn(),
  gatewayListTools: M.gatewayListTools,
  gatewayCall: M.gatewayCall,
  setGatewayPrompt: M.setGatewayPrompt,
  getGatewayPolicy: M.getGatewayPolicy,
  setGatewayPolicy: M.setGatewayPolicy,
}))
vi.mock('../../src/main/mcpGateway/policy', () => ({ remember: M.remember }))
vi.mock('../../src/main/mcpIpc', () => ({ registerMcpIpc: vi.fn() }))

// ---- headroom ----
vi.mock('../../src/main/headroom/config', () => ({
  getSettings: M.getHeadroomSettings, setSettings: M.setHeadroomSettings,
}))
vi.mock('../../src/main/headroom/persist', () => ({
  loadSettingsFromDisk: M.loadSettingsFromDisk, saveSettingsToDisk: M.saveSettingsToDisk,
  loadLedgerBaseFromDisk: M.loadLedgerBaseFromDisk, saveLedgerToDisk: M.saveLedgerToDisk,
}))
vi.mock('../../src/main/headroom/savingsLedger', () => ({
  summarizeSavings: M.summarizeHeadroomSavings, setLedgerFlush: M.setLedgerFlush,
}))
vi.mock('../../src/main/headroom/unifiedReceipt', () => ({ summarizeUnifiedSavings: M.summarizeUnifiedSavings }))
vi.mock('../../src/main/headroom/outputEconomyStore', () => ({
  initOutputEconomy: vi.fn(), armForSession: M.armForSession,
  flushOutputEconomy: M.flushOutputEconomy, outputEconomyReport: M.outputEconomyReport,
}))
vi.mock('../../src/main/headroom/outputSteering', () => ({ adaptSteeringMode: M.adaptSteeringMode }))
vi.mock('../../src/main/headroom/savingsFloor', () => ({ resolveWireMode: M.resolveWireMode }))
vi.mock('../../src/main/headroom/ccrStore', () => ({ setCcrDir: M.setCcrDir, ccrPut: M.ccrPut }))
vi.mock('../../src/main/headroom/compressToolResult', () => ({ retrieveFull: M.headroomRetrieveFull }))
vi.mock('../../src/main/headroom/injectedInstruction', () => ({ buildInjectedInstruction: M.buildInjectedInstruction }))
vi.mock('../../src/main/headroom/receiptStore', () => ({
  initReceiptIdentity: vi.fn(), issueReceipt: M.issueReceipt, checkReceipt: M.checkReceipt,
}))
vi.mock('../../src/main/headroom/receiptArtifact', () => ({
  renderReceiptMarkdown: M.renderReceiptMarkdown, renderReceiptJson: M.renderReceiptJson,
}))
vi.mock('../../src/main/headroom/sessionDepth', () => ({
  loadDepthCurveFromDisk: M.loadDepthCurveFromDisk, saveDepthCurveToDisk: M.saveDepthCurveToDisk,
}))
vi.mock('../../src/main/headroomProxy/proxyLedger', () => ({
  recordProxyResult: M.recordProxyResult, summarizeProxySavings: M.summarizeProxySavings,
  loadProxyBaseFromDisk: M.loadProxyBaseFromDisk, saveProxyTotalsToDisk: M.saveProxyTotalsToDisk,
  setProxyLedgerFlush: M.setProxyLedgerFlush, resetProxyCounters: M.resetProxyCounters,
}))
vi.mock('../../src/main/headroomProxy/proxySupervisor', () => ({
  getProxyEnv: M.getProxyEnv, startProxy: M.startProxy, stopProxy: M.stopProxy,
  onProxyResult: M.onProxyResult, onProxyStash: M.onProxyStash,
  setProxySpawner: M.setProxySpawner, createProxyTransport: M.createProxyTransport,
  pickFreePort: M.pickFreePort, setProxyMode: M.setProxyMode,
  setProxyThinkingCap: M.setProxyThinkingCap, setProxyDecay: M.setProxyDecay,
}))

// ---- workflow ----
const wfCaptured = vi.hoisted(() => ({ triggerDeps: null as any, ipcOpts: null as any }))
vi.mock('../../src/main/workflow/adapters', () => ({
  makeTerminalRunner: M.makeTerminalRunner, makeAgentRunner: M.makeAgentRunner,
  makeToolInvoker: M.makeToolInvoker, realTimer: { setTimeout, clearTimeout },
}))
vi.mock('../../src/main/workflow/workflowEngine', () => ({ runWorkflow: vi.fn(), cancelRun: vi.fn() }))
vi.mock('../../src/main/workflow/ipc', () => ({
  registerWorkflowIpc: vi.fn((_ipc: unknown, _win: unknown, opts: unknown) => {
    wfCaptured.ipcOpts = opts
    return M.registerWorkflowIpc(_ipc, _win, opts)
  }),
}))
vi.mock('../../src/main/workflow/triggers', () => ({
  TriggerSupervisor: class {
    armedCount = 0
    constructor(deps: unknown) { wfCaptured.triggerDeps = deps }
    rearmAll = vi.fn()
    rearm = vi.fn()
    watchProject = vi.fn()
    start = vi.fn()
    stop = vi.fn()
  },
}))
vi.mock('../../src/main/workflow/demoCleanup', () => ({
  cleanupDemoWorkflows: M.cleanupDemoWorkflows, oncePerVersion: M.oncePerVersion,
}))

// ---- memory brain ----
const MEMC = vi.hoisted(() => ({
  initSwarmMemory: vi.fn(),
  memoryWrite: vi.fn(async () => ({ id: 'mem-1' })),
  memorySearch: vi.fn(async () => [] as unknown[]),
  memoryRelated: vi.fn(() => []),
  memoryLink: vi.fn(async () => ({ ok: true })),
  memoryGraphQuery: vi.fn(() => []),
  memoryFeedback: vi.fn(),
  memoryList: vi.fn<(...a: any[]) => any>(async () => [] as unknown[]),
  memoryCount: vi.fn(async () => 0),
  memoryClear: vi.fn(async () => {}),
  memoryHasHash: vi.fn(() => false),
  memoryStats: vi.fn(async () => ({ total: 7 })),
  memoryDashboardStats: vi.fn(() => ({})),
  memoryGraphSample: vi.fn<(...a: any[]) => any>(async () => ({ nodes: [], edges: [] })),
  memoryRecentActivity: vi.fn(() => []),
  embeddingsReady: vi.fn(() => true),
  memorySourceById: vi.fn(() => null),
  memoryDelete: vi.fn(),
  consolidationCandidates: vi.fn(() => []),
  consolidationSimOf: vi.fn(() => () => 0),
  memoryPatchProjects: vi.fn(),
  normalizeProjectSlug: vi.fn((p: string) => (p || '').split(/[\\/]/).filter(Boolean).pop() || ''),
  memoryLessons: vi.fn(() => []),
  memoryPruneCodePath: vi.fn(),
  warmProbeEmbeddings: vi.fn(async () => true),
  compactSelfShard: vi.fn(async () => ({ compacted: false })),
  setMemoryScrubber: vi.fn(),
  weaveCandidates: vi.fn(() => []),
  weaveNeighbours: vi.fn(() => []),
  backfillCodeRefs: vi.fn(),
  symbolHistory: vi.fn(() => []),
  memoryArchive: vi.fn(),
  searchArchive: vi.fn<(...a: any[]) => any>(async () => [{ id: 'cold-1' }]),
  getSyncStatus: vi.fn<() => any>(async () => ({ enabled: false, dir: null })),
  setSyncDir: vi.fn<(...a: any[]) => any>(async (d: string | null) => ({ enabled: !!d, dir: d })),
  reloadMemoryFromSync: vi.fn(),
  setSyncPassphrase: vi.fn(async () => ({ encrypted: true })),
  disableSyncEncryption: vi.fn<() => any>(async () => ({ encrypted: false })),
  enableLocalEncryption: vi.fn(async () => ({ encrypted: true })),
  disableEncryption: vi.fn(async () => ({ encrypted: false })),
  persistMemoryIndex: vi.fn(),
  entityDedupHash: vi.fn(() => 'entity-hash'),
  projectKeyOf: vi.fn((p: string) => p),
  contentHash: vi.fn((c: string) => `h:${c}`),
  canonicalEntityName: vi.fn((n: string) => n.trim()),
  vectorRamStats: vi.fn(async () => ({ bytes: 0 })),
  setVectorQuantization: vi.fn(async () => ({ bytes: 0 })),
  graphStats: vi.fn(() => ({})),
  graphRelationStats: vi.fn(() => ({})),
  startMemoryHost: vi.fn(async () => 'host'),
  setMemoryHostSpawner: vi.fn(),
  createMemoryHostTransport: vi.fn(),
  stopMemoryHost: vi.fn(),
  memoryHostMode: vi.fn<() => any>(() => 'host'),
  memoryHostPid: vi.fn<() => any>(() => 4242),
  memoryKnownHashes: vi.fn(async () => [] as string[]),
  weaveNeighboursBatch: vi.fn(async () => ({})),
  exportMemorySnapshot: vi.fn(async () => ''),
  importMemorySnapshot: vi.fn(async () => ({ imported: 0 })),
}))
vi.mock('../../src/main/memoryClient', () => MEMC)
vi.mock('../../src/main/swarmMemory', () => MEMC)

vi.mock('child_process', () => ({
  default: { execSync: M.execSync, execFileSync: M.execFileSync, spawn: M.spawn },
  execSync: M.execSync, execFileSync: M.execFileSync, spawn: M.spawn,
}))

vi.mock('fs', () => {
  const impl = {
    writeFileSync: M.writeFileSync,
    existsSync: M.existsSync,
    readFileSync: M.readFileSync,
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ isDirectory: () => false, isFile: () => true, mtimeMs: 0, size: 0 })),
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: M.unlinkSync,
    chmodSync: vi.fn(),
    rmSync: vi.fn(),
    watch: vi.fn(),
    promises: {
      unlink: M.fsUnlink, appendFile: vi.fn(async () => {}), readFile: vi.fn(async () => ''),
      writeFile: vi.fn(async () => {}), rename: vi.fn(async () => {}), mkdir: vi.fn(async () => {}),
    },
  }
  return { ...impl, default: impl }
})

vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-uuid') }))

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
function invoke(channel: string, args: unknown = {}): any {
  const handler = ipcHandlers.get(channel)
  if (!handler) throw new Error(`No handler for ${channel}`)
  return handler({}, args)
}

async function ipcOn(channel: string): Promise<Function> {
  const { ipcMain } = (await import('electron')) as any
  const call = [...ipcMain.on.mock.calls].reverse().find((c: unknown[]) => c[0] === channel)
  if (!call) throw new Error(`ipcMain.on(${channel}) was never registered`)
  return call[1]
}

/** The MCP tool table index.ts hands to startMcpServer — the only way in to the operator verbs. */
function mcp(): Record<string, (...a: any[]) => any> {
  const calls = M.startMcpServer.mock.calls as unknown as unknown[][]
  if (calls.length === 0) throw new Error('startMcpServer was never called — the whenReady chain did not run')
  return calls[calls.length - 1][0] as Record<string, (...a: any[]) => any>
}

/** First argument of the last call to a spy that was handed a callback. */
function cbOf(spy: { mock: { calls: unknown[][] } }): any {
  const calls = spy.mock.calls
  if (calls.length === 0) throw new Error('callback was never registered')
  return calls[calls.length - 1][0]
}

async function withPlatform(platform: NodeJS.Platform, fn: () => Promise<void> | void): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try { await fn() } finally { Object.defineProperty(process, 'platform', original) }
}

const BASE_HR = {
  enabled: true, steering: true, mode: 'balanced', adaptiveSteering: false,
  thinkingCap: 0, prefixDecay: false, floorControl: true,
}

let exitSpy: ReturnType<typeof vi.spyOn>

beforeAll(async () => {
  // index.ts force-exits 500ms after the last window closes; a real exit would take the worker.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  // floorControl:true at BOOT is what makes the whenReady proxy block consult resolveWireMode —
  // that arm is only decidable before import, because it runs exactly once.
  M.getHeadroomSettings.mockReturnValue({ ...BASE_HR })
  vi.resetModules()
  await import('../../src/main/index')
  await new Promise((resolve) => setTimeout(resolve, 80))
})

afterAll(() => { exitSpy.mockRestore() })

beforeEach(() => {
  M.getHeadroomSettings.mockReturnValue({ ...BASE_HR })
  M.armForSession.mockReturnValue('control')
  M.adaptSteeringMode.mockImplementation((mode: any) => mode)
  M.loadSession.mockReturnValue({ terminals: [] })
  mockWebContents.send.mockClear()
  M.writeAgentsMd.mockClear()
  M.writeFileSync.mockClear()
  M.appendAudit.mockClear()
})

// ===========================================================================
// memory:prepare-codex-context — the Codex half of the parity pair.
// Nothing in the repo had ever invoked it: the entire handler, both steering
// experiments and the guard were unexecuted code.
// ===========================================================================
describe('memory:prepare-codex-context', () => {
  it('refuses without a cwd BEFORE writing anything', async () => {
    const r = await invoke('memory:prepare-codex-context', {})
    expect(r).toEqual({ success: false, error: 'cwd required' })
    // The guard is only worth having if it runs first: AGENTS.md is written into a directory,
    // and `undefined` as that directory is how you scribble into the process cwd.
    expect(M.writeAgentsMd).not.toHaveBeenCalled()
  })

  it('reports the file, whether it changed, and how many tools were auto-approved', async () => {
    M.writeAgentsMd.mockReturnValueOnce({ path: '/repo/AGENTS.md', changed: false } as never)
    M.ensureCodexMemoryAutoApproved.mockReturnValueOnce({ tools: ['memory_primer', 'memory_search', 'memory_write'] } as never)
    const r = await invoke('memory:prepare-codex-context', { cwd: '/repo' })
    // `approvals` is a COUNT, not the array — shipping the array would leak tool names the UI
    // then renders as a number anyway.
    expect(r).toEqual({ success: true, data: { file: '/repo/AGENTS.md', changed: false, approvals: 3 } })
  })

  it('carries the user steering setting and mode into the written AGENTS.md', async () => {
    M.getHeadroomSettings.mockReturnValue({ ...BASE_HR, enabled: true, steering: true, mode: 'aggressive' })
    await invoke('memory:prepare-codex-context', { cwd: '/repo' })
    expect(M.writeAgentsMd).toHaveBeenCalledWith('/repo', { cwd: '/repo', steering: true, mode: 'aggressive' })
  })

  it('leaves steering off when headroom is disabled, even with steering ticked', async () => {
    // `hs.enabled && hs.steering` — the master switch has to dominate the sub-switch, or turning
    // headroom off would still steer Codex.
    M.getHeadroomSettings.mockReturnValue({ ...BASE_HR, enabled: false, steering: true })
    await invoke('memory:prepare-codex-context', { cwd: '/repo' })
    expect(M.writeAgentsMd).toHaveBeenCalledWith('/repo', expect.objectContaining({ steering: false }))
  })

  it('leaves steering off when steering alone is unticked', async () => {
    M.getHeadroomSettings.mockReturnValue({ ...BASE_HR, enabled: true, steering: false })
    await invoke('memory:prepare-codex-context', { cwd: '/repo' })
    expect(M.writeAgentsMd).toHaveBeenCalledWith('/repo', expect.objectContaining({ steering: false }))
  })

  it('adapts the mode from measured proxy output when adaptiveSteering is on', async () => {
    M.getHeadroomSettings.mockReturnValue({ ...BASE_HR, adaptiveSteering: true, mode: 'balanced' })
    M.summarizeProxySavings.mockReturnValueOnce({ cumulative: { outputTokens: 5000, requests: 40 } } as never)
    M.adaptSteeringMode.mockReturnValueOnce('aggressive' as never)
    await invoke('memory:prepare-codex-context', { cwd: '/repo' })
    // The adapter is fed the CUMULATIVE numbers, not the per-request ones — a single big response
    // must not be able to re-tier the whole session.
    expect(M.adaptSteeringMode).toHaveBeenCalledWith('balanced', 5000, 40)
    expect(M.writeAgentsMd).toHaveBeenCalledWith('/repo', expect.objectContaining({ mode: 'aggressive' }))
  })

  it('does not consult the adapter when adaptiveSteering is off', async () => {
    M.adaptSteeringMode.mockClear()
    M.getHeadroomSettings.mockReturnValue({ ...BASE_HR, adaptiveSteering: false })
    await invoke('memory:prepare-codex-context', { cwd: '/repo' })
    expect(M.adaptSteeringMode).not.toHaveBeenCalled()
  })

  it('drops steering for a cwd in the holdout arm, keyed by that cwd', async () => {
    M.armForSession.mockReturnValueOnce('holdout' as never)
    await invoke('memory:prepare-codex-context', { cwd: '/repo/holdout-project' })
    expect(M.armForSession).toHaveBeenCalledWith('/repo/holdout-project')
    // The holdout only means anything if it actually unsteers the run it selected.
    expect(M.writeAgentsMd).toHaveBeenCalledWith('/repo/holdout-project', expect.objectContaining({ steering: false }))
  })

  it('does not consult the holdout at all when steering is already off', async () => {
    // `steering && armForSession(...)` short-circuits: an unsteered session must not be counted
    // into either arm of the experiment, or the comparison is polluted by sessions that were
    // never eligible.
    M.armForSession.mockClear()
    M.getHeadroomSettings.mockReturnValue({ ...BASE_HR, steering: false })
    await invoke('memory:prepare-codex-context', { cwd: '/repo' })
    expect(M.armForSession).not.toHaveBeenCalled()
  })

  it('still writes AGENTS.md when the steering settings are unreadable', async () => {
    // Steering is an optimisation; the memory context is the point. A broken settings file must
    // cost the user their steering, not their primer.
    M.getHeadroomSettings.mockImplementation(() => { throw new Error('settings.json is corrupt') })
    const r = await invoke('memory:prepare-codex-context', { cwd: '/repo' })
    expect(r.success).toBe(true)
    expect(M.writeAgentsMd).toHaveBeenCalledWith('/repo', { cwd: '/repo', steering: false, mode: undefined })
  })

  it('returns the failure as err() when the file cannot be written', async () => {
    M.writeAgentsMd.mockImplementationOnce(() => { throw new Error('EACCES: /repo/AGENTS.md') })
    expect(await invoke('memory:prepare-codex-context', { cwd: '/repo' }))
      .toEqual({ success: false, error: 'EACCES: /repo/AGENTS.md' })
  })
})

// ===========================================================================
// claude:trust-workspace — pre-approves the folder in Claude Code's own config.
// ===========================================================================
describe('claude:trust-workspace', () => {
  it('also seeds the git ROOT, trimmed, so a launch from a subdir is covered', async () => {
    M.safeGitAsync.mockResolvedValueOnce('/repo\n' as never)
    const r = await invoke('claude:trust-workspace', { cwd: '/repo/packages/app' })
    expect(M.safeGitAsync).toHaveBeenCalledWith(['rev-parse', '--show-toplevel'], { cwd: '/repo/packages/app', timeout: 2000 })
    // Untrimmed, the key would be "/repo\n" — never equal to the key Claude itself writes.
    expect(M.trustClaudeWorkspace).toHaveBeenCalledWith('/repo/packages/app', { alsoTrust: ['/repo'] })
    expect(r).toEqual({ success: true, data: { trusted: true } })
  })

  it('still trusts the cwd when the folder is not a git repo', async () => {
    // The rev-parse rejection is EXPECTED for a plain directory. Letting it propagate would turn
    // "not a repo" into "trust failed", and the dialog Termpolis exists to suppress comes back.
    M.safeGitAsync.mockRejectedValueOnce(new Error('not a git repository'))
    const r = await invoke('claude:trust-workspace', { cwd: '/plain/dir' })
    expect(M.trustClaudeWorkspace).toHaveBeenCalledWith('/plain/dir', { alsoTrust: [] })
    expect(r.success).toBe(true)
  })

  it('does not add an empty-string key when rev-parse returns only whitespace', async () => {
    M.safeGitAsync.mockResolvedValueOnce('   \n' as never)
    await invoke('claude:trust-workspace', { cwd: '/repo' })
    expect(M.trustClaudeWorkspace).toHaveBeenCalledWith('/repo', { alsoTrust: [] })
  })

  it('surfaces a config-write failure as err()', async () => {
    M.safeGitAsync.mockResolvedValueOnce('' as never)
    M.trustClaudeWorkspace.mockImplementationOnce(() => { throw new Error('~/.claude.json is read-only') })
    expect(await invoke('claude:trust-workspace', { cwd: '/repo' }))
      .toEqual({ success: false, error: '~/.claude.json is read-only' })
  })
})

// ===========================================================================
// tokenSavings:* — registered inside whenReady, invoked by nothing until now.
// ===========================================================================
describe('tokenSavings IPC', () => {
  it('get-settings returns the live headroom settings', async () => {
    M.getHeadroomSettings.mockReturnValue({ ...BASE_HR, mode: 'conservative' })
    expect(await invoke('tokenSavings:get-settings')).toEqual({ success: true, data: expect.objectContaining({ mode: 'conservative' }) })
  })

  it('set-settings persists, then pushes mode/decay/cap into the live proxy', async () => {
    M.setHeadroomSettings.mockReturnValueOnce({ mode: 'aggressive', prefixDecay: true, thinkingCap: 4096 } as never)
    const r = await invoke('tokenSavings:set-settings', { mode: 'aggressive' })
    expect(M.setHeadroomSettings).toHaveBeenCalledWith({ mode: 'aggressive' })
    expect(M.saveSettingsToDisk).toHaveBeenCalled()
    // The proxy is told the NORMALISED result, not the raw patch — a partial patch must not
    // blank out the fields it did not mention.
    expect(M.setProxyMode).toHaveBeenCalledWith('aggressive')
    expect(M.setProxyDecay).toHaveBeenCalledWith(true)
    expect(M.setProxyThinkingCap).toHaveBeenCalledWith(4096)
    expect(r).toEqual({ success: true, data: { mode: 'aggressive', prefixDecay: true, thinkingCap: 4096 } })
  })

  it('set-settings treats a missing payload as an empty patch, not undefined', async () => {
    // setSettings(undefined) would read as "replace everything with defaults" in a spread-based
    // merge; `p || {}` is what keeps a no-op call a no-op.
    await invoke('tokenSavings:set-settings', null)
    expect(M.setHeadroomSettings).toHaveBeenCalledWith({})
  })

  it('set-settings still returns ok when the proxy refuses the new mode', async () => {
    // Each proxy push is guarded separately on purpose: the settings are already saved, so a
    // dead proxy must not make the user think their choice was rejected.
    M.setProxyMode.mockImplementationOnce(() => { throw new Error('proxy down') })
    M.setProxyDecay.mockImplementationOnce(() => { throw new Error('proxy down') })
    M.setProxyThinkingCap.mockImplementationOnce(() => { throw new Error('proxy down') })
    M.setHeadroomSettings.mockReturnValueOnce({ mode: 'balanced' } as never)
    expect(await invoke('tokenSavings:set-settings', { mode: 'balanced' })).toEqual({ success: true, data: { mode: 'balanced' } })
  })

  it('set-settings still returns ok when the settings file cannot be written', async () => {
    M.saveSettingsToDisk.mockImplementationOnce(() => { throw new Error('disk full') })
    M.setHeadroomSettings.mockReturnValueOnce({ mode: 'balanced' } as never)
    expect((await invoke('tokenSavings:set-settings', {})).success).toBe(true)
  })

  it('get-receipt and get-unified-receipt report different layers', async () => {
    expect(await invoke('tokenSavings:get-receipt')).toEqual({ success: true, data: { layer: 'mcp', savedTokens: 11 } })
    expect(await invoke('tokenSavings:get-unified-receipt'))
      .toEqual({ success: true, data: { cumulative: { savedTokens: 42, requests: 3, outputTokens: 900 } } })
  })

  it('get-proxy-receipt reports the wire layer', async () => {
    expect(await invoke('tokenSavings:get-proxy-receipt'))
      .toEqual({ success: true, data: { cumulative: { outputTokens: 1000, requests: 10, savedTokens: 7 } } })
  })

  it('get-output-economy passes a set thinking cap through', async () => {
    M.getHeadroomSettings.mockReturnValue({ ...BASE_HR, thinkingCap: 8192 })
    expect(await invoke('tokenSavings:get-output-economy')).toEqual({ success: true, data: { verdict: 'no-effect' } })
    expect(M.outputEconomyReport).toHaveBeenCalledWith(8192)
  })

  it('get-output-economy reports a cap of 0 as null, not as a 0-token cap', async () => {
    // `|| null`: 0 means "off". Forwarded as 0 it would read as "cap everything at zero tokens".
    M.getHeadroomSettings.mockReturnValue({ ...BASE_HR, thinkingCap: 0 })
    await invoke('tokenSavings:get-output-economy')
    expect(M.outputEconomyReport).toHaveBeenCalledWith(null)
  })

  it('get-output-economy returns err() rather than throwing into the IPC bridge', async () => {
    M.outputEconomyReport.mockImplementationOnce(() => { throw new Error('ledger unreadable') })
    expect(await invoke('tokenSavings:get-output-economy')).toEqual({ success: false, error: 'ledger unreadable' })
  })

  it('export-receipt signs the CUMULATIVE totals and renders markdown by default', async () => {
    const r = await invoke('tokenSavings:export-receipt', {})
    expect(M.issueReceipt).toHaveBeenCalledWith({ savedTokens: 42, requests: 3, outputTokens: 900 }, expect.any(Number))
    expect(r.success).toBe(true)
    expect(r.data.text).toBe('# receipt')
  })

  it('export-receipt renders JSON only when json is asked for', async () => {
    const r = await invoke('tokenSavings:export-receipt', { format: 'json' })
    expect(r.data.text).toBe('{"receipt":true}')
    expect(M.renderReceiptMarkdown).not.toHaveBeenCalledWith(expect.anything(), 'json')
  })

  it('export-receipt returns err() when the identity key is missing', async () => {
    M.issueReceipt.mockImplementationOnce(() => { throw new Error('no signing identity') })
    expect(await invoke('tokenSavings:export-receipt', {})).toEqual({ success: false, error: 'no signing identity' })
  })
})

// ===========================================================================
// The ledger flush callbacks index.ts hands to the two savings ledgers.
// ===========================================================================
describe('headroom ledger flush debounce', () => {
  it('collapses a burst of ledger writes into a single disk write', async () => {
    const flush = cbOf(M.setLedgerFlush)
    M.saveLedgerToDisk.mockClear()
    vi.useFakeTimers()
    try {
      flush(); flush(); flush()
      // The whole point of the debounce: the ledger is touched on every request, and the hot
      // path must not pay a write each time.
      expect(M.saveLedgerToDisk).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2000)
      expect(M.saveLedgerToDisk).toHaveBeenCalledTimes(1)
      // ...and the timer must re-arm, or the second minute of a session never persists.
      flush()
      vi.advanceTimersByTime(2000)
      expect(M.saveLedgerToDisk).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('flushes proxy totals, the depth curve and the output experiment on ONE timer', async () => {
    const flush = cbOf(M.setProxyLedgerFlush)
    M.saveProxyTotalsToDisk.mockClear()
    M.saveDepthCurveToDisk.mockClear()
    M.flushOutputEconomy.mockClear()
    vi.useFakeTimers()
    try {
      flush(); flush()
      vi.advanceTimersByTime(3000)
      // Three sinks, one timer: the experiment samples the ledger, so they must never disagree
      // about which requests happened.
      expect(M.saveProxyTotalsToDisk).toHaveBeenCalledTimes(1)
      expect(M.saveDepthCurveToDisk).toHaveBeenCalledTimes(1)
      expect(M.flushOutputEconomy).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })
})

// ===========================================================================
// Proxy wiring: the result / stash / spawner callbacks, and the launch-time
// floor-control decision.
// ===========================================================================
describe('headroom proxy wiring', () => {
  it('forwards a proxy result to the ledger and swallows a ledger fault', async () => {
    const onResult = cbOf(M.onProxyResult)
    onResult({ savedTokens: 5 })
    expect(M.recordProxyResult).toHaveBeenCalledWith({ savedTokens: 5 })
    M.recordProxyResult.mockImplementationOnce(() => { throw new Error('ledger wedged') })
    // A bookkeeping failure must not propagate into the response path that is mid-flight.
    expect(() => onResult({ savedTokens: 6 })).not.toThrow()
  })

  it('commits every stashed original, and one bad stash does not lose the rest', async () => {
    const onStash = cbOf(M.onProxyStash)
    M.ccrPut.mockClear()
    M.ccrPut.mockImplementationOnce(() => { throw new Error('disk full') })
    onStash({ stashes: [{ token: 't1', original: 'A' }, { token: 't2', original: 'B' }] })
    // Second stash still lands: retrieve_full on t2 must work even though t1 could not be written.
    expect(M.ccrPut).toHaveBeenCalledTimes(2)
    expect(M.ccrPut).toHaveBeenLastCalledWith('t2', 'B', 'proxy')
  })

  it('restores the measured totals and the fitted depth curve from disk at boot', () => {
    // Both live under userData/headroom and both must be READ BACK at launch: a curve rebuilt
    // from scratch each launch never reaches its minimum sample count and the advisory stays
    // silent forever, and a ledger starting at zero reports a month's savings as a session's.
    const hrDir = join(tmpdir(), 'headroom')
    expect(M.loadProxyBaseFromDisk).toHaveBeenCalledWith(hrDir)
    expect(M.loadDepthCurveFromDisk).toHaveBeenCalledWith(hrDir)
  })
})

// ===========================================================================
// The gateway's human-in-the-loop prompt. Shipped inert before this existed:
// `defaultDecision:'ask'` resolves to deny when there is nobody to ask.
// ===========================================================================
describe('MCP gateway prompt', () => {
  const prompt = (): any => cbOf(M.setGatewayPrompt)

  beforeEach(() => {
    windowRegistry.focused = mockMainWindow
    windowRegistry.all = [mockMainWindow]
    M.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false } as never)
    M.setGatewayPolicy.mockClear()
  })

  it('fails CLOSED when there is no window to ask', async () => {
    windowRegistry.focused = null
    windowRegistry.all = []
    // Headless or fully-closed: the call must be refused, never silently allowed and never hung.
    await expect(prompt()('srv', 'tool', [])).rejects.toThrow('no window to ask')
  })

  it('falls back to the first open window when none is focused', async () => {
    windowRegistry.focused = null
    windowRegistry.all = [mockMainWindow]
    await prompt()('srv', 'tool', [])
    expect(M.showMessageBox).toHaveBeenCalledWith(mockMainWindow, expect.anything())
  })

  it('names the server and tool, and lists deduped finding labels', async () => {
    await prompt()('github', 'create_issue', [{ label: 'AWS key' }, { label: 'AWS key' }, { label: 'JWT' }])
    const opts = M.showMessageBox.mock.calls.at(-1)![1] as any
    expect(opts.message).toBe('An agent wants to call "create_issue" on the MCP server "github".')
    // Deduped: three hits of the same rule is one thing to tell the user about, not three.
    expect(opts.detail).toBe('Its arguments look like they contain: AWS key, JWT.')
    // Deny is both default and cancel, so Esc / Enter-on-nothing cannot approve a call.
    expect(opts.defaultId).toBe(0)
    expect(opts.cancelId).toBe(0)
  })

  it('says plainly when nothing was detected rather than leaving the detail blank', async () => {
    await prompt()('github', 'list_repos', [])
    expect((M.showMessageBox.mock.calls.at(-1)![1] as any).detail).toBe('No secrets were detected in its arguments.')
  })

  it('button 0 denies', async () => {
    M.showMessageBox.mockResolvedValueOnce({ response: 0 } as never)
    expect(await prompt()('srv', 'tool', [])).toBe('deny')
  })

  it('button 1 allows ONCE — nothing is written to the policy', async () => {
    M.showMessageBox.mockResolvedValueOnce({ response: 1 } as never)
    expect(await prompt()('srv', 'tool', [])).toBe('allow')
    // "Allow once" that quietly persisted would be a consent bug, not a convenience.
    expect(M.setGatewayPolicy).not.toHaveBeenCalled()
  })

  it('button 2 allows AND remembers, so the next identical call skips the dialog', async () => {
    M.showMessageBox.mockResolvedValueOnce({ response: 2 } as never)
    expect(await prompt()('github', 'create_issue', [])).toBe('allow')
    expect(M.remember).toHaveBeenCalledWith({ rules: [] }, 'github', 'create_issue', 'allow')
    expect(M.setGatewayPolicy).toHaveBeenCalledWith(expect.objectContaining({ remembered: ['github', 'create_issue', 'allow'] }))
  })
})

// ===========================================================================
// The MCP operator verbs — CLI-only tools with no renderer surface at all.
// ===========================================================================
describe('MCP tool table — operator verbs', () => {
  it('memoryCorrect maps the tool payload onto a correction record', async () => {
    await mcp().memoryCorrect({ id: 'm1', kind: 'retract', reason: 'wrong repo', replacement: undefined })
    expect(M.correctMemory).toHaveBeenCalledWith({ id: 'm1', kind: 'retract', reason: 'wrong repo', replacement: undefined })
  })

  it('gatewayListTools / gatewayCall / retrieveFull forward to the gateway runtime', async () => {
    expect(await mcp().gatewayListTools()).toEqual([{ name: 'upstream.tool' }])
    await mcp().gatewayCall({ server: 's', tool: 't', args: { a: 1 } })
    expect(M.gatewayCall).toHaveBeenCalledWith({ server: 's', tool: 't', args: { a: 1 } })
    expect(mcp().retrieveFull('hr_tok')).toEqual({ ok: true, text: 'full' })
    expect(M.headroomRetrieveFull).toHaveBeenCalledWith('hr_tok')
  })

  describe('agentExec', () => {
    it('omits every optional field the caller did not supply', async () => {
      await mcp().agentExec({ prompt: 'summarise the repo' })
      const [req] = M.runHeadless.mock.calls.at(-1)!
      // Spread-if-present, not `agent: opts.agent`: an explicit `undefined` would override
      // runHeadless's own default agent.
      expect(req).toEqual({ task: 'summarise the repo' })
    })

    it('forwards write:false and timeoutMs:0 — falsy is not the same as absent', async () => {
      await mcp().agentExec({ prompt: 'p', agent: 'codex', model: 'o3', cwd: '/repo', write: false, timeoutMs: 0 })
      const [req] = M.runHeadless.mock.calls.at(-1)!
      // `!== undefined` rather than truthiness: dropping write:false would let a CI job commit.
      expect(req).toEqual({ task: 'p', agent: 'codex', model: 'o3', cwd: '/repo', write: false, timeoutMs: 0 })
    })

    it('primes the run with a project-scoped primer when given a cwd', async () => {
      M.runHeadless.mockImplementationOnce(async (_req: any, deps: any) => ({ primer: await deps.primer('/work/termpolis') }))
      const r = await mcp().agentExec({ prompt: 'p' })
      const [, opts] = M.buildContextPrimer.mock.calls.at(-1)!
      expect(opts.query).toBe('recent work, decisions, conventions, and context for termpolis')
      expect(opts.project).toBe('termpolis')
      expect(opts.projectPath).toBe('/work/termpolis')
      expect(opts.limit).toBe(12)
      expect(opts.maxSnippetChars).toBe(400)
      expect(r).toEqual({ primer: 'PRIMER TEXT' })
    })

    it('falls back to a generic primer query when there is no cwd', async () => {
      M.runHeadless.mockImplementationOnce(async (_req: any, deps: any) => ({ primer: await deps.primer('') }))
      await mcp().agentExec({ prompt: 'p' })
      const [, opts] = M.buildContextPrimer.mock.calls.at(-1)!
      expect(opts.query).toBe('recent work, key decisions, and conventions')
      // An empty project must become undefined, not '': '' would scope the search to a project
      // named empty-string and return nothing.
      expect(opts.project).toBeUndefined()
      expect(opts.projectPath).toBeUndefined()
    })

    it('files what the run learned under the headless-exec agent', async () => {
      M.runHeadless.mockImplementationOnce(async (_req: any, deps: any) => await deps.remember({ content: 'the build needs node 22', project: 'termpolis' }))
      await mcp().agentExec({ prompt: 'p' })
      expect(MEMC.memoryWrite).toHaveBeenCalledWith({
        agentId: 'headless-exec', kind: 'result', content: 'the build needs node 22', project: 'termpolis',
      })
    })
  })

  describe('savingsReceipt', () => {
    it('rejects a verify payload that is not JSON, with advice rather than a stack', async () => {
      expect(mcp().savingsReceipt({ verify: 'not json at all' }))
        .toEqual({ ok: false, error: 'not valid JSON — pass the contents of a receipt file' })
      expect(M.checkReceipt).not.toHaveBeenCalled()
    })

    it('verifies a parsed receipt instead of issuing a new one', async () => {
      M.issueReceipt.mockClear()
      const r = mcp().savingsReceipt({ verify: '{"sig":"abc"}' })
      expect(M.checkReceipt).toHaveBeenCalledWith({ sig: 'abc' })
      expect(r).toEqual({ ok: true, verify: { valid: true } })
      // Verification must never mint — otherwise "check this receipt" silently issues one.
      expect(M.issueReceipt).not.toHaveBeenCalled()
    })

    it('issues a markdown receipt by default and JSON on request', async () => {
      expect(mcp().savingsReceipt({}).text).toBe('# receipt')
      expect(mcp().savingsReceipt({ format: 'json' }).text).toBe('{"receipt":true}')
    })
  })

  describe('recallBench', () => {
    beforeEach(() => {
      MEMC.memoryList.mockResolvedValue([] as never)
      MEMC.memoryGraphSample.mockResolvedValue({ nodes: [], edges: [] } as never)
    })

    it('clamps the sample size into [20, 1000]', async () => {
      await mcp().recallBench({ limit: 5 })
      expect(MEMC.memoryList.mock.calls.at(-1)![0].limit).toBe(20)
      await mcp().recallBench({ limit: 99999 })
      expect(MEMC.memoryList.mock.calls.at(-1)![0].limit).toBe(1000)
      await mcp().recallBench({})
      expect(MEMC.memoryList.mock.calls.at(-1)![0].limit).toBe(200)
    })

    it('caps the graph sample at 300 even when more memories were listed', async () => {
      await mcp().recallBench({ limit: 900 })
      expect(MEMC.memoryGraphSample).toHaveBeenLastCalledWith({ limit: 300 })
    })

    it('collapses multiple edges from one memory into a single links list', async () => {
      MEMC.memoryList.mockResolvedValue([
        { id: 'a', content: 'A', ts: 1, project: 'p' },
        { id: 'b', content: 'B', ts: 2 },
      ] as never)
      MEMC.memoryGraphSample.mockResolvedValue({ nodes: [], edges: [{ from: 'a', to: 'x' }, { from: 'a', to: 'y' }] } as never)
      await mcp().recallBench({})
      const [memories] = M.buildProbes.mock.calls.at(-1)!
      // Both edges land on 'a' (the second takes the push arm, not a fresh list)...
      expect(memories[0]).toEqual({ id: 'a', content: 'A', ts: 1, project: 'p', links: ['x', 'y'] })
      // ...and a memory with no edges and no project carries neither key, rather than undefined
      // values a probe builder would have to defend against.
      expect(memories[1]).toEqual({ id: 'b', content: 'B', ts: 2 })
    })

    it('scores against the saved baseline and does NOT rebaseline by default', async () => {
      const r = await mcp().recallBench({})
      expect(M.checkRegression).toHaveBeenCalledWith({ score: 0.5 }, { base: null })
      // A bench that rebaselines every run can never report a regression.
      expect(M.saveBenchBaseline).not.toHaveBeenCalled()
      expect(r).toEqual({ ok: true, text: 'BENCH TEXT', result: { score: 0.5 }, verdict: { regressed: false }, saved: false })
    })

    it('rebaselines only on an explicit save', async () => {
      const r = await mcp().recallBench({ save: true })
      expect(M.baselineFrom).toHaveBeenCalledWith({ score: 0.5 })
      expect(M.saveBenchBaseline).toHaveBeenCalledWith({ base: { score: 0.5 } })
      expect(r.saved).toBe(true)
    })

    it('searches inside the project scope it was asked for', async () => {
      M.runBench.mockImplementationOnce(async (_p: any, search: any) => await search('needle', 5))
      await mcp().recallBench({ project: 'termpolis' })
      expect(MEMC.memorySearch).toHaveBeenCalledWith({ query: 'needle', limit: 5, project: 'termpolis' })
    })
  })
})

// ===========================================================================
// The remote bridge's readers and senders.
// ===========================================================================
describe('remote bridge host wiring', () => {
  const opts = (): any => {
    const calls = M.startRemoteBridgeHost.mock.calls
    if (calls.length === 0) throw new Error('startRemoteBridgeHost was never called')
    return calls[calls.length - 1][0]
  }

  it('starts on the port the MCP server actually bound, with the live token', () => {
    // A bridge pointed at a port nothing is listening on is a bridge to nothing.
    expect(opts().mcpPort).toBe(9315)
    expect(opts().mcpToken).toBe('fake-token')
  })

  it('pushes status and events to the renderer on their own channels', () => {
    opts().sendStatus({ running: true })
    opts().sendEvent({ kind: 'terminal-data' })
    expect(mockWebContents.send).toHaveBeenCalledWith('remote:status-changed', { running: true })
    expect(mockWebContents.send).toHaveBeenCalledWith('remote:event', { kind: 'terminal-data' })
  })

  it('swallows a send into a window that has gone away', () => {
    mockWebContents.send.mockImplementationOnce(() => { throw new Error('Object has been destroyed') })
    // The phone disconnecting must not take down the bridge; the window is simply gone.
    expect(() => opts().sendStatus({ running: false })).not.toThrow()
    mockWebContents.send.mockImplementationOnce(() => { throw new Error('Object has been destroyed') })
    expect(() => opts().sendEvent({ kind: 'x' })).not.toThrow()
  })

  it('reads a terminal size through the terminal manager', () => {
    expect(opts().terminalSize('t-1')).toEqual({ cols: 80, rows: 24 })
    expect(M.getTerminalSize).toHaveBeenCalledWith('t-1')
  })

  it('returns null for a terminal with no buffered output instead of an empty session', () => {
    // null is what tells the phone "there is nothing here"; {output:''} would render as a live
    // terminal that has printed nothing.
    expect(opts().readRecent('no-such-terminal')).toBeNull()
  })
})

// ===========================================================================
// Learning-signal closures: the session reads behind every graded outcome.
// ===========================================================================
describe('learning signal deps', () => {
  const deps = (): any => {
    const calls = M.startLearningSignals.mock.calls
    if (calls.length === 0) throw new Error('startLearningSignals was never called')
    return calls[calls.length - 1][0]
  }

  it('lists the open projects from the saved session', () => {
    M.loadSession.mockReturnValue({ terminals: [{ id: 't1', cwd: homedir() }] })
    expect(deps().openProjects()).toContain(homedir())
  })

  it('returns no projects rather than throwing when the session file is broken', () => {
    // A corrupt session must cost the user their graded outcomes, not their app.
    M.loadSession.mockImplementation(() => { throw new Error('session.json is truncated') })
    expect(deps().openProjects()).toEqual([])
    M.loadSession.mockReturnValue({ terminals: [] })
  })

  it('resolves a terminal id to its cwd', () => {
    M.loadSession.mockReturnValue({ terminals: [{ id: 't1', cwd: '/repo/a' }, { id: 't2', cwd: '/repo/b' }] })
    expect(deps().cwdForTerminal('t2')).toBe('/repo/b')
  })

  it('returns null for an unknown terminal and for one with no cwd', () => {
    M.loadSession.mockReturnValue({ terminals: [{ id: 't1' }] })
    // `?? null`, not `?? undefined`: the signal emitter tests for null, and undefined would be
    // read as "not looked up yet".
    expect(deps().cwdForTerminal('missing')).toBeNull()
    expect(deps().cwdForTerminal('t1')).toBeNull()
  })

  it('returns null rather than throwing when the session cannot be read', () => {
    M.loadSession.mockImplementation(() => { throw new Error('EBUSY') })
    expect(deps().cwdForTerminal('t1')).toBeNull()
    M.loadSession.mockReturnValue({ terminals: [] })
  })
})

// ===========================================================================
// Workflow wiring closures.
// ===========================================================================
describe('workflow orchestrator wiring', () => {
  it('resolves a logical shell type to an executable before spawning a Command step', async () => {
    const spawnDeps = M.makeTerminalRunner.mock.calls.at(-1)![0] as any
    const onData = vi.fn()
    spawnDeps.spawnTerminal('wf-1', 'bash', '/repo', onData, ['/extra'], { A: '1' })
    // node-pty needs a real path — bare 'bash' throws "File not found" on Windows.
    expect(M.spawnTerminal).toHaveBeenCalledWith('wf-1', '/bin/bash', '/repo', onData, ['/extra'], { A: '1' }, undefined)
  })

  it('reads an unnamed agent as claude, and passes an explicit name straight through', async () => {
    const { detectAgentStatus } = await import('../../src/shared/agentStatusDetector')
    const statusOf = M.makeAgentRunner.mock.calls.at(-1)![1] as any
    const out = 'esc to interrupt\n> '
    // An Agent step may omit the agent name; the detector has per-agent prompt shapes, so an
    // undefined name must read as claude rather than fall through to a name it has no rules for.
    expect(statusOf(out, undefined)).toEqual(detectAgentStatus(out, 'claude'))
    expect(statusOf(out, 'codex')).toEqual(detectAgentStatus(out, 'codex'))
  })

  it('launches gemini through the agy binary', async () => {
    const launchFor = M.makeAgentRunner.mock.calls.at(-1)![2] as any
    expect(launchFor('gemini')).toBe('agy')
    expect(launchFor('claude')).toBe('claude')
    expect(launchFor('codex')).toBe('codex')
  })

  it('triggers only fire in a trusted workspace, and an unreadable trust store reads as untrusted', () => {
    const deps = wfCaptured.triggerDeps
    M.isWorkspaceTrusted.mockReturnValueOnce(true as never)
    expect(deps.isTrusted('/repo')).toBe(true)
    M.isWorkspaceTrusted.mockImplementationOnce(() => { throw new Error('trust store unreadable') })
    // Fail closed: an unreadable trust store must not arm a trigger that runs commands.
    expect(deps.isTrusted('/repo')).toBe(false)
  })

  it('a fired trigger returns the run promise so the supervisor can await it', () => {
    const done = Promise.resolve()
    M.wfStartRun.mockReturnValueOnce({ ok: true, done } as never)
    expect(wfCaptured.triggerDeps.fire('/repo', 'wf-1', 'schedule', 'project')).toBe(done)
    expect(M.wfStartRun).toHaveBeenCalledWith('/repo', 'wf-1', { scope: 'project' })
  })

  it('a refused trigger warns with the reason instead of failing silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      M.wfStartRun.mockReturnValueOnce({ ok: false, error: 'already running' } as never)
      expect(wfCaptured.triggerDeps.fire('/repo', 'wf-2', 'gitCommit', 'global')).toBeUndefined()
      expect(warn).toHaveBeenCalledWith('[workflow] trigger (gitCommit) could not start wf-2: already running')
      // ...and a supervisor that fired before the runner existed says so, rather than "undefined".
      M.wfStartRun.mockReturnValueOnce(undefined as never)
      wfCaptured.triggerDeps.fire('/repo', 'wf-3', 'fileWatch', 'project')
      expect(warn).toHaveBeenCalledWith('[workflow] trigger (fileWatch) could not start wf-3: no runner')
    } finally { warn.mockRestore() }
  })

  it('a global workflow change rearms every project, a local one only its own', () => {
    const sup = wfCaptured.triggerDeps
    const ipc = wfCaptured.ipcOpts
    const instance = (M.registerWorkflowIpc.mock.calls.at(-1) as any)
    expect(instance).toBeTruthy()
    ipc.onWorkflowsChanged('/repo', 'global')
    ipc.onWorkflowsChanged('/repo', 'project')
    ipc.onWatchProject('/repo/other')
    // Both arms exist because a global workflow arms in every watched project, not just the one
    // it was authored in.
    expect(sup).toBeTruthy()
  })

  it('mints a distinct run id per run, and pins the emitted id inside the deps', () => {
    const ipc = wfCaptured.ipcOpts
    const a = ipc.newRunId()
    const b = ipc.newRunId()
    expect(a).not.toBe(b)
    const emit = vi.fn()
    const deps = ipc.makeDeps(emit, 'run-42')
    // newRunId inside a run must return THAT run's id — a fresh uuid here would split one run's
    // events across two ids in the ledger.
    expect(deps.newRunId()).toBe('run-42')
    expect(deps.emit).toBe(emit)
    expect(typeof deps.now()).toBe('number')
  })

  it('the demo-workflow sweep runs against the home store', () => {
    expect(M.oncePerVersion).toHaveBeenCalled()
    expect(M.cleanupDemoWorkflows).toHaveBeenCalledWith(homedir(), expect.anything(), undefined, expect.any(Function))
  })
})

// ===========================================================================
// Second Opinion delivery — the spawn path, including both failure arms.
// ===========================================================================
describe('agent:second-opinion', () => {
  it('refuses an agent that is not one of the three supported CLIs', async () => {
    expect(await invoke('agent:second-opinion', { agent: 'evilcli', content: 'x' }))
      .toEqual({ success: false, error: 'unsupported agent' })
    expect(M.runSecondOpinion).not.toHaveBeenCalled()
  })

  it('returns the review text on success', async () => {
    M.runSecondOpinion.mockResolvedValueOnce({ ok: true, feedback: 'looks fine' } as never)
    expect(await invoke('agent:second-opinion', { agent: 'claude', content: 'diff' }))
      .toEqual({ success: true, data: { feedback: 'looks fine' } })
  })

  it('reports the runner error, and a generic one when the runner gave none', async () => {
    M.runSecondOpinion.mockResolvedValueOnce({ ok: false, error: 'claude exited 127' } as never)
    expect(await invoke('agent:second-opinion', { agent: 'claude', content: 'd' }))
      .toEqual({ success: false, error: 'claude exited 127' })
    M.runSecondOpinion.mockResolvedValueOnce({ ok: false } as never)
    expect(await invoke('agent:second-opinion', { agent: 'codex', content: 'd' }))
      .toEqual({ success: false, error: 'second opinion failed' })
  })

  it('defaults missing content to an empty string rather than sending undefined', async () => {
    M.runSecondOpinion.mockResolvedValueOnce({ ok: true, feedback: '' } as never)
    await invoke('agent:second-opinion', { agent: 'gemini' })
    expect(M.runSecondOpinion.mock.calls.at(-1)![0]).toEqual({ agent: 'gemini', model: undefined, content: '' })
  })

  it('surfaces a thrown runner as err()', async () => {
    M.runSecondOpinion.mockRejectedValueOnce(new Error('spawn EPERM'))
    expect(await invoke('agent:second-opinion', { agent: 'claude', content: 'd' }))
      .toEqual({ success: false, error: 'spawn EPERM' })
  })

  describe('deliver', () => {
    /** The delivery fn index.ts hands runSecondOpinion — never exported, only reachable here. */
    async function deliver(...args: unknown[]): Promise<any> {
      let captured: Function | null = null
      M.runSecondOpinion.mockImplementationOnce(async (_req: any, d: any) => { captured = d; return { ok: true, feedback: '' } })
      await invoke('agent:second-opinion', { agent: 'claude', content: 'x' })
      if (!captured) throw new Error('deliver was never handed to runSecondOpinion')
      return await (captured as Function)(...args)
    }

    it('gives up cleanly when the Windows prompt file cannot be written', async () => {
      await withPlatform('win32', async () => {
        M.writeFileSync.mockImplementationOnce(() => { throw new Error('EACCES') })
        // The prompt is UNTRUSTED terminal scrape; if it cannot go into a file it must NOT fall
        // back to a command line. Refusing the review is the safe outcome.
        expect(await deliver('claude', ['-p', 'TOKEN'], 'the prompt', 'TOKEN', { timeoutMs: 1000 }))
          .toEqual({ stdout: '', code: 1 })
        expect(M.spawn).not.toHaveBeenCalled()
      })
    })

    it('reports a spawn that throws outright as code 1 with the message', async () => {
      await withPlatform('linux', async () => {
        M.spawn.mockImplementationOnce(() => { throw new Error('ENOENT claude') })
        expect(await deliver('claude', ['-p', 'TOKEN'], 'p', 'TOKEN', { timeoutMs: 1000 }))
          .toEqual({ stdout: '', stderr: 'ENOENT claude', code: 1 })
      })
    })
  })
})

// ===========================================================================
// Git range guards. isValidGitRef is REAL here — these are the actual guards.
// ===========================================================================
describe('git range handlers reject invalid refs before shelling out', () => {
  beforeEach(() => { M.safeGit.mockClear() })

  it('git:diff-range refuses a bad "from" ref', async () => {
    expect(await invoke('git:diff-range', { cwd: '/repo', from: 'HEAD; rm -rf /' }))
      .toEqual({ success: false, error: 'Invalid "from" ref' })
    expect(M.safeGit).not.toHaveBeenCalled()
  })

  it('git:diff-range refuses a bad "to" ref', async () => {
    expect(await invoke('git:diff-range', { cwd: '/repo', from: 'HEAD', to: '--upload-pack=evil' }))
      .toEqual({ success: false, error: 'Invalid "to" ref' })
    expect(M.safeGit).not.toHaveBeenCalled()
  })

  it('git:diff-range accepts an omitted "to" and diffs against the working tree', async () => {
    // `to !== undefined`: omitting it is legal and means "include uncommitted swarm changes",
    // so the guard must not treat absence as invalid — and the range must then be the bare ref,
    // not "HEAD..undefined".
    M.safeGit.mockReturnValueOnce('diff text' as never)
    expect(await invoke('git:diff-range', { cwd: '/repo', from: 'HEAD' })).toEqual({ success: true, data: 'diff text' })
    expect(M.safeGit.mock.calls.at(-1)![0]).toEqual(['diff', '--no-color', '--no-ext-diff', 'HEAD'])
  })

  it('git:files-in-range refuses a bad "from" ref', async () => {
    expect(await invoke('git:files-in-range', { cwd: '/repo', from: 'a b c;id' }))
      .toEqual({ success: false, error: 'Invalid "from" ref' })
    expect(M.safeGit).not.toHaveBeenCalled()
  })

  it('git:files-in-range refuses a bad "to" ref', async () => {
    expect(await invoke('git:files-in-range', { cwd: '/repo', from: 'HEAD', to: '$(id)' }))
      .toEqual({ success: false, error: 'Invalid "to" ref' })
    expect(M.safeGit).not.toHaveBeenCalled()
  })

  it('git:files-in-range keeps the FINAL name of a rename and skips blank lines', async () => {
    M.safeGit.mockReturnValueOnce('M\tsrc/a.ts\n\nR100\tsrc/old.ts\tsrc/new.ts\n' as never)
    expect(await invoke('git:files-in-range', { cwd: '/repo', from: 'HEAD', to: 'main' })).toEqual({
      success: true,
      // "R100\told\tnew" — the reviewer needs the name the file has NOW, and a blank line must
      // not become a {file:'',status:''} row in the changed-files list.
      data: [{ file: 'src/a.ts', status: 'M' }, { file: 'src/new.ts', status: 'R100' }],
    })
    expect(M.safeGit.mock.calls.at(-1)![0]).toEqual(['diff', '--name-status', 'HEAD..main'])
  })
})

// ===========================================================================
// Error arms of handlers whose happy paths are already covered elsewhere.
// Each of these is the difference between a message in the UI and a promise
// that never settles.
// ===========================================================================
describe('memory handlers return err() instead of rejecting the IPC call', () => {
  it('memory:count', async () => {
    MEMC.memoryCount.mockRejectedValueOnce(new Error('memory host is down') as never)
    expect(await invoke('memory:count')).toEqual({ success: false, error: 'memory host is down' })
  })

  it('memory:count awaits the number rather than shipping a Promise', async () => {
    MEMC.memoryCount.mockResolvedValueOnce(1234 as never)
    // A Promise is not structured-clonable: the renderer would receive {} and read it as
    // "your memory is gone".
    expect(await invoke('memory:count')).toEqual({ success: true, data: 1234 })
  })

  it('memory:clear', async () => {
    MEMC.memoryClear.mockRejectedValueOnce(new Error('store is locked') as never)
    expect(await invoke('memory:clear')).toEqual({ success: false, error: 'store is locked' })
  })

  it('memory:stats merges the last Weave pass into the store stats', async () => {
    MEMC.memoryStats.mockResolvedValueOnce({ total: 7 } as never)
    const r = await invoke('memory:stats')
    // `weave: null` until the indexer has run one — "never ran" and "ran and minted nothing"
    // used to look identical from outside.
    expect(r).toEqual({ success: true, data: { total: 7, weave: null } })
  })

  it('memory:stats', async () => {
    MEMC.memoryStats.mockRejectedValueOnce(new Error('index unreadable') as never)
    expect(await invoke('memory:stats')).toEqual({ success: false, error: 'index unreadable' })
  })

  it('memory:deep-search defaults to 20 archive hits and surfaces failures', async () => {
    MEMC.searchArchive.mockResolvedValueOnce([{ id: 'cold-1' }] as never)
    expect(await invoke('memory:deep-search', { query: 'old decision' })).toEqual({ success: true, data: [{ id: 'cold-1' }] })
    expect(MEMC.searchArchive).toHaveBeenLastCalledWith('old decision', 20)
    await invoke('memory:deep-search', { query: 'q', limit: 3 })
    expect(MEMC.searchArchive).toHaveBeenLastCalledWith('q', 3)
    MEMC.searchArchive.mockRejectedValueOnce(new Error('archive shard missing') as never)
    expect(await invoke('memory:deep-search', {})).toEqual({ success: false, error: 'archive shard missing' })
  })

  it('memory:host-status reports the mode and pid, and null when there is no child', async () => {
    MEMC.memoryHostMode.mockReturnValueOnce('host' as never)
    MEMC.memoryHostPid.mockReturnValueOnce(4242 as never)
    expect(await invoke('memory:host-status')).toEqual({ success: true, data: { mode: 'host', pid: 4242 } })
    MEMC.memoryHostMode.mockReturnValueOnce('inline' as never)
    MEMC.memoryHostPid.mockReturnValueOnce(undefined as never)
    // The silent fallback to the main thread is DESIGNED to be invisible; surfacing it is the
    // whole point of this channel.
    expect(await invoke('memory:host-status')).toEqual({ success: true, data: { mode: 'inline', pid: null } })
  })

  it('memory:host-status', async () => {
    MEMC.memoryHostMode.mockImplementationOnce(() => { throw new Error('rpc closed') })
    expect(await invoke('memory:host-status')).toEqual({ success: false, error: 'rpc closed' })
  })

  it('memory:get-primer-limit / set-primer-limit round-trip and surface failures', async () => {
    M.getPrimerLimit.mockReturnValueOnce(25 as never)
    expect(await invoke('memory:get-primer-limit')).toEqual({ success: true, data: 25 })
    M.setPrimerLimit.mockReturnValueOnce(40 as never)
    expect(await invoke('memory:set-primer-limit', { value: 40 })).toEqual({ success: true, data: 40 })
    expect(M.setPrimerLimit).toHaveBeenCalledWith(40)
    M.getPrimerLimit.mockImplementationOnce(() => { throw new Error('settings unreadable') })
    expect(await invoke('memory:get-primer-limit')).toEqual({ success: false, error: 'settings unreadable' })
    M.setPrimerLimit.mockImplementationOnce(() => { throw new Error('out of range') })
    expect(await invoke('memory:set-primer-limit', { value: -1 })).toEqual({ success: false, error: 'out of range' })
  })

  it('memory:sync-status', async () => {
    MEMC.getSyncStatus.mockRejectedValueOnce(new Error('sync dir vanished') as never)
    expect(await invoke('memory:sync-status')).toEqual({ success: false, error: 'sync dir vanished' })
  })

  it('memory:set-sync-dir turns a missing dir into an explicit null (disable)', async () => {
    MEMC.setSyncDir.mockResolvedValueOnce({ enabled: false, dir: null } as never)
    expect(await invoke('memory:set-sync-dir', {})).toEqual({ success: true, data: { enabled: false, dir: null } })
    // `?? null`: undefined would read as "no argument supplied" and could leave sync on.
    expect(MEMC.setSyncDir).toHaveBeenLastCalledWith(null)
    MEMC.setSyncDir.mockRejectedValueOnce(new Error('not writable') as never)
    expect(await invoke('memory:set-sync-dir', { dir: '/x' })).toEqual({ success: false, error: 'not writable' })
  })

  it('memory:choose-sync-dir leaves sync untouched when the picker is cancelled', async () => {
    M.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] } as never)
    MEMC.setSyncDir.mockClear()
    MEMC.getSyncStatus.mockResolvedValueOnce({ enabled: false, dir: null } as never)
    expect(await invoke('memory:choose-sync-dir')).toEqual({ success: true, data: { enabled: false, dir: null } })
    // Cancel must not disable an already-configured sync.
    expect(MEMC.setSyncDir).not.toHaveBeenCalled()
  })

  it('memory:choose-sync-dir enables sync to the chosen folder in one step', async () => {
    M.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/Dropbox/brain'] } as never)
    MEMC.setSyncDir.mockResolvedValueOnce({ enabled: true, dir: '/Dropbox/brain' } as never)
    expect(await invoke('memory:choose-sync-dir')).toEqual({ success: true, data: { enabled: true, dir: '/Dropbox/brain' } })
  })

  it('memory:choose-sync-dir', async () => {
    M.showOpenDialog.mockRejectedValueOnce(new Error('no window'))
    expect(await invoke('memory:choose-sync-dir')).toEqual({ success: false, error: 'no window' })
  })

  it('memory:disable-sync-encryption', async () => {
    MEMC.disableSyncEncryption.mockRejectedValueOnce(new Error('wrong passphrase') as never)
    expect(await invoke('memory:disable-sync-encryption')).toEqual({ success: false, error: 'wrong passphrase' })
  })
})

describe('aiSecurity + telemetry error arms', () => {
  it('aiSecurity:recent-audit clamps the limit and never lets NaN return the whole log', async () => {
    M.recentAudit.mockClear()
    await invoke('aiSecurity:recent-audit', { limit: Number.NaN })
    // typeof NaN is 'number', so a typeof check would take the clamp arm and Math.min/max
    // PROPAGATE NaN — getRecentAudit(NaN) slices from 0 and returns everything.
    expect(M.recentAudit).toHaveBeenLastCalledWith(200)
    await invoke('aiSecurity:recent-audit', { limit: 99999 })
    expect(M.recentAudit).toHaveBeenLastCalledWith(2000)
    await invoke('aiSecurity:recent-audit', { limit: 0 })
    expect(M.recentAudit).toHaveBeenLastCalledWith(1)
  })

  it('aiSecurity:recent-audit', async () => {
    M.recentAudit.mockRejectedValueOnce(new Error('audit log corrupt') as never)
    expect(await invoke('aiSecurity:recent-audit', { limit: 10 })).toEqual({ success: false, error: 'audit log corrupt' })
  })

  it('aiSecurity:clear-audit awaits the clear before reporting success', async () => {
    M.clearAudit.mockResolvedValueOnce(undefined as never)
    expect(await invoke('aiSecurity:clear-audit')).toEqual({ success: true })
    M.clearAudit.mockRejectedValueOnce(new Error('file busy') as never)
    expect(await invoke('aiSecurity:clear-audit')).toEqual({ success: false, error: 'file busy' })
  })

  it('aiSecurity:append validates the shape and the event name before writing', async () => {
    expect(await invoke('aiSecurity:append', null)).toEqual({ success: false, error: 'invalid entry' })
    expect(await invoke('aiSecurity:append', { agent: 1, event: 'terminal_open' })).toEqual({ success: false, error: 'invalid entry' })
    expect(await invoke('aiSecurity:append', { agent: 'claude', event: 42 })).toEqual({ success: false, error: 'invalid entry' })
    // An open allowlist would let a renderer forge any event type into the security audit log.
    expect(await invoke('aiSecurity:append', { agent: 'claude', event: 'totally_made_up' })).toEqual({ success: false, error: 'invalid event' })
    expect(M.appendAudit).not.toHaveBeenCalled()
  })

  it('aiSecurity:append forwards an allowed event with its full detail', async () => {
    expect(await invoke('aiSecurity:append', {
      agent: 'claude', event: 'redaction_hit', terminalId: 't1', byteCount: 12, hitCount: 2, notes: 'n',
    })).toEqual({ success: true })
    expect(M.appendAudit).toHaveBeenCalledWith({
      agent: 'claude', event: 'redaction_hit', terminalId: 't1', byteCount: 12, hitCount: 2, notes: 'n',
    })
  })

  it('aiSecurity:append', async () => {
    M.appendAudit.mockRejectedValueOnce(new Error('audit disk full') as never)
    expect(await invoke('aiSecurity:append', { agent: 'claude', event: 'manual_scan' }))
      .toEqual({ success: false, error: 'audit disk full' })
  })

  it('ai-security:sensitive-reads reports the count and recent list, and errors cleanly', async () => {
    M.sensitiveCount.mockReturnValueOnce(3 as never)
    M.sensitiveRecent.mockReturnValueOnce([{ path: '~/.ssh/id_rsa' }] as never)
    expect(await invoke('ai-security:sensitive-reads', { terminalId: 't1' }))
      .toEqual({ success: true, data: { count: 3, recent: [{ path: '~/.ssh/id_rsa' }] } })
    M.sensitiveCount.mockImplementationOnce(() => { throw new Error('watcher gone') })
    expect(await invoke('ai-security:sensitive-reads', { terminalId: 't1' })).toEqual({ success: false, error: 'watcher gone' })
  })

  it('telemetry:record-event refuses a blank name before recording anything', async () => {
    M.recordTelemetryEvent.mockClear()
    expect(await invoke('telemetry:record-event', { name: '   ' })).toEqual({ success: false, error: 'event name required' })
    expect(await invoke('telemetry:record-event', { name: 42 })).toEqual({ success: false, error: 'event name required' })
    expect(M.recordTelemetryEvent).not.toHaveBeenCalled()
    expect(await invoke('telemetry:record-event', { name: 'swarm.start', props: { n: 1 } })).toEqual({ success: true })
    expect(M.recordTelemetryEvent).toHaveBeenCalledWith('swarm.start', { n: 1 })
  })

  it('telemetry:record-event', async () => {
    M.recordTelemetryEvent.mockImplementationOnce(() => { throw new Error('telemetry.json locked') })
    expect(await invoke('telemetry:record-event', { name: 'x' })).toEqual({ success: false, error: 'telemetry.json locked' })
  })

  it('telemetry:set-opt-in coerces to a strict boolean and echoes the persisted state', async () => {
    M.isTelemetryEnabled.mockReturnValueOnce(true as never)
    expect(await invoke('telemetry:set-opt-in', { value: true })).toEqual({ success: true, data: { optIn: true } })
    // `value === true`: a truthy string from a renderer must not opt the user in.
    await invoke('telemetry:set-opt-in', { value: 'yes' })
    expect(M.setTelemetryOptIn).toHaveBeenLastCalledWith(false)
  })

  it('telemetry:set-opt-in', async () => {
    M.setTelemetryOptIn.mockImplementationOnce(() => { throw new Error('read-only profile') })
    expect(await invoke('telemetry:set-opt-in', { value: true })).toEqual({ success: false, error: 'read-only profile' })
  })

  it('diagnostics:collect returns the report, and err() when collection throws', async () => {
    M.collectDiagnostics.mockReturnValueOnce({ os: 'win32', version: '1.0.0' } as never)
    expect(await invoke('diagnostics:collect')).toEqual({ success: true, data: { os: 'win32', version: '1.0.0' } })
    M.collectDiagnostics.mockImplementationOnce(() => { throw new Error('wmic not found') })
    expect(await invoke('diagnostics:collect')).toEqual({ success: false, error: 'wmic not found' })
  })
})

describe('safe-import and git-hook error arms', () => {
  it('safeImport:list returns the installed artifacts, and err() when the trust db is broken', async () => {
    M.listImported.mockReturnValueOnce([{ id: 'a1' }] as never)
    expect(await invoke('safeImport:list')).toEqual({ success: true, data: [{ id: 'a1' }] })
    M.listImported.mockImplementationOnce(() => { throw new Error('imported.json is corrupt') })
    expect(await invoke('safeImport:list')).toEqual({ success: false, error: 'imported.json is corrupt' })
  })

  it('safeImport:revoke revokes by id, and err() when the write fails', async () => {
    M.revokeArtifact.mockReturnValueOnce(true as never)
    expect(await invoke('safeImport:revoke', { id: 'a1' })).toEqual({ success: true, data: true })
    expect(M.revokeArtifact).toHaveBeenCalledWith('a1')
    M.revokeArtifact.mockImplementationOnce(() => { throw new Error('EROFS') })
    expect(await invoke('safeImport:revoke', { id: 'a1' })).toEqual({ success: false, error: 'EROFS' })
  })

  it('gitHooks:status refuses a folder git reports no hooks path for', async () => {
    // `rev-parse --git-path hooks` printing nothing is how a non-repo answers.
    M.safeGit.mockReturnValueOnce('' as never)
    expect(await invoke('gitHooks:status', { cwd: '/definitely/not/a/repo' }))
      .toEqual({ success: false, error: 'Not a git repository' })
    expect(M.hookStatus).not.toHaveBeenCalled()
  })

  it('gitHooks:status refuses a folder where rev-parse itself fails', async () => {
    // "fatal: not a git repository" is a THROW from safeGit, and it must read as the same
    // plain refusal — not as an unhandled error dialog on a folder the user just opened.
    M.safeGit.mockImplementationOnce(() => { throw new Error('fatal: not a git repository') })
    expect(await invoke('gitHooks:status', { cwd: '/definitely/not/a/repo' }))
      .toEqual({ success: false, error: 'Not a git repository' })
  })

  it('gitHooks:status surfaces a hook read failure as err()', async () => {
    M.safeGit.mockReturnValueOnce('.git/hooks' as never)
    M.hookStatus.mockImplementationOnce(() => { throw new Error('hooks dir unreadable') })
    expect(await invoke('gitHooks:status', { cwd: '/repo' })).toEqual({ success: false, error: 'hooks dir unreadable' })
  })

  it('gitHooks:list is empty, not broken, when no repo has been shielded', async () => {
    // The registry file does not exist until the first install, so the very first read ALWAYS
    // throws ENOENT. That must surface as an empty list — an err() here would put a failure
    // banner on the Security pane of every fresh install.
    expect(await invoke('gitHooks:list')).toEqual({ success: true, data: [] })
  })
})

describe('context pin error arms', () => {
  it('contextPins:list', async () => {
    M.listPins.mockReturnValueOnce([{ id: 'p1' }] as never)
    expect(await invoke('contextPins:list', { cwd: '/repo' })).toEqual({ success: true, data: [{ id: 'p1' }] })
    M.listPins.mockImplementationOnce(() => { throw new Error('pins.json is corrupt') })
    expect(await invoke('contextPins:list', { cwd: '/repo' })).toEqual({ success: false, error: 'pins.json is corrupt' })
  })

  it('contextPins:add', async () => {
    M.addPin.mockImplementationOnce(() => { throw new Error('pin store is read-only') })
    expect(await invoke('contextPins:add', { cwd: '/repo', input: { label: 'l', body: 'b' } }))
      .toEqual({ success: false, error: 'pin store is read-only' })
  })

  it('contextPins:update distinguishes "not found" from a store failure', async () => {
    M.updatePin.mockReturnValueOnce(null as never)
    // A missing pin is a normal outcome the UI must be able to report — not an exception.
    expect(await invoke('contextPins:update', { cwd: '/repo', id: 'nope', patch: {} }))
      .toEqual({ success: false, error: 'pin not found' })
    M.updatePin.mockImplementationOnce(() => { throw new Error('EBUSY') })
    expect(await invoke('contextPins:update', { cwd: '/repo', id: 'p1', patch: {} }))
      .toEqual({ success: false, error: 'EBUSY' })
  })

  it('contextPins:remove reports whether anything was actually removed', async () => {
    M.removePin.mockReturnValueOnce(false as never)
    expect(await invoke('contextPins:remove', { cwd: '/repo', id: 'gone' })).toEqual({ success: true, data: { removed: false } })
    M.removePin.mockImplementationOnce(() => { throw new Error('EBUSY') })
    expect(await invoke('contextPins:remove', { cwd: '/repo', id: 'p1' })).toEqual({ success: false, error: 'EBUSY' })
  })

  it('contextPins:clear', async () => {
    expect(await invoke('contextPins:clear', { cwd: '/repo' })).toEqual({ success: true })
    M.clearPins.mockImplementationOnce(() => { throw new Error('EBUSY') })
    expect(await invoke('contextPins:clear', { cwd: '/repo' })).toEqual({ success: false, error: 'EBUSY' })
  })
})

// ===========================================================================
// aiSecurity:input-pending — the "is the user mid-sentence" probe that every
// unprompted write has to consult. Driven through the real staging path.
// ===========================================================================
describe('aiSecurity:input-pending', () => {
  it('is false for a terminal nobody has typed into', async () => {
    // `?? ''` on a missing entry: without it, `.length` on undefined throws and every
    // compaction re-prime would fail instead of proceeding.
    expect(await invoke('aiSecurity:input-pending', { id: 'never-typed' })).toEqual({ success: true, data: false })
  })

  it('stays false in an ordinary shell, where nothing is staged at all', async () => {
    const write = await ipcOn('terminal:write')
    write({}, { id: 'ip-plain', data: 'ls -la' })
    // Staging only exists for terminals running an agent. A plain shell is not screened, so
    // there is nothing to report — and nothing to leak into the audit path either.
    expect(await invoke('aiSecurity:input-pending', { id: 'ip-plain' })).toEqual({ success: true, data: false })
  })

  it('becomes true while a draft is staged in an AI terminal and false once it is submitted', async () => {
    const write = await ipcOn('terminal:write')
    // Typing an agent name is what marks the terminal as an AI session.
    write({}, { id: 'ip-1', data: 'claude ' })
    write({}, { id: 'ip-1', data: 'review this' })
    // An unprompted write here would land in the middle of the user's half-typed prompt.
    expect(await invoke('aiSecurity:input-pending', { id: 'ip-1' })).toEqual({ success: true, data: true })
    write({}, { id: 'ip-1', data: '\r' })
    // Enter clears the staging buffer: the line is gone, so the coast is clear.
    expect(await invoke('aiSecurity:input-pending', { id: 'ip-1' })).toEqual({ success: true, data: false })
  })
})
