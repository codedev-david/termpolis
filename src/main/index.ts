import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, safeStorage, shell } from 'electron'
import { initMainSentry } from './sentry'
import { gpuPolicy } from './gpuPolicy'
import {
  initTelemetry,
  setOptIn as setTelemetryOptIn,
  isEnabled as isTelemetryEnabled,
  dailyLaunchPing,
  recordEvent as recordTelemetryEvent,
  recordUncleanExit,
} from './telemetry'
import { initCrashWatch, heartbeat as crashHeartbeat, markCleanExit, installCleanExitGuards } from './crashWatch'

// Force a stable app name. When launched via `electron out/main/index.js`
// (dev, E2E tests) Electron defaults to "Electron" for app.getName() and
// therefore stores userData under ~/AppData/Roaming/Electron instead of
// ~/AppData/Roaming/termpolis. That mismatch causes external callers
// (MCP clients, tests) to read a stale mcp-token from the wrong dir and
// hit 401. Pinning the name keeps userData consistent across all launch
// modes (unpacked, packaged, CI).
app.setName('termpolis')

// Windows taskbar identity. The NSIS installer stamps the Start-menu/desktop
// shortcut with an explicit AppUserModelID equal to build.appId. Windows groups
// taskbar buttons and resolves the taskbar/jump-list icon by that ID — but ONLY
// if the RUNNING process declares the SAME id. Without this call the process
// gets a default per-process id, Windows can't tie the live window to the
// installed shortcut, and the taskbar shows a GENERIC icon instead of ours.
// Must stay in sync with build.appId in package.json. No-op on macOS/Linux;
// optional-chained so a minimal `app` mock in unit tests can't trip on it.
app.setAppUserModelId?.('com.termpolis.app')

// Telemetry must initialize before Sentry — Sentry's gate reads from the
// persisted opt-in state. Without this ordering, the very first launch
// after install would never enable Sentry even after the user opts in,
// because the gate reads stale "false" before persisted state is loaded.
initTelemetry(app.getPath('userData'))
initMainSentry()

// Linux AppImage: the bundled chrome-sandbox lacks SUID root, which crashes on
// launch. Use Chromium's namespace sandbox instead (no root needed).
if (process.platform === 'linux' && (process.env.APPIMAGE || !process.env.CHROME_DEVEL_SANDBOX)) {
  app.commandLine.appendSwitch('no-sandbox')
}

// Linux blank/black-window safety net, as a testable policy (see gpuPolicy.ts). By DEFAULT this
// disables only VAAPI video decode/encode — the most-reported cause of a blank Electron window on
// Ubuntu, and free for us since we play no video — and leaves the GPU ON so xterm's WebGL renderer
// works. The FULL GPU disable is the documented TERMPOLIS_DISABLE_GPU=1 escape hatch for genuinely
// broken drivers. (Until now `--disable-gpu` was baked into the .deb launcher, forcing the slow DOM
// renderer on every Linux user and leaving this hatch dead — the executableArgs no longer do that.)
{
  const gpu = gpuPolicy(process.platform, process.env)
  if (gpu.disableVaapi) app.commandLine.appendSwitch('disable-features', 'VaapiVideoDecoder,VaapiVideoEncoder')
  if (gpu.disableHardwareAcceleration) app.disableHardwareAcceleration()
  if (gpu.disableGpuSwitch) app.commandLine.appendSwitch('disable-gpu')
}
import { join, dirname } from 'path'
import { homedir, release } from 'os'
import { writeFileSync, readFileSync, mkdirSync, readdirSync, statSync, unlinkSync, existsSync, appendFileSync, rmSync } from 'fs'
import { execSync, spawn } from 'child_process'
import { runSecondOpinion, secondOpinionSpawnPlan, type SecondOpinionAgent } from './secondOpinion'
import { detectAvailableShells, resolveShellExecutable } from './shellDetector'
import { spawnTerminal, killTerminal, writeToTerminal, resizeTerminal, killAll, getTerminalCwdAsync, getTerminalPid, computeWindowsPty } from './terminalManager'
import { getRecentEgress, recordEgress, clearEgress, pollAgentEgress, type EgressEndpoint } from './egressAudit'
import { refreshAllowedIps, attributeEgress } from './egressAttribute'
import {
  subscribeSensitiveReads,
  getReadCount as getSensitiveReadCount,
  getRecentReads as getRecentSensitiveReads,
  clearReadCount as clearSensitiveReadCount,
  type SensitiveReadEvent,
} from './sensitiveFileWatcher'
import {
  initAiSecurity,
  getSettings as getAiSecuritySettings,
  setAuditEnabled,
  scanText as aiSecurityScan,
  processOutboundChunk,
  appendAudit as aiSecurityAppend,
  getRecentAudit as aiSecurityRecent,
  clearAudit as aiSecurityClear,
  getAuditPath as aiSecurityAuditPath,
  AGENT_FACTS,
  detectGeminiAccount,
  setStrictGeminiPaidOnly,
  setCommitShield,
  setEgressGuard,
  setMemoryScrub,
  RULES as SECRET_RULES,
} from './aiSecurity'
import { scanStagedDiff, scanPushRange, blockMessage } from './commitScan'
import { deriveOutcome, type WorkEvent } from './outcomeSignals'
// Safe Import — static scan -> hash-pinned approval -> install into the agent configs.
import { scanImportArtifact, type Finding as ImportFinding, type RiskLevel as ImportRiskLevel } from './importScanner'
import { initImportTrust, artifactHash, isApproved, approveArtifact, revokeArtifact, listImported } from './importTrust'
import {
  classifyArtifact, supportedTargets, installArtifact, defaultInstallerDeps,
  type ArtifactKind, type ArtifactFile, type AgentTarget,
} from './artifactInstaller'
import { readZip } from './zipArchive'
import { statSync as ipStat, readdirSync as ipReaddir, readFileSync as ipRead, chmodSync as ghChmod, existsSync as ghExists } from 'node:fs'
import { join as ipJoin, dirname as ghDirname, resolve as ghResolve } from 'node:path'
// Commit Shield git hooks — the layer that makes the shield cover terminal-typed git.
// (resolveNodeCommand is already imported above for the MCP registration.)
import { installHooks, uninstallHooks, hookStatus, type HookDeps, type HookPaths } from './gitHooks'
import { loadSession, loadRestoreSession, saveSession } from './sessionStore'
import { appendCommand, searchHistory } from './historyStore'
import { readConfigFile, writeConfigFile } from './configFileManager'
import { listPathEntries, listPathCommands, listEnvVars } from './completionService'
import { startMcpServer, stopMcpServer, getMcpAuthToken, getMcpPort, awaitMcpPortBound, initAuditLog, executeTool, type McpToolHandlers } from './mcpServer'
import { randomUUID } from 'node:crypto'
import { detectAgentStatus } from '../renderer/src/lib/agentStatusDetector'
import { makeTerminalRunner, makeAgentRunner, makeToolInvoker, realTimer } from './workflow/adapters'
import { runWorkflow as wfRun, cancelRun as wfCancel } from './workflow/workflowEngine'
import { registerWorkflowIpc } from './workflow/ipc'
import { TriggerSupervisor } from './workflow/triggers'
import { sessionProjectCwds, type SessionLike } from './workflow/sessionProjects'
import { startLearningSignals, stopLearningSignals } from './learningSignals'
import { cleanupDemoWorkflows, oncePerVersion } from './workflow/demoCleanup'
import type { FsLike as WorkflowFsLike } from './workflow/workflowStore'
import type { WorkflowScope } from '../renderer/src/types'
import { retrieveFull as headroomRetrieveFull } from './headroom/compressToolResult'
import { getSettings as getHeadroomSettings, setSettings as setHeadroomSettings } from './headroom/config'
import { buildInjectedInstruction } from './headroom/injectedInstruction'
import { writeAgentsMd, ensureCodexMemoryAutoApproved } from './codexParity'
import { adaptSteeringMode, type SteeringMode } from './headroom/outputSteering'
import { initOutputEconomy, armForSession, flushOutputEconomy, outputEconomyReport } from './headroom/outputEconomyStore'
import { resolveWireMode } from './headroom/savingsFloor'
import { setCcrDir, ccrPut } from './headroom/ccrStore'
import { summarizeUnifiedSavings } from './headroom/unifiedReceipt'
import { getProxyEnv, startProxy, stopProxy, onProxyResult, onProxyStash, setProxySpawner, createProxyTransport, pickFreePort, setProxyMode, setProxyThinkingCap, setProxyDecay } from './headroomProxy/proxySupervisor'
import { recordProxyResult, summarizeProxySavings, loadProxyBaseFromDisk, saveProxyTotalsToDisk, setProxyLedgerFlush, resetProxyCounters } from './headroomProxy/proxyLedger'
import { loadDepthCurveFromDisk, saveDepthCurveToDisk } from './headroom/sessionDepth'
import { fileURLToPath } from 'url'
import { summarizeSavings as summarizeHeadroomSavings, setLedgerFlush } from './headroom/savingsLedger'
import { loadSettingsFromDisk, saveSettingsToDisk, loadLedgerBaseFromDisk, saveLedgerToDisk } from './headroom/persist'
import { getGroqKey, setGroqKey, getGroqKeyStatus, clearGroqKey } from './groqKeyStore'
import { transcribeWithGroq, validateGroqKey } from './groqTranscription'
import {
  sendMessage, readMessages, getAllMessages,
  createTask, listTasks, updateTask, clearSwarm,
  type SwarmMessage, type SwarmTask,
} from './swarmManager'
import {
  initEventBus, query as queryEvents, subscribe as subscribeEvents,
  publish as publishEvent,
  getRingSize, getDroppedCount, shutdownEventBus,
  type AgentEvent, type EventFilter,
} from './agentEventBus'
import {
  attachWatcher, detachWatchers, detachAll as detachAllWatchers,
  type DetectedAgent,
} from './transcriptWatchers'
import {
  initContextPinStore,
  listPins, addPin, removePin, updatePin, clearPins,
  type ContextPin,
} from './contextPinStore'
import { initMcpGateway, gatewayListTools, gatewayCall } from './mcpGatewayRuntime'
import { initMemoryCorrections, correctMemory, applyCorrections } from './memoryCorrectionStore'
import { runHeadless, type ExecAgent } from './headlessExec'
import { initReceiptIdentity, issueReceipt, checkReceipt } from './headroom/receiptStore'
import { renderReceiptMarkdown, renderReceiptJson, type SignedReceipt } from './headroom/receiptArtifact'
import { buildProbes, runBench, checkRegression, baselineFrom, formatBench, type BenchMemory } from './recallBench'
import { initRecallBench, loadBenchBaseline, saveBenchBaseline } from './recallBenchStore'
// v1.26 — the memory brain lives in a utilityProcess (memoryHost.ts). NOTHING in main imports
// ./swarmMemory any more: main talks to the store through this proxy, so initSwarmMemory's ~4,276 ms
// launch block (measured, 475 MB / 90,817 entries) is off the thread that paints the window and
// echoes PTY keystrokes. Every store call below is therefore a PROMISE.
//
// The `await` is mechanical inside an async handler. It is NOT mechanical wherever a store call is
// handed to something that consumes it SYNCHRONOUSLY — a Promise is truthy, has no `.length`, and
// compares NaN — so those sites hoist the data first and hand the consumer a resolved value. See
// runConsolidation / runSummarization / runWeave in the indexer below, locateIssueSites, and the
// hasHashes wiring on both ingesters. Getting one of those wrong fails SILENTLY.
//
// normalizeProjectSlug / projectKeyOf / entityDedupHash are pure string helpers and stay SYNC.
import {
  startMemoryHost, setMemoryHostSpawner, createMemoryHostTransport, stopMemoryHost, memoryHostMode, memoryHostPid,
  graphStats, graphRelationStats,
  memoryWrite, memorySearch, memoryRelated, memoryLink, memoryGraphQuery, memoryFeedback, memoryList, memoryCount, memoryClear, memoryKnownHashes, memoryStats, memoryDashboardStats, memoryGraphSample, memoryRecentActivity, embeddingsReady, memorySourceById, memoryDelete, consolidationCandidates, consolidationSimOf,
  memoryPatchProjects, normalizeProjectSlug, memoryLessons, memoryPruneCodePath, warmProbeEmbeddings, compactSelfShard,
  setMemoryScrubber,
  weaveCandidates, weaveNeighboursBatch, backfillCodeRefs, symbolHistory, memoryArchive, searchArchive,
  getSyncStatus, setSyncDir, reloadMemoryFromSync, setSyncPassphrase, disableSyncEncryption, enableLocalEncryption, disableEncryption,
  persistMemoryIndex,
  entityDedupHash, projectKeyOf,
  type MemoryEntry,
  vectorRamStats,
  setVectorQuantization,
} from './memoryClient'
import { setSafeStorage } from './secureKeyStore'
import { runConversationIngest } from './conversationIngest'
import { runCodeIngest, discoverRepoFiles } from './codeIngest'
import { initCodeGraph, buildCodeGraph, reindexWatchedChange, codeExplore, codeCallers, codeCallees, codeImpact, codeSymbols, codeGraphStats, graphKeyForRoot, resolveCodeRefs, resolveToken, ALL_REPOS, type CodeRef } from './codeGraph'
import { ensureRepoWatch, stopRepoWatches, fsBackedWatchDeps } from './codeWatch'
import { watch as fsWatch, promises as fsPromises } from 'fs'
import { initAnomalyLog, getAnomalies, anomalyCount } from './memoryAnomalyLog'
import { startIndexer, stopIndexer } from './memoryIndexer'
import { runWeave, WEAVE_NEIGHBOUR_K, type WeaveStats } from './mnemeWeave'
import { auditMemory } from './memoryAudit' // WP-E: audit learning events (reflection / consolidation)
// Mneme — the learning layer (see docs/learning-architecture.md).
import { distillEpisode } from './mnemeReflect'
import { onTaskComplete, onSessionEpisode } from './mnemeReflex'
import { reflectSoloSession, type SessionCursor } from './mnemeSession'
import { readSessionTranscript } from './liveTranscript'
import { initCompetence, recordOutcome, assessCompetence, competenceSummary, competenceRecords } from './mnemeCompetence'
import { initIdentity, identitySummary } from './mnemeIdentity'
import { findGaps, curiosityPrompts } from './mnemeCuriosity'
import { augmentPrimer } from './mnemePrimerAugment'
import { runConsolidation, runSummarization } from './mnemeConsolidateRun'
import { poolLessons, toAgentLesson } from './mnemeSociety'
import { detectConflictsNli } from './nliContradict'
import { proactiveQuery, proactiveSignals } from './mnemeRetrieval'
import { codeLocate, type LocatedSite, type LocatorSymbol, type LocatorMemory } from './codeLocate'
import { isHighValueEpisode } from './mnemeReflect'
import { makeHeadlessDistiller } from './mnemeDistiller'
import { buildBrainArchive, mergeBrainArchive, realBrainFs } from './brainIpc'
import { initMetrics, recordMetric, metricsSummary } from './metricsLedger'
import { setWorkerSpawner } from './localEmbedder'
import { createWorkerTransport } from './embedWorker'

// v1.26 — the sync-void `link` dep, made safe against an out-of-process graph write.
//
// The mneme planners (onTaskComplete, onSessionEpisode, runSummarization, runWeave) all take
// `link: (from, to, relation, weight?) => void` and call it from inside a SYNC loop. memoryLink is a
// Promise now. Firing it and dropping the handle would mint the edges eventually, unordered, with an
// unhandled rejection if the host is down — so instead the planner's decisions are COLLECTED and
// applied afterwards, awaited, exactly once. Same edges, same order, and a failure is contained
// per-edge rather than aborting the pass (which is how every one of these call sites already behaves).
function collectEdges(createdBy?: string) {
  const pending: Array<{ from: string; to: string; relation: string; weight?: number }> = []
  return {
    /** The SYNC dep to hand the planner — it only records the decision. */
    collect: (from: string, to: string, relation: string, weight?: number): void => {
      if (!from || !to) return
      pending.push({ from, to, relation, weight })
    },
    /** Apply them for real, awaited. Call after the planner returns. */
    async flush(): Promise<number> {
      let minted = 0
      for (const e of pending.splice(0)) {
        try {
          // Spread createdBy only when set, so the minted edge is byte-identical to what each of
          // these call sites passed before (the session reflector deliberately stamps no provenance).
          await memoryLink({ from: e.from, to: e.to, relation: e.relation, weight: e.weight, ...(createdBy ? { createdBy } : {}) })
          minted++
        } catch { /* best effort — one bad edge never aborts the pass */ }
      }
      return minted
    },
  }
}

/**
 * The store deps every conversation-ingest pass uses — one definition, so the three call sites
 * (reindex IPC, slow indexer tick, fast indexer tick) cannot drift apart on the one that matters.
 *
 * `hasHashES`, never `hasHash`. The ingest loop consumes membership as a SYNC predicate over every
 * chunk; the store is out of process, so the only correct answers are batched-and-resolved. Wiring
 * the async `memoryHasHash` here instead would return a Promise per chunk — truthy — so every chunk
 * reads as "already stored" and ingestion silently writes NOTHING, forever, with no error anywhere.
 */
function ingestMemoryDeps() {
  return {
    hasHashes: memoryKnownHashes,
    write: memoryWrite,
    patchProjects: (patches: Array<{ hash: string; project: string }>): void => {
      void memoryPatchProjects(patches).catch(() => { /* best effort — F30 backfill */ })
    },
    link: (from: string, to: string, relation: string, weight: number, ts?: number): void => {
      // The BB6 'follows' backbone. Fire-and-forget by contract (a sync void dep called per chunk),
      // but the rejection is CAUGHT: an unhandled one in the main process is a crash, and losing a
      // backbone edge is not worth that.
      void memoryLink({ from, to, relation, weight, ts, createdBy: 'ingest' }).catch(() => {})
    },
  }
}

// Mneme entity layer: upsert an `entity` node by name (idempotent via content-hash)
// and return its id, so a distilled lesson can link to the files/functions/errors it
// references — the connective tissue the knowledge graph was missing. Low importance
// so entity stubs never dominate recall. Best-effort: never breaks reflection.
async function ensureEntityNode(name: string, project?: string): Promise<string | null> {
  const n = (name || '').trim()
  if (!n) return null
  try {
    const e = await memoryWrite({
      agentId: 'mneme',
      kind: 'fact',
      memoryType: 'entity',
      content: n,
      source: 'mneme',
      importance: 0.3,
      ...(project ? { project } : {}),
      // WP-D: scope the DEDUP hash by projectKey so `parse` in repoA and repoB are DISTINCT entity
      // nodes (no false cross-repo conflation). Content stays the bare name (entities:[content] clean).
      hash: entityDedupHash(n, project ? projectKeyOf(project) : undefined),
    })
    return e?.id ?? null
  } catch {
    return null
  }
}

// v1.23 C5 — the issue->location predictor, wired to the real code graph + memory bridge.
// Reused by the code_locate MCP tool, the code:locate IPC, and the proactive-on-error hook.
//
// codeLocate is a SYNC planner and its `history` dep returns an ARRAY — but symbolHistory now lives
// in the memory process. Handing it the async proxy would `.map()` a Promise, throw, get swallowed by
// the catch below, and make code_locate return [] forever: a feature that silently stops working.
//
// So the history is PRE-FETCHED. signals() and resolve() (the code graph) are both still sync and in
// main, so the exact set of queries codeLocate will ask for is derivable up front — it asks for each
// resolved symbol's NAME, and for each token that resolved to files. Same queries, same answers, and
// the planner keeps a sync dep.
async function locateIssueSites(issue: string, projectKey?: string, limit?: number): Promise<LocatedSite[]> {
  try {
    const resolveOne = (token: string): { symbols: LocatorSymbol[]; files: string[] } => {
      const r = resolveToken(token, projectKey)
      return { symbols: r.symbols.map((s) => ({ id: s.id, name: s.name, file: s.file })), files: r.files }
    }
    const tokens = proactiveSignals(issue) || []
    const queries = new Set<string>()
    for (const token of tokens) {
      let r: { symbols: LocatorSymbol[]; files: string[] }
      try { r = resolveOne(token) } catch { continue }
      for (const s of r.symbols) queries.add(s.name)
      if (r.files.length > 0) queries.add(token)
    }
    // proactiveSignals is capped (MAX_SIGNALS), so this is a bounded handful of round trips, not a
    // per-token stampede — and they go out concurrently.
    const histories = new Map<string, LocatorMemory[]>()
    await Promise.all([...queries].map(async (q) => {
      try {
        const rows = await symbolHistory(q, projectKey)
        histories.set(q, rows.map((e) => ({ id: e.id, content: e.content, importance: e.importance, ts: e.ts, memoryType: e.memoryType })))
      } catch { histories.set(q, []) }
    }))
    return codeLocate(
      issue,
      {
        signals: (t) => proactiveSignals(t),
        resolve: resolveOne,
        history: (q) => histories.get(q) ?? [], // sync closure over already-resolved data
        impact: (name) => codeImpact(name, 6, projectKey).length,
        now: Date.now(),
      },
      { limit },
    )
  } catch {
    return []
  }
}

// v1.23 C7 — OPTIONAL headless LLM enrichment of reflection, OFF by default (a frontier feature,
// like adaptEnabled / prfEnabled / graphFusionEnabled). When TERMPOLIS_MNEME_DISTILLER=1, a
// high-value episode ALSO gets a cheap `claude -p --model haiku` lesson (net-positive on tokens:
// the stored lesson prevents later re-derivation). The zero-token deterministic extractor always
// runs regardless, and the distiller never throws — so reflection can't be broken by enabling it.
const MNEME_DISTILLER_ENABLED = process.env.TERMPOLIS_MNEME_DISTILLER === '1'
const headlessDistiller = makeHeadlessDistiller()

/**
 * Mneme reflex: when a swarm task finishes, learn from it — ground the outcome
 * into self-competence and reflect the episode into distilled lessons.
 * Deterministic (zero-token) distillation by default. Fully guarded and
 * fire-and-forget: reflection never breaks or delays the task-update path.
 */
async function reflectOnTask(
  task: { id?: string; title?: string; description?: string; result?: string; project?: string } | null | undefined,
  status: string,
  result?: string,
): Promise<void> {
  try {
    // `link` is a SYNC void dep and memoryLink is now a Promise. Collect the edges the reflector
    // decides on and mint them after it returns — awaited, so reflectOnTask still completes with the
    // graph fully written (a fire-and-forget `void memoryLink(...)` would leave the edges racing the
    // next read, and drop a rejection on the floor).
    const edges = collectEdges('reflect')
    const res = await onTaskComplete(
      {
        id: task?.id ?? 'unknown',
        status,
        title: task?.title,
        description: task?.description,
        result: result ?? task?.result,
        project: task?.project,
        source: 'swarm',
      },
      {
        distill: (ep) => distillEpisode(ep, MNEME_DISTILLER_ENABLED && isHighValueEpisode(ep) ? { llm: headlessDistiller } : {}),
        write: (input) => memoryWrite(input),
        recordOutcome,
        now: Date.now(),
        link: edges.collect,
        ensureEntity: ensureEntityNode,
        resolveCode: (names, project) => resolveCodeRefs(names, graphKeyForRoot(project ?? '')),
      },
    )
    await edges.flush()
    try {
      if (res.fired && res.lessons > 0) {
        recordMetric({ t: 'reflect', ts: Date.now(), lessons: res.lessons })
        auditMemory({ event: 'learn', kind: 'reflect', detail: `${res.lessons} lesson(s) distilled from a task` }) // WP-E
      }
    } catch { /* best effort */ }
  } catch {
    /* best effort — reflection never breaks task completion */
  }
}

