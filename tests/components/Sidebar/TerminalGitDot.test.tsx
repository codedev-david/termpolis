import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../src/renderer/src/lib/pollingService', () => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}))

import { subscribe, unsubscribe } from '../../../src/renderer/src/lib/pollingService'
import { resetCountsRegistry } from '../../../src/renderer/src/lib/gitCountsCache'
import { TerminalGitDot, isDirty, summarize } from '../../../src/renderer/src/components/Sidebar/TerminalGitDot'

const counts = (patch: Partial<Record<string, any>> = {}) => ({
  branch: 'main', ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, ...patch,
})

const gitChangeCounts = vi.fn()

beforeEach(() => {
  // The dot now reads from a per-REPO shared poller rather than its own per-terminal
  // subscription. That registry is module state: without this reset a test rendering
  // /repo would be handed the previous test's answer and never call the bridge at all.
  resetCountsRegistry()
  vi.clearAllMocks()
  ;(window as any).termpolis = { gitChangeCounts }
  gitChangeCounts.mockResolvedValue({ success: true, data: counts() })
})

afterEach(() => {
  delete (window as any).termpolis
})

const dot = () => screen.queryByTestId('git-dot-t1')

/**
 * Wait for the LIVE mark.
 *
 * The inert mark renders synchronously on every terminal, so findByTestId resolves
 * instantly and proves nothing about whether the git result arrived — every assertion
 * about grey-vs-pulsing has to wait for data-repo to flip or it silently tests the
 * pre-data state instead.
 */
const liveDot = async (): Promise<HTMLElement> => {
  await waitFor(() => expect(dot()).toHaveAttribute('data-repo', 'true'))
  return dot() as HTMLElement
}

describe('TerminalGitDot — the inert mark', () => {
  // The mark exists on every terminal so people learn where to look. Outside a repo it
  // is a dim glyph with no click target, rather than a button onto an empty panel.
  const expectInert = () => {
    const el = dot()
    expect(el).toBeInTheDocument()
    expect(el).toHaveAttribute('data-repo', 'false')
    expect(el).toHaveAttribute('data-dirty', 'false')
    expect(el!.tagName).toBe('SPAN')
    expect(el!.className).not.toContain('animate-pulse-git')
  }

  it('shows the inert mark before the first result arrives', () => {
    render(<TerminalGitDot terminalId="t1" cwd="/repo" />)
    expectInert()
  })

  it('shows the inert mark outside a repo (handler returns null)', async () => {
    gitChangeCounts.mockResolvedValue({ success: true, data: null })
    render(<TerminalGitDot terminalId="t1" cwd="/not-a-repo" />)
    await waitFor(() => expect(gitChangeCounts).toHaveBeenCalled())
    expectInert()
  })

  it('shows the inert mark when the call fails', async () => {
    gitChangeCounts.mockResolvedValue({ success: false, error: 'boom' })
    render(<TerminalGitDot terminalId="t1" cwd="/repo" />)
    await waitFor(() => expect(gitChangeCounts).toHaveBeenCalled())
    expectInert()
  })

  it('shows the inert mark when the promise rejects', async () => {
    gitChangeCounts.mockRejectedValue(new Error('git missing'))
    render(<TerminalGitDot terminalId="t1" cwd="/repo" />)
    await waitFor(() => expect(gitChangeCounts).toHaveBeenCalled())
    expectInert()
  })

  it('does not open the Changes rail when the inert mark is clicked', async () => {
    // Nothing to show, so clicking must do nothing at all rather than open an
    // empty panel and make people doubt the feature.
    const onEvent = vi.fn()
    window.addEventListener('termpolis:openChanges', onEvent)
    gitChangeCounts.mockResolvedValue({ success: true, data: null })
    render(<TerminalGitDot terminalId="t1" cwd="/not-a-repo" />)
    await waitFor(() => expect(gitChangeCounts).toHaveBeenCalled())
    fireEvent.click(dot()!)
    expect(onEvent).not.toHaveBeenCalled()
    window.removeEventListener('termpolis:openChanges', onEvent)
  })

  it('never calls the bridge without a cwd', () => {
    render(<TerminalGitDot terminalId="t1" cwd="" />)
    expect(gitChangeCounts).not.toHaveBeenCalled()
  })

  it('never calls the bridge when the preload API is absent', () => {
    // Checked synchronously, so no promise is started and no setState can land
    // after unmount in a host that has no bridge yet.
    delete (window as any).termpolis
    expect(() => render(<TerminalGitDot terminalId="t1" cwd="/repo" />)).not.toThrow()
    expectInert()
  })
})

