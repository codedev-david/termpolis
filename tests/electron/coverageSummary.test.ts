import { describe, it, expect } from 'vitest'
import { summarizeCoverage, type FileCoverage } from '../../src/main/coverageReader'

/**
 * summarizeCoverage is what the test_coverage MCP tool actually returns, so these pin the
 * shape an agent reads: numbers plus a short list of misses, never the raw line-hit map.
 */
function cov(lines: Record<number, number>, stale = false): FileCoverage {
  return { source: '/repo/coverage/lcov.info', lines, stale }
}

describe('summarizeCoverage', () => {
  it('counts the hits and lists the misses in ascending order', () => {
    // Keys deliberately out of order: lcov emits DA records in file order, but an object's
    // key order is not something to lean on when the output is meant to be read by a human.
    const r = summarizeCoverage(cov({ 10: 3, 11: 0, 12: 1, 9: 0 }))
    expect(r.total).toBe(4)
    expect(r.covered).toBe(2)
    expect(r.uncovered).toEqual([9, 11])
    expect(r.percent).toBe(50)
  })

  it('narrows to a hunk, so the question is about the lines just changed', () => {
    // The whole point of the range: this file is 50% covered overall and 0% where it matters.
    const r = summarizeCoverage(cov({ 1: 1, 2: 1, 50: 0, 51: 0 }), 50, 51)
    expect(r.total).toBe(2)
    expect(r.covered).toBe(0)
    expect(r.uncovered).toEqual([50, 51])
    expect(r.percent).toBe(0)
  })

  it('reports a null percent, not zero, for a range with nothing executable in it', () => {
    // A hunk touching only comments or braces is not 0% covered — it is not a question. A 0
    // there reads as a failure the agent should go and fix, and there is nothing to fix.
    const r = summarizeCoverage(cov({ 1: 1, 2: 1 }), 900, 999)
    expect(r.total).toBe(0)
    expect(r.percent).toBeNull()
    expect(r.uncovered).toEqual([])
  })

  it('rounds to one decimal rather than emitting a repeating fraction', () => {
    expect(summarizeCoverage(cov({ 1: 1, 2: 1, 3: 0 })).percent).toBe(66.7)
  })

  it('carries staleness and the artifact path through', () => {
    // Staleness is the difference between a number and a misleading number, so it must not be
    // dropped on the way out of the reader.
    const r = summarizeCoverage(cov({ 1: 0 }, true))
    expect(r.stale).toBe(true)
    expect(r.source).toBe('/repo/coverage/lcov.info')
  })

  it('accepts a range bounded on one side only', () => {
    expect(summarizeCoverage(cov({ 1: 1, 5: 0, 9: 0 }), 5).uncovered).toEqual([5, 9])
    expect(summarizeCoverage(cov({ 1: 1, 5: 0, 9: 0 }), undefined, 5).total).toBe(2)
  })

  it('treats a fully covered file as 100, with nothing to act on', () => {
    const r = summarizeCoverage(cov({ 1: 2, 2: 9 }))
    expect(r.percent).toBe(100)
    expect(r.uncovered).toEqual([])
  })
})
