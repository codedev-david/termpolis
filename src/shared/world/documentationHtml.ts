// The Lumopolis documentation as one standalone HTML file: documentation.ts's model rendered with inline CSS (light by
// default, dark under prefers-color-scheme, clean in print), a sticky contents column and an SVG map of the areas. It
// has no script and links out only to termpolis.com. Every interpolated text node and attribute value goes through
// escapeHtml, because names come from code and may hold markup. Pure, ES2020 and deterministic.
import { PROPOSED_MEANS, STATES_MEAN, type DocBlock, type DocModel, type DocSection } from './documentation'
import { escapeHtml as esc } from './html'
import { placeOnMap } from './mapPlacement'
import type { WorldDoc } from './types'

type Pt = [number, number]
interface Box { x: number; y: number; w: number; h: number }

/** Map geometry, in SVG user units. A box holds at most BOX_CAP slots; past it the last slot says "and N more". */
const CELL_H = 28
const CELL_GAP = 8
const PAD = 14
const HEAD_H = 52
const BOX_MIN_W = 250
const CELL_W = 150
const BOX_CAP = 12
const GAP_X = 120
const GAP_Y = 110
/**
 * How far a line bows from the straight path, as a share of its length: to the left of its travel first (so the two
 * directions between a pair bow apart), then to the right. The first that clears every other box and every count
 * already placed wins; failing that, the one that clips the least.
 */
const BOWS = [0.12, 0.3, 0.5, 0.7, -0.12, -0.3, -0.5, -0.7]
/** The map's smallest label size. The map is never drawn under its natural width (min-width), so no label shows under
 *  12px: past that a narrow page scrolls the map in its frame. ROOT_PX is the page's 1rem at scale 1: the map's width
 *  in rem grows with the page. */
const LABEL_PX = 12
const LABEL_MIN_PX = 12
const ROOT_PX = 16
/** Rough glyph widths, to cut a label to its box. */
const PART_GLYPH = 6.6
const AREA_GLYPH = 8.6

const n1 = (n: number): string => String(Math.round(n * 10) / 10)
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
/** A label cut to `max` characters (by code point, so an emoji is never split) with an ellipsis. */
function clip(text: string, max: number): string {
  const cps = Array.from(text)
  return cps.length > max ? `${cps.slice(0, max - 1).join('').trimEnd()}…` : text
}
const centre = (b: Box): Pt => [b.x + b.w / 2, b.y + b.h / 2]
const bezier = (a: Pt, c: Pt, b: Pt, t: number): Pt => {
  const u = 1 - t
  return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]
}
const SAMPLES = Array.from({ length: 19 }, (_, i) => (i + 1) / 20)
const inside = (p: Pt, b: Box, pad: number): boolean =>
  p[0] > b.x - pad && p[0] < b.x + b.w + pad && p[1] > b.y - pad && p[1] < b.y + b.h + pad
/** Where the ray from a box's centre toward `to` leaves the box, `gap` units out. */
function border(b: Box, to: Pt, gap: number): Pt {
  const c = centre(b)
  const dx = to[0] - c[0]
  const dy = to[1] - c[1]
  const s = Math.min((b.w / 2 + gap) / Math.abs(dx), (b.h / 2 + gap) / Math.abs(dy))
  return [c[0] + dx * s, c[1] + dy * s]
}

/** The districts' grid cells, keeping the city's arrangement as the 2D map places it (mapPlacement.ts): rows from the
 *  back of the city (z) to the front, each row from left to right (x), ties in the world's order. Boxes never overlap,
 *  whatever the layout. */
function cells(doc: WorldDoc): { col: number; row: number }[] {
  const at = placeOnMap(doc).districts
  const n = at.length
  const cols = n <= 3 ? n : Math.min(3, Math.ceil(Math.sqrt(n)))
  const order = at.map((_, i) => i).sort((a, b) => at[a][1] - at[b][1] || at[a][0] - at[b][0] || a - b)
  const out: { col: number; row: number }[] = []
  for (let r = 0; r * cols < n; r++) {
    order.slice(r * cols, r * cols + cols).sort((a, b) => at[a][0] - at[b][0] || a - b).forEach((i, col) => { out[i] = { col, row: r } })
  }
  return out
}

