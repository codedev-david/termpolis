// Lumopolis labelling context: the extra evidence a building's labels may cite beyond its own files.
// Recent commit subjects, lines of the project's markdown docs that name a member, and the memory
// brain's decisions about the building. Main-side (git, docs and the brain live here); the host
// asks for it over the world client. Async fs only, every read capped; any failure is just "no
// evidence", never an error, so labelling still runs from file excerpts alone.
import { promises as fsp } from 'node:fs'
import type { Evidence } from '../../shared/world/types'

export const MAX_COMMITS = 5
export const MAX_DOC_HITS = 3
export const MAX_MEMORIES = 3
export const MAX_DOC_FILES = 200
export const MAX_DOC_BYTES = 64 * 1024
export const MAX_SCAN_DIRS = 2000
export const MAX_LINE_CHARS = 300
export const MAX_MEMORY_CHARS = 600
export const CONTEXT_TIMEOUT_MS = 8000
export const GIT_TIMEOUT_MS = 5000
const DOC_CACHE_MS = 30_000
const COMMIT_MEMBERS = 3
const MAX_NAMES = 20
const MIN_NAME = 4

const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', 'coverage', 'release', '.next', '.cache', '.venv', 'vendor'])
const GENERIC = new Set(['index', 'main', 'utils', 'types', 'test', 'tests', 'readme'])

export interface DirEntry { name: string; dir: boolean }
export interface MemoryHit { id: string; text: string }
interface Doc { path: string; lines: string[] }

export interface LabelContextDeps {
  /** Runs git with these arguments in `cwd` (main's safeGitAsync, a short timeout). */
  git: (args: string[], cwd: string) => Promise<string>
  /** The memory brain's top decisions for a query in the project at `root`; none when the brain is unavailable. */
  memory: (query: string, root: string) => Promise<MemoryHit[]>
  /** Real directory entries only (a link is neither a file nor a directory). Default: fs.promises. */
  readDir?: (dir: string) => Promise<DirEntry[]>
  /** The first `maxBytes` of a file, or null. Default: fs.promises. */
  readHead?: (file: string, maxBytes: number) => Promise<string | null>
  now?: () => number
  timeoutMs?: number
}

/** Adapts the brain's search to the label context: top decisions of one project only (never another project's notes). */
export function memoryForLabels(
  search: (opts: { query: string; limit: number; kind: 'decision'; project: string }) => Promise<{ id: string; content: string }[]>
): LabelContextDeps['memory'] {
  return async (query, root) => {
    const rows = await search({ query, limit: 3, kind: 'decision', project: root })
    return rows.map((r) => ({ id: r.id, text: r.content }))
  }
}

export async function fsReadDir(dir: string): Promise<DirEntry[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  return entries.filter((e) => e.isDirectory() || e.isFile()).map((e) => ({ name: e.name, dir: e.isDirectory() }))
}

export async function fsReadHead(file: string, maxBytes: number): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof fsp.open>> | null = null
  try {
    fh = await fsp.open(file, 'r')
    const buf = Buffer.alloc(maxBytes)
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } catch {
    return null
  } finally {
    await fh?.close()
  }
}

