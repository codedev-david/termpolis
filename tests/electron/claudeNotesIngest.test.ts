// @vitest-environment node
// Bringing Claude Code's saved notes into memory: discovery on disk, the manifest, and every pass
// behaviour, against REAL temporary folders and a fake store. The tricky store semantics (a deleted
// memory's content hash stays dead, a restart, a killed pass) are in claudeNotesStore.test.ts, against the
// real store. Nothing here reads the real home folder: roots are always injected or point at a temp dir.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  MAX_NOTE_BYTES,
  MAX_NOTE_FILES,
  NOTES_MANIFEST_FILE,
  _resetNotesLockForTests,
  fileManifest,
  clearNotesRecord,
  finishQueuedRemovals,
  findNotes,
  noteRoots,
  notesStatus,
  realNotesFs,
  removeImportedNotes,
  runClaudeNotesIngest,
  type NoteWrite,
  type NotesDirEntry,
  type NotesFs,
  type NotesManifestIO,
  type NotesStore,
  type StoredNote,
} from '../../src/main/claudeNotesIngest'
import {
  CWD, FEEDBACK, FOLDER, cleanup, data, deps, fakeStore, flakyManifest, manifestFile, manifestJson, note, root, session,
  setupWorld, spyFs, teardownWorld, tempDir,
} from './_claudeNotesHarness'

beforeEach(setupWorld)
afterEach(teardownWorld)

describe('noteRoots: the one place the folders to read come from', () => {
  it('is ~/.claude/projects, and the scratch home a test run points TERMPOLIS_TEST_AGENT_HOME at', async () => {
    const prev = process.env.TERMPOLIS_TEST_AGENT_HOME
    try {
      process.env.TERMPOLIS_TEST_AGENT_HOME = path.join(root, 'scratch-home')
      expect(await noteRoots()).toEqual([path.join(root, 'scratch-home', '.claude', 'projects')])
      process.env.TERMPOLIS_TEST_AGENT_HOME = '   '
      expect(await noteRoots()).toEqual([path.join(os.homedir(), '.claude', 'projects')]) // a path only: nothing is read
      delete process.env.TERMPOLIS_TEST_AGENT_HOME
      expect(await noteRoots()).toEqual([path.join(os.homedir(), '.claude', 'projects')])
    } finally {
      if (prev === undefined) delete process.env.TERMPOLIS_TEST_AGENT_HOME
      else process.env.TERMPOLIS_TEST_AGENT_HOME = prev
    }
  })
})

describe('realNotesFs', () => {
  it('lists a folder by what each entry is, and says null for one it cannot read', async () => {
    fs.mkdirSync(path.join(root, 'sub'))
    fs.writeFileSync(path.join(root, 'a.md'), 'x')
    const list = (await realNotesFs.list(root)) as NotesDirEntry[]
    expect(list.find((e) => e.name === 'sub')?.kind).toBe('dir')
    expect(list.find((e) => e.name === 'a.md')?.kind).toBe('file')
    expect(await realNotesFs.list(path.join(root, 'nope'))).toBeNull()
  })

  it('reports a link as a link, and anything else that is neither file nor folder as other', async () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-target-'))
    cleanup.push(target)
    try { fs.symlinkSync(target, path.join(root, 'ln'), 'junction') } catch { return } // links need rights this account may lack
    expect((await realNotesFs.list(root))?.find((e) => e.name === 'ln')?.kind).toBe('link')
  })

  it('stats a file, and gives null for a missing path or a folder', async () => {
    const p = path.join(root, 'a.md')
    fs.writeFileSync(p, 'hello')
    expect(await realNotesFs.stat(p)).toEqual({ size: 5, mtimeMs: fs.statSync(p).mtimeMs })
    expect(await realNotesFs.stat(path.join(root, 'nope'))).toBeNull()
    expect(await realNotesFs.stat(root)).toBeNull()
  })

  it('resolves a real path, null when there is none', async () => {
    expect(await realNotesFs.real(root)).toBe(fs.realpathSync.native(root)) // the long form of a Windows 8.3 temp path
    expect(await realNotesFs.real(path.join(root, 'nope'))).toBeNull()
  })

  it('reads no more than the bytes asked for, and gives null for a file it cannot open', async () => {
    const p = path.join(root, 'big.md')
    fs.writeFileSync(p, 'a'.repeat(1000))
    expect((await realNotesFs.read(p, 100))?.length).toBe(100)
    expect((await realNotesFs.read(p, 5000))?.length).toBe(1000)
    expect(await realNotesFs.read(path.join(root, 'nope'), 100)).toBeNull()
    expect(await realNotesFs.read(root, 100)).toBeNull() // a folder cannot be read as a file
  })
})

describe('findNotes: which files are notes', () => {
  it('finds projects/*/memory/*.md, in a stable order, with size and modified time', async () => {
    const b = note('B-proj', 'b_note.md', 'Second.', Date.UTC(2026, 7, 1))
    const a1 = note('A-proj', 'z_last.md', 'Third.')
    const a0 = note('A-proj', 'a_first.md', 'First.')
    const found = await findNotes([root], realNotesFs)
    expect(found.notes.map((n) => n.key)).toEqual(['A-proj/a_first.md', 'A-proj/z_last.md', 'B-proj/b_note.md'])
    expect(found.notes[0]).toEqual({
      key: 'A-proj/a_first.md', folder: 'A-proj', fileName: 'a_first.md', path: a0, folderDir: path.join(root, 'A-proj'),
      size: 6, mtimeMs: fs.statSync(a0).mtimeMs,
    })
    expect(found.notes[2].mtimeMs).toBe(fs.statSync(b).mtimeMs)
    expect(found.notes[1].path).toBe(a1)
    expect([...found.listed].sort()).toEqual(['A-proj', 'B-proj'])
    expect([...found.folders].sort()).toEqual(['A-proj', 'B-proj'])
    expect(found.rootsRead).toBe(1)
  })

  it('leaves out MEMORY.md in any case, other file types, subfolders, empty files and oversize files, and counts them', async () => {
    note('P', 'MEMORY.md', '- [a](a.md)')
    note('P', 'memory.MD', 'index')
    note('P', 'notes.txt', 'text')
    note('P', 'empty.md', '')
    note('P', 'huge.md', 'x'.repeat(MAX_NOTE_BYTES + 1))
    note('P', 'ok.md', 'Fine.')
    fs.mkdirSync(path.join(root, 'P', 'memory', 'sub.md'))
    const found = await findNotes([root], realNotesFs)
    expect(found.notes.map((n) => n.fileName)).toEqual(['ok.md'])
    expect(found.skipped).toMatchObject({ empty: 1, oversize: 1, links: 0, capped: 0, duplicate: 0 })
  })

  // PRIVACY.md and DOCUMENTATION.md tell the user these two numbers ("files over 64 KB", "anything past 2,000 files"). They
  // are pinned by value here, so a change to either is a change to what the user was told.
  it('has the limits the privacy notes disclose: 64 KB a note, 2,000 notes', () => {
    expect(MAX_NOTE_BYTES).toBe(64 * 1024)
    expect(MAX_NOTE_FILES).toBe(2000)
  })

  it('keeps the first 2,000 notes by default and counts the rest, whatever the caller passes', async () => {
    const dir = path.join(root, 'P', 'memory')
    const names = Array.from({ length: MAX_NOTE_FILES + 3 }, (_, i) => `n${String(i).padStart(4, '0')}.md`)
    const f = spyFs({
      dirs: { [root]: [{ name: 'P', kind: 'dir' }], [dir]: names.map((name) => ({ name, kind: 'file' as const })) },
      stats: Object.fromEntries(names.map((n) => [path.join(dir, n), { size: 3, mtimeMs: 1 }])),
    })
    const found = await findNotes([root], f)
    expect(found.notes).toHaveLength(MAX_NOTE_FILES)
    expect(found.notes[MAX_NOTE_FILES - 1].fileName).toBe(names[MAX_NOTE_FILES - 1])
    expect(found.skipped.capped).toBe(3)
  })

  it('a note exactly at the size limit is still a note', async () => {
    note('P', 'edge.md', 'x'.repeat(MAX_NOTE_BYTES))
    expect((await findNotes([root], realNotesFs)).notes).toHaveLength(1)
  })

  it('a folder with no notes folder is not an error, and a file in the projects folder itself is ignored', async () => {
    fs.mkdirSync(path.join(root, 'bare'))
    fs.writeFileSync(path.join(root, 'stray.md'), 'x')
    const found = await findNotes([root], realNotesFs, { imported: new Set(['bare']) })
    expect(found.notes).toEqual([])
    expect([...found.folders]).toEqual(['bare'])
    expect([...found.listed]).toEqual(['bare']) // it was read, and holds no notes folder: whatever was imported from it is gone
  })

  // A project folder with no notes folder is "listed" (nothing in it) only when that was SEEN: the project folder read fine
  // and has no entry called memory. Anything short of that is unknown, and unknown removes nothing.
  describe('a project folder with no notes folder to read', () => {
    const memoryDir = (): string => path.join(root, 'P', 'memory')
    const imported = { imported: new Set(['P']) }
    const seen = (entries: Array<{ name: string; kind: 'file' | 'dir' | 'link' | 'other' }> | null) =>
      spyFs({ dirs: { [root]: [{ name: 'P', kind: 'dir' }], [path.join(root, 'P')]: entries }, reals: { [memoryDir()]: null } })

    it('is listed, empty, when the project folder reads fine and holds no notes folder', async () => {
      const found = await findNotes([root], seen([{ name: 'aaaa.jsonl', kind: 'file' }]), imported)
      expect([...found.listed]).toEqual(['P'])
      expect(found.notes).toEqual([])
    })

    // Looking inside a project folder that has no notes folder is only worth doing for a folder notes were taken from: for any
    // other there is nothing to take out. PRIVACY.md and DOCUMENTATION.md say what is read; this is what keeps them true.
    it("looks inside only a folder that notes were imported from, and reads no other folder's entries", async () => {
      const f = seen([{ name: 'aaaa.jsonl', kind: 'file' }])
      for (const opts of [{}, { imported: new Set<string>() }, { imported: new Set(['Q']) }]) {
        const found = await findNotes([root], f, opts)
        expect([...found.listed]).toEqual([])
        expect([...found.folders]).toEqual(['P']) // it was seen, and is still reported as a folder
      }
      expect(f.calls.list).toEqual([root, root, root]) // the projects folder each time, and never the folder P
    })

    it('is not listed when the project folder cannot be read', async () => {
      expect([...(await findNotes([root], seen(null), imported)).listed]).toEqual([])
    })

    it('is not listed when there is an entry called memory that cannot be resolved (a dangling link, a drive not mounted)', async () => {
      expect([...(await findNotes([root], seen([{ name: 'memory', kind: 'link' }]), imported)).listed]).toEqual([])
    })

    it('is not listed when the entry is spelt in another case, which a case-sensitive disk keeps apart', async () => {
      expect([...(await findNotes([root], seen([{ name: 'Memory', kind: 'dir' }]), imported)).listed]).toEqual([])
    })
  })

  it('a root that does not exist is skipped, and a missing list of roots finds nothing', async () => {
    const found = await findNotes([path.join(root, 'gone')], realNotesFs)
    expect(found).toMatchObject({ notes: [], rootsRead: 0 })
    expect((await findNotes([], realNotesFs)).rootsRead).toBe(0)
  })

  it('reads a root once however many ways it is named, and a note once however many roots hold it', async () => {
    note('P', 'one.md', 'First.')
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-root2-'))
    cleanup.push(other)
    fs.mkdirSync(path.join(other, 'P', 'memory'), { recursive: true })
    fs.writeFileSync(path.join(other, 'P', 'memory', 'one.md'), 'Same name in a second root.')
    const found = await findNotes([root, root, other], realNotesFs)
    expect(found.rootsRead).toBe(2)
    expect(found.notes).toHaveLength(1)
    expect(found.notes[0].path).toBe(path.join(root, 'P', 'memory', 'one.md')) // the first root wins
    expect(found.skipped.duplicate).toBe(1)
  })

  it('stops at the file cap and says how many it left', async () => {
    for (const f of ['a', 'b', 'c', 'd', 'e']) note('P', `${f}.md`, 'x')
    const found = await findNotes([root], realNotesFs, { maxFiles: 3 })
    expect(found.notes.map((n) => n.fileName)).toEqual(['a.md', 'b.md', 'c.md'])
    expect(found.skipped.capped).toBe(2)
  })

  it('leaves out a link that leaves the projects folder, and keeps one that stays inside it', async () => {
    const dir = path.join(root, 'P', 'memory')
    const file = (n: string): string => path.join(dir, n)
    const f = spyFs({
      dirs: {
        [root]: [{ name: 'P', kind: 'dir' }, { name: 'Q', kind: 'link' }, { name: 'R', kind: 'dir' }, { name: 'S', kind: 'other' }],
        [dir]: [{ name: 'out.md', kind: 'link' }, { name: 'in.md', kind: 'link' }, { name: 'dead.md', kind: 'link' }, { name: 'sock.md', kind: 'other' }],
        [path.join(root, 'Q', 'memory')]: [{ name: 'q.md', kind: 'file' }],
        [path.join(root, 'R', 'memory')]: [{ name: 'r.md', kind: 'file' }],
      },
      stats: { [file('in.md')]: { size: 5, mtimeMs: 1 }, [path.join(root, 'R', 'memory', 'r.md')]: { size: 5, mtimeMs: 2 } },
      reals: {
        [root]: root,
        [file('out.md')]: path.join(os.tmpdir(), 'elsewhere', 'out.md'),
        [file('in.md')]: path.join(root, 'P', 'shared', 'in.md'),
        [file('dead.md')]: null,
        [path.join(root, 'Q', 'memory')]: path.join(os.tmpdir(), 'elsewhere', 'memory'), // a notes folder that is a link out
      },
    })
    const found = await findNotes([root], f)
    expect(found.notes.map((n) => n.key)).toEqual(['P/in.md', 'R/r.md'])
    expect(found.skipped.links).toBe(3) // out.md, dead.md, and Q's whole notes folder
  })

  it('a path that is the root itself, or only looks like going up, is judged correctly', async () => {
    const dir = path.join(root, 'P', 'memory')
    const f = spyFs({
      dirs: { [root]: [{ name: 'P', kind: 'dir' }], [dir]: [{ name: 'self.md', kind: 'link' }, { name: 'dots.md', kind: 'link' }] },
      stats: { [path.join(dir, 'dots.md')]: { size: 3, mtimeMs: 5 } },
      reals: { [path.join(dir, 'self.md')]: root, [path.join(dir, 'dots.md')]: path.join(root, '..notes', 'dots.md') },
    })
    const found = await findNotes([root], f)
    expect(found.notes.map((n) => n.key)).toEqual(['P/dots.md']) // a folder called ..notes inside the root is inside it
    expect(found.skipped.links).toBe(1) // self.md IS the root: not a file inside it
  })

  it('does not count a notes folder it could not list as listed, and marks a file it could not stat as uncertain', async () => {
    const dirA = path.join(root, 'A', 'memory')
    const dirB = path.join(root, 'B', 'memory')
    const f = spyFs({
      dirs: { [root]: [{ name: 'A', kind: 'dir' }, { name: 'B', kind: 'dir' }], [dirB]: [{ name: 'locked.md', kind: 'file' }] },
      reals: { [dirA]: dirA },
    })
    const found = await findNotes([root], f)
    expect(found.listed.size).toBe(1) // B listed; A's listing failed
    expect([...found.listed]).toEqual(['B'])
    expect([...found.uncertain]).toEqual(['B/locked.md'])
    expect(found.notes).toEqual([])
  })
})

