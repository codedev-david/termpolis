// The job history file on the computer doing the work. Real files in a temp dir for everything a
// disk does; a stand-in fs only for the failures a real disk won't produce on cue.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  LINKED_JOB_LOG_FILE,
  LINKED_JOB_LOG_PREV,
  MAX_JOB_LOG_BYTES,
  MAX_JOB_LOG_READ,
  createLinkedJobLog,
  recordFrom,
  type JobLogFs,
  type LinkedJobRecord,
} from '../../src/main/linkedJobLog'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-job-log-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const file = (): string => path.join(dir, LINKED_JOB_LOG_FILE)
const prev = (): string => path.join(dir, LINKED_JOB_LOG_PREV)

/** A started line for job `n`: twelve hex digits, as the executor mints them. */
function started(n: number, over: Partial<LinkedJobRecord> = {}): LinkedJobRecord {
  return {
    ts: 1_700_000_000_000 + n,
    event: 'started',
    jobId: n.toString(16).padStart(12, '0'),
    ref: 'device:a1b2c3d4e5f60718',
    machine: 'laptop',
    agent: 'codex',
    write: false,
    cwd: '/home/me/repos/app',
    summary: `job ${n}`,
    ...over,
  }
}

const lines = (p: string): string[] => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)

describe('appending', () => {
  it('writes one JSON line per record, in the order they were queued, however many at once', async () => {
    const log = createLinkedJobLog(dir)
    for (let i = 0; i < 50; i++) log.append(started(i))
    // Newest first, once every queued line has landed.
    const read = await log.recent()
    expect(read.map((r) => r.summary)).toEqual(Array.from({ length: 50 }, (_, i) => `job ${49 - i}`))
    expect(lines(file()).map((l) => JSON.parse(l).summary)).toEqual(Array.from({ length: 50 }, (_, i) => `job ${i}`))
  })

  it('returns at once and never throws, even for a record that cannot be written as JSON', async () => {
    const log = createLinkedJobLog(dir)
    const circular = started(1) as LinkedJobRecord & { self?: unknown }
    circular.self = circular
    expect(() => log.append(circular)).not.toThrow()
    log.append(started(2))
    expect((await log.recent()).map((r) => r.summary)).toEqual(['job 2'])
  })

  it('creates the file readable by this user only', async () => {
    const log = createLinkedJobLog(dir)
    log.append(started(1))
    await log.recent()
    // Windows has no POSIX modes; its ACLs come from the user's profile folder.
    if (process.platform !== 'win32') expect(fs.statSync(file()).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(file())).toBe(true)
  })

  it('swallows every failure: a line that cannot be written is lost, never thrown', async () => {
    const broken: JobLogFs = {
      appendFile: async () => {
        throw new Error('EACCES')
      },
      stat: async () => {
        throw new Error('EACCES')
      },
      rename: async () => {
        throw new Error('EACCES')
      },
      open: async () => {
        throw new Error('EACCES')
      },
    }
    const log = createLinkedJobLog(dir, { fs: broken })
    log.append(started(1))
    log.append(started(2))
    expect(await log.recent()).toEqual([])
  })

  it('keeps writing after one line failed', async () => {
    let fail = true
    const real = fs.promises as unknown as JobLogFs
    const flaky: JobLogFs = {
      ...real,
      stat: (f) => real.stat(f),
      rename: (a, b) => real.rename(a, b),
      open: (f, flags) => real.open(f, flags),
      appendFile: async (f, data, options) => {
        if (fail) {
          fail = false
          throw new Error('ENOSPC')
        }
        return real.appendFile(f, data, options)
      },
    }
    const log = createLinkedJobLog(dir, { fs: flaky })
    log.append(started(1))
    log.append(started(2))
    expect((await log.recent()).map((r) => r.summary)).toEqual(['job 2'])
  })
})

describe('rotation', () => {
  it('moves the file aside past the threshold, keeping only one older file', async () => {
    const log = createLinkedJobLog(dir, { maxBytes: 600 })
    for (let i = 0; i < 6; i++) log.append(started(i))
    await log.recent()
    expect(fs.existsSync(prev())).toBe(true)
    expect(fs.statSync(file()).size).toBeLessThan(600 + 300)
    const before = lines(prev())
    for (let i = 6; i < 20; i++) log.append(started(i))
    await log.recent()
    // Replaced, not chained: two files at most.
    expect(lines(prev())).not.toEqual(before)
    expect(fs.readdirSync(dir).sort()).toEqual([LINKED_JOB_LOG_FILE, LINKED_JOB_LOG_PREV])
  })

  it('reads across the pair: the older file fills in what the current one lacks, newest first', async () => {
    const log = createLinkedJobLog(dir, { maxBytes: 600 })
    for (let i = 0; i < 6; i++) log.append(started(i))
    const all = await log.recent()
    const onDisk = [...lines(prev()), ...lines(file())].map((l) => JSON.parse(l).summary)
    expect(all.map((r) => r.summary)).toEqual([...onDisk].reverse())
    expect(all[0].summary).toBe('job 5')
    // A limit the current file meets alone reads nothing older.
    expect((await log.recent(1)).map((r) => r.summary)).toEqual(['job 5'])
  })

  it('rotates at 2 MiB by default', () => {
    expect(MAX_JOB_LOG_BYTES).toBe(2 * 1024 * 1024)
  })
})

