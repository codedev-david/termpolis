// The exported page's entry (boot.ts runs when the script loads): it reads the blocks, mounts the viewer read-only
// (or the 2D map without WebGL), wires Ask, starts smart Ask only after the first paint and only on a page with
// the model, sets window.__worldExport, and makes no request of any kind.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { askEntries, packInt8 } from '../../../src/shared/world/askIndex'
import type { WorldDoc } from '../../../src/shared/world/types'
import type * as SmartAskModule from '../../../src/world-export/smartAsk'
import { minimal } from '../world/helpers'
import { addBlock, ensureDecompressionStream } from './helpers'

const { createWorldViewer, hasWebGL, startSmartAsk } = vi.hoisted(() => ({ createWorldViewer: vi.fn(), hasWebGL: vi.fn(), startSmartAsk: vi.fn() }))
vi.mock('../../../src/renderer/src/world/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/src/world/engine')>()),
  createWorldViewer,
  hasWebGL,
}))
vi.mock('../../../src/world-export/smartAsk', async (importOriginal) => ({ ...(await importOriginal<typeof SmartAskModule>()), startSmartAsk }))

const META = { project: 'Termpolis', exportedOn: '2026-11-21', head7: 'abc1234', dirty: false }
const fakeViewer = () => ({
  load: vi.fn(), setLayers: vi.fn(), setTheme: vi.fn(), setRightReserve: vi.fn(), setBottomReserve: vi.fn(), setCardReserve: vi.fn(),
  apply: vi.fn(async () => undefined), play: vi.fn(async () => undefined), resetView: vi.fn(), setPaused: vi.fn(), dispose: vi.fn(),
})

