import React from 'react'
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { VectorRamPanel } from '../../src/renderer/src/components/SettingsPane/VectorRamPanel'

// The panel is a DECISION AID, not a switch. The tests that matter are the ones proving it will
// tell the user NOT to enable the thing it controls — because a control that only ever markets
// itself is an upsell, and here a wrong "yes" quietly approximates the one thing the brain exists
// to do, for a saving the user cannot feel.

const MB = 1048576

const payload = (over: Record<string, unknown> = {}) => ({
  vectors: 106_432,
  dim: 384,
  quantized: false,
  ramBytes: 163 * MB,
  ramBytesFloat: 163 * MB,
  ramBytesInt8: 41 * MB,
  persisted: false,
  health: {
    rssBytes: 900 * MB,
    heapUsedBytes: 200 * MB,
    arrayBufferBytes: 170 * MB,
    loopDelayP50Ms: 1.2,
    loopDelayP99Ms: 4.5,
    loopDelayMaxMs: 9,
    gcMajorCount: 3,
    gcTotalPauseMs: 42,
    gcMaxPauseMs: 18,
    sampleWindowMs: 60_000,
    gcTimeFraction: 0.0007,
  },
  advice: {
    verdict: 'not-needed',
    headline: 'Not needed — your 106,432 vectors use only 163 MB',
    detail: 'Turning int8 on would free about 122 MB, which is not enough to change anything. Leave it off.',
    savingBytes: 122 * MB,
  },
  ...over,
})

let getRam: ReturnType<typeof vi.fn>
let setQuant: ReturnType<typeof vi.fn>

function mockApi(data: Record<string, unknown> = payload()) {
  getRam = vi.fn(async () => ({ success: true, data }))
  setQuant = vi.fn(async (on: boolean) => ({ success: true, data: { ...data, quantized: on, persisted: on } }))
  ;(window as any).termpolis = { memoryGetVectorRam: getRam, memorySetVectorQuantize: setQuant }
}

beforeEach(() => { mockApi() })
afterEach(() => { cleanup(); delete (window as any).termpolis; vi.useRealTimers(); vi.restoreAllMocks() })

describe('VectorRamPanel — live metrics', () => {
  it('shows a loading state before the first read lands', () => {
    ;(window as any).termpolis = { memoryGetVectorRam: vi.fn(() => new Promise(() => {})) }
    render(<VectorRamPanel />)
    expect(screen.getByTestId('vector-ram-loading')).toBeInTheDocument()
  })

  it('renders every live metric once loaded', async () => {
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    for (const id of ['m-vectors', 'm-vector-ram', 'm-rss', 'm-loop', 'm-gc', 'm-gc-share']) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
    expect(screen.getByTestId('m-vectors').textContent).toMatch(/106,432/)
    expect(screen.getByTestId('m-vector-ram').textContent).toMatch(/163 MB/)
    expect(screen.getByTestId('m-vector-ram').textContent).toMatch(/41 MB as int8/)
  })

  it('reports the vectors as a SHARE of the process, not just an absolute', async () => {
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    // 163 of 900 MB ≈ 18%. The share is what decides whether the vectors are the problem.
    expect(screen.getByTestId('m-rss').textContent).toMatch(/18% of it/)
  })

  it('marks a healthy main thread as healthy, and does not cry wolf', async () => {
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    expect(screen.getByTestId('m-loop').textContent).toMatch(/healthy/i)
    expect(screen.getByTestId('m-loop').textContent).toMatch(/4\.5 ms/)
  })

  it('flags a stalling main thread as something you would feel', async () => {
    mockApi(payload({ health: { ...payload().health, loopDelayP99Ms: 180, gcMaxPauseMs: 120 } }))
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    expect(screen.getByTestId('m-loop').textContent).toMatch(/you would feel this/i)
  })

  it('polls live so GC pressure can be watched as a trend', async () => {
    vi.useFakeTimers()
    render(<VectorRamPanel />)
    await vi.advanceTimersByTimeAsync(0)
    expect(getRam).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(getRam).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4000)
    expect(getRam).toHaveBeenCalledTimes(4)
  })

  it('stops polling on unmount (no setState-after-unmount, no leaked interval)', async () => {
    vi.useFakeTimers()
    const { unmount } = render(<VectorRamPanel />)
    await vi.advanceTimersByTimeAsync(0)
    unmount()
    const calls = getRam.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(getRam).toHaveBeenCalledTimes(calls)
  })
})

