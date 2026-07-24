// cron.ts — a minimal, dependency-free 5-field cron parser for `schedule`
// triggers. Deliberately tiny: we accept the subset of crontab syntax people
// actually type (`*`, `*/n`, `a`, `a-b`, `a-b/n`, comma lists) plus the common
// `@daily`-style aliases, and reject everything else rather than guessing.
//
// Time is never read in here — the caller injects `nowMs`/`Date` so the
// scheduler stays deterministic under test.

export interface CronFields {
  min: Set<number>
  hour: Set<number>
  dom: Set<number>
  mon: Set<number>
  dow: Set<number>
  /** Vixie-cron day semantics: when BOTH dom and dow are restricted, a date
   *  matches if EITHER field matches (not both). Tracked here so `cronMatches`
   *  can apply the rule without re-parsing. */
  domRestricted: boolean
  dowRestricted: boolean
}

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
}

/** Expand one crontab field into the set of values it matches, or null if the
 *  field is malformed. `lo`/`hi` bound the legal range for that column. */
function parseField(raw: string, lo: number, hi: number): Set<number> | null {
  const out = new Set<number>()
  for (const part of raw.split(',')) {
    const piece = part.trim()
    if (!piece) return null
    const [rangeRaw, stepRaw, ...extra] = piece.split('/')
    if (extra.length) return null
    let step = 1
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw)) return null
      step = Number(stepRaw)
      if (step < 1) return null
    }
    let from: number
    let to: number
    if (rangeRaw === '*') {
      from = lo
      to = hi
    } else if (/^\d+$/.test(rangeRaw)) {
      from = Number(rangeRaw)
      // A bare number with a step (`5/15`) means "from 5 to the end of range".
      to = stepRaw === undefined ? from : hi
    } else {
      const m = /^(\d+)-(\d+)$/.exec(rangeRaw)
      if (!m) return null
      from = Number(m[1])
      to = Number(m[2])
    }
    if (from < lo || to > hi || from > to) return null
    for (let v = from; v <= to; v += step) out.add(v)
  }
  return out.size ? out : null
}

/** Parse a cron expression. Returns null when the expression is invalid — the
 *  caller surfaces that as "this workflow never fires" rather than throwing. */
export function parseCron(expr: string): CronFields | null {
  if (typeof expr !== 'string') return null
  const trimmed = expr.trim().toLowerCase()
  if (!trimmed) return null
  const resolved = ALIASES[trimmed] ?? trimmed
  const cols = resolved.split(/\s+/)
  if (cols.length !== 5) return null
  const min = parseField(cols[0], 0, 59)
  const hour = parseField(cols[1], 0, 23)
  const dom = parseField(cols[2], 1, 31)
  const mon = parseField(cols[3], 1, 12)
  const dowRaw = parseField(cols[4], 0, 7)
  if (!min || !hour || !dom || !mon || !dowRaw) return null
  // Cron allows 7 as a second spelling of Sunday; normalize so matching only
  // ever compares against JS `getDay()` values (0-6).
  const dow = new Set<number>()
  for (const d of dowRaw) dow.add(d === 7 ? 0 : d)
  return {
    min,
    hour,
    dom,
    mon,
    dow,
    domRestricted: cols[2] !== '*',
    dowRestricted: cols[4] !== '*',
  }
}

/** Does this local-time date fall on a cron occurrence? Second/ms are ignored:
 *  cron granularity is one minute. */
export function cronMatches(f: CronFields, d: Date): boolean {
  if (!f.min.has(d.getMinutes())) return false
  if (!f.hour.has(d.getHours())) return false
  if (!f.mon.has(d.getMonth() + 1)) return false
  const domHit = f.dom.has(d.getDate())
  const dowHit = f.dow.has(d.getDay())
  // Both restricted → OR them (Vixie semantics). Otherwise the restricted one
  // decides, and an unrestricted field is always a hit by construction.
  if (f.domRestricted && f.dowRestricted) return domHit || dowHit
  return domHit && dowHit
}

/** How far back `dueSince` will look for a missed occurrence. Bounds the walk
 *  so a workflow untouched for a year can't spin through half a million
 *  minutes at boot — 14 days of catch-up is well past useful. */
export const MAX_CATCHUP_MS = 14 * 24 * 60 * 60 * 1000
const MINUTE = 60_000

/**
 * Did a cron occurrence fall in `(lastMs, nowMs]`? This is the whole catch-up
 * mechanism: the scheduler stores when a workflow last fired, and on every tick
 * (including the first one after launch) asks whether the app slept through a
 * scheduled slot. Walks minute boundaries, so cost is bounded by the window,
 * and the window is bounded by MAX_CATCHUP_MS.
 */
export function dueSince(f: CronFields, lastMs: number, nowMs: number, maxLookbackMs = MAX_CATCHUP_MS): boolean {
  if (!Number.isFinite(lastMs) || !Number.isFinite(nowMs)) return false
  if (nowMs <= lastMs) return false
  const floor = Math.max(lastMs, nowMs - maxLookbackMs)
  // Start at the first minute boundary strictly after `floor` — an occurrence
  // exactly at `lastMs` already fired and must not fire twice.
  let cursor = Math.floor(floor / MINUTE) * MINUTE + MINUTE
  for (; cursor <= nowMs; cursor += MINUTE) {
    if (cronMatches(f, new Date(cursor))) return true
  }
  return false
}
