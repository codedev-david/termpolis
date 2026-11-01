/**
 * What reached the model: a read-only tally of the tool_result texts in a request body the proxy
 * is about to forward, by what the proxy did to them.
 *
 * One live session in the compression research received its first tool results as content-free
 * "Aged out" stubs, which the code makes only after 128 messages, and nothing could say whether
 * other sessions did too. A stub like that is redeemed almost every time, so if they are common
 * they inflate the redemption rate and a policy that never touches them cannot remove it. This
 * counts them, per request, so the answer is a number in the ledger.
 *
 * Reads, never writes: the caller's messages are the body that goes upstream, and nothing here
 * assigns into them. Pure, so it adds nothing to what compression depends on, and the child
 * imports it, so it stays free of electron and fs.
 */
import { mapOutsideReminders } from './reminders'
import { DECAY_FIRST_THRESHOLD } from './prefixDecay'

export interface StubKindCounts {
  /** Text the proxy left as the client wrote it (or only collapsed repeated lines in). */
  plain: number
  /** A head/tail window, or a structural reduction, ending in a retrieve_full footer. */
  compact: number
  /** A one-line reference to an identical earlier result in the same request. */
  dedup: number
  /** A patch against an earlier result in the same request, ending in a footer. */
  diff: number
  /** A content-free stub for a result aged out of a long conversation. */
  aged: number
  /** The subset of `aged` sitting in a body shorter than the decay threshold, which the decay pass
   *  cannot have made: the unexplained case. */
  agedEarly: number
}

export function emptyKinds(): StubKindCounts {
  return { plain: 0, compact: 0, dedup: 0, diff: 0, aged: 0, agedEarly: 0 }
}

// The shapes below are the ones wireCompress.ts, diffEncode.ts and prefixDecay.ts write. The
// golden tests build their bodies with the real rewriter, so a change there fails here.
const TOKEN = 'hr_[0-9a-f]{16}'
const FOOTER = new RegExp(`\\n\\n\\[headroom\\] Full result cached — call the retrieve_full tool with token "${TOKEN}" to expand it\\.$`)
const DEDUP = new RegExp(`^\\[headroom\\] Identical to an earlier tool result in this conversation — call the retrieve_full tool with token "${TOKEN}" to expand it\\.$`)
const AGED = new RegExp(`^\\[headroom\\] Aged out of this conversation's active context — call the retrieve_full tool with token "${TOKEN}" to expand it\\.$`)
const DIFF_HEAD = '[headroom] Identical to an earlier tool result in this conversation except for the lines below.\n@@ '
/** The footer is ~110 characters; only the end of a long text needs the pattern run on it. */
const FOOTER_WINDOW = 200
const BLANK = /^\s*$/

type Kind = 'plain' | 'compact' | 'dedup' | 'diff' | 'aged'

/**
 * A text counts as a stub only when the stub IS the text (dedup, aged) or ENDS it (footer), the way
 * the proxy writes them. A tool output that merely quotes one, in a fence or in prose, goes on
 * past it. A fence is deliberately not looked for: a head/tail window of a markdown file often
 * ends inside one, and calling that plain would hide real compactions.
 */
function classify(seg: string): Kind {
  if (seg.startsWith('[headroom] ')) {
    if (DEDUP.test(seg)) return 'dedup'
    if (AGED.test(seg)) return 'aged'
  }
  if (seg.endsWith('to expand it.') && FOOTER.test(seg.length > FOOTER_WINDOW ? seg.slice(-FOOTER_WINDOW) : seg)) {
    return seg.startsWith(DIFF_HEAD) ? 'diff' : 'compact'
  }
  return 'plain'
}

function tally(text: string, k: StubKindCounts, early: boolean): void {
  // Each stretch outside a harness reminder is what the compressor saw, so it is what is counted;
  // the reminders themselves are instructions to the model and ride through untouched.
  mapOutsideReminders(text, (seg) => {
    if (!BLANK.test(seg)) {
      const kind = classify(seg)
      k[kind]++
      if (kind === 'aged' && early) k.agedEarly++
    }
    return { text: seg, changed: false }
  })
}

/** The tally for a request's messages. Total: anything that is not a tool_result with text is skipped. */
export function classifyMessages(messages: readonly unknown[]): StubKindCounts {
  const k = emptyKinds()
  // Below the decay threshold the decay pass cannot run, so an aged-out stub here came from elsewhere.
  const early = messages.length < DECAY_FIRST_THRESHOLD
  for (const m of messages) {
    const content = (m as { content?: unknown } | null)?.content
    if (!Array.isArray(content)) continue
    for (const b of content as unknown[]) {
      const block = b as { type?: unknown; content?: unknown } | null
      if (!block || block.type !== 'tool_result') continue
      const c = block.content
      if (typeof c === 'string') tally(c, k, early)
      else if (Array.isArray(c)) {
        for (const item of c as unknown[]) {
          const it = item as { type?: unknown; text?: unknown } | null
          if (it && it.type === 'text' && typeof it.text === 'string') tally(it.text, k, early)
        }
      }
    }
  }
  return k
}

/** The same, from a body as it goes upstream. A body that is not a Messages request counts as nothing. */
export function classifyForwardedResults(body: string): StubKindCounts {
  let obj: { messages?: unknown }
  try { obj = JSON.parse(body) } catch { return emptyKinds() }
  return obj && Array.isArray(obj.messages) ? classifyMessages(obj.messages) : emptyKinds()
}
