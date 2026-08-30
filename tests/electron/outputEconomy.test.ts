import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  assignArm,
  emptyExperiment,
  recordOutput,
  mean,
  variance,
  assessSteering,
  projectedOutputSaving,
  costThinkingBand,
  recommendThinkingCap,
  formatOutputEconomy,
  OUTPUT_WEIGHT,
  HOLDOUT_RATE,
  MIN_SAMPLES_PER_ARM,
  T_CRITICAL,
  THINKING_MIN_BUDGET,
  MIN_BAND_REQUESTS,
  MIN_RELATIVE_GAIN,
  type Arm,
  type OutputExperiment,
  type ThinkingBand,
} from '../../src/main/headroom/outputEconomy'
import {
  initOutputEconomy,
  armForSession,
  recordProxyOutput,
  flushOutputEconomy,
  outputEconomyReport,
  outputEconomyState,
  resetOutputEconomy,
} from '../../src/main/headroom/outputEconomyStore'

/** Fill an arm with n samples alternating around `centre` so variance is non-zero and
 *  the t-test is exercised rather than short-circuited by a zero standard error. */
function fill(exp: OutputExperiment, arm: Arm, n: number, centre: number, spread = 20): void {
  for (let i = 0; i < n; i++) recordOutput(exp, arm, centre + (i % 2 === 0 ? spread : -spread))
}

const band = (over: Partial<ThinkingBand> = {}): ThinkingBand => ({
  requests: 100,
  meanOutputTokens: 500,
  meanTurns: 4,
  meanPrefixTokens: 20_000,
  ...over,
})

describe('outputEconomy/assignArm', () => {
  it('is deterministic, so a retried request cannot cross arms mid-experiment', () => {
    const key = 'C:/repos/termpolis'
    expect(assignArm(key)).toBe(assignArm(key))
  })

  it('splits close to the configured rate over many keys', () => {
    let holdout = 0
    for (let i = 0; i < 5000; i++) if (assignArm(`session-${i}`) === 'holdout') holdout++
    expect(holdout / 5000).toBeGreaterThan(HOLDOUT_RATE * 0.6)
    expect(holdout / 5000).toBeLessThan(HOLDOUT_RATE * 1.4)
  })

  it('honours an explicit rate at both extremes', () => {
    expect(assignArm('anything', 0)).toBe('steered')
    expect(assignArm('anything', 1)).toBe('holdout')
  })

  it('does not collapse similar keys into one arm', () => {
    const arms = new Set(Array.from({ length: 200 }, (_, i) => assignArm(`/repo/${i}`)))
    expect(arms.size).toBe(2)
  })

  it('handles an empty key without throwing', () => {
    expect(['steered', 'holdout']).toContain(assignArm(''))
  })

  it('holds out a tenth by default — cheap unless steering works, at which point it ends', () => {
    expect(HOLDOUT_RATE).toBe(0.1)
  })
})

describe('outputEconomy/recordOutput, mean, variance', () => {
  it('accumulates without retaining sample history', () => {
    const exp = emptyExperiment()
    recordOutput(exp, 'steered', 100)
    recordOutput(exp, 'steered', 300)
    expect(exp.steered).toEqual({ n: 2, sum: 400, sumSq: 100_000 })
    expect(mean(exp.steered)).toBe(200)
    expect(variance(exp.steered)).toBe(20_000)
  })

  it('refuses a malformed usage block rather than poisoning the running variance', () => {
    const exp = emptyExperiment()
    recordOutput(exp, 'steered', NaN)
    recordOutput(exp, 'steered', Infinity)
    recordOutput(exp, 'steered', -5)
    expect(exp.steered.n).toBe(0)
  })

  it('accepts a genuinely zero-output request', () => {
    const exp = emptyExperiment()
    recordOutput(exp, 'holdout', 0)
    expect(exp.holdout.n).toBe(1)
  })

  it('reports zero rather than NaN on an empty arm', () => {
    expect(mean({ n: 0, sum: 0, sumSq: 0 })).toBe(0)
    expect(variance({ n: 0, sum: 0, sumSq: 0 })).toBe(0)
    expect(variance({ n: 1, sum: 5, sumSq: 25 })).toBe(0)
  })

  it('clamps a cancellation-induced negative variance to zero', () => {
    // Near-constant large samples: the sum-of-squares form can go slightly negative.
    const exp = emptyExperiment()
    for (let i = 0; i < 50; i++) recordOutput(exp, 'steered', 1e8)
    expect(variance(exp.steered)).toBeGreaterThanOrEqual(0)
  })
})

