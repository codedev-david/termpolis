// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'

const DIR = join(__dirname, '..', '..', '..', 'src', 'renderer', 'src', 'assets', 'intro')

interface Img { file1x: string; file2x: string; width: number; height: number }
interface Manifest {
  stage: { width: number; height: number }
  pad: number
  images: { termpolisMark: Img; termpolisTag: Img; lumopolisTag: Img; letters: Img[] }
  letterOffsets: number[]
  ruleTop: number
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as Manifest
}
function allImgs(m: Manifest): Img[] {
  const { termpolisMark, termpolisTag, lumopolisTag, letters } = m.images
  return [termpolisMark, termpolisTag, lumopolisTag, ...letters]
}
function ihdr(file: string): { w: number; h: number; colorType: number } {
  const b = readFileSync(join(DIR, file))
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] }
}

/** Decode an 8-bit RGBA PNG to its alpha plane (no dependencies). */
function alphaPlane(file: string): { w: number; h: number; a: Uint8Array } {
  const b = readFileSync(join(DIR, file))
  const w = b.readUInt32BE(16)
  const h = b.readUInt32BE(20)
  expect(b[24]).toBe(8)
  expect(b[25]).toBe(6)
  const idat: Buffer[] = []
  for (let p = 8; p < b.length; ) {
    const len = b.readUInt32BE(p)
    if (b.toString('latin1', p + 4, p + 8) === 'IDAT') idat.push(b.subarray(p + 8, p + 8 + len))
    p += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * 4
  const px = new Uint8Array(h * stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]
      const left = x >= 4 ? px[y * stride + x - 4] : 0
      const up = y > 0 ? px[(y - 1) * stride + x] : 0
      const ul = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0
      let add = 0
      if (f === 1) add = left
      else if (f === 2) add = up
      else if (f === 3) add = (left + up) >> 1
      else if (f === 4) {
        const pa = Math.abs(up - ul)
        const pb = Math.abs(left - ul)
        const pc = Math.abs(left + up - 2 * ul)
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : ul
      }
      px[y * stride + x] = (v + add) & 255
    }
  }
  const a = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) a[i] = px[i * 4 + 3]
  return { w, h, a }
}

describe('launch intro artwork', () => {
  it('names only files that exist', () => {
    for (const i of allImgs(manifest())) {
      expect(existsSync(join(DIR, i.file1x))).toBe(true)
      expect(existsSync(join(DIR, i.file2x))).toBe(true)
    }
  })

  it('sizes every PNG to the manifest, at 1x and exactly double at 2x', () => {
    for (const i of allImgs(manifest())) {
      const a = ihdr(i.file1x)
      const b = ihdr(i.file2x)
      expect([a.w, a.h]).toEqual([i.width, i.height])
      expect([b.w, b.h]).toEqual([i.width * 2, i.height * 2])
    }
  })

  it('has nine letters with strictly increasing offsets', () => {
    const m = manifest()
    expect(m.images.letters).toHaveLength(9)
    expect(m.letterOffsets).toHaveLength(9)
    for (let k = 1; k < 9; k++) expect(m.letterOffsets[k]).toBeGreaterThan(m.letterOffsets[k - 1])
  })

  it('keeps transparency (RGBA) and stays within 4 MB', () => {
    const m = manifest()
    for (const i of allImgs(m)) {
      expect(ihdr(i.file1x).colorType).toBe(6)
      expect(ihdr(i.file2x).colorType).toBe(6)
    }
    const total = readdirSync(DIR)
      .filter((f) => f.endsWith('.png'))
      .reduce((n, f) => n + statSync(join(DIR, f)).size, 0)
    expect(total).toBeLessThanOrEqual(4 * 1024 * 1024)
  })

  it('renders equal letters to identical bytes (L and O repeat in LUMOPOLIS)', () => {
    const m = manifest()
    for (const [i, j] of [[0, 6], [3, 5]]) {
      for (const k of ['file1x', 'file2x'] as const) {
        const a = readFileSync(join(DIR, m.images.letters[i][k]))
        const b = readFileSync(join(DIR, m.images.letters[j][k]))
        expect(a.equals(b)).toBe(true)
      }
    }
  })

  it('never clips the glow: the outermost pixel border is transparent', () => {
    for (const i of allImgs(manifest())) {
      for (const f of [i.file1x, i.file2x]) {
        const { w, h, a } = alphaPlane(f)
        let max = 0
        for (let x = 0; x < w; x++) max = Math.max(max, a[x], a[(h - 1) * w + x])
        for (let y = 0; y < h; y++) max = Math.max(max, a[y * w], a[y * w + w - 1])
        expect(max).toBeLessThanOrEqual(2)
      }
    }
  })
})
