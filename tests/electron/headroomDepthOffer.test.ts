import { describe, it, expect, beforeEach } from 'vitest'
import type { ProxyResultMsg } from '../../src/main/headroomProxy/proxySupervisor'

const { recordDepthSample, resetDepthCurveAll, depthAdvice, depthAdviceAt, MIN_BAND_SAMPLES } = await import('../../src/main/headroom/sessionDepth')
const { depthOfferFor, resetDepthOffers, OFFER_MIN_SAVING_PCT, OFFER_TERMINAL_CAP } = await import('../../src/main/headroom/depthOffer')

function fill(messages: number, read: number, write = 0): void {
  for (let i = 0; i < MIN_BAND_SAMPLES; i++) recordDepthSample(messages, read, write)
}

/** A curve where band 1 (10-24 messages) is cheap and every deeper band costs more, as on real traffic. */
function realisticCurve(): void {
  fill(15, 10_000)    // band 1: the fresh rate
  fill(30, 12_000)    // band 2: 17% saving, not offered
  fill(60, 16_000)    // band 3: 38%, not offered
  fill(150, 24_000)   // band 4: 58%, offered
  fill(300, 34_000)   // band 5: 71%
}

function result(over: Partial<ProxyResultMsg> & { msgCount?: number } = {}): ProxyResultMsg {
  const { msgCount = 150, ...rest } = over
  return { kind: 'result', changed: false, stats: { msgCount } as ProxyResultMsg['stats'], usage: {} as ProxyResultMsg['usage'], turn: {} as ProxyResultMsg['turn'], stashes: [], status: 200, terminal: 't-1', main: true, ...rest }
}

describe('fresh-session offer before compaction (v1.59.0)', () => {
  beforeEach(() => { resetDepthCurveAll(); resetDepthOffers() })

  it('depthAdviceAt answers for the depth asked, not the last request', () => {
    realisticCurve()
    expect(depthAdvice()?.messages).toBe(300)
    const at = depthAdviceAt(150)
    expect(at?.messages).toBe(150)
    expect(at?.bandIndex).toBe(4)
    expect(at?.savingPct).toBeGreaterThanOrEqual(OFFER_MIN_SAVING_PCT)
    expect(depthAdviceAt(0)).toBeNull()
    expect(depthAdviceAt(15)).toBeNull()
  })

  it('offers once a terminal reaches a band worth it, then only at a deeper band', () => {
    realisticCurve()
    expect(depthOfferFor(result({ msgCount: 30 }))).toBeNull()
    expect(depthOfferFor(result({ msgCount: 60 }))).toBeNull()
    const first = depthOfferFor(result({ msgCount: 110 }))
    expect(first).toEqual({ terminalId: 't-1', messages: 110, savingPct: depthAdviceAt(110)?.savingPct })
    expect(depthOfferFor(result({ msgCount: 111 }))).toBeNull()
    expect(depthOfferFor(result({ msgCount: 199 }))).toBeNull()
    expect(depthOfferFor(result({ msgCount: 210 }))?.messages).toBe(210)
    expect(depthOfferFor(result({ msgCount: 220 }))).toBeNull()
  })

  it('a message count that drops starts the terminal over', () => {
    realisticCurve()
    expect(depthOfferFor(result({ msgCount: 150 }))).not.toBeNull()
    // compacted or restarted: back to a short conversation, and the offer comes again once it is long
    expect(depthOfferFor(result({ msgCount: 4 }))).toBeNull()
    expect(depthOfferFor(result({ msgCount: 150 }))).not.toBeNull()
  })

  it('terminals are counted apart', () => {
    realisticCurve()
    expect(depthOfferFor(result({ terminal: 'a' }))?.terminalId).toBe('a')
    expect(depthOfferFor(result({ terminal: 'b' }))?.terminalId).toBe('b')
    expect(depthOfferFor(result({ terminal: 'a' }))).toBeNull()
  })

  it('only a terminal\'s own successful main request counts', () => {
    realisticCurve()
    expect(depthOfferFor(result({ terminal: undefined }))).toBeNull()
    expect(depthOfferFor(result({ main: undefined }))).toBeNull()
    expect(depthOfferFor(result({ agent: true }))).toBeNull()
    expect(depthOfferFor(result({ status: 429 }))).toBeNull()
    expect(depthOfferFor(result({ status: 199 }))).toBeNull()
    expect(depthOfferFor(result({ msgCount: 0 }))).toBeNull()
    expect(depthOfferFor({ ...result(), stats: undefined as unknown as ProxyResultMsg['stats'] })).toBeNull()
    expect(depthOfferFor(result())).not.toBeNull()
  })

  it('no offer without evidence or below the saving floor, and the band stays open for later', () => {
    // no curve at all
    expect(depthOfferFor(result())).toBeNull()
    // a curve whose deep band saves too little
    fill(15, 10_000)
    fill(150, 14_000)
    expect(depthOfferFor(result({ msgCount: 150 }))).toBeNull()
    // once the evidence says it pays, the same band offers
    fill(150, 60_000)
    expect(depthOfferFor(result({ msgCount: 151 }))).not.toBeNull()
  })

  it('forgets the oldest terminal past the cap', () => {
    realisticCurve()
    expect(depthOfferFor(result({ terminal: 'first' }))).not.toBeNull()
    for (let i = 0; i < OFFER_TERMINAL_CAP; i++) depthOfferFor(result({ terminal: `t${i}` }))
    // 'first' was dropped, so it is offered again as a new terminal
    expect(depthOfferFor(result({ terminal: 'first' }))).not.toBeNull()
  })
})
