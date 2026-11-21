// Lumopolis world host: the CHILD half of the world compiler, run in its own utilityProcess
// (serviceName `termpolis-lumopolis`) so reading a whole repository, detecting boundaries and laying
// out a world never runs on the main thread that echoes keystrokes. worldClient.ts is the MAIN half.
//
// Same shape as memoryHost.ts: an `init` message, then `call` messages answered with `result`, all
// discriminated on `kind`. Three extras:
//   - pushes: `progress` while a world compiles, and `updated` after every save (compile, relayout, watcher recompile);
//   - a reverse RPC for labelling: the host posts `llm`, main posts `llm-started` once the call has one of the
//     computer's labelling slots (llmGate.ts) and answers `llm-result`; a host that stops waiting posts `llm-cancel`. The model call
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
import { cardText } from './cardText'
import type { Claim, Evidence, Proposal, WorldDoc, WorldQuery, WorldReadResult } from '../../shared/world/types'
import { createAnnotationStore, hasPart, mergeAnnotations, NO_PART, withAnnotations, type AnnotationStore } from './annotations'
import { compileWorld, compileWorldStaged, createRecompileScheduler, type CompileDeps, type StagedInput } from './compile'
import { snapshotFromFiles } from './fileSnapshot'
import type { StageCache } from './stageCache'
import type { TestRun } from './testStatus'
import { cleanTranscriptFiles, readTranscriptRuns, TRANSCRIPT_CACHE_MS } from './transcriptRuns'
import { MAX_DETECT_FILE_CHARS } from './detectors'
import { confinedReader, isCloneRoot } from './folderSafety'
import {
  CANCELLED_MESSAGE,
  CLONE_TIMEOUT_MS,
  cloneKey,
  cloneRepo,
  dirSizeOf,
  nodeExecFile,
  removeDir,
  TIMEOUT_MESSAGE,
  type CloneDeps,
  type CloneResult,
  type LoginRun,
  type NeedsLogin
} from './gitSource'
import { normalizeToken, TOKEN_REJECTED_MESSAGE } from '../../shared/world/repoAccess'
import { resolveGitBin } from '../binPath'
import type { LabelDeps } from './label'
import { createWorldStore, type WorldStore } from './worldStore'
import { validateWorld } from '../../shared/world/validate'

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
  /** The askpass Termpolis ships (resources/git-askpass/askpass.sh); a token run needs it. */
  askpassPath?: string
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
/** Main gave a labelling request a slot and started its model call: the host's limit for the call starts now. */
export interface WorldLlmStartedMsg {
  kind: 'llm-started'
  id: number
}
/** The `worldLabelling` setting changed: the next compile or watcher recompile honours it, no restart. */
export interface WorldSettingsMsg {
  kind: 'settings'
  labelling: boolean
}
/** Main's answer to a `context` request: the evidence it found for the building (empty when it found none). */
export interface WorldContextResultMsg {
  kind: 'context-result'
  id: number
  evidence: Evidence[]
}
/**
 * Main's answer to a `runs` request: for `ci`, the test runs; for `transcript`, only the FILES to read (the host
 * reads and parses them, so main never does). Empty when there are none.
 */
export interface WorldRunsResultMsg {
  kind: 'runs-result'
  id: number
  runs: TestRun[]
  files?: string[]
}
export type WorldHostRequest =
  | WorldInitMsg
  | WorldCallMsg
  | WorldLlmResultMsg
  | WorldLlmStartedMsg
  | WorldContextResultMsg
  | WorldRunsResultMsg
  | WorldSettingsMsg

export interface WorldReadyMsg { kind: 'ready'; pid: number }
export interface WorldInitErrorMsg { kind: 'init-error'; error: SerializedError }
export interface WorldOkMsg { kind: 'result'; id: number; ok: true; result: unknown }
export interface WorldErrMsg { kind: 'result'; id: number; ok: false; error: SerializedError }
export interface WorldProgressMsg { kind: 'progress'; projectKey: string; stage: string; pct: number }
export interface WorldUpdatedMsg { kind: 'updated'; projectKey: string }
export interface WorldLlmMsg { kind: 'llm'; id: number; projectKey: string; prompt: string }
/** The host stopped waiting for a labelling request (its limit passed): main drops it, and never starts it if it still waits. */
export interface WorldLlmCancelMsg { kind: 'llm-cancel'; id: number }
/** The host asks main for commit, docs and memory evidence about a building's files. */
export interface WorldContextMsg { kind: 'context'; id: number; projectKey: string; members: string[] }
/** The host asks main for test runs: the agent transcripts' (`transcript`) or the newest CI conclusion's (`ci`). */
export interface WorldRunsMsg { kind: 'runs'; id: number; projectKey: string; source: 'transcript' | 'ci' }
export type WorldHostResponse =
  | WorldReadyMsg
  | WorldInitErrorMsg
  | WorldOkMsg
  | WorldErrMsg
  | WorldProgressMsg
  | WorldUpdatedMsg
  | WorldLlmMsg
  | WorldLlmCancelMsg
  | WorldContextMsg
  | WorldRunsMsg

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
export const LLM_TIMEOUT_MS = 150_000
/** How long a labelling request may wait in main for a slot (behind other worlds' calls) before the host stops waiting.
 *  The wait is not the call's time: LLM_TIMEOUT_MS starts when main says the call started. */
