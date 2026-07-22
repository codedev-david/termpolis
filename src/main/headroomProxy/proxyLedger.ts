import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { ccrPut } from '../headroom/ccrStore'
import type { ProxyResultMsg } from './proxySupervisor'

export interface ProxyTotals {
  requests: number
  textOrigTokens: number
  textSavedTokens: number
  images: number
  imageOrigBytes: number
  imageSavedBytes: number
  cacheReadTokens: number
  cacheCreationTokens: number
  inputTokens: number
  outputTokens: number
}
export interface ProxyReceipt {
  session: ProxyTotals & { savedPct: number }
  cumulative: ProxyTotals & { savedPct: number }
}

function empty(): ProxyTotals {
  return { requests: 0, textOrigTokens: 0, textSavedTokens: 0, images: 0, imageOrigBytes: 0, imageSavedBytes: 0, cacheReadTokens: 0, cacheCreationTokens: 0, inputTokens: 0, outputTokens: 0 }
}

let session = empty()
let base = empty() // cumulative baseline loaded from disk
let flush: (() => void) | null = null

export function setProxyLedgerFlush(fn: (() => void) | null): void { flush = fn }
export function loadProxyBase(b: Partial<ProxyTotals>): void { base = { ...empty(), ...b } }

/** Record one proxy /v1/messages result: accumulate real savings + usage, and make
 *  compressed originals retrievable via the retrieve_full MCP tool. Best-effort. */
export function recordProxyResult(r: ProxyResultMsg): void {
  const s = r.stats || ({} as ProxyResultMsg['stats'])
  const u = r.usage || ({} as ProxyResultMsg['usage'])
  session.requests += 1
  session.textOrigTokens += Math.ceil((s.trOrigChars || 0) / 4)
  session.textSavedTokens += Math.max(0, Math.ceil(((s.trOrigChars || 0) - (s.trCompChars || 0)) / 4))
  session.images += s.images || 0
  session.imageOrigBytes += s.imgOrigBytes || 0
  session.imageSavedBytes += Math.max(0, (s.imgOrigBytes || 0) - (s.imgCompBytes || 0))
  session.cacheReadTokens += u.cache_read_input_tokens || 0
  session.cacheCreationTokens += u.cache_creation_input_tokens || 0
  session.inputTokens += u.input_tokens || 0
  session.outputTokens += u.output_tokens || 0
  if (Array.isArray(r.stashes)) for (const st of r.stashes) { try { ccrPut(st.token, st.original) } catch { /* best effort */ } }
  try { flush?.() } catch { /* best effort */ }
}

function withPct(t: ProxyTotals): ProxyTotals & { savedPct: number } {
  const pct = t.textOrigTokens > 0 ? Math.round((t.textSavedTokens / t.textOrigTokens) * 100) : 0
  return { ...t, savedPct: pct }
}
function sumWithBase(): ProxyTotals {
  const cum = empty()
  for (const k of Object.keys(cum) as (keyof ProxyTotals)[]) cum[k] = base[k] + session[k]
  return cum
}

export function summarizeProxySavings(): ProxyReceipt {
  return { session: withPct(session), cumulative: withPct(sumWithBase()) }
}
export function currentProxyTotals(): ProxyTotals { return sumWithBase() }
export function loadProxyBaseFromDisk(dir: string): void {
  try { loadProxyBase(JSON.parse(readFileSync(join(dir, 'proxy-totals.json'), 'utf8'))) } catch { /* start at zero */ }
}
export function saveProxyTotalsToDisk(dir: string): void {
  try { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'proxy-totals.json'), JSON.stringify(currentProxyTotals()), 'utf8') } catch { /* best effort */ }
}
/** Zero the lifetime meter (session + on-disk base) WITHOUT dropping the flush wiring, so the
 *  ledger keeps persisting afterward. Used for a live "reset lifetime savings" (e.g. after a
 *  compression-methodology change) — unlike resetProxyLedger(), which also nulls flush for tests. */
export function resetProxyCounters(): void { session = empty(); base = empty() }
export function resetProxyLedger(): void { session = empty(); base = empty(); flush = null }