describe('outputEconomy/assessSteering', () => {
  it('refuses to speak before it has samples — an early verdict is noise with a decimal point', () => {
    const exp = emptyExperiment()
    fill(exp, 'steered', MIN_SAMPLES_PER_ARM, 400)
    fill(exp, 'holdout', MIN_SAMPLES_PER_ARM - 1, 500)
    const a = assessSteering(exp)
    expect(a.verdict).toBe('insufficient')
    expect(a.t).toBe(0)
    expect(a.summary).toContain(`need ${MIN_SAMPLES_PER_ARM} per arm`)
    expect(a.n).toEqual({ steered: MIN_SAMPLES_PER_ARM, holdout: MIN_SAMPLES_PER_ARM - 1 })
  })

  it('reports helping when the holdout writes measurably more', () => {
    const exp = emptyExperiment()
    fill(exp, 'steered', 300, 400)
    fill(exp, 'holdout', 300, 500)
    const a = assessSteering(exp)
    expect(a.verdict).toBe('helping')
    expect(a.deltaPerRequest).toBeCloseTo(100)
    expect(a.t).toBeGreaterThan(T_CRITICAL)
    expect(a.summary).toContain('steering saves 100 output tokens/request')
    expect(a.summary).toContain('20.0%')
  })

  it('says the feature is COSTING tokens and recommends disabling it', () => {
    const exp = emptyExperiment()
    fill(exp, 'steered', 300, 600)
    fill(exp, 'holdout', 300, 500)
    const a = assessSteering(exp)
    expect(a.verdict).toBe('hurting')
    expect(a.t).toBeLessThan(-T_CRITICAL)
    expect(a.summary).toContain('recommend disabling')
  })

  it('reports neutral when the arms agree', () => {
    const exp = emptyExperiment()
    fill(exp, 'steered', 300, 500)
    fill(exp, 'holdout', 300, 500)
    const a = assessSteering(exp)
    expect(a.verdict).toBe('neutral')
    expect(a.summary).toContain('no measurable effect')
  })

  it('stays neutral rather than dividing by a zero standard error', () => {
    const exp = emptyExperiment()
    fill(exp, 'steered', 300, 400, 0)
    fill(exp, 'holdout', 300, 500, 0)
    const a = assessSteering(exp)
    expect(a.t).toBe(0)
    expect(a.verdict).toBe('neutral')
  })

  it('reports no effect, not a division by zero, when neither arm produced output', () => {
    const exp = emptyExperiment()
    for (let i = 0; i < 300; i++) {
      recordOutput(exp, 'steered', 0)
      recordOutput(exp, 'holdout', 0)
    }
    const a = assessSteering(exp)
    expect(a.verdict).toBe('neutral')
    expect(a.summary).toBe('no measurable effect (delta 0 tokens/request, t=0.00)')
  })
})

describe('outputEconomy/projectedOutputSaving', () => {
  it('prices a real effect in the same effective units as the rest of the receipt', () => {
    const exp = emptyExperiment()
    fill(exp, 'steered', 300, 400)
    fill(exp, 'holdout', 300, 500)
    expect(projectedOutputSaving(assessSteering(exp), 1000)).toBeCloseTo(100 * 1000 * OUTPUT_WEIGHT)
  })

  it('projects nothing from a verdict that is not "helping"', () => {
    const exp = emptyExperiment()
    fill(exp, 'steered', 300, 500)
    fill(exp, 'holdout', 300, 500)
    expect(projectedOutputSaving(assessSteering(exp))).toBe(0)
    expect(projectedOutputSaving(assessSteering(emptyExperiment()))).toBe(0)
  })
})

