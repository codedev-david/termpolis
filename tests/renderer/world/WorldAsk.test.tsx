import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { minimal } from './helpers'

const vm = vi.hoisted(() => ({
  status: 'idle' as string,
  errorMsg: null as string | null,
  toggle: vi.fn(),
  sink: null as ((t: string) => void) | null,
  args: null as unknown[] | null,
}))
vi.mock('../../../src/renderer/src/hooks/useVoiceInput', () => ({
  useVoiceInput: (...args: unknown[]) => {
    vm.args = args
    vm.sink = (args[2] as { onTranscript: (t: string) => void }).onTranscript
    return { status: vm.status, errorMsg: vm.errorMsg, toggle: vm.toggle }
  }
}))
import { WorldAsk } from '../../../src/renderer/src/components/World/WorldAsk'
import type { AskRequest, AskResult } from '../../../src/shared/world/types'

type Res = { success: true; data: AskResult } | { success: false; error: string }
const okRes = (askId: string, text: string, over: Record<string, unknown> = {}): Res => ({
  success: true,
  data: {
    askId, ok: true, answer: { text, actions: [{ type: 'reset' }], evidence: [], dropped: 0 },
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
    expect(screen.getByText('The answer.')).toBeInTheDocument()
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
    expect(screen.getByText('The answer.')).toBeInTheDocument()
  })

  it('a viewer whose play or apply rejects causes no unhandled rejection', async () => {
    const seen: unknown[] = []
    const onRej = (e: unknown) => { seen.push(e) }
    process.on('unhandledRejection', onRej)
    const v = makeViewer()
    v.play.mockRejectedValue(new Error('play boom'))
    v.apply.mockRejectedValue(new Error('apply boom'))
    ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, 'See [E1].', { cited: { E1: { kind: 'symbol', ref: 'b1' } } }))
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
    expect(screen.getByText(evil)).toBeInTheDocument()
  })

  describe('evidence chips', () => {
    const withCited = (text: string, cited: Record<string, unknown>) =>
      ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, text, { cited }))

    it('a chip for a part id opens its card in the viewer', async () => {
      const v = makeViewer()
      withCited('See [E1] now.', { E1: { kind: 'symbol', ref: 'b1' } })
      await submit(v, 'q')
      fireEvent.click(screen.getByRole('button', { name: 'Evidence E1' }))
      expect(v.apply).toHaveBeenCalledWith({ type: 'openCard', id: 'b1' })
    })

    it('a chip opens a card for an edge id too, whatever its kind', async () => {
      const v = makeViewer()
      withCited('See [E1].', { E1: { kind: 'file', ref: 'e1' } })
      await submit(v, 'q')
      fireEvent.click(screen.getByRole('button', { name: 'Evidence E1' }))
      expect(v.apply).toHaveBeenCalledWith({ type: 'openCard', id: 'e1' })
    })

    it('an id that is not in the loaded world (or no doc) shows the inline line instead', async () => {
      const v = makeViewer()
      withCited('See [E1].', { E1: { kind: 'symbol', ref: 'nope' } })
      await submit(v, 'q')
      fireEvent.click(screen.getByRole('button', { name: 'Evidence E1' }))
      expect(screen.getByText('symbol nope')).toBeInTheDocument()
      expect(v.apply).not.toHaveBeenCalled()
      cleanup()
      withCited('See [E1].', { E1: { kind: 'symbol', ref: 'b1' } })
      await submit(v, 'q', { doc: null })
      fireEvent.click(screen.getByRole('button', { name: 'Evidence E1' }))
      expect(screen.getByText('symbol b1')).toBeInTheDocument()
      cleanup()
      withCited('See [E1].', { E1: { kind: 'symbol', ref: 'b1' } })
      render(<WorldAsk viewer={v as never} root="r" />)
      await settle()
      fireEvent.change(input(), { target: { value: 'q' } })
      fireEvent.keyDown(input(), { key: 'Enter' })
      await settle()
      fireEvent.click(screen.getByRole('button', { name: 'Evidence E1' }))
      expect(v.apply).not.toHaveBeenCalled()
    })

    it('a file chip toggles an inline line showing kind and ref', async () => {
      const v = makeViewer()
      withCited('See [E2].', { E2: { kind: 'file', ref: 'src/main/x.ts' } })
      await submit(v, 'q')
      const chip = screen.getByRole('button', { name: 'Evidence E2' })
      fireEvent.click(chip)
      expect(screen.getByText('file src/main/x.ts')).toBeInTheDocument()
      expect(v.apply).not.toHaveBeenCalled()
      fireEvent.click(chip)
      expect(screen.queryByText('file src/main/x.ts')).toBeNull()
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
    expect(refine).toHaveBeenCalledWith('design:d1', 'add Payments', '')
    expect(setDoc).toHaveBeenCalledWith(doc)
    expect(screen.getByText('Added Payments.')).toBeInTheDocument()
  })

  it('a project box with no viewer stays off', async () => {
    render(<WorldAsk viewer={null} root="C:/repo" />)
    await settle()
    expect(input()).toBeDisabled()
  })
})
