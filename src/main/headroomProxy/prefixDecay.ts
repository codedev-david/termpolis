/**
 * Prefix decay — aging out the oldest bulk in a long conversation.
 *
 * Compression normally leaves the cached prefix byte-identical turn over turn, which is what makes
 * it free. Decay deliberately breaks that: it reaches back into history the app has already sent
 * and shrinks it further. That is only ever worth doing when the arithmetic says so, so the
 * arithmetic is written down here rather than assumed.
 *
 * ## What a cache break costs
 *
 * Anthropic bills a matching cached prefix at 0.1x and a cache write at 1.25x. Changing a byte at
 * position X forces everything after X to be re-written instead of re-read, so the marginal cost
 * of one decay pass is `1.15 x prefixTokens`. On this app's measured traffic (~68,000 cache-read
 * tokens per request) that is roughly 78,000 effective units — an enormous single-turn charge.
 *
 * ## What it earns
 *
 * A pass that removes R tokens makes every LATER turn's prefix R tokens smaller, worth `0.1 x R`
 * per turn. Break-even is therefore `11.5 x prefixTokens / R` turns. At a 68,000-token prefix,
 * removing 20,000 tokens pays for itself in ~39 more turns; removing 5,000 needs ~156.
 *
 * ## Why the thresholds double
 *
 * The cutoff must be a function of the body alone (no cross-request state) or the transform stops
 * being deterministic. It must also be STICKY, because a cutoff that advanced by one message per
 * turn would re-cut the prefix on every request and bust the cache every single time — strictly
 * worse than never decaying at all.
 *
 * Doubling boundaries give both. The cutoff changes only when the message count crosses 64, 128,
 * 256, ... and holds constant in between, so the compressed prefix is byte-stable between
 * thresholds. It also means each pass is followed by an interval as long as everything before it,
 * which is exactly the payoff period the break-even calculation needs. A 256-message session pays
 * for three cache breaks, not two hundred.
 *
 * Even so this ships OFF by default. The payoff is a bet that the session keeps going, and a
 * session that ends right after a threshold pays the break and collects nothing.
 */

import crypto from 'crypto'

/** Messages before which decay starts applying at all. Below this a break can't repay itself. */
export const DECAY_FIRST_THRESHOLD = 64
/** Blocks smaller than this are left alone: the stub itself costs ~30 tokens. */
export const DECAY_MIN_CHARS = 600
/**
 * tool_use keys that NAME a thing rather than carry content. Same exclusion the live compressor
 * makes: a truncated path or URL is actively misleading, where an aged-out file body is merely
 * shorter and recoverable.
 */
const DECAY_SKIP_KEYS = new Set(['file_path', 'path', 'notebook_path', 'url', 'pattern', 'glob'])

/** Effective-cost weights, from Anthropic's published multipliers. */
const CACHE_READ_W = 0.1
const CACHE_WRITE_W = 1.25

/**
 * How many more turns a decay pass must survive to pay for the cache break it causes.
 * Exported because it is the number that decides whether this feature is worth enabling, and it
 * should be checkable rather than folded invisibly into a constant.
 */
export function breakEvenTurns(prefixTokens: number, removedTokens: number): number {
  if (!(removedTokens > 0) || !Number.isFinite(prefixTokens) || !Number.isFinite(removedTokens)) return Infinity
  return (prefixTokens * (CACHE_WRITE_W - CACHE_READ_W)) / (removedTokens * CACHE_READ_W)
}

/**
 * Index before which messages are aged out, given the conversation length.
 * Constant between doubling boundaries — see the note above on stickiness.
 */
export function decayCutoff(messageCount: number): number {
  if (!Number.isFinite(messageCount) || messageCount < DECAY_FIRST_THRESHOLD) return 0
  const steps = Math.floor(Math.log2(messageCount / DECAY_FIRST_THRESHOLD))
  const threshold = DECAY_FIRST_THRESHOLD * Math.pow(2, steps)
  return Math.floor(threshold / 2)
}

function decayToken(s: string): string {
  return 'hr_' + crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)
}

function stubFor(text: string, stashes: Array<{ token: string; original: string }>): string {
  const token = decayToken(text)
  stashes.push({ token, original: text })
  return `[headroom] Aged out of this conversation's active context — call the retrieve_full tool with token "${token}" to expand it.`
}

export interface DecayCounts { blocks: number; origChars: number; compChars: number }

/**
 * Replace large text in messages older than the cutoff with a retrievable stub, in place.
 * Returns what was removed. Pure with respect to the body: the same messages array always decays
 * the same way, because the cutoff is derived from its own length.
 */
export function applyPrefixDecay(
  messages: Array<{ content?: unknown }>,
  stashes: Array<{ token: string; original: string }>,
): DecayCounts {
  const counts: DecayCounts = { blocks: 0, origChars: 0, compChars: 0 }
  const cutoff = decayCutoff(messages.length)
  for (let i = 0; i < cutoff; i++) {
    const m = messages[i]
    if (!m || !Array.isArray(m.content)) continue
    for (const b of m.content as Array<Record<string, unknown>>) {
      if (!b || typeof b !== 'object') continue
      // thinking blocks carry a signature Anthropic validates — never touched, at any age.
      if (b.type === 'tool_result') {
        if (typeof b.content === 'string' && b.content.length >= DECAY_MIN_CHARS) {
          counts.blocks++; counts.origChars += b.content.length
          b.content = stubFor(b.content, stashes)
          counts.compChars += (b.content as string).length
        } else if (Array.isArray(b.content)) {
          for (const item of b.content as Array<Record<string, unknown>>) {
            if (item && item.type === 'text' && typeof item.text === 'string' && item.text.length >= DECAY_MIN_CHARS) {
              counts.blocks++; counts.origChars += item.text.length
              item.text = stubFor(item.text, stashes)
              counts.compChars += (item.text as string).length
            }
          }
        }
      } else if (b.type === 'tool_use' && b.input && typeof b.input === 'object' && !Array.isArray(b.input)) {
        const rec = b.input as Record<string, unknown>
        for (const k of Object.keys(rec)) {
          if (DECAY_SKIP_KEYS.has(k)) continue
          const v = rec[k]
          if (typeof v === 'string' && v.length >= DECAY_MIN_CHARS) {
            counts.blocks++; counts.origChars += v.length
            rec[k] = stubFor(v, stashes)
            counts.compChars += (rec[k] as string).length
          }
        }
      }
    }
  }
  return counts
}