describe('outputEconomy/costThinkingBand', () => {
  it('prices output at 5x and a follow-up turn at the cached re-read rate', () => {
    const v = costThinkingBand(band({ meanOutputTokens: 100, meanTurns: 3, meanPrefixTokens: 10_000 }))
    expect(v.outputCost).toBe(500)
    expect(v.turnCost).toBe(3000)
    expect(v.totalCost).toBe(3500)
  })

  it('shows why an aggressive cap can lose: the turns it provokes outweigh the output it saves', () => {
    const thinky = costThinkingBand(band({ meanOutputTokens: 900, meanTurns: 3, meanPrefixTokens: 20_000 }))
    const capped = costThinkingBand(band({ meanOutputTokens: 500, meanTurns: 6, meanPrefixTokens: 20_000 }))
    // Capping cut 2,000 effective units of output and bought 6,000 of re-read prefix.
    expect(capped.outputCost).toBeLessThan(thinky.outputCost)
    expect(capped.totalCost).toBeGreaterThan(thinky.totalCost)
  })

  it('lets a cap win when it does not cost extra turns', () => {
    const thinky = costThinkingBand(band({ meanOutputTokens: 900, meanTurns: 3, meanPrefixTokens: 20_000 }))
    const capped = costThinkingBand(band({ meanOutputTokens: 500, meanTurns: 3, meanPrefixTokens: 20_000 }))
    expect(capped.totalCost).toBeLessThan(thinky.totalCost)
  })
})

describe('outputEconomy/recommendThinkingCap', () => {
  it('refuses to recommend from too little traffic', () => {
    const bands = new Map([[4096, band({ requests: MIN_BAND_REQUESTS - 1 })]])
    const r = recommendThinkingCap(bands, 8192)
    expect(r).toMatchObject({ cap: 8192, savingPerRequest: 0 })
    expect(r.reason).toContain(`need ${MIN_BAND_REQUESTS}+ requests in 2+ budget bands`)
  })

  it('ignores a band below Anthropic\u2019s floor however good its arithmetic looks', () => {
    const bands = new Map([
      [512, band({ meanOutputTokens: 1, meanTurns: 1, meanPrefixTokens: 1 })],
      [8192, band({ meanOutputTokens: 900 })],
    ])
    expect(recommendThinkingCap(bands, null).cap).toBeNull()
    expect(recommendThinkingCap(bands, null).reason).toContain('2+ budget bands')
    expect(THINKING_MIN_BUDGET).toBe(1024)
  })

  it('recommends the cheapest band once follow-up turns are counted', () => {
    const bands = new Map([
      [4096, band({ meanOutputTokens: 400, meanTurns: 4, meanPrefixTokens: 20_000 })],
      [16384, band({ meanOutputTokens: 900, meanTurns: 4, meanPrefixTokens: 20_000 })],
    ])
    const r = recommendThinkingCap(bands, null)
    expect(r.cap).toBe(4096)
    expect(r.savingPerRequest).toBeCloseTo((900 - 400) * OUTPUT_WEIGHT)
    expect(r.reason).toContain('once follow-up turns are counted')
  })

  it('declines to churn the cap for a marginal difference', () => {
    const bands = new Map([
      [4096, band({ meanOutputTokens: 500, meanTurns: 4, meanPrefixTokens: 20_000 })],
      [16384, band({ meanOutputTokens: 505, meanTurns: 4, meanPrefixTokens: 20_000 })],
    ])
    const r = recommendThinkingCap(bands, 8192)
    expect(r.cap).toBe(8192)
    expect(r.savingPerRequest).toBe(0)
    expect(r.reason).toContain(`no band is >${Math.round(MIN_RELATIVE_GAIN * 100)}% cheaper`)
  })

  it('leaves an already-tight cap alone rather than recommending a looser one', () => {
    const bands = new Map([
      [8192, band({ meanOutputTokens: 400, meanTurns: 4, meanPrefixTokens: 20_000 })],
      [16384, band({ meanOutputTokens: 900, meanTurns: 4, meanPrefixTokens: 20_000 })],
    ])
    const r = recommendThinkingCap(bands, 4096)
    expect(r.cap).toBe(4096)
    expect(r.reason).toContain('already at or below the cheapest band')
  })

  it('breaks a cost tie on the smaller budget', () => {
    const bands = new Map([
      [16384, band({ meanOutputTokens: 400 })],
      [4096, band({ meanOutputTokens: 400 })],
      [32768, band({ meanOutputTokens: 900 })],
    ])
    expect(recommendThinkingCap(bands, null).cap).toBe(4096)
  })

  it('does not divide by a zero worst-case cost', () => {
    const bands = new Map([
      [4096, band({ meanOutputTokens: 0, meanTurns: 0, meanPrefixTokens: 0 })],
      [8192, band({ meanOutputTokens: 0, meanTurns: 0, meanPrefixTokens: 0 })],
    ])
    const r = recommendThinkingCap(bands, null)
    expect(r.cap).toBeNull()
    expect(r.savingPerRequest).toBe(0)
  })
})

