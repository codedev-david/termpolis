// @vitest-environment node
// The arms of the saved-notes pass that only run on a bad day: a manifest that cannot be saved at the worst
// moment, a filesystem that answers oddly, a manifest written by hand. Each is something a user would meet.
// The main behaviour is in claudeNotesIngest.test.ts; the real store in claudeNotesStore.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  DEFAULT_MAX_CHUNKS,
  fileManifest,
  findNotes,
  findProject,
  notesStatus,
  realNotesFs,
  removeImportedNotes,
  runClaudeNotesIngest,
  type NotesFs,
} from '../../src/main/claudeNotesIngest'
import {
  CWD, FEEDBACK, FOLDER, data, deps, fakeStore, flakyManifest, manifestFile, manifestJson, note, root, session,
  setupWorld, spyFs, teardownWorld,
} from './_claudeNotesHarness'

beforeEach(setupWorld)
afterEach(teardownWorld)

describe('a manifest that cannot be saved at the worst moment', () => {
  it('does not delete anything it could not write ahead (the first save fails)', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    fs.rmSync(path.join(root, FOLDER, 'memory', 'n.md'))
    const stats = await runClaudeNotesIngest(deps(store, { manifest: flakyManifest(0) }))
    expect(stats).toMatchObject({ manifestFailed: true, chunksDeleted: 0, filesRemoved: 0 })
    expect(store.rows.size).toBe(1) // the store was not touched without the manifest knowing
    expect(store.removed).toEqual([])
  })

  it('does not delete anything when only the write-ahead save fails', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    fs.rmSync(path.join(root, FOLDER, 'memory', 'n.md'))
    // The first save (the dirty flag) works; the second (the removal written ahead) does not.
    const stats = await runClaudeNotesIngest(deps(store, { manifest: flakyManifest(1) }))
    expect(stats.manifestFailed).toBe(true)
    expect(store.removed).toEqual([])
  })

  it('does not delete a changed note\'s old chunks when the write-ahead cannot be saved, and stops there', async () => {
    const p = note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    fs.writeFileSync(p, FEEDBACK.replace('on write', 'on every write'))
    fs.utimesSync(p, new Date(Date.UTC(2026, 8, 4)), new Date(Date.UTC(2026, 8, 4)))
    const stats = await runClaudeNotesIngest(deps(store, { manifest: flakyManifest(0) }))
    expect(stats).toMatchObject({ manifestFailed: true, chunksDeleted: 0, chunksWritten: 0 })
    expect(store.removed).toEqual([])
  })

  it('stops the pass at the next note when a checkpoint cannot be saved', async () => {
    for (let i = 0; i < 4; i++) note(FOLDER, `n${i}.md`, `---\nname: n${i}\n---\nNote ${i}.`)
    session(FOLDER, CWD)
    const store = fakeStore()
    // Saves: the dirty flag (1), then the checkpoint after the first note (2) fails.
    const stats = await runClaudeNotesIngest(deps(store, { manifest: flakyManifest(1) }), { checkpointEvery: 1 })
    expect(stats.manifestFailed).toBe(true)
    expect(stats.chunksWritten).toBe(1)
  })

  it('checkpoints after a note that was only touched, too', async () => {
    const p = note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    fs.utimesSync(p, new Date(Date.UTC(2026, 9, 1)), new Date(Date.UTC(2026, 9, 1)))
    const manifest = flakyManifest(Infinity)
    await runClaudeNotesIngest(deps(store, { manifest }), { checkpointEvery: 1 })
    expect(manifest.writes()).toBe(2) // the checkpoint, and the final save
  })

  it('reports everything as failed when "Remove imported notes" cannot save its manifest', async () => {
    note(FOLDER, 'a.md', '---\nname: a\n---\nAlpha.')
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    expect(await removeImportedNotes(deps(store, { manifest: flakyManifest(0) }))).toEqual({ removed: 0, failed: 1 })
    expect(store.rows.size).toBe(1)
  })

  it('does not retry a leftover removal when the manifest cannot be saved', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    const m = manifestJson()
    m.stale = ['m1']
    fs.writeFileSync(manifestFile(), JSON.stringify(m))
    const stats = await runClaudeNotesIngest(deps(store, { manifest: flakyManifest(0) }))
    expect(stats.manifestFailed).toBe(true)
    expect(store.removed).toEqual([])
  })

  it('leaves a gone note\'s chunks alone when the write-ahead for them cannot be saved', async () => {
    note(FOLDER, 'a.md', '---\nname: a\n---\nAlpha.')
    note(FOLDER, 'b.md', '---\nname: b\n---\nBeta.')
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    fs.rmSync(path.join(root, FOLDER, 'memory', 'a.md'))
    fs.rmSync(path.join(root, FOLDER, 'memory', 'b.md'))
    const stats = await runClaudeNotesIngest(deps(store, { manifest: flakyManifest(1) }))
    expect(stats.filesRemoved).toBe(0)
    expect(store.rows.size).toBe(2)
  })
})

