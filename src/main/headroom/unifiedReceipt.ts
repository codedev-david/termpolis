import { summarizeSavings, type SavingsTotals } from './savingsLedger'
import { summarizeProxySavings, type ProxyTotals } from '../headroomProxy/proxyLedger'

/**
 * ONE honest savings number.
 *
 * Token Headroom compresses on two independent surfaces — the wire proxy (every tool_result and
 * image on the way to Anthropic) and the MCP tool-output compressor (Termpolis's own tools) —
 * and until v1.34.0 each kept its own ledger with no view that summed them. The tool-layer
 * ledger was also charged for every `retrieve_full`, including the overwhelming majority whose
 * tokens the PROXY issued. The result was a Settings receipt reading −4,600,801 while the proxy
 * ledger next to it recorded +450,150,158 actually saved.
 *
 * This module is the single place that adds them up, with reversal cost subtracted exactly once.
 */
export interface UnifiedTotals {
  /** Inbound wire compression (the dominant term). */
  requests: number
  wireOrigTokens: number
  wireSavedTokens: number
  images: number
  imageOrigBytes: number
  imageSavedBytes: number
  /** Termpolis's own MCP tool outputs. */
  toolOrigTokens: number
  toolSavedTokens: number
  toolEvents: number
  byTool: Record<string, number>
  /** What reversing compression cost, summed across both layers. */
  retrieves: number
  givebackTokens: number
  /** The bottom line. */
  grossSavedTokens: number
  netSavedTokens: number
  savedPct: number
  /** Observed usage, straight off the wire — context for where the remaining spend actually is. */
  cacheReadTokens: number
  cacheCreationTokens: number
  inputTokens: number
  outputTokens: number
  /** The tool_use half of `wireOrigTokens`/`wireSavedTokens`, broken out so the dashboard can
   *  show which surface earned what instead of one blended figure. */
  toolUseOrigTokens: number
  toolUseSavedTokens: number
  /** Floor evidence — see ProxyTotals. A lifetime average cannot prove a per-request floor. */
  worstSavedPct: number
  belowFloorRequests: number
  floorEligibleRequests: number
}
export interface UnifiedReceipt { session: UnifiedTotals; cumulative: UnifiedTotals }

function merge(proxy: ProxyTotals, tool: SavingsTotals): UnifiedTotals {
  // The wire has TWO compressible surfaces: tool_result (what came back) and tool_use (what the
  // agent itself wrote, re-read from the prefix on every later turn). Reporting only the first
  // was accurate about a slice while implying it described the wire.
  const wireOrigTokens = proxy.textOrigTokens + proxy.toolUseOrigTokens
  const wireSavedTokens = proxy.textSavedTokens + proxy.toolUseSavedTokens
  const toolOrigTokens = tool.origTokens
  const toolSavedTokens = tool.netSaved
  const retrieves = proxy.retrieves + tool.retrieves
  const givebackTokens = proxy.givebackTokens + tool.givebackTokens
  const grossSavedTokens = wireSavedTokens + toolSavedTokens
  const netSavedTokens = grossSavedTokens - givebackTokens
  const denom = wireOrigTokens + toolOrigTokens
  return {
    requests: proxy.requests,
    wireOrigTokens,
    wireSavedTokens,
    images: proxy.images,
    imageOrigBytes: proxy.imageOrigBytes,
    imageSavedBytes: proxy.imageSavedBytes,
    toolOrigTokens,
    toolSavedTokens,
    toolEvents: tool.events,
    byTool: { ...tool.byTool },
    retrieves,
    givebackTokens,
    grossSavedTokens,
    netSavedTokens,
    savedPct: denom > 0 ? Math.round((netSavedTokens / denom) * 100) : 0,
    toolUseOrigTokens: proxy.toolUseOrigTokens,
    toolUseSavedTokens: proxy.toolUseSavedTokens,
    worstSavedPct: proxy.worstSavedPct,
    belowFloorRequests: proxy.belowFloorRequests,
    floorEligibleRequests: proxy.floorEligibleRequests,
    cacheReadTokens: proxy.cacheReadTokens,
    cacheCreationTokens: proxy.cacheCreationTokens,
    inputTokens: proxy.inputTokens,
    outputTokens: proxy.outputTokens,
  }
}

export function summarizeUnifiedSavings(): UnifiedReceipt {
  const p = summarizeProxySavings()
  const t = summarizeSavings()
  return { session: merge(p.session, t.session), cumulative: merge(p.cumulative, t.cumulative) }
}
