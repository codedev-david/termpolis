// sessionReflectPass.ts
//
// The one entry for a memory:reflect-session pass. It does two things the handler used to leave undone:
//
//  1. ONE pass per transcript at a time. Five terminals on one repo fire within the same second (60 s after
//     the last output, and again when a terminal closes) and the cursor is keyed on (cwd, agent), not on the
//     terminal: each of the five read the same transcript whole, found the same new turns (the cursor only
//     moves after the reflex resolves) and reflected them five times. Now a request that arrives while a
//     pass runs shares ONE trailing pass with every other request that arrives meanwhile. The trailing pass
//     starts after the running one ends, so a request is never answered by a pass that began before it
//     arrived (a terminal that closes, and flushes, still gets what was written up to then). Four requests
//     cost one extra pass that, if nothing changed, is a stat.
//  2. The delta reader (transcriptDelta): unless the caller brought its own, reflectSoloSession is given
//     readSessionDelta, which reads the cursor first and only what the transcript added after it.
//
// Kill switch: TERMPOLIS_REFLECT_FAST=off|0|false|no turns both off: the pass is exactly the call the
// handler used to make (reflectSoloSession with the deps it was given: whole transcript, no sharing).
//
// A pass that has run for FLIGHT_STALE_MS (a read hung on a locked file) is not waited for: the next request
// starts its own, so one stuck transcript cannot stop learning from that repo for good.

import { reflectSoloSession, type SoloReflexDeps, type SoloSessionInput } from './mnemeSession'
import { readSessionDelta } from './transcriptDelta'
import { sessionCursorKey } from './sessionCursorStore'
import { recordPass } from './passCounters'

export type ReflectResult = { fired: boolean; lessons: number }

export const REFLECT_FAST_ENV = 'TERMPOLIS_REFLECT_FAST'
/** A pass this old is taken for hung: the next request does not wait for it. */
export const FLIGHT_STALE_MS = 5 * 60_000

export function reflectFastEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env[REFLECT_FAST_ENV] ?? '').trim().toLowerCase()
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no')
}

// Passes are type-erased inside: the map only ever stores them, and singleFlight<T> casts once at its boundary.
interface Pass {
  run: () => Promise<unknown>
  /** Requests this pass answers. */
  callers: number
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  promise: Promise<unknown>
}

interface Flight {
  /** The pass that starts when this one ends: shared by every request that arrived meanwhile. */
  next: Pass | null
  startedAt: number
}

const flights = new Map<string, Flight>()

function newPass(run: () => Promise<unknown>): Pass {
  let resolve!: (value: unknown) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { run, callers: 1, resolve, reject, promise }
}

function launch(key: string, pass: Pass, now: () => number): void {
  const flight: Flight = { next: null, startedAt: now() }
  flights.set(key, flight)
  const began = flight.startedAt

  const finish = (result: { fired?: boolean; lessons?: number; failed?: boolean }): void => {
    recordPass('reflect', {
      callers: pass.callers,
      ms: now() - began,
      fired: result.fired ? 1 : 0,
      lessons: result.lessons ?? 0,
      failed: result.failed ? 1 : 0,
    })
    // Taken over after a hang: the newer flight owns the key and what was queued behind this one.
    if (flights.get(key) !== flight) return
    flights.delete(key)
    if (flight.next) launch(key, flight.next, now)
  }

  let started: Promise<unknown>
  try {
    started = pass.run()
  } catch (e) {
    started = Promise.reject(e)
  }
  started.then(
    (value) => {
      pass.resolve(value)
      const r = value as ReflectResult | null
      finish({ fired: !!r?.fired, lessons: typeof r?.lessons === 'number' ? r.lessons : 0 })
    },
    (err) => {
      pass.reject(err)
      finish({ failed: true })
    },
  )
}

/**
 * Run `run` for `key` with at most one running at a time. A request that arrives while one runs does not
 * start another: it joins the ONE pass that follows (and the latest request's `run` is the one that runs).
 */
export function singleFlight<T>(key: string, run: () => Promise<T>, now: () => number = Date.now): Promise<T> {
  const flight = flights.get(key)
  if (!flight) {
    const pass = newPass(run)
    launch(key, pass, now)
    return pass.promise as Promise<T>
  }
  const age = now() - flight.startedAt
  if (!(age >= 0 && age < FLIGHT_STALE_MS)) {
    // Hung (or the clock is not to be trusted): do not wait. Whatever was queued behind it runs now, with this request's closure.
    const pass = flight.next ?? newPass(run)
    if (flight.next) {
      pass.run = run
      pass.callers++
    }
    launch(key, pass, now)
    return pass.promise as Promise<T>
  }
  if (flight.next) {
    flight.next.run = run
    flight.next.callers++
    return flight.next.promise as Promise<T>
  }
  flight.next = newPass(run)
  return flight.next.promise as Promise<T>
}

/** Test seams. */
export function flightCount(): number {
  return flights.size
}
export function resetFlights(): void {
  flights.clear()
}

/**
 * One memory:reflect-session pass for `input`: reflectSoloSession, one at a time per transcript, with the
 * delta reader unless `deps` already has one. Resolves like reflectSoloSession; rejects like it.
 */
export function runSessionReflection(input: SoloSessionInput, deps: SoloReflexDeps, opts: { now?: () => number } = {}): Promise<ReflectResult> {
  const now = opts.now ?? Date.now
  if (!reflectFastEnabled()) {
    // Exactly the old call. Only the pass is counted, so the cost with and without the fast path can be compared.
    const began = now()
    const line = (r: Partial<ReflectResult> | null, failed: boolean): void =>
      recordPass('reflect', { callers: 1, legacy: 1, ms: now() - began, fired: r?.fired ? 1 : 0, lessons: r?.lessons ?? 0, failed: failed ? 1 : 0 })
    return reflectSoloSession(input, deps).then(
      (r) => {
        line(r, false)
        return r
      },
      (e) => {
        line(null, true)
        throw e
      },
    )
  }
  const withDelta: SoloReflexDeps = deps.readDelta ? deps : { ...deps, readDelta: readSessionDelta }
  return singleFlight(sessionCursorKey(input.cwd, input.agent), () => reflectSoloSession(input, withDelta), now)
}
