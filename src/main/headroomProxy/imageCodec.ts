import { PNG } from 'pngjs'
import { encode as encodeJpeg } from 'jpeg-js'
import * as crypto from 'crypto'

export interface ImageResult { data: string; mediaType: string; changed: boolean }

const memo = new Map<string, ImageResult>()
const MEMO_MAX = 256

// A decoded RGBA raster larger than this many pixels is refused BEFORE PNG.sync.read allocates it.
// PNGs compress flat regions arbitrarily well, so a small (well within the body gate) file can
// decode into a multi-hundred-MB buffer and stall the shared proxy child for seconds — a
// decompression bomb. 40M px ≈ a 160 MB RGBA raster: far above any real screenshot (a 4K frame is
// ~8.3M px), far below the danger zone. Above the cap we fail open (forward the original, uncompressed).
const MAX_DECODE_PIXELS = 40_000_000

/**
 * Quality for the JPEG arm of the re-encode. Deliberately high: an agent READS the text in a
 * screenshot, and ringing around glyphs costs more in re-reads than the bytes are worth. At 82 a
 * downscaled screenshot still lands several times smaller than the PNG of the same raster.
 */
const JPEG_QUALITY = 82

/**
 * JPEG carries no alpha, so it is only a candidate when every pixel is already opaque — otherwise
 * transparency would silently flatten. Screenshots (the whole point of this codec) are opaque;
 * icons and diagrams frequently are not, and those keep the PNG arm.
 */
function isFullyOpaque(rgba: Buffer): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return false
  return true
}

/**
 * Encode a downscaled RGBA raster the smallest way available: PNG always, JPEG too when the
 * raster is opaque, and whichever came out shorter wins.
 *
 * Worth being precise about what this buys, because it is NOT what the rest of Token Headroom
 * buys. Anthropic prices an image on its PIXEL COUNT (~w*h/750 tokens), so the token saving was
 * already banked by the downscale above; re-encoding the same raster as JPEG does not reduce it
 * further. What it reduces is BYTES on the wire — typically 4-8x versus PNG — which is upload
 * latency and memory in the proxy child, and is exactly what the receipt's separate image-bytes
 * line has always measured. Both encoders are pure deterministic JS, so the chosen output is
 * byte-stable across turns and restarts and the prompt cache is unaffected.
 */
function encodeSmallest(rgba: Buffer, width: number, height: number): { buf: Buffer; mediaType: string } {
  const png = new PNG({ width, height })
  png.data = rgba
  let buf = PNG.sync.write(png)
  let mediaType = 'image/png'
  if (isFullyOpaque(rgba)) {
    try {
      const j = encodeJpeg({ data: rgba, width, height }, JPEG_QUALITY)
      const jb = j && j.data ? Buffer.from(j.data) : null
      if (jb && jb.length > 0 && jb.length < buf.length) { buf = jb; mediaType = 'image/jpeg' }
    } catch { /* JPEG arm is optional — keep the PNG */ }
  }
  return { buf, mediaType }
}

/**
 * Read a PNG's declared width/height straight from the IHDR header WITHOUT decoding pixels.
 * Layout: 8-byte signature, then the IHDR chunk (4-byte length, 'IHDR', width u32-BE @16, height @20).
 * Returns null when the buffer isn't a PNG or is too short to hold an IHDR — the caller fails open.
 */
function readPngDims(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (width <= 0 || height <= 0) return null
  return { width, height }
}

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
 * Downscale an oversized base64 PNG below Anthropic's cap so it costs fewer image tokens, then
 * emit it in whichever of PNG/JPEG is smaller (see encodeSmallest — a bytes win, not a token one).
 * DETERMINISTIC (pure box filter + deterministic pure-JS encoders) and memoized by content hash — the
 * same image compresses to identical bytes on every turn AND across restarts, so the prompt cache
 * stays intact. FAIL-OPEN: non-PNG media types, too-small images, oversized rasters, or any error
 * return the original. Pure JS (no nativeImage / no native binary) → runs in the proxy CHILD, off
 * the main thread. Only ACTUALLY-COMPRESSED (smaller) results are cached; pass-throughs are not, so
 * the memo never pins full-size originals in the lightweight child.
 */
export function compressImage(dataB64: string, mediaType: string, maxEdge = 1280): ImageResult {
  const original: ImageResult = { data: dataB64, mediaType, changed: false }
  if (!/png/i.test(mediaType)) return original // v1: PNG only (screenshots); other formats pass through
  // Key includes maxEdge: a different target edge is a different output, so it must not collide.
  const key = crypto.createHash('sha1').update(dataB64).update(`|${maxEdge}`).digest('hex')
  const hit = memo.get(key)
  if (hit) return hit
  try {
    const raw = Buffer.from(dataB64, 'base64')
    const dims = readPngDims(raw)
    if (!dims) return original // not a real PNG → fail open (uncached)
    const long = Math.max(dims.width, dims.height)
    if (long <= maxEdge) return original // already small enough → pass through (uncached)
    if (dims.width * dims.height > MAX_DECODE_PIXELS) return original // decompression-bomb guard → fail open (uncached)
    const png = PNG.sync.read(raw)
    const scale = maxEdge / long
    const nw = Math.max(1, Math.round(png.width * scale))
    const nh = Math.max(1, Math.round(png.height * scale))
    const enc = encodeSmallest(downscaleRGBA(png.data, png.width, png.height, nw, nh), nw, nh)
    const b64 = enc.buf.toString('base64')
    if (b64.length > 0 && b64.length < dataB64.length) {
      const out: ImageResult = { data: b64, mediaType: enc.mediaType, changed: true }
      memo.set(key, out) // cache ONLY the smaller, re-encoded result — never a full-size pass-through
      while (memo.size > MEMO_MAX) { const k = memo.keys().next().value; if (k === undefined) break; memo.delete(k) }
      return out
    }
    return original // re-encode wasn't smaller (e.g. compact grayscale) → pass through (uncached)
  } catch { return original /* fail-open */ }
}

export function _resetImageCodec(): void { memo.clear() }
/** Test-only: current memo size, to assert pass-throughs are NOT cached. */
export function _imageMemoSize(): number { return memo.size }
