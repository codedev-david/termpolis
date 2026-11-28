// Lumopolis: the question before a design change that removes a district with buildings in it (D3, signoff-decisions.md
// row #12). Main holds the change until the answer: Remove makes it (world:design-confirm), Cancel lets main drop it. An
// empty district is removed without asking. It is modal in the pane like the other dialogs (usePaneDialog, A11Y Y4):
// Cancel, its first control, takes the focus, so Enter never removes anything by accident; Esc is Cancel (WorldView's Esc
// cascade). Its accessible name is the question on show, so it holds every word a speech user reads off the screen.
import { useRef } from 'react'
import type { CSSProperties } from 'react'
import type { DistrictRemoval } from '../../../../shared/world/designPatch'
import { usePaneDialog } from './usePaneDialog'

const oneRemoval = (r: DistrictRemoval): string => `${r.name} and its ${r.buildings} building${r.buildings === 1 ? '' : 's'}`

/** "Remove A and its 3 buildings? This can't be undone.", every district the change removes named in one question. */
export function removalQuestion(removals: DistrictRemoval[]): string {
  const parts = removals.map(oneRemoval)
  const last = parts.pop() as string
  const list = parts.length === 0 ? last : `${parts.join(', ')}, and ${last}`
  return `Remove ${list}? This can't be undone.`
}

export interface RemoveDistrictConfirmProps {
  zoom: CSSProperties
  removals: DistrictRemoval[]
  onCancel: () => void
  onConfirm: () => void
}

export function RemoveDistrictConfirm({ zoom, removals, onCancel, onConfirm }: RemoveDistrictConfirmProps): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  usePaneDialog(box)
  const question = removalQuestion(removals)
  return (
    <div
      ref={box}
      tabIndex={-1}
      role="alertdialog"
      aria-label={question}
      data-testid="world-remove-district-confirm"
      className="p-3 rounded border border-[#3c3c3c] shadow-xl flex flex-col gap-2 text-xs focus:outline-none"
      style={{ position: 'absolute', top: 12, right: 12, width: 320, maxWidth: 'calc(100% - 24px)', boxSizing: 'border-box', zIndex: 10, background: '#252526', overflowWrap: 'anywhere', ...zoom }}
    >
      <p>{question}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          data-testid="world-remove-district-cancel"
          className="px-2 py-1 rounded border border-[#3c3c3c] hover:bg-[#37373d]"
          onClick={onCancel}
        >Cancel</button>
        <button
          type="button"
          data-testid="world-remove-district-go"
          className="px-2 py-1 rounded bg-[#a1260d] hover:bg-[#c42b1c] text-white"
          onClick={onConfirm}
        >Remove</button>
      </div>
    </div>
  )
}