describe('TerminalGitDot — grey vs pulsing', () => {
  it('is grey and still on a clean, pushed repo', async () => {
    render(<TerminalGitDot terminalId="t1" cwd="/repo" />)
    const el = await liveDot()
    expect(el).toHaveAttribute('data-dirty', 'false')
    expect(el.className).not.toContain('animate-pulse-git')
    expect(el).toHaveAttribute('title', 'main — Nothing to commit or push')
  })

  it.each([
    ['staged', { staged: 1 }],
    ['unstaged', { unstaged: 1 }],
    ['untracked', { untracked: 1 }],
    ['conflicted', { conflicted: 1 }],
    ['unpushed commits', { ahead: 1 }],
  ])('pulses amber for %s', async (_label, patch) => {
    gitChangeCounts.mockResolvedValue({ success: true, data: counts(patch) })
    render(<TerminalGitDot terminalId="t1" cwd="/repo" />)
    const el = await liveDot()
    expect(el).toHaveAttribute('data-dirty', 'true')
    expect(el.className).toContain('animate-pulse-git')
    expect(el.className).toContain('#e5c07b')
  })

  it('does NOT pulse when merely behind the remote', async () => {
    // Someone else's work arriving is not your work waiting; pulsing on it would
    // leave the dot lit permanently on a busy shared repo.
    gitChangeCounts.mockResolvedValue({ success: true, data: counts({ behind: 7 }) })
    render(<TerminalGitDot terminalId="t1" cwd="/repo" />)
    const el = await liveDot()
    expect(el).toHaveAttribute('data-dirty', 'false')
    expect(el).toHaveAttribute('title', 'main — 7 to pull')
  })

  it('falls back to "detached HEAD" when there is no branch name', async () => {
    gitChangeCounts.mockResolvedValue({ success: true, data: counts({ branch: '', unstaged: 1 }) })
    render(<TerminalGitDot terminalId="t1" cwd="/repo" />)
    expect((await liveDot()).getAttribute('title')).toBe('detached HEAD — 1 modified')
  })
})

describe('TerminalGitDot — opening the rail', () => {
  it('dispatches termpolis:openChanges carrying its own terminal id', async () => {
    const onEvent = vi.fn()
    window.addEventListener('termpolis:openChanges', onEvent)
    gitChangeCounts.mockResolvedValue({ success: true, data: counts({ unstaged: 2 }) })
    render(<TerminalGitDot terminalId="t1" cwd="/repo" />)
    fireEvent.click(await liveDot())
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent.mock.calls[0][0].detail).toEqual({ terminalId: 't1' })
    window.removeEventListener('termpolis:openChanges', onEvent)
  })

  it('does not select the terminal when the dot is clicked', async () => {
    const rowClick = vi.fn()
    render(
      <div onClick={rowClick}>
        <TerminalGitDot terminalId="t1" cwd="/repo" />
      </div>,
    )
    fireEvent.click(await liveDot())
    expect(rowClick).not.toHaveBeenCalled()
  })
})

