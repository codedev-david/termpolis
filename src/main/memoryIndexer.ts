// Background memory indexer — keeps the brain fed without the user lifting a
// finger. It schedules ingestion runs (conversations, and optionally code) on a
// timer + once shortly after launch. Runs are non-overlapping and never throw:
// a failed run is logged and the next tick tries again.
//
// The actual ingest work is injected (`run`) so this module is pure scheduling
// logic and fully unit-testable with fake timers. Ingestion itself is
// incremental + idempotent (content-hash dedup), so repeated runs only embed
// genuinely new chunks and are cheap once warmed up.
//
// NOTE: embedding currently runs in-process; a first run over months of history
// can stall the UI in bursts. Moving embedding to a worker is the planned next
// optimization — the scheduler here is unaffected by that change.

export interface IndexRunResult {
  ranAt: number
  written: number
  error?: string
}

interface IndexerConfig {
  run: () => Promise<{ written: number }>
  log?: (msg: string) => void
}

const DEFAULT_INTERVAL_MS = 30 * 60_000 // every 30 min, like a quiet autosync
const DEFAULT_INITIAL_DELAY_MS = 10_000 // 10s after launch, once the app settles

let config: IndexerConfig | null = null
let interval: ReturnType<typeof setInterval> | null = null
let initial: ReturnType<typeof setTimeout> | null = null
let running = false

/** Run one ingestion pass now. No-op (with a reason) if busy or not started. */
export async function tick(): Promise<IndexRunResult> {
  if (!config) return { ranAt: Date.now(), written: 0, error: 'not started' }
  if (running) return { ranAt: Date.now(), written: 0, error: 'busy' }
  running = true
  try {
    const r = await config.run()
    config.log?.(`memory indexer: +${r.written} new chunks`)
    return { ranAt: Date.now(), written: r.written }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    config.log?.(`memory indexer error: ${msg}`)
    return { ranAt: Date.now(), written: 0, error: msg }
  } finally {
    running = false
  }
}

export function startIndexer(cfg: IndexerConfig & { intervalMs?: number; initialDelayMs?: number }): void {
  stopIndexer()
  config = { run: cfg.run, log: cfg.log }
  initial = setTimeout(() => void tick(), cfg.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS)
  interval = setInterval(() => void tick(), cfg.intervalMs ?? DEFAULT_INTERVAL_MS)
  // Don't keep the process alive just for the indexer (Node refs).
  if (initial && typeof (initial as { unref?: () => void }).unref === 'function') (initial as { unref: () => void }).unref()
  if (interval && typeof (interval as { unref?: () => void }).unref === 'function') (interval as { unref: () => void }).unref()
}

export function stopIndexer(): void {
  if (interval) clearInterval(interval)
  if (initial) clearTimeout(initial)
  interval = null
  initial = null
}

export function isIndexing(): boolean {
  return running
}

export function _resetIndexerForTests(): void {
  stopIndexer()
  running = false
  config = null
}
