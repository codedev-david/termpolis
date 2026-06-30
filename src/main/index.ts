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
import { execSync } from 'child_process'
import { detectAvailableShells } from './shellDetector'
import { spawnTerminal, killTerminal, writeToTerminal, resizeTerminal, killAll, getTerminalCwd, getTerminalPid, computeWindowsPty } from './terminalManager'
import { getRecentEgress, recordEgress, clearEgress, pollAgentEgress } from './egressAudit'
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
  setRedactionEnabled,
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
} from './aiSecurity'
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
  memoryWrite, memorySearch, memoryRelated, memoryLink, memoryGraphQuery, memoryFeedback, memoryList, memoryCount, memoryClear, memoryHasHash, memoryStats,
  memoryPatchProjects, normalizeProjectSlug,
  getSyncStatus, setSyncDir, reloadMemoryFromSync, setSyncPassphrase, disableSyncEncryption,
  persistMemoryIndex,
  type MemoryEntry,
} from './swarmMemory'
import { setSafeStorage } from './secureKeyStore'
import { runConversationIngest } from './conversationIngest'
import { runCodeIngest } from './codeIngest'
import { startIndexer, stopIndexer } from './memoryIndexer'
import { buildContextPrimer } from './contextPrimer'
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
      const timeout = setTimeout(() => reject(new Error('timeout')), 5000)
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
        clearTimeout(timeout)
        resolve()
      } catch (e) {
        clearTimeout(timeout)
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
ipcMain.handle('ai-security:egress', async (_, { terminalId }: { terminalId: string }) => {
  try {
    const pid = getTerminalPid(terminalId)
    if (pid && pid > 0) {
      const endpoints = await pollAgentEgress(pid)
      if (endpoints.length) recordEgress(terminalId, endpoints)
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
          // Emit the refusal banner via the same channel the renderer reads
          // (we cheat a bit and write into the PTY by way of an echo that the
          // shell renders verbatim — using printf ensures the message shows
          // exactly once and respects ANSI). Since we already sent Ctrl+C,
          // the shell is at a fresh prompt; we just print to its TTY.
          const safe = banner.replace(/'/g, "'\\''")
          writeToTerminal(id, `printf '${safe}'\r`)
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
    const s = getAiSecuritySettings()
    const decision = processOutboundChunk(aiInputStaging.get(id) ?? '', data, {
      redactionEnabled: s.redactionEnabled,
      isAiTerminal: aiTerminalFlag.has(id),
    })
    if (decision.action === 'stage') {
      aiInputStaging.set(id, decision.newStaging)
      return
    }
    if (decision.action === 'redact') {
      const r = decision.scan!
      aiSecurityAppend({
        agent: detectedAgent ?? 'unknown',
        event: 'redaction_hit',
        terminalId: id,
        hitCount: r.hitCount,
        byteCount: (aiInputStaging.get(id) ?? '').length + data.length,
        notes: r.hits.map((h) => h.rule).join(','),
      }).catch(() => {})
      writeToTerminal(id, decision.writeChunk)
      mainWindow?.webContents.send('terminal:secrets-redacted', {
        id,
        hits: r.hits,
        agent: detectedAgent ?? null,
      })
      aiInputStaging.set(id, decision.newStaging)
      return
    }
    if (decision.action === 'flush') {
      aiInputStaging.set(id, decision.newStaging)
    }
    // Notify the renderer when a code-shaped or env-shaped prompt fires so
    // the UI can surface a one-time "X lines of code detected" banner. We
    // never block here — the prompt has already been forwarded and the user
    // can use the banner to cancel future similar sends. (A 'redact' decision
    // returns earlier with its own secrets-redacted notification, so by here
    // the action can only be 'flush' or 'pass'.)
    if (decision.action === 'flush') {
      if (decision.codeChunk?.isCode) {
        aiSecurityAppend({
          agent: detectedAgent ?? 'unknown',
          event: 'redaction_hit',
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
          event: 'redaction_hit',
          terminalId: id,
          byteCount: (aiInputStaging.get(id) ?? '').length + data.length,
          notes: 'env-dump:' + decision.envDump.varCount + ':' + decision.envDump.variableNames.slice(0, 5).join(','),
        }).catch(() => {})
        mainWindow?.webContents.send('terminal:env-dump-detected', {
          id,
          agent: detectedAgent ?? null,
          varCount: decision.envDump.varCount,
          variableNames: decision.envDump.variableNames,
        })
      }
    }
    // 'pass' or 'flush' both fall through to the normal write path below.
  } catch {}

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
    })
  } catch (e: any) { return err(e.message) }
})
ipcMain.handle('aiSecurity:set-strict-gemini', (_, { value }: { value: boolean }) => {
  try { return ok(setStrictGeminiPaidOnly(value === true)) } catch (e: any) { return err(e.message) }
})
ipcMain.handle('aiSecurity:set-redaction', (_, { value }: { value: boolean }) => {
  try { return ok(setRedactionEnabled(value === true)) } catch (e: any) { return err(e.message) }
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
ipcMain.handle('aiSecurity:scan', (_, { text }: { text: string }) => {
  try { return ok(aiSecurityScan(typeof text === 'string' ? text : '')) } catch (e: any) { return err(e.message) }
})
ipcMain.handle('aiSecurity:recent-audit', async (_, { limit }: { limit?: number }) => {
  try { return ok(await aiSecurityRecent(typeof limit === 'number' ? Math.max(1, Math.min(2000, limit)) : 200)) } catch (e: any) { return err(e.message) }
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

ipcMain.handle('git:commit', async (_, { cwd, message }: { cwd: string; message: string }) => {
  try {
    if (!message.trim()) return err('Commit message cannot be empty')
    safeGit(['commit', '-m', message], { cwd, timeout: 30000 })
    return ok()
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
    safeGit(['commit', '-m', message], { cwd, timeout: 30000 })
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
    return ok(entry)
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('memory:search', async (_, opts: { query: string; limit?: number; agentId?: string; kind?: string; taskId?: string }) => {
  try {
    const results = await memorySearch({
      query: opts.query,
      limit: opts.limit,
      agentId: opts.agentId,
      kind: opts.kind as MemoryEntry['kind'] | undefined,
      taskId: opts.taskId,
    })
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

// Ingest past AI sessions (Claude/Codex/Gemini transcripts on disk) into the
// shared memory so every agent can semantically recall them. Idempotent — only
// genuinely new chunks are embedded, so re-running is cheap.
ipcMain.handle('memory:ingest-conversations', async () => {
  try {
    const stats = await runConversationIngest({ hasHash: memoryHasHash, write: memoryWrite, patchProjects: memoryPatchProjects, link: (from, to, relation, weight) => memoryLink({ from, to, relation, weight }) })
    return ok(stats)
  } catch (e: any) { return err(e.message) }
})

// Index the working repo's git-tracked source into the shared memory so agents
// can semantically recall the codebase. Secrets are never indexed (reuses the
// sensitive-file denylist). repoRoot is the active project directory.
ipcMain.handle('memory:ingest-code', async (_, opts: { repoRoot: string }) => {
  try {
    if (!opts?.repoRoot) return err('repoRoot required')
    const stats = await runCodeIngest({ hasHash: memoryHasHash, write: memoryWrite }, { repoRoot: opts.repoRoot })
    return ok(stats)
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
    const primer = await buildContextPrimer(memorySearch, { query: opts?.query ?? '', limit: opts?.limit, project: project || undefined })
    return ok(primer)
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
    const digest = await buildContextPrimer(memorySearch, { query: opts?.query ?? '', project: project || undefined })
    if (!digest) return ok(null) // no relevant memory → launch bare, skip seeding
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
      'If the termpolis memory tools are unavailable, ignore this and proceed normally.',
    ].join(' ')
    const file = join(dir, `primer-${uuidv4()}.txt`)
    writeFileSync(file, instruction, 'utf8')
    return ok(file)
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
  const agents = ['claude', 'codex', 'gemini']
  const results: Record<string, boolean> = {}
  for (const agent of agents) {
    results[agent] = findAgentInstalled(agent)
  }
  // Qwen-Code: id 'qwen-code', binary 'qwen' (Alibaba's Gemini-CLI fork)
  results['qwen-code'] = findAgentInstalled('qwen')
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
        return updateTask(taskId, status as typeof validStatuses[number], result)
      },
      swarmListAgents: () => {
        const session = loadSession()
        return session.terminals.map(t => ({ id: t.id, name: t.name, shellType: t.shellType, cwd: t.cwd }))
      },
      memoryWrite: (input) => memoryWrite({
        agentId: input.agentId,
        kind: (input.kind as MemoryEntry['kind']) || 'note',
        content: input.content,
        tags: input.tags,
        taskId: input.taskId,
        project: input.project,
      }),
      memorySearch: (opts) => memorySearch({
        query: opts.query,
        limit: opts.limit,
        agentId: opts.agentId,
        kind: opts.kind as MemoryEntry['kind'] | undefined,
        taskId: opts.taskId,
        project: opts.project,
      }),
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
          limit: opts.limit ?? 40,
          maxSnippetChars: 600,
          project: project || undefined,
        })
        return { project: project || null, primer }
      },
      memoryRelated: (opts) => memoryRelated({
        id: opts.id,
        query: opts.query,
        limit: opts.limit,
      }),
      memoryLink: (opts) => memoryLink({ from: opts.from, to: opts.to, relation: opts.relation }),
      memoryGraph: (opts) => memoryGraphQuery({
        id: opts.id,
        query: opts.query,
        relation: opts.relation,
        depth: opts.depth,
        limit: opts.limit,
      }),
      memoryFeedback: (opts) => memoryFeedback({ id: opts.id, helpful: opts.helpful, query: opts.query }),
    }

    initAuditLog(app.getPath('userData'))
    initEventBus(app.getPath('userData'))
    initContextPinStore(app.getPath('userData'))
    initAiSecurity()
    // Back the memory sync-key cache with the OS keychain (safeStorage: DPAPI /
    // Keychain / libsecret) — no native module, ships in the one executable.
    setSafeStorage(safeStorage)
    initSwarmMemory(app.getPath('userData'))
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
          { hasHash: memoryHasHash, write: memoryWrite, link: (from, to, relation, weight) => memoryLink({ from, to, relation, weight }) },
          { maxChunks: 250 },
        )
        // Keep the on-disk HNSW graph tracking recent state (no-op if not built).
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
      const r = registerInClaudeSettings(claudeSettingsPath, adapterPath, hookPath.replace(/\\/g, '/'))
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
