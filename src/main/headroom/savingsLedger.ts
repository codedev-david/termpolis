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
  /** retrieve_full calls that resolved nothing — an elision we could not honour. Must stay 0. */
  retrieveMisses: number
  /** retrieve_full calls for a token shape we never mint. Not lost content; a prompting artefact. */
  retrieveBadTokens: number
}
export interface SavingsReceipt { session: SavingsTotals; cumulative: SavingsTotals }

function emptyTotals(): SavingsTotals {
  return { netSaved: 0, events: 0, byTool: {}, origTokens: 0, givebackTokens: 0, retrieves: 0, retrieveMisses: 0, retrieveBadTokens: 0 }
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
export function recordRetrieveFailure(kind: 'miss' | 'badToken'): void {
  if (kind === 'miss') session.retrieveMisses += 1
  else session.retrieveBadTokens += 1
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
