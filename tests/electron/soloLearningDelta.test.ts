import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseBySource } from '../../src/main/conversationIngest'
import { readSessionTranscript } from '../../src/main/liveTranscript'
import { reflectSoloSession, sessionDelta, EMPTY_CURSOR, type SessionCursor, type SoloReflexDeps } from '../../src/main/mnemeSession'
import { readSessionDelta, defaultDeltaDeps, resetDeltaState, type DeltaDeps } from '../../src/main/transcriptDelta'
import { onSessionEpisode } from '../../src/main/mnemeReflex'
import { distillEpisode } from '../../src/main/mnemeReflect'

// What matters about the delta reader is not the turns it returns but what the learning loop WRITES because
// of them. This drives the REAL main-side pipeline (parse, session delta, episode, deterministic distillation,
// lesson writes, competence) twice over the same on-disk transcript, once through the whole-transcript reader
// the app used to call on every pass and once through the delta reader, and requires everything that reaches
// memory (the lessons written, the competence recorded, the results, the cursor's count and hash) to be
// IDENTICAL after every step. Same shape as soloLearningIntegration.test.ts, which keeps pinning the old path.

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-delta-'))
})
afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

const STAMP = '2026-11-03T10:00:00.000Z'
const user = (text: string): string => JSON.stringify({ type: 'user', timestamp: STAMP, sessionId: 's1', cwd: '/repo/acme', message: { role: 'user', content: text } })
const assistant = (text: string): string =>
  JSON.stringify({ type: 'assistant', timestamp: STAMP, sessionId: 's1', message: { role: 'assistant', content: [{ type: 'text', text }] } })

/** An error and its fix: the shape the deterministic distiller turns into a lesson. */
const problem = (name: string): string => user(`the build fails with Error: cannot find module ${name}`)
const fix = (name: string): string => assistant(`Fixed it, the ${name} package was missing from package.json. I added it and the build passes now.`)

let seq = 0
function newFile(initial: string): string {
  const file = path.join(dir, `session-${seq++}.jsonl`)
  fs.writeFileSync(file, initial)
  return file
}

interface Counts {
  opens: number
  bytes: number
}

type ReadDelta = NonNullable<SoloReflexDeps['readDelta']>

function pipeline(file: string, withDelta: boolean, startCursor?: SessionCursor, readDeltaOverride?: ReadDelta) {
  const cursors = new Map<string, SessionCursor>()
  if (startCursor) cursors.set('t-int', startCursor)
  const written: unknown[] = []
  const competence: Array<{ domain: string; success: boolean }> = []
  const counts: Counts = { opens: 0, bytes: 0 }
  const base = defaultDeltaDeps()
  const deltaDeps: DeltaDeps = {
    ...base,
    listFiles: async () => [file],
    fs: {
      ...base.fs,
      open: async (f) => {
        counts.opens++
        const fh = await base.fs.open(f)
        return {
          stat: () => fh.stat(),
          read: async (buf, off, len, pos) => {
            const r = await fh.read(buf, off, len, pos)
            counts.bytes += r.bytesRead
            return r
          },
          close: () => fh.close(),
        }
      },
    },
  }
  const deps: SoloReflexDeps = {
    readTranscript: (cwd, agent) =>
      readSessionTranscript(cwd, agent, {
        findFiles: () => [file],
        readFile: (f) => fs.promises.readFile(f, 'utf8'),
        parse: (a, c) => parseBySource(a as never, c),
      }),
    ...(withDelta ? { readDelta: readDeltaOverride ?? ((cwd: string, agent: string, prev: SessionCursor) => readSessionDelta(cwd, agent, prev, deltaDeps)) } : {}),
    getCursor: (id) => cursors.get(id),
    setCursor: (id, c) => {
      cursors.set(id, c)
    },
    reflect: (episode) =>
      onSessionEpisode(episode, {
        distill: (ep) => distillEpisode(ep),
        write: async (input) => {
          written.push(input)
          return { id: `mem-${written.length}` } as never
        },
        recordOutcome: (domain, success) => {
          competence.push({ domain, success })
        },
        now: 1000,
      }),
  }
  return {
    pass: () => reflectSoloSession({ terminalId: 't-int', cwd: '/repo/acme', agent: 'claude', project: 'acme' }, deps),
    cursors,
    written,
    competence,
    counts,
  }
}

