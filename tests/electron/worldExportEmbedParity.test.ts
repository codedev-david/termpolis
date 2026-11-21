// The exported page's smart Ask and the app's embedder must give one meaning to one question: the page ranks its
// question vector against entry vectors the app's embedder made at export time, so a page that embedded queries even
// slightly differently would rank by noise. This runs the page's own startSmartAsk under Node with the real
// onnxruntime-web, fed the same bytes the export puts in the page (tokenizer, ORT wasm, model), and compares each
// question's vector with the main embedder's embedText(q, { isQuery: true }).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { embedText, resolveEmbedderAssets } from '../../src/main/localEmbedder'
import { startSmartAsk } from '../../src/world-export/smartAsk'

const root = join(__dirname, '..', '..')
const ORT_WASM = join(root, 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.wasm')
const questions = (JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'world', 'askQuestions.json'), 'utf8')) as Array<{ q: string }>)
  .slice(0, 5)
  .map((x) => x.q)

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
    // The blocks the export writes into a smart page (export.ts smartFiles), as bytes.
    const vocab = JSON.stringify({
      tokenizer: JSON.parse(readFileSync(join(assets.dir, 'tokenizer.json'), 'utf8')),
      tokenizerConfig: JSON.parse(readFileSync(join(assets.dir, 'tokenizer_config.json'), 'utf8')),
    })
    const blocks: Record<string, Uint8Array> = {
      vocab: new TextEncoder().encode(vocab),
      ortwasm: new Uint8Array(readFileSync(ORT_WASM)),
      model: new Uint8Array(readFileSync(assets.model)),
    }
    const page = await startSmartAsk(async (id) => blocks[id] ?? null)
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
