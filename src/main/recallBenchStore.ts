// recallBenchStore.ts
//
// The recorded baseline a recall benchmark run is compared against.
//
// One file, one object. A baseline is only ever written when explicitly asked for
// (`--save`), never automatically on a run: a benchmark that silently re-baselines
// itself can never report a regression, because every result becomes the new normal.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { BenchBaseline } from './recallBench'

let dir: string | null = null

function baselinePath(): string {
  return join(dir as string, 'recall-baseline.json')
}

export function initRecallBench(userDataPath: string): void {
  if (!userDataPath || typeof userDataPath !== 'string') throw new Error('initRecallBench: userDataPath required')
  dir = userDataPath
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* the bench still runs; only the baseline is lost */
  }
}

export function loadBenchBaseline(): BenchBaseline | null {
  if (!dir) return null
  try {
    if (!existsSync(baselinePath())) return null
    const parsed = JSON.parse(readFileSync(baselinePath(), 'utf8')) as Partial<BenchBaseline>
    if (typeof parsed.mrr !== 'number' || typeof parsed.recallAt5 !== 'number') return null
    return { mrr: parsed.mrr, recallAt5: parsed.recallAt5, ts: typeof parsed.ts === 'number' ? parsed.ts : 0 }
  } catch {
    // A corrupt baseline reads as "no baseline", which `checkRegression` treats as
    // not-a-regression. The alternative — a half-parsed baseline — would fail runs for
    // a reason that has nothing to do with recall quality.
    return null
  }
}

export function saveBenchBaseline(baseline: BenchBaseline): boolean {
  if (!dir) return false
  try {
    writeFileSync(baselinePath(), JSON.stringify(baseline, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/** Tests only. */
export function resetRecallBenchStore(): void {
  dir = null
}
