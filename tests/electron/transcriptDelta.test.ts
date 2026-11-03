import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { countSyncFs, type SyncFsCounter } from './_syncFsCounter'
import {
  BROKEN_LINE,
  PREAMBLE,
  TEXTS,
  assistantLine,
  delegated,
  lines,
  metaLine,
  mulberry32,
  noiseLine,
  primed,
  summaryLine,
  toolCallLine,
  toolResultLine,
  userBlocksLine,
  userLine,
} from './_transcriptFixture'

// memory:reflect-session used to read the transcript BEFORE it looked at the cursor: up to five whole
// files per pass (one of them 77.5 MiB: 229 to 296 ms of synchronous parsing and +78 to +167 MiB of heap
// per call), hashed every turn twice, and only then found that nothing was new. readSessionDelta is told
// the cursor first. An unchanged transcript is not opened; a grown one is read from the byte after the
// last line already reflected; and any doubt gives null, which the caller answers by doing what it always
// did. Every claim below is a COUNTER (opens, reads, bytes, parse calls, sync fs calls), and the one that
// matters most is the equivalence: whatever the delta reader says must be exactly what reading the whole
// file would have said.
//
// Real files, under a scratch home: os.homedir() reads USERPROFILE / HOME, so they are pointed at it
// BEFORE the modules under test are first imported, and a guard stops the file if that did not take.

type DeltaMod = typeof import('../../src/main/transcriptDelta')
type DeltaDeps = import('../../src/main/transcriptDelta').DeltaDeps
type ListMod = typeof import('../../src/main/claudeSessionList')
type WatcherMod = typeof import('../../src/main/transcriptWatchers/claudeCodeWatcher')
type LiveMod = typeof import('../../src/main/liveTranscript')
type IngestMod = typeof import('../../src/main/conversationIngest')
type MnemeMod = typeof import('../../src/main/mnemeSession')
type PassMod = typeof import('../../src/main/passCounters')
type Cursor = import('../../src/main/mnemeSession').SessionCursor

let home: string
let work: string
let delta: DeltaMod
let list: ListMod
let watcher: WatcherMod
let live: LiveMod
let ingest: IngestMod
let mneme: MnemeMod
let passes: PassMod
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-delta-home-'))
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-delta-work-'))
  for (const k of ['USERPROFILE', 'HOME']) saved[k] = process.env[k]
  process.env.USERPROFILE = home
  process.env.HOME = home
  watcher = await import('../../src/main/transcriptWatchers/claudeCodeWatcher')
  list = await import('../../src/main/claudeSessionList')
  delta = await import('../../src/main/transcriptDelta')
  live = await import('../../src/main/liveTranscript')
  ingest = await import('../../src/main/conversationIngest')
  mneme = await import('../../src/main/mnemeSession')
  passes = await import('../../src/main/passCounters')
  // The guard: never go on if the scratch home did not take.
  expect(path.resolve(watcher.CLAUDE_PROJECTS_DIR).toLowerCase().startsWith(path.resolve(home).toLowerCase())).toBe(true)
})

