import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { publish } from '../agentEventBus'
import { tailFile, resolvePathWithinRoot, POLL_INTERVAL_MS, type TailHandle } from './baseWatcher'
import { CONDUCTOR_CLAUDE_HOME_FILE } from '../../shared/conductorFiles'

/**
 * Claude Code transcript watcher.
 *
 * Claude Code writes per-session JSONL files under:
 *   ~/.claude/projects/<mangled-cwd>/*.jsonl
 *
 * where <mangled-cwd> replaces path separators (/ \) with "-" and drops
 * drive colons on Windows. Example:
 *   C:\Users\david\repos\app  →  C--Users-david-repos-app
 *
 * Each JSONL line is one turn (user or assistant) or a system event.
 * Common shapes we care about:
 *   { type: "user", message: { role, content } }
 *   { type: "assistant", message: { role, content, usage: { input_tokens, output_tokens, cache_read_input_tokens } } }
 *   { type: "system", subtype: "compact_boundary" | ... }
 *
 * Tolerances:
 * - Unknown types are ignored silently (schema drift without crash)
 * - Malformed JSON lines are skipped
 * - Token fields may be missing on older sessions — only emit when present
 */

export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

export interface ClaudeCodeWatcherHandle {
  terminalId: string
  sessionFile: string
  stop(): void
}

/** How long a folder name Claude Code makes from a working folder gets before it is cut short. */
const MANGLED_MAX = 200

/**
 * Convert a working-directory path to Claude Code's mangled form.
 *
 * "C:\foo\bar" → "C--foo-bar"
 * "/home/u/r"  → "-home-u-r"
 * "C:\Users\john.smith\my_app" → "C--Users-john-smith-my-app"
 *
 * No filesystem escape is possible here — we only transform the string.
 */
export function mangleCwd(cwd: string): string {
  if (!cwd) return ''
  // Claude Code turns every character but an ASCII letter or digit into "-", not only the
  // separators and the drive colon: in a folder with a dot, a space or an underscore in its path
  // there was no transcript to find, so no activity was read from Claude Code there. That takes in
  // the "~" of a Windows short name (DAVIDE~1) and every letter outside ASCII, one dash for each
  // UTF-16 unit: a live claude 2.1.303 named "x~José😀" as "x-Jos---". Past 200 characters it
  // keeps the first 200 and adds a hash of the folder, as its own code does: no transcript of a
  // folder that deep was found.
  const mangled = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (mangled.length <= MANGLED_MAX) return mangled
  return `${mangled.slice(0, MANGLED_MAX)}-${Math.abs(folderHash(cwd)).toString(36)}`
}

/** The 32-bit string hash Claude Code adds to a folder name it cut short. */
function folderHash(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
  return hash
}

/** A working folder as Claude Code reads it when it names its transcripts' folder: every link on
 *  the way resolved. Live, claude started in a junction kept its transcript under the junction's
 *  target, so nothing was found under the folder as given. It keeps the rest as it was given, a
 *  Windows short name too. A folder that can't be read is taken as given. */
export function claudeCwd(cwd: string): string {
  try {
    return fs.realpathSync(cwd)
  } catch {
    return cwd
  }
}

/**
 * Find the most-recently-modified JSONL transcript for a given cwd.
 * Returns null if no matching directory or no JSONL files found.
 */
export function findLatestSessionFile(cwd: string): string | null {
  return listSessionFiles(cwd)[0] ?? null
}

/**
 * Every JSONL transcript for a given cwd, newest first. Empty if there is no matching directory.
 * The newest can be a job another computer ran in this folder, which a reader then passes over
 * (liveTranscript); the watcher above only ever wants the newest.
 */
