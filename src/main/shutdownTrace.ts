/**
 * Which async requests are still in flight when the app quits, and where each one was made.
 *
 * After `quit`, Node frees the main environment, and that loops until every request it still owns
 * has finished. One that never finishes (a read that blocks, say) leaves the process alive with no
 * window and no JS running, which is how an e2e `app.close()` hangs with nothing in the log.
 * `process.getActiveResourcesInfo()` can count those requests, but not say whose they are. This
 * keeps the stack each one was created on, so a stuck quit names the line that started it.
 *
 * e2e only: an Error per fs call is cheap for a test run and pointless for a user.
 */
import { createHook } from 'async_hooks'

/** Requests that run on libuv's threadpool, or wait on the network, rather than on a handle. */
const TRACKED = /^(FSREQ|GETADDRINFO|GETNAMEINFO|QUERY|PBKDF2|SCRYPT|RANDOMBYTES|ZLIB|WRITEWRAP|SHUTDOWNWRAP|CONNECTWRAP)/

interface Request { type: string; stack: string; started: number }

const inflight = new Map<number, Request>()
let hook: ReturnType<typeof createHook> | null = null

export function startShutdownTrace(): void {
  if (hook) return
  hook = createHook({
    init(asyncId, type) {
      if (!TRACKED.test(type)) return
      // Deeper than V8's default 10 frames: Node's own fs/promises plumbing takes the first few.
      const limit = Error.stackTraceLimit
      Error.stackTraceLimit = 16
      const stack = String(new Error().stack)
      Error.stackTraceLimit = limit
      const frames = stack.split('\n').slice(1)
        .filter(frame => !frame.includes('node:internal/async_hooks') && !frame.includes('shutdownTrace.ts'))
      inflight.set(asyncId, { type, stack: frames.slice(0, 12).join('\n'), started: Date.now() })
    },
    destroy(asyncId) { inflight.delete(asyncId) },
  })
  hook.enable()
}

/** One line per request still in flight, oldest first, each with the stack that made it. */
export function describeInflight(now = Date.now()): string[] {
  return [...inflight.values()]
    .sort((a, b) => a.started - b.started)
    .map(r => `${r.type}, ${now - r.started}ms old, made at:\n${r.stack}`)
}

/** @internal test-only */
export function _stopShutdownTraceForTests(): void {
  hook?.disable()
  hook = null
  inflight.clear()
}
