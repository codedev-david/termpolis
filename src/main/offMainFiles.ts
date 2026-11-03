// File work for the Electron main thread that must never block it.
//
// Main is the thread that carries every keystroke and every echo (node-pty runs in it). On a
// monitored Windows laptop one synchronous file call there has been measured at up to 1.5 s (p99)
// and a spawn at 0.1-0.3 s, because the endpoint scanner inspects every file open and every process
// creation and its queue grows when the machine is busy. So a timer that persists a ledger, a
// watcher that appends an event, an IPC handler that logs: none of them may call a *Sync function.
//
// What this gives them instead, with the guarantees a hot path needs:
//   * TRUE async I/O (fs.promises: the libuv thread pool, never the main thread);
//   * bounded concurrency (at most `concurrency` file operations in flight, so a burst cannot take
//     every pool thread from the rest of the app);
//   * a bounded queue (a flood is shed and COUNTED, never allowed to grow without limit);
//   * per-path order (a path's operations run one after the other, in the order they were asked);
//   * coalescing (a state file written 1,000 times in a burst is written once, with the last
//     content; appended lines that arrive together go out in one write);
//   * writeSoon (at most one write per path per delay, whatever the rate of asking).
//
// What still needs the disk at the very end (quit) uses flushSync(). That is one of the few
// allow-listed synchronous sites (tests/electron/main-thread-allowlist.json): quitting is not typing.

import { promises as fsp, mkdirSync, writeFileSync, appendFileSync } from 'fs'
import { dirname } from 'path'

export interface FsPromisesLike {
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>
  writeFile(path: string, data: string | Uint8Array, opts?: { mode?: number }): Promise<void>
  appendFile(path: string, data: string): Promise<void>
  readFile(path: string, enc: BufferEncoding): Promise<string | Buffer>
}

export interface OffMainFilesOptions {
  /** File operations in flight at once. */
  concurrency?: number
  /** Operations waiting, across all paths. Past this, new ones are shed (and counted). */
  maxQueued?: number
  /** Characters one path may hold waiting to be appended. Past this, the OLDEST waiting lines are shed. */
  maxAppendChars?: number
  fs?: FsPromisesLike
  /** Called when something is shed. The caller rate-limits what it logs. */
  onShed?: (what: 'queue' | 'append', path: string) => void
}

export class QueueFullError extends Error {
  constructor(path: string) {
    super(`file queue full: ${path}`)
    this.name = 'QueueFullError'
  }
}

export const DEFAULT_CONCURRENCY = 2
export const DEFAULT_MAX_QUEUED = 512
export const DEFAULT_MAX_APPEND_CHARS = 8 * 1024 * 1024
/** writeSoon: the least time between two writes of one path. */
export const DEFAULT_SOON_MS = 500

interface PendingWrite { data: string | Uint8Array; mode?: number; promise: Promise<void>; flushed?: boolean }
interface PendingAppend { chunks: string[]; chars: number; promise: Promise<void>; flushed?: boolean }
interface Soon { data: string | Uint8Array; mode?: number; timer: ReturnType<typeof setTimeout> }

export interface OffMainFilesStats {
  /** Operations that ran, by kind. */
  writes: number
  appends: number
  reads: number
  runs: number
  /** Asks that were folded into an operation that had not started yet (a write replaced, a line joined). */
  coalesced: number
  /** Operations refused because the queue was full, and characters dropped because a path held too many. */
  shedOps: number
  shedChars: number
  /** The most operations in flight at once, and the most waiting at once. */
  maxInFlight: number
  maxQueued: number
  queued: number
  inFlight: number
}

export class OffMainFiles {
  private readonly concurrency: number
  private readonly maxQueuedOps: number
  private readonly maxAppendChars: number
  private readonly fsApi: FsPromisesLike
  private readonly onShed: OffMainFilesOptions['onShed']
  private readonly chains = new Map<string, Promise<void>>()
  private readonly pendingWrites = new Map<string, PendingWrite>()
  private readonly pendingAppends = new Map<string, PendingAppend>()
  private readonly soon = new Map<string, Soon>()
  private readonly gate: Array<() => void> = []
  private readonly st: OffMainFilesStats = {
    writes: 0, appends: 0, reads: 0, runs: 0, coalesced: 0, shedOps: 0, shedChars: 0,
    maxInFlight: 0, maxQueued: 0, queued: 0, inFlight: 0,
  }

