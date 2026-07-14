import React from 'react'
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { VectorRamPanel, quantizationAdvice } from '../../src/renderer/src/components/SettingsPane/VectorRamPanel'

// The panel is a DECISION AID, not a switch. The tests that matter are the ones proving it will tell
// the user NOT to enable the thing it controls — because a control that only ever markets itself is
// an upsell, and here a wrong "yes" quietly approximates the one thing the brain exists to do, for a
// saving the user cannot feel.
//
// And the tests that matter just as much are the ones proving it costs nothing to look at. The
// v1.25.5 version of this panel polled live process health every 2 s off the thread that echoes
// keystrokes and was part of what froze the app. What is left reads a vector COUNT, once, when you
// open the tab. `it never polls` below is not a nicety — it is the reason this panel is allowed to
// exist at all.

const MB = 1048576

/** 14,170 × 384 × 4 B ≈ 21 MB — David's real store, and the case the whole panel is built to answer. */
const payload = (over: Record<string, unknown> = {}) => ({
  vectors: 14_170,
  dim: 384,
  quantized: false,
  ramBytes: 14_170 * 384 * 4,
  ramBytesFloat: 14_170 * 384 * 4,
  ramBytesInt8: 14_170 * 384,
  persisted: false,
  ...over,
})

/** A corpus big enough that the RAM is worth mentioning (past the 256 MB floor). */
const bigPayload = (over: Record<string, unknown> = {}) =>
  payload({ vectors: 900_000, ramBytes: 1300 * MB, ramBytesFloat: 1300 * MB, ramBytesInt8: 325 * MB, ...over })

let getRam: ReturnType<typeof vi.fn>
let setQuant: ReturnType<typeof vi.fn>

/**
 * A faithful fake of main. The setter REBUILDS the packed store, so the next read reports the new
 * mode — a fake whose reader kept answering with the old one would let a component that ignores the
 * rebuild pass, which is precisely the bug worth catching.
 */
function mockApi(data: Record<string, unknown> = payload()) {
  let live: Record<string, unknown> = { ...data }
  getRam = vi.fn(async () => ({ success: true, data: live }))
  setQuant = vi.fn(async (on: boolean) => {
    live = { ...live, quantized: on, persisted: on, ramBytes: on ? live.ramBytesInt8 : live.ramBytesFloat }
    return { success: true, data: live }
  })
  ;(window as any).termpolis = { memoryGetVectorRam: getRam, memorySetVectorQuantize: setQuant }
}

beforeEach(() => { mockApi() })
afterEach(() => { cleanup(); delete (window as any).termpolis; vi.useRealTimers(); vi.restoreAllMocks() })

// ============================================================================================
// The cost of the panel itself. This is the section that keeps v1.25.16 from happening twice.
// ============================================================================================
describe('VectorRamPanel — it must be free to look at', () => {
  it('NEVER polls — the read happens on open, and then not again', async () => {
    vi.useFakeTimers()
    render(<VectorRamPanel />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(getRam).toHaveBeenCalledTimes(1) // the tab was opened

    // Five minutes of a mounted, idle panel. The old one would have read 150 times by here, each
    // read dragging live RSS/heap/GC numbers off the thread that echoes the user's keystrokes.
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000) })
    expect(getRam).toHaveBeenCalledTimes(1)
  })

  it('re-reads when Refresh is pressed (the refreshToken changes) — and only then', async () => {
    const { rerender } = render(<VectorRamPanel refreshToken={0} />)
    await screen.findByTestId('vector-ram-panel')
    expect(getRam).toHaveBeenCalledTimes(1)

    rerender(<VectorRamPanel refreshToken={0} />) // a plain re-render is not a Refresh
    expect(getRam).toHaveBeenCalledTimes(1)

    rerender(<VectorRamPanel refreshToken={1} />) // this is
    await waitFor(() => expect(getRam).toHaveBeenCalledTimes(2))
  })

  it('asks the main process for a COUNT, never for process health', async () => {
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    // The bridge exposes exactly one read, it takes no arguments, and everything the verdict needs
    // is derived from what it returns. If a health read is ever added back, this fails.
    expect(getRam).toHaveBeenCalledWith()
    expect((window as any).termpolis.memoryGetStalls).toBeUndefined()
  })

  it('does not read again on unmount, and never sets state after it', async () => {
    const { unmount } = render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    unmount()
    expect(getRam).toHaveBeenCalledTimes(1)
  })

  it('an in-flight read that lands after unmount is dropped, not written into a dead tree', async () => {
    let resolve!: (v: unknown) => void
    const slow = vi.fn(() => new Promise((r) => { resolve = r }))
    ;(window as any).termpolis = { memoryGetVectorRam: slow }
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { unmount } = render(<VectorRamPanel />)
    unmount()
    await act(async () => { resolve({ success: true, data: payload() }) })

    expect(errSpy).not.toHaveBeenCalled() // no "setState on an unmounted component"
  })
})