export const LLM_QUEUE_TIMEOUT_MS = 30 * 60_000
/** How long a compile waits for main's commit, docs and memory evidence for one building. */
export const CONTEXT_WAIT_MS = 10_000
/** How long a compile waits for main's test runs (CI asks `gh` for up to 5 s, then git). */
export const RUNS_WAIT_MS = 20_000
/**
 * The watcher recompile's debounce. Its input is already paced: main tells the host only after the code
 * watcher's window (CODE_WATCH_MS) and its re-index, and no more often than every 2 s. So this wait only gathers what
 * lands together; a longer one would add itself to the time from a saved file to the world showing it.
 */
export const WATCH_RECOMPILE_MS = 100
const MAX_RUNS = 5000

/** Main's test runs, checked: whole runs only, as `source`, at most MAX_RUNS. */
export function cleanRuns(v: unknown, source: TestRun['source']): TestRun[] {
  if (!Array.isArray(v)) return []
  const out: TestRun[] = []
  for (const r of v) {
    if (out.length === MAX_RUNS) break
    if (typeof r === 'object' && r !== null && isStr((r as TestRun).file) && typeof (r as TestRun).passed === 'boolean' && Number.isFinite((r as TestRun).at)) {
      out.push({ file: (r as TestRun).file, passed: (r as TestRun).passed, at: (r as TestRun).at, source })
    }
  }
  return out
}
const CONTEXT_KINDS = new Set(['file', 'commit', 'memory'])
const MAX_CONTEXT_ITEMS = 11

/** Main's evidence list, checked: only whole file, commit and memory items with text survive. */
export function cleanEvidence(v: unknown): Evidence[] {
  if (!Array.isArray(v)) return []
  const out: Evidence[] = []
  for (const e of v) {
    if (out.length === MAX_CONTEXT_ITEMS) break
    if (typeof e === 'object' && e !== null && CONTEXT_KINDS.has((e as Evidence).kind) && isStr((e as Evidence).ref) && isStr((e as Evidence).excerpt)) {
      out.push({ kind: (e as Evidence).kind, ref: (e as Evidence).ref, excerpt: (e as Evidence).excerpt })
    }
  }
  return out
}

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
  // The facts beyond how and why (tests, code, a person) cite evidence too: a test's source rides on it.
  const known = Array.isArray(rec.claims) ? (rec.claims as Claim[]) : []
  return [...how, ...why, ...known]
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
  const q = query ?? {}
  if (!doc) {
    return { items: [], evidence: [], ...(q.cards === true ? { cards: {} } : {}), ...(q.plan === true ? { plan: { proposals: [] } } : {}) }
  }
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
  return {
    items, evidence,
    ...(q.cards === true ? { cards: cardsOf(doc, items) } : {}),
    ...(q.plan === true ? { plan: { proposals: doc.layers.plan.map(proposalPlan) } } : {})
  }
}

/** A plain-text card for each building and line among the items (a district has none). */
function cardsOf(doc: WorldDoc, items: Item[]): Record<string, string> {
  const out: Record<string, string> = Object.create(null)
  for (const it of items) {
    const text = cardText(doc, it.id)
    if (text !== '') out[it.id] = text
  }
  return out
}

/**
 * One proposal against the built code. The linked design carries what reconcilePlan found when the world
 * compiled (missing, changed while the build still falls short of the plan, extra); a hand-sketched one has
 * nothing built to compare with, so all its buildings are missing.
 */
function proposalPlan(p: Proposal): NonNullable<WorldReadResult['plan']>['proposals'][number] {
  const r = p.reconcile
  return {
    id: p.id, title: p.title,
    missing: r ? [...r.missing] : p.buildings.map((b) => b.id),
    changed: r ? [...r.changed] : [], extra: r ? [...r.extra] : [], removes: [...(p.removes ?? [])],
    ...(r ? { planAt: r.planAt } : {})
  }
}

// ── The host ─────────────────────────────────────────────────────────────────────────────────────

