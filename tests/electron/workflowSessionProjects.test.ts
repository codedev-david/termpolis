import { describe, it, expect } from 'vitest'
import { sessionProjectCwds } from '../../src/main/workflow/sessionProjects'

// ---------------------------------------------------------------------------
// v1.32.1 — the boot fan-out. At launch the supervisor arms the home store plus
// every project the last session had open, because the sidebar only registers a
// project once you LOOK at it — far too late for a nightly cron in a repo you
// never click into. If this list comes back short, automatic triggers silently
// stop working and nothing in the app reports it, so every branch is pinned.
// ---------------------------------------------------------------------------

const HOME = '/home/dev'

describe('sessionProjectCwds', () => {
  it('always includes the home store, even with no session at all', () => {
    expect(sessionProjectCwds(null, HOME)).toEqual([HOME])
    expect(sessionProjectCwds(undefined, HOME)).toEqual([HOME])
  })

  it('puts home first so the fallback project arms before anything else', () => {
    const s = { terminals: [{ cwd: '/repos/alpha' }] }
    expect(sessionProjectCwds(s, HOME)).toEqual([HOME, '/repos/alpha'])
  })

  it('collects loose terminals', () => {
    const s = { terminals: [{ cwd: '/repos/alpha' }, { cwd: '/repos/beta' }] }
    expect(sessionProjectCwds(s, HOME)).toEqual([HOME, '/repos/alpha', '/repos/beta'])
  })

  it('collects workspace terminals too — a cron in a workspace repo must arm', () => {
    const s = {
      terminals: [],
      workspaces: [{ terminals: [{ cwd: '/repos/gamma' }] }, { terminals: [{ cwd: '/repos/delta' }] }],
    }
    expect(sessionProjectCwds(s, HOME)).toEqual([HOME, '/repos/gamma', '/repos/delta'])
  })

  it('keeps loose terminals ahead of workspace terminals, in first-seen order', () => {
    const s = {
      terminals: [{ cwd: '/repos/alpha' }],
      workspaces: [{ terminals: [{ cwd: '/repos/gamma' }] }],
    }
    expect(sessionProjectCwds(s, HOME)).toEqual([HOME, '/repos/alpha', '/repos/gamma'])
  })

  it('de-duplicates a directory opened in several terminals — watchProject once', () => {
    const s = {
      terminals: [{ cwd: '/repos/alpha' }, { cwd: '/repos/alpha' }],
      workspaces: [{ terminals: [{ cwd: '/repos/alpha' }] }],
    }
    expect(sessionProjectCwds(s, HOME)).toEqual([HOME, '/repos/alpha'])
  })

  it('does not re-emit home when a terminal is sitting in it', () => {
    const s = { terminals: [{ cwd: HOME }, { cwd: '/repos/alpha' }] }
    expect(sessionProjectCwds(s, HOME)).toEqual([HOME, '/repos/alpha'])
  })

  it('skips terminals with no cwd rather than arming ""', () => {
    const s = { terminals: [{ cwd: '' }, {}, { cwd: '/repos/alpha' }] }
    expect(sessionProjectCwds(s, HOME)).toEqual([HOME, '/repos/alpha'])
  })

  it('skips a whitespace-only cwd', () => {
    const s = { terminals: [{ cwd: '   ' }, { cwd: '/repos/alpha' }] }
    expect(sessionProjectCwds(s, HOME)).toEqual([HOME, '/repos/alpha'])
  })

  it('trims a cwd so " /repos/a" and "/repos/a" are one project', () => {
    const s = { terminals: [{ cwd: ' /repos/alpha ' }, { cwd: '/repos/alpha' }] }
    expect(sessionProjectCwds(s, HOME)).toEqual([HOME, '/repos/alpha'])
  })

  it('ignores a non-string cwd from a hand-edited session file', () => {
    const s = { terminals: [{ cwd: 42 }, { cwd: null }, { cwd: { path: '/x' } }, { cwd: '/repos/alpha' }] }
    expect(sessionProjectCwds(s as never, HOME)).toEqual([HOME, '/repos/alpha'])
  })

  it('survives a session missing terminals/workspaces entirely', () => {
    expect(sessionProjectCwds({}, HOME)).toEqual([HOME])
  })

  it('survives terminals/workspaces being the wrong type', () => {
    expect(sessionProjectCwds({ terminals: 'nope', workspaces: 7 } as never, HOME)).toEqual([HOME])
  })

  it('survives a workspace whose terminals array is missing or wrong', () => {
    const s = { workspaces: [{}, { terminals: null }, { terminals: [{ cwd: '/repos/gamma' }] }] }
    expect(sessionProjectCwds(s as never, HOME)).toEqual([HOME, '/repos/gamma'])
  })

  it('tolerates null entries inside the arrays', () => {
    const s = { terminals: [null, { cwd: '/repos/alpha' }], workspaces: [null, { terminals: [null] }] }
    expect(sessionProjectCwds(s as never, HOME)).toEqual([HOME, '/repos/alpha'])
  })

  it('returns a plain array of strings — the exact argument watchProject takes', () => {
    const out = sessionProjectCwds({ terminals: [{ cwd: '/repos/alpha' }] }, HOME)
    expect(Array.isArray(out)).toBe(true)
    expect(out.every(c => typeof c === 'string' && c.length > 0)).toBe(true)
  })

  it('scales to a session with many repos without dropping any', () => {
    const cwds = Array.from({ length: 50 }, (_, i) => `/repos/r${i}`)
    const s = { terminals: cwds.map(cwd => ({ cwd })) }
    expect(sessionProjectCwds(s, HOME)).toEqual([HOME, ...cwds])
  })
})
