// The whole value of this panel is that it makes an INVISIBLE failure visible: memoryClient falls
// back to running the store on the main thread when the utilityProcess cannot start, and that
// fallback is deliberately silent (an app with slow memory beats an app with none). So the tests
// that matter are the ones asserting the degraded state is LOUD, and that the panel never polls.
//
// v1.38.2 added the other half: STARTING IS NOT FAILING. The child takes tens of seconds to report
// ready on a large store, and rendering the fallback copy during that window turned the panel from
// a truth-teller into a liar at the exact moment a user is most likely to look at it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { BrainProcessPanel } from '../../src/renderer/src/components/SettingsPane/BrainProcessPanel'

const hostStatus = vi.fn()

beforeEach(() => {
  hostStatus.mockReset()
  ;(globalThis as unknown as { window: Window }).window.termpolis = {
    memoryHostStatus: hostStatus,
  } as unknown as Window['termpolis']
})

afterEach(() => { vi.useRealTimers() })

describe('BrainProcessPanel', () => {
  it('reports the healthy case: the brain is in its own process, with its pid', async () => {
    hostStatus.mockResolvedValue({ success: true, data: { mode: 'host', pid: 52572 } })
    render(<BrainProcessPanel refreshToken={0} />)
    const panel = await screen.findByTestId('brain-process-panel')
    expect(panel.getAttribute('data-mode')).toBe('host')
    expect(panel.textContent).toContain('Memory runs in its own process')
    expect(panel.textContent).toContain('52572')
  })

  it('SHOUTS when the store fell back to the main thread (the silent failure this exists to expose)', async () => {
    hostStatus.mockResolvedValue({ success: true, data: { mode: 'inproc', pid: null } })
    render(<BrainProcessPanel refreshToken={0} />)
    const panel = await screen.findByTestId('brain-process-panel')
    expect(panel.getAttribute('data-mode')).toBe('inproc')
    expect(panel.textContent).toContain('Memory is running on the main thread')
    // ...and it must say WHY the user should care, not just state a mode.
    expect(panel.textContent).toContain('main thread')
    expect(panel.textContent).toMatch(/typing can stutter|launch is slower/)
    // the degraded state must be visually distinct, not a grey footnote
    expect(panel.className).toContain('#f0a020')
  })

  it('treats "unstarted" as degraded too — anything that is not `host` means main is paying for it', async () => {
    hostStatus.mockResolvedValue({ success: true, data: { mode: 'unstarted', pid: null } })
    render(<BrainProcessPanel refreshToken={0} />)
    const panel = await screen.findByTestId('brain-process-panel')
    expect(panel.getAttribute('data-mode')).toBe('unstarted')
    expect(panel.textContent).toContain('Memory is running on the main thread')
  })

  it('surfaces an IPC failure instead of rendering a confident lie', async () => {
    hostStatus.mockResolvedValue({ success: false, error: 'ipc exploded' })
    render(<BrainProcessPanel refreshToken={0} />)
    await waitFor(() => expect(screen.getByTestId('brain-process-panel').textContent).toContain('ipc exploded'))
  })

  it('survives a rejected promise', async () => {
    hostStatus.mockRejectedValue(new Error('channel closed'))
    render(<BrainProcessPanel refreshToken={0} />)
    await waitFor(() => expect(screen.getByTestId('brain-process-panel').textContent).toContain('channel closed'))
  })

  it('NEVER polls — one read on mount, and nothing on a timer', async () => {
    vi.useFakeTimers()
    hostStatus.mockResolvedValue({ success: true, data: { mode: 'host', pid: 1 } })
    render(<BrainProcessPanel refreshToken={0} />)
    await vi.advanceTimersByTimeAsync(5 * 60_000) // five minutes
    // Polling the main thread from a dashboard is exactly the mistake v1.25.16 was written to undo.
    expect(hostStatus).toHaveBeenCalledTimes(1)
  })

  it('re-reads when the tab Refresh bumps refreshToken (and only then)', async () => {
    hostStatus.mockResolvedValue({ success: true, data: { mode: 'host', pid: 1 } })
    const { rerender } = render(<BrainProcessPanel refreshToken={0} />)
    await screen.findByTestId('brain-process-panel')
    expect(hostStatus).toHaveBeenCalledTimes(1)

    rerender(<BrainProcessPanel refreshToken={0} />) // same token → no re-read
    expect(hostStatus).toHaveBeenCalledTimes(1)

    rerender(<BrainProcessPanel refreshToken={1} />) // Refresh pressed
    await waitFor(() => expect(hostStatus).toHaveBeenCalledTimes(2))
  })

  it('renders nothing until the status arrives (no flash of a wrong verdict)', () => {
    hostStatus.mockReturnValue(new Promise(() => {})) // never resolves
    const { container } = render(<BrainProcessPanel refreshToken={0} />)
    expect(container.querySelector('[data-testid="brain-process-panel"]')).toBeNull()
  })

  it('does NOT take down the tab when the IPC bridge is absent', () => {
    // Found by the full suite: 24 existing MemoryLearningSettings tests died because they mock
    // `window.termpolis` without this method. A STATUS panel that crashes the dashboard it reports
    // on is worse than no panel. It must render nothing and get out of the way.
    ;(globalThis as unknown as { window: Window }).window.termpolis = {} as unknown as Window['termpolis']
    const { container } = render(<BrainProcessPanel refreshToken={0} />)
    expect(container.querySelector('[data-testid="brain-process-panel"]')).toBeNull()
  })
  it('does NOT call a still-starting child a failure (the v1.38.2 lie)', async () => {
    hostStatus.mockResolvedValue({ success: true, data: { mode: 'starting', pid: 1744924 } })
    render(<BrainProcessPanel refreshToken={0} />)
    const panel = await screen.findByTestId('brain-process-panel')
    expect(panel.getAttribute('data-mode')).toBe('starting')
    expect(panel.textContent).toContain('Memory is starting in its own process')
    // The exact words that made a healthy launch look like a bug report.
    expect(panel.textContent).not.toContain('Memory is running on the main thread')
    expect(panel.textContent).not.toContain('could not start')
    expect(panel.className).not.toContain('#f0a020') // not dressed as the fallback
    expect(panel.textContent).toContain('1744924')   // it has a pid: it really is its own process
  })

  it('leaves the transitional state on its own — no Refresh needed', async () => {
    vi.useFakeTimers()
    hostStatus
      .mockResolvedValueOnce({ success: true, data: { mode: 'starting', pid: 7 } })
      .mockResolvedValue({ success: true, data: { mode: 'host', pid: 7 } })
    render(<BrainProcessPanel refreshToken={0} />)
    // `findBy*` never settles under fake timers here — RTL's waitFor polls on a timer it can't
    // advance — so flush React explicitly instead of waiting on it.
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByTestId('brain-process-panel').getAttribute('data-mode')).toBe('starting')
    await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
    // Without this the false banner stayed on screen for the rest of the session.
    expect(screen.getByTestId('brain-process-panel').getAttribute('data-mode')).toBe('host')
  })

  it('stops probing the moment the mode settles', async () => {
    vi.useFakeTimers()
    hostStatus
      .mockResolvedValueOnce({ success: true, data: { mode: 'starting', pid: 7 } })
      .mockResolvedValue({ success: true, data: { mode: 'host', pid: 7 } })
    render(<BrainProcessPanel refreshToken={0} />)
    await vi.advanceTimersByTimeAsync(2500)
    const settled = hostStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(hostStatus).toHaveBeenCalledTimes(settled) // a probe, not a poll
  })

  it('gives up probing rather than hammering a wedged host forever', async () => {
    vi.useFakeTimers()
    hostStatus.mockResolvedValue({ success: true, data: { mode: 'starting', pid: 7 } })
    render(<BrainProcessPanel refreshToken={0} />)
    await vi.advanceTimersByTimeAsync(60 * 60_000) // an hour
    // 10 minutes of 2s probes, then silence — bounded even in the state that never resolves.
    expect(hostStatus.mock.calls.length).toBeLessThanOrEqual(302)
  })

  it('a Refresh restarts an exhausted probe budget', async () => {
    vi.useFakeTimers()
    hostStatus.mockResolvedValue({ success: true, data: { mode: 'starting', pid: 7 } })
    const { rerender } = render(<BrainProcessPanel refreshToken={0} />)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    const exhausted = hostStatus.mock.calls.length
    rerender(<BrainProcessPanel refreshToken={1} />)
    await vi.advanceTimersByTimeAsync(2500)
    expect(hostStatus.mock.calls.length).toBeGreaterThan(exhausted)
  })

  it('does not probe from a settled mode, however unhappy it is', async () => {
    vi.useFakeTimers()
    hostStatus.mockResolvedValue({ success: true, data: { mode: 'inproc', pid: null } })
    render(<BrainProcessPanel refreshToken={0} />)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(hostStatus).toHaveBeenCalledTimes(1)
  })
})