export interface WorldHostDeps {
  /** A plain compile (tests); without it the host compiles with the stage cache (compileWorldStaged). */
  compile?: typeof compileWorld
  /** Lists a folder's files for snapshotFromFiles (default: `git ls-files`). */
  listFiles?: (root: string) => Promise<string[]>
  createStore?: (dir: string) => WorldStore
  /** The annotation store for a userData folder (default: annotations.ts's). */
  createAnnotations?: (dir: string) => AnnotationStore
  /** Reads test reports (default: readCapped up to MAX_READ_BYTES); also source when `readSource` is absent. */
  readFile?: (p: string) => Promise<string | null>
  /** Reads source for the boundary scan and labelling excerpts (default: readCapped up to MAX_SOURCE_READ_BYTES). */
  readSource?: (p: string) => Promise<string | null>
  glob?: (root: string, patterns: string[]) => Promise<string[]>
  now?: () => number
  /** The watcher recompile's debounce (default WATCH_RECOMPILE_MS). */
  debounceMs?: number
  /** How long one labelling call may run once main has started it (default LLM_TIMEOUT_MS). */
  llmTimeoutMs?: number
  /** How long a labelling request may wait for main to start it (default LLM_QUEUE_TIMEOUT_MS). */
  llmQueueTimeoutMs?: number
  /** How long to wait for main's evidence for one building (default CONTEXT_WAIT_MS). */
  contextTimeoutMs?: number
  /** How long to wait for main's test runs (default RUNS_WAIT_MS). */
  runsTimeoutMs?: number
  /** Clones a git source (default: gitSource's cloneRepo with the real git, size check and remover). */
  cloneRepo?: typeof cloneRepo
  /** Overrides for the real clone deps (tests). */
  cloneDeps?: Partial<CloneDeps>
}

export interface WorldHost {
  /** Routes one inbound message; every answer and push goes out through `post`. Never rejects. */
  handle(msg: WorldHostRequest | null | undefined): Promise<void>
}

interface Latest {
  snap: GraphSnapshot
  head: WorldHead
  plan?: WorldDoc
}

/** The linked design main sent along, kept only when it is a valid world (anything else is ignored). */
const planArg = (plan: unknown): { plan?: WorldDoc } => (plan && validateWorld(plan).ok ? { plan: plan as WorldDoc } : {})

const refOf = (ref: unknown): string | undefined => (isStr(ref) && ref !== '' ? ref : undefined)

/** What opening a repository answers: its folder, or why not (with the host to sign in to when that is why). */
export type CloneSourceResult = { ok: true; root: string } | { ok: false; error: string; needsLogin?: NeedsLogin }
/** What a background update answers: whether anything new came down, or why not. */
export type UpdateSourceResult = { ok: true; changed: boolean } | { ok: false; error: string; needsLogin?: NeedsLogin }

/**
 * The git run a person's request asks for. No access (or anything that is not one) is a run with no
 * login; `machine` from a person is interactive; a token is trimmed and checked, and a refused one is
 * its message, so git never sees it. The token stays a local of the call that asked for it.
 */
function accessRun(access: unknown): { run: LoginRun } | { error: string } {
  if (!access || typeof access !== 'object') return { run: { mode: 'none' } }
  const a = access as { mode?: unknown; value?: unknown }
  if (a.mode === 'machine') return { run: { mode: 'machine', interactive: true } }
  if (a.mode !== 'token') return { run: { mode: 'none' } }
  const t = normalizeToken(a.value)
  return t.ok ? { run: { mode: 'token', value: t.value } } : { error: t.error }
}

/** A background update with no access: a repository opened with this computer's login asks for no prompt. */
function backgroundRun(login: unknown): LoginRun {
  return login === 'machine' ? { mode: 'machine', interactive: false } : { mode: 'none' }
}

/** True for an access that asks for a token run (its value is checked later by normalizeToken). */
const isTokenAccess = (access: unknown): boolean =>
  !!access && typeof access === 'object' && (access as { mode?: unknown }).mode === 'token'

/** Two runs are the same run: same mode, same prompt choice, same token (compared here, never kept in a key). */
function sameRun(a: LoginRun, b: LoginRun): boolean {
  if (a.mode !== b.mode) return false
  if (a.mode === 'machine') return a.interactive === (b as typeof a).interactive
  if (a.mode === 'token') return a.value === (b as typeof a).value
  return true
}

function needKey(projectKey: unknown): string {
  if (!isStr(projectKey) || projectKey === '') throw new Error('worldHost: projectKey required')
  return projectKey
}

interface HostState {
  store: WorldStore
  annotations: AnnotationStore
  userDataPath: string
  labelling: boolean
  /** From init: the shipped askpass, handed to every clone run (a token run is refused without it). */
  askpassPath?: string
  /**
   * Projects whose stage cache a compile under this init checked against every file's text. Until then (a
   * restart: files may have changed while no host ran) and after a failed run (its stages were never
   * saved), a watcher recompile reads every file, keeping a cached scan only where the hash matches.
   */
  checked: Set<string>
  /** The changed files of a failed watcher run, carried into the next run so their buildings are re-labelled. */
  carried: Map<string, string[]>
}

