import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  emptyOverlay,
  applyCorrection,
  revokeCorrection,
  correctionFor,
  overlayFromLog,
  applyOverlayToRecall,
  explainRecall,
  correctionStats,
  DEMOTE_FACTOR,
  type Correction,
} from '../../src/main/memoryCorrection'
import {
  initMemoryCorrections,
  correctMemory,
  revokeMemoryCorrection,
  applyCorrections,
  correctionForMemory,
  memoryCorrectionStats,
  resetMemoryCorrections,
} from '../../src/main/memoryCorrectionStore'

const cand = (id: string, score: number, content = `content ${id}`) => ({ id, content, score })

describe('memoryCorrection/applyCorrection', () => {
  it('records a retraction with defaults filled in', () => {
    const o = emptyOverlay()
    const r = applyCorrection(o, { id: 'm1', kind: 'retract', ts: 5 })
    expect(r.ok).toBe(true)
    expect(r.correction).toMatchObject({ id: 'm1', kind: 'retract', by: 'user', ts: 5, reason: '(no reason given)' })
    expect(o.byId.get('m1')).toBe(r.correction)
    expect(o.log).toHaveLength(1)
  })

  it('requires a memory id', () => {
    expect(applyCorrection(emptyOverlay(), { id: '  ', kind: 'retract' }).error).toBe('a memory id is required')
    expect(applyCorrection(emptyOverlay(), { id: undefined as unknown as string, kind: 'retract' }).error)
      .toBe('a memory id is required')
  })

  it('rejects an unknown kind rather than storing an unenforceable correction', () => {
    expect(applyCorrection(emptyOverlay(), { id: 'm1', kind: 'delete' as never }).error)
      .toBe('unknown correction kind "delete"')
  })

  it('rejects an amend with no replacement — the silent-no-op mistake', () => {
    expect(applyCorrection(emptyOverlay(), { id: 'm1', kind: 'amend' }).error)
      .toBe("an 'amend' correction needs a replacement")
    expect(applyCorrection(emptyOverlay(), { id: 'm1', kind: 'amend', replacement: '   ' }).error)
      .toBe("an 'amend' correction needs a replacement")
  })

  it('trims the reason and attributes the corrector', () => {
    const r = applyCorrection(emptyOverlay(), { id: 'm1', kind: 'demote', reason: '  flaky  ', by: 'agent-7' })
    expect(r.correction).toMatchObject({ reason: 'flaky', by: 'agent-7' })
  })

  it('lets a later correction supersede an earlier one instead of merging them', () => {
    const o = emptyOverlay()
    applyCorrection(o, { id: 'm1', kind: 'demote', ts: 1 })
    applyCorrection(o, { id: 'm1', kind: 'retract', ts: 2 })
    expect(correctionFor(o, 'm1')?.kind).toBe('retract')
    // The superseded entry stays in the log: "why did the agent believe X?" needs it.
    expect(o.log).toHaveLength(2)
  })

  it('defaults ts to now when no clock is supplied', () => {
    const before = Date.now()
    expect(applyCorrection(emptyOverlay(), { id: 'm1', kind: 'retract' }).correction!.ts).toBeGreaterThanOrEqual(before)
  })
})

describe('memoryCorrection/revokeCorrection', () => {
  it('undoes the live correction but leaves it in the log, marked', () => {
    const o = emptyOverlay()
    applyCorrection(o, { id: 'm1', kind: 'retract', ts: 1 })
    expect(revokeCorrection(o, 'm1', 9).ok).toBe(true)
    expect(correctionFor(o, 'm1')).toBeNull()
    expect(o.log[0].revokedAt).toBe(9)
  })

  it('refuses to revoke what was never corrected', () => {
    expect(revokeCorrection(emptyOverlay(), 'ghost').error).toBe('no live correction for ghost')
  })

  it('restores a retracted memory to recall — corrections are themselves fallible', () => {
    const o = emptyOverlay()
    applyCorrection(o, { id: 'm1', kind: 'retract', ts: 1 })
    expect(applyOverlayToRecall(o, [cand('m1', 1)])).toHaveLength(0)
    revokeCorrection(o, 'm1', 2)
    expect(applyOverlayToRecall(o, [cand('m1', 1)])).toHaveLength(1)
  })

  it('defaults the revoke timestamp to now', () => {
    const o = emptyOverlay()
    applyCorrection(o, { id: 'm1', kind: 'retract', ts: 1 })
    const before = Date.now()
    revokeCorrection(o, 'm1')
    expect(o.log[0].revokedAt!).toBeGreaterThanOrEqual(before)
  })
})

