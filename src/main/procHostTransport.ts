// Forking the real utilityProcess — the ONE place in the app that touches `electron` to do it.
//
// Kept out of procClient.ts on purpose. procClient is imported by gitCommand, gitCommand is
// reachable from memoryHost.ts, and memoryHost runs INSIDE a utilityProcess — an environment where
// `import { utilityProcess } from 'electron'` is not a runtime error you can catch but a link-time
// SyntaxError that takes the whole child down before a line of it executes. (See
// tests/electron/memoryHostImportGraph.test.ts, the guard test for exactly that.) Only index.ts
// imports this file, and index.ts only ever runs in the main process.
//
// Integration code: exercised in the running app, not the unit suite — procClient's orchestration
// is what the tests drive, through an injected transport.
/* c8 ignore start */

import { utilityProcess } from 'electron'
import { fileURLToPath } from 'url'
import type { ProcTransport } from './procClient'
import type { ProcResult } from './procHost'

/** The bundled host entry, emitted next to the main `index.js` (another electron-vite input).
 *  `import.meta.url`, not `__dirname`: package.json is `"type": "module"` and the built main
 *  bundle is real ESM, where __dirname does not exist. */
export function resolveProcHostPath(): string {
  return fileURLToPath(new URL('./procHost.js', import.meta.url))
}

/**
 * Fork the real utilityProcess.
 *
 * No `--max-old-space-size` bump, unlike memoryHost: this child holds nothing between calls. It
 * exists purely to own CreateProcess, so its heap is whatever one command's stdout needs.
 */
export function createProcHostTransport(hostPath: string = resolveProcHostPath()): ProcTransport {
  const child = utilityProcess.fork(hostPath, [], { serviceName: 'termpolis-proc' })
  return {
    postMessage: (msg) => child.postMessage(msg),
    onMessage: (cb) => { child.on('message', (m: ProcResult) => cb(m)) },
    onExit: (cb) => { child.on('exit', (code: number) => cb(code)) },
    kill: () => { try { child.kill() } catch { /* already gone */ } },
    get pid() { return child.pid },
  }
}
/* c8 ignore stop */
