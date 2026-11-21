// The writer in main and the page's runtime, together: a page exportWorld writes is put into the document and read
// back through the runtime's own readers (blocks.ts readJsonBlock, readBlock and readAskIndex) and page check
// (isMeta), with the browser's DecompressionStream. The writer and the runtime cannot drift apart unnoticed.
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { exportWorld, type ExportAssets, type ExportFs, type ExportRequest } from '../../../src/main/world/export'
import { askEntries } from '../../../src/shared/world/askIndex'
import { applyDesignPatch, REMOVALS_ID } from '../../../src/shared/world/designPatch'
import { isMeta } from '../../../src/shared/world/exportMeta'
import type { WorldDoc } from '../../../src/shared/world/types'
import { validateWorld } from '../../../src/shared/world/validate'
import { readAskIndex, readBlock, readJsonBlock } from '../../../src/world-export/blocks'
import { designWorld, labelledWorld, linkedDesignWorld } from '../../fixtures/world/docWorlds'
import { ensureDecompressionStream } from './helpers'

const HOME = 'C:/Users/someone'
const CTX = { root: `${HOME}/repos/shop`, home: HOME, userData: `${HOME}/AppData/Roaming/Termpolis` }
const ASSETS: ExportAssets = { runtimeJs: 'R:/world-export.js', ortWasm: 'R:/ort.wasm', modelDir: 'M:/bge', modelFile: 'M:/bge/onnx/model.onnx' }
const WASM = new Uint8Array(3000).map((_, i) => (i * 7) % 256)
const MODEL = new Uint8Array(5000).map((_, i) => (i * 13) % 256)
const TOKENIZER = { model: { vocab: { '[PAD]': 0, '[UNK]': 1, '</script>': 2 } } }

/** The page exportWorld writes, from an in-memory file system. */
async function exported(over: Partial<ExportRequest>): Promise<string> {
  const files = new Map<string, Uint8Array>([
    [ASSETS.runtimeJs, Buffer.from('(function(){window.__ran=1})()\n')], [ASSETS.ortWasm, WASM], [ASSETS.modelFile, MODEL],
    ['M:/bge/tokenizer.json', Buffer.from(JSON.stringify(TOKENIZER))], ['M:/bge/tokenizer_config.json', Buffer.from('{"do_lower_case":true}')],
  ])
  let page = ''
  const fs: ExportFs = {
    readFile: async (p) => files.get(p.replace(/\\/g, '/')) as Uint8Array,
    writeFile: async (_p, d) => { page = String(d) },
    rename: async () => undefined,
    rm: async () => undefined,
    stat: async () => ({ size: page.length }),
  }
  // A vector per text that differs from the next, so the int8 rows are not all alike.
  const embed = async (texts: string[]): Promise<number[][]> => texts.map((t, i) => Array.from({ length: 384 }, (_, k) => Math.sin(k + i + t.length)))
  const r = await exportWorld(
    { doc: labelledWorld(), ctx: CTX, title: 'Shop', smart: true, target: 'D:/Shop.html', exportedOn: '2026-11-21', ...over },
    { assets: ASSETS, embed, fs, signal: new AbortController().signal, progress: () => undefined },
  )
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return page
}

/** Puts the page's body into the document as a browser parses it (inserted scripts do not run). */
function load(page: string): void {
  const parsed = new DOMParser().parseFromString(page, 'text/html')
  document.title = parsed.title
  document.body.replaceChildren(...Array.from(parsed.body.childNodes, (n) => document.importNode(n, true)))
}

beforeAll(ensureDecompressionStream)
afterEach(() => { document.body.innerHTML = '' })

describe('a page the export writes, read by the runtime', () => {
  it('smart: the world validates, the meta passes isMeta, and readAskIndex takes the vectors (the fit rule holds)', async () => {
    load(await exported({ smart: true }))
    const checked = validateWorld(await readJsonBlock<unknown>('world'))
    expect(checked.ok).toBe(true)
    const doc = (checked as { doc: WorldDoc }).doc
    const meta = await readJsonBlock<unknown>('meta')
    expect(isMeta(meta)).toBe(true)
    expect(meta).toEqual({ project: 'Shop', exportedOn: '2026-11-21', head7: 'a1b2c3d', dirty: true })
    const { entries, vectors } = await readAskIndex(doc)
    expect(entries).toEqual(askEntries(doc))
    expect(vectors).not.toBeNull()
    expect(vectors!.dim).toBe(384)
    expect(vectors!.scales).toHaveLength(entries.length)
    expect(vectors!.data.byteLength).toBe(entries.length * 384)
    expect(new Set(vectors!.data).size).toBeGreaterThan(2)
    // The smart files the page's Ask runtime reads (smartAsk.ts): the tokenizer pair, the wasm and the model, unchanged.
    expect(await readJsonBlock('vocab')).toEqual({ tokenizer: TOKENIZER, tokenizerConfig: { do_lower_case: true } })
    expect(Array.from((await readBlock('ortwasm')) as Uint8Array)).toEqual(Array.from(WASM))
    expect(Array.from((await readBlock('model')) as Uint8Array)).toEqual(Array.from(MODEL))
    expect(document.title).toBe('Shop · Lumopolis')
  })

  it('keyword: readAskIndex takes the entries and no vectors, and the page has no smart blocks', async () => {
    load(await exported({ smart: false }))
    const doc = (validateWorld(await readJsonBlock<unknown>('world')) as { doc: WorldDoc }).doc
    expect(isMeta(await readJsonBlock<unknown>('meta'))).toBe(true)
    const { entries, vectors } = await readAskIndex(doc)
    expect(entries).toEqual(askEntries(doc))
    expect(vectors).toBeNull()
    for (const id of ['askvec', 'vocab', 'ortwasm', 'model']) expect(await readBlock(id)).toBeNull()
  })

  it('a proposal export: the meta names the proposal the world holds', async () => {
    load(await exported({ doc: linkedDesignWorld(), proposalId: 'p2', smart: false }))
    const doc = (validateWorld(await readJsonBlock<unknown>('world')) as { doc: WorldDoc }).doc
    const meta = await readJsonBlock<{ proposalId?: string }>('meta')
    expect(isMeta(meta)).toBe(true)
    expect(meta!.proposalId).toBe('p2')
    expect(doc.layers.plan.map((p) => p.id)).toEqual(['p2'])
  })

  it('a design world with removals: the world the runtime reads keeps them', async () => {
    const design = applyDesignPatch(designWorld(), [{ op: 'removePart', id: 'b2' }]).doc
    load(await exported({ doc: design, ctx: { ...CTX, root: null }, title: 'Shop design', smart: true }))
    const doc = (validateWorld(await readJsonBlock<unknown>('world')) as { doc: WorldDoc }).doc
    expect(doc.layers.plan.find((p) => p.id === REMOVALS_ID)?.removes).toEqual(['b2'])
    expect(isMeta(await readJsonBlock<unknown>('meta'))).toBe(true)
    expect((await readAskIndex(doc)).vectors).not.toBeNull()
  })
})
