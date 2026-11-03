// v1.54.5 (typing hotfix, lane C, package P6) — the honest "memory unavailable, retrying" state.
//
// Above a store-size limit the memory client no longer loads the store on the main thread when its
// own process cannot serve (that load froze typing for seconds). It reports mode 'unavailable', keeps
// retrying in the background, and refuses memory calls with an honest error. This panel is the one
// place a person would look, so it must say exactly that: not "running on the main thread" (it is not
// running anywhere), not a silent grey footnote, and not forever: it must leave the state on its own
// the moment the retry succeeds.
//
// Until now the panel treated every mode that was not 'host' or 'starting' as the main-thread
// fallback, so an 'unavailable' payload rendered the wrong, alarming and false sentence. The tests
// that say so are red on 942f2177. The CONTROLS (host, inproc, starting) are green on both sides.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { BrainProcessPanel } from '../../src/renderer/src/components/SettingsPane/BrainProcessPanel'

const hostStatus = vi.fn()

beforeEach(() => {
  hostStatus.mockReset()
  ;(globalThis as unknown as { window: Window }).window.termpolis = {
    memoryHostStatus: hostStatus,
  } as unknown as Window['termpolis']
})

afterEach(() => { vi.useRealTimers() })

const unavailable = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    mode: 'unavailable', pid: null,
    attempt: 2, retrying: false, retryInMs: 20_000, storeMB: 475, limitMB: 256,
    reason: 'memory host exited during startup (code 9)',
    ...over,
  },
})

describe('BrainProcessPanel — memory unavailable, retrying', () => {
  it('says it plainly: unavailable and retrying, with the attempt, the wait, and why it is not on the main thread', async () => {
    hostStatus.mockResolvedValue(unavailable())
    render(<BrainProcessPanel refreshToken={0} />)
    const panel = await screen.findByTestId('brain-process-panel')

    expect(panel.getAttribute('data-mode')).toBe('unavailable')
    expect(panel.textContent).toContain('Memory is unavailable, retrying')
    expect(panel.textContent).toContain('475 MB')                  // what the store weighs...
    expect(panel.textContent).toContain('256 MB')                  // ...against what the main thread may load
    expect(panel.textContent).toMatch(/attempt 2/i)
    expect(panel.textContent).toMatch(/20 s/)                      // the countdown
    expect(panel.textContent).toContain('memory host exited during startup (code 9)') // the cause
    // It says what the person will see elsewhere: memory calls fail instead of returning nothing.
    expect(panel.textContent).toMatch(/error/i)
  })

  it('is NOT dressed as the main-thread fallback: that sentence would be false here, and so would its colour', async () => {
    hostStatus.mockResolvedValue(unavailable())
    render(<BrainProcessPanel refreshToken={0} />)
    const panel = await screen.findByTestId('brain-process-panel')

    expect(panel.textContent).not.toContain('Memory is running on the main thread')
    expect(panel.textContent).not.toMatch(/typing can stutter/)
    expect(panel.className).not.toContain('#f0a020')               // the fallback's amber
    expect(panel.className).toContain('#f48771')                   // the error red the other panels use
    expect(panel.textContent).not.toContain('Memory runs in its own process')
  })

  it('while a retry is running there is no countdown, just "trying again now"', async () => {
    hostStatus.mockResolvedValue(unavailable({ retrying: true, retryInMs: null }))
    render(<BrainProcessPanel refreshToken={0} />)
    const panel = await screen.findByTestId('brain-process-panel')
    expect(panel.textContent).toMatch(/trying again now/i)
    expect(panel.textContent).not.toMatch(/next try in/i)
  })

  it('reads a wait the way a person does: seconds under a minute and a half, whole minutes above, "a moment" below one second', async () => {
    const cases: Array<[number, RegExp]> = [[400, /a moment/], [45_000, /45 s/], [89_000, /89 s/], [90_000, /2 min|1\.5 min|90 s/], [300_000, /5 min/]]
    for (const [ms, expected] of cases) {
      hostStatus.mockResolvedValue(unavailable({ retryInMs: ms }))
      const { unmount } = render(<BrainProcessPanel refreshToken={0} />)
      const panel = await screen.findByTestId('brain-process-panel')
      expect(panel.textContent, `${ms} ms`).toMatch(expected)
      unmount()
    }
  })

  it('does not break, or print "undefined" or "NaN", when the main process sent no detail (an older build, a partial payload)', async () => {
    hostStatus.mockResolvedValue({ success: true, data: { mode: 'unavailable', pid: null } })
    render(<BrainProcessPanel refreshToken={0} />)
    const panel = await screen.findByTestId('brain-process-panel')
    expect(panel.textContent).toContain('Memory is unavailable, retrying')
    expect(panel.textContent).not.toMatch(/undefined|NaN|null/)
  })

  it('shows a long cause as given, as text: nothing in it is interpreted as markup', async () => {
    hostStatus.mockResolvedValue(unavailable({ reason: '<img src=x onerror=alert(1)> ' + 'y'.repeat(300) }))
    const { container } = render(<BrainProcessPanel refreshToken={0} />)
    const panel = await screen.findByTestId('brain-process-panel')
    expect(panel.textContent).toContain('<img src=x onerror=alert(1)>') // shown, literally, as text...
    expect(container.querySelector('img')).toBeNull()                   // ...and never parsed as an element
  })

  it('keeps probing while unavailable, and leaves the state on its own when the retry succeeds: no Refresh needed', async () => {
    vi.useFakeTimers()
    hostStatus
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValue({ success: true, data: { mode: 'host', pid: 4242 } })
    render(<BrainProcessPanel refreshToken={0} />)
    // `findBy*` never settles under fake timers here (RTL's waitFor polls on a timer it cannot
    // advance), so flush React explicitly, as the 'starting' tests beside this one do.
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByTestId('brain-process-panel').getAttribute('data-mode')).toBe('unavailable')
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500) })
    const panel = screen.getByTestId('brain-process-panel')
    expect(panel.getAttribute('data-mode')).toBe('host')
    expect(panel.textContent).toContain('Memory runs in its own process')
    expect(panel.textContent).not.toContain('unavailable')
  })

  it('stops probing the moment memory is back (a probe, not a poll)', async () => {
    vi.useFakeTimers()
    hostStatus
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValue({ success: true, data: { mode: 'host', pid: 4242 } })
    render(<BrainProcessPanel refreshToken={0} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500) })
    const settled = hostStatus.mock.calls.length
    expect(settled).toBeGreaterThanOrEqual(2)      // it DID probe while unavailable...
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000) })
    expect(hostStatus).toHaveBeenCalledTimes(settled) // ...and stopped the moment memory was back
  })

  it('gives up probing after its budget rather than reading for ever, and a Refresh restarts the budget', async () => {
    vi.useFakeTimers()
    hostStatus.mockResolvedValue(unavailable())
    const { rerender } = render(<BrainProcessPanel refreshToken={0} />)
    // One act() per 2 s step, as the 'starting' tests beside this one do: inside a single long act()
    // React would not render between the probes, and the count would say nothing.
    for (let i = 0; i < 320; i++) await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    const exhausted = hostStatus.mock.calls.length
    expect(exhausted).toBeGreaterThan(250)         // it probed for as long as memory stayed unavailable...
    expect(exhausted).toBeLessThanOrEqual(302)     // ...10 minutes of 2 s probes, then silence
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000) })
    expect(hostStatus.mock.calls.length).toBe(exhausted) // and it stayed silent

    rerender(<BrainProcessPanel refreshToken={1} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500) })
    expect(hostStatus.mock.calls.length).toBeGreaterThan(exhausted)
  })
})