export function createWorldHost(post: (msg: WorldHostResponse) => void, deps: WorldHostDeps = {}): WorldHost {
  const plain = deps.compile
  const compile = async (input: StagedInput, d: CompileDeps): Promise<{ doc: WorldDoc; cache: StageCache | null }> =>
    plain ? { doc: await plain(input, d), cache: null } : compileWorldStaged(input, d)
  const createStore = deps.createStore ?? createWorldStore
  const createAnnotations = deps.createAnnotations ?? createAnnotationStore
  const readFile = deps.readFile ?? ((p: string) => readCapped(p))
  const readSource = deps.readSource ?? deps.readFile ?? ((p: string) => readCapped(p, MAX_SOURCE_READ_BYTES))
  const glob = deps.glob ?? ((root: string, patterns: string[]) => globFiles(root, patterns))
  const now = deps.now ?? Date.now
  const llmTimeoutMs = deps.llmTimeoutMs ?? LLM_TIMEOUT_MS
  const llmQueueTimeoutMs = deps.llmQueueTimeoutMs ?? LLM_QUEUE_TIMEOUT_MS
  const contextTimeoutMs = deps.contextTimeoutMs ?? CONTEXT_WAIT_MS
  const runsTimeoutMs = deps.runsTimeoutMs ?? RUNS_WAIT_MS
  const clone = deps.cloneRepo ?? cloneRepo

  /** Set by init. `labelling` is read each time a compile starts, so a settings message applies to the next one. */
  let state: HostState | null = null
  const chains = new Map<string, Promise<unknown>>()
  const latest = new Map<string, Latest>()
  const schedulers = new Map<string, ReturnType<typeof createRecompileScheduler>>()
  const llmWaiting = new Map<number, (text: string | null) => void>()
  /** Requests main has not started yet, by id: called when main says it started one. */
  const llmStarting = new Map<number, () => void>()
  let llmSeq = 0
  const contextWaiting = new Map<number, (evidence: Evidence[]) => void>()
  const runsWaiting = new Map<number, (msg: { runs?: unknown; files?: unknown }) => void>()
  /** cloneKey → the running clone and its abort controller: a repeat call joins it, cancel aborts it. */
  const clones = new Map<string, { ctl: AbortController; done: Promise<CloneResult>; run: LoginRun; progress: boolean }>()
  // Calls waiting behind a different run, and how many cancels came while any waited, by clone key.
  // Both are dropped when the last waiter of a key is done.
  const queued = new Map<string, number>()
  const cancels = new Map<string, number>()

  /** Runs `fn` after every earlier job for the same project, so saves never interleave. */
  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const next = (chains.get(key) ?? Promise.resolve()).then(fn)
    chains.set(
      key,
      next.catch(() => undefined)
    )
    return next
  }

  // A labelling request waits, first for main to give it a slot (llmGate.ts: other worlds' calls may hold them all),
  // then for its answer. Only the call itself is timed: llmTimeoutMs starts when main says it started, and the
  // label run's own clock starts then too (`started`). A request answered without ever starting (no consent, no
  // agent, cancelled while it waited) is marked started as it is answered, so it counts as reaching no model.
  const askMain =
    (projectKey: string) =>
    (prompt: string, started?: () => void): Promise<string | null> =>
      new Promise((resolve) => {
        const id = ++llmSeq
        let begun = false
        const begin = (): void => {
          if (begun) return
          begun = true
          started?.()
        }
        const finish = (text: string | null): void => {
          clearTimeout(timer)
          llmWaiting.delete(id)
          llmStarting.delete(id)
          begin()
          resolve(text)
        }
        // Main is told, so a request still waiting there leaves its line and never starts a CLI.
        const giveUp = (): void => {
          post({ kind: 'llm-cancel', id })
          finish(null)
        }
        let timer = setTimeout(giveUp, llmQueueTimeoutMs)
        llmStarting.set(id, () => {
          llmStarting.delete(id)
          begin()
          clearTimeout(timer)
          timer = setTimeout(giveUp, llmTimeoutMs)
        })
        llmWaiting.set(id, finish)
        post({ kind: 'llm', id, projectKey, prompt })
      })

  /** Asks main for evidence about a building; no answer in time is no evidence. */
  const askContext =
    (projectKey: string) =>
    (members: string[]): Promise<Evidence[]> =>
      new Promise((resolve) => {
        const id = ++llmSeq
        const timer = setTimeout(() => {
          contextWaiting.delete(id)
          resolve([])
        }, contextTimeoutMs)
        contextWaiting.set(id, (evidence) => {
          clearTimeout(timer)
          contextWaiting.delete(id)
          resolve(evidence)
        })
        post({ kind: 'context', id, projectKey, members })
      })

  /** Asks main about test runs from `source`; no answer in time is an empty answer. */
  const askRunsMain = (projectKey: string, source: 'transcript' | 'ci'): Promise<{ runs?: unknown; files?: unknown }> =>
    new Promise((resolve) => {
      const id = ++llmSeq
      const timer = setTimeout(() => {
        runsWaiting.delete(id)
        resolve({})
      }, runsTimeoutMs)
      runsWaiting.set(id, (msg) => {
        clearTimeout(timer)
        runsWaiting.delete(id)
        resolve(msg)
      })
      post({ kind: 'runs', id, projectKey, source })
    })
  const askCi = (projectKey: string) => async (): Promise<TestRun[]> => cleanRuns((await askRunsMain(projectKey, 'ci')).runs, 'ci')
  /** Main names the transcript files; this host reads the tail of each, parses it and yields between files. */
  const transcriptCache = new Map<string, { at: number; runs: TestRun[] }>()
  const askTranscripts = (projectKey: string, root: string) => async (): Promise<TestRun[]> => {
    const hit = transcriptCache.get(projectKey)
    if (hit && now() - hit.at < TRANSCRIPT_CACHE_MS) return hit.runs
    const files = cleanTranscriptFiles((await askRunsMain(projectKey, 'transcript')).files)
    const runs = await readTranscriptRuns(files, root, { now })
    transcriptCache.set(projectKey, { at: now(), runs })
    return runs
  }

  /** A cloned repository is someone else's content: its reads never follow a link out of the clone. */
  const confinedTo = (root: string, read: (p: string) => Promise<string | null>): ((p: string) => Promise<string | null>) => {
    const inside = confinedReader(root, read)
    return (p) => inside(p).catch(() => null)
  }

  /** The project's stage cache, or null (none stored, a store without one, or a wrong shape). */
  const stagesOf = async (st: HostState, key: string): Promise<StageCache | null> => (st.store.loadStages ? st.store.loadStages(key) : null)

  /** The stage cache (and the files to read again) as compile input; nothing at all without a cache. */
  const stagedArg = (cache: StageCache | null, reread?: string[]): Pick<StagedInput, 'cache' | 'reread'> =>
    cache ? { cache, ...(reread ? { reread } : {}) } : {}

  /** Keeps the stage cache for the next compile; best effort (the store never rejects). */
  const keepStages = async (st: HostState, key: string, cache: StageCache | null): Promise<void> => {
    if (cache && st.store.saveStages) await st.store.saveStages(key, cache)
  }

  /** Per project: bumped on every save, so a label follow-up can tell that a newer world landed meanwhile. */
  const generations = new Map<string, number>()
  /** Per project: what the stored world was compiled from, for a follow-up that must compile it again. */
  const compiledFrom = new Map<string, Latest>()
  const bump = (key: string): void => void generations.set(key, (generations.get(key) ?? 0) + 1)

  /** Saves a compiled world and its stage cache, records what it came from, and pushes `updated`. */
  const saveCompiled = async (st: HostState, key: string, out: { doc: WorldDoc; cache: StageCache | null }, from: Latest): Promise<void> => {
    await st.store.save(out.doc)
    await keepStages(st, key, out.cache)
    bump(key)
    compiledFrom.set(key, from)
    post({ kind: 'updated', projectKey: key })
  }

  /** One labelled run in flight. `again` asks for one more after it, for `changed` files (null: every file). */
  interface LabelRun { again: boolean; changed: string[] | null }
  /** Per project: the labelling run in flight; at most one per project at a time (fix wave I1). */
  const labelRuns = new Map<string, LabelRun>()
  interface RunInput { base: WorldDoc; from: Latest; cache: StageCache | null; changed: string[] | undefined; generation: number | undefined }

  /**
   * One labelled pass: the model is asked outside the project's queue, so a file change meanwhile still saves
   * and draws at once; every accepted reply also lands in the label cache. Then, in the queue: labelling
   * turned off meanwhile saves nothing; when no newer world was saved since `base`, the labelled world is
   * saved as it is; when one was, that newer world is compiled again from the label cache (which now holds
   * the replies) for the same files, so the labels merge into it.
   */
  const labelOnce = async (st: HostState, key: string, r: RunInput): Promise<void> => {
    const only = r.changed ? { changed: r.changed } : {}
    const out = await compile(
      { snap: r.from.snap, projectKey: key, head: r.from.head, previous: r.base, ...only, ...stagedArg(r.cache, []), ...planArg(r.from.plan) },
      depsFor(st, key, r.from.snap, askMain(key))
    )
    await serial(key, async () => {
      if (!st.labelling) return
      if (generations.get(key) === r.generation) return saveCompiled(st, key, out, r.from)
      const now = compiledFrom.get(key) as Latest
      const previous = await st.store.load(key)
      if (!previous) return
      const fromCache = async (): Promise<null> => null
      const again = await compile(
        { snap: now.snap, projectKey: key, head: now.head, previous, ...only, ...stagedArg(await stagesOf(st, key), []), ...planArg(now.plan) },
        depsFor(st, key, now.snap, fromCache)
      )
      await saveCompiled(st, key, again, now)
    })
  }

  /**
   * Labels with the model after a pass that labelled from the label cache only (film bug 8). One run per
   * project at a time: a trigger while one runs only marks it to run once more after, for the union of the
   * changed files (a full pass when any trigger was one). That run starts from the stored world, so the label
   * cache answers whatever is already labelled and the model is asked only for what is still missing.
   */
  const labelLater = (st: HostState, key: string, base: WorldDoc, from: Latest, cache: StageCache | null, changed?: string[]): void => {
    // Labelling turned off since the cache-only pass started asks no model.
    if (!st.labelling) return
    const running = labelRuns.get(key)
    if (running) {
      running.changed = !running.again ? (changed ?? null) : running.changed && changed ? [...new Set([...running.changed, ...changed])].sort() : null
      running.again = true
      return
    }
    const run: LabelRun = { again: false, changed: null }
    labelRuns.set(key, run)
    const loop = async (): Promise<void> => {
      let next: RunInput | null = { base, from, cache, changed, generation: generations.get(key) }
      while (next) {
        await labelOnce(st, key, next).catch((err: unknown) => console.error('[world host] labelled follow-up failed:', err))
        if (!run.again || !st.labelling) break
        const files = run.changed ?? undefined
        run.again = false
        run.changed = null
        next = await serial(key, async () => {
          const stored = await st.store.load(key)
          if (!stored) return null
          return { base: stored, from: compiledFrom.get(key) as Latest, cache: await stagesOf(st, key), changed: files, generation: generations.get(key) }
        })
      }
    }
    // Whatever happens, the project is freed, so a failed run never stops the next trigger from labelling.
    void loop()
      .catch((err: unknown) => console.error('[world host] labelling rerun failed:', err))
      .finally(() => labelRuns.delete(key))
  }

  /** `llm` is main's model, the label cache only, or none (labelling off). */
  const depsFor = (st: HostState, projectKey: string, snap: GraphSnapshot, llm: LabelDeps['llm']): CompileDeps => {
    const root = String(snap.root).replace(/\/+$/, '')
    const cloned = isCloneRoot(st.userDataPath, root)
    const rf = cloned ? confinedTo(root, readFile) : readFile
    const rs = cloned ? confinedTo(root, readSource) : readSource
    const label: LabelDeps = {
      llm,
      ...(st.labelling ? { context: askContext(projectKey) } : {}),
      cache: st.store.labelCache,
      excerpt: async (file, line) => {
        const text = await rs(`${root}/${file}`)
        return text === null ? '' : excerptOf(text, line)
      }
    }
    return {
      readFile: rf,
      readSource: rs,
      glob,
      label,
      now,
      // A cloned repository's own transcripts and CI are not this machine's: no runs from main for it.
      ...(cloned ? {} : { transcriptRuns: askTranscripts(projectKey, root), ciRuns: askCi(projectKey) }),
      annotations: () => st.annotations.list(projectKey),
      onProgress: (stage, pct) => post({ kind: 'progress', projectKey, stage, pct })
    }
  }

  const schedulerFor = (st: HostState, key: string): ReturnType<typeof createRecompileScheduler> => {
    let s = schedulers.get(key)
    if (!s) {
      s = createRecompileScheduler(
        (notified) =>
          serial(key, async () => {
            // A watcher never makes the first world: no stored world, nothing to refresh.
            const previous = await st.store.load(key)
            if (!previous) return
            const cur = latest.get(key) as Latest
            const changed = [...new Set([...(st.carried.get(key) ?? []), ...notified])].sort()
            st.carried.set(key, changed)
            // Once this lifetime has checked the cache, only the changed files are read again and the rest of
            // the scan comes from it; before that, every file is read and hash-checked.
            const cache = await stagesOf(st, key)
            const reread = st.checked.has(key) ? undefined : [...cur.snap.files]
            const input = { snap: cur.snap, projectKey: key, head: cur.head, previous, changed, ...stagedArg(cache, reread), ...planArg(cur.plan) }
            st.checked.delete(key)
            // Labelling on: this pass labels from the label cache only, so the change is saved and drawn
            // at once; when anything missed, the model labels it afterwards, outside this queue.
            const labelled = st.labelling
            let missed = false
            const cacheOnly = async (): Promise<null> => {
              missed = true
              return null
            }
            const out = await compile(input, depsFor(st, key, cur.snap, labelled ? cacheOnly : null))
            const from = { snap: cur.snap, head: cur.head, ...planArg(cur.plan) }
            await saveCompiled(st, key, out, from)
            st.checked.add(key)
            st.carried.delete(key)
            if (missed) labelLater(st, key, out.doc, from, out.cache, changed)
          }),
        deps.debounceMs ?? WATCH_RECOMPILE_MS
      )
      schedulers.set(key, s)
    }
    return s
  }

  type Handler = (...args: never[]) => Promise<unknown>
  const handlers = (st: HostState): Record<string, Handler> => ({
    compile: (projectKey: unknown, snap: GraphSnapshot, head: WorldHead, opts?: { relayout?: boolean; plan?: unknown }) => {
      const key = needKey(projectKey)
      const plan = planArg(opts?.plan)
      // Labelling on: the model's questions can outlast the RPC's timeout while the user sees nothing. So
      // this pass labels from the label cache only (a miss keeps the code-derived label and asks no model);
      // it is saved, pushed and returned at once. When anything missed, labelLater asks the model outside
      // the queue, building on the world just saved so its positions carry, then saves and pushes again.
      const labelled = st.labelling
      let missed = false
      const cacheOnly = async (): Promise<null> => {
        missed = true
        return null
      }
      return serial(key, async () => {
        // A re-layout is a compile whose previous world has no positions (so it lays out afresh with
        // the same seed) and the next layout round (so the window knows the parts moved on purpose);
        // everything else compile carries from previous still carries.
        const stored = await st.store.load(key)
        const previous =
          stored && opts?.relayout === true
            ? { ...stored, layout: { seed: stored.layout.seed, positions: {}, round: (stored.layout.round ?? 0) + 1 } }
            : stored
        // With a stored stage cache every file is read but only one whose text changed is scanned again.
        const cache = await stagesOf(st, key)
        st.checked.delete(key)
        const out = await compile({ snap, projectKey: key, head, previous, ...stagedArg(cache), ...plan }, depsFor(st, key, snap, labelled ? cacheOnly : null))
        await saveCompiled(st, key, out, { snap, head, ...plan })
        // Every file was read and checked, and the stages saved: watcher runs may trust them now.
        st.checked.add(key)
        if (missed) labelLater(st, key, out.doc, { snap, head, ...plan }, out.cache)
        return out.doc
      })
    },
    get: async (projectKey: unknown) => st.store.load(needKey(projectKey)),
    // A person's confirmation: stored apart from the world (a recompile keeps it) and merged into the saved
    // doc, which is returned so the pane shows it at once. Works on design worlds as well (their files sit in
    // the same store).
    annotate: (projectKey: unknown, itemId: unknown, claim: unknown) => {
      const key = needKey(projectKey)
      return serial(key, async () => {
        const doc = await st.store.load(key)
        if (!doc || !isStr(itemId) || !hasPart(doc, itemId)) throw new Error(NO_PART)
        await st.annotations.add(key, itemId, claim as Claim)
        // A new generation, so a pane holding the old one reloads (it skips a doc whose generatedAt it already shows).
        const merged = { ...mergeAnnotations(doc, await st.annotations.list(key)), generatedAt: Math.max(now(), doc.generatedAt + 1) }
        await st.store.save(merged)
        bump(key)
        return merged
      })
    },
    notifyChanged: async (projectKey: unknown, snap: GraphSnapshot, head: WorldHead, files: unknown, plan?: unknown) => {
      const key = needKey(projectKey)
      latest.set(key, { snap, head, ...planArg(plan) })
      schedulerFor(st, key).notify(Array.isArray(files) ? files.filter(isStr) : [])
      return true
    },
    read: async (projectKey: unknown, query: WorldQuery) => filterWorld(await st.store.load(needKey(projectKey)), query),
    cloneSource: async (url: unknown, ref?: unknown, access?: unknown): Promise<CloneSourceResult> => {
      const asked = accessRun(access)
      if ('error' in asked) return { ok: false, error: asked.error }
      const res = await runClone(st, url, ref, asked.run, true)
      return res.ok ? { ok: true, root: res.root } : res
    },
    // Brings a repository Lumopolis already opened up to date. With no access it runs the way the entry
    // was opened: no login, or this computer's login without a prompt. A token entry runs only with a token
    // access: anything else (none, machine, an unknown shape) is refused here before git runs.
    updateSource: async (url: unknown, ref?: unknown, login?: unknown, access?: unknown): Promise<UpdateSourceResult> => {
      if (login === 'token' && !isTokenAccess(access)) throw new Error('token update needs a token')
      const asked = access === undefined ? { run: backgroundRun(login) } : accessRun(access)
      if ('error' in asked) return { ok: false, error: asked.error }
      const res = await runClone(st, url, ref, asked.run, false)
      return res.ok ? { ok: true, changed: res.changed } : res
    },
    // The structure of a folder main has not indexed yet, read and parsed here rather than on main's
    // thread. A clone's reads never follow a link out of it.
    snapshotFromFiles: async (root: unknown) => {
      if (!isStr(root) || root === '') throw new Error('worldHost: root required')
      const read = isCloneRoot(st.userDataPath, root) ? confinedTo(root, readSource) : readSource
      return snapshotFromFiles(root, { read, ...(deps.listFiles ? { listFiles: deps.listFiles } : {}) })
    },
    // Cancels the running clone or update and every call waiting behind it (a waiting one never starts git).
    cancelClone: async (url: unknown, ref?: unknown) => {
      const hash = cloneKey(isStr(url) ? url : '', refOf(ref))
      const waiting = queued.has(hash)
      if (waiting) cancels.set(hash, (cancels.get(hash) ?? 0) + 1)
      const running = clones.get(hash)
      running?.ctl.abort()
      return running !== undefined || waiting
    }
  })

  /**
   * A token run needs the askpass Termpolis ships to exist: without it git would ask a terminal nobody
   * sees, so the run is refused before git starts and one plain line (never the value) is logged. It is
   * checked inside the registered run, so a cancel that lands while it is looked for still finds the run.
   */
  const askpassReady = async (st: HostState, run: LoginRun): Promise<boolean> => {
    if (run.mode !== 'token') return true
    const p = deps.cloneDeps?.askpassPath ?? st.askpassPath
    const there = p ? await fsp.stat(p).then((s) => s.isFile(), () => false) : false
    if (!there) console.warn('[world host] a token run was refused: the askpass Termpolis ships was not found')
    return there
  }

  /**
   * One clone or update of a url and branch at a time. A repeat call joins the running one only when it
   * asks for the same run (an open joining a silent run turns its progress on); a different run waits for
   * the running one to settle, then starts its own, unless cancelClone came meanwhile or the wait alone
   * used up a run's whole time (then it answers that copy and git never sees it).
   *
   * `since` is when the caller first asked and `cancelsAtQueue` the cancel count when it first queued; a call
   * that waits behind one run and then another keeps both, so every wait counts against one CLONE_TIMEOUT_MS
   * and a cancel during any of its waits still stops it.
   */
  const runClone = (
    st: HostState,
    url: unknown,
    ref: unknown,
    run: LoginRun,
    progress: boolean,
    since: number = now(),
    cancelsAtQueue?: number
  ): Promise<CloneResult> => {
    const u = isStr(url) ? url : ''
    const r = refOf(ref)
    const hash = cloneKey(u, r)
    const projectKey = `clone:${hash}`
    // What is left of this caller's time: nothing left means no git, and no more waiting, for a caller whose
    // client may already have given up.
    const left = CLONE_TIMEOUT_MS - (now() - since)
    if (left <= 0) return Promise.resolve({ ok: false, error: TIMEOUT_MESSAGE })
    const running = clones.get(hash)
    if (running) {
      if (!sameRun(running.run, run)) {
        const snapshot = cancelsAtQueue ?? cancels.get(hash) ?? 0
        queued.set(hash, (queued.get(hash) ?? 0) + 1)
        return running.done
          .catch(() => undefined)
          .then((): Promise<CloneResult> => {
            const cancelled = (cancels.get(hash) ?? 0) !== snapshot
            // Queue again (or start) before this wait is let go, so the cancel count this call holds a snapshot
            // of is not cleared between its two waits.
            const next: Promise<CloneResult> = cancelled
              ? Promise.resolve({ ok: false, error: CANCELLED_MESSAGE })
              : runClone(st, url, ref, run, progress, since, snapshot)
            const waiting = (queued.get(hash) as number) - 1
            if (waiting > 0) queued.set(hash, waiting)
            else {
              queued.delete(hash)
              cancels.delete(hash)
            }
            return next
          })
      }
      if (progress && !running.progress) {
        running.progress = true
        post({ kind: 'progress', projectKey, stage: 'cloning', pct: 0 })
      }
      return running.done
    }
    const ctl = new AbortController()
    if (progress) post({ kind: 'progress', projectKey, stage: 'cloning', pct: 0 })
    const entry = { ctl, run, progress } as { ctl: AbortController; done: Promise<CloneResult>; run: LoginRun; progress: boolean }
    // The askpass check runs inside the registered entry: a cancel during it aborts ctl, and the run answers
    // Cancelled, whether the askpass was found (the clone stops before it looks for git) or not.
    const done = askpassReady(st, run)
      .then(
        (ready): Promise<CloneResult> =>
          ready
            ? clone(
                u,
                r,
                {
                  execFile: nodeExecFile,
                  gitBin: resolveGitBin,
                  baseDir: st.userDataPath,
                  dirSize: dirSizeOf,
                  rm: removeDir,
                  isWindows: process.platform === 'win32',
                  ...(st.askpassPath ? { askpassPath: st.askpassPath } : {}),
                  ...deps.cloneDeps,
                  timeoutMs: left,
                  signal: ctl.signal
                },
                run
              )
            : Promise.resolve({ ok: false, error: ctl.signal.aborted ? CANCELLED_MESSAGE : TOKEN_REJECTED_MESSAGE })
      )
      .then((res) => {
        if (res.ok && entry.progress) post({ kind: 'progress', projectKey, stage: 'cloning', pct: 100 })
        return res
      })
      .finally(() => clones.delete(hash))
    entry.done = done
    clones.set(hash, entry)
    return done
  }

  const fail = (id: number, message: string): void => post({ kind: 'result', id, ok: false, error: { name: 'Error', message } })

  return {
    async handle(msg) {
      if (!msg || typeof msg !== 'object') return
      if (msg.kind === 'init') {
        try {
          if (!isStr(msg.userDataPath) || msg.userDataPath === '') throw new Error('worldHost: userDataPath required')
          for (const s of schedulers.values()) s.dispose()
          schedulers.clear()
          const annotations = createAnnotations(msg.userDataPath)
          state = {
            store: withAnnotations(createStore(msg.userDataPath), annotations),
            annotations,
            userDataPath: msg.userDataPath,
            labelling: msg.labelling !== false,
            ...(isStr(msg.askpassPath) && msg.askpassPath !== '' ? { askpassPath: msg.askpassPath } : {}),
            checked: new Set(),
            carried: new Map()
          }
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
      if (msg.kind === 'context-result') {
        contextWaiting.get(msg.id)?.(cleanEvidence(msg.evidence))
        return
      }
      if (msg.kind === 'runs-result') {
        runsWaiting.get(msg.id)?.({ runs: msg.runs, files: msg.files })
        return
      }
      if (msg.kind === 'llm-result') {
        llmWaiting.get(msg.id)?.(isStr(msg.text) ? msg.text : null)
        return
      }
      if (msg.kind === 'llm-started') {
        llmStarting.get(msg.id)?.()
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
