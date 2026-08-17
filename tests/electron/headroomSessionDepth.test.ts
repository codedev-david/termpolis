import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const {
  bandFor, recordDepthSample, depthAdvice, currentDepthCurve, loadDepthCurve,
  loadDepthCurveFromDisk, saveDepthCurveToDisk, setDepthCurveFlush, resetDepthCurve,
  resetDepthCurveAll, DEPTH_BAND_EDGES, MIN_BAND_SAMPLES, FRESH_BAND_LIMIT,
} = await import('../../src/main/headroom/sessionDepth')

let dirs: string[] = []
const mkdir = (): string => { const d = mkdtempSync(join(tmpdir(), 'depth-')); dirs.push(d); return d }

/** Fill one band with enough samples to clear MIN_BAND_SAMPLES, at a known per-request cost. */
function fill(messages: number, read: number, write: number, n = MIN_BAND_SAMPLES): void {
  for (let i = 0; i < n; i++) recordDepthSample(messages, read, write)
}

describe('headroom session depth', () => {
  beforeEach(() => resetDepthCurveAll())
  afterEach(() => {
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
    dirs = []
  })

  it('bands by message count, with the last edge catching everything above it', () => {
    expect(bandFor(1)).toBe(0)
    expect(bandFor(9)).toBe(0)
    expect(bandFor(10)).toBe(1)
    expect(bandFor(24)).toBe(1)
    expect(bandFor(400)).toBe(6)
    expect(bandFor(100000)).toBe(DEPTH_BAND_EDGES.length - 1)
    // findIndex finds nothing only when the value is not less than Infinity either.
    expect(bandFor(Number.POSITIVE_INFINITY)).toBe(DEPTH_BAND_EDGES.length - 1)
  })

  it('ignores requests with no message count and clamps negative usage', () => {
    recordDepthSample(0, 5000, 100)
    recordDepthSample(-3, 5000, 100)
    expect(currentDepthCurve().bands.every((b) => b.requests === 0)).toBe(true)
    recordDepthSample(5, -5000, -100)
    const b = currentDepthCurve().bands[0]
    expect(b.requests).toBe(1)
    expect(b.readTokens).toBe(0)
    expect(b.writeTokens).toBe(0)
  })

  it('says nothing until both bands are this user own curve rather than one accident', () => {
    expect(depthAdvice()).toBeNull()
    fill(300, 320000, 7500, MIN_BAND_SAMPLES)
    // Deep band is full, shallow band is empty: there is nothing honest to compare against.
    expect(depthAdvice()).toBeNull()
    fill(15, 67000, 10000, MIN_BAND_SAMPLES - 1)
    expect(depthAdvice()).toBeNull()
    recordDepthSample(300, 320000, 7500)
    fill(15, 67000, 10000, 1)
    recordDepthSample(300, 320000, 7500)
    expect(depthAdvice()).not.toBeNull()
  })

  it('prices a turn on read AND write, which is what removes the fudged restart constant', () => {
    fill(15, 67000, 10000)
    fill(300, 320000, 7500)
    const a = depthAdvice()
    expect(a).not.toBeNull()
    expect(a!.messages).toBe(300)
    expect(a!.bandIndex).toBe(5)
    // 320000 read at 0.1x + 7500 written at 1.25x.
    expect(a!.unitsPerTurnNow).toBe(41375)
    // The shallow band pays a BIGGER write - that is the price of a fresh prefix, already in.
    expect(a!.unitsPerTurnFresh).toBe(19200)
    expect(a!.savingPerTurn).toBe(22175)
    expect(a!.savingPct).toBe(54)
    expect(a!.requestsNow).toBe(MIN_BAND_SAMPLES)
    expect(a!.requestsFresh).toBe(MIN_BAND_SAMPLES)
  })

  it('never advises restarting a conversation that is already shallow', () => {
    fill(15, 67000, 10000)
    recordDepthSample(15, 67000, 10000)
    expect(depthAdvice()).toBeNull()
  })

  it('stays silent when depth is not what is costing the money', () => {
    fill(15, 200000, 0)
    fill(300, 50000, 0)
    expect(depthAdvice()).toBeNull()
  })

  it('compares against the CHEAPEST shallow band it has, not merely the first', () => {
    fill(5, 30000, 20000)
    fill(15, 60000, 2000)
    fill(300, 320000, 7500)
    const a = depthAdvice()
    // Band 0 costs 28000 a turn, band 1 costs 8500. The advice must use 8500.
    expect(a!.unitsPerTurnFresh).toBe(8500)
  })

  it('will not call a mid-depth band fresh, however cheap it looks', () => {
    expect(FRESH_BAND_LIMIT).toBe(2)
    fill(75, 1000, 0)
    fill(300, 320000, 7500)
    expect(depthAdvice()).toBeNull()
  })

  it('hands out a copy of the curve, so a reader cannot edit the meter', () => {
    fill(15, 1000, 100, 2)
    const c = currentDepthCurve()
    c.bands[1].requests = 999
    c.lastMessages = 999
    expect(currentDepthCurve().bands[1].requests).toBe(2)
    expect(currentDepthCurve().lastMessages).toBe(15)
  })

  it('flushes on every sample, and a throwing flush never breaks the request path', () => {
    let n = 0
    setDepthCurveFlush(() => { n++ })
    recordDepthSample(15, 1000, 100)
    expect(n).toBe(1)
    setDepthCurveFlush(() => { throw new Error('disk full') })
    expect(() => recordDepthSample(15, 1000, 100)).not.toThrow()
    expect(currentDepthCurve().bands[1].requests).toBe(2)
    setDepthCurveFlush(null)
    recordDepthSample(15, 1000, 100)
    expect(currentDepthCurve().bands[1].requests).toBe(3)
  })

  it('resetDepthCurve keeps the writer attached; resetDepthCurveAll drops it', () => {
    let n = 0
    setDepthCurveFlush(() => { n++ })
    recordDepthSample(15, 1000, 100)
    resetDepthCurve()
    recordDepthSample(15, 1000, 100)
    expect(n).toBe(2)
    resetDepthCurveAll()
    recordDepthSample(15, 1000, 100)
    expect(n).toBe(2)
  })

  it('round-trips through disk so the curve survives a relaunch', () => {
    const d = mkdir()
    fill(15, 67000, 10000)
    fill(300, 320000, 7500)
    const before = depthAdvice()
    saveDepthCurveToDisk(d)
    resetDepthCurveAll()
    expect(depthAdvice()).toBeNull()
    loadDepthCurveFromDisk(d)
    expect(depthAdvice()).toEqual(before)
  })

  it('starts at zero rather than throwing when there is nothing on disk', () => {
    const d = mkdir()
    fill(15, 1000, 100, 3)
    loadDepthCurveFromDisk(d)
    expect(currentDepthCurve().bands[1].requests).toBe(3)
    expect(() => saveDepthCurveToDisk(join(d, 'no', 'such', 'dir'))).not.toThrow()
  })

  it('refuses a stored curve whose shape is not this build shape', () => {
    fill(15, 1000, 100, 4)
    loadDepthCurve(null)
    loadDepthCurve({})
    loadDepthCurve({ bands: 'nope' })
    loadDepthCurve({ bands: [{ requests: 1, readTokens: 1, writeTokens: 1 }] })
    expect(currentDepthCurve().bands[1].requests).toBe(4)
  })

  it('sanitises a stored curve rather than trusting it', () => {
    const bands = DEPTH_BAND_EDGES.map(() => ({ requests: -5, readTokens: NaN, writeTokens: 'x' }))
    loadDepthCurve({ bands, lastMessages: -9 })
    const c = currentDepthCurve()
    expect(c.lastMessages).toBe(0)
    expect(c.bands.every((b) => b.requests === 0 && b.readTokens === 0 && b.writeTokens === 0)).toBe(true)
    expect(depthAdvice()).toBeNull()
  })

  it('survives a corrupt curve file the same way it survives a missing one', () => {
    const d = mkdir()
    writeFileSync(join(d, 'depth-curve.json'), '{ not json', 'utf8')
    fill(15, 1000, 100, 2)
    expect(() => loadDepthCurveFromDisk(d)).not.toThrow()
    expect(currentDepthCurve().bands[1].requests).toBe(2)
  })

  it('keeps the cheaper shallow band when a later one is dearer', () => {
    fill(5, 20000, 2000)
    fill(15, 90000, 9000)
    fill(300, 320000, 7500)
    // Band 0 costs 4500 a turn, band 1 costs 20250. The scan must not drift to the later band.
    expect(depthAdvice()!.unitsPerTurnFresh).toBe(4500)
  })

  it('treats a stored curve with no lastMessages as a curve with nothing to advise on', () => {
    const bands = DEPTH_BAND_EDGES.map(() => ({ requests: 50, readTokens: 100, writeTokens: 10 }))
    loadDepthCurve({ bands })
    expect(currentDepthCurve().lastMessages).toBe(0)
    expect(depthAdvice()).toBeNull()
  })

  it('treats missing usage numbers as zero rather than as NaN', () => {
    recordDepthSample(5, undefined, undefined)
    const b = currentDepthCurve().bands[0]
    expect(b.requests).toBe(1)
    expect(b.readTokens).toBe(0)
    expect(b.writeTokens).toBe(0)
  })

  it('will not advise off the first request into a new band', () => {
    fill(15, 67000, 10000)
    recordDepthSample(300, 320000, 7500)
    // Depth 300 is now the current band and would show a huge saving on its single sample.
    expect(depthAdvice()).toBeNull()
    fill(300, 320000, 7500, MIN_BAND_SAMPLES - 1)
    expect(depthAdvice()).not.toBeNull()
  })
})