describe('a pass that finds things in an odd state', () => {
  it('remembers within a pass that a folder has no project, instead of looking for each of its notes', async () => {
    note(FOLDER, 'a.md', '---\nname: a\n---\nAlpha.')
    note(FOLDER, 'b.md', '---\nname: b\n---\nBeta.')
    note(FOLDER, 'c.md', '---\nname: c\n---\nGamma.')
    const listed: string[] = []
    const counting: NotesFs = { ...realNotesFs, list: async (d) => { listed.push(d); return realNotesFs.list(d) } }
    const stats = await runClaudeNotesIngest(deps(fakeStore(), { fs: counting }))
    expect(stats.noProject).toBe(3)
    expect(listed.filter((d) => d === path.join(root, FOLDER))).toHaveLength(1) // the sessions were listed once
  })

  it('uses the event loop as its pause between writes when none is given', async () => {
    note(FOLDER, 'a.md', '---\nname: a\n---\nAlpha.')
    session(FOLDER, CWD)
    const noPause = deps(fakeStore())
    delete noPause.yield
    expect(await runClaudeNotesIngest(noPause)).toMatchObject({ chunksWritten: 1 })
  })

  it('reads a manifest that is valid but bare: no stale list, no folders remembered, no last run', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    fs.writeFileSync(manifestFile(), JSON.stringify({ version: 1, salt: 'abc', epoch: 3, files: {} }))
    const stats = await runClaudeNotesIngest(deps(fakeStore()))
    expect(stats.chunksWritten).toBe(1)
    expect(manifestJson()).toMatchObject({ salt: 'abc', epoch: 3, stale: [], cwds: { [FOLDER]: CWD } })
  })

  it('keeps only usable folder-to-project entries, and a half-recorded last run counts as none', async () => {
    fs.writeFileSync(manifestFile(), JSON.stringify({
      version: 1, salt: 'abc', epoch: 0, files: {}, stale: [],
      cwds: { good: 'C:\\good', empty: '', number: 5 },
      last: { at: 1, filesSeen: 'many' },
    }))
    expect(notesStatus(fileManifest(data)).lastAt).toBeNull()
    await runClaudeNotesIngest(deps(fakeStore()))
    expect(manifestJson().cwds).toEqual({ good: 'C:\\good' })
  })

  it('rounds a fractional epoch down', async () => {
    fs.writeFileSync(manifestFile(), JSON.stringify({ version: 1, salt: 'abc', epoch: 2.9, files: {} }))
    await runClaudeNotesIngest(deps(fakeStore()))
    expect(manifestJson().epoch).toBe(2)
  })

  it('keeps the stale ids that are real strings and drops the rest', () => {
    fs.writeFileSync(manifestFile(), JSON.stringify({ version: 1, salt: 'abc', epoch: 0, files: {}, stale: ['a', '', 7, null, 'b'] }))
    expect(notesStatus(fileManifest(data)).pending).toBe(2)
  })

  it('remembers a note with nothing to store as read, without counting it as imported', async () => {
    note(FOLDER, 'real.md', '---\nname: real\n---\nSomething real.')
    note(FOLDER, 'blank.md', '---\nname: nothing\ntype: user\n---\n')
    session(FOLDER, CWD)
    await runClaudeNotesIngest(deps(fakeStore()))
    expect(notesStatus(fileManifest(data))).toMatchObject({ notes: 1, chunks: 1, projects: 1 })
    expect(Object.keys(manifestJson().files)).toHaveLength(2)
  })

  it('ignores a listed row that is not a note, or has no time, when removing imported notes', async () => {
    note(FOLDER, 'a.md', '---\nname: a\n---\nAlpha.')
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    store.rows.set('not-a-note', { id: 'not-a-note', ts: 1, agentId: 'claude-notes', source: 'other', content: 'x' } as never)
    store.rows.set('no-time', { id: 'no-time', agentId: 'claude-notes', source: 'claude-notes', content: 'x' } as never)
    const res = await removeImportedNotes(deps(store))
    expect(res).toEqual({ removed: 1, failed: 0 })
    expect(store.rows.has('not-a-note')).toBe(true)
  })
})

