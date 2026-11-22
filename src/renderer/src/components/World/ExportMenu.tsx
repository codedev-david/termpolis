// Lumopolis Export: the toolbar button and its menu. Each item opens one dialog: the interactive world as one
// offline page (ExportDialog), or the world's documentation as one page (DocumentDialog). The menu is a plain group
// of buttons, like Bookmarks beside it. The toolbar opens and shuts it (WorldToolbar keeps one popup open at a
// time): Esc shuts it and nothing else, and so does a click anywhere outside it.
import { useContext, useRef, useState } from 'react'
import { screenRect } from '../../world/engine/screenRect'
import { UiScaleContext } from './worldPane'

export type ExportKind = 'world' | 'document'

export interface ExportMenuProps {
  /** The toolbar's button class, so Export looks like its neighbours. */
  btnClass: string
  onExport: (kind: ExportKind) => void
  /** An Export or Build it dialog is open: the button is off (and the toolbar shuts the menu). */
  disabled?: boolean
  /** The menu is open. */
  open: boolean
  /** The button was pressed: opens the menu, or shuts it. */
  onToggle: () => void
  /** An item was chosen: shuts the menu, the focus back on the button. */
  onDone: () => void
  /** The menu's id, for the button's aria-controls. */
  menuId: string
}

/** The menu's width in its own px (w-56), to tell whether it fits to the left of the button: times the pane's scale on screen. */
const MENU_W = 224

const itemCls = 'text-left px-2 py-1.5 rounded text-[#d4d4d4] hover:bg-[#37373d] focus:bg-[#37373d] outline-none'

export function ExportMenu({ btnClass, onExport, disabled = false, open, onToggle, onDone, menuId }: ExportMenuProps): JSX.Element {
  const scale = useContext(UiScaleContext)
  // Which edge the menu hangs from. The toolbar wraps in a narrow pane, and Export can start a row: a menu hung
  // from its right edge would then reach past the pane's left edge, where the pane clips it.
  const [side, setSide] = useState<'left' | 'right'>('right')
  const wrapRef = useRef<HTMLDivElement>(null)
  const choose = (kind: ExportKind): void => {
    onDone()
    onExport(kind)
  }
  return (
    <div
      ref={wrapRef}
      className="relative"
      data-world-popup="export"
      // While the menu is open the pane leaves Esc to it (WorldView reads this attribute).
      data-world-own-esc={open ? '' : undefined}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-testid="world-export"
        className={`${btnClass} inline-flex items-center gap-1.5`}
        disabled={disabled}
        onClick={() => {
          const wrap = wrapRef.current as HTMLDivElement
          // Both on screen: on a big monitor the toolbar, and the menu in it, are drawn `scale` times bigger.
          const room = screenRect(wrap).right - screenRect(wrap.parentElement as HTMLElement).left
          setSide(room < MENU_W * scale ? 'left' : 'right')
          onToggle()
        }}
        title="Save this world as a page you can share"
      ><i className="fa-solid fa-file-export" aria-hidden="true" />Export</button>
      {open && (
        <div
          id={menuId}
          role="group"
          aria-label="Export"
          data-testid="world-export-menu"
          className={`absolute ${side === 'left' ? 'left-0' : 'right-0'} top-full mt-1 p-1 rounded border border-[#3c3c3c] shadow-xl flex flex-col gap-0.5 text-xs w-56`}
          style={{ zIndex: 7, background: '#252526' }}
        >
          <button type="button" data-testid="world-export-world" className={itemCls} onClick={() => choose('world')}>
            Interactive world (HTML)…
          </button>
          <button type="button" data-testid="world-export-document" className={itemCls} onClick={() => choose('document')}>
            Documentation (HTML)…
          </button>
        </div>
      )}
    </div>
  )
}
