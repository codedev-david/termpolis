/**
 * When Token Headroom may shorten a tool result the first time the model sees it, and which
 * conversations are held out of that choice so its effect can be measured.
 *
 * WHY THERE IS A CHOICE. First-sight compaction replaces a tool result with a head and tail window
 * and a `retrieve_full` footer. That pays when the model never asks for the rest and loses when it
 * does, because a retrieval is a whole extra turn: the entire cached prefix is read again, about
 * 16,800 billed units on measured traffic. Until late August 2026 the model asked for about 13% of
 * shortened results; since Claude Code 2.1.247 it asks for about 66% (the compression research,
 * section 5). At that rate no class of result under roughly 40,000 characters pays for itself.
 *
 * `late` therefore leaves a tool result whole until it reaches 40,000 characters and shortens it
 * from there exactly as before. Everything else Token Headroom does (collapsing a repeat or a
 * near-repeat within one request, ageing out old history in a long conversation, scaling images) is
 * outside this choice and unchanged. `legacy` adds no floor of its own and is v1.54 to the byte.
 *
 * `late` only ever RAISES the floor: the one in force is the larger of the tier's own (1,600
 * characters at Aggressive) and the policy's, so a policy can never shorten more than the tier would
 * have, and the model sees at least what it saw before.
 *
 * Pure and clock-free, like everything the proxy child imports: no fs, no electron, no clock and no
 * random numbers (tests/electron/noNondeterministicCompression.test.ts sweeps this directory).
 */

export type FirstSightPolicy = 'late' | 'legacy'

export function isFirstSightPolicy(v: unknown): v is FirstSightPolicy {
  return v === 'late' || v === 'legacy'
}

/** The smallest tool result, in characters, that first-sight compaction may shorten under `late`. */
export const LATE_FLOOR_CHARS = 40_000

/**
 * Floors that differ from LATE_FLOOR_CHARS, by tool name or by model, empty until the elision ledger
 * shows a class that pays at a lower floor. Both lookups are exact. A value that is not a finite
 * number of at least zero is ignored, and zero means "no floor of its own": the tier decides.
 */
export interface FloorOverrides {
  byTool?: Readonly<Record<string, number>>
  byModel?: Readonly<Record<string, number>>
}
export const FLOOR_OVERRIDES: FloorOverrides = Object.freeze({})

export interface ElisionPolicy {
  readonly kind: FirstSightPolicy
  /** Characters below which first-sight compaction leaves this tool's results whole; 0 = the tier decides. */
  floorFor(toolName?: string): number
}

/** v1.54's behaviour: the tier's own floor and nothing more. */
export const LEGACY_POLICY: ElisionPolicy = Object.freeze({ kind: 'legacy' as const, floorFor: () => 0 })