describe('the manifest file', () => {
  it('round-trips, reads as null when there is none, and replaces the old one whole', () => {
    const io = fileManifest(data)
    expect(io.read()).toBeNull()
    io.write('{"a":1}')
    expect(io.read()).toBe('{"a":1}')
    io.write('{"a":2}')
    expect(io.read()).toBe('{"a":2}')
    expect(fs.readdirSync(data)).toEqual([NOTES_MANIFEST_FILE]) // no temp file left behind
  })

  it('a leftover temp file from a killed write is ignored and the old manifest still reads', () => {
    const io = fileManifest(data)
    io.write('{"old":true}')
    fs.writeFileSync(path.join(data, `${NOTES_MANIFEST_FILE}.termpolis-999.tmp`), '{"half')
    expect(io.read()).toBe('{"old":true}')
  })
})

describe('a pass: what is read, and when', () => {
  it('reads nothing at all while the switch is off: no folder listed, no file touched, no manifest read', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const f = spyFs()
    const manifest: NotesManifestIO = { read: vi.fn(() => null), write: vi.fn() }
    const store = fakeStore()
    const stats = await runClaudeNotesIngest(deps(store, { enabled: () => false, fs: f, manifest, roots: vi.fn(async () => [root]) }))
    expect(stats).toMatchObject({ idle: 'off', chunksWritten: 0 })
    expect(f.calls).toEqual({ list: [], stat: [], real: [], read: [] })
    expect(manifest.read).not.toHaveBeenCalled()
    expect(manifest.write).not.toHaveBeenCalled()
    expect(store.writes).toHaveLength(0)
  })

  it('reads nothing while the agents are not connected, whatever the switch says', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    const f = spyFs()
    const roots = vi.fn(async () => [root])
    const stats = await runClaudeNotesIngest(deps(fakeStore(), { connected: () => false, fs: f, roots }))
    expect(stats).toMatchObject({ idle: 'not-connected', chunksWritten: 0 })
    expect(f.calls.list).toEqual([])
    expect(roots).not.toHaveBeenCalled()
  })

  it('writes one entry per chunk, with exactly the fields the notes are stored with', async () => {
    const file = note(FOLDER, 'feedback_widget.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    const stats = await runClaudeNotesIngest(deps(store))
    expect(stats).toMatchObject({ filesSeen: 1, filesChanged: 1, chunksWritten: 1, noProject: 0, truncated: false })
    expect(store.writes).toEqual([{
      agentId: 'claude-notes',
      source: 'claude-notes',
      kind: 'decision',
      content: 'widget_cache_rules \u2014 How the widget cache is invalidated\n\nInvalidate on write, not on a timer.',
      tags: ['type:feedback', 'note:feedback_widget.md'],
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      importance: 0.9,
      memoryType: 'summary',
      project: CWD, // the raw working directory: the store derives the slug and the key
      ts: fs.statSync(file).mtimeMs, // the note's last edit, so its age reads true
    }])
  })

  it('stores each type the way it is mapped: reference and user as facts, project as a note', async () => {
    note(FOLDER, 'a.md', '---\nname: a\ntype: reference\n---\nA reference.')
    note(FOLDER, 'b.md', '---\nname: b\ntype: user\n---\nAbout the user.')
    note(FOLDER, 'c.md', '---\nname: c\ntype: project\n---\nProject state.')
    note(FOLDER, 'd.md', 'No frontmatter at all.')
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    const by = (n: string): NoteWrite => store.writes.find((w) => w.tags.includes(`note:${n}`))!
    expect([by('a.md').kind, by('a.md').importance]).toEqual(['fact', 0.9])
    expect([by('b.md').kind, by('b.md').importance]).toEqual(['fact', 0.9])
    expect([by('c.md').kind, by('c.md').importance]).toEqual(['note', 0.8])
    expect([by('d.md').kind, by('d.md').importance, by('d.md').tags[0]]).toEqual(['note', 0.8, 'type:untyped'])
    expect(store.writes.every((w) => w.kind !== ('message' as string))).toBe(true)
  })

  it('a second pass over unchanged notes writes nothing and reads no note', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    const f = spyFs({})
    const real = realNotesFs
    const watching: NotesFs = { ...real, read: async (file, max) => { f.calls.read.push(file); return real.read(file, max) } }
    const second = await runClaudeNotesIngest(deps(store, { fs: watching }))
    expect(second).toMatchObject({ filesSeen: 1, filesChanged: 0, chunksWritten: 0, chunksDeleted: 0 })
    expect(store.writes).toHaveLength(1)
    expect(f.calls.read).toEqual([]) // size and time said nothing changed: not even opened
  })

  it('a note touched but not changed is read once, recorded, and writes nothing', async () => {
    const p = note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    const later = new Date(Date.UTC(2026, 9, 1))
    fs.utimesSync(p, later, later)
    const stats = await runClaudeNotesIngest(deps(store))
    expect(stats).toMatchObject({ filesChanged: 0, chunksWritten: 0, chunksDeleted: 0 })
    expect(manifestJson().files[`${FOLDER}/n.md`].mtimeMs).toBe(fs.statSync(p).mtimeMs)
    const third = await runClaudeNotesIngest(deps(store, { fs: { ...realNotesFs, read: async () => { throw new Error('should not read') } } }))
    expect(third.filesChanged).toBe(0)
  })

  it('an edited note replaces only the chunks that changed: the old ones removed, the new ones written', async () => {
    const filler = 'f'.repeat(1500)
    const body = (tail: string): string => `---\nname: big\ndescription: two chunks\ntype: reference\n---\nFirst paragraph. ${filler}\n\nSecond paragraph. ${filler}\n\n${tail}`
    const p = note(FOLDER, 'big.md', body('Original tail.'))
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    const before = [...store.rows.values()]
    expect(before.length).toBeGreaterThanOrEqual(2)
    fs.writeFileSync(p, body('Edited tail.'))
    fs.utimesSync(p, new Date(Date.UTC(2026, 8, 2)), new Date(Date.UTC(2026, 8, 2)))
    const stats = await runClaudeNotesIngest(deps(store))
    const after = [...store.rows.values()]
    expect(stats.filesChanged).toBe(1)
    expect(stats.chunksDeleted).toBe(1)
    expect(stats.chunksWritten).toBe(1)
    expect(store.removed).toHaveLength(1)
    expect(after.some((r) => r.content.includes('Edited tail.'))).toBe(true)
    expect(after.some((r) => r.content.includes('Original tail.'))).toBe(false)
    const keptId = before.find((r) => !r.content.includes('Original tail.'))!.id
    expect(after.some((r) => r.id === keptId)).toBe(true) // an unchanged chunk keeps its entry
  })

  it('a note that changes type keeps its words but is stored again, so its type travels with it', async () => {
    const p = note(FOLDER, 'n.md', '---\nname: n\ntype: project\n---\nSame words.')
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    fs.writeFileSync(p, '---\nname: n\ntype: reference\n---\nSame words.')
    fs.utimesSync(p, new Date(Date.UTC(2026, 8, 2)), new Date(Date.UTC(2026, 8, 2)))
    const stats = await runClaudeNotesIngest(deps(store))
    expect(stats).toMatchObject({ chunksDeleted: 1, chunksWritten: 1 })
    expect([...store.rows.values()].map((r) => r.tags?.[0])).toEqual(['type:reference'])
  })

  it('a deleted note removes its chunks; a renamed one removes the old and writes the new', async () => {
    const p = note(FOLDER, 'old.md', '---\nname: n\n---\nKeep this text.')
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    fs.renameSync(p, path.join(path.dirname(p), 'new.md'))
    const renamed = await runClaudeNotesIngest(deps(store))
    expect(renamed).toMatchObject({ chunksDeleted: 1, chunksWritten: 1, filesRemoved: 1 })
    expect([...store.rows.values()].map((r) => r.tags?.[1])).toEqual(['note:new.md'])
    fs.rmSync(path.join(path.dirname(p), 'new.md'))
    const gone = await runClaudeNotesIngest(deps(store))
    expect(gone).toMatchObject({ chunksDeleted: 1, chunksWritten: 0, filesRemoved: 1 })
    expect(store.rows.size).toBe(0)
    expect(manifestJson().files).toEqual({})
  })

  it('leaves a note alone when its folder has no session to say which project it belongs to, and says so', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    const store = fakeStore()
    const stats = await runClaudeNotesIngest(deps(store))
    expect(stats).toMatchObject({ noProject: 1, chunksWritten: 0 })
    expect(store.writes).toHaveLength(0)
    session(FOLDER, CWD) // a session appears later: the next pass picks the note up
    expect(await runClaudeNotesIngest(deps(store))).toMatchObject({ noProject: 0, chunksWritten: 1 })
  })

  it('does not file a note under a project when no session ran in a directory that folder is named for', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, 'C:\\somewhere\\else')
    const store = fakeStore()
    expect(await runClaudeNotesIngest(deps(store))).toMatchObject({ noProject: 1, chunksWritten: 0 })
  })

  it('finds the project from the newest session, through a parent when the session moved into a subfolder', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, 'C:\\unrelated', 'old.jsonl', Date.UTC(2026, 0, 1))
    session(FOLDER, `${CWD}\\.worktrees\\feat`, 'new.jsonl', Date.UTC(2026, 8, 1))
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    expect(store.writes[0].project).toBe(CWD)
    expect(manifestJson().cwds[FOLDER]).toBe(CWD) // remembered: the next pass does not look again
  })

  it('looks at no more than the newest few sessions, and reads only their start', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    for (let i = 0; i < 5; i++) session(FOLDER, 'C:\\unrelated', `s${i}.jsonl`, Date.UTC(2026, 8, 10 + i))
    session(FOLDER, CWD, 'ancient.jsonl', Date.UTC(2020, 0, 1)) // the only one that fits, but the oldest
    const store = fakeStore()
    expect(await runClaudeNotesIngest(deps(store))).toMatchObject({ noProject: 1 })
    const big = path.join(root, FOLDER, 'big.jsonl')
    fs.writeFileSync(big, `${JSON.stringify({ cwd: 'C:\\unrelated' })}\n${'x'.repeat(400 * 1024)}\n${JSON.stringify({ cwd: CWD })}\n`)
    fs.utimesSync(big, new Date(Date.UTC(2026, 9, 1)), new Date(Date.UTC(2026, 9, 1)))
    expect(await runClaudeNotesIngest(deps(store))).toMatchObject({ noProject: 1 }) // the cwd past the first 256 KB is not seen
  })

  it('skips a session file it cannot read and a note it cannot read, and tries again next time', async () => {
    const p = note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    const real = realNotesFs
    let failNote = true
    const flaky: NotesFs = { ...real, read: async (file, max) => (failNote && file === p ? null : real.read(file, max)) }
    const first = await runClaudeNotesIngest(deps(store, { fs: flaky }))
    expect(first).toMatchObject({ unreadable: 1, chunksWritten: 0 })
    failNote = false
    expect(await runClaudeNotesIngest(deps(store, { fs: flaky }))).toMatchObject({ unreadable: 0, chunksWritten: 1 })
  })

  it('a session whose start cannot be read is passed over for the next newest', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD, 'good.jsonl', Date.UTC(2026, 8, 1))
    session(FOLDER, CWD, 'bad.jsonl', Date.UTC(2026, 9, 1))
    const real = realNotesFs
    const flaky: NotesFs = { ...real, read: async (file, max) => (file.endsWith('bad.jsonl') ? null : real.read(file, max)) }
    const store = fakeStore()
    expect(await runClaudeNotesIngest(deps(store, { fs: flaky }))).toMatchObject({ chunksWritten: 1, noProject: 0 })
  })

  it('skips a binary file and a note that has nothing to say, and does not read them again until they change', async () => {
    const bin = note(FOLDER, 'bin.md', 'text')
    fs.writeFileSync(bin, Buffer.from([0x23, 0x20, 0x61, 0x00, 0x62, 0x63]))
    note(FOLDER, 'blank.md', '---\nname: nothing\ntype: user\n---\n')
    session(FOLDER, CWD)
    const store = fakeStore()
    const first = await runClaudeNotesIngest(deps(store))
    expect(first).toMatchObject({ binary: 1, chunksWritten: 0, filesChanged: 2 })
    const reads: string[] = []
    const watching: NotesFs = { ...realNotesFs, read: async (f, m) => { reads.push(f); return realNotesFs.read(f, m) } }
    await runClaudeNotesIngest(deps(store, { fs: watching }))
    expect(reads).toEqual([])
  })

  it('a note that grew past the limit between the listing and the read is skipped, not stored', async () => {
    const p = note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const real = realNotesFs
    const grown: NotesFs = { ...real, read: async (file, max) => (file === p ? Buffer.alloc(MAX_NOTE_BYTES + 1, 0x61) : real.read(file, max)) }
    const store = fakeStore()
    expect(await runClaudeNotesIngest(deps(store, { fs: grown }))).toMatchObject({ chunksWritten: 0 })
    expect(store.writes).toHaveLength(0)
  })

  it('a note emptied after it was imported has its chunks removed', async () => {
    const p = note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    fs.writeFileSync(p, '---\nname: n\ntype: feedback\n---\n')
    fs.utimesSync(p, new Date(Date.UTC(2026, 8, 3)), new Date(Date.UTC(2026, 8, 3)))
    expect(await runClaudeNotesIngest(deps(store))).toMatchObject({ chunksDeleted: 1, chunksWritten: 0 })
    expect(store.rows.size).toBe(0)
  })
})