afterAll(() => {
  for (const k of ['USERPROFILE', 'HOME']) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  for (const d of [home, work]) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

let seq = 0
let tick = 0
const T0 = 1_700_000_000
const at = (s: number): Date => new Date((T0 + s) * 1000)

interface Project {
  cwd: string
  dir: string
}

/** A working folder that exists, and Claude Code's project folder for it. */
function newProject(): Project {
  const cwd = path.join(work, `repo-${seq++}`)
  fs.mkdirSync(cwd, { recursive: true })
  const dir = path.join(watcher.CLAUDE_PROJECTS_DIR, watcher.mangleCwd(watcher.claudeCwd(cwd)))
  fs.mkdirSync(dir, { recursive: true })
  return { cwd, dir }
}

/** The folder changed (a transcript came or went): say so by a new mtime, deterministically. */
function touchDir(p: Project): void {
  tick += 1
  fs.utimesSync(p.dir, at(100_000 + tick), at(100_000 + tick))
}

function write(dir: string, name: string, body: string | Buffer, mtimeS = 10): string {
  const file = path.join(dir, `${name}.jsonl`)
  fs.writeFileSync(file, body)
  fs.utimesSync(file, at(mtimeS), at(mtimeS))
  return file
}

interface Counts {
  lists: number
  stats: number
  opens: number
  reads: number
  bytes: number
  readFiles: number
  parseCalls: number
  parseChars: number
  maxParseChars: number
  yields: number
}

/** Deps over the REAL fs, every call counted. */
function makeDeps(over: Partial<DeltaDeps> = {}, chunkBytes = 4 * 1024 * 1024): { deps: DeltaDeps; c: Counts } {
  const c: Counts = { lists: 0, stats: 0, opens: 0, reads: 0, bytes: 0, readFiles: 0, parseCalls: 0, parseChars: 0, maxParseChars: 0, yields: 0 }
  const deps: DeltaDeps = {
    listFiles: async (cwd, agent) => {
      c.lists++
      return agent === 'claude' ? list.listSessionFilesAsync(cwd, { limit: 5 }) : []
    },
    fs: {
      stat: async (f) => {
        c.stats++
        return fs.promises.stat(f)
      },
      open: async (f) => {
        c.opens++
        const fh = await fs.promises.open(f, 'r')
        return {
          stat: () => fh.stat(),
          read: async (buf, off, len, pos) => {
            const r = await fh.read(buf, off, len, pos)
            c.reads++
            c.bytes += r.bytesRead
            return r
          },
          close: () => fh.close(),
        }
      },
      readFile: async (f) => {
        c.readFiles++
        const s = await fs.promises.readFile(f, 'utf8')
        c.bytes += Buffer.byteLength(s)
        return s
      },
    },
    parse: (agent, content) => {
      c.parseCalls++
      c.parseChars += content.length
      c.maxParseChars = Math.max(c.maxParseChars, content.length)
      return ingest.parseBySource(agent as 'claude', content)
    },
    now: () => Date.now(),
    yieldToLoop: async () => {
      c.yields++
    },
    chunkBytes,
    ...over,
  }
  return { deps, c }
}

/** What reading the WHOLE transcript says, through the code the delta reader replaces. */
async function legacyTurns(cwd: string, files: string[], agent = 'claude') {
  return live.readSessionTranscript(cwd, agent, {
    findFiles: async () => files,
    readFile: (f) => fs.promises.readFile(f, 'utf8'),
    parse: (a, content) => ingest.parseBySource(a as 'claude' | 'codex' | 'gemini', content),
  })
}

type AnyTurn = { role: string; text?: string; content?: string }
const texts = (turns: AnyTurn[]): string[] => turns.map((t) => t.text ?? t.content ?? '')
const rt = (turns: AnyTurn[]): Array<[string, string]> => turns.map((t) => [t.role, t.text ?? t.content ?? ''])

let counter: SyncFsCounter | null = null
beforeEach(() => {
  list.resetSessionListCache()
  delta.resetDeltaState()
  passes.resetPasses()
})
afterEach(() => {
  counter?.restore()
  counter = null
})

describe('the stat gate: an unchanged transcript is not opened', () => {
  it('opens nothing, reads nothing, parses nothing, and hands the very same cursor back', async () => {
    const p = newProject()
    const file = write(p.dir, 's1', lines(userLine('Fix the build'), assistantLine('on it')))
    const { deps, c } = makeDeps()

    const first = await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)
    expect(first).not.toBeNull()
    expect(texts(first!.fresh)).toEqual(['Fix the build', 'on it'])
    expect(first!.cursor.count).toBe(2)
    const size = fs.statSync(file).size
    expect(first!.cursor.pos).toMatchObject({ file, size, offset: size })
    const cold = { ...c }
    expect(cold.opens).toBe(1)

    for (let i = 0; i < 25; i++) {
      const again = await delta.readSessionDelta(p.cwd, 'claude', first!.cursor, deps)
      expect(again!.fresh).toEqual([])
      expect(again!.cursor).toBe(first!.cursor)
    }
    expect(c.opens).toBe(cold.opens)
    expect(c.reads).toBe(cold.reads)
    expect(c.bytes).toBe(cold.bytes)
    expect(c.readFiles).toBe(0)
    expect(c.parseCalls).toBe(cold.parseCalls)
  })

  it('CONTROL: the whole-transcript reader it replaces opens, reads and parses the file again on every pass', async () => {
    const p = newProject()
    const file = write(p.dir, 's1', lines(userLine('Fix the build'), assistantLine('on it')))
    const size = fs.statSync(file).size
    let reads = 0
    let bytes = 0
    let parses = 0
    for (let i = 0; i < 25; i++) {
      await live.readSessionTranscript(p.cwd, 'claude', {
        findFiles: async () => [file],
        readFile: async (f) => {
          reads++
          const s = await fs.promises.readFile(f, 'utf8')
          bytes += Buffer.byteLength(s)
          return s
        },
        parse: (a, content) => {
          parses++
          return ingest.parseBySource(a as 'claude', content)
        },
      })
    }
    expect(reads).toBe(25)
    expect(parses).toBe(25)
    expect(bytes).toBe(25 * size)
  })
})

describe('the delta: only the bytes after the cursor', () => {
  it('reads exactly the bytes that were added (plus the 256-byte anchor), however big the file already is', async () => {
    const p = newProject()
    const body = lines(...Array.from({ length: 400 }, (_, i) => (i % 2 ? assistantLine(`answer ${i} ${'y'.repeat(60)}`) : userLine(`question ${i} ${'x'.repeat(60)}`))))
    const file = write(p.dir, 's1', body)
    const { deps, c } = makeDeps()
    const first = await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)
    const size1 = fs.statSync(file).size
    expect(size1).toBeGreaterThan(40_000)
    const o1 = mneme.sessionDelta(await legacyTurns(p.cwd, [file]), mneme.EMPTY_CURSOR) // what the whole-file path said, BEFORE the append
    const before = { ...c }

    const added = lines(userLine('one more thing'), assistantLine('done, tests pass'))
    fs.appendFileSync(file, added)
    const second = await delta.readSessionDelta(p.cwd, 'claude', first!.cursor, deps)

    expect(texts(second!.fresh)).toEqual(['one more thing', 'done, tests pass'])
    expect(c.opens - before.opens).toBe(1)
    expect(c.bytes - before.bytes).toBe(delta.ANCHOR_BYTES + Buffer.byteLength(added))
    expect(c.parseChars - before.parseChars).toBe(added.length) // only the new lines were parsed
    expect(second!.cursor.count).toBe(402)
    expect(second!.cursor.pos!.offset).toBe(size1 + Buffer.byteLength(added))
    expect(second!.cursor.pos!.size).toBe(fs.statSync(file).size)

    // and it says exactly what reading the whole file says
    const o2 = mneme.sessionDelta(await legacyTurns(p.cwd, [file]), o1.cursor)
    expect(second!.cursor.count).toBe(o2.cursor.count)
    expect(second!.cursor.hash).toBe(o2.cursor.hash)
    expect(rt(second!.fresh)).toEqual(rt(o2.fresh))
  })

  it('does not consume a line that is still being written, and takes it once it is whole', async () => {
    const p = newProject()
    const file = write(p.dir, 's1', lines(userLine('first'), assistantLine('second')))
    const { deps } = makeDeps()
    const first = await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)
    const sizeWhole = fs.statSync(file).size

    const late = userLine('late arrival, still being written')
    fs.appendFileSync(file, late.slice(0, 31)) // a writer caught mid-line
    const mid = await delta.readSessionDelta(p.cwd, 'claude', first!.cursor, deps)
    expect(mid!.fresh).toEqual([])
    expect(mid!.cursor.count).toBe(2)
    expect(mid!.cursor.pos!.offset).toBe(sizeWhole) // the half line is NOT consumed

    fs.appendFileSync(file, late.slice(31) + '\n')
    const done = await delta.readSessionDelta(p.cwd, 'claude', mid!.cursor, deps)
    expect(texts(done!.fresh)).toEqual(['late arrival, still being written'])
    expect(done!.cursor.count).toBe(3)
    expect(done!.cursor.pos!.offset).toBe(fs.statSync(file).size)
  })

  it('takes a whole last line that has no newline yet at once, and does not take it again when the newline comes', async () => {
    const p = newProject()
    const file = write(p.dir, 's1', lines(userLine('first')))
    const { deps } = makeDeps()
    const first = await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)

    fs.appendFileSync(file, assistantLine('no newline yet')) // complete JSON, no terminator
    const a = await delta.readSessionDelta(p.cwd, 'claude', first!.cursor, deps)
    expect(texts(a!.fresh)).toEqual(['no newline yet'])
    expect(a!.cursor.pos!.offset).toBe(fs.statSync(file).size)

    fs.appendFileSync(file, '\n')
    const b = await delta.readSessionDelta(p.cwd, 'claude', a!.cursor, deps)
    expect(b!.fresh).toEqual([]) // not twice
    expect(b!.cursor.count).toBe(2)
  })

  it('skips what is not dialogue (tool calls, results, meta, command noise, summaries, broken lines) as the whole-file parse does', async () => {
    const p = newProject()
    const file = write(p.dir, 's1', lines(userLine('start')))
    const { deps } = makeDeps()
    const first = await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)
    fs.appendFileSync(file, lines(toolCallLine(), toolResultLine(), metaLine(), noiseLine(), summaryLine(), BROKEN_LINE, userBlocksLine('from blocks'), assistantLine('real answer')))
    const second = await delta.readSessionDelta(p.cwd, 'claude', first!.cursor, deps)
    expect(texts(second!.fresh)).toEqual(['from blocks', 'real answer'])
    const o = mneme.sessionDelta(await legacyTurns(p.cwd, [file]), mneme.sessionDelta([{ role: 'user', text: 'start' }], mneme.EMPTY_CURSOR).cursor)
    expect(second!.cursor.hash).toBe(o.cursor.hash)
    expect(second!.cursor.count).toBe(o.cursor.count)
  })

  it('a touch (same size, newer mtime) costs one open and the anchor, finds nothing new, and is then an unchanged file again', async () => {
    const p = newProject()
    const file = write(p.dir, 's1', lines(userLine('first'), assistantLine('second')))
    const { deps, c } = makeDeps()
    const first = await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)
    const before = { ...c }

    fs.utimesSync(file, at(5000), at(5000))
    const touched = await delta.readSessionDelta(p.cwd, 'claude', first!.cursor, deps)
    expect(touched!.fresh).toEqual([])
    expect(touched!.cursor.count).toBe(2)
    expect(touched!.cursor.pos!.mtimeMs).toBe(fs.statSync(file).mtimeMs)
    expect(c.opens - before.opens).toBe(1)
    expect(c.bytes - before.bytes).toBeLessThanOrEqual(delta.ANCHOR_BYTES)

    const mid = { ...c }
    await delta.readSessionDelta(p.cwd, 'claude', touched!.cursor, deps)
    expect(c.opens).toBe(mid.opens)
  })
})

