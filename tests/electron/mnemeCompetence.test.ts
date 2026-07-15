import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  initCompetence,
  recordOutcome,
  assessCompetence,
  competenceSummary,
  _resetCompetenceForTests,
} from '../../src/main/mnemeCompetence'

describe('mnemeCompetence — persistent self-competence store', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-comp-'))
    _resetCompetenceForTests()
    initCompetence(dir)
  })
  afterEach(() => {
    _resetCompetenceForTests()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('records an outcome and reflects it in the assessment', () => {
    recordOutcome('voice', true, 1000)
    const a = assessCompetence('voice')
    expect(a.known).toBe(true)
    expect(a.attempts).toBe(1)
  })

  it('accumulates multiple outcomes for a domain', () => {
    recordOutcome('build', true, 1)
    recordOutcome('build', false, 2)
    recordOutcome('build', true, 3)
    expect(assessCompetence('build').attempts).toBe(3)
  })

  it('reports an unknown domain', () => {
    expect(assessCompetence('never-seen').known).toBe(false)
  })

  it('persists across a reload (last-write-wins)', () => {
    recordOutcome('deploy', false, 1)
    recordOutcome('deploy', false, 2)
    _resetCompetenceForTests()
    initCompetence(dir)
    const a = assessCompetence('deploy')
    expect(a.attempts).toBe(2)
    expect(a.confidence).toBeLessThan(0.5)
  })

  it('summarizes weak domains for the primer', () => {
    recordOutcome('flaky', false, 1)
    recordOutcome('flaky', false, 2)
    recordOutcome('flaky', true, 3)
    recordOutcome('flaky', false, 4)
    expect(competenceSummary()).toMatch(/flaky/)
  })

  it('works in-memory when not initialized (no persistence)', () => {
    _resetCompetenceForTests()
    const r = recordOutcome('adhoc', true, 1)
    expect(r.attempts).toBe(1)
    expect(assessCompetence('adhoc').attempts).toBe(1)
  })

  it('tolerates corrupt / blank lines on load', () => {
    const fp = path.join(dir, 'mneme-competence.jsonl')
    fs.writeFileSync(
      fp,
      'not json\n\n' + JSON.stringify({ domain: 'ok', attempts: 2, successes: 1, lastTs: 5, confidence: 0.1 }) + '\n',
    )
    _resetCompetenceForTests()
    initCompetence(dir)
    expect(assessCompetence('ok').attempts).toBe(2)
  })

  it('purges the stale home-directory (account-name) domain on load, durably', () => {
    // Before v1.26.2, opening a terminal in ~ normalized to the home basename — the user's ACCOUNT
    // NAME — as a "project", and a project is a competence domain (mnemeReflex). normalizeProjectSlug
    // now rejects home, but the record it already wrote replays forever: a dashboard bar labelled
    // with the user's own name, and "low competence in <name>" atop every agent primer. It can never
    // be legitimately reproduced, so initCompetence drops it on load and rewrites the sidecar.
    const home = (os.homedir().replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '').toLowerCase()
    expect(home).not.toBe('') // sanity: the test box has a real home dir
    const fp = path.join(dir, 'mneme-competence.jsonl')
    fs.writeFileSync(
      fp,
      JSON.stringify({ domain: home, attempts: 1, successes: 1, lastTs: 5, confidence: 0.2065 }) + '\n' +
        JSON.stringify({ domain: 'termpolis', attempts: 4, successes: 3, lastTs: 6, confidence: 0.42 }) + '\n',
    )
    _resetCompetenceForTests()
    initCompetence(dir)
    expect(assessCompetence(home).known).toBe(false)       // the account-name domain is gone
    expect(assessCompetence('termpolis').known).toBe(true)  // real domains survive
    expect(competenceSummary()).not.toMatch(new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

    // Durable: the dead line was rewritten out, so it does not resurrect on the next load.
    _resetCompetenceForTests()
    initCompetence(dir)
    expect(assessCompetence(home).known).toBe(false)
    expect(assessCompetence('termpolis').known).toBe(true)
  })
})