describe('a pass: limits, interruptions, failures', () => {
  it('stops at the per-pass budget, says there is more, and the next pass carries on to exactly the full set', async () => {
    for (let i = 0; i < 5; i++) note(FOLDER, `n${i}.md`, `---\nname: n${i}\n---\nNote number ${i}.`, Date.UTC(2026, 8, 1 + i))
    session(FOLDER, CWD)
    const store = fakeStore()
    const first = await runClaudeNotesIngest(deps(store), { maxChunks: 2 })
    expect(first).toMatchObject({ chunksWritten: 2, truncated: true })
    const second = await runClaudeNotesIngest(deps(store), { maxChunks: 2 })
    expect(second).toMatchObject({ chunksWritten: 2, truncated: true })
    const third = await runClaudeNotesIngest(deps(store), { maxChunks: 2 })
    expect(third).toMatchObject({ chunksWritten: 1, truncated: false })
    expect(store.rows.size).toBe(5)
    expect(new Set([...store.rows.values()].map((r) => r.content)).size).toBe(5)
  })

  it('imports the newest notes first', async () => {
    note(FOLDER, 'old.md', '---\nname: old\n---\nOld one.', Date.UTC(2025, 0, 1))
    note(FOLDER, 'new.md', '---\nname: new\n---\nNew one.', Date.UTC(2026, 9, 1))
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store), { maxChunks: 1 })
    expect(store.writes.map((w) => w.tags[1])).toEqual(['note:new.md'])
  })

  it('ends the pass when the app is quitting, and says there is more', async () => {
    for (let i = 0; i < 3; i++) note(FOLDER, `n${i}.md`, `---\nname: n${i}\n---\nNote ${i}.`)
    session(FOLDER, CWD)
    let calls = 0
    const stats = await runClaudeNotesIngest(deps(fakeStore(), { stopped: () => ++calls > 1 }))
    expect(stats.truncated).toBe(true)
    expect(stats.chunksWritten).toBe(1)
  })

  it('stops quietly when the switch is turned off in the middle of a pass', async () => {
    for (let i = 0; i < 3; i++) note(FOLDER, `n${i}.md`, `---\nname: n${i}\n---\nNote ${i}.`)
    session(FOLDER, CWD)
    let on = true
    const store = fakeStore()
    const stats = await runClaudeNotesIngest(deps(store, { enabled: () => on, yield: async () => { on = false } }))
    expect(stats.chunksWritten).toBe(1)
    expect(stats.truncated).toBe(false) // nothing is queued as backlog: the user turned it off
  })

  it('a store that refuses writes (memory locked) ends the pass at the first refusal and claims nothing', async () => {
    for (let i = 0; i < 3; i++) note(FOLDER, `n${i}.md`, `---\nname: n${i}\n---\nNote ${i}.`)
    session(FOLDER, CWD)
    const store = fakeStore()
    store.failWrites(new Error('Memory is locked (key-unreadable)'))
    const stats = await runClaudeNotesIngest(deps(store))
    expect(stats).toMatchObject({ chunksWritten: 0, writeFailed: 1 })
    expect(Object.values(manifestJson().files as Record<string, { mtimeMs: number }>).every((f) => f.mtimeMs === -1)).toBe(true)
    store.failWrites(null) // unlocked
    expect(await runClaudeNotesIngest(deps(store))).toMatchObject({ chunksWritten: 3 })
    expect(store.rows.size).toBe(3)
  })

  it('a write that answers with no entry is a failure, not a success', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    store.write = vi.fn(async () => null)
    expect(await runClaudeNotesIngest(deps(store))).toMatchObject({ chunksWritten: 0, writeFailed: 1 })
  })

  it('a partly stored note is finished by the next pass without storing its first chunks again', async () => {
    const filler = 'p'.repeat(1500)
    note(FOLDER, 'big.md', `---\nname: big\n---\nOne ${filler}\n\nTwo ${filler}\n\nThree ${filler}`)
    session(FOLDER, CWD)
    const store = fakeStore()
    const first = await runClaudeNotesIngest(deps(store), { maxChunks: 1 })
    expect(first).toMatchObject({ chunksWritten: 1, truncated: true })
    const second = await runClaudeNotesIngest(deps(store))
    expect(second.chunksWritten).toBe(store.rows.size - 1)
    expect(store.writes.map((w) => w.hash).length).toBe(new Set(store.writes.map((w) => w.hash)).size) // no chunk twice
  })

  it('counts the secrets the store redacted, and the note arrives redacted', async () => {
    note(FOLDER, 'n.md', '---\nname: n\n---\nKey is here.')
    session(FOLDER, CWD)
    const store = fakeStore()
    const write = store.write.bind(store)
    store.write = async (i) => ({ ...(await write(i)), scrubbed: 2 }) as StoredNote
    expect(await runClaudeNotesIngest(deps(store))).toMatchObject({ secretsRedacted: 2 })
    expect(manifestJson().last.secretsRedacted).toBe(2)
  })

  it('keeps the redaction count across passes: Settings shows the total, not the last pass\'s', async () => {
    note(FOLDER, 'a.md', '---\nname: a\n---\nFirst key is here.')
    session(FOLDER, CWD)
    const store = fakeStore()
    const write = store.write.bind(store)
    store.write = async (i) => ({ ...(await write(i)), scrubbed: 1 }) as StoredNote
    await runClaudeNotesIngest(deps(store))
    note(FOLDER, 'b.md', '---\nname: b\n---\nSecond key is here.')
    expect(await runClaudeNotesIngest(deps(store))).toMatchObject({ secretsRedacted: 1 }) // this pass redacted one...
    expect(notesStatus(fileManifest(data)).secretsRedacted).toBe(2) // ...and the panel counts both
    await runClaudeNotesIngest(deps(store)) // a pass that redacts nothing does not reset it
    expect(notesStatus(fileManifest(data)).secretsRedacted).toBe(2)
  })

  it('stops without touching the store when the manifest cannot be saved', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    const manifest: NotesManifestIO = { read: () => null, write: () => { throw new Error('disk full') } }
    const stats = await runClaudeNotesIngest(deps(store, { manifest }))
    expect(stats.chunksWritten).toBe(0)
    expect(stats.manifestFailed).toBe(true)
    expect(store.writes).toHaveLength(0)
  })

  it('a pass in which nothing changed does not rewrite the store and still records when it ran', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    const now = vi.fn(() => 1_700_000_000_000)
    await runClaudeNotesIngest(deps(store, { now }))
    expect(manifestJson().last.at).toBe(1_700_000_000_000)
    now.mockReturnValue(1_700_000_900_000)
    await runClaudeNotesIngest(deps(store, { now }))
    expect(manifestJson().last.at).toBe(1_700_000_900_000)
    expect(store.writes).toHaveLength(1)
  })
})

