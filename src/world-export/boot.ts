// The runtime an exported Lumopolis page runs: one classic script (dist-world/world-export.js, inlined after the
// page's data blocks). It reads the blocks, mounts the viewer read-only (or the 2D map without WebGL), wires the
// controls and the Ask box, and starts smart Ask after the first paint when the page carries the model.
// The page makes no request of any kind: everything it shows is in the file (the CSP also forbids it).
import { askEntries, buildBm25, type AskEntry, type PackedVectors } from '../shared/world/askIndex'
import { createWorldViewer, hasWebGL, validateWorld } from '../renderer/src/world/engine'
import { mountAskBox, type AskState } from './askBox'
import { readBlock, readJsonBlock } from './blocks'
import { buildPage, type PageMeta } from './controls'
import { startSmartAsk, type SmartAsk } from './smartAsk'

/** The `ask` block: the entries the export indexed and, on a smart page, how its `askvec` rows are packed. */
interface AskBlock { version: number; entries: AskEntry[]; dim: number; scales: number[] }

/** What the page's own tests read (window.__worldExport): set as soon as the script runs, and read-only. */
export interface WorldExportHandle { ready: Promise<AskState>; state(): AskState }
declare global {
  interface Window { __worldExport: WorldExportHandle }
}

export const BROKEN_PAGE = "This Lumopolis page's data is missing or damaged, so the world can't be shown."

/** Resolves after the next frame has painted: rAF runs before the paint, the timeout after it. */
const afterPaint = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))

const domReady = (): Promise<void> => new Promise((resolve) => {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => resolve(), { once: true })
  else resolve()
})

/** The Ask box's state, set once the box exists. */
let current: () => AskState = () => 'loading'

async function boot(): Promise<AskState> {
  await domReady()
  try {
    const raw = await readJsonBlock<unknown>('world')
    const meta = await readJsonBlock<PageMeta>('meta')
    const checked = validateWorld(raw)
    if (!checked.ok || meta === null) throw new Error('world or meta block')
    const doc = checked.doc
    const ask = await readJsonBlock<AskBlock>('ask')
    const askvec = await readBlock('askvec')

    const page = buildPage(document.body, doc, meta)
    const viewer = hasWebGL() ? createWorldViewer(page.viewHost, { title: meta.project, readOnly: true, renderCard: (html) => page.showCard(html) }) : null
    viewer?.load(doc)
    page.attach(viewer)

    // The ask block is the export's index; a page without one still searches, from the world itself.
    const entries = ask ? ask.entries : askEntries(doc)
    const vectors: PackedVectors | null = ask && askvec
      ? { dim: ask.dim, scales: ask.scales, data: new Int8Array(askvec.buffer, askvec.byteOffset, askvec.byteLength) }
      : null
    // Smart Ask only on a page that carries the model (and the vectors it ranks), and only after the city has painted.
    const smart: Promise<SmartAsk> | null = vectors && document.getElementById('model')
      ? afterPaint().then(() => startSmartAsk(readBlock))
      : null
    const box = mountAskBox(page.askHost, { entries, bm25: buildBm25(entries.map((e) => e.text)), vectors, smart, onPick: page.pick })
    current = box.state
    return await box.ready
  } catch {
    const p = document.createElement('p')
    p.className = 'wx-broken'
    p.textContent = BROKEN_PAGE
    document.body.appendChild(p)
    current = () => 'failed'
    return 'failed'
  }
}

const handle: WorldExportHandle = Object.freeze({ ready: boot(), state: () => current() })
Object.defineProperty(window, '__worldExport', { value: handle, writable: false, enumerable: false, configurable: true })
