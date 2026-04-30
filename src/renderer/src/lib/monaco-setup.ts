// Monaco editor needs to be told two things in this Electron renderer:
//
// 1. WHERE TO LOAD FROM — by default, `@monaco-editor/react` fetches Monaco
//    from cdn.jsdelivr.net. Our renderer's CSP restricts script-src to
//    'self', so the CDN fetch is blocked and the editor sits on
//    "Loading..." forever (this was the v1.11.x Shell Config Files bug,
//    Sentry issue #4 — DOM error event on the loader.js script).
//    Calling `loader.config({ monaco })` makes the loader use the
//    locally-bundled monaco-editor module instead of any network fetch.
//
// 2. HOW TO SPAWN WORKERS — Monaco runs syntax tokenization in a Web
//    Worker. Vite's `?worker` import compiles `editor.worker.js` into a
//    bundled worker that the renderer can load from 'self' / blob:,
//    which our CSP allows (worker-src 'self' blob:).
//
// The configure function is exported (and unit-tested in isolation); the
// bootstrap that wires in the real monaco/worker imports lives in
// monaco-bootstrap.ts so this module stays importable from jsdom tests.

export function configureMonaco(opts: {
  loader: { config: (cfg: { monaco: unknown }) => void }
  monaco: unknown
  WorkerCtor: new () => Worker
  globalScope?: { MonacoEnvironment?: { getWorker: (workerId: string, label: string) => Worker } }
}): void {
  const scope = opts.globalScope ?? (self as unknown as { MonacoEnvironment?: { getWorker: (workerId: string, label: string) => Worker } })
  scope.MonacoEnvironment = {
    getWorker: () => new opts.WorkerCtor(),
  }
  opts.loader.config({ monaco: opts.monaco })
}
