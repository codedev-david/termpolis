// scopedWatch — subscribe to the parts of a tree that matter (src/main/scopedWatch.ts).
//
// Why it exists, in one measured line (David's laptop, Windows 11, Defender on): a recursive watch of a
// repo root cost its thread 1.79 ms of CPU per delivered event while a worker wrote into `.worktrees/`,
// and 16 ms in total when the same writes landed in a subtree that was not subscribed. A JavaScript
// filter cannot save what the OS has already delivered, so the proof here is the COUNT OF OS
// SUBSCRIPTIONS: no watch is ever opened on an ignored subtree, so no event from it can arrive, however
// many are written. Everything is on injected fakes (the watch function, the directory listing, the
// lstat), so nothing depends on a clock or a disk.
import { describe, it, expect, vi } from 'vitest'
import { join, sep } from 'path'
import {
  scopedRecursiveWatch,
  openScopedGitWatch,
  scopedTriggerWatch,
  GIT_DIR_SKIP,
  TRIGGER_SKIP_NAMES,
  CODE_SKIP_NAMES,
  type ScopedFsWatchFn,
  type ScopedWatchOptions,
} from '../../src/main/scopedWatch'

type Listener = (event: string, filename: string | Buffer | null) => void

interface Opened {
  path: string
  opts: { recursive?: boolean; persistent?: boolean }
  listener: Listener
  closed: number
  fail(): void
}

/**
 * A world: the directories that exist (by absolute path), a recording fs.watch, and the knobs.
 * `dirs` maps a directory to the entries listed in it; a path is a real directory when it has an entry
 * there (or is in `realDirs`, when given), and its identity is the path itself unless `ids` says otherwise.
 */
