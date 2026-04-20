import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  emptyReviewState,
  loadReviewDiff,
  reviewProgress,
  reviewStat,
  runTests,
  detectTestCommand,
  suggestCommitMessage,
} from '../../src/renderer/src/lib/swarmReview'

const SINGLE_FILE_DIFF = `diff --git a/x.ts b/x.ts
index 111..222 100644
--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-old
+new
@@ -5 +5 @@
-drop
+insert
`

const termpolis = {
  gitDiffRange: vi.fn(),
  swarmRunCommand: vi.fn(),
  readConfigFile: vi.fn(),
}

beforeEach(() => {
  termpolis.gitDiffRange.mockReset()
  termpolis.swarmRunCommand.mockReset()
  termpolis.readConfigFile.mockReset()
  ;(globalThis as any).window = { termpolis }
})

describe('emptyReviewState', () => {
  it('returns a blank state seeded with the SHA', () => {
    const s = emptyReviewState('abc123')
    expect(s.preSha).toBe('abc123')
    expect(s.files).toEqual([])
    expect(s.hunkDecisions).toEqual({})
    expect(s.lastTestPassed).toBeNull()
    expect(s.lastTestOutput).toBe('')
  })
})

describe('loadReviewDiff', () => {
  it('fetches + parses the diff range', async () => {
    termpolis.gitDiffRange.mockResolvedValue({ success: true, data: SINGLE_FILE_DIFF })
    const state = await loadReviewDiff('/repo', 'pre123')
    expect(termpolis.gitDiffRange).toHaveBeenCalledWith('/repo', 'pre123')
    expect(state.files).toHaveLength(1)
    expect(state.files[0].hunks).toHaveLength(2)
  })

  it('returns empty files on failed fetch', async () => {
    termpolis.gitDiffRange.mockResolvedValue({ success: false, error: 'bang' })
    const state = await loadReviewDiff('/repo', 'pre123')
    expect(state.files).toEqual([])
  })

  it('handles non-string data gracefully', async () => {
    termpolis.gitDiffRange.mockResolvedValue({ success: true, data: null })
    const state = await loadReviewDiff('/repo', 'pre123')
    expect(state.files).toEqual([])
  })
})

describe('reviewProgress', () => {
  it('counts accepted / rejected / pending hunks', async () => {
    termpolis.gitDiffRange.mockResolvedValue({ success: true, data: SINGLE_FILE_DIFF })
    const state = await loadReviewDiff('/r', 'sha')
    state.hunkDecisions[state.files[0].hunks[0].id] = 'accept'
    const prog = reviewProgress(state)
    expect(prog.total).toBe(2)
    expect(prog.accepted).toBe(1)
    expect(prog.rejected).toBe(0)
    expect(prog.pending).toBe(1)
  })

  it('returns zeros for empty state', () => {
    expect(reviewProgress(emptyReviewState('x'))).toEqual({ total: 0, accepted: 0, rejected: 0, pending: 0 })
  })

  it('counts rejects', async () => {
    termpolis.gitDiffRange.mockResolvedValue({ success: true, data: SINGLE_FILE_DIFF })
    const state = await loadReviewDiff('/r', 'sha')
    for (const h of state.files[0].hunks) state.hunkDecisions[h.id] = 'reject'
    expect(reviewProgress(state).rejected).toBe(2)
  })
})

describe('reviewStat', () => {
  it('mirrors diffStat', async () => {
    termpolis.gitDiffRange.mockResolvedValue({ success: true, data: SINGLE_FILE_DIFF })
    const state = await loadReviewDiff('/r', 'sha')
    const stat = reviewStat(state)
    expect(stat.added).toBe(2)
    expect(stat.removed).toBe(2)
    expect(stat.files).toBe(1)
  })
})

describe('runTests', () => {
  it('maps exitCode 0 to passed=true', async () => {
    termpolis.swarmRunCommand.mockResolvedValue({ success: true, data: { output: 'ok', exitCode: 0 } })
    const r = await runTests('/r', 'npm test')
    expect(r.passed).toBe(true)
    expect(r.exitCode).toBe(0)
  })

  it('maps non-zero exit to failed', async () => {
    termpolis.swarmRunCommand.mockResolvedValue({ success: true, data: { output: 'fail', exitCode: 1 } })
    const r = await runTests('/r', 'npm test')
    expect(r.passed).toBe(false)
  })

  it('returns failure on IPC error', async () => {
    termpolis.swarmRunCommand.mockResolvedValue({ success: false, error: 'spawn EACCES' })
    const r = await runTests('/r', 'npm test')
    expect(r.passed).toBe(false)
    expect(r.exitCode).toBe(-1)
    expect(r.output).toContain('spawn EACCES')
  })
})

describe('detectTestCommand', () => {
  it('returns npm test when package.json has a test script', async () => {
    termpolis.readConfigFile.mockResolvedValue({ success: true, data: JSON.stringify({ scripts: { test: 'vitest' } }) })
    expect(await detectTestCommand('/repo')).toBe('npm test')
  })

  it('still returns npm test when script is missing (safe default)', async () => {
    termpolis.readConfigFile.mockResolvedValue({ success: true, data: JSON.stringify({}) })
    expect(await detectTestCommand('/repo')).toBe('npm test')
  })

  it('returns default when no package.json', async () => {
    termpolis.readConfigFile.mockResolvedValue({ success: false, error: 'ENOENT' })
    expect(await detectTestCommand('/repo')).toBe('npm test')
  })

  it('tolerates malformed JSON', async () => {
    termpolis.readConfigFile.mockResolvedValue({ success: true, data: 'not json' })
    expect(await detectTestCommand('/repo')).toBe('npm test')
  })
})

describe('suggestCommitMessage', () => {
  it('prepends the task description when provided', async () => {
    termpolis.gitDiffRange.mockResolvedValue({ success: true, data: SINGLE_FILE_DIFF })
    const state = await loadReviewDiff('/r', 'sha')
    const msg = suggestCommitMessage(state, 'Implement feature X')
    expect(msg.startsWith('Implement feature X')).toBe(true)
    expect(msg).toContain('1 file')
  })

  it('truncates long task descriptions', async () => {
    termpolis.gitDiffRange.mockResolvedValue({ success: true, data: SINGLE_FILE_DIFF })
    const state = await loadReviewDiff('/r', 'sha')
    const long = 'x'.repeat(200)
    const msg = suggestCommitMessage(state, long)
    expect(msg.split('\n')[0].length).toBeLessThanOrEqual(72)
  })

  it('works without a task description', async () => {
    termpolis.gitDiffRange.mockResolvedValue({ success: true, data: SINGLE_FILE_DIFF })
    const state = await loadReviewDiff('/r', 'sha')
    const msg = suggestCommitMessage(state)
    expect(msg).toContain('Swarm changes:')
  })
})
