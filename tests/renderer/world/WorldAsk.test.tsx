import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup, waitFor, within } from '@testing-library/react'
import { minimal } from './helpers'

const vm = vi.hoisted(() => ({
  status: 'idle' as string,
  errorMsg: null as string | null,
  toggle: vi.fn(),
  sink: null as ((t: string) => void) | null,
  args: null as unknown[] | null,
  start: vi.fn(),
  stop: vi.fn(),
  /** The hook's `cancel` (WP-VOICE): absent unless a test gives it one. */
  cancel: undefined as ReturnType<typeof vi.fn> | undefined,
  /** The hook's `notice` (WP-VOICE, the 5-minute cap): undefined stands for a hook without it. */
  notice: null as string | null | undefined,
}))
vi.mock('../../../src/renderer/src/hooks/useVoiceInput', () => ({
  useVoiceInput: (...args: unknown[]) => {
    vm.args = args
    vm.sink = (args[2] as { onTranscript: (t: string) => void }).onTranscript
    return { status: vm.status, errorMsg: vm.errorMsg, toggle: vm.toggle, start: vm.start, stop: vm.stop, ...(vm.cancel ? { cancel: vm.cancel } : {}), ...(vm.notice !== undefined ? { notice: vm.notice } : {}) }
  }
}))
import { WorldAsk } from '../../../src/renderer/src/components/World/WorldAsk'
import { ANSWER_TEXT_CEILING, ANSWER_TEXT_MAX_HEIGHT, NO_MEMORY_NOTE, answerTextMaxHeight, evidenceReach } from '../../../src/renderer/src/components/World/WorldAnswer'
import { useTerminalStore } from '../../../src/renderer/src/store/terminalStore'
import type { AskRequest, AskResult } from '../../../src/shared/world/types'
import { spokenText } from '../../../src/shared/world/answerMarkdown'

type Res = { success: true; data: AskResult } | { success: false; error: string }
const okRes = (askId: string, text: string, over: Record<string, unknown> = {}): Res => ({
  success: true,
  data: {
    askId, ok: true, answer: { text, sentences: [{ text, actions: [0], sep: '' }], actions: [{ type: 'reset' }], evidence: [], dropped: 0, unsupported: [], uncited: false },
    summary: 's', cited: {}, ...over
  } as AskResult
})
const settle = () => act(async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)) })

function makeViewer() {
  return {
    getSelection: vi.fn(() => ['b1']), cameraRegion: vi.fn(() => ['b1']),
    play: vi.fn(async () => undefined), cancelActions: vi.fn(), apply: vi.fn(async () => undefined)
  }
}

let ask: ReturnType<typeof vi.fn>
let cancel: ReturnType<typeof vi.fn>
let settingsGet: ReturnType<typeof vi.fn>
const speech = { speak: vi.fn(), cancel: vi.fn() }

beforeEach(() => {
  ask = vi.fn(async (req: AskRequest) => okRes(req.askId, 'The answer.'))
  cancel = vi.fn(async () => ({ success: true, data: true }))
  settingsGet = vi.fn(async () => ({ success: true, data: { worldLabelling: true, worldSpeakAnswers: false } }))
  ;(window as any).termpolis = { worldAsk: ask, worldAskCancel: cancel, worldSettingsGet: settingsGet }
  speech.speak.mockClear(); speech.cancel.mockClear()
  Object.defineProperty(window, 'speechSynthesis', { value: speech, configurable: true, writable: true })
  ;(window as any).SpeechSynthesisUtterance = class { text: string; constructor(t: string) { this.text = t } }
})
afterEach(() => {
  cleanup()
  delete (window as any).termpolis
  delete (window as any).speechSynthesis
  delete (window as any).SpeechSynthesisUtterance
})

/** A stand-in for WorldView's side of the link: it holds the box's Esc handler and its busy flag. */
function makeLink() {
  let esc: (() => boolean) | null = null
  const link = { onEscape: vi.fn((fn: (() => boolean) | null) => { esc = fn }), setBusy: vi.fn() }
  return { link, esc: (): boolean => (esc as () => boolean)(), has: () => esc !== null }
}
const lastBusy = (link: { setBusy: ReturnType<typeof vi.fn> }): unknown => link.setBusy.mock.calls[link.setBusy.mock.calls.length - 1][0]

const input = () => screen.getByPlaceholderText('Ask about this project…') as HTMLInputElement
async function submit(v: ReturnType<typeof makeViewer>, q: string, extra: Record<string, unknown> = {}) {
  const view = render(<WorldAsk viewer={v as never} doc={minimal()} root="r" {...extra} />)
  await settle()
  fireEvent.change(input(), { target: { value: q } })
  fireEvent.keyDown(input(), { key: 'Enter' })
  await settle()
  return view
}

