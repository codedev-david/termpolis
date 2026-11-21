// Lumopolis Export: the toolbar button and its menu. Each item opens one dialog: the interactive world as one
// offline page (ExportDialog), or the world's documentation as one page (DocumentDialog). The menu is a plain group
// of buttons, like Bookmarks beside it: Esc closes it and nothing else, and so does a click anywhere outside it.
import { useEffect, useRef, useState } from 'react'

export type ExportKind = 'world' | 'document'

export interface ExportMenuProps {
  /** The toolbar's button class, so Export looks like its neighbours. */
  btnClass: string
  onExport: (kind: ExportKind) => void
  /** An Export or Build it dialog is open: the button is off and the menu closed. */
  disabled?: boolean
}

/** The menu's width in px (w-56), to tell whether it fits to the left of the button. */
const MENU_W = 224

const itemCls = 'text-left px-2 py-1.5 rounded text-[#d4d4d4] hover:bg-[#37373d] focus:bg-[#37373d] outline-none'

export function ExportMenu({ btnClass, onExport, disabled = false }: ExportMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  // Which edge the menu hangs from. The toolbar wraps in a narrow pane, and Export can start a row: a menu hung
  // from its right edge would then reach past the pane's left edge, where the pane clips it.
  const [side, setSide] = useState<'left' | 'right'>('right')
  const wrapRef = useRef<HTMLDivElement>(null)
  // A dialog opened some other way (the palette) closes the menu under it.
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!(wrapRef.current as HTMLDivElement).contains(e.target as Node | null)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [open])
  const choose = (kind: ExportKind): void => {
    setOpen(false)
    onExport(kind)
  }
  return (
    <div
      ref={wrapRef}
      className="relative"
      // The pane leaves an Esc from inside an open menu to the menu (WorldView reads this attribute).
      data-world-own-esc={open ? '' : undefined}
      onKeyDown={(e) => {
        if (!open || e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
      }}
    >
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        data-testid="world-export"
        className={`${btnClass} inline-flex items-center gap-1.5`}
        disabled={disabled}
        onClick={() => {
          const wrap = wrapRef.current as HTMLDivElement
          const room = wrap.getBoundingClientRect().right - (wrap.parentElement as HTMLElement).getBoundingClientRect().left
          setSide(room < MENU_W ? 'left' : 'right')
          setOpen(!open)
        }}
        title="Save this world as a page you can share"
      ><i className="fa-solid fa-file-export" aria-hidden="true" />Export</button>
      {open && (
        <div
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
