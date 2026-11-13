// The direct typing line, the page's end (1.61.0). See src/shared/ptyDirect.ts for the wire, ptyHost.ts for the far end.
//
// Main hands the preload a MessagePort on every page load (pty:direct-port). From then on, a write to a terminal the host
// has bound goes down the port, and the host's copies of output come up it into the router (terminalDataRouter.ts),
// which drops whichever copy of a stretch arrives second. The page itself never sees the port.
//
// Ordering. A write that went through main (no port yet, an unbound terminal, a relaunch's keyed write) may still be on
// its way when the next one goes direct. So the first direct write after one through main carries a mark `n`, and the
// same `n` goes to main on terminal:direct-sync right behind the main-bound writes; main passes it to the host after
// them, and the host holds the marked write (and everything after it for that terminal) until the mark arrives.
//
// Failure is always the old path: no port, a port that throws, a host that went away (pty:direct-reset) -- every write
// then goes through main, exactly as before 1.61.0.
import type { DirectFromHost, DirectToHost } from '../shared/ptyDirect'
import type { RouterIpc, TerminalDataRouter } from './terminalDataRouter'

/** The DOM MessagePort the preload receives, as far as this file uses it. */
export interface DirectPortLike {
  postMessage(message: DirectToHost): void
  start(): void
  close(): void
  onmessage: ((ev: { data: unknown }) => void) | null
}

export interface DirectLine {
  /** Send `data` to terminal `id` down the line; false = not sent, the caller writes through main (then wentViaMain). */
  write(id: string, data: string, key?: string): boolean
  /** A write to `id` went through main. */
  wentViaMain(id: string): void
  /** Whether a port is held, and how many terminals it serves (for tests and the stats). */
  state(): { port: boolean; bound: number }
}

export function createDirectLine(
  ipcRenderer: Pick<RouterIpc, 'on' | 'send'>,
  router: Pick<TerminalDataRouter, 'direct' | 'resetDirect' | 'listened' | 'onListen'>,
  now: () => number = Date.now,
): DirectLine {
  let port: DirectPortLike | null = null
  const bound = new Set<string>()
  // Terminals with a write through main since their last direct one: the next direct write needs a mark.
  const viaMain = new Set<string>()
  let lastMark = 0

  const post = (msg: DirectToHost): boolean => {
    if (!port) return false
    try {
      port.postMessage(msg)
      return true
    } catch (e) {
      console.error('[termpolis] the direct typing line failed; writes go through main again', e)
      drop()
      return false
    }
  }

  const drop = (): void => {
    const old = port
    port = null
    bound.clear()
    if (old) {
      old.onmessage = null
      try { old.close() } catch { /* already closed */ }
    }
  }

  const onMessage = (m: unknown): void => {
    if (!m || typeof m !== 'object') return
    const msg = m as Partial<DirectFromHost> & { id?: unknown; data?: unknown; end?: unknown; fresh?: unknown }
    if (typeof msg.id !== 'string') return
    if (msg.t === 'bind') {
      bound.add(msg.id)
      if (msg.fresh === true) router.resetDirect(msg.id)
    } else if (msg.t === 'unbind') {
      bound.delete(msg.id)
    } else if (msg.t === 'd' && typeof msg.data === 'string' && typeof msg.end === 'number') {
      router.direct(msg.id, msg.data, msg.end)
    }
  }

  const adopt = (next: DirectPortLike | null): void => {
    drop()
    if (!next) return
    port = next
    next.onmessage = (ev) => onMessage(ev?.data)
    try {
      next.start()
    } catch (e) {
      console.error('[termpolis] the direct typing line would not start', e)
      drop()
      return
    }
    for (const id of router.listened()) post({ t: 'sub', id })
  }

  // Literal channels: tests/electron/ipcChannelSync.test.ts reads the preload's source for these registrations.
  ipcRenderer.on('pty:direct-port', (event: unknown) => {
    const ports = (event as { ports?: unknown[] } | undefined)?.ports
    adopt(Array.isArray(ports) && ports[0] ? (ports[0] as DirectPortLike) : null)
  })
  ipcRenderer.on('pty:direct-reset', () => drop())

  router.onListen((id, listening) => {
    post(listening ? { t: 'sub', id } : { t: 'unsub', id })
  })

  return {
    write(id, data, key) {
      // A keyed write is a relaunch's own: main checks the key against its hold, so it always goes through main.
      if (key || !port || !bound.has(id) || typeof data !== 'string') return false
      let sync: number | undefined
      if (viaMain.has(id)) {
        lastMark = Math.max(lastMark + 1, Math.floor(now() * 1000))
        sync = lastMark
        try {
          ipcRenderer.send('terminal:direct-sync', { id, n: sync })
        } catch {
          return false // the mark could not go; this write goes through main, behind the others
        }
      }
      if (!post(sync === undefined ? { t: 'w', id, data } : { t: 'w', id, data, sync })) return false
      viaMain.delete(id)
      return true
    },
    wentViaMain(id) {
      viaMain.add(id)
    },
    state: () => ({ port: port !== null, bound: bound.size }),
  }
}
