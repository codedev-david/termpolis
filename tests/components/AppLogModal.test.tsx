import React from 'react'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AppLogModal, filterEntries } from '../../src/renderer/src/components/AppLogModal/AppLogModal'
import { formatLogLine, type AppLogEntry } from '../../src/shared/appLog'

// A fixed stamp so every expectation can be built from the SAME formatLogLine the
// component renders with -- hard-coding "12:00:00.000" would fail on any box whose
// timezone is not this one, and formatLogTime renders in local time on purpose.
const T0 = Date.UTC(2026, 8, 4, 12, 0, 0, 0)

function entry(over: Partial<AppLogEntry> = {}): AppLogEntry {
  return { t: T0, level: 'log', source: 'main', msg: 'plain message', ...over }
}

/** One entry per level, in LEVEL_ORDER, with distinct messages so getByText is unambiguous. */
const FIVE: AppLogEntry[] = [
  entry({ level: 'debug', msg: 'dbg line', t: T0 + 1 }),
  entry({ level: 'info', msg: 'info line', t: T0 + 2 }),
  entry({ level: 'log', msg: 'log line', t: T0 + 3 }),
  entry({ level: 'warn', msg: 'warn line', t: T0 + 4 }),
  entry({ level: 'error', msg: 'err line', t: T0 + 5 }),
]

const LOG_PATH = 'C:/Users/x/AppData/Roaming/termpolis/logs/app-2026-09-04.log'

interface LogApi {
  readAppLog: ReturnType<typeof vi.fn>
  clearAppLog: ReturnType<typeof vi.fn>
  openPath: ReturnType<typeof vi.fn>
}

let api: LogApi
let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  api = {
    readAppLog: vi.fn().mockResolvedValue({ success: true, data: { entries: [], path: null } }),
    clearAppLog: vi.fn().mockResolvedValue({ success: true }),
    openPath: vi.fn().mockResolvedValue({ success: true }),
  }
  Object.defineProperty(window, 'termpolis', { value: api, writable: true, configurable: true })

  // The viewer copies through the web clipboard, not the Electron IPC one. jsdom has no
  // Clipboard API at all, so without this navigator.clipboard is undefined and Copy would
  // land in the catch for the wrong reason.
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, writable: true, configurable: true })

  // jsdom implements no layout, so scrollIntoView does not exist. The modal calls it after
  // every render that changes the row count.
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

function seed(entries: AppLogEntry[], path: string | null = null): void {
  api.readAppLog.mockResolvedValue({ success: true, data: { entries, path } })
}

/** Render and let the on-open read settle -- the rows only exist after that promise chain. */
async function mount(onClose: () => void = vi.fn()) {
  const view = render(<AppLogModal onClose={onClose} />)
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return view
}

describe('filterEntries', () => {
  it('keeps warn and error when the floor is warn -- the two levels anyone opens this for', () => {
    const kept = filterEntries(FIVE, 'warn', '')
    expect(kept.map(e => e.level)).toEqual(['warn', 'error'])
  })

  it('treats an empty or whitespace-only query as no query at all', () => {
    // A user who typed a filter and then cleared it back to spaces expects the whole log
    // again, not an empty pane.
    expect(filterEntries(FIVE, 'debug', '')).toHaveLength(5)
    expect(filterEntries(FIVE, 'debug', '   ')).toHaveLength(5)
  })

  it('matches the message case-insensitively', () => {
    // Log lines are written by dozens of call sites with no shared casing convention, so a
    // case-sensitive filter would be useless in practice.
    const entries = [entry({ msg: 'Spawned PTY 7' }), entry({ msg: 'nothing here' })]
    expect(filterEntries(entries, 'debug', 'spawned').map(e => e.msg)).toEqual(['Spawned PTY 7'])
    expect(filterEntries(entries, 'debug', 'SPAWNED').map(e => e.msg)).toEqual(['Spawned PTY 7'])
  })

  it('matches the source, so "renderer" narrows the log to one side of the app', () => {
    const entries = [entry({ source: 'main', msg: 'a' }), entry({ source: 'renderer', msg: 'b' })]
    expect(filterEntries(entries, 'debug', 'renderer').map(e => e.msg)).toEqual(['b'])
    expect(filterEntries(entries, 'debug', 'main').map(e => e.msg)).toEqual(['a'])
  })

  it('drops an entry the query matches in neither the message nor the source', () => {
    expect(filterEntries([entry({ msg: 'a', source: 'main' })], 'debug', 'zzz')).toEqual([])
  })

  it('composes the level floor with the query rather than treating them as alternatives', () => {
    const entries = [
      entry({ level: 'info', msg: 'boom in info' }),
      entry({ level: 'error', msg: 'boom in error' }),
      entry({ level: 'error', msg: 'quiet' }),
    ]
    expect(filterEntries(entries, 'warn', 'boom').map(e => e.msg)).toEqual(['boom in error'])
  })
})