describe('a cold read is chunked', () => {
  it('reads in chunks, yields to the event loop between them, and never parses more than a chunk plus a line at once', async () => {
    const p = newProject()
    const bodies = Array.from({ length: 120 }, (_, i) => (i % 2 ? assistantLine : userLine)(`turn ${i} ${'z'.repeat(80)}`))
    const file = write(p.dir, 's1', lines(...bodies))
    const size = fs.statSync(file).size
    const chunk = 2048
    const { deps, c } = makeDeps({}, chunk)

    const res = await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)
    expect(res!.fresh).toHaveLength(120)
    expect(c.reads).toBe(Math.ceil(size / chunk))
    expect(c.bytes).toBe(size)
    expect(c.yields).toBe(c.reads - 1)
    const longestLine = Math.max(...bodies.map((b) => b.length)) + 1
    expect(c.parseCalls).toBeGreaterThan(5)
    expect(c.maxParseChars).toBeLessThanOrEqual(chunk + longestLine)
    // same answer as one whole read
    expect(rt(res!.fresh)).toEqual(rt(await legacyTurns(p.cwd, [file])))
  })

  it('carries a line longer than a chunk across chunks', async () => {
    const p = newProject()
    const long = 'L'.repeat(5000)
    const file = write(p.dir, 's1', lines(userLine('short'), assistantLine(long), userLine('after')))
    const { deps, c } = makeDeps({}, 700)
    const res = await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)
    expect(texts(res!.fresh)).toEqual(['short', long, 'after'])
    expect(c.bytes).toBe(fs.statSync(file).size)
  })
})

describe('delegated sessions (another computer ran them here)', () => {
  it('reads only the head of one, once; later passes skip it without opening it', async () => {
    const p = newProject()
    const own = write(p.dir, 'own', lines(userLine('Fix the build'), assistantLine('ok')), 10)
    const job = write(p.dir, 'job', lines(userLine(delegated()), assistantLine('reviewed'), ...Array.from({ length: 300 }, (_, i) => assistantLine(`${'x'.repeat(100)}${i}`))), 20)
    touchDir(p)
    expect(fs.statSync(job).size).toBeGreaterThan(30_000)
    const chunk = 1024
    const { deps, c } = makeDeps({}, chunk)

    const first = await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)
    // the newest session is the delegated one: passed over; the own one is what is reflected
    expect(texts(first!.fresh)).toEqual(['Fix the build', 'ok'])
    expect(first!.cursor.pos!.file).toBe(own)
    expect(c.opens).toBe(2)
    expect(c.bytes).toBe(chunk + fs.statSync(own).size) // ONE chunk of the 30 KB job, then the own file

    const before = { ...c }
    const again = await delta.readSessionDelta(p.cwd, 'claude', first!.cursor, deps)
    expect(again!.fresh).toEqual([])
    expect(c.opens).toBe(before.opens)
    expect(c.bytes).toBe(before.bytes)
  })

  it('stops reading a delegated session as soon as its opening prompt is in, even when preambles come first', async () => {
    const p = newProject()
    const job = write(p.dir, 'job', lines(userLine(PREAMBLE), userLine(delegated()), ...Array.from({ length: 300 }, (_, i) => assistantLine(`${'x'.repeat(100)}${i}`))), 20)
    // A chunk smaller than the preamble line: the preamble and the prompt complete in DIFFERENT chunks, so the
    // first look at the turns so far sees only a preamble and must NOT judge the session yet.
    const chunk = 128
    expect(fs.statSync(job).size).toBeGreaterThan(30_000)
    expect(userLine(PREAMBLE).length).toBeGreaterThan(chunk)
    const { deps, c } = makeDeps({}, chunk)
    const res = await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)
    expect(res).toEqual(mneme.sessionDelta([], mneme.EMPTY_CURSOR))
    expect(c.bytes).toBeLessThan(2000) // the head, not the 30 KB
  })

  it('CONTROL: the whole-transcript reader reads the entire delegated file on every pass', async () => {
    const p = newProject()
    const own = write(p.dir, 'own', lines(userLine('Fix the build'), assistantLine('ok')), 10)
    const job = write(p.dir, 'job', lines(userLine(delegated()), ...Array.from({ length: 300 }, (_, i) => assistantLine(`${'x'.repeat(100)}${i}`))), 20)
    let bytes = 0
    for (let i = 0; i < 3; i++) {
      await live.readSessionTranscript(p.cwd, 'claude', {
        findFiles: async () => [job, own],
        readFile: async (f) => {
          const s = await fs.promises.readFile(f, 'utf8')
          bytes += Buffer.byteLength(s)
          return s
        },
        parse: (a, content) => ingest.parseBySource(a as 'claude', content),
      })
    }
    expect(bytes).toBe(3 * (fs.statSync(job).size + fs.statSync(own).size))
  })

  it('passes over a session that turns out to be delegated after it was first seen as a bare preamble', async () => {
    const p = newProject()
    const file = write(p.dir, 's1', lines(userLine(PREAMBLE)))
    const { deps, c } = makeDeps()
    const first = await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)
    expect(texts(first!.fresh)).toEqual([PREAMBLE])
    expect(first!.cursor.pos!.offset).toBeUndefined() // unsettled: no byte position to carry on from

    fs.appendFileSync(file, lines(userLine(delegated()), assistantLine('reviewed')))
    const second = await delta.readSessionDelta(p.cwd, 'claude', first!.cursor, deps)
    expect(second!.fresh).toEqual([])
    expect(second!.cursor.count).toBe(0) // as the whole-file reader: no own transcript at all
    const before = { ...c }
    await delta.readSessionDelta(p.cwd, 'claude', second!.cursor, deps)
    expect(c.opens).toBe(before.opens) // and now it is remembered as delegated
  })
})

describe('where the cursor stands in the file', () => {
  it('an opening that is only preamble has no byte position until the prompt is there, then carries on from it', async () => {
    const p = newProject()
    const file = write(p.dir, 's1', lines(userLine(PREAMBLE)))
    const { deps, c } = makeDeps()
    const a = await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)
    expect(a!.cursor.pos).toMatchObject({ file })
    expect(a!.cursor.pos!.offset).toBeUndefined()

    const before = { ...c }
    const same = await delta.readSessionDelta(p.cwd, 'claude', a!.cursor, deps)
    expect(c.opens).toBe(before.opens) // still gated by size and mtime

    fs.appendFileSync(file, lines(userLine('Fix the build'), assistantLine('on it')))
    const b = await delta.readSessionDelta(p.cwd, 'claude', same!.cursor, deps)
    expect(texts(b!.fresh)).toEqual(['Fix the build', 'on it']) // read in full (it was not settled), diffed against the cursor: the preamble was reflected
    expect(b!.cursor.count).toBe(3)
    expect(b!.cursor.pos!.offset).toBe(fs.statSync(file).size)

    const mid = { ...c }
    fs.appendFileSync(file, lines(userLine('next')))
    const d = await delta.readSessionDelta(p.cwd, 'claude', b!.cursor, deps)
    expect(texts(d!.fresh)).toEqual(['next'])
    expect(c.bytes - mid.bytes).toBe(Math.min(delta.ANCHOR_BYTES, b!.cursor.pos!.offset!) + Buffer.byteLength(lines(userLine('next'))))
  })

  it('follows the file when the newest own session changes: all of the new one is fresh, as the whole-file reader says', async () => {
    const p = newProject()
    const a = write(p.dir, 'a', lines(userLine('task A'), assistantLine('answer A')), 10)
    const { deps } = makeDeps()
    const first = await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)
    expect(first!.cursor.pos!.file).toBe(a)

    const b = write(p.dir, 'b', lines(userLine('task B'), assistantLine('answer B'), userLine('more B')), 50)
    touchDir(p)
    const second = await delta.readSessionDelta(p.cwd, 'claude', first!.cursor, deps)
    expect(texts(second!.fresh)).toEqual(['task B', 'answer B', 'more B'])
    expect(second!.cursor.pos!.file).toBe(b)

    const o1 = mneme.sessionDelta(await legacyTurns(p.cwd, [a]), mneme.EMPTY_CURSOR)
    const o2 = mneme.sessionDelta(await legacyTurns(p.cwd, [b, a]), o1.cursor)
    expect(rt(second!.fresh)).toEqual(rt(o2.fresh))
    expect(second!.cursor.hash).toBe(o2.cursor.hash)
  })

  it('says there is no transcript (count 0, nothing fresh) when the folder has none, as the whole-file reader does', async () => {
    const p = newProject()
    const { deps } = makeDeps()
    const prev: Cursor = { count: 7, hash: 'abc' }
    const res = await delta.readSessionDelta(p.cwd, 'claude', prev, deps)
    expect(res).toEqual(mneme.sessionDelta([], prev))
  })
})

