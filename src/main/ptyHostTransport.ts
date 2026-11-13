// Forking the real terminal process host. Only index.ts imports this file, so `electron` never reaches a module a
// utilityProcess loads (see procHostTransport.ts for why that matters).
//
// Integration code: exercised in the running app; ptyHostClient's orchestration is what the unit suite drives, through
// an injected transport.
/* c8 ignore start */

import { utilityProcess, type MessagePortMain } from 'electron'
import { fileURLToPath } from 'url'
import type { PtyHostTransport } from './ptyHostClient'
import type { PtyHostReply } from './ptyHost'
import { killUtility } from './utilityKill'

/** The bundled host entry, emitted next to the main `index.js` (another electron-vite input). */
export function resolvePtyHostPath(): string {
  return fileURLToPath(new URL('./ptyHost.js', import.meta.url))
}

export function createPtyHostTransport(hostPath: string = resolvePtyHostPath()): PtyHostTransport {
  const child = utilityProcess.fork(hostPath, [], { serviceName: 'termpolis-pty' })
  return {
    postMessage: (msg) => child.postMessage(msg),
    onMessage: (cb) => { child.on('message', (m: PtyHostReply) => cb(m)) },
    onExit: (cb) => { child.on('exit', (code: number) => cb(code)) },
    kill: () => killUtility(child),
    // The host's end of a renderer's direct line, transferred (ptyHost.ts takes it from the message's ports).
    postPort: (port) => child.postMessage({ kind: 'renderer-port' }, [port as MessagePortMain]),
  }
}
/* c8 ignore stop */
