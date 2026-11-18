// The detail card over the Lumopolis map, top left. Its HTML comes only from the engine's card builders
// (buildingCard, edgeCard, the tour caption), which escape every string from the world document,
// so it is safe to set as innerHTML. Never pass raw document strings here.
import { useEffect, useState, type FormEvent, type MouseEvent, type Ref } from 'react'
import type { Evidence } from '../../../../shared/world/types'
import { cleanRuntimeNames, MAX_RUNTIME_NAMES } from '../../../../shared/world/runtimeNames'
import { CARD_INSET_PX, CARD_WIDTH_PX } from './worldPane'

const EVIDENCE_KINDS = ['file', 'symbol', 'test', 'transcriptStep', 'memory', 'commit', 'trace', 'metric', 'log', 'deploy', 'person']

/** The evidence a button carries, or null when its value does not parse or is not {kind, ref}. A string excerpt (a
 *  test's source) is kept; anything else in it is dropped. */
function readEvidence(raw: string | null): Evidence | null {
  try {
    const v = JSON.parse(raw as string) as { kind?: unknown; ref?: unknown; excerpt?: unknown } | null
    if (!v || !EVIDENCE_KINDS.includes(v.kind as string) || typeof v.ref !== 'string') return null
    const e: Evidence = { kind: v.kind as Evidence['kind'], ref: v.ref }
    return typeof v.excerpt === 'string' ? { ...e, excerpt: v.excerpt } : e
  } catch {
    return null
  }
}

export interface WorldCardProps {
  /** Escaped HTML from an engine card builder. */
  html: string
  onClose: () => void
  /** A link inside the card (data-node / data-edge) was clicked: open that part's card. */
  onOpen: (id: string) => void
  /** A technology chip (data-tech) was clicked: open its glossary card and light up every use. */
  onTech: (techId: string) => void
  /** Confirm (data-confirm) on an inferred claim: a person vouches for its text. */
  onConfirm: (itemId: string, text: string) => void
  /** Save on the "Service names" editor: the part and the names typed (already checked). Left out, the Edit button does nothing. */
  onRuntimeNames?: (itemId: string, names: string[]) => void
  /** An evidence button (data-evidence) was clicked. */
  onEvidence: (ev: Evidence) => void
  /** The card's element, measured so the close-ups are framed beside it. */
  boxRef?: Ref<HTMLElement>
  /**
   * The card's greatest height in pixels (cardMaxHeight: a narrow pane keeps the city room below it);
   * null or left out, the stage less 110 px. Past it the body scrolls under the title and the ×.
   */
  maxHeight?: number | null
}

/**
 * The prototype's inspector look (world-relationships.html): a dark glass panel, the name large, section
 * headings small capitals in sky blue so they read as labels and the text under them as values, status
 * pills, technology chips and dotted links. Scoped to .world-card so nothing leaks into the app.
 */
const CARD_CSS = `
.world-card{display:flex;flex-direction:column;overflow:hidden;background:rgba(8,12,22,.78);backdrop-filter:blur(10px);border:1px solid rgba(148,163,184,.18);border-radius:12px;padding:12px 6px 12px 14px;font-size:13px;line-height:1.45;color:#e2e8f0;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.world-card-close{position:absolute;top:8px;right:10px;z-index:2;padding:2px 7px;border-radius:6px;color:#94a3b8;background:transparent;border:0;cursor:pointer}
.world-card-close:hover{color:#e0f2fe;background:rgba(56,189,248,.18)}
.world-card-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding-right:8px;scrollbar-width:thin;scrollbar-color:rgba(125,211,252,.55) rgba(148,163,184,.12)}
.world-card-body:focus-visible{outline:1px solid rgba(125,211,252,.6);outline-offset:2px;border-radius:4px}
.world-card-body > h3:first-child{position:sticky;top:0;z-index:1;padding:0 26px 4px 0;background:rgba(8,12,22,.96)}
.world-card-body > :first-child:not(h3){padding-right:26px}
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
.world-card-body ul.claims{list-style:none;padding-left:0}
.world-card-body .claim .state{display:inline-block;padding:0 6px;border-radius:99px;font-size:10.5px;background:#334155;color:#cbd5e1}
.world-card-body .claim[data-state=verified] .state{background:#14532d;color:#4ade80}
.world-card-body .claim[data-state=observed] .state{background:#1e3a5f;color:#7dd3fc}
.world-card-body .claim[data-state=inferred] .state{background:#451a03;color:#fbbf24}
.world-card-body .claim button{margin-left:4px;padding:0 6px;border-radius:6px;font-size:11px;color:#7dd3fc;background:transparent;border:1px solid rgba(125,211,252,.4);cursor:pointer}
.world-card-body .claim button:hover{color:#e0f2fe;background:rgba(56,189,248,.18)}
.world-card-body .chip[data-tech]{cursor:pointer}
.world-card-body .chip[data-tech]:hover{background:rgba(167,139,250,.3)}
.world-card-body .chip{display:inline-block;margin:2px 3px 2px 0;padding:2px 8px;border-radius:99px;font-size:11.5px;background:rgba(167,139,250,.14);border:1px solid rgba(167,139,250,.45);color:#ede9fe}
.world-card-body .cargo{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.world-card-body a{color:#7dd3fc;cursor:pointer;text-decoration:underline dotted}
.world-card-body a:hover{color:#e0f2fe}
.world-card-names{margin-top:8px;padding:8px 8px 0 0;border-top:1px solid rgba(148,163,184,.18)}
.world-card-names label{display:block;font-size:11px;color:#7dd3fc;margin-bottom:4px}
.world-card-names input{width:100%;box-sizing:border-box;padding:4px 6px;border-radius:6px;font-size:12px;color:#e2e8f0;background:rgba(15,23,42,.8);border:1px solid rgba(148,163,184,.35)}
.world-card-names button{margin:6px 6px 0 0;padding:1px 8px;border-radius:6px;font-size:11px;color:#7dd3fc;background:transparent;border:1px solid rgba(125,211,252,.4);cursor:pointer}
.world-card-names [role=alert]{margin:4px 0 0;font-size:11px;color:#fbbf24}
.world-card-body .edit-names{padding:0 6px;border-radius:6px;font-size:11px;color:#7dd3fc;background:transparent;border:1px solid rgba(125,211,252,.4);cursor:pointer}
.world-card-body .tour-caption{font-size:13px;color:#e2e8f0}
`

