// The job history on the computer doing the work: a line when another computer starts a job here,
// a line when it ends, and a line when one is refused. Kept across restarts, unlike the activity
// view, so what a grant let through -- and what it stopped -- can still be looked up later.
//
// It holds what the user needs for that and no more: the machine, the agent, read-only or edit,
// the folder, and the first line of the screened prompt (80 characters at most). Never the prompt,
// never the output.
//
// Appends are asynchronous and queued on one chain, so lines land in order and the main thread
// never waits on the disk. Past 2 MiB the file moves to `linked-jobs.prev.jsonl`, replacing the one
// there: two files at most. A job with edit permission runs as the user and can rewrite this file
// like any other, so it is a record, not evidence -- and every line is read back field by field.
import { promises as fsp } from 'fs'
import * as path from 'path'
import type { LinkedJobRecord } from '../renderer/src/types'

export type { LinkedJobRecord }

export const LINKED_JOB_LOG_FILE = 'linked-jobs.jsonl'
export const LINKED_JOB_LOG_PREV = 'linked-jobs.prev.jsonl'

/** The size past which the file is rotated. */
export const MAX_JOB_LOG_BYTES = 2 * 1024 * 1024

/** The most lines one read returns. */
export const MAX_JOB_LOG_READ = 500

/** How much of a file one read takes from its end. A file this process wrote is no larger, give
 *  or take its last line; one something else wrote can be any size, and only its tail is read. */
const READ_TAIL_BYTES = MAX_JOB_LOG_BYTES + 64 * 1024

/** The longest fields a line may carry, as the writers cap them. Longer is not a line we wrote. */
const MAX_NAME_CHARS = 64
const MAX_REF_CHARS = 64
const MAX_CWD_CHARS = 4_096
export const MAX_SUMMARY_CHARS = 80
export const MAX_REASON_CHARS = 200
const MAX_RULES = 32

const EVENTS: readonly LinkedJobRecord['event'][] = ['started', 'finished', 'refused']
const AGENTS: readonly NonNullable<LinkedJobRecord['agent']>[] = ['claude', 'codex', 'gemini']
const STATUSES: readonly NonNullable<LinkedJobRecord['status']>[] = ['done', 'failed', 'cancelled']
const JOB_ID_RE = /^[0-9a-f]{12}$/
const RULE_RE = /^[A-Za-z0-9_]{1,64}$/

/** The file system calls the log makes. Node's own by default; a test hands in failing ones. */
export interface JobLogFs {
  appendFile(file: string, data: string, options: { encoding: 'utf8'; mode: number }): Promise<void>
  stat(file: string): Promise<{ size: number }>
  rename(from: string, to: string): Promise<void>
  open(
    file: string,
    flags: 'r',
  ): Promise<{
    stat(): Promise<{ size: number }>
    read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
    close(): Promise<void>
  }>
}

export interface LinkedJobLog {
  /** Queue one line. Never throws, and never waits: a line that can't be written is lost, the job
   *  is not. */
  append(record: LinkedJobRecord): void
  /** The latest lines, newest first, once every line queued before the call has landed. */
  recent(limit?: number): Promise<LinkedJobRecord[]>
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1

/** A line as it was read, rebuilt field by field: anything that isn't the shape written is
 *  dropped, the line too when it lacks what every line has. */
export function recordFrom(v: unknown): LinkedJobRecord | null {
  if (!isRecord(v)) return null
  const { ts, event, ref, machine } = v
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null
  if (!(EVENTS as readonly unknown[]).includes(event)) return null
  if (!text(ref, MAX_REF_CHARS) || !text(machine, MAX_NAME_CHARS)) return null
  const { jobId, agent, write, cwd, summary, status, durationMs, reason, count: n, secretRules } = v
  const rules = Array.isArray(secretRules) ? secretRules.filter((r): r is string => typeof r === 'string' && RULE_RE.test(r)) : []
  return {
    ts,
    event: event as LinkedJobRecord['event'],
    ref,
    machine,
    ...(typeof jobId === 'string' && JOB_ID_RE.test(jobId) ? { jobId } : {}),
    ...((AGENTS as readonly unknown[]).includes(agent) ? { agent: agent as LinkedJobRecord['agent'] } : {}),
    ...(typeof write === 'boolean' ? { write } : {}),
    ...(text(cwd, MAX_CWD_CHARS) ? { cwd } : {}),
    ...(text(summary, MAX_SUMMARY_CHARS) ? { summary } : {}),
    ...((STATUSES as readonly unknown[]).includes(status) ? { status: status as LinkedJobRecord['status'] } : {}),
    ...(typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}),
    ...(text(reason, MAX_REASON_CHARS) ? { reason } : {}),
    ...(count(n) ? { count: n } : {}),
    ...(rules.length > 0 ? { secretRules: rules.slice(0, MAX_RULES) } : {}),
  }
}

/** The lines in the last `max` bytes of a file, oldest first; none for a file that isn't there. A
 *  read that starts mid-file drops the partial line it starts in. */
async function readTail(fs: JobLogFs, file: string, max: number): Promise<LinkedJobRecord[]> {
  let handle: Awaited<ReturnType<JobLogFs['open']>>
  try {
    handle = await fs.open(file, 'r')
  } catch {
    return []
  }
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, max)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, size - length)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
    if (length < size) lines.shift()
    const out: LinkedJobRecord[] = []
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const record = recordFrom(JSON.parse(line))
        if (record) out.push(record)
      } catch {
        /* a torn or hand-edited line: the rest of the file still reads */
      }
    }
    return out
  } catch {
    return []
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export function createLinkedJobLog(
  userDataDir: string,
  opts: { fs?: JobLogFs; maxBytes?: number } = {},
): LinkedJobLog {
  const fs: JobLogFs = opts.fs ?? (fsp as unknown as JobLogFs)
  const maxBytes = opts.maxBytes ?? MAX_JOB_LOG_BYTES
  const file = path.join(userDataDir, LINKED_JOB_LOG_FILE)
  const prev = path.join(userDataDir, LINKED_JOB_LOG_PREV)
  let queue: Promise<void> = Promise.resolve()

  async function write(line: string): Promise<void> {
    try {
      if ((await fs.stat(file)).size >= maxBytes) await fs.rename(file, prev)
    } catch {
      /* not there yet, or it couldn't be moved: the line is appended either way */
    }
    // 0600 when it is created: it names the folders jobs ran in and what they were asked.
    await fs.appendFile(file, line, { encoding: 'utf8', mode: 0o600 })
  }

  return {
    append(record) {
      let line: string
      try {
        line = `${JSON.stringify(record)}\n`
      } catch {
        return
      }
      queue = queue.then(() => write(line)).catch(() => undefined)
    },

    async recent(limit = MAX_JOB_LOG_READ) {
      const n = Math.min(Math.max(Math.floor(Number.isFinite(limit) ? limit : MAX_JOB_LOG_READ), 1), MAX_JOB_LOG_READ)
      await queue
      let lines = await readTail(fs, file, READ_TAIL_BYTES)
      if (lines.length < n) lines = [...(await readTail(fs, prev, READ_TAIL_BYTES)), ...lines]
      return lines.slice(-n).reverse()
    },
  }
}