describe('a pass: what it will not delete', () => {
  async function importedOne(): Promise<ReturnType<typeof fakeStore>> {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    expect(store.rows.size).toBe(1)
    return store
  }

  it('keeps everything when no root could be read (a drive that is not mounted)', async () => {
    const store = await importedOne()
    const stats = await runClaudeNotesIngest(deps(store, { roots: async () => [path.join(root, 'unmounted')] }))
    expect(stats.chunksDeleted).toBe(0)
    expect(store.rows.size).toBe(1)
    expect((await runClaudeNotesIngest(deps(store, { roots: async () => [] }))).chunksDeleted).toBe(0)
  })

  it('keeps everything when the root reads but holds no project folders at all', async () => {
    const store = await importedOne()
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-empty-'))
    cleanup.push(empty)
    expect((await runClaudeNotesIngest(deps(store, { roots: async () => [empty] }))).chunksDeleted).toBe(0)
    expect(store.rows.size).toBe(1)
  })

  it('keeps a note whose file could not be stat-ed this time, and a note whose folder could not be listed', async () => {
    const store = await importedOne()
    const f = spyFs({
      dirs: { [root]: [{ name: FOLDER, kind: 'dir' }], [path.join(root, FOLDER, 'memory')]: [{ name: 'n.md', kind: 'file' }] },
      reals: { [root]: root },
    })
    expect((await runClaudeNotesIngest(deps(store, { fs: f }))).chunksDeleted).toBe(0) // stat said nothing
    const g = spyFs({ dirs: { [root]: [{ name: FOLDER, kind: 'dir' }] }, reals: { [root]: root } })
    expect((await runClaudeNotesIngest(deps(store, { fs: g }))).chunksDeleted).toBe(0) // notes folder unreadable
    expect(store.rows.size).toBe(1)
  })

  it('keeps everything when the file cap cut the listing short', async () => {
    const store = await importedOne()
    for (const f of ['a', 'b', 'c']) note('Z-other', `${f}.md`, 'x')
    fs.rmSync(path.join(root, FOLDER, 'memory', 'n.md'))
    const stats = await runClaudeNotesIngest(deps(store), { maxFiles: 1 })
    expect(stats.chunksDeleted).toBe(0)
    expect(store.rows.size).toBe(1)
  })

  it('removes the notes of a project folder that is gone from a root that did read', async () => {
    const store = await importedOne()
    fs.rmSync(path.join(root, FOLDER), { recursive: true })
    fs.mkdirSync(path.join(root, 'some-other-folder'))
    expect((await runClaudeNotesIngest(deps(store))).chunksDeleted).toBe(1)
    expect(store.rows.size).toBe(0)
  })

  // Wiping a project's notes means deleting its memory folder; the project folder and its sessions stay. The copies go with
  // the notes (PRIVACY.md: "a deleted one removes it"), or text the user wanted gone keeps being served to every agent.
  it('removes the copies of a project whose whole notes folder was deleted, while the project and its sessions remain', async () => {
    const store = await importedOne()
    fs.rmSync(path.join(root, FOLDER, 'memory'), { recursive: true })
    const stats = await runClaudeNotesIngest(deps(store))
    expect(stats).toMatchObject({ filesRemoved: 1, chunksDeleted: 1 })
    expect(store.rows.size).toBe(0)
    expect(manifestJson().files).toEqual({})
    expect(manifestJson().cwds[FOLDER]).toBe(CWD) // the project is still known: a new note there needs no second look at the sessions
    note(FOLDER, 'again.md', FEEDBACK) // and a notes folder made afresh imports again
    expect((await runClaudeNotesIngest(deps(store))).chunksWritten).toBe(1)
    expect(store.rows.size).toBe(1)
  })

  it('keeps the copies when the notes folder cannot be resolved though the project folder lists an entry for it', async () => {
    const store = await importedOne()
    const dangling: NotesFs = { ...realNotesFs, real: async (p) => (p === path.join(root, FOLDER, 'memory') ? null : realNotesFs.real(p)) }
    const stats = await runClaudeNotesIngest(deps(store, { fs: dangling }))
    expect(stats).toMatchObject({ filesRemoved: 0, chunksDeleted: 0 })
    expect(store.rows.size).toBe(1)
  })

  it('keeps the copies when the project folder itself cannot be listed', async () => {
    const store = await importedOne()
    const blind: NotesFs = {
      ...realNotesFs,
      real: async (p) => (p === path.join(root, FOLDER, 'memory') ? null : realNotesFs.real(p)),
      list: async (d) => (d === path.join(root, FOLDER) ? null : realNotesFs.list(d)),
    }
    expect((await runClaudeNotesIngest(deps(store, { fs: blind }))).chunksDeleted).toBe(0)
    expect(store.rows.size).toBe(1)
  })
})

describe('the manifest is the record of what was stored', () => {
  it('writes a manifest the next pass can use: salt, epoch, files with their chunks, the folders\' projects', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    await runClaudeNotesIngest(deps(fakeStore()))
    const m = manifestJson()
    expect(m).toMatchObject({ version: 1, epoch: 0, dirty: false, stale: [], cwds: { [FOLDER]: CWD } })
    expect(m.salt).toMatch(/^[0-9a-f]{16}$/)
    expect(m.files[`${FOLDER}/n.md`]).toMatchObject({ project: CWD, size: expect.any(Number), mtimeMs: expect.any(Number), sha: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(m.files[`${FOLDER}/n.md`].chunks).toEqual([{ id: 'm1', hash: expect.stringMatching(/^[0-9a-f]{64}$/), th: expect.stringMatching(/^[0-9a-f]{16}$/) }])
  })

  it('reads a torn or foreign manifest as empty, and still ends with one entry per chunk', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    fs.writeFileSync(manifestFile(), '{"version":1,"salt":"abc","epoch":0,"files":{"x') // killed mid-write on a filesystem without atomic rename
    const stats = await runClaudeNotesIngest(deps(store))
    expect(stats.chunksWritten).toBe(1) // it no longer knows it stored the note, so it stores it again...
    expect(stats.swept).toBe(1) // ...and then clears the copy it can no longer account for
    expect(store.rows.size).toBe(1)
    for (const text of ['null', '[]', '"x"', '{"version":2}', '{"version":1,"salt":""}', '{"version":1,"salt":"s","epoch":-1}']) {
      fs.writeFileSync(manifestFile(), text)
      await runClaudeNotesIngest(deps(store))
      expect(store.rows.size).toBe(1)
    }
  })

  it('drops a damaged entry in an otherwise good manifest, and sweeps what it can no longer account for', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    const m = manifestJson()
    m.files[`${FOLDER}/n.md`].chunks = [{ id: 7 }]
    m.files['bad/entry.md'] = 'nonsense'
    m.files['also/bad.md'] = { mtimeMs: 'x', size: 1, sha: 's', project: 'p', chunks: [] }
    m.stale = ['gone', 5]
    m.cwds = { ok: 'C:\\ok', bad: 7 }
    fs.writeFileSync(manifestFile(), JSON.stringify(m))
    const stats = await runClaudeNotesIngest(deps(store))
    expect(stats.chunksWritten).toBe(1)
    expect(stats.swept).toBe(1)
    expect(store.rows.size).toBe(1)
    expect(manifestJson().stale).toEqual([])
    expect(manifestJson().cwds).toMatchObject({ ok: 'C:\\ok' })
  })

  it('finishes the removals a killed pass had written ahead, before doing anything else', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    const m = manifestJson()
    const orphanId = [...store.rows.keys()][0]
    m.stale = [orphanId]
    // The state a pass leaves when it is killed after writing the removal ahead: the chunk is off the note
    // and on the stale list, and the note's stamps are cleared so it counts as partly stored.
    m.files[`${FOLDER}/n.md`].chunks = []
    m.files[`${FOLDER}/n.md`].mtimeMs = -1
    m.files[`${FOLDER}/n.md`].size = -1
    m.files[`${FOLDER}/n.md`].sha = ''
    m.epoch = 1
    m.dirty = true
    fs.writeFileSync(manifestFile(), JSON.stringify(m))
    const stats = await runClaudeNotesIngest(deps(store))
    expect(store.removed).toContain(orphanId)
    expect(stats.chunksWritten).toBe(1) // the note is stored again, under a new hash
    expect(store.rows.size).toBe(1)
    expect(manifestJson().stale).toEqual([])
  })

  // The same kill, in the flow where a note is deleted from disk. The removal is written ahead with the manifest as it stands, so
  // the entry must not stand as a complete one while its chunks are on their way out: the same words coming back (a restore from
  // the Recycle Bin keeps the modified time, a git checkout gives a new one and the same hash) would be found unchanged and
  // never imported again, while Settings counts the note as imported.
  describe('a note that is deleted from disk, a removal that is killed, and the same words coming back', () => {
    // Two paragraphs that cannot share a chunk: the note is stored as two copies, so a kill can come between the removal of one and of the other.
    const paragraph = (word: string): string => `${word} `.repeat(200).trim()
    const BODY = `---\nname: a\ndescription: about a\ntype: reference\n---\n${paragraph('alpha')}\n\n${paragraph('omega')}`
    const OTHER = '---\nname: b\ndescription: about b\ntype: feedback\n---\nBeta says another.'

    // The kill is a store call that never returns, after the removal was written ahead and some of the copies are gone. The next pass
    // is a new process, so the lock is reset. A second note keeps the store from being empty, which the pass would take for a reason
    // to start the record over (step 0) and so hide the fault.
    it.each([
      ['before any copy is deleted', 0],
      ['after the first of its two copies is deleted', 1],
    ])('imports the note again when it comes back with the same words (killed %s)', async (_label, deleteBeforeDying) => {
      note(FOLDER, 'a.md', BODY, Date.UTC(2026, 8, 1))
      note(FOLDER, 'b.md', OTHER, Date.UTC(2026, 8, 2))
      session(FOLDER, CWD)
      const store = fakeStore()
      await runClaudeNotesIngest(deps(store))
      const ofA = (): number => [...store.rows.values()].filter((r) => (r.tags ?? []).includes('note:a.md')).length
      expect(ofA()).toBe(2)

      fs.rmSync(path.join(root, FOLDER, 'memory', 'a.md'))
      let removals = 0
      let killed!: () => void
      const dead = new Promise<void>((resolve) => { killed = resolve })
      const dying = {
        ...store,
        remove: async (id: string): Promise<void> => {
          if (removals++ >= deleteBeforeDying) { killed(); return new Promise<void>(() => { /* the process is gone: this never returns */ }) }
          await store.remove(id)
        },
      }
      void runClaudeNotesIngest(deps(dying))
      await dead // not a timer: the pass has made the removals it is going to make
      _resetNotesLockForTests()

      note(FOLDER, 'a.md', BODY, Date.UTC(2026, 8, 5)) // restored: the same words, a newer modified time
      const stats = await runClaudeNotesIngest(deps(store))
      expect(ofA()).toBe(2)
      expect(stats.chunksWritten).toBe(2)
      expect(manifestJson().dirty).toBe(false)
      const claimed = Object.values(manifestJson().files as Record<string, { chunks: unknown[] }>).reduce((n, f) => n + f.chunks.length, 0)
      expect(claimed).toBe(store.rows.size) // what Settings counts is what memory holds
    })
  })

  it('a removal that fails stays on the list and is tried again, without losing the rest of the pass', async () => {
    const p = note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    fs.rmSync(p)
    store.failRemoves(new Error('locked'))
    const failed = await runClaudeNotesIngest(deps(store))
    expect(failed.deleteFailed).toBe(1)
    expect(manifestJson().stale).toHaveLength(1)
    store.failRemoves(null)
    const again = await runClaudeNotesIngest(deps(store))
    expect(store.rows.size).toBe(0)
    expect(again.chunksDeleted).toBe(1)
    expect(manifestJson().stale).toEqual([])
  })

  it('stays dirty after an interrupted pass and is swept once a pass completes', async () => {
    for (let i = 0; i < 3; i++) note(FOLDER, `n${i}.md`, `---\nname: n${i}\n---\nNote ${i}.`)
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store), { maxChunks: 1 })
    expect(manifestJson().dirty).toBe(true)
    await runClaudeNotesIngest(deps(store), { maxChunks: 1 })
    expect(manifestJson().dirty).toBe(true)
    await runClaudeNotesIngest(deps(store), { maxChunks: 5 })
    expect(manifestJson().dirty).toBe(false)
    expect(store.lists.length).toBeGreaterThan(0) // the sweep listed what the store holds
  })

  it('lists one row of the store, and no more, on a pass that was not interrupted and has nothing to account for', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    store.lists.length = 0
    await runClaudeNotesIngest(deps(store))
    // The one question: does the store still hold a note at all (it may have been replaced). Never a walk of all of them.
    expect(store.lists).toEqual([{ agentId: 'claude-notes', limit: 1 }])
  })
})

