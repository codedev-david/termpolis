import { describe, it, expect, beforeEach } from 'vitest'
import { PNG } from 'pngjs'
const { compressImage, _resetImageCodec, _imageMemoSize } = await import('../../src/main/headroomProxy/imageCodec')

function makePng(w: number, h: number): string {
  const png = new PNG({ width: w, height: h })
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = (i * 7) % 256
    png.data[i * 4 + 1] = (i * 13) % 256
    png.data[i * 4 + 2] = (i * 29) % 256
    png.data[i * 4 + 3] = 255
  }
  return PNG.sync.write(png).toString('base64')
}

/** A well-formed PNG signature + IHDR declaring w×h, with NO pixel data — enough to exercise the
 *  pre-decode dimension guard (which never calls PNG.sync.read when the raster is over the cap). */
function makeIhdrOnly(w: number, h: number): string {
  const buf = Buffer.alloc(24)
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47; buf[4] = 0x0d; buf[5] = 0x0a; buf[6] = 0x1a; buf[7] = 0x0a
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(w, 16)
  buf.writeUInt32BE(h, 20)
  return buf.toString('base64')
}

describe('imageCodec (pure-JS, child-safe)', () => {
  beforeEach(() => _resetImageCodec())

  it('downscales an oversized PNG below the max edge and shrinks it', () => {
    const big = makePng(2000, 200)
    const r = compressImage(big, 'image/png', 1280)
    expect(r.changed).toBe(true)
    const out = PNG.sync.read(Buffer.from(r.data, 'base64'))
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(1280)
    expect(r.data.length).toBeLessThan(big.length)
    expect(r.mediaType).toBe('image/png')
  })

  it('is DETERMINISTIC across a fresh recompute — same image → identical bytes (cache safety)', () => {
    const big = makePng(2000, 200)
    const a = compressImage(big, 'image/png', 1280)
    _resetImageCodec() // clear the memo so the second call fully recomputes
    const b = compressImage(big, 'image/png', 1280)
    expect(a.data).toBe(b.data)
  })

  it('leaves an already-small PNG untouched', () => {
    const small = makePng(200, 100)
    const r = compressImage(small, 'image/png', 1280)
    expect(r.changed).toBe(false)
    expect(r.data).toBe(small)
  })

  it('passes through non-PNG media types unchanged', () => {
    expect(compressImage('anything', 'image/jpeg', 1280).changed).toBe(false)
  })

  it('is fail-open on garbage base64', () => {
    expect(compressImage('!!!not-a-png!!!', 'image/png', 1280).changed).toBe(false)
  })

  it('refuses an oversized raster (decompression-bomb guard) WITHOUT decoding — fail-open', () => {
    // 10000×10000 = 100M px, over the 40M cap. Buffer has a valid IHDR but no IDAT; the guard must
    // bail on dimensions ALONE (never reaching PNG.sync.read, which would throw on the truncated buf).
    const bomb = makeIhdrOnly(10000, 10000)
    const r = compressImage(bomb, 'image/png', 1280)
    expect(r.changed).toBe(false)
    expect(r.data).toBe(bomb)
    expect(_imageMemoSize()).toBe(0) // fail-open path must NOT cache
  })

  it('fails open when the bytes are valid base64 but not a PNG (bad signature)', () => {
    const notPng = Buffer.from('this is clearly not a png file at all').toString('base64')
    const r = compressImage(notPng, 'image/png', 1280)
    expect(r.changed).toBe(false)
    expect(r.data).toBe(notPng)
  })

  it('does NOT memoize pass-throughs, but DOES cache the compressed result', () => {
    _resetImageCodec()
    // Already-small image → pass-through → must not be pinned in the memo.
    compressImage(makePng(200, 100), 'image/png', 1280)
    expect(_imageMemoSize()).toBe(0)
    // Oversized image that actually shrinks → cached (so repeat turns skip the re-encode).
    const r = compressImage(makePng(2000, 200), 'image/png', 1280)
    expect(r.changed).toBe(true)
    expect(_imageMemoSize()).toBe(1)
  })

  it('keys the memo on maxEdge — a different target edge is a different cache entry', () => {
    _resetImageCodec()
    const big = makePng(2000, 200)
    const a = compressImage(big, 'image/png', 1280)
    const b = compressImage(big, 'image/png', 640)
    expect(a.changed).toBe(true)
    expect(b.changed).toBe(true)
    expect(a.data).not.toBe(b.data) // different edge → different bytes, not a stale 1280 hit
    expect(_imageMemoSize()).toBe(2)
  })
})
