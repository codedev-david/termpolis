// Lumopolis world sources registry: the list of worlds the user can open (a project, a folder, a
// cloned git repository or an agent-drafted design). One JSON file at `<dir>/world/sources.json`,
// written atomically (unique temp file, then rename; a rename Windows refuses for a moment because the
// file is being read is tried again). A file that fails to parse or validate is
// moved aside to `.bad` and read as an empty list. `missing` is computed on every read, never stored.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { graphKeyForRoot } from '../codeGraph'
import { worldFileName } from './worldStore'
import { renameWithRetry } from './gitSource'
import { stripUrlUserinfo } from '../../shared/world/gitUrl'
import type { WorldEntry, WorldSource } from '../../shared/world/types'
import type { RepoLogin } from '../../shared/world/repoAccess'

export type { WorldEntry, WorldSource }

export interface SourceRegistryDeps {
  exists(p: string): Promise<boolean>
  now(): number
  /** Waits between rename tries; a timer when not given. */
  sleep?: (ms: number) => Promise<void>
}

export interface SourceRegistry {
  list(): Promise<WorldEntry[]>
  upsert(s: WorldSource, title?: string): Promise<WorldEntry>
  remove(key: string): Promise<void>
  /** Marks a registered world opened now (its lastOpened); null when the key is not registered. */
  touch(key: string): Promise<WorldEntry | null>
  /** Remembers how a cloned repository was opened, changing nothing else (its place in the recent list
   *  stays); null when the key is not a registered git world. */
  setLogin(key: string, login: RepoLogin): Promise<WorldEntry | null>
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
      // `login` is only how it was opened (never a token). Like any other unknown field it never fails the
      // entry: loginRead reads an unknown value as 'token', so it is never updated without asking.
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

/** A git entry's `login` as this build reads it: 'machine' or 'token' as stored, absent stays absent, and
 *  anything else (a newer build's value) is the conservative 'token'. Applied only to what is returned. */
function loginRead(e: WorldEntry): WorldEntry {
  if (e.source.kind !== 'git') return e
  const login: unknown = e.source.login
  return login === undefined || login === 'machine' || login === 'token' ? e : { ...e, source: { ...e.source, login: 'token' } }
}

/** The source as it may be stored or shown: a git URL never keeps the user-info it was cloned with. */
function withoutUserinfo(s: WorldSource): WorldSource {
  return s.kind === 'git' ? { ...s, url: stripUrlUserinfo(s.url) } : s
}

/** A readable default title: the folder name, the repository name, or the design's own title. */
function defaultTitle(s: WorldSource): string {
  if (s.kind === 'design') return s.title
  const base = s.kind === 'git' ? basename(s.url.replace(/\/+$/, '').replace(/\.git$/, '')) : basename(s.root)
  return base || (s.kind === 'git' ? s.url : s.root)
}

const tmpFor = (target: string): string => `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// On Windows a rename onto a file someone is reading (the recent list reloads as a world opens) fails
// with EPERM for a moment, so a transient refusal is tried again before the write counts as failed.
async function writeAtomic(target: string, text: string, sleep: (ms: number) => Promise<void>): Promise<void> {
  const tmp = tmpFor(target)
  try {
    await writeFile(tmp, text, 'utf8')
    await renameWithRetry(rename, sleep, tmp, target)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

export function createSourceRegistry(dir: string, deps: SourceRegistryDeps): SourceRegistry {
  const folder = join(dir, 'world')
  const file = join(folder, 'sources.json')
  // Writers run one after another so two upserts never lose each other's entry. Reads take their turn on the same
  // chain: on Windows a rename onto a file still open for reading fails (EPERM), so a write never lands while this
  // registry reads the file, and a read sees every write asked before it. The file is small, so the wait is short.
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
    // Entries stay as stored (an unknown login included) so a save never rewrites what a newer build wrote.
    if (Array.isArray(parsed) && parsed.every(validEntry)) return parsed
    await rename(file, `${file}.bad`).catch(() => undefined)
    return []
  }

  async function save(entries: WorldEntry[]): Promise<void> {
    await mkdir(folder, { recursive: true })
    await writeAtomic(file, JSON.stringify(entries), deps.sleep ?? sleepMs)
  }

  async function decorate(e: WorldEntry): Promise<WorldEntry> {
    const target = e.source.kind === 'design' ? join(folder, worldFileName(e.key)) : e.source.root
    // An entry stored before user-info was stripped on the way in is cleaned on the way out.
    const read = loginRead(e)
    const out: WorldEntry = { ...read, source: withoutUserinfo(read.source) }
    if (!(await deps.exists(target))) out.missing = true
    return out
  }

  return {
    async list() {
      const sorted = [...(await serial(load))].sort((a, b) => b.lastOpened - a.lastOpened)
      return Promise.all(sorted.map(decorate))
    },

    upsert(given, title) {
      return serial(async () => {
        const s = withoutUserinfo(given)
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

    touch(key) {
      return serial(async () => {
        const entries = await load()
        const old = entries.find((e) => e.key === key)
        if (!old) return null
        const entry: WorldEntry = { ...old, lastOpened: deps.now() }
        await save([...entries.filter((e) => e.key !== key), entry])
        return decorate(entry)
      })
    },

    setLogin(key, login) {
      return serial(async () => {
        const entries = await load()
        const old = entries.find((e) => e.key === key)
        if (!old || old.source.kind !== 'git') return null
        const entry: WorldEntry = { ...old, source: { ...old.source, login } }
        await save(entries.map((e) => (e.key === key ? entry : e)))
        return decorate(entry)
      })
    },

    async get(key) {
      const e = (await serial(load)).find((x) => x.key === key)
      return e ? decorate(e) : null
    }
  }
}
