import { describe, it, expect } from 'vitest'
import {
  AGENT_LABEL,
  REASON_HINT,
  describeKillResult,
  formatAge,
  formatBytes,
  formatCpu,
  killResultTone,
  ownerLabel,
  processKey,
  reasonHint,
} from '../../src/renderer/src/lib/processFormat'

describe('processFormat', () => {
  it('keys a process by pid AND start time, since a pid alone can be reused', () => {
    expect(processKey({ pid: 42, created: 1700 })).toBe('42:1700')
    expect(processKey({ pid: 42, created: 1800 })).not.toBe(processKey({ pid: 42, created: 1700 }))
  })

  it('formats an age at the coarsest unit that still reads well', () => {
    expect(formatAge(0)).toBe('—')
    expect(formatAge(-5)).toBe('—')
    expect(formatAge(Number.NaN)).toBe('—')
    expect(formatAge(Number.POSITIVE_INFINITY)).toBe('—')
    expect(formatAge(45_000)).toBe('45s')
    expect(formatAge(12 * 60_000 + 59_000)).toBe('12m')
    expect(formatAge((3 * 60 + 20) * 60_000)).toBe('3h 20m')
    expect(formatAge((2 * 24 + 4) * 3_600_000 + 59 * 60_000)).toBe('2d 4h')
  })

  it('formats bytes with one decimal below 100 and none above', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB')
    expect(formatBytes(2.25 * 1024 ** 3)).toBe('2.3 GB')
    // The largest unit caps the loop instead of running off the table.
    expect(formatBytes(5 * 1024 ** 5)).toBe('5120 TB')
  })

  it('formats CPU time so a hung process reads differently from a runaway one', () => {
    expect(formatCpu(0)).toBe('0s')
    expect(formatCpu(-1)).toBe('0s')
    expect(formatCpu(Number.NaN)).toBe('0s')
    expect(formatCpu(0.02)).toBe('<1s')
    expect(formatCpu(7.9)).toBe('7s')
    expect(formatCpu(3 * 3600 + 5 * 60)).toBe('3h 5m')
  })

  it('describes a kill in one sentence per outcome', () => {
    expect(describeKillResult({ killed: [1], failed: [], skipped: [] })).toBe('Killed 1 process.')
    expect(describeKillResult({ killed: [1, 2, 3], failed: [], skipped: [] })).toBe('Killed 3 processes.')
    expect(describeKillResult({ killed: [], failed: [], skipped: [] })).toBe('Nothing was killed.')
    expect(
      describeKillResult({
        killed: [1],
        failed: [
          { pid: 2, error: 'access denied' },
          { pid: 3, error: 'other' },
        ],
        skipped: [{ pid: 4, reason: 'gone' }],
      }),
    ).toBe('Killed 1 process. 2 could not be killed: access denied; other. 1 was skipped: gone.')
    expect(
      describeKillResult({
        killed: [],
        failed: [],
        skipped: [
          { pid: 4, reason: 'gone' },
          { pid: 5, reason: 'gone' },
        ],
      }),
    ).toBe('Nothing was killed. 2 were skipped: gone.')
    expect(describeKillResult({ killed: [], failed: [{ pid: 2, error: 'access denied' }], skipped: [] })).toBe(
      'Nothing was killed. 1 could not be killed: access denied.',
    )
  })

  it('gives each distinct reason once, in the order first seen, ending the sentence exactly once', () => {
    expect(
      describeKillResult({
        killed: [],
        failed: [
          { pid: 1, error: 'access denied.' },
          { pid: 2, error: 'timed out' },
          // The same reason again, with trailing punctuation and space, is not a new reason.
          { pid: 3, error: 'access denied. ' },
          { pid: 4, error: ' access denied' },
        ],
        skipped: [
          { pid: 5, reason: 'pid reused by a different process' },
          { pid: 6, reason: 'still running but no longer listed' },
          { pid: 7, reason: 'pid reused by a different process...' },
        ],
      }),
    ).toBe(
      'Nothing was killed. 4 could not be killed: access denied; timed out. ' +
        '3 were skipped: pid reused by a different process; still running but no longer listed.',
    )
  })

  it('never leaves an empty reason in the sentence', () => {
    expect(
      describeKillResult({
        killed: [9],
        failed: [
          { pid: 1, error: '' },
          { pid: 2, error: ' . ' },
        ],
        skipped: [{ pid: 3, reason: '' }],
      }),
    ).toBe('Killed 1 process. 2 could not be killed: no reason given. 1 was skipped: no reason given.')
    // Punctuation inside a reason is the reason's own; only the end is trimmed.
    expect(
      describeKillResult({ killed: [], failed: [{ pid: 1, error: 'kill -9 failed. try sudo' }], skipped: [] }),
    ).toBe('Nothing was killed. 1 could not be killed: kill -9 failed. try sudo.')
  })

  it('colours a kill green only when every target was ended', () => {
    const fail = { pid: 2, error: 'access denied' }
    const skip = { pid: 3, reason: 'gone' }
    expect(killResultTone({ killed: [1], failed: [], skipped: [] })).toBe('ok')
    expect(killResultTone({ killed: [1], failed: [fail], skipped: [] })).toBe('warn')
    expect(killResultTone({ killed: [1], failed: [], skipped: [skip] })).toBe('warn')
    expect(killResultTone({ killed: [], failed: [], skipped: [skip] })).toBe('warn')
    // Asked to kill nothing that was left: not a failure, but not a success either.
    expect(killResultTone({ killed: [], failed: [], skipped: [] })).toBe('warn')
    expect(killResultTone({ killed: [], failed: [fail], skipped: [] })).toBe('bad')
    expect(killResultTone({ killed: [], failed: [fail], skipped: [skip] })).toBe('bad')
  })

  it('explains "suspended" as frozen on Windows and as a stopped job elsewhere', () => {
    expect(reasonHint('suspended', 'win32')).toBe(REASON_HINT.suspended)
    for (const platform of ['linux', 'darwin', 'freebsd']) {
      expect(reasonHint('suspended', platform)).toBe(
        'Stopped (e.g. Ctrl+Z): it will not run again until something resumes it.',
      )
    }
    for (const r of ['headless', 'orphaned', 'long-running'] as const) {
      expect(reasonHint(r, 'win32')).toBe(REASON_HINT[r])
      expect(reasonHint(r, 'linux')).toBe(REASON_HINT[r])
    }
  })

  it('names every agent and explains every reason', () => {
    expect(AGENT_LABEL).toEqual({ claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' })
    for (const r of ['headless', 'orphaned', 'suspended', 'long-running'] as const) expect(REASON_HINT[r]).toMatch(/\.$/)
  })

  it('says who owns a process', () => {
    expect(ownerLabel({ owner: 'termpolis' })).toBe('started from Termpolis')
    expect(ownerLabel({ owner: 'orphaned' })).toBe('parent exited')
    expect(ownerLabel({ owner: 'external', parentName: 'code' })).toBe('under code')
    expect(ownerLabel({ owner: 'external' })).toBe('under another program')
  })
})