describe('reading', () => {
  it('reads nothing when there is no history yet', async () => {
    expect(await createLinkedJobLog(dir).recent()).toEqual([])
  })

  it('skips a torn, corrupt or foreign line and reads the rest', async () => {
    fs.writeFileSync(
      file(),
      [
        JSON.stringify(started(1)),
        '{"ts": 5, "event": "started", "ref": "x", "machine": "torn',
        'not json at all',
        JSON.stringify({ ts: 'yesterday', event: 'started', ref: '', machine: 'm' }),
        JSON.stringify({ ts: 1, event: 'deleted', ref: '', machine: 'm' }),
        JSON.stringify({ ts: 1, event: 'refused', ref: 7, machine: 'm' }),
        JSON.stringify({ ts: 1, event: 'refused', ref: '', machine: 'm'.repeat(65) }),
        '[]',
        JSON.stringify(started(2)),
        '',
      ].join('\n'),
    )
    expect((await createLinkedJobLog(dir).recent()).map((r) => r.summary)).toEqual(['job 2', 'job 1'])
  })

  it('reads only the tail of a file something else made huge, dropping the line it starts in', async () => {
    // An edit job runs as the user and could write anything here; the app must not load it whole.
    const filler = `${JSON.stringify(started(0, { summary: 'filler' }))}\n`
    fs.writeFileSync(file(), filler.repeat(Math.ceil((MAX_JOB_LOG_BYTES * 1.5) / filler.length)))
    fs.appendFileSync(file(), `${JSON.stringify(started(9))}\n`)
    const read = await createLinkedJobLog(dir).recent()
    expect(read).toHaveLength(MAX_JOB_LOG_READ)
    expect(read[0].summary).toBe('job 9')
  })

  it(`returns at most ${MAX_JOB_LOG_READ} lines, at least one, and the most for a limit that is not a number`, async () => {
    const log = createLinkedJobLog(dir)
    for (let i = 0; i < 3; i++) log.append(started(i))
    expect(await log.recent(0)).toHaveLength(1)
    expect(await log.recent(2.7)).toHaveLength(2)
    expect(await log.recent(Number.NaN)).toHaveLength(3)
    expect(await log.recent(10_000)).toHaveLength(3)
  })

  it('reads nothing from a file it opened but could not read', async () => {
    const real = fs.promises as unknown as JobLogFs
    fs.writeFileSync(file(), `${JSON.stringify(started(1))}\n`)
    let closed = 0
    const unreadable: JobLogFs = {
      ...real,
      stat: (f) => real.stat(f),
      rename: (a, b) => real.rename(a, b),
      appendFile: (f, d, o) => real.appendFile(f, d, o),
      open: async () => ({
        stat: async () => {
          throw new Error('EIO')
        },
        read: async () => ({ bytesRead: 0 }),
        close: async () => {
          closed++
          throw new Error('already closed')
        },
      }),
    }
    expect(await createLinkedJobLog(dir, { fs: unreadable }).recent()).toEqual([])
    // Closed either way, and a close that fails is not the reader's problem.
    expect(closed).toBe(2)
  })
})

describe('recordFrom', () => {
  it('keeps every field a writer writes, in its shape', () => {
    const full: LinkedJobRecord = {
      ts: 1,
      event: 'finished',
      jobId: '0123456789ab',
      ref: 'link:0011223344556677',
      machine: 'linux',
      agent: 'gemini',
      write: true,
      cwd: '/srv/app',
      summary: 'x',
      status: 'cancelled',
      durationMs: 0,
      reason: 'busy',
      count: 3,
      secretRules: ['gh_pat', 'password_literal'],
    }
    expect(recordFrom(full)).toEqual(full)
  })

  it('drops fields that are not the shape written, and keeps the line', () => {
    expect(
      recordFrom({
        ts: 1,
        event: 'refused',
        ref: '',
        machine: 'm',
        jobId: 'not-an-id',
        agent: 'bash',
        write: 'yes',
        cwd: 'c'.repeat(4097),
        summary: 's'.repeat(81),
        status: 'running',
        durationMs: -1,
        reason: 'r'.repeat(201),
        count: 0,
        secretRules: ['ok_rule', 'not a rule', 7, 'x'.repeat(65)],
        extra: 'dropped',
      }),
    ).toEqual({ ts: 1, event: 'refused', ref: '', machine: 'm', secretRules: ['ok_rule'] })
    expect(recordFrom({ ts: 1, event: 'started', ref: '', machine: 'm', count: 1.5, secretRules: 'gh_pat', durationMs: Infinity })).toEqual({
      ts: 1,
      event: 'started',
      ref: '',
      machine: 'm',
    })
  })

  it('refuses a line without what every line has', () => {
    for (const v of [null, 'line', 5, { event: 'started', ref: '', machine: 'm' }, { ts: Infinity, event: 'started', ref: '', machine: 'm' }]) {
      expect(recordFrom(v)).toBeNull()
    }
    expect(recordFrom({ ts: 1, event: 'started', ref: 'r'.repeat(65), machine: 'm' })).toBeNull()
  })

  it('keeps at most 32 rule names', () => {
    const many = Array.from({ length: 40 }, (_, i) => `rule_${i}`)
    expect(recordFrom({ ts: 1, event: 'started', ref: '', machine: 'm', secretRules: many })?.secretRules).toHaveLength(32)
  })
})
