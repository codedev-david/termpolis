// The exported page's smart Ask and the app's embedder must give one meaning to one question: the page ranks its
// question vector against entry vectors the app's embedder made at export time, so a page that embedded queries even
// slightly differently would rank by noise. This exports the fixture world as a smart page through the app's own
// exportWorld (so the vocab, ORT wasm and model blocks are exactly what export.ts writes, gzip and base64 included),
// reads those blocks back with the page's own readBlock (DecompressionStream), runs the page's startSmartAsk under
// Node with the real onnxruntime-web, and compares each question's vector with embedText(q, { isQuery: true }).
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EMBED_DIM, embedText, resolveEmbedderAssets } from '../../src/main/localEmbedder'
import { exportWorld, type ExportFs } from '../../src/main/world/export'
import type { WorldDoc } from '../../src/shared/world/types'
import { readBlock } from '../../src/world-export/blocks'
import { startSmartAsk } from '../../src/world-export/smartAsk'

const root = join(__dirname, '..', '..')
const ORT_WASM = join(root, 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.wasm')
const questions = (JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'world', 'askQuestions.json'), 'utf8')) as Array<{ q: string }>)
  .slice(0, 5)
  .map((x) => x.q)

const world = JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'world', 'termpolis.world.json'), 'utf8')) as WorldDoc
/** The runtime is not under test here (and need not be built): a stand-in the export embeds as it would the real one. */
const RUNTIME = '/runtime/world-export.js'
const realDocument = (globalThis as { document?: unknown }).document

afterEach(() => {
  ;(globalThis as { document?: unknown }).document = realDocument
})

/** Exports the fixture world as a smart page and returns its HTML, read and written in memory but for the assets. */
async function exportSmartPage(assets: { dir: string; model: string }): Promise<string> {
  let html = ''
  const fs: ExportFs = {
    readFile: async (p) => (p === RUNTIME ? new TextEncoder().encode('void 0') : new Uint8Array(await readFile(p))),
    writeFile: async (_p, data) => { html = String(data) },
    rename: async () => undefined,
    rm: async () => undefined,
    stat: async () => ({ size: html.length }),
  }
  const result = await exportWorld(
    { doc: world, ctx: { root: '/home/demo/repos/termpolis', home: '/home/demo', userData: '/home/demo/.config/termpolis' }, title: 'Termpolis', smart: true, target: '/out/smart.html', exportedOn: '2026-11-21' },
    {
      assets: { runtimeJs: RUNTIME, ortWasm: ORT_WASM, modelDir: assets.dir, modelFile: assets.model },
      // The entry vectors are not compared here; any row of the right width lets the export write a smart page.
      embed: async (texts) => texts.map(() => new Array<number>(EMBED_DIM).fill(0.01)),
      fs,
      signal: new AbortController().signal,
      progress: () => undefined,
    },
  )
  if (!result.ok) throw new Error(`the smart export failed: ${result.error}`)
  return html
}

/** The page's blocks as the page sees them: a document whose getElementById answers each data block of `html`. */
function pageDocument(html: string): { getElementById(id: string): { getAttribute(name: string): string | null; textContent: string } | null } {
  const blocks = new Map<string, { enc: string; text: string }>()
  for (const m of html.matchAll(/<script type="application\/octet-stream" id="([a-z0-9]+)" data-enc="([a-z0-9]+)">([^<]*)<\/script>/g)) {
    blocks.set(m[1], { enc: m[2], text: m[3] })
  }
  return {
    getElementById: (id) => {
      const b = blocks.get(id)
      return b ? { getAttribute: (name) => (name === 'data-enc' ? b.enc : null), textContent: b.text } : null
    },
  }
}

const cosine = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / Math.sqrt(na * nb)
}

describe('the exported page embeds a question as the app does', () => {
  it('startSmartAsk and embedText(q, { isQuery: true }) agree to cosine 0.999 on five fixture questions', async (ctx) => {
    // The guard sits inside the test (not describe.skipIf), so a run without the model reports a skip it cannot hide;
    // CI's package-verify job downloads the model and sets TERMPOLIS_REQUIRE_MODEL=1, which turns the skip into a failure.
    const assets = resolveEmbedderAssets()
    if (assets === undefined) {
      if (process.env.TERMPOLIS_REQUIRE_MODEL === '1') throw new Error('The bge-small model is missing from resources/models')
      ctx.skip('the bge-small model is not on this machine')
      return
    }
    // The blocks export.ts wrote into a smart page, decoded by the page's own reader.
    const html = await exportSmartPage(assets)
    ;(globalThis as { document?: unknown }).document = pageDocument(html)
    for (const id of ['vocab', 'ortwasm', 'model']) expect(await readBlock(id), `the page carries a ${id} block`).not.toBeNull()
    const page = await startSmartAsk(readBlock)
    expect(questions).toHaveLength(5)
    for (const q of questions) {
      const fromPage = await page.embed(q)
      const fromApp = await embedText(q, { isQuery: true })
      expect(fromApp, q).not.toBeNull()
      expect(fromPage).toHaveLength(384)
      expect(cosine(fromPage, fromApp as number[]), q).toBeGreaterThanOrEqual(0.999)
    }
  }, 120_000)
})