describe('WorldAsk', () => {
  it('fills its slot and never sets its own width, so in a 360 px pane the chips wrap and the input shrinks', async () => {
    const v = makeViewer()
    ask.mockResolvedValueOnce({ success: false, error: 'bridge down' })
    const { container } = render(<WorldAsk viewer={v as never} doc={minimal()} root="r" />)
    await settle()
    expect(screen.getByTestId('world-ask')).toHaveClass('w-full')
    expect(screen.getByTestId('world-ask-chips')).toHaveClass('flex-wrap', 'max-w-full')
    for (const chip of screen.getByTestId('world-ask-chips').querySelectorAll('button')) expect(chip).toHaveClass('max-w-full')
    expect(screen.getByTestId('world-ask-row')).toHaveClass('w-full')
    expect(input()).toHaveClass('flex-1', 'min-w-0')
    fireEvent.change(input(), { target: { value: 'q' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    await settle()
    expect(screen.getByRole('alert')).toHaveClass('w-full')
    fireEvent.change(input(), { target: { value: 'q2' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    await settle()
    expect(screen.getByTestId('world-answer')).toHaveClass('w-full')
    // No fixed rem width or window-relative cap anywhere in the bar: those overflowed a narrow pane.
    expect(container.innerHTML).not.toMatch(/w-\[\d+rem\]|\d+vw/)
  })

  it('is disabled and greyed while the viewer is null', () => {
    render(<WorldAsk viewer={null} root="r" />)
    expect(input()).toBeDisabled()
    fireEvent.click(screen.getByText('Where is memory stored?'))
    expect(ask).not.toHaveBeenCalled()
  })

  it('submitting calls worldAsk with the selection and camera region (Enter)', async () => {
    const v = makeViewer()
    await submit(v, 'What is this?')
    expect(ask.mock.calls[0][0]).toMatchObject({ question: 'What is this?', selection: ['b1'], cameraRegion: ['b1'], root: 'r' })
    expect(within(screen.getByTestId('world-answer')).getByText('The answer.')).toBeInTheDocument()
    expect(input().value).toBe('')
  })

  it('the send button submits too, and is inert for blank input', async () => {
    const v = makeViewer()
    render(<WorldAsk viewer={v as never} root="r" />)
    await settle()
    fireEvent.click(screen.getByLabelText('Ask'))
    expect(ask).not.toHaveBeenCalled()
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(ask).not.toHaveBeenCalled()
    fireEvent.keyDown(input(), { key: 'a' })
    fireEvent.change(input(), { target: { value: 'hi' } })
    fireEvent.click(screen.getByLabelText('Ask'))
    await settle()
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('answer actions are played via viewer.play', async () => {
    const v = makeViewer()
    await submit(v, 'q')
    expect(v.play).toHaveBeenCalledWith([{ type: 'reset' }])
  })

  it('lifts an older answer fog (not reset: that would close the card) before it plays a new one', async () => {
    const v = makeViewer()
    await submit(v, 'q')
    expect(v.apply).toHaveBeenCalledWith({ type: 'fog', ids: [] })
    expect(v.apply).not.toHaveBeenCalledWith({ type: 'reset' })
  })

  it('says so when the evidence does not support the answer, and when it cites none', async () => {
    const v = makeViewer()
    ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, 'Nothing records why.', {
      answer: { text: 'Nothing records why.', sentences: [{ text: 'Nothing records why.', actions: [0], sep: '' }], actions: [{ type: 'fog', ids: ['b1'] }], evidence: [], dropped: 0, unsupported: ['b1'], uncited: true }
    }))
    await submit(v, 'why?')
    const note = screen.getByRole('note')
    expect(screen.getByText("The evidence doesn't say. The fogged parts aren't supported.")).toBeInTheDocument()
    expect(screen.getByText('This answer cites no evidence.')).toBeInTheDocument()
    expect(note.textContent).not.toContain('b1')
  })

  it('shows no honesty note for a supported, cited answer', async () => {
    const v = makeViewer()
    await submit(v, 'q')
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('says quietly when the answer was made without the project memory, and why (WPA)', async () => {
    for (const [why, text] of Object.entries(NO_MEMORY_NOTE)) {
      const v = makeViewer()
      ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, 'The answer.', { noMemory: why }))
      const view = await submit(v, 'q')
      const note = screen.getByTestId('world-answer-memory')
      expect(note.textContent).toBe(text)
      // Outside the answer's scroller, so it is always on show, and not an honesty note.
      expect(screen.getByTestId('world-answer-scroll').contains(note)).toBe(false)
      expect(screen.queryByRole('note')).toBeNull()
      view.unmount()
    }
    expect(Object.keys(NO_MEMORY_NOTE).sort()).toEqual(['down', 'empty', 'locked', 'timeout'])
  })

  it('says the answer comes from the code alone when no saved notes matched, in the approved words (WPA2 M8)', async () => {
    const v = makeViewer()
    ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, 'The answer.', { noMemory: 'empty' }))
    await submit(v, 'q')
    const note = screen.getByTestId('world-answer-memory')
    expect(note.textContent).toBe('No saved notes matched this question, so this answer comes from the code alone.')
    expect(note.className).toContain('text-xs') // the same quiet line as the other memory notes
    expect(note.className).toContain('break-words') // wraps in a narrow pane rather than running off it
  })

  it('shows no memory note for an answer made with the memory', async () => {
    const v = makeViewer()
    await submit(v, 'q')
    expect(screen.queryByTestId('world-answer-memory')).toBeNull()
  })

  it('Show me again cancels running actions then replays them', async () => {
    const v = makeViewer()
    await submit(v, 'q')
    v.play.mockClear()
    fireEvent.click(screen.getByText('Show me again'))
    expect(v.cancelActions).toHaveBeenCalled()
    expect(v.play).toHaveBeenCalledWith([{ type: 'reset' }])
  })

  it('suggestion chip click asks that question; chips hide once a question is typed or answered', async () => {
    const v = makeViewer()
    render(<WorldAsk viewer={v as never} root="r" />)
    await settle()
    for (const q of ['How does it all fit together?', 'What happens when I press Enter in a terminal?', 'Where is memory stored?', "What isn't tested?"]) {
      expect(screen.getByText(q)).toBeInTheDocument()
    }
    fireEvent.change(input(), { target: { value: 'x' } })
    expect(screen.queryByText('Where is memory stored?')).toBeNull()
    fireEvent.change(input(), { target: { value: '' } })
    fireEvent.click(screen.getByText('Where is memory stored?'))
    await settle()
    expect(ask.mock.calls[0][0].question).toBe('Where is memory stored?')
    expect(screen.queryByText("What isn't tested?")).toBeNull()
  })

  it('shows a Thinking status while a question runs', async () => {
    const v = makeViewer()
    ask.mockImplementationOnce(() => new Promise(() => undefined))
    render(<WorldAsk viewer={v as never} root="r" />)
    await settle()
    fireEvent.change(input(), { target: { value: 'q' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(screen.getByRole('status')).toHaveTextContent('Thinking…')
  })

  it('a new question while thinking cancels the previous ask and the running actions', async () => {
    const v = makeViewer()
    ask.mockImplementationOnce(() => new Promise(() => undefined))
    render(<WorldAsk viewer={v as never} root="r" />)
    await settle()
    fireEvent.change(input(), { target: { value: 'one' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    await settle()
    const firstId = ask.mock.calls[0][0].askId
    fireEvent.change(input(), { target: { value: 'two' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    await settle()
    expect(cancel).toHaveBeenCalledWith(firstId)
    expect(v.cancelActions).toHaveBeenCalled()
  })

  it('error shows the message and a Retry that re-asks the last question', async () => {
    const v = makeViewer()
    ask.mockResolvedValueOnce({ success: false, error: 'bridge down' })
    await submit(v, 'why?')
    expect(screen.getByText('bridge down')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Retry'))
    await settle()
    expect(ask.mock.calls[1][0].question).toBe('why?')
    expect(within(screen.getByTestId('world-answer')).getByText('The answer.')).toBeInTheDocument()
  })

  it('a viewer whose play or apply rejects causes no unhandled rejection', async () => {
    const seen: unknown[] = []
    const onRej = (e: unknown) => { seen.push(e) }
    process.on('unhandledRejection', onRej)
    const v = makeViewer()
    v.play.mockRejectedValue(new Error('play boom'))
    v.apply.mockRejectedValue(new Error('apply boom'))
    ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, 'See [E1].', { cited: { E1: { kind: 'symbol', ref: 'b1', items: [] } } }))
    render(<WorldAsk viewer={v as never} doc={minimal()} root="r" />)
    await settle()
    fireEvent.change(input(), { target: { value: 'q' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    await settle()
    fireEvent.click(screen.getByText('Show me again'))
    fireEvent.click(screen.getByRole('button', { name: 'Evidence E1' }))
    await settle()
    process.off('unhandledRejection', onRej)
    expect(seen).toEqual([])
  })

  it('the error panel can be closed', async () => {
    const v = makeViewer()
    ask.mockResolvedValueOnce({ success: false, error: 'bridge down' })
    await submit(v, 'q')
    fireEvent.click(screen.getByLabelText('Close answer'))
    expect(screen.queryByText('bridge down')).toBeNull()
  })

  it('<img onerror> in answer text renders as text, not as an element', async () => {
    const v = makeViewer()
    const evil = '<img src=x onerror=alert(1)> hi'
    ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, evil))
    const { container } = await submit(v, 'q')
    expect(container.querySelector('img')).toBeNull()
    expect(within(screen.getByTestId('world-answer')).getByText(evil)).toBeInTheDocument()
  })

  describe('evidence chips', () => {
    const withCited = (text: string, cited: Record<string, unknown>) =>
      ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, text, { cited }))

    it('a chip for a part id opens its card in the viewer', async () => {
      const v = makeViewer()
      withCited('See [E1] now.', { E1: { kind: 'symbol', ref: 'b1', items: [] } })
      await submit(v, 'q')
      fireEvent.click(screen.getByRole('button', { name: 'Evidence E1' }))
      expect(v.apply).toHaveBeenCalledWith({ type: 'openCard', id: 'b1' })
    })

    it('a chip opens a card for an edge id too, whatever its kind', async () => {
      const v = makeViewer()
      withCited('See [E1].', { E1: { kind: 'file', ref: 'e1', items: [] } })
      await submit(v, 'q')
      fireEvent.click(screen.getByRole('button', { name: 'Evidence E1' }))
      expect(v.apply).toHaveBeenCalledWith({ type: 'openCard', id: 'e1' })
    })

    it('an id that is not in the loaded world (or no doc) shows the inline line instead', async () => {
      const v = makeViewer()
      withCited('See [E1].', { E1: { kind: 'symbol', ref: 'nope', items: [] } })
      await submit(v, 'q')
      fireEvent.click(screen.getByRole('button', { name: 'Evidence E1' }))
      expect(screen.getByText('symbol nope')).toBeInTheDocument()
      expect(v.apply).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'openCard' }))
      cleanup()
      withCited('See [E1].', { E1: { kind: 'symbol', ref: 'b1', items: [] } })
      await submit(v, 'q', { doc: null })
      fireEvent.click(screen.getByRole('button', { name: 'Evidence E1' }))
      expect(screen.getByText('symbol b1')).toBeInTheDocument()
      cleanup()
      withCited('See [E1].', { E1: { kind: 'symbol', ref: 'b1', items: [] } })
      render(<WorldAsk viewer={v as never} root="r" />)
      await settle()
      fireEvent.change(input(), { target: { value: 'q' } })
      fireEvent.keyDown(input(), { key: 'Enter' })
      await settle()
      fireEvent.click(screen.getByRole('button', { name: 'Evidence E1' }))
      expect(v.apply).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'openCard' }))
    })

    it('a file chip toggles an inline line showing kind and ref', async () => {
      const v = makeViewer()
      withCited('See [E2].', { E2: { kind: 'file', ref: 'src/main/x.ts', items: [] } })
      await submit(v, 'q')
      const chip = screen.getByRole('button', { name: 'Evidence E2' })
      fireEvent.click(chip)
      expect(screen.getByText('file src/main/x.ts')).toBeInTheDocument()
      expect(v.apply).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'openCard' }))
      fireEvent.click(chip)
      expect(screen.queryByText('file src/main/x.ts')).toBeNull()
    })

    it('the answer scrolls inside a capped region of its own; the ×, the honesty note and Show me again stay outside it (round 4: I2)', async () => {
      const v = makeViewer()
      ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, 'Long [E1].', {
        cited: { E1: { kind: 'file', ref: 'src/a.ts', items: [] } },
        answer: { text: 'Long [E1].', sentences: [{ text: 'Long [E1].', actions: [0], sep: '' }], actions: [{ type: 'reset' }], evidence: [], dropped: 0, unsupported: [], uncited: true }
      }))
      await submit(v, 'q')
      const scroller = screen.getByTestId('world-answer-scroll')
      expect(ANSWER_TEXT_MAX_HEIGHT).toBe('6rem')
      expect(scroller.style.maxHeight).toBe(answerTextMaxHeight(0))
      expect(scroller.className).toMatch(/(^| )overflow-y-auto( |$)/)
      expect(scroller).toHaveAttribute('role', 'region')
      expect(scroller).toHaveAccessibleName('Answer')
      expect(scroller.tabIndex).toBe(0)
      expect(scroller.contains(screen.getByTestId('world-answer-text'))).toBe(true)
      expect(scroller.contains(screen.getByRole('button', { name: 'Evidence E1' }))).toBe(true)
      for (const outside of [screen.getByRole('button', { name: 'Close answer' }), screen.getByRole('note'), screen.getByRole('button', { name: 'Show me again' })]) {
        expect(scroller.contains(outside)).toBe(false)
      }
      // An opened evidence line is inside the scroller too, so the panel never grows past its cap.
      fireEvent.click(screen.getByRole('button', { name: 'Evidence E1' }))
      expect(scroller.contains(screen.getByTestId('evidence-view'))).toBe(true)
    })

    it('an evidence line that opens is scrolled into view; one that closes is not (round 4: I2)', async () => {
      const into = vi.fn()
      const was = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
      Object.defineProperty(Element.prototype, 'scrollIntoView', { value: into, configurable: true, writable: true })
      try {
        const v = makeViewer()
        withCited('See [E1] and [E2].', { E1: { kind: 'file', ref: 'src/a.ts', items: [] }, E2: { kind: 'file', ref: 'src/b.ts', items: [] } })
        await submit(v, 'q')
        const chip = (n: number): HTMLElement => screen.getByRole('button', { name: `Evidence E${n}` })
        fireEvent.click(chip(2))
        expect(into).toHaveBeenCalledTimes(1)
        expect(into.mock.instances[0]).toBe(screen.getByText('file src/b.ts').closest('[data-evidence-label]'))
        expect(into).toHaveBeenLastCalledWith({ block: 'nearest' })
        fireEvent.click(chip(2))
        expect(into).toHaveBeenCalledTimes(1)
        // Opened again, it is scrolled to again.
        fireEvent.click(chip(2))
        expect(into).toHaveBeenCalledTimes(2)
        fireEvent.click(chip(1))
        expect(into).toHaveBeenCalledTimes(3)
        expect(into.mock.instances[2]).toBe(screen.getByText('file src/a.ts').closest('[data-evidence-label="E1"]'))
      } finally {
        if (was) Object.defineProperty(Element.prototype, 'scrollIntoView', was)
        else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
      }
    })

    it('the answer grows past its cap only as far as its first two pieces of evidence reach, never past the ceiling', () => {
      expect(ANSWER_TEXT_CEILING).toBe('8rem')
      expect(answerTextMaxHeight(null)).toBe('6rem')
      expect(answerTextMaxHeight(130)).toBe('max(6rem, min(8rem, 130px))')
      const box = document.body.appendChild(document.createElement('div'))
      expect(evidenceReach(box)).toBeNull()
      const chip = (label: string, top: number, height: number): void => {
        const el = document.createElement('button')
        el.setAttribute('data-evidence', label)
        Object.defineProperty(el, 'offsetTop', { value: top })
        Object.defineProperty(el, 'offsetHeight', { value: height })
        box.appendChild(el)
      }
      // One chip: as far as it reaches.
      chip('E2', 90, 20.4)
      expect(evidenceReach(box)).toBe(111)
      // E2 cited again further down, then E1 above it, then E3 far below: the first two distinct ones count.
      chip('E2', 400, 20)
      chip('E1', 30, 20)
      chip('E3', 600, 20)
      expect(evidenceReach(box)).toBe(111)
      // In a line taller than the chip, the half of the leading below it counts: 90 + 20.4 + (24 - 20.4) / 2.
      box.style.lineHeight = '24px'
      expect(evidenceReach(box)).toBe(113)
      // A line no taller than the chip adds nothing.
      box.style.lineHeight = '20px'
      expect(evidenceReach(box)).toBe(111)
      box.remove()
    })

    it('the panel measures the reach on each render and as the text reflows, and stops watching when it goes', async () => {
      let reflow: () => void = () => {}
      const disconnect = vi.fn()
      vi.stubGlobal('ResizeObserver', class {
        constructor(cb: () => void) { reflow = cb }
        observe(): void {}
        disconnect(): void { disconnect() }
      })
      try {
        const v = makeViewer()
        withCited('See [E1] and [E2].', { E1: { kind: 'file', ref: 'src/a.ts', items: [] }, E2: { kind: 'file', ref: 'src/b.ts', items: [] } })
        const { unmount } = await submit(v, 'q')
        const scroller = screen.getByTestId('world-answer-scroll')
        // jsdom lays nothing out: both chips at 0.
        expect(scroller.style.maxHeight).toBe(answerTextMaxHeight(0))
        expect(scroller.className).toMatch(/(^| )relative( |$)/)
        // A narrower pane wraps E2 onto a lower line.
        Object.defineProperty(screen.getByRole('button', { name: 'Evidence E2' }), 'offsetTop', { value: 112, configurable: true })
        Object.defineProperty(screen.getByRole('button', { name: 'Evidence E2' }), 'offsetHeight', { value: 18, configurable: true })
        act(() => { reflow() })
        expect(scroller.style.maxHeight).toBe(answerTextMaxHeight(130))
        // Reflowed to the same place: nothing changes.
        act(() => { reflow() })
        expect(scroller.style.maxHeight).toBe(answerTextMaxHeight(130))
        unmount()
        expect(disconnect).toHaveBeenCalled()
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('a chip names the part it cites: E1 · <building name>, or the edge label', async () => {
      const v = makeViewer()
      const doc = minimal()
      withCited('See [E1] and [E2] and [E3].', {
        E1: { kind: 'file', ref: 'src/main/index.ts', items: ['b1'] },
        E2: { kind: 'file', ref: 'e1', items: [] },
        E3: { kind: 'file', ref: 'x.ts', items: [] }
      })
      await submit(v, 'q', { doc })
      expect(screen.getByRole('button', { name: 'Evidence E1' })).toHaveTextContent(`E1 · ${doc.buildings[0].name}`)
      expect(screen.getByRole('button', { name: 'Evidence E2' })).toHaveTextContent(`E2 · ${doc.edges[0].label}`)
      expect(screen.getByRole('button', { name: 'Evidence E3' })).toHaveTextContent(/^E3$/)
    })

    it('clicking a chip opens its part, then highlights its items', async () => {
      const v = makeViewer()
      withCited('See [E1].', { E1: { kind: 'file', ref: 'src/main/index.ts', items: ['b1', 'e1'] } })
      await submit(v, 'q')
      v.apply.mockClear()
      fireEvent.click(screen.getByRole('button', { name: 'Evidence E1' }))
      await settle()
      expect(v.apply.mock.calls).toEqual([[{ type: 'openCard', id: 'b1' }], [{ type: 'highlight', ids: ['b1', 'e1'] }]])
      expect(screen.getByText('file src/main/index.ts')).toBeInTheDocument()
    })

    it('a chip for a part id highlights its items too', async () => {
      const v = makeViewer()
      withCited('See [E1].', { E1: { kind: 'symbol', ref: 'b1', items: ['b2'] } })
      await submit(v, 'q')
      v.apply.mockClear()
      fireEvent.click(screen.getByRole('button', { name: 'Evidence E1' }))
      await settle()
      expect(v.apply.mock.calls).toEqual([[{ type: 'openCard', id: 'b1' }], [{ type: 'highlight', ids: ['b2'] }]])
    })

    it('the answer text appears one sentence at a time', async () => {
      const v = makeViewer()
      ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, 'First one. Second one.', {
        answer: { text: 'First one. Second one.', sentences: [{ text: 'First one.', actions: [0], sep: '' }, { text: 'Second one.', actions: [], sep: ' ' }], actions: [{ type: 'reset' }], evidence: [], dropped: 0, unsupported: [], uncited: false }
      }))
      await submit(v, 'q')
      const shown = (): string => screen.getByTestId('world-answer').textContent ?? ''
      expect(shown()).toContain('First one.')
      expect(shown()).not.toContain('Second one.')
      await waitFor(() => expect(shown()).toContain('Second one.'), { timeout: 3000 })
    })

    it('a blank line between paragraphs survives into the shown answer', async () => {
      const v = makeViewer()
      ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, 'First one.\n\nSecond one.', {
        answer: { text: 'First one.\n\nSecond one.', sentences: [{ text: 'First one.', actions: [0], sep: '' }, { text: 'Second one.', actions: [], sep: '\n\n' }], actions: [{ type: 'reset' }], evidence: [], dropped: 0, unsupported: [], uncited: false }
      }))
      await submit(v, 'q')
      const paras = (): string[] => [...screen.getByTestId('world-answer-text').querySelectorAll('p')].map((p) => p.textContent ?? '')
      await waitFor(() => expect(paras()).toEqual(['First one.', 'Second one.']), { timeout: 3000 })
    })

    it('a markdown list with bold names shows as a list, never as literal stars (film bug 3)', async () => {
      const v = makeViewer()
      const text = 'Main parts:\n- **TerminalPane** draws a terminal.\n- *Store* keeps `state`, line one\n\nline two\nline three.'
      ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, text, {
        answer: { text, sentences: [{ text, actions: [0], sep: '' }], actions: [{ type: 'reset' }], evidence: [], dropped: 0, unsupported: [], uncited: false }
      }))
      await submit(v, 'q')
      const box = screen.getByTestId('world-answer-text')
      expect(box.textContent).not.toContain('**')
      expect([...box.querySelectorAll('ul > li')].map((li) => li.textContent)).toEqual(['TerminalPane draws a terminal.', 'Store keeps state, line one'])
      expect(box.querySelector('li strong')?.textContent).toBe('TerminalPane')
      expect(box.querySelector('li em')?.textContent).toBe('Store')
      expect(box.querySelector('li code')?.textContent).toBe('state')
      expect(box.querySelector('p br')).not.toBeNull()
    })

    it('a numbered list keeps its evidence chips', async () => {
      const v = makeViewer()
      withCited('1. **First** step [E1].\n2. Second.', { E1: { label: 'E1', kind: 'file', ref: 'src/a.ts', items: [] } })
      await submit(v, 'q')
      const box = screen.getByTestId('world-answer-text')
      expect(box.querySelectorAll('ol > li')).toHaveLength(2)
      expect(box.querySelector('ol > li button')?.getAttribute('aria-label')).toBe('Evidence E1')
    })

    it('an unknown marker stays plain text', async () => {
      const v = makeViewer()
      withCited('Unknown [E9] marker.', {})
      await submit(v, 'q')
      expect(screen.queryByRole('button', { name: 'Evidence E9' })).toBeNull()
      expect(screen.getByTestId('world-answer').textContent).toContain('Unknown [E9] marker.')
    })
  })

  describe('mic button', () => {
    const withMic = (): void => {
      Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true })
    }
    afterEach(() => {
      delete (navigator as any).mediaDevices
      vm.status = 'idle'; vm.errorMsg = null; vm.toggle.mockClear()
    })

    it('uses the hook with no terminal and a sink, and shows a mic only when capture is supported', () => {
      const a = render(<WorldAsk viewer={makeViewer() as never} root="r" />)
      expect(vm.args?.[0]).toBeNull()
      expect(vm.args?.[1]).toBe(false)
      expect(screen.queryByLabelText('Ask by voice')).toBeNull()
      a.unmount()
      withMic()
      render(<WorldAsk viewer={makeViewer() as never} root="r" />)
      fireEvent.click(screen.getByLabelText('Ask by voice'))
      expect(vm.toggle).toHaveBeenCalledTimes(1)
    })

    it('shows listening and transcribing states from the hook status', () => {
      withMic()
      vm.status = 'listening'
      const a = render(<WorldAsk viewer={makeViewer() as never} root="r" />)
      expect(screen.getByLabelText('Stop listening')).toBeInTheDocument()
      a.unmount()
      vm.status = 'transcribing'
      render(<WorldAsk viewer={makeViewer() as never} root="r" />)
      expect(screen.getByLabelText('Ask by voice').className).toContain('animate-pulse')
    })

    it('shows the hook notice (the 5-minute cap) as a quiet status line, not an alert; none without one', () => {
      vm.notice = 'Recording stopped after 5 minutes.'
      const view = render(<WorldAsk viewer={makeViewer() as never} root="r" />)
      expect(screen.getByRole('status').textContent).toBe('Recording stopped after 5 minutes.')
      expect(screen.getByRole('status').className).toContain('text-[#9ca3af]')
      expect(screen.queryByRole('alert')).toBeNull()
      vm.notice = null
      view.rerender(<WorldAsk viewer={makeViewer() as never} root="r" />)
      expect(screen.queryByRole('status')).toBeNull()
      // A hook from before WP-VOICE has no notice at all.
      vm.notice = undefined
      view.rerender(<WorldAsk viewer={makeViewer() as never} root="r" />)
      expect(screen.queryByRole('status')).toBeNull()
      vm.notice = null
    })

    it('shows the hook error as plain text under the input', () => {
      vm.errorMsg = 'Groq heard no speech'
      render(<WorldAsk viewer={makeViewer() as never} root="r" />)
      expect(screen.getByRole('alert').textContent).toBe('Groq heard no speech')
    })

    it('voice transcript fills the input and asks', async () => {
      render(<WorldAsk viewer={makeViewer() as never} root="r" />)
      await settle()
      await act(async () => { vm.sink?.('where is memory stored') })
      await settle()
      expect(input().value).toBe('where is memory stored')
      expect(ask).toHaveBeenCalledTimes(1)
      expect((ask.mock.calls[0][0] as AskRequest).question).toBe('where is memory stored')
    })

    it('is absent without a voice prop and drives it when given', async () => {
      const v = makeViewer()
      const a = render(<WorldAsk viewer={v as never} root="r" />)
      expect(screen.queryByLabelText('Ask by voice')).toBeNull()
      a.unmount()
      const toggle = vi.fn()
      const b = render(<WorldAsk viewer={v as never} root="r" voice={{ supported: true, listening: false, toggle }} />)
      fireEvent.click(screen.getByLabelText('Ask by voice'))
      expect(toggle).toHaveBeenCalled()
      b.unmount()
      render(<WorldAsk viewer={v as never} root="r" voice={{ supported: true, listening: true, toggle }} />)
      expect(screen.getByLabelText('Stop listening')).toBeInTheDocument()
    })

    describe('tap or hold', () => {
      const mode = (m: 'tapOrHold' | 'toggle' | 'tapSpace'): void => { useTerminalStore.getState().setVoiceSettings({ pushToTalkMode: m }) }
      const mount = (listening = false) => {
        const voice = { supported: true, listening, toggle: vi.fn(), start: vi.fn(), stop: vi.fn() }
        render(<WorldAsk viewer={makeViewer() as never} root="r" voice={voice} />)
        return { voice, btn: screen.getByLabelText(listening ? 'Stop listening' : 'Ask by voice') }
      }
      beforeEach(() => { vi.useFakeTimers(); mode('tapOrHold') })
      afterEach(() => { vi.useRealTimers(); mode('tapOrHold') })

      it('holding 600 ms records and stops on release', () => {
        const { voice, btn } = mount()
        const capture = vi.fn()
        ;(btn as any).setPointerCapture = capture
        fireEvent.pointerDown(btn, { button: 0, pointerId: 3 })
        expect(voice.start).toHaveBeenCalledTimes(1)
        expect(capture).toHaveBeenCalledWith(3)
        vi.advanceTimersByTime(600)
        fireEvent.pointerUp(btn, { button: 0 })
        expect(voice.stop).toHaveBeenCalledTimes(1)
        fireEvent.click(btn, { detail: 1 })
        expect(voice.toggle).not.toHaveBeenCalled()
      })

      it('a 100 ms tap starts and the next tap stops', () => {
        const a = mount()
        fireEvent.pointerDown(a.btn, { button: 0 })
        vi.advanceTimersByTime(100)
        fireEvent.pointerUp(a.btn, { button: 0 })
        expect(a.voice.start).toHaveBeenCalledTimes(1)
        expect(a.voice.stop).not.toHaveBeenCalled()
        cleanup()
        const b = mount(true)
        fireEvent.pointerDown(b.btn, { button: 0 })
        expect(b.voice.stop).toHaveBeenCalledTimes(1)
        expect(b.voice.start).not.toHaveBeenCalled()
        fireEvent.pointerUp(b.btn, { button: 0 })
        expect(b.voice.stop).toHaveBeenCalledTimes(1)
      })

      it('ignores a non-primary button, and a second press while one is in progress', () => {
        const { voice, btn } = mount()
        fireEvent.pointerDown(btn, { button: 2 })
        expect(voice.start).not.toHaveBeenCalled()
        fireEvent.pointerDown(btn, { button: 0 })
        fireEvent.pointerDown(btn, { button: 0 })
        expect(voice.start).toHaveBeenCalledTimes(1)
      })

      it('a pointercancel stops the mic, a hold or a press as short as a tap; with no press it does nothing', () => {
        const a = mount()
        fireEvent.pointerDown(a.btn, { button: 0 })
        vi.advanceTimersByTime(500)
        fireEvent.pointerCancel(a.btn)
        expect(a.voice.stop).toHaveBeenCalledTimes(1)
        cleanup()
        const b = mount()
        fireEvent.pointerDown(b.btn, { button: 0 })
        vi.advanceTimersByTime(50)
        fireEvent.pointerCancel(b.btn)
        expect(b.voice.stop).toHaveBeenCalledTimes(1)
        fireEvent.pointerCancel(b.btn)
        expect(b.voice.stop).toHaveBeenCalledTimes(1)
      })

      it('the button going off mid-press ends the press: the mic stops and no stale hold fires later', () => {
        const voice = { supported: true, listening: false, toggle: vi.fn(), start: vi.fn(), stop: vi.fn() }
        const v = makeViewer()
        const { rerender } = render(<WorldAsk viewer={v as never} root="r" voice={voice} />)
        fireEvent.pointerDown(screen.getByLabelText('Ask by voice'), { button: 0 })
        expect(voice.start).toHaveBeenCalledTimes(1)
        rerender(<WorldAsk viewer={v as never} root="" voice={voice} />)
        expect(voice.stop).toHaveBeenCalledTimes(1)
        // Back on: the next press starts afresh rather than reading as the second of a stale one.
        rerender(<WorldAsk viewer={v as never} root="r" voice={voice} />)
        expect(voice.stop).toHaveBeenCalledTimes(1)
        vi.advanceTimersByTime(5000)
        fireEvent.pointerDown(screen.getByLabelText('Ask by voice'), { button: 0 })
        expect(voice.start).toHaveBeenCalledTimes(2)
        // Disabled with no press in progress stops nothing.
        fireEvent.pointerUp(screen.getByLabelText('Ask by voice'), { button: 0 })
        rerender(<WorldAsk viewer={v as never} root="" voice={voice} />)
        expect(voice.stop).toHaveBeenCalledTimes(1)
      })

      it('keyboard activation (a click with no pointer) still toggles', () => {
        const { voice, btn } = mount()
        fireEvent.click(btn)
        expect(voice.toggle).toHaveBeenCalledTimes(1)
      })

      it.each(['toggle', 'tapSpace'] as const)('in %s mode a click toggles and a press does nothing', (m) => {
        mode(m)
        const { voice, btn } = mount()
        fireEvent.pointerDown(btn, { button: 0 })
        fireEvent.pointerUp(btn, { button: 0 })
        expect(voice.start).not.toHaveBeenCalled()
        fireEvent.click(btn, { detail: 1 })
        expect(voice.toggle).toHaveBeenCalledTimes(1)
      })

      it('a voice with no start and stop falls back to a click toggle', () => {
        const toggle = vi.fn()
        render(<WorldAsk viewer={makeViewer() as never} root="r" voice={{ supported: true, listening: false, toggle }} />)
        const btn = screen.getByLabelText('Ask by voice')
        fireEvent.pointerDown(btn, { button: 0 })
        fireEvent.click(btn, { detail: 1 })
        expect(toggle).toHaveBeenCalledTimes(1)
      })

      it("the built-in mic hands the hook's start and stop to the button", () => {
        Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true })
        render(<WorldAsk viewer={makeViewer() as never} root="r" />)
        const btn = screen.getByLabelText('Ask by voice')
        fireEvent.pointerDown(btn, { button: 0 })
        vi.advanceTimersByTime(700)
        fireEvent.pointerUp(btn, { button: 0 })
        expect(vm.start).toHaveBeenCalled()
        expect(vm.stop).toHaveBeenCalled()
      })
    })

    it('sends the id of the proposal the toolbar selected, and none when "No proposal" is chosen', async () => {
      const d = minimal()
      d.layers.plan.push(
        { id: 'pA', title: 'A', summary: [], buildings: [], edges: [] },
        { id: 'pB', title: 'B', summary: [], buildings: [], edges: [], reconcile: { matched: {}, missing: [], extra: [], changed: [], planAt: 1 } }
      )
      const first = await submit(makeViewer(), 'q', { doc: d, proposal: 'pB' })
      expect((ask.mock.calls[0][0] as AskRequest).proposalId).toBe('pB')
      first.unmount()
      ask.mockClear()
      await submit(makeViewer(), 'q', { doc: d, proposal: null })
      expect((ask.mock.calls[0][0] as AskRequest).proposalId).toBeUndefined()
    })

    it('is hidden when the voice is unsupported', () => {
      render(<WorldAsk viewer={makeViewer() as never} root="r" voice={{ supported: false, listening: false, toggle: vi.fn() }} />)
      expect(screen.queryByLabelText('Ask by voice')).toBeNull()
    })
  })

  describe('spoken answers', () => {
    const on = () => settingsGet.mockResolvedValue({ success: true, data: { worldLabelling: true, worldSpeakAnswers: true } })

    it('off by default: speak is not called', async () => {
      await submit(makeViewer(), 'q')
      expect(speech.speak).not.toHaveBeenCalled()
    })

    it('on: speaks the answer once, markers stripped', async () => {
      on()
      ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, 'Memory lives in SQLite [E1] always.', { cited: {} }))
      await submit(makeViewer(), 'q')
      expect(speech.speak).toHaveBeenCalledTimes(1)
      expect(speech.speak.mock.calls[0][0].text).toBe('Memory lives in SQLite always.')
    })

    it('on: a formatted answer is read without its marks, each list step ending in a pause (round 3 C)', async () => {
      on()
      ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, 'It goes:\n1. **Terminal** [E1]\n2. **Proxy**', { cited: {} }))
      await submit(makeViewer(), 'q')
      expect(speech.speak.mock.calls[0][0].text).toBe('It goes: 1. Terminal. 2. Proxy.')
    })

    it('Esc from the pane stops the speech and says it used the key; with nothing to stop it does not', async () => {
      on()
      const l = makeLink()
      await submit(makeViewer(), 'q', { link: l.link })
      expect(speech.speak).toHaveBeenCalledTimes(1)
      speech.cancel.mockClear()
      let used: unknown
      act(() => { used = l.esc() })
      expect(used).toBe(true)
      expect(speech.cancel).toHaveBeenCalled()
      expect(cancel).not.toHaveBeenCalled()
      act(() => { used = l.esc() })
      expect(used).toBe(false)
    })

    it('Esc from the pane while thinking cancels the ask and says it used the key', async () => {
      const v = makeViewer()
      const l = makeLink()
      ask.mockImplementationOnce(() => new Promise(() => undefined))
      render(<WorldAsk viewer={v as never} root="r" link={l.link} />)
      await settle()
      fireEvent.change(input(), { target: { value: 'q' } })
      fireEvent.keyDown(input(), { key: 'Enter' })
      await settle()
      let used: unknown
      act(() => { used = l.esc() })
      expect(used).toBe(true)
      expect(cancel).toHaveBeenCalledWith(ask.mock.calls[0][0].askId)
      expect(screen.queryByRole('status')).toBeNull()
    })

    it('tells the pane it is busy while thinking, playing or speaking, and idle once all of that is over', async () => {
      on()
      const l = makeLink()
      const v = makeViewer()
      let endTour!: () => void
      v.play.mockImplementationOnce(() => new Promise<undefined>((r) => { endTour = () => r(undefined) }))
      const d: { resolve?: (r: Res) => void } = {}
      ask.mockImplementationOnce(() => new Promise<Res>((r) => { d.resolve = r }))
      const view = render(<WorldAsk viewer={v as never} doc={minimal()} root="r" link={l.link} />)
      await settle()
      expect(l.has()).toBe(true)
      expect(lastBusy(l.link)).toBe(false)
      fireEvent.change(input(), { target: { value: 'q' } })
      fireEvent.keyDown(input(), { key: 'Enter' })
      expect(lastBusy(l.link)).toBe(true)
      await settle()
      await act(async () => { (d.resolve as (r: Res) => void)(okRes(ask.mock.calls[0][0].askId, 'The answer.')) })
      expect(lastBusy(l.link)).toBe(true)
      await act(async () => { endTour() })
      expect(lastBusy(l.link)).toBe(true) // still speaking
      const u = speech.speak.mock.calls[0][0] as { onend: () => void; onerror: () => void }
      act(() => { u.onend() })
      expect(lastBusy(l.link)).toBe(false)
      view.unmount()
      expect(l.has()).toBe(false)
      expect(lastBusy(l.link)).toBe(false)
    })

    it('the end of an utterance that was already hushed changes nothing', async () => {
      on()
      const l = makeLink()
      ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, 'First.'))
      await submit(makeViewer(), 'q', { link: l.link })
      const first = speech.speak.mock.calls[0][0] as { onerror: () => void }
      // A second question hushes the first answer; its answer is read aloud in turn.
      fireEvent.change(input(), { target: { value: 'again' } })
      fireEvent.keyDown(input(), { key: 'Enter' })
      await settle()
      expect(speech.speak).toHaveBeenCalledTimes(2)
      act(() => { first.onerror() })
      expect(lastBusy(l.link)).toBe(true)
    })

    it('without a root the bar is off', () => {
      render(<WorldAsk viewer={makeViewer() as never} root="" />)
      expect(input()).toBeDisabled()
    })

    it('closing the panel cancels speech', async () => {
      on()
      await submit(makeViewer(), 'q')
      speech.cancel.mockClear()
      fireEvent.click(screen.getByLabelText('Close answer'))
      expect(speech.cancel).toHaveBeenCalled()
      expect(screen.queryByText('The answer.')).toBeNull()
    })

    it('a new question cancels speech', async () => {
      on()
      render(<WorldAsk viewer={makeViewer() as never} root="r" />)
      await settle()
      speech.cancel.mockClear()
      fireEvent.change(input(), { target: { value: 'q' } })
      fireEvent.keyDown(input(), { key: 'Enter' })
      expect(speech.cancel).toHaveBeenCalled()
    })

    it('unmount cancels speech', async () => {
      const { unmount } = render(<WorldAsk viewer={makeViewer() as never} root="r" />)
      await settle()
      speech.cancel.mockClear()
      unmount()
      expect(speech.cancel).toHaveBeenCalled()
    })

    it('no speechSynthesis: nothing throws, nothing is spoken', async () => {
      on()
      delete (window as any).speechSynthesis
      const v = makeViewer()
      const l = makeLink()
      const { unmount } = await submit(v, 'q', { link: l.link })
      act(() => { l.esc() })
      expect(speech.speak).not.toHaveBeenCalled()
      unmount()
    })

    it('a refused, failed or missing settings read keeps speech off', async () => {
      for (const make of [
        () => settingsGet.mockResolvedValue({ success: false, error: 'x' }),
        () => settingsGet.mockRejectedValue(new Error('ipc')),
        () => { delete (window as any).termpolis.worldSettingsGet }
      ]) {
        make()
        speech.speak.mockClear()
        const { unmount } = await submit(makeViewer(), 'q')
        expect(speech.speak).not.toHaveBeenCalled()
        unmount()
      }
    })

    it('a settings read that lands after unmount is ignored', async () => {
      let resolve!: (v: unknown) => void
      settingsGet.mockImplementation(() => new Promise((r) => { resolve = r }))
      const { unmount } = render(<WorldAsk viewer={makeViewer() as never} root="r" />)
      unmount()
      resolve({ success: true, data: { worldSpeakAnswers: true } })
      await settle()
    })
  })
})

