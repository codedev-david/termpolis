import * as crypto from 'crypto'

export interface NativeImageLike {
  createFromBuffer(buf: Buffer): {
    isEmpty(): boolean
    getSize(): { width: number; height: number }
    resize(o: { width: number; height: number; quality?: string }): { toPNG(): Buffer }
  }
}
export interface ImageResult { data: string; mediaType: string; changed: boolean }

let cachedApi: NativeImageLike | null | undefined
function getApi(): NativeImageLike | null {
  if (cachedApi !== undefined) return cachedApi ?? null
  try {
    // Lazy require so this module imports cleanly in tests / non-Electron contexts.
    cachedApi = (require('electron') as { nativeImage: NativeImageLike }).nativeImage
  } catch { cachedApi = null }
  return cachedApi ?? null
}

const memo = new Map<string, ImageResult>()
const MEMO_MAX = 128

/**
 * Downscale an oversized base64 image below Anthropic's default (1568px) so it costs fewer
 * image tokens. DETERMINISTIC via content-hash memoization → identical re-encode across turns
 * → prompt-cache safe. FAIL-OPEN: returns the original on any error or when nativeImage is
 * unavailable (e.g. inside a utilityProcess).
 */
export function compressImage(dataB64: string, mediaType: string, maxEdge = 1280, injected?: NativeImageLike | null): ImageResult {
  const api = injected !== undefined ? injected : getApi()
  const original: ImageResult = { data: dataB64, mediaType, changed: false }
  if (!api) return original
  const key = crypto.createHash('sha1').update(dataB64).digest('hex')
  const hit = memo.get(key)
  if (hit) return hit
  let out = original
  try {
    const buf = Buffer.from(dataB64, 'base64')
    const img = api.createFromBuffer(buf)
    if (!img.isEmpty()) {
      const { width, height } = img.getSize()
      const long = Math.max(width, height)
      if (long > maxEdge && width > 0 && height > 0) {
        const scale = maxEdge / long
        const png = img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' }).toPNG()
        const b64 = png.toString('base64')
        if (b64.length > 0 && b64.length < dataB64.length) out = { data: b64, mediaType: 'image/png', changed: true }
      }
    }
  } catch { /* fail-open */ }
  memo.set(key, out)
  while (memo.size > MEMO_MAX) { const k = memo.keys().next().value; if (k === undefined) break; memo.delete(k) }
  return out
}

export function compressImageBatch(images: Array<{ data: string; mediaType: string }>): ImageResult[] {
  return images.map((i) => compressImage(i.data, i.mediaType))
}

export function _resetImageCompress(): void { memo.clear(); cachedApi = undefined }
