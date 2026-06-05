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
  log?: (msg: string) => void
  drainDelayMs: number
}

const DEFAULT_INTERVAL_MS = 30 * 60_000 // every 30 min, like a quiet autosync
const DEFAULT_INITIAL_DELAY_MS = 10_000 // 10s after launch, once the app settles
const DEFAULT_DRAIN_DELAY_MS = 3_000 // when a pass hit its cap, continue draining soon — not in 30 min

let config: IndexerConfig | null = null
let interval: ReturnType<typeof setInterval> | null = null
let initial: ReturnType<typeof setTimeout> | null = null
let drain: ReturnType<typeof setTimeout> | null = null
let running = false

/** Run one ingestion pass now. No-op (with a reason) if busy or not started. */
export async function tick(): Promise<IndexRunResult> {
  if (!config) return { ranAt: Date.now(), written: 0, error: 'not started' }
  if (running) return { ranAt: Date.now(), written: 0, error: 'busy' }
  running = true
  try {
    const r = await config.run()
    config.log?.(`memory indexer: +${r.written} new chunks${r.more ? ' (more queued)' : ''}`)
    return { ranAt: Date.now(), written: r.written, more: r.more }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    config.log?.(`memory indexer error: ${msg}`)
    return { ranAt: Date.now(), written: 0, error: msg }
  } finally {
    running = false
  }
}

// Timer-driven pass. Unlike a manual tick(), this self-schedules a fast
// follow-up while a bulk backlog is still draining. Manual tick() stays pure so
// tests/callers don't get surprise timers.
async function scheduledTick(): Promise<void> {
  const r = await tick()
  if (r.more && config) scheduleDrain()
}

function scheduleDrain(): void {
  if (drain) clearTimeout(drain)
  drain = setTimeout(() => void scheduledTick(), config?.drainDelayMs ?? DEFAULT_DRAIN_DELAY_MS)
  if (drain && typeof (drain as { unref?: () => void }).unref === 'function') (drain as { unref: () => void }).unref()
}

export function startIndexer(
  cfg: { run: () => Promise<{ written: number; more?: boolean }>; log?: (msg: string) => void; intervalMs?: number; initialDelayMs?: number; drainDelayMs?: number },
): void {
  stopIndexer()
  config = { run: cfg.run, log: cfg.log, drainDelayMs: cfg.drainDelayMs ?? DEFAULT_DRAIN_DELAY_MS }
  initial = setTimeout(() => void scheduledTick(), cfg.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS)
  interval = setInterval(() => void scheduledTick(), cfg.intervalMs ?? DEFAULT_INTERVAL_MS)
  // Don't keep the process alive just for the indexer (Node refs).
  if (initial && typeof (initial as { unref?: () => void }).unref === 'function') (initial as { unref: () => void }).unref()
  if (interval && typeof (interval as { unref?: () => void }).unref === 'function') (interval as { unref: () => void }).unref()
}

export function stopIndexer(): void {
  if (interval) clearInterval(interval)
  if (initial) clearTimeout(initial)
  if (drain) clearTimeout(drain)
  interval = null
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