// ============================================================================================
// The verdict IS the product.
// ============================================================================================
describe('VectorRamPanel — the verdict', () => {
  it("not-needed: at a real-world corpus it tells the user to leave the toggle alone", async () => {
    render(<VectorRamPanel />)
    const v = await screen.findByTestId('vector-ram-verdict')
    expect(v.textContent).toMatch(/not needed/i)
    expect(v.textContent).toMatch(/14,170 vectors use only 21 MB/)
    expect(v.textContent).toMatch(/would free about 16 MB/)
    expect(v.textContent).toMatch(/not enough to change anything/i)
    expect(v.textContent).toMatch(/leave it off/i)
  })

  // THE INTEGRITY TEST. The panel owns a toggle and its standing answer is "don't".
  it('says NO by default — the arithmetic, not a mood', () => {
    const a = quantizationAdvice(payload() as never)
    expect(a.verdict).toBe('not-needed')
    expect(a.savingBytes).toBe(14_170 * 384 * 3) // float32 - int8, exactly
  })

  it('optional: a large corpus gets the number, but no push and no invented harm', async () => {
    mockApi(bigPayload())
    render(<VectorRamPanel />)
    const v = await screen.findByTestId('vector-ram-verdict')
    expect(v.textContent).toMatch(/your call/i)
    expect(v.textContent).toMatch(/1\.27 GB/)          // GB, not "1300 MB"
    expect(v.textContent).toMatch(/free about 975 MB/)
    // It must NOT claim to know the RAM is hurting them — it cannot see the main thread any more,
    // and the instrument that could was the freeze.
    expect(v.textContent).toMatch(/does not measure your main thread/i)
    expect(v.textContent).toMatch(/leaving it off is not a mistake/i)
  })

  it('enabled: reassures that switching back loses nothing', async () => {
    mockApi(bigPayload({ quantized: true, persisted: true, ramBytes: 325 * MB }))
    render(<VectorRamPanel />)
    const v = await screen.findByTestId('vector-ram-verdict')
    expect(v.textContent).toMatch(/int8 on/i)
    expect(v.textContent).toMatch(/int8 is on — vectors are using 325 MB/)
    expect(v.textContent).toMatch(/lose nothing/i)
    expect(quantizationAdvice(bigPayload({ quantized: true }) as never).savingBytes).toBe(0)
    expect((screen.getByTestId('vector-quantize-toggle') as HTMLInputElement).checked).toBe(true)
  })

  it('never reports a negative saving, even if int8 somehow costs more than the current mode', () => {
    const a = quantizationAdvice(payload({ ramBytes: 1000, ramBytesInt8: 4000 }) as never)
    expect(a.savingBytes).toBe(0)
  })
})

// ============================================================================================
// The explanation. This is the paragraph the user actually asked to keep.
// ============================================================================================
describe('VectorRamPanel — what it says about itself', () => {
  it('explains WHERE the vectors live and why that thread is the one that matters', async () => {
    const panel = await (render(<VectorRamPanel />), screen.findByTestId('vector-ram-panel'))
    expect(panel.textContent).toMatch(/Vector memory/)
    expect(panel.textContent).toMatch(/main process/)
    expect(panel.textContent).toMatch(/the same thread that echoes your keystrokes/i)
    expect(panel.textContent).toMatch(/4× less RAM/)
    expect(panel.textContent).toMatch(/benchmarked/i)
    expect(panel.textContent).toMatch(/reversible/i)
  })

  it('states plainly that nothing is destroyed — the claim the whole design rests on', async () => {
    render(<VectorRamPanel />)
    const panel = await screen.findByTestId('vector-ram-panel')
    expect(panel.textContent).toMatch(/nothing is ever destroyed/i)
    expect(panel.textContent).toMatch(/not a data migration/i)
    expect(panel.textContent).toMatch(/off by default/i)
  })
})

