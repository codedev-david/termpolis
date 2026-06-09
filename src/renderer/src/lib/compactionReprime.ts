// Compaction-aware re-primer (framework-free core).
//
// When Claude Code compacts its conversation it summarizes detail out of its context
// window to make room. That detail still lives in the local memory brain, so once the
// compaction settles we re-inject the most relevant memories and the agent picks right
// back up — the durable brain acts as the large working memory, the model's window
// holds only the active task. This module is the pure state machine (no React, no DOM)
// so every edge — arming, debounce, cooldown, gates — is deterministically testable.

import { COMPACTION_PATTERN } from './outputPatterns'

const SETTING_KEY = 'termpolis.memory.autoReprimeOnCompaction'

/** Auto re-prime after compaction is ON by default; users opt out in Settings. */
export function isAutoReprimeOnCompactionEnabled(): boolean {
  try {
    return localStorage.getItem(SETTING_KEY) !== '0'
  } catch {
    return true
  }
}

export function setAutoReprimeOnCompactionEnabled(on: boolean): void {
  try {
    localStorage.setItem(SETTING_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}

// The live "Compacting conversation…" UI redraws repeatedly (a ticking timer) for the
// whole multi-minute compaction, so we ARM on the marker and only fire once output has
// been QUIET for `quietMs` — i.e. compaction (and any immediate follow-up) has settled.
// A `cooldownMs` window then prevents a lingering marker in the scrollback from
// re-triggering, so each compaction re-primes exactly once.
export const DEFAULT_REPRIME_QUIET_MS = 3000
export const DEFAULT_REPRIME_COOLDOWN_MS = 60_000

export interface ReprimeController {
  /** Feed stripped terminal output (a chunk or the recent buffer). */
  onOutput(stripped: string): void
  /** Cancel any pending re-prime (call on teardown). */
  dispose(): void
}

export interface ReprimeOptions {
  /** Called when a settled compaction should be re-primed. */
  reprime: () => void
  /** Only re-prime while an AI agent is present in the terminal. Default: always. */
  hasAgent?: () => boolean
  /** Gate on the user setting at fire time (so toggling takes effect live). */
  isEnabled?: () => boolean
  /** Clock (injectable for tests). */
  now?: () => number
  quietMs?: number
  cooldownMs?: number
}

export function createReprimeController(opts: ReprimeOptions): ReprimeController {
  const quietMs = opts.quietMs ?? DEFAULT_REPRIME_QUIET_MS
  const cooldownMs = opts.cooldownMs ?? DEFAULT_REPRIME_COOLDOWN_MS
  const now = opts.now ?? (() => Date.now())
  const isEnabled = opts.isEnabled ?? isAutoReprimeOnCompactionEnabled
  const hasAgent = opts.hasAgent ?? (() => true)

  let armed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastReprimeAt = Number.NEGATIVE_INFINITY // "never re-primed" → no cooldown before the first

  function onOutput(stripped: string): void {
    if (!hasAgent()) return
    // Ignore everything for a cooldown after a re-prime so a marker still sitting in
    // the scrollback can't re-fire from the same compaction.
    if (now() - lastReprimeAt < cooldownMs) return
    if (COMPACTION_PATTERN.test(stripped)) armed = true
    if (!armed) return
    // Reset the quiet timer on every chunk — the compaction progress bar keeps
    // emitting, so this only elapses once it stops.
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      armed = false
      if (!isEnabled()) return // checked at fire time, not arm time
      lastReprimeAt = now()
      opts.reprime()
    }, quietMs)
  }

  function dispose(): void {
    if (timer) clearTimeout(timer)
    timer = null
    armed = false
  }

  return { onOutput, dispose }
}
