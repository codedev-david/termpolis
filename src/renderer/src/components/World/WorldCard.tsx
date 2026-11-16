// The detail card over the Lumopolis map, top left. Its HTML comes only from the engine's card builders
// (buildingCard, edgeCard, the tour caption), which escape every string from the world document,
// so it is safe to set as innerHTML. Never pass raw document strings here.
import type { MouseEvent } from 'react'

export interface WorldCardProps {
  /** Escaped HTML from an engine card builder. */
  html: string
  onClose: () => void
  /** A link inside the card (data-node / data-edge) was clicked: open that part's card. */
  onOpen: (id: string) => void
}

export function WorldCard({ html, onClose, onOpen }: WorldCardProps): JSX.Element {
  const onClick = (e: MouseEvent<HTMLDivElement>): void => {
    const link = (e.target as Element).closest('[data-node],[data-edge]')
    if (!link) return
    e.preventDefault()
    onOpen(link.getAttribute('data-node') ?? (link.getAttribute('data-edge') as string))
  }
  return (
    <aside
      aria-label="Lumopolis details"
      data-testid="world-card"
      className="rounded border border-[#3c3c3c] shadow-xl text-sm text-[#cccccc]"
      // Top left over the map, where the prototype's inspector sits (the legend is top right).
      style={{ position: 'absolute', top: 12, left: 12, width: 330, maxHeight: 'calc(100% - 110px)', overflow: 'auto', zIndex: 3, background: 'rgba(30,30,30,.95)' }}
    >
      <div className="flex justify-end px-2 pt-2">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          data-testid="world-card-close"
          className="px-1.5 py-0.5 rounded text-[#999] hover:text-white hover:bg-[#37373d]"
        ><i className="fa-solid fa-xmark" aria-hidden="true" /></button>
      </div>
      <div
        className="px-3 pb-3 flex flex-col gap-2 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-xs [&_h3]:uppercase [&_h3]:tracking-wider [&_h3]:text-[#9ca3af] [&_a]:text-[#4fc1ff] [&_a]:cursor-pointer [&_a:hover]:underline [&_.chip]:inline-block [&_.chip]:mr-1 [&_.chip]:px-1.5 [&_.chip]:rounded [&_.chip]:bg-[#2d2d2d] [&_.chip]:text-xs"
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </aside>
  )
}