describe('the sweep: entries the manifest cannot account for', () => {
  it('removes this computer\'s orphans and leaves another computer\'s notes alone', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    store.rows.set('own-orphan', { id: 'own-orphan', ts: 5, agentId: 'claude-notes', source: 'claude-notes', content: 'x', origin: 'me' } as never)
    store.rows.set('peer-note', { id: 'peer-note', ts: 4, agentId: 'claude-notes', source: 'claude-notes', content: 'y', origin: 'laptop' } as never)
    store.rows.set('plain-orphan', { id: 'plain-orphan', ts: 3, agentId: 'claude-notes', source: 'claude-notes', content: 'z' } as never)
    store.rows.set('someone-elses', { id: 'someone-elses', ts: 2, agentId: 'claude-notes', source: 'other', content: 'w' } as never)
    const stats = await runClaudeNotesIngest(deps(store, { ownOrigin: async () => 'me' }))
    expect(stats.swept).toBe(2)
    expect([...store.rows.keys()].filter((k) => k.startsWith('m'))).toHaveLength(1)
    expect(store.rows.has('peer-note')).toBe(true)
    expect(store.rows.has('someone-elses')).toBe(true)
    expect(store.rows.has('own-orphan')).toBe(false)
    expect(store.rows.has('plain-orphan')).toBe(false)
    expect(manifestJson().epoch).toBeGreaterThan(0) // what was removed can no longer be mistaken for what is stored next
  })

  it('treats every entry as its own while the store has no id of its own to compare with', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    for (const ownOrigin of [undefined, async () => undefined]) {
      fs.rmSync(manifestFile(), { force: true })
      const store = fakeStore()
      store.rows.set('x', { id: 'x', ts: 1, agentId: 'claude-notes', source: 'claude-notes', content: 'x', origin: 'other' } as never)
      const stats = await runClaudeNotesIngest(deps(store, { ownOrigin }))
      expect(stats.swept).toBe(1)
    }
  })

  // "I have no id" and "I could not ask" are two answers. The first means the store marks nothing, so every entry is this
  // computer's. The second says nothing about whose entries these are: reading it as the first would let a host that is busy for a
  // moment turn every other computer's copy into one of ours to delete.
  it('removes nothing, and does not call the record settled, while it cannot ask what its own id is', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    store.rows.set('peer', { id: 'peer', ts: 1, agentId: 'claude-notes', source: 'claude-notes', content: 'x', origin: 'laptop' } as never)
    store.rows.set('orphan', { id: 'orphan', ts: 2, agentId: 'claude-notes', source: 'claude-notes', content: 'y', origin: 'me' } as never)
    const stats = await runClaudeNotesIngest(deps(store, { ownOrigin: async () => { throw new Error('host busy') } }))
    expect(stats.swept).toBe(0)
    expect(stats.chunksWritten).toBe(1) // the note on this computer is imported all the same
    expect(store.removed).toEqual([])
    expect(store.rows.has('peer')).toBe(true)
    expect(store.rows.has('orphan')).toBe(true) // not known to be this computer's: it waits until it can be told
    expect(manifestJson().dirty).toBe(true)
    const again = await runClaudeNotesIngest(deps(store, { ownOrigin: async () => 'me' }))
    expect(again.swept).toBe(1) // the answer is back: its own orphan goes, the other computer's copy stays
    expect(store.rows.has('orphan')).toBe(false)
    expect(store.rows.has('peer')).toBe(true)
    expect(manifestJson().dirty).toBe(false)
  })

  it('pages through a store of more notes than one listing holds, whole groups of equal time included', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    // 1,200 orphans in groups of 70 sharing a timestamp, so a page boundary falls inside a group.
    for (let i = 0; i < 1200; i++) store.rows.set(`o${i}`, { id: `o${i}`, ts: 1000 + Math.floor(i / 70), agentId: 'claude-notes', source: 'claude-notes', content: `o${i}` } as never)
    const stats = await runClaudeNotesIngest(deps(store))
    expect(stats.swept).toBe(1200)
    expect(store.rows.size).toBe(1)
  })

  it('leaves the manifest dirty, and removes nothing, when the store cannot be listed', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    store.failList(new Error('host down'))
    const stats = await runClaudeNotesIngest(deps(store))
    expect(stats.chunksWritten).toBe(1)
    expect(stats.swept).toBe(0)
    expect(manifestJson().dirty).toBe(true)
    store.failList(null)
    await runClaudeNotesIngest(deps(store))
    expect(manifestJson().dirty).toBe(false)
  })

  it('a removal that fails during the sweep leaves the manifest dirty for the next pass', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    store.rows.set('o', { id: 'o', ts: 1, agentId: 'claude-notes', source: 'claude-notes', content: 'o' } as never)
    store.failRemoves(new Error('locked'))
    const stats = await runClaudeNotesIngest(deps(store))
    expect(stats.swept).toBe(0)
    expect(manifestJson().dirty).toBe(true)
    expect(manifestJson().stale).toEqual(['o']) // written ahead, still waiting
    store.failRemoves(null)
    const next = await runClaudeNotesIngest(deps(store))
    expect(next.chunksDeleted).toBe(1) // the next pass finishes it before anything else
    expect(store.rows.has('o')).toBe(false)
    expect(manifestJson().dirty).toBe(false)
  })

  it('stops paging when a listing makes no progress', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    store.list = async () => Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, ts: 42, agentId: 'claude-notes', source: 'claude-notes' })) // the same page forever
    const stats = await runClaudeNotesIngest(deps(store))
    expect(stats.chunksWritten).toBe(1)
  })
})

describe('Remove imported notes', () => {
  it('removes every imported note, including ones the manifest lost track of, and starts the manifest over', async () => {
    note(FOLDER, 'a.md', '---\nname: a\n---\nAlpha.')
    note(FOLDER, 'b.md', '---\nname: b\n---\nBeta.')
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    store.rows.set('lost', { id: 'lost', ts: 1, agentId: 'claude-notes', source: 'claude-notes', content: 'x' } as never)
    store.rows.set('keep-me', { id: 'keep-me', ts: 1, agentId: 'claude', source: 'claude', content: 'not a note' } as never)
    const before = manifestJson()
    const res = await removeImportedNotes(deps(store))
    expect(res).toEqual({ removed: 3, failed: 0 })
    expect([...store.rows.keys()]).toEqual(['keep-me'])
    const after = manifestJson()
    expect(after.files).toEqual({})
    expect(after.stale).toEqual([])
    expect(after.epoch).toBeGreaterThan(before.epoch) // what comes back later cannot reuse a hash that was just retired
    expect(after.salt).toBe(before.salt)
    expect(after.cwds).toEqual(before.cwds)
    expect(after.last).toBeNull()
  })

  it('reports what it could not remove and keeps it on the list to try again', async () => {
    note(FOLDER, 'a.md', '---\nname: a\n---\nAlpha.')
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    store.failRemoves(new Error('Memory is locked'))
    const res = await removeImportedNotes(deps(store))
    expect(res).toEqual({ removed: 0, failed: 1 })
    expect(manifestJson().stale).toHaveLength(1)
    store.failRemoves(null)
    expect(await removeImportedNotes(deps(store))).toEqual({ removed: 1, failed: 0 })
    expect(store.rows.size).toBe(0)
  })

  // "Remove imported notes" turns the switch off first, so when memory is locked the removals fail and queue, and the panel
  // says they "will be retried". A pass with the switch off reads nothing and so retries nothing: the tick finishes them.
  describe('finishing a removal that memory being locked left behind', () => {
    async function queued(): Promise<ReturnType<typeof fakeStore>> {
      note(FOLDER, 'a.md', '---\nname: a\n---\nAlpha.')
      session(FOLDER, CWD)
      const store = fakeStore()
      await runClaudeNotesIngest(deps(store))
      store.failRemoves(new Error('Memory is locked'))
      expect(await removeImportedNotes(deps(store, { enabled: () => false }))).toEqual({ removed: 0, failed: 1 })
      store.failRemoves(null)
      return store
    }

    it('removes what is queued once memory opens, though the switch is off, and clears the queue', async () => {
      const store = await queued()
      const res = await finishQueuedRemovals(deps(store, { enabled: () => false }))
      expect(res).toEqual({ removed: 1, failed: 0 })
      expect(store.rows.size).toBe(0)
      expect(manifestJson().stale).toEqual([])
      expect(notesStatus(fileManifest(data)).pending).toBe(0)
    })

    it('reads no folder and no note: it works from this computer\'s own record and the store', async () => {
      const store = await queued()
      const f = spyFs()
      await finishQueuedRemovals(deps(store, { enabled: () => false, fs: f, roots: vi.fn(async () => [root]) }))
      expect(f.calls).toEqual({ list: [], stat: [], real: [], read: [] })
    })

    it('keeps what still cannot be removed on the queue', async () => {
      const store = await queued()
      store.failRemoves(new Error('Memory is locked'))
      expect(await finishQueuedRemovals(deps(store, { enabled: () => false }))).toEqual({ removed: 0, failed: 1 })
      expect(manifestJson().stale).toHaveLength(1)
    })

    it('does nothing, and writes nothing, when nothing is queued', async () => {
      const manifest: NotesManifestIO = { read: vi.fn(() => null), write: vi.fn() }
      const store = fakeStore()
      expect(await finishQueuedRemovals(deps(store, { enabled: () => false, manifest }))).toEqual({ removed: 0, failed: 0 })
      expect(manifest.write).not.toHaveBeenCalled()
      expect(store.removed).toEqual([])
    })

    it('reports a queue it could not even save as failed, and removes nothing', async () => {
      const store = await queued()
      const stale = manifestJson().stale.length
      const res = await finishQueuedRemovals(deps(store, { enabled: () => false, manifest: flakyManifest(0) }))
      expect(res).toEqual({ removed: 0, failed: stale })
      expect(store.rows.size).toBe(1)
    })

    it('waits for a pass in progress, like a removal does, and so never removes the same copy twice', async () => {
      const store = await queued()
      let release: () => void = () => {}
      const gate = new Promise<void>((r) => { release = r })
      const pass = runClaudeNotesIngest(deps(store, { roots: async () => { await gate; return [root] } }))
      const finished = finishQueuedRemovals(deps(store, { enabled: () => false }))
      await new Promise((r) => setTimeout(r, 20))
      expect(store.removed).toEqual([]) // the pass has the line and has not got as far as its own removals
      release()
      await pass
      expect(await finished).toEqual({ removed: 0, failed: 0 }) // the pass finished the queue: nothing was left to do twice
      expect(store.removed).toHaveLength(1)
    })
  })

  it('still removes what the manifest knows when the store cannot be listed, and keeps the manifest dirty', async () => {
    note(FOLDER, 'a.md', '---\nname: a\n---\nAlpha.')
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    store.failList(new Error('host down'))
    expect(await removeImportedNotes(deps(store))).toEqual({ removed: 1, failed: 0 })
    expect(manifestJson().dirty).toBe(true)
  })

  it('leaves another computer\'s notes alone', async () => {
    const store = fakeStore()
    store.rows.set('peer', { id: 'peer', ts: 1, agentId: 'claude-notes', source: 'claude-notes', content: 'x', origin: 'laptop' } as never)
    const res = await removeImportedNotes(deps(store, { ownOrigin: async () => 'me' }))
    expect(res).toEqual({ removed: 0, failed: 0 })
    expect(store.rows.has('peer')).toBe(true)
  })

  it('removes only what the manifest knows, and leaves another computer\'s notes alone, while it cannot ask what its own id is', async () => {
    note(FOLDER, 'a.md', '---\nname: a\n---\nAlpha.')
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    store.rows.set('peer', { id: 'peer', ts: 1, agentId: 'claude-notes', source: 'claude-notes', content: 'x', origin: 'laptop' } as never)
    const res = await removeImportedNotes(deps(store, { ownOrigin: async () => { throw new Error('host busy') } }))
    expect(res).toEqual({ removed: 1, failed: 0 })
    expect([...store.rows.keys()]).toEqual(['peer'])
    expect(manifestJson().dirty).toBe(true) // what the store holds was not seen whole: the next pass checks
  })

  it('works on a computer that never imported anything', async () => {
    expect(await removeImportedNotes(deps(fakeStore()))).toEqual({ removed: 0, failed: 0 })
  })

  it('does not run in the middle of a pass', async () => {
    note(FOLDER, 'a.md', '---\nname: a\n---\nAlpha.')
    session(FOLDER, CWD)
    const store = fakeStore()
    const order: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const slow: NotesStore = { ...store, write: async (i) => { order.push('write'); await gate; return store.write(i) } }
    const pass = runClaudeNotesIngest(deps(slow))
    await vi.waitFor(() => expect(order).toEqual(['write']), { timeout: 10_000 })
    const removal = removeImportedNotes(deps(store)).then((r) => { order.push('removed'); return r })
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toEqual(['write']) // the removal is waiting its turn
    release()
    await pass
    expect(await removal).toEqual({ removed: 1, failed: 0 })
    expect(order).toEqual(['write', 'removed'])
  })

  it('a failed pass does not hold the line for the next one', async () => {
    const store = fakeStore()
    const bad: NotesDeps = deps(store, { roots: async () => { throw new Error('no roots') } })
    await expect(runClaudeNotesIngest(bad)).rejects.toThrow('no roots')
    expect(await runClaudeNotesIngest(deps(store))).toMatchObject({ chunksWritten: 0 })
  })
})

