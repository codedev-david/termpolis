import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  registerWebglPane,
  setWebglPaneVisible,
  resetWebglBudget,
  MAX_WEBGL_CONTEXTS,
} from '../../src/renderer/src/lib/webglBudget'

/**
 * A stand-in for one TerminalPane's GPU renderer.
 *
 * `held` is the assertion target throughout: the budget's whole job is deciding which
 * panes own a live WebGL context at any moment, and a pane that is told to acquire twice
 * or release twice would leak or double-dispose a real addon.
 */
function fakePane() {
  const p = {
    held: false,
    acquires: 0,
    releases: 0,
    acquire: () => { p.held = true; p.acquires++ },
    release: () => { p.held = false; p.releases++ },
  }
  return p
}

const heldCount = (panes: ReturnType<typeof fakePane>[]) => panes.filter(p => p.held).length

beforeEach(() => {
  resetWebglBudget()
})

describe('WebGL context budget', () => {
  // The bug this exists for. TabView mounts EVERY non-hidden terminal at once, and each
  // pane used to take a WebGL context at mount and hold it until the terminal closed.
  // Chromium allows only ~16 live contexts per process and silently evicts the oldest
  // when you ask for more — no exception, no console warning. So opening a 17th terminal
  // quietly stopped the first one from painting, and the only symptom was a terminal that
  // had gone blank for no visible reason.
  it('never holds more contexts than the budget allows', () => {
    const panes = Array.from({ length: MAX_WEBGL_CONTEXTS + 5 }, () => fakePane())
    panes.forEach((p, i) => {
      registerWebglPane(`t${i}`, p)
      setWebglPaneVisible(`t${i}`, true)
      setWebglPaneVisible(`t${i}`, false)
    })
    expect(heldCount(panes)).toBeLessThanOrEqual(MAX_WEBGL_CONTEXTS)
  })

  // Retention is for panes you have actually looked at. A terminal that has never been
  // on screen — a background agent, a session restored on launch — must cost nothing:
  // twenty of those at startup would otherwise fill the whole budget speculatively and
  // evict each other before you ever saw one.
  it('gives nothing to a pane that has never been visible', () => {
    const panes = Array.from({ length: 3 }, () => fakePane())
    panes.forEach((p, i) => {
      registerWebglPane(`bg${i}`, p)
      setWebglPaneVisible(`bg${i}`, false)
    })
    expect(heldCount(panes)).toBe(0)
  })

  it('gives a pane a context as soon as it becomes visible', () => {
    const p = fakePane()
    registerWebglPane('t1', p)
    expect(p.held).toBe(false)
    setWebglPaneVisible('t1', true)
    expect(p.held).toBe(true)
  })

  // Switching tabs must not thrash the GPU: creating a context costs real milliseconds,
  // so a pane you just left keeps its context until something else actually needs one.
  it('lets a hidden pane keep its context while there is room', () => {
    const a = fakePane()
    const b = fakePane()
    registerWebglPane('a', a)
    registerWebglPane('b', b)
    setWebglPaneVisible('a', true)
    setWebglPaneVisible('a', false)
    setWebglPaneVisible('b', true)

    expect(b.held).toBe(true)
    expect(a.held).toBe(true)
    expect(a.releases).toBe(0)
  })

  // Under pressure the pane you looked at longest ago is the one to give up, because it
  // is the one you are least likely to switch back to next.
  it('evicts the least recently visible pane first', () => {
    const panes: ReturnType<typeof fakePane>[] = []
    for (let i = 0; i < MAX_WEBGL_CONTEXTS; i++) {
      const p = fakePane()
      panes.push(p)
      registerWebglPane(`t${i}`, p)
      setWebglPaneVisible(`t${i}`, true)
      setWebglPaneVisible(`t${i}`, false)
    }
    expect(heldCount(panes)).toBe(MAX_WEBGL_CONTEXTS)

    const newcomer = fakePane()
    registerWebglPane('new', newcomer)
    setWebglPaneVisible('new', true)

    expect(newcomer.held).toBe(true)
    expect(panes[0].held).toBe(false)
    expect(panes[panes.length - 1].held).toBe(true)
  })

  // A visible pane is being looked at RIGHT NOW. Taking its context to give to a hidden
  // one would blank the only terminal on screen — the exact bug this module prevents.
  it('never evicts a visible pane to make room', () => {
    const visible: ReturnType<typeof fakePane>[] = []
    for (let i = 0; i < MAX_WEBGL_CONTEXTS; i++) {
      const p = fakePane()
      visible.push(p)
      registerWebglPane(`v${i}`, p)
      setWebglPaneVisible(`v${i}`, true)
    }
    const hidden = fakePane()
    registerWebglPane('h', hidden)
    setWebglPaneVisible('h', true)
    setWebglPaneVisible('h', false)

    expect(visible.every(p => p.held)).toBe(true)
  })

  it('re-acquires a context when an evicted pane is looked at again', () => {
    const panes: ReturnType<typeof fakePane>[] = []
    for (let i = 0; i < MAX_WEBGL_CONTEXTS + 1; i++) {
      const p = fakePane()
      panes.push(p)
      registerWebglPane(`t${i}`, p)
      setWebglPaneVisible(`t${i}`, true)
      setWebglPaneVisible(`t${i}`, false)
    }
    expect(panes[0].held).toBe(false)

    setWebglPaneVisible('t0', true)
    expect(panes[0].held).toBe(true)
  })

  // Double-acquire on a live addon leaks a context; double-release throws inside xterm's
  // teardown. Both are silent in a browser, so they are pinned here instead.
  it('never tells a pane to acquire or release twice in a row', () => {
    const p = fakePane()
    registerWebglPane('t1', p)
    setWebglPaneVisible('t1', true)
    setWebglPaneVisible('t1', true)
    expect(p.acquires).toBe(1)

    setWebglPaneVisible('t1', false)
    setWebglPaneVisible('t1', false)
    expect(p.releases).toBe(0) // still within budget — nothing forced it out
  })

  it('releases the context when a pane unregisters, and frees the slot', () => {
    const panes: ReturnType<typeof fakePane>[] = []
    const offs: (() => void)[] = []
    for (let i = 0; i < MAX_WEBGL_CONTEXTS; i++) {
      const p = fakePane()
      panes.push(p)
      offs.push(registerWebglPane(`t${i}`, p))
      setWebglPaneVisible(`t${i}`, true)
      setWebglPaneVisible(`t${i}`, false)
    }

    offs[0]()
    expect(panes[0].held).toBe(false)

    // The freed slot is usable: a newcomer gets it without evicting anyone else.
    const newcomer = fakePane()
    registerWebglPane('new', newcomer)
    setWebglPaneVisible('new', true)
    expect(newcomer.held).toBe(true)
    expect(panes.slice(1).every(p => p.held)).toBe(true)
  })

  it('ignores visibility changes for a pane it has never heard of', () => {
    expect(() => setWebglPaneVisible('ghost', true)).not.toThrow()
  })

  // A pane whose acquire throws (a driver refusing a context) must not take the budget
  // down with it, and must not be recorded as holding something it does not have.
  it('survives a pane that cannot get a context', () => {
    const bad = { acquire: () => { throw new Error('no GL for you') }, release: () => {} }
    registerWebglPane('bad', bad)
    expect(() => setWebglPaneVisible('bad', true)).not.toThrow()

    const good = fakePane()
    registerWebglPane('good', good)
    setWebglPaneVisible('good', true)
    expect(good.held).toBe(true)
  })

  it('releases everything on reset', () => {
    const p = fakePane()
    registerWebglPane('t1', p)
    setWebglPaneVisible('t1', true)
    resetWebglBudget()
    expect(p.held).toBe(false)
  })
})
