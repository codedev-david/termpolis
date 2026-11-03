import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { promisify } from 'util'
import { publish } from '../agentEventBus'
import { mapLimit } from '../asyncPool'
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
  // the "~" of a Windows short name (TERMPO~1) and every letter outside ASCII, one dash for each
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
 *  Windows short name too. A folder that can't be read is taken as given, and so is none at all,
 *  which Node's realpathSync reads as the folder the process runs in. Asked on the thread pool: this is the
 *  JavaScript realpath (as realpathSync was), NOT fs.promises.realpath, which is the native one and would
 *  spell a short name out. */
const realpathJs = promisify(fs.realpath)
export async function claudeCwd(cwd: string): Promise<string> {
  if (!cwd) return cwd
  try {
    return await realpathJs(cwd)
  } catch {
    return cwd
  }
}

/**
 * Find the most-recently-modified JSONL transcript for a given cwd.
 * Returns null if no matching directory or no JSONL files found.
 */
export async function findLatestSessionFile(cwd: string): Promise<string | null> {
  return (await listSessionFiles(cwd))[0] ?? null
}

/**
 * Every JSONL transcript for a given cwd, newest first. Empty if there is no matching directory.
 * The newest can be a job another computer ran in this folder, which a reader then passes over
 * (liveTranscript); the watcher above only ever wants the newest.
 */
export async function listSessionFiles(cwd: string): Promise<string[]> {
  const mangled = mangleCwd(await claudeCwd(cwd))
  if (!mangled) return []

  // On the thread pool, a bounded number of stats at a time: the folder of a project worked in for months holds
  // hundreds or thousands of transcripts, and this was a stat each on the thread that echoes keystrokes.
  const dir = path.join(CLAUDE_PROJECTS_DIR, mangled)
  try {
    if (!(await fs.promises.stat(dir)).isDirectory()) return []
  } catch {
    return []
  }

  let entries: string[]
  try {
    entries = await fs.promises.readdir(dir)
  } catch {
    return []
  }

  const candidates = entries
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f))
    .filter((full) => {
      // Security: refuse entries that escape the projects dir
      try {
        resolvePathWithinRoot(CLAUDE_PROJECTS_DIR, full)
        return true
      } catch {
        return false
      }
    })
  const stats = await mapLimit(candidates, STAT_CONCURRENCY, async (full) => {
    try {
      return { path: full, mtime: (await fs.promises.stat(full)).mtimeMs }
    } catch {
      return null
    }
  })
  return stats
    .filter((x): x is { path: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .map((f) => f.path)
}

/** Transcript files looked at at once. */
const STAT_CONCURRENCY = 16

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
export async function attachClaudeCodeWatcher(terminalId: string, cwd: string): Promise<ClaudeCodeWatcherHandle | null> {
  const sessionFile = await findLatestSessionFile(cwd)
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
  /** Resolves once every look for the transcript that has been started so far has finished (a look is I/O on the
   *  thread pool). For tests, and for a caller that wants to know the watcher has caught up. */
  settled(): Promise<void>
}

/** The folder Claude Code keeps its sessions in, under its config home: CLAUDE_CONFIG_DIR when its
 *  environment sets one (read from the folder it runs in, as its own code does), else ~/.claude. */
export function claudeProjectsDir(cwd: string, env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  const configDir = env.CLAUDE_CONFIG_DIR
  return path.join(configDir ? path.resolve(cwd, configDir) : path.join(homeDir, '.claude'), 'projects')
}

/** The CLAUDE_CONFIG_DIR the conductor's run script recorded for this session ('' for none), or
 *  null while the file holds another session's, or none (CONDUCTOR_CLAUDE_HOME_FILE). */
async function recordedConfigDir(file: string, sessionId: string): Promise<string | null> {
  let text: string
  try {
    text = await fs.promises.readFile(file, 'utf8')
  } catch {
    return null
  }
  // Windows PowerShell 5.1 writes it as UTF-8 with a BOM, and its lines end in CRLF.
  const [id, configDir = ''] = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  return id.toLowerCase() === sessionId.toLowerCase() ? configDir : null
}

/** A working folder as PowerShell hands it to a program it starts: with a Windows short name
 *  spelled out (TERMPO~1 as TermpolisUser1, as seen live), and every link resolved, as Claude
 *  Code then does. Taken as given when it can't be read. */
async function spelledOut(cwd: string): Promise<string> {
  try {
    return await fs.promises.realpath(cwd) // the native one: it spells a short name out
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
  // Which folders and which config home are asked on the thread pool, on the first look. Until then the file is
  // assumed to be where Claude Code's own default puts it for the folder as given.
  let folders: string[] | null = null
  const record = path.join(homeDir, CONDUCTOR_CLAUDE_HOME_FILE)
  let recorded: string | null = null
  const projectsDir = async (): Promise<string> => {
    if (recorded === null) recorded = await recordedConfigDir(record, sessionId)
    return claudeProjectsDir(cwd, recorded === null ? env : { CLAUDE_CONFIG_DIR: recorded }, homeDir)
  }
  let tail: TailHandle | null = null
  let stopped = false
  let polls = 0
  // The looks run one after the other, none dropped: a look is one poll, and the polls are counted (every 4th looks
  // through every project folder, for 200 of them).
  let chain: Promise<void> = Promise.resolve()
  const handle: ClaudeSessionWatcherHandle = {
    terminalId,
    sessionId,
    settled: () => chain,
    sessionFile: path.join(claudeProjectsDir(cwd, env, homeDir), mangleCwd(cwd), name),
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
  // One look at a time, all on the thread pool. This was a synchronous existsSync (and, until the first
  // look found the record, a synchronous read of it) on the main thread, once per poll, per watched session.
  const lookOnce = async (): Promise<void> => {
    if (stopped || tail) return
    try {
      if (folders === null) folders = [...new Set([await claudeCwd(cwd), await spelledOut(cwd)].map(mangleCwd))]
      const dir = await projectsDir()
      for (const folder of folders) {
        const file = path.join(dir, folder, name)
        let there = true
        try { await fs.promises.access(file) } catch { there = false }
        if (there) return follow(file)
      }
      polls += 1
      if (polls % SCAN_EVERY_POLLS !== 0 || polls > SCAN_POLLS) return
      const found = await sessionFileIn(dir, name)
      if (found) follow(found)
    } catch { /* the next look tries again */ }
  }
  const locate = (): void => { chain = chain.then(lookOnce) }
  const locator = setInterval(locate, POLL_INTERVAL_MS)
  locate()
  return handle
}
