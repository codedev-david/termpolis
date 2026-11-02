// Claude Code's saved notes, read into memory. Claude keeps what it learns about a project as small
// markdown files in ~/.claude/projects/<folder>/memory/ -- curated, one fact to a file, and visible only
// to Claude in that one project. Left there, Codex and Antigravity never see them, and a transcript search
// finds the notes' own wording for fewer than one in twenty. This pass reads them (claudeNotesParse.ts says
// how), stores them as shared memory under the project they belong to, and keeps them true: an edited note
// replaces its chunks, a deleted one takes them away. Nothing is ever written back into the notes folder.
//
// It runs from the indexer's slow tick, only while the user's agents are connected and the "include Claude
// Code's saved notes" switch is on (a pass with either off touches nothing: not a folder, not a file).
//
// The bookkeeping is a manifest, `claude-notes-manifest.json`, kept on this computer only: for each note
// its size, time and content hash, and the id, store hash and text hash of each chunk stored for it. It is
// what makes a pass incremental (an unchanged note is not even opened), and it is written atomically, so a
// kill leaves the old manifest or the new one, never half of one.
//
// WHY the store hashes carry a salt and an epoch. Deleting a memory also retires its content hash for good:
// the store drops any later entry with that hash when it reloads. A note edited back to an earlier wording,
// or removed and imported again, would then be stored, looked fine, and vanish at the next restart. So a
// chunk's hash is taken over a per-manifest salt and an epoch counter, and the epoch moves on before
// anything is deleted: nothing written afterwards can equal a hash that was retired.
//
// WHY removals are written ahead. A pass that is killed between "delete from the store" and "record that
// in the manifest" would leave a manifest claiming chunks that are gone: a note that looks imported and is
// not. So the ids are first moved to the manifest's `stale` list and saved, then deleted, then taken off
// the list. A `dirty` flag, set before the first change and cleared when a pass completes, tells the next
// pass that something may have been left half done; it then sweeps the store for notes the manifest cannot
// account for (the ones a killed pass wrote before it could record them).

import { createHash, randomBytes } from 'crypto'
import { promises as fsp, readFileSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, relative } from 'path'
import { atomicWriteText } from './agentConfigIO'
import {
  NOTES_SOURCE,
  chunkNote,
  cwdsFromTranscript,
  isClaudeNote,
  noteFields,
  noteTags,
  parseNote,
  projectCwdFor,
  type NoteType,
} from './claudeNotesParse'

export const NOTES_MANIFEST_FILE = 'claude-notes-manifest.json'
/** A note bigger than this is not read: it is not a note, it is a document. */
export const MAX_NOTE_BYTES = 64 * 1024
/** Never track more files than this; a runaway folder would otherwise fill the memory with one project. */
export const MAX_NOTE_FILES = 2000
/** Chunks stored per pass. A first import of hundreds of notes drains over a few passes, not one long one. */
export const DEFAULT_MAX_CHUNKS = 300

const TRANSCRIPT_HEAD_BYTES = 256 * 1024
const TRANSCRIPTS_TRIED = 3
const MAX_TRANSCRIPTS_STATTED = 5000
const BINARY_SNIFF_BYTES = 8192
/** The manifest is saved after this many notes, not after each: a kill then costs at most this many notes' ids. */
const CHECKPOINT_EVERY = 20
const LIST_PAGE = 500

/**
 * THE ONE PLACE the folders to read come from: Claude Code's projects folder, or a test run's scratch home
 * (TERMPOLIS_TEST_AGENT_HOME, which every reader of agent folders honours so no test reads the real one).
 *
 * Once fix/accounts154 merges, this body becomes `return walkRoots(transcriptRoots('claude'))`
 * (conversationIngest.ts): every sign-in profile's projects folder, each real folder once. This is the only
 * line to change; nothing else here assumes a single root.
 */
export async function noteRoots(): Promise<string[]> {
  const home = process.env.TERMPOLIS_TEST_AGENT_HOME?.trim() || homedir()
  return [join(home, '.claude', 'projects')]
}

// ---- The filesystem, as this pass sees it ----

export interface NotesDirEntry {
  name: string
  /** A link is reported as a link and never followed here: where it leads is asked with `real`. */
  kind: 'file' | 'dir' | 'link' | 'other'
}

export interface NotesFs {
  /** The entries of a folder; null when it cannot be read. */
  list(dir: string): Promise<NotesDirEntry[] | null>
  /** A file's size and modified time; null when it is gone or is not a file. */
  stat(file: string): Promise<{ size: number; mtimeMs: number } | null>
  /** Where a path really is, links resolved; null when there is nothing there. */
  real(path: string): Promise<string | null>
  /** The first `maxBytes` of a file; null when it cannot be read. */
  read(file: string, maxBytes: number): Promise<Buffer | null>
}

