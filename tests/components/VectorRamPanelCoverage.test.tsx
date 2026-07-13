import React from 'react'
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { VectorRamPanel } from '../../src/renderer/src/components/SettingsPane/VectorRamPanel'
import { AuditLogModal } from '../../src/renderer/src/components/SettingsPane/AuditLogModal'
import type { AuditCoverage, AuditEntry } from '../../src/renderer/src/lib/auditSummary'

// Companion to VectorRamPanel.test.tsx (which owns the happy paths and must not be touched).
// This file takes the two panels that ask the user to TRUST a number, and pins the cases where the
// number is easy to get wrong or easy to lie with:
//
//   VectorRamPanel  — it must be willing to say "your thread is stalling and my toggle will NOT
//                     fix it". A control that only ever markets itself is an upsell, not a tool.
//   AuditLogModal   — it must name WHAT leaked and never the value. The value is the one thing the
//                     audit log must not become a second copy of.

const MB = 1_048_576
const GIB = 1_073_741_824

// ===========================================================================================
// VectorRamPanel
// ===========================================================================================

const health = (over: Record<string, unknown> = {}) => ({
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
  ...over,
})

const payload = (over: Record<string, unknown> = {}) => ({
  vectors: 106_432,
  dim: 384,
  quantized: false,
  ramBytes: 163 * MB,
  ramBytesFloat: 163 * MB,
  ramBytesInt8: 41 * MB,
  persisted: false,
  health: health(),
  advice: {
    verdict: 'not-needed',
    headline: 'Not needed — your 106,432 vectors use only 163 MB',
    detail: 'Turning int8 on would free about 122 MB. Leave it off.',
    savingBytes: 122 * MB,
  },
  ...over,
})

/** Reads that land exactly once.
 *
 *  WHY: toggle()'s `finally` fires `void load()`, and a SUCCESSFUL load calls `setErr('')` — so a
 *  freshly-set toggle error is wiped again a microtask later. Any test that asserts on the error
 *  banner while the refresh can land is a race. Letting only the FIRST read resolve (and hanging
 *  every read after it) freezes the panel in the state under test, so these assertions are
 *  deterministic instead of lucky. */
function oneShotRead(data: Record<string, unknown> = payload()) {
  return vi
    .fn()
    .mockResolvedValueOnce({ success: true, data })
    .mockReturnValue(new Promise(() => {}))
}

/** The three stacked divs inside a <Metric>: [0] label, [1] value, [2] sub-caption. */
const metricValue = (id: string): HTMLElement => screen.getByTestId(id).children[1] as HTMLElement
const toggle = (): HTMLInputElement => screen.getByTestId('vector-quantize-toggle') as HTMLInputElement