describe('anything it cannot be sure of is a full read, never a guess', () => {
  async function grown(): Promise<{ p: Project; file: string; first: Cursor; deps: DeltaDeps; c: Counts }> {
    const p = newProject()
    const file = write(p.dir, 's1', lines(userLine('Fix the build'), assistantLine('on it'), userLine('and the tests'), assistantLine('done, tests pass')))
    const { deps, c } = makeDeps()
    const first = await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)
    return { p, file, first: first!.cursor, deps, c }
  }

  async function sameAsWhole(p: Project, file: string, got: { fresh: AnyTurn[]; cursor: Cursor }, legacyPrev: Cursor): Promise<void> {
    const o = mneme.sessionDelta(await legacyTurns(p.cwd, [file]), legacyPrev)
    expect(rt(got.fresh)).toEqual(rt(o.fresh))
    expect(got.cursor.count).toBe(o.cursor.count)
    expect(got.cursor.hash).toBe(o.cursor.hash)
  }

  it('the file got SHORTER than the position: read in full, and the old reflected turns no longer match', async () => {
    const { p, file, first, deps, c } = await grown()
    const legacyPrev = mneme.sessionDelta(await legacyTurns(p.cwd, [file]), mneme.EMPTY_CURSOR).cursor
    fs.writeFileSync(file, lines(userLine('a different start'), assistantLine('an answer')))
    fs.utimesSync(file, at(900), at(900))
    const before = c.bytes
    const got = await delta.readSessionDelta(p.cwd, 'claude', first, deps)
    expect(c.bytes - before).toBe(fs.statSync(file).size) // the whole new file, no anchor
    await sameAsWhole(p, file, got!, legacyPrev)
  })

  it('the file was REWRITTEN to something longer: the anchor does not match, so it is read in full', async () => {
    const { p, file, first, deps, c } = await grown()
    const legacyPrev = mneme.sessionDelta(await legacyTurns(p.cwd, [file]), mneme.EMPTY_CURSOR).cursor
    fs.writeFileSync(file, lines(userLine('Fix the build'), assistantLine('on it'), userLine('and the tests'), assistantLine('this is NOT what it said before'), userLine('and a lot more'), assistantLine('after the rewrite')))
    fs.utimesSync(file, at(901), at(901))
    const before = c.bytes
    const got = await delta.readSessionDelta(p.cwd, 'claude', first, deps)
    // it tried the anchor (that is what told it the file was not the one it followed), then read the whole new file
    expect(c.bytes - before).toBe(Math.min(delta.ANCHOR_BYTES, first.pos!.offset!) + fs.statSync(file).size)
    await sameAsWhole(p, file, got!, legacyPrev)
  })

  // Each names the REAL file: a position for some other file is ignored for the trivial reason.
  it.each([
    ['not an object', () => 'junk'],
    ['no file', () => ({ size: 1, mtimeMs: 1 })],
    ['a size that is not a number', (f: string) => ({ file: f, size: 'big', mtimeMs: 1 })],
    ['a negative size', (f: string) => ({ file: f, size: -1, mtimeMs: 1 })],
    ['an offset past the size', (f: string) => ({ file: f, size: 10, mtimeMs: 1, offset: 99, anchor: 'ab', anchorLen: 0 })],
    ['an offset that is not a whole number', (f: string) => ({ file: f, size: 10, mtimeMs: 1, offset: 4.5, anchor: 'ab', anchorLen: 4 })],
    ['an anchor that is not a hash', (f: string) => ({ file: f, size: 10, mtimeMs: 1, offset: 5, anchor: 'ZZZ', anchorLen: 5 })],
    ['an anchor longer than the offset', (f: string) => ({ file: f, size: 10, mtimeMs: 1, offset: 5, anchor: 'ab', anchorLen: 9 })],
    ['an anchor longer than anchors are', (f: string) => ({ file: f, size: 9999, mtimeMs: 1, offset: 5000, anchor: 'ab', anchorLen: 4000 })],
  ])('a position it cannot trust (%s) is ignored: the whole file is read', async (_why, make) => {
    const { p, file, first, deps, c } = await grown()
    const before = { ...c }
    const got = await delta.readSessionDelta(p.cwd, 'claude', { ...first, pos: make(file) as never }, deps)
    expect(c.bytes - before.bytes).toBe(fs.statSync(file).size)
    expect(got!.fresh).toEqual([]) // nothing new: it simply had to look to know
    expect(got!.cursor.count).toBe(first.count)
    expect(got!.cursor.hash).toBe(first.hash)
    expect(got!.cursor.pos).toMatchObject({ file, offset: fs.statSync(file).size })
  })

  it('UPGRADE: a cursor written before byte positions existed ({count, hash} only) costs ONE full read, reflects only what is after it, and gains a position', async () => {
    const p = newProject()
    const file = write(p.dir, 's1', lines(userLine('first task'), assistantLine('first answer')))
    // the cursor the OLD code stored after reflecting those two turns
    const old = mneme.sessionDelta(await legacyTurns(p.cwd, [file]), mneme.EMPTY_CURSOR).cursor
    expect(old.pos).toBeUndefined()
    fs.appendFileSync(file, lines(userLine('second task'), assistantLine('second answer')))
    const { deps, c } = makeDeps()

    const first = await delta.readSessionDelta(p.cwd, 'claude', old, deps)
    expect(texts(first!.fresh)).toEqual(['second task', 'second answer']) // nothing reflected twice
    expect(c.bytes).toBe(fs.statSync(file).size) // the whole file, once
    expect(first!.cursor.count).toBe(4)
    expect(first!.cursor.pos).toMatchObject({ file, offset: fs.statSync(file).size })

    const before = { ...c }
    const again = await delta.readSessionDelta(p.cwd, 'claude', first!.cursor, deps)
    expect(again!.fresh).toEqual([])
    expect(c.opens).toBe(before.opens) // and from here on it is a stat
  })

  describe('a position whose size or mtime is not a number', () => {
    // A file big enough that the cost tells the two paths apart: carrying on from the offset reads the
    // 256 anchor bytes; the full read reads all of it. The recorded size is one MORE than the real one, so
    // the unchanged gate does not fire and the offset is not past it: only the type of the field is in question.
    async function craft(bad: (size: number) => Record<string, unknown>) {
      const p = newProject()
      const body = lines(...Array.from({ length: 24 }, (_, i) => (i % 2 ? assistantLine : userLine)(`turn ${i} ${'w'.repeat(30)}`)))
      const file = write(p.dir, 's1', body)
      const { deps: d0 } = makeDeps()
      const first = await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, d0)
      const real = fs.statSync(file)
      expect(real.size).toBeGreaterThan(1500)
      const crafted = { ...first!.cursor.pos!, mtimeMs: 1, size: real.size + 1, ...bad(real.size + 1) }
      const { deps, c } = makeDeps()
      const got = await delta.readSessionDelta(p.cwd, 'claude', { ...first!.cursor, pos: crafted as never }, deps)
      return { got, c, size: real.size }
    }

    it('CONTROL: the same position with numbers is trusted, and only the anchor is read', async () => {
      const { got, c } = await craft(() => ({}))
      expect(c.bytes).toBe(delta.ANCHOR_BYTES)
      expect(got!.fresh).toEqual([])
    })

    it.each([
      ['size', (n: number) => ({ size: String(n) })],
      ['mtimeMs', () => ({ mtimeMs: 'yesterday' })],
    ])('%s: not trusted, so the whole file is read', async (_field, bad) => {
      const { got, c, size } = await craft(bad)
      expect(c.bytes).toBe(size)
      expect(got!.fresh).toEqual([])
    })
  })

  it('a position whose offset is past its own recorded size is not trusted, even when its anchor matches the real file', async () => {
    const { p, file, first, deps, c } = await grown()
    const real = fs.readFileSync(file)
    const fnvHex = (b: Buffer): string => {
      let h = 0x811c9dc5
      for (const x of b) {
        h ^= x
        h = Math.imul(h, 0x01000193)
      }
      return (h >>> 0).toString(16)
    }
    expect(real.length).toBeGreaterThan(99)
    // consistent in every way but one: it claims to have consumed 99 bytes of a file it recorded as 10 long
    const pos = { file, size: 10, mtimeMs: 1, offset: 99, anchor: fnvHex(real.subarray(0, 99)), anchorLen: 99 }
    const before = { ...c }
    const got = await delta.readSessionDelta(p.cwd, 'claude', { ...first, pos }, deps)
    expect(c.bytes - before.bytes).toBe(real.length) // the whole file: no carrying on from byte 99
    expect(got!.fresh).toEqual([])
    expect(got!.cursor.count).toBe(first.count)
    expect(got!.cursor.hash).toBe(first.hash)
    expect(got!.cursor.pos!.offset).toBe(real.length)
  })

  it('a hash it cannot continue (a cursor not written by this code) is a full read', async () => {
    const { p, file, first, deps, c } = await grown()
    const before = c.bytes
    fs.appendFileSync(file, lines(userLine('one more')))
    const got = await delta.readSessionDelta(p.cwd, 'claude', { ...first, hash: 'NOT-A-HASH' }, deps)
    expect(c.bytes - before).toBeGreaterThanOrEqual(fs.statSync(file).size)
    expect(got).not.toBeNull()
  })

  it.each([
    ['listing fails', { listFiles: async () => { throw new Error('EMFILE') } }],
    ['the file cannot be opened', { fs: { stat: fs.promises.stat, open: async () => { throw new Error('EBUSY') }, readFile: async () => '' } }],
  ])('%s: null, so the caller does what it always did', async (_why, over) => {
    const p = newProject()
    write(p.dir, 's1', lines(userLine('x')))
    const { deps } = makeDeps(over as Partial<DeltaDeps>)
    expect(await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)).toBeNull()
  })

  it('a read that fails halfway is null too, and closes the file', async () => {
    const p = newProject()
    write(p.dir, 's1', lines(userLine('x')))
    let closed = 0
    const { deps } = makeDeps({
      fs: {
        stat: fs.promises.stat,
        readFile: async () => '',
        open: async () => ({
          stat: async () => ({ size: 100, mtimeMs: 1 }),
          read: async () => { throw new Error('EIO') },
          close: async () => { closed++ },
        }),
      },
    })
    expect(await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)).toBeNull()
    expect(closed).toBe(1)
  })

  it('does nothing for no folder, no agent or an agent it does not know', async () => {
    const { deps, c } = makeDeps()
    expect(await delta.readSessionDelta('', 'claude', mneme.EMPTY_CURSOR, deps)).toBeNull()
    expect(await delta.readSessionDelta('/r', '', mneme.EMPTY_CURSOR, deps)).toBeNull()
    expect(await delta.readSessionDelta('/r', 'agy', mneme.EMPTY_CURSOR, deps)).toBeNull()
    expect(c.lists + c.stats + c.opens + c.readFiles).toBe(0)
  })
})

