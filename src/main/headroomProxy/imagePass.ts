export interface ImgStats { images: number; imgOrigBytes: number; imgCompBytes: number }
export type AsyncImgCompressor = (imgs: Array<{ data: string; mediaType: string }>) => Promise<Array<{ data: string; mediaType: string; changed: boolean }>>

interface ImgSource { type?: string; data?: string; media_type?: string }
interface Block { type?: string; source?: ImgSource; content?: unknown }

/**
 * Second pass over a (text-already-compressed) request body: collect image blocks, compress
 * them via an async delegate (image work lives in main where nativeImage exists), apply, and
 * re-serialize. TIMEOUT-BOUNDED + FAIL-OPEN so the proxy request can never hang or corrupt.
 */
export async function compressImagesInBody(raw: string, compress: AsyncImgCompressor, timeoutMs = 400): Promise<{ body: string; stats: ImgStats }> {
  const stats: ImgStats = { images: 0, imgOrigBytes: 0, imgCompBytes: 0 }
  let obj: { messages?: unknown[] }
  try { obj = JSON.parse(raw) } catch { return { body: raw, stats } }
  if (!obj || !Array.isArray(obj.messages)) return { body: raw, stats }

  const refs: Block[] = []
  try {
    for (const m of obj.messages as Array<{ content?: unknown }>) {
      if (!m || !Array.isArray(m.content)) continue
      for (const b of m.content as Block[]) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'image' && b.source?.type === 'base64' && typeof b.source.data === 'string') refs.push(b)
        else if (b.type === 'tool_result' && Array.isArray(b.content)) {
          for (const c of b.content as Block[]) if (c && c.type === 'image' && c.source?.type === 'base64' && typeof c.source.data === 'string') refs.push(c)
        }
      }
    }
  } catch { return { body: raw, stats } }
  if (refs.length === 0) return { body: raw, stats }

  let results: Array<{ data: string; mediaType: string; changed: boolean }> | null
  try {
    const inputs = refs.map((r) => ({ data: r.source!.data as string, mediaType: r.source!.media_type || 'image/png' }))
    const timeout = new Promise<null>((res) => setTimeout(() => res(null), timeoutMs))
    results = await Promise.race([compress(inputs), timeout])
  } catch { return { body: raw, stats } }
  if (!results || !Array.isArray(results)) return { body: raw, stats } // timed out or bad → keep originals

  let changed = false
  for (let i = 0; i < refs.length; i++) {
    const r = results[i]
    const src = refs[i].source!
    const origLen = (src.data as string).length
    if (r && r.changed && typeof r.data === 'string' && r.data.length < origLen) {
      stats.images++; stats.imgOrigBytes += origLen; stats.imgCompBytes += r.data.length
      src.data = r.data; src.media_type = r.mediaType
      changed = true
    }
  }
  if (!changed) return { body: raw, stats }
  try { return { body: JSON.stringify(obj), stats } } catch { return { body: raw, stats } }
}