describe('WorldAsk: Esc and Close stop the answer tour, its timers and its speech together (T4)', () => {
  const on = () => settingsGet.mockResolvedValue({ success: true, data: { worldLabelling: true, worldSpeakAnswers: true } })
  /** An answer whose tour never lands on its own, so it is still playing when the key comes. */
  async function touring(speak: boolean) {
    if (speak) on()
    const v = makeViewer()
    v.play.mockImplementation(() => new Promise<undefined>(() => undefined))
    const l = makeLink()
    render(<WorldAsk viewer={v as never} doc={minimal()} root="r" link={l.link} />)
    await settle()
    fireEvent.change(input(), { target: { value: 'q' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    await settle()
    expect(v.play).toHaveBeenCalledTimes(1)
    expect(lastBusy(l.link)).toBe(true)
    v.cancelActions.mockClear()
    speech.cancel.mockClear()
    return { v, l }
  }

  for (const speak of [false, true]) {
    it(`Esc stops the tour in the viewer and says it used the key, so the camera is left alone (speech ${speak ? 'on' : 'off'})`, async () => {
      const { v, l } = await touring(speak)
      let used: unknown
      act(() => { used = l.esc() })
      expect(used).toBe(true)
      expect(v.cancelActions).toHaveBeenCalledTimes(1)
      expect(speech.cancel).toHaveBeenCalled()
      expect(lastBusy(l.link)).toBe(false)
      expect(document.activeElement).toBe(input())
      // The answer stays on show; a second Esc has nothing left to stop.
      expect(screen.getByTestId('world-answer')).toBeInTheDocument()
      act(() => { used = l.esc() })
      expect(used).toBe(false)
      expect(v.cancelActions).toHaveBeenCalledTimes(1)
    })
  }

  it('closing the answer stops its tour and its speech', async () => {
    const { v, l } = await touring(true)
    fireEvent.click(screen.getByLabelText('Close answer'))
    expect(v.cancelActions).toHaveBeenCalledTimes(1)
    expect(speech.cancel).toHaveBeenCalled()
    expect(lastBusy(l.link)).toBe(false)
  })
})

describe('WorldAsk: speech in bounded pieces that always ends (T6)', () => {
  const on = () => settingsGet.mockResolvedValue({ success: true, data: { worldLabelling: true, worldSpeakAnswers: true } })
  type U = { text: string; onend: () => void; onerror: () => void }
  const said = (): U[] => speech.speak.mock.calls.map((c) => c[0] as U)
  const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })
  const words = (w: string, n: number): string => Array.from({ length: n }, () => w).join(' ')
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); on() })
  afterEach(() => { vi.useRealTimers() })

  async function answered(text: string) {
    ask.mockImplementation(async (req: AskRequest) => okRes(req.askId, text, { cited: {} }))
    const l = makeLink()
    const view = render(<WorldAsk viewer={makeViewer() as never} doc={minimal()} root="r" link={l.link} />)
    await flush()
    fireEvent.change(input(), { target: { value: 'q' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    await flush(); await flush()
    return { l, view }
  }

  it('a long answer is read in pieces of at most 220 characters, one after another, broken after sentences', async () => {
    const a = words('alpha', 30) + '.'
    const b = words('bravo', 30) + '.'
    const text = `${a} ${b} Charlie ends.`
    const { l } = await answered(text)
    expect(said().map((u) => u.text)).toEqual([a])
    act(() => { said()[0].onend() })
    expect(said().map((u) => u.text)).toEqual([a, `${b} Charlie ends.`])
    // A late second end of the first piece does not read the second twice.
    act(() => { said()[0].onend() })
    expect(speech.speak).toHaveBeenCalledTimes(2)
    expect(lastBusy(l.link)).toBe(true)
    act(() => { said()[1].onend() })
    expect(speech.speak).toHaveBeenCalledTimes(2)
    expect(lastBusy(l.link)).toBe(false)
    expect(said().map((u) => u.text).join(' ')).toBe(spokenText(text))
  })

  it('a run-on sentence is broken between words, and a word longer than a piece is cut', async () => {
    const run = words('delta', 100) + ' ' + 'x'.repeat(300) + ' end.'
    await answered(run)
    for (let i = 0; i < 20 && said()[i]; i++) act(() => { said()[i].onend() })
    const pieces = said().map((u) => u.text)
    expect(pieces.length).toBeGreaterThan(3)
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(220)
    expect(pieces.join('').replace(/ /g, '')).toBe(spokenText(run).replace(/ /g, ''))
  })

  it('an engine that never ends a piece is given up on, so a newer world is not held off for ever', async () => {
    const { l } = await answered('The answer.')
    expect(speech.speak).toHaveBeenCalledTimes(1)
    speech.cancel.mockClear()
    // Two words: 2 x 800 ms, plus 5 s for the engine to start.
    await act(async () => { await vi.advanceTimersByTimeAsync(6599) })
    expect(lastBusy(l.link)).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(lastBusy(l.link)).toBe(false)
    expect(speech.cancel).toHaveBeenCalled()
    // The end that comes after all changes nothing.
    act(() => { said()[0].onend() })
    expect(speech.speak).toHaveBeenCalledTimes(1)
    expect(lastBusy(l.link)).toBe(false)
  })

  /** Still speaking one ms before `ms`, given up on at `ms`. */
  async function givenUpAt(l: ReturnType<typeof makeLink>, ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms - 1) })
    expect(lastBusy(l.link)).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(lastBusy(l.link)).toBe(false)
  }

  it('a 220-character CJK piece, with no spaces, gets 500 ms a character, not the one word its spaces count', async () => {
    const cjk = '项目'.repeat(110)
    const { l } = await answered(cjk)
    expect(said().map((u) => u.text)).toEqual([cjk])
    // By words it would be given up on at 5.8 s, long before an engine could read it.
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(lastBusy(l.link)).toBe(true)
    // 220 x 500 ms, plus 5 s.
    await givenUpAt(l, 115_000 - 6000)
  })

  it('a piece made mostly of file paths gets 400 ms for each slash and dot, which are read out as words', async () => {
    const paths = 'See src/renderer/src/components/World/WorldAsk.tsx, src/renderer/src/components/World/useWorldAsk.ts and src/renderer/src/world/engine/createWorldViewer.ts.'
    const { l } = await answered(paths)
    expect(said().map((u) => u.text)).toEqual([paths])
    // Five words would give 9 s. By characters: 20 symbols x 400 ms and 136 others x 120 ms, plus 5 s.
    await givenUpAt(l, 29_320)
  })

  it('ordinary English keeps its word budget, the larger of the two', async () => {
    const { l } = await answered(words('alpha', 30) + '.')
    // 30 x 800 ms (the 180 characters come to 21.9 s), plus 5 s.
    await givenUpAt(l, 29_000)
  })

  it('a piece that ends before the watchdog clears it; the watchdog of a hushed answer changes nothing later', async () => {
    const { l } = await answered('One. ' + words('two', 40) + '. ' + words('three', 40) + '.')
    act(() => { said()[0].onend() })
    await act(async () => { await vi.advanceTimersByTimeAsync(6599) })
    expect(lastBusy(l.link)).toBe(true)
    act(() => { l.esc() })
    expect(lastBusy(l.link)).toBe(false)
    speech.cancel.mockClear()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(speech.cancel).not.toHaveBeenCalled()
  })

  it('an engine that throws on a new utterance or on speak reads nothing and is not left speaking', async () => {
    ;(window as any).SpeechSynthesisUtterance = class { constructor() { throw new Error('no voices') } }
    const first = await answered('The answer.')
    expect(speech.speak).not.toHaveBeenCalled()
    expect(lastBusy(first.l.link)).toBe(false)
    first.view.unmount()
    ;(window as any).SpeechSynthesisUtterance = class { text: string; constructor(t: string) { this.text = t } }
    speech.speak.mockImplementationOnce(() => { throw new Error('busy') })
    const second = await answered('The answer.')
    expect(speech.speak).toHaveBeenCalledTimes(1)
    expect(lastBusy(second.l.link)).toBe(false)
  })

  it('an answer with nothing to say aloud says nothing and is not left speaking', async () => {
    const { l } = await answered('[E1]')
    expect(speech.speak).not.toHaveBeenCalled()
    expect(lastBusy(l.link)).toBe(false)
  })
})

