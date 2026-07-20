import { describe, it, expect, beforeEach } from 'vitest'
const { compressImage, _resetImageCompress } = await import('../../src/main/headroomProxy/imageCompress')
const { compressImagesInBody } = await import('../../src/main/headroomProxy/imagePass')

const fakeNativeImage = (w: number, h: number, outBytes = 40) => ({
  createFromBuffer: () => ({
    isEmpty: () => false,
    getSize: () => ({ width: w, height: h }),
    resize: () => ({ toPNG: () => Buffer.from('p'.repeat(outBytes)) }),
  }),
})

describe('compressImage', () => {
  beforeEach(() => _resetImageCompress())

  it('downscales an oversized image and re-encodes smaller', () => {
    const big = 'A'.repeat(9000)
    const r = compressImage(big, 'image/png', 1280, fakeNativeImage(3000, 2000))
    expect(r.changed).toBe(true)
    expect(r.data.length).toBeLessThan(big.length)
    expect(r.mediaType).toBe('image/png')
  })

  it('leaves an already-small image untouched', () => {
    const small = 'A'.repeat(9000)
    const r = compressImage(small, 'image/png', 1280, fakeNativeImage(800, 600))
    expect(r.changed).toBe(false)
    expect(r.data).toBe(small)
  })

  it('is deterministic (memoized by content hash)', () => {
    const big = 'A'.repeat(9000)
    const a = compressImage(big, 'image/png', 1280, fakeNativeImage(3000, 2000))
    const b = compressImage(big, 'image/png', 1280, fakeNativeImage(3000, 2000))
    expect(a.data).toBe(b.data)
  })

  it('fail-open when nativeImage is unavailable or throws', () => {
    const big = 'A'.repeat(9000)
    expect(compressImage(big, 'image/png', 1280, null).changed).toBe(false)
    const boom = { createFromBuffer: () => { throw new Error('bad') } }
    expect(compressImage(big, 'image/png', 1280, boom as never).changed).toBe(false)
  })
})

describe('compressImagesInBody', () => {
  const body = (imgData: string) => JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imgData } }] }] })

  it('compresses image blocks via the async delegate and re-serializes', async () => {
    const r = await compressImagesInBody(body('A'.repeat(9000)), async (imgs) => imgs.map(() => ({ data: 'B'.repeat(100), mediaType: 'image/png', changed: true })))
    const src = JSON.parse(r.body).messages[0].content[0].source
    expect(src.data).toBe('B'.repeat(100))
    expect(r.stats.images).toBe(1)
  })

  it('is fail-open and bounded: a hanging delegate times out and keeps the original', async () => {
    const orig = body('A'.repeat(9000))
    const r = await compressImagesInBody(orig, () => new Promise(() => {}), 30)
    expect(r.body).toBe(orig)
    expect(r.stats.images).toBe(0)
  })

  it('passes through a body with no images', async () => {
    const noImg = JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    const r = await compressImagesInBody(noImg, async (imgs) => imgs.map((i) => ({ ...i, changed: false })))
    expect(r.body).toBe(noImg)
  })
})
