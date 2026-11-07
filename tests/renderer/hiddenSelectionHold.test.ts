import { describe, it, expect, vi } from 'vitest'
import { holdHiddenSelectionRepaints } from '../../src/renderer/src/lib/hiddenSelectionHold'

type Args = [[number, number] | undefined, [number, number] | undefined, boolean]

/** A terminal shaped like xterm's internals: `_core._renderService.handleSelectionChanged`, counted. */
const fakeTerm = () => {
  const calls: Args[] = []
  const service = {
    marker: 'render-service',
    handleSelectionChanged(this: { marker: string }, ...a: Args) {
      expect(this.marker).toBe('render-service') // called on the service, not detached
      calls.push(a)
    },
  }
  const original = service.handleSelectionChanged
  return { term: { _core: { _renderService: service } }, service, calls, original }
}

describe('holdHiddenSelectionRepaints', () => {
  it('no xterm internals: no hold, and no throw', () => {
    expect(holdHiddenSelectionRepaints(null)).toBeNull()
    expect(holdHiddenSelectionRepaints(undefined)).toBeNull()
    expect(holdHiddenSelectionRepaints({})).toBeNull()
    expect(holdHiddenSelectionRepaints({ _core: {} })).toBeNull()
    expect(holdHiddenSelectionRepaints({ _core: { _renderService: { handleSelectionChanged: 1 } } })).toBeNull()
  })

  it('shown (the default): every call goes straight through', () => {
    const f = fakeTerm()
    expect(holdHiddenSelectionRepaints(f.term)).not.toBeNull()
    f.service.handleSelectionChanged([0, 0], [3, 0], false)
    f.service.handleSelectionChanged(undefined, undefined, false)
    expect(f.calls).toEqual([[[0, 0], [3, 0], false], [undefined, undefined, false]])
  })

  it('hidden: nothing reaches the renderer; shown again: ONLY the latest is replayed, once', () => {
    const f = fakeTerm()
    const hold = holdHiddenSelectionRepaints(f.term)!
    hold.setHidden(true)
    for (let i = 0; i < 50; i++) f.service.handleSelectionChanged(undefined, undefined, false)
    f.service.handleSelectionChanged([1, 2], [5, 2], true)
    expect(f.calls).toEqual([])
    hold.setHidden(false)
    expect(f.calls).toEqual([[[1, 2], [5, 2], true]])
    hold.setHidden(false) // nothing left to replay
    expect(f.calls).toHaveLength(1)
  })

  it('hidden and shown with nothing in between: no replay', () => {
    const f = fakeTerm()
    const hold = holdHiddenSelectionRepaints(f.term)!
    hold.setHidden(true)
    hold.setHidden(false)
    expect(f.calls).toEqual([])
  })

  it("dispose puts xterm's handler back and drops what was held", () => {
    const f = fakeTerm()
    const hold = holdHiddenSelectionRepaints(f.term)!
    hold.setHidden(true)
    f.service.handleSelectionChanged(undefined, undefined, false)
    hold.dispose()
    expect(f.service.handleSelectionChanged).toBe(f.original)
    expect(f.calls).toEqual([])
    f.service.handleSelectionChanged([0, 0], [1, 0], false)
    expect(f.calls).toHaveLength(1)
  })

  it('dispose leaves a handler someone else installed after it alone', () => {
    const f = fakeTerm()
    const hold = holdHiddenSelectionRepaints(f.term)!
    const later = vi.fn()
    f.service.handleSelectionChanged = later
    hold.dispose()
    expect(f.service.handleSelectionChanged).toBe(later)
  })
})