// The numbers a pass runs by when nobody overrides them. Each is a promise to the machine it runs on (how much one pass stores,
// how often the record is saved, what counts as a binary file), so each is held to its value here, not only to being "some number".
describe('the defaults a pass runs by', () => {
  const many = (n: number): void => {
    for (let i = 0; i < n; i++) note(FOLDER, `n${String(i).padStart(3, '0')}.md`, `---\nname: note ${i}\n---\nBody of note ${i}.`)
    session(FOLDER, CWD)
  }

  it('stores at most 300 chunks in one pass and leaves the rest for the next', async () => {
    expect(DEFAULT_MAX_CHUNKS).toBe(300)
    many(303)
    const store = fakeStore()
    const first = await runClaudeNotesIngest(deps(store))
    expect(first).toMatchObject({ chunksWritten: 300, truncated: true })
    const second = await runClaudeNotesIngest(deps(store))
    expect(second).toMatchObject({ chunksWritten: 3, truncated: false })
    expect(store.rows.size).toBe(303)
  })

  it('saves its record after every 20 notes, and not after every 21st', async () => {
    const savesFor = async (n: number): Promise<number> => {
      teardownWorld(); setupWorld(); many(n)
      const manifest = flakyManifest(Infinity)
      await runClaudeNotesIngest(deps(fakeStore(), { manifest }))
      return manifest.writes()
    }
    const base = await savesFor(19)
    expect(await savesFor(20)).toBe(base + 1) // the 20th note triggers a save of its own
    expect(await savesFor(39)).toBe(base + 1)
    expect(await savesFor(40)).toBe(base + 2)
  })

  it('judges a file binary by a zero byte in its first 8 KB, and not further in', async () => {
    const withNulAt = (at: number): string => {
      const text = '---\nname: n\n---\n' + 'x'.repeat(at - 16) + '\0' + 'y'.repeat(100)
      return text
    }
    note(FOLDER, 'early.md', withNulAt(5000)) // inside the first 8 KB: binary
    note(FOLDER, 'edge.md', withNulAt(8191)) // the last byte of the first 8 KB (offset 8191): binary
    note(FOLDER, 'late.md', withNulAt(8192)) // the first byte past it: read as text
    session(FOLDER, CWD)
    const stats = await runClaudeNotesIngest(deps(fakeStore()))
    expect(stats.binary).toBe(2)
    expect(notesStatus(fileManifest(data)).notes).toBe(1)
  })
})

