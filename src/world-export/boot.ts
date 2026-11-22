// The runtime an exported Lumopolis page runs: one classic script (dist-world/world-export.js, inlined after the
// page's data blocks). It reads the blocks, mounts the viewer read-only (or the 2D map without WebGL), wires the
// controls and the Ask box, and starts smart Ask after the first paint when the page carries the model.
// The page makes no request of any kind: everything it shows is in the file (the CSP also forbids it).
import type { WorldDoc } from '../shared/world/types'
import { buildBm25 } from '../shared/world/askIndex'
import { createWorldViewer, hasWebGL, validateWorld, type WorldViewer } from '../renderer/src/world/engine'
import { mountAskBox, type AskState } from './askBox'
import { readAskIndex, readBlock, readJsonBlock } from './blocks'
import { isMeta, type PageMeta } from '../shared/world/exportMeta'
import { buildPage, type Page } from './controls'
import { startSmartAsk, type SmartAsk } from './smartAsk'

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

/**
 * The 3D city, read-only, or null for the 2D map: without WebGL, and also when the viewer cannot be created or
 * cannot take the world (a renderer the probe did not catch, a lost context). The page then works as it does
 * without WebGL, Ask included.
 */
function mountViewer(page: Page, doc: WorldDoc, meta: PageMeta): WorldViewer | null {
  let viewer: WorldViewer | null = null
  if (hasWebGL()) {
    try {
      viewer = createWorldViewer(page.viewHost, { title: meta.project, readOnly: true, renderCard: (html) => page.showCard(html) })
      viewer.load(doc)
      page.attach(viewer)
      return viewer
    } catch {
      disposeQuietly(viewer)
      page.viewHost.textContent = ''
    }
  }
  page.attach(null)
  return null
}

function disposeQuietly(viewer: WorldViewer | null): void {
  try {
    viewer?.dispose()
  } catch {
    // Already broken: what matters is that the page goes on without it.
  }
}

async function boot(): Promise<AskState> {
  await domReady()
  let viewer: WorldViewer | null = null
  try {
    const checked = validateWorld(await readJsonBlock<unknown>('world'))
    const meta = await readJsonBlock<unknown>('meta')
    if (!checked.ok || !isMeta(meta)) throw new Error('world or meta block')
    const doc = checked.doc
    const { entries, vectors } = await readAskIndex(doc)

    const page = buildPage(document.body, doc, meta)
    viewer = mountViewer(page, doc, meta)
    // Smart Ask only on a page that carries the model (and the vectors it ranks), and only after the city has painted.
    const smart: Promise<SmartAsk> | null = vectors && document.getElementById('model')
      ? afterPaint().then(() => startSmartAsk(readBlock))
      : null
    const box = mountAskBox(page.askHost, { entries, bm25: buildBm25(entries.map((e) => e.text)), vectors, smart, onPick: page.pick })
    page.setAsk(box)
    current = box.state
    return await box.ready
  } catch {
    // Never leave the message under the page: the page is fixed, full-window and opaque, so it goes.
    disposeQuietly(viewer)
    document.querySelector('.wx-page')?.remove()
    const p = document.createElement('p')
    p.className = 'wx-broken'
    p.textContent = BROKEN_PAGE
    p.style.cssText = 'margin:32px auto;max-width:560px;padding:16px 20px;border-radius:10px;background:#0f172a;color:#e2e8f0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif'
    document.body.appendChild(p)
    current = () => 'failed'
    return 'failed'
  }
}

const handle: WorldExportHandle = Object.freeze({ ready: boot(), state: () => current() })
Object.defineProperty(window, '__worldExport', { value: handle, writable: false, enumerable: false, configurable: true })
