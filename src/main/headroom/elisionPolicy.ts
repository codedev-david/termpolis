/**
 * When Token Headroom may shorten a tool result the first time the model sees it, and which
 * conversations are held out of that choice so its effect can be measured.
 *
 * WHY THERE IS A CHOICE. First-sight compaction replaces a tool result with a head and tail window
 * and a `retrieve_full` footer. That pays when the model never asks for the rest and loses when it
 * does, because a retrieval is a whole extra turn: the entire cached prefix is read again, about
 * 16,800 billed units on measured traffic. Until late August 2026 the model asked for about 13% of
 * shortened results; since Claude Code 2.1.247 it asks for about 66% (the compression research,
 * section 5). At that rate almost no class of result under roughly 40,000 characters pays for itself (Grep
 * and PowerShell between 10,000 and 40,000 characters came close, and a retrieval cheaper than the average
 * one would have tipped them; the value given up is about 0.05% of the bill). The rate is the author's, on
 * Opus: about 44% on Sonnet 5.5, where the research puts Late's gain near nothing at this floor, which is
 * what the holdout and the Elision health card are there to check on the person's own work.
 *
 * `late` therefore leaves a tool result whole until it reaches 40,000 characters and shortens it
 * from there exactly as before. Everything else Token Headroom does (collapsing a repeat or a
 * near-repeat within one request, ageing out old history in a long conversation, scaling images) is
 * outside this choice and unchanged in kind. One outcome does differ, and in the model's favour: a
 * near-repeat under the floor is replaced by a patch against the earlier copy whenever that is shorter
 * than the whole text, where `legacy` replaced it by the head and tail window unless the patch was
 * shorter than the window, so the model is shown more of such a result. `legacy` adds no floor of its
 * own and is v1.54 to the byte.
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
 * this). Without it the research's modeled gain (about 10% of the bill where the model asks that often)
 * would stay a model fitted to one history and could never
 * be checked on another.
 *
 * The arm is a function of the conversation's FIRST USER MESSAGE and of nothing else:
 *
 *  - It must not move during a conversation. The two arms transform the body differently, so an arm
 *    that flipped between turns would rewrite the cached prefix. The first message is the one part
 *    of the body that is identical on every turn.
 *  - Only the TEXT is read. Claude Code writes the same first message as a plain string on one turn
 *    and as a block carrying a cache breakpoint on another, may cut it into more blocks, and may add
 *    an image, so the text blocks are laid end to end and only that text is read: its length, its
 *    first and its last kilobyte (see HASH_HEAD), however the blocks happen to be cut.
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

/**
 * How much of a first message the arm reads: its length, its first HASH_HEAD characters and its last
 * HASH_TAIL. The arm is chosen on EVERY request in the one proxy child that serves every Claude
 * session, and a first message is not small: Claude Code puts the project instructions, the memory
 * index and the skill listing in it, easily 50 to 100 KB, and a pasted file can make it megabytes.
 * Hashing all of it cost 16 ns a character, 1.6 ms a request at 100 KB and 31 ms at 2 MB, for a
 * decision that needs a few kilobytes. The ends carry what tells conversations apart: the shared
 * reminders sit at the front and the task at the back. Two first messages that agree in length, head
 * and tail share an arm, which costs nothing, since the arm only has to be a stable function of the
 * message. Up to HASH_HEAD + HASH_TAIL characters the two ends together are the whole text.
 */
const HASH_HEAD = 1024
const HASH_TAIL = 1024

/** The first `n` characters of the blocks laid end to end, without laying them end to end. */
function headOf(texts: string[], n: number): string {
  let out = ''
  for (let i = 0; i < texts.length && out.length < n; i++) out += texts[i].slice(0, n - out.length)
  return out
}

/** The last `n` characters of the blocks laid end to end. */
function tailOf(texts: string[], n: number): string {
  let out = ''
  for (let i = texts.length - 1; i >= 0 && out.length < n; i--) {
    const t = texts[i]
    out = t.slice(Math.max(0, t.length - (n - out.length))) + out
  }
  return out
}

/** The 32-bit hash of the first user message, or null when it has no text to hash. */
function armHash(body: unknown): number | null {
  let texts: string[] | null
  try { texts = firstUserText(body) } catch { return null }
  if (!texts) return null
  let total = 0
  for (const t of texts) total += t.length
  if (total === 0) return null
  // FNV-1a over the salt, the length and the two ends, with a separator between the parts.
  let h = 0x811c9dc5
  const feed = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
  }
  feed(ARM_SALT)
  feed(`\u0000${total}\u0000`)
  feed(headOf(texts, HASH_HEAD))
  feed('\u0000')
  feed(tailOf(texts, HASH_TAIL))
  // FNV-1a alone leaves keys that share a long prefix and differ in a counter slightly uneven in
  // the top bits, which is where the bucket is read. The murmur3 finalizer spreads them.
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

/**
 * The arm of a conversation, the group of conversations it falls in within that arm, and `key`: the
 * hash itself, which names the conversation to anything that has to follow it from one request to the
 * next (a ToolSearch turn and the retrieve_full turn after it, proxyLedger.ts). 0 means a first
 * message with nothing to hash, which names nothing.
 */
export function armOf(body: unknown): { arm: 'late' | 'holdout'; cluster: number; key: number } {
  const h = armHash(body)
  if (h === null) return { arm: 'late', cluster: 0, key: 0 }
  const p = h / 0x100000000
  const holdout = p < ELISION_HOLDOUT_RATE
  const within = holdout ? p / ELISION_HOLDOUT_RATE : (p - ELISION_HOLDOUT_RATE) / (1 - ELISION_HOLDOUT_RATE)
  return { arm: holdout ? 'holdout' : 'late', cluster: Math.min(ARM_CLUSTERS - 1, Math.floor(within * ARM_CLUSTERS)), key: h }
}

export function armForBody(body: unknown): 'late' | 'holdout' {
  return armOf(body).arm
}