export const realNotesFs: NotesFs = {
  async list(dir) {
    try {
      return (await fsp.readdir(dir, { withFileTypes: true })).map((e) => ({
        name: e.name,
        kind: e.isSymbolicLink() ? 'link' : e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
      }))
    } catch {
      return null
    }
  },
  async stat(file) {
    try {
      const s = await fsp.stat(file)
      return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null
    } catch {
      return null
    }
  },
  async real(path) {
    try {
      return await fsp.realpath(path)
    } catch {
      return null
    }
  },
  async read(file, maxBytes) {
    let handle: Awaited<ReturnType<typeof fsp.open>> | undefined
    try {
      handle = await fsp.open(file, 'r')
      const buf = Buffer.alloc(maxBytes)
      const { bytesRead } = await handle.read(buf, 0, maxBytes, 0)
      return buf.subarray(0, bytesRead)
    } catch {
      return null
    } finally {
      // A handle that will not close is not a failed read: the bytes are already in hand.
      try { await handle?.close() } catch { /* nothing to be done about it */ }
    }
  },
}

// ---- Finding the notes ----

export interface FoundNote {
  /** `<project folder>/<file>`: the note's identity everywhere below. */
  key: string
  folder: string
  fileName: string
  path: string
  /** The project folder, where its sessions are. */
  folderDir: string
  size: number
  mtimeMs: number
}

export interface FoundNotes {
  notes: FoundNote[]
  /** Project folders whose notes folder was listed, so a note missing from them is really gone. */
  listed: Set<string>
  /** Every project folder seen under a root that could be read. */
  folders: Set<string>
  /** Notes that exist but whose size could not be read this time: neither new nor gone. */
  uncertain: Set<string>
  rootsRead: number
  skipped: { oversize: number; empty: number; links: number; capped: number; duplicate: number }
}

/** Is `p` somewhere inside `root` (not `root` itself, and not above it)? A folder merely named `..x` is inside. */
function within(root: string, p: string): boolean {
  const rel = relative(root, p)
  return rel !== '' && !/^\.\.(?:[\\/]|$)/.test(rel) && !isAbsolute(rel)
}

const byName = (a: NotesDirEntry, b: NotesDirEntry): number => a.name.localeCompare(b.name)

/**
 * Every importable note under the roots: `<root>/<folder>/memory/*.md`, not MEMORY.md (an index of the
 * others), not empty, not over 64 KB, not a link that leaves the projects folder, at most `maxFiles` of
 * them. What was left out is counted, so Settings can say so.
 */
export async function findNotes(roots: readonly string[], fs: NotesFs, opts: { maxFiles?: number; imported?: ReadonlySet<string> } = {}): Promise<FoundNotes> {
  const maxFiles = opts.maxFiles ?? MAX_NOTE_FILES
  const out: FoundNotes = {
    notes: [], listed: new Set(), folders: new Set(), uncertain: new Set(), rootsRead: 0,
    skipped: { oversize: 0, empty: 0, links: 0, capped: 0, duplicate: 0 },
  }
  const keys = new Set<string>()
  const readRoots = new Set<string>()
  for (const root of roots) {
    const rootReal = await fs.real(root)
    if (!rootReal || readRoots.has(rootReal)) continue // not there, or the same folder reached another way
    const projects = await fs.list(root)
    if (!projects) continue
    readRoots.add(rootReal)
    out.rootsRead++
    for (const project of projects.slice().sort(byName)) {
      if (project.kind !== 'dir' && project.kind !== 'link') continue
      out.folders.add(project.name)
      const folderDir = join(root, project.name)
      const memoryDir = join(folderDir, 'memory')
      const memoryReal = await fs.real(memoryDir)
      if (!memoryReal) {
        // Nothing at the notes folder's path. Deleting a project's notes means deleting this folder, with the project and its
        // sessions left in place, so when the project folder reads fine and holds no entry called memory the notes are gone and
        // whatever was imported from here goes with them. Anything short of that is unknown, not empty: a project folder that
        // cannot be listed, or an entry that is there and cannot be resolved (a dangling link, a drive not mounted). Only a
        // folder that has had notes imported is looked into: for any other there is nothing to take out, and nothing is read.
        if (opts.imported?.has(project.name)) {
          const around = await fs.list(folderDir)
          if (around && !around.some((e) => e.name.toLowerCase() === 'memory')) out.listed.add(project.name)
        }
        continue
      }
      if (!within(rootReal, memoryReal)) { out.skipped.links++; continue } // a notes folder that is a link out
      const files = await fs.list(memoryDir)
      if (!files) continue
      out.listed.add(project.name)
      for (const file of files.slice().sort(byName)) {
        if (!/\.md$/i.test(file.name) || /^memory\.md$/i.test(file.name)) continue
        if (file.kind !== 'file' && file.kind !== 'link') continue
        const path = join(memoryDir, file.name)
        const key = `${project.name}/${file.name}`
        if (file.kind === 'link') {
          const target = await fs.real(path)
          if (!target || !within(rootReal, target)) { out.skipped.links++; continue }
        }
        const st = await fs.stat(path)
        if (!st) { out.uncertain.add(key); continue }
        if (st.size > MAX_NOTE_BYTES) { out.skipped.oversize++; continue }
        if (st.size === 0) { out.skipped.empty++; continue }
        if (keys.has(key)) { out.skipped.duplicate++; continue }
        if (out.notes.length >= maxFiles) { out.skipped.capped++; continue }
        keys.add(key)
        out.notes.push({ key, folder: project.name, fileName: file.name, path, folderDir, size: st.size, mtimeMs: st.mtimeMs })
      }
    }
  }
  return out
}

