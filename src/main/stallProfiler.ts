// What the CPU was ACTUALLY running while the app was frozen.
//
// Manual breadcrumbs (processHealth.markBusy) can only name work somebody remembered to label. The
// freeze you did not predict is, by definition, the one with no label on it — and that is the freeze
// worth naming. So we need an attribution that requires no foresight.
//
// V8's sampling CPU profiler gives us exactly that, because of one property that is easy to miss:
// **the sampler runs on its own native thread.** It interrupts the JS thread and walks its stack, so
// it keeps taking samples straight through a block that has the event loop completely dead. Measured
// on this machine: 238 samples across 2.4 s of hard blocking, correctly attributed to `blockFor`,
// `JSON.parse`'s JS caller, the blocking `read` syscall, and GC — each with its own self-time.
//
// That is the whole trick. Everything else in this file is bookkeeping around it:
//
//   - `session.post` callbacks are SYNCHRONOUS (verified), so the watchdog — itself a synchronous
//     timer callback — can harvest a profile inline and write one complete record. No async
//     enrichment, so a freeze bad enough that the user force-quits still leaves its stack behind.
//   - `Profiler.stop` blocks the thread for 4-15 ms even on a 60 s profile (5,701 samples), which is
//     an order of magnitude under the 400 ms we would record as a freeze. The instrument cannot
//     manufacture the disease. We rotate the profile every 30 s to keep it that way.
//   - `profile.startTime` is MONOTONIC microseconds, not epoch. It has to be anchored to Date.now()
//     at start, or every stack lands in the wrong window — silently, and plausibly.
//
// KNOWN LIMIT, and it is worth knowing before you read a stack and go looking:
//
//   Once V8 has INLINED a hot function into its caller, the callee stops appearing as a leaf and its
//   time is charged to the CALLER instead. Measured here: the same function, sampled cold, reports
//   `chewTheCpuForAWhile 700ms`; sampled again once hot, the identical work reports `round 700ms` —
//   its caller — and the callee is simply gone.
//
//   So the sampler is never WRONG, but it can be COARSE: the frame you get is always a true frame on
//   the stack, sometimes an ancestor of the one you wanted. In practice this barely touches us — the
//   freezes worth naming are long, cold, allocation- and syscall-heavy (a 464 MB read, 108k AES
//   decrypts, a 1.9 GB index build), which is exactly the code V8 does not inline into one frame.
//   But it is why the panel shows the top several frames rather than one, and why a hand-written
//   label (markBusy) is still the better answer whenever we can be bothered to write one.

import { Session } from 'node:inspector'

/** A frame the CPU was actually in during the freeze, with the time it held the thread. */
export interface SampledFrame {
  /** The function itself. May be native — `(garbage collector)`, `readFileSync` — which is a real answer. */
  fn: string
  /** Nearest source location in OUR code, so even a native leaf points somewhere you can go and look. */
  file: string
  line: number
  /** Self-time inside the freeze window. */
  ms: number
}

export interface SampledWindow {
  /** Hottest first. */
  frames: SampledFrame[]
  /** Time in GC, per the sampler — an INDEPENDENT witness to the PerformanceObserver's number. */
  gcMs: number
  sampleCount: number
}

/** V8's CPU profile, as far as we care about it. */
interface ProfileNode {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number }
  children?: number[]
}
export interface CpuProfile {
  nodes: ProfileNode[]
  /** Monotonic microseconds. NOT an epoch. */
  startTime: number
  samples?: number[]
  /** Microseconds since the previous sample. */
  timeDeltas?: number[]
}

/** Ties V8's monotonic microsecond clock to wall time, so samples can be placed in a stall window. */
export interface ClockAnchor {
  /** Date.now() when the profile started. */
  epochMs: number
  /** profile.startTime for that same profile. */
  monotonicUs: number
}

// V8's synthetic frames. `(garbage collector)` is a real, useful answer and is counted separately.
// `(idle)` means the loop was NOT blocked — it is the opposite of a freeze, and must never be blamed
// for one. `(root)` / `(program)` carry no information a user can act on.
const GC_FRAME = '(garbage collector)'
const NOISE_FRAMES = new Set(['(root)', '(idle)', '(program)'])

