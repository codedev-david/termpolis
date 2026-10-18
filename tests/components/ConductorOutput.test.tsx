import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'

// The refresh is driven by hand: the test calls what the component registered.
const poll = vi.hoisted(() => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }))
vi.mock('../../src/renderer/src/lib/pollingService', () => poll)

import { ConductorOutput } from '../../src/renderer/src/components/ConductorOutput/ConductorOutput'

// GitHub #36: Debug only unhid the conductor's terminal, behind the dashboard, and split view
// never drew it. It now shows that terminal's output read-only inside the dashboard.

const buffer = (output: string, extra: Record<string, unknown> = {}) =>
  ({ success: true, data: { output, length: output.length, nextOffset: output.length, missed: 0, ...extra } })

let readTerminalBuffer: ReturnType<typeof vi.fn>

beforeEach(() => {
  poll.subscribe.mockReset()
  poll.unsubscribe.mockReset()
  readTerminalBuffer = vi.fn().mockResolvedValue(buffer(''))
  ;(window as any).termpolis = { readTerminalBuffer }
})

/** Runs the refresh the component registered with the polling service. */
async function refresh(): Promise<void> {
  const calls = poll.subscribe.mock.calls
  const callback = calls[calls.length - 1][1] as () => void
  await act(async () => { callback() })
}

