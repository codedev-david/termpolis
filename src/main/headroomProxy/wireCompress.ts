import * as crypto from 'crypto'
import { compactText } from '../headroom/compactText'
import { compactWeb, looksLikeHtml } from '../headroom/compactWeb'

export interface WireStats {
  trBlocks: number
  trOrigChars: number
  trCompChars: number
  images: number
  imgOrigBytes: number
  imgCompBytes: number
}
export interface WireResult {
  body: string
  changed: boolean
  stats: WireStats
  stashes: Array<{ token: string; original: string }>
}
export type ImageCompressor = (dataB64: string, mediaType: string) => { data: string; mediaType: string; changed: boolean }

function emptyStats(): WireStats { return { trBlocks: 0, trOrigChars: 0, trCompChars: 0, images: 0, imgOrigBytes: 0, imgCompBytes: 0 } }
function detToken(s: string): string { return 'hr_' + crypto.createHash('sha1').update(s).digest('hex').slice(0, 16) }

/**
 * Deterministically compact one tool_result text. Aggressive: line-dedup + head/tail
 * window. When it elides content it appends a footer with a CONTENT-HASH token (so
 * re-compression is byte-identical → cache-safe) and returns the original to stash.
 */
export function compactToolText(text: string): { text: string; stash?: { token: string; original: string } } {
  if (text.length < 400) return { text }
  // Content-aware pre-pass: reduce HTML/web dumps (WebFetch, curl'd pages, MCP HTML)
  // to their readable text BEFORE the head/tail window — a line window barely helps
  // markup-dense, few-newline HTML. Shrink-only + deterministic; original still stashed.
  let body = text
  let webReduced = false
  if (looksLikeHtml(text)) {
    const w = compactWeb(text)
    if (w.length < text.length) {
      body = w
      webReduced = true
    }
  }
  const r = compactText(body, { headLines: 30, tailLines: 12, maxChars: 4000 })
  if (r.text.length >= text.length) return { text } // net no shrink → forward original
  // No retrieve token needed only when nothing was hidden: pure consecutive-line
  // dedup is self-describing, whereas an elision OR an HTML reduction hides content.
  if (!r.elided && !webReduced) return { text: r.text }
  const token = detToken(text) // key on the ORIGINAL so retrieve_full returns the true original
  return {
    text: `${r.text}\n\n[headroom] Full result cached — call the retrieve_full tool with token "${token}" to expand it.`,
    stash: { token, original: text },
  }
}

/**
 * Compact one tool_result text string, OR — if an identical text already appeared
 * earlier IN THIS SAME REQUEST BODY — replace it with a one-line reference stub.
 * `seen` is scoped to a single rewriteMessagesBody call and filled left-to-right, so
 * the output stays a PURE function of the body (determinism guard holds) and remains
 * byte-stable across turns (cache-safe): a repeat only collapses when its earlier
 * twin is also present, which it is on every turn that re-sends the conversation.
 * Reversible: the original is stashed under its content-hash token for retrieve_full.
 */
function compactOrDedup(
  text: string,
  seen: Set<string>,
  stats: WireStats,
  stashes: Array<{ token: string; original: string }>,
): { text: string; changed: boolean } {
  stats.trOrigChars += text.length
  let out = text
  let changed = false
  const key = detToken(text)
  if (text.length >= 400 && seen.has(key)) {
    // A 400+ char block already seen earlier in THIS body → collapse to a one-line
    // reference stub (always far shorter than a ≥400 original). Reversible: the
    // original is stashed under its content-hash token for retrieve_full.
    out = `[headroom] Identical to an earlier tool result in this conversation — call the retrieve_full tool with token "${key}" to expand it.`
    changed = true
    stats.trBlocks++
    stashes.push({ token: key, original: text })
  } else {
    if (text.length >= 400) seen.add(key)
    const c = compactToolText(text)
    if (c.text.length < text.length) {
      out = c.text
      changed = true
      stats.trBlocks++
      if (c.stash) stashes.push(c.stash)
    }
  }
  stats.trCompChars += out.length
  return { text: out, changed }
}

