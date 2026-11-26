// Lumopolis: the question before a re-layout, which forgets the current arrangement. It is modal in the pane like the
// other dialogs (usePaneDialog, A11Y Y4): Cancel, its first control, takes the focus, so Enter never re-lays out by accident; Esc is
// Cancel (WorldView's Esc cascade); closed, the focus goes back to the Re-layout control, or to the pane.
import { useRef } from 'react'
import type { CSSProperties } from 'react'
import { usePaneDialog } from './usePaneDialog'

export interface RelayoutConfirmProps {
  zoom: CSSProperties
  onCancel: () => void
  onConfirm: () => void
}

export function RelayoutConfirm({ zoom, onCancel, onConfirm }: RelayoutConfirmProps): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  usePaneDialog(box)
  return (
    <div
      ref={box}
      tabIndex={-1}
      role="alertdialog"
      aria-modal="true"
      aria-label="Confirm re-layout"
      aria-describedby="world-relayout-text"
      data-testid="world-relayout-confirm"
      className="p-3 rounded border border-[#3c3c3c] shadow-xl flex flex-col gap-2 text-xs focus:outline-none"
      style={{ position: 'absolute', top: 12, right: 12, width: 320, maxWidth: 'calc(100% - 24px)', boxSizing: 'border-box', zIndex: 5, background: '#252526', ...zoom }}
    >
      <p id="world-relayout-text">Re-layout places every part again from scratch and forgets the current arrangement. Continue?</p>
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          data-testid="world-relayout-cancel"
          className="px-2 py-1 rounded border border-[#3c3c3c] hover:bg-[#37373d]"
          onClick={onCancel}
        >Cancel</button>
        <button
          type="button"
          data-testid="world-relayout-go"
          className="px-2 py-1 rounded bg-[#0078d4] hover:bg-[#106ebe] text-white"
          onClick={onConfirm}
        >Re-layout</button>
      </div>
    </div>
  )
}