/**
 * The working directory a project folder stands for, from the start of its newest few sessions. Looked at
 * only for a folder not yet known: the answer is kept in the manifest.
 */
export async function findProject(fs: NotesFs, folder: string, dir: string, opts: { maxStat?: number } = {}): Promise<string | null> {
  const maxStat = opts.maxStat ?? MAX_TRANSCRIPTS_STATTED
  const dated: Array<{ path: string; mtimeMs: number }> = []
  for (const e of (await fs.list(dir)) ?? []) {
    if (dated.length >= maxStat) break
    if (e.kind !== 'file' || !/\.jsonl$/i.test(e.name)) continue
    const path = join(dir, e.name)
    const st = await fs.stat(path)
    if (st) dated.push({ path, mtimeMs: st.mtimeMs })
  }
  dated.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const session of dated.slice(0, TRANSCRIPTS_TRIED)) {
    const head = await fs.read(session.path, TRANSCRIPT_HEAD_BYTES)
    if (!head) continue
    const cwd = projectCwdFor(folder, cwdsFromTranscript(head.toString('utf8')))
    if (cwd) return cwd
  }
  return null
}

// ---- The manifest ----

interface ManifestChunk { id: string; hash: string; th: string }
interface ManifestFile {
  /** Of the version of the note the chunks were built from; -1 while the note is only partly stored. */
  mtimeMs: number
  size: number
  sha: string
  project: string
  chunks: ManifestChunk[]
}
interface ManifestLast { at: number; filesSeen: number; noProject: number; secretsRedacted: number }
interface Manifest {
  version: 1
  salt: string
  epoch: number
  dirty: boolean
  files: Record<string, ManifestFile>
  stale: string[]
  cwds: Record<string, string>
  last: ManifestLast | null
}

export interface NotesManifestIO {
  /** The saved text, or null when there is none. */
  read(): string | null
  /** Replace the saved text, atomically. Throws when it cannot. */
  write(text: string): void
}

