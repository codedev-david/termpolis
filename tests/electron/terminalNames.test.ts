import { describe, it, expect } from 'vitest'
import {
  createTerminalNameLookup,
  TERMINAL_NAME_TTL_MS,
  type NamedTerminal,
} from '../../src/main/terminalNames'

function lookup(rows: NamedTerminal[], ttlMs?: number) {
  let clock = 0
  let loads = 0
  let current = rows
  let fail = false
  const name = createTerminalNameLookup({
    load: () => {
      loads++
      if (fail) throw new Error('session file is not JSON')
      return current
    },
    now: () => clock,
    ...(ttlMs === undefined ? {} : { ttlMs }),
  })
  return {
    name,
    get loads() {
      return loads
    },
    advance(ms: number) {
      clock += ms
    },
    replace(next: NamedTerminal[]) {
      current = next
    },
    breakSession() {
      fail = true
    },
  }
}

describe('terminal name lookup', () => {
  it('answers with the name on record', () => {
    const l = lookup([{ id: 't1', name: 'Backend' }])
    expect(l.name('t1')).toBe('Backend')
  })

  it('answers with an empty string for a terminal it has never heard of', () => {
    // '' rather than undefined or a throw: every caller can carry on without a
    // name, and the one caller there is treats it as "run no per-agent rules".
    const l = lookup([{ id: 't1', name: 'Backend' }])
    expect(l.name('nope')).toBe('')
  })

  it('reads the session once for a burst of lookups', () => {
    // The reason this file exists. `loadSession()` is a synchronous file read on
    // the thread that also pumps every PTY in the window.
    const l = lookup([
      { id: 't1', name: 'a' },
      { id: 't2', name: 'b' },
    ])
    l.name('t1')
    l.name('t2')
    l.name('t1')
    expect(l.loads).toBe(1)
  })

  it('picks up a rename once the cache expires', () => {
    const l = lookup([{ id: 't1', name: 'old' }])
    expect(l.name('t1')).toBe('old')
    l.replace([{ id: 't1', name: 'new' }])
    expect(l.name('t1')).toBe('old')

    l.advance(TERMINAL_NAME_TTL_MS)

    expect(l.name('t1')).toBe('new')
    expect(l.loads).toBe(2)
  })

  it('holds the cache right up to the expiry instant', () => {
    // Off-by-one guard: a TTL that expired a millisecond early would be a read
    // per lookup for a caller running on a matching interval.
    const l = lookup([{ id: 't1', name: 'old' }])
    l.name('t1')
    l.replace([{ id: 't1', name: 'new' }])
    l.advance(TERMINAL_NAME_TTL_MS - 1)
    expect(l.name('t1')).toBe('old')
  })

  it('honours an injected TTL', () => {
    const l = lookup([{ id: 't1', name: 'old' }], 10)
    l.name('t1')
    l.replace([{ id: 't1', name: 'new' }])
    l.advance(10)
    expect(l.name('t1')).toBe('new')
  })

  it('answers empty, not throws, when the session will not parse', () => {
    // A corrupt session file is a reason to lose the names, not a reason to stop
    // reporting agent status to a phone.
    const l = lookup([{ id: 't1', name: 'Backend' }])
    l.breakSession()
    expect(l.name('t1')).toBe('')
  })

  it('recovers once the session file parses again', () => {
    const l = lookup([{ id: 't1', name: 'Backend' }])
    l.breakSession()
    expect(l.name('t1')).toBe('')
    // Not "breakSession" undone -- a fresh lookup with a working loader, which is
    // what the next process state looks like after the file is rewritten.
    const healthy = lookup([{ id: 't1', name: 'Backend' }])
    healthy.advance(TERMINAL_NAME_TTL_MS)
    expect(healthy.name('t1')).toBe('Backend')
  })
})