export function WorldCard({ html, onClose, onOpen, onTech, onConfirm, onEvidence, onRuntimeNames, boxRef, maxHeight = null }: WorldCardProps): JSX.Element {
  // The service-names editor: the part it edits and what is typed. A new card (another part, or the saved one) closes it.
  const [edit, setEdit] = useState<{ id: string; text: string; was: string; error: boolean } | null>(null)
  useEffect(() => setEdit(null), [html])
  const save = (e: FormEvent): void => {
    e.preventDefault()
    const typed = (edit as { id: string; text: string; was: string }).text.split(',').map((n) => n.trim()).filter((n) => n !== '')
    const names = cleanRuntimeNames(typed)
    if (names.length !== typed.length) { setEdit({ ...(edit as { id: string; text: string; was: string }), error: true }); return }
    // Saving the names as they were shown would freeze today's detected names as hand-set ones: nothing is stored.
    const before = cleanRuntimeNames((edit as { was: string }).was.split(',').map((n) => n.trim()).filter((n) => n !== ''))
    if (names.join(',') !== before.join(',')) onRuntimeNames?.((edit as { id: string }).id, names)
    setEdit(null)
  }
  const onClick = (e: MouseEvent<HTMLDivElement>): void => {
    const target = e.target as Element
    const chip = target.closest('[data-tech]')
    if (chip) { e.preventDefault(); onTech(chip.getAttribute('data-tech') as string); return }
    const rename = target.closest('[data-runtime-edit]')
    if (rename) {
      e.preventDefault()
      if (onRuntimeNames) {
        const shown = rename.getAttribute('data-names') ?? ''
        setEdit({ id: rename.getAttribute('data-runtime-edit') as string, text: shown, was: shown, error: false })
      }
      return
    }
    const confirm = target.closest('[data-confirm]')
    if (confirm) {
      e.preventDefault()
      const itemId = (confirm.getAttribute('data-confirm') as string).split('|')[0]
      onConfirm(itemId, confirm.closest('.claim')?.querySelector('.ctext')?.textContent ?? '')
      return
    }
    const ev = target.closest('[data-evidence]')
    if (ev) {
      e.preventDefault()
      const parsed = readEvidence(ev.getAttribute('data-evidence'))
      if (parsed) onEvidence(parsed)
      return
    }
    const link = target.closest('[data-node],[data-edge]')
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
      style={{ position: 'absolute', top: CARD_INSET_PX, left: CARD_INSET_PX, width: CARD_WIDTH_PX, maxHeight: maxHeight === null ? 'calc(100% - 110px)' : `min(${maxHeight}px, calc(100% - 110px))`, boxSizing: 'border-box', zIndex: 3 }}
    >
      <style>{CARD_CSS}</style>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close details"
        data-testid="world-card-close"
        className="world-card-close"
      ><i className="fa-solid fa-xmark" aria-hidden="true" /></button>
      {/* Its own scroller, reachable by Tab, so the arrow keys and Page Up/Down scroll a capped card. */}
      <div
        className="world-card-body"
        data-testid="world-card-body"
        role="region"
        aria-label="Details"
        tabIndex={0}
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {edit && (
        <form className="world-card-names" data-testid="world-card-names" onSubmit={save}>
          <label htmlFor="world-card-names-input">Service names (up to {MAX_RUNTIME_NAMES}, separated by commas)</label>
          <input id="world-card-names-input" autoFocus value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value, error: false })} />
          <p className="world-card-names-help">Leave it empty and save to clear this part's service names, including the ones Lumopolis found in the code. Names you save replace the detected ones.</p>
          {edit.error && <p role="alert">Use only letters, digits, dots, dashes and underscores, up to {MAX_RUNTIME_NAMES} names.</p>}
          <button type="submit">Save</button>
          <button type="button" onClick={() => setEdit(null)}>Cancel</button>
        </form>
      )}
    </aside>
  )
}
