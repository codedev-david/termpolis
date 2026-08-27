import { summarizeSavings, type SavingsTotals } from './savingsLedger'
import { summarizeProxySavings, type ProxyTotals } from '../headroomProxy/proxyLedger'
import { billBreakdown, type BillBreakdown } from './effectiveUnits'
import { depthAdvice, type DepthAdvice } from './sessionDepth'

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
  /** The same activity priced in effective units. `savedPct` answers "how much of the text we were
   *  allowed to touch did we remove?"; this answers "how much of the invoice did that avoid?" —
   *  a much smaller number, and the only one that survives contact with a bill. */
  bill: BillBreakdown
  /** `retrieve_full` calls that found nothing. Must stay 0 — every elision is a promise that the
   *  original can be brought back, and a non-zero value here means content was destroyed. */
  retrieveMisses: number
  /** `retrieve_full` calls for a token shape this app never mints — a mistyped or invented handle.
   *  Kept apart from `retrieveMisses` because it says nothing about whether content survived. */
  retrieveBadTokens: number
  /** The prefix head, per request, in tokens: the system prompt and the tool schemas that sit in
   *  front of `messages` and are re-sent every turn. No compression layer touches them, which is
   *  precisely why they belong on the receipt — this is the part of the bill Headroom does NOT
   *  earn against, and hiding it would make every other number here look better than it is.
   *  `tpToolsTokensPerRequest` is the share Termpolis itself puts there. */
  sysTokensPerRequest: number
  toolsTokensPerRequest: number
  tpToolsTokensPerRequest: number
  toolCount: number
  /** Output steering, observed rather than asserted. Reported as two means so the reader can
   *  draw their own conclusion; it is not a controlled comparison and is never labelled a saving. */
  steeredRequests: number
  unsteeredRequests: number
  steeredAvgOutput: number
  unsteeredAvgOutput: number
}

/** `depth` is a sibling of the two totals rather than a field on them, deliberately: it is
 *  neither a session sum nor a lifetime sum. The curve behind it is lifetime, but the reading is
 *  about the conversation happening right now, and folding it into either bucket would invite
 *  someone to add it to something. */
export interface UnifiedReceipt { session: UnifiedTotals; cumulative: UnifiedTotals; depth: DepthAdvice | null }

/** Chars summed over N requests → tokens on a typical one. The ~4 chars/token ratio is the same
 *  estimate the rest of the wire layer uses; consistency matters more here than precision. */
function perRequestTokens(chars: number, requests: number): number {
  if (!(requests > 0)) return 0
  return Math.round(chars / requests / 4)
}
function mean(total: number, n: number): number {
  return n > 0 ? Math.round(total / n) : 0
}

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
    // Net, not gross: tokens handed back through retrieve_full were re-billed, and a savings
    // figure that ignores its own giveback is the same species of lie as a compressible-only
    // denominator. Only the proxy counters are priced here — the tool-layer ledger never touches
    // the wire, so its savings show up as prefix tokens that were never sent.
    bill: billBreakdown(proxy, netSavedTokens),
    retrieveMisses: tool.retrieveMisses,
    retrieveBadTokens: tool.retrieveBadTokens,
    sysTokensPerRequest: perRequestTokens(proxy.sysChars, proxy.requests),
    toolsTokensPerRequest: perRequestTokens(proxy.toolsChars, proxy.requests),
    tpToolsTokensPerRequest: perRequestTokens(proxy.tpToolsChars, proxy.requests),
    toolCount: proxy.maxToolCount,
    steeredRequests: proxy.steeredRequests,
    unsteeredRequests: proxy.unsteeredRequests,
    steeredAvgOutput: mean(proxy.steeredOutputTokens, proxy.steeredRequests),
    unsteeredAvgOutput: mean(proxy.unsteeredOutputTokens, proxy.unsteeredRequests),
  }
}

export function summarizeUnifiedSavings(): UnifiedReceipt {
  const p = summarizeProxySavings()
  const t = summarizeSavings()
  return { session: merge(p.session, t.session), cumulative: merge(p.cumulative, t.cumulative), depth: depthAdvice() }
}