describe('findProject', () => {
  it('is null for a folder it cannot list', async () => {
    expect(await findProject(spyFs(), FOLDER, path.join(root, FOLDER))).toBeNull()
  })

  it('skips a session it cannot stat or read, and stops looking at the cap', async () => {
    const dir = path.join(root, FOLDER)
    const line = Buffer.from(`${JSON.stringify({ cwd: CWD })}\n`)
    const f = spyFs({
      dirs: { [dir]: [{ name: 'gone.jsonl', kind: 'file' }, { name: 'a.jsonl', kind: 'file' }, { name: 'b.jsonl', kind: 'file' }, { name: 'notes.txt', kind: 'file' }, { name: 'sub', kind: 'dir' }] },
      stats: { [path.join(dir, 'a.jsonl')]: { size: 1, mtimeMs: 5 }, [path.join(dir, 'b.jsonl')]: { size: 1, mtimeMs: 9 } },
      reads: { [path.join(dir, 'a.jsonl')]: line, [path.join(dir, 'b.jsonl')]: Buffer.from('nothing here') },
    })
    expect(await findProject(f, FOLDER, dir)).toBe(CWD) // b is newer but says nothing; a answers
    const capped = spyFs({
      dirs: { [dir]: [{ name: 'a.jsonl', kind: 'file' }, { name: 'b.jsonl', kind: 'file' }] },
      stats: { [path.join(dir, 'a.jsonl')]: { size: 1, mtimeMs: 5 }, [path.join(dir, 'b.jsonl')]: { size: 1, mtimeMs: 9 } },
      reads: { [path.join(dir, 'a.jsonl')]: Buffer.from('nothing here'), [path.join(dir, 'b.jsonl')]: line },
    })
    expect(await findProject(capped, FOLDER, dir, { maxStat: 1 })).toBeNull() // only the first was looked at, and it is silent
    expect(capped.calls.stat).toHaveLength(1)
  })

  // PRIVACY.md and DOCUMENTATION.md: "the first 256 KB of that folder's three newest session files", and nothing else of a session.
  describe('what it reads of a folder\'s sessions', () => {
    const dir = (): string => path.join(root, FOLDER)
    const silent = Buffer.from('{"type":"summary"}\n')
    const says = Buffer.from(`${JSON.stringify({ cwd: CWD })}\n`)
    /** Sessions newest first: `names[0]` is the newest. A session's content comes from `content`. */
    const sessions = (names: string[], content: Record<string, Buffer>) => {
      const reads: Array<{ file: string; max: number }> = []
      const base = spyFs({
        dirs: { [dir()]: names.map((name) => ({ name, kind: 'file' as const })) },
        stats: Object.fromEntries(names.map((name, i) => [path.join(dir(), name), { size: 1, mtimeMs: 1000 - i }])),
        reads: Object.fromEntries(Object.entries(content).map(([name, buf]) => [path.join(dir(), name), buf])),
      })
      const f: NotesFs & { reads: typeof reads } = { ...base, reads, read: async (file, max) => { reads.push({ file: path.basename(file), max }); return base.read(file, max) } }
      return f
    }

    it('looks at the three newest and no more: a project only the fourth newest names is not found', async () => {
      const f = sessions(['s1.jsonl', 's2.jsonl', 's3.jsonl', 's4.jsonl'], { 's1.jsonl': silent, 's2.jsonl': silent, 's3.jsonl': silent, 's4.jsonl': says })
      expect(await findProject(f, FOLDER, dir())).toBeNull()
      expect(f.reads.map((r) => r.file)).toEqual(['s1.jsonl', 's2.jsonl', 's3.jsonl'])
    })

    it('finds it in the third newest', async () => {
      const f = sessions(['s1.jsonl', 's2.jsonl', 's3.jsonl', 's4.jsonl'], { 's1.jsonl': silent, 's2.jsonl': silent, 's3.jsonl': says, 's4.jsonl': silent })
      expect(await findProject(f, FOLDER, dir())).toBe(CWD)
      expect(f.reads.map((r) => r.file)).toEqual(['s1.jsonl', 's2.jsonl', 's3.jsonl'])
    })

    it('stops at the first that answers, and reads at most the first 256 KB of a session', async () => {
      const f = sessions(['s1.jsonl', 's2.jsonl', 's3.jsonl'], { 's1.jsonl': says, 's2.jsonl': says, 's3.jsonl': says })
      expect(await findProject(f, FOLDER, dir())).toBe(CWD)
      expect(f.reads).toEqual([{ file: 's1.jsonl', max: 256 * 1024 }])
    })

    it('looks at the times of up to 5,000 of a folder\'s sessions to find the newest, and no more', async () => {
      const names = Array.from({ length: 5003 }, (_, i) => `s${i}.jsonl`)
      const f = sessions(names, {})
      await findProject(f, FOLDER, dir())
      expect(f.calls.stat).toHaveLength(5000)
    })
  })
})

describe('a root that lists as nothing', () => {
  it('is not counted as read when its folders cannot be listed', async () => {
    const f = spyFs({ reals: { [root]: root } }) // real() answers; list() says null
    expect((await findNotes([root], f)).rootsRead).toBe(0)
  })
})

describe('realNotesFs against a filesystem that answers oddly', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('calls anything that is neither a file, a folder nor a link "other"', async () => {
    vi.spyOn(fs.promises, 'readdir').mockResolvedValueOnce([
      { name: 'pipe', isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false },
    ] as never)
    expect(await realNotesFs.list(root)).toEqual([{ name: 'pipe', kind: 'other' }])
  })

  it('still returns what it read when the handle will not close', async () => {
    const read = vi.fn(async (buf: Buffer) => { buf.write('hello'); return { bytesRead: 5 } })
    vi.spyOn(fs.promises, 'open').mockResolvedValueOnce({ read, close: vi.fn(async () => { throw new Error('EBADF') }) } as never)
    expect((await realNotesFs.read(path.join(root, 'x'), 10))?.toString()).toBe('hello')
  })
})
