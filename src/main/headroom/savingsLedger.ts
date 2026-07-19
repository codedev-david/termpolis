export interface LedgerEvent { tool: string; kind: 'compress' | 'retrieve'; savedTokens: number }
export interface SavingsTotals { netSaved: number; events: number; byTool: Record<string, number> }
export interface SavingsReceipt { session: SavingsTotals; cumulative: SavingsTotals }

function emptyTotals(): SavingsTotals { return { netSaved: 0, events: 0, byTool: {} } }

let session: SavingsTotals = emptyTotals()
// Cumulative baseline loaded from disk at startup (see index.ts init); session adds on top.
let cumulativeBase: SavingsTotals = emptyTotals()
let flush: (() => void) | null = null

/** Wire an async, best-effort persistence flush (called from main startup). */
export function setLedgerFlush(fn: (() => void) | null): void { flush = fn }
export function loadCumulativeBase(base: SavingsTotals): void { cumulativeBase = base }

export function recordEvent(ev: LedgerEvent): void {
  session.netSaved += ev.savedTokens
  session.events += 1
  session.byTool[ev.tool] = (session.byTool[ev.tool] ?? 0) + ev.savedTokens
  try { flush?.() } catch { /* best effort */ }
}

export function summarizeSavings(): SavingsReceipt {
  const cumulative: SavingsTotals = {
    netSaved: cumulativeBase.netSaved + session.netSaved,
    events: cumulativeBase.events + session.events,
    byTool: { ...cumulativeBase.byTool },
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