describe('WorldAsk: speech stops with a different project and when the app is hidden (T7)', () => {
  const on = () => settingsGet.mockResolvedValue({ success: true, data: { worldLabelling: true, worldSpeakAnswers: true } })
  type U = { text: string; onend: () => void; onerror: () => void }
  const said = (): U[] => speech.speak.mock.calls.map((c) => c[0] as U)
  const long = Array.from({ length: 30 }, () => 'alpha').join(' ') + '. ' + Array.from({ length: 30 }, () => 'bravo').join(' ') + '.'
  let hidden = false
  beforeEach(() => {
    on()
    hidden = false
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
    ask.mockImplementation(async (req: AskRequest) => okRes(req.askId, long, { cited: {} }))
  })
  afterEach(() => { delete (document as any).visibilityState })

  async function speaking(root = 'C:/a') {
    const l = makeLink()
    const view = render(<WorldAsk viewer={makeViewer() as never} doc={minimal()} root={root} link={l.link} />)
    await settle()
    fireEvent.change(input(), { target: { value: 'q' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    await settle()
    expect(speech.speak).toHaveBeenCalledTimes(1)
    expect(lastBusy(l.link)).toBe(true)
    speech.cancel.mockClear()
    return { l, view }
  }

  it('a different project stops the speech, and the reading has moved on before the engine is told', async () => {
    const { l, view } = await speaking()
    // An engine that ends the utterance as it is cancelled: that end must not start the next piece.
    speech.cancel.mockImplementationOnce(() => { said()[0].onend() })
    view.rerender(<WorldAsk viewer={makeViewer() as never} doc={minimal()} root="C:/b" link={l.link} />)
    expect(speech.cancel).toHaveBeenCalled()
    expect(speech.speak).toHaveBeenCalledTimes(1)
    expect(lastBusy(l.link)).toBe(false)
  })

  it('the app going hidden stops the speech; coming back changes nothing', async () => {
    const { l } = await speaking()
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(speech.cancel).not.toHaveBeenCalled()
    expect(lastBusy(l.link)).toBe(true)
    hidden = true
    speech.cancel.mockImplementationOnce(() => { said()[0].onend() })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(speech.cancel).toHaveBeenCalled()
    expect(speech.speak).toHaveBeenCalledTimes(1)
    expect(lastBusy(l.link)).toBe(false)
  })

  it('an answer that lands while the app is hidden is shown but not read, and coming back does not read it late', async () => {
    let land!: () => void
    ask.mockImplementation((req: AskRequest) => new Promise((r) => { land = () => r(okRes(req.askId, long, { cited: {} })) }))
    const l = makeLink()
    render(<WorldAsk viewer={makeViewer() as never} doc={minimal()} root="C:/a" link={l.link} />)
    await settle()
    fireEvent.change(input(), { target: { value: 'q' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    await settle()
    // Away while it thinks: the hide comes before there is any speech to stop.
    hidden = true
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { land() })
    await settle()
    expect(screen.getByTestId('world-answer-text')).toHaveTextContent('alpha')
    expect(speech.speak).not.toHaveBeenCalled()
    hidden = false
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await settle()
    expect(speech.speak).not.toHaveBeenCalled()
    expect(lastBusy(l.link)).toBe(false)
  })

  it('once unmounted, the app going hidden reaches nothing', async () => {
    const { view } = await speaking()
    view.unmount()
    speech.cancel.mockClear()
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    expect(speech.cancel).not.toHaveBeenCalled()
  })
})

describe('WorldAsk: a capture is dropped on Esc, a typed question, a different project and a close (T8)', () => {
  beforeEach(() => { vm.cancel = vi.fn(); vm.status = 'idle' })
  afterEach(() => { vm.cancel = undefined; vm.status = 'idle' })

  it('Esc drops a capture that is listening or transcribing and says it used the key; an idle mic is not counted', async () => {
    const l = makeLink()
    const view = render(<WorldAsk viewer={makeViewer() as never} doc={minimal()} root="r" link={l.link} />)
    await settle()
    for (const status of ['listening', 'transcribing']) {
      vm.status = status
      view.rerender(<WorldAsk viewer={makeViewer() as never} doc={minimal()} root="r" link={l.link} />)
      ;(vm.cancel as ReturnType<typeof vi.fn>).mockClear()
      let used: unknown
      act(() => { used = l.esc() })
      expect(used).toBe(true)
      expect(vm.cancel).toHaveBeenCalledTimes(1)
    }
    vm.status = 'idle'
    view.rerender(<WorldAsk viewer={makeViewer() as never} doc={minimal()} root="r" link={l.link} />)
    let used: unknown
    act(() => { used = l.esc() })
    expect(used).toBe(false)
  })

  it('a typed question, closing the answer, closing an error, a different project and unmount each drop it', async () => {
    const c = (): ReturnType<typeof vi.fn> => vm.cancel as ReturnType<typeof vi.fn>
    const view = await submit(makeViewer(), 'q')
    expect(c()).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByLabelText('Close answer'))
    expect(c()).toHaveBeenCalledTimes(2)
    ask.mockImplementationOnce(async () => ({ success: false, error: 'boom' }))
    fireEvent.change(input(), { target: { value: 'again' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    await settle()
    expect(c()).toHaveBeenCalledTimes(3)
    fireEvent.click(screen.getByLabelText('Close answer'))
    expect(c()).toHaveBeenCalledTimes(4)
    view.rerender(<WorldAsk viewer={makeViewer() as never} doc={minimal()} root="r2" />)
    expect(c()).toHaveBeenCalledTimes(5)
    view.unmount()
    expect(c()).toHaveBeenCalledTimes(6)
  })

  it('without the hook’s cancel (WP-VOICE not landed) a listening mic is not counted by Esc and nothing throws', async () => {
    vm.cancel = undefined
    vm.status = 'listening'
    const l = makeLink()
    const view = render(<WorldAsk viewer={makeViewer() as never} doc={minimal()} root="r" link={l.link} />)
    await settle()
    let used: unknown
    act(() => { used = l.esc() })
    expect(used).toBe(false)
    vm.status = 'idle'
    view.rerender(<WorldAsk viewer={makeViewer() as never} doc={minimal()} root="r2" link={l.link} />)
    view.unmount()
  })
})

describe('WorldAsk cost line', () => {
  it('shows the answer and session cost after two answers, and nothing after dismiss', async () => {
    ask.mockImplementation(async (req: AskRequest) => okRes(req.askId, 'The answer.', { tokens: 1000 }))
    await submit(makeViewer(), 'one')
    expect(screen.getByTestId('world-ask-cost')).toHaveTextContent('This answer: about 1.0k tokens · this session: about 1.0k tokens')
    fireEvent.change(input(), { target: { value: 'two' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    await settle()
    expect(screen.getByTestId('world-ask-cost')).toHaveTextContent('This answer: about 1.0k tokens · this session: about 2.0k tokens')
    fireEvent.click(screen.getByRole('button', { name: 'Close answer' }))
    expect(screen.queryByTestId('world-ask-cost')).toBeNull()
  })

  it('shows no line before the first answer', async () => {
    render(<WorldAsk viewer={makeViewer() as never} doc={minimal()} root="r" />)
    await settle()
    expect(screen.queryByTestId('world-ask-cost')).toBeNull()
  })

  it('a design change shows the same line', async () => {
    const doc = { ...minimal(), projectKey: 'design:d1' }
    const refine = vi.fn(async () => ({ success: true, data: { doc, text: 'Added.', applied: 1, skipped: 0, summary: 's', tokens: 3150 } }))
    ;(window as any).termpolis = { worldDesignRefine: refine, worldDesignCancel: vi.fn(), worldSettingsGet: settingsGet }
    render(<WorldAsk viewer={null} doc={doc} root="design:d1" link={{ onEscape: vi.fn(), setBusy: vi.fn(), setDoc: vi.fn() }} />)
    await settle()
    const box = screen.getByPlaceholderText('Change the design…')
    fireEvent.change(box, { target: { value: 'add' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await settle()
    expect(screen.getByTestId('world-ask-cost')).toHaveTextContent('This answer: about 3.2k tokens · this session: about 3.2k tokens')
  })
})

describe('WorldAsk on a design', () => {
  it('asks for a change to the design, with no suggestions and no viewer needed, and hands the doc to the pane', async () => {
    const doc = { ...minimal(), projectKey: 'design:d1' }
    const refine = vi.fn(async () => ({ success: true, data: { doc, text: 'Added Payments.', applied: 1, skipped: 0, summary: 's1' } }))
    ;(window as any).termpolis = { worldDesignRefine: refine, worldDesignCancel: vi.fn(), worldSettingsGet: settingsGet }
    const setDoc = vi.fn()
    const link = { onEscape: vi.fn(), setBusy: vi.fn(), setDoc }
    render(<WorldAsk viewer={null} doc={doc} root="design:d1" link={link} />)
    await settle()
    const box = screen.getByPlaceholderText('Change the design…') as HTMLInputElement
    expect(box).not.toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Where is memory stored?' })).toBeNull()
    fireEvent.change(box, { target: { value: 'add Payments' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await settle()
    expect(refine).toHaveBeenCalledWith('design:d1', 'add Payments', '', undefined)
    expect(setDoc).toHaveBeenCalledWith(doc)
    expect(within(screen.getByTestId('world-answer')).getByText('Added Payments.')).toBeInTheDocument()
  })

  it('a project box with no viewer stays off', async () => {
    render(<WorldAsk viewer={null} root="C:/repo" />)
    await settle()
    expect(input()).toBeDisabled()
  })
})

describe('WorldAsk: the field, its keys and what a screen reader hears (U2, U7, U9, U10, U11, U12)', () => {
  afterEach(() => { vi.useRealTimers(); vm.status = 'idle'; vm.stop.mockClear() })

  it('Enter while an IME is composing, the keyCode 229 fallback and Shift+Enter send nothing and keep the text (U7)', async () => {
    render(<WorldAsk viewer={makeViewer() as never} root="r" />)
    await settle()
    fireEvent.change(input(), { target: { value: '日本' } })
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true })
    await settle()
    expect(ask).not.toHaveBeenCalled()
    expect(input().value).toBe('日本')
    fireEvent.keyDown(input(), { key: 'Enter' })
    await settle()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(input().value).toBe('')
  })

  it('a question that is not taken keeps its draft; the field holds no more than the limit (U9)', async () => {
    render(<WorldAsk viewer={makeViewer() as never} root="r" />)
    await settle()
    expect(input().maxLength).toBe(4000)
    fireEvent.change(input(), { target: { value: '\u0000\u0007' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    await settle()
    expect(ask).not.toHaveBeenCalled()
    expect(input().value).toBe('\u0000\u0007')
  })

  it('the placeholder is legible (#9ca3af, over 4.5:1 on the bar) and names the field (U12)', () => {
    const a = render(<WorldAsk viewer={makeViewer() as never} root="r" />)
    expect(input()).toHaveAttribute('aria-label', 'Ask about this project…')
    expect(input().className).toContain('placeholder:text-[#9ca3af]')
    expect(input().className).not.toContain('placeholder:text-[#6b7280]')
    a.unmount()
    render(<WorldAsk viewer={null} root="design:d1" />)
    expect(screen.getByPlaceholderText('Change the design…')).toHaveAttribute('aria-label', 'Change the design…')
  })

  it('a Cancel beside Thinking stops the question and puts the focus back in the field (U11)', async () => {
    ask.mockImplementationOnce(() => new Promise(() => undefined))
    await submit(makeViewer(), 'q')
    expect(screen.getByRole('status')).toHaveTextContent('Thinking…')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(cancel).toHaveBeenCalledWith(ask.mock.calls[0][0].askId)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    expect(document.activeElement).toBe(input())
  })

  it('closing an answer or an error, and an Esc that cancels, put the focus back in the field (U11)', async () => {
    const l = makeLink()
    const view = await submit(makeViewer(), 'q', { link: l.link })
    ;(screen.getByText('Show me again') as HTMLElement).focus()
    fireEvent.click(screen.getByLabelText('Close answer'))
    expect(document.activeElement).toBe(input())
    view.unmount()
    ask.mockResolvedValueOnce({ success: false, error: 'bridge down' })
    const second = await submit(makeViewer(), 'q')
    screen.getByText('Retry').focus()
    fireEvent.click(screen.getByLabelText('Close answer'))
    expect(document.activeElement).toBe(input())
    second.unmount()
    const m = makeLink()
    ask.mockImplementationOnce(() => new Promise(() => undefined))
    await submit(makeViewer(), 'q', { link: m.link })
    ;(document.activeElement as HTMLElement).blur()
    act(() => { m.esc() })
    expect(document.activeElement).toBe(input())
  })

  it('an Esc that cancelled nothing leaves the focus where it was (U11)', async () => {
    const l = makeLink()
    render(<WorldAsk viewer={makeViewer() as never} root="r" link={l.link} />)
    await settle()
    act(() => { l.esc() })
    expect(document.activeElement).not.toBe(input())
  })

  it('says each newly revealed sentence once, politely, and nothing again on Show me again (U10)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const sentences = [{ text: 'One **two**.', actions: [], sep: '' }, { text: 'Three [E1].', actions: [], sep: ' ' }]
    ask.mockImplementation(async (req: AskRequest) => okRes(req.askId, 'One **two**. Three [E1].', {
      answer: { text: 'One **two**. Three [E1].', sentences, actions: [], evidence: [], dropped: 0, unsupported: [], uncited: false }
    }))
    const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })
    render(<WorldAsk viewer={makeViewer() as never} doc={minimal()} root="r" />)
    await flush()
    const live = screen.getByTestId('world-ask-live')
    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(live).toHaveClass('sr-only')
    expect(live.textContent).toBe('')
    fireEvent.change(input(), { target: { value: 'q' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    await flush(); await flush()
    expect(live.textContent).toBe('One two.')
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(live.textContent).toBe('Three.')
    fireEvent.click(screen.getByText('Show me again'))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(live.textContent).toBe('Three.')
    fireEvent.click(screen.getByLabelText('Close answer'))
    await flush()
    expect(live.textContent).toBe('')
    // A new answer is said from its first sentence.
    fireEvent.change(input(), { target: { value: 'again' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    await flush(); await flush()
    expect(live.textContent).toBe('One two.')
  })

  it('a transcript from a capture begun on another project is dropped, and a root change stops a live mic (U2)', async () => {
    vm.status = 'listening'
    const view = render(<WorldAsk viewer={makeViewer() as never} root="C:/a" />)
    await settle()
    expect(vm.stop).not.toHaveBeenCalled()
    vm.status = 'transcribing'
    view.rerender(<WorldAsk viewer={makeViewer() as never} root="C:/b" />)
    expect(vm.stop).not.toHaveBeenCalled() // only a mic still listening is stopped
    await act(async () => { vm.sink?.('where is memory stored') })
    await settle()
    expect(ask).not.toHaveBeenCalled()
    expect(input().value).toBe('')
    vm.status = 'listening'
    view.rerender(<WorldAsk viewer={makeViewer() as never} root="C:/b" />)
    view.rerender(<WorldAsk viewer={makeViewer() as never} root="C:/c" />)
    expect(vm.stop).toHaveBeenCalledTimes(1)
    vm.status = 'idle'
    view.rerender(<WorldAsk viewer={makeViewer() as never} root="C:/c" />)
    vm.status = 'listening'
    view.rerender(<WorldAsk viewer={makeViewer() as never} root="C:/c" />)
    await act(async () => { vm.sink?.('where is memory stored') })
    await settle()
    expect(ask).toHaveBeenCalledTimes(1)
    expect((ask.mock.calls[0][0] as AskRequest).root).toBe('C:/c')
  })

  it('a spoken question that is not taken stays in the field (U9)', async () => {
    render(<WorldAsk viewer={makeViewer() as never} root="r" />)
    await settle()
    await act(async () => { vm.sink?.('x'.repeat(4001)) })
    await settle()
    expect(ask).not.toHaveBeenCalled()
    expect(input().value).toHaveLength(4001)
  })
})
