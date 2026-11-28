// The detail card over the Lumopolis map, top left. Its HTML comes only from the engine's card builders
// (buildingCard, edgeCard, the tour caption), which escape every string from the world document,
// so it is safe to set as innerHTML. Never pass raw document strings here.
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type CSSProperties, type MouseEvent, type Ref } from 'react'
import type { Evidence } from '../../../../shared/world/types'
import { cleanRuntimeNames, MAX_RUNTIME_NAMES } from '../../../../shared/world/runtimeNames'
import { CARD_INSET_PX, CARD_WIDTH_PX, SOLID_PANEL, useUiZoom } from './worldPane'

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
  /** True when a click on the map opened the card: it then lets clicks through for CARD_CLICK_GRACE_MS. */
  clickThrough?: boolean
  /** The map is drawn in software (WorldDrawn.software): the card is opaque, with no blur of the map behind it. */
  solid?: boolean
  /**
   * Told the card's height in its own pixels that shows its first heading and the first two items under it without a
   * scroll (readableNeed), each time the card is measured: cardMaxHeight gives a narrow pane's card that much where
   * the city keeps its least room.
   */
  onNeed?: (px: number) => void
  /** A tour stop shows: the body is no live region then, as the pane says the stop in its own status region, once (T5). */
  quiet?: boolean
  /** A tour on the 2D map: the stop shown of how many, and Back, Next and End tour to step through it (Y2). */
  tour?: CardTour
}

/** The 2D map's tour as the card steps through it (Y2). */
export interface CardTour {
  n: number
  of: number
  /** The tour's title, which names its controls ("Tour: How a request flows"); an answer's tour has none. */
  title?: string
  onBack: () => void
  onNext: () => void
  onEnd: () => void
}

/**
 * How far up from the bottom of a card that scrolls on its content fades out. A capped card's bottom edge falls
 * wherever the cap does, through a line of text as often as not (at 1366x768 it sliced a list entry through its
 * glyphs). Fading the last stretch, instead of snapping the card's height to an item's end, works whatever the
 * items' heights (a wrapped paragraph, a row of chips, the sticky title) and at every scroll position, gives the
 * card all its height, and says there is more below. It is deeper than any line the card shows (13 px text at
 * 1.45, a 16 px title, a chip row of about 22 px), so a line the edge cuts lies wholly in the fade. Gone at the end.
 */
export const CARD_FADE_PX = 24

/**
 * The height, in the card's own pixels, at which the card shows its first heading and the first two items after it
 * (a claim, a sentence or a list entry; a later heading is passed over) without a scroll: from the card's top to the
 * second item's end as laid out with the body at its top, the fade under it (CARD_FADE_PX), and what lies under the
 * body (its padding and border). 0 where there is no heading, nothing under it, or the card is not laid out. Screen
 * pixels are taken back to the card's own through its measured height, since the pane may draw it zoomed.
 */
function readableNeed(body: HTMLElement): number {
  const card = body.parentElement as HTMLElement
  const items: Element[] = []
  for (let el = body.querySelector('h4')?.nextElementSibling ?? null; el && items.length < 2; el = el.nextElementSibling) {
    if (el.tagName === 'H4') continue
    items.push(...(/^[OU]L$/.test(el.tagName) ? Array.from(el.children).slice(0, 2 - items.length) : [el]))
  }
  const box = card.getBoundingClientRect()
  if (items.length === 0 || !(box.height > 0)) return 0
  const own = card.offsetHeight / box.height
  const end = items[items.length - 1].getBoundingClientRect().bottom
  return Math.ceil((end - box.top) * own + body.scrollTop + CARD_FADE_PX + (box.bottom - body.getBoundingClientRect().bottom) * own)
}

/**
 * The prototype's inspector look (world-relationships.html): a dark glass panel, the name large, section
 * headings small capitals in sky blue so they read as labels and the text under them as values, status
 * pills, technology chips and dotted links. Scoped to .world-card so nothing leaks into the app. Drawn in software,
 * the card is solid (SOLID_PANEL) instead of glass.
 */
