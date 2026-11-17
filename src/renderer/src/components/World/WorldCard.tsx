// The detail card over the Lumopolis map, top left. Its HTML comes only from the engine's card builders
// (buildingCard, edgeCard, the tour caption), which escape every string from the world document,
// so it is safe to set as innerHTML. Never pass raw document strings here.
import type { MouseEvent, Ref } from 'react'
import { CARD_INSET_PX } from './worldPane'

export interface WorldCardProps {
  /** Escaped HTML from an engine card builder. */
  html: string
  onClose: () => void
  /** A link inside the card (data-node / data-edge) was clicked: open that part's card. */
  onOpen: (id: string) => void
  /** The card's element, measured so the close-ups are framed beside it. */
  boxRef?: Ref<HTMLElement>
}

/**
 * The prototype's inspector look (world-relationships.html): a dark glass panel, the name large, section
 * headings small capitals in sky blue so they read as labels and the text under them as values, status
 * pills, technology chips and dotted links. Scoped to .world-card so nothing leaks into the app.
 */
const CARD_CSS = `
.world-card{background:rgba(8,12,22,.78);backdrop-filter:blur(10px);border:1px solid rgba(148,163,184,.18);border-radius:12px;padding:12px 14px;font-size:13px;line-height:1.45;color:#e2e8f0;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.world-card-close{float:right;margin:-4px -6px 0 8px;padding:2px 7px;border-radius:6px;color:#94a3b8;background:transparent;border:0;cursor:pointer}
.world-card-close:hover{color:#e0f2fe;background:rgba(56,189,248,.18)}
.world-card-body h3,.world-card-body h2{margin:0 0 4px;font-size:16px;font-weight:600;color:#f1f5f9;text-transform:none;letter-spacing:0}
.world-card-body h4{margin:12px 0 4px;font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#7dd3fc}
.world-card-body p{margin:4px 0}
.world-card-body ul{margin:2px 0;padding-left:16px;list-style:disc}
.world-card-body li{margin:2px 0}
.world-card-body b{font-weight:600;color:#f1f5f9}
.world-card-body .muted{color:#94a3b8;font-size:12px}
.world-card-body .proc{font-size:12px;color:#cbd5e1;background:rgba(148,163,184,.1);border-radius:6px;padding:4px 8px;margin:6px 0}
.world-card-body .tag{display:inline-block;padding:1px 8px;border-radius:99px;font-size:11px;background:#334155;color:#cbd5e1;margin-right:4px}
.world-card-body .status-verified{background:#14532d;color:#4ade80}
.world-card-body .status-built{background:#1e3a5f;color:#7dd3fc}
.world-card-body .status-gap{background:#451a03;color:#fbbf24}
.world-card-body .status-proposed{background:#1e293b;color:#93c5fd}
.world-card-body .status-external{background:#334155;color:#e2e8f0}
.world-card-body .claim-inferred{color:#cbd5e1}
.world-card-body .chip{display:inline-block;margin:2px 3px 2px 0;padding:2px 8px;border-radius:99px;font-size:11.5px;background:rgba(167,139,250,.14);border:1px solid rgba(167,139,250,.45);color:#ede9fe}
.world-card-body .cargo{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.world-card-body a{color:#7dd3fc;cursor:pointer;text-decoration:underline dotted}
.world-card-body a:hover{color:#e0f2fe}
.world-card-body .tour-caption{font-size:13px;color:#e2e8f0}
`

export function WorldCard({ html, onClose, onOpen, boxRef }: WorldCardProps): JSX.Element {
  const onClick = (e: MouseEvent<HTMLDivElement>): void => {
    const link = (e.target as Element).closest('[data-node],[data-edge]')
    if (!link) return
    e.preventDefault()
    onOpen(link.getAttribute('data-node') ?? (link.getAttribute('data-edge') as string))
  }
  return (
    <aside
      ref={boxRef}
      aria-label="Lumopolis details"
      data-testid="world-card"
      className="world-card"
      // Top left over the map, where the prototype's inspector sits (the legend is top right).
      style={{ position: 'absolute', top: CARD_INSET_PX, left: CARD_INSET_PX, width: 330, maxHeight: 'calc(100% - 110px)', overflow: 'auto', zIndex: 3 }}
    >
      <style>{CARD_CSS}</style>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close details"
        data-testid="world-card-close"
        className="world-card-close"
      ><i className="fa-solid fa-xmark" aria-hidden="true" /></button>
      <div className="world-card-body" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
    </aside>
  )
}