describe('outputEconomy/formatOutputEconomy', () => {
  it('leads with the share of the bill compression cannot reach', () => {
    const text = formatOutputEconomy(assessSteering(emptyExperiment()), { cap: null, reason: 'no data', savingPerRequest: 0 })
    expect(text.split('\n')[0]).toContain('the ~30% of the bill compression cannot reach')
    expect(text).toContain('thinking: uncapped — no data')
    expect(text).toContain('0 steered (mean 0) / 0 holdout (mean 0)')
  })

  it('names the recommended cap when there is one', () => {
    expect(formatOutputEconomy(assessSteering(emptyExperiment()), { cap: 4096, reason: 'cheapest', savingPerRequest: 1 }))
      .toContain('thinking: cap 4096 — cheapest')
  })
})

describe('outputEconomyStore', () => {
  let tmp: string
  const stateFile = () => path.join(tmp, 'headroom', 'output-economy.json')

  beforeEach(() => {
    resetOutputEconomy()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-oe-'))
    initOutputEconomy(tmp)
  })

  afterEach(() => {
    resetOutputEconomy()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* windows lock */ }
  })

  it('rejects an empty userData path', () => {
    expect(() => initOutputEconomy('')).toThrow('userDataPath required')
  })

  it('delegates arm assignment to the pure, deterministic splitter', () => {
    expect(armForSession('C:/repos/termpolis')).toBe(assignArm('C:/repos/termpolis'))
  })

  it('labels the arm from the wire, so a failed assignment shows up as data', () => {
    recordProxyOutput(true, 500)
    recordProxyOutput(false, 700)
    expect(outputEconomyState().experiment.steered.n).toBe(1)
    expect(outputEconomyState().experiment.holdout.n).toBe(1)
  })

  it('accumulates a band keyed by the requested thinking budget', () => {
    recordProxyOutput(true, 500, 4096, 3, 20_000)
    recordProxyOutput(true, 700, 4096, 5, 30_000)
    expect(outputEconomyState().bands['4096']).toEqual({ requests: 2, outputTokens: 1200, turns: 8, prefixTokens: 50_000 })
  })

  it('files an unbudgeted request under band 0 rather than dropping it', () => {
    recordProxyOutput(true, 500)
    expect(outputEconomyState().bands['0'].requests).toBe(1)
  })

  it('ignores a request with no output — nothing to attribute', () => {
    recordProxyOutput(true, 0, 4096)
    recordProxyOutput(true, NaN, 4096)
    recordProxyOutput(true, -1, 4096)
    expect(outputEconomyState().experiment.steered.n).toBe(0)
    expect(outputEconomyState().bands).toEqual({})
  })

  it('floors a fractional budget and clamps negative turn/prefix counts', () => {
    recordProxyOutput(true, 100, 4096.7, -5, -100)
    const b = outputEconomyState().bands['4096']
    expect(b).toEqual({ requests: 1, outputTokens: 100, turns: 0, prefixTokens: 0 })
  })

  it('survives a restart with the experiment intact', () => {
    recordProxyOutput(true, 500, 4096, 3, 1000)
    recordProxyOutput(false, 900, 4096, 3, 1000)
    flushOutputEconomy()
    expect(fs.existsSync(stateFile())).toBe(true)
    resetOutputEconomy()
    initOutputEconomy(tmp)
    expect(outputEconomyState().experiment.steered.sum).toBe(500)
    expect(outputEconomyState().bands['4096'].requests).toBe(2)
  })

  it('does not rewrite the file when nothing changed', () => {
    recordProxyOutput(true, 500)
    flushOutputEconomy()
    const first = fs.statSync(stateFile()).mtimeMs
    flushOutputEconomy()
    expect(fs.statSync(stateFile()).mtimeMs).toBe(first)
  })

  it('discards a corrupt file rather than reporting a verdict from numbers that never happened', () => {
    fs.mkdirSync(path.join(tmp, 'headroom'), { recursive: true })
    fs.writeFileSync(stateFile(), '{ not json', 'utf8')
    resetOutputEconomy()
    initOutputEconomy(tmp)
    expect(outputEconomyState().experiment.steered.n).toBe(0)
    expect(outputEconomyState().bands).toEqual({})
  })

  it('fills in missing halves of a partial file', () => {
    fs.mkdirSync(path.join(tmp, 'headroom'), { recursive: true })
    fs.writeFileSync(stateFile(), JSON.stringify({ bands: { '4096': { requests: 1, outputTokens: 2, turns: 0, prefixTokens: 0 } } }), 'utf8')
    resetOutputEconomy()
    initOutputEconomy(tmp)
    expect(outputEconomyState().experiment.steered.n).toBe(0)
    expect(outputEconomyState().bands['4096'].requests).toBe(1)
  })

  it('keeps running in memory when the state directory cannot be created', () => {
    resetOutputEconomy()
    fs.writeFileSync(path.join(tmp, 'blocker'), 'x', 'utf8')
    expect(() => initOutputEconomy(path.join(tmp, 'blocker'))).not.toThrow()
    recordProxyOutput(true, 500)
    expect(() => flushOutputEconomy()).not.toThrow()
    expect(outputEconomyState().experiment.steered.n).toBe(1)
  })

  it('is inert without an init rather than writing to an arbitrary path', () => {
    resetOutputEconomy()
    recordProxyOutput(true, 500)
    expect(() => flushOutputEconomy()).not.toThrow()
    expect(fs.existsSync(stateFile())).toBe(false)
  })

  it('derives band means on read, so counts and means can never disagree', () => {
    for (let i = 0; i < MIN_BAND_REQUESTS; i++) recordProxyOutput(true, 400, 4096, 4, 20_000)
    for (let i = 0; i < MIN_BAND_REQUESTS; i++) recordProxyOutput(true, 900, 4096 * 4, 4, 20_000)
    const report = outputEconomyReport(null)
    expect(report.thinking.cap).toBe(4096)
    expect(report.steering.verdict).toBe('insufficient')
    expect(report.text).toContain('Output economy')
  })

  it('skips a band whose key is not a number', () => {
    recordProxyOutput(true, 400, 4096, 4, 20_000)
    outputEconomyState().bands['nonsense'] = { requests: 100, outputTokens: 1, turns: 0, prefixTokens: 0 }
    expect(() => outputEconomyReport()).not.toThrow()
  })

  it('passes the current cap through to the recommendation', () => {
    expect(outputEconomyReport(8192).thinking.cap).toBe(8192)
    expect(outputEconomyReport().thinking.cap).toBeNull()
  })
})