/** Is this a location in OUR code, rather than node/electron internals? */
function isOwnCode(url: string): boolean {
  if (!url) return false
  if (url.startsWith('node:') || url.startsWith('electron/')) return false
  // A bare `evalmachine`/anonymous eval frame is not somewhere anyone can go and look.
  return !url.startsWith('evalmachine')
}

function basename(url: string): string {
  const cut = url.split(/[\\/]/).pop() ?? url
  return cut.split('?')[0]
}

/**
 * Turn a raw profile into "what held the thread during [fromMs, toMs]".
 *
 * PURE — profile in, attribution out — so the whole thing is testable against a synthetic profile
 * with no inspector, no timing, and no flake.
 *
 * The subtlety is native leaves. A 464 MB `readFileSync` samples as a native `read` frame with no
 * source location at all; blaming "read" would be true and useless. So for any leaf without a
 * location we climb the call tree to the nearest frame that IS in our code, and report the leaf's
 * name AT that caller's location. `read @ swarmMemory.ts:377` is an answer you can act on.
 */
export function attributeProfile(
  profile: CpuProfile,
  anchor: ClockAnchor,
  fromMs: number,
  toMs: number,
): SampledWindow {
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  if (samples.length === 0) return { frames: [], gcMs: 0, sampleCount: 0 }

  const byId = new Map<number, ProfileNode>()
  for (const n of profile.nodes) byId.set(n.id, n)
  // The profile gives children, not parents. Invert it once so a leaf can climb.
  const parentOf = new Map<number, number>()
  for (const n of profile.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id)

  /** The nearest ancestor (or self) that lives in our own source. */
  const ownLocation = (id: number): { file: string; line: number } => {
    let cur: number | undefined = id
    for (let hops = 0; cur !== undefined && hops < 64; hops++) {
      const n = byId.get(cur)
      if (!n) break
      if (isOwnCode(n.callFrame.url)) {
        return { file: basename(n.callFrame.url), line: n.callFrame.lineNumber + 1 } // V8 is 0-based
      }
      cur = parentOf.get(cur)
    }
    return { file: '', line: 0 }
  }

  const self = new Map<string, SampledFrame>()
  let gcMs = 0
  let counted = 0
  let tUs = profile.startTime

  for (let i = 0; i < samples.length; i++) {
    // A sample's delta is the time since the PREVIOUS sample, so the clock advances first and the
    // sample is stamped at the arrival time. Off-by-one here shifts every frame by one sample.
    tUs += deltas[i] ?? 0
    const epochMs = anchor.epochMs + (tUs - anchor.monotonicUs) / 1000
    if (epochMs < fromMs || epochMs > toMs) continue

    const node = byId.get(samples[i])
    if (!node) continue
    const name = node.callFrame.functionName || '(anonymous)'
    // Charge the sample the time it represents: the gap since the last sample.
    const ms = (deltas[i] ?? 0) / 1000
    counted++

    if (name === GC_FRAME) {
      gcMs += ms
      // GC still gets a row — "the collector held the thread for 1.9 s" is exactly the kind of thing
      // this panel exists to say out loud.
    } else if (NOISE_FRAMES.has(name)) {
      continue
    }

    const loc = ownLocation(node.id)
    // Key on name AND location: the same `read` under two different callers are two different
    // findings, and merging them would hide which one froze you.
    const key = name + '|' + loc.file + '|' + loc.line
    const prev = self.get(key)
    if (prev) prev.ms += ms
    else self.set(key, { fn: name, file: loc.file, line: loc.line, ms })
  }

  const frames = [...self.values()]
    .map((f) => ({ ...f, ms: Math.round(f.ms) }))
    .filter((f) => f.ms > 0)
    .sort((a, b) => b.ms - a.ms)

  return { frames, gcMs: Math.round(gcMs), sampleCount: counted }
}

// --- the live sampler ---------------------------------------------------------------------------

