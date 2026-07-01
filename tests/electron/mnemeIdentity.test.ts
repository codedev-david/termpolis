import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  initIdentity,
  setGoal,
  recordMilestone,
  identitySummary,
  _resetIdentityForTests,
} from '../../src/main/mnemeIdentity'

describe('mnemeIdentity — persistent continuous-identity store', () => {
  let dir: string
  const sidecar = () => path.join(dir, 'mneme-identity.jsonl')

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-id-'))
    _resetIdentityForTests()
    initIdentity(dir)
  })
  afterEach(() => {
    _resetIdentityForTests()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  describe('setGoal / recordMilestone → identitySummary', () => {
    it('returns "" when there is neither goal nor milestone', () => {
      expect(identitySummary()).toBe('')
    })

    it('summarizes an active goal', () => {
      setGoal('ship the learning system', 1000)
      const s = identitySummary()
      expect(s).toContain('Active goals: ship the learning system')
      expect(s).not.toContain('Recent milestones')
    })

    it('summarizes a recorded milestone', () => {
      recordMilestone('P1 shipped in v1.17.0', 1000)
      const s = identitySummary()
      expect(s).toContain('Recent milestones: P1 shipped in v1.17.0')
      expect(s).not.toContain('Active goals')
    })

    it('summarizes goals and milestones together, newest first', () => {
      setGoal('goal one', 1)
      setGoal('goal two', 2)
      recordMilestone('did A', 3)
      recordMilestone('did B', 4)
      const s = identitySummary()
      expect(s).toBe('Active goals: goal two; goal one\nRecent milestones: did B; did A')
    })

    it('caps each section at the limit, most recent first', () => {
      for (let i = 1; i <= 5; i++) setGoal(`g${i}`, i)
      for (let i = 1; i <= 5; i++) recordMilestone(`m${i}`, 10 + i)
      const s = identitySummary(2)
      expect(s).toBe('Active goals: g5; g4\nRecent milestones: m5; m4')
    })

    it('a non-positive limit yields an empty summary', () => {
      setGoal('g', 1)
      recordMilestone('m', 2)
      expect(identitySummary(0)).toBe('')
      expect(identitySummary(-1)).toBe('')
    })
  })

  describe('persistence (append-and-replay across a reload)', () => {
    it('replays goals and milestones from the sidecar', () => {
      setGoal('north star', 1)
      recordMilestone('milestone one', 2)
      _resetIdentityForTests()
      initIdentity(dir)
      const s = identitySummary()
      expect(s).toContain('Active goals: north star')
      expect(s).toContain('Recent milestones: milestone one')
    })

    it('appends one JSONL line per write', () => {
      setGoal('g1', 1)
      recordMilestone('m1', 2)
      const lines = fs.readFileSync(sidecar(), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0])).toMatchObject({ type: 'goal', text: 'g1', ts: 1 })
      expect(JSON.parse(lines[1])).toMatchObject({ type: 'milestone', text: 'm1', ts: 2 })
    })

    it('keeps only the latest 10 goals across a reload (older ones drop out)', () => {
      for (let i = 1; i <= 13; i++) setGoal(`goal-${i}`, i)
      _resetIdentityForTests()
      initIdentity(dir)
      // all 13 lines are on disk (append-only) but only the latest 10 replay
      expect(fs.readFileSync(sidecar(), 'utf8').trim().split('\n')).toHaveLength(13)
      const s = identitySummary(20)
      expect(s).toContain('goal-13')
      expect(s).toContain('goal-4') // 13 - 10 + 1 = 4 is the oldest retained
      expect(s).not.toContain('goal-3') // dropped by the cap
    })

    it('starts empty when the sidecar is missing', () => {
      const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-id-empty-'))
      try {
        _resetIdentityForTests()
        initIdentity(fresh)
        expect(identitySummary()).toBe('')
      } finally {
        fs.rmSync(fresh, { recursive: true, force: true })
      }
    })

    it('tolerates corrupt / blank / malformed lines on load', () => {
      fs.writeFileSync(
        sidecar(),
        [
          'not json at all',
          '',
          JSON.stringify({ type: 'goal', text: 'valid goal', ts: 5 }),
          JSON.stringify({ type: 'goal', ts: 6 }), // no text → skipped
          JSON.stringify({ type: 'unknown', text: 'ignored', ts: 7 }), // unknown type → skipped
          JSON.stringify({ type: 'milestone', text: 'valid milestone', ts: 8 }),
        ].join('\n') + '\n',
      )
      _resetIdentityForTests()
      initIdentity(dir)
      const s = identitySummary()
      expect(s).toContain('Active goals: valid goal')
      expect(s).toContain('Recent milestones: valid milestone')
    })

    it('is idempotent — re-initing the same dir does not double-count', () => {
      setGoal('only goal', 1)
      initIdentity(dir) // reload without reset
      const s = identitySummary()
      expect(s).toBe('Active goals: only goal')
    })
  })

  describe('in-memory operation without initialization', () => {
    it('updates state but writes nothing when uninitialized', () => {
      _resetIdentityForTests() // filePath = null
      setGoal('ephemeral', 1)
      recordMilestone('ephemeral ms', 2)
      const s = identitySummary()
      expect(s).toContain('Active goals: ephemeral')
      expect(s).toContain('Recent milestones: ephemeral ms')
      // nothing persisted to the previous dir
      expect(fs.existsSync(sidecar())).toBe(false)
    })
  })
})