export function fileManifest(dir: string): NotesManifestIO {
  const file = join(dir, NOTES_MANIFEST_FILE)
  return {
    read: () => { try { return readFileSync(file, 'utf8') } catch { return null } },
    write: (text) => atomicWriteText(file, text),
  }
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function freshManifest(): Manifest {
  // dirty: nothing is known about what the store holds, so the first complete pass checks.
  return { version: 1, salt: randomBytes(8).toString('hex'), epoch: 0, dirty: true, files: {}, stale: [], cwds: {}, last: null }
}

function sanitizeFile(v: unknown): ManifestFile | null {
  if (!isRec(v) || !isNum(v.mtimeMs) || !isNum(v.size) || !isStr(v.sha) || !isStr(v.project) || !Array.isArray(v.chunks)) return null
  const chunks: ManifestChunk[] = []
  for (const c of v.chunks) {
    if (!isRec(c) || !isStr(c.id) || !c.id || !isStr(c.hash) || !isStr(c.th)) return null
    chunks.push({ id: c.id, hash: c.hash, th: c.th })
  }
  return { mtimeMs: v.mtimeMs, size: v.size, sha: v.sha, project: v.project, chunks }
}

/** The manifest in `text`, or a fresh one when there is none or it is unusable. A part of it that cannot be
 *  trusted is dropped, never repaired, and the manifest is then marked dirty so the store gets checked. */
function parseManifest(text: string | null): Manifest {
  let raw: unknown
  try { raw = text === null ? null : JSON.parse(text) } catch { raw = null }
  if (!isRec(raw) || raw.version !== 1 || !isStr(raw.salt) || !raw.salt || !isNum(raw.epoch) || raw.epoch < 0 || !isRec(raw.files)) return freshManifest()
  const m: Manifest = {
    version: 1,
    salt: raw.salt,
    epoch: Math.floor(raw.epoch),
    dirty: raw.dirty === true,
    files: {},
    stale: Array.isArray(raw.stale) ? raw.stale.filter((id): id is string => isStr(id) && !!id) : [],
    cwds: {},
    last: null,
  }
  for (const [key, value] of Object.entries(raw.files)) {
    const file = sanitizeFile(value)
    if (file) m.files[key] = file
    else m.dirty = true
  }
  if (isRec(raw.cwds)) for (const [folder, cwd] of Object.entries(raw.cwds)) if (isStr(cwd) && cwd) m.cwds[folder] = cwd
  const last = raw.last
  if (isRec(last) && isNum(last.at) && isNum(last.filesSeen) && isNum(last.noProject) && isNum(last.secretsRedacted)) {
    m.last = { at: last.at, filesSeen: last.filesSeen, noProject: last.noProject, secretsRedacted: last.secretsRedacted }
  }
  return m
}

// ---- The store, as this pass sees it ----

export interface NoteWrite {
  agentId: typeof NOTES_SOURCE
  source: typeof NOTES_SOURCE
  kind: 'fact' | 'decision' | 'note'
  content: string
  tags: string[]
  hash: string
  importance: number
  memoryType: 'summary'
  /** The raw working directory: the store derives the slug and the key from it. */
  project: string
  ts: number
}

export interface StoredNote {
  id: string
  ts: number
  agentId?: string
  source?: string
  /** Which computer wrote it, when the store says (memory sync). */
  origin?: unknown
  tags?: string[]
  /** How many secrets the store redacted out of the text it was given. */
  scrubbed?: number
}

export interface NotesStore {
  write(input: NoteWrite): Promise<StoredNote | null | undefined>
  remove(id: string): Promise<void>
  list(opts: { agentId: string; limit: number; since?: number; before?: number }): Promise<StoredNote[]>
}

const isRow = (r: unknown): r is StoredNote => !!r && typeof r === 'object' && isStr((r as StoredNote).id) && isNum((r as StoredNote).ts)

/** Every entry the store holds under the notes' author, newest first. Entries that share a time and straddle
 *  a page boundary are fetched whole, because the listing's cursor skips the time it was given. */
async function listAll(store: NotesStore): Promise<StoredNote[]> {
  const seen = new Map<string, StoredNote>()
  let before: number | undefined
  for (;;) {
    const raw = await store.list({ agentId: NOTES_SOURCE, limit: LIST_PAGE, ...(before === undefined ? {} : { before }) })
    const page = raw.filter(isRow)
    let added = 0
    for (const r of page) if (!seen.has(r.id)) { seen.set(r.id, r); added++ }
    if (raw.length < LIST_PAGE || added === 0) break
    const oldest = Math.min(...page.map((r) => r.ts))
    for (const r of (await store.list({ agentId: NOTES_SOURCE, limit: LIST_PAGE, since: oldest, before: oldest + 1 })).filter(isRow)) {
      if (!seen.has(r.id)) seen.set(r.id, r)
    }
    before = oldest
  }
  return [...seen.values()]
}

/** Is this row this computer's to remove? Another computer's notes (memory sync) are theirs. */
const ownedBy = (row: StoredNote, own: string | undefined): boolean => own === undefined || typeof row.origin !== 'string' || row.origin === own

/** Rounds of "list what is left, remove what was not tried" one sweep may take: 100 rounds reach 50,000 notes. */
const MAX_SWEEP_ROUNDS = 100

// ---- One pass ----

export interface NotesDeps {
  /** The user's switch ("Include Claude Code's saved notes in memory"). */
  enabled: () => boolean
  /** Whether the user said yes to connecting their agents: the consent every other agent integration is gated on. */
  connected: () => boolean
  roots: () => Promise<readonly string[]>
  fs: NotesFs
  manifest: NotesManifestIO
  store: NotesStore
  now?: () => number
  /** True once the app is quitting: the pass ends there. */
  stopped?: () => boolean
  /** Awaited between writes so a first import cannot freeze the app. Default: a setImmediate. */
  yield?: () => Promise<void>
  /** This computer's id as the store stamps it on entries, when the store does (memory sync). */
  ownOrigin?: () => Promise<string | undefined>
  /** Rounds one sweep of the store may take (MAX_SWEEP_ROUNDS). A seam for tests. */
  sweepRounds?: number
}

export interface NotesStats {
  /** Set when the pass did nothing because the switch is off, or the agents are not connected. */
  idle?: 'off' | 'not-connected'
  rootsRead: number
  filesSeen: number
  filesChanged: number
  filesRemoved: number
  chunksWritten: number
  chunksDeleted: number
  secretsRedacted: number
  /** Notes left alone because no session says which project their folder belongs to. */
  noProject: number
  unreadable: number
  binary: number
  writeFailed: number
  deleteFailed: number
  swept: number
  skipped: FoundNotes['skipped']
  /** Stopped at the per-pass budget, or because the app is quitting: there is more to do. */
  truncated: boolean
  manifestFailed: boolean
}

const emptyStats = (): NotesStats => ({
  rootsRead: 0, filesSeen: 0, filesChanged: 0, filesRemoved: 0, chunksWritten: 0, chunksDeleted: 0, secretsRedacted: 0,
  noProject: 0, unreadable: 0, binary: 0, writeFailed: 0, deleteFailed: 0, swept: 0,
  skipped: { oversize: 0, empty: 0, links: 0, capped: 0, duplicate: 0 },
  truncated: false, manifestFailed: false,
})

const yieldToEventLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
/** Identifies a chunk by what the store will be told about it, so a change to the note's type or project
 *  replaces it even when its words are the same. */
const textHash = (type: NoteType, project: string, text: string): string => sha256(`${type}\u001f${project}\u001f${text}`).slice(0, 16)
const storeHash = (m: Manifest, key: string, th: string): string => sha256([NOTES_SOURCE, m.salt, String(m.epoch), key, th].join('\u001f'))

async function originOf(deps: NotesDeps): Promise<string | undefined> {
  if (!deps.ownOrigin) return undefined
  try { return await deps.ownOrigin() } catch { return undefined }
}

/** Every imported note this computer holds, from the store's own listing. Throws when the store cannot be listed. */
async function ownNotes(deps: NotesDeps): Promise<StoredNote[]> {
  const own = await originOf(deps)
  return (await listAll(deps.store)).filter((r) => isClaudeNote(r) && ownedBy(r, own))
}

/** Passes and removals take turns: a removal in the middle of a pass would delete what it is about to record. */
let chain: Promise<unknown> = Promise.resolve()
function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job)
  chain = run.then(() => undefined, () => undefined)
  return run
}

