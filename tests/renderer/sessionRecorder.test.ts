import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createSessionRecorder,
  appendEntry,
  formatRecording,
  generateRecordingFilename,
  type SessionRecording,
} from '../../src/renderer/src/lib/sessionRecorder'

describe('createSessionRecorder', () => {
  it('creates recorder with correct shape', () => {
    const rec = createSessionRecorder('My Terminal', 'bash')
    expect(rec.terminalName).toBe('My Terminal')
    expect(rec.shellLabel).toBe('bash')
    expect(rec.entries).toEqual([])
    expect(typeof rec.startTime).toBe('number')
  })

  it('sets startTime to current time', () => {
    const before = Date.now()
    const rec = createSessionRecorder('T', 'zsh')
    const after = Date.now()
    expect(rec.startTime).toBeGreaterThanOrEqual(before)
    expect(rec.startTime).toBeLessThanOrEqual(after)
  })
})

describe('appendEntry', () => {
  let rec: SessionRecording

  beforeEach(() => {
    rec = createSessionRecorder('T', 'bash')
  })

  it('appends an input entry', () => {
    appendEntry(rec, 'input', 'ls -la')
    expect(rec.entries).toHaveLength(1)
    expect(rec.entries[0].type).toBe('input')
    expect(rec.entries[0].data).toBe('ls -la')
  })

  it('appends an output entry', () => {
    appendEntry(rec, 'output', 'total 0')
    expect(rec.entries[0].type).toBe('output')
  })

  it('records a timestamp for each entry', () => {
    const before = Date.now()
    appendEntry(rec, 'input', 'echo hi')
    expect(rec.entries[0].timestamp).toBeGreaterThanOrEqual(before)
  })

  it('accumulates multiple entries in order', () => {
    appendEntry(rec, 'input', 'l')
    appendEntry(rec, 'input', 's')
    appendEntry(rec, 'output', 'file.txt')
    expect(rec.entries).toHaveLength(3)
    expect(rec.entries.map(e => e.data)).toEqual(['l', 's', 'file.txt'])
  })
})

describe('formatRecording', () => {
  it('includes the header with terminal name, shell, and started date', () => {
    const rec = createSessionRecorder('Main', 'powershell')
    const output = formatRecording(rec)
    expect(output).toContain('Termpolis Session Recording')
    expect(output).toContain('Terminal: Main')
    expect(output).toContain('Shell: powershell')
    expect(output).toContain('Started:')
    expect(output).toContain('Duration:')
  })

  it('formats output entries as timestamped lines', () => {
    const rec = createSessionRecorder('T', 'bash')
    appendEntry(rec, 'output', 'hello world\nsecond line')
    const out = formatRecording(rec)
    expect(out).toContain('hello world')
    expect(out).toContain('second line')
  })

  it('accumulates input chars and flushes on carriage return', () => {
    const rec = createSessionRecorder('T', 'bash')
    appendEntry(rec, 'input', 'g')
    appendEntry(rec, 'input', 'i')
    appendEntry(rec, 'input', 't')
    appendEntry(rec, 'input', '\r')
    const out = formatRecording(rec)
    expect(out).toContain('$ git')
  })

  it('handles backspace in input accumulation', () => {
    const rec = createSessionRecorder('T', 'bash')
    appendEntry(rec, 'input', 'g')
    appendEntry(rec, 'input', 'x')
    appendEntry(rec, 'input', '\u007f') // backspace
    appendEntry(rec, 'input', 'i')
    appendEntry(rec, 'input', 't')
    appendEntry(rec, 'input', '\r')
    const out = formatRecording(rec)
    expect(out).toContain('$ git')
    expect(out).not.toContain('gx')
  })

  it('strips ANSI escape codes from output', () => {
    const rec = createSessionRecorder('T', 'bash')
    appendEntry(rec, 'output', '\x1b[32mgreen text\x1b[0m')
    const out = formatRecording(rec)
    expect(out).toContain('green text')
    expect(out).not.toContain('\x1b[32m')
  })

  it('returns a string even with empty entries', () => {
    const rec = createSessionRecorder('Empty', 'bash')
    const out = formatRecording(rec)
    expect(typeof out).toBe('string')
    expect(out).toContain('Termpolis Session Recording')
  })

  it('shows duration of 0s for empty recording', () => {
    const rec = createSessionRecorder('T', 'bash')
    const out = formatRecording(rec)
    expect(out).toContain('0s')
  })

  it('formats duration in minutes and seconds', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const rec = createSessionRecorder('T', 'bash')
    vi.setSystemTime(new Date('2026-01-01T00:01:30Z'))
    appendEntry(rec, 'output', 'done')
    const out = formatRecording(rec)
    expect(out).toMatch(/1m \d+s/)
    vi.useRealTimers()
  })
})