describe('notesStatus: what Settings shows', () => {
  it('counts the notes, their chunks and their projects from the manifest, and says when it last ran', async () => {
    note(FOLDER, 'a.md', '---\nname: a\n---\nAlpha.')
    note(FOLDER, 'b.md', '---\nname: b\n---\nBeta.')
    note('D--other', 'c.md', '---\nname: c\n---\nGamma.')
    note('E--none', 'd.md', '---\nname: d\n---\nDelta.')
    session(FOLDER, CWD)
    session('D--other', 'D:\\other')
    const store = fakeStore()
    const now = () => 1_700_000_000_000
    await runClaudeNotesIngest(deps(store, { now }))
    expect(notesStatus(fileManifest(data))).toEqual({
      notes: 3, chunks: 3, projects: 2, lastAt: 1_700_000_000_000, noProject: 1, secretsRedacted: 0, pending: 0,
    })
  })

  it('is all zeros before the first pass, and when the manifest is unusable', () => {
    const zero = { notes: 0, chunks: 0, projects: 0, lastAt: null, noProject: 0, secretsRedacted: 0, pending: 0 }
    expect(notesStatus(fileManifest(data))).toEqual(zero)
    fs.writeFileSync(manifestFile(), 'not json')
    expect(notesStatus(fileManifest(data))).toEqual(zero)
  })

  it('counts the removals still waiting', async () => {
    note(FOLDER, 'a.md', '---\nname: a\n---\nAlpha.')
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    store.failRemoves(new Error('locked'))
    await removeImportedNotes(deps(store))
    expect(notesStatus(fileManifest(data)).pending).toBe(1)
  })
})

describe('an unreadable store entry never breaks a listing', () => {
  it('ignores listed rows that are not notes', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    const list = store.list.bind(store)
    store.list = async (o) => [...(await list(o)), null as never, 'x' as never, { id: 'no-source' } as never]
    expect(await runClaudeNotesIngest(deps(store))).toMatchObject({ chunksWritten: 1 })
  })
})

// A listing of the store holds at most LIST_PAGE (500) notes, and a page cannot go on past 500 that carry the same time: notes
// copied or extracted together all get one modified time, and the store orders equal times by when they were stored, so no cursor
// falls between them. What one listing cannot reach shows up in the next once the first are gone, so the sweeps list again.
describe('more notes than a listing can reach in one go', () => {
  const T = Date.UTC(2026, 8, 1) // one modified time for every one of them
  const stored = async (store: ReturnType<typeof fakeStore>, n: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      await store.write({
        agentId: 'claude-notes', source: 'claude-notes', kind: 'note', content: `x${i}`, tags: ['type:project'], hash: `x-hash-${i}`,
        importance: 0.8, memoryType: 'summary', project: CWD, ts: T,
      })
    }
  }

  it('Remove imported notes removes all of them when the manifest is gone, not just the first page', async () => {
    const store = fakeStore()
    await stored(store, 1200)
    expect(await removeImportedNotes(deps(store))).toEqual({ removed: 1200, failed: 0 })
    expect(store.rows.size).toBe(0)
    expect(manifestJson().dirty).toBe(false) // the store was seen whole
  })

  it('the sweep that settles an interrupted pass finds them all too', async () => {
    const store = fakeStore()
    await stored(store, 1200)
    const stats = await runClaudeNotesIngest(deps(store)) // a fresh manifest: nothing in the store is accounted for
    expect(stats.swept).toBe(1200)
    expect(store.rows.size).toBe(0)
    expect(manifestJson().dirty).toBe(false)
  })

  it('leaves the manifest dirty when the rounds run out, so the next pass looks again, and a second removal finishes the job', async () => {
    const store = fakeStore()
    await stored(store, 1200)
    expect(await removeImportedNotes(deps(store, { sweepRounds: 1 }))).toEqual({ removed: 1000, failed: 0 }) // the first listing's 500, and one round of 500
    expect(store.rows.size).toBe(200)
    expect(manifestJson().dirty).toBe(true)
    expect(await removeImportedNotes(deps(store))).toEqual({ removed: 200, failed: 0 })
    expect(store.rows.size).toBe(0)
    expect(manifestJson().dirty).toBe(false)
  })

  it('does not call a sweep settled when it ran out of rounds, and does not clear the flag', async () => {
    const store = fakeStore()
    await stored(store, 1200)
    await runClaudeNotesIngest(deps(store, { sweepRounds: 1 }))
    expect(store.rows.size).toBe(200) // a round of 500 for the sweep before the import, and another for the sweep at the end
    expect(manifestJson().dirty).toBe(true)
    await runClaudeNotesIngest(deps(store)) // the next pass carries on
    expect(store.rows.size).toBe(0)
    expect(manifestJson().dirty).toBe(false)
  })

  it('asks for nothing twice: a note whose removal fails is not tried again within the sweep, and is reported', async () => {
    const store = fakeStore()
    await stored(store, 600)
    store.failRemoves(new Error('locked'))
    const res = await removeImportedNotes(deps(store))
    expect(res).toEqual({ removed: 0, failed: 500 }) // the first page; the sweep sees only those 500 again and leaves them
    expect(store.rows.size).toBe(600)
    expect(manifestJson().dirty).toBe(true)
    expect(manifestJson().stale).toHaveLength(500)
  })

  it('a removal that fails in a later round is reported and leaves the manifest dirty', async () => {
    const store = fakeStore()
    await stored(store, 600)
    const remove = store.remove.bind(store)
    let removals = 0
    store.remove = async (id) => { if (++removals > 500) throw new Error('locked'); return remove(id) }
    const res = await removeImportedNotes(deps(store))
    expect(res).toEqual({ removed: 500, failed: 100 })
    expect(manifestJson().dirty).toBe(true)
    expect(manifestJson().stale).toHaveLength(100)
  })

  it('counts what a later round could not write ahead as failed: it is neither removed nor forgotten', async () => {
    const store = fakeStore()
    await stored(store, 600)
    const manifest = flakyManifest(2) // the dirty flag and the queue of the first 500 are saved; the next round's queue is not
    const res = await removeImportedNotes(deps(store, { manifest }))
    expect(res).toEqual({ removed: 500, failed: 100 })
    expect(store.rows.size).toBe(100)
    expect(manifestJson().dirty).toBe(true) // so the next pass finishes the job
    const again = await removeImportedNotes(deps(store))
    expect(again.failed).toBe(0)
    expect(store.rows.size).toBe(0)
    expect(manifestJson().dirty).toBe(false)
  })

  it('stops quietly when the store cannot be listed in a later round', async () => {
    const store = fakeStore()
    await stored(store, 600)
    const list = store.list.bind(store)
    let lists = 0
    store.list = async (o) => { if (++lists > 3) throw new Error('host gone'); return list(o) }
    const res = await removeImportedNotes(deps(store))
    expect(res.failed).toBe(0)
    expect(manifestJson().dirty).toBe(true) // not seen whole: the next pass checks
  })

  it('stops when the manifest cannot be saved in a later round', async () => {
    const store = fakeStore()
    await stored(store, 600)
    const res = await removeImportedNotes(deps(store, { manifest: flakyManifest(1) })) // the first save goes through, the rest fail
    expect(res.removed).toBeLessThanOrEqual(500)
    expect(store.rows.size).toBeGreaterThanOrEqual(100)
  })
})

