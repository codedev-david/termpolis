// A submodule's edits on the git dot, the change rail and the status bar, without the submodule's own config running
// anything.
//
// Every guarded status carries `--ignore-submodules=dirty` (gitSafety.ts displayFlags): asking a submodule whether
// its working tree is dirty starts a child git in it, under the submodule's OWN config, whose filter drivers the
// superproject's scan never saw. So the superproject's status no longer says ` M sub` for edits inside `sub`, and the
// signal comes back here instead: each submodule .gitmodules lists, and the index holds as a gitlink, gets a status
// of its own through safeGitAsync (which scans that submodule's filters first, like any read), and a dirty one is
// written back into the superproject's output in the row git itself would have written.
//
// Bounds: one budget a poll over every level, MAX_GIT_PER_POLL git calls in all and MAX_GIT_AT_ONCE at once, nested
// submodules MAX_DEPTH deep, nearest first; a submodule the budget does not reach is reported as modified, never as
// clean. The answer is reused for the git cache's window. A submodule .gitmodules does not list (an embedded repository added
// by hand, which git warns about) is not looked into: finding one would mean listing the whole index every poll.
//
// No Electron imports and no spawns of its own: gitCommand.ts hands it the guarded runner and the file reads.

import { posix } from 'path'
import { gitSubcommand } from './gitSafety'

/** Git calls one poll makes to look into submodules, every level together (each listing and each status counts). */
export const MAX_GIT_PER_POLL = 64
/** Of those, how many run at once. */
export const MAX_GIT_AT_ONCE = 4
/** Submodules inside submodules, this many levels down. */
export const MAX_DEPTH = 3

export type SubmoduleIgnore = 'none' | 'untracked' | 'dirty' | 'all'

export interface SubmoduleEntry {
  /** Root-relative, forward slashes, as .gitmodules and the index write it. */
  path: string
  ignore: SubmoduleIgnore
}

/** Unquotes a git config value: surrounding or embedded `"…"` sections, `\"`, `\\`, `\n`, `\t`, and a `#`/`;`
 *  comment outside quotes ends it. */
function configValue(raw: string): string {
  let out = ''
  let quoted = false
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c === '\\' && i + 1 < raw.length) {
      const n = raw[++i]
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'b' ? '\b' : n
    } else if (c === '"') quoted = !quoted
    else if (!quoted && (c === '#' || c === ';')) break
    else out += c
  }
  return out.trim()
}

/** A path a submodule may sit at: relative, inside the repository, no backslash (git writes forward slashes). */
function safeSubmodulePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\') || /^[A-Za-z]:/.test(p)) return false
  return !p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')
}

/** The submodules a .gitmodules file lists: each `[submodule "…"]` section's `path` and `ignore`. A path that leaves
 *  the repository is dropped. */