/** A drawn line: its ends on the box borders, its control point, and the midpoint that carries its count. */
interface Route { p0: Pt; c: Pt; p1: Pt; m: Pt }
/** A line from box `a` to box `b` as a quadratic curve, bowed by the first of BOWS that clears `others` and keeps its
 *  count off the counts already `placed`; failing that, the bow that clips the least. */
function route(a: Box, b: Box, others: Box[], placed: Route[]): Route {
  const A = centre(a)
  const B = centre(b)
  const len = Math.hypot(B[0] - A[0], B[1] - A[1])
  const nx = -(B[1] - A[1]) / len
  const ny = (B[0] - A[0]) / len
  let best = { cost: Infinity } as Route & { cost: number }
  for (const k of BOWS) {
    const c: Pt = [(A[0] + B[0]) / 2 + nx * k * len, (A[1] + B[1]) / 2 + ny * k * len]
    const p0 = border(a, c, 2)
    const p1 = border(b, c, 7)
    const m = bezier(p0, c, p1, 0.5)
    const clipped = SAMPLES.reduce((sum, t) => sum + others.filter((o) => inside(bezier(p0, c, p1, t), o, 12)).length, 0)
    const crowded = placed.filter((q) => Math.abs(q.m[0] - m[0]) < 44 && Math.abs(q.m[1] - m[1]) < 24).length
    const cost = clipped + crowded * 100
    if (cost < best.cost) best = { p0, c, p1, m, cost }
    if (cost === 0) break
  }
  return best
}

const MAP_STYLE = [
  '.lm-map{display:block;margin:0 auto;max-width:100%;height:auto;font-family:inherit}',
  '.lm-box{fill:var(--map-box,#f3f5f9);stroke:var(--map-box-line,#cbd3e0)}',
  '.lm-area-name{fill:var(--map-text,#1b2230);font-size:15px;font-weight:650}',
  '.lm-area-meta{fill:var(--map-muted,#566073);font-size:12px}',
  '.lm-part{fill:var(--map-part,#ffffff);stroke:var(--map-part-line,#b7c2d4)}',
  '.lm-part-label{fill:var(--map-text,#1b2230);font-size:12.5px}',
  '.lm-more{fill:none;stroke:var(--map-part-line,#b7c2d4);stroke-dasharray:4 3}',
  '.lm-more-label,.lm-empty{fill:var(--map-muted,#566073);font-size:12px;font-style:italic}',
  '.lm-line{fill:none;stroke:var(--map-line,#4d63cf);stroke-opacity:.8}',
  '.lm-arrowhead{fill:var(--map-line,#4d63cf)}',
  '.lm-count rect{fill:var(--map-count-bg,#ffffff);stroke:var(--map-line,#4d63cf)}',
  '.lm-count text{fill:var(--map-line-text,#2c41a8);font-size:12px;font-weight:650}'
].join('')

/**
 * The map of the city at a glance: each district a box (laid out from the layout by the 2D map's placement rule) with
 * its parts inside, and the lines between districts aggregated into one curve per direction, each with its count and
 * an arrow. Lines inside a district are counted in its box; lines to outside systems are left to the Outside systems
 * table. Ids never reach an SVG `id` or `url(#…)`: the one reference is the fixed arrow marker. No xmlns: the map is
 * inline in the page, and the page names no address but termpolis.com. On its own it carries its stylesheet; the
 * documentation page passes `ownStyle` false and holds the map's rules in its one stylesheet instead.
 */