/** @internal a test that abandons a pass (to stand in for a kill) must not leave the next one waiting for it. */
export function _resetNotesLockForTests(): void {
  chain = Promise.resolve()
}

/** The manifest and the store, kept consistent through the steps that matter. */
class Ledger {
  private bumped = false
  private began = false
  halted = false

  constructor(readonly deps: NotesDeps, readonly m: Manifest, readonly stats: NotesStats) {}

  /** Save the manifest. A manifest that cannot be saved ends the pass: nothing may change in the store
   *  that the manifest does not know about. */
  save(): boolean {
    try {
      this.deps.manifest.write(JSON.stringify(this.m))
      return true
    } catch {
      this.halted = true
      this.stats.manifestFailed = true
      return false
    }
  }

  /** Called before the first change to the store: flags the manifest, so a kill leaves something to find. */
  begin(): boolean {
    if (this.began) return !this.halted
    this.began = true
    this.m.dirty = true
    return this.save()
  }

  /** Move the epoch on, once per pass, before anything is deleted. */
  bump(): void {
    if (this.bumped) return
    this.m.epoch++
    this.bumped = true
  }

  /** Remove these ids from the store. Written ahead: they are on the manifest's `stale` list, saved, before
   *  the first is deleted, and come off it one by one as each goes. False when the manifest could not be saved. */
  async retire(ids: string[], counter: 'chunksDeleted' | 'swept' = 'chunksDeleted'): Promise<boolean> {
    if (ids.length === 0) return true
    if (!this.begin()) return false
    this.bump()
    for (const id of ids) {
      if (this.m.stale.includes(id)) continue // already queued (a killed pass wrote it ahead)
      this.m.stale.push(id)
    }
    if (!this.save()) return false
    for (const id of ids) {
      try {
        await this.deps.store.remove(id)
        this.stats[counter]++
        this.m.stale = this.m.stale.filter((s) => s !== id)
      } catch {
        this.stats.deleteFailed++
      }
    }
    return true
  }
}

