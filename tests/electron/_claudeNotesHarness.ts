// Shared scaffolding for the Claude Code saved-notes tests: a scratch projects folder and manifest folder
// per test, notes and sessions written into it, an in-memory store, and filesystems that count or fail.
// `root` and `data` are live bindings: they change at every setupWorld(), and every importer sees the new value.
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  NOTES_MANIFEST_FILE,
  _resetNotesLockForTests,
  fileManifest,
  realNotesFs,
  type NoteWrite,
  type NotesDeps,
  type NotesFs,
  type NotesManifestIO,
  type NotesStore,
  type StoredNote,
} from '../../src/main/claudeNotesIngest'
import { encodeProjectFolder } from '../../src/main/claudeNotesParse'

export const CWD = 'C:\\work\\app'
export const FOLDER = encodeProjectFolder(CWD) // C--work-app

export const FEEDBACK = [
  '---',
  'name: widget_cache_rules',
  'description: How the widget cache is invalidated',
  'metadata:',
  '  type: feedback',
  '---',
  '',
  'Invalidate on write, not on a timer.',
].join('\n')

export let root = '' // the projects folder
export let data = '' // where the manifest lives
export const cleanup: string[] = []

export function setupWorld(): void {
  _resetNotesLockForTests()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-root-'))
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-data-'))
  cleanup.push(root, data)
}

export function teardownWorld(): void {
  for (const d of cleanup.splice(0)) fs.rmSync(d, { recursive: true, force: true })
}

/** A scratch folder outside the projects folder, removed with the rest. */
export function tempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  cleanup.push(d)
  return d
}

/** A note on disk; its modified time is set so a test can reason about the age it will be stored with. */
export function note(folder: string, file: string, text: string, mtime = Date.UTC(2026, 8, 1)): string {
  const dir = path.join(root, folder, 'memory')
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, file)
  fs.writeFileSync(p, text)
  fs.utimesSync(p, new Date(mtime), new Date(mtime))
  return p
}

/** A session transcript for the folder, recording where it ran. */
export function session(folder: string, cwd: string, name = 'aaaa.jsonl', mtime?: number): void {
  const dir = path.join(root, folder)
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  fs.writeFileSync(p, `${JSON.stringify({ type: 'summary' })}\n${JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hi' } })}\n`)
  if (mtime) fs.utimesSync(p, new Date(mtime), new Date(mtime))
}

export type FakeStore = NotesStore & {
  rows: Map<string, StoredNote & { content: string }>
  writes: NoteWrite[]
  removed: string[]
  failWrites: (e: Error | null) => void
  failRemoves: (e: Error | null) => void
  failList: (e: Error | null) => void
  lists: unknown[]
}

/** The store as the pass sees it, kept in memory: dedups by hash like the real one, lists newest first. */
export function fakeStore(): FakeStore {
  const rows = new Map<string, StoredNote & { content: string }>()
  const writes: NoteWrite[] = []
  const removed: string[] = []
  const lists: unknown[] = []
  let n = 0
  let writeErr: Error | null = null
  let removeErr: Error | null = null
  let listErr: Error | null = null
  return {
    rows,
    writes,
    removed,
    lists,
    failWrites: (e) => { writeErr = e },
    failRemoves: (e) => { removeErr = e },
    failList: (e) => { listErr = e },
    async write(i) {
      if (writeErr) throw writeErr
      writes.push(i)
      const dup = [...rows.values()].find((r) => (r as { hash?: string }).hash === i.hash)
      if (dup) return dup
      const row = { ...i, id: `m${++n}` }
      rows.set(row.id, row)
      return row
    },
    async remove(id) {
      if (removeErr) throw removeErr
      removed.push(id)
      rows.delete(id)
    },
    async list(o) {
      lists.push(o)
      if (listErr) throw listErr
      return [...rows.values()]
        .filter((r) => r.agentId === o.agentId && (o.since === undefined || r.ts >= o.since) && (o.before === undefined || r.ts < o.before))
        .sort((a, b) => b.ts - a.ts)
        .slice(0, o.limit)
    },
  }
}

export function deps(store: NotesStore, over: Partial<NotesDeps> = {}): NotesDeps {
  return {
    enabled: () => true,
    connected: () => true,
    roots: async () => [root],
    fs: realNotesFs,
    manifest: fileManifest(data),
    store,
    yield: async () => {},
    ...over,
  }
}

export const manifestFile = (): string => path.join(data, NOTES_MANIFEST_FILE)
export const manifestJson = (): any => JSON.parse(fs.readFileSync(manifestFile(), 'utf8'))

/** A filesystem that counts what it is asked, and answers from tables. */
export function spyFs(tables: {
  dirs?: Record<string, Array<{ name: string; kind: 'file' | 'dir' | 'link' | 'other' }> | null>
  stats?: Record<string, { size: number; mtimeMs: number } | null>
  reals?: Record<string, string | null>
  reads?: Record<string, Buffer | null>
} = {}): NotesFs & { calls: { list: string[]; stat: string[]; real: string[]; read: string[] } } {
  const calls = { list: [] as string[], stat: [] as string[], real: [] as string[], read: [] as string[] }
  return {
    calls,
    async list(dir) { calls.list.push(dir); return tables.dirs && dir in tables.dirs ? tables.dirs[dir] : null },
    async stat(file) { calls.stat.push(file); return tables.stats && file in tables.stats ? tables.stats[file] : null },
    async real(p) { calls.real.push(p); return tables.reals && p in tables.reals ? tables.reals[p] : p },
    async read(file) { calls.read.push(file); return tables.reads && file in tables.reads ? tables.reads[file] : null },
  }
}

/** A manifest that saves its first `ok` writes and fails every one after. */
export function flakyManifest(ok: number): NotesManifestIO & { writes: () => number } {
  const real = fileManifest(data)
  let n = 0
  return {
    read: () => real.read(),
    write: (text) => { if (++n > ok) throw new Error('disk full'); real.write(text) },
    writes: () => n,
  }
}
