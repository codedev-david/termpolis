// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

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
})
