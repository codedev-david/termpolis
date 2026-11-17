import { describe, it, expect, vi } from 'vitest'
import {
  createCameraRig,
  easeInOut,
  poseAlong,
  FRAME_FLIGHT_S,
  GLIDE_S,
  OVERVIEW_FLIGHT_S,
  type CameraRigDeps,
  type Pose,
} from '../../../src/renderer/src/world/engine/cameraRig'

const pose = (x: number, y: number, z: number, tx = 0, ty = 0, tz = 0): Pose => ({ pos: [x, y, z], target: [tx, ty, tz] })

/** A rig over a fake camera: `home` and the framings' shots follow the panels (`reserve`), the clock is manual. */
function rigWith(opts: { reduced?: boolean } = {}) {
  const w = {
    t: 0,
    reserve: 0,
    cam: pose(5, 5, 5),
    modes: 0,
    apply: (p: Pose): void => { w.cam = p },
    halts: 0,
    halt: (): void => { w.halts++ },
  }
  const deps: CameraRigDeps<string> = {
    // The home pose moves back as the bottom reserve grows: an awkward, non-round number.
    home: () => pose(40 + w.reserve * 0.137, 120 + w.reserve * 0.291, 165, 10, 0, 4 + w.reserve * 0.05),
    shot: (f) => (f === 'none' ? null : pose(f.length * 3 + w.reserve, 9, 11, f.length, 0, 0)),
    current: () => w.cam,
    apply: (p) => w.apply(p),
    halt: () => w.halt(),
    onMode: () => { w.modes++ },
    now: () => w.t,
    reduced: opts.reduced ?? false,
  }
  const rig = createCameraRig<string>(deps)
  /** Runs frames of 16 ms for `ms`. */
  const run = (ms: number): void => {
    const end = w.t + ms
    while (w.t < end) { w.t = Math.min(end, w.t + 16); rig.step() }
  }
  return { w, deps, rig, run }
}

describe('easeInOut and poseAlong', () => {
  it('eases from 0 to 1 through the middle', () => {
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(0.25)).toBeCloseTo(0.0625)
    expect(easeInOut(0.5)).toBe(0.5)
    expect(easeInOut(0.75)).toBeCloseTo(0.9375)
    expect(easeInOut(1)).toBe(1)
  })

  it('lands exactly on the goal, whatever it started from', () => {
    const to = pose(0.1, 0.2, 0.3, 0.7, 0.11, 0.13)
    // a + (b - a) * 1 is not always b in floating point: the end is the goal itself.
    expect(poseAlong(pose(1e9, -3.3, 7.77), to, 1)).toEqual(to)
    expect(poseAlong(pose(-0.3, 1e-9, 2), to, 1.5)).toEqual(to)
    expect(poseAlong(pose(0, 0, 0), to, 1).pos).not.toBe(to.pos) // a copy
    expect(poseAlong(pose(0, 0, 0, 0, 0, 0), pose(2, 4, 6, 8, 10, 12), 0.5)).toEqual(pose(1, 2, 3, 4, 5, 6))
    expect(poseAlong(pose(1, 1, 1), pose(2, 2, 2), -1)).toEqual(pose(1, 1, 1))
  })
})