describe('AppLogModal', () => {
  it('reads the ring buffer on open and renders one row per entry', async () => {
    seed(FIVE, LOG_PATH)
    await mount()

    // 1000 is the viewer's own cap -- if it drifts, the modal silently starts showing a
    // different slice of history than the one the docs promise.
    expect(api.readAppLog).toHaveBeenCalledWith(1000)
    for (const e of FIVE) expect(screen.getByText(formatLogLine(e))).toBeInTheDocument()
    expect(screen.getByTestId('app-log-count')).toHaveTextContent('(5 of 5 lines)')
  })

  it('says "1 line" and not "1 lines" for a single entry', async () => {
    seed([entry({ msg: 'only one' })])
    await mount()
    expect(screen.getByTestId('app-log-count')).toHaveTextContent(/^\(1 of 1 line\)$/)
  })

  it('shows a placeholder while the very first read is still in flight', async () => {
    let settle!: (v: unknown) => void
    api.readAppLog.mockReturnValue(new Promise(res => { settle = res }))

    render(<AppLogModal onClose={vi.fn()} />)
    expect(screen.getByText(/Reading log/)).toBeInTheDocument()

    await act(async () => {
      settle({ success: true, data: { entries: FIVE, path: null } })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.queryByText(/Reading log/)).not.toBeInTheDocument()
  })

  it('Refresh re-reads without blanking the lines already on screen', async () => {
    seed(FIVE)
    await mount()

    let settle!: (v: unknown) => void
    api.readAppLog.mockReturnValue(new Promise(res => { settle = res }))
    fireEvent.click(screen.getByTestId('app-log-refresh'))

    // Loading is true again, but there is readable content -- swapping it for "Reading log"
    // would make Refresh feel like it lost the log.
    expect(screen.queryByText(/Reading log/)).not.toBeInTheDocument()
    expect(screen.getByText(formatLogLine(FIVE[0]))).toBeInTheDocument()

    await act(async () => {
      settle({ success: true, data: { entries: FIVE, path: null } })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.readAppLog).toHaveBeenCalledTimes(2)
  })

  it('survives a rejecting readAppLog and stays usable', async () => {
    // The log viewer failing to read the log must not throw into the app that is already
    // misbehaving enough for someone to have opened it.
    api.readAppLog.mockRejectedValue(new Error('ipc down'))
    await mount()

    expect(screen.getByTestId('app-log-modal')).toBeInTheDocument()
    expect(screen.getByTestId('app-log-empty')).toHaveTextContent('Nothing logged yet this session.')

    seed(FIVE)
    fireEvent.click(screen.getByTestId('app-log-refresh'))
    await waitFor(() => expect(screen.getByText(formatLogLine(FIVE[0]))).toBeInTheDocument())
  })

  it('handles success:false as "no data" instead of reading through it', async () => {
    api.readAppLog.mockResolvedValue({ success: false, error: 'no log service' })
    await mount()
    expect(screen.getByTestId('app-log-empty')).toHaveTextContent('Nothing logged yet this session.')
  })

  it('handles a successful response that carries no data payload', async () => {
    api.readAppLog.mockResolvedValue({ success: true })
    await mount()
    expect(screen.getByTestId('app-log-empty')).toHaveTextContent('Nothing logged yet this session.')
  })

  it('falls back to an empty list and no file when the payload omits both fields', async () => {
    api.readAppLog.mockResolvedValue({ success: true, data: {} })
    await mount()
    expect(screen.getByTestId('app-log-empty')).toHaveTextContent('Nothing logged yet this session.')
    expect(screen.getByTestId('app-log-path')).toHaveTextContent('In memory only (no log file this session)')
  })

  it('distinguishes an empty log from a filter that excluded everything', async () => {
    // Same empty pane, two completely different situations -- one is "nothing happened",
    // the other is "you typed something too narrow".
    seed(FIVE)
    await mount()
    fireEvent.change(screen.getByTestId('app-log-filter'), { target: { value: 'zzz-no-match' } })
    expect(screen.getByTestId('app-log-empty')).toHaveTextContent('No lines match that filter.')
  })

  it('raises the floor when the level select changes', async () => {
    seed(FIVE)
    await mount()
    fireEvent.change(screen.getByTestId('app-log-level'), { target: { value: 'warn' } })

    expect(screen.getByText(formatLogLine(FIVE[3]))).toBeInTheDocument()
    expect(screen.getByText(formatLogLine(FIVE[4]))).toBeInTheDocument()
    expect(screen.queryByText(formatLogLine(FIVE[2]))).not.toBeInTheDocument()
    // The denominator stays the full count so it is obvious lines are being hidden, not lost.
    expect(screen.getByTestId('app-log-count')).toHaveTextContent('(2 of 5 lines)')
  })

  it('narrows the rows as the filter is typed', async () => {
    seed(FIVE)
    await mount()
    fireEvent.change(screen.getByTestId('app-log-filter'), { target: { value: 'WARN LINE' } })
    expect(screen.getByTestId('app-log-count')).toHaveTextContent('(1 of 5 lines)')
    expect(screen.getByText(formatLogLine(FIVE[3]))).toBeInTheDocument()
  })

  it('labels the level options in words rather than as raw level codes', async () => {
    await mount()
    const select = screen.getByTestId('app-log-level')
    expect(select.textContent).toContain('All levels')
    expect(select.textContent).toContain('warn and above')
    expect(select.textContent).toContain('error and above')
  })

  it('Copy puts the VISIBLE lines on the clipboard and flashes the label back', async () => {
    seed(FIVE)
    vi.useFakeTimers()
    render(<AppLogModal onClose={vi.fn()} />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.change(screen.getByTestId('app-log-level'), { target: { value: 'warn' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('app-log-copy'))
      await Promise.resolve()
      await Promise.resolve()
    })

    // A bug report should contain the lines the reporter was looking at, not the ones the
    // filter was hiding from them.
    expect(writeText).toHaveBeenCalledWith([FIVE[3], FIVE[4]].map(formatLogLine).join('\n'))
    expect(screen.getByTestId('app-log-copy')).toHaveTextContent('Copied')

    // "Copied" is a 1.5s flash, not a mode -- it has to go back on its own.
    act(() => { vi.advanceTimersByTime(1500) })
    expect(screen.getByTestId('app-log-copy')).toHaveTextContent('Copy')
  })

  it('swallows a denied clipboard -- the text is still on screen to select by hand', async () => {
    writeText.mockRejectedValue(new Error('write permission denied'))
    seed(FIVE)
    await mount()

    await act(async () => {
      fireEvent.click(screen.getByTestId('app-log-copy'))
      await Promise.resolve()
      await Promise.resolve()
    })

    // No "Copied" claim, because nothing was copied.
    expect(screen.getByTestId('app-log-copy')).toHaveTextContent('Copy')
    expect(screen.getByText(formatLogLine(FIVE[0]))).toBeInTheDocument()
  })

  it('Clear empties the viewer through the main-process ring', async () => {
    seed(FIVE)
    await mount()

    await act(async () => {
      fireEvent.click(screen.getByTestId('app-log-clear'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.clearAppLog).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('app-log-empty')).toHaveTextContent('Nothing logged yet this session.')
  })

  it('leaves the lines alone when clearAppLog rejects, rather than lying about them', async () => {
    api.clearAppLog.mockRejectedValue(new Error('file locked'))
    seed(FIVE)
    await mount()

    await act(async () => {
      fireEvent.click(screen.getByTestId('app-log-clear'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByText(formatLogLine(FIVE[0]))).toBeInTheDocument()
  })

  it('closes on a backdrop click but NOT on a click inside the dialog', async () => {
    const onClose = vi.fn()
    await mount(onClose)

    // Without stopPropagation, selecting a log line to copy by hand would close the modal.
    fireEvent.click(screen.getByTestId('app-log-modal'))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('app-log-overlay'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes from the X button', async () => {
    const onClose = vi.fn()
    await mount(onClose)
    fireEvent.click(screen.getByTestId('app-log-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape, and the key listener does not outlive the modal', async () => {
    const onClose = vi.fn()
    const { unmount } = await mount(onClose)

    fireEvent.keyDown(window, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    // The listener is on window, so a leaked one would keep firing onClose for every Escape
    // pressed anywhere in the app for the rest of the session.
    unmount()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('names the file on disk in the footer and opens it on demand', async () => {
    seed(FIVE, LOG_PATH)
    await mount()

    expect(screen.getByTestId('app-log-path')).toHaveTextContent(`Saved to ${LOG_PATH}`)
    // The path is truncated in the UI, so the full one has to survive as a tooltip.
    expect(screen.getByTestId('app-log-path')).toHaveAttribute('title', LOG_PATH)

    fireEvent.click(screen.getByTestId('app-log-open-file'))
    expect(api.openPath).toHaveBeenCalledWith(LOG_PATH)
  })

  it('offers no Open file button when there is no file this session', async () => {
    seed(FIVE, null)
    await mount()

    expect(screen.getByTestId('app-log-path')).toHaveTextContent('In memory only (no log file this session)')
    expect(screen.queryByTestId('app-log-open-file')).not.toBeInTheDocument()
    expect(screen.getByTestId('app-log-path')).not.toHaveAttribute('title')
  })

  it('gives every level its own colour so warn and error are findable by scrolling', async () => {
    seed(FIVE)
    await mount()

    const classes = FIVE.map(e => screen.getByText(formatLogLine(e)).className)
    expect(new Set(classes).size).toBe(5)
    expect(classes[0]).toContain('text-[#6a737d]') // debug
    expect(classes[1]).toContain('text-[#8ab4f8]') // info
    expect(classes[2]).toContain('text-[#c8c8c8]') // log
    expect(classes[3]).toContain('text-[#e5c07b]') // warn
    expect(classes[4]).toContain('text-[#ff8a8a]') // error
  })

  it('scrolls the newest line into view -- the last thing that happened is what you came to read', async () => {
    seed(FIVE)
    await mount()
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'end' })
  })
})
