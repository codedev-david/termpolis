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
  fileManifest,
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
    const found = await findNotes([root], realNotesFs)
    expect(found.notes).toEqual([])
    expect([...found.folders]).toEqual(['bare'])
    expect([...found.listed]).toEqual(['bare']) // it was read, and holds no notes folder: whatever was imported from it is gone
  })

  // A project folder with no notes folder is "listed" (nothing in it) only when that was SEEN: the project folder read fine
  // and has no entry called memory. Anything short of that is unknown, and unknown removes nothing.
  describe('a project folder with no notes folder to read', () => {
    const memoryDir = (): string => path.join(root, 'P', 'memory')
    const seen = (entries: Array<{ name: string; kind: 'file' | 'dir' | 'link' | 'other' }> | null) =>
      spyFs({ dirs: { [root]: [{ name: 'P', kind: 'dir' }], [path.join(root, 'P')]: entries }, reals: { [memoryDir()]: null } })

    it('is listed, empty, when the project folder reads fine and holds no notes folder', async () => {
      const found = await findNotes([root], seen([{ name: 'aaaa.jsonl', kind: 'file' }]))
      expect([...found.listed]).toEqual(['P'])
      expect(found.notes).toEqual([])
    })

    it('is not listed when the project folder cannot be read', async () => {
      expect([...(await findNotes([root], seen(null))).listed]).toEqual([])
    })

    it('is not listed when there is an entry called memory that cannot be resolved (a dangling link, a drive not mounted)', async () => {
      expect([...(await findNotes([root], seen([{ name: 'memory', kind: 'link' }]))).listed]).toEqual([])
    })

    it('is not listed when the entry is spelt in another case, which a case-sensitive disk keeps apart', async () => {
      expect([...(await findNotes([root], seen([{ name: 'Memory', kind: 'dir' }]))).listed]).toEqual([])
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

  it('does not list the store at all on a pass that was not interrupted and has nothing to account for', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    const store = fakeStore()
    await runClaudeNotesIngest(deps(store))
    store.lists.length = 0
    await runClaudeNotesIngest(deps(store))
    expect(store.lists).toEqual([])
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

  it('treats every entry as its own when this computer\'s origin is unknown or cannot be asked', async () => {
    note(FOLDER, 'n.md', FEEDBACK)
    session(FOLDER, CWD)
    for (const own of [undefined, 'throws'] as const) {
      fs.rmSync(manifestFile(), { force: true })
      const store = fakeStore()
      store.rows.set('x', { id: 'x', ts: 1, agentId: 'claude-notes', source: 'claude-notes', content: 'x', origin: 'other' } as never)
      const stats = await runClaudeNotesIngest(deps(store, { ownOrigin: own === 'throws' ? async () => { throw new Error('no status') } : undefined }))
      expect(stats.swept).toBe(1)
    }
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