export function listSessionFiles(cwd: string): string[] {
  const mangled = mangleCwd(claudeCwd(cwd))
  if (!mangled) return []

  const dir = path.join(CLAUDE_PROJECTS_DIR, mangled)
  let stat: fs.Stats
  try {
    stat = fs.statSync(dir)
  } catch {
    return []
  }
  if (!stat.isDirectory()) return []

  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }

  const files = entries
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const full = path.join(dir, f)
      // Security: refuse entries that escape the projects dir
      try {
        resolvePathWithinRoot(CLAUDE_PROJECTS_DIR, full)
      } catch {
        return null
      }
      try {
        return { path: full, mtime: fs.statSync(full).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((x): x is { path: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)

  return files.map((f) => f.path)
}

interface ClaudeEntry {
  type?: string
  subtype?: string
  message?: {
    role?: string
    content?: unknown
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
  timestamp?: string
  sessionId?: string
}

function parseTimestamp(ts: unknown): number {
  if (typeof ts === 'string') {
    const d = Date.parse(ts)
    if (!isNaN(d)) return d
  }
  return Date.now()
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const t = (item as Record<string, unknown>).type
    if (t === 'text') {
      const text = (item as Record<string, unknown>).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join(' ')
}

export function processClaudeLine(line: string, terminalId: string): void {
  let entry: ClaudeEntry
  try {
    entry = JSON.parse(line)
  } catch {
    return
  }
  if (!entry || typeof entry !== 'object') return

  const ts = parseTimestamp(entry.timestamp)
  const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : undefined

  // Handle message entries (user / assistant)
  if ((entry.type === 'user' || entry.type === 'assistant') && entry.message) {
    const msg = entry.message
    const content = msg.content

    // Tool calls embedded in assistant content
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== 'object') continue
        const itemType = (item as Record<string, unknown>).type
        if (itemType === 'tool_use') {
          const toolName = String((item as Record<string, unknown>).name || 'unknown')
          const toolInput = (item as Record<string, unknown>).input
          publish({
            ts,
            terminalId,
            agentType: 'claude',
            kind: 'tool_call',
            taskId: sessionId,
            summary: `${toolName}`,
            payload: { tool: toolName, input: toolInput },
          })
        } else if (itemType === 'tool_result') {
          const toolUseId = String((item as Record<string, unknown>).tool_use_id || '')
          const isError = Boolean((item as Record<string, unknown>).is_error)
          publish({
            ts,
            terminalId,
            agentType: 'claude',
            kind: 'tool_result',
            taskId: sessionId,
            summary: isError ? 'tool error' : 'tool result',
            payload: { toolUseId, isError },
          })
        }
      }
    }

    // Message text (for feed)
    const text = extractTextContent(content)
    if (text) {
      publish({
        ts,
        terminalId,
        agentType: 'claude',
        kind: 'message',
        taskId: sessionId,
        summary: (msg.role === 'user' ? 'user: ' : 'assistant: ') + text.slice(0, 200),
        payload: { role: msg.role, length: text.length },
      })
    }

    // Token usage
    if (msg.usage) {
      const inTok = Number(msg.usage.input_tokens || 0)
      const outTok = Number(msg.usage.output_tokens || 0)
      const cacheRead = Number(msg.usage.cache_read_input_tokens || 0)
      const cacheCreate = Number(msg.usage.cache_creation_input_tokens || 0)
      if (inTok || outTok || cacheRead || cacheCreate) {
        publish({
          ts,
          terminalId,
          agentType: 'claude',
          kind: 'token_update',
          taskId: sessionId,
          summary: `in:${inTok} out:${outTok}${cacheRead ? ` cache:${cacheRead}` : ''}`,
          payload: {
            inputTokens: inTok,
            outputTokens: outTok,
            cacheReadInputTokens: cacheRead,
            cacheCreationInputTokens: cacheCreate,
          },
        })
      }
    }
    return
  }

  // System events
  if (entry.type === 'system') {
    if (entry.subtype === 'compact_boundary') {
      publish({
        ts,
        terminalId,
        agentType: 'claude',
        kind: 'compaction',
        taskId: sessionId,
        summary: 'context compacted',
        payload: { subtype: entry.subtype },
      })
    }
    return
  }
}

/**
 * Attach a watcher to a terminal's working directory.
 * Tails the latest JSONL transcript and emits events.
 */
export function attachClaudeCodeWatcher(terminalId: string, cwd: string): ClaudeCodeWatcherHandle | null {
  const sessionFile = findLatestSessionFile(cwd)
  if (!sessionFile) return null

  // Security: sessionFile must be within CLAUDE_PROJECTS_DIR
  try {
    resolvePathWithinRoot(CLAUDE_PROJECTS_DIR, sessionFile)
  } catch {
    return null
  }

  // startAtEnd: this watcher is for LIVE events. Without it the tail opened at byte 0 and replayed
  // the WHOLE transcript through the event bus — 53,023 lines / 77 MB for the largest session on
  // David's machine — and every replayed line cost an appendFileSync + a statSync on the MAIN
  // thread (639 µs each, measured), plus a webContents.send and a memoryWrite RPC. At the bus's own
  // 500/s limiter that is ~319 ms of dead main thread PER SECOND, for about a minute, starting the
  // moment you open an agent terminal. That is the "typing lags for the first few minutes after
  // opening an AI terminal, then warms up" complaint, exactly: "warms up" was the replay hitting EOF.
  // History is not lost — it was never this path's job. runConversationIngest (startIndexer, in
  // bounded 250-chunk bursts precisely so a first index "can't peg the main thread") owns the
  // backfill, and it is idempotent.
  const tail: TailHandle = tailFile(sessionFile, (line) => processClaudeLine(line, terminalId), { startAtEnd: true })

  return {
    terminalId,
    sessionFile,
    stop: () => tail.stop(),
  }
}

/** What `claude --session-id` takes, and so all a session's transcript is named: `<id>.jsonl`. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** While a session's transcript is not where it is looked for, every this many looks (one as the
 *  watcher starts, then one a poll) it is looked for in every project folder too (sessionFileIn),
 *  up to this many looks: 5 minutes. */
const SCAN_EVERY_POLLS = 4
const SCAN_POLLS = 200

export interface ClaudeSessionWatcherHandle extends ClaudeCodeWatcherHandle {
  sessionId: string
}

/** The folder Claude Code keeps its sessions in, under its config home: CLAUDE_CONFIG_DIR when its
 *  environment sets one (read from the folder it runs in, as its own code does), else ~/.claude. */
export function claudeProjectsDir(cwd: string, env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  const configDir = env.CLAUDE_CONFIG_DIR
  return path.join(configDir ? path.resolve(cwd, configDir) : path.join(homeDir, '.claude'), 'projects')
}

/** The CLAUDE_CONFIG_DIR the conductor's run script recorded for this session ('' for none), or
 *  null while the file holds another session's, or none (CONDUCTOR_CLAUDE_HOME_FILE). */
function recordedConfigDir(file: string, sessionId: string): string | null {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  // Windows PowerShell 5.1 writes it as UTF-8 with a BOM, and its lines end in CRLF.
  const [id, configDir = ''] = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  return id.trim().toLowerCase() === sessionId.toLowerCase() ? configDir.trim() : null
}

/** A working folder as PowerShell hands it to a program it starts: with a Windows short name
 *  spelled out (DAVIDE~1 was DavidEngelhart, live), and every link resolved, as Claude Code then
 *  does. Taken as given when it can't be read. */
function spelledOut(cwd: string): string {
  try {
    return fs.realpathSync.native(cwd)
  } catch {
    return cwd
  }
}

/** The transcript called `name` in any of Claude Code's project folders, or null. Off the main
 *  thread: there can be thousands of them. */
async function sessionFileIn(projectsDir: string, name: string): Promise<string | null> {
  let folders: string[]
  try {
    folders = await fs.promises.readdir(projectsDir)
  } catch {
    return null
  }
  const found = await Promise.all(folders.map(async (folder) => {
    const file = path.join(projectsDir, folder, name)
    try {
      await fs.promises.access(file)
      return file
    } catch {
      return null
    }
  }))
  return found.find((file) => file !== null) ?? null
}

/**
 * Follow one Claude Code session's transcript, from its first byte: the file a `claude -p
 * --session-id <id>` writes, `<id>.jsonl`, which the swarm conductor is started with. Unlike
 * attachClaudeCodeWatcher's newest transcript in the folder, it can never be another session's,
 * the last swarm's conductor or a Claude Code worker in the same folder (GitHub #36), and nothing
 * before the session's own first line is in it, so no history is replayed.
 *
 * It is under claude's config home: the one the conductor's run script recorded for this session
 * in `<home>/CONDUCTOR_CLAUDE_HOME_FILE`, which the shell claude runs in decides, and until the
 * script has, the one Termpolis's environment, which its terminals are started with, gives. The
 * file appears once claude has started (about 5 seconds, live). Until then it is looked for in
 * the folder Claude Code names for the working folder, read as it reads it and as PowerShell hands
 * it on; and, every few polls for a while, in every project folder: the id names one session only,
 * so a file of that name is this one wherever Claude Code put it.
 */
export function attachClaudeSessionWatcher(
  terminalId: string,
  cwd: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): ClaudeSessionWatcherHandle | null {
  if (!SESSION_ID.test(sessionId)) return null
  const name = `${sessionId}.jsonl`
  const folders = [...new Set([claudeCwd(cwd), spelledOut(cwd)].map(mangleCwd))]
  const record = path.join(homeDir, CONDUCTOR_CLAUDE_HOME_FILE)
  let recorded: string | null = null
  const projectsDir = (): string => {
    if (recorded === null) recorded = recordedConfigDir(record, sessionId)
    return claudeProjectsDir(cwd, recorded === null ? env : { CLAUDE_CONFIG_DIR: recorded }, homeDir)
  }
  const expected = (): string[] => folders.map((folder) => path.join(projectsDir(), folder, name))
  let tail: TailHandle | null = null
  let stopped = false
  let polls = 0
  const handle: ClaudeSessionWatcherHandle = {
    terminalId,
    sessionId,
    sessionFile: expected()[0],
    stop: () => {
      stopped = true
      clearInterval(locator)
      tail?.stop()
    },
  }
  const follow = (file: string): void => {
    if (stopped || tail) return
    clearInterval(locator)
    handle.sessionFile = file
    tail = tailFile(file, (line) => processClaudeLine(line, terminalId))
  }
  const locate = (): void => {
    const file = expected().find((f) => fs.existsSync(f))
    if (file) return follow(file)
    polls += 1
    if (polls % SCAN_EVERY_POLLS !== 0 || polls > SCAN_POLLS) return
    void sessionFileIn(projectsDir(), name).then((found) => {
      if (found) follow(found)
    })
  }
  const locator = setInterval(locate, POLL_INTERVAL_MS)
  locate()
  return handle
}
