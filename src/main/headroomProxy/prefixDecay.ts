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
 * ## Why this now ships ON (v1.36.0)
 *
 * It shipped OFF for two releases, and the stated reason was that the payoff is a bet the session
 * keeps going: a session ending right after a threshold pays the break and collects nothing. That
 * reason was real but it was not the binding one. The binding one was that `retrieve_full` was
 * broken — the wire minted a stub token on the REQUEST path but only committed the original after
 * the response completed, so every redemption raced and lost. Decaying history to stubs nobody can
 * expand is not compression, it is data loss, and no threshold makes that trade good.
 *
 * v1.36.0 commits the stash before the upstream request is released, so a decayed block is now
 * genuinely recoverable. With a working escape hatch the only remaining question is the wager, and
 * the wager is priced: a pass costs ~1.15x prefixTokens (~87,000 effective units at this install's
 * measured 76,010 cached tokens/request) and returns ~0.1x the tokens it removed on every later
 * turn, so it repays in ~44 turns. Starting at 128 rather than 64 means the next boundary is 128
 * turns away — a ~3x margin — so the pass is ahead well before it could be stranded.
 */

import crypto from 'crypto'
import { isExempt } from '../headroom/router'
import { mapOutsideReminders } from './reminders'

/** Messages before which decay starts applying at all. Below this a break can't repay itself. */
export const DECAY_FIRST_THRESHOLD = 128
/** Blocks smaller than this are left alone: the stub itself costs ~30 tokens. */
export const DECAY_MIN_CHARS = 600
/**
 * Decay never touches a tool_use input, at any age — the same invariant the live compressor keeps
 * (see TOOL_USE_VERBATIM in wireCompress.ts). The model replays its own prior tool input as a
 * template, so a stub aged into one is copied into a real file, shell command or subagent prompt;
 * only tool_result text, which the model knows it can re-fetch, is aged out.
 */

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

export interface DecayCounts {
  blocks: number; origChars: number; compChars: number
  /** Always 0 — decay never touches tool_use input; kept for schema compatibility with WireStats. */
  tuBlocks: number; tuOrigChars: number; tuCompChars: number
}

/**
 * Stub every stretch of `text` outside a harness `<system-reminder>` that is big enough to be
 * worth it. A reminder is an instruction to the model riding inside the result, so age is no
 * reason to hide it; without one this is exactly the old whole-text stub.
 */
function decayText(text: string, stashes: Array<{ token: string; original: string }>, counts: DecayCounts): string {
  return mapOutsideReminders(text, (seg) => {
    if (seg.length < DECAY_MIN_CHARS) return { text: seg, changed: false }
    counts.blocks++; counts.origChars += seg.length
    const stub = stubFor(seg, stashes)
    counts.compChars += stub.length
    return { text: stub, changed: true }
  }).text
}

/**
 * Replace large tool_result text in messages older than the cutoff with a retrievable stub, in place.
 * Returns what was removed. Pure with respect to the body: the same messages array always decays
 * the same way, because the cutoff is derived from its own length.
 *
 * `resultToolName` names the tool a tool_result answers (the name lives on the tool_use, in an
 * earlier message). Results of exempt tools are never aged out — above all retrieve_full, whose
 * whole job is to hand back what compression took away: decaying it re-hid the content the model
 * had just asked for, and the model's only move was to ask again.
 */
export function applyPrefixDecay(
  messages: Array<{ content?: unknown }>,
  stashes: Array<{ token: string; original: string }>,
  resultToolName?: (toolUseId: string) => string | undefined,
): DecayCounts {
  const counts: DecayCounts = {
    blocks: 0, origChars: 0, compChars: 0, tuBlocks: 0, tuOrigChars: 0, tuCompChars: 0,
  }
  const cutoff = decayCutoff(messages.length)
  for (let i = 0; i < cutoff; i++) {
    const m = messages[i]
    if (!m || !Array.isArray(m.content)) continue
    for (const b of m.content as Array<Record<string, unknown>>) {
      if (!b || typeof b !== 'object') continue
      // Only tool_result text ages out. thinking blocks carry a signature Anthropic validates and
      // tool_use input is replayed by the model (see the note above) — neither is touched, at any age.
      if (b.type === 'tool_result') {
        const tool = typeof b.tool_use_id === 'string' ? resultToolName?.(b.tool_use_id) : undefined
        if (tool && isExempt(tool)) continue
        if (typeof b.content === 'string' && b.content.length >= DECAY_MIN_CHARS) {
          b.content = decayText(b.content, stashes, counts)
        } else if (Array.isArray(b.content)) {
          for (const item of b.content as Array<Record<string, unknown>>) {
            if (item && item.type === 'text' && typeof item.text === 'string' && item.text.length >= DECAY_MIN_CHARS) {
              item.text = decayText(item.text, stashes, counts)
            }
          }
        }
      }
    }
  }
  return counts
}