type Pipeline = ReturnType<typeof pipeline>

/** Run one pass through both and require that everything that reaches memory is the same. */
async function bothPass(legacy: Pipeline, delta: Pipeline, where: string) {
  const a = await legacy.pass()
  const b = await delta.pass()
  expect(b, `${where}: result`).toEqual(a)
  expect(delta.written, `${where}: lessons written`).toEqual(legacy.written)
  expect(delta.competence, `${where}: competence`).toEqual(legacy.competence)
  const ca = legacy.cursors.get('t-int')
  const cb = delta.cursors.get('t-int')
  expect(cb?.count, `${where}: cursor count`).toBe(ca?.count)
  expect(cb?.hash, `${where}: cursor hash`).toBe(ca?.hash)
  return { a, b }
}

describe('the delta reader teaches the learning loop exactly what the whole-transcript reader did', () => {
  it('the fixture is meaningful: the old path distils a lesson from an error and its fix', async () => {
    resetDeltaState()
    const file = newFile([problem('foo'), fix('foo')].join('\n') + '\n')
    const legacy = pipeline(file, false)
    const res = await legacy.pass()
    expect(res.fired).toBe(true)
    expect(res.lessons).toBeGreaterThan(0)
    expect(legacy.written.length).toBeGreaterThan(0)
    expect(legacy.competence).toEqual([{ domain: 'acme', success: true }])
  })

  it('pass after pass over a growing transcript: same lessons, same competence, same cursor', async () => {
    resetDeltaState()
    const file = newFile([problem('foo'), fix('foo')].join('\n') + '\n')
    const legacy = pipeline(file, false)
    const delta = pipeline(file, true)

    const first = await bothPass(legacy, delta, 'first look')
    expect(first.b.fired).toBe(true)
    expect(delta.written.length).toBeGreaterThan(0)
    const afterFirst = delta.written.length

    const again = await bothPass(legacy, delta, 'nothing new')
    expect(again.b).toEqual({ fired: false, lessons: 0 })
    expect(delta.written.length).toBe(afterFirst) // a quiet pass writes nothing

    fs.appendFileSync(file, [problem('bar'), fix('bar')].join('\n') + '\n')
    const grown = await bothPass(legacy, delta, 'a second error and its fix')
    expect(grown.b.fired).toBe(true)
    // NOT vacuous: the comparison above is between two lists that really did grow, with the new lesson in them
    expect(delta.written.length).toBeGreaterThan(afterFirst)
    expect(JSON.stringify(delta.written.slice(afterFirst))).toContain('bar')
    expect(JSON.stringify(delta.written.slice(afterFirst))).not.toContain('foo') // and only the NEW exchange was learned from

    // the half-written last line: the error is complete, its fix is still being written
    const late = fix('baz')
    fs.appendFileSync(file, problem('baz') + '\n' + late.slice(0, 40))
    await bothPass(legacy, delta, 'the fix is half written')
    fs.appendFileSync(file, late.slice(40) + '\n')
    await bothPass(legacy, delta, 'the fix is whole')

    // and a last line with no newline at all
    fs.appendFileSync(file, problem('qux') + '\n' + fix('qux'))
    await bothPass(legacy, delta, 'no trailing newline')
    fs.appendFileSync(file, '\n')
    await bothPass(legacy, delta, 'the newline arrives')

    // The whole conversation, then, cost the delta reader few reads: a stat per quiet pass, the new bytes plus
    // a 256-byte anchor per growth, and the whole file only once.
    expect(delta.counts.opens).toBeLessThanOrEqual(7)
    expect(delta.counts.bytes).toBeLessThan(2 * fs.statSync(file).size + 6 * 256)
  })

  it('CONTROL: the comparison catches a delta reader that forgot the cursor (it would learn the same turns again)', async () => {
    resetDeltaState()
    const file = newFile([problem('foo'), fix('foo')].join('\n') + '\n')
    const forgetful: ReadDelta = async (cwd, agent) => {
      const turns = await readSessionTranscript(cwd, agent, {
        findFiles: () => [file],
        readFile: (f) => fs.promises.readFile(f, 'utf8'),
        parse: (a, c) => parseBySource(a as never, c),
      })
      // a correct cursor, but every pass says everything is new (it never looked at where the last one stopped)
      return { fresh: turns, cursor: sessionDelta(turns, EMPTY_CURSOR).cursor }
    }
    const legacy = pipeline(file, false)
    const broken = pipeline(file, true, undefined, forgetful)
    await bothPass(legacy, broken, 'first look') // identical so far: nothing has been seen yet
    await expect(bothPass(legacy, broken, 'second look')).rejects.toThrow() // the lessons are written a second time
    expect(broken.written.length).toBeGreaterThan(legacy.written.length)
  })

  it('a restart: the cursor comes back from disk as JSON and the transcript is not opened or reflected again', async () => {
    resetDeltaState()
    const file = newFile([problem('foo'), fix('foo')].join('\n') + '\n')
    const before = pipeline(file, true)
    await before.pass()
    const stored = JSON.parse(JSON.stringify(before.cursors.get('t-int'))) as SessionCursor
    expect(stored.pos).toBeDefined()

    const after = pipeline(file, true, stored)
    const res = await after.pass()
    expect(res).toEqual({ fired: false, lessons: 0 })
    expect(after.written).toEqual([])
    expect(after.counts.opens).toBe(0)

    // and it carries on from there when the transcript grows
    const legacy = pipeline(file, false, { count: stored.count, hash: stored.hash })
    fs.appendFileSync(file, [problem('bar'), fix('bar')].join('\n') + '\n')
    const a = await legacy.pass()
    const b = await after.pass()
    expect(b).toEqual(a)
    expect(after.written).toEqual(legacy.written)
    expect(after.counts.opens).toBe(1)
  })

  it('UPGRADE: a cursor the old code stored (no byte position) continues without learning anything twice', async () => {
    resetDeltaState()
    const file = newFile([problem('foo'), fix('foo')].join('\n') + '\n')
    const old = pipeline(file, false)
    await old.pass()
    const oldCursor = old.cursors.get('t-int') as SessionCursor
    expect(oldCursor.pos).toBeUndefined()

    fs.appendFileSync(file, [problem('bar'), fix('bar')].join('\n') + '\n')
    const legacy = pipeline(file, false, oldCursor)
    const delta = pipeline(file, true, oldCursor)
    const { a, b } = await bothPass(legacy, delta, 'first pass after the upgrade')
    expect(b.fired).toBe(true)
    expect(a.lessons).toBeGreaterThan(0)
    // only the new exchange was written: one lesson set, not two
    expect(delta.written.length).toBe(legacy.written.length)
    expect(delta.cursors.get('t-int')!.pos).toBeDefined()
  })

  it('a session that was rewritten in place (compaction): the same relearning as before, no more and no less', async () => {
    resetDeltaState()
    const file = newFile([problem('foo'), fix('foo'), problem('bar'), fix('bar')].join('\n') + '\n')
    const legacy = pipeline(file, false)
    const delta = pipeline(file, true)
    await bothPass(legacy, delta, 'before the rewrite')

    // the transcript is replaced by a different, longer one
    fs.writeFileSync(file, [problem('alpha'), fix('alpha'), problem('beta'), fix('beta'), problem('gamma'), fix('gamma')].join('\n') + '\n')
    const later = new Date(Date.now() + 5000)
    fs.utimesSync(file, later, later)
    const res = await bothPass(legacy, delta, 'after the rewrite')
    expect(res.b.fired).toBe(true)
  })
})