/** 10 ms between samples. Fine enough to resolve a 400 ms freeze into frames, coarse enough to be free. */
export const SAMPLE_INTERVAL_US = 10_000
/** Rotate the profile on this cadence so `Profiler.stop` stays a few ms, never a freeze of its own. */
export const PROFILE_ROTATE_MS = 30_000
/** How many frames are worth keeping. Past this it is a flame graph, not an answer. */
const MAX_FRAMES = 6

let session: Session | null = null
let anchor: ClockAnchor | null = null
let startedAtMs = 0

/** Send a command and take the answer NOW — the inspector answers in-process, synchronously. */
function post<T>(method: string, params?: Record<string, unknown>): T | null {
  if (!session) return null
  let out: T | null = null
  let failed = false
  try {
    session.post(method, params as never, (err, res) => {
      if (err) failed = true
      else out = res as T
    })
  } catch {
    return null
  }
  return failed ? null : out
}

/**
 * Arm the sampler. Returns false — never throws — if this runtime will not give us a profiler, in
 * which case stall attribution quietly degrades to labelled spans only.
 */
export function startStallProfiler(now: () => number = Date.now, intervalUs = SAMPLE_INTERVAL_US): boolean {
  if (session) return true
  try {
    session = new Session()
    session.connect()
    post('Profiler.enable')
    post('Profiler.setSamplingInterval', { interval: intervalUs })
    const at = now()
    post('Profiler.start')
    // The anchor's monotonicUs is only known once a profile comes back, so seed it from the first
    // harvest (see `harvest`). Until then we hold the wall time we started at.
    anchor = { epochMs: at, monotonicUs: Number.NaN }
    startedAtMs = at
    return true
  } catch {
    stopStallProfiler()
    return false
  }
}

export function stopStallProfiler(): void {
  try {
    if (session) {
      post('Profiler.stop')
      post('Profiler.disable')
      session.disconnect()
    }
  } catch {
    /* teardown must never be the thing that takes down the app */
  }
  session = null
  anchor = null
  startedAtMs = 0
}

export function isStallProfilerRunning(): boolean {
  return session !== null
}

/** Stop, re-arm, and hand back the profile that just ended. Synchronous — see the header. */
function harvest(now: () => number): { profile: CpuProfile; anchor: ClockAnchor } | null {
  if (!session || !anchor) return null
  const stopped = post<{ profile: CpuProfile }>('Profiler.stop')
  const ended = anchor

  // Re-arm immediately, so the window between two profiles is microseconds rather than milliseconds.
  const at = now()
  post('Profiler.start')
  anchor = { epochMs: at, monotonicUs: Number.NaN }
  startedAtMs = at

  if (!stopped?.profile) return null
  const profile = stopped.profile
  // First harvest: we now know what V8's monotonic clock read when this profile began, so the
  // wall-time anchor we saved at start finally has something to be anchored TO.
  const resolved: ClockAnchor = { epochMs: ended.epochMs, monotonicUs: profile.startTime }
  return { profile, anchor: resolved }
}

/**
 * What ran during [fromMs, toMs]. Call this from the stall watchdog, synchronously, the moment the
 * thread comes back — the samples are already collected and waiting.
 */
export function sampleStallWindow(fromMs: number, toMs: number, now: () => number = Date.now): SampledWindow | null {
  const h = harvest(now)
  if (!h) return null
  const w = attributeProfile(h.profile, h.anchor, fromMs, toMs)
  return { ...w, frames: w.frames.slice(0, MAX_FRAMES) }
}

/**
 * Keep the live profile short. Called on the healthy ticks; a long-lived profile costs memory and
 * makes its own `Profiler.stop` slow, which is precisely the failure this whole file exists to catch.
 */
export function rotateStallProfileIfStale(now: () => number = Date.now): boolean {
  if (!session || !startedAtMs) return false
  if (now() - startedAtMs < PROFILE_ROTATE_MS) return false
  harvest(now) // discard: no freeze happened, so there is nothing in it worth keeping
  return true
}

/** @internal test-only */
export function _resetStallProfilerForTests(): void {
  session = null
  anchor = null
  startedAtMs = 0
}