const CARD_CSS = `
.world-card{display:flex;flex-direction:column;overflow:hidden;background:rgba(8,12,22,.78);backdrop-filter:blur(10px);border:1px solid rgba(148,163,184,.18);border-radius:12px;padding:12px 6px 12px 14px;font-size:13px;line-height:1.45;color:#e2e8f0;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.world-card[data-solid]{background:${SOLID_PANEL};backdrop-filter:none}
.world-card-close{position:absolute;top:8px;right:calc(10px + var(--world-card-gutter, 0px));z-index:2;padding:2px 7px;border-radius:6px;color:#94a3b8;background:transparent;border:0;cursor:pointer}
.world-card-close:hover{color:#e0f2fe;background:rgba(56,189,248,.18)}
.world-card-body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-wrap:anywhere;padding-right:8px;scrollbar-width:thin;scrollbar-color:rgba(125,211,252,.55) rgba(148,163,184,.12)}
.world-card-body[data-more]{-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - ${CARD_FADE_PX}px),transparent),linear-gradient(#000,#000);mask-image:linear-gradient(to bottom,#000 calc(100% - ${CARD_FADE_PX}px),transparent),linear-gradient(#000,#000);-webkit-mask-size:calc(100% - var(--world-card-gutter,0px)) 100%,var(--world-card-gutter,0px) 100%;mask-size:calc(100% - var(--world-card-gutter,0px)) 100%,var(--world-card-gutter,0px) 100%;-webkit-mask-position:left top,right top;mask-position:left top,right top;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat}
.world-card-body:focus-visible{outline:1px solid rgba(125,211,252,.6);outline-offset:2px;border-radius:4px}
.world-card-body > h3:first-child{position:sticky;top:0;z-index:1;padding:0 26px 4px 0;background:rgba(8,12,22,.96)}
.world-card-body > :first-child:not(h3){padding-right:26px}
.world-card-body h3,.world-card-body h2{margin:0 0 4px;font-size:16px;font-weight:600;color:#f1f5f9;text-transform:none;letter-spacing:0}
.world-card-body h4{margin:12px 0 4px;font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#7dd3fc}
.world-card-body p{margin:4px 0}
.world-card-body ul{margin:2px 0;padding-left:16px;list-style:disc}
.world-card-body li{margin:2px 0}
.world-card-body b{font-weight:600;color:#f1f5f9}
.world-card-body .muted{color:#94a3b8;font-size:12px}
.world-card-body .proc{font-size:12px;color:#cbd5e1;background:rgba(148,163,184,.1);border-radius:6px;padding:4px 8px;margin:6px 0}
.world-card-body .tag{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;background:#334155;color:#cbd5e1;margin-right:4px}
.world-card-body .status-verified{background:#14532d;color:#4ade80}
.world-card-body .status-built{background:#1e3a5f;color:#7dd3fc}
.world-card-body .status-gap{background:#451a03;color:#fbbf24}
.world-card-body .status-proposed{background:#1e293b;color:#93c5fd}
.world-card-body .status-external{background:#334155;color:#e2e8f0}
.world-card-body ul.claims{list-style:none;padding-left:0}
.world-card-body .claim .state{display:inline-block;padding:0 6px;border-radius:99px;font-size:12px;background:#334155;color:#cbd5e1}
.world-card-body .claim[data-state=verified] .state{background:#14532d;color:#4ade80}
.world-card-body .claim[data-state=observed] .state{background:#1e3a5f;color:#7dd3fc}
.world-card-body .claim[data-state=inferred] .state{background:#451a03;color:#fbbf24}
.world-card-body .claim button{margin-left:4px;padding:0 6px;border-radius:6px;font-size:12px;color:#7dd3fc;background:transparent;border:1px solid rgba(125,211,252,.4);cursor:pointer}
.world-card-body .claim button:hover{color:#e0f2fe;background:rgba(56,189,248,.18)}
.world-card-body .chip[data-tech]{cursor:pointer}
.world-card-body .chip[data-tech]:hover{background:rgba(167,139,250,.3)}
.world-card-body .chip{display:inline-block;max-width:100%;box-sizing:border-box;margin:2px 3px 2px 0;padding:2px 8px;border-radius:99px;font:inherit;font-size:12px;line-height:1.45;text-align:left;background:rgba(167,139,250,.14);border:1px solid rgba(167,139,250,.45);color:#ede9fe}
.world-card-body .cargo{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.world-card-body a,.world-card-body .lnk{color:#7dd3fc;cursor:pointer;text-decoration:underline dotted}
.world-card-body a:hover,.world-card-body .lnk:hover{color:#e0f2fe}
.world-card-body .lnk{display:inline;margin:0;padding:0;border:0;background:none;font:inherit;text-align:inherit}
.world-card button:focus-visible{outline:2px solid #7dd3fc;outline-offset:1px}
.world-card-names{margin-top:8px;padding:8px 8px 0 0;border-top:1px solid rgba(148,163,184,.18)}
.world-card-names label{display:block;font-size:12px;color:#7dd3fc;margin-bottom:4px}
.world-card-names input{width:100%;box-sizing:border-box;padding:4px 6px;border-radius:6px;font-size:12px;color:#e2e8f0;background:rgba(15,23,42,.8);border:1px solid rgba(148,163,184,.35)}
.world-card-names button{margin:6px 6px 0 0;padding:1px 8px;border-radius:6px;font-size:12px;color:#7dd3fc;background:transparent;border:1px solid rgba(125,211,252,.4);cursor:pointer}
.world-card-names [role=alert]{margin:4px 0 0;font-size:12px;color:#fbbf24}
.world-card-body .edit-names{padding:0 6px;border-radius:6px;font-size:12px;color:#7dd3fc;background:transparent;border:1px solid rgba(125,211,252,.4);cursor:pointer}
.world-card-body .tour-caption{font-size:13px;color:#e2e8f0}
.world-card-tour{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid rgba(148,163,184,.18);font-size:12px;color:#cbd5e1}
.world-card-tour span{margin-right:auto}
.world-card-tour button{padding:1px 8px;border-radius:6px;font-size:12px;color:#7dd3fc;background:transparent;border:1px solid rgba(125,211,252,.4);cursor:pointer}
.world-card-tour button[aria-disabled=true]{color:#94a3b8;border-color:rgba(148,163,184,.3);cursor:default}
`