/**
 * Remove every note of this computer's that the store holds and `tried` does not already cover, and look again. One listing
 * cannot reach past LIST_PAGE entries that share a single time (notes copied or extracted in one go all carry the same modified
 * time, and the store orders equal times by when they were stored, so there is no cursor between them), so what a listing did not
 * show appears in the next one once the first are gone. It ends when a listing shows nothing that was not tried. `tried` grows
 * with every id removed here, so a note whose removal fails is not asked for again.
 *
 * True when the store was seen whole and everything found was removed: the caller may then call it settled. False when the store
 * could not be listed, the manifest could not be saved, a removal failed, or the rounds ran out with notes still turning up.
 */
async function sweepOwnNotes(deps: NotesDeps, ledger: Ledger, tried: Set<string>, counter: 'chunksDeleted' | 'swept'): Promise<boolean> {
  let clean = true
  const rounds = deps.sweepRounds ?? MAX_SWEEP_ROUNDS
  for (let round = 0; round < rounds; round++) {
    let fresh: string[]
    try {
      fresh = (await ownNotes(deps)).map((r) => r.id).filter((id) => !tried.has(id))
    } catch {
      return false // the store could not be listed: check again next time
    }
    if (fresh.length === 0) return clean
    for (const id of fresh) tried.add(id)
    if (!(await ledger.retire(fresh, counter))) return false
    if (fresh.some((id) => ledger.m.stale.includes(id))) clean = false // a removal failed; it waits on the manifest's list
  }
  return false // the rounds ran out with notes still turning up
}

export interface PassOptions {
  maxChunks?: number
  maxFiles?: number
  checkpointEvery?: number
}

export function runClaudeNotesIngest(deps: NotesDeps, opts: PassOptions = {}): Promise<NotesStats> {
  return exclusive(() => pass(deps, opts))
}