describe('TerminalGitDot — polling', () => {
  // This used to subscribe once per TERMINAL, so ten terminals on one repo spawned ten
  // identical `git status` processes every five seconds. It now subscribes once per REPO.
  // The invariant that matters to a user is unchanged and still asserted below: two rows
  // on the same repo must BOTH keep updating — which is exactly what a naive keyed-by-cwd
  // fix would have broken, since pollingService ids are global and a duplicate silently
  // replaces the previous subscriber.
  it('polls a repo once however many terminals are open on it', () => {
    render(<TerminalGitDot terminalId="t1" cwd="/repo" />)
    render(<TerminalGitDot terminalId="t2" cwd="/repo" />)
    const ids = (subscribe as any).mock.calls.map((c: any[]) => c[0])
    expect(ids).toEqual(['git-counts-/repo'])
    expect((subscribe as any).mock.calls[0][2]).toBe(15000)
  })

  it('updates every terminal on the repo from that one poll', async () => {
    render(<TerminalGitDot terminalId="t1" cwd="/repo" />)
    render(<TerminalGitDot terminalId="t2" cwd="/repo" />)
    await waitFor(() => expect(gitChangeCounts).toHaveBeenCalledTimes(1))

    gitChangeCounts.mockResolvedValue({ success: true, data: counts({ untracked: 3 }) })
    ;(subscribe as any).mock.calls[0][1]()

    await waitFor(() => {
      expect(screen.queryByTestId('git-dot-t1')).toHaveAttribute('data-dirty', 'true')
      expect(screen.queryByTestId('git-dot-t2')).toHaveAttribute('data-dirty', 'true')
    })
    // Still one spawn for that tick, not one per row — the whole point.
    expect(gitChangeCounts).toHaveBeenCalledTimes(2)
  })

  it('keeps polling until the LAST terminal on the repo goes away', () => {
    const a = render(<TerminalGitDot terminalId="t1" cwd="/repo" />)
    const b = render(<TerminalGitDot terminalId="t2" cwd="/repo" />)

    a.unmount()
    expect(unsubscribe).not.toHaveBeenCalledWith('git-counts-/repo')

    b.unmount()
    expect(unsubscribe).toHaveBeenCalledWith('git-counts-/repo')
  })

  it('re-reads when the polling callback fires', async () => {
    render(<TerminalGitDot terminalId="t1" cwd="/repo" />)
    await waitFor(() => expect(gitChangeCounts).toHaveBeenCalledTimes(1))
    const cb = (subscribe as any).mock.calls[0][1]
    gitChangeCounts.mockResolvedValue({ success: true, data: counts({ untracked: 3 }) })
    cb()
    // waitFor, not findByTestId: the live mark is already on screen carrying the PREVIOUS
    // result, so a query that only waits for existence would assert against stale data
    // and pass whether or not the poll ever landed.
    await waitFor(() => expect(dot()).toHaveAttribute('data-dirty', 'true'))
  })
})

describe('isDirty', () => {
  it('is false only when nothing is outstanding', () => {
    expect(isDirty(counts() as any)).toBe(false)
    expect(isDirty(counts({ behind: 9 }) as any)).toBe(false)
  })

  it.each(['staged', 'unstaged', 'untracked', 'conflicted', 'ahead'])(
    'is true when %s is non-zero', key => {
      expect(isDirty(counts({ [key]: 1 }) as any)).toBe(true)
    },
  )
})

describe('summarize', () => {
  it('says so plainly when there is nothing to do', () => {
    expect(summarize(counts() as any)).toBe('Nothing to commit or push')
  })

  it('lists every outstanding category in a fixed order', () => {
    expect(summarize(counts({ staged: 1, unstaged: 2, untracked: 3, conflicted: 4, ahead: 5, behind: 6 }) as any))
      .toBe('1 staged, 2 modified, 3 untracked, 4 conflicted, 5 to push, 6 to pull')
  })

  it('names unpushed commits, which no other part of the UI shows', () => {
    expect(summarize(counts({ ahead: 2 }) as any)).toBe('2 to push')
  })
})
