import { fileURLToPath } from 'url'
import { utilityProcess } from 'electron'
import type { BridgeToHost, HostToBridge } from './remoteBridge/protocol'

export interface BridgeHandle {
  postMessage(msg: HostToBridge): void
  on(event: 'message', cb: (m: BridgeToHost) => void): void
  on(event: 'exit', cb: (code: number) => void): void
  kill(): void
}

export type BridgeSpawner = () => BridgeHandle
type InitParams = Omit<Extract<HostToBridge, { kind: 'init' }>, 'kind'>

// Matches memoryClient's flap policy. The response differs: memory falls back
// in-process, but a network-facing bridge must fail CLOSED.
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 60_000

let spawner: BridgeSpawner | null = null
let handle: BridgeHandle | null = null
let params: InitParams | null = null
let disabled = false
let stopping = false
const restartTimes: number[] = []
const subscribers: Array<(m: BridgeToHost) => void> = []

export function setBridgeSpawner(fn: BridgeSpawner | null): void {
  spawner = fn
}

export function onBridgeMessage(cb: (m: BridgeToHost) => void): void {
  subscribers.push(cb)
}

export function isRemoteBridgeRunning(): boolean {
  return handle !== null
}

export function isRemoteDisabled(): boolean {
  return disabled
}

function emit(m: BridgeToHost): void {
  for (const cb of subscribers) cb(m)
}

function spawn(): void {
  if (!spawner || !params || disabled) return
  const child = spawner()
  handle = child
  child.on('message', emit)
  child.on('exit', (code) => {
    handle = null
    if (stopping || disabled) return

    const now = Date.now()
    restartTimes.push(now)
    while (restartTimes.length > 0 && now - restartTimes[0] > RESTART_WINDOW_MS) restartTimes.shift()

    if (restartTimes.length > MAX_RESTARTS) {
      disabled = true
      emit({ kind: 'error', message: `remote bridge crashed ${restartTimes.length}x in ${RESTART_WINDOW_MS / 1000}s — remote disabled` })
      return
    }
    void code
    spawn()
  })
  child.postMessage({ kind: 'init', ...params })
}

export function startRemoteBridge(init: InitParams): void {
  if (handle || disabled) return
  stopping = false
  params = init
  spawn()
}

export function stopRemoteBridge(): void {
  stopping = true
  handle?.kill()
  handle = null
}

// ── Real fork ────────────────────────────────────────────────────────────────
// Only reachable inside a packaged/dev Electron run, exactly like
// createMemoryHostTransport, so it carries the same coverage exemption.
/* c8 ignore start */

/** The bundled bridge entry, emitted next to the main `index.js` as a fourth
 *  electron-vite input. `import.meta.url`, not `__dirname`: package.json is
 *  `"type": "module"` and the built main bundle is real ESM. Same resolution
 *  `resolveMemoryHostPath()` uses. */
export function resolveRemoteBridgePath(): string {
  return fileURLToPath(new URL('./remoteBridge.js', import.meta.url))
}

/**
 * Fork the real utilityProcess. Wired by the app via
 *   setBridgeSpawner(() => createRemoteBridgeTransport())
 *
 * GOTCHA (asymmetric, and it bites — memoryClient.ts:655 documents the same trap):
 * in the CHILD, `parentPort.on('message', e => …)` receives an Electron MessageEvent
 * and the payload is `e.data`. In the PARENT, `child.on('message', m => …)` receives
 * the payload DIRECTLY. Unwrap `.data` on both sides and every message arrives
 * undefined — which looks exactly like a phone that paired but never responds.
 */
export function createRemoteBridgeTransport(
  bridgePath: string = resolveRemoteBridgePath(),
): BridgeHandle {
  const child = utilityProcess.fork(bridgePath, [], { serviceName: 'termpolis-remote-bridge' })
  return {
    postMessage: (msg) => child.postMessage(msg),
    on: (event: 'message' | 'exit', cb: never) => {
      if (event === 'message') child.on('message', cb as unknown as (m: BridgeToHost) => void)
      else child.on('exit', cb as unknown as (code: number) => void)
    },
    kill: () => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    },
  } as BridgeHandle
}
/* c8 ignore stop */

/** @internal test-only */
export function _resetSupervisorForTests(): void {
  stopping = false
  disabled = false
  handle = null
  params = null
  spawner = null
  restartTimes.length = 0
  subscribers.length = 0
}
