// Lumopolis world sources registry: the list of worlds the user can open (a project, a folder, a
// cloned git repository or an agent-drafted design). One JSON file at `<dir>/world/sources.json`,
// written atomically (unique temp file, then rename). A file that fails to parse or validate is
// moved aside to `.bad` and read as an empty list. `missing` is computed on every read, never stored.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { graphKeyForRoot } from '../codeGraph'
import { worldFileName } from './worldStore'

export type WorldSource =
  | { kind: 'project'; root: string; linkedDesign?: string }
  | { kind: 'folder'; root: string; linkedDesign?: string }
  | { kind: 'git'; url: string; ref?: string; root: string; linkedDesign?: string }
  | { kind: 'design'; id: string; title: string; linkedRoot?: string }

export interface WorldEntry {
  key: string
  source: WorldSource
  title: string
  lastOpened: number
  missing?: boolean
}

export interface SourceRegistryDeps {
  exists(p: string): Promise<boolean>
  now(): number
}

export interface SourceRegistry {
  list(): Promise<WorldEntry[]>
  upsert(s: WorldSource, title?: string): Promise<WorldEntry>
  remove(key: string): Promise<void>
  get(key: string): Promise<WorldEntry | null>
}

/** The registry key: the code graph key for anything with a root, `design:<id>` for a design. */
export function keyForSource(s: WorldSource): string {
  return s.kind === 'design' ? `design:${s.id}` : graphKeyForRoot(s.root)
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const optStr = (v: unknown): boolean => v === undefined || isStr(v)

function validSource(s: unknown): s is WorldSource {
  if (typeof s !== 'object' || s === null) return false
  const o = s as Record<string, unknown>
  switch (o.kind) {
    case 'project':
    case 'folder':
      return isStr(o.root) && optStr(o.linkedDesign)
    case 'git':
      return isStr(o.url) && isStr(o.root) && optStr(o.ref) && optStr(o.linkedDesign)
    case 'design':
      return isStr(o.id) && isStr(o.title) && optStr(o.linkedRoot)
    default:
      return false
  }
}

function validEntry(e: unknown): e is WorldEntry {
  if (typeof e !== 'object' || e === null) return false
  const o = e as Record<string, unknown>
  return isStr(o.key) && isStr(o.title) && typeof o.lastOpened === 'number' && validSource(o.source)
}

/** A readable default title: the folder name, the repository name, or the design's own title. */
function defaultTitle(s: WorldSource): string {
  if (s.kind === 'design') return s.title
  const base = s.kind === 'git' ? basename(s.url.replace(/\/+$/, '').replace(/\.git$/, '')) : basename(s.root)
  return base || (s.kind === 'git' ? s.url : s.root)
}

const tmpFor = (target: string): string => `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`

async function writeAtomic(target: string, text: string): Promise<void> {
  const tmp = tmpFor(target)
  try {
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, target)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

export function createSourceRegistry(dir: string, deps: SourceRegistryDeps): SourceRegistry {
  const folder = join(dir, 'world')
  const file = join(folder, 'sources.json')
  // Writers run one after another so two upserts never lose each other's entry.
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn)
    chain = run.catch(() => undefined)
    return run
  }

  async function load(): Promise<WorldEntry[]> {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    if (Array.isArray(parsed) && parsed.every(validEntry)) return parsed
    await rename(file, `${file}.bad`).catch(() => undefined)
    return []
  }

  async function save(entries: WorldEntry[]): Promise<void> {
    await mkdir(folder, { recursive: true })
    await writeAtomic(file, JSON.stringify(entries))
  }

  async function decorate(e: WorldEntry): Promise<WorldEntry> {
    const target = e.source.kind === 'design' ? join(folder, worldFileName(e.key)) : e.source.root
    const out: WorldEntry = { ...e }
    if (!(await deps.exists(target))) out.missing = true
    return out
  }

  return {
    async list() {
      const sorted = [...(await load())].sort((a, b) => b.lastOpened - a.lastOpened)
      return Promise.all(sorted.map(decorate))
    },

    upsert(s, title) {
      return serial(async () => {
        const key = keyForSource(s)
        const entries = await load()
        const old = entries.find((e) => e.key === key)
        let source = s
        if (old && s.kind !== 'design' && old.source.kind !== 'design' && s.linkedDesign === undefined && old.source.linkedDesign !== undefined) {
          source = { ...s, linkedDesign: old.source.linkedDesign }
        }
        const entry: WorldEntry = { key, source, title: title ?? old?.title ?? defaultTitle(s), lastOpened: deps.now() }
        await save([...entries.filter((e) => e.key !== key), entry])
        return decorate(entry)
      })
    },

    remove(key) {
      return serial(async () => {
        const entries = await load()
        if (entries.some((e) => e.key === key)) await save(entries.filter((e) => e.key !== key))
      })
    },

    async get(key) {
      const e = (await load()).find((x) => x.key === key)
      return e ? decorate(e) : null
    }
  }
}