// "Clear memory" empties the store, so the record of what was imported has to stop claiming it is there (Settings read "N notes are in
// memory" over an empty store), without bringing the notes straight back at the next pass.
describe('Clear memory and the record of imported notes', () => {
  const setup = async (): Promise<ReturnType<typeof fakeStore>> => {
    note(FOLDER, 'a.md', '---\nname: a\ndescription: A\nmetadata:\n  type: reference\n---\nAlpha.')
    note(FOLDER, 'b.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    expect(notesStatus(fileManifest(data)).notes).toBe(2)
    return store
  }
  const clearing = (store: ReturnType<typeof fakeStore>) => async (): Promise<void> => { store.rows.clear() }

  it('runs the clear, and then Settings counts no notes', async () => {
    const store = await setup()
    await clearNotesRecord(deps(store), clearing(store))
    expect(store.rows.size).toBe(0)
    expect(notesStatus(fileManifest(data))).toMatchObject({ notes: 0, chunks: 0, projects: 0, pending: 0 })
  })

  it('keeps when it last looked, and forgets how many secrets were redacted from copies that are gone', async () => {
    const store = await setup()
    const before = notesStatus(fileManifest(data))
    const m = manifestJson()
    m.last.secretsRedacted = 5
    fs.writeFileSync(manifestFile(), JSON.stringify(m))
    await clearNotesRecord(deps(store), clearing(store))
    const after = notesStatus(fileManifest(data))
    expect(after.lastAt).toBe(before.lastAt)
    expect(after.secretsRedacted).toBe(0)
  })

  it('does not bring the notes back at the next pass: an unchanged note is not opened again', async () => {
    const store = await setup()
    await clearNotesRecord(deps(store), clearing(store))
    const opened = spyFs({})
    const read = realNotesFs.read
    const stats = await runClaudeNotesIngest(deps(store, { fs: { ...realNotesFs, read: async (file, max) => { opened.calls.read.push(file); return read(file, max) } } }))
    expect(stats.chunksWritten).toBe(0)
    expect(store.rows.size).toBe(0)
    expect(opened.calls.read.filter((f) => f.endsWith('.md'))).toEqual([]) // no note was opened
  })

  it('imports a note that is edited afterwards, as it does any change', async () => {
    const store = await setup()
    await clearNotesRecord(deps(store), clearing(store))
    note(FOLDER, 'b.md', FEEDBACK + '\n\nAnd a second rule.', Date.UTC(2026, 9, 1))
    expect(await runClaudeNotesIngest(deps(store))).toMatchObject({ filesChanged: 1, chunksWritten: 1 })
    expect(store.rows.size).toBe(1)
    expect(notesStatus(fileManifest(data)).notes).toBe(1)
  })

  it('removes the queued removals from the record: the rows they named are gone with the rest', async () => {
    const store = await setup()
    store.failRemoves(new Error('locked'))
    await removeImportedNotes(deps(store))
    expect(notesStatus(fileManifest(data)).pending).toBe(2)
    store.failRemoves(null)
    await clearNotesRecord(deps(store), clearing(store))
    expect(notesStatus(fileManifest(data)).pending).toBe(0)
  })

  // PRIVACY.md describes the record as existing once notes are imported. A computer that never connected its agents, or never had the
  // switch on, has none, and clearing memory must not make one (it would hold no user data, but it is a file the user was not told of).
  it('makes no record where there was none: the clear runs, no file appears', async () => {
    const store = fakeStore()
    store.rows.set('x', { id: 'x', ts: 1, agentId: 'claude-notes', content: 'x' } as never)
    expect(fs.existsSync(manifestFile())).toBe(false)
    await clearNotesRecord(deps(store), clearing(store))
    expect(store.rows.size).toBe(0)
    expect(fs.existsSync(manifestFile())).toBe(false)
  })

  it('makes no record where the manifest cannot be read either: there is nothing it can say is cleared', async () => {
    const write = vi.fn()
    await clearNotesRecord({ manifest: { read: () => null, write } }, async () => undefined)
    expect(write).not.toHaveBeenCalled()
  })

  it('leaves the record alone when the clear fails, and lets the error through', async () => {
    const store = await setup()
    const before = fs.readFileSync(manifestFile(), 'utf8')
    await expect(clearNotesRecord(deps(store), async () => { throw new Error('store is locked') })).rejects.toThrow('store is locked')
    expect(fs.readFileSync(manifestFile(), 'utf8')).toBe(before)
    expect(notesStatus(fileManifest(data)).notes).toBe(2)
  })

  it('does not undo the clear when the record cannot be saved: the old count stays on screen, nothing throws', async () => {
    const store = await setup()
    await expect(clearNotesRecord({ manifest: flakyManifest(0) }, clearing(store))).resolves.toBeUndefined()
    expect(store.rows.size).toBe(0)
  })

  it('works on a record that does not exist yet', async () => {
    const store = fakeStore()
    await clearNotesRecord(deps(store), async () => {})
    expect(notesStatus(fileManifest(data))).toMatchObject({ notes: 0, lastAt: null })
  })

  it('runs in turn with the passes: a clear that is waiting for a pass does not interleave with it', async () => {
    const store = await setup()
    note(FOLDER, 'c.md', '---\nname: c\n---\nGamma.', Date.UTC(2026, 9, 2))
    const order: string[] = []
    const pass = runClaudeNotesIngest(deps(store, { yield: async () => { order.push('pass') } }))
    const cleared = clearNotesRecord(deps(store), async () => { order.push('clear'); store.rows.clear() })
    await Promise.all([pass, cleared])
    expect(order.lastIndexOf('pass')).toBeLessThan(order.indexOf('clear')) // every step of the pass came first
    expect(store.rows.size).toBe(0)
    expect(notesStatus(fileManifest(data)).notes).toBe(0)
  })
})

// What the manifest carries from one pass to the next, and the guards the documents promise.
describe('what a pass keeps between runs, and what it will not follow', () => {
  const alpha = '---\nname: a\n---\nAlpha.'

  // Claude Code prunes old sessions. After that only the working directory kept in the manifest can place a folder's notes.
  it('remembers the working directory a project folder stands for, after the sessions that named it are gone', async () => {
    note(FOLDER, 'a.md', alpha)
    session(FOLDER, CWD, 'aaaa.jsonl')
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    expect(manifestJson().cwds[FOLDER]).toBe(CWD)
    fs.rmSync(path.join(root, FOLDER, 'aaaa.jsonl'))
    note(FOLDER, 'a.md', '---\nname: a\n---\nAlpha, edited.', Date.UTC(2026, 9, 1))
    expect(await runClaudeNotesIngest(deps(store))).toMatchObject({ noProject: 0, chunksWritten: 1 })
    expect(store.writes[store.writes.length - 1].project).toBe(CWD)
  })

  it('without that memory, a folder whose sessions are gone is left out and counted', async () => {
    note(FOLDER, 'a.md', alpha)
    const store = fakeStore()
    expect(await runClaudeNotesIngest(deps(store))).toMatchObject({ noProject: 1, chunksWritten: 0 })
  })

  it('reads a manifest of a version it does not know as no manifest at all, and sweeps the copies it cannot account for', async () => {
    note(FOLDER, 'a.md', alpha)
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    const m = manifestJson()
    m.version = 2
    fs.writeFileSync(manifestFile(), JSON.stringify(m))
    expect(notesStatus(fileManifest(data))).toMatchObject({ notes: 0, chunks: 0 })
    const stats = await runClaudeNotesIngest(deps(store))
    expect(stats).toMatchObject({ chunksWritten: 1, swept: 1 }) // read again under a new salt; the first copy had no record
    expect(store.rows.size).toBe(1)
    expect(manifestJson().version).toBe(1)
  })

  it('reads a manifest with an empty salt, a negative epoch or no files as no manifest', () => {
    for (const bad of [{ salt: '' }, { epoch: -1 }, { files: null }]) {
      fs.writeFileSync(manifestFile(), JSON.stringify({ version: 1, salt: 's', epoch: 0, dirty: false, files: {}, stale: [], cwds: {}, last: { at: 1, filesSeen: 1, noProject: 0, secretsRedacted: 0 }, ...bad }))
      expect(notesStatus(fileManifest(data)).lastAt).toBeNull()
    }
  })

  // On Windows the path from one drive's folder to another drive's is an absolute path with no `..` in it, which a naive "does it climb out"
  // test lets through. A notes folder, or a note, that is a link to another drive is outside the projects folder like any other.
  describe.runIf(process.platform === 'win32')('a link to another drive', () => {
    const other = (): string => (root.slice(0, 1).toUpperCase() === 'D' ? 'C' : 'D') + ':\\elsewhere'
    const memoryDir = (): string => path.join(root, 'P', 'memory')

    it('is not followed when it is the notes folder', async () => {
      const f = spyFs({
        dirs: { [root]: [{ name: 'P', kind: 'dir' }], [memoryDir()]: [{ name: 'a.md', kind: 'file' }] },
        reals: { [memoryDir()]: `${other()}\\memory` },
        stats: { [path.join(memoryDir(), 'a.md')]: { size: 10, mtimeMs: 1 } },
      })
      const found = await findNotes([root], f)
      expect(found.notes).toEqual([])
      expect(found.skipped.links).toBe(1)
      expect(f.calls.list).toEqual([root]) // the folder behind the link was never listed
    })

    it('is not followed when it is a note', async () => {
      const f = spyFs({
        dirs: { [root]: [{ name: 'P', kind: 'dir' }], [memoryDir()]: [{ name: 'a.md', kind: 'link' }] },
        reals: { [path.join(memoryDir(), 'a.md')]: `${other()}\\a.md` },
        stats: { [path.join(memoryDir(), 'a.md')]: { size: 10, mtimeMs: 1 } },
      })
      const found = await findNotes([root], f)
      expect(found.notes).toEqual([])
      expect(found.skipped.links).toBe(1)
      expect(f.calls.stat).toEqual([]) // and it was not even sized
    })
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
// Round 3: what a pass does when the user takes the grant back in its middle, when the manifest knows nothing, when the store
// was replaced under it, and the edges of a listing it relies on.
// ---------------------------------------------------------------------------------------------------------------------------

/** `count` notes on disk, each of its own wording, each one chunk, in one project folder with a transcript. */
function seedNotes(count: number, mtime = (i: number): number => Date.UTC(2026, 8, 1 + i)): void {
  for (let i = 0; i < count; i++) note(FOLDER, `rule_${i}.md`, FEEDBACK.replace('Invalidate on write, not on a timer.', `Rule number ${i}: invalidate on write, and only then, because a timer serves stale data (${i}).`), mtime(i))
  session(FOLDER, CWD)
}

describe('a pass stops the moment the user takes the grant back', () => {
  it('opens no further note and stores no further chunk once the answer has become no', async () => {
    seedNotes(6)
    const store = fakeStore()
    let granted = true
    const stored = store.write.bind(store)
    store.write = async (i) => { const row = await stored(i); granted = false; return row } // the user disconnects as the first copy is stored
    const reads: string[] = []
    const watched: NotesFs = { ...realNotesFs, read: async (file, max) => { reads.push(file); return realNotesFs.read(file, max) } }
    const stats = await runClaudeNotesIngest(deps(store, { connected: () => granted, fs: watched }))
    expect(reads.filter((file) => file.endsWith('.md'))).toHaveLength(1) // the session transcript is read too, to find the project
    expect(store.rows.size).toBe(1)
    expect(stats.chunksWritten).toBe(1)
  })

  it('leaves the rest for the next pass, which reads nothing while the answer stays no and finishes when it is yes again', async () => {
    seedNotes(6)
    const store = fakeStore()
    let granted = true
    let flipped = false
    const stored = store.write.bind(store)
    store.write = async (i) => { const row = await stored(i); if (!flipped) { flipped = true; granted = false } return row }
    await runClaudeNotesIngest(deps(store, { connected: () => granted }))
    const reads: string[] = []
    const watched: NotesFs = { ...realNotesFs, read: async (file, max) => { reads.push(file); return realNotesFs.read(file, max) } }
    const idle = await runClaudeNotesIngest(deps(store, { connected: () => granted, fs: watched }))
    expect(idle.idle).toBe('not-connected')
    expect(reads).toEqual([])
    expect(store.rows.size).toBe(1)
    granted = true
    await runClaudeNotesIngest(deps(store, { connected: () => granted }))
    expect(store.rows.size).toBe(6) // each note once: the first copy is still the first copy
    expect(notesStatus(fileManifest(data)).notes).toBe(6)
  })

  it('asks about the grant for a note it is about to open, and not for one it passes over unchanged', async () => {
    seedNotes(6)
    const store = fakeStore()
    const connected = vi.fn(() => true)
    await runClaudeNotesIngest(deps(store, { connected }))
    expect(connected).toHaveBeenCalledTimes(1 + 6) // the pass, then each of the six notes it opened
    connected.mockClear()
    await runClaudeNotesIngest(deps(store, { connected }))
    expect(connected).toHaveBeenCalledTimes(1) // nothing changed: the pass alone
  })
})

describe('a manifest that knows nothing is told apart from the store before the notes are imported again', () => {
  /** The store with every write and removal logged, in order. */
  const logged = (store: ReturnType<typeof fakeStore>, events: string[]): NotesStore => ({
    write: async (i) => { events.push('write'); return store.write(i) },
    remove: async (id) => { events.push('remove'); return store.remove(id) },
    list: (o) => store.list(o),
  })

  it('removes every copy the lost manifest cannot account for before it stores the new ones', async () => {
    seedNotes(3)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    expect(store.rows.size).toBe(3)
    fs.rmSync(manifestFile()) // the manifest is lost; the store is not
    const events: string[] = []
    await runClaudeNotesIngest(deps(logged(store, events)))
    expect(events.filter((e) => e === 'remove')).toHaveLength(3)
    expect(events.lastIndexOf('remove')).toBeLessThan(events.indexOf('write')) // none of the old copies is left to hide behind the new ones
    expect(store.rows.size).toBe(3)
    expect(manifestJson().dirty).toBe(false)
  })

  it('does not do it on the first import, where the store holds nothing of the notes', async () => {
    seedNotes(3)
    const store = fakeStore()
    const events: string[] = []
    await runClaudeNotesIngest(deps(logged(store, events)))
    expect(events).toEqual(['write', 'write', 'write'])
    expect(store.removed).toEqual([])
  })

  it('does not do it to a manifest that knows its notes: an interrupted import leaves its copies in use until it is finished', async () => {
    seedNotes(6)
    const store = fakeStore()
    const first = await runClaudeNotesIngest(deps(store), { maxChunks: 2 })
    expect(first.truncated).toBe(true)
    expect(manifestJson().dirty).toBe(true)
    const events: string[] = []
    await runClaudeNotesIngest(deps(logged(store, events)))
    expect(events).toEqual(['write', 'write', 'write', 'write']) // the four it still lacked; the two it had are not touched
    expect(store.rows.size).toBe(6)
    expect(store.removed).toEqual([])
  })

  it('leaves the old copies and says so when the manifest cannot be written ahead of removing them', async () => {
    seedNotes(3)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    fs.rmSync(manifestFile())
    const stats = await runClaudeNotesIngest(deps(store, { manifest: flakyManifest(0) }))
    expect(stats.manifestFailed).toBe(true)
    expect(store.removed).toEqual([])
    expect(store.rows.size).toBe(3) // nothing written either: a manifest that cannot be saved ends the pass
  })

  it('carries on to the import when the store cannot be listed, and the end of the pass tries again', async () => {
    seedNotes(3)
    const store = fakeStore()
    store.failList(new Error('host down'))
    const stats = await runClaudeNotesIngest(deps(store))
    expect(stats.chunksWritten).toBe(3)
    expect(manifestJson().dirty).toBe(true) // the store was never seen whole
  })
})

describe('a store that was replaced under the manifest', () => {
  it('is imported into again: a store with none of the notes the manifest says it holds', async () => {
    seedNotes(3)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    store.rows.clear() // a new memory key, a restored data folder, a log deleted by hand
    const stats = await runClaudeNotesIngest(deps(store))
    expect(stats.chunksWritten).toBe(3)
    expect(store.rows.size).toBe(3)
    expect(notesStatus(fileManifest(data))).toMatchObject({ notes: 3, chunks: 3, pending: 0 })
  })

  it('starts from the store as it is: nothing is removed, and nothing doubles up', async () => {
    seedNotes(3)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    store.rows.clear()
    await runClaudeNotesIngest(deps(store))
    expect(store.rows.size).toBe(3)
    expect(store.removed).toEqual([])
  })

  // A store with no imported note may have been emptied by its owner one memory at a time, which retires each content hash for
  // good (a copy stored under one is dropped at the next restart). So the record starts over under a new epoch: the copies it
  // stores are not any hash an earlier epoch could have retired.
  it('moves the epoch on when the record starts over, so the new copies carry hashes the old ones did not', async () => {
    seedNotes(3)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    const before = { epoch: manifestJson().epoch, hashes: store.writes.map((w) => w.hash) }
    store.rows.clear()
    await runClaudeNotesIngest(deps(store))
    expect(manifestJson().epoch).toBeGreaterThan(before.epoch)
    const fresh = store.writes.slice(before.hashes.length).map((w) => w.hash)
    expect(fresh).toHaveLength(3)
    expect(fresh.filter((h) => before.hashes.includes(h))).toEqual([])
  })

  it('is not an ordinary pass\'s business to move the epoch: a store that still holds a note keeps its hashes', async () => {
    seedNotes(3)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    const epoch = manifestJson().epoch
    await runClaudeNotesIngest(deps(store))
    expect(manifestJson().epoch).toBe(epoch)
  })

  // The listing that said "none" could be wrong. Then the store does hold the copies, and the new ones (new hashes) would sit
  // beside them: the record is dirty, so the copies the record cannot account for go BEFORE the new ones are stored.
  it('sweeps the copies a wrong listing hid, so they do not double up with the new ones', async () => {
    seedNotes(3)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    const held = [...store.rows.keys()]
    const list = store.list
    let lied = false
    store.list = async (o) => { if (!lied && o.limit === 1) { lied = true; return [] } return list(o) } // only the one-row look is wrong
    const stats = await runClaudeNotesIngest(deps(store))
    expect(lied).toBe(true)
    expect(stats.swept).toBe(3)
    expect(stats.chunksWritten).toBe(3)
    expect([...store.rows.keys()].filter((id) => held.includes(id))).toEqual([]) // the old copies are gone
    expect(store.rows.size).toBe(3)
    expect(manifestJson().dirty).toBe(false) // settled
  })

  it('leaves the record dirty when the pass is cut short right after it started over', async () => {
    seedNotes(3)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    store.rows.clear()
    await runClaudeNotesIngest(deps(store, { stopped: () => true })) // the app is quitting: nothing is stored, nothing is swept
    expect(manifestJson()).toMatchObject({ dirty: true, files: {} })
    expect(store.rows.size).toBe(0)
    await runClaudeNotesIngest(deps(store)) // the next pass imports them, and settles
    expect(store.rows.size).toBe(3)
    expect(manifestJson().dirty).toBe(false)
  })

  it('is not mistaken for an ordinary pass: a store that still holds a note is left alone', async () => {
    seedNotes(3)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    const stats = await runClaudeNotesIngest(deps(store))
    expect(stats.chunksWritten).toBe(0)
    expect(store.writes).toHaveLength(3)
  })

  it('changes nothing when the store cannot be listed: that says nothing about what it holds', async () => {
    seedNotes(3)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    const before = manifestJson()
    store.failList(new Error('host down'))
    const stats = await runClaudeNotesIngest(deps(store))
    expect(stats.chunksWritten).toBe(0)
    expect(manifestJson().files).toEqual(before.files)
  })

  it('is not looked for when the manifest holds no chunk: there is nothing to compare, and the pass asks the store nothing', async () => {
    note(FOLDER, 'empty.md', '---\nname: nothing\n---\n')
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store)) // a complete pass over a note with no text: settled, and no chunk on record
    expect(manifestJson().dirty).toBe(false)
    const listsBefore = store.lists.length
    await runClaudeNotesIngest(deps(store))
    expect(store.lists.length).toBe(listsBefore)
  })

  it('does not undo Clear memory: its record keeps the notes it saw but not their chunks', async () => {
    seedNotes(3)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    await clearNotesRecord({ manifest: fileManifest(data) }, async () => { store.rows.clear() })
    const stats = await runClaudeNotesIngest(deps(store))
    expect(stats.chunksWritten).toBe(0)
    expect(store.rows.size).toBe(0)
  })
})

describe('the edges of the listing a sweep relies on', () => {
  const noteRow = (id: string, ts: number): StoredNote => ({ id, ts, agentId: 'claude-notes', source: 'claude-notes', content: id } as unknown as StoredNote)

  it('reaches the notes that share the oldest time of a full page, when they do not all fit in it', async () => {
    const store = fakeStore()
    for (let i = 0; i < 470; i++) store.rows.set(`n${i}`, noteRow(`n${i}`, 1_000_000 - i))
    for (let i = 0; i < 50; i++) store.rows.set(`t${i}`, noteRow(`t${i}`, 1_000)) // 30 of these fit in the page of 500; 20 do not
    const result = await removeImportedNotes(deps(store, { sweepRounds: 1 }))
    expect(result.removed).toBe(520)
    expect(store.rows.size).toBe(0)
    expect(manifestJson().dirty).toBe(false) // one round saw them all: nothing was left for a second to find
  })

  it('treats a chunk with no id on the manifest as untrustworthy: the entry is dropped, the record is dirty, the note is imported again', async () => {
    seedNotes(1)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    const m = manifestJson()
    const key = Object.keys(m.files)[0]
    m.files[key].chunks[0].id = ''
    fs.writeFileSync(manifestFile(), JSON.stringify(m))
    const stats = await runClaudeNotesIngest(deps(store))
    expect(stats.filesChanged).toBe(1) // not unchanged: the entry could not be trusted
    const after = manifestJson()
    expect(after.files[key].chunks[0].id).not.toBe('')
    expect(after.files[key].chunks[0].id).toBe([...store.rows.keys()][0])
    expect(store.rows.size).toBe(1)
  })
})

describe('a store that was replaced, when other computers\' notes are in it (memory sync)', () => {
  const peerRow = (id: string, ts: number): StoredNote => ({ id, ts, agentId: 'claude-notes', source: 'claude-notes', origin: 'peer-1', content: id } as unknown as StoredNote)
  const NEWER = Date.UTC(2030, 0, 1)
  const me = { ownOrigin: async () => 'me' }
  const imported = async (): Promise<ReturnType<typeof fakeStore>> => {
    seedNotes(3)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store, me))
    return store
  }

  it('looks through them for this computer\'s own copies, and imports again when it has none', async () => {
    const store = await imported()
    store.rows.clear()
    store.rows.set('p1', peerRow('p1', NEWER)) // newer than anything of ours, so it is the one row a quick look sees
    const stats = await runClaudeNotesIngest(deps(store, me))
    expect(stats.chunksWritten).toBe(3)
    expect(store.rows.has('p1')).toBe(true) // a peer's note is theirs: it stays
    expect([...store.rows.values()].filter((r) => (r as { origin?: string }).origin === undefined)).toHaveLength(3)
  })

  it('leaves the record alone when its own copies are still there, behind a newer one of a peer\'s', async () => {
    const store = await imported()
    store.rows.set('p1', peerRow('p1', NEWER))
    const stats = await runClaudeNotesIngest(deps(store, me))
    expect(stats.chunksWritten).toBe(0)
    expect(store.rows.size).toBe(4)
  })

  it('asks for one row, and no more, when the newest is its own', async () => {
    const store = await imported()
    store.lists.length = 0
    await runClaudeNotesIngest(deps(store, me))
    expect(store.lists).toEqual([{ agentId: 'claude-notes', limit: 1 }])
  })

  it('counts any row as its own while it does not know its own id', async () => {
    const store = await imported()
    store.rows.clear()
    store.rows.set('p1', peerRow('p1', NEWER))
    const stats = await runClaudeNotesIngest(deps(store)) // no ownOrigin: nothing says this row is not ours
    expect(stats.chunksWritten).toBe(0)
  })

  it('changes nothing when the look through them fails', async () => {
    const store = await imported()
    store.rows.clear()
    store.rows.set('p1', peerRow('p1', NEWER))
    const before = manifestJson().files
    const listed = store.list.bind(store)
    let n = 0
    store.list = async (o) => { if (++n > 1) throw new Error('host down'); return listed(o) }
    const stats = await runClaudeNotesIngest(deps(store, me))
    expect(stats.chunksWritten).toBe(0)
    expect(manifestJson().files).toEqual(before)
  })
})

describe('a pass over a record that is clean and knows no note', () => {
  // Nothing can be left over by an interrupted pass or a lost record, so nothing is looked for: with no note on this computer
  // (the usual state of a user whose projects keep none) the 30-minute pass costs no listing of the store at all.
  it('does not list the store', async () => {
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store)) // nothing on disk: the first pass settles an empty record
    expect(manifestJson().dirty).toBe(false)
    store.lists.length = 0
    const stats = await runClaudeNotesIngest(deps(store))
    expect(stats.chunksWritten).toBe(0)
    expect(store.lists).toEqual([])
  })

  it('does look, before anything is imported, once the record is dirty', async () => {
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    const m = manifestJson()
    m.dirty = true // an interrupted pass, or a record that could not be read, leaves this behind
    fs.writeFileSync(manifestFile(), JSON.stringify(m))
    store.lists.length = 0
    await runClaudeNotesIngest(deps(store))
    expect(store.lists.length).toBeGreaterThan(0)
  })
})

