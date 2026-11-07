// A modal sheet of the account UI (the sign-in sheet, Add account, agy's switch): it holds the
// keyboard while open (Tab goes round its controls, so no key reaches a terminal under it), gives
// the focus back when it closes, and Esc does what its close button does.
import { useRef } from 'react'
import type { ReactNode } from 'react'
import { useFocusTrap } from '../../hooks/useFocusTrap'

interface Props {
  title: string
  subtitle?: string
  /** Font Awesome icon for the sheet's badge. */
  icon: string
  /** Esc and the close button; absent while the sheet can't be closed (a step that must finish). */
  onClose?: () => void
  /** The id of the text inside that says what the sheet asks: a screen reader says it with the title, where the focus starts on a
   *  button (the safe answer) and would otherwise not hear what it answers (R3-6). */
  describedBy?: string
  testId: string
  children: ReactNode
}

export function Sheet({ title, subtitle, icon, onClose, describedBy, testId, children }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref)
  const titleId = `${testId}-title`
  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70"
      data-testid={`${testId}-overlay`}
      // A press on the dark backdrop would drop the focus to the page, and Esc and Tab (handled here) would go nowhere.
      onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); ref.current?.focus() } }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        tabIndex={-1}
        data-testid={testId}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || !onClose) return
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }}
        className="bg-[#252526] border border-[#3c3c3c] rounded-xl shadow-2xl w-[540px] max-w-[92vw] max-h-[90vh] overflow-y-auto p-6 flex flex-col gap-4 text-sm text-[#d4d4d4] focus:outline-none"
      >
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 shrink-0 rounded-xl bg-[#22D3EE]/15 flex items-center justify-center">
            <i className={`fa-solid ${icon} text-[#22D3EE]`} aria-hidden="true"></i>
          </div>
          <div className="flex-1 min-w-0">
            <h2 id={titleId} className="text-lg font-semibold text-[#e0e0e0] break-words">{title}</h2>
            {subtitle && <p className="text-xs text-[#9ca3af]">{subtitle}</p>}
          </div>
          {onClose && (
            <button type="button" onClick={onClose} aria-label="Close" className="px-1.5 py-0.5 rounded text-[#9ca3af] hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#22D3EE]" data-testid={`${testId}-close`}>
              <i className="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  )
}