describe('memoryCorrection/overlayFromLog', () => {
  it('replays supersession and revocation from the persisted order alone', () => {
    const log: Correction[] = [
      { id: 'a', kind: 'demote', reason: 'r', by: 'user', ts: 1 },
      { id: 'a', kind: 'retract', reason: 'r', by: 'user', ts: 2 },
      { id: 'b', kind: 'retract', reason: 'r', by: 'user', ts: 3, revokedAt: 4 },
    ]
    const o = overlayFromLog(log)
    expect(o.byId.get('a')!.kind).toBe('retract')
    expect(o.byId.has('b')).toBe(false)
    expect(o.log).toHaveLength(3)
  })

  it('lets a correction that arrives after a revocation take effect again', () => {
    const o = overlayFromLog([
      { id: 'a', kind: 'retract', reason: 'r', by: 'user', ts: 1, revokedAt: 2 },
      { id: 'a', kind: 'demote', reason: 'r2', by: 'user', ts: 3 },
    ])
    expect(o.byId.get('a')!.kind).toBe('demote')
  })
})

describe('memoryCorrection/applyOverlayToRecall', () => {
  it('passes an uncorrected list through unchanged, sorted by score', () => {
    const out = applyOverlayToRecall(emptyOverlay(), [cand('a', 1), cand('b', 3)])
    expect(out.map(c => c.id)).toEqual(['b', 'a'])
    expect(out[0].correction).toBeUndefined()
  })

  it('drops a retracted memory rather than labelling it — a labelled wrong fact still costs context', () => {
    const o = emptyOverlay()
    applyCorrection(o, { id: 'bad', kind: 'retract', reason: 'we moved off Postgres' })
    expect(applyOverlayToRecall(o, [cand('bad', 9), cand('ok', 1)]).map(c => c.id)).toEqual(['ok'])
  })

  it('substitutes amended content and carries the reason forward', () => {
    const o = emptyOverlay()
    applyCorrection(o, { id: 'a', kind: 'amend', replacement: 'the port is 8080', reason: 'was 3000', by: 'user' })
    const [hit] = applyOverlayToRecall(o, [cand('a', 1, 'the port is 3000')])
    expect(hit.content).toBe('the port is 8080')
    expect(hit.correction).toEqual({ kind: 'amend', reason: 'was 3000', by: 'user' })
    expect(hit.score).toBe(1)
  })

  it('demotes multiplicatively and re-sorts so the order actually changes', () => {
    const o = emptyOverlay()
    applyCorrection(o, { id: 'a', kind: 'demote', reason: 'flaky' })
    const out = applyOverlayToRecall(o, [cand('a', 1), cand('b', 0.5)])
    expect(out.map(c => c.id)).toEqual(['b', 'a'])
    expect(out[1].score).toBeCloseTo(DEMOTE_FACTOR)
  })

  it('still surfaces a demoted memory when nothing else is relevant', () => {
    const o = emptyOverlay()
    applyCorrection(o, { id: 'a', kind: 'demote', reason: 'flaky' })
    expect(applyOverlayToRecall(o, [cand('a', 1)]).map(c => c.id)).toEqual(['a'])
  })

  it('preserves extra fields on richer candidate shapes', () => {
    const o = emptyOverlay()
    applyCorrection(o, { id: 'a', kind: 'demote', reason: 'r' })
    const [hit] = applyOverlayToRecall(o, [{ ...cand('a', 1), project: 'termpolis', kind: 'decision' }])
    expect(hit.project).toBe('termpolis')
    expect(hit.kind).toBe('decision')
  })

  it('does not mutate the input list', () => {
    const o = emptyOverlay()
    applyCorrection(o, { id: 'a', kind: 'demote', reason: 'r' })
    const input = [cand('a', 1)]
    applyOverlayToRecall(o, input)
    expect(input[0].score).toBe(1)
  })
})

describe('memoryCorrection/explainRecall', () => {
  it('leads with rank, score and age', () => {
    expect(explainRecall({ rank: 1, score: 0.8123, ageMs: 0 })).toBe('#1 · score 0.81 · today')
    expect(explainRecall({ rank: 2, score: 0.5, ageMs: 3 * 86_400_000 })).toBe('#2 · score 0.50 · 3d old')
  })

  it('prefers an explicit source over the agent id', () => {
    expect(explainRecall({ rank: 1, score: 1, ageMs: 0, source: 'transcript', agentId: 'a7' })).toContain('via transcript')
    expect(explainRecall({ rank: 1, score: 1, ageMs: 0, agentId: 'a7' })).toContain('by a7')
  })

  it('appends the correction so the reader sees why it was struck', () => {
    const c: Correction = { id: 'a', kind: 'demote', reason: 'flaky', by: 'user', ts: 1 }
    expect(explainRecall({ rank: 1, score: 1, ageMs: 0 }, c)).toContain('demote: flaky')
    expect(explainRecall({ rank: 1, score: 1, ageMs: 0 }, null)).not.toContain('demote')
  })
})

