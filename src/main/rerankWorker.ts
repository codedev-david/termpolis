// The cross-encoder's worker_thread (crossEncoderRerank.ts). Two halves, the same shape as embedWorker.ts:
//
//  • WORKER side (when run AS a worker): load the cross-encoder once, on `threads` WASM threads of its
//    own, and score one search's pool per message ({id, query, docs} → {id, scores}). This module's
//    copy of crossEncoderRerank has no worker spawner, so getRerankBatchScorer() loads the model in
//    this thread: no recursion. Messages are answered one at a time, in order. Anything that fails
//    answers `scores: null`; the host side then turns reranking off and recall keeps its first-stage
//    order.
//
//  • HOST side (createRerankWorkerTransport / resolveRerankWorkerPath): spawn the worker and proxy
//    scoring over it. The memory host wires this through setRerankWorkerSpawner, and main does the
//    same for the in-process fallback. Why a worker at all: a forward pass with WASM threads blocks the
//    thread that runs it, and the memory host's thread also serves every write, the primer and every
//    other memory call. Its own ORT instance also keeps its thread count apart from the embedder's.
//
// INTEGRATION code (a real worker_thread + ORT), exercised in the running app and by hand under a real
// Electron utilityProcess, not in the unit suite: the testable load/timeout/turn-off orchestration lives
// in crossEncoderRerank.ts behind RerankWorkerTransport. Excluded from coverage, as embedWorker.ts is.
import { parentPort, workerData, Worker } from 'worker_threads'
import { availableParallelism } from 'os'
import { fileURLToPath } from 'url'
import { getRerankBatchScorer, setRerankThreads, rerankThreadsFor, type RerankWorkerTransport } from './crossEncoderRerank'

interface ScoreRequest { id: number; query: string; docs: string[] }
interface ScoreReply { id: number; scores: number[] | null }

interface RerankWorkerData { rerankWorker: true; threads: number }

// ── Worker side ──────────────────────────────────────────────────────────────
// `parentPort` is null outside a worker_thread (main, the memory utilityProcess), and a worker_thread
// that is not this one (a test runner's, say) carries no `rerankWorker` mark, so importing this module
// anywhere else is a no-op.
const data = workerData as Partial<RerankWorkerData> | null
if (parentPort && data?.rerankWorker === true) {
  const port = parentPort
  setRerankThreads(Number(data.threads))
  let queue: Promise<void> = Promise.resolve()
  port.on('message', (msg: ScoreRequest) => {
    queue = queue.then(async () => {
      let scores: number[] | null = null
      try {
        const scorer = await getRerankBatchScorer()
        if (scorer) scores = await scorer(String(msg?.query ?? ''), Array.isArray(msg?.docs) ? msg.docs.map(String) : [])
      } catch { scores = null }
      port.postMessage({ id: msg?.id, scores } satisfies ScoreReply)
    })
  })
}

// ── Host side ────────────────────────────────────────────────────────────────
/** The bundled worker entry, next to `memoryHost.js` and `index.js` (an electron-vite main input). */
export function resolveRerankWorkerPath(): string {
  return fileURLToPath(new URL('./rerankWorker.js', import.meta.url))
}

/** Spawn the rerank worker and proxy scoring over it. A worker that errors or exits answers null for
 *  everything pending and everything after, which crossEncoderRerank reads as "turn reranking off". */
export function createRerankWorkerTransport(
  workerPath: string = resolveRerankWorkerPath(),
  threads: number = rerankThreadsFor(availableParallelism()),
): RerankWorkerTransport {
  const worker = new Worker(workerPath, { workerData: { rerankWorker: true, threads } satisfies RerankWorkerData })
  worker.unref() // never what keeps a quitting process alive
  let nextId = 0
  let dead = false
  const pending = new Map<number, (v: number[] | null) => void>()
  worker.on('message', (m: ScoreReply) => {
    const resolve = pending.get(m?.id)
    if (resolve) { pending.delete(m.id); resolve(Array.isArray(m.scores) ? m.scores : null) }
  })
  const failAll = (): void => {
    dead = true
    for (const resolve of pending.values()) resolve(null)
    pending.clear()
  }
  worker.on('error', failAll)
  worker.on('exit', failAll)
  return {
    score: (query, docs) => {
      if (dead) return Promise.resolve(null)
      return new Promise<number[] | null>((resolve) => {
        const id = nextId++
        pending.set(id, resolve)
        worker.postMessage({ id, query, docs } satisfies ScoreRequest)
      })
    },
    dispose: () => {
      failAll()
      try { void worker.terminate() } catch { /* already gone */ }
    },
  }
}