afterEach(() => {
  cleanup()
  delete (window as any).termpolis
  delete (window as any).aiSecurity
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('VectorRamPanel — the numbers are readable at every scale', () => {
  it('switches to GB once the vectors pass a gibibyte, and keeps the small number in MB', async () => {
    ;(window as any).termpolis = {
      memoryGetVectorRam: oneShotRead(
        payload({
          ramBytes: Math.round(1.46 * GIB),
          ramBytesFloat: Math.round(1.46 * GIB),
          ramBytesInt8: Math.round((1.46 * GIB) / 4),
          health: health({ rssBytes: 2.5 * GIB }),
        }),
      ),
    }
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')

    // The whole point of the GB arm: "1.46 GB" instead of a four-digit "1495 MB" nobody can read.
    expect(metricValue('m-vector-ram').textContent).toBe('1.46 GB')
    expect(metricValue('m-rss').textContent).toBe('2.50 GB')
    // …and the same formatter still says MB when MB is the right unit — both arms, one metric.
    expect(screen.getByTestId('m-vector-ram').textContent).toMatch(/374 MB as int8/)
    expect(screen.getByTestId('m-rss').textContent).toMatch(/vectors are 58% of it/)
  })

  it('switches units AT one gibibyte, not near it', async () => {
    ;(window as any).termpolis = { memoryGetVectorRam: oneShotRead(payload({ ramBytes: GIB - 1 })) }
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    expect(metricValue('m-vector-ram').textContent).toBe('1024 MB')

    cleanup()
    ;(window as any).termpolis = { memoryGetVectorRam: oneShotRead(payload({ ramBytes: GIB })) }
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    expect(metricValue('m-vector-ram').textContent).toBe('1.00 GB')
  })

  it('reports 0%, not NaN%, when the process RAM reading is missing', async () => {
    // rssBytes = 0 is division by zero. A panel that answers "vectors are NaN% of it" has just
    // destroyed the credibility of every other number on it.
    ;(window as any).termpolis = {
      memoryGetVectorRam: oneShotRead(payload({ health: health({ rssBytes: 0 }) })),
    }
    render(<VectorRamPanel />)
    const panel = await screen.findByTestId('vector-ram-panel')

    expect(metricValue('m-rss').textContent).toBe('0 MB')
    expect(screen.getByTestId('m-rss').textContent).toMatch(/vectors are 0% of it/)
    expect(panel.textContent).not.toMatch(/NaN|Infinity/)
  })

  it('renders an empty brain as 0 vectors / 0 MB rather than blanks or NaN', async () => {
    ;(window as any).termpolis = {
      memoryGetVectorRam: oneShotRead(
        payload({
          vectors: 0,
          ramBytes: 0,
          ramBytesFloat: 0,
          ramBytesInt8: 0,
          advice: {
            verdict: 'not-needed',
            headline: 'Not needed — there is nothing stored yet',
            detail: 'There are no vectors to compress. Come back once the brain has something in it.',
            savingBytes: 0,
          },
        }),
      ),
    }
    render(<VectorRamPanel />)
    const panel = await screen.findByTestId('vector-ram-panel')

    expect(metricValue('m-vectors').textContent).toBe('0 × 384d')
    expect(metricValue('m-vector-ram').textContent).toBe('0 MB')
    expect(screen.getByTestId('m-rss').textContent).toMatch(/vectors are 0% of it/)
    expect(panel.textContent).not.toMatch(/NaN|Infinity|undefined/)
    // An empty store must never be sold the toggle.
    expect(screen.getByTestId('vector-ram-verdict').textContent).toMatch(/not needed/i)
  })
})

describe('VectorRamPanel — "bad" is a state the panel is willing to enter', () => {
  it('a long GC pause is flagged on the GC row -- and the LOOP row does not lie about its own 4.5 ms', async () => {
    // The thread really did freeze for 120 ms, and p99 really is a healthy 4.5 ms. Both are true:
    // one bad stop-the-world pause barely moves a percentile. The old panel resolved that by
    // painting the LOOP row amber with the caption "above 50 ms -- you would feel this" directly
    // above the number "4.5 ms", which is simply false about the figure it was displaying.
    //
    // Each row now judges only its OWN number. The COMBINED stall judgement lives in the verdict,
    // computed in main from both -- which is where it always belonged, and which is the first
    // thing on the panel, so nothing is hidden.
    ;(window as any).termpolis = {
      memoryGetVectorRam: oneShotRead(
        payload({ health: health({ loopDelayP99Ms: 4.5, gcMaxPauseMs: 120 }) }),
      ),
    }
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')

    // The loop row tells the truth about p99: it is fine.
    expect(screen.getByTestId('m-loop').textContent).toMatch(/4\.5 ms/)
    expect(screen.getByTestId('m-loop').textContent).toMatch(/healthy/i)
    expect(screen.getByTestId('m-loop').textContent).not.toMatch(/above 50 ms/)

    // The GC row owns the freeze, and flags it.
    expect(screen.getByTestId('m-gc').textContent).toMatch(/120 ms/)
  })

  it('flags the GC time share once it passes 5% of the session', async () => {
    ;(window as any).termpolis = {
      memoryGetVectorRam: oneShotRead(payload({ health: health({ gcTimeFraction: 0.12 }) })),
    }
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')

    expect(metricValue('m-gc-share').textContent).toBe('12.00%')
    expect(metricValue('m-gc-share')).toHaveClass('text-[#FFB74D]')
    expect(screen.getByTestId('m-gc-share').textContent).toMatch(/over 60s of this session/)
  })

  it('leaves a healthy GC share unstyled — it does not cry wolf', async () => {
    ;(window as any).termpolis = { memoryGetVectorRam: oneShotRead() }
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')

    expect(metricValue('m-gc-share').textContent).toBe('0.07%')
    expect(metricValue('m-gc-share')).toHaveClass('text-[#e0e0e0]')
    expect(metricValue('m-gc-share')).not.toHaveClass('text-[#FFB74D]')
  })
})

describe('VectorRamPanel — the verdict must be able to argue against its own toggle', () => {
  // THE INVARIANT. The stalls are REAL (the panel says so, in the same breath) — and the vectors
  // are 4% of the process, so freeing them cannot be the fix. The panel has to be able to hold both
  // of those thoughts at once, or it is an upsell wearing a diagnostic's clothes.
  it("wont-help: the thread IS stalling, the vectors are 4% of it, and the toggle is NOT the answer", async () => {
    ;(window as any).termpolis = {
      memoryGetVectorRam: oneShotRead(
        payload({
          ramBytes: 40 * MB,
          ramBytesFloat: 40 * MB,
          ramBytesInt8: 10 * MB,
          health: health({ rssBytes: 1000 * MB, loopDelayP99Ms: 180, gcMaxPauseMs: 120 }),
          advice: {
            verdict: 'wont-help',
            headline: 'Your main thread is stalling — but not because of the vectors',
            detail: 'They are 4% of this process. Freeing them will not fix the stalls. Look elsewhere.',
            savingBytes: 30 * MB,
          },
        }),
      ),
    }
    render(<VectorRamPanel />)
    const verdict = await screen.findByTestId('vector-ram-verdict')

    // 1. It does not deny the pain: the stall is flagged, loudly, on the metric itself.
    expect(metricValue('m-loop')).toHaveClass('text-[#FFB74D]')
    expect(screen.getByTestId('m-loop').textContent).toMatch(/you would feel this/i)

    // 2. It shows the evidence that acquits the vectors: 40 MB of a 1000 MB process.
    expect(screen.getByTestId('m-rss').textContent).toMatch(/vectors are 4% of it/)

    // 3. And it refuses the sale — the warning tone, never the call-to-action tone.
    expect(verdict.textContent).toMatch(/won't help/i)
    expect(verdict.textContent).toMatch(/not because of the vectors/i)
    expect(verdict.textContent).not.toMatch(/recommended/i)
    expect(verdict).toHaveClass('bg-[#3a2a0d]') // TONE['wont-help'], not TONE.recommended
    expect(verdict).not.toHaveClass('bg-[#3d2a1a]')
  })

  it('optional: says "Your call" and declines to push', async () => {
    ;(window as any).termpolis = {
      memoryGetVectorRam: oneShotRead(
        payload({
          advice: {
            verdict: 'optional',
            headline: 'Either way is fine — vectors are 163 MB of a 900 MB process',
            detail: 'Nothing here is hurting you. Turn it on if you want the RAM back; nothing breaks if you do not.',
            savingBytes: 122 * MB,
          },
        }),
      ),
    }
    render(<VectorRamPanel />)
    const verdict = await screen.findByTestId('vector-ram-verdict')

    expect(verdict.textContent).toMatch(/your call/i)
    expect(verdict.textContent).not.toMatch(/recommended/i)
    expect(verdict.textContent).toMatch(/nothing breaks if you do not/i)
    expect(verdict).toHaveClass('bg-[#22303a]') // the neutral tone
  })

  it('an unknown verdict degrades to "Your call" — never to a call-to-action', async () => {
    // A newer main sends a verdict this build has never heard of. The panel must not blank out, and
    // it must certainly not fall back to the one tone that says "do it": an unrecognised string is
    // not consent to upsell.
    ;(window as any).termpolis = {
      memoryGetVectorRam: oneShotRead(
        payload({
          advice: {
            verdict: 'urgently-required-by-marketing',
            headline: 'Something this build does not have a colour for',
            detail: 'The headline and the detail still come straight from main, so the user still learns something.',
            savingBytes: 0,
          },
        }),
      ),
    }
    render(<VectorRamPanel />)
    const verdict = await screen.findByTestId('vector-ram-verdict')

    expect(verdict.textContent).toMatch(/your call/i) // TONE.optional, the `??` fallback
    expect(verdict.textContent).not.toMatch(/recommended/i)
    expect(verdict.textContent).not.toMatch(/not needed/i)
    // The unrecognised verdict does not cost the user the advice itself.
    expect(verdict.textContent).toMatch(/Something this build does not have a colour for/)
    expect(screen.getByTestId('m-vectors')).toBeInTheDocument()
  })

  it('each verdict gets its own label — the five tones are five different sentences', async () => {
    const labels: Array<[string, RegExp]> = [
      ['not-needed', /not needed/i],
      ['wont-help', /won't help/i],
      ['optional', /your call/i],
      ['recommended', /recommended/i],
      ['enabled', /int8 on/i],
    ]
    for (const [verdict, label] of labels) {
      ;(window as any).termpolis = {
        memoryGetVectorRam: oneShotRead(
          payload({
            quantized: verdict === 'enabled',
            advice: { verdict, headline: `headline for ${verdict}`, detail: `detail for ${verdict}`, savingBytes: 0 },
          }),
        ),
      }
      render(<VectorRamPanel />)
      const v = await screen.findByTestId('vector-ram-verdict')
      expect(v.textContent).toMatch(label)
      expect(v.textContent).toMatch(`headline for ${verdict}`)
      cleanup()
    }
  })
})

describe('VectorRamPanel — the toggle fails out loud', () => {
  it('goes busy mid-rebuild: disabled, "rebuilding…", and a second flip is refused', async () => {
    let current: Record<string, unknown> = payload()
    let finishRebuild!: () => void
    const getRam = vi.fn(async () => ({ success: true, data: current }))
    const setQuant = vi.fn(
      (on: boolean) =>
        new Promise((resolve) => {
          finishRebuild = () => {
            current = payload({ quantized: on, persisted: on, ramBytes: 41 * MB })
            resolve({ success: true, data: current })
          }
        }),
    )
    ;(window as any).termpolis = { memoryGetVectorRam: getRam, memorySetVectorQuantize: setQuant }

    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')

    fireEvent.click(toggle())
    await waitFor(() => expect(toggle()).toBeDisabled())
    expect(screen.getByTestId('vector-ram-panel').textContent).toMatch(/rebuilding/i)

    // Repacking the store twice at once would be a genuinely bad day. One flip, one rebuild.
    fireEvent.click(toggle())
    expect(setQuant).toHaveBeenCalledTimes(1)

    await act(async () => {
      finishRebuild()
    })
    await waitFor(() => {
      expect(toggle()).not.toBeDisabled()
      expect(toggle().checked).toBe(true)
    })
    expect(screen.getByTestId('vector-ram-panel').textContent).not.toMatch(/rebuilding/i)
    expect(metricValue('m-vector-ram').textContent).toBe('41 MB')
  })

  it('a rebuild that throws shows WHY and hands the toggle back', async () => {
    const getRam = oneShotRead()
    ;(window as any).termpolis = {
      memoryGetVectorRam: getRam,
      memorySetVectorQuantize: vi.fn().mockRejectedValue(new Error('int8 rebuild failed: out of memory')),
    }
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')

    fireEvent.click(toggle())
    await waitFor(() =>
      expect(screen.getByTestId('vector-quantize-error').textContent).toBe('int8 rebuild failed: out of memory'),
    )
    // A thrown rebuild must not wedge the control, and must not blank the panel it lives in.
    expect(toggle()).not.toBeDisabled()
    expect(screen.getByTestId('vector-ram-panel')).toBeInTheDocument()
    expect(toggle().checked).toBe(false) // and it did NOT pretend the flip landed
  })

  it('a rejection with no message still produces a sentence, not "undefined"', async () => {
    ;(window as any).termpolis = {
      memoryGetVectorRam: oneShotRead(),
      memorySetVectorQuantize: vi.fn().mockRejectedValue('main died'), // not an Error: no .message
    }
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')

    fireEvent.click(toggle())
    await waitFor(() =>
      expect(screen.getByTestId('vector-quantize-error').textContent).toBe('Could not change vector precision'),
    )
  })

  it('a reply of success-without-data is treated as a failure, not as a silent win', async () => {
    // main said "sure" and sent nothing back. The panel has no new state to show, so claiming the
    // flip worked would be a guess. Say so instead.
    ;(window as any).termpolis = {
      memoryGetVectorRam: oneShotRead(),
      memorySetVectorQuantize: vi.fn().mockResolvedValue({ success: true }),
    }
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')

    fireEvent.click(toggle())
    await waitFor(() =>
      expect(screen.getByTestId('vector-quantize-error').textContent).toBe('Could not change vector precision'),
    )
    expect(toggle().checked).toBe(false)
  })

  it('an old preload with no quantize bridge fails visibly instead of doing nothing', async () => {
    // window.termpolis exists, but this build of the preload predates memorySetVectorQuantize.
    // Optional chaining makes the call evaporate — the user must not be left clicking a dead switch.
    ;(window as any).termpolis = { memoryGetVectorRam: oneShotRead() }
    render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')

    fireEvent.click(toggle())
    await waitFor(() =>
      expect(screen.getByTestId('vector-quantize-error').textContent).toBe('Could not change vector precision'),
    )
  })
})

describe('VectorRamPanel — the read fails out loud', () => {
  it('a thrown read shows the reason instead of an eternal spinner', async () => {
    ;(window as any).termpolis = {
      memoryGetVectorRam: vi.fn().mockRejectedValue(new Error('vector store is locked by another process')),
    }
    render(<VectorRamPanel />)
    await waitFor(() =>
      expect(screen.getByTestId('vector-ram-error').textContent).toBe('vector store is locked by another process'),
    )
    expect(screen.queryByTestId('vector-ram-loading')).toBeNull()
    expect(screen.queryByTestId('vector-ram-panel')).toBeNull()
  })

  it('a thrown read with no message still says something human', async () => {
    ;(window as any).termpolis = { memoryGetVectorRam: vi.fn().mockRejectedValue({}) }
    render(<VectorRamPanel />)
    await waitFor(() =>
      expect(screen.getByTestId('vector-ram-error').textContent).toBe('Could not read vector memory'),
    )
  })

  it('an old preload with no vector-ram bridge at all reports it', async () => {
    ;(window as any).termpolis = {} // bridge object present, this method missing
    render(<VectorRamPanel />)
    await waitFor(() =>
      expect(screen.getByTestId('vector-ram-error').textContent).toBe('Could not read vector memory'),
    )
  })

  it('a success reply carrying no data is an error, not an empty panel', async () => {
    ;(window as any).termpolis = { memoryGetVectorRam: vi.fn().mockResolvedValue({ success: true }) }
    render(<VectorRamPanel />)
    await waitFor(() =>
      expect(screen.getByTestId('vector-ram-error').textContent).toBe('Could not read vector memory'),
    )
  })

  it('unmounting mid-rebuild drops the reply and does not restart the poll', async () => {
    let finishRebuild!: () => void
    const getRam = vi.fn(async () => ({ success: true, data: payload() }))
    const setQuant = vi.fn(
      () =>
        new Promise((resolve) => {
          finishRebuild = () => resolve({ success: true, data: payload({ quantized: true }) })
        }),
    )
    ;(window as any).termpolis = { memoryGetVectorRam: getRam, memorySetVectorQuantize: setQuant }

    const { unmount } = render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    fireEvent.click(toggle())
    await waitFor(() => expect(setQuant).toHaveBeenCalledTimes(1))

    unmount()
    const readsAtUnmount = getRam.mock.calls.length

    // The rebuild lands on a component that no longer exists. toggle()'s `finally` normally fires a
    // refresh — on a dead panel that refresh is a zombie IPC call, and it must not happen.
    await act(async () => {
      finishRebuild()
      await Promise.resolve()
    })
    expect(getRam).toHaveBeenCalledTimes(readsAtUnmount)
  })

  it('unmounting mid-read drops the reply without a further call', async () => {
    let land!: (v: unknown) => void
    const getRam = vi.fn(() => new Promise((resolve) => { land = resolve }))
    ;(window as any).termpolis = { memoryGetVectorRam: getRam }

    const { unmount } = render(<VectorRamPanel />)
    expect(screen.getByTestId('vector-ram-loading')).toBeInTheDocument()
    unmount()

    await act(async () => {
      land({ success: true, data: payload() })
      await Promise.resolve()
    })
    expect(getRam).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('vector-ram-panel')).toBeNull()
  })

  it('a read that REJECTS after unmount is swallowed — no stray banner, no zombie poll', async () => {
    // Closing the settings pane while an IPC read is in flight is the ordinary case, not the exotic
    // one. The rejection has to land in a catch (an unhandled one reaches Sentry as a phantom crash)
    // and the 2s interval has to be gone with the component.
    let boom!: (e: unknown) => void
    const getRam = vi.fn(() => new Promise((_resolve, reject) => { boom = reject }))
    ;(window as any).termpolis = { memoryGetVectorRam: getRam }

    const { unmount } = render(<VectorRamPanel />)
    expect(screen.getByTestId('vector-ram-loading')).toBeInTheDocument()
    unmount()

    await act(async () => {
      boom(new Error('bridge died while the pane was closing'))
      await Promise.resolve()
    })
    expect(getRam).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('vector-ram-error')).toBeNull()
    expect(document.body.textContent).not.toMatch(/bridge died/)
  })

  it('a rebuild that REJECTS after unmount is swallowed — and the refresh does not fire', async () => {
    let boom!: (e: unknown) => void
    const getRam = vi.fn(async () => ({ success: true, data: payload() }))
    const setQuant = vi.fn(() => new Promise((_resolve, reject) => { boom = reject }))
    ;(window as any).termpolis = { memoryGetVectorRam: getRam, memorySetVectorQuantize: setQuant }

    const { unmount } = render(<VectorRamPanel />)
    await screen.findByTestId('vector-ram-panel')
    fireEvent.click(toggle())
    await waitFor(() => expect(setQuant).toHaveBeenCalledTimes(1))

    unmount()
    const readsAtUnmount = getRam.mock.calls.length

    await act(async () => {
      boom(new Error('rebuild died while the pane was closing'))
      await Promise.resolve()
    })
    expect(getRam).toHaveBeenCalledTimes(readsAtUnmount) // the `finally` refresh must not resurrect
    expect(document.body.textContent).not.toMatch(/rebuild died/)
  })
})

// ===========================================================================================
// AuditLogModal
// ===========================================================================================

const TS = '2026-07-12T10:00:00.000Z'

const cov = (over: Partial<AuditCoverage> = {}): AuditCoverage => ({
  auditEnabled: true,
  commitShield: true,
  egressGuard: true,
  memoryScrub: true,
  ...over,
})

let recentAudit: ReturnType<typeof vi.fn>
let clearAudit: ReturnType<typeof vi.fn>

function mockAudit(rows: AuditEntry[] = []): void {
  recentAudit = vi.fn(async () => ({ success: true, data: rows }))
  clearAudit = vi.fn(async () => ({ success: true }))
  ;(window as any).aiSecurity = { recentAudit, clearAudit }
}

const AUDIT_PATH = 'C:\\Users\\d\\AppData\\Roaming\\Termpolis\\ai-security-audit.jsonl'

function openAudit(coverage: Partial<AuditCoverage> = {}, onClose: () => void = vi.fn()) {
  const view = render(<AuditLogModal onClose={onClose} coverage={cov(coverage)} auditPath={AUDIT_PATH} />)
  return { ...view, onClose }
}

const verdictIcon = (): string =>
  screen.getByTestId('audit-verdict').querySelector('i')?.className ?? ''

/** The count tiles are label-then-number; pull the number span out by its label. */
const countTile = (label: string): HTMLElement => {
  const tile = Array.from(screen.getByTestId('audit-counts').children).find((el) =>
    el.textContent?.startsWith(label),
  )
  if (!tile) throw new Error(`no count tile labelled ${label}`)
  return tile.children[1] as HTMLElement
}

describe('AuditLogModal — it names WHAT leaked, never the value', () => {
  // THE INVARIANT. main captures the identifier and the rule that matched it and nothing else. If
  // a future entry ever arrives carrying the matched text (the `sample` field is exactly the trap),
  // this modal must still refuse to put it on screen — or the audit log becomes a second, durable,
  // on-disk copy of the credential it exists to warn you about.
  it('renders the identifier and nothing that resembles the secret itself', async () => {
    const SECRET_VALUE = 'hunter2-correct-horse-battery-staple'
    mockAudit([
      {
        ts: TS,
        agent: 'claude',
        event: 'prompt_secret_sent',
        hitCount: 2,
        notes: 'DB_PASSWORD (env_secret), apiKey (json_secret)',
        // A rogue/newer main attaches the matched text. Nothing in this component reads it.
        sample: SECRET_VALUE,
        value: SECRET_VALUE,
      } as AuditEntry & { sample: string; value: string },
    ])
    openAudit()

    const list = await screen.findByTestId('audit-secret-name-list')
    const chips = Array.from(list.querySelectorAll('code')).map((c) => c.textContent)
    // EXACTLY the names. Not the rule ids, not a `NAME=value`, not a truncated preview.
    expect(chips).toEqual(['DB_PASSWORD', 'apiKey'])

    // The names ARE shown (so this is not passing by rendering nothing at all)…
    expect(screen.getByTestId('audit-rows').textContent).toMatch(/DB_PASSWORD/)
    // …and the value is nowhere on the page.
    expect(document.body.textContent).not.toContain(SECRET_VALUE)
    expect(document.body.textContent).not.toContain('hunter2')

    expect(screen.getByTestId('audit-secret-names').textContent).toMatch(/never the value/i)
    expect(screen.getByTestId('audit-secret-names').textContent).toMatch(/rotation is the remedy/i)
  })

  it('a secret with no name still counts as a secret — "no name" is not "no leak"', async () => {
    // An AWS key has no identifier; it IS the identifier. auditSummary yields no name for it, so
    // the rotate-these panel has nothing to list — and the verdict must NOT quietly soften to clean.
    mockAudit([{ ts: TS, agent: 'codex', event: 'prompt_secret_sent', hitCount: 1, notes: 'aws_access_key' }])
    openAudit()

    const verdict = await screen.findByTestId('audit-verdict')
    expect(verdict.textContent).toMatch(/1 secret sent to a model/i)
    expect(verdict.textContent).toMatch(/every credential listed below/i)
    expect(verdict.textContent).not.toMatch(/no secret has reached a model/i)
    expect(screen.queryByTestId('audit-secret-names')).toBeNull() // nothing to name, so nothing named
    expect(countTile('Secrets to a model').textContent).toBe('1')
  })

  it('a big paste is not a leak: code chunks and env dumps are counted apart from secrets', async () => {
    mockAudit([
      { ts: TS, agent: 'claude', event: 'prompt_secret_sent', hitCount: 3, notes: 'DB_PASSWORD (env_secret)' },
      { ts: TS, agent: 'claude', event: 'code_chunk_sent', byteCount: 40_960, notes: 'code-chunk:src/main/index.ts' },
      { ts: TS, agent: 'gemini', event: 'env_dump_sent', notes: 'env-dump:.env.local' },
    ])
    openAudit()
    await screen.findByTestId('audit-counts')

    expect(countTile('Secrets to a model').textContent).toBe('3')
    expect(countTile('Code chunks sent').textContent).toBe('1')
    expect(countTile('Env dumps sent').textContent).toBe('1')
    // A zero is grey. Dressing an untouched counter in alarm-red is how a dashboard stops being read.
    expect(countTile('Memories scrubbed').textContent).toBe('0')
    expect(countTile('Memories scrubbed')).toHaveStyle({ color: 'rgb(107, 114, 128)' })
    expect(countTile('Secrets to a model')).toHaveStyle({ color: 'rgb(255, 180, 180)' })
  })
})

describe('AuditLogModal — the four verdicts', () => {
  it('caught: a secret reached a model', async () => {
    mockAudit([{ ts: TS, agent: 'claude', event: 'prompt_secret_sent', hitCount: 1, notes: 'DB_PASSWORD (env_secret)' }])
    openAudit()
    const verdict = await screen.findByTestId('audit-verdict')
    expect(verdict.textContent).toMatch(/1 secret sent to a model/i)
    expect(verdict.textContent).toMatch(/this is a record, not a save/i) // never "we stopped it"
    expect(verdictIcon()).toMatch(/fa-triangle-exclamation/)
    expect(verdict).toHaveClass('bg-[#3a0d0d]')
  })

  it('clean: the log is recording, it has rows, and none of them is a secret', async () => {
    mockAudit([{ ts: TS, agent: 'claude', event: 'terminal_open' }])
    openAudit()
    const verdict = await screen.findByTestId('audit-verdict')
    expect(verdict.textContent).toMatch(/no secret has reached a model/i)
    expect(verdict.textContent).toMatch(/not the lifetime of the machine/i) // scoped, not absolute
    expect(verdictIcon()).toMatch(/fa-circle-check/)
    expect(verdict).toHaveClass('bg-[#0d3a1a]')
  })

  it('audit-off: a zero means "no record was kept", and it says so', async () => {
    mockAudit([{ ts: TS, agent: 'claude', event: 'terminal_open' }])
    openAudit({ auditEnabled: false, commitShield: false, egressGuard: false, memoryScrub: false })
    const verdict = await screen.findByTestId('audit-verdict')

    expect(verdict.textContent).toMatch(/nothing is being recorded/i)
    expect(verdict.textContent).not.toMatch(/no secret has reached a model/i) // the dangerous sentence
    expect(verdictIcon()).toMatch(/fa-ban/)

    const chips = screen.getByTestId('audit-coverage').textContent || ''
    expect(chips).toMatch(/Commit Shield: OFF/)
    expect(chips).toMatch(/Egress Guard: OFF/)
    expect(chips).toMatch(/Memory scrub: OFF/)
    expect(chips).toMatch(/Recording: OFF/)
  })

  it('no-data: recording, watching, nothing has happened yet', async () => {
    mockAudit([])
    openAudit()
    const verdict = await screen.findByTestId('audit-verdict')
    expect(verdict.textContent).toMatch(/nothing recorded yet/i)
    expect(verdictIcon()).toMatch(/fa-circle-info/)
    expect(verdict).toHaveClass('bg-[#252526]')

    expect(screen.getByTestId('audit-empty').textContent).toBe('The log is empty.')
    expect(screen.queryByTestId('audit-rows')).toBeNull()
    expect(screen.getByTestId('audit-coverage').textContent).toMatch(/Recording: on/)
  })

  it('while the log is still being read it says nothing at all — an early "empty" reads as "clean"', () => {
    recentAudit = vi.fn(() => new Promise(() => {})) // never lands
    clearAudit = vi.fn(async () => ({ success: true }))
    ;(window as any).aiSecurity = { recentAudit, clearAudit }

    openAudit()
    expect(screen.getByText(/Loading audit log/i)).toBeInTheDocument()
    expect(screen.queryByTestId('audit-empty')).toBeNull()
    expect(screen.queryByTestId('audit-rows')).toBeNull()
  })
})

describe('AuditLogModal — the filter', () => {
  const ROWS: AuditEntry[] = [
    { ts: TS, agent: 'claude', event: 'terminal_open' }, // no notes, not a finding
    { ts: TS, agent: 'codex', event: 'commit_blocked', hitCount: 2, notes: 'AWS_SECRET (aws_secret)' },
    { ts: TS, agent: 'gemini', event: 'code_chunk_sent', byteCount: 40_960, notes: 'code-chunk:src/main/index.ts' },
  ]

  const type = (text: string): void => {
    fireEvent.change(screen.getByTestId('audit-filter'), { target: { value: text } })
  }

  it('matches on the event name, on the agent, and on the note', async () => {
    mockAudit(ROWS)
    openAudit()
    await screen.findByTestId('audit-rows')
    const rows = (): string => screen.getByTestId('audit-rows').textContent || ''

    type('terminal') // the event name — and this row has NO notes, so `notes || ''` has to hold
    await waitFor(() => expect(rows()).toMatch(/Terminal opened/))
    expect(rows()).not.toMatch(/Commit blocked/)

    type('codex') // the agent
    await waitFor(() => expect(rows()).toMatch(/Commit blocked/))
    expect(rows()).not.toMatch(/Terminal opened/)

    type('index.ts') // the note
    await waitFor(() => expect(rows()).toMatch(/Code chunk sent/))
    expect(rows()).not.toMatch(/Commit blocked/)
  })

  it('an empty RESULT is not an empty LOG, and the modal says which one it is', async () => {
    mockAudit(ROWS)
    openAudit()
    await screen.findByTestId('audit-rows')

    type('zzz-nothing-matches-this')
    await waitFor(() => expect(screen.getByTestId('audit-empty').textContent).toBe('Nothing matches that filter.'))
    expect(screen.getByTestId('audit-empty').textContent).not.toBe('The log is empty.')
    expect(screen.queryByTestId('audit-rows')).toBeNull()

    type('')
    await waitFor(() => expect(screen.getByTestId('audit-rows')).toBeInTheDocument())
  })

  it('"only security findings" and the text filter compose, and both let go again', async () => {
    mockAudit(ROWS)
    openAudit()
    await screen.findByTestId('audit-rows')
    const rows = (): string => screen.getByTestId('audit-rows').textContent || ''

    fireEvent.click(screen.getByTestId('audit-only-notable'))
    await waitFor(() => expect(rows()).not.toMatch(/Terminal opened/))
    expect(rows()).not.toMatch(/Code chunk sent/) // pasting a source file is the workflow, not a finding
    expect(rows()).toMatch(/Commit blocked/)

    // …now narrow it further by text, with the notable gate still on.
    fireEvent.change(screen.getByTestId('audit-filter'), { target: { value: 'gemini' } })
    await waitFor(() => expect(screen.getByTestId('audit-empty').textContent).toBe('Nothing matches that filter.'))

    // …and both filters release.
    fireEvent.change(screen.getByTestId('audit-filter'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('audit-only-notable'))
    await waitFor(() => expect(rows()).toMatch(/Terminal opened/))
    expect(rows()).toMatch(/Code chunk sent/)
  })

  it('counts what is shown against what is held, and shows where the file lives', async () => {
    mockAudit(ROWS)
    const { container } = openAudit()
    await screen.findByTestId('audit-rows')
    expect(container.textContent).toMatch(/3 of 3 events/)

    fireEvent.change(screen.getByTestId('audit-filter'), { target: { value: 'codex' } })
    await waitFor(() => expect(container.textContent).toMatch(/1 of 3 events/))
    expect(container.textContent).toContain(AUDIT_PATH)
  })
})

describe('AuditLogModal — the rows', () => {
  /** A row is [timestamp, agent, event + note, hit count]. */
  const cells = (rows: HTMLElement, i: number): string[] =>
    Array.from(rows.children[i].children).map((c) => c.textContent || '')

  it('an event this build has never heard of still renders, raw, rather than as a blank line', async () => {
    // A log written by a NEWER Termpolis. An unlabelled row that renders as an empty line is worse
    // than an ugly one: it hides a security event behind a gap in a table.
    mockAudit([
      { ts: TS, agent: 'claude', event: 'quantum_key_exfil', notes: 'from the future' },
      { ts: TS, agent: 'codex', event: 'prompt_secret_sent', hitCount: 4, notes: 'DB_PASSWORD (env_secret)' },
    ])
    openAudit()
    const rows = await screen.findByTestId('audit-rows')

    expect(cells(rows, 0)[2]).toMatch(/^quantum_key_exfil\s+—\s+from the future$/) // the raw id, not nothing
    expect(cells(rows, 0)[3]).toBe('') // no hit count → an empty cell, never the string "undefined"
    expect(cells(rows, 1)[2]).toMatch(/^SECRET SENT to a model\s+—\s+DB_PASSWORD \(env_secret\)$/)
    expect(cells(rows, 1)[3]).toBe('4')
    expect(cells(rows, 1)[1]).toBe('codex')
  })

  it('a row with no note renders no dangling em-dash and no "undefined"', async () => {
    mockAudit([{ ts: TS, agent: 'claude', event: 'terminal_open' }])
    openAudit()
    const rows = await screen.findByTestId('audit-rows')

    expect(cells(rows, 0)[2]).toBe('Terminal opened')
    expect(cells(rows, 0)[3]).toBe('')
    expect(rows.textContent).not.toMatch(/undefined|NaN|null/)
  })
})

describe('AuditLogModal — clearing, closing, and a missing bridge', () => {
  it('Clear log wipes the file and re-reads it, rather than just blanking the table', async () => {
    // Blanking the table locally would leave the user believing a log they never actually cleared.
    recentAudit = vi
      .fn()
      .mockResolvedValueOnce({ success: true, data: [{ ts: TS, agent: 'claude', event: 'terminal_open' }] })
      .mockResolvedValueOnce({ success: true, data: [] })
    clearAudit = vi.fn(async () => ({ success: true }))
    ;(window as any).aiSecurity = { recentAudit, clearAudit }

    openAudit()
    await screen.findByTestId('audit-rows')

    fireEvent.click(screen.getByTestId('audit-clear'))
    await waitFor(() => expect(clearAudit).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('audit-empty').textContent).toBe('The log is empty.'))

    expect(recentAudit).toHaveBeenCalledTimes(2) // it re-read the file; it did not trust itself
    expect(screen.queryByTestId('audit-rows')).toBeNull()
  })

  it('closes on the X and on Escape, and stays open for every other key', async () => {
    mockAudit([])
    const onClose = vi.fn()
    openAudit({}, onClose)
    await screen.findByTestId('audit-verdict')

    fireEvent.keyDown(screen.getByTestId('audit-log-modal'), { key: 'a' })
    fireEvent.keyDown(screen.getByTestId('audit-log-modal'), { key: 'Enter' })
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(screen.getByTestId('audit-log-modal'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('audit-close'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('with no security bridge at all it settles instead of spinning forever', async () => {
    delete (window as any).aiSecurity
    const onClose = vi.fn()
    openAudit({}, onClose)

    // A permanent "Loading audit log…" is the worst outcome here: it looks like the log is coming.
    await waitFor(() => expect(screen.getByTestId('audit-empty')).toBeInTheDocument())
    expect(screen.queryByText(/Loading audit log/i)).toBeNull()
    expect(screen.getByTestId('audit-verdict').textContent).toMatch(/nothing recorded yet/i)

    // …and Clear is inert rather than explosive.
    expect(() => fireEvent.click(screen.getByTestId('audit-clear'))).not.toThrow()
    fireEvent.click(screen.getByTestId('audit-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a failed read leaves the table empty rather than half-populated, and stops loading', async () => {
    recentAudit = vi.fn(async () => ({ success: false }))
    clearAudit = vi.fn(async () => ({ success: true }))
    ;(window as any).aiSecurity = { recentAudit, clearAudit }

    openAudit()
    await waitFor(() => expect(screen.getByTestId('audit-empty')).toBeInTheDocument())
    expect(screen.queryByText(/Loading audit log/i)).toBeNull()
    expect(screen.queryByTestId('audit-rows')).toBeNull()
  })
})
