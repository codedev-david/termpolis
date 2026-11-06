// 1.54.5 wire step: the kill switch for lane M's watcher changes. TERMPOLIS_SCOPED_WATCH=0 (off/false/no) brings back
// the 1.54.4 subscriptions: one plain recursive fs.watch of the root for the code index, the git dot and workflow file
// triggers (no scoped set of sub-watches), and a plain watch with no storm shedding wherever shedWatch.ts wraps one.
// Counted with a fake fs.watch: which watches open, with what options, and how many events reach the listener.

import { describe, it, expect } from 'vitest'
import { scopedRecursiveWatch, openScopedGitWatch, type ScopedFsWatchFn } from '../../src/main/scopedWatch'
import { openSheddingWatch, scopedWatchDisabled, SCOPED_WATCH_ENV, SHED_EVENTS_PER_SECOND } from '../../src/main/shedWatch'

type Listener = (event: string, filename: string | Buffer | null) => void

function fakeFs() {
  const opened: Array<{ path: string; recursive: boolean; persistent?: boolean; listener: Listener; closed: boolean; onError: Array<(e: unknown) => void> }> = []
  const fsWatch: ScopedFsWatchFn = (path, o, listener) => {
    const w = { path, recursive: !!o.recursive, persistent: o.persistent, listener, closed: false, onError: [] as Array<(e: unknown) => void> }
    opened.push(w)
    return {
      close: () => { w.closed = true },
      on: (_ev: 'error', l: (e: unknown) => void) => { w.onError.push(l); return undefined },
    }
  }
  return { opened, fsWatch }
}

const OFF = { [SCOPED_WATCH_ENV]: '0' }
const ON = {}

describe('scopedWatchDisabled: how the switch is read', () => {
  it('0, off, false and no (any case, any padding) turn it off; anything else leaves the 1.54.5 watchers on', () => {
    for (const v of ['0', 'off', 'OFF', ' false ', 'No']) expect(scopedWatchDisabled({ [SCOPED_WATCH_ENV]: v })).toBe(true)
    for (const v of [undefined, '', '1', 'on', 'yes', 'scoped']) expect(scopedWatchDisabled({ [SCOPED_WATCH_ENV]: v })).toBe(false)
    expect(scopedWatchDisabled({})).toBe(false)
  })
})

describe('scopedRecursiveWatch with the switch off: the one recursive watch of 1.54.4', () => {
  it('opens exactly one watch, recursive, on the root, never lists a directory, and hands every event through', async () => {
    const { opened, fsWatch } = fakeFs()
    let listed = 0
    const got: Array<[string, string | null]> = []
    const w = scopedRecursiveWatch(fsWatch, '/repo', (e, f) => got.push([e, f]), {
      env: OFF, persistent: false, listDirs: async () => { listed++; return ['src', 'node_modules', '.worktrees'] },
      yieldToLoop: async () => {},
    })
    await new Promise((r) => setImmediate(r))
    expect(opened.map((o) => [o.path, o.recursive, o.persistent])).toEqual([['/repo', true, false]])
    expect(listed).toBe(0)
    expect(w.subscriptions).toBe(0)
    expect(w.fellBack).toBe(true)
    // No storm shedding either: 5x the shedding limit in one burst all reaches the listener (and Buffers become text).
    for (let i = 0; i < SHED_EVENTS_PER_SECOND * 5; i++) opened[0].listener('change', i === 0 ? Buffer.from('a.ts') : `node_modules/x${i}.js`)
    expect(got).toHaveLength(SHED_EVENTS_PER_SECOND * 5)
    expect(got[0]).toEqual(['change', 'a.ts'])
    expect(opened).toHaveLength(1)
    // An OS error is a look-again, as the scoped watch reports one.
    opened[0].onError.forEach((l) => l(new Error('EPERM')))
    expect(opened[0].closed).toBe(true)
    expect(got[got.length - 1]).toEqual(['rename', null])
    w.close()
    w.close()
  })

  it('control: with the switch unset it scopes (root non-recursive first, then one recursive watch per wanted directory)', async () => {
    const { opened, fsWatch } = fakeFs()
    const w = scopedRecursiveWatch(fsWatch, '/repo', () => {}, {
      env: ON, listDirs: async () => ['src', 'node_modules', '.worktrees'], statDir: async (p) => p, yieldToLoop: async () => {},
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(opened[0]).toMatchObject({ path: '/repo', recursive: false })
    expect(opened.filter((o) => o.recursive)).toHaveLength(1) // src only; node_modules and .worktrees are never subscribed
    expect(w.fellBack).toBe(false)
    w.close()
  })

  it('the git rail takes the switch through its extra options too', async () => {
    const { opened, fsWatch } = fakeFs()
    const w = openScopedGitWatch(fsWatch, '/repo/.git', { recursive: true }, () => {}, undefined, { env: OFF, listDirs: async () => ['objects', 'refs'] })
    await new Promise((r) => setImmediate(r))
    expect(opened.map((o) => [o.path, o.recursive])).toEqual([['/repo/.git', true]])
    w.close()
  })

  it('a first open that throws is the caller\'s, exactly as with the plain fs.watch', () => {
    const fsWatch: ScopedFsWatchFn = () => { throw new Error('ENOENT') }
    expect(() => scopedRecursiveWatch(fsWatch, '/gone', () => {}, { env: OFF })).toThrow('ENOENT')
  })
})

describe('openSheddingWatch with the switch off: a plain watch that never sheds', () => {
  it('delivers every event of a storm, never closes or reopens, and passes error listeners and close straight through', () => {
    const { opened, fsWatch } = fakeFs()
    let delivered = 0
    let resumed = 0
    const w = openSheddingWatch(fsWatch, '/t/session.jsonl', { persistent: false }, () => { delivered++ }, {
      env: OFF, onResume: () => { resumed++ }, now: () => 0, setTimer: () => 0, clearTimer: () => {},
    })
    for (let i = 0; i < SHED_EVENTS_PER_SECOND * 10; i++) opened[0].listener('change', 'session.jsonl')
    expect(delivered).toBe(SHED_EVENTS_PER_SECOND * 10)
    expect(w.shed).toBe(false)
    expect(w.sheds).toBe(0)
    expect(resumed).toBe(0)
    expect(opened).toHaveLength(1)
    const errs: unknown[] = []
    expect(w.on('error', (e) => errs.push(e))).toBe(w)
    opened[0].onError.forEach((l) => l('boom'))
    expect(errs).toEqual(['boom'])
    w.close()
    expect(opened[0].closed).toBe(true)
  })

  it('control: with the switch unset the same storm is cut off at the limit and the watch is closed', () => {
    const { opened, fsWatch } = fakeFs()
    let delivered = 0
    const w = openSheddingWatch(fsWatch, '/t/session.jsonl', {}, () => { delivered++ }, {
      env: ON, now: () => 0, setTimer: () => 0, clearTimer: () => {},
    })
    for (let i = 0; i < SHED_EVENTS_PER_SECOND * 10; i++) opened[0].listener('change', 'session.jsonl')
    expect(delivered).toBeLessThanOrEqual(SHED_EVENTS_PER_SECOND)
    expect(w.shed).toBe(true)
    expect(opened[0].closed).toBe(true)
    w.close()
  })
})
