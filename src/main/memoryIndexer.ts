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
// Embedding runs in-process. To keep it from freezing the UI, two things work
// together: the ingest loop yields the event loop between embeds (so a pass
// never starves IPC), and each pass is bounded (`run` reports `more` when it hit
// its cap). When there's more backlog we reschedule a quick follow-up rather
// than waiting the full interval — so a first index over months of history
// trickles in as short, responsive bursts instead of one long grind.

export interface IndexRunResult {
  ranAt: number
  written: number
  more?: boolean // the pass stopped at its cap; backlog remains to drain
  error?: string
}

interface IndexerConfig {
  run: () => Promise<{ written: number; more?: boolean }>
  /** Optional cheap pass run on a faster cadence (#2): typically a freshness-
   *  limited ingest of only the active session, so new turns become searchable in
   *  seconds instead of waiting the full interval. */
  fastRun?: () => Promise<{ written: number; more?: boolean }>
  log?: (msg: string) => void
  drainDelayMs: number
}

const DEFAULT_INTERVAL_MS = 30 * 60_000 // every 30 min, like a quiet autosync
const DEFAULT_INITIAL_DELAY_MS = 10_000 // 10s after launch, once the app settles
const DEFAULT_DRAIN_DELAY_MS = 3_000 // when a pass hit its cap, continue draining soon — not in 30 min

let config: IndexerConfig | null = null
let interval: ReturnType<typeof setInterval> | null = null
let fastInterval: ReturnType<typeof setInterval> | null = null
let initial: ReturnType<typeof setTimeout> | null = null
let drain: ReturnType<typeof setTimeout> | null = null
let running = false

/** Run one ingestion pass now. No-op (with a reason) if busy or not started. */
export async function tick(fast = false): Promise<IndexRunResult> {
  if (!config) return { ranAt: Date.now(), written: 0, error: 'not started' }
  if (running) return { ranAt: Date.now(), written: 0, error: 'busy' }
  const runner = fast ? config.fastRun : config.run
  if (!runner) return { ranAt: Date.now(), written: 0, error: 'no runner' }
  running = true
  try {
    const r = await runner()
    config.log?.(`memory indexer${fast ? ' (fast)' : ''}: +${r.written} new chunks${r.more ? ' (more queued)' : ''}`)
    return { ranAt: Date.now(), written: r.written, more: r.more }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    config.log?.(`memory indexer${fast ? ' (fast)' : ''} error: ${msg}`)
    return { ranAt: Date.now(), written: 0, error: msg }
  } finally {
    running = false
  }
}

// Timer-driven pass. Unlike a manual tick(), this self-schedules a fast
// follow-up while a bulk backlog is still draining. Manual tick() stays pure so
// tests/callers don't get surprise timers.
async function scheduledTick(fast = false): Promise<void> {
  const r = await tick(fast)
  if (r.more && config) scheduleDrain()
}

function scheduleDrain(): void {
  if (drain) clearTimeout(drain)
  drain = setTimeout(() => void scheduledTick(), config?.drainDelayMs ?? DEFAULT_DRAIN_DELAY_MS)
  if (drain && typeof (drain as { unref?: () => void }).unref === 'function') (drain as { unref: () => void }).unref()
}

export function startIndexer(
  cfg: { run: () => Promise<{ written: number; more?: boolean }>; fastRun?: () => Promise<{ written: number; more?: boolean }>; log?: (msg: string) => void; intervalMs?: number; fastIntervalMs?: number; initialDelayMs?: number; drainDelayMs?: number },
): void {
  stopIndexer()
  config = { run: cfg.run, fastRun: cfg.fastRun, log: cfg.log, drainDelayMs: cfg.drainDelayMs ?? DEFAULT_DRAIN_DELAY_MS }
  initial = setTimeout(() => void scheduledTick(), cfg.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS)
  interval = setInterval(() => void scheduledTick(), cfg.intervalMs ?? DEFAULT_INTERVAL_MS)
  // Optional fast tier (#2): a cheap freshness-limited pass on a short cadence so
  // the ACTIVE session is searchable in seconds, not after the full interval.
  if (cfg.fastRun && cfg.fastIntervalMs) {
    fastInterval = setInterval(() => void scheduledTick(true), cfg.fastIntervalMs)
    if (fastInterval && typeof (fastInterval as { unref?: () => void }).unref === 'function') (fastInterval as { unref: () => void }).unref()
  }
  // Don't keep the process alive just for the indexer (Node refs).
  if (initial && typeof (initial as { unref?: () => void }).unref === 'function') (initial as { unref: () => void }).unref()
  if (interval && typeof (interval as { unref?: () => void }).unref === 'function') (interval as { unref: () => void }).unref()
}

export function stopIndexer(): void {
  if (interval) clearInterval(interval)
  if (fastInterval) clearInterval(fastInterval)
  if (initial) clearTimeout(initial)
  if (drain) clearTimeout(drain)
  interval = null
  fastInterval = null
  initial = null
  drain = null
}

export function isIndexing(): boolean {
  return running
}

export function _resetIndexerForTests(): void {
  stopIndexer()
  running = false
  config = null
}
