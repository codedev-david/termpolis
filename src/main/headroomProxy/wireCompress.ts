import * as crypto from 'crypto'
import { compactText } from '../headroom/compactText'

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
function detToken(s: string): string { return 'hr_' + crypto.createHash('sha1').update(s).digest('hex').slice(0, 12) }

/**
 * Deterministically compact one tool_result text. Aggressive: line-dedup + head/tail
 * window. When it elides content it appends a footer with a CONTENT-HASH token (so
 * re-compression is byte-identical → cache-safe) and returns the original to stash.
 */
export function compactToolText(text: string): { text: string; stash?: { token: string; original: string } } {
  if (text.length < 400) return { text }
  const r = compactText(text, { headLines: 30, tailLines: 12, maxChars: 4000 })
  if (r.text.length >= text.length) return { text }
  if (!r.elided) return { text: r.text }
  const token = detToken(text)
  return {
    text: `${r.text}\n\n[headroom] Full result cached — call the retrieve_full tool with token "${token}" to expand it.`,
    stash: { token, original: text },
  }
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
  const maxChars = opts.maxBodyChars ?? 10_000_000
  if (raw.length > maxChars) return { body: raw, changed: false, stats, stashes }
  let obj: { messages?: unknown[] }
  try { obj = JSON.parse(raw) } catch { return { body: raw, changed: false, stats, stashes } }
  if (!obj || !Array.isArray(obj.messages)) return { body: raw, changed: false, stats, stashes }
  let changed = false
  try {
    for (const m of obj.messages as Array<{ content?: unknown }>) {
      if (!m || !Array.isArray(m.content)) continue
      for (const b of m.content as Array<Record<string, unknown>>) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'tool_result') {
          if (typeof b.content === 'string') {
            stats.trOrigChars += b.content.length
            const c = compactToolText(b.content)
            if (c.text.length < b.content.length) { b.content = c.text; changed = true; stats.trBlocks++; if (c.stash) stashes.push(c.stash) }
            stats.trCompChars += (b.content as string).length
          } else if (Array.isArray(b.content)) {
            for (const item of b.content as Array<Record<string, unknown>>) {
              if (item && item.type === 'text' && typeof item.text === 'string') {
                stats.trOrigChars += item.text.length
                const c = compactToolText(item.text)
                if (c.text.length < item.text.length) { item.text = c.text; changed = true; stats.trBlocks++; if (c.stash) stashes.push(c.stash) }
                stats.trCompChars += (item.text as string).length
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