  constructor(opts: OffMainFilesOptions = {}) {
    this.concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)
    this.maxQueuedOps = Math.max(1, opts.maxQueued ?? DEFAULT_MAX_QUEUED)
    this.maxAppendChars = Math.max(1, opts.maxAppendChars ?? DEFAULT_MAX_APPEND_CHARS)
    this.fsApi = opts.fs ?? (fsp as unknown as FsPromisesLike)
    this.onShed = opts.onShed
  }

  stats(): OffMainFilesStats {
    return { ...this.st }
  }

  /** Resolves when nothing is waiting or running. Never rejects. For tests and a polite quit. */
  async idle(): Promise<void> {
    for (;;) {
      if (this.soon.size > 0) this.releaseSoon()
      const chains = [...this.chains.values()]
      if (chains.length === 0) return
      await Promise.all(chains)
    }
  }

  /**
   * Replace `path` with `data`, creating its folder. While an earlier write to the same path has not
   * started, this one takes its place (the last content wins). The promise settles when the content
   * that reached the disk was written.
   */
  write(path: string, data: string | Uint8Array, opts: { mode?: number } = {}): Promise<void> {
    this.cancelSoon(path)
    const waiting = this.pendingWrites.get(path)
    if (waiting) {
      waiting.data = data
      if (opts.mode !== undefined) waiting.mode = opts.mode
      this.st.coalesced++
      return waiting.promise
    }
    // An append asked for after this write must run after it, so it cannot join an append in front.
    this.pendingAppends.delete(path)
    const entry = { data, mode: opts.mode, promise: undefined as unknown as Promise<void> } as PendingWrite
    this.pendingWrites.set(path, entry)
    entry.promise = this.enqueue(path, async () => {
      if (this.pendingWrites.get(path) === entry) this.pendingWrites.delete(path)
      if (entry.flushed) return
      await this.withDir(path, () => this.fsApi.writeFile(path, entry.data, entry.mode !== undefined ? { mode: entry.mode } : undefined))
      this.st.writes++
    })
    entry.promise.catch(() => { if (this.pendingWrites.get(path) === entry) this.pendingWrites.delete(path) })
    return entry.promise
  }

  /**
   * write(), at most once per `delayMs` per path, with whatever content is latest by then. For a state
   * file that changes in bursts (a session, a ledger): the rate of asking never sets the rate of writing.
   * Fire and forget: a failure is dropped (the next ask writes again).
   */
  writeSoon(path: string, data: string | Uint8Array, opts: { delayMs?: number; mode?: number } = {}): void {
    const armed = this.soon.get(path)
    if (armed) {
      armed.data = data
      if (opts.mode !== undefined) armed.mode = opts.mode
      this.st.coalesced++
      return
    }
    const entry: Soon = {
      data,
      mode: opts.mode,
      timer: setTimeout(() => {
        this.soon.delete(path)
        this.write(path, entry.data, entry.mode !== undefined ? { mode: entry.mode } : {}).catch(() => { /* the next ask writes again */ })
      }, opts.delayMs ?? DEFAULT_SOON_MS),
    }
    entry.timer.unref?.()
    this.soon.set(path, entry)
  }

  /**
   * Add `text` to the end of `path`, creating its folder. Lines asked for while an earlier append to
   * the same path has not started go out in ONE write, in order. A path that waits with more than
   * maxAppendChars loses its OLDEST lines first (counted in stats().shedChars): an event log may thin
   * out in a flood, it may not eat the heap.
   */
  append(path: string, text: string): Promise<void> {
    const waiting = this.pendingAppends.get(path)
    if (waiting) {
      waiting.chunks.push(text)
      waiting.chars += text.length
      this.st.coalesced++
      while (waiting.chars > this.maxAppendChars && waiting.chunks.length > 1) {
        const dropped = waiting.chunks.shift() as string
        waiting.chars -= dropped.length
        this.st.shedChars += dropped.length
        this.onShed?.('append', path)
      }
      return waiting.promise
    }
    this.pendingWrites.delete(path)
    const entry = { chunks: [text], chars: text.length, promise: undefined as unknown as Promise<void> } as PendingAppend
    this.pendingAppends.set(path, entry)
    entry.promise = this.enqueue(path, async () => {
      if (this.pendingAppends.get(path) === entry) this.pendingAppends.delete(path)
      if (entry.flushed || entry.chunks.length === 0) return
      await this.withDir(path, () => this.fsApi.appendFile(path, entry.chunks.join('')))
      this.st.appends++
    })
    entry.promise.catch(() => { if (this.pendingAppends.get(path) === entry) this.pendingAppends.delete(path) })
    return entry.promise
  }

  /** Read a file through the same bounded gate. Callers that need their own latest content keep it in memory. */
  async read(path: string, enc: BufferEncoding = 'utf8'): Promise<string> {
    await this.acquire()
    try {
      const out = await this.fsApi.readFile(path, enc)
      this.st.reads++
      return typeof out === 'string' ? out : out.toString(enc)
    } finally {
      this.release()
    }
  }

  /**
   * Run async file work that is more than one call (a rotation: rename, then a fresh file) strictly
   * after the earlier work for `key`, through the bounded gate. Work asked for later runs after it,
   * so nothing joins an operation queued in front of it.
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.cancelSoon(key)
    this.pendingWrites.delete(key)
    this.pendingAppends.delete(key)
    return this.enqueue(key, async () => {
      const out = await fn()
      this.st.runs++
      return out
    })
  }

  /**
   * Quit time only: put what is still waiting on the disk NOW, synchronously, and forget it. One
   * operation already running cannot be waited for from here; the rest cannot be lost.
   */
  flushSync(): void {
    this.releaseSoon()
    for (const [path, w] of [...this.pendingWrites]) {
      this.pendingWrites.delete(path)
      w.flushed = true
      try {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, w.data, w.mode !== undefined ? { mode: w.mode } : undefined)
      } catch { /* quitting: nothing left to tell */ }
    }
    for (const [path, a] of [...this.pendingAppends]) {
      this.pendingAppends.delete(path)
      a.flushed = true
      try {
        mkdirSync(dirname(path), { recursive: true })
        appendFileSync(path, a.chunks.join(''))
      } catch { /* quitting: nothing left to tell */ }
    }
  }

  /** The writeSoon waiting on a timer: write them now (the timer's work, early). */
  private releaseSoon(): void {
    for (const [path, s] of [...this.soon]) {
      clearTimeout(s.timer)
      this.soon.delete(path)
      this.write(path, s.data, s.mode !== undefined ? { mode: s.mode } : {}).catch(() => { /* dropped */ })
    }
  }

  private cancelSoon(path: string): void {
    const s = this.soon.get(path)
    if (!s) return
    clearTimeout(s.timer)
    this.soon.delete(path)
  }

  /** `op`, and when its folder is missing, the folder and `op` again: one fs call per write in the usual case. */
  private async withDir(path: string, op: () => Promise<void>): Promise<void> {
    try {
      await op()
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e
      await this.fsApi.mkdir(dirname(path), { recursive: true })
      await op()
    }
  }

  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.st.queued >= this.maxQueuedOps) {
      this.st.shedOps++
      this.onShed?.('queue', key)
      return Promise.reject(new QueueFullError(key))
    }
    this.st.queued++
    this.st.maxQueued = Math.max(this.st.maxQueued, this.st.queued)
    const previous = this.chains.get(key) ?? Promise.resolve()
    const run = previous
      .then(() => this.acquire())
      .then(async () => {
        try { return await fn() } finally { this.release() }
      })
    const tail: Promise<void> = run.then(() => undefined, () => undefined).then(() => {
      this.st.queued--
      if (this.chains.get(key) === tail) this.chains.delete(key)
    })
    this.chains.set(key, tail)
    return run
  }

  private acquire(): Promise<void> {
    if (this.st.inFlight < this.concurrency) {
      this.take()
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.gate.push(() => { this.take(); resolve() })
    })
  }

  private take(): void {
    this.st.inFlight++
    this.st.maxInFlight = Math.max(this.st.maxInFlight, this.st.inFlight)
  }

  private release(): void {
    this.st.inFlight--
    const next = this.gate.shift()
    if (next) next()
  }
}

/** The one the app shares. Tests make their own with a fake fs. */
export const offMainFiles = new OffMainFiles()