// Per-terminal reflection cursors for solo-session learning: how far each agent
// terminal's transcript has already been reflected, so each pass only distils the
// newly-appended turns. In-memory (terminal ids are per-session uuids); a lost cursor
// just re-reads, and the content-addressed store dedups any overlap.
const sessionCursors = new Map<string, SessionCursor>()
import { buildContextPrimer, type PrimerRecent } from './contextPrimer'
import { getPrimerLimit, setPrimerLimit, getVectorQuantize, setVectorQuantize } from './memorySettings'
import { initAutoUpdater } from './autoUpdater'
import type { SessionData } from './types'
import { v4 as uuidv4 } from 'uuid'

function ok<T>(data?: T) { return { success: true, data } }
function err(error: string) { return { success: false, error } }

// One-way bypass for the agents-running close guard: armed when the user clicks
// "Restart" on a downloaded update, so the quit from quitAndInstall isn't
// intercepted (and cancelled) by the confirm dialog.
let quittingForUpdate = false

let mainWindow: BrowserWindow | null = null

// Buffer terminal output for MCP read_output (capped at 32KB per terminal)
const terminalOutputBuffers = new Map<string, string>()

// Track terminals created via MCP (swarm) so we can enforce agent commands
const mcpCreatedTerminals = new Set<string>()
const MAX_MCP_TERMINALS = 8 // Cap concurrent swarm agent terminals to limit memory

import { sanitizeAgentCommand } from './agentCommandSanitizer'
import { getAgentExtraPaths, getExtendedPath } from './agentPaths'
import { safeGit, safeGitAsync, isValidGitRef, parseSafeCommand, runSafeCommand } from './gitCommand'
import { installApplicationMenu, globalHotkeys } from './appMenu'
import { writeSecureFile } from './secureFile'
import {
  initWorkspaceTrust,
  isWorkspaceTrusted,
  trustWorkspace,
  revokeWorkspaceTrust,
  listTrustedWorkspaces,
  ensureWorkspaceTrust,
} from './workspaceTrust'
import {
  registerInClaudeSettings,
  registerInGlobalMcp,
  registerInCodex,
  registerInGemini,
  resolveNodeCommand,
} from './agentMcpRegistry'
import { repairWindowsShortcuts, defaultShortcutPaths } from './windowsShortcutRepair'

// Load the window/taskbar icon from a Buffer. We previously used
// nativeImage.createFromPath, but the assets/ dir lives INSIDE app.asar and
// createFromPath's native file read does NOT reliably resolve asar paths — it
// returned an EMPTY image, so `icon` was dropped and Windows showed the generic
// taskbar icon. fs (Electron-patched) reads the asar entry correctly, and a PNG
// buffer is a format nativeImage always decodes; Electron downscales it for the
// taskbar/title bar. The crisp multi-size .ico is what electron-builder stamps
// onto the exe + Start-menu/taskbar shortcut (build.win.icon).
function loadWindowIcon() {
  try {
    const buf = readFileSync(join(__dirname, '../../assets', 'logo-termpolis.png'))
    const img = nativeImage.createFromBuffer(buf)
    return img.isEmpty?.() ? undefined : img
  } catch {
    return undefined
  }
}

/**
 * The crash-watch "the OS is ending the session" handler, once installCleanExitGuards has produced
 * it. Held here because `session-end` is a BrowserWindow event and the window is recreated (macOS
 * 'activate'), so every new window has to pick it up again.
 */
let onSessionEnd: (() => void) | null = null

function createWindow() {
  // If the icon fails to load we leave `icon` undefined so the OS uses the
  // executable's embedded icon, never a blank one.
  const windowIcon = loadWindowIcon()
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: 'Termpolis',
    icon: windowIcon ?? undefined,
    backgroundColor: '#1e1e1e',
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // A terminal is not a web page: its content arrives from a PTY on its own schedule and has to
      // keep flowing whether or not anyone is looking at the window. Chromium's default is to
      // throttle timers and stop requestAnimationFrame outright once a window is hidden or
      // OCCLUDED — and on Windows a window with anything sitting on top of it is occluded, not
      // merely unfocused. That froze every terminal for as long as something covered Termpolis:
      // agent output stopped rendering, keystroke echo went dark, and the backlog dumped in one
      // burst on refocus. See outputThrottle.ts, which pairs a timer watchdog with rAF so the
      // buffer drains even if a frame never comes.
      backgroundThrottling: false,
    },
  })

  // Defensive: explicitly (re)assert the taskbar/window icon after creation —
  // some Windows setups don't apply the constructor `icon` to the taskbar button
  // until it's set on the live window.
  if (windowIcon) { try { mainWindow.setIcon(windowIcon) } catch { /* non-fatal */ } }

  // Permissions: the renderer needs the microphone (voice input) and clipboard.
  // Electron rejects getUserMedia without an explicit grant. We keep the prior
  // permissive default (Electron approves all requests when no handler is set),
  // so nothing else regresses. NOTE: packaged macOS builds also need
  // NSMicrophoneUsageDescription + the audio-input entitlement (build config).
  // Guarded with optional chaining so a minimal BrowserWindow mock (unit tests)
  // doesn't trip on it; in real Electron the session and handlers always exist.
  const ses = mainWindow.webContents?.session
  ses?.setPermissionRequestHandler?.((_wc, _permission, callback) => callback(true))
  ses?.setPermissionCheckHandler?.(() => true)

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Confirm close when AI agents are running. Skipped in test mode, and skipped
  // when the user already chose Restart for an update — the agents-running
  // dialog must not interject and cancel the update's restart.
  let forceClose = false
  mainWindow.on('close', (e) => {
    if (forceClose || quittingForUpdate || process.env.NODE_ENV === 'test') return
    // Ask renderer if agents are running, show in-app dialog if so
    const hasAgents = mainWindow?.webContents.executeJavaScript(
      `(() => { try { return window.__termpolis_has_agents?.() ?? false } catch { return false } })()`
    )
    hasAgents?.then((running: boolean) => {
      if (running) {
        // Send event to renderer to show in-app close confirmation dialog
        mainWindow?.webContents.send('app:confirm-close')
      } else {
        forceClose = true
        mainWindow?.close()
      }
    }).catch(() => {
      forceClose = true
      mainWindow?.close()
    })
    e.preventDefault()
  })

  // Renderer confirmed force close
  ipcMain.on('app:force-close', () => {
    forceClose = true
    mainWindow?.close()
  })

  // A Windows session end (force shutdown / restart / log off) is a BrowserWindow event, and the
  // window outlives neither a close nor a macOS re-activate — so it re-attaches on every creation.
  // Without it the marker stays uncleared and the next launch reports a phantom crash (#20).
  if (onSessionEnd) mainWindow.on('session-end', onSessionEnd)

  mainWindow.on('closed', () => { mainWindow = null })
}

// IPC Handlers

// Clipboard — routed through Electron's native clipboard module (main process)
// rather than the renderer's navigator.clipboard. The web Clipboard API is gated
// on the calling document being focused; when the user clicks a terminal
// context-menu item, focus has left xterm's hidden textarea, so
// navigator.clipboard.writeText/readText reject and copy/paste silently no-op
// (the keyboard path works because it fires while the textarea is still focused).
// The main-process clipboard module has no focus/permission gate.
ipcMain.handle('clipboard:write-text', (_e, { text }: { text?: string }) => {
  clipboard.writeText(typeof text === 'string' ? text : '')
  return ok()
})
ipcMain.handle('clipboard:read-text', () => ok(clipboard.readText()))
ipcMain.handle('clipboard:write-rich', (_e, { text, html }: { text?: string; html?: string }) => {
  clipboard.write({ text: text ?? '', html: html ?? '' })
  return ok()
})

ipcMain.handle('terminal:create', async (_, { id, shellType, cwd, extraPaths, claudeHeadroom }) => {
  try {
    const shells = await detectAvailableShells()
    const shell = shells.find(s => s.type === shellType) ?? shells[0]
    if (!shell) return err('No shell available')
    await new Promise<void>((resolve, reject) => {
      // NOTE: a `setTimeout(() => reject('timeout'), 5000)` "hang guard" used to sit here. It was
      // DEAD CODE: the executor body below is fully SYNCHRONOUS, so clearTimeout always won the
      // race and the timer could never fire. It could never have worked anyway — a blocking
      // synchronous spawn blocks the event loop, so the timer still could not fire. It read like
      // a hang guard and provided none, which is worse than no guard at all.
      try {
        const agentPaths = getAgentExtraPaths()
        const allExtraPaths = [...agentPaths, ...(extraPaths || [])]
        spawnTerminal(id, shell.executable, cwd, (data) => {
          mainWindow?.webContents.send('terminal:data', id, data)
          // Buffer output for MCP read_output
          const existing = terminalOutputBuffers.get(id) || ''
          const updated = existing + data
          terminalOutputBuffers.set(id, updated.length > 32768 ? updated.slice(-32768) : updated)
        }, allExtraPaths, claudeHeadroom ? (getProxyEnv() ?? undefined) : undefined)
        resolve()
      } catch (e) {
        reject(e)
      }
    })
    return ok()
  } catch (e: any) {
    return err(e.message ?? 'Failed to create terminal')
  }
})

// Heuristic: when the user types `claude`, `codex`, or `gemini` as
// the start of a command line, the next bytes typed are about to be a prompt
// going to that AI provider's network. We log a terminal_open audit entry
// (only if the audit toggle is on) so security-conscious teams can prove
// "exactly when did developer X launch agent Y in repo Z."
const auditLaunchPattern = /(?:^|[\r\n;&|])\s*(claude|codex|gemini)(?:\s|$)/
// Strict mode: refuse to forward a `gemini` invocation when the account
// detector says we're on the free OAuth tier. We intercept before the bytes
// hit the PTY, write a clear refusal message to the terminal, and audit it.
const strictBlockPattern = /(?:^|[\r\n;&|])\s*gemini(?:\s|$|\r|\n)/
const recentlyAuditedTerminals = new Map<string, number>()

// Per-terminal "this is an AI session" flag. We set this the first time a
// terminal:write matches auditLaunchPattern (the user typed `claude` /
// `codex` / `gemini`). All subsequent writes on that terminal are
// then auto-scanned for secrets before they reach the PTY.
const aiTerminalFlag = new Set<string>()
// Per-terminal staging buffer: characters typed since the last submit. We
// flush + scan when the user presses Enter (\r or \n) OR when a single
// chunked write is large enough to look like a paste (≥32 chars). This
// keeps the regex pass amortized — at most one per submit / per paste.
const aiInputStaging = new Map<string, string>()
// Per-terminal "we already prompted on this submit" — when redaction fires
// we hold the write and emit a renderer event; the user resolves with allow
// or block. Until they do, we drop further writes for that submit.
const PASTE_THRESHOLD = 32
const STAGE_CAP = 64 * 1024 // 64 KB per terminal — safety bound on staging

ipcMain.handle('terminal:kill', async (_, { id }) => {
  try {
    killTerminal(id)
    terminalOutputBuffers.delete(id)
    try { detachWatchers(id) } catch {}
    if (recentlyAuditedTerminals.has(id)) {
      recentlyAuditedTerminals.delete(id)
      aiSecurityAppend({ agent: 'unknown', event: 'terminal_close', terminalId: id }).catch(() => {})
    }
    aiTerminalFlag.delete(id)
    aiInputStaging.delete(id)
    try { clearEgress(id) } catch {}
    try { reportedEgressViolations.delete(id) } catch {}
    try { clearSensitiveReadCount(id) } catch {}
    return ok()
  } catch (e: any) { return err(e.message) }
})

// Renderer-facing read of the per-terminal egress cache. The Security panel
// queries this to render "this agent talked to X hosts". We poll on-demand
// here rather than running a background interval per AI terminal — the
// every-60s `netstat -ano` triad (process-enum + subprocess-spawn + signed-exe
// from a fresh-reputation OV cert) was load-bearing in Defender's cloud-ML
// false-positive against v1.11.55. Cost of moving to on-demand is one extra
// shell-out the first time the user opens the Security panel; benefit is no
// continuous behavioral signature.
// Egress Guard — turn the egress RECORD into a POLICY.
//
// The poller only ever hands us IP literals (netstat/ss/lsof do not reverse-DNS), while the
// allowlist is expressed in hostnames. egressAttribute closes that gap by FORWARD-resolving
// the known AI-provider hosts to their current IPs and judging what we observed against
// that set — the agent resolved the same names from this same machine, so its connected IP
// is overwhelmingly likely to be in it. Anything left over is the signal that actually
// matters: an agent talking to a host nobody expects.
//
// We FLAG (audit + surface), we do not kill the process: a false positive must never take
// down the user's agent mid-task.
// Per-terminal memo of already-reported violations, so re-opening the Security panel does
// not re-log the same IP on every poll.
const reportedEgressViolations = new Map<string, Set<string>>()
function alreadyReportedEgress(terminalId: string, ip: string): boolean {
  let seen = reportedEgressViolations.get(terminalId)
  if (!seen) { seen = new Set(); reportedEgressViolations.set(terminalId, seen) }
  if (seen.has(ip)) return true
  seen.add(ip)
  return false
}

async function judgeEgressForTerminal(terminalId: string, endpoints: EgressEndpoint[]): Promise<void> {
  try {
    if (!getAiSecuritySettings().egressGuard) return
    const allowed = await refreshAllowedIps()
    // LOAD-BEARING. An empty allowlist means DNS failed or the machine is offline — judging
    // against it would report every legitimate provider IP as exfiltration. Say nothing
    // rather than cry wolf; a guard that fires constantly is a guard nobody reads.
    if (allowed.size === 0) return
    const report = attributeEgress(endpoints.map((e) => e.remoteHost).filter(Boolean), allowed)
    const fresh = report.violations.filter((v) => !alreadyReportedEgress(terminalId, v.ip))
    if (fresh.length === 0) return
    await aiSecurityAppend({
      agent: 'egress',
      event: 'egress_violation',
      terminalId,
      hitCount: fresh.length,
      notes: report.summary,
    })
  } catch { /* best effort — the guard must never break the egress panel */ }
}

ipcMain.handle('ai-security:egress', async (_, { terminalId }: { terminalId: string }) => {
  try {
    const pid = getTerminalPid(terminalId)
    if (pid && pid > 0) {
      const endpoints = await pollAgentEgress(pid)
      if (endpoints.length) {
        recordEgress(terminalId, endpoints)
        await judgeEgressForTerminal(terminalId, endpoints)
      }
    }
    return ok({ endpoints: getRecentEgress(terminalId) })
  } catch (e: any) { return err(e.message) }
})

// Renderer-facing read of the per-terminal sensitive-file-read counter.
// The Security panel uses this to show "3 sensitive reads this session"
// alongside the running list of which files / which agent.
ipcMain.handle('ai-security:sensitive-reads', async (_, { terminalId }: { terminalId: string }) => {
  try {
    return ok({
      count: getSensitiveReadCount(terminalId),
      recent: getRecentSensitiveReads(terminalId),
    })
  } catch (e: any) { return err(e.message) }
})

// Test-only: record raw terminal writes so e2e can assert the compaction re-prime
// paste actually reached a terminal. Only populated under NODE_ENV=test.
const __testTerminalWrites: Array<{ id: string; data: string }> = []
ipcMain.on('terminal:write', (_, { id, data }: { id: string; data: string }) => {
  if (process.env.NODE_ENV === 'test') __testTerminalWrites.push({ id, data })
  // Strict-mode enforcement: if the user is launching `gemini` on a free-tier
  // account and the operator has enabled the lock, intercept BEFORE forwarding
  // to the PTY. We write a refusal banner directly back to the terminal stream
  // and a Ctrl+C, so the user's shell drops back to a fresh prompt without
  // the unsafe `gemini` token having reached the agent.
  try {
    if (typeof data === 'string' && data.length > 0) {
      const s = getAiSecuritySettings()
      if (s.strictGeminiPaidOnly && strictBlockPattern.test(data)) {
        const acct = detectGeminiAccount()
        if (!acct.safeForTraining) {
          writeToTerminal(id, '\u0003')
          const banner =
            '\r\n\x1b[31m⛔ Termpolis Strict Mode: Gemini CLI launch BLOCKED.\x1b[0m\r\n' +
            '\x1b[33mDetected account mode: ' + acct.mode + ' (unsafe — prompts may be used for training).\x1b[0m\r\n' +
            'To proceed, set one of: GEMINI_API_KEY, GOOGLE_GENAI_USE_GCA=true, or GOOGLE_APPLICATION_CREDENTIALS + GOOGLE_CLOUD_PROJECT.\r\n' +
            'Or disable Strict Mode in Settings → Security.\r\n\r\n'
          // Render the banner by sending it STRAIGHT TO THE RENDERER, on the same channel the PTY's own
          // output uses. It used to be wrapped in `printf '<banner>'` and written to the PTY as a TYPED
          // SHELL COMMAND — which only works on a shell that HAS printf. On Windows (cmd.exe /
          // PowerShell: the default, and Termpolis's primary platform) the user got
          // `'printf' is not recognized` INSTEAD of the explanation — at the exact moment they most
          // needed to know why the launch was refused. The BLOCK always worked; it was the MESSAGE that
          // failed. xterm renders bytes; it does not need a shell to print for us, and going direct also
          // means the shell never sees the text at all.
          mainWindow?.webContents.send('terminal:data', id, banner)
          aiSecurityAppend({
            agent: 'gemini',
            event: 'terminal_open',
            terminalId: id,
            notes: 'BLOCKED: strict-mode + free-tier (' + acct.mode + ')',
          }).catch(() => {})
          return
        }
      }
    }
  } catch {}

  // Mark the terminal as an AI session if the user just typed an agent name —
  // this gates auto-scan to only the terminals where the leak risk lives.
  let detectedAgent: string | null = null
  try {
    if (typeof data === 'string' && auditLaunchPattern.test(data)) {
      const m = data.match(auditLaunchPattern)
      detectedAgent = m ? m[1] : null
      if (detectedAgent) {
        aiTerminalFlag.add(id)
      }
    }
  } catch {}

  // Auto-scan: every prompt typed into an AI terminal is screened for
  // well-shaped secrets BEFORE it reaches the PTY. The decision logic lives
  // in processOutboundChunk so it can be unit-tested without IPC.
  try {
    const decision = processOutboundChunk(aiInputStaging.get(id) ?? '', data, {
      isAiTerminal: aiTerminalFlag.has(id),
    })
    aiInputStaging.set(id, decision.newStaging)

    // A secret was in what just went to the model. It is ALREADY GONE — we do not pretend
    // otherwise. Record it (rule ids + a redacted sample; never the prompt itself) so the
    // audit log can answer "was a secret sent?" after the fact, which is the one question
    // the old redact-before-send design could never answer when it was switched off.
    if (decision.action === 'observed') {
      const r = decision.scan!
      aiSecurityAppend({
        agent: detectedAgent ?? 'unknown',
        event: 'prompt_secret_sent',
        terminalId: id,
        hitCount: r.hitCount,
        byteCount: data.length,
        // NAMES AND RULE IDS ONLY. Never the value, and never `hit.sample` either — for the
        // named rules the match spans the whole assignment (`DB_PASSWORD=hunter2xyz`), so the
        // sample's tail characters come out of the secret itself. An audit log full of secret
        // fragments is just a second place the secret leaked to.
        notes: [...new Set(r.hits.map((h) => (h.name ? `${h.name} (${h.rule})` : h.rule)))].join(', '),
      }).catch(() => {})
      // Same rule as the audit note, enforced a second time at the process boundary: the
      // renderer is told WHAT leaked, never the value. `hit.sample` is deliberately dropped
      // here — for the named rules the match spans the whole assignment, so the sample carries
      // the secret inside it, and shipping that into the renderer would put a live credential
      // in a devtools console, a heap snapshot and any future component that renders a hit.
      // The banner needs a name and a label to be useful; it never needs the value.
      mainWindow?.webContents.send('terminal:secret-observed', {
        id,
        hits: r.hits.map((h) => ({ rule: h.rule, label: h.label, name: h.name })),
        agent: detectedAgent ?? null,
      })
    }

    // Code-shaped / env-shaped prompts get their OWN events. They used to be logged as
    // 'redaction_hit', which conflated "you pasted a big file" with "you leaked a key" and
    // would inflate the secrets-sent count with things that are not secrets at all.
    if (decision.codeChunk?.isCode) {
      aiSecurityAppend({
        agent: detectedAgent ?? 'unknown',
        event: 'code_chunk_sent',
        terminalId: id,
        byteCount: decision.codeChunk.byteSize,
        notes: 'code-chunk:' + decision.codeChunk.signals.join(','),
      }).catch(() => {})
      mainWindow?.webContents.send('terminal:code-chunk-detected', {
        id,
        agent: detectedAgent ?? null,
        byteSize: decision.codeChunk.byteSize,
        lineCount: decision.codeChunk.lineCount,
        signals: decision.codeChunk.signals,
      })
    }
    if (decision.envDump?.isEnvDump) {
      aiSecurityAppend({
        agent: detectedAgent ?? 'unknown',
        event: 'env_dump_sent',
        terminalId: id,
        byteCount: data.length,
        notes: 'env-dump:' + decision.envDump.varCount + ':' + decision.envDump.variableNames.slice(0, 5).join(','),
      }).catch(() => {})
      mainWindow?.webContents.send('terminal:env-dump-detected', {
        id,
        agent: detectedAgent ?? null,
        varCount: decision.envDump.varCount,
        variableNames: decision.envDump.variableNames,
      })
    }
  } catch { /* watching must never break the terminal */ }

  // ALWAYS. Unmodified. Never withheld. This is the "don't touch" half of the contract.
  writeToTerminal(id, data)
  try {
    if (typeof data === 'string' && auditLaunchPattern.test(data)) {
      const last = recentlyAuditedTerminals.get(id) || 0
      const now = Date.now()
      if (now - last > 5000) {
        recentlyAuditedTerminals.set(id, now)
        const m = data.match(auditLaunchPattern)
        const agent = m ? m[1] : 'unknown'
        aiSecurityAppend({ agent, event: 'terminal_open', terminalId: id, byteCount: data.length, notes: 'AI agent invocation detected' }).catch(() => {})
      }
    }
  } catch {}
})
ipcMain.on('terminal:resize', (_, { id, cols, rows }) => resizeTerminal(id, cols, rows))

