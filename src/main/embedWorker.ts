// BB11: embedding worker_thread. Two halves live here:
//
//  • WORKER side (when run AS a worker): keep one warm ORT session and embed a single
//    text per message ({id, text} → {id, vec}). Loading happens in-process WITHIN this
//    worker — its localEmbedder module has no worker spawner set, so embedText takes the
//    in-process path (no recursion). Any failure posts a null vec; the main side then
//    falls back to its OWN in-process embedder, then keyword.
//
//  • MAIN side (createWorkerTransport / resolveWorkerPath): lazily spawn the worker and
//    proxy single-text embeds over it. The app wires this via setWorkerSpawner; it is
//    INTEGRATION code (a real worker_thread + ORT) and is exercised in the running app,
//    not in the unit suite — the testable spawn/timeout/fallback orchestration lives in
//    localEmbedder.ts behind the injectable transport. Excluded from coverage.
import { parentPort, Worker } from 'worker_threads'
import { fileURLToPath } from 'url'
import { embedText, type WorkerTransport } from './localEmbedder'

// ── Worker side ──────────────────────────────────────────────────────────────
// `parentPort` is null in the main process, so importing this module there is a no-op.
parentPort?.on('message', async (msg: { id: number; text: string }) => {
  let vec: number[] | null = null
  try { vec = await embedText(msg?.text ?? '') } catch { vec = null }
  parentPort?.postMessage({ id: msg?.id, vec })
})

// ── Main side ────────────────────────────────────────────────────────────────
/** The bundled worker entry, next to the main `index.js` (a second electron-vite input). */
export function resolveWorkerPath(): string {
  return fileURLToPath(new URL('./embedWorker.js', import.meta.url))
}

/** Spawn the embedding worker and proxy single-text embeds over it. The app passes this
 *  (or `() => createWorkerTransport()`) to setWorkerSpawner; a spawn/runtime failure is
 *  surfaced as a null/rejected embed so localEmbedder falls back to in-process. */
export function createWorkerTransport(workerPath: string = resolveWorkerPath()): WorkerTransport {
  const worker = new Worker(workerPath)
  let nextId = 0
  const pending = new Map<number, (v: number[] | null) => void>()
  worker.on('message', (m: { id: number; vec: number[] | null }) => {
    const resolve = pending.get(m.id)
    if (resolve) { pending.delete(m.id); resolve(m.vec) }
  })
  const failAll = (): void => { for (const resolve of pending.values()) resolve(null); pending.clear() }
  worker.on('error', failAll)
  worker.on('exit', failAll)
  return {
    embed: (text: string) => new Promise<number[] | null>((resolve) => {
      const id = nextId++
      pending.set(id, resolve)
      worker.postMessage({ id, text })
    }),
    dispose: () => { try { void worker.terminate() } catch { /* already gone */ } },
  }
}
