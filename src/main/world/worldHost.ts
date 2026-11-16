// Lumopolis world host: the CHILD half of the world compiler, run in its own utilityProcess
// (serviceName `termpolis-lumopolis`) so reading a whole repository, detecting boundaries and laying
// out a world never runs on the main thread that echoes keystrokes. worldClient.ts is the MAIN half.
//
// Same shape as memoryHost.ts: an `init` message, then `call` messages answered with `result`, all
// discriminated on `kind`. Three extras:
//   - pushes: `progress` while a world compiles, and `updated` after every save (compile, relayout, watcher recompile);
//   - a reverse RPC for labelling: the host posts `llm` and main answers `llm-result`. The model call
//     runs in MAIN because it needs the token-proxy environment main owns (claudeLaunchEnv), and
//     because spawning an agent CLI from here would put a second spawner beside procHost;
//   - per-project serialisation, so a compile and a watcher recompile never race to save.
//
// The ONLY Electron touch is `process.parentPort` at the bottom. Nothing here imports 'electron'
// (tests/electron/worldHostImports.test.ts guards the whole import graph), because a named import of
// an Electron API that a utilityProcess lacks is a link-time error that kills the child silently.
import * as fsp from 'node:fs/promises'
import { join } from 'node:path'
import type { GraphSnapshot } from '../codeGraph'
import { lowerHostPriority } from '../hostPriority'
import type { Claim, Evidence, WorldDoc, WorldQuery, WorldReadResult } from '../../shared/world/types'
import { compileWorld, createRecompileScheduler, type CompileDeps } from './compile'
import { MAX_DETECT_FILE_CHARS } from './detectors'
import type { LabelDeps } from './label'
import { createWorldStore, type WorldStore } from './worldStore'

// ── Wire protocol ────────────────────────────────────────────────────────────────────────────────

export interface SerializedError {
  message: string
  name: string
}

export interface WorldHead {
  head: string
  dirty: boolean
}

export interface WorldInitMsg {
  kind: 'init'
  /** Electron's userData folder; the store lives under `<userDataPath>/world/`. */
  userDataPath: string
  /** The `worldLabelling` setting. False: the host labels from the code alone (`llm: null`). */
  labelling: boolean
}
export interface WorldCallMsg {
  kind: 'call'
  id: number
  fn: string
  args: unknown[]
}
export interface WorldLlmResultMsg {
  kind: 'llm-result'
  id: number
  text: string | null
}
/** The `worldLabelling` setting changed: the next compile or watcher recompile honours it, no restart. */
export interface WorldSettingsMsg {
  kind: 'settings'
  labelling: boolean
}
export type WorldHostRequest = WorldInitMsg | WorldCallMsg | WorldLlmResultMsg | WorldSettingsMsg

export interface WorldReadyMsg { kind: 'ready'; pid: number }
export interface WorldInitErrorMsg { kind: 'init-error'; error: SerializedError }
export interface WorldOkMsg { kind: 'result'; id: number; ok: true; result: unknown }
export interface WorldErrMsg { kind: 'result'; id: number; ok: false; error: SerializedError }
export interface WorldProgressMsg { kind: 'progress'; projectKey: string; stage: string; pct: number }
export interface WorldUpdatedMsg { kind: 'updated'; projectKey: string }
export interface WorldLlmMsg { kind: 'llm'; id: number; projectKey: string; prompt: string }
export type WorldHostResponse =
  | WorldReadyMsg
  | WorldInitErrorMsg
  | WorldOkMsg
  | WorldErrMsg
  | WorldProgressMsg
  | WorldUpdatedMsg
  | WorldLlmMsg

/** Errors do not survive structured clone (an Error posts as `{}`), so flatten them. */
export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) return { message: err.message || String(err), name: err.name || 'Error' }
  return { message: typeof err === 'string' ? err : String(err), name: 'Error' }
}