describe('generateRecordingFilename', () => {
  it('includes the terminal name (sanitized)', () => {
    const name = generateRecordingFilename('My Terminal')
    expect(name).toContain('My_Terminal')
  })

  it('replaces special characters with underscores', () => {
    const name = generateRecordingFilename('node (dev) #1')
    expect(name).toMatch(/^[a-zA-Z0-9_-]+_recording_/)
  })

  it('includes _recording_ in the name', () => {
    expect(generateRecordingFilename('T')).toContain('_recording_')
  })

  it('ends with .txt', () => {
    expect(generateRecordingFilename('T')).toMatch(/\.txt$/)
  })

  it('matches expected filename pattern', () => {
    const name = generateRecordingFilename('X')
    expect(name).toMatch(/X_recording_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.txt/)
  })
})

describe('formatRecording — input edge cases', () => {
  const commandRows = (rec: SessionRecording): string[] =>
    formatRecording(rec).split('\n').filter(l => l.includes('] $ '))

  it('flushes a half-typed command that was never submitted', () => {
    // The user was still typing when the recording stopped: no \r ever arrived,
    // so the only way `npm` reaches the log is the trailing flush at the end.
    const rec = createSessionRecorder('T', 'bash')
    appendEntry(rec, 'input', 'n')
    appendEntry(rec, 'input', 'p')
    appendEntry(rec, 'input', 'm')
    const rows = commandRows(rec)
    expect(rows).toHaveLength(1)
    expect(rows[0].endsWith('$ npm')).toBe(true)
  })

  it('treats a bare newline as a submit, exactly like a carriage return', () => {
    const rec = createSessionRecorder('T', 'bash')
    appendEntry(rec, 'input', 'p')
    appendEntry(rec, 'input', 'w')
    appendEntry(rec, 'input', 'd')
    appendEntry(rec, 'input', '\n')
    const rows = commandRows(rec)
    // Submitted once by the \n — and NOT a second time by the trailing flush.
    expect(rows).toHaveLength(1)
    expect(rows[0].endsWith('$ pwd')).toBe(true)
  })

  it('emits nothing for a carriage return with no accumulated input', () => {
    // Pressing Enter at an empty prompt must not produce a blank "$ " row.
    const rec = createSessionRecorder('T', 'bash')
    appendEntry(rec, 'input', '\r')
    appendEntry(rec, 'input', '\r')
    expect(commandRows(rec)).toHaveLength(0)
    expect(formatRecording(rec)).not.toContain('$ ')
  })

  it('drops raw escape input (the Escape key) instead of typing it into the command', () => {
    // A lone \x1b survives stripAnsi (it is not a complete sequence), so the
    // explicit startsWith('\x1b') guard is the only thing keeping it out.
    const rec = createSessionRecorder('T', 'bash')
    appendEntry(rec, 'input', 'l')
    appendEntry(rec, 'input', '\x1b')
    appendEntry(rec, 'input', 's')
    appendEntry(rec, 'input', '\r')
    const rows = commandRows(rec)
    expect(rows).toHaveLength(1)
    expect(rows[0].endsWith('$ ls')).toBe(true)
    expect(rows[0]).not.toContain('\x1b')
  })

  it('backspace at an empty prompt is a no-op rather than corrupting the line', () => {
    const rec = createSessionRecorder('T', 'bash')
    appendEntry(rec, 'input', '')
    appendEntry(rec, 'input', 'h')
    appendEntry(rec, 'input', 'i')
    appendEntry(rec, 'input', '\r')
    const rows = commandRows(rec)
    expect(rows).toHaveLength(1)
    expect(rows[0].endsWith('$ hi')).toBe(true)
  })
})

describe('formatRecording — output and duration edge cases', () => {
  it('skips blank output lines so the log has no empty timestamped rows', () => {
    const rec = createSessionRecorder('T', 'bash')
    appendEntry(rec, 'output', 'first\n\n   \r\nsecond')
    const rows = formatRecording(rec).split('\n').filter(l => l.startsWith('['))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('first')
    expect(rows[1]).toContain('second')
  })

  it('formats a recording longer than an hour as Xh Ym Zs', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const rec = createSessionRecorder('T', 'bash')
      vi.setSystemTime(new Date('2026-01-01T02:03:04Z'))
      appendEntry(rec, 'output', 'done')
      expect(formatRecording(rec)).toContain('Duration: 2h 3m 4s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('measures duration to the LAST entry, not to now', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const rec = createSessionRecorder('T', 'bash')
      vi.setSystemTime(new Date('2026-01-01T00:00:42Z'))
      appendEntry(rec, 'output', 'last line')
      // Clock keeps running after the recording stopped — duration must not grow.
      vi.setSystemTime(new Date('2026-01-01T09:59:00Z'))
      expect(formatRecording(rec)).toContain('Duration: 42s')
    } finally {
      vi.useRealTimers()
    }
  })
})
