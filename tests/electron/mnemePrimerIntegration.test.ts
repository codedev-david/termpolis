import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  initCompetence,
  recordOutcome,
  competenceSummary,
  competenceRecords,
  _resetCompetenceForTests,
} from '../../src/main/mnemeCompetence'
import { initIdentity, setGoal, identitySummary, _resetIdentityForTests } from '../../src/main/mnemeIdentity'
import { findGaps, curiosityPrompts } from '../../src/main/mnemeCuriosity'
import { augmentPrimer } from '../../src/main/mnemePrimerAugment'

// Proves the exact composition the memoryPrimer MCP handler runs — self-competence
// + curiosity gaps + identity digest folded into the launch primer — using REAL
// accrued state (not just the augmentPrimer unit).
describe('Mneme primer integration — real accrued state', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-primer-'))
    _resetCompetenceForTests()
    _resetIdentityForTests()
    initCompetence(tmp)
    initIdentity(tmp)
  })
  afterEach(() => {
    _resetCompetenceForTests()
    _resetIdentityForTests()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('surfaces a genuinely weak domain + an open question + a goal in the primer', () => {
    // A domain the fleet keeps failing at.
    for (let i = 0; i < 4; i++) recordOutcome('flaky-deploy', false, 1000 + i)
    recordOutcome('flaky-deploy', true, 2000)
    setGoal('ship the learning brain', 3000)

    const out = augmentPrimer('BASE PRIMER TEXT', {
      competence: competenceSummary(3),
      curiosity: curiosityPrompts(findGaps(competenceRecords()), 2),
      identity: identitySummary(3),
    })

    expect(out).toContain('BASE PRIMER TEXT')
    expect(out).toContain('Self-competence')
    expect(out).toContain('flaky-deploy')
    expect(out).toContain('Open questions')
    expect(out).toContain('ship the learning brain')
  })

  it('is a clean no-op on a fresh brain (nothing accrued yet)', () => {
    const out = augmentPrimer('BASE', {
      competence: competenceSummary(3),
      curiosity: curiosityPrompts(findGaps(competenceRecords()), 2),
      identity: identitySummary(3),
    })
    expect(out).toBe('BASE')
  })
})
