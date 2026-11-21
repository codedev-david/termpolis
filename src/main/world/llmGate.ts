// One limit on Lumopolis labelling calls for the whole computer. Every world's labelling run asks for at most
// LABEL_CONCURRENCY model calls at once (label.ts), but two or three projects compiling together (the home, the
// recent worlds, several terminals) each run their own pool, so 8 to 12 agent CLIs could start at once. Main
// answers every world's calls through this one gate: at most WORLD_LLM_HOST_LIMIT run at a time, the rest wait
// their turn in the order they asked.
//
// - A waiting call still has its own way out: its signal aborted (its compile ended, its world was removed,
//   labelling was turned off) takes it out of the line, answered null, and its CLI never starts.
// - Waiting is not the call's time: its limit (`timeoutMs`) starts when it gets a slot, and `onStart` tells the
//   caller when that is, so the host times the call itself and never the wait.
// - A call that rejects or throws frees its slot. One answered null by its limit or its signal while it runs keeps
//   the slot until its CLI settles (the slot stands for a running process), but never longer than `graceMs` more.
//
// Pure: no Electron, no process; the timers are injected, so the tests run it on fake time.

/** Labelling model calls running at once across every world. */
export const WORLD_LLM_HOST_LIMIT = 4
/** How long a call answered by its limit or its signal may still hold its slot while its CLI is stopped. */
export const GATE_SETTLE_GRACE_MS = 10_000

export interface GateTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface GateCallOptions {
  /** Aborted while waiting: the call leaves the line and never starts. Aborted while running: answered null at once. */
  signal?: AbortSignal
  /** The call's own limit, counted from when it starts, never while it waits. */
  timeoutMs: number
  /** Told the moment the call gets its slot, just before it starts. */
  onStart?: () => void
}

export interface LlmGate {
  /** Runs `call` when a slot is free: its reply, or null when it rejected, threw, timed out or was cancelled. */
  run(call: (signal: AbortSignal) => Promise<string | null>, opts: GateCallOptions): Promise<string | null>
  /** Calls holding a slot. */
  inFlight(): number
  /** Calls waiting for one. */
  queued(): number
}

export interface LlmGateOptions {
  limit?: number
  timers?: GateTimers
  graceMs?: number
}

const realTimers: GateTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export function createLlmGate(o: LlmGateOptions = {}): LlmGate {
  const limit = Math.max(1, o.limit ?? WORLD_LLM_HOST_LIMIT)
  const timers = o.timers ?? realTimers
  const graceMs = o.graceMs ?? GATE_SETTLE_GRACE_MS
  let running = 0
  /** The waiting calls, oldest first: each entry starts its call. */
  const line: Array<() => void> = []

  // A slot is taken back the moment it frees, so a call waits only while all of them are held.
  const next = (): void => {
    while (running < limit && line.length > 0) (line.shift() as () => void)()
  }

  const run = (call: (signal: AbortSignal) => Promise<string | null>, opts: GateCallOptions): Promise<string | null> =>
    new Promise((resolve) => {
      const signal = opts.signal
      if (signal?.aborted) return resolve(null)
      let answered = false
      const answer = (text: string | null): void => {
        if (answered) return
        answered = true
        resolve(text)
      }

      const start = (): void => {
        signal?.removeEventListener('abort', leave)
        running++
        const ctl = new AbortController()
        let freed = false
        let grace: unknown
        const free = (): void => {
          if (freed) return
          freed = true
          timers.clearTimeout(limitTimer)
          if (grace !== undefined) timers.clearTimeout(grace)
          signal?.removeEventListener('abort', stop)
          running--
          next()
        }
        // Its limit or its signal: the caller has its answer now, and the CLI is told to stop.
        const stop = (): void => {
          answer(null)
          ctl.abort()
          if (grace === undefined) grace = timers.setTimeout(free, graceMs)
        }
        const limitTimer = timers.setTimeout(stop, opts.timeoutMs)
        signal?.addEventListener('abort', stop, { once: true })
        try {
          opts.onStart?.()
        } catch {
          // a caller that cannot be told still gets its answer
        }
        let reply: Promise<string | null>
        try {
          reply = Promise.resolve(call(ctl.signal))
        } catch {
          reply = Promise.resolve(null)
        }
        reply.then(
          (text) => answer(typeof text === 'string' ? text : null),
          () => answer(null)
        ).finally(free)
      }

      const leave = (): void => {
        line.splice(line.indexOf(start), 1)
        answer(null)
      }

      if (running < limit) start()
      else {
        line.push(start)
        signal?.addEventListener('abort', leave, { once: true })
      }
    })

  return { run, inFlight: () => running, queued: () => line.length }
}