describe('races and odd files', () => {
  /** The real fs, with the handle's methods wrapped. `n` counts handles opened. */
  function wrapped(over: {
    stat?: (n: number, real: { size: number; mtimeMs: number }) => { size: number; mtimeMs: number }
    read?: (n: number, call: number) => 'eof' | 'real'
    close?: 'throws'
  }): { fs: DeltaDeps['fs']; opened: () => number; closed: () => number } {
    let n = 0
    let closed = 0
    return {
      opened: () => n,
      closed: () => closed,
      fs: {
        stat: (f) => fs.promises.stat(f),
        readFile: (f) => fs.promises.readFile(f, 'utf8'),
        open: async (f) => {
          const fh = await fs.promises.open(f, 'r')
          const mine = ++n
          let call = 0
          return {
            stat: async () => {
              const real = await fh.stat()
              return over.stat ? over.stat(mine, real) : real
            },
            read: async (buf, off, len, pos) => {
              call++
              if (over.read?.(mine, call) === 'eof') return { bytesRead: 0 }
              return fh.read(buf, off, len, pos)
            },
            close: async () => {
              closed++
              await fh.close()
              if (over.close === 'throws') throw new Error('EBADF')
            },
          }
        },
      },
    }
  }

  async function sessionFile(body: string): Promise<{ p: Project; file: string }> {
    const p = newProject()
    return { p, file: write(p.dir, 's1', body) }
  }

  it('a file that is cut short while it is being read is an empty read, not an error; the handle is closed', async () => {
    const { p } = await sessionFile(lines(userLine('first'), assistantLine('second')))
    const w = wrapped({ read: () => 'eof' })
    const { deps } = makeDeps({ fs: w.fs })
    const res = await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)
    const empty = mneme.sessionDelta([], mneme.EMPTY_CURSOR) // what reading an empty file says
    expect(res!.fresh).toEqual([])
    expect(res!.cursor.count).toBe(empty.cursor.count)
    expect(res!.cursor.hash).toBe(empty.cursor.hash)
    expect(res!.cursor.pos!.offset).toBeUndefined() // nothing settled, so no byte to carry on from
    expect(w.closed()).toBe(w.opened())
  })

  it('a file that shrinks between the size check and the open falls back to a full read and says what the whole file says', async () => {
    const { p, file } = await sessionFile(lines(userLine('first'), assistantLine('second')))
    const { deps: d0 } = makeDeps()
    const a = await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, d0)
    fs.appendFileSync(file, lines(userLine('third'), assistantLine('fourth')))
    // the first handle (the incremental attempt) sees a file shorter than the offset: a rewrite
    const w = wrapped({ stat: (n, real) => (n === 1 ? { ...real, size: 3 } : real) })
    const { deps } = makeDeps({ fs: w.fs })
    const got = await delta.readSessionDelta(p.cwd, 'claude', a!.cursor, deps)
    const want = mneme.sessionDelta(await legacyTurns(p.cwd, [file]), a!.cursor)
    expect(rt(got!.fresh)).toEqual(rt(want.fresh))
    expect(got!.cursor.hash).toBe(want.cursor.hash)
    expect(w.opened()).toBe(2) // the attempt, then the full read
    expect(w.closed()).toBe(2)
  })

  it('a position at byte 0 (nothing was consumed) carries on from the start without an anchor', async () => {
    const { p, file } = await sessionFile(lines(userLine('first'), assistantLine('second')))
    const pos = { file, size: 1, mtimeMs: 1, offset: 0, anchor: '811c9dc5', anchorLen: 0 }
    const { deps, c } = makeDeps()
    const got = await delta.readSessionDelta(p.cwd, 'claude', { count: 0, hash: '', pos }, deps)
    const want = mneme.sessionDelta(await legacyTurns(p.cwd, [file]), mneme.EMPTY_CURSOR)
    expect(rt(got!.fresh)).toEqual(rt(want.fresh))
    expect(got!.cursor.hash).toBe(want.cursor.hash)
    expect(c.bytes).toBe(fs.statSync(file).size) // no anchor bytes: there was nothing before byte 0
  })

  it('an anchor length that is not the one it would read now (a hand-edited cursor) is not trusted: one full read', async () => {
    const body = lines(...Array.from({ length: 30 }, (_, i) => (i % 2 ? assistantLine : userLine)(`turn ${i} ${'q'.repeat(40)}`)))
    const { p, file } = await sessionFile(body)
    const size = fs.statSync(file).size
    expect(size).toBeGreaterThan(1500)
    const pos = { file, size: size - 10, mtimeMs: 1, offset: 1000, anchor: 'abcd', anchorLen: 100 }
    const { deps, c } = makeDeps()
    const got = await delta.readSessionDelta(p.cwd, 'claude', { count: 0, hash: '', pos }, deps)
    expect(c.opens).toBe(1) // the full read only: the incremental attempt gave up before opening anything
    expect(c.bytes).toBe(size)
    expect(rt(got!.fresh)).toEqual(rt(await legacyTurns(p.cwd, [file])))
  })

  it.each([
    ['spaces', '   '],
    ['a lone carriage return', '\r'],
  ])('a tail of only %s is consumed (it holds no turn), and the line it precedes is taken whole later', async (_name, tail) => {
    const { p, file } = await sessionFile(lines(userLine('first'), assistantLine('second')) + tail)
    const { deps } = makeDeps()
    const a = await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)
    expect(a!.cursor.pos!.offset).toBe(fs.statSync(file).size)
    fs.appendFileSync(file, '\n' + lines(userLine('third')))
    const b = await delta.readSessionDelta(p.cwd, 'claude', a!.cursor, deps)
    expect(texts(b!.fresh)).toEqual(['third'])
    const want = mneme.sessionDelta(await legacyTurns(p.cwd, [file]), a!.cursor)
    expect(b!.cursor.hash).toBe(want.cursor.hash)
  })

  it('a handle that cannot be closed does not cost the answer (full read and incremental read alike)', async () => {
    const { p, file } = await sessionFile(lines(userLine('first'), assistantLine('second')))
    const w = wrapped({ close: 'throws' })
    const { deps } = makeDeps({ fs: w.fs })
    const a = await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)
    expect(texts(a!.fresh)).toEqual(['first', 'second'])
    fs.appendFileSync(file, lines(userLine('third')))
    const b = await delta.readSessionDelta(p.cwd, 'claude', a!.cursor, deps)
    expect(texts(b!.fresh)).toEqual(['third'])
    expect(w.closed()).toBe(2)
  })

  it('the cursor.pos of a different CANDIDATE is not mistaken for this file: it is read in full', async () => {
    const p = newProject()
    const other = write(p.dir, 'other', lines(userLine('somewhere else')), 5)
    const mine = write(p.dir, 'mine', lines(userLine('here'), assistantLine('there')), 50)
    touchDir(p)
    const { deps, c } = makeDeps()
    const pos = { file: other, size: fs.statSync(other).size, mtimeMs: fs.statSync(other).mtimeMs }
    const got = await delta.readSessionDelta(p.cwd, 'claude', { count: 0, hash: '', pos }, deps)
    expect(texts(got!.fresh)).toEqual(['here', 'there'])
    expect(c.bytes).toBe(fs.statSync(mine).size)
  })
})