export function docMapSvg(doc: WorldDoc, ownStyle = true): string {
  const open = (w: number, h: number, minX: number, minY: number, label: string): string =>
    `<svg class="lm-map" viewBox="${n1(minX)} ${n1(minY)} ${n1(w)} ${n1(h)}" width="${n1(w)}" height="${n1(h)}" role="img" aria-label="${esc(label)}"`
    + ` style="width: ${n1(Number(n1(w)) / ROOT_PX)}rem; min-width: ${Math.ceil((Number(n1(w)) * LABEL_MIN_PX) / LABEL_PX)}px">${ownStyle ? `<style>${MAP_STYLE}</style>` : ''}`
  if (doc.districts.length === 0) {
    return `${open(320, 80, 0, 0, 'Map of the areas')}<text class="lm-empty" x="160" y="44" text-anchor="middle">No areas yet</text></svg>`
  }
  const groups = doc.districts.map((d) => doc.buildings.filter((b) => b.districtId === d.id))
  const most = Math.max(1, ...groups.map((g) => Math.min(g.length, BOX_CAP)))
  const inner = Math.min(2, most)
  const rows = Math.ceil(most / inner)
  const w = Math.max(BOX_MIN_W, PAD * 2 + inner * CELL_W + (inner - 1) * CELL_GAP)
  const h = HEAD_H + rows * (CELL_H + CELL_GAP) - CELL_GAP + PAD
  const cellW = (w - PAD * 2 - (inner - 1) * CELL_GAP) / inner
  const boxes: Box[] = cells(doc).map(({ col, row }) => ({ x: col * (w + GAP_X), y: row * (h + GAP_Y), w, h }))

  const home = new Map<string, number>()
  groups.forEach((g, i) => g.forEach((b) => home.set(b.id, i)))
  const within = doc.districts.map(() => 0)
  const pairs = new Map<string, { from: number; to: number; n: number }>()
  for (const e of doc.edges) {
    const a = home.get(e.from)
    const b = home.get(e.to)
    if (a === undefined || b === undefined) continue
    if (a === b) {
      within[a]++
      continue
    }
    const pair = pairs.get(`${a}>${b}`)
    if (pair) pair.n++
    else pairs.set(`${a}>${b}`, { from: a, to: b, n: 1 })
  }

  const extent: Pt[] = boxes.flatMap((b) => [[b.x, b.y], [b.x + b.w, b.y + b.h]] as Pt[])
  const lines: string[] = []
  const counts: string[] = []
  const placed: Route[] = []
  for (const { from, to, n } of Array.from(pairs.values())) {
    const r = route(boxes[from], boxes[to], boxes.filter((_, i) => i !== from && i !== to), placed)
    placed.push(r)
    const { p0, c, p1, m } = r
    const lw = 14 + String(n).length * 7.5
    const words = `${plural(n, 'connection', 'connections')} from ${doc.districts[from].name} to ${doc.districts[to].name}`
    extent.push(...SAMPLES.map((t) => bezier(p0, c, p1, t)), [m[0] - lw / 2, m[1] - 10], [m[0] + lw / 2, m[1] + 10])
    lines.push(`<path class="lm-line" d="M${n1(p0[0])} ${n1(p0[1])} Q${n1(c[0])} ${n1(c[1])} ${n1(p1[0])} ${n1(p1[1])}" stroke-width="${n1(1.5 + Math.min(2.5, Math.log2(n)) * 0.8)}" marker-end="url(#lm-arrow)"/>`)
    counts.push(`<g class="lm-count"><title>${esc(words)}</title><rect x="${n1(m[0] - lw / 2)}" y="${n1(m[1] - 10)}" width="${n1(lw)}" height="20" rx="10"/>`
      + `<text x="${n1(m[0])}" y="${n1(m[1])}" text-anchor="middle" dominant-baseline="central">${n}</text></g>`)
  }

  const partMax = Math.floor((cellW - 20) / PART_GLYPH)
  const areaMax = Math.floor((w - PAD * 2) / AREA_GLYPH)
  const areas = doc.districts.map((d, i) => {
    const { x, y } = boxes[i]
    const g = groups[i]
    const slots = g.length > BOX_CAP ? [...g.slice(0, BOX_CAP - 1).map((b) => b.name), null] : g.map((b) => b.name)
    const cell = (k: number): Pt => [x + PAD + (k % inner) * (cellW + CELL_GAP), y + HEAD_H + Math.floor(k / inner) * (CELL_H + CELL_GAP)]
    const parts = slots.map((name, k) => {
      const [cx, cy] = cell(k)
      const rect = `x="${n1(cx)}" y="${n1(cy)}" width="${n1(cellW)}" height="${CELL_H}" rx="6"`
      const at = `x="${n1(cx + 10)}" y="${n1(cy + CELL_H / 2)}" dominant-baseline="central"`
      return name === null
        ? `<rect class="lm-more" ${rect}/><text class="lm-more-label" ${at}>and ${g.length - BOX_CAP + 1} more</text>`
        : `<rect class="lm-part" ${rect}><title>${esc(name)}</title></rect><text class="lm-part-label" ${at}>${esc(clip(name, partMax))}</text>`
    }).join('')
    const [ex, ey] = cell(0)
    const empty = g.length ? '' : `<text class="lm-empty" x="${n1(ex)}" y="${n1(ey + CELL_H / 2)}" dominant-baseline="central">No parts yet</text>`
    const meta = `${plural(g.length, 'part', 'parts')}${within[i] ? ` · ${plural(within[i], 'connection', 'connections')} inside` : ''}`
    return `<g data-id="${esc(d.id)}" class="lm-area"><title>${esc(d.subtitle ? `${d.name}: ${d.subtitle}` : d.name)}</title>`
      + `<rect class="lm-box" x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(h)}" rx="12"/>`
      + `<text class="lm-area-name" x="${n1(x + PAD)}" y="${n1(y + 24)}">${esc(clip(d.name, areaMax))}</text>`
      + `<text class="lm-area-meta" x="${n1(x + PAD)}" y="${n1(y + 41)}">${esc(meta)}</text>${parts}${empty}</g>`
  }).join('')

  const minX = Math.min(...extent.map((p) => p[0])) - 12
  const minY = Math.min(...extent.map((p) => p[1])) - 12
  const maxX = Math.max(...extent.map((p) => p[0])) + 12
  const maxY = Math.max(...extent.map((p) => p[1])) + 12
  const label = `Map of ${plural(doc.districts.length, 'area', 'areas')} and the connections between them`
  return `${open(maxX - minX, maxY - minY, minX, minY, label)}<defs><marker id="lm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto">`
    + `<path class="lm-arrowhead" d="M0 1L10 5L0 9z"/></marker></defs>${lines.join('')}${areas}${counts.join('')}</svg>`
}

