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
let disabled = false
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

/** Fork one child and arm the restart policy behind it.
 *
 *  `init` is a FACTORY, asked afresh on every spawn. It used to be the params
 *  themselves, captured at launch and replayed on every respawn -- so a bridge
 *  that crashed an hour in came back with the devices and links of an hour ago:
 *  a phone paired since then was gone until the next manual restart, and one
 *  revoked since was live again. An argument rather than module state, because
 *  held in a variable it could be `null` on a path no caller can reach, which
 *  buys a guard nothing can exercise. */
function spawn(init: () => InitParams): void {
  if (!spawner || disabled) return
  const child = spawner()
  handle = child
  // Only the CURRENT child speaks for the bridge. A stopped child's last words and
  // its exit arrive after its replacement is already running; treating that exit
  // as a crash would clear the new handle and spawn a third bridge that fights the
  // second for every relay seat (409), with nothing left holding a handle to kill it.
  child.on('message', (m: BridgeToHost) => {
    if (handle === child) emit(m)
  })
  child.on('exit', (code) => {
    // A stopped child is no longer `handle` (stop clears it), so this one guard also
    // covers a deliberate stop: only an unplanned exit of the live child counts. No
    // `disabled` check is needed here either: `disabled` is only ever set below, and
    // `spawn()` refuses to start a child while it is set.
    if (handle !== child) return
    handle = null

    const now = Date.now()
    restartTimes.push(now)
    while (restartTimes.length > 0 && now - restartTimes[0] > RESTART_WINDOW_MS) restartTimes.shift()

    if (restartTimes.length > MAX_RESTARTS) {
      disabled = true
      emit({ kind: 'error', message: `remote bridge crashed ${restartTimes.length}x in ${RESTART_WINDOW_MS / 1000}s — remote disabled` })
      return
    }
    void code
    spawn(init)
  })
  child.postMessage({ kind: 'init', ...init() })
}

/** Start the bridge. Pass a factory so a crash restart replays the CURRENT
 *  devices and links; plain params are still accepted and replay as given. */
export function startRemoteBridge(init: InitParams | (() => InitParams)): void {
  // `disabled` is checked in `spawn()` and nowhere else. Two places that decide
  // whether a fail-closed switch is closed is one place too many: the day a
  // third caller appears, it will copy whichever guard it happened to read.
  if (handle) return
  spawn(typeof init === 'function' ? init : () => init)
}

/** Push one message down to the running bridge.
 *
 *  Silently a no-op when nothing is running. Every caller is reacting to a user
 *  action or a PTY write, neither of which can know whether the child is up, and
 *  making them all check first would put the same race in every call site. */
export function sendToBridge(msg: HostToBridge): void {
  handle?.postMessage(msg)
}

/** Re-arm after the flap limit tripped.
 *
 *  The supervisor fails CLOSED on a crash loop and stays that way, which is
 *  right for an automatic restart and wrong for a person: toggling remote off
 *  and on again is an explicit decision to try once more, and without this that
 *  switch would do nothing until the app was restarted, with no explanation. */
export function clearRemoteDisabled(): void {
  disabled = false
  restartTimes.length = 0
}

export function stopRemoteBridge(): void {
  // Ask before killing. The child closes its relay rooms on `shutdown`, which
  // frees each seat immediately -- and a seat is exclusive: the relay answers a
  // second desktop socket for the same room with 409. Without this the next
  // start races the old sockets' timeouts.
  handle?.postMessage({ kind: 'shutdown' })
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
  relayUrl?: string,
): BridgeHandle {
  // Extended, never replaced: the child is a Node process and needs PATH, TMPDIR
  // and the Electron run-time variables to start at all.
  //
  // The key is omitted rather than set empty when there is no URL, because the
  // child falls back with `?? DEFAULT_RELAY_URL` -- an empty string is not
  // nullish and would sail through as a URL nothing can dial.
  const env = { ...process.env }
  if (relayUrl) env.TERMPOLIS_RELAY_URL = relayUrl
  const child = utilityProcess.fork(bridgePath, [], {
    serviceName: 'termpolis-remote-bridge',
    env,
  })
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
  disabled = false
  handle = null
  spawner = null
  restartTimes.length = 0
  subscribers.length = 0
}