describe('what is remembered is bounded', () => {
  it(`remembers at most ${'DELEGATED_MAX'} delegated sessions, forgetting the one judged longest ago`, async () => {
    const p = newProject()
    const count = delta.DELEGATED_MAX + 3
    const files = Array.from({ length: count }, (_, i) => write(p.dir, `job-${i}`, lines(userLine(delegated(`job ${i}`)), assistantLine('done')), 10 + i))
    const { deps, c } = makeDeps()
    const only = (file: string): Partial<DeltaDeps> => ({ listFiles: async () => [file] })
    for (const f of files) await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, { ...deps, ...only(f) })
    expect(c.opens).toBe(count)

    const before = c.opens
    await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, { ...deps, ...only(files[count - 1]) })
    expect(c.opens).toBe(before) // the latest is still remembered: a stat, no open
    await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, { ...deps, ...only(files[0]) })
    expect(c.opens).toBe(before + 1) // the first was forgotten: judged again
  })

  it('looks at a delegated session again when it has changed since it was judged', async () => {
    const p = newProject()
    const file = write(p.dir, 'job', lines(userLine(delegated()), assistantLine('reviewed')), 10)
    const { deps, c } = makeDeps()
    await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)
    const judged = c.opens
    fs.appendFileSync(file, lines(assistantLine('still going')))
    await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)
    expect(c.opens).toBe(judged + 1)
  })
})

describe('the production deps', () => {
  it('list, stat, open and read, parse, clock and yield all work on real files', async () => {
    const d = delta.defaultDeltaDeps()
    const p = newProject()
    const file = write(p.dir, 's1', lines(userLine('x'), assistantLine('y')))
    expect(await d.listFiles(p.cwd, 'claude')).toEqual([file])
    expect((await d.fs.stat(file)).size).toBe(fs.statSync(file).size)
    const fh = await d.fs.open(file)
    const buf = Buffer.alloc(4)
    expect((await fh.read(buf, 0, 4, 0)).bytesRead).toBe(4)
    expect((await fh.stat()).size).toBe(fs.statSync(file).size)
    await fh.close()
    const content = await d.fs.readFile(file)
    expect(d.parse('claude', content).map((t) => t.text)).toEqual(['x', 'y'])
    expect(d.now()).toBeGreaterThan(0)
    await expect(d.yieldToLoop()).resolves.toBeUndefined()
    expect(d.chunkBytes).toBe(delta.CHUNK_BYTES)
  })

  it('looks at as many sessions as the whole-transcript reader does', () => {
    expect(delta.CANDIDATES).toBe(live.MAX_SESSION_CANDIDATES)
  })
})

