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
//
// P4 additions, each optional and each failing open to the behaviour above:
//   - drainRun: the follow-up of a pass that hit its cap is this INCREMENTAL tier (ingest only), not a whole
//     full pass again (which re-ran the planners, the rechecks and the index persist every 3 s);
//   - paused(): the "Learn from conversations" switch. Every timer asks it; while it is OFF no pass starts
//     and no follow-up is armed. A switch that cannot be read counts as ON;
//   - quiet(): the typing gate. A pass waits (bounded) until the user has stopped typing before it starts;
//   - every pass is counted (passCounters) and a pass that did something is logged with how many follow-ups
//     of a drain it was, so nobody has to guess whether a drain is running.

import { recordPass } from './passCounters'

export interface IndexRunResult {
  ranAt: number
  written: number
  more?: boolean // the pass stopped at its cap; backlog remains to drain
  error?: string
  /** Why nothing ran: the "Learn from conversations" switch is OFF. */
  skipped?: 'paused'
}

/** What a pass reports. `note` is a few counters for the log line ("files 9 skipped 40 8.0 MB"). */
interface RunResult {
  written: number
  more?: boolean
  note?: string
}

type Tier = 'full' | 'fast' | 'drain'

interface IndexerConfig {
  run: () => Promise<RunResult>
  /** Optional cheap pass run on a faster cadence (#2): typically a freshness-
   *  limited ingest of only the active session, so new turns become searchable in
   *  seconds instead of waiting the full interval. */
  fastRun?: () => Promise<RunResult>
  /** The follow-up of a pass that reported `more`: the incremental tier. Absent = the full `run` again, as before. */
  drainRun?: (info: { drainPass: number }) => Promise<RunResult>
  log?: (msg: string) => void
  drainDelayMs: number
  paused?: () => boolean
  quiet?: () => Promise<unknown>
}

const DEFAULT_INTERVAL_MS = 30 * 60_000 // every 30 min, like a quiet autosync
const DEFAULT_INITIAL_DELAY_MS = 10_000 // 10s after launch, once the app settles
const DEFAULT_DRAIN_DELAY_MS = 3_000 // when a pass hit its cap, continue draining soon — not in 30 min
const DEFAULT_NUDGE_MS = 5_000 // after the "Learn from conversations" switch goes back ON

const TIER_NUMBER: Record<Tier, number> = { full: 0, fast: 1, drain: 2 }

let config: IndexerConfig | null = null
let interval: ReturnType<typeof setInterval> | null = null
let fastInterval: ReturnType<typeof setInterval> | null = null
let initial: ReturnType<typeof setTimeout> | null = null
let drain: ReturnType<typeof setTimeout> | null = null
let nudge: ReturnType<typeof setTimeout> | null = null
let running = false
/** Follow-ups of the current drain so far: counted up by each drain pass, back to 0 when a pass reports no more. */
let drainPasses = 0

const unref = (t: unknown): void => {
  (t as { unref?: () => void } | null)?.unref?.()
}

/** Whether the switch is OFF. One that cannot be read is not "off": indexing is what it always was. */
function isPaused(): boolean {
  try {
    return config?.paused?.() === true
  } catch {
    return false
  }
}

/** Run one ingestion pass of a tier. */
async function runTier(tier: Tier): Promise<IndexRunResult> {
  const cfg = config
  if (!cfg) return { ranAt: Date.now(), written: 0, error: 'not started' }
  if (isPaused()) return { ranAt: Date.now(), written: 0, skipped: 'paused' }
  if (running) return { ranAt: Date.now(), written: 0, error: 'busy' }
  const runner = tier === 'fast' ? cfg.fastRun : tier === 'drain' ? cfg.drainRun : cfg.run
  if (!runner) return { ranAt: Date.now(), written: 0, error: 'no runner' }
  running = true
  const label = tier === 'fast' ? ' (fast)' : tier === 'drain' ? ' (drain)' : ''
  const startedAt = Date.now()
  try {
    // The typing gate: a pass does not start while the user is typing (bounded; it fails open).
    if (cfg.quiet) {
      try {
        await cfg.quiet()
      } catch {
        /* the pass goes ahead */
      }
      if (config !== cfg) return { ranAt: Date.now(), written: 0, error: 'stopped' }
      if (isPaused()) return { ranAt: Date.now(), written: 0, skipped: 'paused' }
    }
    let r: RunResult
    if (tier === 'drain') {
      drainPasses++
      r = await (runner as NonNullable<IndexerConfig['drainRun']>)({ drainPass: drainPasses })
    } else {
      r = await (runner as () => Promise<RunResult>)()
    }
    const passNo = tier === 'drain' ? drainPasses : 0
    if (!r.more) drainPasses = 0
    recordPass('indexer', { tier: TIER_NUMBER[tier], written: r.written, more: r.more ? 1 : 0, drainPasses: passNo, ms: Date.now() - startedAt })
    // A pass that did nothing says nothing: a line every 90 s forever would only be noise.
    if (r.written > 0 || r.more || r.note) {
      cfg.log?.(`memory indexer${label}: +${r.written} new chunks${r.more ? ' (more queued)' : ''}${tier === 'drain' ? ` drainPasses=${passNo}` : ''}${r.note ? ` [${r.note}]` : ''}`)
    }
    return { ranAt: Date.now(), written: r.written, more: r.more }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const failedAt = tier === 'drain' ? drainPasses : 0
    // A failed pass arms no follow-up, so the drain it belonged to is over.
    if (tier === 'drain') drainPasses = 0
    recordPass('indexer', { tier: TIER_NUMBER[tier], written: 0, more: 0, error: 1, drainPasses: failedAt, ms: Date.now() - startedAt })
    cfg.log?.(`memory indexer${label} error: ${msg}`)
    return { ranAt: Date.now(), written: 0, error: msg }
  } finally {
    running = false
  }
}

