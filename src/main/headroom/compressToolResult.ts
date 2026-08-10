import { estimateTokens } from '../memoryEconomy'
import { getSettings, thresholdsFor, MAX_COMPRESS_BYTES } from './config'
import { route } from './router'
import { compressArray, compressObject, type Compressed } from './compressors'
import { ccrStash, ccrRetrieveRecord } from './ccrStore'
import { recordEvent } from './savingsLedger'
import { recordProxyGiveback } from '../headroomProxy/proxyLedger'

function footer(token: string): string {
  return `\n\n[headroom] Full result cached — call the retrieve_full tool with token "${token}" to expand it.`
}

/**
 * Wraps a raw MCP tool result, returning the text the agent should receive.
 * Fail-open: any error returns the pretty-printed original. Never throws.
 */
export function compressToolResult(name: string, result: unknown): string {
  let pretty: string
  try {
    pretty = JSON.stringify(result, null, 2)
  } catch {
    // Non-serializable (e.g. circular) — hand back a safe string form.
    return String(result)
  }
  try {
    const settings = getSettings()
    if (!settings.enabled) return pretty
    const kind = route(name, result)
    if (kind === 'exempt') return pretty
    if (Buffer.byteLength(pretty, 'utf8') > MAX_COMPRESS_BYTES) return pretty // perf guard

    const origTokens = estimateTokens(pretty)
    const t = thresholdsFor(settings.mode)
    if (origTokens < t.floorTokens) return pretty // nothing to gain

    const c: Compressed = kind === 'array'
      ? compressArray(result as unknown[], t)
      : compressObject(result as Record<string, unknown>, t)

    let text = c.text
    let token: string | undefined
    if (c.offload !== undefined) { token = ccrStash(c.offload); text += footer(token) }

    const compTokens = estimateTokens(text)
    if (compTokens >= origTokens) return pretty // never inflate; don't leak a token

    recordEvent({ tool: name, kind: 'compress', savedTokens: origTokens - compTokens, origTokens })
    return text
  } catch {
    return pretty // fail-open
  }
}

/**
 * Inverse of compressToolResult: given an hr_ token from a [headroom] footer, return the full
 * original result. Records the give-back so net savings stays honest.
 *
 * The give-back is charged to the layer that ISSUED the token, not to whichever ledger happens
 * to be nearest. Nearly every token an agent redeems came from the wire proxy, and billing all
 * of them to the tool-layer ledger is exactly how the receipt came to read −4.6M against a real
 * +450M. Returns a clear message (never throws) on an unknown token.
 */
export function retrieveFull(token: string): unknown {
  const rec = ccrRetrieveRecord(token)
  if (rec === undefined) return { error: 'expired', message: 'This result has expired — re-run the original tool.' }
  try {
    const cost = estimateTokens(typeof rec.value === 'string' ? rec.value : JSON.stringify(rec.value, null, 2))
    if (rec.origin === 'proxy') recordProxyGiveback(cost)
    else recordEvent({ tool: 'retrieve_full', kind: 'retrieve', savedTokens: -cost })
  } catch { /* best effort */ }
  return rec.value
}