function usableFloor(table: Readonly<Record<string, number>> | undefined, key: unknown): number | undefined {
  if (!table || typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(table, key)) return undefined
  const v = table[key]
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

/**
 * The policy a request runs under. `model` is the body's own `model` field, which is how a floor can
 * differ by model and stay a pure function of the body.
 */
export function policyFor(kind: FirstSightPolicy, model?: unknown, overrides: FloorOverrides = FLOOR_OVERRIDES): ElisionPolicy {
  if (kind !== 'late') return LEGACY_POLICY
  const modelFloor = usableFloor(overrides.byModel, model)
  return {
    kind,
    floorFor: (toolName) => usableFloor(overrides.byTool, toolName) ?? modelFloor ?? LATE_FLOOR_CHARS,
  }
}

/** The first-sight floor in force for one tool's result: the tier's, or the policy's if that is larger. */
export function effectiveFloor(tierFloorChars: number, policy: ElisionPolicy, toolName?: string): number {
  return Math.max(tierFloorChars, policy.floorFor(toolName))
}

/**
 * THE HOLDOUT. About one conversation in ten keeps running `legacy` while the rest run `late`, so
 * the two can be compared on the same person's own work afterwards (the Elision health card does
 * this). Without it the research's +11.7% would stay a model fitted to one history and could never
 * be checked on another.
 *
 * The arm is a function of the conversation's FIRST USER MESSAGE and of nothing else:
 *
 *  - It must not move during a conversation. The two arms transform the body differently, so an arm
 *    that flipped between turns would rewrite the cached prefix. The first message is the one part
 *    of the body that is identical on every turn.
 *  - Only the TEXT is read. Claude Code writes the same first message as a plain string on one turn
 *    and as a block carrying a cache breakpoint on another, may cut it into more blocks, and may add
 *    an image, so the characters of its text blocks are hashed end to end and nothing else is.
 *  - It is not read from the system prompt or the steering mark. That is how the output-steering
 *    experiment came to hold out 82.5% of requests against a design rate of 10% (section 9 of the
 *    research): most subagent requests do not carry the mark.
 *  - It is salted, so it is independent of the output-steering holdout (outputEconomy.assignArm)
 *    even though both hash the same kind of text.
 *
 * A conversation with nothing to hash stays on `late`, the default, rather than falling into the
 * holdout through the hash of an empty string. Total: it never throws.
 */
export const ELISION_HOLDOUT_RATE = 0.1
/**
 * Each arm is cut into this many groups of conversations by where the same hash falls inside it.
 * Requests of one conversation are alike, so counting every request as an independent sample would
 * make the comparison look surer than it is; the group is the unit its uncertainty is measured in
 * (armCompare.ts).
 */
export const ARM_CLUSTERS = 20
const ARM_SALT = 'termpolis/first-sight-arm/1'

/** The text of the first user message, in order, or null when it has none. */
function firstUserText(body: unknown): string[] | null {
  let obj = body
  if (typeof body === 'string') {
    try { obj = JSON.parse(body) } catch { return null }
  }
  const messages = (obj as { messages?: unknown } | null)?.messages
  if (!Array.isArray(messages)) return null
  for (const m of messages) {
    if (!m || typeof m !== 'object' || (m as { role?: unknown }).role !== 'user') continue
    const content = (m as { content?: unknown }).content
    if (typeof content === 'string') return [content]
    if (!Array.isArray(content)) return null
    const texts: string[] = []
    for (const b of content) {
      const t = b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' ? (b as { text?: unknown }).text : undefined
      if (typeof t === 'string') texts.push(t)
    }
    return texts
  }
  return null
}

/** Where the first user message falls in [0, 1), or null when it has no text to hash. */
function armPosition(body: unknown): number | null {
  let texts: string[] | null
  try { texts = firstUserText(body) } catch { return null }
  if (!texts) return null
  // FNV-1a over the salt and then the characters, with no separator between blocks.
  let h = 0x811c9dc5
  const feed = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
  }
  feed(ARM_SALT)
  let hashed = 0
  for (const t of texts) { feed(t); hashed += t.length }
  if (hashed === 0) return null
  // FNV-1a alone leaves keys that share a long prefix and differ in a counter slightly uneven in
  // the top bits, which is where the bucket is read. The murmur3 finalizer spreads them.
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h ^= h >>> 16
  return (h >>> 0) / 0x100000000
}

/** The arm of a conversation and the group of conversations it falls in within that arm. */
export function armOf(body: unknown): { arm: 'late' | 'holdout'; cluster: number } {
  const p = armPosition(body)
  if (p === null) return { arm: 'late', cluster: 0 }
  const holdout = p < ELISION_HOLDOUT_RATE
  const within = holdout ? p / ELISION_HOLDOUT_RATE : (p - ELISION_HOLDOUT_RATE) / (1 - ELISION_HOLDOUT_RATE)
  return { arm: holdout ? 'holdout' : 'late', cluster: Math.min(ARM_CLUSTERS - 1, Math.floor(within * ARM_CLUSTERS)) }
}

export function armForBody(body: unknown): 'late' | 'holdout' {
  return armOf(body).arm
}
