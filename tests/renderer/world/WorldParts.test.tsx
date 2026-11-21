import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { CARD_CLICK_GRACE_MS, WorldCard } from '../../../src/renderer/src/components/World/WorldCard'
import { EvidenceView } from '../../../src/renderer/src/components/World/EvidenceView'
import { WorldEmptyState } from '../../../src/renderer/src/components/World/WorldEmptyState'
import { WorldToolbar, type WorldToolbarProps } from '../../../src/renderer/src/components/World/WorldToolbar'
import { DEFAULT_LAYERS } from '../../../src/renderer/src/world/engine'

const noop = { onTech: vi.fn(), onConfirm: vi.fn(), onEvidence: vi.fn() }

describe('WorldCard', () => {
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
})
