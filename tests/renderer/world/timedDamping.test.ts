// timedDamping: OrbitControls' damping share is set from the time since the controls last updated, on every update
// (its own input handlers' too), so many input events inside one frame spend no more of a glide than one update over
// the same time (look plan Task 4, VISFLAKE Minor 2).
import { describe, expect, it } from 'vitest'
import { timedUpdate } from '../../../src/renderer/src/world/engine/timedDamping'
import { CONTROLS_DAMPING_RATE, easeShare } from '../../../src/renderer/src/world/engine/viewMath'

/** A stand-in for OrbitControls' damping: each update applies its share of what is left of the motion, and decays the rest by it. */
function fakeControls(): { dampingFactor: number; left: number; moved: number; factors: number[]; args: unknown[][]; update(...a: unknown[]): boolean } {
  return {
    dampingFactor: 0.05,
    left: 1,
    moved: 0,
    factors: [],
    args: [],
    update(...a: unknown[]): boolean {
      this.factors.push(this.dampingFactor)
      this.args.push(a)
      this.moved += this.left * this.dampingFactor
      this.left *= 1 - this.dampingFactor
      return this.dampingFactor > 0
    },
  }
}

describe('timedUpdate', () => {
  it('ten input updates inside one 33 ms frame decay as much as one update 33 ms later', () => {
    let t = 1000
    const many = fakeControls()
    timedUpdate(many, CONTROLS_DAMPING_RATE, () => t)
    for (let i = 0; i < 10; i++) { t += 3.3; many.update() }
    t = 1000
    const one = fakeControls()
    timedUpdate(one, CONTROLS_DAMPING_RATE, () => t)
    t += 33
    one.update()
    expect(many.left).toBeCloseTo(one.left, 12)
    expect(many.moved).toBeCloseTo(one.moved, 12)
    expect(one.factors).toEqual([easeShare(CONTROLS_DAMPING_RATE, 0.033)])
    // A share fixed per frame (the old way) spends ten frames' worth in that one frame.
    expect(1 - Math.pow(1 - easeShare(CONTROLS_DAMPING_RATE, 0.033), 10)).toBeGreaterThan(1 - one.left + 0.3)
  })

  it('a zero or negative gap decays nothing', () => {
    let t = 500
    const c = fakeControls()
    timedUpdate(c, CONTROLS_DAMPING_RATE, () => t)
    c.update() // no time since it was wrapped
    t -= 5 // a clock that went back
    c.update()
    expect(c.factors).toEqual([0, 0])
    expect(c.left).toBe(1)
    expect(c.moved).toBe(0)
  })

  it('passes its arguments and its answer through, and stamps the time of each call', () => {
    let t = 0
    const c = fakeControls()
    timedUpdate(c, 6, () => t)
    t = 100
    expect(c.update(0.016)).toBe(true)
    expect(c.args).toEqual([[0.016]])
    t = 100 // the next call is measured from the last one, not from the wrap
    expect(c.update()).toBe(false)
    t = 350
    c.update()
    expect(c.factors).toEqual([easeShare(6, 0.1), 0, easeShare(6, 0.25)])
  })
})
