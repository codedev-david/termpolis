// v1.54.5 (typing hotfix, package P6): keep the memory store off the MAIN thread when it is big.
//
// memoryClient used to answer EVERY way the memory host can fail (a spawn that throws, an init error,
// an exit before ready, the 120 s ready timeout, a crash loop) by loading the whole store inside the
// main process, and it never went back. That load is synchronous: 4.3 s on a 475 MB store,
// rebuildVectorIndex up to 18.8 s, on the thread that paints the window and echoes every keystroke.
// A CPU-starved machine makes a slow or failed host start an ordinary event, so it turned straight
// into seconds of frozen typing.
//
// Above a size limit the client now says "unavailable" and retries in the background instead. This
// module holds the deterministic parts so each can be pinned by a test and none of them needs
// Electron: the limit and its kill switch, the size probe, the backoff, the one fixed sentence an
// agent sees, and the small record the Settings panel reads.
//
// It deliberately imports nothing but fs and path. src/main/index.ts and mcpServer.ts import it
// directly (the IPC status payload and the MCP error filter), and the suites that mock memoryClient
// wholesale must keep working with no mock edits.

import * as fs from 'fs'
import * as path from 'path'

const MB = 1024 * 1024

// ── The limit and its kill switch ────────────────────────────────────────────────────────────────

/** Above this many bytes of store on disk, a memory host that cannot serve is never replaced by
 *  loading the store in the main process. 256 MB is about 2.3 s of synchronous main-thread work at
 *  the measured 9 ms per MB, before the index rebuild on top. */
export const DEFAULT_INPROC_MAX_BYTES = 256 * MB

/** Kill switch. "0", "off", "false" or "no" (any case) brings back the old behaviour exactly: any
 *  failure of the host loads the store on the main thread, however big it is. */
export const GUARD_ENV = 'TERMPOLIS_MEMORY_INPROC_GUARD'

/** The limit in MB, fractions allowed. Anything that is not a positive, finite number is ignored. */
export const LIMIT_ENV = 'TERMPOLIS_MEMORY_INPROC_MAX_MB'

export interface InprocGuard {
  enabled: boolean
  maxBytes: number
}

export function resolveInprocGuard(env: Record<string, string | undefined> = process.env): InprocGuard {
  const sw = (env[GUARD_ENV] ?? '').trim().toLowerCase()
  const enabled = !(sw === '0' || sw === 'off' || sw === 'false' || sw === 'no')
  const mb = Number((env[LIMIT_ENV] ?? '').trim())
  const maxBytes = Number.isFinite(mb) && mb > 0 ? Math.floor(mb * MB) : DEFAULT_INPROC_MAX_BYTES
  return { enabled, maxBytes }
}

// ── The size of the store on disk ────────────────────────────────────────────────────────────────

// The device's own log: swarm-memory.jsonl plus its rotated generations swarm-memory.<n>.jsonl. Digits
// only, so swarm-memory.archive.jsonl (the cold archive, not loaded at init) is never counted, and
// neither is any other .jsonl that lives in the same folder (agent-events.jsonl, audit logs...).
const OWN_SHARD = /^swarm-memory(\.\d+)?\.jsonl$/

/**
 * How many bytes of memory store the host would load, counted the way swarmMemory.shardFiles() picks
 * its files: in local mode the own shard set; with a sync folder every *.jsonl in it, peers' too.
 *
 * Async on purpose: this runs while the app is starting, beside the host's own spawn, and must never
 * add a synchronous file call to the main thread. Resolves null when it cannot tell (a folder that
 * will not list), and the caller then fails OPEN to the old behaviour. A shard that disappears between
 * the listing and the stat (a compaction swap) counts as nothing.
 */
export async function measureMemoryStoreBytes(userDataPath: string, syncDir: string | null): Promise<number | null> {
  try {
    const dir = syncDir || userDataPath
    const names = await fs.promises.readdir(dir)
    const shards = syncDir ? names.filter((n) => n.endsWith('.jsonl')) : names.filter((n) => OWN_SHARD.test(n))
    let total = 0
    for (const n of shards) {
      try { total += (await fs.promises.stat(path.join(dir, n))).size } catch { /* gone since the listing */ }
    }
    return total
  } catch {
    return null
  }
}