describe('Codex and Gemini: gated by size and mtime, read whole when they change (as before)', () => {
  const codexLine = (role: 'user' | 'assistant', text: string): string =>
    JSON.stringify({ timestamp: '2026-11-03T10:00:00.000Z', type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } })
  const codexMeta = JSON.stringify({ timestamp: '2026-11-03T10:00:00.000Z', type: 'session_meta', payload: { id: 'c1', cwd: '/r' } })

  it('Codex: an unchanged rollout is not read again; a grown one is read whole and diffed as the whole-file reader does', async () => {
    const dir = fs.mkdtempSync(path.join(work, 'codex-'))
    const file = path.join(dir, 'rollout-1.jsonl')
    fs.writeFileSync(file, lines(codexMeta, codexLine('user', PREAMBLE), codexLine('user', 'Fix the build'), codexLine('assistant', 'on it')))
    const { deps, c } = makeDeps({ listFiles: async () => [file] })

    const first = await delta.readSessionDelta('/r', 'codex', mneme.EMPTY_CURSOR, deps)
    expect(texts(first!.fresh)).toEqual(['Fix the build', 'on it']) // the synthetic first preamble is dropped by the parser
    expect(c.readFiles).toBe(1)
    expect(first!.cursor.pos).toMatchObject({ file })
    expect(first!.cursor.pos!.offset).toBeUndefined() // a Codex rollout is never carried on from a byte

    await delta.readSessionDelta('/r', 'codex', first!.cursor, deps)
    expect(c.readFiles).toBe(1) // unchanged: not read

    fs.appendFileSync(file, lines(codexLine('user', 'and the tests'), codexLine('assistant', 'done, tests pass')))
    const second = await delta.readSessionDelta('/r', 'codex', first!.cursor, deps)
    expect(c.readFiles).toBe(2)
    expect(texts(second!.fresh)).toEqual(['and the tests', 'done, tests pass'])

    const whole = await legacyTurns('/r', [file], 'codex')
    const o = mneme.sessionDelta(whole, mneme.sessionDelta(whole.slice(0, 2), mneme.EMPTY_CURSOR).cursor)
    expect(second!.cursor.hash).toBe(o.cursor.hash)
  })

  it('Codex: a rollout another computer started is passed over, and not read again while it is unchanged', async () => {
    const dir = fs.mkdtempSync(path.join(work, 'codex-job-'))
    const file = path.join(dir, 'rollout-job.jsonl')
    fs.writeFileSync(file, lines(codexMeta, codexLine('user', PREAMBLE), codexLine('user', delegated()), codexLine('assistant', 'reviewed it')))
    const { deps, c } = makeDeps({ listFiles: async () => [file] })
    const prev: Cursor = { count: 3, hash: 'abc' }
    const first = await delta.readSessionDelta('/r', 'codex', prev, deps)
    expect(first).toEqual(mneme.sessionDelta([], prev)) // no transcript of its own: as the whole-transcript reader says
    expect(c.readFiles).toBe(1)
    await delta.readSessionDelta('/r', 'codex', prev, deps)
    expect(c.readFiles).toBe(1) // unchanged and known to be delegated: a stat
  })

  it('Gemini: the same, for its single JSON document', async () => {
    const dir = fs.mkdtempSync(path.join(work, 'gemini-'))
    const file = path.join(dir, 'session-1.json')
    const doc = (n: number): string =>
      JSON.stringify({ sessionId: 'g1', messages: [{ type: 'user', content: 'hi' }, { type: 'gemini', content: 'hello' }, ...(n > 2 ? [{ type: 'user', content: 'again' }] : [])] })
    fs.writeFileSync(file, doc(2))
    const { deps, c } = makeDeps({ listFiles: async () => [file] })
    const first = await delta.readSessionDelta('/r', 'gemini', mneme.EMPTY_CURSOR, deps)
    expect(texts(first!.fresh)).toEqual(['hi', 'hello'])
    await delta.readSessionDelta('/r', 'gemini', first!.cursor, deps)
    expect(c.readFiles).toBe(1)
    fs.writeFileSync(file, doc(3))
    const second = await delta.readSessionDelta('/r', 'gemini', first!.cursor, deps)
    expect(c.readFiles).toBe(2)
    expect(texts(second!.fresh)).toEqual(['again'])
  })

  it('finds the newest rollout and chat through the real discovery under the home folder', async () => {
    fs.mkdirSync(path.join(home, '.codex', 'sessions', '2026', '11', '03'), { recursive: true })
    fs.writeFileSync(path.join(home, '.codex', 'sessions', '2026', '11', '03', 'rollout-x.jsonl'), lines(codexMeta, codexLine('user', 'from the real discovery')))
    fs.mkdirSync(path.join(home, '.gemini', 'tmp', 'proj', 'chats'), { recursive: true })
    fs.writeFileSync(path.join(home, '.gemini', 'tmp', 'proj', 'chats', 'session-1.json'), JSON.stringify({ sessionId: 'g', messages: [{ type: 'user', content: 'gemini says hi' }] }))
    const codex = await delta.readSessionDelta('/r', 'codex', mneme.EMPTY_CURSOR)
    expect(texts(codex!.fresh)).toEqual(['from the real discovery'])
    const gemini = await delta.readSessionDelta('/r', 'gemini', mneme.EMPTY_CURSOR)
    expect(texts(gemini!.fresh)).toEqual(['gemini says hi'])
  })
})

describe('the hot path makes no synchronous fs call', () => {
  it('cold, unchanged and grown passes, through the production wiring', async () => {
    const p = newProject()
    const file = write(p.dir, 's1', lines(userLine('Fix the build'), assistantLine('on it')))
    // warm: first imports and lazy module state must not be counted
    await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR)
    list.resetSessionListCache()
    delta.resetDeltaState()

    counter = countSyncFs([home, work])
    const first = await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR)
    const same = await delta.readSessionDelta(p.cwd, 'claude', first!.cursor)
    fs.appendFileSync(file, lines(userLine('and the tests')))
    const grew = await delta.readSessionDelta(p.cwd, 'claude', same!.cursor)
    const made = { ...counter.counts }
    counter.restore()
    counter = null

    expect(texts(first!.fresh)).toEqual(['Fix the build', 'on it'])
    expect(grew!.fresh).toHaveLength(1)
    expect(made).toEqual({})
  })

  it('CONTROL: the whole-transcript path it replaces makes sync calls on every pass (the listing: a readdir and a stat per file)', async () => {
    const p = newProject()
    for (let i = 0; i < 10; i++) write(p.dir, `old-${i}`, lines(userLine(`old ${i}`)), i)
    write(p.dir, 'live', lines(userLine('Fix the build')), 50)
    touchDir(p)

    counter = countSyncFs([home, work])
    await live.readSessionTranscript(p.cwd, 'claude')
    await live.readSessionTranscript(p.cwd, 'claude')
    const c = { ...counter.counts }
    counter.restore()
    counter = null
    expect(c.readdirSync).toBe(2)
    expect(c.statSync).toBeGreaterThanOrEqual(2 * 12)
  })
})

