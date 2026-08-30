// outputEconomyStore.ts
//
// The stateful edge around `outputEconomy`: where the randomized-holdout experiment and
// the thinking-budget bands accumulate, and where they are flushed to disk.
//
// Everything decision-shaped — arm assignment, the t-test, the verdict, the cap
// recommendation — lives in `outputEconomy.ts` and is pure. This file only accumulates
// and persists, so the statistics can be tested without a filesystem and the persistence
// can fail without corrupting a conclusion.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  assignArm,
  recordOutput,
  emptyExperiment,
  assessSteering,
  recommendThinkingCap,
  formatOutputEconomy,
  type Arm,
  type OutputExperiment,
  type ThinkingBand,
  type SteeringAssessment,
  type ThinkingRecommendation,
} from './outputEconomy'

/** Raw sums per budget. Means are derived on read rather than stored, so a resumed file
 *  can never carry a mean that disagrees with the counts it was computed from. */
interface BandSums {
  requests: number
  outputTokens: number
  turns: number
  prefixTokens: number
}

interface EconomyState {
  experiment: OutputExperiment
  /** Keyed by the requested thinking budget, so "does a bigger budget earn its 5x?" is
   *  answerable against real traffic rather than a guess. */
  bands: Record<string, BandSums>
}

let dir: string | null = null
let state: EconomyState = { experiment: emptyExperiment(), bands: {} }
let dirty = false

function statePath(): string {
  return join(dir as string, 'output-economy.json')
}

export function initOutputEconomy(userDataPath: string): void {
  if (!userDataPath || typeof userDataPath !== 'string') throw new Error('initOutputEconomy: userDataPath required')
  dir = join(userDataPath, 'headroom')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* the experiment still runs in memory */
  }
  try {
    if (existsSync(statePath())) {
      const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<EconomyState>
      state = {
        experiment: parsed.experiment ?? emptyExperiment(),
        bands: parsed.bands ?? {},
      }
    }
  } catch {
    // A corrupt file discards the experiment rather than poisoning it. Half-parsed arm
    // counts would produce a confident verdict from numbers that never happened, which is
    // strictly worse than starting the sample over.
    state = { experiment: emptyExperiment(), bands: {} }
  }
}

/** Which arm a session belongs to. Deterministic in the session key so a retried or
 *  resumed session never crosses arms mid-experiment — a session that switched sides
 *  would contribute its output to both means and bias the comparison in whichever
 *  direction it happened to fall. */
export function armForSession(sessionKey: string): Arm {
  return assignArm(sessionKey)
}

/** Record one completed request. `steered` is read off the WIRE, not off intent: the
 *  ground truth is whether the mark actually reached the model, so an arm assignment that
 *  failed to take effect shows up as data rather than as a silent mislabel. */
export function recordProxyOutput(
  steered: boolean,
  outputTokens: number,
  thinkBudget = 0,
  turns = 0,
  prefixTokens = 0,
): void {
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) return
  recordOutput(state.experiment, steered ? 'steered' : 'holdout', outputTokens)
  const key = String(Math.max(0, Math.floor(thinkBudget)))
  const band = state.bands[key] ?? { requests: 0, outputTokens: 0, turns: 0, prefixTokens: 0 }
  band.requests += 1
  band.outputTokens += outputTokens
  band.turns += Math.max(0, turns)
  band.prefixTokens += Math.max(0, prefixTokens)
  state.bands[key] = band
  dirty = true
}

export function flushOutputEconomy(): void {
  if (!dir || !dirty) return
  try {
    writeFileSync(statePath(), JSON.stringify(state), 'utf8')
    dirty = false
  } catch {
    /* best effort — the in-memory experiment is still valid this session */
  }
}

export function outputEconomyReport(currentCap: number | null = null): {
  steering: SteeringAssessment
  thinking: ThinkingRecommendation
  text: string
} {
  const steering = assessSteering(state.experiment)
  const bands = new Map<number, ThinkingBand>()
  for (const [key, sums] of Object.entries(state.bands)) {
    const budget = Number(key)
    if (!Number.isFinite(budget) || sums.requests <= 0) continue
    bands.set(budget, {
      requests: sums.requests,
      meanOutputTokens: sums.outputTokens / sums.requests,
      meanTurns: sums.turns / sums.requests,
      meanPrefixTokens: sums.prefixTokens / sums.requests,
    })
  }
  const thinking = recommendThinkingCap(bands, currentCap)
  return { steering, thinking, text: formatOutputEconomy(steering, thinking) }
}

export function outputEconomyState(): EconomyState {
  return state
}

/** Tests only. */
export function resetOutputEconomy(): void {
  dir = null
  state = { experiment: emptyExperiment(), bands: {} }
  dirty = false
}
