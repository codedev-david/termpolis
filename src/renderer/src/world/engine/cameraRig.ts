// Lumopolis camera rig: what the camera is doing (at the overview, on a framing, or moved by hand),
// its flights, and which free area the picture uses. Pure (no three.js): the renderer reads and
// writes the camera through `current` and `apply`, and calls `step` once a frame.
//
// The rules it keeps:
// - The overview (Reset view, Esc) drops any framing and flies to the home pose as it is when the
//   flight lands: a panel that changes while it flies re-aims it, and it lands exactly on the home
//   pose, whatever it started from, so every way back to the overview ends in the same place.
// - A framing on screen is done again when a panel changes; one that loses its card is dropped
//   where it is (closing a card never flies the camera back into its close-up).
// - Only a hand that really moves the camera (a drag, a wheel, the keys) takes it over. A plain
//   click (a press with no movement) leaves the camera, its flight and the picture as they are.

export type Vec3 = readonly [number, number, number]
/** Where the camera is and what it looks at. */
export interface Pose { pos: Vec3; target: Vec3 }
/** At (or flying to) the overview, on (or flying to) a framing, or left where a hand put it. */
export type RigMode = 'overview' | 'framing' | 'free'

export interface CameraRigDeps<F> {
  /** The overview's pose for the view and panels as they are now. */
  home(): Pose
  /** Where framing `f` puts the camera for the view and panels as they are now (null: nothing to frame). */
  shot(f: F): Pose | null
  /** The camera's pose now. */
  current(): Pose
  /** Puts the camera at `pose`. */
  apply(pose: Pose): void
  /** Ends any motion the controls carry on with by themselves (a drag's glide), so a flight lands where it aims. */
  halt(): void
  /** The mode changed: the picture moves to its free area (withCard). */
  onMode(): void
  now(): number
  /** Reduced motion: every flight and glide lands at once. */
  reduced: boolean
}

export interface CameraRig<F> {
  mode(): RigMode
  /** The framing on screen, if any. */
  framing(): F | null
  /** Whether the picture fits around the open card: on a framing, and after a hand moved one. */
  withCard(): boolean
  /** Whether a flight or glide is under way. */
  flying(): boolean
  /** The flight under way: how far along it is in time (`t`, 0 to 1) and in distance (`eased`); all zero when none. */
  flight(): FlightState
  /** Flies to the overview (`instant`: lands at once). Settles when it lands or is cut short. */
  overview(instant: boolean): Promise<void>
  /** Flies to framing `f` and keeps it. Nothing to frame: nothing changes. */
  frame(f: F, instant: boolean): Promise<void>
  /** Flies to a pose of its own (a saved view) and leaves the camera there, free of any framing. */
  to(pose: Pose, instant: boolean): Promise<void>
  /** A panel opened, closed or changed size: the overview or the framing on screen is done again. */
  refit(): void
  /** The view changed size: a camera at the overview with no flight moves there at once, else as refit. */
  resized(): void
  /** The open card closed: a framing is dropped where it is. */
  cardClosed(): void
  /** A pointer went down on the view (the hand may be about to move the camera). */
  press(): void
  /** The camera moved under the controls: while pressed, the hand takes it over. True when it just did. */
  move(): boolean
  /** The pointer is up. */
  release(): void
  /** The keys moved the camera: the hand takes it over. */
  keys(): void
  /** One frame: a flight under way moves the camera. */
  step(): void
  /** Ends any flight where the camera is (its promise settles). */
  stop(): void
  /** Ends any flight where it was going: the camera is put at its end at once (its promise settles). */
  land(): void
}

/** The default flight times, in seconds: to a framing, to the overview, and a panel's glide. */
export const FRAME_FLIGHT_S = 1.5
export const OVERVIEW_FLIGHT_S = 1.8
export const GLIDE_S = 0.6

/** Cubic ease in and out over k in [0, 1]. */
export function easeInOut(k: number): number {
  return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
}

const mix = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const near = (a: Vec3, b: Vec3): boolean => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 < 1e-6

/** The pose `k` of the way (eased) from `from` to `to`; exactly `to` at the end. */
export function poseAlong(from: Pose, to: Pose, k: number): Pose {
  if (k >= 1) return { pos: [...to.pos], target: [...to.target] }
  const e = easeInOut(Math.max(0, k))
  return { pos: mix(from.pos, to.pos, e), target: mix(from.target, to.target, e) }
}