describe('the sweep before an import, and a removal that has just failed', () => {
  it('does not try it a second time in the same pass: the queue of removals made it once, and left it queued', async () => {
    seedNotes(2)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    const ids = [...store.rows.keys()]
    const m = manifestJson()
    m.files = {} // a record that lost track of its notes, with their removal already queued by a pass that was killed
    m.stale = ids
    m.dirty = true
    fs.writeFileSync(manifestFile(), JSON.stringify(m))
    store.failRemoves(new Error('memory is locked'))
    let attempts = 0
    const remove = store.remove.bind(store)
    store.remove = async (id) => { attempts++; return remove(id) }
    await runClaudeNotesIngest(deps(store))
    expect(attempts).toBe(ids.length) // once each, from the queue; the sweep that follows leaves them to it
    expect([...manifestJson().stale].sort()).toEqual([...ids].sort()) // and they stay queued for the next pass
    expect(manifestJson().dirty).toBe(true) // so the record is not called settled
  })
})

// A brain export from another computer brings that computer's copies of its saved notes. They carry no mark of who made them and this
// computer's record has never heard of them. A pass takes the entries it cannot account for for stale copies of its own only when it has
// reason to look (a record that is new, lost or left unfinished by an interrupted pass), and then replaces them with copies made from the
// notes on THIS computer; with a whole record it does not look, and they stay. PRIVACY.md and the documentation say so, and say to turn the
// import off first to keep them in the first case. (Once memory sync stamps whose an entry is, the strangers are no longer taken for this
// computer's in any case, and those sentences change with it: the notes at the top of claudeNotesIngest.ts's `ownedBy` say what to re-read.)
describe('copies that came in with a brain import from another computer', () => {
  const imported = (): Array<StoredNote & { content: string }> => [1, 2, 3].map((n) => ({
    id: `brain${n}`, ts: 5_000 + n, agentId: 'claude-notes', source: 'claude-notes', content: `a note of the other computer, number ${n}`,
    tags: ['type:reference', `note:other${n}.md`],
  } as unknown as StoredNote & { content: string }))

  it('are removed by the first pass here when this computer has no record yet, which imports its own notes in their place', async () => {
    seedNotes(3)
    const store = fakeStore()
    for (const r of imported()) store.rows.set(r.id, r)
    const stats = await runClaudeNotesIngest(deps(store)) // this computer has no record yet
    expect(stats.swept).toBe(3)
    expect(store.removed.sort()).toEqual(['brain1', 'brain2', 'brain3'])
    expect(stats.chunksWritten).toBe(3)
    expect([...store.rows.keys()].filter((id) => id.startsWith('brain'))).toEqual([])
    expect(store.rows.size).toBe(3)
  })

  // The documents say what happens to a computer that already has its record: nothing. It knows which copies are its own, the
  // others are not among them, and a pass that finds nothing unfinished does not go looking for strangers.
  it('stay beside this computer\'s own copies when it has imported before and its record is whole', async () => {
    seedNotes(3)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store)) // its own three; the pass settles the record
    expect(manifestJson().dirty).toBe(false)
    for (const r of imported()) store.rows.set(r.id, r)
    store.lists.length = 0
    const stats = await runClaudeNotesIngest(deps(store))
    expect(stats.swept).toBe(0)
    expect(stats.chunksWritten).toBe(0)
    expect(store.removed).toEqual([])
    expect(store.rows.size).toBe(6)
    expect(manifestJson().dirty).toBe(false)
    // and it did not even look: one row asked for to see that the store still holds a note of its own, never a walk of all of them
    expect(store.lists).toEqual([{ agentId: 'claude-notes', limit: 1 }])
  })

  it('are removed by the next pass when the record was left unfinished by an interrupted pass, and this computer\'s own stay', async () => {
    seedNotes(3)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    const own = [...store.rows.keys()]
    for (const r of imported()) store.rows.set(r.id, r)
    const m = manifestJson()
    m.dirty = true // what a pass cut short leaves behind
    fs.writeFileSync(manifestFile(), JSON.stringify(m))
    const stats = await runClaudeNotesIngest(deps(store))
    expect(stats.swept).toBe(3)
    expect([...store.rows.keys()].sort()).toEqual([...own].sort())
    expect(stats.chunksWritten).toBe(0) // nothing of its own was missing: it only took the strangers out
    expect(manifestJson().dirty).toBe(false)
  })

  it('go with the rest when Remove imported notes is used (nothing marks whose they are, so they are taken for this computer\'s)', async () => {
    seedNotes(3)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    for (const r of imported()) store.rows.set(r.id, r)
    expect(await removeImportedNotes(deps(store))).toEqual({ removed: 6, failed: 0 })
    expect(store.rows.size).toBe(0)
  })

  it('stay for as long as the import is off, which is what the documentation says to do first', async () => {
    seedNotes(3)
    const store = fakeStore()
    for (const r of imported()) store.rows.set(r.id, r)
    const stats = await runClaudeNotesIngest(deps(store, { enabled: () => false }))
    expect(stats.idle).toBe('off')
    expect(store.removed).toEqual([])
    expect(store.rows.size).toBe(3)
  })
})
