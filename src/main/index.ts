import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, safeStorage, shell } from 'electron'
import { initMainSentry } from './sentry'
import {
  initTelemetry,
  setOptIn as setTelemetryOptIn,
  isEnabled as isTelemetryEnabled,
  dailyLaunchPing,
  recordEvent as recordTelemetryEvent,
} from './telemetry'

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

// Linux blank/black-window safety net. Reported by .deb users on Ubuntu after
// the initial install (no UI, just a black box). Two fixes layered here:
//
// 1. Disable VAAPI video decode/encode features. We don't play video — these
//    Chromium features are opt-out unstable on many Ubuntu setups (especially
//    NVIDIA proprietary drivers + Wayland) and are the most-reported cause of
//    "blank Electron window on Linux". Disabling costs us nothing.
// 2. TERMPOLIS_DISABLE_GPU=1 escape hatch — forces software rendering for users
//    on broken GPU drivers. Slower (xterm falls back to canvas) but reliable.
//    Documented in troubleshooting so users hitting the black-box issue can
//    `TERMPOLIS_DISABLE_GPU=1 termpolis` from a terminal.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('disable-features', 'VaapiVideoDecoder,VaapiVideoEncoder')
  if (process.env.TERMPOLIS_DISABLE_GPU === '1') {
    app.disableHardwareAcceleration()
  }
}
import { join } from 'path'
import { homedir, release } from 'os'
import { writeFileSync, readFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import { execSync, spawn } from 'child_process'
import { runSecondOpinion, secondOpinionSpawnPlan, type SecondOpinionAgent } from './secondOpinion'
import { detectAvailableShells } from './shellDetector'
import { spawnTerminal, killTerminal, writeToTerminal, resizeTerminal, killAll, getTerminalCwd, getTerminalPid, computeWindowsPty } from './terminalManager'
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
import { loadSession, saveSession } from './sessionStore'
import { appendCommand, searchHistory } from './historyStore'
import { readConfigFile, writeConfigFile } from './configFileManager'
import { listPathEntries, listPathCommands, listEnvVars } from './completionService'
import { startMcpServer, stopMcpServer, getMcpAuthToken, getMcpPort, awaitMcpPortBound, initAuditLog, type McpToolHandlers } from './mcpServer'
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
import {
  initSwarmMemory,
  memoryWrite, memorySearch, memoryRelated, memoryLink, memoryGraphQuery, memoryFeedback, memoryList, memoryCount, memoryClear, memoryHasHash, memoryStats, memoryDashboardStats, memoryGraphSample, memoryRecentActivity, embeddingsReady, memorySourceById, memoryDelete, consolidationCandidates, consolidationSimOf,
  memoryPatchProjects, normalizeProjectSlug, memoryLessons, memoryPruneCodePath, warmProbeEmbeddings, compactSelfShard,
  setMemoryScrubber,
  weaveCandidates, weaveNeighbours, backfillCodeRefs, symbolHistory, memoryArchive, searchArchive,
  getSyncStatus, setSyncDir, reloadMemoryFromSync, setSyncPassphrase, disableSyncEncryption, enableLocalEncryption, disableEncryption,
  persistMemoryIndex,
  entityDedupHash, projectKeyOf,
  type MemoryEntry,
  vectorRamStats,
  setVectorQuantization,
} from './swarmMemory'
import { setSafeStorage } from './secureKeyStore'
import { runConversationIngest } from './conversationIngest'
import { runCodeIngest, discoverRepoFiles } from './codeIngest'
import { initCodeGraph, buildCodeGraph, reindexWatchedChange, codeExplore, codeCallers, codeCallees, codeImpact, codeSymbols, codeGraphStats, graphKeyForRoot, resolveCodeRefs, resolveToken, ALL_REPOS } from './codeGraph'
import { ensureRepoWatch, stopRepoWatches, fsBackedWatchDeps } from './codeWatch'
import { watch as fsWatch, promises as fsPromises } from 'fs'
import { initAnomalyLog, getAnomalies, anomalyCount } from './memoryAnomalyLog'
import { startIndexer, stopIndexer } from './memoryIndexer'
import { runWeave } from './mnemeWeave'
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
import { codeLocate, type LocatedSite } from './codeLocate'
import { isHighValueEpisode } from './mnemeReflect'
import { makeHeadlessDistiller } from './mnemeDistiller'
import { getAllEdges, graphStats } from './memoryGraph'
import { buildBrainArchive, mergeBrainArchive, realBrainFs } from './brainIpc'
import { initMetrics, recordMetric, metricsSummary } from './metricsLedger'
import { isEmbedderReady, setWorkerSpawner } from './localEmbedder'
import { createWorkerTransport } from './embedWorker'

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
function locateIssueSites(issue: string, projectKey?: string, limit?: number): LocatedSite[] {
  try {
    return codeLocate(
      issue,
      {
        signals: (t) => proactiveSignals(t),
        resolve: (token) => {
          const r = resolveToken(token, projectKey)
          return { symbols: r.symbols.map((s) => ({ id: s.id, name: s.name, file: s.file })), files: r.files }
        },
        history: (q) => symbolHistory(q, projectKey).map((e) => ({ id: e.id, content: e.content, importance: e.importance, ts: e.ts, memoryType: e.memoryType })),
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
        link: (from, to, relation, weight) => { memoryLink({ from, to, relation, weight, createdBy: 'reflect' }) },
        ensureEntity: ensureEntityNode,
        resolveCode: (names, project) => resolveCodeRefs(names, graphKeyForRoot(project ?? '')),
      },
    )
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
import { buildContextPrimer } from './contextPrimer'
import { getPrimerLimit, setPrimerLimit, getVectorQuantize, setVectorQuantize } from './memorySettings'
import { startProcessHealth, processHealth, quantizationAdvice, recentStalls, persistedStalls, initStallLog } from './processHealth'
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
import { safeGit, isValidGitRef, parseSafeCommand, runSafeCommand } from './gitCommand'
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
  registerInQwen,
  resolveNodeCommand,
} from './agentMcpRegistry'

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

ipcMain.handle('terminal:create', async (_, { id, shellType, cwd, extraPaths }) => {
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
        }, allExtraPaths)
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

// Heuristic: when the user types `claude`, `codex`, `gemini`, or `qwen` as
// the start of a command line, the next bytes typed are about to be a prompt
// going to that AI provider's network. We log a terminal_open audit entry
// (only if the audit toggle is on) so security-conscious teams can prove
// "exactly when did developer X launch agent Y in repo Z."
const auditLaunchPattern = /(?:^|[\r\n;&|])\s*(claude|codex|gemini|qwen)(?:\s|$)/
// Strict mode: refuse to forward a `gemini` invocation when the account
// detector says we're on the free OAuth tier. We intercept before the bytes
// hit the PTY, write a clear refusal message to the terminal, and audit it.
const strictBlockPattern = /(?:^|[\r\n;&|])\s*gemini(?:\s|$|\r|\n)/
const recentlyAuditedTerminals = new Map<string, number>()

// Per-terminal "this is an AI session" flag. We set this the first time a
// terminal:write matches auditLaunchPattern (the user typed `claude` /
// `codex` / `gemini` / `qwen`). All subsequent writes on that terminal are
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

ipcMain.handle('session:load', async () => {
  try { return ok(loadSession()) }
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
// the renderer can inject into any AI shell (Codex, Gemini, Qwen, or
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
    try {
      // `path` must reflect what ACTUALLY ran. This booked every UI-driven search as a vector
      // recall even when the embedder was down and the store had fallen back to keyword, so the
      // Memory dashboard over-counted vector recalls — a proof dashboard that flatters itself is
      // worse than none. The MCP twin below already did this correctly.
      const ready = embeddingsReady()
      recordMetric({ t: 'recall', ts: Date.now(), hits: results.length, topScore: results[0]?.score ?? 0, path: ready ? 'vector' : 'keyword' })
      recordMetric({ t: 'embed', ts: Date.now(), available: ready })
    } catch { /* best effort */ }
    return ok(results)
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('memory:list', async (_, opts: { limit?: number; agentId?: string; kind?: string; since?: number } = {}) => {
  try {
    const list = memoryList({
      limit: opts.limit,
      agentId: opts.agentId,
      kind: opts.kind as MemoryEntry['kind'] | undefined,
      since: opts.since,
    })
    return ok(list)
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('memory:count', () => ok(memoryCount()))
ipcMain.handle('memory:clear', () => { memoryClear(); return ok() })
ipcMain.handle('memory:stats', () => ok(memoryStats()))
// Memory & Learning dashboard: the proof numbers, computed locally and offline.
// Store-derived composition + graph connections are always real; the ledger adds
// live reliability/receipt SLIs (sparse until the brain has been used a while).
ipcMain.handle('memory:metrics', () => {
  try {
    const byRelation: Record<string, number> = {}
    for (const e of getAllEdges()) byRelation[e.relation] = (byRelation[e.relation] || 0) + 1
    const gs = graphStats()
    const competence = competenceRecords()
      .slice()
      .sort((a, b) => b.attempts - a.attempts)
      .slice(0, 8)
      .map((c) => ({ domain: c.domain, attempts: c.attempts, confidence: c.confidence }))
    return ok({
      ledger: metricsSummary(Date.now()),
      store: memoryDashboardStats(),
      graph: { nodes: gs.nodes, edges: gs.edges, byRelation },
      // The STRUCTURAL code graph is a SEPARATE store from the semantic memory graph:
      // indexing a repo mints code symbols + caller->callee edges that never land in `graph`.
      // Surfacing it here is what makes "index a repo -> see connections" actually true.
      codeGraph: codeGraphStats(ALL_REPOS),
      competence,
      recentActivity: memoryRecentActivity(14),
    })
  } catch (e: any) { return err(e.message) }
})

// Live connections graph — a legible sample of the REAL knowledge graph (the densest
// subgraph: nodes + induced edges, labeled + typed). Fetched on demand rather than in
// the 5s metrics poll, since it's heavier and the force layout shouldn't reset each tick.
ipcMain.handle('memory:graph-sample', (_e, opts: { limit?: number } = {}) => {
  try {
    return ok(memoryGraphSample({ limit: opts?.limit }))
  } catch (e: any) { return err(e.message) }
})

// Ingest past AI sessions (Claude/Codex/Gemini transcripts on disk) into the
// shared memory so every agent can semantically recall them. Idempotent — only
// genuinely new chunks are embedded, so re-running is cheap.
ipcMain.handle('memory:ingest-conversations', async () => {
  try {
    const stats = await runConversationIngest({ hasHash: memoryHasHash, write: memoryWrite, patchProjects: memoryPatchProjects, link: (from, to, relation, weight, ts) => memoryLink({ from, to, relation, weight, ts, createdBy: 'ingest' }) })
    return ok(stats)
  } catch (e: any) { return err(e.message) }
})

// Index the working repo's git-tracked source into the shared memory so agents
// can semantically recall the codebase. Secrets are never indexed (reuses the
// sensitive-file denylist). repoRoot is the active project directory.
ipcMain.handle('memory:ingest-code', async (_, opts: { repoRoot: string }) => {
  try {
    if (!opts?.repoRoot) return err('repoRoot required')
    const stats = await runCodeIngest({ hasHash: memoryHasHash, write: memoryWrite, prunePath: memoryPruneCodePath }, { repoRoot: opts.repoRoot })
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
ipcMain.handle('code-graph:locate', async (_, opts: { issue: string; projectKey?: string; limit?: number }) => { try { return ok(locateIssueSites(opts?.issue || '', opts?.projectKey, opts?.limit)) } catch (e: any) { return err(e.message) } })
// v1.23 C6 — DEEP recall over the archive tier (cold/consolidated memories beyond the hot window).
ipcMain.handle('memory:deep-search', async (_, opts: { query: string; limit?: number }) => { try { return ok(searchArchive(opts?.query || '', opts?.limit ?? 20)) } catch (e: any) { return err(e.message) } })

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
    const zip = buildBrainArchive(ud, app.getVersion(), Date.now(), realBrainFs())
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
    const res = mergeBrainArchive(ud, buf, realBrainFs())
    if (!res.ok) return err(res.error || 'Import failed')
    // Reload stores whose files a fresh-machine import may have restored, so they take effect now.
    try { initCompetence(ud) } catch { /* best effort */ }
    try { initIdentity(ud) } catch { /* best effort */ }
    try { initMetrics(ud) } catch { /* best effort */ }
    try { initCodeGraph(ud) } catch { /* best effort */ }
    return ok({ canceled: false, memoriesImported: res.memoriesImported, edgesImported: res.edgesImported, restored: res.restored })
  } catch (e: any) { return err(e.message) }
})

// Pre-context primer: pull the most relevant memories for a query (e.g. the
// user's first ask or the active project) so it can be injected as an agent's
// first input — the agent starts already knowing the context instead of the
// user re-explaining it. Returns a shell-paste-safe string, or null.
ipcMain.handle('memory:build-primer', async (_, opts: { query: string; limit?: number; cwd?: string }) => {
  try {
    // Current-directory precedence: context for the cwd's project leads the
    // primer; unrelated global hits are labeled "may NOT apply".
    const project = opts?.cwd ? normalizeProjectSlug(opts.cwd) : ''
    const primer = await buildContextPrimer(memorySearch, { query: opts?.query ?? '', limit: opts?.limit ?? getPrimerLimit(), project: project || undefined })
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
// Exposed so the Memory panel can be a DECISION AID rather than a mystery switch: it reads the live
// vector RAM, shows what the other mode would cost, and states the MEASURED recall impact. Off by
// default; losslessly reversible (disk always keeps exact floats), so it can be tried and reverted.
// Recent FREEZES of the main thread — the ones the user actually feels as "(Not Responding)".
//
// A percentile hides these: one 2.5 s stop-the-world pause barely moves a p99 over a 60 s window.
// So they are recorded as discrete EVENTS, with what the heap looked like and what was in flight,
// which is the difference between "the app feels slow sometimes" and "GC, 2.4 s, heap 1.1 GB".
ipcMain.handle('memory:get-stalls', async () => {
  try {
    // Prefer the on-disk log: a freeze bad enough to be worth reading about is often one the user
    // restarted the app to escape, which used to erase the only record of it. Fall back to the live
    // ring if the log can't be read.
    const saved = persistedStalls()
    return ok(saved.length > 0 ? saved : recentStalls())
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('memory:get-vector-ram', async () => {
  try {
    const vectors = vectorRamStats()
    const health = processHealth()
    // The advice is computed HERE, from this machine's live numbers, so the panel never has to
    // guess at a threshold — and can tell the user the toggle would NOT help them.
    return ok({ ...vectors, persisted: getVectorQuantize(), health, advice: quantizationAdvice(vectors, health) })
  } catch (e: any) { return err(e.message) }
})
ipcMain.handle('memory:set-vector-quantize', async (_, opts: { value: boolean }) => {
  try {
    const on = opts?.value === true
    setVectorQuantize(on)                    // persist the choice...
    const stats = setVectorQuantization(on)  // ...and rebuild the packed store in the new mode
    const health = processHealth()
    return ok({ ...stats, persisted: on, health, advice: quantizationAdvice(stats, health) })
  } catch (e: any) { return err(e.message) }
})

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
    const digest = await buildContextPrimer(memorySearch, { query: opts?.query ?? '', limit: getPrimerLimit(), project: project || undefined })
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
    const cwdArg = opts?.cwd ? ` (cwd "${opts.cwd}")` : ''
    const instruction = [
      'Termpolis project memory: saved background context exists for this project.',
      `When you begin working, call the termpolis MCP tool memory_primer${cwdArg} and read it as background reference only — do NOT resume past work from it or summarize it unprompted; just hold it as context.`,
      'Before re-deriving any fix or solution that may already be stored, call the termpolis memory_search tool first.',
      // Compaction self-reprime. THIS is what lets the re-prime happen behind the scenes.
      //
      // A system prompt is re-sent on every request — compaction summarizes the CONVERSATION,
      // not the system prompt — so this line survives a compaction while the digest you loaded
      // (which lived in the conversation) does not. Telling the agent to re-fetch it itself is
      // the only way to restore that context without typing into its input box.
      //
      // The alternative, which this replaces, was to paste "call memory_primer" into the input
      // after each compaction. That is visible, unexplained, and worse: writeToTerminal appends
      // at the CURSOR, and the agent owns its own line buffer — so a re-prime that lands while
      // the user is mid-sentence is appended onto their draft. Same architectural fact that made
      // pre-send prompt redaction impossible in v1.25.2. Don't write into a buffer you don't own.
      'If your context is compacted or summarized during this session, the memory digest you loaded will have been summarized away with it — call memory_primer once more, silently, before continuing, then carry on with the task in hand.',
      'If the termpolis memory tools are unavailable, ignore this and proceed normally.',
    ].join(' ')
    const file = join(dir, `primer-${uuidv4()}.txt`)
    writeFileSync(file, instruction, 'utf8')
    // Count the memories in the digest so the launch banner can show how much
    // recall was injected (observable recall — #1). Each gate-passed memory is
    // rendered as one "- [...]" line.
    const count = digest.split('\n').filter((l) => l.startsWith('- [')).length
    return ok({ file, count })
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
        reflect: (episode) =>
          onSessionEpisode(episode, {
            distill: (ep) => distillEpisode(ep, MNEME_DISTILLER_ENABLED && isHighValueEpisode(ep) ? { llm: headlessDistiller } : {}),
            write: (input) => memoryWrite(input),
            recordOutcome,
            now: Date.now(),
            link: (from, to, relation, weight) => { memoryLink({ from, to, relation, weight }) },
            ensureEntity: ensureEntityNode,
            resolveCode: (names, project) => resolveCodeRefs(names, graphKeyForRoot(project ?? '')),
          }).then((r) => {
            try { if (r.fired && r.lessons > 0) recordMetric({ t: 'reflect', ts: Date.now(), lessons: r.lessons }) } catch { /* best effort */ }
            return { fired: r.fired, lessons: r.lessons }
          }),
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
  try { return ok(getSyncStatus()) } catch (e: any) { return err(e.message) }
})

ipcMain.handle('memory:set-sync-dir', async (_, opts: { dir: string | null }) => {
  try { return ok(setSyncDir(opts?.dir ?? null)) } catch (e: any) { return err(e.message) }
})

// Native folder picker → enable sync to the chosen folder in one step.
ipcMain.handle('memory:choose-sync-dir', async () => {
  try {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: 'Choose a synced folder for Termpolis memory (e.g. inside Dropbox or Syncthing)',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (res.canceled || !res.filePaths[0]) return ok(getSyncStatus())
    return ok(setSyncDir(res.filePaths[0]))
  } catch (e: any) { return err(e.message) }
})

// At-rest encryption of the synced folder. Set/enter the passphrase (encrypts
// this device's shard + unlocks peers' encrypted shards); the key is derived
// locally and never leaves the machine, so the sync provider only sees
// ciphertext. Returns an error (e.g. wrong passphrase) without throwing.
ipcMain.handle('memory:set-sync-passphrase', async (_, opts: { passphrase: string }) => {
  try { return ok(setSyncPassphrase(opts?.passphrase ?? '')) } catch (e: any) { return err(e.message) }
})

ipcMain.handle('memory:disable-sync-encryption', async () => {
  try { return ok(disableSyncEncryption()) } catch (e: any) { return err(e.message) }
})

// WP-F: local at-rest encryption (no cross-machine sync required). Default-ON when the OS keychain is
// available; these let the user re-enable after an opt-out, or turn it off (decrypts + remembers).
ipcMain.handle('memory:enable-local-encryption', async () => {
  try { return ok(enableLocalEncryption()) } catch (e: any) { return err(e.message) }
})
ipcMain.handle('memory:disable-encryption', async () => {
  try { return ok(disableEncryption()) } catch (e: any) { return err(e.message) }
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

ipcMain.handle('git:status-parsed', async (_, { cwd }: { cwd: string }) => {
  try {
    let branch = ''
    try { branch = safeGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 2000 }).trim() } catch {}
    const statusRaw = safeGit(['status', '--porcelain'], { cwd, timeout: 5000 }).trim()
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

ipcMain.handle('terminal:status', async (_, { terminalId, fallbackCwd }) => {
  try {
    // Try to get the real CWD from the PTY process
    const liveCwd = getTerminalCwd(terminalId)
    const cwd = liveCwd || fallbackCwd
    let gitBranch = ''
    try {
      gitBranch = safeGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 2000 }).trim()
    } catch {}
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
  // Qwen-Code: id 'qwen-code', binary 'qwen' (Alibaba's Gemini-CLI fork)
  results['qwen-code'] = findAgentInstalled('qwen')
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
    if (!['claude', 'codex', 'gemini', 'qwen'].includes(agent)) return err('unsupported agent')
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
    Menu.setApplicationMenu(null)
    createWindow()

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
          }, getAgentExtraPaths())
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
        try {
          const ready = isEmbedderReady()
          recordMetric({ t: 'recall', ts: Date.now(), hits: res.length, topScore: res[0]?.score ?? 0, path: ready ? 'vector' : 'keyword', ms: Date.now() - started })
          recordMetric({ t: 'embed', ts: Date.now(), available: ready })
        } catch { /* metrics are best-effort */ }
        return res
      },
      memoryList: (opts) => memoryList({
        limit: opts.limit,
        agentId: opts.agentId,
        kind: opts.kind as MemoryEntry['kind'] | undefined,
        since: opts.since,
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
      memoryFeedback: (opts) => {
        const helpful = opts.helpful !== false
        try {
          recordMetric({ t: 'feedback', ts: Date.now(), helpful })
          // Cross-agent teaching: a helpful memory authored by a DIFFERENT agent than the
          // one giving feedback is real cross-agent reuse — the teaching-matrix signal.
          if (helpful && opts.agentId) {
            const author = memorySourceById(opts.id)
            if (author && author !== opts.agentId) recordMetric({ t: 'cross_recall', ts: Date.now(), author, reader: opts.agentId })
          }
        } catch { /* best effort */ }
        return memoryFeedback({ id: opts.id, helpful: opts.helpful, query: opts.query })
      },
      memorySelfcheck: (opts) => ({ ...assessCompetence(opts.domain), summary: competenceSummary(3) }),
      memoryPool: (opts) => poolLessons(
        // F13: pool over the LESSONS in the full window, not just the newest ~200 rows (which an
        // actively-ingesting brain floods with non-lesson message chunks, hiding real corroboration).
        memoryLessons(opts.limit ?? 200)
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
        const lessons = memoryLessons(opts.limit ?? 200).map(toAgentLesson)
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
    }

    initAuditLog(app.getPath('userData'))
    initEventBus(app.getPath('userData'))
    initContextPinStore(app.getPath('userData'))
    initAiSecurity()
    // Back the memory sync-key cache with the OS keychain (safeStorage: DPAPI /
    // Keychain / libsecret) — no native module, ships in the one executable.
    setSafeStorage(safeStorage)
    initAnomalyLog(app.getPath('userData')) // burn-in: capture surprising memory events (incl. this init's)
    // Sample main-thread health for the whole session. The PTY is pumped on this thread, so its
    // stalls ARE the typing lag — and that is the only evidence that can honestly justify trading
    // vector exactness for RAM.
    initStallLog(app.getPath('userData')) // freezes outlive the process that had them — before start
    // Arm V8's sampling profiler with it, so a freeze in code nobody thought to label still gets
    // named. It samples on its own native thread and so keeps working while this one is dead.
    // Measured cost of the 10 ms interval: p99 event-loop lag 6.6 ms -> 10.8 ms (about one frame,
    // far below the ~50 ms at which a stall is perceptible) for the ability to name an 18-second one.
    // TERMPOLIS_STALL_STACKS=0 turns the sampling off and falls back to labelled operations only.
    startProcessHealth(Date.now, process.env.TERMPOLIS_STALL_STACKS !== '0')
    // Apply the persisted vector-quantization choice BEFORE the store is built — the packed array
    // is allocated inside initSwarmMemory, so the mode has to be known by then. Default is exact
    // float32; int8 is opt-in from Settings -> Memory & Learning.
    try { setVectorQuantization(getVectorQuantize()) } catch { /* fall back to exact floats */ }
    initSwarmMemory(app.getPath('userData'))
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
    // Warm the embedder OFF the main thread ~20s after startup so the dashboard's status reflects
    // reality (ready/unavailable, not a misleading pre-probe "healthy") without a startup model load
    // stalling the first keystrokes — the worker thread carries it.
    setTimeout(() => { warmProbeEmbeddings().catch(() => {}) }, 20000)
    // Periodically compact this device's append-only shard once it's mostly dead lines
    // (threshold-gated + non-forced → a no-op until it's worth it), so per-reload parse cost
    // stays bounded as the log grows. Lossless + atomic (compactSelfShard proves the round-trip).
    setInterval(() => { try { compactSelfShard() } catch { /* best effort */ } }, 30 * 60 * 1000)
    initCompetence(app.getPath('userData')) // Mneme: load the persistent self-competence store
    initMetrics(app.getPath('userData')) // Memory & Learning dashboard: device-local metrics ledger
    initIdentity(app.getPath('userData')) // Mneme: load the continuous-identity store
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
        try { reloadMemoryFromSync() } catch { /* best effort */ }
        const stats = await runConversationIngest(
          { hasHash: memoryHasHash, write: memoryWrite, patchProjects: memoryPatchProjects, link: (from, to, relation, weight, ts) => memoryLink({ from, to, relation, weight, ts, createdBy: 'ingest' }) }, // F30: backfill legacy project tags each pass (now persisted)
          { maxChunks: 250 },
        )
        // Keep the on-disk HNSW graph tracking recent state (no-op if not built).
        try { persistMemoryIndex() } catch { /* best effort */ }
        // Mneme P2: the consolidation "sleep" — forget cold, low-value, edge-free
        // episodic noise so signal stays high as the store grows. Conservative and
        // capped; curated lessons (tagged / edged / high-importance / recalled) are
        // never touched. Decay-only on the scheduled pass; merge is on-demand.
        try {
          const cnow = Date.now()
          // v1.23 C6: ARCHIVE cold chatter (recoverable) instead of memoryDelete (permanent
          // tombstone) — the "rock solid: never silently lose memory" fix. Archived entries leave
          // the hot window but stay recoverable via searchArchive / the deep-search IPC.
          runConsolidation({ candidates: () => consolidationCandidates(500), simOf: () => 0, forget: memoryArchive, now: cnow })
          // P2 (summaries): cluster near-duplicates in a bounded window and write a
          // higher-level `summary` node linking them (additive; a no-op when the
          // embedder is unavailable, since it needs real vectors).
          await runSummarization({
            candidates: () => consolidationCandidates(200),
            simOf: consolidationSimOf(),
            write: (i) => memoryWrite(i),
            link: (from, to, relation) => { memoryLink({ from, to, relation, createdBy: 'consolidate' }) },
            now: cnow,
          })
          auditMemory({ event: 'learn', kind: 'consolidate', detail: 'idle consolidation + summarization pass' }) // WP-E
        } catch { /* best effort */ }
        // v1.23 C4 — The Weave: continuously draw cross-repo analogies + backfill bridge anchors
        // AHEAD OF TIME so the agents reason faster (the connections are already there). Bounded,
        // idempotent, best-effort; runs on this idle tick so it never touches a hot path.
        try {
          runWeave(
            {
              candidates: () => weaveCandidates(300),
              neighbours: (id, k) => weaveNeighbours(id, k),
              link: (from, to, relation, weight) => { memoryLink({ from, to, relation, weight, createdBy: 'weave' }) },
              resolveCode: (names, projectKey) => resolveCodeRefs(names, projectKey),
              backfillCodeRefs: (id, refs) => backfillCodeRefs(id, refs),
            },
            { maxPerPass: 200 },
          )
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
          { hasHash: memoryHasHash, write: memoryWrite, patchProjects: memoryPatchProjects, link: (from, to, relation, weight, ts) => memoryLink({ from, to, relation, weight, ts, createdBy: 'ingest' }) }, // F30: backfill legacy project tags each pass (now persisted)
          // F16: the fast pass re-reads the ACTIVE session — emit only sealed chunks so a
          // growing trailing partial doesn't deposit a superset duplicate every 90s.
          { maxChunks: 250, freshSinceTs: Date.now() - 10 * 60_000, chunkOptions: { sealedOnly: true } },
        )
        try { persistMemoryIndex() } catch { /* best effort */ }
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

    // Auto-register in Qwen-Code CLI (~/.qwen/settings.json)
    {
      const qwenSettingsPath = join(homedir(), '.qwen', 'settings.json')
      const r = registerInQwen(qwenSettingsPath, adapterPath)
      if (r.changed) console.log('Auto-registered Termpolis MCP server in Qwen-Code CLI settings')
      else if (r.error) console.log('Could not register in Qwen settings (non-fatal):', r.skipped, r.error)
    }

    // Global hotkey: Win+Shift+T to create a new terminal (works even when minimized)
    globalShortcut.register('Super+Shift+T', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
        mainWindow.webContents.send('global:new-terminal')
      }
    })

    // Global hotkey: Win+Shift+S to open/close swarm dashboard
    globalShortcut.register('Super+Shift+S', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
        mainWindow.webContents.send('global:toggle-swarm')
      }
    })
  })

  app.on('before-quit', () => {
    globalShortcut.unregisterAll()
    killAll()
    try { clearSensitiveReadCount() } catch {}
    try { detachAllWatchers() } catch {}
    try { stopRepoWatches() } catch {}
    try { shutdownEventBus() } catch {}
    try { stopIndexer() } catch {}
    if (mcpServer) { stopMcpServer(mcpServer); mcpServer = null }
  })
  app.on('window-all-closed', () => {
    killAll()
    try { clearSensitiveReadCount() } catch {}
    try { detachAllWatchers() } catch {}
    try { shutdownEventBus() } catch {}
    if (mcpServer) { stopMcpServer(mcpServer); mcpServer = null }
    if (process.platform !== 'darwin') {
      app.quit()
      // Force exit — MCP server or PTY processes may keep event loop alive
      setTimeout(() => process.exit(0), 500)
    }
  })
  app.on('activate', () => { if (!mainWindow) createWindow() })
}