/** The colours of the light scheme: the default, and what print always uses. */
const LIGHT = [
  '--bg: #f7f8fa; --surface: #ffffff; --text: #1b2230; --muted: #566073; --line: #e1e5ec; --strong-line: #c9d0dc;',
  '--accent: #3550c8; --accent-soft: #eef1fd; --code: #eef1f6; --head: #f3f5f8;',
  '--b-inferred: #8a5300; --b-inferred-bg: #fff1d4; --b-verified: #17663a; --b-verified-bg: #ddf4e6;',
  '--b-observed: #1c4d9e; --b-observed-bg: #e2ecff; --b-proposed: #6430b5; --b-proposed-bg: #efe7ff;',
  '--map-box: #f3f5f9; --map-box-line: #cbd3e0; --map-part: #ffffff; --map-part-line: #b7c2d4; --map-text: #1b2230;',
  '--map-muted: #566073; --map-line: #4d63cf; --map-line-text: #2c41a8; --map-count-bg: #ffffff;',
  '--map-scroll-shadow: rgba(16, 24, 40, .2);'
].join(' ')
const DARK = [
  '--bg: #0f131a; --surface: #161b24; --text: #e6e9ef; --muted: #9ba5b6; --line: #262d3a; --strong-line: #3a4457;',
  '--accent: #93a5ff; --accent-soft: #1d2440; --code: #1f2633; --head: #1a202b;',
  '--b-inferred: #f5c26b; --b-inferred-bg: #3a2a0c; --b-verified: #7fdca3; --b-verified-bg: #10301f;',
  '--b-observed: #8fb8ff; --b-observed-bg: #132542; --b-proposed: #c9a9ff; --b-proposed-bg: #2a1a48;',
  '--map-box: #1a202b; --map-box-line: #36415a; --map-part: #232b39; --map-part-line: #44516b; --map-text: #e6e9ef;',
  '--map-muted: #9ba5b6; --map-line: #8fa2ff; --map-line-text: #c3cdff; --map-count-bg: #161b24;',
  '--map-scroll-shadow: rgba(0, 0, 0, .6);'
].join(' ')

