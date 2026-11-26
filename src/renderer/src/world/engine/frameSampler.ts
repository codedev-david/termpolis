// The 3D map's frame-time sampler (look spec §6.1): a ring of the last frame gaps the loop drew, and their p50, p95,
// p99 and worst by nearest rank. Pure, with no WebGL and no clock: the loop gives it each drawn frame's gap.

/** Frame times over some frames, in ms: each percentile is the nearest-rank one (the ceil(n * p)th smallest). */
export interface FrameStats {
  frames: number
  p50: number
  p95: number
  p99: number
  worst: number
}

export interface FrameSampler {
  /**
   * A frame was drawn `gapMs` after the one before. `counted` is false when the two were not drawn back to back (the
   * loop slept between them, the pane was hidden, the view was resized, the tier changed or the context came back):
   * that frame breaks the chain, and its gap is not counted. Returns whether the gap was counted.
   */
  add(gapMs: number, counted: boolean): boolean
  /** The next `n` frames are not counted (the first frames after a wake, a resize, a tier change or a restore). */
  skip(n: number): void
  /** The counted gaps in the ring, the last `size` of them. */
  stats(): FrameStats
  /** The counted gaps since the last window() (at most ten rings' worth, the newest), and a new window starts. */
  window(): FrameStats
  /** Forgets every gap, the window and any frames still to skip. */
  reset(): void
}

const NONE: FrameStats = { frames: 0, p50: 0, p95: 0, p99: 0, worst: 0 }

/** p50, p95, p99 and worst by nearest rank (as e2e/world-view.spec.ts reads its latencies). */
export function frameStats(gaps: readonly number[]): FrameStats {
  const n = gaps.length
  if (n === 0) return { ...NONE }
  const v = gaps.slice().sort((a, b) => a - b)
  const rank = (p: number): number => v[Math.min(n - 1, Math.ceil(n * p) - 1)]
  return { frames: n, p50: rank(0.5), p95: rank(0.95), p99: rank(0.99), worst: v[n - 1] }
}

/** A sampler keeping the last `size` counted gaps (600: ten seconds at 60 fps). */
export function createFrameSampler(size = 600): FrameSampler {
  const ring: number[] = []
  let at = 0
  // The window is a ring too (ten rings' worth): a full one overwrites its oldest gap, with no shift per frame.
  let win: number[] = []
  let winAt = 0
  const winMax = size * 10
  let skipLeft = 0
  return {
    add(gapMs, counted) {
      if (skipLeft > 0) {
        skipLeft--
        return false
      }
      if (!counted) return false
      if (ring.length < size) ring.push(gapMs)
      else ring[at] = gapMs
      at = (at + 1) % size
      if (win.length < winMax) win.push(gapMs)
      else win[winAt] = gapMs
      winAt = (winAt + 1) % winMax
      return true
    },
    skip(n) {
      skipLeft = Math.max(skipLeft, n)
    },
    stats: () => frameStats(ring),
    window() {
      const s = frameStats(win)
      win = []
      winAt = 0
      return s
    },
    reset() {
      ring.length = 0
      at = 0
      win = []
      winAt = 0
      skipLeft = 0
    },
  }
}
