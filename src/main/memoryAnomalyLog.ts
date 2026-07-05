// memoryAnomalyLog.ts — a small, device-local log of SURPRISING memory events (degraded init,
// corrupt shard lines, embedder going unavailable, a clear, an eviction burst, an empty recall
// where one was expected). Its job is production burn-in: run the app for real across agents and
// have a concrete, reviewable trail of anything the brain found unusual — the signal that tells
// you whether the hardening actually holds in the wild, rather than guessing.
//
// Deliberately tiny + safe: recordAnomaly() is a NO-OP until initAnomalyLog() wires a directory,
// so callers (swarmMemory) can sprinkle it freely without coupling their unit tests to fs. Bounded
// (a capped ring, rewritten atomically) so it can never grow without limit. Not telemetry — it
// never leaves the device.

import * as fs from 'fs'
import * as path from 'path'

export interface Anomaly {
  ts: number
  kind: string
  detail: string
}

const FILE = 'memory-anomalies.json'
const CAP = 500

let dir: string | null = null
let ring: Anomaly[] = []

/** Wire the log to a directory and load any persisted anomalies (keeping the most recent CAP). */
export function initAnomalyLog(d: string): void {
  dir = d
  ring = []
  try {
    const data = JSON.parse(fs.readFileSync(path.join(d, FILE), 'utf8')) as Anomaly[]
    if (Array.isArray(data)) ring = data.filter(isAnomaly).slice(-CAP)
  } catch {
    /* none yet */
  }
}

function isAnomaly(x: unknown): x is Anomaly {
  const a = x as Anomaly
  return !!a && typeof a.ts === 'number' && typeof a.kind === 'string' && typeof a.detail === 'string'
}

/** Record one anomaly. No-op until initAnomalyLog() has run. `ts` is injectable for determinism. */
export function recordAnomaly(kind: string, detail: string = '', ts: number = Date.now()): void {
  if (!dir || !kind) return
  ring.push({ ts, kind, detail })
  if (ring.length > CAP) ring = ring.slice(-CAP)
  try {
    const target = path.join(dir, FILE)
    const tmp = `${target}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(ring))
    fs.renameSync(tmp, target) // atomic
  } catch {
    /* best effort — the in-memory ring still serves getAnomalies() this session */
  }
}

/** Most-recent-first anomalies, capped at `limit`. */
export function getAnomalies(limit = 100): Anomaly[] {
  return ring.slice(-Math.max(0, limit)).reverse()
}

/** Count anomalies of a given kind (for at-a-glance dashboard badges). */
export function anomalyCount(kind?: string): number {
  return kind ? ring.filter((a) => a.kind === kind).length : ring.length
}

export function _resetAnomalyLogForTests(): void {
  dir = null
  ring = []
}
