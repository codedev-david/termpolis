import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { CARD_CLICK_GRACE_MS, CARD_FADE_PX, WorldCard } from '../../../src/renderer/src/components/World/WorldCard'
import { EvidenceView } from '../../../src/renderer/src/components/World/EvidenceView'
import { WorldEmptyState } from '../../../src/renderer/src/components/World/WorldEmptyState'
import { UI_FAILED } from '../../../src/renderer/src/components/World/worldTargets'
import { TOOLBAR_FOLD_PX, TOOLBAR_MAX_ROWS, toolbarRows, WorldToolbar, type WorldToolbarProps } from '../../../src/renderer/src/components/World/WorldToolbar'
import { SOLID_PANEL, UiScaleContext } from '../../../src/renderer/src/components/World/worldPane'
import { DEFAULT_LAYERS } from '../../../src/renderer/src/world/engine'

const noop = { onTech: vi.fn(), onConfirm: vi.fn(), onEvidence: vi.fn() }

/** Resolves after the next animation frame (jsdom runs them on a timer). */
const nextFrame = (): Promise<void> => new Promise((done) => { requestAnimationFrame(() => done()) })

describe('WorldCard', () => {
  it('is glass over a map a GPU draws, and solid with no backdrop blur over one drawn in software', () => {
    const { rerender } = render(<WorldCard html="<h3>Store</h3>" onClose={() => {}} onOpen={() => {}} {...noop} />)
    const card = screen.getByTestId('world-card')
    const css = (card.querySelector('style') as HTMLStyleElement).textContent as string
    expect(css).toMatch(/\.world-card\{[^}]*backdrop-filter:blur\(10px\)/)
    expect(css).toContain(`.world-card[data-solid]{background:${SOLID_PANEL};backdrop-filter:none}`)
    expect(card).not.toHaveAttribute('data-solid')
    rerender(<WorldCard html="<h3>Store</h3>" onClose={() => {}} onOpen={() => {}} solid {...noop} />)
    expect(card).toHaveAttribute('data-solid', '')
  })

  it('is a polite live region, so a screen reader reads a card that opens or changes (R11)', () => {
    render(<WorldCard html="<h3>Store</h3>" onClose={() => {}} onOpen={() => {}} onTech={() => {}} onConfirm={() => {}} onEvidence={() => {}} />)
    const body = screen.getByRole('region', { name: 'Details' })
    expect(body).toHaveAttribute('aria-live', 'polite')
    expect(body).toHaveTextContent('Store')
  })

  it('moves the close button left by the scrollbar a capped body shows, and watches the body for it', () => {
    const observed: Element[] = []
    let fire = (): void => undefined
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { fire = cb }
      observe(el: Element): void { observed.push(el) }
      disconnect(): void { disconnect() }
    })
    const widths = { offset: 320, client: 320 }
    const spyO = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => widths.offset)
    const spyC = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => widths.client)
    try {
      const { unmount } = render(<WorldCard html="<h3>Store</h3>" onClose={() => {}} onOpen={() => {}} onTech={() => {}} onConfirm={() => {}} onEvidence={() => {}} />)
      const card = screen.getByTestId('world-card')
      expect(card.style.getPropertyValue('--world-card-gutter')).toBe('')
      const body = screen.getByTestId('world-card-body')
      expect(observed).toEqual([body, body.querySelector('h3')])
      widths.client = 306
      act(() => fire())
      expect(card.style.getPropertyValue('--world-card-gutter')).toBe('14px')
      unmount()
      expect(disconnect).toHaveBeenCalled()
    } finally {
      spyO.mockRestore()
      spyC.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('fades its bottom edge while more lies below, at every scroll position and size, and not at the end (round 4: m6)', () => {
    let fire = (): void => undefined
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { fire = cb }
      observe(): void {}
      disconnect(): void {}
    })
    const box = { scroll: 400, client: 200 }
    const spyS = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => box.scroll)
    const spyC = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => box.client)
    try {
      const { rerender } = render(<WorldCard html="<h3>Store</h3>" onClose={() => {}} onOpen={() => {}} {...noop} />)
      const body = screen.getByTestId('world-card-body')
      expect(body).toHaveAttribute('data-more')
      // Scrolled to within a pixel of the end: nothing more below, no fade.
      body.scrollTop = 199.5
      fireEvent.scroll(body)
      expect(body).not.toHaveAttribute('data-more')
      body.scrollTop = 100
      fireEvent.scroll(body)
      expect(body).toHaveAttribute('data-more')
      // The card grows to hold it all (a new cap): the fade goes.
      body.scrollTop = 0
      box.client = 400
      act(() => fire())
      expect(body).not.toHaveAttribute('data-more')
      // A longer card shown in it is measured again.
      box.scroll = 900
      rerender(<WorldCard html="<h3>Longer</h3>" onClose={() => {}} onOpen={() => {}} {...noop} />)
      expect(body).toHaveAttribute('data-more')
      // The fade is CARD_FADE_PX deep, on the text only: the scrollbar's gutter keeps a solid mask.
      const css = screen.getByTestId('world-card').querySelector('style')?.textContent ?? ''
      expect(CARD_FADE_PX).toBe(24)
      expect(css).toContain('.world-card-body[data-more]{-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 24px),transparent),linear-gradient(#000,#000);')
      expect(css).toContain('mask-size:calc(100% - var(--world-card-gutter,0px)) 100%,var(--world-card-gutter,0px) 100%;')
      expect(css).toContain('mask-position:left top,right top;')
    } finally {
      spyS.mockRestore()
      spyC.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('fades when the content grows, or stops when it shrinks, while the capped body keeps its size (round 4 re-review: m1)', () => {
    // Each observer reports only the elements it watches, as a real ResizeObserver does.
    const watching: { cb: () => void; els: Element[] }[] = []
    vi.stubGlobal('ResizeObserver', class {
      private w: { cb: () => void; els: Element[] }
      constructor(cb: () => void) { this.w = { cb, els: [] }; watching.push(this.w) }
      observe(el: Element): void { this.w.els.push(el) }
      disconnect(): void { this.w.els = [] }
    })
    const resized = (el: Element): void => { for (const w of watching) if (w.els.includes(el)) w.cb() }
    const box = { scroll: 200, client: 200 }
    const spyS = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => box.scroll)
    const spyC = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => box.client)
    try {
      const { rerender } = render(<WorldCard html="<h3>Store</h3><p>Holds the data</p>" onClose={() => {}} onOpen={() => {}} {...noop} />)
      const body = screen.getByTestId('world-card-body')
      expect(body).not.toHaveAttribute('data-more')
      // A late font makes the paragraph taller; the body is at its cap, so only the content changes size.
      box.scroll = 260
      act(() => resized(body.querySelector('p') as Element))
      expect(body).toHaveAttribute('data-more')
      box.scroll = 200
      act(() => resized(body.querySelector('h3') as Element))
      expect(body).not.toHaveAttribute('data-more')
      // A new card's content is watched in place of the old one's.
      rerender(<WorldCard html="<h3>Longer</h3>" onClose={() => {}} onOpen={() => {}} {...noop} />)
      box.scroll = 300
      act(() => resized(body.querySelector('h3') as Element))
      expect(body).toHaveAttribute('data-more')
    } finally {
      spyS.mockRestore()
      spyC.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('measures the scrollbar once where there is no ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const spyO = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => 320)
    const spyC = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => 312)
    try {
      render(<WorldCard html="<h3>Store</h3>" onClose={() => {}} onOpen={() => {}} onTech={() => {}} onConfirm={() => {}} onEvidence={() => {}} />)
      expect(screen.getByTestId('world-card').style.getPropertyValue('--world-card-gutter')).toBe('8px')
    } finally {
      spyO.mockRestore()
      spyC.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('reports the height its first heading and first two items need, in its own pixels, with the fade and its padding under them (the answer card at 1366x768)', () => {
    let fire = (): void => undefined
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { fire = cb }
      observe(): void {}
      disconnect(): void {}
    })
    // The pane drawn at 1.5: the card is 300 px on screen and 200 of its own.
    const rects: Record<string, { top: number; bottom: number }> = { card: { top: 100, bottom: 400 }, body: { top: 113, bottom: 388 }, a: { top: 0, bottom: 0 }, b: { top: 0, bottom: 0 }, l1: { top: 230, bottom: 262 }, l2: { top: 262, bottom: 280 }, x: { top: 0, bottom: 0 } }
    const spyR = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const el = this as HTMLElement
      const key = el.dataset.testid === 'world-card' ? 'card' : el.dataset.testid === 'world-card-body' ? 'body' : el.dataset.r ?? 'x'
      const r = rects[key]
      return { top: r.top, bottom: r.bottom, height: r.bottom - r.top, left: 0, right: 0, width: 0, x: 0, y: r.top, toJSON: () => ({}) } as DOMRect
    })
    const spyH = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'world-card' ? 200 : 0
    })
    const onNeed = vi.fn()
    try {
      const html = (list: string): string => `<h3>Store</h3><p data-r="a">Config</p><h4>What it does</h4><p data-r="b">Not described yet.</p><h4>What's inside</h4>${list}<p>More</p>`
      const { rerender } = render(<WorldCard html={html('<ul><li data-r="l1">a.spec – c.spec</li><li data-r="l2">d.spec</li></ul>')} onClose={() => {}} onOpen={() => {}} onNeed={onNeed} {...noop} />)
      // The first heading's two items are its sentence and the first floor (the second heading is passed over):
      // (262 - 100) / 1.5 = 108 to the floor's end, the 24 px fade, then (400 - 388) / 1.5 = 8 of padding and border.
      expect(onNeed).toHaveBeenLastCalledWith(140)
      // Scrolled, the items are measured from the body's top all the same.
      const body = screen.getByTestId('world-card-body')
      body.scrollTop = 30
      rects.l1 = { top: 185, bottom: 217 }
      act(() => fire())
      expect(onNeed).toHaveBeenLastCalledWith(140)
      body.scrollTop = 0
      rects.l1 = { top: 230, bottom: 262 }
      // An ordered list counts as a list; a heading with nothing under it, or no heading at all, needs nothing.
      rerender(<WorldCard html={html('<ol><li data-r="l1">a.spec – c.spec</li></ol>')} onClose={() => {}} onOpen={() => {}} onNeed={onNeed} {...noop} />)
      expect(onNeed).toHaveBeenLastCalledWith(140)
      rerender(<WorldCard html="<h3>Store</h3><h4>What it does</h4>" onClose={() => {}} onOpen={() => {}} onNeed={onNeed} {...noop} />)
      expect(onNeed).toHaveBeenLastCalledWith(0)
      rerender(<WorldCard html="<h3>Store</h3><p data-r='a'>Config</p>" onClose={() => {}} onOpen={() => {}} onNeed={onNeed} {...noop} />)
      expect(onNeed).toHaveBeenLastCalledWith(0)
      // A card not laid out yet (no height on screen) needs nothing either.
      rects.card = { top: 0, bottom: 0 }
      rerender(<WorldCard html={html('<ul><li data-r="l1">x</li></ul>')} onClose={() => {}} onOpen={() => {}} onNeed={onNeed} {...noop} />)
      expect(onNeed).toHaveBeenLastCalledWith(0)
    } finally {
      spyR.mockRestore()
      spyH.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('a chip calls onTech, Confirm calls onConfirm with the part and the claim text, evidence calls onEvidence', () => {
    const onTech = vi.fn()
    const onConfirm = vi.fn()
    const onEvidence = vi.fn()
    const html =
      '<h3>T</h3><span class="chip" data-tech="electron">electron</span>' +
      '<ul><li class="claim"><span class="ctext">Keeps data safe</span> <button data-confirm="b1|0">Confirm</button>' +
      '<button data-evidence="{&quot;kind&quot;:&quot;file&quot;,&quot;ref&quot;:&quot;a.ts:3&quot;}">evidence</button></li></ul>' +
      '<button data-confirm="b2|1">Loose</button>'
    render(<WorldCard html={html} onOpen={vi.fn()} onClose={vi.fn()} onTech={onTech} onConfirm={onConfirm} onEvidence={onEvidence} />)
    fireEvent.click(screen.getByText('electron'))
    expect(onTech).toHaveBeenCalledWith('electron')
    fireEvent.click(screen.getAllByText('Confirm')[0])
    expect(onConfirm).toHaveBeenLastCalledWith('b1', 'Keeps data safe')
    fireEvent.click(screen.getByText('Loose'))
    expect(onConfirm).toHaveBeenLastCalledWith('b2', '')
    fireEvent.click(screen.getByText('evidence'))
    expect(onEvidence).toHaveBeenCalledWith({ kind: 'file', ref: 'a.ts:3' })
  })

  it("an evidence button keeps a test's source, and drops anything else it carries", () => {
    const onEvidence = vi.fn()
    const html =
      '<button data-evidence="{&quot;kind&quot;:&quot;test&quot;,&quot;ref&quot;:&quot;t.test.ts&quot;,&quot;excerpt&quot;:&quot;from CI (gh)&quot;,&quot;x&quot;:1}">one</button>' +
      '<button data-evidence="{&quot;kind&quot;:&quot;test&quot;,&quot;ref&quot;:&quot;u.test.ts&quot;,&quot;excerpt&quot;:5}">two</button>'
    render(<WorldCard html={html} onOpen={vi.fn()} onClose={vi.fn()} onTech={vi.fn()} onConfirm={vi.fn()} onEvidence={onEvidence} />)
    fireEvent.click(screen.getByText('one'))
    expect(onEvidence).toHaveBeenLastCalledWith({ kind: 'test', ref: 't.test.ts', excerpt: 'from CI (gh)' })
    fireEvent.click(screen.getByText('two'))
    expect(onEvidence).toHaveBeenLastCalledWith({ kind: 'test', ref: 'u.test.ts' })
  })

  it('the card Edit button saves service names; bad names say why and save nothing', () => {
    const onRuntimeNames = vi.fn()
    const html = '<h3>T</h3><button data-runtime-edit="b1" data-names="a, b">Edit</button><button data-runtime-edit="b2">Edit</button>'
    render(<WorldCard html={html} onOpen={vi.fn()} onClose={vi.fn()} {...noop} onRuntimeNames={onRuntimeNames} />)
    fireEvent.click(screen.getAllByText('Edit')[0])
    const input = screen.getByLabelText(/Service names/) as HTMLInputElement
    expect(input.value).toBe('a, b')
    fireEvent.change(input, { target: { value: 'has space' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Use only letters')
    expect(onRuntimeNames).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'orders-api, db.1,' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onRuntimeNames).toHaveBeenCalledWith('b1', ['orders-api', 'db.1'])
    expect(screen.queryByTestId('world-card-names')).toBeNull()
    // Cancel closes it; a part with no names starts empty.
    fireEvent.click(screen.getAllByText('Edit')[1])
    expect((screen.getByLabelText(/Service names/) as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('world-card-names')).toBeNull()
  })

  it('saving the names exactly as shown stores nothing; the help text says an empty save clears them', () => {
    const onRuntimeNames = vi.fn()
    const html = '<button data-runtime-edit="b1" data-names="a, b">Edit</button>'
    render(<WorldCard html={html} onOpen={vi.fn()} onClose={vi.fn()} {...noop} onRuntimeNames={onRuntimeNames} />)
    fireEvent.click(screen.getByText('Edit'))
    expect(screen.getByTestId('world-card-names')).toHaveTextContent(/Leave it empty and save to clear/)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onRuntimeNames).not.toHaveBeenCalled()
    expect(screen.queryByTestId('world-card-names')).toBeNull()
    fireEvent.click(screen.getByText('Edit'))
    fireEvent.change(screen.getByLabelText(/Service names/), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onRuntimeNames).toHaveBeenCalledWith('b1', [])
  })

  it('without a save handler the Edit button does nothing', () => {
    render(<WorldCard html={'<button data-runtime-edit="b1">Edit</button>'} onOpen={vi.fn()} onClose={vi.fn()} {...noop} />)
    fireEvent.click(screen.getByText('Edit'))
    expect(screen.queryByTestId('world-card-names')).toBeNull()
  })

  it('ignores evidence that does not parse or is not {kind, ref}', () => {
    const onEvidence = vi.fn()
    const html =
      '<button data-evidence="not json">a</button><button data-evidence="null">b</button>' +
      '<button data-evidence="{&quot;kind&quot;:&quot;nope&quot;,&quot;ref&quot;:&quot;x&quot;}">c</button>' +
      '<button data-evidence="{&quot;kind&quot;:&quot;file&quot;,&quot;ref&quot;:3}">d</button>'
    render(<WorldCard html={html} onOpen={vi.fn()} onClose={vi.fn()} onTech={vi.fn()} onConfirm={vi.fn()} onEvidence={onEvidence} />)
    for (const t of ['a', 'b', 'c', 'd']) fireEvent.click(screen.getByText(t))
    expect(onEvidence).not.toHaveBeenCalled()
  })

  it('opens the part a data-node or data-edge link names, and ignores other clicks', () => {
    const onOpen = vi.fn()
    const onClose = vi.fn()
    render(<WorldCard html={'<h3>T</h3><a data-node="b1">B</a><a data-edge="e1">E</a>'} onOpen={onOpen} onClose={onClose} {...noop} />)
    fireEvent.click(screen.getByText('T'))
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('B'))
    expect(onOpen).toHaveBeenLastCalledWith('b1')
    fireEvent.click(screen.getByText('E'))
    expect(onOpen).toHaveBeenLastCalledWith('e1')
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('scrolls its body under a fixed title and ×, reachable by keyboard, within the cap it is given', () => {
    const html = `<h3>m12</h3>${'<h4>What it does</h4><p>Line</p>'.repeat(20)}`
    const { rerender } = render(<WorldCard html={html} onOpen={vi.fn()} onClose={vi.fn()} {...noop} />)
    const card = screen.getByTestId('world-card')
    const body = screen.getByTestId('world-card-body')
    // Uncapped (a wide pane): the stage less 110 px, as before.
    expect(card.style.maxHeight).toBe('calc(100% - 110px)')
    // Never wider than the pane less its insets: a tablet's narrow pane gets a narrower card, not a cut-off one.
    expect(card.style.maxWidth).toBe('calc(100% - 24px)')
    rerender(<WorldCard html={html} onOpen={vi.fn()} onClose={vi.fn()} {...noop} maxHeight={132} />)
    expect(card.style.maxHeight).toBe('min(132px, calc(100% - 110px))')
    // The body is the scroller: a region with a name, in the tab order, so arrows and Page Down scroll it.
    expect(body).toHaveAttribute('role', 'region')
    expect(body).toHaveAccessibleName('Details')
    expect(body.tabIndex).toBe(0)
    body.focus()
    expect(document.activeElement).toBe(body)
    // The × sits outside the scroller, and the title row sticks at its top; a visible scrollbar.
    const button = screen.getByRole('button', { name: 'Close details' })
    expect(body.contains(button)).toBe(false)
    const css = card.querySelector('style')?.textContent ?? ''
    expect(css).toMatch(/\.world-card\{display:flex;flex-direction:column;overflow:hidden;/)
    expect(css).toMatch(/\.world-card-body\{flex:1 1 auto;min-height:0;overflow-y:auto;[^}]*scrollbar-color:/)
    expect(css).toMatch(/\.world-card-body > h3:first-child\{position:sticky;top:0;/)
    expect(css).toMatch(/\.world-card-close\{position:absolute;/)
  })

  it('lets clicks through for a double-click time after it opens, so a double-click whose first click opened it reaches the map (film bug 6)', () => {
    vi.useFakeTimers()
    try {
      // A card opened from the tree, an answer or a bookmark takes clicks at once (fix wave M1).
      const plain = render(<WorldCard html="<h3>P</h3>" onOpen={vi.fn()} onClose={vi.fn()} {...noop} />)
      expect(screen.getByTestId('world-card').style.pointerEvents).toBe('')
      plain.unmount()
      expect(vi.getTimerCount()).toBe(0)
      const { rerender, unmount } = render(<WorldCard html="<h3>A</h3>" clickThrough onOpen={vi.fn()} onClose={vi.fn()} {...noop} />)
      const card = screen.getByTestId('world-card')
      expect(CARD_CLICK_GRACE_MS).toBe(500)
      expect(card.style.pointerEvents).toBe('none')
      act(() => { vi.advanceTimersByTime(CARD_CLICK_GRACE_MS - 1) })
      expect(card.style.pointerEvents).toBe('none')
      act(() => { vi.advanceTimersByTime(1) })
      expect(card.style.pointerEvents).toBe('')
      // Another part's card in the open card takes clicks at once: it is no new card over the map.
      rerender(<WorldCard html="<h3>B</h3>" clickThrough onOpen={vi.fn()} onClose={vi.fn()} {...noop} />)
      expect(card.style.pointerEvents).toBe('')
      unmount()
      // Closed before the time is up: nothing is left running.
      const third = render(<WorldCard html="<h3>C</h3>" clickThrough onOpen={vi.fn()} onClose={vi.fn()} {...noop} />)
      third.unmount()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('WorldEmptyState', () => {
  it('M3: the fixed words for a call that threw add nothing under "could not map this project"', () => {
    render(<WorldEmptyState mode="error" error={UI_FAILED} onRetry={vi.fn()} />)
    expect(screen.getByTestId('world-empty')).toHaveTextContent(/^Lumopolis could not map this project\.Try again$/)
    expect(screen.queryByTestId('world-error')).toBeNull()
  })

  it('an error without a retry handler shows no retry button', () => {
    render(<WorldEmptyState mode="error" error="nope" />)
    expect(screen.getByTestId('world-error')).toHaveTextContent('nope')
    expect(screen.queryByTestId('world-retry')).toBeNull()
  })

  it('mapping without a progress prop starts at zero', () => {
    render(<WorldEmptyState mode="mapping" />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
    expect(screen.getByText('Mapping your project…')).toBeInTheDocument()
  })
})

describe('EvidenceView', () => {
  it('shows the kind and where it points as text, with a close button only when given one', () => {
    const onClose = vi.fn()
    const { rerender } = render(<EvidenceView evidence={{ kind: 'file', ref: '<img src=x onerror=alert(1)>' }} />)
    expect(screen.getByTestId('evidence-view').textContent).toBe('file <img src=x onerror=alert(1)>')
    expect(screen.getByTestId('evidence-view').querySelector('img')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<EvidenceView evidence={{ kind: 'person', ref: 'confirmed in Lumopolis' }} onClose={onClose} className="x" />)
    expect(screen.getByTestId('evidence-view').className).toBe('x')
    fireEvent.click(screen.getByRole('button', { name: 'Close evidence' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('a test says where its result came from; other kinds and an empty excerpt show kind and ref only', () => {
    const { rerender } = render(<EvidenceView evidence={{ kind: 'test', ref: 't/a.test.ts', excerpt: 'from CI (gh)' }} />)
    expect(screen.getByTestId('evidence-view').textContent).toBe('test t/a.test.ts (from CI (gh))')
    rerender(<EvidenceView evidence={{ kind: 'test', ref: 't/a.test.ts', excerpt: '' }} />)
    expect(screen.getByTestId('evidence-view').textContent).toBe('test t/a.test.ts')
    rerender(<EvidenceView evidence={{ kind: 'commit', ref: 'abc', excerpt: 'subject' }} />)
    expect(screen.getByTestId('evidence-view').textContent).toBe('commit abc')
  })
})

describe('WorldToolbar Export', () => {
  const props = (over: Partial<WorldToolbarProps> = {}): WorldToolbarProps => ({
    projectName: 'termpolis', layers: DEFAULT_LAYERS, onLayers: vi.fn(), proposals: [], onProposal: vi.fn(), theme: 'neon', onTheme: vi.fn(),
    tours: [], onTour: vi.fn(), onResetView: vi.fn(), onRelayout: vi.fn(), relayoutDisabled: false, onClose: vi.fn(),
    bookmarks: [], onSaveBookmark: vi.fn(), onBookmark: vi.fn(), onRemoveBookmark: vi.fn(), map2d: false, onMap2d: vi.fn(), ...over,
  })

  it('shows no Export button without onExport', () => {
    render(<WorldToolbar {...props()} />)
    expect(screen.queryByTestId('world-export')).toBeNull()
  })

  it('F-R13: inert while the home has a dialog up, live again after', () => {
    const r = render(<WorldToolbar {...props({ inert: true })} />)
    expect(screen.getByRole('toolbar').inert).toBe(true)
    r.rerender(<WorldToolbar {...props()} />)
    expect(screen.getByRole('toolbar').inert).toBe(false)
  })

  it('Export opens its menu; each item calls onExport with its kind and closes the menu', () => {
    const onExport = vi.fn()
    render(<WorldToolbar {...props({ onExport, onBuildIt: vi.fn() })} />)
    const button = screen.getByTestId('world-export')
    expect(button).toHaveTextContent('Export')
    expect(button.querySelector('i.fa-solid.fa-file-export')).not.toBeNull()
    // Before Build it, in the right-hand group.
    expect(button.closest('.relative')?.nextElementSibling).toBe(screen.getByTestId('world-build-it-open'))
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('world-export-menu')).toBeNull()
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByTestId('world-export-menu')
    expect(menu).toHaveStyle({ background: '#252526' })
    fireEvent.click(screen.getByTestId('world-export-world'))
    expect(onExport).toHaveBeenLastCalledWith('world')
    expect(screen.queryByTestId('world-export-menu')).toBeNull()
    fireEvent.click(button)
    expect(screen.getByTestId('world-export-world')).toHaveTextContent('Interactive world (HTML)…')
    expect(screen.getByTestId('world-export-document')).toHaveTextContent('Documentation (HTML)…')
    fireEvent.click(screen.getByTestId('world-export-document'))
    expect(onExport).toHaveBeenLastCalledWith('document')
    expect(screen.queryByTestId('world-export-menu')).toBeNull()
    // The button toggles the menu shut too.
    fireEvent.click(button)
    fireEvent.click(button)
    expect(screen.queryByTestId('world-export-menu')).toBeNull()
  })

  it('the Export menu opens toward the side with room, so a narrow pane never cuts it off', () => {
    render(<WorldToolbar {...props({ onExport: vi.fn(), onBuildIt: vi.fn() })} />)
    const button = screen.getByTestId('world-export')
    const wrap = button.parentElement as HTMLElement
    const bar = screen.getByRole('toolbar')
    const rect = (left: number, right: number) => ({ left, right, top: 0, bottom: 20, width: right - left, height: 20, x: left, y: 0, toJSON: () => ({}) })
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue(rect(300, 720) as DOMRect)
    // At the far end of a row: the menu hangs left from the button's right edge.
    vi.spyOn(wrap, 'getBoundingClientRect').mockReturnValue(rect(620, 700) as DOMRect)
    fireEvent.click(button)
    expect(screen.getByTestId('world-export-menu')).toHaveClass('right-0')
    expect(screen.getByTestId('world-export-menu')).not.toHaveClass('left-0')
    fireEvent.click(button)
    // Wrapped to the start of a row: no room on the left, so it opens to the right.
    vi.spyOn(wrap, 'getBoundingClientRect').mockReturnValue(rect(312, 392) as DOMRect)
    fireEvent.click(button)
    expect(screen.getByTestId('world-export-menu')).toHaveClass('left-0')
    expect(screen.getByTestId('world-export-menu')).not.toHaveClass('right-0')
  })

  it('on a big monitor, judges the room on screen against the menu drawn at the pane scale', () => {
    render(<UiScaleContext.Provider value={1.5}><WorldToolbar {...props({ onExport: vi.fn(), onBuildIt: vi.fn() })} /></UiScaleContext.Provider>)
    const button = screen.getByTestId('world-export')
    const wrap = button.parentElement as HTMLElement
    const rect = (left: number, right: number) => ({ left, right, top: 0, bottom: 20, width: right - left, height: 20, x: left, y: 0, toJSON: () => ({}) })
    // A Chromium with standard zoom: boxes already on screen. 300 px is room for a 224 px menu, not a 336 px one.
    Object.defineProperty(wrap, 'currentCSSZoom', { value: 1.5, configurable: true })
    Object.defineProperty(wrap.parentElement as HTMLElement, 'currentCSSZoom', { value: 1.5, configurable: true })
    vi.spyOn(wrap.parentElement as HTMLElement, 'getBoundingClientRect').mockReturnValue(rect(300, 900) as DOMRect)
    vi.spyOn(wrap, 'getBoundingClientRect').mockReturnValue(rect(520, 600) as DOMRect)
    fireEvent.click(button)
    expect(screen.getByTestId('world-export-menu')).toHaveClass('left-0')
  })
})

describe('WorldToolbar in a narrow pane', () => {
  const props = (over: Partial<WorldToolbarProps> = {}): WorldToolbarProps => ({
    projectName: 'termpolis', layers: DEFAULT_LAYERS, onLayers: vi.fn(), proposals: [{ id: 'p1', title: 'Split the core' }], onProposal: vi.fn(), theme: 'neon', onTheme: vi.fn(),
    tours: [{ id: 't1', title: 'The tour', stops: [] } as unknown as WorldToolbarProps['tours'][number]], onTour: vi.fn(), onResetView: vi.fn(), onRelayout: vi.fn(), relayoutDisabled: false, onClose: vi.fn(),
    bookmarks: [], onSaveBookmark: vi.fn(), onBookmark: vi.fn(), onRemoveBookmark: vi.fn(), map2d: false, onMap2d: vi.fn(), ...over,
  })
  const FOLDED = ['world-layer-labels', 'world-layer-processes', 'world-layer-allLineLabels', 'world-layer-planned', 'world-proposal', 'world-theme', 'world-tours', 'world-map2d', 'world-reset', 'world-relayout']
  const rect = (left: number, right: number) => ({ left, right, top: 0, bottom: 20, width: right - left, height: 20, x: left, y: 0, toJSON: () => ({}) }) as DOMRect

  it('folds below 440 of its own px', () => {
    expect(TOOLBAR_FOLD_PX).toBe(440)
  })

  it('keeps every control in the row when wide, with no More', () => {
    render(<WorldToolbar {...props({ onExport: vi.fn() })} />)
    expect(screen.queryByTestId('world-more')).toBeNull()
    for (const id of FOLDED) expect(screen.getByTestId(id), id).toBeInTheDocument()
  })

  it('folds the secondary controls into More, keeping the name, switcher, Bookmarks, Export, Build it and close in the row', () => {
    const p = props({ compact: true, onExport: vi.fn(), onBuildIt: vi.fn(), switcher: <span data-testid="sw">switch</span> })
    render(<WorldToolbar {...p} />)
    for (const id of FOLDED) expect(screen.queryByTestId(id), id).toBeNull()
    for (const id of ['world-project', 'sw', 'world-bookmarks', 'world-export', 'world-build-it-open', 'world-close']) expect(screen.getByTestId(id), id).toBeInTheDocument()
    const more = screen.getByTestId('world-more')
    expect(more).toHaveTextContent('More')
    expect(more).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByTestId('world-more-menu')
    expect(menu).toHaveAttribute('role', 'group')
    expect(menu).toHaveAttribute('aria-label', 'More')
    for (const id of FOLDED) expect(menu.contains(screen.getByTestId(id)), id).toBe(true)
    // A layer toggle leaves the menu open, so several can be set in one go.
    fireEvent.click(screen.getByTestId('world-layer-processes'))
    expect(p.onLayers).toHaveBeenCalledWith({ processes: true })
    fireEvent.click(screen.getByTestId('world-map2d'))
    expect(p.onMap2d).toHaveBeenCalledWith(true)
    fireEvent.change(screen.getByTestId('world-theme'), { target: { value: 'glass' } })
    expect(p.onTheme).toHaveBeenCalledWith('glass')
    expect(screen.getByTestId('world-more-menu')).toBeInTheDocument()
    // Starting a tour, resetting the view and re-laying out leave the menu.
    fireEvent.change(screen.getByTestId('world-tours'), { target: { value: 't1' } })
    expect(p.onTour).toHaveBeenCalled()
    expect(screen.queryByTestId('world-more-menu')).toBeNull()
    fireEvent.click(more)
    fireEvent.click(screen.getByTestId('world-reset'))
    expect(p.onResetView).toHaveBeenCalled()
    expect(screen.queryByTestId('world-more-menu')).toBeNull()
    fireEvent.click(more)
    fireEvent.click(screen.getByTestId('world-relayout'))
    expect(p.onRelayout).toHaveBeenCalled()
    expect(screen.queryByTestId('world-more-menu')).toBeNull()
    // The button toggles it shut too.
    fireEvent.click(more)
    fireEvent.click(more)
    expect(screen.queryByTestId('world-more-menu')).toBeNull()
  })

  it('closes on Esc (and keeps that Esc from the pane), on a click outside, and when the pane widens past the fold', async () => {
    const p = props({ compact: true })
    const { rerender } = render(<WorldToolbar {...p} />)
    const more = screen.getByTestId('world-more')
    expect(more.parentElement).not.toHaveAttribute('data-world-own-esc')
    fireEvent.click(more)
    expect(more.parentElement).toHaveAttribute('data-world-own-esc', '')
    // Another key does nothing.
    fireEvent.keyDown(screen.getByTestId('world-theme'), { key: 'a' })
    expect(screen.getByTestId('world-more-menu')).toBeInTheDocument()
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => { screen.getByTestId('world-theme').dispatchEvent(esc) })
    expect(esc.defaultPrevented).toBe(true)
    expect(screen.queryByTestId('world-more-menu')).toBeNull()
    // Esc with the menu shut is not the menu's.
    const esc2 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => { more.dispatchEvent(esc2) })
    expect(esc2.defaultPrevented).toBe(false)
    fireEvent.click(more)
    fireEvent.mouseDown(screen.getByTestId('world-theme'))
    expect(screen.getByTestId('world-more-menu')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByTestId('world-more-menu')).toBeNull()
    fireEvent.click(more)
    rerender(<WorldToolbar {...p} compact={false} />)
    expect(screen.queryByTestId('world-more-menu')).toBeNull()
    expect(screen.getByTestId('world-theme')).toBeInTheDocument()
    // Unfolded for a frame: the menu has nothing left to show, and is shut.
    await act(async () => { await nextFrame() })
    rerender(<WorldToolbar {...p} compact />)
    expect(screen.queryByTestId('world-more-menu')).toBeNull()
  })

  it('opens the menu toward the side with room, judged on screen at the pane scale', () => {
    const view = (): JSX.Element => <UiScaleContext.Provider value={1.5}><WorldToolbar {...props({ compact: true })} /></UiScaleContext.Provider>
    const { rerender } = render(view())
    const more = screen.getByTestId('world-more')
    const wrap = more.parentElement as HTMLElement
    const bar = screen.getByRole('toolbar')
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue(rect(0, 600))
    // 400 px to the bar's right edge: room for the 360 px menu (240 at 1.5), so it hangs from the left.
    vi.spyOn(wrap, 'getBoundingClientRect').mockReturnValue(rect(200, 260))
    fireEvent.click(more)
    expect(screen.getByTestId('world-more-menu')).toHaveClass('left-0')
    fireEvent.click(more)
    // Near the right edge, with room to the left: it hangs from the right.
    vi.spyOn(wrap, 'getBoundingClientRect').mockReturnValue(rect(500, 560))
    fireEvent.click(more)
    expect(screen.getByTestId('world-more-menu')).toHaveClass('right-0')
    fireEvent.click(more)
    // No room either way: from the left, where its start stays readable.
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue(rect(0, 300))
    vi.spyOn(wrap, 'getBoundingClientRect').mockReturnValue(rect(100, 160))
    fireEvent.click(more)
    expect(screen.getByTestId('world-more-menu')).toHaveClass('left-0')
    // Left open while the toolbar moves (the pane widened, the rows re-wrapped): judged again, so it never keeps a
    // side that now hangs out of the pane.
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue(rect(0, 600))
    vi.spyOn(wrap, 'getBoundingClientRect').mockReturnValue(rect(500, 560))
    rerender(view())
    expect(screen.getByTestId('world-more-menu')).toHaveClass('right-0')
    // Re-rendered where it already fits: it stays.
    rerender(view())
    expect(screen.getByTestId('world-more-menu')).toHaveClass('right-0')
  })

  it('keeps one popup open at a time: opening Bookmarks, More or Export shuts the one that was open', () => {
    render(<WorldToolbar {...props({ compact: true, onExport: vi.fn() })} />)
    const open = (): string[] => ['world-bookmarks-menu', 'world-more-menu', 'world-export-menu'].filter((id) => screen.queryByTestId(id) !== null)
    // Keyboard presses: no mousedown outside closes the one before.
    fireEvent.click(screen.getByTestId('world-more'))
    expect(open()).toEqual(['world-more-menu'])
    fireEvent.click(screen.getByTestId('world-bookmarks'))
    expect(open()).toEqual(['world-bookmarks-menu'])
    expect(screen.getByTestId('world-more')).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByTestId('world-export'))
    expect(open()).toEqual(['world-export-menu'])
    expect(screen.getByTestId('world-bookmarks')).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByTestId('world-more'))
    expect(open()).toEqual(['world-more-menu'])
  })

  it('names what each button opens with aria-controls while it is open, and claims no popup role it lacks', () => {
    render(<WorldToolbar {...props({ compact: true, onExport: vi.fn() })} />)
    for (const [button, menu] of [['world-bookmarks', 'world-bookmarks-menu'], ['world-more', 'world-more-menu'], ['world-export', 'world-export-menu']]) {
      const b = screen.getByTestId(button)
      expect(b, button).not.toHaveAttribute('aria-haspopup')
      expect(b, button).not.toHaveAttribute('aria-controls')
      fireEvent.click(b)
      const m = screen.getByTestId(menu)
      expect(m.id, menu).not.toBe('')
      expect(b, button).toHaveAttribute('aria-controls', m.id)
      fireEvent.click(b)
      expect(b, button).not.toHaveAttribute('aria-controls')
    }
  })

  it('Esc shuts the open popup wherever the focus is in the pane; the focus goes back to its button when it was in the menu', () => {
    render(<div><button type="button" data-testid="elsewhere">map</button><WorldToolbar {...props({ compact: true, onExport: vi.fn() })} /></div>)
    const escAt = (el: Element): KeyboardEvent => {
      const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      act(() => { el.dispatchEvent(e) })
      return e
    }
    const bookmarks = screen.getByTestId('world-bookmarks')
    // From inside the menu: shut, focus on its button, and the pane never sees that Esc.
    fireEvent.click(bookmarks)
    screen.getByTestId('world-bookmark-name').focus()
    expect(escAt(screen.getByTestId('world-bookmark-name')).defaultPrevented).toBe(true)
    expect(screen.queryByTestId('world-bookmarks-menu')).toBeNull()
    expect(document.activeElement).toBe(bookmarks)
    // From elsewhere in the pane: shut, the focus stays where it is.
    fireEvent.click(bookmarks)
    const elsewhere = screen.getByTestId('elsewhere')
    elsewhere.focus()
    expect(escAt(elsewhere).defaultPrevented).toBe(true)
    expect(screen.queryByTestId('world-bookmarks-menu')).toBeNull()
    expect(document.activeElement).toBe(elsewhere)
    // Focus lost to the page (the control it was on is gone): back to the button. An Esc from outside the pane
    // (a terminal) shuts the menu too, and is still the terminal's.
    fireEvent.click(screen.getByTestId('world-more'))
    elsewhere.blur()
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    expect(escAt(outside).defaultPrevented).toBe(false)
    expect(screen.queryByTestId('world-more-menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('world-more'))
    outside.remove()
    // Another key does nothing.
    fireEvent.click(screen.getByTestId('world-export'))
    fireEvent.keyDown(screen.getByTestId('world-export'), { key: 'Tab' })
    expect(screen.getByTestId('world-export-menu')).toBeInTheDocument()
  })

  it('a choice that shuts a popup gives the focus back to its button, not to the page', () => {
    const p = props({ compact: true, onExport: vi.fn(), bookmarks: [{ name: 'Home view' } as unknown as WorldToolbarProps['bookmarks'][number]] })
    render(<WorldToolbar {...p} />)
    const more = screen.getByTestId('world-more')
    fireEvent.click(more)
    screen.getByTestId('world-reset').focus()
    fireEvent.click(screen.getByTestId('world-reset'))
    expect(p.onResetView).toHaveBeenCalled()
    expect(document.activeElement).toBe(more)
    fireEvent.click(more)
    fireEvent.change(screen.getByTestId('world-tours'), { target: { value: 't1' } })
    expect(document.activeElement).toBe(more)
    const bookmarks = screen.getByTestId('world-bookmarks')
    fireEvent.click(bookmarks)
    fireEvent.click(screen.getByTestId('world-bookmark-go'))
    expect(p.onBookmark).toHaveBeenCalled()
    expect(screen.queryByTestId('world-bookmarks-menu')).toBeNull()
    expect(document.activeElement).toBe(bookmarks)
    const exp = screen.getByTestId('world-export')
    fireEvent.click(exp)
    fireEvent.click(screen.getByTestId('world-export-world'))
    expect(p.onExport).toHaveBeenCalledWith('world')
    expect(document.activeElement).toBe(exp)
  })

  it('a click outside shuts Bookmarks too, and a row control (wide pane) leaves an open popup alone', () => {
    const p = props({ onExport: vi.fn() })
    const { rerender } = render(<WorldToolbar {...p} />)
    fireEvent.click(screen.getByTestId('world-bookmarks'))
    fireEvent.mouseDown(screen.getByTestId('world-bookmark-name'))
    expect(screen.getByTestId('world-bookmarks-menu')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByTestId('world-bookmarks-menu')).toBeNull()
    fireEvent.click(screen.getByTestId('world-bookmarks'))
    screen.getByTestId('world-bookmark-name').focus()
    fireEvent.click(screen.getByTestId('world-reset'))
    expect(p.onResetView).toHaveBeenCalled()
    expect(screen.getByTestId('world-bookmarks-menu')).toBeInTheDocument()
    // Export taken away (the world closed) with its menu open: the menu goes with it, and does not come back.
    fireEvent.click(screen.getByTestId('world-export'))
    rerender(<WorldToolbar {...p} onExport={undefined} />)
    rerender(<WorldToolbar {...p} />)
    expect(screen.queryByTestId('world-export-menu')).toBeNull()
  })

  it('puts the close button in the top right corner, out of the rows, which keep clear of it', () => {
    render(<WorldToolbar {...props()} />)
    expect(screen.getByTestId('world-close')).toHaveStyle({ position: 'absolute', top: '8px', right: '8px' })
    // 48px: the 36px button and its 8px inset, with room to spare.
    expect(screen.getByRole('toolbar')).toHaveClass('pr-12')
  })
})

describe('WorldToolbar rows', () => {
  const props = (over: Partial<WorldToolbarProps> = {}): WorldToolbarProps => ({
    projectName: 'termpolis', layers: DEFAULT_LAYERS, onLayers: vi.fn(), proposals: [], onProposal: vi.fn(), theme: 'neon', onTheme: vi.fn(),
    tours: [], onTour: vi.fn(), onResetView: vi.fn(), onRelayout: vi.fn(), relayoutDisabled: false, onClose: vi.fn(),
    bookmarks: [], onSaveBookmark: vi.fn(), onBookmark: vi.fn(), onRemoveBookmark: vi.fn(), map2d: false, onMap2d: vi.fn(), ...over,
  })
  const box = (top: number, height: number, width = 50) => ({ left: 0, right: width, top, bottom: top + height, width, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect

  it('keeps the full toolbar to two rows at most', () => {
    expect(TOOLBAR_MAX_ROWS).toBe(2)
  })

  it('counts the rows its controls lie on by their middles, leaving out what takes no room and what is marked off the rows', () => {
    const bar = document.createElement('div')
    const add = (r: DOMRect, skip = false): void => {
      const el = document.createElement('span')
      if (skip) el.setAttribute('data-world-row-skip', '')
      el.getBoundingClientRect = () => r
      bar.appendChild(el)
    }
    // A 24px select and a 20px button centred on one row; a second row 32px down; a third.
    add(box(8, 24)); add(box(10, 20)); add(box(40, 24)); add(box(42, 20)); add(box(72, 24))
    expect(toolbarRows(bar)).toBe(3)
    // The empty spacer (no height), the close button in the corner and the cost line under the rows.
    add(box(200, 0)); add(box(500, 30), true); add(box(104, 16, 0))
    expect(toolbarRows(bar)).toBe(3)
    expect(toolbarRows(document.createElement('div'))).toBe(0)
  })

  it('folds into More when the full toolbar would take more than two rows, and unfolds once the pane is wider than where it folded', () => {
    const size = { client: 400, perRow: 4 }
    const spyC = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.getAttribute('role') === 'toolbar' ? size.client : 0 })
    const spyR = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const bar = this.parentElement
      if (!bar || bar.getAttribute('role') !== 'toolbar') return box(0, 0, 0)
      const i = Array.from(bar.children).indexOf(this)
      return box(8 + Math.floor(i / size.perRow) * 32, 24)
    })
    try {
      const { rerender } = render(<WorldToolbar {...props({ onExport: vi.fn() })} />)
      // The full toolbar's controls spread over four rows: the secondary ones fold into More.
      expect(screen.getByTestId('world-more')).toBeInTheDocument()
      expect(screen.queryByTestId('world-layer-labels')).toBeNull()
      // Re-rendered at the same width: it stays folded.
      rerender(<WorldToolbar {...props({ onExport: vi.fn() })} />)
      expect(screen.getByTestId('world-more')).toBeInTheDocument()
      // Wider than where it folded, and the full toolbar fits on two rows: it unfolds.
      size.client = 700
      size.perRow = 12
      rerender(<WorldToolbar {...props({ onExport: vi.fn() })} />)
      expect(screen.queryByTestId('world-more')).toBeNull()
      expect(screen.getByTestId('world-layer-labels')).toBeInTheDocument()
      // Narrow again: it folds again.
      size.client = 420
      size.perRow = 4
      rerender(<WorldToolbar {...props({ onExport: vi.fn() })} />)
      expect(screen.getByTestId('world-more')).toBeInTheDocument()
      // Wider, but the full toolbar still needs three rows there: it folds again at the new width.
      size.client = 480
      size.perRow = 6
      rerender(<WorldToolbar {...props({ onExport: vi.fn() })} />)
      expect(screen.getByTestId('world-more')).toBeInTheDocument()
      expect(screen.queryByTestId('world-layer-labels')).toBeNull()
    } finally {
      spyC.mockRestore()
      spyR.mockRestore()
    }
  })

  it('a folded toolbar widened a little keeps an open More menu; one that unfolds and folds straight back keeps it too (M1)', async () => {
    const size = { client: 400, perRow: 4 }
    const spyC = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.getAttribute('role') === 'toolbar' ? size.client : 0 })
    const spyR = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const bar = this.parentElement
      if (!bar || bar.getAttribute('role') !== 'toolbar') return box(0, 0, 0)
      const i = Array.from(bar.children).indexOf(this)
      return box(8 + Math.floor(i / size.perRow) * 32, 24)
    })
    try {
      const { rerender } = render(<WorldToolbar {...props()} />)
      fireEvent.click(screen.getByTestId('world-more'))
      expect(screen.getByTestId('world-more-menu')).toBeInTheDocument()
      // A pixel wider, then a few: it stays folded (it looks again only well past where it folded), the menu open.
      for (const w of [401, 410, 420]) {
        size.client = w
        rerender(<WorldToolbar {...props()} />)
        await act(async () => { await nextFrame() })
        expect(screen.getByTestId('world-more-menu')).toBeInTheDocument()
      }
      // Well wider, but the full toolbar still needs three rows: it unfolds to look, folds back before paint, and
      // the menu stays open.
      size.client = 470
      rerender(<WorldToolbar {...props()} />)
      await act(async () => { await nextFrame() })
      expect(screen.getByTestId('world-more-menu')).toBeInTheDocument()
      // Wide enough for the full toolbar: it unfolds, and the menu, with nothing left to show, shuts.
      size.client = 900
      size.perRow = 20
      rerender(<WorldToolbar {...props()} />)
      await act(async () => { await nextFrame() })
      expect(screen.queryByTestId('world-more')).toBeNull()
      size.client = 400
      size.perRow = 4
      rerender(<WorldToolbar {...props()} />)
      expect(screen.queryByTestId('world-more-menu')).toBeNull()
    } finally {
      spyC.mockRestore()
      spyR.mockRestore()
    }
  })

  it('after an unfold that folds straight back, the open More menu still shuts on its button and still runs a choice in it', async () => {
    const size = { client: 400, perRow: 4 }
    const spyC = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.getAttribute('role') === 'toolbar' ? size.client : 0 })
    const spyR = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const bar = this.parentElement
      if (!bar || bar.getAttribute('role') !== 'toolbar') return box(0, 0, 0)
      const i = Array.from(bar.children).indexOf(this)
      return box(8 + Math.floor(i / size.perRow) * 32, 24)
    })
    const onResetView = vi.fn()
    try {
      const { rerender } = render(<WorldToolbar {...props({ onResetView })} />)
      const press = (el: HTMLElement): void => { fireEvent.mouseDown(el); fireEvent.click(el) }
      press(screen.getByTestId('world-more'))
      // Well wider, but the full toolbar still needs three rows: it unfolds to look and folds back before paint, the
      // More button and its menu drawn anew.
      size.client = 470
      rerender(<WorldToolbar {...props({ onResetView })} />)
      await act(async () => { await nextFrame() })
      expect(screen.getByTestId('world-more-menu')).toBeInTheDocument()
      // A choice in the menu runs (its mousedown is inside the menu, not a click outside that took it away first).
      press(screen.getByTestId('world-reset'))
      expect(onResetView).toHaveBeenCalledTimes(1)
      expect(screen.queryByTestId('world-more-menu')).toBeNull()
      // Open again, through another unfold that folds back: its own button shuts it, and it stays shut.
      press(screen.getByTestId('world-more'))
      size.client = 520
      rerender(<WorldToolbar {...props({ onResetView })} />)
      await act(async () => { await nextFrame() })
      expect(screen.getByTestId('world-more-menu')).toBeInTheDocument()
      press(screen.getByTestId('world-more'))
      expect(screen.queryByTestId('world-more-menu')).toBeNull()
      expect(screen.getByTestId('world-more')).toHaveAttribute('aria-expanded', 'false')
      // And Esc still shuts it, the focus back on the More button drawn now.
      press(screen.getByTestId('world-more'))
      size.client = 570
      rerender(<WorldToolbar {...props({ onResetView })} />)
      await act(async () => { await nextFrame() })
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(screen.queryByTestId('world-more-menu')).toBeNull()
      expect(document.activeElement).toBe(screen.getByTestId('world-more'))
      // In the frame a toolbar has unfolded (no More button yet to hold the menu), a press anywhere or an Esc shuts it.
      for (const shut of [(): void => { fireEvent.mouseDown(document.body) }, (): void => { fireEvent.keyDown(document.body, { key: 'Escape' }) }]) {
        size.client = 400
        size.perRow = 4
        rerender(<WorldToolbar {...props({ onResetView })} />)
        press(screen.getByTestId('world-more'))
        size.client = 900
        size.perRow = 20
        rerender(<WorldToolbar {...props({ onResetView })} />)
        expect(screen.queryByTestId('world-more')).toBeNull()
        act(() => { shut() })
        await act(async () => { await nextFrame() })
        size.client = 400
        size.perRow = 4
        rerender(<WorldToolbar {...props({ onResetView })} />)
        expect(screen.queryByTestId('world-more-menu')).toBeNull()
      }
    } finally {
      spyC.mockRestore()
      spyR.mockRestore()
    }
  })

  it('with the More menu shut, a toolbar folded by a narrow moment unfolds as soon as the bar is any wider and the full toolbar fits (M1)', () => {
    const size = { client: 700, perRow: 12 }
    const spyC = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.getAttribute('role') === 'toolbar' ? size.client : 0 })
    const spyR = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const bar = this.parentElement
      if (!bar || bar.getAttribute('role') !== 'toolbar') return box(0, 0, 0)
      const i = Array.from(bar.children).indexOf(this)
      return box(8 + Math.floor(i / size.perRow) * 32, 24)
    })
    try {
      const { rerender } = render(<WorldToolbar {...props()} />)
      expect(screen.queryByTestId('world-more')).toBeNull()
      // A scrollbar or a relayout narrows the bar for a moment: it folds.
      size.client = 690
      size.perRow = 4
      rerender(<WorldToolbar {...props()} />)
      expect(screen.getByTestId('world-more')).toBeInTheDocument()
      // Back to its width, under the slack: no menu is open to keep, so it looks again and unfolds.
      size.client = 700
      size.perRow = 12
      rerender(<WorldToolbar {...props()} />)
      expect(screen.queryByTestId('world-more')).toBeNull()
    } finally {
      spyC.mockRestore()
      spyR.mockRestore()
    }
  })

  it('a folded toolbar looks again when what it holds shrinks at the same width: a shorter name, a smaller zoom or scale (M1)', () => {
    const size = { client: 400, perRow: 4 }
    const spyC = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.getAttribute('role') === 'toolbar' ? size.client : 0 })
    const spyR = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const bar = this.parentElement
      if (!bar || bar.getAttribute('role') !== 'toolbar') return box(0, 0, 0)
      const i = Array.from(bar.children).indexOf(this)
      return box(8 + Math.floor(i / size.perRow) * 32, 24)
    })
    try {
      const { rerender } = render(<UiScaleContext.Provider value={1.5}><WorldToolbar {...props({ projectName: 'a-very-long-project-name' })} /></UiScaleContext.Provider>)
      expect(screen.getByTestId('world-more')).toBeInTheDocument()
      // The same width; the controls now fit on two rows.
      size.perRow = 20
      rerender(<UiScaleContext.Provider value={1.5}><WorldToolbar {...props({ projectName: 'a-very-long-project-name' })} /></UiScaleContext.Provider>)
      expect(screen.getByTestId('world-more')).toBeInTheDocument()
      // A shorter name: it looks again and unfolds.
      rerender(<UiScaleContext.Provider value={1.5}><WorldToolbar {...props({ projectName: 'w' })} /></UiScaleContext.Provider>)
      expect(screen.queryByTestId('world-more')).toBeNull()
      // Crowded again; a smaller scale at the same width: it looks again.
      size.perRow = 4
      rerender(<UiScaleContext.Provider value={1.5}><WorldToolbar {...props({ projectName: 'w' })} /></UiScaleContext.Provider>)
      expect(screen.getByTestId('world-more')).toBeInTheDocument()
      size.perRow = 20
      rerender(<UiScaleContext.Provider value={1}><WorldToolbar {...props({ projectName: 'w' })} /></UiScaleContext.Provider>)
      expect(screen.queryByTestId('world-more')).toBeNull()
    } finally {
      spyC.mockRestore()
      spyR.mockRestore()
    }
  })

  it('never counts the close button in the corner or the cost line as a row', () => {
    render(<WorldToolbar {...props({ labelCost: 'Labelling cost 1,200 tokens' })} />)
    expect(screen.getByTestId('world-close')).toHaveAttribute('data-world-row-skip')
    expect(screen.getByTestId('world-label-cost')).toHaveAttribute('data-world-row-skip')
  })
})
