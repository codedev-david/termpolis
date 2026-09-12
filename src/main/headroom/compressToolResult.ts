import { estimateTokens } from '../memoryEconomy'
import { getSettings, thresholdsFor, MAX_COMPRESS_BYTES } from './config'
import { route } from './router'
import { compressArray, compressObject, type Compressed } from './compressors'
import { ccrStash, ccrRetrieveRecord, ccrMarkRedeemed, ccrIsIssuableToken, ccrNoteMiss } from './ccrStore'
import { logToApp } from '../appLog'
import { recordEvent, recordRetrieveFailure } from './savingsLedger'
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
/**
 * How long a redemption waits for a stash that may still be in flight.
 *
 * The wire proxy commits originals from the CHILD process over parentPort while `retrieve_full`
 * arrives on a loopback socket into MAIN: two independent queues with no ordering guarantee
 * between them. OBSERVED 2026-09-09: a redemption booked a miss at 22:37:20.889Z for a token whose
 * file was written at 22:37:20.891Z — it lost to its own commit by two milliseconds and reported
 * the content as permanently unrecoverable. 10 x 25 ms is a hundredfold margin on that, costs
 * nothing on the hit path, and is only ever paid on a redemption that was going to fail anyway.
 *
 * Counted in attempts rather than measured against a clock deliberately: everything under
 * src/main/headroom is swept by the cache-safety guard that forbids reading a clock here at all
 * (tests/electron/noNondeterministicCompression.test.ts), and a retry budget is the more honest
 * shape for this anyway — it cannot be skewed by a timer the event loop starved.
 */
const LATE_STASH_ATTEMPTS = 10
const LATE_STASH_POLL_MS = 25

export async function retrieveFull(token: string): Promise<unknown> {
  let rec = ccrRetrieveRecord(token)
  // Only a shape we could have minted is worth waiting for; anything else cannot be in flight.
  if (rec === undefined && ccrIsIssuableToken(token)) {
    for (let i = 0; i < LATE_STASH_ATTEMPTS && rec === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, LATE_STASH_POLL_MS))
      rec = ccrRetrieveRecord(token)
    }
  }
  if (rec === undefined) {
    // Classified once, after the wait, and only ever here — so the alarm counts redemptions that
    // failed, not lookups that were early.
    const kind = ccrNoteMiss(token)
    recordRetrieveFailure(
      kind === 'forgotten' ? 'miss' : kind === 'badShape' ? 'badToken' : kind === 'expired' ? 'expired' : 'unknown'
    )
    // The token is the whole diagnosis and it used to be dropped on the floor: the four misses that
    // prompted this work could only be investigated by reconstructing the handles from agent
    // transcripts. The app log stamps the time, which is the half the store cannot record itself —
    // and that stamp against the CCR file's mtime is exactly what exposed the 2 ms race above.
    logToApp('warn', 'main', [`[headroom] retrieve_full could not resolve ${token} (${kind})`])
    return { error: 'expired', message: 'This result has expired — re-run the original tool.' }
  }
  // Billed on the FIRST redemption only. One token stands for one compression event, so its
  // give-back can only be given back once — but an agent re-reads a token freely (a retry after a
  // failed turn, a second reference to the same result), and charging each of those reversed
  // savings that were never actually lost, which is what made the receipt read pessimistically low.
  if (ccrMarkRedeemed(token)) {
    try {
      const cost = estimateTokens(typeof rec.value === 'string' ? rec.value : JSON.stringify(rec.value, null, 2))
      if (rec.origin === 'proxy') recordProxyGiveback(cost)
      else recordEvent({ tool: 'retrieve_full', kind: 'retrieve', savedTokens: -cost })
    } catch { /* best effort */ }
  }
  return rec.value
}