/** Writes a page's blocks: the keyword-only three, plus the smart ones when `smart`. */
function writePage(opts: { doc?: WorldDoc; smart?: boolean; skip?: string[] } = {}): WorldDoc {
  const doc = opts.doc ?? minimal()
  const entries = Array.isArray(doc.buildings) ? askEntries(doc) : []
  const packed = packInt8(entries.map((_, i) => Array.from({ length: 4 }, (__, h) => (h === i % 4 ? 1 : 0))))
  const blocks: Record<string, Uint8Array | object> = {
    world: doc,
    meta: META,
    ask: { version: 1, entries, dim: packed.dim, scales: packed.scales },
  }
  if (opts.smart) {
    blocks.askvec = new Uint8Array(packed.data.buffer, packed.data.byteOffset, packed.data.byteLength)
    blocks.vocab = { tokenizer: { model: { vocab: { '[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3 } } }, tokenizerConfig: {} }
    blocks.ortwasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 9, 9, 9])
    blocks.model = new Uint8Array([1, 2, 3, 4])
  }
  for (const [id, data] of Object.entries(blocks)) if (!opts.skip?.includes(id)) addBlock(id, data)
  return doc
}

async function boot(): Promise<void> {
  vi.resetModules()
  await import('../../../src/world-export/boot')
}

const ask = async (q: string): Promise<string[]> => {
  const input = document.querySelector('.wx-ask-input') as HTMLInputElement
  input.value = q
  document.querySelector('.wx-ask-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  await new Promise((r) => setTimeout(r, 0))
  return Array.from(document.querySelectorAll('.wx-ask-pick'), (b) => b.getAttribute('data-id') as string)
}

let actualStart: typeof SmartAskModule.startSmartAsk
beforeEach(async () => {
  ensureDecompressionStream()
  actualStart = (await vi.importActual<typeof SmartAskModule>('../../../src/world-export/smartAsk')).startSmartAsk
  createWorldViewer.mockReset().mockImplementation(fakeViewer)
  hasWebGL.mockReset().mockReturnValue(true)
  startSmartAsk.mockReset().mockResolvedValue({ embed: async () => new Float32Array([1, 0, 0, 0]) })
})

afterEach(() => {
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('boot', () => {
  it('mounts the viewer read-only with the page as its card panel, and loads the world', async () => {
    const doc = writePage()
    await boot()
    expect(await window.__worldExport.ready).toBe('keyword')
    expect(createWorldViewer).toHaveBeenCalledTimes(1)
    const [host, opts] = createWorldViewer.mock.calls[0]
    expect(host).toBe(document.querySelector('.wx-view'))
    expect(opts).toMatchObject({ title: 'Termpolis', readOnly: true })
    const viewer = createWorldViewer.mock.results[0].value as ReturnType<typeof fakeViewer>
    expect(viewer.load).toHaveBeenCalledWith(doc)
    opts.renderCard('<h3>From the viewer</h3>')
    expect(document.querySelector('.wx-card-body')!.innerHTML).toBe('<h3>From the viewer</h3>')
    expect(document.querySelector('.wx-title')!.textContent).toBe('Termpolis, exported from Termpolis on 2026-11-21 · commit abc1234')
  })

  it('sets window.__worldExport at once, read-only, and reports the state', async () => {
    writePage()
    await boot()
    const handle = window.__worldExport
    expect(handle.state()).toBe('loading')
    expect(() => { (window as { __worldExport: unknown }).__worldExport = null }).toThrow()
    expect(window.__worldExport).toBe(handle)
    expect(() => { (handle as { state: unknown }).state = null }).toThrow()
    expect(await handle.ready).toBe('keyword')
    expect(handle.state()).toBe('keyword')
  })

  it('shows the 2D map without WebGL, and Ask still works', async () => {
    writePage()
    hasWebGL.mockReturnValue(false)
    await boot()
    expect(await window.__worldExport.ready).toBe('keyword')
    expect(createWorldViewer).not.toHaveBeenCalled()
    const map = document.querySelector('.wx-map2d') as HTMLElement
    expect(map.hidden).toBe(false)
    expect(map.querySelector('[data-kind="building"][data-id="b1"]')).not.toBeNull()
    const ids = await ask('memory')
    expect(ids.length).toBeGreaterThan(0)
    ;(document.querySelector('.wx-ask-pick') as HTMLButtonElement).click()
    expect((document.querySelector('.wx-card') as HTMLElement).hidden).toBe(false)
  })

  it('starts smart Ask only after the first frame has painted', async () => {
    writePage({ smart: true })
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => { frames.push(cb); return frames.length }))
    await boot()
    await vi.waitFor(() => expect(frames).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 5))
    expect(startSmartAsk).not.toHaveBeenCalled()
    expect(window.__worldExport.state()).toBe('loading')
    frames[0](0)
    expect(startSmartAsk).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(startSmartAsk).toHaveBeenCalledTimes(1))
    expect(await window.__worldExport.ready).toBe('smart')
    expect(await ask('anything')).toHaveLength(Math.min(5, askEntries(minimal()).length))
  })

  it('never starts smart Ask on a page without the model block', async () => {
    writePage({ smart: true, skip: ['model'] })
    await boot()
    expect(await window.__worldExport.ready).toBe('keyword')
    await new Promise((r) => setTimeout(r, 20))
    expect(startSmartAsk).not.toHaveBeenCalled()
  })

  it('never starts smart Ask on a page with the model but no vectors', async () => {
    writePage({ smart: true, skip: ['askvec'] })
    await boot()
    expect(await window.__worldExport.ready).toBe('keyword')
    expect(startSmartAsk).not.toHaveBeenCalled()
  })

  it('says failed when smart Ask cannot start, and keeps keyword search', async () => {
    writePage({ smart: true })
    startSmartAsk.mockRejectedValue(new Error('no wasm'))
    await boot()
    expect(await window.__worldExport.ready).toBe('failed')
    expect(document.querySelector('.wx-ask-status')!.textContent).toContain("couldn't start")
    expect((await ask('memory')).length).toBeGreaterThan(0)
  })

  it('searches the world itself when the page has no ask block', async () => {
    writePage({ skip: ['ask'] })
    await boot()
    expect(await window.__worldExport.ready).toBe('keyword')
    expect(await ask('memory')).toContain('b2')
  })

  it('waits for the document when the script runs before it has loaded', async () => {
    writePage()
    Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true })
    try {
      await boot()
      await new Promise((r) => setTimeout(r, 5))
      expect(document.querySelector('.wx-page')).toBeNull()
      document.dispatchEvent(new Event('DOMContentLoaded'))
      expect(await window.__worldExport.ready).toBe('keyword')
      expect(document.querySelector('.wx-page')).not.toBeNull()
    } finally {
      delete (document as { readyState?: string }).readyState
    }
  })

  it.each([
    ['no world block', { skip: ['world'] }],
    ['no meta block', { skip: ['meta'] }],
    ['a world that does not validate', { doc: { nope: true } as unknown as WorldDoc }],
  ])('shows that the page is damaged, with %s', async (_, opts) => {
    writePage(opts)
    await boot()
    expect(await window.__worldExport.ready).toBe('failed')
    expect(window.__worldExport.state()).toBe('failed')
    expect(document.querySelector('.wx-broken')!.textContent).toBe("This Lumopolis page's data is missing or damaged, so the world can't be shown.")
    expect(createWorldViewer).not.toHaveBeenCalled()
  })

  it.each([false, true])('makes no fetch, XHR, WebSocket or Worker call (model block: %s)', async (smart) => {
    const fetchSpy = vi.fn()
    const xhr = vi.fn()
    const ws = vi.fn()
    const worker = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('XMLHttpRequest', xhr)
    vi.stubGlobal('WebSocket', ws)
    vi.stubGlobal('Worker', worker)
    // The real smart Ask and the real onnxruntime-web, on the page's (bogus) wasm and model bytes: ORT fails to start.
    startSmartAsk.mockImplementation(actualStart)
    writePage({ smart })
    await boot()
    expect(await window.__worldExport.ready).toBe(smart ? 'failed' : 'keyword')
    await ask('memory')
    expect(startSmartAsk).toHaveBeenCalledTimes(smart ? 1 : 0)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(xhr).not.toHaveBeenCalled()
    expect(ws).not.toHaveBeenCalled()
    expect(worker).not.toHaveBeenCalled()
  })
})