describe('createCameraRig', () => {
  it('starts free with no framing, no card and no flight', () => {
    const { rig } = rigWith()
    expect(rig.mode()).toBe('free')
    expect(rig.framing()).toBeNull()
    expect(rig.withCard()).toBe(false)
    expect(rig.flying()).toBe(false)
  })

  it('flies to the overview and lands exactly on the home pose', async () => {
    const { w, rig, run, deps } = rigWith()
    const landed = vi.fn()
    void rig.overview(false).then(landed)
    expect(rig.mode()).toBe('overview')
    expect(rig.withCard()).toBe(false)
    expect(w.modes).toBe(1)
    run(OVERVIEW_FLIGHT_S * 1000 / 2)
    expect(rig.flying()).toBe(true)
    expect(w.cam).not.toEqual(deps.home())
    run(OVERVIEW_FLIGHT_S * 1000 / 2 + 32)
    expect(rig.flying()).toBe(false)
    expect(w.cam).toEqual(deps.home())
    await Promise.resolve()
    expect(landed).toHaveBeenCalled()
  })

  it('reaches the same overview pose fresh and after a card opened, closed and the view was reset', () => {
    // Fresh: straight to the overview.
    const a = rigWith()
    void a.rig.overview(false)
    a.run(2500)
    // The other way: a click frames a building, its card opens (a panel change), the card closes
    // (which resets the view), its reserve goes, then Reset view again.
    const b = rigWith()
    void b.rig.overview(false)
    b.run(2500)
    void b.rig.frame('routes', false)
    b.run(120)
    b.w.reserve = 0 // the card's reserve is not a reserve the home pose reads
    b.rig.refit() // the card opened: the framing is done again around it
    b.run(50)
    void b.rig.overview(false) // the card's close resets the view
    b.rig.cardClosed()
    b.rig.refit() // its reserve went
    b.run(20)
    void b.rig.overview(false) // Reset view
    b.run(2500)
    expect(b.w.cam).toEqual(a.w.cam)
    expect(b.rig.mode()).toBe('overview')
    expect(b.rig.framing()).toBeNull()
  })

  it('card closes, then reset: the close drops the framing without moving the camera, the reset lands home', () => {
    const { w, rig, run, deps } = rigWith()
    void rig.frame('routes', false)
    run(FRAME_FLIGHT_S * 1000 + 32)
    const atShot = w.cam
    expect(rig.mode()).toBe('framing')
    expect(rig.withCard()).toBe(true)
    rig.cardClosed()
    expect(rig.mode()).toBe('free')
    expect(rig.framing()).toBeNull()
    expect(rig.withCard()).toBe(false)
    // A panel changing now (the card's reserve going, the ask bar) does not fly back into the close-up.
    w.reserve = 40
    rig.refit()
    run(1000)
    expect(w.cam).toBe(atShot)
    expect(rig.flying()).toBe(false)
    void rig.overview(false)
    run(2500)
    expect(w.cam).toEqual(deps.home())
  })

  it('a card closing on no framing changes nothing', () => {
    const { w, rig } = rigWith()
    void rig.overview(true)
    const modes = w.modes
    rig.cardClosed()
    expect(rig.mode()).toBe('overview')
    expect(w.modes).toBe(modes)
  })

  it('reset during a reserve glide lands on the home pose for the latest reserves', () => {
    const { w, rig, run, deps } = rigWith()
    void rig.overview(true)
    expect(w.cam).toEqual(deps.home())
    // The ask bar grows: the camera glides to the new home pose.
    w.reserve = 120
    rig.refit()
    expect(rig.flying()).toBe(true)
    run(GLIDE_S * 1000 / 3)
    // Reset view mid-glide, then the bar shrinks while the reset flies.
    void rig.overview(false)
    run(400)
    w.reserve = 33
    rig.refit()
    run(2500)
    expect(w.cam).toEqual(deps.home())
    // And it is the pose a fresh reset with those reserves gives.
    const fresh = rigWith()
    fresh.w.reserve = 33
    void fresh.rig.overview(false)
    fresh.run(2500)
    expect(w.cam).toEqual(fresh.w.cam)
  })

  it('repeated resets from anywhere land on the same pose', () => {
    const { w, rig, run } = rigWith()
    const seen: Pose[] = []
    for (const start of [pose(1, 2, 3), pose(-400, 7.25, 0.001), pose(1e-7, 999, -13)]) {
      w.cam = start
      void rig.overview(false)
      run(700) // cut short by the next reset half the time
      void rig.overview(false)
      run(2500)
      seen.push(w.cam)
    }
    expect(seen[1]).toEqual(seen[0])
    expect(seen[2]).toEqual(seen[0])
  })

  it('a reset settles the flight it replaces', async () => {
    const { rig } = rigWith()
    const first = vi.fn()
    void rig.frame('routes', false).then(first)
    void rig.overview(false)
    await Promise.resolve()
    expect(first).toHaveBeenCalled()
  })

  it('a panel change at the overview glides home; none when the camera is already there', () => {
    const { w, rig, run, deps } = rigWith()
    void rig.overview(true)
    rig.refit()
    expect(rig.flying()).toBe(false)
    w.reserve = 10
    rig.refit()
    run(GLIDE_S * 1000 + 32)
    expect(w.cam).toEqual(deps.home())
  })

  it('a panel change on a framing does the framing again; a free camera stays', () => {
    const { w, rig, run, deps } = rigWith()
    void rig.frame('routes', true)
    expect(w.cam).toEqual(deps.shot('routes'))
    w.reserve = 7
    rig.refit()
    run(GLIDE_S * 1000 + 32)
    expect(w.cam).toEqual(deps.shot('routes'))
    rig.keys()
    const here = w.cam
    w.reserve = 70
    rig.refit()
    run(1000)
    expect(w.cam).toBe(here)
  })

  it('a framing with nothing to frame changes nothing', async () => {
    const { w, rig } = rigWith()
    void rig.overview(true)
    await rig.frame('none', false)
    expect(rig.mode()).toBe('overview')
    expect(rig.flying()).toBe(false)
    expect(w.modes).toBe(1)
  })

  it('a plain click (a press with no movement) leaves the camera, its flight and the picture alone', () => {
    const { w, rig, run, deps } = rigWith()
    void rig.overview(false)
    run(300)
    const modes = w.modes
    rig.press()
    rig.release()
    expect(rig.mode()).toBe('overview')
    expect(rig.flying()).toBe(true)
    expect(rig.withCard()).toBe(false)
    expect(w.modes).toBe(modes)
    run(2500)
    expect(w.cam).toEqual(deps.home())
  })

  it('the rig moving the camera under a held pointer is not the hand', () => {
    const { w, rig, run, deps } = rigWith()
    rig.press()
    // The controls report a change while the rig applies a pose (their update runs inside apply).
    w.apply = (p) => { w.cam = p; expect(rig.move()).toBe(false) }
    void rig.overview(false)
    run(2500)
    expect(rig.mode()).toBe('overview')
    expect(w.cam).toEqual(deps.home())
  })

  it('every flight and glide first spends the controls\' own glide, and that is not the hand either', () => {
    const { w, rig, run } = rigWith()
    rig.press()
    w.halt = () => { w.halts++; expect(rig.move()).toBe(false) }
    void rig.overview(false)
    expect(w.halts).toBe(1)
    run(2500)
    w.reserve = 20
    rig.refit()
    expect(w.halts).toBe(2)
    void rig.frame('routes', true)
    expect(w.halts).toBe(3)
    expect(rig.mode()).toBe('framing')
  })

  it('a drag takes the camera over: the flight stops where it is and the framing goes', async () => {
    const { w, rig, run } = rigWith()
    const landed = vi.fn()
    void rig.frame('routes', false).then(landed)
    run(300)
    const here = w.cam
    expect(rig.move()).toBe(false) // not pressed: the controls' own damping, say
    expect(rig.mode()).toBe('framing')
    rig.press()
    expect(rig.move()).toBe(true)
    expect(rig.mode()).toBe('free')
    expect(rig.framing()).toBeNull()
    expect(rig.flying()).toBe(false)
    // Moved off a framing: the picture stays around the open card.
    expect(rig.withCard()).toBe(true)
    expect(rig.move()).toBe(false) // already the hand's
    expect(rig.withCard()).toBe(true)
    run(1000)
    expect(w.cam).toBe(here)
    await Promise.resolve()
    expect(landed).toHaveBeenCalled()
    rig.release()
    rig.keys()
    expect(rig.withCard()).toBe(true)
  })

  it('a drag at the overview or the keys leave the picture without the card', () => {
    const { rig } = rigWith()
    void rig.overview(true)
    rig.press()
    expect(rig.move()).toBe(true)
    expect(rig.withCard()).toBe(false)
    rig.release()
    void rig.overview(true)
    rig.keys()
    expect(rig.mode()).toBe('free')
    expect(rig.withCard()).toBe(false)
    void rig.frame('routes', true)
    rig.keys()
    expect(rig.withCard()).toBe(true)
  })

  it('a resize at the overview moves there at once; mid-flight it re-aims the flight', () => {
    const { w, rig, run, deps } = rigWith()
    void rig.overview(true)
    w.reserve = 50
    rig.resized()
    expect(rig.flying()).toBe(false)
    expect(w.cam).toEqual(deps.home())
    w.cam = pose(0, 0, 0)
    void rig.overview(false)
    run(200)
    w.reserve = 5
    rig.resized()
    expect(rig.flying()).toBe(true)
    run(2500)
    expect(w.cam).toEqual(deps.home())
  })

  it('a resize does a framing again and leaves a free camera', () => {
    const { w, rig, run, deps } = rigWith()
    void rig.frame('routes', true)
    w.reserve = 9
    rig.resized()
    run(GLIDE_S * 1000 + 32)
    expect(w.cam).toEqual(deps.shot('routes'))
    rig.keys()
    const here = w.cam
    rig.resized()
    expect(w.cam).toBe(here)
    expect(rig.flying()).toBe(false)
  })

  it('under reduced motion every flight and glide lands at once', async () => {
    const { w, rig, deps } = rigWith({ reduced: true })
    await rig.overview(false)
    expect(w.cam).toEqual(deps.home())
    w.reserve = 30
    rig.refit()
    expect(rig.flying()).toBe(false)
    expect(w.cam).toEqual(deps.home())
    await rig.frame('routes', false)
    expect(w.cam).toEqual(deps.shot('routes'))
  })

  it('stop ends a flight where the camera is and settles it; step without a flight does nothing', async () => {
    const { w, rig, run } = rigWith()
    rig.step()
    expect(w.cam).toEqual(pose(5, 5, 5))
    const landed = vi.fn()
    void rig.overview(false).then(landed)
    run(100)
    const here = w.cam
    rig.stop()
    expect(rig.flying()).toBe(false)
    run(500)
    expect(w.cam).toBe(here)
    await Promise.resolve()
    expect(landed).toHaveBeenCalled()
    rig.stop() // nothing to stop
  })

  it('a throwing apply does not leave the rig deaf to the hand', () => {
    const { w, rig } = rigWith()
    w.apply = () => { throw new Error('boom') }
    expect(() => rig.overview(true)).toThrow('boom')
    w.apply = (p) => { w.cam = p }
    rig.press()
    expect(rig.move()).toBe(true)
  })
})