describe('the counters it records (numbers only, never content)', () => {
  it('records one reflect-read line per pass with what it opened, read and skipped', async () => {
    const p = newProject()
    const file = write(p.dir, 's1', lines(userLine('Fix the build'), assistantLine('on it')))
    const { deps } = makeDeps()
    const first = await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)
    await delta.readSessionDelta(p.cwd, 'claude', first!.cursor, deps)
    fs.appendFileSync(file, lines(userLine('more')))
    await delta.readSessionDelta(p.cwd, 'claude', first!.cursor, deps)

    const snap = passes.snapshotPasses()
    const k = snap.kinds['reflect-read']
    expect(k.n).toBe(3)
    expect(k.sum.full).toBe(1)
    expect(k.sum.unchanged).toBe(1)
    expect(k.sum.incremental).toBe(1)
    expect(k.sum.opens).toBe(2)
    expect(snap.recent[1].f.opens).toBe(0) // the unchanged pass opened nothing
    const json = JSON.stringify(snap)
    expect(json).not.toContain(path.basename(work))
    expect(json).not.toContain('Fix the build')
  })

  it('records the pass even when it gives up (null)', async () => {
    const p = newProject()
    write(p.dir, 's1', lines(userLine('x')))
    const { deps } = makeDeps({ listFiles: async () => { throw new Error('boom') } })
    expect(await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)).toBeNull()
    expect(passes.snapshotPasses().kinds['reflect-read'].n).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------------
// The equivalence. Random transcripts, random appends (whole lines, half lines cut at ANY byte, a last
// line with no newline, garbage, CRLF), touches, no-ops, truncations and rewrites. After every step the
// delta reader (cursor carried from its own previous answer) must say exactly what the old path says
// (the whole file read, parsed, filtered and diffed against ITS cursor): same fresh turns, same count,
// same hash. And a no-op step must open nothing.
// ---------------------------------------------------------------------------------------------------

describe('equivalence with reading the whole transcript', () => {
  const randomLine = (rng: () => number): string => {
    const text = TEXTS[Math.floor(rng() * TEXTS.length)]
    const r = rng()
    if (r < 0.3) return userLine(text)
    if (r < 0.55) return assistantLine(text)
    if (r < 0.62) return userBlocksLine(text)
    if (r < 0.7) return toolCallLine()
    if (r < 0.78) return toolResultLine()
    if (r < 0.82) return metaLine()
    if (r < 0.86) return noiseLine()
    if (r < 0.9) return summaryLine()
    if (r < 0.93) return BROKEN_LINE
    // The prompts that decide whether a session is another computer's, or carries a primer, can arrive at
    // any later step (after a bare preamble, say): they must change nothing once the opening is settled
    // and everything while it is not.
    if (r < 0.95) return userLine(delegated(text))
    if (r < 0.97) return userLine(primed(text))
    if (r < 0.98) return userLine(PREAMBLE)
    return assistantLine(text + ' ' + text)
  }

  const OPENINGS: Array<(rng: () => number) => string[]> = [
    () => [userLine('Fix the failing build please'), assistantLine('looking at it')],
    () => [userLine(primed('List the open TODOs.')), assistantLine('Two TODOs.')],
    () => [userLine(primed('')), assistantLine('Nothing was asked, the primer was all there was.')],
    () => [assistantLine('Resuming where we left off.'), userLine('thanks, carry on')],
    () => [userLine(PREAMBLE)], // unsettled: the prompt arrives on a later step
    () => [userLine(delegated()), assistantLine('reviewed it')],
    () => [userLine(PREAMBLE), userLine(delegated('Do the thing.')), assistantLine('done')],
    () => [],
  ]

  async function run(seed: number): Promise<void> {
    const rng = mulberry32(seed)
    const p = newProject()
    list.resetSessionListCache()
    const file = path.join(p.dir, 'session.jsonl')
    // opening, chunk size and line ending vary independently: seeds 0..31 pair every opening with every
    // chunk size, and 32..63 do it again with CRLF line ends
    const chunk = [48, 128, 1000, 100_000][Math.floor(seed / OPENINGS.length) % 4]
    const eol = Math.floor(seed / 32) % 2 === 1 ? '\r\n' : '\n'
    const opening = OPENINGS[seed % OPENINGS.length](rng)
    fs.writeFileSync(file, Buffer.from(opening.map((l) => l + eol).join(''), 'utf8'))
    fs.utimesSync(file, at(10), at(10))

    const { deps, c } = makeDeps({}, chunk)
    let mine: Cursor = mneme.EMPTY_CURSOR
    let theirs: Cursor = mneme.EMPTY_CURSOR
    let pending: Buffer | null = null
    let needNewline = false
    let clock = 10

    const bump = (): void => {
      clock += 10
      fs.utimesSync(file, at(clock), at(clock))
    }
    const prefix = (): string => {
      const s = needNewline ? '\n' : ''
      needNewline = false
      return s
    }

    for (let step = 0; step < 10; step++) {
      const r = rng()
      let kind: string
      if (pending) kind = r < 0.7 ? 'complete' : r < 0.85 ? 'noop' : 'touch'
      else if (r < 0.32) kind = 'lines'
      else if (r < 0.44) kind = 'partial'
      else if (r < 0.52) kind = 'nonewline'
      else if (r < 0.58) kind = 'broken'
      else if (r < 0.66) kind = 'touch'
      else if (r < 0.8) kind = 'noop'
      else if (r < 0.9) kind = 'truncate'
      else kind = 'rewrite'

      if (kind === 'lines') {
        const n = 1 + Math.floor(rng() * 4)
        fs.appendFileSync(file, Buffer.from(prefix() + Array.from({ length: n }, () => randomLine(rng) + eol).join(''), 'utf8'))
        bump()
      } else if (kind === 'partial') {
        const whole = Buffer.from(prefix() + randomLine(rng) + eol, 'utf8')
        const cut = 1 + Math.floor(rng() * (whole.length - 1))
        fs.appendFileSync(file, whole.subarray(0, cut))
        pending = Buffer.from(whole.subarray(cut))
        bump()
      } else if (kind === 'complete') {
        fs.appendFileSync(file, pending!)
        pending = null
        bump()
      } else if (kind === 'nonewline') {
        fs.appendFileSync(file, Buffer.from(prefix() + (rng() < 0.5 ? userLine(TEXTS[Math.floor(rng() * TEXTS.length)]) : assistantLine('tail without newline')), 'utf8'))
        needNewline = true
        bump()
      } else if (kind === 'broken') {
        fs.appendFileSync(file, Buffer.from(prefix() + BROKEN_LINE + eol, 'utf8'))
        bump()
      } else if (kind === 'touch') {
        bump()
      } else if (kind === 'truncate') {
        const buf = fs.readFileSync(file)
        const nls: number[] = []
        buf.forEach((b, i) => { if (b === 0x0a) nls.push(i) })
        if (nls.length > 1) {
          const keep = nls[Math.floor(rng() * (nls.length - 1))] + 1
          fs.writeFileSync(file, buf.subarray(0, keep))
          pending = null
          needNewline = false
          bump()
        }
      } else if (kind === 'rewrite') {
        const fresh = Array.from({ length: 2 + Math.floor(rng() * 6) }, () => randomLine(rng) + eol).join('')
        fs.writeFileSync(file, Buffer.from(userLine(`rewritten ${seed} ${step}`) + eol + fresh, 'utf8'))
        pending = null
        needNewline = false
        bump()
      }

      const opensBefore = c.opens
      const got = await delta.readSessionDelta(p.cwd, 'claude', mine, deps)
      const turns = await legacyTurns(p.cwd, [file])
      const want = mneme.sessionDelta(turns, theirs)

      const where = `seed ${seed} step ${step} (${kind}, chunk ${chunk})`
      expect(got, where).not.toBeNull()
      expect(rt(got!.fresh), where).toEqual(rt(want.fresh))
      expect(got!.cursor.count, where).toBe(want.cursor.count)
      expect(got!.cursor.hash, where).toBe(want.cursor.hash)
      if (got!.cursor.pos?.offset !== undefined) expect(got!.cursor.pos.offset, where).toBeLessThanOrEqual(fs.statSync(file).size)
      if (kind === 'noop' && step > 0) expect(c.opens, `${where}: a no-op must not open the file`).toBe(opensBefore)

      mine = got!.cursor
      theirs = want.cursor
    }
  }

  it('says exactly what the whole-file path says, over 64 random sessions of 10 steps', async () => {
    for (let seed = 0; seed < 64; seed++) await run(seed)
  }, 180_000)

  it('CONTROL: a deliberately WRONG reader (carry on from the old offset without checking the anchor, and hash only the new turns) is caught by the same comparison', async () => {
    const p = newProject()
    const file = write(p.dir, 's1', lines(userLine('first'), assistantLine('second')))
    const { deps } = makeDeps()
    const a = await delta.readSessionDelta(p.cwd, 'claude', mneme.EMPTY_CURSOR, deps)
    const sizeBefore = fs.statSync(file).size
    // a rewrite that is longer than the old file: a reader that trusted the old offset would read from the middle of it
    fs.writeFileSync(file, lines(userLine('totally'), assistantLine('different'), userLine('content here'), assistantLine('and more')))
    fs.utimesSync(file, at(77), at(77))
    expect(fs.statSync(file).size).toBeGreaterThan(sizeBefore)
    const fromOldOffset = fs.readFileSync(file).subarray(a!.cursor.pos!.offset!).toString('utf8')
    const naive = ingest.parseBySource('claude', fromOldOffset)
    const want = mneme.sessionDelta(await legacyTurns(p.cwd, [file]), a!.cursor)
    // the naive answer differs from the truth (it would have reflected a torn line and missed the turns before it)...
    expect(rt(naive.map((t) => ({ role: t.role, text: t.text })))).not.toEqual(rt(want.fresh))
    // ...and the real reader gives the truth
    const got = await delta.readSessionDelta(p.cwd, 'claude', a!.cursor, deps)
    expect(rt(got!.fresh)).toEqual(rt(want.fresh))
  })
})