describe('ConductorOutput', () => {
  it('says so when there is no conductor, and reads nothing', () => {
    render(<ConductorOutput conductorTerminalId={null} />)
    expect(screen.getByTestId('conductor-output')).toHaveTextContent('No swarm conductor running.')
    expect(readTerminalBuffer).not.toHaveBeenCalled()
    expect(poll.subscribe).not.toHaveBeenCalled()
  })

  it("shows all the conductor terminal still holds, as plain text", async () => {
    readTerminalBuffer.mockResolvedValue(buffer(
      '\x1b]0;Windows PowerShell\x07\x1b[2J\x1b[1;1HPS C:\\proj> claude --version\r\n2.1.300 (Claude Code)\r\n' +
      "\x1b[31merror: unknown option '-NoProfile'\x1b[0m\r\n[termpolis-conductor-exited] 1\r\n",
    ))
    render(<ConductorOutput conductorTerminalId="cond-1" />)

    const text = await screen.findByTestId('conductor-output-text')
    expect(text.textContent).toBe(
      "PS C:\\proj> claude --version\n2.1.300 (Claude Code)\nerror: unknown option '-NoProfile'\n[termpolis-conductor-exited] 1",
    )
    // From the start of what is retained, not from the launch: the startup output matters too.
    expect(readTerminalBuffer).toHaveBeenCalledWith('cond-1')
    expect(screen.getByTestId('conductor-output')).toHaveTextContent('read-only')
  })

  it('leaves out the half escape sequence the buffer cut off at its start', async () => {
    readTerminalBuffer.mockResolvedValue(buffer('5;1Hhello\r\n', { skip: 4 }))
    render(<ConductorOutput conductorTerminalId="cond-1" />)
    expect((await screen.findByTestId('conductor-output-text')).textContent).toBe('hello')
  })

  it('refreshes every two seconds while it is open', async () => {
    readTerminalBuffer.mockResolvedValue(buffer('first\r\n'))
    render(<ConductorOutput conductorTerminalId="cond-1" />)
    expect((await screen.findByTestId('conductor-output-text')).textContent).toBe('first')
    expect(poll.subscribe).toHaveBeenCalledWith('conductor-output', expect.any(Function), 2000)

    readTerminalBuffer.mockResolvedValue(buffer('first\r\nsecond\r\n'))
    await refresh()

    expect(screen.getByTestId('conductor-output-text').textContent).toBe('first\nsecond')
  })

  it("says so when the conductor hasn't printed anything yet", async () => {
    render(<ConductorOutput conductorTerminalId="cond-1" />)
    expect(await screen.findByText("The conductor hasn't printed anything yet.")).toBeInTheDocument()
  })

  it("says so when the output can't be read, whether the read fails or throws", async () => {
    readTerminalBuffer.mockResolvedValue({ success: false, error: 'no such terminal' })
    render(<ConductorOutput conductorTerminalId="cond-1" />)
    expect(await screen.findByText(/output can't be read/)).toBeInTheDocument()

    readTerminalBuffer.mockRejectedValue(new Error('ipc gone'))
    readTerminalBuffer.mockClear()
    await refresh()
    expect(readTerminalBuffer).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/output can't be read/)).toBeInTheDocument()
  })

  it('shows that it is reading until the first read comes back', () => {
    readTerminalBuffer.mockReturnValue(new Promise(() => {}))
    render(<ConductorOutput conductorTerminalId="cond-1" />)
    expect(screen.getByText(/Reading the conductor's output/)).toBeInTheDocument()
  })

  it('stops reading when it closes, and ignores a read that comes back after', async () => {
    let finish: (value: unknown) => void = () => {}
    readTerminalBuffer.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const { unmount } = render(<ConductorOutput conductorTerminalId="cond-1" />)

    unmount()
    expect(poll.unsubscribe).toHaveBeenCalledWith('conductor-output')
    await act(async () => { finish(buffer('late\r\n')) })

    readTerminalBuffer.mockRejectedValue(new Error('late failure'))
    await refresh() // the registered refresh, run after the close, changes nothing either
    expect(screen.queryByTestId('conductor-output')).toBeNull()
  })

  it('starts over for another conductor', async () => {
    readTerminalBuffer.mockImplementation(async (id: string) => buffer(`output of ${id}\r\n`))
    const { rerender } = render(<ConductorOutput conductorTerminalId="cond-1" />)
    expect((await screen.findByTestId('conductor-output-text')).textContent).toBe('output of cond-1')

    rerender(<ConductorOutput conductorTerminalId="cond-2" />)

    expect(poll.unsubscribe).toHaveBeenCalledWith('conductor-output')
    expect((await screen.findByText('output of cond-2')).textContent).toBe('output of cond-2')
  })

  describe('scrolling', () => {
    // jsdom lays nothing out, so the element's geometry is given here.
    const top = new WeakMap<Element, number>()
    let restore: () => void = () => {}

    beforeEach(() => {
      const proto = HTMLElement.prototype
      const saved = ['scrollHeight', 'clientHeight', 'scrollTop'].map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const)
      Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => 500 })
      Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 100 })
      Object.defineProperty(proto, 'scrollTop', {
        configurable: true,
        get(this: Element) { return top.get(this) ?? 0 },
        set(this: Element, v: number) { top.set(this, v) },
      })
      restore = () => {
        for (const [k, d] of saved) {
          if (d) Object.defineProperty(proto, k, d)
          else delete (proto as any)[k]
        }
      }
    })
    afterEach(() => restore())

    it('follows new output to the end until the user scrolls up, and again once back at the end', async () => {
      readTerminalBuffer.mockResolvedValue(buffer('one\r\n'))
      render(<ConductorOutput conductorTerminalId="cond-1" />)
      const pre = await screen.findByTestId('conductor-output-text')
      expect(pre.scrollTop).toBe(500)

      pre.scrollTop = 0 // the user scrolls up to read
      fireEvent.scroll(pre)
      readTerminalBuffer.mockResolvedValue(buffer('one\r\ntwo\r\n'))
      await refresh()
      expect(pre.textContent).toBe('one\ntwo')
      expect(pre.scrollTop).toBe(0)

      pre.scrollTop = 390 // back near the end: 500 - 390 - 100 < 24
      fireEvent.scroll(pre)
      readTerminalBuffer.mockResolvedValue(buffer('one\r\ntwo\r\nthree\r\n'))
      await refresh()
      expect(pre.scrollTop).toBe(500)
    })
  })
})