const CSS = [
  `:root{color-scheme: light dark; ${LIGHT}}`,
  `@media (prefers-color-scheme: dark){:root{${DARK}}}`,
  '*{box-sizing: border-box}',
  // 16px up to a 1920x1080 window, then half the window's growth past it (the smaller of across and down), at most twice:
  // uiScale's rule, so a 4K screen reads like a laptop. Every length below is in rem and grows with it.
  'html{-webkit-text-size-adjust: 100%; font-size: clamp(16px, calc(8px + min(.41667vw, .74074vh)), 32px)}',
  'body{margin: 0; background: var(--bg); color: var(--text); font: 1rem/1.6 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; overflow-wrap: break-word}',
  'a{color: var(--accent)}',
  // 104rem: from a 1080p screen up the column holds a map of about 80rem (the fixture city's) whole, with its frame.
  '.page{max-width: 104rem; margin: 0 auto; padding: 3rem 1.5rem 4rem; display: grid; grid-template-columns: minmax(0, 1fr); column-gap: 3rem}',
  '.title-block{padding-bottom: 1.75rem; border-bottom: 1px solid var(--line)}',
  '.eyebrow{margin: 0 0 .5rem; font-size: .75rem; font-weight: 650; letter-spacing: .09em; text-transform: uppercase; color: var(--accent)}',
  'h1{margin: 0 0 .875rem; font-size: 2.3rem; line-height: 1.15; letter-spacing: -.02em}',
  '.title-block p{display: inline-block; margin: 0; color: var(--muted); font-size: .92rem}',
  // The eyebrow is a block of its own: inline-block, its line would take the parent's line height and run into the title.
  '.title-block .eyebrow{display: block; margin: 0 0 .5rem; color: var(--accent); font-size: .75rem}',
  '.title-block p+p::before{content: "\\00b7"; margin: 0 .6em; color: var(--strong-line)}',
  '.toc{padding: 1.75rem 0 .5rem; font-size: .9rem}',
  '.toc-title{margin: 0 0 .5rem .5rem; font-size: .75rem; font-weight: 650; letter-spacing: .09em; text-transform: uppercase; color: var(--muted)}',
  '.toc ol{list-style: none; margin: 0; padding: 0}',
  '.toc ol ol{margin: .125rem 0 .375rem .875rem; padding-left: .5rem; border-left: 1px solid var(--line)}',
  '.toc a{display: block; padding: .1875rem .5rem; border-radius: .375rem; color: var(--text); text-decoration: none; line-height: 1.35}',
  '.toc ol ol a{color: var(--muted); font-size: .85rem}',
  '.toc a:hover{background: var(--accent-soft); color: var(--accent)}',
  'main{min-width: 0}',
  '@media (min-width: 1000px){.page{grid-template-columns: 13.75rem minmax(0, 1fr)} .title-block{grid-column: 1 / -1} .colophon{grid-column: 2}'
    + ' .toc{position: sticky; top: 0; align-self: start; max-height: 100vh; overflow-y: auto}}',
  'h2{margin: 3rem 0 1rem; padding-top: 1.75rem; border-top: 1px solid var(--line); font-size: 1.55rem; line-height: 1.25; letter-spacing: -.01em}',
  'main > .chapter:first-child h2{margin-top: .75rem; border-top: 0}',
  'h3{margin: 2rem 0 .75rem; font-size: 1.22rem; line-height: 1.3}',
  '.area > h3{padding-left: .75rem; border-left: .25rem solid var(--accent)}',
  '.area > p{color: var(--muted)}',
  '.part{margin: 1rem 0; padding: 1.125rem 1.375rem .5rem; background: var(--surface); border: 1px solid var(--line); border-radius: .75rem; box-shadow: 0 1px 2px rgba(16, 24, 40, .05)}',
  'h4{margin: 0 0 .375rem; font-size: 1.08rem; line-height: 1.35}',
  '.part > p{margin: 0 0 2px; color: var(--muted); font-size: .9rem}',
  '.field{margin-top: 1rem}',
  'h5{margin: 0 0 .25rem; font-size: .75rem; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; color: var(--muted)}',
  'p{margin: 0 0 .75rem}',
  'ul, ol{margin: 0 0 .875rem; padding-left: 1.3em}',
  'li{margin: .1875rem 0}',
  // Long reading keeps to about 75 characters a line, however wide the page; tables and the map use the whole column.
  'p, li, figcaption{max-width: 66ch}',
  '.claims{list-style: none; padding: 0}',
  '.claims li{margin: .375rem 0}',
  '.badge{display: inline-block; margin-right: .25rem; padding: 0 .5rem; border-radius: 999px; font-size: .75rem; font-weight: 650; line-height: 1.7; letter-spacing: .04em; text-transform: uppercase; vertical-align: .12em}',
  '.badge-inferred{color: var(--b-inferred); background: var(--b-inferred-bg)}',
  '.badge-verified{color: var(--b-verified); background: var(--b-verified-bg)}',
  '.badge-observed{color: var(--b-observed); background: var(--b-observed-bg)}',
  '.badge-proposed{color: var(--b-proposed); background: var(--b-proposed-bg)}',
  '.refs{display: block; margin-top: .1875rem}',
  '.refs:empty{display: none}',
  'code{font: .8em/1.5 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; padding: .0625rem .375rem; border-radius: .3125rem; background: var(--code); color: var(--muted)}',
  '.refs code + code{margin-left: .375rem}',
  '.steps{padding-left: 1.6em}',
  '.steps li{padding-left: .25rem}',
  '.table-wrap{overflow-x: auto; margin: 0 0 1rem; border: 1px solid var(--line); border-radius: .625rem; background: var(--surface)}',
  'table{width: 100%; border-collapse: collapse; font-size: .86rem; line-height: 1.45}',
  'th, td{padding: .5625rem .75rem; text-align: left; vertical-align: top; border-bottom: 1px solid var(--line)}',
  'th{font-size: .75rem; font-weight: 650; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); background: var(--head); white-space: nowrap}',
  'td{min-width: 7.5em}',
  'tbody tr:last-child td{border-bottom: 0}',
  '.empty{color: var(--muted); font-style: italic}',
  'figure{margin: 0 0 1.25rem}',
  // A wide map scrolls sideways, and an edge shows a shadow only while more of the map is hidden past it: two covers in
  // the surface colour scroll with the map (local) over two shadows fixed to the frame (scroll), and at an end of the
  // map its cover sits on that edge's shadow. A map that fits covers both. No script.
  '.map{padding: 1.125rem; overflow-x: auto; border: 1px solid var(--line); border-radius: .75rem; background-color: var(--surface);'
    + ' background-image: linear-gradient(to right, var(--surface) 50%, transparent), linear-gradient(to left, var(--surface) 50%, transparent),'
    + ' linear-gradient(to right, var(--map-scroll-shadow), transparent), linear-gradient(to left, var(--map-scroll-shadow), transparent);'
    + ' background-position: left center, right center, left center, right center;'
    + ' background-size: 48px 100%, 48px 100%, 16px 100%, 16px 100%; background-repeat: no-repeat;'
    + ' background-attachment: local, local, scroll, scroll}',
  MAP_STYLE,
  '.picture img{display: block; max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: .75rem}',
  'figcaption{margin-top: .625rem; color: var(--muted); font-size: .85rem; text-align: left}',
  '.colophon{margin-top: 3.5rem; padding-top: 1.25rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .85rem}',
  '@page{margin: 16mm 14mm}',
  `@media print{:root{${LIGHT}}`
    + ' html{font-size: 16px}'
    + ' body{background: #ffffff; font-size: 10.5pt}'
    + ' .page{display: block; max-width: none; padding: 0}'
    + ' .toc{position: static; break-after: page}'
    + ' .area{break-before: page}'
    + ' #areas{break-before: page}'
    + ' #areas > .area:first-of-type{break-before: auto}'
    + ' .field, figure, tr{break-inside: avoid}'
    + ' h2, h3, h4, h5, .area > p{break-after: avoid}'
    + ' table{font-size: 8.5pt}'
    + ' th, td{padding: 6px 8px}'
    + ' td{min-width: 0}'
    + ' .part{box-shadow: none}'
    + ' .table-wrap, .map{overflow: visible}'
    + ' .lm-map{min-width: 0 !important}'
    + ' p, li, figcaption{max-width: none}'
    + ' thead{display: table-header-group}'
    + ' a{color: inherit; text-decoration: none}'
    + ' *{-webkit-print-color-adjust: exact; print-color-adjust: exact}}'
].join('\n')