/**
 * How long a card a map click opened lets clicks through to the map. A double-click's first click opens the
 * card, which can open over the pointer; the second click then has to reach the map, or the building
 * never explodes. 500 ms is the usual system double-click time. A card opened any other way (the tree,
 * an answer, a bookmark) takes clicks at once.
 */
export const CARD_CLICK_GRACE_MS = 500

export function WorldCard({ html, onClose, onOpen, onTech, onConfirm, onEvidence, onRuntimeNames, onNeed, boxRef, maxHeight = null, clickThrough = false, solid = false, quiet = false, tour }: WorldCardProps): JSX.Element {
  const zoom = useUiZoom()
  // Only how the card opened counts: a later card shown in it takes clicks at once.
  const [opening, setOpening] = useState(clickThrough)
  useEffect(() => {
    if (!opening) return
    const t = setTimeout(() => setOpening(false), CARD_CLICK_GRACE_MS)
    return () => clearTimeout(t)
  }, [opening])
  // The service-names editor: the part it edits and what is typed. A new card (another part, or the saved one) closes it.
  const [edit, setEdit] = useState<{ id: string; text: string; was: string; error: boolean } | null>(null)
  useEffect(() => setEdit(null), [html])
  // A chip or link pressed in the body (from the keyboard as well as by a click) opens another card in its place, and
  // the button that had the focus goes with the old card: the body takes the focus, so the next Tab is on the new card,
  // not back at the top of the page (A11Y Y3).
  // The card a press opens comes in the same event (the viewer renders it as it runs), so a press that changed nothing
  // is forgotten by the next frame: a later card, from the map or an answer, leaves a focus on the page where it is.
  const pressedRef = useRef(false)
  const pressFrame = useRef(0)
  const pressed = (): void => {
    pressedRef.current = true
    cancelAnimationFrame(pressFrame.current)
    pressFrame.current = requestAnimationFrame(() => { pressedRef.current = false })
  }
  useEffect(() => () => cancelAnimationFrame(pressFrame.current), [])
  useLayoutEffect(() => {
    if (pressedRef.current && document.activeElement === document.body) bodyRef.current?.focus()
    pressedRef.current = false
  }, [html])
  // A capped card's scrollbar takes the body's right edge, where the close button sits: the button moves left by the
  // scrollbar's measured width (0 with an overlay scrollbar or none), so it is never drawn over the scrollbar.
  const bodyRef = useRef<HTMLDivElement>(null)
  // The latest onNeed, so a parent's new callback does not set the card's watchers up again.
  const needRef = useRef(onNeed)
  needRef.current = onNeed
  const [gutter, setGutter] = useState(0)
  // Whether more lies below what the body shows: its bottom edge then fades (CARD_FADE_PX), never the scrollbar.
  const [more, setMore] = useState(false)
  const readMore = (): void => {
    const body = bodyRef.current as HTMLDivElement
    setMore(body.scrollHeight - body.scrollTop - body.clientHeight > 1)
  }
  useLayoutEffect(() => {
    const body = bodyRef.current as HTMLDivElement
    const measure = (): void => {
      setGutter(body.offsetWidth - body.clientWidth)
      readMore()
      needRef.current?.(readableNeed(body))
    }
    measure()
    // Bare text at the body's top is no element, so no observer below sees a late font make it taller: the card
    // measures again when the page's fonts finish loading (HOLD-B #106, landing m2).
    const fonts = document.fonts as FontFaceSet | undefined
    fonts?.addEventListener('loadingdone', measure)
    const stop = (): void => fonts?.removeEventListener('loadingdone', measure)
    // The scrollbar comes and goes as the card meets its cap; its width is taken from the body's content box.
    if (typeof ResizeObserver !== 'function') return stop
    const watch = new ResizeObserver(measure)
    watch.observe(body)
    // A capped body keeps its size when its content grows or shrinks (a late font, an icon): the content is watched too,
    // so the fade follows what lies below.
    for (const part of Array.from(body.children)) watch.observe(part)
    return () => { watch.disconnect(); stop() }
  }, [html])
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
    if (chip) { e.preventDefault(); pressed(); onTech(chip.getAttribute('data-tech') as string); return }
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
    pressed()
    onOpen(link.getAttribute('data-node') ?? (link.getAttribute('data-edge') as string))
  }
  return (
    <aside
      ref={boxRef}
      aria-label="Lumopolis details"
      data-testid="world-card"
      className="world-card"
      data-solid={solid ? '' : undefined}
      // Top left over the map, where the prototype's inspector sits (the legend is top right).
      style={{ position: 'absolute', top: CARD_INSET_PX, left: CARD_INSET_PX, width: CARD_WIDTH_PX, maxWidth: `calc(100% - ${CARD_INSET_PX * 2}px)`, maxHeight: maxHeight === null ? 'calc(100% - 110px)' : `min(${maxHeight}px, calc(100% - 110px))`, boxSizing: 'border-box', zIndex: 3, ...zoom, ...(opening ? { pointerEvents: 'none' as const } : {}), ...(gutter > 0 ? { '--world-card-gutter': `${gutter}px` } : {}) } as CSSProperties}
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
        ref={bodyRef}
        className="world-card-body"
        data-testid="world-card-body"
        role="region"
        aria-label="Details"
        // A screen reader reads a card when it opens or another part's replaces it, wherever the focus is (the 2D map's
        // list, the Ask box): polite, so it waits for what is being read to finish. A tour stop is said by the pane (T5).
        aria-live={quiet ? 'off' : 'polite'}
        tabIndex={0}
        onClick={onClick}
        onScroll={readMore}
        {...(more ? { 'data-more': '' } : {})}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {tour && (
        // Back and Next at either end say they can go no further (aria-disabled) but are never disabled: the focus
        // stays on the button pressed. SIGNED OFF 2026-11-27 (signoff-decisions.md) (A11Y Y2): "Stop {n} of {m}", "Back", "Next", "End tour",
        // "Tour: {title}".
        <nav className="world-card-tour" aria-label={tour.title !== undefined ? `Tour: ${tour.title}` : 'Tour'} data-testid="world-card-tour">
          <span>Stop {tour.n} of {tour.of}</span>
          <button type="button" aria-disabled={tour.n === 1 ? 'true' : undefined} onClick={() => { if (tour.n > 1) tour.onBack() }}>Back</button>
          <button type="button" aria-disabled={tour.n === tour.of ? 'true' : undefined} onClick={() => { if (tour.n < tour.of) tour.onNext() }}>Next</button>
          <button type="button" onClick={tour.onEnd}>End tour</button>
        </nav>
      )}
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