function world(
  dirs: Record<string, string[]>,
  extra: Partial<ScopedWatchOptions> & { throwOn?: (p: string, recursive: boolean) => boolean; realDirs?: Set<string>; ids?: Map<string, string> } = {},
) {
  const opened: Opened[] = []
  const events: Array<[string, string | null]> = []
  const checks: string[] = []
  const logs: string[] = []
  const ids = extra.ids ?? new Map<string, string>()
  let inFlight = 0
  let maxInFlight = 0
  const fsWatch: ScopedFsWatchFn = (p, o, l) => {
    if (extra.throwOn?.(p, !!o.recursive)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    const errors: Array<(e: unknown) => void> = []
    const rec: Opened = {
      path: p, opts: o, listener: l, closed: 0,
      fail() { for (const cb of errors) cb(Object.assign(new Error('EPERM'), { code: 'EPERM' })) },
    }
    opened.push(rec)
    return {
      close() { rec.closed++ },
      on(ev: 'error', cb: (e: unknown) => void) { if (ev === 'error') errors.push(cb); return this },
    }
  }
  const root = join('/repo')
  const opts: ScopedWatchOptions = {
    caseInsensitive: false,
    yieldToLoop: async () => {},
    listDirs: async (abs) => {
      const list = dirs[abs]
      if (list === undefined) throw new Error('ENOENT')
      return list
    },
    statDir: async (abs) => {
      checks.push(abs)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      inFlight--
      const real = extra.realDirs ? extra.realDirs.has(abs) : abs in dirs
      return real ? (ids.get(abs) ?? abs) : null
    },
    log: (m) => { logs.push(m) },
    ...extra,
  }
  const handle = scopedRecursiveWatch(fsWatch, root, (e, f) => { events.push([e, f]) }, opts)
  return {
    root, handle, opened, events, checks, logs, ids,
    maxInFlight: () => maxInFlight,
    at: (rel: string) => opened.filter((w) => w.path === join(root, ...rel.split('/'))),
    paths: () => opened.map((w) => w.path.slice(root.length + 1) || '.'),
    open: () => opened.filter((w) => w.closed === 0),
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

const ROOT = join('/repo')
const sub = (...p: string[]): string => join(ROOT, ...p)

describe('opening the subscriptions', () => {
  it('opens one NON-recursive watch on the root at once, then one recursive watch per real directory, and none for ignored names', async () => {
    const w = world({ [ROOT]: ['src', 'docs', '.worktrees', 'node_modules', '.git', 'dist', 'Pods', 'build', 'coverage', '.venv'], [sub('src')]: [], [sub('docs')]: [] }, { skipNames: ['pods'] })
    expect(w.opened).toHaveLength(1) // synchronously: the root, and only that
    expect(w.opened[0]).toMatchObject({ path: ROOT, opts: { recursive: false } })
    await settle()
    expect(w.paths()).toEqual(['.', 'src', 'docs'])
    expect(w.at('src')[0].opts.recursive).toBe(true)
    expect(w.at('docs')[0].opts.recursive).toBe(true)
    expect(w.handle.subscriptions).toBe(2)
    expect(w.handle.fellBack).toBe(false)
    w.handle.close()
  })

  it('no watch is ever opened on an ignored subtree, so no number of events written there can reach the listener', async () => {
    const w = world({ [ROOT]: ['src', '.worktrees', 'node_modules', 'dist', 'target', 'coverage', '.next', '.venv', '__pycache__'], [sub('src')]: [] })
    await settle()
    const subscribed = w.opened.map((o) => o.path.toLowerCase())
    for (const bad of ['.worktrees', 'node_modules', 'dist', 'target', 'coverage', '.next', '.venv', '__pycache__']) {
      expect(subscribed.some((p) => p.endsWith(sep + bad))).toBe(false)
    }
    // 100,000 events "written" under the ignored names have nowhere to go: the only watches are the
    // root's own (children of the root only) and src's.
    expect(w.open()).toHaveLength(2)
    expect(w.checks).toEqual([sub('src')]) // ignored names are not even looked at
    w.handle.close()
  })

  it('a listed name that is not a real directory (a file, a link) is not subscribed', async () => {
    const w = world({ [ROOT]: ['src', 'link', 'notes'], [sub('src')]: [] }, { realDirs: new Set([sub('src')]) })
    await settle()
    expect(w.paths()).toEqual(['.', 'src'])
    expect(w.checks).toEqual([sub('src'), sub('link'), sub('notes')])
    w.handle.close()
  })

  it('passes `persistent` to every watch it opens, and nothing when none was asked for', async () => {
    const off = world({ [ROOT]: ['src'], [sub('src')]: [] }, { persistent: false })
    await settle()
    expect(off.opened.every((o) => o.opts.persistent === false)).toBe(true)
    off.handle.close()
    const dflt = world({ [ROOT]: ['src'], [sub('src')]: [] })
    await settle()
    expect(dflt.opened.every((o) => !('persistent' in o.opts))).toBe(true)
    dflt.handle.close()
  })

  it('opens the handles one per turn of the event loop', async () => {
    const yields: number[] = []
    const w = world({ [ROOT]: ['a', 'b', 'c'], [sub('a')]: [], [sub('b')]: [], [sub('c')]: [] }, { yieldToLoop: async () => { yields.push(w.opened.length) } })
    await settle()
    expect(yields).toEqual([1, 2, 3]) // before each sub-watch was opened, the one before it already was
    w.handle.close()
  })

  it('a root that cannot be watched throws, as the single recursive watch it replaces did', () => {
    expect(() => world({ [ROOT]: [] }, { throwOn: (p) => p === ROOT })).toThrow(/EPERM/)
  })

  it('a sub-watch that cannot be opened is skipped; the others are unaffected', async () => {
    const w = world({ [ROOT]: ['src', 'bad', 'docs'], [sub('src')]: [], [sub('bad')]: [], [sub('docs')]: [] }, { throwOn: (p) => p.endsWith(sep + 'bad') })
    await settle()
    expect(w.paths()).toEqual(['.', 'src', 'docs'])
    expect(w.handle.subscriptions).toBe(2)
    w.handle.close()
  })
})

describe('naming events', () => {
  it('events from a sub-watch are named as a single recursive watch of the root would name them', async () => {
    const w = world({ [ROOT]: ['src', 'docs'], [sub('src')]: [], [sub('docs')]: [] })
    await settle()
    w.at('src')[0].listener('change', 'app\\a.ts')
    w.at('docs')[0].listener('rename', 'b.md')
    expect(w.events).toEqual([['change', 'src' + sep + 'app\\a.ts'], ['rename', 'docs' + sep + 'b.md']])
    w.handle.close()
  })

  it('events on the root itself are passed through unprefixed, including a missing name', async () => {
    const w = world({ [ROOT]: ['src'], [sub('src')]: [] })
    await settle()
    w.opened[0].listener('change', 'package.json')
    w.opened[0].listener('change', null)
    expect(w.events).toEqual([['change', 'package.json'], ['change', null]])
    w.handle.close()
  })

  it('a sub-watch event with no name is the directory itself', async () => {
    const w = world({ [ROOT]: ['src'], [sub('src')]: [] })
    await settle()
    w.at('src')[0].listener('change', null)
    expect(w.events).toEqual([['change', 'src']])
    w.handle.close()
  })

  it('decodes Buffer names', async () => {
    const w = world({ [ROOT]: ['src'], [sub('src')]: [] })
    await settle()
    w.opened[0].listener('change', Buffer.from('x.txt'))
    w.at('src')[0].listener('change', Buffer.from('y.ts'))
    expect(w.events).toEqual([['change', 'x.txt'], ['change', 'src' + sep + 'y.ts']])
    w.handle.close()
  })

  it('a `rename` from inside a recursive sub-watch is not a new top-level directory: nothing is checked', async () => {
    const w = world({ [ROOT]: ['src'], [sub('src')]: [] })
    await settle()
    const base = w.checks.length
    w.at('src')[0].listener('rename', 'newdir')
    await settle()
    expect(w.checks.length).toBe(base)
    w.handle.close()
  })
})

describe('directories that come and go', () => {
  it('a new top-level directory is checked once, subscribed, and announced with one synthetic rename', async () => {
    const w = world({ [ROOT]: ['src'], [sub('src')]: [], [sub('lib')]: [] })
    await settle()
    const base = w.checks.length
    w.opened[0].listener('rename', 'lib')
    w.opened[0].listener('rename', 'lib') // a burst of renames for the same name
    w.opened[0].listener('change', 'lib') // a `change` is not a reason to look
    await settle()
    // Two looks for the whole burst, not one per event: the second because events arrived while the first
    // was in flight (its answer might predate them), and it finds the same directory, so it changes nothing.
    expect(w.checks.slice(base)).toEqual([sub('lib'), sub('lib')])
    expect(w.at('lib')).toHaveLength(1)
    expect(w.at('lib')[0].opts.recursive).toBe(true)
    // the two real renames and the change, then the synthetic one, in that order
    expect(w.events).toEqual([['rename', 'lib'], ['rename', 'lib'], ['change', 'lib'], ['rename', 'lib']])
    w.handle.close()
  })

  it('a rename for a file or an ignored name opens nothing (and an ignored name is not even looked at)', async () => {
    const w = world({ [ROOT]: ['src'] }, { realDirs: new Set([sub('src')]) })
    await settle()
    const base = w.checks.length
    w.opened[0].listener('rename', 'package.json') // lstat says: not a directory
    w.opened[0].listener('rename', 'node_modules') // ignored by name: not even asked
    w.opened[0].listener('rename', '.worktrees')
    await settle()
    expect(w.checks.slice(base)).toEqual([sub('package.json')])
    expect(w.open()).toHaveLength(2)
    w.handle.close()
  })

  it('a rename that arrives before the first listing is done does not subscribe the same directory twice', async () => {
    const w = world({ [ROOT]: ['src'], [sub('src')]: [] })
    w.opened[0].listener('rename', 'src') // before init has listed anything
    await settle()
    expect(w.at('src')).toHaveLength(1)
    expect(w.handle.subscriptions).toBe(1)
    w.handle.close()
  })

  it('a rename for a directory that is already watched is looked at by identity: the SAME directory changes nothing', async () => {
    const w = world({ [ROOT]: ['src'], [sub('src')]: [] })
    await settle()
    const base = w.checks.length
    w.opened[0].listener('rename', 'src')
    await settle()
    expect(w.checks.slice(base)).toEqual([sub('src')])
    expect(w.at('src')).toHaveLength(1)
    expect(w.at('src')[0].closed).toBe(0)
    w.handle.close()
  })

  it('a watched name that now holds a DIFFERENT directory has its old watch closed and a new one opened', async () => {
    // Windows follows the directory, not the name: a directory renamed away keeps its handle, and would go on
    // reporting ITS files under the old name. The identity (device and inode) is what tells.
    const w = world({ [ROOT]: ['src'], [sub('src')]: [] })
    await settle()
    const old = w.at('src')[0]
    w.ids.set(sub('src'), 'another-directory')
    w.opened[0].listener('rename', 'src')
    await settle()
    expect(old.closed).toBe(1)
    expect(w.at('src')).toHaveLength(2)
    expect(w.at('src')[1].closed).toBe(0)
    expect(w.events).toContainEqual(['rename', 'src']) // the synthetic one, for the new directory
    expect(w.handle.subscriptions).toBe(1)
    w.handle.close()
  })

  it('an event for a name that is already being looked at makes it look once more when the answer lands (remove and recreate back to back is not missed)', async () => {
    // A branch switch flips a directory away and back. The first look can land BETWEEN the two: it sees
    // nothing, closes the old watch, and the recreation event that arrived meanwhile must not be lost.
    let calls = 0
    const deferred: Array<(v: string | null) => void> = []
    const w = world({ [ROOT]: ['docs'], [sub('docs')]: [] }, {
      statDir: (): Promise<string | null> => {
        calls++
        if (calls === 1) return Promise.resolve('X') // init
        return new Promise<string | null>((resolve) => { deferred.push(resolve) })
      },
    })
    await settle()
    expect(w.at('docs')).toHaveLength(1)
    w.opened[0].listener('rename', 'docs') // the removal: a look starts
    w.opened[0].listener('rename', 'docs') // the recreation, while that look is in flight
    w.opened[0].listener('rename', 'docs') // and a third: still only ONE more look afterwards
    await settle()
    expect(deferred).toHaveLength(1)
    deferred[0](null) // the first look saw it gone: the old watch is closed ...
    await settle()
    expect(w.at('docs')[0].closed).toBe(1)
    expect(deferred).toHaveLength(2) // ... and, because events arrived meanwhile, it looked again
    deferred[1]('Y') // the recreated directory
    await settle()
    expect(w.at('docs')).toHaveLength(2)
    expect(w.at('docs')[1].closed).toBe(0)
    expect(w.handle.subscriptions).toBe(1)
    w.handle.close()
  })

  it('a look that fails changes nothing, and is repeated once if an event arrived while it was failing', async () => {
    let calls = 0
    const rejects: Array<(e: Error) => void> = []
    const w = world({ [ROOT]: ['docs'], [sub('docs')]: [] }, {
      statDir: (): Promise<string | null> => {
        calls++
        if (calls === 1) return Promise.resolve('X')
        if (calls === 2) return new Promise<string | null>((_r, rej) => { rejects.push(rej) })
        return Promise.resolve('X')
      },
    })
    await settle()
    w.opened[0].listener('rename', 'docs')
    w.opened[0].listener('rename', 'docs') // marks "look again"
    rejects[0](new Error('EIO'))
    await settle()
    expect(calls).toBe(3)
    expect(w.at('docs')[0].closed).toBe(0) // a failed look says nothing about the directory
    expect(w.handle.subscriptions).toBe(1)
    w.handle.close()
  })

  it('a watched name that no longer exists has its watch closed and forgotten, and nothing new is opened', async () => {
    const real = new Set([sub('src'), sub('docs')])
    const w = world({ [ROOT]: ['src', 'docs'], [sub('src')]: [], [sub('docs')]: [] }, { realDirs: real })
    await settle()
    const docs = w.at('docs')[0]
    real.delete(sub('docs')) // renamed away or removed: that watch would go on following the OLD directory
    w.opened[0].listener('rename', 'docs')
    await settle()
    expect(docs.closed).toBe(1)
    expect(w.handle.subscriptions).toBe(1)
    expect(w.at('docs')).toHaveLength(1)
    w.handle.close()
  })

  it('at most 32 directory checks are in flight, however fast the renames arrive', async () => {
    // (The storm limit is raised out of the way: this is about the look-ups, not about shedding.)
    const w = world({ [ROOT]: [] }, { realDirs: new Set(), shed: { eventsPerSecond: 1_000_000 } })
    await settle()
    for (let i = 0; i < 5000; i++) w.opened[0].listener('rename', `tmp${i}`)
    await settle()
    expect(w.maxInFlight()).toBeLessThanOrEqual(32)
    expect(w.checks.length).toBeLessThanOrEqual(32)
    expect(w.events).toHaveLength(5000) // every event still reached the listener
    w.handle.close()
  })

  it('a watched directory that is deleted is dropped, announced, and resubscribed if it is back', async () => {
    const w = world({ [ROOT]: ['src', 'docs'], [sub('src')]: [], [sub('docs')]: [] }, { realDirs: new Set([sub('src'), sub('docs')]) })
    await settle()
    expect(w.handle.subscriptions).toBe(2)
    const before = w.events.length
    const base = w.checks.length
    w.at('docs')[0].fail() // Windows: EPERM when the watched directory is removed
    await settle()
    expect(w.at('docs')[0].closed).toBeGreaterThanOrEqual(1)
    expect(w.events.slice(before)).toContainEqual(['rename', 'docs'])
    // it was looked at again at once (it may have been recreated), and it still exists here
    expect(w.checks.slice(base)).toContain(sub('docs'))
    expect(w.at('docs')).toHaveLength(2)
    expect(w.handle.subscriptions).toBe(2)
    w.handle.close()
  })

  it('a deleted directory that stays gone is just forgotten', async () => {
    const real = new Set([sub('src'), sub('docs')])
    const w = world({ [ROOT]: ['src', 'docs'], [sub('src')]: [], [sub('docs')]: [] }, { realDirs: real })
    await settle()
    real.delete(sub('docs'))
    w.at('docs')[0].fail() // EPERM: the watched directory was removed, and it is not coming back
    await settle()
    expect(w.handle.subscriptions).toBe(1)
    expect(w.at('docs')).toHaveLength(1)
    w.handle.close()
  })

  it('an old watcher whose error arrives after its replacement was opened does not evict the replacement', async () => {
    const w = world({ [ROOT]: ['src'], [sub('src')]: [] }, { realDirs: new Set([sub('src')]) })
    await settle()
    const old = w.at('src')[0]
    old.fail() // dropped and resubscribed ...
    await settle()
    expect(w.at('src')).toHaveLength(2)
    old.fail() // ... and the stale handle reports again
    await settle()
    expect(w.handle.subscriptions).toBe(1)
    w.handle.close()
  })

  it('names that differ only in case are one directory where the disk is case-insensitive', async () => {
    // On such a disk both spellings are the same inode, so the identity is the lower-cased path here.
    const lower = (abs: string): string => abs.toLowerCase()
    const real = new Set([sub('src'), sub('Src')])
    const w = world({ [ROOT]: ['Src'] }, {
      caseInsensitive: true,
      statDir: async (abs) => (real.has(abs) ? lower(abs) : null),
    })
    await settle()
    expect(w.at('Src')).toHaveLength(1)
    w.opened[0].listener('rename', 'src')
    await settle()
    expect(w.at('Src')).toHaveLength(1) // not subscribed a second time
    expect(w.at('src')).toHaveLength(0) // (no watch was opened under the other spelling either)
    expect(w.opened).toHaveLength(2) // the root, and the one directory
    expect(w.handle.subscriptions).toBe(1)
    w.handle.close()
  })

  it('a directory whose check fails is simply not subscribed', async () => {
    const w = world({ [ROOT]: [] }, { statDir: async () => { throw new Error('EIO') } })
    await settle()
    w.opened[0].listener('rename', 'lib')
    await settle()
    expect(w.open()).toHaveLength(1)
    w.opened[0].listener('rename', 'lib2') // and a failed check did not wedge the queue
    await settle()
    expect(w.open()).toHaveLength(1)
    w.handle.close()
  })
})

describe('falling back to ONE recursive watch of the root', () => {
  it('more directories than the limit: the scoped watches are closed and the root is watched recursively', async () => {
    const names = Array.from({ length: 10 }, (_, i) => `d${i}`)
    const w = world({ [ROOT]: names }, { maxSubscriptions: 4 })
    await settle()
    expect(w.handle.fellBack).toBe(true)
    expect(w.handle.subscriptions).toBe(0)
    expect(w.opened[0].closed).toBe(1) // the non-recursive root watch
    const full = w.opened.filter((o) => o.path === ROOT && o.opts.recursive)
    expect(full).toHaveLength(1)
    expect(w.open()).toEqual(full)
    expect(w.logs).toHaveLength(1)
    expect(w.logs[0]).toMatch(/more than 4 directories.*recursively/)
    // ... and it reports like the old watch did
    full[0].listener('change', 'd3\\a.ts')
    expect(w.events).toEqual([['change', 'd3\\a.ts']])
    w.handle.close()
    expect(full[0].closed).toBe(1)
  })

  it('an unreadable root falls back at once', async () => {
    const w = world({}, { listDirs: async () => { throw new Error('EACCES') } })
    await settle()
    expect(w.handle.fellBack).toBe(true)
    expect(w.open().map((o) => o.opts.recursive)).toEqual([true])
    w.handle.close()
  })

  it('a directory that appears after the limit was reached also falls back', async () => {
    const w = world({ [ROOT]: ['a', 'b'], [sub('a')]: [], [sub('b')]: [], [sub('c')]: [] }, { maxSubscriptions: 2 })
    await settle()
    expect(w.handle.fellBack).toBe(false)
    w.opened[0].listener('rename', 'c')
    await settle()
    expect(w.handle.fellBack).toBe(true)
    expect(w.open().map((o) => o.opts.recursive)).toEqual([true])
    w.handle.close()
  })

  it('once fallen back it ignores renames, and a fallback that is itself refused leaves nothing open', async () => {
    const w = world({ [ROOT]: ['a', 'b', 'c'] }, { maxSubscriptions: 1, throwOn: (p, rec) => rec && p === ROOT })
    await settle()
    expect(w.handle.fellBack).toBe(true)
    expect(w.open()).toHaveLength(0)
    const base = w.checks.length
    w.opened[0].listener('rename', 'zzz') // the closed root watch can still deliver a queued event
    await settle()
    expect(w.checks.length).toBe(base)
    expect(() => w.handle.close()).not.toThrow()
  })

  it('a logger that throws does not take the watch down', async () => {
    const w = world({ [ROOT]: ['a', 'b', 'c'] }, { maxSubscriptions: 1, log: () => { throw new Error('logger') } })
    await settle()
    expect(w.handle.fellBack).toBe(true)
    w.handle.close()
  })

  it('a recursive watch that errors tells the listener something moved', async () => {
    const w = world({}, { listDirs: async () => { throw new Error('EACCES') } })
    await settle()
    const full = w.open()[0]
    full.fail()
    expect(w.events).toContainEqual(['rename', null])
    w.handle.close()
  })
})

describe('expanded directories (.claude)', () => {
  it('is watched non-recursively, with each child below it recursively except worktrees', async () => {
    const w = world({
      [ROOT]: ['src', '.claude'],
      [sub('src')]: [],
      [sub('.claude')]: ['commands', 'worktrees', 'agents'],
      [sub('.claude', 'commands')]: [],
      [sub('.claude', 'agents')]: [],
    })
    await settle()
    expect(w.paths()).toEqual(['.', 'src', '.claude', join('.claude', 'commands'), join('.claude', 'agents')])
    expect(w.at('.claude')[0].opts.recursive).toBe(false)
    expect(w.at('.claude/commands')[0].opts.recursive).toBe(true)
    expect(w.at('.claude/worktrees')).toHaveLength(0)
    w.handle.close()
  })

  it('names its events, and its children\'s, from the root', async () => {
    const w = world({ [ROOT]: ['.claude'], [sub('.claude')]: ['commands'], [sub('.claude', 'commands')]: [] })
    await settle()
    w.at('.claude')[0].listener('change', 'settings.json')
    w.at('.claude/commands')[0].listener('change', 'x.md')
    expect(w.events).toEqual([
      ['change', '.claude' + sep + 'settings.json'],
      ['change', '.claude' + sep + 'commands' + sep + 'x.md'],
    ])
    w.handle.close()
  })

  it('a child that appears later is subscribed; one named worktrees is not', async () => {
    const w = world({ [ROOT]: ['.claude'], [sub('.claude')]: [], [sub('.claude', 'skills')]: [] })
    await settle()
    const base = w.checks.length
    w.at('.claude')[0].listener('rename', 'skills')
    w.at('.claude')[0].listener('rename', 'worktrees')
    await settle()
    expect(w.at('.claude/skills')).toHaveLength(1)
    expect(w.at('.claude/worktrees')).toHaveLength(0)
    expect(w.checks.slice(base)).toEqual([sub('.claude', 'skills')])
    expect(w.events).toContainEqual(['rename', '.claude' + sep + 'skills'])
    w.handle.close()
  })

  it('an unreadable expanded directory still reports its own files', async () => {
    const w = world({ [ROOT]: ['.claude'], [sub('.claude')]: undefined as unknown as string[] }, { realDirs: new Set([sub('.claude')]) })
    await settle()
    expect(w.at('.claude')).toHaveLength(1)
    expect(w.handle.subscriptions).toBe(1)
    w.handle.close()
  })

  it('expandNames can be replaced (the .git scope expands nothing)', async () => {
    const w = world({ [ROOT]: ['.claude'], [sub('.claude')]: [] }, { expandNames: [] })
    await settle()
    expect(w.at('.claude')[0].opts.recursive).toBe(true)
    w.handle.close()
  })
})

describe('the platform default for case', () => {
  it('treats names that differ only in case as one directory exactly where the disk does', async () => {
    const ci = process.platform === 'win32' || process.platform === 'darwin'
    const w = world({ [ROOT]: ['Src'], [sub('Src')]: [] }, { caseInsensitive: undefined, statDir: async (abs) => (abs.toLowerCase() === sub('src').toLowerCase() ? 'one-directory' : null) })
    await settle()
    w.opened[0].listener('rename', 'src')
    await settle()
    // Where the disk folds case, `src` is the watched `Src`: nothing is opened. Where it does not, it is a
    // second name for the same fake directory, and the identity (equal) still says nothing changed.
    expect(w.handle.subscriptions).toBe(ci ? 1 : 2)
    w.handle.close()
  })
})

describe('a storm in one of its watches (shedWatch.ts)', () => {
  /** A world whose shedding watches run on a clock the test moves by hand. */
  function stormWorld(dirs: Record<string, string[]>, extra: Parameters<typeof world>[1] = {}) {
    let t = 5_000_000
    let seq = 0
    const timers = new Map<number, { at: number; fn: () => void }>()
    const clock = {
      advance(ms: number): void {
        const end = t + ms
        for (;;) {
          const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
          if (!due) break
          timers.delete(due[0])
          t = Math.max(t, due[1].at)
          due[1].fn()
        }
        t = end
      },
    }
    const w = world(dirs, {
      shed: {
        now: () => t,
        setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id },
        clearTimer: (id) => { timers.delete(id as number) },
      },
      ...extra,
    })
    return { w, clock }
  }

  it('closes only the watch that is flooded: it delivers 200 events, the others carry on', async () => {
    const { w } = stormWorld({ [ROOT]: ['src', 'docs'], [sub('src')]: [], [sub('docs')]: [] })
    await settle()
    const src = w.at('src')[0]
    for (let i = 0; i < 100_000; i++) src.listener('change', `f${i % 500}.ts`)
    expect(w.events).toHaveLength(200)
    expect(src.closed).toBe(1)
    w.at('docs')[0].listener('change', 'readme.md')
    expect(w.events[200]).toEqual(['change', 'docs' + sep + 'readme.md'])
    expect(w.at('docs')[0].closed).toBe(0)
    expect(w.opened[0].closed).toBe(0) // the root watch is not the one that was shouted at
    w.handle.close()
  })

  it('after the back-off the watch is reopened and ONE overflow event names its directory', async () => {
    const { w, clock } = stormWorld({ [ROOT]: ['src'], [sub('src')]: [] })
    await settle()
    for (let i = 0; i < 300; i++) w.at('src')[0].listener('change', `f${i}.ts`)
    const before = w.events.length
    clock.advance(3999)
    expect(w.at('src')).toHaveLength(1)
    clock.advance(1)
    expect(w.at('src')).toHaveLength(2)
    expect(w.events.slice(before)).toEqual([['overflow', 'src']])
    w.at('src')[1].listener('change', 'after.ts') // and it listens again
    expect(w.events[w.events.length - 1]).toEqual(['change', 'src' + sep + 'after.ts'])
    w.handle.close()
  })

  it('the root watch closed by a storm comes back with a bare overflow and a rescan: a directory created meanwhile is subscribed, one removed is dropped', async () => {
    const real = new Set([sub('src'), sub('gone')])
    const dirs: Record<string, string[]> = { [ROOT]: ['src', 'gone'], [sub('src')]: [], [sub('gone')]: [] }
    const { w, clock } = stormWorld(dirs, { realDirs: real })
    await settle()
    expect(w.handle.subscriptions).toBe(2)
    for (let i = 0; i < 300; i++) w.opened[0].listener('change', `noise${i % 5}`) // `change:dist` and friends
    // while the root watch is closed: a directory appears, another goes, an ignored name shows up
    real.add(sub('newdir'))
    real.delete(sub('gone'))
    dirs[ROOT] = ['src', 'newdir', 'node_modules']
    clock.advance(4000)
    await settle()
    expect(w.events).toContainEqual(['overflow', null])
    expect(w.at('newdir')).toHaveLength(1) // found by the rescan
    expect(w.at('gone')[0].closed).toBe(1) // no longer there
    expect(w.at('node_modules')).toHaveLength(0)
    expect(w.at('src')).toHaveLength(1) // unchanged: the same directory, not resubscribed
    expect(w.handle.subscriptions).toBe(2) // src and newdir
    w.handle.close()
  })

  it('a rescan whose listing fails does nothing, and one closed in the middle stops', async () => {
    const dirs: Record<string, string[]> = { [ROOT]: ['src'], [sub('src')]: [] }
    const failing = stormWorld(dirs)
    await settle()
    for (let i = 0; i < 300; i++) failing.w.opened[0].listener('change', 'n')
    delete dirs[ROOT]
    failing.clock.advance(4000)
    await settle()
    expect(failing.w.handle.subscriptions).toBe(1)
    expect(failing.w.handle.fellBack).toBe(false)
    failing.w.handle.close()

    const dirs2: Record<string, string[]> = { [ROOT]: ['src', 'a', 'b'], [sub('src')]: [], [sub('a')]: [], [sub('b')]: [] }
    let calls = 0
    let closer: (() => void) | null = null
    const mid = stormWorld(dirs2, { yieldToLoop: async () => { calls++; if (calls > 3 && closer) closer() } })
    await settle()
    closer = () => mid.w.handle.close()
    for (let i = 0; i < 300; i++) mid.w.opened[0].listener('change', 'n')
    dirs2[ROOT] = ['src', 'a', 'b', 'c', 'd']
    mid.clock.advance(4000)
    await settle()
    expect(mid.w.handle.subscriptions).toBe(0) // closed: nothing is left, and nothing was opened afterwards
  })

  it('an expanded directory (.claude) that was shouted at is rescanned on its own level', async () => {
    const real = new Set([sub('.claude'), sub('.claude', 'commands'), sub('.claude', 'gone')])
    const dirs: Record<string, string[]> = {
      [ROOT]: ['.claude'],
      [sub('.claude')]: ['commands', 'gone', 'worktrees'],
      [sub('.claude', 'commands')]: [], [sub('.claude', 'gone')]: [], [sub('.claude', 'fresh')]: [],
    }
    const { w, clock } = stormWorld(dirs, { realDirs: real })
    await settle()
    expect(w.handle.subscriptions).toBe(3) // .claude, commands, gone
    for (let i = 0; i < 300; i++) w.at('.claude')[0].listener('change', 'settings.json')
    real.add(sub('.claude', 'fresh'))
    real.delete(sub('.claude', 'gone'))
    dirs[sub('.claude')] = ['commands', 'fresh', 'worktrees']
    clock.advance(4000)
    await settle()
    expect(w.events).toContainEqual(['overflow', '.claude'])
    expect(w.at('.claude/fresh')).toHaveLength(1)
    expect(w.at('.claude/gone')[0].closed).toBe(1)
    expect(w.at('.claude/worktrees')).toHaveLength(0)
    expect(w.at('.claude/commands')).toHaveLength(1) // still the same one
    expect(w.handle.subscriptions).toBe(3) // .claude, commands, fresh
    w.handle.close()
  })

  it('the fallback recursive watch is a shedding watch too: it comes back with a bare overflow', async () => {
    const { w, clock } = stormWorld({}, { listDirs: async () => { throw new Error('EACCES') } })
    await settle()
    const full = w.open()[0]
    for (let i = 0; i < 300; i++) full.listener('change', `f${i}.ts`)
    expect(full.closed).toBe(1)
    clock.advance(4000)
    expect(w.open()).toHaveLength(1)
    expect(w.events[w.events.length - 1]).toEqual(['overflow', null])
    w.handle.close()
  })

  it('a storm of events about IGNORED names only (the root hearing `change:dist` once per file a build writes) closes the watch but owes nobody an overflow; the rescan still runs', async () => {
    const { w, clock } = stormWorld({ [ROOT]: ['src'], [sub('src')]: [] })
    await settle()
    for (let i = 0; i < 300; i++) w.opened[0].listener('change', i % 2 ? 'dist' : 'node_modules')
    const before = w.events.length
    const looked = w.checks.length
    clock.advance(4000)
    await settle()
    expect(w.opened[0].closed).toBe(1)
    expect(w.opened.filter((o) => o.path === ROOT)).toHaveLength(2) // reopened
    expect(w.events.slice(before)).toEqual([]) // and not one overflow: a re-sweep, a repaint or a workflow run for noise
    expect(w.checks.length).toBeGreaterThan(looked) // but the directories were looked at
    w.handle.close()
  })

  it('one wanted event among the noise is enough to owe the overflow', async () => {
    const { w, clock } = stormWorld({ [ROOT]: ['src'], [sub('src')]: [] })
    await settle()
    w.opened[0].listener('change', 'package.json')
    for (let i = 0; i < 300; i++) w.opened[0].listener('change', 'dist')
    const before = w.events.length
    clock.advance(4000)
    await settle()
    expect(w.events.slice(before)).toEqual([['overflow', null]])
    w.handle.close()
  })

  it('an event with no name might be about anything, so it counts as wanted', async () => {
    const { w, clock } = stormWorld({ [ROOT]: ['src'], [sub('src')]: [] })
    await settle()
    for (let i = 0; i < 300; i++) w.opened[0].listener('change', null)
    const before = w.events.length
    clock.advance(4000)
    await settle()
    expect(w.events.slice(before)).toEqual([['overflow', null]])
    w.handle.close()
  })

  it('a sub-watch hearing only ignored nested names (src/node_modules/...) owes no overflow either', async () => {
    const { w, clock } = stormWorld({ [ROOT]: ['src'], [sub('src')]: [] })
    await settle()
    for (let i = 0; i < 300; i++) w.at('src')[0].listener('change', 'node_modules' + sep + 'x' + sep + `i${i}.js`)
    const before = w.events.length
    clock.advance(4000)
    await settle()
    expect(w.at('src')).toHaveLength(2) // reopened
    expect(w.events.slice(before)).toEqual([])
    w.handle.close()
  })

  it('the wanted count starts again after each reopening: noise first, then a wanted storm, owes the overflow once', async () => {
    const { w, clock } = stormWorld({ [ROOT]: ['src'], [sub('src')]: [] })
    await settle()
    for (let i = 0; i < 300; i++) w.at('src')[0].listener('change', 'node_modules' + sep + `i${i}.js`)
    clock.advance(4000)
    await settle()
    const before = w.events.length
    for (let i = 0; i < 300; i++) w.at('src')[1].listener('change', `real${i}.ts`)
    clock.advance(8000)
    await settle()
    expect(w.events.slice(before).filter((e) => e[0] === 'overflow')).toEqual([['overflow', 'src']])
    w.handle.close()
  })

  it('the fallback watch hearing only ignored names owes no overflow either', async () => {
    const { w, clock } = stormWorld({}, { listDirs: async () => { throw new Error('EACCES') } })
    await settle()
    const full = w.open()[0]
    for (let i = 0; i < 300; i++) full.listener('change', 'node_modules' + sep + `i${i}.js`)
    const before = w.events.length
    clock.advance(4000)
    expect(w.events.slice(before)).toEqual([])
    w.handle.close()
  })

  it('a rescan that finds more directories than the limit allows ends in the fallback, and stops looking', async () => {
    const real = new Set([sub('src')])
    const dirs: Record<string, string[]> = { [ROOT]: ['src'], [sub('src')]: [] }
    const { w, clock } = stormWorld(dirs, { realDirs: real, maxSubscriptions: 1 })
    await settle()
    for (let i = 0; i < 300; i++) w.opened[0].listener('change', `n${i}`)
    for (const n of ['a', 'b', 'c']) real.add(sub(n))
    dirs[ROOT] = ['src', 'a', 'b', 'c']
    clock.advance(4000)
    await settle()
    expect(w.handle.fellBack).toBe(true)
    expect(w.open().map((o) => o.opts.recursive)).toEqual([true])
    w.handle.close()
  })

  it('an error from the root watch after close() is not reported', async () => {
    const w = world({ [ROOT]: [] })
    await settle()
    const root = w.opened[0]
    w.handle.close()
    const n = w.events.length
    root.fail()
    expect(w.events.length).toBe(n)
  })

  it('counts: 100,000 events at a flooded sub-watch are 200 deliveries a try, however long it goes on', async () => {
    const { w, clock } = stormWorld({ [ROOT]: ['src'], [sub('src')]: [] })
    await settle()
    let delivered = 0
    for (let attempt = 0; attempt < 6; attempt++) {
      const h = w.at('src')[w.at('src').length - 1]
      for (let i = 0; i < 100_000; i++) h.listener('change', `f${i % 500}.ts`)
      delivered = w.events.filter((e) => e[0] === 'change').length
      clock.advance(60_000) // long enough for any back-off
    }
    expect(w.at('src')).toHaveLength(7) // the first handle and six reopenings
    expect(delivered).toBe(1200) // 6 attempts x 200 events, out of 600,000
    w.handle.close()
  })
})

describe('closing', () => {
  it('closes every handle, forgets everything, and is idempotent', async () => {
    const w = world({ [ROOT]: ['src', 'docs'], [sub('src')]: [], [sub('docs')]: [] })
    await settle()
    w.handle.close()
    w.handle.close()
    expect(w.opened.every((o) => o.closed === 1)).toBe(true)
    expect(w.handle.subscriptions).toBe(0)
  })

  it('ignores an event that was already queued, and opens nothing for a check that finishes afterwards', async () => {
    const w = world({ [ROOT]: ['src'], [sub('src')]: [], [sub('late')]: [] })
    await settle()
    w.opened[0].listener('rename', 'late')
    w.handle.close() // the lstat has not been answered yet
    await settle()
    expect(w.at('late')).toHaveLength(0)
    const n = w.events.length
    w.opened[0].listener('change', 'x')
    w.at('src')[0].listener('change', 'y')
    expect(w.events.length).toBe(n)
  })

  it('closing while the directories are still being listed opens none of them', async () => {
    let release!: (n: string[]) => void
    const w = world({ [ROOT]: ['src'] }, { listDirs: () => new Promise<string[]>((r) => { release = r }) })
    w.handle.close()
    release(['src', 'docs'])
    await settle()
    expect(w.opened).toHaveLength(1)
  })

  it('closing between two sub-watches stops the rest', async () => {
    let calls = 0
    const w = world({ [ROOT]: ['a', 'b', 'c'], [sub('a')]: [], [sub('b')]: [], [sub('c')]: [] }, { yieldToLoop: async () => { if (++calls === 2) w.handle.close() } })
    await settle()
    expect(w.opened.filter((o) => o.path !== ROOT)).toHaveLength(1)
  })

  it('a late answer to listing the root after close() falls back to nothing', async () => {
    let reject!: (e: Error) => void
    const w = world({ [ROOT]: [] }, { listDirs: () => new Promise<string[]>((_r, rej) => { reject = rej }) })
    w.handle.close()
    reject(new Error('EACCES'))
    await settle()
    expect(w.opened).toHaveLength(1) // no recursive watch was opened for a watch nobody wants any more
    expect(w.handle.fellBack).toBe(false)
  })

  it('an error from a watch after close() is bookkeeping only: nothing is announced or looked at', async () => {
    const w = world({ [ROOT]: ['src'], [sub('src')]: [] })
    await settle()
    const src = w.at('src')[0]
    w.handle.close()
    const n = w.events.length
    const base = w.checks.length
    src.fail()
    await settle()
    expect(w.events.length).toBe(n)
    expect(w.checks.length).toBe(base)
  })

  it('closing while an expanded directory is still being subscribed stops its remaining children', async () => {
    let calls = 0
    const w = world(
      { [ROOT]: ['.claude'], [sub('.claude')]: ['a', 'b', 'c'], [sub('.claude', 'a')]: [], [sub('.claude', 'b')]: [], [sub('.claude', 'c')]: [] },
      { yieldToLoop: async () => { if (++calls === 3) w.handle.close() } },
    )
    await settle()
    // the root's own yield, then one per child: closed at the second child's
    expect(w.opened.filter((o) => o.path.includes(sep + '.claude' + sep))).toHaveLength(1)
  })

  it('an expanded directory that pushes past the limit falls back, and its remaining children are not opened', async () => {
    const w = world({ [ROOT]: ['.claude'], [sub('.claude')]: ['a', 'b', 'c'], [sub('.claude', 'a')]: [], [sub('.claude', 'b')]: [], [sub('.claude', 'c')]: [] }, { maxSubscriptions: 2 })
    await settle()
    expect(w.handle.fellBack).toBe(true)
    expect(w.open().map((o) => o.opts.recursive)).toEqual([true])
  })

  it('a handle that throws on close does not stop the others', async () => {
    const opened: Array<() => void> = []
    const fsWatch: ScopedFsWatchFn = () => {
      const closed = { n: 0 }
      opened.push(() => closed.n++)
      return { close() { closed.n++; throw new Error('already closed') } }
    }
    const h = scopedRecursiveWatch(fsWatch, ROOT, () => {}, { caseInsensitive: false, yieldToLoop: async () => {}, listDirs: async () => ['a', 'b'], statDir: async (p) => p })
    await settle()
    expect(() => h.close()).not.toThrow()
    expect(opened).toHaveLength(3)
  })

  it('a watch without an event emitter is still usable', async () => {
    const fsWatch: ScopedFsWatchFn = () => ({ close() {} })
    const h = scopedRecursiveWatch(fsWatch, ROOT, () => {}, { caseInsensitive: false, yieldToLoop: async () => {}, listDirs: async () => ['a'], statDir: async (p) => p })
    await settle()
    expect(h.subscriptions).toBe(1)
    h.close()
  })

  it('a watch whose .on throws is still usable', async () => {
    const fsWatch: ScopedFsWatchFn = () => ({ close() {}, on() { throw new Error('no emitter') } })
    const h = scopedRecursiveWatch(fsWatch, ROOT, () => {}, { caseInsensitive: false, yieldToLoop: async () => {}, listDirs: async () => ['a'], statDir: async (p) => p })
    await settle()
    expect(h.subscriptions).toBe(1)
    h.close()
  })

  it('the root watch erroring tells the listener something moved', async () => {
    const w = world({ [ROOT]: [] })
    await settle()
    w.opened[0].fail()
    expect(w.events).toContainEqual(['rename', null])
    w.handle.close()
  })
})

describe('defaults (the real async readdir and lstat)', () => {
  it('lists only real directories: files, links and junctions are not subscribed', async () => {
    const fs = await import('fs')
    const os = await import('os')
    const path = await import('path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-scoped-'))
    try {
      fs.mkdirSync(path.join(dir, 'src'))
      fs.mkdirSync(path.join(dir, 'other'))
      fs.mkdirSync(path.join(dir, 'node_modules'))
      fs.writeFileSync(path.join(dir, 'package.json'), '{}')
      let linked = false
      try {
        fs.symlinkSync(path.join(dir, 'other'), path.join(dir, 'link'), 'junction')
        linked = true
      } catch { /* no permission to make links here */ }
      const opened: string[] = []
      const fsWatch: ScopedFsWatchFn = (p) => { opened.push(path.relative(dir, p) || '.'); return { close() {} } }
      const h = scopedRecursiveWatch(fsWatch, dir, () => {}, { caseInsensitive: false })
      await vi.waitFor(() => expect(opened.length).toBeGreaterThanOrEqual(3), { timeout: 15_000, interval: 25 })
      await new Promise((r) => setTimeout(r, 100))
      expect(opened.sort()).toEqual(['.', 'other', 'src'])
      if (linked) expect(opened).not.toContain('link')
      h.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an unreadable root falls back, with the real readdir', async () => {
    const opened: Array<{ p: string; recursive: boolean }> = []
    const fsWatch: ScopedFsWatchFn = (p, o) => { opened.push({ p, recursive: !!o.recursive }); return { close() {} } }
    const h = scopedRecursiveWatch(fsWatch, join('/definitely/not/here', String(process.pid)), () => {}, { caseInsensitive: false })
    await vi.waitFor(() => expect(h.fellBack).toBe(true), { timeout: 15_000, interval: 25 })
    expect(opened.map((o) => o.recursive)).toEqual([false, true])
    h.close()
  })

  it('uses setImmediate to yield by default, and the real lstat to look at a new name', async () => {
    const fs = await import('fs')
    const os = await import('os')
    const path = await import('path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-scoped-'))
    try {
      const opened: string[] = []
      let rootListener: Listener = () => {}
      const fsWatch: ScopedFsWatchFn = (p, _o, l) => { if (p === dir) rootListener = l; opened.push(path.relative(dir, p) || '.'); return { close() {} } }
      const h = scopedRecursiveWatch(fsWatch, dir, () => {}, { caseInsensitive: false })
      await new Promise((r) => setTimeout(r, 50))
      fs.mkdirSync(path.join(dir, 'fresh'))
      fs.writeFileSync(path.join(dir, 'file.txt'), 'x')
      rootListener('rename', 'file.txt')
      rootListener('rename', 'vanished') // not there any more: the real lstat throws, which is just "not a directory"
      rootListener('rename', 'fresh')
      await vi.waitFor(() => expect(opened).toContain('fresh'), { timeout: 15_000, interval: 25 })
      expect(opened).not.toContain('file.txt')
      expect(opened).not.toContain('vanished')
      h.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('openScopedGitWatch', () => {
  function gitWorld() {
    const opened: Array<{ path: string; opts: { recursive?: boolean; persistent?: boolean }; listener: Listener }> = []
    const fsWatch: ScopedFsWatchFn = (p, o, l) => { opened.push({ path: p, opts: o, listener: l }); return { close() {} } }
    const rel = (base: string): string[] => opened.map((o) => o.path.slice(base.length + 1) || '.')
    return { opened, fsWatch, rel }
  }
  const hooks = (list: string[]): ScopedWatchOptions => ({ listDirs: async () => list, statDir: async (p) => p, yieldToLoop: async () => {}, caseInsensitive: false })

  it('a non-recursive watch is passed straight to fs.watch', () => {
    const g = gitWorld()
    const l = vi.fn()
    openScopedGitWatch(g.fsWatch, join('/repo', 'x'), { recursive: false, persistent: false }, l)
    expect(g.opened).toHaveLength(1)
    expect(g.opened[0].listener).toBe(l)
    expect(g.opened[0].opts).toEqual({ recursive: false, persistent: false })
  })

  it('a recursive watch of .git skips objects, logs and worktrees, and keeps refs, hooks and modules', async () => {
    const gitDir = join('/repo', '.git')
    const g = gitWorld()
    const h = openScopedGitWatch(g.fsWatch, gitDir, { recursive: true, persistent: false }, () => {}, undefined,
      hooks(['objects', 'logs', 'refs', 'worktrees', 'hooks', 'modules']))
    await settle()
    expect(g.rel(gitDir)).toEqual(['.', 'refs', 'hooks', 'modules'])
    expect(g.opened.every((o) => o.opts.persistent === false)).toBe(true)
    expect(GIT_DIR_SKIP).toEqual(['objects', 'logs', 'worktrees'])
    h.close()
  })

  it('.git is recognised with a trailing separator and in either spelling, and a name that merely ends in .git is not', async () => {
    for (const target of [join('/repo', '.git') + sep, 'C:\\Users\\d\\repo\\.git', 'C:/Users/d/repo/.git', '.git']) {
      const g = gitWorld()
      const h = openScopedGitWatch(g.fsWatch, target, { recursive: true }, () => {}, undefined, hooks(['objects', 'refs']))
      await settle()
      expect(g.opened.map((o) => o.path)).not.toContainEqual(expect.stringMatching(/objects/))
      expect(g.opened.some((o) => /refs$/.test(o.path))).toBe(true)
      h.close()
    }
    const g = gitWorld()
    const h = openScopedGitWatch(g.fsWatch, join('/repo', 'repo.git'), { recursive: true }, () => {}, undefined, hooks(['objects', 'refs']))
    await settle()
    expect(g.opened.some((o) => /objects$/.test(o.path))).toBe(true) // an ordinary tree called repo.git
    h.close()
  })

  it('a recursive watch of a working tree skips only what every watcher skips; its .claude is expanded, .git\'s is not', async () => {
    const g = gitWorld()
    const tree = join('/repo')
    const h = openScopedGitWatch(g.fsWatch, tree, { recursive: true, persistent: false }, () => {}, undefined,
      hooks(['src', '.worktrees', 'objects', 'node_modules', '.git']))
    await settle()
    expect(g.rel(tree)).toEqual(['.', 'src', 'objects']) // `objects` is a perfectly good folder name in a working tree
    h.close()
  })

  it('a flood of events in the repository\'s own objects and logs has nowhere to arrive: no watch is open on them', async () => {
    const gitDir = join('/repo', '.git')
    const g = gitWorld()
    const events: string[] = []
    const h = openScopedGitWatch(g.fsWatch, gitDir, { recursive: true, persistent: false }, (e, f) => { events.push(`${e}:${f}`) }, undefined,
      hooks(['objects', 'logs', 'refs', 'worktrees']))
    await settle()
    const open = g.opened.map((o) => o.path.slice(gitDir.length + 1))
    expect(open.some((p) => /^(objects|logs|worktrees)/.test(p))).toBe(false)
    // what IS open delivers what matters, named as a recursive watch of .git would name it
    g.opened.find((o) => o.path.endsWith('refs'))!.listener('change', 'heads' + sep + 'main')
    g.opened[0].listener('change', 'index')
    expect(events).toEqual([`change:refs${sep}heads${sep}main`, 'change:index'])
    h.close()
  })
})

describe('scopedTriggerWatch', () => {
  it('opens the project root non-recursively, and hands back a close()', () => {
    const opened: Array<{ path: string; recursive?: boolean; closed: number }> = []
    const fsWatch: ScopedFsWatchFn = (p, o) => {
      const rec = { path: p, recursive: o.recursive, closed: 0 }
      opened.push(rec)
      return { close() { rec.closed++ } }
    }
    const handle = scopedTriggerWatch(fsWatch)(ROOT, () => {})
    expect(opened[0]).toMatchObject({ path: ROOT, recursive: false })
    handle.close()
    expect(opened[0].closed).toBe(1)
    expect(TRIGGER_SKIP_NAMES).toEqual(['.termpolis', 'Pods', '.turbo'])
    expect(CODE_SKIP_NAMES).toEqual(['Pods', '.turbo'])
  })

  it('skips .termpolis (the supervisor\'s own state would retrigger it forever) through the skip list it is built with', async () => {
    const opened: string[] = []
    const fsWatch: ScopedFsWatchFn = (p) => { opened.push(p); return { close() {} } }
    const h = scopedRecursiveWatch(fsWatch, ROOT, () => {}, {
      skipNames: TRIGGER_SKIP_NAMES, caseInsensitive: false, yieldToLoop: async () => {}, statDir: async (p) => p,
      listDirs: async () => ['src', '.termpolis', 'Pods', '.turbo'],
    })
    await settle()
    expect(opened.map((p) => p.slice(ROOT.length + 1) || '.')).toEqual(['.', 'src'])
    h.close()
  })
})