export function parseGitmodules(text: string): SubmoduleEntry[] {
  const out: SubmoduleEntry[] = []
  let current: SubmoduleEntry | null = null
  const flush = (): void => {
    if (current !== null && safeSubmodulePath(current.path) && !out.some((e) => e.path === current!.path)) out.push(current)
    current = null
  }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (t.startsWith('[')) {
      flush()
      if (/^\[\s*submodule\s+"/i.test(t)) current = { path: '', ignore: 'none' }
      continue
    }
    if (current === null) continue
    const m = /^([A-Za-z][A-Za-z0-9-]*)\s*=(.*)$/.exec(t)
    if (m === null) continue
    const key = m[1].toLowerCase()
    const value = configValue(m[2])
    if (key === 'path') current.path = value.replace(/\/+$/, '')
    else if (key === 'ignore') {
      const v = value.toLowerCase()
      current.ignore = v === 'untracked' || v === 'dirty' || v === 'all' ? v : 'none'
    }
  }
  flush()
  return out
}

/** The paths `ls-files -z -s` lists as gitlinks (mode 160000), stage 0. */
export function gitlinkPaths(lsFiles: string): Set<string> {
  const out = new Set<string>()
  for (const rec of lsFiles.split('\0')) {
    const tab = rec.indexOf('\t')
    if (tab < 0) continue
    const [mode, , stage] = rec.slice(0, tab).split(' ')
    if (mode === '160000' && stage === '0') out.add(rec.slice(tab + 1))
  }
  return out
}

export interface StatusShape {
  format: 'porcelain' | 'short'
  z: boolean
  untrackedNo: boolean
}

const BRANCH_FLAGS = new Set(['-b', '--branch'])
const UNTRACKED_NO = new Set(['-uno', '--untracked-files=no'])
const UNTRACKED_SHOWN = new Set(['-u', '-unormal', '-uall', '--untracked-files', '--untracked-files=normal', '--untracked-files=all'])

/** The output shape of a status call this module knows how to add a row to: `status` first, then only --porcelain
 *  (v1) or --short, -z, -b and an --untracked-files choice. Anything else (a pathspec, another format, a global before
 *  the subcommand, the caller's own --ignore-submodules) is left as git wrote it: null. */
export function statusShape(args: readonly string[]): StatusShape | null {
  const sub = gitSubcommand(args)
  if (sub === null || sub.name !== 'status' || sub.index !== 0) return null
  let format: StatusShape['format'] | null = null
  let z = false
  let untrackedNo = false
  for (const a of args.slice(1)) {
    if (a === '--porcelain' || a === '--porcelain=v1') {
      if (format === 'short') return null
      format = 'porcelain'
    } else if (a === '--short' || a === '-s') {
      if (format === 'porcelain') return null
      format = 'short'
    } else if (a === '-z') z = true
    else if (UNTRACKED_NO.has(a)) untrackedNo = true
    else if (UNTRACKED_SHOWN.has(a)) untrackedNo = false
    else if (!BRANCH_FLAGS.has(a)) return null
  }
  return format === null ? null : { format, z, untrackedNo }
}

/** A path as git's status writes it outside -z (quote_c_style with core.quotePath on, quoting a space too): in
 *  double quotes, with C escapes and each byte above 0x7f in octal, whenever anything needs it. */
export function quotePath(p: string): string {
  const bytes = Buffer.from(p, 'utf8')
  const NAMED: Record<number, string> = { 7: 'a', 8: 'b', 9: 't', 10: 'n', 11: 'v', 12: 'f', 13: 'r', 34: '"', 92: '\\' }
  let needs = false
  let out = ''
  for (const b of bytes) {
    if (NAMED[b] !== undefined) { out += `\\${NAMED[b]}`; needs = true }
    else if (b < 0x20 || b >= 0x7f) { out += `\\${b.toString(8).padStart(3, '0')}`; needs = true }
    else {
      if (b === 0x20) needs = true
      out += String.fromCharCode(b)
    }
  }
  return needs ? `"${out}"` : p
}

export interface DirtySubmodule {
  /** Root-relative, forward slashes. */
  path: string
  /** Modified tracked content (or a nested change), or only files git does not track yet. */
  state: 'modified' | 'untracked'
}

/** What a submodule's own `status --porcelain -z` says about it: nothing, untracked files only, or modified. */
export function submoduleState(statusZ: string): DirtySubmodule['state'] | null {
  const recs = statusZ.split('\0').filter((r) => r.length >= 3 && !r.startsWith('##'))
  if (recs.length === 0) return null
  return recs.some((r) => !r.startsWith('??') && !r.startsWith('!!')) ? 'modified' : 'untracked'
}

/** The row git writes for a dirty submodule, in `shape`, for a status run `cwdRel` (root-relative, '' at the top)
 *  below the root. --porcelain says ` M` for either kind; --short says ` m` (modified) or ` ?` (untracked files only),
 *  and outside -z writes the path relative to the folder it ran in. */
function rowFor(d: DirtySubmodule, shape: StatusShape, cwdRel: string): string {
  const xy = shape.format === 'porcelain' ? ' M' : d.state === 'modified' ? ' m' : ' ?'
  if (shape.z) return `${xy} ${d.path}`
  const shown = shape.format === 'short' && cwdRel !== '' ? posix.relative(cwdRel, d.path) : d.path
  return `${xy} ${quotePath(shown)}`
}

/** The superproject's status output with a row for each dirty submodule it does not already list (a submodule with
 *  new commits is already there, as git reports it), placed where git puts it: among the tracked changes in path
 *  order, before the untracked and ignored ones. */
export function foldSubmoduleRows(out: string, shape: StatusShape, dirty: readonly DirtySubmodule[], cwdRel: string): string {
  if (dirty.length === 0) return out
  const sep = shape.z ? '\u0000' : '\n'
  const recs = out.split(sep)
  const trailing = recs[recs.length - 1] === '' ? recs.pop() : undefined
  // Group the records into entries: with -z a rename or copy writes its source as a record of its own after it.
  const entries: { recs: string[]; key: string; tracked: boolean }[] = []
  const listed = new Set<string>()
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]
    const entry = { recs: [r], key: pathKey(r.slice(3)), tracked: !/^(##|\?\?|!!)/.test(r) }
    if (!r.startsWith('##')) {
      listed.add(r.slice(3))
      if (!shape.z) for (const part of r.slice(3).split(' -> ')) listed.add(part)
      else if (/^[RC]|^.[RC]/.test(r) && i + 1 < recs.length) {
        listed.add(recs[i + 1])
        entry.recs.push(recs[++i])
      }
    }
    entries.push(entry)
  }
  const rows = dirty.map((d) => rowFor(d, shape, cwdRel)).filter((row) => !listed.has(row.slice(3)))
  if (rows.length === 0) return out
  for (const row of rows) {
    const key = pathKey(row.slice(3))
    let at = entries.findIndex((e) => (e.tracked && e.key > key) || /^(\?\?|!!)/.test(e.recs[0]))
    if (at < 0) at = entries.length
    entries.splice(at, 0, { recs: [row], key, tracked: true })
  }
  return entries.flatMap((e) => e.recs).join(sep) + (trailing !== undefined ? sep : '')
}

/** The order git sorts a status by: the path, compared as text (outside -z without its quotes, near enough). */
function pathKey(shown: string): string {
  return shown.startsWith('"') ? shown.slice(1) : shown
}

export interface SubmoduleDeps {
  /** The repository's top folder for `cwd`, or null outside one (found on disk, without starting git). */
  topLevel: (cwd: string) => Promise<string | null>
  /** A file's text, or null when it cannot be read. */
  readText: (file: string) => Promise<string | null>
  /** Whether a path exists. */
  exists: (p: string) => Promise<boolean>
  /** A guarded read (safeGitAsync) that writes no submodule rows of its own: this module walks the levels itself.
   *  `start` is asked once for each further git the read must start first (a filter scan the cache does not hold);
   *  when it answers false the read starts nothing and throws PollBudgetSpent. */
  git: (args: string[], cwd: string, start?: () => boolean) => Promise<string>
  /** Joins a root and a root-relative forward-slash path into a path on this OS. */
  join: (root: string, rel: string) => string
  /** The root-relative, forward-slash form of `cwd` ('' at the root). */
  relative: (root: string, cwd: string) => string
}

/** Thrown by SubmoduleDeps.git when a git it had to start first did not fit in the poll's budget: nothing was started. */
export class PollBudgetSpent extends Error {
  constructor() {
    super('the poll has no git calls left')
    this.name = 'PollBudgetSpent'
  }
}

/** One poll's git calls: MAX_GIT_PER_POLL in all, over every level, and at most MAX_GIT_AT_ONCE running. */
class PollBudget {
  private left = MAX_GIT_PER_POLL
  private running = 0
  private readonly waiting: (() => void)[] = []

  /** Takes one call from the budget, or false when it is spent. Taken in the order asked, before any wait. */
  take(): boolean {
    if (this.left <= 0) return false
    this.left--
    return true
  }

  /** take, for a git a read starts on its own first (its filter scan): handed to SubmoduleDeps.git as `start`. */
  readonly extra = (): boolean => this.take()

  /** Runs a call taken from the budget once fewer than MAX_GIT_AT_ONCE are running. */
  async run(fn: () => Promise<string>): Promise<string> {
    while (this.running >= MAX_GIT_AT_ONCE) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.running++
    try {
      return await fn()
    } finally {
      this.running--
      this.waiting.shift()?.()
    }
  }
}

/** A repository's submodules worth asking: listed in .gitmodules (not ignored as all or dirty), a gitlink in the index,
 *  and checked out. `unchecked` are the gitlinks past MAX_GIT_PER_POLL, never looked at. null: the listing itself was
 *  past the budget. A missing .gitmodules or a failed listing is none. */
async function listSubmodules(dir: string, budget: PollBudget, d: SubmoduleDeps): Promise<{ present: SubmoduleEntry[]; unchecked: SubmoduleEntry[] } | null> {
  const none = { present: [], unchecked: [] }
  const text = await d.readText(d.join(dir, '.gitmodules'))
  if (text === null) return none
  const wanted = parseGitmodules(text).filter((e) => e.ignore !== 'all' && e.ignore !== 'dirty')
  if (wanted.length === 0) return none
  if (!budget.take()) return null
  let links: Set<string>
  try {
    links = gitlinkPaths(await budget.run(() => d.git(['ls-files', '-z', '-s', '--', ...wanted.map((e) => `:(literal)${e.path}`)], dir, budget.extra)))
  } catch (e) {
    // A listing the budget stopped is not an empty one: what it would have listed cannot be called clean.
    return e instanceof PollBudgetSpent ? null : none
  }
  const linked = wanted.filter((e) => links.has(e.path))
  const looked = linked.slice(0, MAX_GIT_PER_POLL)
  const out = await Promise.all(looked.map((e) => d.exists(d.join(d.join(dir, e.path), '.git'))))
  return { present: looked.filter((_, i) => out[i]), unchecked: linked.slice(MAX_GIT_PER_POLL) }
}

interface Node {
  dir: string
  /** The submodule of the top repository this one sits in (itself at the first level). */
  top: string
  noUntracked: boolean
  depth: number
}

const RANK = { untracked: 1, modified: 2 } as const

/** The dirty submodules of the repository at `root`, each looked at through the guarded runner: level by level, nearest
 *  first, MAX_DEPTH levels down, within one PollBudget. A change in a nested submodule makes the one at the top
 *  modified, as git reports it. One the budget did not reach (itself, or a submodule inside it) cannot be called clean,
 *  so it is reported as modified. Never throws: a submodule whose status fails (a filter that cannot be switched off, a
 *  broken checkout) is reported as not dirty, and its own submodules are not looked into. */
export async function dirtySubmodules(root: string, untrackedNo: boolean, d: SubmoduleDeps): Promise<DirtySubmodule[]> {
  const budget = new PollBudget()
  const tops = new Map<string, DirtySubmodule['state'] | null>()
  const mark = (top: string, state: DirtySubmodule['state'] | null): void => {
    const now = tops.get(top) ?? null
    if (state !== null && (now === null || RANK[state] > RANK[now])) tops.set(top, state)
  }
  // The top repository first, as a parent of depth 0: its submodules are the ones reported.
  let parents: Node[] = [{ dir: root, top: '', noUntracked: untrackedNo, depth: 0 }]
  while (parents.length > 0) {
    const lists = await Promise.all(parents.map((n) => listSubmodules(n.dir, budget, d)))
    const level = parents.flatMap((n, i): Node[] => {
      const list = lists[i]
      if (list === null) {
        mark(n.top, 'modified')
        return []
      }
      const topOf = (e: SubmoduleEntry): string => (n.depth === 0 ? e.path : n.top)
      if (n.depth === 0) for (const e of list.present) tops.set(e.path, null)
      for (const e of list.unchecked) mark(topOf(e), 'modified')
      return list.present.map((e) => ({ dir: d.join(n.dir, e.path), top: topOf(e), noUntracked: n.noUntracked || e.ignore === 'untracked', depth: n.depth + 1 }))
    })
    const asked = await Promise.all(level.map(async (n) => {
      if (!budget.take()) {
        mark(n.top, 'modified')
        return false
      }
      try {
        const out = await budget.run(() => d.git(['status', '--porcelain', '-z', ...(n.noUntracked ? ['--untracked-files=no'] : [])], n.dir, budget.extra))
        const state = submoduleState(out)
        mark(n.top, n.depth === 1 || state === null ? state : 'modified')
        return true
      } catch (e) {
        // Its scan did not fit in the budget: not looked at, so not clean.
        if (e instanceof PollBudgetSpent) mark(n.top, 'modified')
        return false
      }
    }))
    parents = level.filter((n, i) => asked[i] && n.depth < MAX_DEPTH)
  }
  return [...tops].flatMap(([path, state]) => (state === null ? [] : [{ path, state }]))
}

/** `out`, the output of a guarded `args` status run in `cwd`, with its dirty submodules written back in. Any other
 *  command, or a shape this module does not know, and `out` comes back as it is. Never throws. */
export async function withSubmoduleEdits(
  args: readonly string[],
  cwd: string,
  out: string,
  d: SubmoduleDeps,
  cached: (root: string, untrackedNo: boolean, load: () => Promise<DirtySubmodule[]>) => Promise<DirtySubmodule[]>
): Promise<string> {
  const shape = statusShape(args)
  if (shape === null) return out
  try {
    const root = await d.topLevel(cwd)
    if (root === null) return out
    const dirty = await cached(root, shape.untrackedNo, () => dirtySubmodules(root, shape.untrackedNo, d))
    return foldSubmoduleRows(out, shape, dirty, d.relative(root, cwd))
  } catch {
    return out
  }
}