ipcMain.handle('shell:available', async () => {
  try { return ok(await detectAvailableShells()) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('config:read', async (_, { filePath }) => {
  try { return ok(readConfigFile(filePath)) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('config:write', async (_, { filePath, content }) => {
  try { writeConfigFile(filePath, content); return ok() }
  catch (e: any) { return err(e.message) }
})

ipcMain.on('history:append', (_, { terminalId, terminalName, command }) => {
  try { appendCommand(terminalId, terminalName ?? terminalId, command) } catch {}
})

ipcMain.handle('history:search', async (_, { query }) => {
  try { return ok(searchHistory(query)) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('fs:homedir', () => ok(homedir()))

// The renderer (conductorManager) needs to pass --mcp-config <path> to
// `claude -p` so headless Claude Code sessions actually load the Termpolis
// MCP server. Without this, even though `claude mcp list` shows termpolis
// as connected, -p mode bypasses user-scope plugins and the swarm runs
// with zero tools. We write the config file at startup (see mcpConfigPath
// below); this handler just hands the resolved absolute path to the renderer.
ipcMain.handle('fs:mcp-config-path', () =>
  ok(join(app.getPath('userData'), 'claude-mcp-config.json')),
)

// The one caller that must NOT see the stored terminals: this is the boot restore,
// and every launch starts with a clean terminal list (workspaces own "which
// terminals are open"). Everything else in main still reads loadSession() so it can
// see what the session actually holds.
ipcMain.handle('session:load', async () => {
  try { return ok(loadRestoreSession()) }
  catch (e: any) { return err(e.message) }
})

ipcMain.on('session:save', (_, data: SessionData) => {
  try { saveSession(data) } catch {}
})

ipcMain.handle('terminal:export', async (_, { content, defaultFilename }) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: defaultFilename,
      filters: [{ name: 'Text Files', extensions: ['txt'] }],
    })
    if (result.canceled || !result.filePath) return ok()
    writeFileSync(result.filePath, content, 'utf-8')
    return ok({ filePath: result.filePath })
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('diagnostics:collect', async () => {
  try {
    const { collectDiagnostics } = await import('./diagnostics')
    return ok(collectDiagnostics())
  } catch (e: any) { return err(e.message) }
})

// Crash-reporting opt-in. The renderer is the source of truth for the
// initial choice (Onboarding/SettingsPane), but the main process needs
// to know to gate Sentry, updater pings, and feature events. Persisted
// to userData/telemetry.json so it survives across launches.
ipcMain.handle('telemetry:set-opt-in', async (_, { value }: { value: boolean }) => {
  try {
    setTelemetryOptIn(value === true)
    return ok({ optIn: isTelemetryEnabled() })
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('telemetry:get-opt-in', async () => ok(isTelemetryEnabled()))

ipcMain.handle('app:get-version', () => ok({ version: app.getVersion() }))

// Synchronous so the renderer can read windowsPty BEFORE it constructs the first
// xterm Terminal (the option must be set at construction time). Tiny static
// payload: tells xterm the Windows ConPTY backend + OS build so its reflow and
// scrollback heuristics match the pty — otherwise a heavy-redraw TUI (Claude
// Code's Ink UI) progressively desyncs and overlaps the prompt box.
ipcMain.on('app:platform-info-sync', (e) => {
  e.returnValue = {
    platform: process.platform,
    windowsPty: computeWindowsPty(process.platform, release()),
  }
})

// Voice (Groq cloud STT). The API key lives ONLY in main, encrypted in the OS
// keychain — the renderer never receives it, it only ever sees a connected flag
// + masked hint. validate/set/status/clear manage the key; transcribe reads it,
// encodes the captured PCM to WAV, and posts it to Groq's Whisper API.
ipcMain.handle('groq:validate-key', async (_, input: { key?: string }) => {
  try {
    return ok(await validateGroqKey(input?.key ?? ''))
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }
})
ipcMain.handle('groq:set-api-key', (_, input: { key?: string }) => {
  try {
    setGroqKey(app.getPath('userData'), input?.key ?? '')
    return ok(getGroqKeyStatus(app.getPath('userData')))
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }
})
ipcMain.handle('groq:get-key-status', () => {
  try {
    return ok(getGroqKeyStatus(app.getPath('userData')))
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }
})
ipcMain.handle('groq:clear-api-key', () => {
  try {
    clearGroqKey(app.getPath('userData'))
    return ok(getGroqKeyStatus(app.getPath('userData')))
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }
})
ipcMain.handle('voice:transcribe', async (_, input: { pcm?: Float32Array | number[]; model?: string }) => {
  try {
    const key = getGroqKey(app.getPath('userData'))
    if (!key) return err('Groq is not connected — add your API key in Settings → Voice.')
    const pcm = input?.pcm instanceof Float32Array ? input.pcm : new Float32Array(input?.pcm ?? [])
    return ok(await transcribeWithGroq(pcm, { apiKey: key, model: input?.model }))
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }
})

// Past AI sessions — scans ~/.claude/projects/ across all project folders so
// the renderer can offer a "Resume any session" picker that bypasses the
// cwd-scoping baked into `claude --resume`.
ipcMain.handle('aiSessions:list', async () => {
  try {
    const { listAISessions } = await import('./aiSessions')
    return ok(await listAISessions({}))
  } catch (e) {
    return err((e as Error).message)
  }
})

// Live transcript source for Conversation Search: read + parse the active agent
// session's JSONL — the COMPLETE, up-to-the-second conversation Claude writes to
// disk — into clean dialogue turns. Lets the search find anything in the session
// rather than just the visible screen a fullscreen agent repaints. Best-effort;
// returns [] for unknown agents or when no session exists.
ipcMain.handle('conversation:read-active', async (_evt, opts: { cwd?: string; agentType?: string }) => {
  try {
    const { readActiveTranscript } = await import('./liveTranscript')
    return ok(await readActiveTranscript(opts?.cwd ?? '', opts?.agentType ?? ''))
  } catch (e) {
    return err((e as Error).message)
  }
})

// Context handoff: read a full Claude Code JSONL and return a prompt
// the renderer can inject into any AI shell (Codex, Gemini, or
// even a fresh Claude). Filepath is supplied by the renderer and must
// match a file under ~/.claude/projects/ — we sanity-check that.
ipcMain.handle('aiSessions:digest', async (_evt, filePath: string) => {
  try {
    if (typeof filePath !== 'string' || !filePath) {
      return err('filePath is required')
    }
    const { homedir } = await import('os')
    const { join, normalize } = await import('path')
    const expectedRoot = normalize(join(homedir(), '.claude', 'projects'))
    const requested = normalize(filePath)
    if (!requested.startsWith(expectedRoot)) {
      return err('filePath must be inside ~/.claude/projects')
    }
    const { digestAISession, renderDigestAsPrompt } = await import('./aiSessions')
    const digest = await digestAISession(requested)
    if (!digest) return err('Could not digest session (missing cwd or unreadable)')
    return ok({ digest, prompt: renderDigestAsPrompt(digest) })
  } catch (e) {
    return err((e as Error).message)
  }
})

// AI Security Center — verifiable outbound-data controls.
ipcMain.handle('aiSecurity:get-status', () => {
  try {
    return ok({
      settings: getAiSecuritySettings(),
      facts: AGENT_FACTS,
      auditPath: aiSecurityAuditPath(),
      geminiAccount: detectGeminiAccount(),
      // Derived, never hardcoded. The UI used to render a literal "91-rule engine" while the
      // table held 97, and the README said "~70" — three numbers, none of them right. A count
      // typed into copy is a fact with no owner: it goes stale the moment a rule is added and
      // nothing fails. Ship the real length and the number cannot drift again.
      ruleCount: SECRET_RULES.length,
    })
  } catch (e: any) { return err(e.message) }
})
ipcMain.handle('aiSecurity:set-strict-gemini', (_, { value }: { value: boolean }) => {
  try { return ok(setStrictGeminiPaidOnly(value === true)) } catch (e: any) { return err(e.message) }
})
ipcMain.handle('aiSecurity:set-audit', (_, { value }: { value: boolean }) => {
  try {
    const updated = setAuditEnabled(value === true)
    if (updated.auditEnabled) {
      // Mark the moment audit was turned on, so users can see in the log
      // exactly when monitoring started.
      aiSecurityAppend({ agent: 'system', event: 'manual_scan', notes: 'audit log enabled' }).catch(() => {})
    }
    return ok(updated)
  } catch (e: any) { return err(e.message) }
})
ipcMain.handle('aiSecurity:set-commit-shield', (_, { value }: { value: boolean }) => {
  try { return ok(setCommitShield(value === true)) } catch (e: any) { return err(e.message) }
})
ipcMain.handle('aiSecurity:set-egress-guard', (_, { value }: { value: boolean }) => {
  try { return ok(setEgressGuard(value === true)) } catch (e: any) { return err(e.message) }
})
ipcMain.handle('aiSecurity:set-memory-scrub', (_, { value }: { value: boolean }) => {
  try { return ok(setMemoryScrub(value === true)) } catch (e: any) { return err(e.message) }
})
ipcMain.handle('aiSecurity:scan', (_, { text }: { text: string }) => {
  try { return ok(aiSecurityScan(typeof text === 'string' ? text : '')) } catch (e: any) { return err(e.message) }
})
// Does this terminal have an un-submitted draft in the agent's input line?
//
// `aiInputStaging` is the shadow copy of what the user has typed since their last Enter —
// it accumulates keystrokes and resets to '' on submit. It was built for the prompt watch,
// but it is also the only signal we have for "the user is mid-sentence", because the line
// buffer itself lives inside the agent's TUI, not here.
//
// Anything that WRITES to a terminal unprompted (the compaction re-prime) must check this
// first: writeToTerminal appends at the cursor, so an unprompted write while the user is
// typing is appended onto their draft. Over-approximates (a typed-then-erased line still
// reads as pending), which is the safe direction — it defers rather than clobbers.
ipcMain.handle('aiSecurity:input-pending', (_, { id }: { id: string }) => {
  try { return ok((aiInputStaging.get(id) ?? '').length > 0) } catch (e: any) { return err(e.message) }
})
ipcMain.handle('aiSecurity:recent-audit', async (_, { limit }: { limit?: number }) => {
  // Number.isFinite, NOT `typeof === 'number'`: typeof NaN is 'number', so NaN took the clamp arm —
  // and Math.min/Math.max PROPAGATE NaN rather than clamping it. getRecentAudit(NaN) then does
  // lines.slice(Math.max(0, len - NaN)) -> slice(NaN) -> slice(0), returning the ENTIRE audit log:
  // exactly what the 2000 cap exists to prevent, and reachable straight from the renderer.
  try {
    const n = Number.isFinite(limit) ? Math.max(1, Math.min(2000, limit as number)) : 200
    return ok(await aiSecurityRecent(n))
  } catch (e: any) { return err(e.message) }
})
ipcMain.handle('aiSecurity:clear-audit', async () => {
  try { await aiSecurityClear(); return ok() } catch (e: any) { return err(e.message) }
})
ipcMain.handle('aiSecurity:append', async (_, entry: { agent: string; event: string; terminalId?: string; byteCount?: number; hitCount?: number; notes?: string }) => {
  try {
    if (!entry || typeof entry.agent !== 'string' || typeof entry.event !== 'string') return err('invalid entry')
    const allowed = ['terminal_open', 'terminal_close', 'redaction_hit', 'manual_scan']
    if (!allowed.includes(entry.event)) return err('invalid event')
    await aiSecurityAppend({
      agent: entry.agent,
      event: entry.event as any,
      terminalId: entry.terminalId,
      byteCount: entry.byteCount,
      hitCount: entry.hitCount,
      notes: entry.notes,
    })
    return ok()
  } catch (e: any) { return err(e.message) }
})

// Tier 3: anonymous usage events from the renderer (e.g. report-problem.submit,
// swarm.start). Caller is responsible for keeping props PII-free.
ipcMain.handle('telemetry:record-event', async (_, { name, props }: { name: string; props?: Record<string, unknown> }) => {
  try {
    if (typeof name !== 'string' || !name.trim()) return err('event name required')
    recordTelemetryEvent(name, props)
    return ok()
  } catch (e: any) { return err(e.message) }
})

// Open a URL in the user's default browser. Scoped to http(s) only —
// refuse file://, javascript:, chrome:, etc. so a misbehaving renderer
// cannot use this surface to launch local helpers or navigate to a
// dangerous scheme. The Report-a-Problem flow is the only current caller.
ipcMain.handle('shell:open-external', async (_, { url }: { url: string }) => {
  try {
    if (typeof url !== 'string') return err('url must be a string')
    let parsed: URL
    try { parsed = new URL(url) } catch { return err('invalid url') }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return err(`disallowed protocol: ${parsed.protocol}`)
    }
    await shell.openExternal(url)
    return ok()
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('shell:open-path', async (_, { path: pathStr }) => {
  try {
    const errorMsg = await shell.openPath(pathStr)
    if (errorMsg) return err(errorMsg)
    return ok()
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('dialog:pick-directory', async (_, { defaultPath }) => {
  try {
    if (process.env.TERMPOLIS_TEST_PROJECT_CWD) {
      trustWorkspace(process.env.TERMPOLIS_TEST_PROJECT_CWD)
      return ok(process.env.TERMPOLIS_TEST_PROJECT_CWD)
    }
    const result = await dialog.showOpenDialog(mainWindow!, {
      defaultPath: defaultPath || homedir(),
      properties: ['openDirectory'],
      title: 'Choose project directory',
    })
    if (result.canceled || !result.filePaths[0]) return ok(null)
    // Picking a folder through the native dialog is an explicit user
    // action — auto-trust so the user isn't double-prompted before the
    // first swarm run.
    trustWorkspace(result.filePaths[0])
    return ok(result.filePaths[0])
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('completion:path-entries', async (_, { dirPath }) => {
  try { return ok(listPathEntries(dirPath)) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('completion:path-commands', async () => {
  try { return ok(listPathCommands()) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('completion:env-vars', async () => {
  try { return ok(listEnvVars()) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('terminal:git-diff', async (_, { cwd }) => {
  try {
    const diff = safeGit(['diff', '--stat'], { cwd, timeout: 5000 }).trim()
    return ok(diff)
  } catch { return ok('') }
})

// Git operations for the Git Panel
ipcMain.handle('git:stage', async (_, { cwd, files }: { cwd: string; files: string[] }) => {
  try {
    const args = files.length > 0 ? ['add', '--', ...files] : ['add', '.']
    safeGit(args, { cwd, timeout: 10000 })
    return ok()
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('git:unstage', async (_, { cwd, files }: { cwd: string; files: string[] }) => {
  try {
    const args = files.length > 0 ? ['reset', 'HEAD', '--', ...files] : ['reset', 'HEAD', '.']
    safeGit(args, { cwd, timeout: 10000 })
    return ok()
  } catch (e: any) { return err(e.message) }
})

// Commit/Push Secret Shield -- run the SAME secret-rule engine the prompt watch uses, but at the
// GIT boundary: on what a commit will capture (the staged diff) and what a push will send (every
// unpushed patch). Returns a block reason, or null to allow.
//
// FAILS OPEN by design: a git or scanner error must never wedge the user's commit for a reason
// unrelated to secrets. The gate only ever BLOCKS on a positive secret match.
//
// But fail-open must never be fail-SILENT, and that distinction is most of this function's security
// value. A control whose failure looks exactly like success is worse than no control, because you
// go on believing you are protected. (Exactly the bug that made the gpg-private watcher rule
// useless: it could never fire, and its silence read as "nothing to report".)
//
// The realistic trigger is the PUSH scan. `git log -p --not --remotes` on a repo with no
// remote-tracking refs excludes nothing, so it diffs the ENTIRE history. That is CORRECT -- you are
// about to push all of it -- but it is unbounded. Overflow the buffer or hit the timeout and the
// throw used to be swallowed: the push went out UNSCANNED, with no warning, at exactly the moment
// the shield matters most. The first push of a whole history to a fresh remote is precisely when an
// old secret actually gets published.
function gitShieldGate(cwd: string, op: 'commit' | 'push'): string | null {
  let enabled = false
  try {
    enabled = getAiSecuritySettings().commitShield
  } catch {
    return null // settings unreadable -> treat as off. That is not a scan FAILURE, so do not cry one.
  }
  if (!enabled) return null

  try {
    // Give the push scan room and time. The alternative is throwing, and a throw here used to mean
    // the shield silently did nothing.
    const limits =
      op === 'push'
        ? { timeout: 120_000, maxBuffer: 512 * 1024 * 1024 }
        : { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 }
    const deps = { git: (args: string[]) => safeGit(args, { cwd, ...limits }) }
    const res = op === 'commit' ? scanStagedDiff(deps) : scanPushRange(deps)
    const reason = res.clean ? null : blockMessage(res, op)
    aiSecurityAppend({
      agent: 'git',
      event: res.clean ? 'commit_scan' : op === 'commit' ? 'commit_blocked' : 'push_blocked',
      byteCount: res.scannedBytes,
      hitCount: res.hitCount,
      notes: reason ?? `${op} scan clean`,
    }).catch(() => {})
    return reason
  } catch (e: any) {
    // Still ALLOW the operation -- but say so, loudly. Recorded in the audit log and surfaced to the
    // user, so "the shield did not run" can never again be mistaken for "the shield found nothing".
    const msg = String(e?.message ?? e)
    aiSecurityAppend({
      agent: 'git',
      event: 'shield_scan_failed',
      notes: `${op} scan DID NOT RUN (operation allowed through): ${msg}`,
    }).catch(() => {})
    mainWindow?.webContents.send('shield:scan-failed', { op, cwd, error: msg })
    return null
  }
}

// Feed REAL work outcomes into the competence layer, so "self-competence by domain"
// populates from ORDINARY use (a commit that landed, a test run that passed or failed)
// instead of only from swarm tasks and end-of-session magic phrases — which is why it
// sat empty at attempts:0 forever. Best-effort: a competence write must never break
// the user's git or test path.
function recordWorkOutcome(e: WorkEvent): void {
  try {
    const o = deriveOutcome(e)
    if (o) recordOutcome(o.domain, o.success, Date.now())
  } catch { /* best effort */ }
}

ipcMain.handle('git:commit', async (_, { cwd, message }: { cwd: string; message: string }) => {
  try {
    if (!message.trim()) return err('Commit message cannot be empty')
    const blocked = gitShieldGate(cwd, 'commit')
    if (blocked) return err(blocked)
    safeGit(['commit', '-m', message], { cwd, timeout: 30000 })
    recordWorkOutcome({ kind: 'git-commit', project: normalizeProjectSlug(cwd), ok: true })
    return ok()
  } catch (e: any) { return err(e.message) }
})

// ---- Commit Shield: git hooks (terminal + external-git coverage) -------------------
//
// WHY THIS EXISTS. `gitShieldGate` above only ever covered the git operations Termpolis
// ITSELF runs — the Git panel and Swarm Review. A `git commit` typed into a terminal pane,
// which is how most people actually commit, went straight past it. The shield was far
// narrower than its name implied.
//
// A real pre-commit/pre-push hook closes that. The hook shells out to a STANDALONE scanner
// (resources/mcp-adapter/termpolis-githook.cjs) that carries its own copy of the rule table,
// so it still protects you with Termpolis CLOSED — a hook that only works while the app is
// running would silently stop protecting you the moment you quit, which is worse than no
// hook at all. It fails OPEN on every error: a hook left behind by an uninstalled Termpolis
// must never wedge someone's git.
const SHIELD_REPOS_FILE = 'commit-shield-repos.json'

function shieldReposPath(): string { return join(app.getPath('userData'), SHIELD_REPOS_FILE) }

/** Canonical key for the protected-repo list.
 *
 *  The list used to be compared with a bare `!==`. Install stores either `opts.cwd` (renderer-
 *  supplied, e.g. `C:/repo`) or `picked.filePaths[0]` from the native dialog (OS-native, `C:
epo`),
 *  so installing via the picker and then uninstalling via cwd never matched: the repo stayed in
 *  commit-shield-repos.json and `gitHooks:list` kept reporting it as PROTECTED after its hooks were
 *  gone — a security control claiming to be armed when it is not. The same mismatch let install add
 *  both spellings as two separate entries. Resolve, unify separators, and case-fold on Windows
 *  (NTFS is case-insensitive; POSIX is not, so only fold where it is correct to). */
function shieldKey(p: string): string {
  // ghResolve: `resolve` is imported under an alias in this file.
  const r = ghResolve(p)
  if (process.platform !== 'win32') return r.replace(/\/+$/, '')
  // Windows only: separators are interchangeable and NTFS is case-insensitive, so the native
  // picker's `C:\\repo` and the renderer's `C:/repo` are the SAME repository. On POSIX a
  // backslash is a legal filename character and the filesystem is case-sensitive, so applying
  // either of these there would conflate two genuinely different paths.
  return r.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function readShieldRepos(): string[] {
  try {
    const arr = JSON.parse(ipRead(shieldReposPath(), 'utf8'))
    return Array.isArray(arr) ? arr.filter((x: unknown): x is string => typeof x === 'string') : []
  } catch { return [] }
}

function writeShieldRepos(list: string[]): void {
  // Dedupe on the CANONICAL key so the same repo cannot be stored twice under two different
    // spellings (forward-slash vs backslash, or differing case on Windows), while still
    // persisting each path in its original spelling for display.
  try {
    const seen = new Set<string>()
    const uniq = list.filter((r) => { const k = shieldKey(r); if (seen.has(k)) return false; seen.add(k); return true })
    writeFileSync(shieldReposPath(), JSON.stringify(uniq, null, 2))
  } catch { /* best effort */ }
}

const realHookDeps: HookDeps = {
  readFile: (p) => { try { return ipRead(p, 'utf8') } catch { return null } },
  writeFile: (p, d) => { mkdirSync(ghDirname(p), { recursive: true }); writeFileSync(p, d, 'utf8') },
  exists: (p) => ghExists(p),
  chmod: (p, m) => { try { ghChmod(p, m) } catch { /* windows has no exec bit */ } },
  remove: (p) => { try { unlinkSync(p) } catch { /* already gone */ } },
}

/** Resolve the repo's REAL hooks dir (honours worktrees / core.hooksPath), plus an absolute
 *  node and the shipped scanner. Null when `cwd` is not a git repository. */
function hookPathsFor(cwd: string): HookPaths | null {
  try {
    const rel = safeGit(['rev-parse', '--git-path', 'hooks'], { cwd, timeout: 5000 }).trim()
    if (!rel) return null
    return {
      hooksDir: ghResolve(cwd, rel),
      nodePath: resolveNodeCommand(),
      scriptPath: app.isPackaged
        ? join(process.resourcesPath, 'mcp-adapter', 'termpolis-githook.cjs')
        : join(__dirname, '../../src/mcp-adapter/termpolis-githook.cjs'),
    }
  } catch { return null }
}

ipcMain.handle('gitHooks:status', async (_, { cwd }: { cwd: string }) => {
  try {
    const paths = hookPathsFor(cwd)
    if (!paths) return err('Not a git repository')
    return ok({ status: hookStatus(paths, realHookDeps) })
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('gitHooks:install', async (_, opts: { cwd?: string } = {}) => {
  try {
    let repo = opts?.cwd
    if (!repo) {
      const picked = await dialog.showOpenDialog(mainWindow!, {
        title: 'Protect a repository with the Commit Shield',
        properties: ['openDirectory'],
      })
      if (picked.canceled || !picked.filePaths[0]) return ok({ canceled: true })
      repo = picked.filePaths[0]
    }
    const paths = hookPathsFor(repo)
    if (!paths) return err('Not a git repository — pick the folder that contains .git')
    mkdirSync(paths.hooksDir, { recursive: true })
    const written = installHooks(paths, realHookDeps)
    writeShieldRepos([...readShieldRepos(), repo])
    aiSecurityAppend({ agent: 'git', event: 'commit_scan', notes: `commit shield hooks installed: ${repo}` }).catch(() => {})
    return ok({ canceled: false, repo, written })
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('gitHooks:uninstall', async (_, { cwd }: { cwd: string }) => {
  try {
    const paths = hookPathsFor(cwd)
    if (!paths) return err('Not a git repository')
    const removed = uninstallHooks(paths, realHookDeps)
    writeShieldRepos(readShieldRepos().filter((r) => r !== cwd))
    return ok({ removed })
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('gitHooks:list', () => {
  try {
    return ok(readShieldRepos().map((repo) => {
      const paths = hookPathsFor(repo)
      return { repo, status: paths ? hookStatus(paths, realHookDeps) : null }
    }))
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('git:pull', async (_, { cwd }: { cwd: string }) => {
  try {
    const output = safeGit(['pull'], { cwd, timeout: 60000 }).trim()
    return ok(output)
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('git:push', async (_, { cwd }: { cwd: string }) => {
  try {
    const blocked = gitShieldGate(cwd, 'push')
    if (blocked) return err(blocked)
    const output = safeGit(['push'], { cwd, timeout: 60000 }).trim()
    return ok(output)
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('git:file-diff', async (_, { cwd, file }: { cwd: string; file: string }) => {
  try {
    const diff = safeGit(['diff', '--', file], { cwd, timeout: 5000 })
    return ok(diff)
  } catch { return ok('') }
})

ipcMain.handle('git:find-root', async (_, { cwd }: { cwd: string }) => {
  try {
    const root = safeGit(['rev-parse', '--show-toplevel'], { cwd, timeout: 3000 }).trim()
    return ok(root)
  } catch { return ok(null) }
})

// Swarm Review: capture the HEAD SHA at a point in time so we can diff the full
// swarm delta later. Returns null when outside a repo so the caller can skip
// review mode cleanly.
ipcMain.handle('git:rev-parse-head', async (_, { cwd }: { cwd: string }) => {
  try {
    const sha = safeGit(['rev-parse', 'HEAD'], { cwd, timeout: 3000 }).trim()
    return ok(sha)
  } catch { return ok(null) }
})

// Swarm Review: unified diff across a range. If `to` is omitted we diff against
// working tree + index so uncommitted swarm changes are included.
ipcMain.handle('git:diff-range', async (_, { cwd, from, to }: { cwd: string; from: string; to?: string }) => {
  try {
    if (!isValidGitRef(from)) return err('Invalid "from" ref')
    if (to !== undefined && !isValidGitRef(to)) return err('Invalid "to" ref')
    const range = to ? `${from}..${to}` : from
    const diff = safeGit(['diff', '--no-color', '--no-ext-diff', range], {
      cwd, timeout: 15000, maxBuffer: 16 * 1024 * 1024,
    })
    return ok(diff)
  } catch (e: any) { return err(e.message) }
})

// Swarm Review: list files changed between two refs (or from ref to working tree).
// Returns [{file, status}] where status is A/M/D/R100/etc.
ipcMain.handle('git:files-in-range', async (_, { cwd, from, to }: { cwd: string; from: string; to?: string }) => {
  try {
    if (!isValidGitRef(from)) return err('Invalid "from" ref')
    if (to !== undefined && !isValidGitRef(to)) return err('Invalid "to" ref')
    const range = to ? `${from}..${to}` : from
    const raw = safeGit(['diff', '--name-status', range], { cwd, timeout: 5000 }).trim()
    const files: { file: string; status: string }[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const parts = line.split('\t')
      const status = parts[0]
      // Renames look like "R100\told\tnew"; take the final name
      const file = parts[parts.length - 1]
      files.push({ file, status })
    }
    return ok(files)
  } catch (e: any) { return err(e.message) }
})

// Swarm Review: apply a patch string. Used to reverse-apply a single hunk to
// reject a change. reverse=true maps to `git apply -R`.
ipcMain.handle('git:apply-patch', async (_, { cwd, patch, reverse }: { cwd: string; patch: string; reverse?: boolean }) => {
  try {
    if (!patch || !patch.trim()) return err('Empty patch')
    const tmpPath = join(homedir(), `.termpolis-patch-${Date.now()}.diff`)
    writeFileSync(tmpPath, patch, 'utf8')
    try {
      const args = reverse
        ? ['apply', '-R', '--whitespace=nowarn', tmpPath]
        : ['apply', '--whitespace=nowarn', tmpPath]
      safeGit(args, { cwd, timeout: 10000 })
      return ok()
    } finally {
      try { require('fs').unlinkSync(tmpPath) } catch {}
    }
  } catch (e: any) { return err(e.message) }
})

// Swarm Review: restore one or more files to a specific SHA. Used for
// "reject this entire file" without touching other files.
ipcMain.handle('git:checkout-file', async (_, { cwd, sha, files }: { cwd: string; sha: string; files: string[] }) => {
  try {
    if (!files.length) return err('No files specified')
    if (!isValidGitRef(sha)) return err('Invalid SHA')
    safeGit(['checkout', sha, '--', ...files], { cwd, timeout: 10000 })
    return ok()
  } catch (e: any) { return err(e.message) }
})

// Swarm Review: hard reset back to pre-swarm SHA (revert-all). Destructive —
// UI must confirm before calling.
ipcMain.handle('git:reset-hard', async (_, { cwd, sha }: { cwd: string; sha: string }) => {
  try {
    if (!sha || !/^[a-f0-9]{7,40}$/i.test(sha)) return err('Invalid SHA')
    safeGit(['reset', '--hard', sha], { cwd, timeout: 10000 })
    return ok()
  } catch (e: any) { return err(e.message) }
})

// Swarm Review: stage everything then commit. Separate from git:commit because
// that one only commits already-staged changes.
ipcMain.handle('git:commit-all', async (_, { cwd, message }: { cwd: string; message: string }) => {
  try {
    if (!message.trim()) return err('Commit message cannot be empty')
    safeGit(['add', '-A'], { cwd, timeout: 15000 })
    // Gate AFTER `add -A` so the staged diff the shield scans is the complete set.
    const blocked = gitShieldGate(cwd, 'commit')
    if (blocked) return err(blocked)
    safeGit(['commit', '-m', message], { cwd, timeout: 30000 })
    recordWorkOutcome({ kind: 'git-commit', project: normalizeProjectSlug(cwd), ok: true })
    return ok()
  } catch (e: any) { return err(e.message) }
})

// Shared swarm memory — RAG layer so agents and the UI can write / retrieve
// facts across terminals without re-running expensive tools.
ipcMain.handle('memory:write', async (_, input: { agentId: string; kind: string; content: string; tags?: string[]; taskId?: string }) => {
  try {
    const entry = await memoryWrite({
      agentId: input.agentId,
      kind: (input.kind as MemoryEntry['kind']) || 'note',
      content: input.content,
      tags: input.tags,
      taskId: input.taskId,
    })
    try { recordMetric({ t: 'write', ts: Date.now(), ok: true, memoryType: entry.memoryType }) } catch { /* best effort */ }
    return ok(entry)
  } catch (e: any) {
    try { recordMetric({ t: 'write', ts: Date.now(), ok: false }) } catch { /* best effort */ }
    return err(e.message)
  }
})

ipcMain.handle('memory:search', async (_, opts: { query: string; limit?: number; agentId?: string; kind?: string; taskId?: string }) => {
  try {
    const started = Date.now()
    const results = await memorySearch({
      query: opts.query,
      limit: opts.limit,
      agentId: opts.agentId,
      kind: opts.kind as MemoryEntry['kind'] | undefined,
      taskId: opts.taskId,
    })
    // Reliability/receipt SLIs: a UI recall is a real recall — record it so the
    // dashboard reflects actual usage, not just agent-side MCP tool calls.
    //
    // Latency is captured BEFORE the embeddingsReady() probe below: that probe is a second RPC to
    // the memory process, and folding its round-trip into `ms` would inflate the recall-latency SLI
    // by the cost of a call the recall itself never made.
    const ms = Date.now() - started
    try {
      // `path`/`available` must reflect what ACTUALLY ran. embeddingsReady() asks the memory process
      // — where the embedder lives since v1.26.0 — whether semantic recall is up; booking a keyword
      // fallback as a vector recall would make this proof dashboard flatter itself, which is worse
      // than none. await: it is a Promise (a cross-process call), and a Promise is truthy, so
      // un-awaited EVERY recall would read as a vector hit even with the embedder down.
      const ready = await embeddingsReady()
      recordMetric({ t: 'recall', ts: Date.now(), ms, hits: results.length, topScore: results[0]?.score ?? 0, path: ready ? 'vector' : 'keyword' })
      recordMetric({ t: 'embed', ts: Date.now(), available: ready })
    } catch { /* best effort */ }
    return ok(results)
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('memory:list', async (_, opts: { limit?: number; agentId?: string; kind?: string; since?: number } = {}) => {
  try {
    const list = await memoryList({
      limit: opts.limit,
      agentId: opts.agentId,
      kind: opts.kind as MemoryEntry['kind'] | undefined,
      since: opts.since,
    })
    return ok(list)
  } catch (e: any) { return err(e.message) }
})

// These MUST await. ok(promise) would ship a Promise across the IPC boundary, where it is not
// structured-clonable — the renderer gets a clone error or an empty object, i.e. "your memory is
// gone". An un-awaited memoryClear() would also return success before the store had cleared.
ipcMain.handle('memory:count', async () => { try { return ok(await memoryCount()) } catch (e: any) { return err(e.message) } })
ipcMain.handle('memory:clear', async () => { try { await memoryClear(); return ok() } catch (e: any) { return err(e.message) } })
/** What the last Weave pass drew. Null until the indexer has run one — which is itself the
 *  signal worth surfacing, because "the Weave has never run" and "the Weave runs and mints
 *  nothing" used to look identical from outside. */
let lastWeaveStats: WeaveStats | null = null
ipcMain.handle('memory:stats', async () => { try { return ok({ ...(await memoryStats()), weave: lastWeaveStats }) } catch (e: any) { return err(e.message) } })
// Memory & Learning dashboard: the proof numbers, computed locally and offline.
// Store-derived composition + graph connections are always real; the ledger adds
// live reliability/receipt SLIs (sparse until the brain has been used a while).
ipcMain.handle('memory:metrics', async () => {
  try {
    const competence = competenceRecords()
      .slice()
      .sort((a, b) => b.attempts - a.attempts)
      .slice(0, 8)
      .map((c) => ({ domain: c.domain, attempts: c.attempts, confidence: c.confidence }))
    // EVERY one of these crosses to the memory process — the graph included. Un-awaited they sit in
    // the payload as Promises: `gs.nodes` reads undefined and byRelation structured-clones to {}, so
    // the dashboard reports an empty brain and nothing throws. The graph reads were the two that
    // v1.26.0 left behind pointing at the in-main module, which is the same empty answer by a
    // different route. graphRelationStats still counts in place, in the child — the tallies cross the
    // wire, never the edge set.
    const [store, recentActivity, gs, byRelation, embedderUp] = await Promise.all([
      memoryDashboardStats(), memoryRecentActivity(14), graphStats(), graphRelationStats(), embeddingsReady(),
    ])
    return ok({
      // embedUp reflects the LIVE embedder (a fresh cross-process probe), NOT the last recorded event.
      // Otherwise a stale 'down' embed event lingers on the tile after an upgrade until ~20 fresh
      // recalls age it out — the exact v1.27.4 field report: "down — keyword fallback" over a brain
      // that was actually serving semantic hits. The historical window (embedRecentUp/Total) is kept.
      ledger: { ...metricsSummary(Date.now()), embedUp: embedderUp },
      store,
      graph: { nodes: gs.nodes, edges: gs.edges, byRelation },
      // The STRUCTURAL code graph is a SEPARATE store from the semantic memory graph:
      // indexing a repo mints code symbols + caller->callee edges that never land in `graph`.
      // Surfacing it here is what makes "index a repo -> see connections" actually true.
      codeGraph: codeGraphStats(ALL_REPOS),
      competence,
      recentActivity,
    })
  } catch (e: any) { return err(e.message) }
})

// Live connections graph — a legible sample of the REAL knowledge graph (the densest
// subgraph: nodes + induced edges, labeled + typed). Fetched on demand rather than in
// the 5s metrics poll, since it's heavier and the force layout shouldn't reset each tick.
ipcMain.handle('memory:graph-sample', async (_e, opts: { limit?: number } = {}) => {
  try {
    return ok(await memoryGraphSample({ limit: opts?.limit }))
  } catch (e: any) { return err(e.message) }
})

// Ingest past AI sessions (Claude/Codex/Gemini transcripts on disk) into the
// shared memory so every agent can semantically recall them. Idempotent — only
// genuinely new chunks are embedded, so re-running is cheap.
ipcMain.handle('memory:ingest-conversations', async () => {
  try {
    const stats = await runConversationIngest(ingestMemoryDeps())
    return ok(stats)
  } catch (e: any) { return err(e.message) }
})

// Index the working repo's git-tracked source into the shared memory so agents
// can semantically recall the codebase. Secrets are never indexed (reuses the
// sensitive-file denylist). repoRoot is the active project directory.
ipcMain.handle('memory:ingest-code', async (_, opts: { repoRoot: string }) => {
  try {
    if (!opts?.repoRoot) return err('repoRoot required')
    // hasHashES, not hasHash: the sync per-chunk predicate cannot be answered by an out-of-process
    // store, and an async one would report every chunk as already-indexed (a Promise is truthy) —
    // the repo would appear to index and nothing would be written.
    const stats = await runCodeIngest(
      {
        hasHashes: memoryKnownHashes,
        write: memoryWrite,
        // memoryPruneCodePath resolves to the number pruned; the dep is void-returning. AWAITED, not
        // dropped: ingestCode re-asks membership right after this, and it must see the post-prune store.
        prunePath: async (filePath) => { await memoryPruneCodePath(filePath) },
      },
      { repoRoot: opts.repoRoot },
    )
    // Also (re)build the native STRUCTURAL code graph over the same repo — best-effort, so a
    // graph hiccup never fails the semantic ingest that already succeeded.
    let codeGraph
    try {
      // fsPromises.readFile, NOT readFileSync. The sweep `await`s this once per file, and an `await`
      // on an already-resolved promise (which is all an async-wrapped readFileSync returns) yields
      // only a microtask — Node drains those to completion WITHOUT running the event loop. That made
      // the whole repo sweep one unbroken 2.8s block: no PTY, no IPC, "(Not Responding)". A real
      // async read hits the threadpool and gives the main thread back between files.
      codeGraph = await buildCodeGraph({ listFiles: () => discoverRepoFiles(opts.repoRoot), readFile: (f) => fsPromises.readFile(f, 'utf8') }, graphKeyForRoot(opts.repoRoot))
      // Keep the graph FRESH: watch the repo and, on source-file changes (debounced), incrementally
      // re-index just the changed files (AST-first) with a full-sweep fallback — so edits show up in
      // seconds without re-parsing the whole tree. reindexWatchedChange owns the incremental-vs-full
      // logic (and is unit-tested); this callback just wires the real fs reader.
      ensureRepoWatch(opts.repoRoot, fsBackedWatchDeps(fsWatch, (root, files) => {
        void reindexWatchedChange(root, files, (f) => fsPromises.readFile(f, 'utf8'))
      }))
    } catch { /* best effort */ }
    return ok({ ...stats, codeGraph })
  } catch (e: any) { return err(e.message) }
})

// Native code-graph IPC (for the app UI / on-demand build + structural queries).
ipcMain.handle('code-graph:build', async (_, opts: { repoRoot: string }) => {
  try {
    if (!opts?.repoRoot) return err('repoRoot required')
    return ok(await buildCodeGraph({ listFiles: () => discoverRepoFiles(opts.repoRoot), readFile: (f) => fsPromises.readFile(f, 'utf8') }, graphKeyForRoot(opts.repoRoot)))
  } catch (e: any) { return err(e.message) }
})
ipcMain.handle('memory:anomalies', async (_, opts?: { limit?: number }) => { try { return ok({ anomalies: getAnomalies(opts?.limit ?? 100), total: anomalyCount() }) } catch (e: any) { return err(e.message) } })
ipcMain.handle('code-graph:stats', async () => { try { return ok(codeGraphStats()) } catch (e: any) { return err(e.message) } })
ipcMain.handle('code-graph:explore', async (_, opts: { query: string }) => { try { return ok(codeExplore(opts?.query || '')) } catch (e: any) { return err(e.message) } })
ipcMain.handle('code-graph:search', async (_, opts: { query?: string; limit?: number }) => { try { return ok(codeSymbols(opts?.query, opts?.limit ?? 50)) } catch (e: any) { return err(e.message) } })
ipcMain.handle('code-graph:callers', async (_, opts: { name: string }) => { try { return ok(codeCallers(opts?.name || '')) } catch (e: any) { return err(e.message) } })
ipcMain.handle('code-graph:impact', async (_, opts: { name: string }) => { try { return ok(codeImpact(opts?.name || '')) } catch (e: any) { return err(e.message) } })
// v1.23 C5 — issue->location prediction (on-demand for the UI; agents get the code_locate MCP tool).
ipcMain.handle('code-graph:locate', async (_, opts: { issue: string; projectKey?: string; limit?: number }) => { try { return ok(await locateIssueSites(opts?.issue || '', opts?.projectKey, opts?.limit)) } catch (e: any) { return err(e.message) } })
// v1.23 C6 — DEEP recall over the archive tier (cold/consolidated memories beyond the hot window).
ipcMain.handle('memory:deep-search', async (_, opts: { query: string; limit?: number }) => { try { return ok(await searchArchive(opts?.query || '', opts?.limit ?? 20)) } catch (e: any) { return err(e.message) } })

// ---- Safe Import ----------------------------------------------------------------
// Bring in a third-party skill / plugin / command / subagent / MCP server, PROVE it is
// safe and LOCAL-ONLY, then wire it into the agents.
//
// WHY: skill and MCP marketplaces are a live supply-chain vector — a skill is just files
// an agent will happily execute. The artifact is staged in memory and statically scanned
// BEFORE a single byte lands in ~/.claude. Nothing installs until the user approves the
// report, and a RED artifact (it can exfiltrate data or execute code) can NEVER install.
interface PendingImport {
  name: string
  kind: ArtifactKind
  hash: string
  files: ArtifactFile[]
  level: ImportRiskLevel
  targets: AgentTarget[]
}
let pendingImport: PendingImport | null = null
let importTrustReady = false

function ensureImportTrust(): void {
  if (importTrustReady) return
  initImportTrust(app.getPath('userData'))
  importTrustReady = true
}

function emitImportProgress(pct: number, stage: string): void {
  try { mainWindow?.webContents.send('safeImport:progress', { pct, stage }) } catch { /* window gone */ }
}

const MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024

/** Read a .zip or a directory into a flat, text-only file list (the quarantine copy). */
function readArtifactFiles(src: string): ArtifactFile[] {
  const out: ArtifactFile[] = []
  if (ipStat(src).isDirectory()) {
    const walk = (dir: string, rel: string): void => {
      for (const e of ipReaddir(dir, { withFileTypes: true })) {
        if (e.name === '.git' || e.name === 'node_modules') continue
        const abs = ipJoin(dir, e.name)
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) walk(abs, r)
        else if (ipStat(abs).size <= MAX_IMPORT_FILE_BYTES) out.push({ path: r, content: ipRead(abs, 'utf8') })
      }
    }
    walk(src, '')
  } else {
    for (const e of readZip(ipRead(src))) {
      if (e.data.length <= MAX_IMPORT_FILE_BYTES) out.push({ path: e.name, content: e.data.toString('utf8') })
    }
  }
  return out
}

ipcMain.handle('safeImport:scan', async () => {
  try {
    ensureImportTrust()
    const picked = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import a Skill or Plugin',
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'Skill / Plugin', extensions: ['zip'] }],
    })
    if (picked.canceled || !picked.filePaths[0]) return ok({ canceled: true })

    emitImportProgress(5, 'Reading artifact')
    const files = readArtifactFiles(picked.filePaths[0])
    if (files.length === 0) return err('Nothing to import — the artifact is empty')

    emitImportProgress(15, 'Classifying')
    const cls = classifyArtifact(files)
    if (!cls) return err('Unrecognised artifact — expected a skill (SKILL.md), plugin, slash-command, subagent, or MCP server')

    // Scan file-by-file so the progress bar reflects REAL work, yielding to the event
    // loop between files so the renderer actually paints each step.
    const findings: ImportFinding[] = []
    for (let i = 0; i < files.length; i++) {
      findings.push(...scanImportArtifact([files[i]]).findings)
      emitImportProgress(15 + Math.round(((i + 1) / files.length) * 70), `Scanning ${files[i].path}`)
      await new Promise((r) => setImmediate(r))
    }

    emitImportProgress(90, 'Assessing risk')
    const reds = findings.filter((f) => f.severity === 'red').length
    const yellows = findings.length - reds
    const level: ImportRiskLevel = reds > 0 ? 'red' : yellows > 0 ? 'yellow' : 'green'
    const summary = findings.length === 0 ? 'no dangerous constructs found' : `${reds} red, ${yellows} yellow`
    const hash = artifactHash(files)
    pendingImport = { name: cls.name, kind: cls.kind, hash, files, level, targets: supportedTargets(cls.kind) }

    aiSecurityAppend({
      agent: 'import',
      event: level === 'red' ? 'import_blocked' : 'import_scan',
      hitCount: findings.length,
      notes: `${cls.kind} "${cls.name}" — ${summary}`,
    }).catch(() => {})

    emitImportProgress(100, 'Done')
    return ok({
      canceled: false,
      name: cls.name, kind: cls.kind, hash, level, findings,
      filesScanned: files.length, summary,
      targets: pendingImport.targets,
      alreadyApproved: isApproved(hash),
    })
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('safeImport:approve-install', async (_, { targets }: { targets: string[] }) => {
  try {
    ensureImportTrust()
    const staged = pendingImport
    if (!staged) return err('Nothing staged to import — scan an artifact first')
    // The hard invariant: a red artifact is never installable, no matter what the UI sends.
    if (staged.level === 'red') {
      return err('Refusing to install: this artifact can exfiltrate data or execute code on your machine.')
    }
    const chosen = (targets || []).filter((t): t is AgentTarget => staged.targets.includes(t as AgentTarget))
    if (chosen.length === 0) return err('Pick at least one agent to wire it into')

    approveArtifact({
      id: staged.name, name: staged.name, kind: staged.kind,
      hash: staged.hash, riskLevel: staged.level, targets: chosen,
    })
    const installed = installArtifact(
      { name: staged.name, kind: staged.kind, files: staged.files },
      chosen, defaultInstallerDeps(),
    )
    aiSecurityAppend({ agent: 'import', event: 'import_scan', notes: `installed "${staged.name}" -> ${chosen.join(', ')}` }).catch(() => {})
    pendingImport = null
    return ok({ installed })
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('safeImport:list', () => {
  try { ensureImportTrust(); return ok(listImported()) } catch (e: any) { return err(e.message) }
})
ipcMain.handle('safeImport:revoke', (_, { id }: { id: string }) => {
  try { ensureImportTrust(); return ok(revokeArtifact(id)) } catch (e: any) { return err(e.message) }
})

// Brain export / import (portable .zip) — integrity-gated (zipArchive CRC + manifest SHA-256).
ipcMain.handle('brain:export', async () => {
  try {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export Memory',
      defaultPath: `termpolis-brain-${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
    })
    if (result.canceled || !result.filePath) return ok({ canceled: true })
    const ud = app.getPath('userData')
    const zip = await buildBrainArchive(ud, app.getVersion(), Date.now(), realBrainFs())
    writeFileSync(result.filePath, zip)
    return ok({ canceled: false, path: result.filePath, bytes: zip.length })
  } catch (e: any) { return err(e.message) }
})
ipcMain.handle('brain:import', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import Memory',
      properties: ['openFile'],
      filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
    })
    if (result.canceled || !result.filePaths?.[0]) return ok({ canceled: true })
    const buf = readFileSync(result.filePaths[0])
    const ud = app.getPath('userData')
    const res = await mergeBrainArchive(ud, buf, realBrainFs())
    if (!res.ok) return err(res.error || 'Import failed')
    // Reload stores whose files a fresh-machine import may have restored, so they take effect now.
    try { initCompetence(ud) } catch { /* best effort */ }
    try { initIdentity(ud) } catch { /* best effort */ }
    try { initMetrics(ud) } catch { /* best effort */ }
    try { initCodeGraph(ud) } catch { /* best effort */ }
    return ok({ canceled: false, memoriesImported: res.memoriesImported, edgesImported: res.edgesImported, restored: res.restored })
  } catch (e: any) { return err(e.message) }
})

// Freshness lane for every primer: a newest-first listing, scoped to the same repo the
// digest is about. Relevance ranking answers "most similar to the query"; a session-start
// digest also has to answer "where did we leave off", and only a time-ordered read can.
// Measured before this existed: a live primer for the termpolis repo returned hits aged
// 12 days to 1 month and nothing from that same day, while the store held that day's work.
const primerRecent: PrimerRecent = async (o) =>
  (await memoryList({ limit: o.limit, project: o.project, since: o.since })).map(e => ({
    content: e.content,
    source: e.source,
    kind: e.kind,
    score: 0, // not a scored hit — the lane is ordered by time, on purpose
    id: e.id,
    project: e.project,
    ts: e.ts,
  }))

// Pre-context primer: pull the most relevant memories for a query (e.g. the
// user's first ask or the active project) so it can be injected as an agent's
// first input — the agent starts already knowing the context instead of the
// user re-explaining it. Returns a shell-paste-safe string, or null.
ipcMain.handle('memory:build-primer', async (_, opts: { query: string; limit?: number; cwd?: string }) => {
  try {
    // Current-directory precedence: context for the cwd's project leads the
    // primer; unrelated global hits are labeled "may NOT apply".
    const project = opts?.cwd ? normalizeProjectSlug(opts.cwd) : ''
    const primer = await buildContextPrimer(memorySearch, { query: opts?.query ?? '', limit: opts?.limit ?? getPrimerLimit(), project: project || undefined, projectPath: opts?.cwd || undefined, recent: primerRecent })
    // Economics SLI: a built primer that gets returned is context injected on the
    // agent's behalf — record the (estimated) tokens so "tokens injected" is real.
    try { if (primer) recordMetric({ t: 'inject', ts: Date.now(), tokens: Math.ceil(primer.length / 4) }) } catch { /* best effort */ }
    return ok(primer)
  } catch (e: any) { return err(e.message) }
})

// Primer size (memories injected per primer) — user-tunable in the Memory panel.
// Lives in main because the MCP memory_primer handler reads it server-side too.
ipcMain.handle('memory:get-primer-limit', async () => {
  try { return ok(getPrimerLimit()) } catch (e: any) { return err(e.message) }
})
ipcMain.handle('memory:set-primer-limit', async (_, opts: { value: number }) => {
  try { return ok(setPrimerLimit(opts?.value)) } catch (e: any) { return err(e.message) }
})

// Vector quantization — the RAM/exactness dial for the packed vector store.
//
// Exposed so the Memory panel can be a DECISION AID rather than a mystery switch: it can show what
// the vectors actually cost and what the other mode would cost, and so it can say "don't turn this
// on" — which, at any ordinary corpus size, is the true answer. Off by default; losslessly
// reversible (disk always keeps exact floats), so it can be tried and reverted.
//
// What v1.25.16 deleted was NOT this read. `vectorRamStats()` is O(1) — it multiplies the store's
// row count by its dimension. What it deleted was the live PROCESS-HEALTH read (RSS, heap, GC
// pauses, event-loop percentiles) that used to ride along with it on a 2 s poll, off the same
// thread that echoes the user's keystrokes. So: no health here, and nothing on a timer. The panel
// reads this when the tab is opened and when Refresh is pressed, exactly like `memory:metrics`.
// See tests/electron/noMainThreadInstruments.test.ts.
// v1.26.1 — is the brain actually in its own process, or did it silently fall back to the main
// thread? The fallback is DESIGNED to be invisible (the app keeps working), which means a user
// could run for months paying the full main-thread cost with no way to know. Surface it.
ipcMain.handle('memory:host-status', async () => {
  try { return ok({ mode: memoryHostMode(), pid: memoryHostPid() ?? null }) } catch (e: any) { return err(e.message) }
})
ipcMain.handle('memory:get-vector-ram', async () => {
  // await before the spread: spreading a Promise yields {} — the panel would show a store with no
  // vectors at all and invite the user to "fix" it.
  try { return ok({ ...(await vectorRamStats()), persisted: getVectorQuantize() }) } catch (e: any) { return err(e.message) }
})
ipcMain.handle('memory:set-vector-quantize', async (_, opts: { value: boolean }) => {
  try {
    const on = opts?.value === true
    setVectorQuantize(on)                          // persist the choice...
    const stats = await setVectorQuantization(on)  // ...and rebuild the packed store in the new mode
    return ok({ ...stats, persisted: on })
  } catch (e: any) { return err(e.message) }
})

// The freeze history (`memory:get-stalls`) is GONE and stays gone — see
// tests/electron/noMainThreadInstruments.test.ts. Its detector named each freeze by harvesting a V8
// CPU profile on the main thread, a call that blocks for ~1 s at a 1.1 GB heap, from the very
// watchdog that reacted to blocking: 1,139 freezes / 890 s in one 21-minute session, every one of
// them its own doing. Diagnostics paid for out of the user's typing latency are not worth having.

// Claude launch primer: when relevant memory exists, write the memory-recall
// instruction to a temp file so Claude Code can be launched with
// `--append-system-prompt-file <path>` — seeding the session invisibly (nothing
// typed into the terminal) while keeping MCP tool access. Returns the file path,
// or null when there is no relevant memory to seed. The instruction routes the
// agent to memory_primer/memory_search; the digest itself loads via the tool, not
// inline, so it never bloats the system prompt.
ipcMain.handle('memory:prepare-primer-file', async (_, opts: { query: string; cwd?: string }) => {
  try {
    const project = opts?.cwd ? normalizeProjectSlug(opts.cwd) : ''
    const digest = await buildContextPrimer(memorySearch, { query: opts?.query ?? '', limit: getPrimerLimit(), project: project || undefined, projectPath: opts?.cwd || undefined, recent: primerRecent })
    if (!digest) return ok({ file: null, count: 0 }) // no relevant memory → launch bare, skip seeding
    try { recordMetric({ t: 'inject', ts: Date.now(), tokens: Math.ceil(digest.length / 4) }) } catch { /* best effort */ }
    const dir = join(app.getPath('userData'), 'primers')
    try { mkdirSync(dir, { recursive: true }) } catch { /* already exists */ }
    // Sweep stale primer files so the dir can't grow unbounded — Claude reads the
    // file at startup, so it's disposable within seconds of launch.
    try {
      const now = Date.now()
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        try { if (now - statSync(p).mtimeMs > 5 * 60_000) unlinkSync(p) } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    // Build the injected system-prompt bytes via a pure, determinism-guarded helper
    // (see injectedInstruction.ts) — the digest itself is fetched via memory_primer,
    // never inlined, so these bytes stay byte-stable per (cwd, steering, mode) and the
    // prompt cache survives. Steering settings are best-effort (optional feature).
    let steering = false
    let steeringMode: SteeringMode | undefined
    try {
      const hs = getHeadroomSettings()
      steering = hs.steering
      // No cast: SteeringMode and the config Mode must stay the same union. The cast that used to
      // sit here hid the 'max' tier from steering entirely — it fell through to the BALANCED
      // directive, so picking the hardest compression silently bought the weakest output nudge.
      steeringMode = hs.mode
      // Adaptive strength, resolved HERE (launch) and frozen for the session — the directive is
      // part of the re-sent system prompt, so a mid-conversation change would bust the prompt
      // cache. Measured lifetime output volume decides; too little history leaves the mode alone.
      if (hs.adaptiveSteering) {
        const cum = summarizeProxySavings().cumulative
        steeringMode = adaptSteeringMode(steeringMode, cum.outputTokens, cum.requests)
      }
      // Randomized holdout. A small deterministic slice of sessions launches UNSTEERED so
      // the app can answer "does steering actually reduce output?" with a comparison rather
      // than an assumption. The existing steered-vs-unsteered split in the ledger is
      // confounded — a session is unsteered because the user turned steering off, which
      // correlates with everything else about how they work — so it can describe the two
      // populations but cannot attribute the difference to steering. This can. The bucket is
      // keyed by cwd so a project stays on one side for the life of the experiment.
      if (steering && armForSession(opts?.cwd || 'default') === 'holdout') steering = false
    } catch { /* steering optional */ }
    const instruction = buildInjectedInstruction({ cwd: opts?.cwd, steering, mode: steeringMode })
    const file = join(dir, `primer-${uuidv4()}.txt`)
    writeFileSync(file, instruction, 'utf8')
    // Count the memories in the digest so the launch banner can show how much
    // recall was injected (observable recall — #1). Each gate-passed memory is
    // rendered as one "- [...]" line.
    const count = digest.split('\n').filter((l) => l.startsWith('- [')).length
    return ok({ file, count })
  } catch (e: any) { return err(e.message) }
})

// Codex parity. Codex has no `--append-system-prompt-file`, so the same instruction Claude gets
// invisibly at launch is delivered through the file Codex reads natively: `<cwd>/AGENTS.md`. The
// bytes come from the SAME builder, so the two agents cannot drift apart. Also clears any
// per-tool approval prompt on the memory tools — Codex writes `approval_mode = "approve"` the
// first time a user approves once, and a dialog on `memory_primer` is the difference between
// having the context and having it behind a click nobody sees.
ipcMain.handle('memory:prepare-codex-context', async (_, opts: { cwd?: string }) => {
  try {
    if (!opts?.cwd) return err('cwd required')
    let steering = false
    let steeringMode: SteeringMode | undefined
    try {
      const hs = getHeadroomSettings()
      steering = hs.enabled && hs.steering
      steeringMode = hs.mode
      if (hs.adaptiveSteering) {
        const cum = summarizeProxySavings().cumulative
        steeringMode = adaptSteeringMode(steeringMode, cum.outputTokens, cum.requests)
      }
      // Same holdout as the Claude path — keyed by cwd so a project is on the same side of
      // the experiment whichever agent it launches, and the arms stay comparable.
      if (steering && armForSession(opts.cwd) === 'holdout') steering = false
    } catch { /* steering optional */ }
    const agents = writeAgentsMd(opts.cwd, { cwd: opts.cwd, steering, mode: steeringMode })
    const approvals = ensureCodexMemoryAutoApproved(join(homedir(), '.codex', 'config.toml'))
    return ok({ file: agents.path, changed: agents.changed, approvals: approvals.tools.length })
  } catch (e: any) { return err(e.message) }
})

// Solo-session learning: reflect on a solo agent terminal's transcript delta so the
// learning brain (self-competence, distilled lessons, cross-agent pooling) grows from
// individual Claude / Codex / Gemini sessions — not only completed swarm tasks. Called
// by the renderer's useSessionReflection hook on idle-settle and on terminal close.
// Guarded / best-effort: a read, distill, or write failure never disturbs the terminal.
ipcMain.handle('memory:reflect-session', async (_, opts: { terminalId: string; cwd: string; agent: string }) => {
  try {
    if (!opts?.terminalId || !opts?.cwd || !opts?.agent) return ok({ fired: false, lessons: 0 })
    const project = normalizeProjectSlug(opts.cwd)
    const res = await reflectSoloSession(
      { terminalId: opts.terminalId, cwd: opts.cwd, agent: opts.agent, project },
      {
        readTranscript: (cwd, agent) => readSessionTranscript(cwd, agent),
        getCursor: (id) => sessionCursors.get(id),
        setCursor: (id, c) => { sessionCursors.set(id, c) },
        reflect: (episode) => {
          // Same sync-void `link` dep as reflectOnTask — collect, then mint after the reflector
          // returns, so the edges are on the graph before this resolves.
          const edges = collectEdges()
          return onSessionEpisode(episode, {
            distill: (ep) => distillEpisode(ep, MNEME_DISTILLER_ENABLED && isHighValueEpisode(ep) ? { llm: headlessDistiller } : {}),
            write: (input) => memoryWrite(input),
            recordOutcome,
            now: Date.now(),
            link: edges.collect,
            ensureEntity: ensureEntityNode,
            resolveCode: (names, project) => resolveCodeRefs(names, graphKeyForRoot(project ?? '')),
          }).then(async (r) => {
            await edges.flush()
            try { if (r.fired && r.lessons > 0) recordMetric({ t: 'reflect', ts: Date.now(), lessons: r.lessons }) } catch { /* best effort */ }
            return { fired: r.fired, lessons: r.lessons }
          })
        },
      },
    )
    return ok(res)
  } catch (e: any) { return err(e.message) }
})

// Cross-machine sync: the brain lives in device-sharded JSONL. Pointing it at a
// folder the user already syncs (Syncthing/Dropbox/iCloud/git) makes the same
// memory follow them across machines — no Termpolis server, no new trust. Each
// device writes only its own shard, so a file-sync tool never hits a conflict.
ipcMain.handle('memory:sync-status', async () => {
  try { return ok(await getSyncStatus()) } catch (e: any) { return err(e.message) }
})

ipcMain.handle('memory:set-sync-dir', async (_, opts: { dir: string | null }) => {
  try { return ok(await setSyncDir(opts?.dir ?? null)) } catch (e: any) { return err(e.message) }
})

// Native folder picker → enable sync to the chosen folder in one step.
ipcMain.handle('memory:choose-sync-dir', async () => {
  try {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: 'Choose a synced folder for Termpolis memory (e.g. inside Dropbox or Syncthing)',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (res.canceled || !res.filePaths[0]) return ok(await getSyncStatus())
    return ok(await setSyncDir(res.filePaths[0]))
  } catch (e: any) { return err(e.message) }
})

// At-rest encryption of the synced folder. Set/enter the passphrase (encrypts
// this device's shard + unlocks peers' encrypted shards); the key is derived
// locally and never leaves the machine, so the sync provider only sees
// ciphertext. Returns an error (e.g. wrong passphrase) without throwing.
ipcMain.handle('memory:set-sync-passphrase', async (_, opts: { passphrase: string }) => {
  try { return ok(await setSyncPassphrase(opts?.passphrase ?? '')) } catch (e: any) { return err(e.message) }
})

ipcMain.handle('memory:disable-sync-encryption', async () => {
  try { return ok(await disableSyncEncryption()) } catch (e: any) { return err(e.message) }
})

// WP-F: local at-rest encryption (no cross-machine sync required). Default-ON when the OS keychain is
// available; these let the user re-enable after an opt-out, or turn it off (decrypts + remembers).
ipcMain.handle('memory:enable-local-encryption', async () => {
  try { return ok(await enableLocalEncryption()) } catch (e: any) { return err(e.message) }
})
ipcMain.handle('memory:disable-encryption', async () => {
  try { return ok(await disableEncryption()) } catch (e: any) { return err(e.message) }
})

// Swarm Review: run the project's test runner and capture stdout/stderr/exitCode.
// Locked down to an allowlist of known test runners (npm/yarn/pytest/cargo/…)
// with zero shell metacharacters, so a compromised renderer or MCP client
// can't turn this into arbitrary RCE. 10 minute cap.
ipcMain.handle('workspace:is-trusted', async (_, { cwd }: { cwd: string }) => {
  try { return ok(isWorkspaceTrusted(cwd)) } catch (e: any) { return err(e.message) }
})

ipcMain.handle('workspace:trust', async (_, { cwd }: { cwd: string }) => {
  try { trustWorkspace(cwd); return ok() } catch (e: any) { return err(e.message) }
})

ipcMain.handle('workspace:revoke-trust', async (_, { cwd }: { cwd: string }) => {
  try { revokeWorkspaceTrust(cwd); return ok() } catch (e: any) { return err(e.message) }
})

ipcMain.handle('workspace:list-trusted', async () => {
  try { return ok(listTrustedWorkspaces()) } catch (e: any) { return err(e.message) }
})

ipcMain.handle('swarm:run-command', async (_, { cwd, command }: { cwd: string; command: string }) => {
  const parsed = parseSafeCommand(command)
  if ('error' in parsed) return err(parsed.error)
  // Workspace trust gate: repo-controlled scripts (e.g. npm test) run whatever
  // the package.json author put in the script, so an untrusted repo could
  // execute arbitrary code. Prompt once per folder; auto-trust on dialog pick.
  const trusted = await ensureWorkspaceTrust({
    cwd,
    reason: `Running "${command}"`,
    parentWindow: mainWindow,
  })
  if (!trusted) return err('Workspace not trusted — command cancelled')
  const result = runSafeCommand(parsed, { cwd, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 })
  // Ground truth, in BOTH directions: a passing suite raises competence for this
  // project, a failing one lowers it. This is the signal that makes the calibration
  // honest instead of a ratchet that only ever goes up.
  recordWorkOutcome({ kind: 'test-run', project: normalizeProjectSlug(cwd), exitCode: result.exitCode })
  return ok(result)
})

// POLLED every 3 s by the git status bar, per repo terminal. safeGit is execFileSync, which blocks
// the main thread for the entire spawn — measured at 227-300 ms per poll (a Windows git spawn alone
// is ~106 ms of process-creation tax), paid TWICE, on the thread that pumps every PTY. That is a
// 7-10% duty cycle of dead main thread for as long as the panel is open, and it reads as periodic
// stutter in terminal output. Same two commands, same parsing — just off-thread, and concurrent.
ipcMain.handle('git:status-parsed', async (_, { cwd }: { cwd: string }) => {
  try {
    const [branchRes, statusRes] = await Promise.all([
      safeGitAsync(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 2000 }).catch(() => ''),
      safeGitAsync(['status', '--porcelain'], { cwd, timeout: 5000 }),
    ])
    const branch = branchRes.trim()
    const statusRaw = statusRes.trim()
    const staged: { file: string; status: string }[] = []
    const unstaged: { file: string; status: string }[] = []
    for (const line of statusRaw.split('\n')) {
      if (!line.trim()) continue
      const indexStatus = line[0]
      const workTreeStatus = line[1]
      const file = line.slice(3).trim()
      if (indexStatus !== ' ' && indexStatus !== '?') staged.push({ file, status: indexStatus })
      if (workTreeStatus !== ' ' && workTreeStatus !== undefined) unstaged.push({ file, status: workTreeStatus === '?' ? 'U' : workTreeStatus })
    }
    return ok({ branch, staged, unstaged })
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('terminal:git-info', async (_, { cwd }) => {
  try {
    let status = ''
    let recentCommits = ''
    try {
      status = safeGit(['status', '--short'], { cwd, timeout: 3000 }).trim()
    } catch {}
    try {
      recentCommits = safeGit(['log', '--oneline', '-5'], { cwd, timeout: 3000 }).trim()
    } catch {}
    return ok({ status, recentCommits })
  } catch (e: any) { return err(e.message) }
})

// POLLED every 5 s by the status bar, per terminal. Both the cwd probe (lsof on macOS, always slow —
// there is no /proc) and the git branch read were SYNCHRONOUS, so this stalled the PTY-pumping thread
// for a few hundred ms every 5 s per open terminal. Both are async now; the handler was already async.
ipcMain.handle('terminal:status', async (_, { terminalId, fallbackCwd }) => {
  try {
    const liveCwd = await getTerminalCwdAsync(terminalId)
    const cwd = liveCwd || fallbackCwd
    const gitBranch = await safeGitAsync(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 2000 })
      .then((s) => s.trim())
      .catch(() => '')
    return ok({ cwd, gitBranch })
  } catch (e: any) { return err(e.message) }
})

// Check which AI agent commands are installed on the system
// Agent install-path discovery lives in ./agentPaths so the unix-only
// branches (NVM/fnm enumeration, interactive-shell PATH fork) can be unit-
// tested with Object.defineProperty(process,'platform',...) without
// dragging the whole Electron main module through resetModules.

// Check if a command exists — tries `where`/`which` against the *extended*
// PATH (covers NVM/asdf/volta and macOS GUI-launch PATH gaps from issue #8),
// then scans known install dirs as a belt-and-braces fallback.
function findAgentInstalled(command: string): boolean {
  const execOpts = {
    stdio: 'ignore' as const,
    timeout: 3000,
    windowsHide: true,
    env: { ...process.env, PATH: getExtendedPath() },
  }
  try {
    execSync(process.platform === 'win32' ? `where ${command}` : `which ${command}`, execOpts)
    return true
  } catch {}

  // Fallback: check known install locations directly (works even if
  // `which`/`where` is missing from PATH, or the binary is non-executable
  // but present).
  const { existsSync } = require('fs')
  const home = homedir()
  const ext = process.platform === 'win32' ? '.cmd' : ''
  const candidates = process.platform === 'win32'
    ? [
        join(home, 'AppData', 'Roaming', 'npm', `${command}${ext}`),
        join(home, 'AppData', 'Roaming', 'npm', `${command}.exe`),
        join(home, 'AppData', 'Local', 'pnpm', `${command}${ext}`),
        join(home, 'AppData', 'Local', 'pnpm', `${command}.exe`),
        join(home, 'AppData', 'Local', 'Google', 'Cloud SDK', 'bin', `${command}${ext}`),
        join(home, 'AppData', 'Local', 'Google', 'Cloud SDK', 'bin', `${command}.exe`),
        join(home, 'AppData', 'Local', 'Programs', command, `${command}.exe`),
      ]
    : getAgentExtraPaths().map((dir) => join(dir, command))
  for (const p of candidates) {
    if (existsSync(p)) return true
  }
  return false
}

ipcMain.handle('agents:detect', async () => {
  const agents = ['claude', 'codex']
  const results: Record<string, boolean> = {}
  for (const agent of agents) {
    results[agent] = findAgentInstalled(agent)
  }
  // Gemini's CLI is the Antigravity CLI (`agy`) now — both the sidebar "Gemini CLI" profile
  // (id 'gemini') and the Second Opinion Gemini option key off agy availability, not the
  // deprecated `gemini` binary.
  results['agy'] = findAgentInstalled('agy')
  results['gemini'] = results['agy']
  // Test hook: force a comma-separated list of agent ids to report as not installed,
  // so Playwright can deterministically open the InstallHint modal for that agent.
  const forceMissing = process.env.TERMPOLIS_FORCE_MISSING_AGENTS
  if (forceMissing) {
    for (const id of forceMissing.split(',').map((s) => s.trim()).filter(Boolean)) {
      results[id] = false
    }
  }
  return ok(results)
})

// Swarm IPC handlers for the dashboard
// Read terminal output buffer from renderer (used by swarm bridge for non-MCP agents)
ipcMain.handle('terminal:read-buffer', async (_, { terminalId, fromOffset }) => {
  const buffer = terminalOutputBuffers.get(terminalId) || ''
  const sliced = buffer.slice(fromOffset || 0)
  return ok({ output: sliced, length: sliced.length })
})

// Second Opinion: run a chosen agent headless over captured terminal output and return its
// review text. `args` carries a PROMPT_TOKEN placeholder where the (UNTRUSTED, terminal-
// scraped) prompt goes — the prompt is NEVER placed on a shell command line: on Windows the
// .cmd shims run through PowerShell with the prompt read from a temp file into a $p variable
// (the token position becomes $p); on unix the binary is exec'd directly (no shell) with the
// token swapped for the prompt. Only the validated argv tokens are ever interpolated.
const deliverSecondOpinion = (bin: string, args: string[], prompt: string, promptToken: string, opts: { timeoutMs: number }): Promise<{ stdout: string; stderr?: string; code: number }> =>
  new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: getExtendedPath() }
    const isWin = process.platform === 'win32'
    let tmp: string | null = null
    if (isWin) {
      // .cmd/.ps1 shims run through PowerShell; the prompt is read from a temp file into $p
      // (never on the command line — see secondOpinionSpawnPlan for the argv shaping).
      tmp = join(app.getPath('temp'), `termpolis-so-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`)
      try { writeFileSync(tmp, prompt, 'utf8') } catch { resolve({ stdout: '', code: 1 }); return }
      env.TP_SO_FILE = tmp
    }
    const { cmd, cmdArgs } = secondOpinionSpawnPlan(isWin, bin, args, promptToken, prompt)
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (r: { stdout: string; stderr?: string; code: number }): void => {
      if (settled) return
      settled = true
      if (tmp) { try { unlinkSync(tmp) } catch { /* best effort */ } }
      resolve(r)
    }
    try {
      // stdin:'ignore' gives the child an immediately-closed stdin — agents that read it
      // (e.g. `codex exec` logs "Reading additional input from stdin…") won't block. The
      // `timeout` kills a runaway review; stderr is captured so failures stay legible.
      const child = spawn(cmd, cmdArgs, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeoutMs })
      child.stdout?.on('data', (d) => { stdout += d.toString() })
      child.stderr?.on('data', (d) => { stderr += d.toString() })
      child.on('error', (e) => finish({ stdout: '', stderr: (e as Error).message, code: 1 }))
      child.on('close', (code) => finish({ stdout, stderr, code: code ?? 1 }))
    } catch (e) {
      finish({ stdout: '', stderr: (e as Error)?.message, code: 1 })
    }
  })

ipcMain.handle('agent:second-opinion', async (_e, opts: { agent: string; model?: string; content: string }) => {
  try {
    const agent = opts?.agent as SecondOpinionAgent
    if (!['claude', 'codex', 'gemini'].includes(agent)) return err('unsupported agent')
    const res = await runSecondOpinion({ agent, model: opts?.model, content: opts?.content || '' }, deliverSecondOpinion)
    return res.ok ? ok({ feedback: res.feedback }) : err(res.error || 'second opinion failed')
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('swarm:messages', async () => ok(getAllMessages()))
ipcMain.handle('swarm:tasks', async () => ok(listTasks()))
ipcMain.handle('swarm:send-message', async (_, { from, to, type, content }) => {
  try { return ok(sendMessage(from, to, type, content)) }
  catch (e: any) { return err(e.message) }
})
ipcMain.handle('swarm:create-task', async (_, { title, description, createdBy, assignTo }) => {
  try { return ok(createTask(title, description, createdBy, assignTo)) }
  catch (e: any) { return err(e.message) }
})
ipcMain.handle('swarm:update-task', async (_, { taskId, status, result }) => {
  try {
    const task = updateTask(taskId, status, result)
    if (!task) return err('Task not found')
    // Same Mneme reflex the MCP path has always had (see swarmUpdateTask below). Without it a task
    // finished from the dashboard or the auto-completion bridge taught the brain nothing, and the
    // two routes to the identical state change learned differently.
    if (status === 'completed' || status === 'failed') void reflectOnTask(task, status, result)
    return ok(task)
  } catch (e: any) { return err(e.message) }
})
ipcMain.handle('swarm:clear', async () => {
  try { clearSwarm(); return ok() }
  catch (e: any) { return err(e.message) }
})

// ---- Agent Event Bus IPC ----
// Query the recent event ring (renderer drives pagination via `since`/`limit`)
ipcMain.handle('agentActivity:query', async (_, { filter }: { filter?: EventFilter } = {}) => {
  try { return ok(queryEvents(filter || {})) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('agentActivity:stats', async () => {
  try { return ok({ ringSize: getRingSize(), dropped: getDroppedCount() }) }
  catch (e: any) { return err(e.message) }
})

// Test-only seam: e2e drives a synthetic agent event through the REAL bus so the
// renderer receives it via the exact same push path as live watcher events. Only
// registered under NODE_ENV=test, so production has no way to inject events.
if (process.env.NODE_ENV === 'test') {
  ipcMain.handle('agentActivity:__test_publish', async (_, { event }: { event?: Partial<AgentEvent> } = {}) => {
    try {
      if (!event || typeof event !== 'object') return err('event required')
      publishEvent(event as Omit<AgentEvent, 'id' | 'ts'> & { ts?: number })
      return ok(true)
    } catch (e: any) { return err(e.message) }
  })
  // Inject synthetic terminal output for a terminal id, so e2e can feed an agent
  // signature + a "Compacting conversation" marker into the real onTerminalData path.
  ipcMain.handle('terminal:__test_data', async (_, { id, data }: { id?: string; data?: string } = {}) => {
    try {
      if (id) mainWindow?.webContents.send('terminal:data', id, data ?? '')
      return ok(true)
    } catch (e: any) { return err(e.message) }
  })
  // Read back the raw terminal writes recorded above (the re-prime paste lands here).
  ipcMain.handle('terminal:__test_writes', async () => ok([...__testTerminalWrites]))
}

// ---- Context Pin IPC ----
ipcMain.handle('contextPins:list', async (_, { cwd }: { cwd: string }) => {
  try { return ok(listPins(cwd)) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('contextPins:add', async (_, { cwd, input }: { cwd: string; input: { label: string; body: string; source?: string; tags?: string[] } }) => {
  try { return ok(addPin(cwd, input)) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('contextPins:update', async (_, { cwd, id, patch }: { cwd: string; id: string; patch: Partial<ContextPin> }) => {
  try {
    const r = updatePin(cwd, id, patch)
    if (!r) return err('pin not found')
    return ok(r)
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('contextPins:remove', async (_, { cwd, id }: { cwd: string; id: string }) => {
  try { return ok({ removed: removePin(cwd, id) }) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('contextPins:clear', async (_, { cwd }: { cwd: string }) => {
  try { clearPins(cwd); return ok() }
  catch (e: any) { return err(e.message) }
})

// ---- Transcript Watcher IPC ----
// Renderer calls these when an agent is detected / terminal closes
ipcMain.handle('agentWatcher:attach', async (_, { terminalId, cwd, agentType }: { terminalId: string; cwd: string; agentType: DetectedAgent }) => {
  try {
    const handle = attachWatcher(terminalId, cwd, agentType)
    return ok({ attached: handle !== null })
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('agentWatcher:detach', async (_, { terminalId }: { terminalId: string }) => {
  try { detachWatchers(terminalId); return ok() }
  catch (e: any) { return err(e.message) }
})

ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize()
  else mainWindow?.maximize()
})
ipcMain.on('window:close', () => mainWindow?.close())

// Suppress node-pty async errors (e.g. resize on dead pty) that can't be try-caught
process.on('uncaughtException', (err) => {
  if (err.message?.includes('pty that has already exited')) return
  console.error('Uncaught exception:', err)
})

// Single instance lock — prevent multiple Termpolis windows from corrupting session data
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  // Another instance is already running — quit immediately
  app.quit()
} else {
  // When a second instance tries to launch, focus the existing window
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  let mcpServer: ReturnType<typeof startMcpServer> | null = null

  app.whenReady().then(() => {
    // null on Windows/Linux (custom title bar, no menu bar); a minimal app/edit/window role menu on
    // macOS, without which Cmd+Q and copy/paste in native inputs do not work. See appMenu.ts.
    installApplicationMenu(Menu, process.platform)
    createWindow()

    // Repair Windows shortcuts whose ICON_LOCATION was corrupted by the over-long
    // package.json description (see windowsShortcutRepair.ts). Shortening the
    // description fixes shortcuts the installer writes from here on, but the PINNED
    // TASKBAR shortcut lives in the user's profile and no installer ever rewrites
    // it — without this, existing users keep a generic taskbar icon forever.
    // Best-effort and fully guarded: an icon must never be able to break startup.
    if (process.platform === 'win32' && app.isPackaged) {
      try {
        repairWindowsShortcuts({
          platform: process.platform,
          exePath: process.execPath,
          exeDir: dirname(process.execPath),
          appUserModelId: 'com.termpolis.app',
          description: 'Secure AI-assisted development terminal.',
          candidatePaths: defaultShortcutPaths(process.env, join),
          fileExists: existsSync,
          readShortcutLink: (p) => shell.readShortcutLink(p),
          writeShortcutLink: (p, op, details) => shell.writeShortcutLink(p, op, details),
          log: (m) => console.log(m),
        })
      } catch { /* never block startup on shortcut cosmetics */ }
    }

    // Move ALL embedding onto a worker_thread so the memory brain's one-time model
    // load + per-chunk forward passes never peg the MAIN thread that also pumps PTY
    // echo. This is the fix for "typing lags for the first few minutes after opening
    // an AI agent terminal, then warms up": keystroke round-trips no longer wait behind
    // embedding. Safe by construction — any spawn/timeout/failure disables the worker
    // and falls back to the in-process embedder (today's behavior), so recall cannot
    // regress. The worker is spawned lazily on the first embed, off the main thread.
    try { setWorkerSpawner(() => createWorkerTransport()) } catch { /* keep in-process embedding */ }

    // Tier 3 heartbeat — counts unique daily launches. Internally de-duped
    // to once per UTC day, so re-opening the window does not re-fire.
    try { dailyLaunchPing(app.getVersion()) } catch {}

    // Check GitHub releases for updates, auto-download in background,
    // notify renderer when ready to install.
    initAutoUpdater(() => mainWindow, { onBeforeQuitAndInstall: () => { quittingForUpdate = true } })

    // Start MCP server for AI agent integration
    const mcpHandlers: McpToolHandlers = {
      listTerminals: () => {
        const session = loadSession()
        return session.terminals.map(t => ({ id: t.id, name: t.name, shellType: t.shellType, cwd: t.cwd }))
      },
      createTerminal: async (name, shell, cwd) => {
        if (mcpCreatedTerminals.size >= MAX_MCP_TERMINALS) {
          throw new Error(`Agent terminal limit reached (${MAX_MCP_TERMINALS}). Close existing agent terminals before creating more.`)
        }
        const id = uuidv4()
        const resolvedCwd = cwd || homedir()
        const shells = await detectAvailableShells()
        const shellInfo = shells.find(s => s.type === shell) || shells[0]
        if (shellInfo) {
          spawnTerminal(id, shellInfo.executable, resolvedCwd, (data) => {
            mainWindow?.webContents.send('terminal:data', id, data)
            // Buffer output for MCP read_output
            const existing = terminalOutputBuffers.get(id) || ''
            const updated = existing + data
            terminalOutputBuffers.set(id, updated.length > 32768 ? updated.slice(-32768) : updated)
          // Inject the proxy env for EVERY swarm worker: create_terminal fixes env BEFORE run_command
          // reveals the real command, and the conductor may name a Claude worker anything ("Backend
          // Dev"), so a name check would miss it. ANTHROPIC_BASE_URL is inert for non-Anthropic agents
          // (codex/gemini read OPENAI_*/Google env), so this compresses every Claude worker and
          // no-ops the rest; getProxyEnv() is null when the proxy is unhealthy → direct launch.
          }, getAgentExtraPaths(), getProxyEnv() ?? undefined)
        }
        // Track as MCP-created (swarm) terminal for command enforcement
        mcpCreatedTerminals.add(id)
        // Notify renderer to add the terminal to the store
        mainWindow?.webContents.send('mcp:terminal-created', { id, name, shell: shellInfo?.type || shell, cwd: resolvedCwd })
        return id
      },
      runCommand: (terminalId, command) => {
        // Enforce correct agent commands on swarm terminals
        const safeCommand = mcpCreatedTerminals.has(terminalId)
          ? sanitizeAgentCommand(command)
          : command
        writeToTerminal(terminalId, safeCommand + '\r')
      },
      readOutput: (terminalId, lines) => {
        const buffer = terminalOutputBuffers.get(terminalId) || ''
        const allLines = buffer.split('\n')
        const clampedLines = Math.max(1, Math.min(Math.floor(lines) || 50, 1000))
        return allLines.slice(-clampedLines).join('\n')
      },
      closeTerminal: (terminalId) => {
        killTerminal(terminalId)
        terminalOutputBuffers.delete(terminalId)
        mcpCreatedTerminals.delete(terminalId)
        mainWindow?.webContents.send('mcp:terminal-closed', terminalId)
      },
      writeToTerminal: (terminalId, text) => {
        writeToTerminal(terminalId, text)
      },
      getFileTree: (path) => {
        return listPathEntries(path)
      },
      getGitStatus: (cwd) => {
        let status = '', recentCommits = '', branch = ''
        try { status = safeGit(['status', '--short'], { cwd, timeout: 3000 }).trim() } catch {}
        try { recentCommits = safeGit(['log', '--oneline', '-5'], { cwd, timeout: 3000 }).trim() } catch {}
        try { branch = safeGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 3000 }).trim() } catch {}
        return { status, recentCommits, branch }
      },
      swarmSendMessage: (from, to, type, content) => {
        const validTypes = ['task', 'result', 'question', 'info', 'review'] as const
        if (!validTypes.includes(type as any)) throw new Error(`Invalid message type: ${type}`)
        return sendMessage(from, to, type as typeof validTypes[number], content)
      },
      swarmReadMessages: (terminalId) => {
        return readMessages(terminalId)
      },
      swarmCreateTask: (title, description, createdBy, assignTo) => {
        return createTask(title, description, createdBy, assignTo)
      },
      swarmListTasks: () => {
        return listTasks()
      },
      swarmUpdateTask: (taskId, status, result) => {
        const validStatuses = ['pending', 'in_progress', 'completed', 'failed'] as const
        if (!validStatuses.includes(status as any)) throw new Error(`Invalid task status: ${status}`)
        const task = updateTask(taskId, status as typeof validStatuses[number], result)
        // Mneme reflex: a finished task is an episode to learn from. Fire-and-forget.
        if (status === 'completed' || status === 'failed') void reflectOnTask(task, status, result)
        return task
      },
      swarmListAgents: () => {
        const session = loadSession()
        return session.terminals.map(t => ({ id: t.id, name: t.name, shellType: t.shellType, cwd: t.cwd }))
      },
      memoryWrite: async (input) => {
        try {
          const e = await memoryWrite({
            agentId: input.agentId,
            kind: (input.kind as MemoryEntry['kind']) || 'note',
            content: input.content,
            tags: input.tags,
            taskId: input.taskId,
            project: input.project,
          })
          try { recordMetric({ t: 'write', ts: Date.now(), ok: true, memoryType: e.memoryType }) } catch { /* best effort */ }
          return e
        } catch (writeErr) {
          try { recordMetric({ t: 'write', ts: Date.now(), ok: false }) } catch { /* best effort */ }
          throw writeErr
        }
      },
      memorySearch: async (opts) => {
        const started = Date.now()
        const res = await memorySearch({
          query: opts.query,
          limit: opts.limit,
          agentId: opts.agentId,
          kind: opts.kind as MemoryEntry['kind'] | undefined,
          taskId: opts.taskId,
          project: opts.project,
          diversify: opts.diversify, // agent-facing recall is gated + diversified (executeTool defaults it on)
          fuseGraph: opts.fuseGraph, // …and fuses graph-connected neighbours one hop out
        })
        // Capture latency BEFORE the readiness probe (a second memory-process RPC) so the probe's
        // round-trip does not inflate the recall-latency SLI.
        const ms = Date.now() - started
        try {
          // The embedder lives in the memory utilityProcess since v1.26.0, so main's
          // localEmbedder.isEmbedderReady() is ALWAYS false here — reading it booked every agent
          // recall as a keyword fallback even while the child returned a real semantic hit, so the
          // dashboard read "Embedding model: down" over a healthy brain. Ask the CHILD, via the same
          // proxied embeddingsReady() the UI recall path uses.
          const ready = await embeddingsReady()
          recordMetric({ t: 'recall', ts: Date.now(), hits: res.length, topScore: res[0]?.score ?? 0, path: ready ? 'vector' : 'keyword', ms })
          recordMetric({ t: 'embed', ts: Date.now(), available: ready })
        } catch { /* metrics are best-effort */ }
        // In-flow corrections apply on the READ path, not by rewriting the store: a memory
        // the user just retracted has to stop reaching agents on the very next recall, and
        // waiting for a re-index would mean the wrong fact gets used again in the same
        // session it was corrected in. Retracted entries are dropped; amended ones carry
        // the replacement text; demoted ones keep their place in the list but not their rank.
        return applyCorrections(res)
      },
      memoryList: (opts) => memoryList({
        limit: opts.limit,
        agentId: opts.agentId,
        kind: opts.kind as MemoryEntry['kind'] | undefined,
        since: opts.since,
        project: opts.project,
      }),
      // Behind-the-scenes memory load: agents call this (prompted by the one-line
      // launch pointer) instead of having the digest pasted into the terminal.
      // Current-directory context leads; cross-project hits follow, labeled.
      memoryPrimer: async (opts) => {
        const project = opts.cwd ? normalizeProjectSlug(opts.cwd) : ''
        const query = (opts.query || '').trim() ||
          (project
            ? `recent work, decisions, conventions, and context for ${project}`
            : 'recent work, key decisions, and conventions')
        const primer = await buildContextPrimer(memorySearch, {
          query,
          limit: opts.limit ?? getPrimerLimit(),
          maxSnippetChars: 600,
          project: project || undefined,
          projectPath: opts.cwd || undefined, // F19: scope precisely by the full cwd (projectKey)
          recent: primerRecent,
        })
        // Metacognition + curiosity + identity (P1c/P5): augment the primer with the
        // brain's self-assessed weak spots, open questions worth exploring, and its
        // continuous-identity digest. All no-ops until that state accrues.
        const primerOut = augmentPrimer(primer, {
          competence: competenceSummary(3),
          curiosity: curiosityPrompts(findGaps(competenceRecords()), 2),
          identity: identitySummary(3),
        })
        try { if (primerOut) recordMetric({ t: 'inject', ts: Date.now(), tokens: Math.ceil(primerOut.length / 4) }) } catch { /* best effort */ }
        return { project: project || null, primer: primerOut }
      },
      memoryRelated: (opts) => memoryRelated({
        id: opts.id,
        query: opts.query,
        limit: opts.limit,
      }),
      memoryLink: (opts) => memoryLink({ from: opts.from, to: opts.to, relation: opts.relation, createdBy: 'agent' }),
      memoryGraph: (opts) => memoryGraphQuery({
        id: opts.id,
        query: opts.query,
        relation: opts.relation,
        depth: opts.depth,
        limit: opts.limit,
      }),
      memoryFeedback: async (opts) => {
        const helpful = opts.helpful !== false
        try {
          recordMetric({ t: 'feedback', ts: Date.now(), helpful })
          // Cross-agent teaching: a helpful memory authored by a DIFFERENT agent than the
          // one giving feedback is real cross-agent reuse — the teaching-matrix signal.
          // await: un-awaited, `author` is a Promise — never === opts.agentId — so EVERY feedback
          // would book a cross_recall, with "[object Promise]" as the teaching agent.
          if (helpful && opts.agentId) {
            const author = await memorySourceById(opts.id)
            if (author && author !== opts.agentId) recordMetric({ t: 'cross_recall', ts: Date.now(), author, reader: opts.agentId })
          }
        } catch { /* best effort */ }
        return await memoryFeedback({ id: opts.id, helpful: opts.helpful, query: opts.query })
      },
      memorySelfcheck: (opts) => ({ ...assessCompetence(opts.domain), summary: competenceSummary(3) }),
      memoryPool: async (opts) => poolLessons(
        // F13: pool over the LESSONS in the full window, not just the newest ~200 rows (which an
        // actively-ingesting brain floods with non-lesson message chunks, hiding real corroboration).
        // poolLessons takes an ARRAY — .map() on the un-awaited Promise would throw.
        (await memoryLessons(opts.limit ?? 200))
          .map((m) => ({ source: m.source || m.agentId || 'unknown', content: m.content, memoryType: m.memoryType, importance: m.importance })),
      ),
      memoryAnticipate: async (opts) => {
        const q = proactiveQuery(opts.task || '')
        if (!q) return []
        const limit = opts.limit ?? 5
        // F12: over-fetch, THEN filter to procedural/high-importance and cap — otherwise a lesson
        // ranked just below the naive top-`limit` is a false negative and the fleet re-derives it.
        const hits = await memorySearch({ query: q, limit: limit * 8 })
        return hits.filter((h) => h.memoryType === 'procedural' || (h.importance ?? 0) >= 0.6).slice(0, limit)
      },
      memoryConflicts: async (opts) => {
        // Surface cross-agent contradictions over the SAME lesson set memory_pool uses. Read-only.
        // detectConflictsNli uses the conservative heuristic by default and the NLI model only when
        // it's been explicitly enabled + bundled (opt-in, per the learning-soundness rule).
        const lessons = (await memoryLessons(opts.limit ?? 200)).map(toAgentLesson)
        const conflicts = await detectConflictsNli(lessons)
        return conflicts.map((c) => ({
          a: { source: c.a.source, content: c.a.content },
          b: { source: c.b.source, content: c.b.content },
        }))
      },
      // Native code graph — structural "what/where" over the repo (complements the semantic
      // "roughly where is X" of memory_search). Read-only queries over the pre-indexed graph.
      codeExplore: (opts) => codeExplore(opts.query),
      codeCallers: (opts) => codeCallers(opts.name),
      codeCallees: (opts) => codeCallees(opts.name),
      codeImpact: (opts) => codeImpact(opts.name),
      codeSearch: (opts) => codeSymbols(opts.query, opts.limit ?? 50),
      codeLocate: (opts) => locateIssueSites(opts.issue, undefined, opts.limit),
      // In-flow memory correction: the agent (or the user through it) can strike out a
      // wrong recall at the moment it surfaces, instead of filing it for a review pass
      // that never happens. Nothing is deleted — see memoryCorrection.ts.
      memoryCorrect: (opts) => correctMemory({ id: opts.id, kind: opts.kind as 'retract' | 'amend' | 'demote', reason: opts.reason, replacement: opts.replacement }),
      // Governed access to EXTERNAL MCP servers. Termpolis has always published tools to
      // the agents; this is the other direction, and it is the only path by which an
      // upstream server's traffic passes the app's policy, secret scan and audit log.
      gatewayListTools: () => gatewayListTools(),
      gatewayCall: (opts) => gatewayCall(opts),
      retrieveFull: (token: string) => headroomRetrieveFull(token),

      // ── Operator verbs (CLI-only — see McpToolHandlers) ───────────────────────────────
      // A headless run of a hosted CLI, primed with this project's memory. The point of
      // the primer is that a CI job or a git hook starts with everything the app already
      // learned instead of from zero, which is the whole difference between "an agent in
      // a pipeline" and "an agent that has worked here before".
      agentExec: async (opts) => await runHeadless(
        {
          task: opts.prompt,
          ...(opts.agent ? { agent: opts.agent as ExecAgent } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.write !== undefined ? { write: opts.write } : {}),
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        },
        {
          deliver: deliverSecondOpinion,
          primer: async (cwd: string) => {
            const project = cwd ? normalizeProjectSlug(cwd) : ''
            return await buildContextPrimer(memorySearch, {
              query: project
                ? `recent work, decisions, conventions, and context for ${project}`
                : 'recent work, key decisions, and conventions',
              limit: getPrimerLimit(),
              maxSnippetChars: 400,
              project: project || undefined,
              projectPath: cwd || undefined,
              recent: primerRecent,
            })
          },
          remember: async (input) => await memoryWrite({
            agentId: 'headless-exec',
            kind: 'result',
            content: input.content,
            project: input.project,
          }),
        },
      ),

      savingsReceipt: (opts) => {
        if (opts.verify) {
          let parsed: SignedReceipt
          try {
            parsed = JSON.parse(opts.verify) as SignedReceipt
          } catch {
            return { ok: false, error: 'not valid JSON — pass the contents of a receipt file' }
          }
          return { ok: true, verify: checkReceipt(parsed) }
        }
        const receipt = issueReceipt(summarizeUnifiedSavings().cumulative, Date.now())
        return opts.format === 'json'
          ? { ok: true, receipt, text: renderReceiptJson(receipt) }
          : { ok: true, receipt, text: renderReceiptMarkdown(receipt) }
      },

      // Scored recall quality over the brain's OWN memories. Probes are derived from
      // signals already in the data (graph edges, distinctive terms, write-time
      // adjacency), so the benchmark measures this install's real corpus rather than a
      // synthetic set that would drift away from it.
      recallBench: async (opts) => {
        const limit = Math.min(Math.max(opts.limit ?? 200, 20), 1000)
        const entries = await memoryList({ limit, project: opts.project })
        const sample = await memoryGraphSample({ limit: Math.min(limit, 300) })
        const links = new Map<string, string[]>()
        for (const edge of sample.edges) {
          const list = links.get(edge.from)
          if (list) list.push(edge.to)
          else links.set(edge.from, [edge.to])
        }
        const memories: BenchMemory[] = entries.map((e) => ({
          id: e.id,
          content: e.content,
          ts: e.ts,
          ...(e.project ? { project: e.project } : {}),
          ...(links.has(e.id) ? { links: links.get(e.id) as string[] } : {}),
        }))
        const probes = buildProbes(memories)
        const result = await runBench(probes, async (query, searchLimit) =>
          await memorySearch({ query, limit: searchLimit, project: opts.project }))
        const verdict = checkRegression(result, loadBenchBaseline())
        // Only ever re-baseline on an explicit request: a bench that rebaselines every
        // run can never report a regression, because each result becomes the new normal.
        const saved = opts.save ? saveBenchBaseline(baselineFrom(result)) : false
        return { ok: true, text: formatBench(result), result, verdict, saved }
      },
    }

    initAuditLog(app.getPath('userData'))
    initEventBus(app.getPath('userData'))
    initContextPinStore(app.getPath('userData'))
    initMcpGateway(app.getPath('userData'))
    initMemoryCorrections(app.getPath('userData'))
    initReceiptIdentity(app.getPath('userData'))
    initRecallBench(app.getPath('userData'))
    initOutputEconomy(app.getPath('userData'))
    initAiSecurity()
    // Back the memory sync-key cache with the OS keychain (safeStorage: DPAPI /
    // Keychain / libsecret) — no native module, ships in the one executable.
    setSafeStorage(safeStorage)
    initAnomalyLog(app.getPath('userData')) // burn-in: capture surprising memory events (incl. this init's)

    // ── Token Headroom: settings + savings-ledger persistence (best-effort) ─────────────────────
    // Guarded per the app.whenReady rule — a bad file must never take the boot down.
    try {
      const hrDir = join(app.getPath('userData'), 'headroom')
      loadSettingsFromDisk(hrDir)
      loadLedgerBaseFromDisk(hrDir)
      // Compressed originals live on DISK from v1.34.0 on. The store used to be memory-only and
      // 192 entries deep, so a busy session evicted its own stashes within minutes and
      // retrieve_full answered "expired" for content that was never actually gone — and a restart
      // took every token with it. Disk-backed + size-capped, they survive both.
      setCcrDir(join(hrDir, 'ccr'))
      let hrFlushTimer: ReturnType<typeof setTimeout> | null = null
      setLedgerFlush(() => { // debounced, async, best-effort — never on the hot path
        if (hrFlushTimer) return
        hrFlushTimer = setTimeout(() => { hrFlushTimer = null; saveLedgerToDisk(hrDir) }, 2000)
      })
      ipcMain.handle('tokenSavings:get-settings', () => ok(getHeadroomSettings()))
      ipcMain.handle('tokenSavings:set-settings', (_e, p) => {
        const next = setHeadroomSettings(p || {})
        try { saveSettingsToDisk(hrDir) } catch { /* best effort */ }
        try { setProxyMode(next.mode) } catch { /* proxy honors the new mode live; aggressive default holds if this fails */ }
        try { setProxyDecay(next.prefixDecay) } catch { /* decay stays where it was → never silently turns itself on */ }
        try { setProxyThinkingCap(next.thinkingCap) } catch { /* cap stays where it was → never silently tightens */ }
        return ok(next)
      })
      ipcMain.handle('tokenSavings:get-receipt', () => ok(summarizeHeadroomSavings()))
      // The one honest number: wire proxy + MCP tool compressor, minus retrieve_full give-backs,
      // counted once. The two legacy per-layer handlers stay for back-compat.
      ipcMain.handle('tokenSavings:get-unified-receipt', () => ok(summarizeUnifiedSavings()))
      // The output side of the bill. Separate from the unified receipt on purpose: the
      // receipt reports what was saved, this reports whether the thing believed to be saving
      // it actually is — including the verdict that it is not.
      ipcMain.handle('tokenSavings:get-output-economy', () => {
        try { return ok(outputEconomyReport(getHeadroomSettings().thinkingCap || null)) }
        catch (e: any) { return err(e.message) }
      })
      // A portable, signed receipt. The dashboard number is only convincing to whoever is
      // looking at the dashboard; this one can be pasted into a procurement thread.
      ipcMain.handle('tokenSavings:export-receipt', (_e, opts: { format?: 'markdown' | 'json' } = {}) => {
        try {
          const receipt = issueReceipt(summarizeUnifiedSavings().cumulative, Date.now())
          return ok({ receipt, text: opts.format === 'json' ? renderReceiptJson(receipt) : renderReceiptMarkdown(receipt) })
        } catch (e: any) { return err(e.message) }
      })
    } catch { /* headroom persistence is best-effort */ }

    // ── Headroom compression proxy: ALWAYS-ON for Claude Code ───────────────────────────────────
    // Runs in a utilityProcess (off the main/PTY thread). Claude terminals launch through it via
    // ANTHROPIC_BASE_URL. Health-gated AT LAUNCH: if the proxy isn't up, getProxyEnv() returns null and
    // Claude launches DIRECT. A live session is pinned to the proxy port for its lifetime, so a
    // sustained proxy outage would surface transient API errors until the child self-heals — it rebinds
    // the SAME port and maybeRestart() never gives up (backs off, then retries). New launches during an
    // outage always go direct. Net: launch is failure-proof; a live session is self-healing, not immune.
    try {
      const hrProxyDir = join(app.getPath('userData'), 'headroom')
      loadProxyBaseFromDisk(hrProxyDir)
      // The depth curve is fitted to this user's own traffic, so it has to survive relaunches —
      // a curve rebuilt from scratch every launch would sit below MIN_BAND_SAMPLES forever and
      // the advisory would never say anything.
      loadDepthCurveFromDisk(hrProxyDir)
      // One-shot lifetime-meter reset: a `.reset-proxy-totals` file in the headroom dir zeroes the
      // cumulative baseline once on next launch (e.g. after a compression-methodology change), so the
      // reported savedPct reflects the NEW rate instead of a stale blended lifetime average.
      try {
        const resetSentinel = join(hrProxyDir, '.reset-proxy-totals')
        if (existsSync(resetSentinel)) { resetProxyCounters(); saveProxyTotalsToDisk(hrProxyDir); unlinkSync(resetSentinel) }
      } catch { /* best effort */ }
      let hrProxyFlushTimer: ReturnType<typeof setTimeout> | null = null
      setProxyLedgerFlush(() => {
        if (hrProxyFlushTimer) return
        // The output experiment rides the same debounce as the ledger it samples from: the
        // two must never disagree about which requests happened, and one timer guarantees it.
        hrProxyFlushTimer = setTimeout(() => { hrProxyFlushTimer = null; saveProxyTotalsToDisk(hrProxyDir); saveDepthCurveToDisk(hrProxyDir); flushOutputEconomy() }, 3000)
      })
      onProxyResult((r) => { try { recordProxyResult(r) } catch { /* best effort */ } })
      // The result only lands once the upstream response ends, but Claude can call retrieve_full
      // the moment the token streams back — so the originals are committed on the request path too.
      onProxyStash((s) => { for (const st of s.stashes) { try { ccrPut(st.token, st.original, 'proxy') } catch { /* best effort */ } } })
      ipcMain.handle('tokenSavings:get-proxy-receipt', () => ok(summarizeProxySavings()))
      const hrProxyEntry = fileURLToPath(new URL('./headroomProxy.js', import.meta.url))
      setProxySpawner(() => createProxyTransport(hrProxyEntry))
      // Carry the user's mode + thinking cap into the proxy child from its very first init
      // (defaults: mode 'aggressive', cap 0 = off). When floor control is on, the ledger — not
      // the selector alone — decides the tier: it escalates if the measured 50% floor isn't
      // holding. Resolved HERE, before the first request, and frozen for the session, because a
      // mid-conversation re-tier would rewrite already-cached history and bust the prompt cache.
      try {
        const hs = getHeadroomSettings()
        let wireMode = hs.mode
        if (hs.floorControl) {
          const cum = summarizeProxySavings().cumulative
          wireMode = resolveWireMode(wireMode, cum)
        }
        setProxyMode(wireMode)
        setProxyThinkingCap(hs.thinkingCap)
        setProxyDecay(hs.prefixDecay)
      } catch { /* defaults hold */ }
      void pickFreePort().then((port) => { if (port > 0) startProxy({ port }) })
    } catch { /* headroom proxy is best-effort; Claude launches direct */ }

    // ── The memory brain starts in ANOTHER PROCESS ────────────────────────────────────────────────
    // initSwarmMemory() blocked THIS thread for ~4,276 ms on a real 475 MB / 90,817-entry store —
    // the thread that paints the window and echoes every PTY keystroke. It now runs in a
    // utilityProcess (memoryHost.ts) and main talks to it over RPC.
    //
    // Deliberately NOT awaited. Awaiting would trade a 4.3 s freeze for a 4.3 s blank screen: the
    // point is that createWindow() happens NOW and the store loads behind it. Calls made before the
    // child reports ready queue on the handshake inside memoryClient rather than failing.
    //
    // The quantization choice rides along in the init message instead of being applied here, because
    // it must be set BEFORE the packed vector array is allocated — and that allocation now happens
    // in the child. (Applying it after would re-run initSwarmMemory: a second full load, every boot.)
    // The settings read is guarded exactly as it was in-process: a corrupt settings file must fall
    // back to exact float32, never take the brain down with it.
    let quantize = false
    try { quantize = getVectorQuantize() } catch { /* fall back to exact floats */ }
    setMemoryHostSpawner(() => createMemoryHostTransport())
    void startMemoryHost({
      userDataPath: app.getPath('userData'),
      quantize,
    }).then((m) => {
      // Say which side is serving. An in-process fallback is a real regression in launch latency and
      // typing lag, so it must never be silent — this is the line that tells us the child died.
      if (m === 'host') console.log(`[termpolis][memory] brain is OFF the main thread (mode=${m})`)
      else console.warn(`[termpolis][memory] FALLBACK — the brain is running ON the main thread (mode=${m}); launch and typing will stall`)
    })
    // Memory-at-rest secret scrub. Redact secrets BEFORE a memory is hashed, embedded, or
    // written to disk, so a key sitting in a transcript or an indexed source file never
    // lands in the brain — and can therefore never be recalled back into an agent's context
    // later. Installing this scrubber IS the security boundary: with none installed the
    // store keeps content verbatim, so this call is not optional.
    setMemoryScrubber((content) => {
      if (!getAiSecuritySettings().memoryScrub) return { redacted: content, hitCount: 0 }
      const scan = aiSecurityScan(content)
      if (scan.hitCount > 0) {
        aiSecurityAppend({
          agent: 'memory',
          event: 'memory_scrub',
          hitCount: scan.hitCount,
          notes: scan.hits.map((h) => h.rule).join(','),
        }).catch(() => {})
      }
      return scan
    })
    initCodeGraph(app.getPath('userData')) // native code graph: load any persisted structural graph
    // Warm the embedder shortly after startup so the FIRST recall isn't a cold model-load spike (was
    // ~2.8 s in the field). Since v1.26.0 the embedder lives in the memory utilityProcess, so the load
    // is OFF the main thread — it can no longer stall first keystrokes and needn't wait the old ~20 s;
    // warming it early makes recall fast from the first query instead of paying the cold load then.
    setTimeout(() => { warmProbeEmbeddings().catch(() => {}) }, 2500)
    // Periodically compact this device's append-only shard once it's mostly dead lines
    // (threshold-gated + non-forced → a no-op until it's worth it), so per-reload parse cost
    // stays bounded as the log grows. Lossless + atomic (compactSelfShard proves the round-trip).
    // It runs in the memory process now, so the compaction itself costs main nothing; the .catch is
    // what keeps a rejected RPC from becoming an unhandled rejection in main.
    setInterval(() => { compactSelfShard().catch(() => { /* best effort */ }) }, 30 * 60 * 1000)
    initCompetence(app.getPath('userData')) // Mneme: load the persistent self-competence store
    initMetrics(app.getPath('userData')) // Memory & Learning dashboard: device-local metrics ledger
    initIdentity(app.getPath('userData')) // Mneme: load the continuous-identity store
    // A native fatal (V8 abort, OOM kill) never becomes a JS exception, so the Sentry→GitHub alert —
    // which matches catchable JS errors — files NOTHING: v1.27.4's 3-second crash-loop made the app
    // unusable for hours and opened ZERO issues. You can't catch your own abort, but you can notice it
    // NEXT boot: an uncleared marker means the last session died hard. Reported as a JS-level event,
    // which the existing alert does file.
    // Guarded like the dailyLaunchPing(app.getVersion()) call above, and for the same reason: this is
    // crash reporting, a nicety — it must NEVER be the thing that stops the app launching. (Written
    // unguarded first, it threw on app.getVersion() and took whenReady down with it before
    // startMcpServer ever ran — the cascade the macOS Menu.buildFromTemplate lesson warns about.)
    try {
      const crashMarkerPath = join(app.getPath('userData'), 'last-session.json')
      initCrashWatch({
        readMarker: () => { try { return readFileSync(crashMarkerPath, 'utf8') } catch { return null } },
        writeMarker: (json) => { try { writeFileSync(crashMarkerPath, json) } catch { /* best effort */ } },
        now: () => Date.now(),
        version: app.getVersion(),
        pid: process.pid,
        report: (ctx) => recordUncleanExit(ctx),
      })
      // Advances lastSeen so the next boot can report HOW LONG the dead session ran — a ~0s uptime is
      // the crash-loop tell. One tiny JSON write a minute.
      setInterval(() => { try { crashHeartbeat() } catch { /* best effort */ } }, 60_000)
    } catch { /* crash detection unavailable — never block launch over it */ }
    initWorkspaceTrust()

    // Auto-feed the memory brain: ingest past AI conversations on a quiet timer
    // (10s after launch, then every 30 min) so it grows itself with no user
    // action. Ingestion is idempotent (content-hash dedup) — steady-state runs
    // only embed genuinely new chunks and are cheap.
    //
    // Each pass is capped (maxChunks) and the ingest loop yields between embeds,
    // so a first index over months of history can't peg the main thread / freeze
    // the UI — it drains as short, responsive bursts (the indexer reschedules a
    // quick follow-up whenever a pass reports more backlog).
    startIndexer({
      run: async () => {
        // Pick up entries other machines synced into the shared folder (no-op
        // when cross-machine sync is off).
        try { await reloadMemoryFromSync() } catch { /* best effort */ }
        const stats = await runConversationIngest(
          ingestMemoryDeps(), // F30: backfill legacy project tags each pass (now persisted)
          { maxChunks: 250 },
        )
        // Keep the on-disk HNSW graph tracking recent state (no-op if not built).
        try { await persistMemoryIndex() } catch { /* best effort */ }

        // ── The three PURE PLANNERS ───────────────────────────────────────────────────────────────
        // runConsolidation and runWeave are SYNC, and runSummarization hands its deps to a sync
        // planMerges. They call candidates() / simOf() / neighbours() and use the result IMMEDIATELY.
        //
        // The store is out of process, so every one of those is a Promise now. Passing the proxies
        // straight through would hand the planners a Promise where they expect an array (planMerges
        // iterates it → nothing) and a Promise where they expect a number (`sim > threshold` → NaN →
        // false). Consolidation would then either stop working forever or decide to forget the WRONG
        // memories — and the `catch { /* best effort */ }` around it would swallow every trace.
        //
        // So: AWAIT the data first, hand the planner sync closures over the resolved values, let it
        // DECIDE, and apply its decisions afterwards with real awaits and real error handling.
        try {
          const cnow = Date.now()
          // v1.23 C6: ARCHIVE cold chatter (recoverable) instead of memoryDelete (permanent
          // tombstone) — the "rock solid: never silently lose memory" fix. Archived entries leave
          // the hot window but stay recoverable via searchArchive / the deep-search IPC.
          const decayCands = await consolidationCandidates(500)
          const toArchive: string[] = []
          runConsolidation({
            candidates: () => decayCands,          // resolved data, not a Promise
            simOf: () => 0,                        // unchanged: the scheduled pass is decay-only
            forget: (id) => { toArchive.push(id) }, // COLLECT the decision — do not act in the planner
            now: cnow,
          })
          for (const id of toArchive) {
            try { await memoryArchive(id) } catch { /* best effort — one failure never aborts the pass */ }
          }

          // P2 (summaries): cluster near-duplicates in a bounded window and write a
          // higher-level `summary` node linking them (additive; a no-op when the
          // embedder is unavailable, since it needs real vectors).
          //
          // The SAME limit must go to both, or the comparator will not know entries it is asked
          // about (an unknown id scores 0 — exactly what the in-process closure does for a
          // vector-less entry). Fetched together so no other main-process task can slip a write
          // between the two calls and desync the candidate list from the matrix.
          const [sumCands, simOf] = await Promise.all([consolidationCandidates(200), consolidationSimOf(200)])
          const sumEdges = collectEdges('consolidate')
          await runSummarization({
            candidates: () => sumCands,
            simOf,                          // a sync (a, b) => number, rebuilt in main over the shipped matrix
            write: (i) => memoryWrite(i),   // genuinely async, and runSummarization already awaits it
            link: sumEdges.collect,
            now: cnow,
          })
          await sumEdges.flush()
          auditMemory({ event: 'learn', kind: 'consolidate', detail: 'idle consolidation + summarization pass' }) // WP-E
        } catch { /* best effort */ }

        // v1.23 C4 — The Weave: continuously draw cross-repo analogies + backfill bridge anchors
        // AHEAD OF TIME so the agents reason faster (the connections are already there). Bounded,
        // idempotent, best-effort; runs on this idle tick so it never touches a hot path.
        try {
          const wcands = await weaveCandidates(300)
          // runWeave asks for neighbours(id, k) from INSIDE its loop, once per candidate — 300 RPCs
          // per pass if proxied naively. One batched call instead, keyed by id, with the SAME k
          // runWeave will use (imported, so the two cannot drift).
          const nbrs = await weaveNeighboursBatch(wcands.map((c) => c.id), WEAVE_NEIGHBOUR_K)
          const weaveEdges = collectEdges('weave')
          const backfills: Array<{ id: string; refs: CodeRef[] }> = []
          const weaveStats = runWeave(
            {
              candidates: () => wcands,
              neighbours: (id) => nbrs[id] ?? [], // sync closure over the pre-fetched neighbourhood
              link: weaveEdges.collect,
              // The CODE graph stays in main and is still synchronous — leave it alone.
              resolveCode: (names, projectKey) => resolveCodeRefs(names, projectKey),
              backfillCodeRefs: (id, refs) => { backfills.push({ id, refs }) },
            },
            { maxPerPass: 200, neighbourK: WEAVE_NEIGHBOUR_K },
          )
          // B2: the Weave used to run silently, so "is the graph actually being drawn?" had no
          // answer short of dumping the store. `considered` without `minted` is the shape that
          // matters — it means the miner spent its whole 200-edge budget re-proposing edges that
          // already exist, which is exactly the failure the novelty check in addMemoryEdge fixes.
          lastWeaveStats = weaveStats
          if (weaveStats.minted > 0 || weaveStats.considered > 0) {
            console.log(`[mneme] weave: considered ${weaveStats.considered}, minted ${weaveStats.minted} (bridge ${weaveStats.bridged}, code ${weaveStats.codeAnalogies}, knowledge ${weaveStats.knowledgeAnalogies}, explains ${weaveStats.explains})`)
          }
          // Deferring the backfill is behaviour-identical: weaveCandidates returns a fresh
          // PROJECTION, so a codeRefs write never reached the objects this pass reasons over anyway
          // (the explains miner reads e.codeRefs off the projection), and weaveNeighbours ranks by
          // vector, which a codeRefs patch does not touch.
          for (const b of backfills) {
            try { await backfillCodeRefs(b.id, b.refs) } catch { /* best effort */ }
          }
          await weaveEdges.flush()
        } catch { /* best effort */ }
        return { written: stats.chunksWritten, more: stats.truncated }
      },
      // Fast tier (#2 live-session lag): every 90s, ingest ONLY transcripts touched
      // in the last 10 min — i.e. the ACTIVE session — so its new turns become
      // searchable via memory_search within seconds instead of waiting the full
      // 30-min pass. The freshness stat-filter keeps this cheap even with hundreds
      // of past sessions on disk (it stats, not re-reads, the cold ones).
      fastIntervalMs: 90_000,
      fastRun: async () => {
        const stats = await runConversationIngest(
          ingestMemoryDeps(), // F30: backfill legacy project tags each pass (now persisted)
          // F16: the fast pass re-reads the ACTIVE session — emit only sealed chunks so a
          // growing trailing partial doesn't deposit a superset duplicate every 90s.
          { maxChunks: 250, freshSinceTs: Date.now() - 10 * 60_000, chunkOptions: { sealedOnly: true } },
        )
        try { await persistMemoryIndex() } catch { /* best effort */ }
        return { written: stats.chunksWritten, more: stats.truncated }
      },
    })

    // Sensitive-file-read watcher: subscribe to agent tool_call events from
    // the transcript watchers and surface a banner + audit entry when the
    // agent autonomously reads a high-risk file (.env, *.pem, ~/.aws/*, ...).
    // The file's already been read by the time we see the event — this is
    // an after-the-fact alert so the user can add the path to .claudeignore
    // (or equivalent) before the next session.
    try {
      subscribeSensitiveReads((ev: SensitiveReadEvent) => {
        try {
          aiSecurityAppend({
            agent: ev.agent || 'unknown',
            event: 'sensitive_file_read',
            terminalId: ev.terminalId,
            notes: ev.rule + ':' + ev.tool + ':' + ev.source + ':' + ev.filePath.slice(0, 200),
          }).catch(() => {})
        } catch {}
        try {
          mainWindow?.webContents.send('terminal:sensitive-file-read', {
            id: ev.terminalId,
            agent: ev.agent,
            tool: ev.tool,
            rule: ev.rule,
            label: ev.label,
            filePath: ev.filePath,
            source: ev.source,
            ts: ev.ts,
          })
        } catch {}
      })
    } catch {}

    // Push events to the renderer (live feed)
    subscribeEvents((event: AgentEvent) => {
      try { mainWindow?.webContents.send('agentActivity:event', event) } catch {}
      // Auto-ingest swarm messages/results into shared memory so other agents
      // can RAG-retrieve context without re-running the same tools.
      try {
        if ((event.kind === 'message' || event.kind === 'tool_result') && event.summary) {
          memoryWrite({
            agentId: event.terminalId || event.agentType || 'unknown',
            kind: event.kind === 'message' ? 'message' : 'result',
            content: event.summary,
            tags: [event.agentType].filter(Boolean) as string[],
            ...(event.taskId && { taskId: event.taskId }),
          }).catch(() => { /* ignore */ })
        }
      } catch { /* ignore */ }
    })
    mcpServer = startMcpServer(mcpHandlers)
    console.log(`MCP auth token: ${getMcpAuthToken()}`)

    // ── Workflow Orchestrator: deterministic local automation engine ──
    // Deps are built from the SAME substrate the app already trusts: managed
    // PTYs (terminalManager), the agent-status heuristic, and the in-process
    // MCP handlers. Wrapped in try/catch per the app-boot rule so a wiring
    // fault can never fatal `whenReady`.
    try {
      const wfFs = { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } as unknown as WorkflowFsLike
      const wfSpawn = { spawnTerminal, writeToTerminal, killTerminal }
      // Command steps store a logical shell TYPE ('bash'|'powershell'|...).
      // node-pty needs a concrete executable — bare 'bash' throws "File not
      // found" on Windows — so resolve the type to a real path before spawning.
      // Agent steps launch CLIs (claude/codex/agy) that are NOT shell types, so
      // they keep the plain, unresolved spawn.
      // Fall back to the platform's default shell TYPE when a Command step's
      // chosen shell can't be spawned in this environment (e.g. a CI runner
      // that can't posix_spawn `/bin/bash`). Matches getDefaultShell's
      // preferredByOs so the fallback is a shell the OS is guaranteed to have.
      const wfDefaultShellType = (({ darwin: 'zsh', linux: 'bash', win32: 'powershell' }) as Record<string, string>)[process.platform] ?? 'bash'
      const wfCommandSpawn = {
        ...wfSpawn,
        defaultShell: wfDefaultShellType,
        spawnTerminal: (id: string, exe: string, cwd: string, onData: (s: string) => void, extraPaths?: string[], extraEnv?: Record<string, string>, onExit?: (code: number) => void) =>
          spawnTerminal(id, resolveShellExecutable(exe), cwd, onData, extraPaths, extraEnv, onExit),
      }
      const wfTerminal = makeTerminalRunner(wfCommandSpawn)
      const wfAgentLaunch: Record<'claude' | 'codex' | 'gemini', string> = { claude: 'claude', codex: 'codex', gemini: 'agy' }
      const wfAgent = makeAgentRunner(
        wfSpawn,
        (out: string, name?: string) => detectAgentStatus(out, name || 'claude'),
        (agent) => wfAgentLaunch[agent],
      )
      const wfTools = makeToolInvoker(mcpHandlers, executeTool)
      // Trigger supervisor: arms schedule/gitCommit/gitPush/fileWatch workflows
      // and drives them through the SAME startRun the Run button uses. Created
      // before the IPC so it can be handed the change callbacks, and given
      // startRun afterwards (the two reference each other).
      let wfStartRun: ((cwd: string, id: string, opts?: { scope?: WorkflowScope }) => { ok: boolean; done?: Promise<void>; error?: string }) | null = null
      const wfTriggers = new TriggerSupervisor({
        fs: wfFs,
        readBytes: (p: string) => readFileSync(p),
        watch: (dir, listener) => fsWatch(dir, { recursive: true }, listener),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
        now: Date.now,
        isTrusted: (cwd: string) => { try { return isWorkspaceTrusted(cwd) } catch { return false } },
        // Global workflows arm in every watched project, not just the one they
        // were authored in.
        globalDir: app.getPath('userData'),
        fire: (cwd, id, reason, scope) => {
          const r = wfStartRun?.(cwd, id, { scope })
          if (!r?.ok) console.warn(`[workflow] trigger (${reason}) could not start ${id}: ${r?.error ?? 'no runner'}`)
          return r?.done
        },
        log: (m) => console.log(m),
      })
      const wfIpc = registerWorkflowIpc(ipcMain, () => mainWindow, {
        fs: wfFs,
        onWorkflowsChanged: (cwd, scope) => { if (scope === 'global') wfTriggers.rearmAll(); else wfTriggers.rearm(cwd) },
        onWatchProject: (cwd) => wfTriggers.watchProject(cwd),
        engine: { runWorkflow: wfRun, cancelRun: wfCancel },
        isTrusted: (cwd: string) => { try { return isWorkspaceTrusted(cwd) } catch { return false } },
        newRunId: () => randomUUID(),
        userDataDir: app.getPath('userData'),
        makeDeps: (emit, runId) => ({ terminal: wfTerminal, agent: wfAgent, tools: wfTools, timer: realTimer, now: Date.now, newRunId: () => runId, emit }),
      })
      wfStartRun = wfIpc.startRun
      // The home store is always watched: it's the fallback project the sidebar
      // shows before any terminal exists, so triggers saved there must arm too.
      // Before arming it, sweep out any demo workflows a screenshot/demo run
      // left behind in the home store — once per version, so a fresh install or
      // an upgrade cleans up and ordinary launches do nothing.
      oncePerVersion(app.getPath('userData'), app.getVersion(), wfFs, () => {
        cleanupDemoWorkflows(homedir(), wfFs, undefined, (m) => console.log(m))
      })
      // Arm every project the last session had open, not just the home store.
      // The sidebar registers a project when you look at it, which is too late
      // for a cron saved in a project you don't click into this launch.
      // Only the session READ is guarded — a broken session file must still
      // leave the home store armed, which sessionProjectCwds guarantees.
      let wfSession: SessionLike = null
      try {
        wfSession = loadSession()
      } catch (e) {
        console.warn('[workflow] could not read the saved session:', (e as Error)?.message)
      }
      for (const c of sessionProjectCwds(wfSession, homedir())) wfTriggers.watchProject(c)
      wfTriggers.start()
      app.on('before-quit', () => { try { wfTriggers.stop() } catch { /* shutting down anyway */ } })
      console.log(`[workflow] orchestrator IPC registered (${wfTriggers.armedCount} trigger(s) armed)`)

      // Learning signals. deriveOutcome has graded 'git-commit' and 'test-run' since the
      // competence layer shipped, but nothing emitted them for ordinary work done in a
      // terminal, so every domain sat at attempts:0 forever. Started here because this is
      // where the session + git plumbing the two watchers need is already resolved.
      //
      // A commit made through the app's own git UI is credited twice: once inline at the
      // ipcMain 'git:commit' handler and once when the poller sees HEAD move. Both are
      // ok:true, so the overlap inflates a positive count and can never flip a verdict —
      // not worth cross-module suppression state. Terminal commits, the case this exists
      // for, are credited exactly once.
      try {
        startLearningSignals({
          openProjects: () => { try { return sessionProjectCwds(loadSession(), homedir()) } catch { return [] } },
          cwdForTerminal: (id) => { try { return loadSession().terminals.find((t) => t.id === id)?.cwd ?? null } catch { return null } },
          normalizeProject: normalizeProjectSlug,
          emit: recordWorkOutcome,
          subscribe: subscribeEvents,
          fs: { existsSync, readFileSync },
          readBytes: (rp: string) => readFileSync(rp),
        })
        app.on('before-quit', () => { try { stopLearningSignals() } catch { /* shutting down anyway */ } })
      } catch (e) {
        console.warn('[learning] signal watchers could not start:', (e as Error)?.message)
      }
    } catch (wfErr) {
      console.error('[workflow] failed to register orchestrator IPC', wfErr)
    }
    // Write token to a file so AI agents can discover it. On Windows the
    // 0o600 mode is a no-op, so writeSecureFile also applies an NTFS ACL
    // restricting the file to the current user.
    const tokenPath = join(app.getPath('userData'), 'mcp-token')
    const tokenWrite = writeSecureFile(tokenPath, getMcpAuthToken())
    if (!tokenWrite.aclApplied) {
      console.warn(`[mcp-token] ACL not applied on ${tokenPath}: ${tokenWrite.aclError}`)
    }
    console.log(`MCP token written to: ${tokenPath}`)
    // Write the actual port (may differ from 9315 if port was taken).
    // awaitMcpPortBound resolves when server.listen succeeds on any of the
    // 5 candidate ports — unlike the old setTimeout(500, ...) this can't race.
    const portPath = join(app.getPath('userData'), 'mcp-port')
    awaitMcpPortBound().then((boundPort) => {
      const portWrite = writeSecureFile(portPath, String(boundPort))
      if (!portWrite.aclApplied) {
        console.warn(`[mcp-port] ACL not applied on ${portPath}: ${portWrite.aclError}`)
      }
      console.log(`MCP port written to: ${portPath} (port ${boundPort})`)
    }).catch((err) => {
      console.error(`[mcp-port] Failed to bind MCP server, port file not written: ${err.message}`)
    })

    // Auto-register Termpolis as an MCP server in Claude Code's settings
    const adapterPath = app.isPackaged
      ? join(process.resourcesPath, 'mcp-adapter', 'stdio-adapter.cjs')
      : join(__dirname, '../../src/mcp-adapter/stdio-adapter.cjs')

    // Preflight — if the adapter file isn't on disk, EVERY Claude Code session
    // will silently fail to register the Termpolis MCP server, and the
    // conductor will bypass the swarm. Logging this loudly on startup turns
    // a silent packaging bug into a visible one.
    if (!require('fs').existsSync(adapterPath)) {
      const msg = `[FATAL] MCP stdio adapter not found at ${adapterPath} — the swarm conductor will have NO MCP tools. Check electron-builder extraResources config.`
      console.error(msg)
      try {
        const Sentry = require('@sentry/electron/main')
        Sentry.captureMessage?.(msg, 'error')
      } catch {}
    }

    // Portable SessionStart memory hook — ships alongside the adapter and is
    // registered into every user's Claude settings so memory recall is
    // deterministic (digest injected at session start, not reliant on the model).
    const hookPath = app.isPackaged
      ? join(process.resourcesPath, 'mcp-adapter', 'memory-primer-hook.cjs')
      : join(__dirname, '../../src/mcp-adapter/memory-primer-hook.cjs')
    if (!require('fs').existsSync(hookPath)) {
      console.warn(`[memory-primer] SessionStart hook not found at ${hookPath} — deterministic memory recall will be disabled for new Claude sessions (non-fatal).`)
    }

    // Also write standalone config for reference
    const mcpConfigPath = join(app.getPath('userData'), 'claude-mcp-config.json')
    const mcpConfig = { mcpServers: { termpolis: { command: 'node', args: [adapterPath] } } }
    require('fs').writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 'utf-8')

    // Auto-inject into Claude Code's global settings (~/.claude/settings.json).
    // Registers MCP server + auto-trusts all Termpolis tools. All robustness
    // (corrupt JSON, missing file, wrong types, atomic write) lives in the helper.
    {
      const claudeSettingsPath = join(homedir(), '.claude', 'settings.json')
      // Normalize to forward slashes for the embedded command string (node
      // accepts them on every OS; the registry also normalizes defensively).
      const r = registerInClaudeSettings(claudeSettingsPath, adapterPath, hookPath.replace(/\\/g, '/'), resolveNodeCommand())
      if (r.changed) console.log('Auto-registered Termpolis MCP server, tool permissions, and memory hook in Claude Code settings')
      else if (r.error) console.log('Could not auto-register in Claude Code settings (non-fatal):', r.skipped, r.error)
    }

    // Also write to ~/.mcp.json (global MCP config that Claude Code actually loads).
    {
      const globalMcpPath = join(homedir(), '.mcp.json')
      const r = registerInGlobalMcp(globalMcpPath, adapterPath)
      if (r.changed) console.log('Auto-registered Termpolis in global ~/.mcp.json')
      else if (r.error) console.log('Could not write ~/.mcp.json (non-fatal):', r.skipped, r.error)
    }

    // Register as a Claude Code local plugin (this is how Claude actually loads MCP servers)
    // Write to BOTH the marketplace source AND the cache (Claude reads from cache at startup)
    try {
      const localMarketplace = join(homedir(), '.claude', 'local-marketplace')
      const pluginDir = join(localMarketplace, 'plugins', 'termpolis')
      const pluginMetaDir = join(pluginDir, '.claude-plugin')
      require('fs').mkdirSync(pluginMetaDir, { recursive: true })

      // Plugin manifest
      const pluginJson = join(pluginMetaDir, 'plugin.json')
      if (!require('fs').existsSync(pluginJson)) {
        require('fs').writeFileSync(pluginJson, JSON.stringify({
          name: 'termpolis',
          description: 'AI-native terminal manager MCP server. Create terminals, run commands, read output, and coordinate multi-agent swarms.',
          author: { name: 'Termpolis' }
        }, null, 2))
      }

      // MCP config for the plugin — Claude Code expects the mcpServers wrapper;
      // without it the server silently fails to register and the conductor has
      // no MCP tool access (symptom: swarm posts "analyzing..." then nothing).
      const pluginMcp = join(pluginDir, '.mcp.json')
      const mcpContent = JSON.stringify({ mcpServers: { termpolis: { command: 'node', args: [adapterPath] } } }, null, 2)
      const existingMcp = require('fs').existsSync(pluginMcp) ? require('fs').readFileSync(pluginMcp, 'utf-8') : ''
      if (existingMcp !== mcpContent) {
        require('fs').writeFileSync(pluginMcp, mcpContent)
      }

      // Enable the plugin in Claude Code settings
      let marketplaceName = 'local-plugins'
      if (require('fs').existsSync(join(homedir(), '.claude', 'settings.json'))) {
        const settings = JSON.parse(require('fs').readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf-8'))
        if (!settings.enabledPlugins) settings.enabledPlugins = {}

        // Detect local marketplace name from settings
        if (settings.extraKnownMarketplaces) {
          for (const [name, config] of Object.entries(settings.extraKnownMarketplaces as Record<string, any>)) {
            if (config?.source?.path?.includes('local-marketplace')) {
              marketplaceName = name
              break
            }
          }
        }

        const pluginKey = `termpolis@${marketplaceName}`
        if (!settings.enabledPlugins[pluginKey]) {
          settings.enabledPlugins[pluginKey] = true
          const tmpPath = join(homedir(), '.claude', 'settings.json.tmp')
          require('fs').writeFileSync(tmpPath, JSON.stringify(settings, null, 2), 'utf-8')
          require('fs').renameSync(tmpPath, join(homedir(), '.claude', 'settings.json'))
          console.log(`Enabled Termpolis plugin as ${pluginKey}`)
        }
      }
      // Also write directly to the plugin cache (Claude reads from cache at startup)
      const cacheDir = join(homedir(), '.claude', 'plugins', 'cache', marketplaceName, 'termpolis', '1.0.0')
      const cacheMetaDir = join(cacheDir, '.claude-plugin')
      require('fs').mkdirSync(cacheMetaDir, { recursive: true })
      require('fs').writeFileSync(join(cacheMetaDir, 'plugin.json'), JSON.stringify({
        name: 'termpolis',
        description: 'AI-native terminal manager MCP server. Create terminals, run commands, read output, and coordinate multi-agent swarms.',
        author: { name: 'Termpolis' }
      }, null, 2))
      require('fs').writeFileSync(join(cacheDir, '.mcp.json'), mcpContent)
      console.log('Termpolis plugin cached at:', cacheDir)

      // Register in marketplace.json manifest (required for Claude to discover the plugin)
      const marketplaceJsonPath = join(localMarketplace, '.claude-plugin', 'marketplace.json')
      if (require('fs').existsSync(marketplaceJsonPath)) {
        const manifest = JSON.parse(require('fs').readFileSync(marketplaceJsonPath, 'utf-8'))
        if (manifest.plugins && !manifest.plugins.some((p: any) => p.name === 'termpolis')) {
          manifest.plugins.push({
            name: 'termpolis',
            description: 'AI-native terminal manager MCP server. Create terminals, run commands, read output, manage split panes, and coordinate multi-agent swarms.',
            version: '1.0.0',
            author: { name: 'Termpolis' },
            source: './plugins/termpolis',
            category: 'development',
            strict: false,
          })
          const tmpManifest = marketplaceJsonPath + '.tmp'
          require('fs').writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2), 'utf-8')
          require('fs').renameSync(tmpManifest, marketplaceJsonPath)
          console.log('Registered Termpolis in marketplace.json manifest')
        }
      }
    } catch (e) {
      console.log('Could not register Claude Code plugin (non-fatal):', (e as any).message)
    }

    // Auto-register in Codex CLI (~/.codex/config.toml)
    {
      const codexConfigPath = join(homedir(), '.codex', 'config.toml')
      const r = registerInCodex(codexConfigPath, adapterPath)
      if (r.changed) console.log('Auto-registered Termpolis MCP server in Codex CLI config')
      else if (r.error) console.log('Could not register in Codex config (non-fatal):', r.skipped, r.error)
    }

    // Auto-register in Gemini CLI (~/.gemini/settings.json)
    {
      const geminiSettingsPath = join(homedir(), '.gemini', 'settings.json')
      const r = registerInGemini(geminiSettingsPath, adapterPath)
      if (r.changed) console.log('Auto-registered Termpolis MCP server in Gemini CLI settings')
      else if (r.error) console.log('Could not register in Gemini settings (non-fatal):', r.skipped, r.error)
    }

    // Global hotkeys. On Windows/Linux these are Win+Shift+T / Win+Shift+S; on macOS `Super` is Cmd
    // and Cmd+Shift+T/S belong to other apps, so appMenu.globalHotkeys hands mac a non-conflicting
    // Ctrl+Alt combo instead. register() returns false if the OS already owns the combo (common for
    // Super+Shift on GNOME/KDE) — log it rather than fail silently.
    const hotkeys = globalHotkeys(process.platform)
    if (!globalShortcut.register(hotkeys.newTerminal, () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
        mainWindow.webContents.send('global:new-terminal')
      }
    })) console.log(`Global hotkey ${hotkeys.newTerminal} unavailable (already registered by the OS)`)

    if (!globalShortcut.register(hotkeys.toggleSwarm, () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
        mainWindow.webContents.send('global:toggle-swarm')
      }
    })) console.log(`Global hotkey ${hotkeys.toggleSwarm} unavailable (already registered by the OS)`)
  })

  app.on('before-quit', () => {
    // FIRST: this is a clean shutdown, so the next boot must not report it as a crash. Everything
    // below can throw; the marker must be cleared regardless.
    try { markCleanExit() } catch { /* best effort */ }
    try { globalShortcut.unregisterAll() } catch { /* best effort */ }
    try { killAll() } catch { /* best effort */ }
    try { clearSensitiveReadCount() } catch {}
    try { detachAllWatchers() } catch {}
    try { stopRepoWatches() } catch {}
    try { shutdownEventBus() } catch {}
    try { stopIndexer() } catch {}
    // Reap the memory process. The store is already durable on disk (every write is appended before
    // its RPC resolves), so this loses nothing — it just stops the child outliving the app.
    try { stopMemoryHost() } catch {}
    try { stopProxy() } catch { /* ignore */ }
    try { saveProxyTotalsToDisk(join(app.getPath('userData'), 'headroom')) } catch { /* ignore */ }
    try { saveDepthCurveToDisk(join(app.getPath('userData'), 'headroom')) } catch { /* ignore */ }
    if (mcpServer) {
      try { stopMcpServer(mcpServer) } catch { /* already down */ }
      mcpServer = null
    }
  })
  // `before-quit` above misses the shutdowns we don't initiate — an OS session end and a
  // termination signal — and each of those would otherwise be filed as a phantom native crash
  // (Sentry ELECTRON-D / #20). Neither is one.
  installCleanExitGuards({
    onSessionEnd: (handler) => {
      onSessionEnd = handler
      mainWindow?.on('session-end', handler)
    },
    onSignal: (signal, handler) => { process.on(signal as NodeJS.Signals, handler) },
    quit: () => app.quit(),
  })
  app.on('window-all-closed', () => {
    // Arm the last-resort exit BEFORE any teardown. Every line below is a chance to throw, and all
    // of them sit between here and the `app.quit()` that actually ends the process — so one throw
    // strands a main process with no windows and no way out, which is invisible to a user (they
    // closed the window; it looks shut) and hangs e2e teardown on app.close() for its full timeout.
    // 5s is far clear of a normal shutdown, which exits ~500ms after the app.quit() below.
    let stage = 'start'
    if (process.platform !== 'darwin') {
      const watchdog = setTimeout(() => {
        console.error(`[shutdown] stalled after "${stage}" — forcing exit`)
        // A forced exit is still a deliberate one: without this the next boot files it as a crash.
        try { markCleanExit() } catch { /* best effort */ }
        process.exit(0)
      }, 5000)
      // unref so the watchdog itself never delays a shutdown that is going fine.
      watchdog.unref?.()
    }
    try { killAll() } catch { /* shutting down anyway */ }
    stage = 'terminals'
    try { clearSensitiveReadCount() } catch {}
    try { detachAllWatchers() } catch {}
    try { shutdownEventBus() } catch {}
    stage = 'watchers'
    // close() on an already-stopped server throws ERR_SERVER_NOT_RUNNING, and this used to be the
    // one unguarded call standing in front of the exit path.
    if (mcpServer) {
      try { stopMcpServer(mcpServer) } catch { /* already down */ }
      mcpServer = null
    }
    stage = 'mcp'
    if (process.platform !== 'darwin') {
      app.quit()
      // Force exit — MCP server or PTY processes may keep event loop alive
      setTimeout(() => process.exit(0), 500)
    }
  })
  app.on('activate', () => { if (!mainWindow) createWindow() })
}
