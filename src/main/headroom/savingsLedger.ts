export interface LedgerEvent {
  tool: string
  kind: 'compress' | 'retrieve'
  /** Positive on compress, negative on retrieve (the give-back). */
  savedTokens: number
  /** Pre-compression size, so the receipt has an honest denominator. Compress events only. */
  origTokens?: number
}

/**
 * Tool-layer (Termpolis's own MCP tools) savings.
 *
 * v1.34.0 — `netSaved` is now GROSS compression savings. Give-backs used to be folded into it,
 * which is how the receipt came to read −4,600,801: every `retrieve_full` was charged here even
 * though the wire proxy is what issued the token, and the proxy's +450M never appeared in the
 * same number. Reversal cost now lives in `givebackTokens` and is charged to whichever layer
 * issued the token (see ccrStore's CcrOrigin), and the two layers are summed by unifiedReceipt.
 */
export interface SavingsTotals {
  netSaved: number
  events: number
  byTool: Record<string, number>
  origTokens: number
  givebackTokens: number
  retrieves: number
  /** retrieve_full calls for content this store HELD and then destroyed — an elision we could
   *  not honour. Must stay 0, and now says so on evidence rather than on the token's shape. */
  retrieveMisses: number
  /** retrieve_full calls for a token shape we never mint. Not lost content; a prompting artefact. */
  retrieveBadTokens: number
  /** retrieve_full calls for a well-shaped token we have no record of ever holding: a typo of a
   *  live token, a handle the model invented, or a stash that never landed. Tokens are content
   *  hashes, so this is indistinguishable BY SHAPE from a real one — which is exactly why it needs
   *  its own bucket instead of being counted as destroyed content. */
  retrieveUnknownTokens: number
  /** retrieve_full calls for content the disk cap aged out. A real loss, but a designed one —
   *  kept out of `retrieveMisses` so a cache that simply filled up cannot read as a defect. */
  retrieveExpired: number
}
export interface SavingsReceipt { session: SavingsTotals; cumulative: SavingsTotals }

function emptyTotals(): SavingsTotals {
  return { netSaved: 0, events: 0, byTool: {}, origTokens: 0, givebackTokens: 0, retrieves: 0, retrieveMisses: 0, retrieveBadTokens: 0, retrieveUnknownTokens: 0, retrieveExpired: 0 }
}

let session: SavingsTotals = emptyTotals()
// Cumulative baseline loaded from disk at startup (see index.ts init); session adds on top.
let cumulativeBase: SavingsTotals = emptyTotals()
let flush: (() => void) | null = null

/** Wire an async, best-effort persistence flush (called from main startup). */
export function setLedgerFlush(fn: (() => void) | null): void { flush = fn }

/**
 * Adopt an on-disk baseline, normalizing the PRE-1.34 shape.
 *
 * A legacy file recorded give-backs inside `netSaved` and `byTool.retrieve_full`. Loading that
 * verbatim would keep the historical −4.6M buried in what is now a gross-savings field, so a
 * negative `retrieve_full` entry is lifted out into `givebackTokens` where it belongs. The
 * bottom line is unchanged — only its attribution is.
 */
export function loadCumulativeBase(base: Partial<SavingsTotals>): void {
  const next: SavingsTotals = { ...emptyTotals(), ...base, byTool: { ...(base.byTool ?? {}) } }
  if (base.givebackTokens === undefined) {
    const legacy = next.byTool.retrieve_full
    if (typeof legacy === 'number' && legacy < 0) {
      next.givebackTokens = -legacy
      next.retrieves = next.retrieves || next.events
      next.netSaved -= legacy // remove the give-back from what is now a GROSS field
      delete next.byTool.retrieve_full
    }
  }
  // Pre-1.41.1 files counted a miss for ANY token of an issuable shape. That test cannot tell a
  // broken promise from a typo of a live token or from a stash that landed late — one recorded
  // miss on this install was booked at 22:37:20.889Z for content written at 22:37:20.891Z, two
  // milliseconds behind its own commit. Those counts are not evidence that anything was destroyed,
  // so they are re-filed under the bucket that matches what they actually prove rather than being
  // carried forward as an alarm or quietly dropped.
  if (base.retrieveUnknownTokens === undefined) {
    next.retrieveUnknownTokens = next.retrieveMisses
    next.retrieveMisses = 0
  }
  cumulativeBase = next
}

export function recordEvent(ev: LedgerEvent): void {
  session.events += 1
  if (ev.kind === 'retrieve') {
    session.givebackTokens += Math.max(0, -ev.savedTokens)
    session.retrieves += 1
  } else {
    session.netSaved += ev.savedTokens
    session.byTool[ev.tool] = (session.byTool[ev.tool] ?? 0) + ev.savedTokens
    session.origTokens += ev.origTokens ?? 0
  }
  try { flush?.() } catch { /* best effort */ }
}

/**
 * Record a retrieve_full that came back empty, split by whether the token was one we could have
 * issued. Kept in the ledger rather than read live off `ccrStats()` so the receipt's session and
 * cumulative columns mean what they say: a process-lifetime counter shown under "all time" made
 * every restart look like a clean slate, and every miss look like it had just happened.
 */
export function recordRetrieveFailure(kind: 'miss' | 'badToken' | 'unknown' | 'expired'): void {
  if (kind === 'miss') session.retrieveMisses += 1
  else if (kind === 'badToken') session.retrieveBadTokens += 1
  else if (kind === 'expired') session.retrieveExpired += 1
  else session.retrieveUnknownTokens += 1
  try { flush?.() } catch { /* best effort */ }
}

export function summarizeSavings(): SavingsReceipt {
  const cumulative: SavingsTotals = {
    netSaved: cumulativeBase.netSaved + session.netSaved,
    events: cumulativeBase.events + session.events,
    byTool: { ...cumulativeBase.byTool },
    origTokens: cumulativeBase.origTokens + session.origTokens,
    givebackTokens: cumulativeBase.givebackTokens + session.givebackTokens,
    retrieves: cumulativeBase.retrieves + session.retrieves,
    retrieveMisses: cumulativeBase.retrieveMisses + session.retrieveMisses,
    retrieveBadTokens: cumulativeBase.retrieveBadTokens + session.retrieveBadTokens,
    retrieveUnknownTokens: cumulativeBase.retrieveUnknownTokens + session.retrieveUnknownTokens,
    retrieveExpired: cumulativeBase.retrieveExpired + session.retrieveExpired,
  }
  for (const [k, v] of Object.entries(session.byTool)) {
    cumulative.byTool[k] = (cumulative.byTool[k] ?? 0) + v
  }
  return { session: { ...session, byTool: { ...session.byTool } }, cumulative }
}

export function resetLedger(): void {
  session = emptyTotals()
  cumulativeBase = emptyTotals()
  flush = null
}