// ── The retry schedule ───────────────────────────────────────────────────────────────────────────

/** First wait before a retry. A start forks a process (10-283 ms of main thread, measured here) and
 *  the child then loads the whole store, so retries must not come fast on a starved machine. */
export const RETRY_BASE_MS = 10_000
/** The longest wait between two retries. */
export const RETRY_CAP_MS = 300_000

/** Capped exponential backoff: 10 s, 20 s, 40 s, 80 s, 160 s, then 300 s. `attempt` is the number of
 *  starts that have failed in a row (1 after the first failure). */
export function retryDelayMs(attempt: number): number {
  const a = Number.isNaN(attempt) ? 1 : Math.max(1, Math.floor(attempt))
  return Math.min(RETRY_BASE_MS * 2 ** (a - 1), RETRY_CAP_MS)
}

/** How long a RETRY may take to report ready: base x (1 + failures so far), at most 5 x base. A store
 *  that needs longer than the first start's allowance on a starved machine must be able to finish, or
 *  "unavailable" would never end; nobody waits on a retry (calls fail fast), so the extra time is free. */
export function retryReadyTimeoutMs(baseMs: number, attempt: number): number {
  const a = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0
  return Math.min(baseMs * (1 + a), baseMs * 5)
}

// ── What an agent is told ────────────────────────────────────────────────────────────────────────

/** mcpServer lets a message through to the agent when it starts with this. Everything else about a
 *  memory failure can carry internals (a path, an exit code) and is flattened to "Tool execution
 *  failed". */
export const UNAVAILABLE_PREFIX = 'Memory is unavailable ('

/** Fixed text, nothing internal in it: the agent needs to learn that nothing was read or saved (an
 *  empty answer would read as "no memories"), that this will pass, and where a person can look. */
export function unavailableMessage(): string {
  return `${UNAVAILABLE_PREFIX}retrying): the memory process is not running, so nothing was read and nothing was saved. `
    + 'Termpolis is restarting it in the background; try again in a minute, or open Settings, Memory & Learning to see its state.'
}

export function isMemoryUnavailableMessage(message: unknown): boolean {
  return typeof message === 'string' && message.startsWith(UNAVAILABLE_PREFIX)
}

// ── What the Settings panel reads ────────────────────────────────────────────────────────────────

export interface MemoryUnavailableState {
  /** Starts that have failed in a row (1 = the first one). */
  attempt: number
  /** When the next try is due (epoch ms); null while one is running. */
  nextRetryAt: number | null
  retrying: boolean
  /** The store on disk, if it could be measured. */
  storeBytes: number | null
  limitBytes: number
  /** The last failure, in a sentence. */
  reason: string
  since: number
}

export interface MemoryUnavailableInfo {
  attempt: number
  retrying: boolean
  /** Milliseconds to the next try; null while one is running. */
  retryInMs: number | null
  storeMB: number | null
  limitMB: number
  reason: string
}

let state: MemoryUnavailableState | null = null

/** memoryClient writes this whenever the unavailable state changes, and clears it (null) when memory is
 *  back, when the store falls back in-process after all, or at quit. */
export function setMemoryUnavailableState(next: MemoryUnavailableState | null): void {
  state = next ? { ...next } : null
}

/** True while memory is unavailable (mode 'unavailable'). For a caller that would otherwise turn a failed
 *  search into an empty answer (the primer), so it can say so instead. */
export function isMemoryUnavailable(): boolean {
  return state !== null
}

const REASON_MAX = 200

/** The status record, or {} when memory is not unavailable (so the IPC payload spreading it is byte for
 *  byte what it was before). A fresh object every call. */
export function memoryUnavailableInfo(now: number = Date.now()): Partial<MemoryUnavailableInfo> {
  if (!state) return {}
  const s = state
  return {
    attempt: s.attempt,
    retrying: s.retrying,
    retryInMs: s.nextRetryAt === null ? null : Math.max(0, s.nextRetryAt - now),
    storeMB: s.storeBytes === null ? null : Math.round(s.storeBytes / MB),
    limitMB: Math.round(s.limitBytes / MB),
    reason: s.reason.length > REASON_MAX ? `${s.reason.slice(0, REASON_MAX)}…` : s.reason,
  }
}