// ============================================================================================
// The toggle.
// ============================================================================================
describe('VectorRamPanel — the toggle', () => {
  it('is OFF by default and reflects the live store, not a local guess', async () => {
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    expect((screen.getByTestId('vector-quantize-toggle') as HTMLInputElement).checked).toBe(false)
  })

  it('turning it ON asks main to quantize, and the box follows the STORE back', async () => {
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    fireEvent.click(screen.getByTestId('vector-quantize-toggle'))
    await waitFor(() => expect(setQuant).toHaveBeenCalledWith(true))
    await waitFor(() => expect((screen.getByTestId('vector-quantize-toggle') as HTMLInputElement).checked).toBe(true))
  })

  it('turning it OFF asks main to restore exact floats (the de-implement path)', async () => {
    mockApi(payload({ quantized: true, persisted: true }))
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    fireEvent.click(screen.getByTestId('vector-quantize-toggle'))
    await waitFor(() => expect(setQuant).toHaveBeenCalledWith(false))
  })

  it('says it is rebuilding, and refuses a second click while it is', async () => {
    let finish!: (v: unknown) => void
    const slowSet = vi.fn(() => new Promise((r) => { finish = r }))
    ;(window as any).termpolis = { memoryGetVectorRam: getRam, memorySetVectorQuantize: slowSet }

    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    fireEvent.click(screen.getByTestId('vector-quantize-toggle'))

    const box = await screen.findByTestId('vector-quantize-toggle') as HTMLInputElement
    await waitFor(() => expect(box.disabled).toBe(true))
    expect(screen.getByTestId('vector-ram-panel').textContent).toMatch(/rebuilding/i)

    fireEvent.click(box)                              // a double-click must not queue a second rebuild
    expect(slowSet).toHaveBeenCalledTimes(1)

    await act(async () => { finish({ success: true, data: payload({ quantized: true }) }) })
    await waitFor(() => expect(box.disabled).toBe(false))
  })

  it('re-reads the store after a flip, so the verdict is the rebuilt store\'s own', async () => {
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    expect(getRam).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('vector-quantize-toggle'))
    await waitFor(() => expect(getRam).toHaveBeenCalledTimes(2)) // one read, caused by the user's own click
  })
})