async function pass(deps: NotesDeps, opts: PassOptions): Promise<NotesStats> {
  const stats = emptyStats()
  // Consent first, and before anything else is touched: a pass that is off reads nothing.
  if (!deps.enabled()) { stats.idle = 'off'; return stats }
  if (!deps.connected()) { stats.idle = 'not-connected'; return stats }
  const now = deps.now ?? Date.now
  const pause = deps.yield ?? yieldToEventLoop
  const budget = opts.maxChunks ?? DEFAULT_MAX_CHUNKS
  const checkpointEvery = opts.checkpointEvery ?? CHECKPOINT_EVERY

  const roots = await deps.roots()
  const m = parseManifest(deps.manifest.read())
  const sweepDue = m.dirty
  const ledger = new Ledger(deps, m, stats)
  const imported = new Set(Object.keys(m.files).map((key) => key.slice(0, key.indexOf('/')))) // the project folders notes were taken from
  const found = await findNotes(roots, deps.fs, { maxFiles: opts.maxFiles, imported })
  Object.assign(stats.skipped, found.skipped)
  stats.rootsRead = found.rootsRead
  stats.filesSeen = found.notes.length

  // 1. Removals a killed pass had written ahead. The epoch moves on first, so what is stored again below
  //    cannot carry a hash that these deletions retire.
  if (m.stale.length > 0) await ledger.retire([...m.stale])

  // 2. Notes that are gone. Only when the listing can be trusted: a root that did not read, one with no
  //    project folders in it, or a listing cut at the cap says nothing about what is missing.
  if (found.rootsRead > 0 && found.folders.size > 0 && found.skipped.capped === 0 && !ledger.halted) {
    const present = new Set(found.notes.map((n) => n.key))
    for (const key of Object.keys(m.files)) {
      if (present.has(key) || found.uncertain.has(key)) continue
      const folder = key.slice(0, key.indexOf('/'))
      // A notes folder that exists but could not be listed is unknown, not empty.
      if (found.folders.has(folder) && !found.listed.has(folder)) continue
      if (!(await ledger.retire(m.files[key].chunks.map((c) => c.id)))) break
      delete m.files[key]
      stats.filesRemoved++
    }
  }

  // 3. New and edited notes, newest first.
  const noProject = new Set<string>()
  const projectOf = async (n: FoundNote): Promise<string | null> => {
    const known = m.cwds[n.folder]
    if (known) return known
    if (noProject.has(n.folder)) return null
    const cwd = await findProject(deps.fs, n.folder, n.folderDir)
    if (cwd) m.cwds[n.folder] = cwd
    else noProject.add(n.folder)
    return cwd
  }
  let writes = 0
  let sinceSave = 0
  let incomplete = false
  const queue = found.notes.slice().sort((a, b) => b.mtimeMs - a.mtimeMs || a.key.localeCompare(b.key))
  for (const f of queue) {
    if (ledger.halted) break // a checkpoint could not be saved
    if (deps.stopped?.()) { stats.truncated = true; incomplete = true; break }
    if (!deps.enabled()) { incomplete = true; break } // turned off mid-pass: stop, with nothing queued
    const prev = m.files[f.key]
    if (prev && prev.mtimeMs === f.mtimeMs && prev.size === f.size) continue // unchanged: not even opened

    const buf = await deps.fs.read(f.path, MAX_NOTE_BYTES + 1)
    if (!buf) { stats.unreadable++; continue }
    if (buf.length > MAX_NOTE_BYTES) { stats.skipped.oversize++; continue } // grew since it was listed
    const binary = buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)
    if (binary) stats.binary++
    const text = binary ? '' : buf.toString('utf8')
    const sha = binary ? '' : sha256(text)
    if (prev && !binary && prev.sha === sha) { // touched, not changed
      prev.mtimeMs = f.mtimeMs
      prev.size = f.size
      if (++sinceSave >= checkpointEvery) { sinceSave = 0; ledger.save() }
      continue
    }

    const parsed = binary ? null : parseNote(text, f.fileName)
    const texts = parsed ? chunkNote(parsed) : []
    let project = prev?.project ?? ''
    if (texts.length > 0) {
      const cwd = await projectOf(f)
      if (!cwd) { stats.noProject++; continue }
      project = cwd
    }
    const type: NoteType = parsed?.type ?? 'untyped'
    const ths = texts.map((t) => textHash(type, project, t))
    const want = new Set(ths)
    const old = prev?.chunks ?? []
    const have = new Set(old.map((c) => c.th))
    // The entry stands as "partly stored" until every chunk is in: a pass cut short, or a write that fails,
    // leaves a note the next pass picks up where this one stopped.
    const entry: ManifestFile = { mtimeMs: -1, size: -1, sha: '', project, chunks: old.filter((c) => want.has(c.th)) }
    m.files[f.key] = entry
    if (!(await ledger.retire(old.filter((c) => !want.has(c.th)).map((c) => c.id)))) break

    if (ths.some((th) => !have.has(th)) && !ledger.begin()) break
    const fields = noteFields(type)
    const tags = parsed ? noteTags(type, f.fileName) : []
    for (let i = 0; i < texts.length; i++) {
      if (have.has(ths[i])) continue
      if (writes >= budget) { stats.truncated = true; incomplete = true; break }
      const hash = storeHash(m, f.key, ths[i])
      let stored: StoredNote | null | undefined
      try {
        stored = await deps.store.write({
          agentId: NOTES_SOURCE, source: NOTES_SOURCE, kind: fields.kind, content: texts[i], tags: [...tags], hash,
          importance: fields.importance, memoryType: 'summary', project, ts: f.mtimeMs,
        })
      } catch { stored = null }
      if (!stored || !isStr(stored.id) || !stored.id) { stats.writeFailed++; incomplete = true; break }
      writes++
      stats.chunksWritten++
      if (stored.scrubbed) stats.secretsRedacted += stored.scrubbed
      entry.chunks.push({ id: stored.id, hash, th: ths[i] })
      await pause()
    }
    if (incomplete) break
    entry.mtimeMs = f.mtimeMs
    entry.size = f.size
    entry.sha = sha
    stats.filesChanged++
    if (++sinceSave >= checkpointEvery) { sinceSave = 0; ledger.save() }
  }

  // 4. A pass that ran to the end settles what an earlier, interrupted one may have left.
  const complete = !ledger.halted && !incomplete
  let settled = true
  if (complete && sweepDue) {
    const keep = new Set<string>(m.stale)
    for (const file of Object.values(m.files)) for (const c of file.chunks) keep.add(c.id)
    settled = await sweepOwnNotes(deps, ledger, keep, 'swept')
  }
  if (complete && settled) m.dirty = false

  m.last = { at: now(), filesSeen: stats.filesSeen, noProject: stats.noProject, secretsRedacted: (m.last?.secretsRedacted ?? 0) + stats.secretsRedacted }
  ledger.save()
  return stats
}

// ---- Removing everything this module imported ----

