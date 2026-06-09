// Memory/ANN benchmark — measures the REAL cost of scaling the brain, so the cap
// + off-heap decisions are data-driven, not estimated. Skipped in CI; run on
// demand for ONE size per process (clean memory numbers):
//
//   RUN_MEMORY_BENCH=1 BENCH_SIZE=100000 npx vitest run tests/electron/memoryBenchmark.bench.test.ts
import { describe, it } from 'vitest'
import { VectorStore } from '../../src/main/vectorStore'
import { HnswIndex } from '../../src/main/hnswIndex'

const RUN = process.env.RUN_MEMORY_BENCH === '1'
const N = Number(process.env.BENCH_SIZE ?? '100000')
const DIM = 384

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const mb = (b: number) => Math.round(b / 1e6)

describe.skipIf(!RUN)('memory benchmark (one BENCH_SIZE per run)', () => {
  it(`N=${N}`, () => {
    const r = rng(42)
    const baseRss = process.memoryUsage().rss

    // 1) pack N random unit vectors into the Float32 store
    let t = performance.now()
    const vs = new VectorStore(DIM, N)
    const tmp = new Float32Array(DIM)
    for (let i = 0; i < N; i++) {
      let norm = 0
      for (let d = 0; d < DIM; d++) { tmp[d] = r() * 2 - 1; norm += tmp[d] * tmp[d] }
      norm = Math.sqrt(norm) || 1
      for (let d = 0; d < DIM; d++) tmp[d] /= norm
      vs.add(tmp)
    }
    const tStore = performance.now() - t
    const afterStore = process.memoryUsage()

    // 2) build the HNSW graph
    t = performance.now()
    const idx = new HnswIndex((row) => vs.get(row))
    for (let i = 0; i < N; i++) idx.add(i)
    const tBuild = performance.now() - t
    const afterGraph = process.memoryUsage()

    // 3) search latency (avg over many queries)
    const q = new Float32Array(DIM)
    let qn = 0
    for (let d = 0; d < DIM; d++) { q[d] = r() * 2 - 1; qn += q[d] * q[d] }
    qn = Math.sqrt(qn) || 1
    for (let d = 0; d < DIM; d++) q[d] /= qn
    const QUERIES = 200
    t = performance.now()
    for (let s = 0; s < QUERIES; s++) idx.search(q, 10)
    const tSearch = (performance.now() - t) / QUERIES

    // 4) serialized graph size
    const json = JSON.stringify(idx.toJSON())
    const graphMB = mb(json.length)

    console.log(
      `\n=== BENCH N=${N} ===\n` +
        `store build : ${Math.round(tStore)} ms\n` +
        `hnsw build  : ${Math.round(tBuild)} ms  (${Math.round(tBuild / N * 1000)} us/insert)\n` +
        `search      : ${tSearch.toFixed(3)} ms/query\n` +
        `graph JSON  : ${graphMB} MB\n` +
        `RSS         : ${mb(afterGraph.rss)} MB  (+${mb(afterGraph.rss - baseRss)} over baseline)\n` +
        `  vectors   : ~${mb(afterStore.external - process.memoryUsage().external + afterStore.external)} (external/ArrayBuffer)\n` +
        `  heapUsed  : ${mb(afterGraph.heapUsed)} MB  (graph + maps + entries on V8 heap)\n` +
        `  external  : ${mb(afterGraph.external)} MB  (Float32 vectors)\n` +
        `==================\n`,
    )
  }, 1_200_000) // up to 20 min for large N
})