// ============================================================================================
// Failure must be visible. A control that fails silently is worse than no control.
// ============================================================================================
describe('VectorRamPanel — failures are shown, never swallowed', () => {
  it('shows a loading state before the first read lands', () => {
    ;(window as any).termpolis = { memoryGetVectorRam: vi.fn(() => new Promise(() => {})) }
    render(<VectorRamPanel />)
    expect(screen.getByTestId('vector-ram-loading')).toBeInTheDocument()
  })

  it('shows an error rather than a blank panel when the read fails outright', async () => {
    ;(window as any).termpolis = { memoryGetVectorRam: vi.fn(async () => ({ success: false, error: 'no store' })) }
    render(<VectorRamPanel />)
    await waitFor(() => expect(screen.getByTestId('vector-ram-error').textContent).toMatch(/no store/))
    expect(screen.queryByTestId('vector-ram-panel')).toBeNull()
  })

  it('falls back to a readable message when the read fails with no reason given', async () => {
    ;(window as any).termpolis = { memoryGetVectorRam: vi.fn(async () => ({ success: false })) }
    render(<VectorRamPanel />)
    await waitFor(() => expect(screen.getByTestId('vector-ram-error').textContent).toMatch(/could not read vector memory/i))
  })

  it('reports a thrown read (the bridge itself blew up)', async () => {
    ;(window as any).termpolis = { memoryGetVectorRam: vi.fn(async () => { throw new Error('bridge died') }) }
    render(<VectorRamPanel />)
    await waitFor(() => expect(screen.getByTestId('vector-ram-error').textContent).toMatch(/bridge died/))
  })

  it('survives a thrown read with no message', async () => {
    ;(window as any).termpolis = { memoryGetVectorRam: vi.fn(async () => { throw new Error('') }) }
    render(<VectorRamPanel />)
    await waitFor(() => expect(screen.getByTestId('vector-ram-error').textContent).toMatch(/could not read vector memory/i))
  })

  it('does not explode when the bridge is missing entirely', async () => {
    delete (window as any).termpolis
    expect(() => render(<VectorRamPanel />)).not.toThrow()
    await waitFor(() => expect(screen.getByTestId('vector-ram-error')).toBeInTheDocument())
  })

  it('surfaces a failed flip instead of silently pretending it worked', async () => {
    setQuant.mockResolvedValueOnce({ success: false, error: 'int8 rebuild failed: out of memory' })
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    fireEvent.click(screen.getByTestId('vector-quantize-toggle'))
    await waitFor(() => expect(screen.getByTestId('vector-quantize-error').textContent).toMatch(/out of memory/))
  })

  it('falls back to a readable message when the flip fails with no reason given', async () => {
    setQuant.mockResolvedValueOnce({ success: false })
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    fireEvent.click(screen.getByTestId('vector-quantize-toggle'))
    await waitFor(() => expect(screen.getByTestId('vector-quantize-error').textContent).toMatch(/could not change vector precision/i))
  })

  it('reports a thrown flip', async () => {
    setQuant.mockRejectedValueOnce(new Error('store is locked'))
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    fireEvent.click(screen.getByTestId('vector-quantize-toggle'))
    await waitFor(() => expect(screen.getByTestId('vector-quantize-error').textContent).toMatch(/store is locked/))
  })

  it('survives a thrown flip with no message', async () => {
    setQuant.mockRejectedValueOnce(new Error(''))
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    fireEvent.click(screen.getByTestId('vector-quantize-toggle'))
    await waitFor(() => expect(screen.getByTestId('vector-quantize-error').textContent).toMatch(/could not change vector precision/i))
  })

  // THE BUG (found by the v1.25.7 coverage audit, in code we wrote). toggle()'s `finally` fires a
  // `load()`, and a SUCCESSFUL load runs setErr('') — so a toggle error written into the SAME slot
  // was wiped a microtask later. The user clicked the box, it failed, the message flashed and
  // vanished, and they were left watching a checkbox that simply did not move.
  //
  // The 2 s poll that made this obvious is gone. The load-after-toggle it raced is NOT — so the read
  // error and the action error stay in separate slots, and this test stays.
  it('the failed flip survives the successful re-read that immediately follows it', async () => {
    setQuant.mockResolvedValueOnce({ success: false, error: 'int8 rebuild failed: out of memory' })
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')

    fireEvent.click(screen.getByTestId('vector-quantize-toggle'))
    await waitFor(() => expect(getRam).toHaveBeenCalledTimes(2)) // the re-read really did land...
    expect(screen.getByTestId('vector-quantize-error').textContent).toMatch(/out of memory/) // ...and the reason is still on screen
    expect(screen.queryByTestId('vector-ram-error')).toBeNull()  // the READ is fine; don't cry about it
  })

  it('retrying the toggle clears the previous failure — only the user resets it', async () => {
    setQuant.mockResolvedValueOnce({ success: false, error: 'boom' })
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')

    fireEvent.click(screen.getByTestId('vector-quantize-toggle'))
    await waitFor(() => expect(screen.getByTestId('vector-quantize-error').textContent).toMatch(/boom/))

    fireEvent.click(screen.getByTestId('vector-quantize-toggle'))
    await waitFor(() => expect(screen.queryByTestId('vector-quantize-error')).toBeNull())
  })

  it('a Refresh that fails degrades IN PLACE — the last good numbers stay, with the error beside them', async () => {
    const { rerender } = render(<VectorRamPanel refreshToken={0} />)
    await screen.findByTestId('vector-ram-panel')

    getRam.mockResolvedValueOnce({ success: false, error: 'store went away' })
    rerender(<VectorRamPanel refreshToken={1} />)

    // Not a blank panel and not a bare error screen: the verdict the user was reading is still there.
    await waitFor(() => expect(screen.getByTestId('vector-ram-error').textContent).toMatch(/store went away/))
    expect(screen.getByTestId('vector-ram-panel')).toBeInTheDocument()
    expect(screen.getByTestId('vector-ram-verdict').textContent).toMatch(/not needed/i)
  })
})