// ── File-system deps ─────────────────────────────────────────────────────────────────────────────

/** Files larger than this read as absent: the biggest test report the status reader accepts. */
export const MAX_READ_BYTES = 16 * 1024 * 1024
/** Source files larger than this read as absent. The boundary scan drops a file over MAX_DETECT_FILE_CHARS
 *  characters anyway; a UTF-8 character is at least one byte, so this cap never drops a file the scan
 *  would keep, bar one whose multi-byte text runs past the margin. */
export const MAX_SOURCE_READ_BYTES = MAX_DETECT_FILE_CHARS + 64 * 1024
/** Report files one glob may return; a repository with more is not a normal one. */
export const MAX_GLOB_RESULTS = 2000
/** Lines an excerpt spans: centred on the line when one is given, else the file's start. */
export const EXCERPT_LINES = 40
/** How long a compile waits for main to answer one labelling request before labelling from code. */
export const LLM_TIMEOUT_MS = 120_000

const SKIP_DIRS = new Set(['node_modules', '.git'])

/** The slice of an open file readCapped uses (a `fs.promises` FileHandle fits it). */
export interface ReadHandle {
  stat(): Promise<{ isFile(): boolean; size: number }>
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

const openForRead = (p: string): Promise<ReadHandle> => fsp.open(p, 'r')

/**
 * Reads a UTF-8 file, or null when it is missing, not a file, bigger than `max`, or unreadable.
 * A bounded read: one buffer of the file's size + 1 bytes, never more, so a file that grows past what
 * stat said (one being written) reads as absent instead of being read without limit.
 */
export async function readCapped(
  p: string,
  max = MAX_READ_BYTES,
  open: (p: string) => Promise<ReadHandle> = openForRead
): Promise<string | null> {
  let handle: ReadHandle
  try {
    handle = await open(p)
  } catch {
    return null
  }
  try {
    const st = await handle.stat()
    if (!st.isFile() || st.size > max) return null
    const buf = Buffer.alloc(st.size + 1)
    let filled = 0
    for (;;) {
      const { bytesRead } = await handle.read(buf, filled, buf.length - filled, filled)
      if (bytesRead === 0) break
      filled += bytesRead
      if (filled === buf.length) return null
    }
    return buf.toString('utf8', 0, filled)
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export type GlobFn = (
  patterns: string[],
  opts: { cwd: string; exclude: (p: string) => boolean }
) => AsyncIterable<string>

/** node's fs.promises.glob (Node 22+); absent on an older runtime, which then finds no reports. */
const nodeGlob = (fsp as unknown as { glob?: GlobFn }).glob

/**
 * Absolute paths under `root` matching the positive patterns. `!` patterns are dropped (node's glob
 * has no negation); node_modules and .git are never entered instead. Never rejects.
 */
export async function globFiles(root: string, patterns: string[], globFn: GlobFn | undefined = nodeGlob): Promise<string[]> {
  const positive = patterns.filter((p) => !p.startsWith('!'))
  if (typeof globFn !== 'function' || positive.length === 0) return []
  const out: string[] = []
  try {
    const exclude = (p: string): boolean => String(p).split(/[\\/]/).some((part) => SKIP_DIRS.has(part))
    for await (const rel of globFn(positive, { cwd: root, exclude })) {
      out.push(join(root, rel))
      if (out.length >= MAX_GLOB_RESULTS) break
    }
  } catch {
    // an unreadable folder ends the walk; what was found so far still counts
  }
  return out
}

/** About EXCERPT_LINES lines of `text` around 1-based `line`, or from the top without one. */
export function excerptOf(text: string, line?: number): string {
  const lines = text.split(/\r?\n/)
  const at = typeof line === 'number' && Number.isFinite(line) ? Math.max(0, Math.floor(line) - 1 - EXCERPT_LINES / 2) : 0
  return lines.slice(at, at + EXCERPT_LINES).join('\n')
}

// ── read(): a filtered view of a stored world ────────────────────────────────────────────────────

export const DEFAULT_READ_LIMIT = 20
export const MAX_READ_LIMIT = 200

type Item = WorldReadResult['items'][number]
const isStr = (v: unknown): v is string => typeof v === 'string'

function claimsOf(item: Item): Claim[] {
  const rec = item as unknown as Record<string, unknown>
  const how = Array.isArray(rec.how) ? (rec.how as Claim[]) : []
  const why = Array.isArray(rec.why) ? (rec.why as Claim[]) : []
  return [...how, ...why]
}

/** Every text field an item is searched by: id, names, labels, members, tech words and claim text. */
function wordsOf(item: Item): string {
  const rec = item as unknown as Record<string, unknown>
  const out: string[] = [item.id]
  for (const k of ['name', 'label', 'subtitle', 'techLabel', 'cargo', 'process', 'rate']) {
    if (isStr(rec[k])) out.push(rec[k] as string)
  }
  for (const k of ['members', 'stack', 'tech']) {
    if (Array.isArray(rec[k])) out.push(...(rec[k] as unknown[]).filter(isStr))
  }
  for (const c of claimsOf(item)) out.push(c.text)
  return out.join('\n').toLowerCase()
}

/** Districts, buildings and edges matching every given filter (ids, then text), and their claims' evidence. */
export function filterWorld(doc: WorldDoc | null, query: WorldQuery | null | undefined): WorldReadResult {
  if (!doc) return { items: [], evidence: [] }
  const q = query ?? {}
  const limit =
    typeof q.limit === 'number' && Number.isFinite(q.limit)
      ? Math.min(MAX_READ_LIMIT, Math.max(1, Math.floor(q.limit)))
      : DEFAULT_READ_LIMIT
  const ids = Array.isArray(q.ids) ? new Set(q.ids.filter(isStr)) : null
  const text = isStr(q.text) ? q.text.trim().toLowerCase() : ''
  const all: Item[] = [...doc.districts, ...doc.buildings, ...doc.edges]
  const items = all.filter((it) => (ids === null || ids.has(it.id)) && (text === '' || wordsOf(it).includes(text))).slice(0, limit)
  const seen = new Set<string>()
  const evidence: Evidence[] = []
  for (const it of items) {
    for (const c of claimsOf(it)) {
      for (const e of c.evidence) {
        const key = `${e.kind}\n${e.ref}`
        if (seen.has(key)) continue
        seen.add(key)
        evidence.push(e)
      }
    }
  }
  return { items, evidence }
}

// ── The host ─────────────────────────────────────────────────────────────────────────────────────

export interface WorldHostDeps {
  compile?: typeof compileWorld
  createStore?: (dir: string) => WorldStore
  /** Reads test reports (default: readCapped up to MAX_READ_BYTES); also source when `readSource` is absent. */
  readFile?: (p: string) => Promise<string | null>
  /** Reads source for the boundary scan and labelling excerpts (default: readCapped up to MAX_SOURCE_READ_BYTES). */
  readSource?: (p: string) => Promise<string | null>
  glob?: (root: string, patterns: string[]) => Promise<string[]>
  now?: () => number
  /** The watcher recompile's debounce (default 1500 ms). */
  debounceMs?: number
  llmTimeoutMs?: number
}

export interface WorldHost {
  /** Routes one inbound message; every answer and push goes out through `post`. Never rejects. */
  handle(msg: WorldHostRequest | null | undefined): Promise<void>
}

interface Latest {
  snap: GraphSnapshot
  head: WorldHead
}

function needKey(projectKey: unknown): string {
  if (!isStr(projectKey) || projectKey === '') throw new Error('worldHost: projectKey required')
  return projectKey
}

interface HostState {
  store: WorldStore
  labelling: boolean
}

export function createWorldHost(post: (msg: WorldHostResponse) => void, deps: WorldHostDeps = {}): WorldHost {
  const compile = deps.compile ?? compileWorld
  const createStore = deps.createStore ?? createWorldStore
  const readFile = deps.readFile ?? ((p: string) => readCapped(p))
  const readSource = deps.readSource ?? deps.readFile ?? ((p: string) => readCapped(p, MAX_SOURCE_READ_BYTES))
  const glob = deps.glob ?? ((root: string, patterns: string[]) => globFiles(root, patterns))
  const now = deps.now ?? Date.now
  const llmTimeoutMs = deps.llmTimeoutMs ?? LLM_TIMEOUT_MS

  /** Set by init. `labelling` is read each time a compile starts, so a settings message applies to the next one. */
  let state: HostState | null = null
  const chains = new Map<string, Promise<unknown>>()
  const latest = new Map<string, Latest>()
  const schedulers = new Map<string, ReturnType<typeof createRecompileScheduler>>()
  const llmWaiting = new Map<number, (text: string | null) => void>()
  let llmSeq = 0

  /** Runs `fn` after every earlier job for the same project, so saves never interleave. */
  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const next = (chains.get(key) ?? Promise.resolve()).then(fn)
    chains.set(
      key,
      next.catch(() => undefined)
    )
    return next
  }

  const askMain =
    (projectKey: string) =>
    (prompt: string): Promise<string | null> =>
      new Promise((resolve) => {
        const id = ++llmSeq
        const timer = setTimeout(() => {
          llmWaiting.delete(id)
          resolve(null)
        }, llmTimeoutMs)
        llmWaiting.set(id, (text) => {
          clearTimeout(timer)
          llmWaiting.delete(id)
          resolve(text)
        })
        post({ kind: 'llm', id, projectKey, prompt })
      })

  const depsFor = (st: HostState, projectKey: string, snap: GraphSnapshot): CompileDeps => {
    const root = String(snap.root).replace(/\/+$/, '')
    const label: LabelDeps = {
      llm: st.labelling ? askMain(projectKey) : null,
      cache: st.store.labelCache,
      excerpt: async (file, line) => {
        const text = await readSource(`${root}/${file}`)
        return text === null ? '' : excerptOf(text, line)
      }
    }
    return {
      readFile,
      readSource,
      glob,
      label,
      now,
      onProgress: (stage, pct) => post({ kind: 'progress', projectKey, stage, pct })
    }
  }

  const schedulerFor = (st: HostState, key: string): ReturnType<typeof createRecompileScheduler> => {
    let s = schedulers.get(key)
    if (!s) {
      s = createRecompileScheduler(
        (changed) =>
          serial(key, async () => {
            // A watcher never makes the first world: no stored world, nothing to refresh.
            const previous = await st.store.load(key)
            if (!previous) return
            const cur = latest.get(key) as Latest
            const doc = await compile({ snap: cur.snap, projectKey: key, head: cur.head, previous, changed }, depsFor(st, key, cur.snap))
            await st.store.save(doc)
            post({ kind: 'updated', projectKey: key })
          }),
        deps.debounceMs ?? 1500
      )
      schedulers.set(key, s)
    }
    return s
  }

  type Handler = (...args: never[]) => Promise<unknown>
  const handlers = (st: HostState): Record<string, Handler> => ({
    compile: (projectKey: unknown, snap: GraphSnapshot, head: WorldHead, opts?: { relayout?: boolean }) => {
      const key = needKey(projectKey)
      return serial(key, async () => {
        // A re-layout is a compile whose previous world has no positions (so it lays out afresh with
        // the same seed); everything else compile carries from previous still carries.
        const stored = await st.store.load(key)
        const previous =
          stored && opts?.relayout === true ? { ...stored, layout: { seed: stored.layout.seed, positions: {} } } : stored
        const doc = await compile({ snap, projectKey: key, head, previous }, depsFor(st, key, snap))
        await st.store.save(doc)
        post({ kind: 'updated', projectKey: key })
        return doc
      })
    },
    get: async (projectKey: unknown) => st.store.load(needKey(projectKey)),
    notifyChanged: async (projectKey: unknown, snap: GraphSnapshot, head: WorldHead, files: unknown) => {
      const key = needKey(projectKey)
      latest.set(key, { snap, head })
      schedulerFor(st, key).notify(Array.isArray(files) ? files.filter(isStr) : [])
      return true
    },
    read: async (projectKey: unknown, query: WorldQuery) => filterWorld(await st.store.load(needKey(projectKey)), query)
  })

  const fail = (id: number, message: string): void => post({ kind: 'result', id, ok: false, error: { name: 'Error', message } })

  return {
    async handle(msg) {
      if (!msg || typeof msg !== 'object') return
      if (msg.kind === 'init') {
        try {
          if (!isStr(msg.userDataPath) || msg.userDataPath === '') throw new Error('worldHost: userDataPath required')
          for (const s of schedulers.values()) s.dispose()
          schedulers.clear()
          state = { store: createStore(msg.userDataPath), labelling: msg.labelling !== false }
          post({ kind: 'ready', pid: process.pid })
        } catch (err) {
          post({ kind: 'init-error', error: serializeError(err) })
        }
        return
      }
      if (msg.kind === 'settings') {
        // Before init there is nothing to switch: init carries the setting itself.
        if (state) state.labelling = msg.labelling !== false
        return
      }
      if (msg.kind === 'llm-result') {
        llmWaiting.get(msg.id)?.(isStr(msg.text) ? msg.text : null)
        return
      }
      if (msg.kind !== 'call') return
      if (!state) return fail(msg.id, `worldHost: not initialised (fn "${String(msg.fn)}")`)
      const table = handlers(state)
      const handler = Object.hasOwn(table, msg.fn) ? table[msg.fn] : undefined
      if (!handler) return fail(msg.id, `worldHost: unknown fn "${String(msg.fn)}"`)
      try {
        const args = Array.isArray(msg.args) ? msg.args : []
        const result = await (handler as (...a: unknown[]) => Promise<unknown>)(...args)
        post({ kind: 'result', id: msg.id, ok: true, result })
      } catch (err) {
        post({ kind: 'result', id: msg.id, ok: false, error: serializeError(err) })
      }
    }
  }
}

// ── Child-process bootstrap ──────────────────────────────────────────────────────────────────────
// GOTCHA (asymmetric): in the CHILD the listener gets an Electron MessageEvent and the payload is
// `e.data`; in the PARENT, `child.on('message', m => …)` gets the payload directly.

export interface ParentPortLike {
  on(channel: 'message', cb: (e: { data: WorldHostRequest } | undefined) => void): void
  postMessage(msg: WorldHostResponse): void
  start?: () => void
}

/** What the forked child does first: lower its own priority, exit on a stray rejection, serve the port. */
export function startWorldHost(port: ParentPortLike, deps?: WorldHostDeps): WorldHost {
  // Its OWN priority only (never another process's). Kill switch TERMPOLIS_NO_HOST_PRIORITY=1 or a list naming `world`.
  lowerHostPriority({ host: 'world' })
  // Electron 37+ only warns on an unhandled rejection in a utility process; a child in an unknown
  // state should go away, and the client starts a fresh one on the next call.
  process.on('unhandledRejection', (reason) => {
    console.error('[world host] unhandled rejection:', reason)
    process.exit(1)
  })
  const host = createWorldHost((m) => port.postMessage(m), deps)
  port.on('message', (e) => void host.handle(e?.data))
  port.start?.()
  return host
}

// `process.parentPort` exists only inside a forked utilityProcess, so importing this module from
// main or from the unit suite starts nothing.
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort
if (parentPort) startWorldHost(parentPort)