/** What a flight looks like from outside: whether one is under way, its time `t` and its eased progress. */
export interface FlightState { active: boolean; t: number; eased: number }

interface Flight { from: Pose; to: Pose; start: number; dur: number; done: () => void }

export function createCameraRig<F>(deps: CameraRigDeps<F>): CameraRig<F> {
  let mode: RigMode = 'free'
  let framing: F | null = null
  /** Moved by hand off a framing: the picture stays around the card. */
  let handCard = false
  let pressed = false
  let flight: Flight | null = null
  /** The rig is moving the camera itself: the controls' change is not the hand's. */
  let applying = false

  /** Runs `fn` as the rig's own move of the camera: the controls' change it causes is not the hand's. */
  const own = (fn: () => void): void => {
    applying = true
    try { fn() } finally { applying = false }
  }
  const put = (pose: Pose): void => own(() => deps.apply(pose))
  const setMode = (m: RigMode, f: F | null, card = false): void => {
    handCard = card
    mode = m
    framing = f
    deps.onMode()
  }
  const stop = (): void => {
    const f = flight
    flight = null
    f?.done()
  }
  const fly = (to: Pose, instant: boolean, seconds: number): Promise<void> => {
    stop()
    own(deps.halt)
    if (instant || deps.reduced) {
      put({ pos: [...to.pos], target: [...to.target] })
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      flight = { from: deps.current(), to, start: deps.now(), dur: seconds * 1000, done: resolve }
    })
  }
  /** The camera moves to `to` without a new flight: one under way is re-aimed, a still camera glides. */
  const glide = (to: Pose): void => {
    if (flight) { flight.to = to; return }
    const now = deps.current()
    if (near(now.pos, to.pos) && near(now.target, to.target)) return
    void fly(to, false, GLIDE_S)
  }
  /** The pose the camera belongs at now: the overview's, the framing's, or none (moved by hand). */
  const goal = (): Pose | null => {
    if (mode === 'overview') return deps.home()
    return mode === 'framing' && framing !== null ? deps.shot(framing) : null
  }
  const takeOver = (): void => {
    stop()
    if (mode !== 'free') setMode('free', null, mode === 'framing')
  }

  return {
    mode: () => mode,
    framing: () => framing,
    withCard: () => mode === 'framing' || (mode === 'free' && handCard),
    flying: () => flight !== null,
    flight() {
      const f = flight
      if (!f) return { active: false, t: 0, eased: 0 }
      const t = Math.max(0, Math.min(1, (deps.now() - f.start) / f.dur))
      return { active: true, t, eased: easeInOut(t) }
    },
    overview(instant) {
      setMode('overview', null)
      return fly(deps.home(), instant, OVERVIEW_FLIGHT_S)
    },
    frame(f, instant) {
      const to = deps.shot(f)
      if (!to) return Promise.resolve()
      setMode('framing', f)
      return fly(to, instant, FRAME_FLIGHT_S)
    },
    to(pose, instant) {
      setMode('free', null, mode === 'framing' || (mode === 'free' && handCard))
      return fly({ pos: [...pose.pos], target: [...pose.target] }, instant, FRAME_FLIGHT_S)
    },
    // refit and resized ask for the framing's shot again on every panel change and every ResizeObserver call (a pane
    // divider dragged calls it each frame). A line's close-up is searched once per line, framing and layout and only
    // re-aimed here (threeRenderer lineShot, lineShotCache): no search runs in these.
    refit() {
      const to = goal()
      if (to) glide(to)
    },
    resized() {
      if (mode === 'overview' && !flight) { put(deps.home()); return }
      const to = goal()
      if (to) glide(to)
    },
    cardClosed() {
      if (mode === 'framing') setMode('free', null)
    },
    press() { pressed = true },
    move() {
      if (!pressed || applying) return false
      const was = mode !== 'free' || flight !== null
      takeOver()
      return was
    },
    release() { pressed = false },
    keys() { takeOver() },
    step() {
      const f = flight
      if (!f) return
      const k = Math.min(1, (deps.now() - f.start) / f.dur)
      put(poseAlong(f.from, f.to, k))
      if (k >= 1) stop()
    },
    stop,
    land() {
      const f = flight
      if (!f) return
      put(f.to)
      stop()
    },
  }
}