describe('CONTROL — the states that already existed read exactly as before', () => {
  it('host: its own process, with the pid', async () => {
    hostStatus.mockResolvedValue({ success: true, data: { mode: 'host', pid: 52572 } })
    render(<BrainProcessPanel refreshToken={0} />)
    const panel = await screen.findByTestId('brain-process-panel')
    expect(panel.getAttribute('data-mode')).toBe('host')
    expect(panel.textContent).toContain('Memory runs in its own process')
    expect(panel.textContent).toContain('52572')
    expect(panel.textContent).not.toContain('unavailable')
  })

  it('inproc: still the loud amber main-thread warning, and still never probes', async () => {
    vi.useFakeTimers()
    hostStatus.mockResolvedValue({ success: true, data: { mode: 'inproc', pid: null } })
    render(<BrainProcessPanel refreshToken={0} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const panel = screen.getByTestId('brain-process-panel')
    expect(panel.textContent).toContain('Memory is running on the main thread')
    expect(panel.className).toContain('#f0a020')
    expect(panel.textContent).not.toContain('unavailable')
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000) })
    expect(hostStatus).toHaveBeenCalledTimes(1)
  })

  it('starting: still the calm blue state, not an error', async () => {
    hostStatus.mockResolvedValue({ success: true, data: { mode: 'starting', pid: 1744924 } })
    render(<BrainProcessPanel refreshToken={0} />)
    const panel = await screen.findByTestId('brain-process-panel')
    expect(panel.textContent).toContain('Memory is starting in its own process')
    expect(panel.textContent).not.toContain('unavailable')
    expect(panel.className).not.toContain('#f48771')
    expect(panel.className).not.toContain('#f0a020')
  })
})
