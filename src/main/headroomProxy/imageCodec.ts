import { PNG } from 'pngjs'
import * as crypto from 'crypto'

export interface ImageResult { data: string; mediaType: string; changed: boolean }

const memo = new Map<string, ImageResult>()
const MEMO_MAX = 256

/** Deterministic box-average downscale of a packed RGBA buffer (w×h) to (nw×nh). Pure integer math. */
function downscaleRGBA(src: Buffer, w: number, h: number, nw: number, nh: number): Buffer {
  const out = Buffer.allocUnsafe(nw * nh * 4)
  const xr = w / nw, yr = h / nh
  for (let ny = 0; ny < nh; ny++) {
    const sy0 = Math.floor(ny * yr)
    const sy1 = Math.max(sy0 + 1, Math.min(h, Math.floor((ny + 1) * yr)))
    for (let nx = 0; nx < nw; nx++) {
      const sx0 = Math.floor(nx * xr)
      const sx1 = Math.max(sx0 + 1, Math.min(w, Math.floor((nx + 1) * xr)))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * w + sx) * 4
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++
        }
      }
      const o = (ny * nw + nx) * 4
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n)
    }
  }
  return out
}

/**
 * Downscale an oversized base64 PNG below Anthropic's cap so it costs fewer image tokens.
 * DETERMINISTIC (pure box filter + deterministic pngjs encode) and memoized by content hash — the
 * same image compresses to identical bytes on every turn AND across restarts, so the prompt cache
 * stays intact. FAIL-OPEN: non-PNG media types, too-small images, or any error return the original.
 * Pure JS (no nativeImage / no native binary) → runs in the proxy CHILD, off the main thread.
 */
export function compressImage(dataB64: string, mediaType: string, maxEdge = 1280): ImageResult {
  const original: ImageResult = { data: dataB64, mediaType, changed: false }
  if (!/png/i.test(mediaType)) return original // v1: PNG only (screenshots); other formats pass through
  const key = crypto.createHash('sha1').update(dataB64).digest('hex')
  const hit = memo.get(key)
  if (hit) return hit
  let out = original
  try {
    const png = PNG.sync.read(Buffer.from(dataB64, 'base64'))
    const long = Math.max(png.width, png.height)
    if (long > maxEdge && png.width > 0 && png.height > 0) {
      const scale = maxEdge / long
      const nw = Math.max(1, Math.round(png.width * scale))
      const nh = Math.max(1, Math.round(png.height * scale))
      const outPng = new PNG({ width: nw, height: nh })
      outPng.data = downscaleRGBA(png.data, png.width, png.height, nw, nh)
      const b64 = PNG.sync.write(outPng).toString('base64')
      if (b64.length > 0 && b64.length < dataB64.length) out = { data: b64, mediaType: 'image/png', changed: true }
    }
  } catch { /* fail-open */ }
  memo.set(key, out)
  while (memo.size > MEMO_MAX) { const k = memo.keys().next().value; if (k === undefined) break; memo.delete(k) }
  return out
}

export function _resetImageCodec(): void { memo.clear() }
