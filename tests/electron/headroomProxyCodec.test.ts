import { describe, it, expect, beforeEach } from 'vitest'
import { PNG } from 'pngjs'
const { compressImage, _resetImageCodec } = await import('../../src/main/headroomProxy/imageCodec')

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
})