function baseNoExt(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(0, i) : base
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The name a building is searched by in memory: its folder when the members share one, else its first file's name. */
export function codeNameOf(members: string[]): string {
  const dirs = members.map((m) => m.split('/').slice(0, -1))
  const first = dirs[0]
  let n = first.length
  for (const d of dirs) {
    let i = 0
    while (i < n && d[i] === first[i]) i++
    n = i
  }
  return n > 0 ? first[n - 1] : baseNoExt(members[0])
}

export function createLabelContext(deps: LabelContextDeps): (root: string, members: string[]) => Promise<Evidence[]> {
  const readDir = deps.readDir ?? fsReadDir
  const readHead = deps.readHead ?? fsReadHead
  const now = deps.now ?? Date.now
  const timeoutMs = deps.timeoutMs ?? CONTEXT_TIMEOUT_MS
  const docCache = new Map<string, { at: number; docs: Promise<Doc[]> }>()

  async function scanDocs(root: string): Promise<Doc[]> {
    const docs: Doc[] = []
    const queue = ['']
    let visited = 0
    while (queue.length > 0 && docs.length < MAX_DOC_FILES && visited < MAX_SCAN_DIRS) {
      const rel = queue.shift() as string
      visited++
      let entries: DirEntry[]
      try {
        entries = await readDir(rel === '' ? root : `${root}/${rel}`)
      } catch {
        continue
      }
      entries.sort((a, z) => a.name.localeCompare(z.name))
      for (const e of entries) {
        const path = rel === '' ? e.name : `${rel}/${e.name}`
        if (e.dir) {
          if (!SKIP_DIRS.has(e.name)) queue.push(path)
        } else if (e.name.endsWith('.md') && docs.length < MAX_DOC_FILES) {
          const text = await readHead(`${root}/${path}`, MAX_DOC_BYTES)
          if (text !== null) docs.push({ path, lines: text.split(/\r?\n/) })
        }
      }
    }
    return docs
  }

  function docsFor(root: string): Promise<Doc[]> {
    const hit = docCache.get(root)
    if (hit && now() - hit.at < DOC_CACHE_MS) return hit.docs
    const docs = scanDocs(root)
    docCache.set(root, { at: now(), docs })
    return docs
  }

  async function commits(root: string, members: string[]): Promise<Evidence[]> {
    try {
      const out = await deps.git(['log', '-n', String(MAX_COMMITS), '--format=%h%x09%s', '--', ...members.slice(0, COMMIT_MEMBERS)], root)
      const found: Evidence[] = []
      for (const line of out.split('\n')) {
        const tab = line.indexOf('\t')
        const subject = line.slice(tab + 1).trim()
        if (tab > 0 && subject !== '') found.push({ kind: 'commit', ref: line.slice(0, tab).slice(0, 7), excerpt: subject })
      }
      return found.slice(0, MAX_COMMITS)
    } catch {
      return []
    }
  }

  async function docLines(root: string, members: string[]): Promise<Evidence[]> {
    try {
      const names = [...new Set(members.map(baseNoExt))].filter((n) => n.length >= MIN_NAME && !GENERIC.has(n.toLowerCase())).slice(0, MAX_NAMES)
      if (names.length === 0) return []
      const re = new RegExp(`(?<![\\w])(?:${names.map(escapeRe).join('|')})(?![\\w])`)
      const found: Evidence[] = []
      for (const doc of await docsFor(root)) {
        const i = doc.lines.findIndex((l) => re.test(l))
        if (i >= 0) found.push({ kind: 'file', ref: `${doc.path}:${i + 1}`, excerpt: doc.lines[i].trim().slice(0, MAX_LINE_CHARS) })
        if (found.length === MAX_DOC_HITS) break
      }
      return found
    } catch {
      return []
    }
  }

  async function decisions(root: string, members: string[]): Promise<Evidence[]> {
    try {
      const hits = await deps.memory(codeNameOf(members), root)
      return hits
        .slice(0, MAX_MEMORIES)
        .map((h): Evidence => ({ kind: 'memory', ref: h.id, excerpt: h.text.trim().slice(0, MAX_MEMORY_CHARS) }))
        .filter((e) => e.excerpt !== '')
    } catch {
      return []
    }
  }

  return async (root, members) => {
    if (members.length === 0) return []
    let timer: ReturnType<typeof setTimeout> | undefined
    const gather = Promise.all([commits(root, members), docLines(root, members), decisions(root, members)]).then((p) => p.flat())
    const limit = new Promise<Evidence[]>((resolve) => {
      timer = setTimeout(() => resolve([]), timeoutMs)
    })
    try {
      return await Promise.race([gather, limit])
    } finally {
      clearTimeout(timer)
    }
  }
}