/** Run one ingestion pass now. No-op (with a reason) if busy, paused or not started. */
export async function tick(fast = false): Promise<IndexRunResult> {
  return runTier(fast ? 'fast' : 'full')
}

// Timer-driven pass. Unlike a manual tick(), this self-schedules a fast
// follow-up while a bulk backlog is still draining. Manual tick() stays pure so
// tests/callers don't get surprise timers.
async function scheduledTick(tier: Tier = 'full'): Promise<void> {
  const r = await runTier(tier)
  if (r.more && config && !isPaused()) scheduleDrain(config)
}

function scheduleDrain(cfg: IndexerConfig): void {
  if (drain) clearTimeout(drain)
  drain = setTimeout(() => void scheduledTick(cfg.drainRun ? 'drain' : 'full'), cfg.drainDelayMs)
  unref(drain)
}

/**
 * One pass soon, for after the "Learn from conversations" switch goes back ON (the timers kept running
 * while it was OFF, but each skipped its pass, so the next real one could be half an hour away). Repeated
 * calls are one pass; nothing happens while the switch is OFF or the indexer is not started.
 */
export function nudgeIndexer(delayMs: number = DEFAULT_NUDGE_MS): void {
  if (!config || nudge || isPaused()) return
  nudge = setTimeout(() => {
    nudge = null
    void scheduledTick('full')
  }, delayMs)
  unref(nudge)
}

export function startIndexer(
  cfg: {
    run: () => Promise<RunResult>
    fastRun?: () => Promise<RunResult>
    drainRun?: (info: { drainPass: number }) => Promise<RunResult>
    log?: (msg: string) => void
    paused?: () => boolean
    quiet?: () => Promise<unknown>
    intervalMs?: number
    fastIntervalMs?: number
    initialDelayMs?: number
    drainDelayMs?: number
  },
): void {
  stopIndexer()
  drainPasses = 0
  config = {
    run: cfg.run,
    fastRun: cfg.fastRun,
    drainRun: cfg.drainRun,
    log: cfg.log,
    paused: cfg.paused,
    quiet: cfg.quiet,
    drainDelayMs: cfg.drainDelayMs ?? DEFAULT_DRAIN_DELAY_MS,
  }
  initial = setTimeout(() => void scheduledTick(), cfg.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS)
  interval = setInterval(() => void scheduledTick(), cfg.intervalMs ?? DEFAULT_INTERVAL_MS)
  // Optional fast tier (#2): a cheap freshness-limited pass on a short cadence so
  // the ACTIVE session is searchable in seconds, not after the full interval.
  if (cfg.fastRun && cfg.fastIntervalMs) {
    fastInterval = setInterval(() => void scheduledTick('fast'), cfg.fastIntervalMs)
    unref(fastInterval)
  }
  // Don't keep the process alive just for the indexer (Node refs).
  unref(initial)
  unref(interval)
}

export function stopIndexer(): void {
  if (interval) clearInterval(interval)
  if (fastInterval) clearInterval(fastInterval)
  if (initial) clearTimeout(initial)
  if (drain) clearTimeout(drain)
  if (nudge) clearTimeout(nudge)
  interval = null
  fastInterval = null
  initial = null
  drain = null
  nudge = null
}

export function isIndexing(): boolean {
  return running
}

export function _resetIndexerForTests(): void {
  stopIndexer()
  running = false
  drainPasses = 0
  config = null
}
