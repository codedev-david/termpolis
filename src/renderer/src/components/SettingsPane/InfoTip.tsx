import { useState, type ReactNode } from 'react'

/**
 * A small "ⓘ" affordance that reveals an explanatory tooltip on hover/focus and toggles
 * on click (touch-friendly). `align="right"` anchors it to the right edge for right-hand
 * panels so the tooltip never runs off-screen.
 *
 * Shared across the Settings panes on purpose. Settings is where the long explanations
 * belong, but prose that is always visible pushes the controls off the screen — one
 * affordance, used the same way everywhere, keeps the copy one hover away instead.
 *
 * `label` names what is being explained for a screen reader, which matters as soon as a
 * pane carries more than one tip: "What this means" three times over says nothing.
 */
export function InfoTip({
  children,
  align = 'left',
  label = 'What this means',
  testId,
}: {
  children: ReactNode
  align?: 'left' | 'right'
  label?: string
  testId?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <span className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label={label}
        data-testid={testId}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
        className="ml-1.5 w-[15px] h-[15px] inline-flex items-center justify-center rounded-full border border-[#3c3c3c] bg-[#2d2d2d] text-[#9ca3af] text-[9px] font-mono leading-none hover:text-[#22D3EE] hover:border-[#22D3EE]"
      >i</button>
      {open && (
        <span
          role="tooltip"
          data-testid={testId ? `${testId}-text` : undefined}
          className={`absolute z-50 top-[calc(100%+8px)] ${align === 'right' ? 'right-0' : 'left-0'} w-64 max-w-[74vw] rounded-lg border border-[#3c3c3c] bg-[#1e1e1e] p-2.5 text-[11px] font-sans font-normal normal-case leading-relaxed tracking-normal text-[#9ca3af] shadow-xl`}
        >{children}</span>
      )}
    </span>
  )
}
