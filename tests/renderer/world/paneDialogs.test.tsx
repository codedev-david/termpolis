import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { useState } from 'react'

// A11Y Y4: every Lumopolis dialog is modal inside the pane. It says so (aria-modal), takes the focus as it opens, keeps
// Tab and Shift+Tab on its own controls, brings back a focus moved to the pane behind it (a click on the map) while the
// terminal beside the pane may still take it, and closed gives the focus back to the control that opened it, or to
// the pane when that control went with its menu. The home's dialogs (Design, Clone) and the token dialog leave the give
// back to the home or the clone dialog, which choose the control themselves (WorldHome.test, CloneDialog tests).

vi.mock('../../../src/renderer/src/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({ status: 'idle', errorMsg: null, notice: null, toggle: vi.fn() }),
}))

import { BuildItDialog } from '../../../src/renderer/src/components/World/BuildItDialog'
import { CloneDialog } from '../../../src/renderer/src/components/World/CloneDialog'
import { DesignStart } from '../../../src/renderer/src/components/World/DesignStart'
import { DocumentDialog } from '../../../src/renderer/src/components/World/DocumentDialog'
import { ExportDialog } from '../../../src/renderer/src/components/World/ExportDialog'
import { RepoAccessDialog } from '../../../src/renderer/src/components/World/RepoAccessDialog'
import { RelayoutConfirm } from '../../../src/renderer/src/components/World/RelayoutConfirm'

const ok = <T,>(data: T) => ({ success: true as const, data })
const never = () => new Promise<never>(() => undefined)

beforeEach(() => {
  ;(window as any).termpolis = {
    worldExportInfo: vi.fn(never),
    worldExportCancel: vi.fn(async () => ok(true)),
    onWorldExportProgress: vi.fn(() => () => undefined),
    worldDocumentCancel: vi.fn(async () => ok(true)),
    worldPickFolder: vi.fn(never),
    worldCloneCancel: vi.fn(async () => ok(true)),
    worldDesignCancel: vi.fn(async () => ok(true)),
  }
})
afterEach(() => { cleanup(); delete (window as any).termpolis })

type Dialog = (onClose: () => void) => JSX.Element
const dialogs: [string, Dialog, boolean][] = [
  ['Build it', (onClose) => <BuildItDialog designKey="d" title="T" agents={[{ id: 'claude', name: 'Claude Code' }]} onBuilt={vi.fn()} onClose={onClose} />, true],
  ['Export', (onClose) => <ExportDialog onSaved={vi.fn()} onClose={onClose} />, true],
  ['Document', (onClose) => <DocumentDialog projectName="p" picture={() => null} onSaved={vi.fn()} onClose={onClose} />, true],
  ['Relayout', (onClose) => <RelayoutConfirm zoom={{}} onCancel={onClose} onConfirm={vi.fn()} />, true],
  ['Design', (onClose) => <DesignStart onDrafted={vi.fn()} onClose={onClose} />, false],
  ['Clone', (onClose) => <CloneDialog onCloned={vi.fn()} onClose={onClose} />, false],
  ['Token', (onClose) => <RepoAccessDialog host="github.com" busy={false} error={null} onSubmit={vi.fn()} onCancel={onClose} />, false],
]

function Pane({ dialog }: { dialog: Dialog }) {
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState(true)
  return (
    <>
      <div data-terminal-id="t1"><textarea data-testid="terminal" /></div>
      <div data-testid="world-view" tabIndex={-1}>
        <button type="button" data-testid="map">map</button>
        <button type="button" data-testid="opener" onClick={() => setOpen(true)}>open</button>
        {menu && <button type="button" data-testid="menu-item" onClick={() => { setMenu(false); setOpen(true) }}>menu item</button>}
        {open && dialog(() => setOpen(false))}
      </div>
    </>
  )
}

const box = (): HTMLElement => document.querySelector('[aria-modal="true"]') as HTMLElement
const open = (id: string): void => {
  screen.getByTestId(id).focus()
  act(() => { fireEvent.click(screen.getByTestId(id)) })
}
const tab = (back = false): void => {
  act(() => { fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab', shiftKey: back }) })
}
const closeOf = (): HTMLElement => {
  const b = box()
  return (b.querySelector('[data-testid="world-relayout-cancel"]') ?? Array.from(b.querySelectorAll('button')).find((x) => x.textContent === 'Cancel')) as HTMLElement
}

describe.each(dialogs)('the %s dialog in the pane (A11Y Y4)', (_name, dialog, givesBack) => {
  it('is modal, takes the focus, and keeps Tab and Shift+Tab on its own controls', () => {
    render(<Pane dialog={dialog} />)
    open('opener')
    const b = box()
    expect(['dialog', 'alertdialog']).toContain(b.getAttribute('role'))
    expect(b.getAttribute('aria-label')).toBeTruthy()
    expect(b.contains(document.activeElement)).toBe(true)
    for (let i = 0; i < 12; i++) { tab(); expect(b.contains(document.activeElement)).toBe(true) }
    for (let i = 0; i < 12; i++) { tab(true); expect(b.contains(document.activeElement)).toBe(true) }
  })

  it('brings back a focus moved to the pane behind it, and lets the terminal beside the pane take it', () => {
    render(<Pane dialog={dialog} />)
    open('opener')
    const at = document.activeElement
    act(() => { screen.getByTestId('map').focus() })
    expect(document.activeElement).toBe(at)
    act(() => { screen.getByTestId('terminal').focus() })
    expect(document.activeElement).toBe(screen.getByTestId('terminal'))
  })

  it(givesBack ? 'closed, gives the focus back to its opener, or to the pane when the opener went with its menu' : 'closed, leaves the give back to the home or the dialog that opened it', () => {
    render(<Pane dialog={dialog} />)
    open('opener')
    act(() => { fireEvent.click(closeOf()) })
    expect(box()).toBeNull()
    expect(document.activeElement).toBe(givesBack ? screen.getByTestId('opener') : document.body)
    open('menu-item')
    act(() => { fireEvent.click(closeOf()) })
    expect(document.activeElement).toBe(givesBack ? screen.getByTestId('world-view') : document.body)
  })
})

it('the re-layout question puts the focus on Cancel, so Enter never forgets the arrangement by accident', () => {
  render(<Pane dialog={dialogs[3][1]} />)
  open('opener')
  expect(document.activeElement).toBe(screen.getByTestId('world-relayout-cancel'))
  expect(box().getAttribute('aria-describedby')).toBe('world-relayout-text')
})