function compressImageBlock(block: { source?: { type?: string; media_type?: string; data?: string } }, compressImage: ImageCompressor, stats: WireStats): boolean {
  const src = block.source
  if (!src || src.type !== 'base64' || typeof src.data !== 'string') return false
  let res
  try { res = compressImage(src.data, src.media_type || 'image/png') } catch { return false }
  if (!res || !res.changed || typeof res.data !== 'string' || res.data.length >= src.data.length) return false
  stats.images++; stats.imgOrigBytes += src.data.length; stats.imgCompBytes += res.data.length
  src.data = res.data; src.media_type = res.mediaType
  return true
}

/**
 * Rewrite an Anthropic /v1/messages request body: compress tool_result text and
 * image blocks ONLY. Everything else (system, tools, thinking, tool_use,
 * cache_control, all headers/fields) is left byte-identical. Deterministic and
 * FAIL-OPEN: any parse error / unknown shape / anomaly returns the original body.
 */
export function rewriteMessagesBody(raw: string, opts: { compressImage?: ImageCompressor; maxBodyChars?: number } = {}): WireResult {
  const stats = emptyStats()
  const stashes: Array<{ token: string; original: string }> = []
  const seen = new Set<string>() // per-body dedup index (content-hash of seen tool_result text), filled left-to-right
  const maxChars = opts.maxBodyChars ?? 10_000_000
  if (raw.length > maxChars) return { body: raw, changed: false, stats, stashes }
  let obj: { messages?: unknown[] }
  try { obj = JSON.parse(raw) } catch { return { body: raw, changed: false, stats, stashes } }
  if (!obj || !Array.isArray(obj.messages)) return { body: raw, changed: false, stats, stashes }
  // Corruption + cache safety: only proceed when the body round-trips LOSSLESSLY (the Anthropic
  // V8 SDK emits canonical JSON). Otherwise a whole-object reserialize could silently alter an
  // UNTOUCHED field — an integer > 2^53, unusual escaping, etc. — so fail open. This makes every
  // non-tool_result byte identical to the client's original, and keeps the prompt cache intact.
  let reserialized: string
  try { reserialized = JSON.stringify(obj) } catch { return { body: raw, changed: false, stats, stashes } }
  if (reserialized !== raw) return { body: raw, changed: false, stats, stashes }
  let changed = false
  try {
    for (const m of obj.messages as Array<{ content?: unknown }>) {
      if (!m || !Array.isArray(m.content)) continue
      for (const b of m.content as Array<Record<string, unknown>>) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'tool_result') {
          if (typeof b.content === 'string') {
            const r = compactOrDedup(b.content, seen, stats, stashes)
            if (r.changed) { b.content = r.text; changed = true }
          } else if (Array.isArray(b.content)) {
            for (const item of b.content as Array<Record<string, unknown>>) {
              if (item && item.type === 'text' && typeof item.text === 'string') {
                const r = compactOrDedup(item.text, seen, stats, stashes)
                if (r.changed) { item.text = r.text; changed = true }
              } else if (item && item.type === 'image' && opts.compressImage) {
                changed = compressImageBlock(item as { source?: { type?: string; media_type?: string; data?: string } }, opts.compressImage, stats) || changed
              }
            }
          }
        } else if (b.type === 'image' && opts.compressImage) {
          changed = compressImageBlock(b as { source?: { type?: string; media_type?: string; data?: string } }, opts.compressImage, stats) || changed
        }
      }
    }
  } catch {
    return { body: raw, changed: false, stats: emptyStats(), stashes: [] } // fail-open
  }
  if (!changed) return { body: raw, changed: false, stats, stashes }
  let out: string
  try { out = JSON.stringify(obj) } catch { return { body: raw, changed: false, stats: emptyStats(), stashes: [] } }
  return { body: out, changed: true, stats, stashes }
}
