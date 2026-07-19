import { describe, it, expect } from 'vitest'
const { compressArray, compressObject } = await import('../../src/main/headroom/compressors')
import { thresholdsFor } from '../../src/main/headroom/config'

const T = thresholdsFor('balanced')

describe('compressArray', () => {
  it('keeps top-K, elides the tail, and offloads the full array', () => {
    const arr = Array.from({ length: 100 }, (_, i) => ({ name: `sym${i}`, file: 'a.ts', startLine: i }))
    const r = compressArray(arr, T)
    expect(r.offload).toBe(arr)                       // full original preserved for retrieve
    expect(r.text).toContain('sym0')
    expect(r.text).not.toContain('sym99')             // tail elided
    expect(r.text).toContain('88 more items elided')  // 100 - topK(12)
  })

  it('compacts (no offload) when the array is within top-K', () => {
    const arr = [{ a: 1 }, { b: 2 }]
    const r = compressArray(arr, T)
    expect(r.offload).toBeUndefined()
    expect(r.text).toBe('{"a":1}\n{"b":2}')            // compact one-line JSON per item
  })
})

describe('compressObject', () => {
  it('truncates over-long string fields and offloads the original', () => {
    const big = Array.from({ length: 500 }, (_, i) => `line${i}`).join('\n')
    const obj = { output: big }
    const r = compressObject(obj, thresholdsFor('aggressive'))
    expect(r.offload).toBe(obj)
    expect(r.text.length).toBeLessThan(big.length)
    expect(r.text).toContain('lines elided')
  })

  it('caps over-long arrays inside an object', () => {
    const obj = { symbol: { name: 'f' }, callers: Array.from({ length: 50 }, (_, i) => ({ n: i })) }
    const r = compressObject(obj, thresholdsFor('aggressive'))
    expect(r.offload).toBe(obj)
    expect(r.text).toContain('more elided')
  })

  it('no offload when nothing needed truncation', () => {
    const r = compressObject({ status: 'clean', branch: 'main' }, T)
    expect(r.offload).toBeUndefined()
    expect(r.text).toBe('{"status":"clean","branch":"main"}')
  })
})