/** The only picture the page takes: a PNG data URL, the one value that becomes an attribute URL. */
const PNG_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/
/** The two sentences whose *word* marks are emphasis; no other text is read as markup. */
const EMPHASISED = new Set([STATES_MEAN, PROPOSED_MEANS])

type Kind = 'chapter' | 'area' | 'part' | 'field' | 'sub'
const NEXT: Record<Kind, Kind> = { chapter: 'sub', area: 'part', part: 'field', field: 'field', sub: 'sub' }

/**
 * The documentation page. `doc` is the (sanitised) world the model was built from, for the map; `picturePng` is the 3D
 * view's capture as a `data:image/png;base64,` URL, shown only where the model asks for the picture, and dropped if it
 * is anything else.
 */
export function renderDocumentation(model: DocModel, doc: WorldDoc, picturePng?: string): string {
  const png = PNG_URL.test(picturePng ?? '') ? picturePng : ''
  const ids = new Map<DocSection, string>()
  let next = 0
  const assign = (s: DocSection, top: boolean): void => {
    ids.set(s, top ? s.id : `s${++next}`)
    for (const c of s.children ?? []) assign(c, false)
  }
  for (const s of model.sections) assign(s, true)
  const href = (s: DocSection): string => `#${esc(ids.get(s))}`

  const block = (b: DocBlock): string => {
    switch (b.kind) {
      case 'p': return `<p>${EMPHASISED.has(b.text) ? esc(b.text).replace(/\*([a-z]+)\*/g, '<em>$1</em>') : esc(b.text)}</p>`
      case 'claims': return `<ul class="claims">${b.items.map((c) => `<li><span class="badge badge-${esc(c.state)}">${esc(c.state)}</span> `
        + `<span class="claim">${esc(c.text)}</span><span class="refs">${c.refs.map((r) => `<code>${esc(r)}</code>`).join('')}</span></li>`).join('')}</ul>`
      case 'list': {
        // A tour's steps arrive numbered "1. …"; they become an ordered list rather than bullets with numbers.
        if (b.items.every((t, i) => t.startsWith(`${i + 1}. `))) {
          return `<ol class="steps">${b.items.map((t, i) => `<li>${esc(t.slice(String(i + 1).length + 2))}</li>`).join('')}</ol>`
        }
        return `<ul>${b.items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`
      }
      case 'table': {
        if (b.rows.length === 0) return '<p class="empty">Nothing recorded yet.</p>'
        const head = b.head.map((t) => `<th>${esc(t)}</th>`).join('')
        const rows = b.rows.map((r) => `<tr>${r.map((t) => `<td>${esc(t)}</td>`).join('')}</tr>`).join('')
        return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`
      }
      case 'map': return `<figure class="map">${docMapSvg(doc, false)}<figcaption>Each box is an area with its parts inside. `
        + 'An arrow between two areas counts the connections running that way.</figcaption></figure>'
      case 'picture': return png ? `<figure class="picture"><img src="${esc(png)}" alt="The city as the 3D view showed it">`
        + '<figcaption>The city in Lumopolis when this document was generated.</figcaption></figure>' : ''
    }
  }
  const section = (s: DocSection, depth: number, kind: Kind): string => {
    const level = Math.min(6, depth + 2)
    const childKind = kind === 'chapter' && s.id === 'areas' ? 'area' : NEXT[kind]
    const children = (s.children ?? []).map((c) => section(c, depth + 1, childKind)).join('')
    return `<section class="${kind}" id="${esc(ids.get(s))}"><h${level}>${esc(s.title)}</h${level}>${s.blocks.map(block).join('')}${children}</section>`
  }

  const body = model.sections.filter((s) => s.id !== 'title')
  const head = model.sections.filter((s) => s.id === 'title').flatMap((s) => s.blocks).map(block).join('')
  const nav = body.map((s) => {
    const sub = s.id === 'areas' && s.children ? `<ol>${s.children.map((a) => `<li><a href="${href(a)}">${esc(a.title)}</a></li>`).join('')}</ol>` : ''
    return `<li><a href="${href(s)}">${esc(s.title)}</a>${sub}</li>`
  }).join('')
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
    `<title>${esc(model.title)}</title>`,
    `<style>\n${CSS}\n</style>`,
    '</head>',
    '<body>',
    '<div class="page">',
    `<header class="title-block"><p class="eyebrow">Lumopolis documentation</p><h1>${esc(model.title)}</h1>${head}</header>`,
    `<nav class="toc" aria-label="Contents"><p class="toc-title">Contents</p><ol>${nav}</ol></nav>`,
    `<main>${body.map((s) => section(s, 0, 'chapter')).join('\n')}</main>`,
    '<footer class="colophon"><p>Made with Lumopolis in Termpolis · <a href="https://termpolis.com">termpolis.com</a></p></footer>',
    '</div>',
    '</body>',
    '</html>',
    ''
  ].join('\n')
}
