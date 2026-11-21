// Lumopolis Export: the toolbar button and its menu. Each item opens one dialog: the interactive world as one
// offline page (ExportDialog), or the world's documentation as one page (DocumentDialog).
import { useState } from 'react'

export type ExportKind = 'world' | 'document'

export interface ExportMenuProps {
  /** The toolbar's button class, so Export looks like its neighbours. */
  btnClass: string
  onExport: (kind: ExportKind) => void
}

const itemCls = 'text-left px-2 py-1.5 rounded text-[#d4d4d4] hover:bg-[#37373d] focus:bg-[#37373d] outline-none'

export function ExportMenu({ btnClass, onExport }: ExportMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const choose = (kind: ExportKind): void => {
    setOpen(false)
    onExport(kind)
  }
  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="world-export"
        className={`${btnClass} inline-flex items-center gap-1.5`}
        onClick={() => setOpen(!open)}
        title="Save this world as a page you can share"
      ><i className="fa-solid fa-file-export" aria-hidden="true" />Export</button>
      {open && (
        <div
          role="menu"
          data-testid="world-export-menu"
          className="absolute right-0 top-full mt-1 p-1 rounded border border-[#3c3c3c] shadow-xl flex flex-col gap-0.5 text-xs w-56"
          style={{ zIndex: 7, background: '#252526' }}
        >
          <button type="button" role="menuitem" data-testid="world-export-world" className={itemCls} onClick={() => choose('world')}>
            Interactive world (HTML)…
          </button>
          <button type="button" role="menuitem" data-testid="world-export-document" className={itemCls} onClick={() => choose('document')}>
            Documentation (HTML)…
          </button>
        </div>
      )}
    </div>
  )
}