describe('memoryCorrection/correctionStats', () => {
  it('counts live corrections by kind and revocations from the log', () => {
    const o = emptyOverlay()
    applyCorrection(o, { id: 'a', kind: 'retract' })
    applyCorrection(o, { id: 'b', kind: 'amend', replacement: 'x' })
    applyCorrection(o, { id: 'c', kind: 'demote' })
    applyCorrection(o, { id: 'd', kind: 'retract' })
    revokeCorrection(o, 'd', 9)
    expect(correctionStats(o)).toEqual({ live: 3, retracted: 1, amended: 1, demoted: 1, revoked: 1 })
  })

  it('reports zeroes for an untouched brain', () => {
    expect(correctionStats(emptyOverlay())).toEqual({ live: 0, retracted: 0, amended: 0, demoted: 0, revoked: 0 })
  })
})

describe('memoryCorrectionStore', () => {
  let tmp: string
  const logFile = () => path.join(tmp, 'memory-corrections.jsonl')

  beforeEach(() => {
    resetMemoryCorrections()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-corr-'))
    initMemoryCorrections(tmp)
  })

  afterEach(() => {
    resetMemoryCorrections()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* windows lock */ }
  })

  it('rejects an empty userData path', () => {
    expect(() => initMemoryCorrections('')).toThrow('userDataPath required')
  })

  it('appends one JSONL line per correction', () => {
    correctMemory({ id: 'a', kind: 'retract', reason: 'wrong', ts: 1 })
    correctMemory({ id: 'b', kind: 'demote', reason: 'flaky', ts: 2 })
    const lines = fs.readFileSync(logFile(), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toMatchObject({ id: 'a', kind: 'retract', reason: 'wrong' })
  })

  it('does not write a rejected correction', () => {
    expect(correctMemory({ id: 'a', kind: 'amend' }).ok).toBe(false)
    expect(fs.existsSync(logFile())).toBe(false)
  })

  it('survives a restart with the correction still in force', () => {
    correctMemory({ id: 'a', kind: 'retract', reason: 'wrong', ts: 1 })
    resetMemoryCorrections()
    initMemoryCorrections(tmp)
    expect(applyCorrections([cand('a', 1), cand('b', 1)]).map(c => c.id)).toEqual(['b'])
  })

  it('takes effect on the very next recall, with no re-index', () => {
    expect(applyCorrections([cand('a', 1)])).toHaveLength(1)
    correctMemory({ id: 'a', kind: 'retract', reason: 'wrong' })
    expect(applyCorrections([cand('a', 1)])).toHaveLength(0)
  })

  it('persists a revocation as its own line and replays it on restart', () => {
    correctMemory({ id: 'a', kind: 'retract', reason: 'wrong', ts: 1 })
    expect(revokeMemoryCorrection('a').ok).toBe(true)
    resetMemoryCorrections()
    initMemoryCorrections(tmp)
    expect(applyCorrections([cand('a', 1)])).toHaveLength(1)
    expect(memoryCorrectionStats()).toMatchObject({ live: 0, revoked: 1 })
  })

  it('reports a failed revocation without writing anything', () => {
    const before = fs.existsSync(logFile()) ? fs.readFileSync(logFile(), 'utf8') : ''
    expect(revokeMemoryCorrection('ghost')).toEqual({ ok: false, error: 'no live correction for ghost' })
    expect(fs.existsSync(logFile()) ? fs.readFileSync(logFile(), 'utf8') : '').toBe(before)
  })

  it('loses exactly one entry to a truncated final write, not the whole file', () => {
    correctMemory({ id: 'a', kind: 'retract', reason: 'r', ts: 1 })
    correctMemory({ id: 'b', kind: 'demote', reason: 'r', ts: 2 })
    fs.appendFileSync(logFile(), '{"id":"c","kind":"retr')
    resetMemoryCorrections()
    initMemoryCorrections(tmp)
    expect(memoryCorrectionStats().live).toBe(2)
  })

  it('ignores blank lines from a sync merge', () => {
    correctMemory({ id: 'a', kind: 'retract', reason: 'r', ts: 1 })
    fs.appendFileSync(logFile(), '\n\n  \n')
    resetMemoryCorrections()
    initMemoryCorrections(tmp)
    expect(memoryCorrectionStats().live).toBe(1)
  })

  it('starts clean when no log exists yet', () => {
    expect(memoryCorrectionStats().live).toBe(0)
    expect(correctionForMemory('anything')).toBeNull()
  })

  it('exposes the live correction for a memory', () => {
    correctMemory({ id: 'a', kind: 'demote', reason: 'flaky', ts: 1 })
    expect(correctionForMemory('a')).toMatchObject({ kind: 'demote', reason: 'flaky' })
  })

  it('still applies corrections in memory when the log cannot be written', () => {
    resetMemoryCorrections()
    // A path whose parent is a FILE: mkdirSync and appendFileSync both fail.
    const blocked = path.join(tmp, 'blocker', 'sub')
    fs.writeFileSync(path.join(tmp, 'blocker'), 'x', 'utf8')
    expect(() => initMemoryCorrections(blocked)).not.toThrow()
    expect(correctMemory({ id: 'a', kind: 'retract', reason: 'r' }).ok).toBe(true)
    expect(applyCorrections([cand('a', 1)])).toHaveLength(0)
  })
})