export interface RemoveResult {
  removed: number
  /** Not removed (memory locked, say); they stay on the manifest's list, and another try finishes them. */
  failed: number
}

/**
 * "Remove imported notes": every note this computer imported leaves memory, including any the manifest
 * had lost track of, and the manifest starts over (its epoch moves on, so a later re-import cannot reuse a
 * retired hash). Another computer's notes (memory sync) are left alone. The caller turns the switch off, or
 * the next pass would bring them back.
 */
export function removeImportedNotes(deps: NotesDeps): Promise<RemoveResult> {
  return exclusive(async () => {
    const m = parseManifest(deps.manifest.read())
    const ids = new Set<string>(m.stale)
    for (const file of Object.values(m.files)) for (const c of file.chunks) ids.add(c.id)
    let listed = true
    try {
      for (const r of await ownNotes(deps)) ids.add(r.id)
    } catch {
      listed = false
    }
    m.files = {}
    m.last = null
    const stats = emptyStats()
    const ledger = new Ledger(deps, m, stats)
    const wroteAhead = await ledger.retire([...ids])
    // One listing cannot reach past 500 notes that share a time, so look again until it shows nothing that was not tried.
    const swept = listed && wroteAhead && (await sweepOwnNotes(deps, ledger, new Set(ids), 'chunksDeleted'))
    // Not clean until every id is gone and the store was seen whole; the next pass then checks.
    m.dirty = !swept || m.stale.length > 0
    ledger.save()
    return { removed: stats.chunksDeleted, failed: wroteAhead ? stats.deleteFailed : ids.size }
  })
}

/**
 * Finish the removals an earlier one left queued. "Remove imported notes" turns the switch off first, so when memory is
 * locked every removal fails and waits on the manifest's `stale` list, and the panel says they will be retried; a pass with
 * the switch off reads nothing, so it retries nothing. This does, from the tick. It reads no folder and no note, only this
 * computer's own record and the store, and does nothing (not even a write) when nothing is queued.
 */
export function finishQueuedRemovals(deps: NotesDeps): Promise<RemoveResult> {
  return exclusive(async () => {
    const m = parseManifest(deps.manifest.read())
    if (m.stale.length === 0) return { removed: 0, failed: 0 }
    const queued = m.stale.length
    const stats = emptyStats()
    const ledger = new Ledger(deps, m, stats)
    const wroteAhead = await ledger.retire([...m.stale])
    ledger.save()
    return { removed: stats.chunksDeleted, failed: wroteAhead ? stats.deleteFailed : queued }
  })
}

/**
 * "Clear memory" empties the store, imported notes with the rest. This runs `clear` and then empties the record of what was
 * imported (every note's chunks, and the removals waiting), so Settings stops saying that notes are in memory. It keeps what it
 * saw of each note (size, time, hash): an unchanged note is not opened again, so clearing memory is not undone at the next pass,
 * and a note that is edited afterwards is imported afresh like any other change. `clear` runs inside the same turn-taking as the
 * passes, so none is writing notes while it goes through, and the record is touched only once it has. A record that cannot be
 * saved does not undo the clear, which has already happened: it only leaves the old count on screen.
 */
export function clearNotesRecord(deps: Pick<NotesDeps, 'manifest'>, clear: () => Promise<unknown>): Promise<void> {
  return exclusive(async () => {
    await clear()
    try {
      const m = parseManifest(deps.manifest.read())
      for (const file of Object.values(m.files)) file.chunks = []
      m.stale = []
      m.dirty = false
      if (m.last) m.last = { ...m.last, secretsRedacted: 0 }
      deps.manifest.write(JSON.stringify(m))
    } catch { /* the clear stands; only the count shown in Settings is out of date */ }
  })
}

// ---- What Settings shows ----

export interface NotesStatus {
  notes: number
  chunks: number
  projects: number
  lastAt: number | null
  noProject: number
  secretsRedacted: number
  /** Removals waiting to be retried. */
  pending: number
}

export function notesStatus(io: NotesManifestIO): NotesStatus {
  const m = parseManifest(io.read())
  const projects = new Set<string>()
  let notes = 0
  let chunks = 0
  for (const file of Object.values(m.files)) {
    if (file.chunks.length === 0) continue
    notes++
    chunks += file.chunks.length
    projects.add(file.project)
  }
  return {
    notes, chunks, projects: projects.size,
    lastAt: m.last?.at ?? null, noProject: m.last?.noProject ?? 0, secretsRedacted: m.last?.secretsRedacted ?? 0,
    pending: m.stale.length,
  }
}