describe('VectorRamPanel — the verdict is the product', () => {
  it('not-needed: tells the user to leave it alone', async () => {
    render(<VectorRamPanel />)
    const v = await screen.findByTestId('vector-ram-verdict')
    expect(v.textContent).toMatch(/not needed/i)
    expect(v.textContent).toMatch(/leave it off/i)
  })

  // THE INTEGRITY TEST — the panel must be willing to say the toggle it owns is useless to you.
  it("wont-help: admits the stalls are real but says quantizing will NOT fix them", async () => {
    mockApi(payload({
      advice: {
        verdict: 'wont-help',
        headline: 'Your main thread is stalling — but not because of the vectors',
        detail: 'Freeing them would not fix the stalls, and you would lose exactness for nothing. Look elsewhere.',
        savingBytes: 200 * MB,
      },
    }))
    render(<VectorRamPanel />)
    const v = await screen.findByTestId('vector-ram-verdict')
    expect(v.textContent).toMatch(/not because of the vectors/i)
    expect(v.textContent).toMatch(/would not fix the stalls/i)
    expect(v.textContent).toMatch(/won't help/i) // the badge says it too
  })

  it('recommended: only when there is real evidence, and it quotes that evidence', async () => {
    mockApi(payload({
      advice: {
        verdict: 'recommended',
        headline: 'Worth turning on — vectors are 1.46 GB (56% of this process)',
        detail: 'The main thread is pausing (p99 180 ms, longest GC 120 ms). int8 frees about 1.10 GB. Reversible.',
        savingBytes: 1100 * MB,
      },
    }))
    render(<VectorRamPanel />)
    const v = await screen.findByTestId('vector-ram-verdict')
    expect(v.textContent).toMatch(/recommended/i)
    expect(v.textContent).toMatch(/p99 180 ms/)
    expect(v.textContent).toMatch(/reversible/i)
  })

  it('enabled: reassures that switching back loses nothing', async () => {
    mockApi(payload({
      quantized: true,
      advice: { verdict: 'enabled', headline: 'int8 is on', detail: 'You can switch back at any time and lose nothing.', savingBytes: 0 },
    }))
    render(<VectorRamPanel />)
    const v = await screen.findByTestId('vector-ram-verdict')
    expect(v.textContent).toMatch(/lose nothing/i)
    expect((screen.getByTestId('vector-quantize-toggle') as HTMLInputElement).checked).toBe(true)
  })
})

describe('VectorRamPanel — the toggle', () => {
  it('is OFF by default and reflects the live store, not a local guess', async () => {
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    expect((screen.getByTestId('vector-quantize-toggle') as HTMLInputElement).checked).toBe(false)
  })

  it('turning it ON asks main to quantize', async () => {
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    fireEvent.click(screen.getByTestId('vector-quantize-toggle'))
    await waitFor(() => expect(setQuant).toHaveBeenCalledWith(true))
  })

  it('turning it OFF asks main to restore exact floats (the de-implement path)', async () => {
    mockApi(payload({ quantized: true, persisted: true }))
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    fireEvent.click(screen.getByTestId('vector-quantize-toggle'))
    await waitFor(() => expect(setQuant).toHaveBeenCalledWith(false))
  })

  it('states plainly that nothing is destroyed — this is the claim the whole design rests on', async () => {
    render(<VectorRamPanel />)
    const panel = await screen.findByTestId('vector-ram-panel')
    expect(panel.textContent).toMatch(/nothing is ever destroyed/i)
    expect(panel.textContent).toMatch(/not a data migration/i)
  })

  it('surfaces a failure instead of silently pretending the flip worked', async () => {
    setQuant.mockResolvedValueOnce({ success: false, error: 'store is locked' })
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    fireEvent.click(screen.getByTestId('vector-quantize-toggle'))
    await waitFor(() => expect(screen.getByTestId('vector-quantize-error').textContent).toMatch(/store is locked/))
  })

  it('shows an error rather than a blank panel when the read fails outright', async () => {
    ;(window as any).termpolis = { memoryGetVectorRam: vi.fn(async () => ({ success: false, error: 'no store' })) }
    render(<VectorRamPanel />)
    await waitFor(() => expect(screen.getByTestId('vector-ram-error').textContent).toMatch(/no store/))
  })

  it('does not explode when the bridge is missing entirely', async () => {
    delete (window as any).termpolis
    expect(() => render(<VectorRamPanel />)).not.toThrow()
  })
})

describe('VectorRamPanel — a failed flip must not be erased by the next poll', () => {
  // THE BUG (found by the coverage audit, in code I wrote). toggle()'s `finally` fires `void load()`,
  // and a SUCCESSFUL load() runs setErr('') — so a toggle error written into the same slot was wiped
  // a microtask later. The user clicked the box, it failed, the message flashed and vanished, and
  // they were left watching a checkbox that simply did not move. No error, no explanation, nothing.
  //
  // A failure that presents as silence is the exact class of bug this whole release is about. So the
  // read error and the action error are now separate: the poll clears its own, and never the other's.
  //
  // The existing error tests all freeze the panel (a one-shot read that never resolves again), which
  // sidesteps the race entirely — they passed even WITH the bug. This one lets the poll actually run.
  it('the error survives the 2s poll that fires right after the failed toggle', async () => {
    vi.useFakeTimers()
    const data = payload()
    const getRam = vi.fn(async () => ({ success: true, data })) // the poll KEEPS SUCCEEDING
    const setQ = vi.fn(async () => ({ success: false, error: 'int8 rebuild failed: out of memory' }))
    ;(window as any).termpolis = { memoryGetVectorRam: getRam, memorySetVectorQuantize: setQ }

    render(<VectorRamPanel />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    await act(async () => {
      fireEvent.click(screen.getByTestId('vector-quantize-toggle'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId('vector-quantize-error').textContent).toMatch(/out of memory/)

    // Let several successful polls land on top of it. Each one calls setErr('').
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(getRam.mock.calls.length).toBeGreaterThan(2) // the polls really did run…

    // …and the reason the flip failed is STILL on screen.
    expect(screen.getByTestId('vector-quantize-error').textContent).toMatch(/out of memory/)
    vi.useRealTimers()
  })

  it('retrying the toggle clears the previous failure — only the user resets it', async () => {
    const data = payload()
    let fail = true
    ;(window as any).termpolis = {
      memoryGetVectorRam: vi.fn(async () => ({ success: true, data })),
      memorySetVectorQuantize: vi.fn(async () =>
        fail ? { success: false, error: 'boom' } : { success: true, data: { ...data, quantized: true } },
      ),
    }
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')

    fireEvent.click(screen.getByTestId('vector-quantize-toggle'))
    await waitFor(() => expect(screen.getByTestId('vector-quantize-error').textContent).toMatch(/boom/))

    fail = false
    fireEvent.click(screen.getByTestId('vector-quantize-toggle'))
    await waitFor(() => expect(screen.queryByTestId('vector-quantize-error')).toBeNull())
  })
})

