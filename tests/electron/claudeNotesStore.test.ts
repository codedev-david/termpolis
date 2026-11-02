// @vitest-environment node
// Claude Code's saved notes against the REAL memory store: the behaviours a fake cannot show. A deleted
// memory's content hash is retired for good (the store drops any later entry with that hash when it
// reloads), so every edit-back, re-import and killed pass below is checked across a restart of the store.
// Every note and secret-looking string here is synthetic (repeated characters, so push protection and
// entropy rules leave them alone); every folder is a temp folder.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// aiSecurity reads app.getPath('userData') at init: give it a folder of its own.
const secDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-sec-'))
vi.mock('electron', () => ({ app: { getPath: () => secDir } }))
vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import {
  _resetForTests,
  _setEmbeddingsAvailable,
  initSwarmMemory,
  memoryCount,
  memoryDelete,
  memoryList,
  memorySearch,
  memoryWrite,
  normalizeProjectSlug,
  projectKeyOf,
  setMemoryScrubber,
} from '../../src/main/swarmMemory'
import { getSettings, scanText, setMemoryScrub } from '../../src/main/aiSecurity'
import {
  NOTES_MANIFEST_FILE,
  _resetNotesLockForTests,
  fileManifest,
  notesStatus,
  removeImportedNotes,
  runClaudeNotesIngest,
  type NotesDeps,
  type NotesStore,
} from '../../src/main/claudeNotesIngest'
import { encodeProjectFolder } from '../../src/main/claudeNotesParse'
import type { McpToolHandlers } from '../../src/main/mcpServer'
import { CWD, FEEDBACK, FOLDER, data, deps, manifestJson, note, root, session, setupWorld, teardownWorld } from './_claudeNotesHarness'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))
const { executeTool } = await import('../../src/main/mcpServer')

const FAKE_KEY = 'AKIA' + 'A'.repeat(16)
const productionScrubber = (content: string) => (getSettings().memoryScrub ? scanText(content) : { redacted: content, hitCount: 0 })

let storeDir = ''

function openStore(): void {
  _resetForTests()
  initSwarmMemory(storeDir)
  _setEmbeddingsAvailable(false) // keyword search unless a test says otherwise
  setMemoryScrub(true)
  setMemoryScrubber(productionScrubber)
}

/** The store as the pass sees it: the real one. */
const realStore: NotesStore = {
  write: (i) => memoryWrite(i),
  remove: async (id) => memoryDelete(id),
  list: async (o) => memoryList(o),
}

/** Everything stored under the notes' author, newest first. */
const stored = () => memoryList({ agentId: 'claude-notes', limit: 500 })
/** Close the store and open it again from disk, as a restart does. */
const restart = (): void => openStore()

const at = (day: number): number => Date.UTC(2026, 8, day)
function touch(p: string, day: number): void {
  fs.utimesSync(p, new Date(at(day)), new Date(at(day)))
}

beforeEach(() => {
  setupWorld()
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-store-'))
  openStore()
})

afterEach(() => {
  _resetForTests()
  teardownWorld()
  fs.rmSync(storeDir, { recursive: true, force: true })
})

afterAll(() => {
  fs.rmSync(secDir, { recursive: true, force: true })
})

describe('what a first pass stores', () => {
  it('one entry per chunk, with the fields the notes are stored with, under the project the folder belongs to', async () => {
    const file = note(FOLDER, 'feedback_widget.md', FEEDBACK)
    session(FOLDER, CWD)
    const stats = await runClaudeNotesIngest(deps(realStore))
    expect(stats).toMatchObject({ chunksWritten: 1, filesChanged: 1 })
    const rows = stored()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      agentId: 'claude-notes',
      source: 'claude-notes',
      kind: 'decision',
      importance: 0.9,
      memoryType: 'summary',
      tags: ['type:feedback', 'note:feedback_widget.md'],
      project: normalizeProjectSlug(CWD),
      projectKey: projectKeyOf(CWD),
    })
    expect(rows[0].content).toBe('widget_cache_rules \u2014 How the widget cache is invalidated\n\nInvalidate on write, not on a timer.')
    expect(rows[0].ts).toBe(Math.floor(fs.statSync(file).mtimeMs) === rows[0].ts ? rows[0].ts : fs.statSync(file).mtimeMs)
    expect(Math.abs(rows[0].ts - fs.statSync(file).mtimeMs)).toBeLessThan(1)
  })

  it('a second pass stores nothing, and the notes survive a restart of the store', async () => {
    note(FOLDER, 'a.md', '---\nname: a\ntype: reference\n---\nAlpha text.')
    note(FOLDER, 'b.md', '---\nname: b\ntype: user\n---\nBeta text.')
    session(FOLDER, CWD)
    await runClaudeNotesIngest(deps(realStore))
    expect((await runClaudeNotesIngest(deps(realStore))).chunksWritten).toBe(0)
    const before = stored().map((r) => r.id).sort()
    restart()
    expect(stored().map((r) => r.id).sort()).toEqual(before)
    expect(before).toHaveLength(2)
  })

  it('never uses the kind `message`, so the idle decay pass that forgets cold messages leaves notes alone', async () => {
    for (const t of ['reference', 'feedback', 'user', 'project']) note(FOLDER, `${t}.md`, `---\nname: ${t}\ntype: ${t}\n---\nText of ${t}.`)
    session(FOLDER, CWD)
    await runClaudeNotesIngest(deps(realStore))
    expect(stored().map((r) => r.kind).sort()).toEqual(['decision', 'fact', 'fact', 'note'])
  })
})

describe('the store retires a deleted memory\'s hash for good: edits, removals and re-imports must still survive a restart', () => {
  const WORDS_A = 'Invalidate on write, never on a timer, because a timer hides stale reads.'
  const WORDS_B = 'Invalidate on write and on a schedule, because the cache also serves other readers.'
  const body = (words: string): string => `---\nname: cache\ndescription: when to invalidate\ntype: reference\n---\n${words}`

  it('a note edited back to wording it had before is still there after a restart', async () => {
    const p = note(FOLDER, 'cache.md', body(WORDS_A))
    session(FOLDER, CWD)
    await runClaudeNotesIngest(deps(realStore))

    fs.writeFileSync(p, body(WORDS_B)); touch(p, 2)
    await runClaudeNotesIngest(deps(realStore))
    expect(stored().map((r) => r.content).join('\n')).toContain('schedule')

    fs.writeFileSync(p, body(WORDS_A)); touch(p, 3) // back to the first wording
    await runClaudeNotesIngest(deps(realStore))
    expect(stored()).toHaveLength(1)
    expect(stored()[0].content).toContain('never on a timer')

    restart() // the store reloads from disk, applying every tombstone it holds
    expect(stored()).toHaveLength(1)
    expect(stored()[0].content).toContain('never on a timer')
    expect(stored()[0].content).not.toContain('schedule')
  })

  it('a note removed and imported again is there after a restart', async () => {
    note(FOLDER, 'cache.md', body(WORDS_A))
    session(FOLDER, CWD)
    await runClaudeNotesIngest(deps(realStore))
    expect(await removeImportedNotes(deps(realStore))).toEqual({ removed: 1, failed: 0 })
    expect(stored()).toHaveLength(0)

    const again = await runClaudeNotesIngest(deps(realStore)) // the switch is back on
    expect(again.chunksWritten).toBe(1)
    restart()
    expect(stored()).toHaveLength(1)
    expect(stored()[0].content).toContain('never on a timer')
  })

  it('a note deleted and recreated with the same words is there after a restart', async () => {
    const p = note(FOLDER, 'cache.md', body(WORDS_A))
    session(FOLDER, CWD)
    await runClaudeNotesIngest(deps(realStore))
    fs.rmSync(p)
    await runClaudeNotesIngest(deps(realStore))
    expect(stored()).toHaveLength(0)
    note(FOLDER, 'cache.md', body(WORDS_A), at(5))
    await runClaudeNotesIngest(deps(realStore))
    restart()
    expect(stored()).toHaveLength(1)
  })

  it('a deleted note stays deleted after a restart', async () => {
    const p = note(FOLDER, 'cache.md', body(WORDS_A))
    session(FOLDER, CWD)
    await runClaudeNotesIngest(deps(realStore))
    fs.rmSync(p)
    await runClaudeNotesIngest(deps(realStore))
    restart()
    expect(stored()).toHaveLength(0)
  })

  it('the same note in two projects is two entries, one for each project', async () => {
    const other = { cwd: 'C:\\work\\other', folder: encodeProjectFolder('C:\\work\\other') }
    note(FOLDER, 'cache.md', body(WORDS_A))
    note(other.folder, 'cache.md', body(WORDS_A))
    session(FOLDER, CWD)
    session(other.folder, other.cwd)
    await runClaudeNotesIngest(deps(realStore))
    expect(stored().map((r) => r.project).sort()).toEqual(['app', 'other'])
  })

  it('an unchanged chunk of an edited note keeps its entry across the edit and the restart', async () => {
    const filler = 'f'.repeat(1500)
    const two = (tail: string): string => `---\nname: big\ntype: reference\n---\nFirst ${filler}\n\nSecond ${filler}\n\n${tail}`
    const p = note(FOLDER, 'big.md', two('Tail one.'))
    session(FOLDER, CWD)
    await runClaudeNotesIngest(deps(realStore))
    const first = stored().find((r) => r.content.includes('First'))!
    fs.writeFileSync(p, two('Tail two.')); touch(p, 2)
    await runClaudeNotesIngest(deps(realStore))
    restart()
    expect(stored().some((r) => r.id === first.id)).toBe(true)
    expect(stored().some((r) => r.content.includes('Tail two.'))).toBe(true)
    expect(stored().some((r) => r.content.includes('Tail one.'))).toBe(false)
  })
})

describe('a pass that is killed', () => {
  /** A store that dies after `n` writes: every call from then on never answers, as in a process that is gone. */
  function dyingStore(n: number): { store: NotesStore; dead: () => boolean } {
    let writes = 0
    let dead = false
    return {
      dead: () => dead,
      store: {
        ...realStore,
        write: (i) => {
          if (dead || ++writes > n) { dead = true; return new Promise<never>(() => {}) }
          return realStore.write(i)
        },
      },
    }
  }

  const three = (): void => {
    for (let i = 0; i < 3; i++) note(FOLDER, `n${i}.md`, `---\nname: n${i}\ntype: reference\n---\nNote number ${i} has its own words.`)
    session(FOLDER, CWD)
  }

  /** The two sides of the record agree: every id the manifest lists is in the store, and every note in the store is listed. */
  function expectConsistent(): void {
    const listed = Object.values(manifestJson().files as Record<string, { chunks: Array<{ id: string }> }>).flatMap((f) => f.chunks.map((c) => c.id))
    expect(stored().map((r) => r.id).sort()).toEqual(listed.sort())
  }

  it('is finished by the next pass with exactly one entry per chunk, however far the dead one got', async () => {
    three()
    for (const survive of [0, 1, 2]) {
      fs.rmSync(path.join(data, 'claude-notes-manifest.json'), { force: true })
      for (const r of stored()) memoryDelete(r.id)
      _resetNotesLockForTests()
      const { store, dead } = dyingStore(survive)
      void runClaudeNotesIngest(deps(store)) // never settles: the process is gone
      await vi.waitFor(() => expect(dead()).toBe(true), { timeout: 10_000 })
      _resetNotesLockForTests()
      restart() // and the app starts again
      await runClaudeNotesIngest(deps(realStore))
      expect(stored(), `after dying with ${survive} written`).toHaveLength(3)
      expect(new Set(stored().map((r) => r.content)).size).toBe(3)
      expectConsistent()
      restart()
      expect(stored()).toHaveLength(3)
    }
  })

  it('leaves no stray entry behind when the note changed before the next pass finished it', async () => {
    const p = note(FOLDER, 'n.md', '---\nname: n\ntype: reference\n---\nThe first wording of this note.')
    session(FOLDER, CWD)
    const { store, dead } = dyingStore(0)
    void runClaudeNotesIngest(deps(store))
    await vi.waitFor(() => expect(dead()).toBe(true), { timeout: 10_000 })
    _resetNotesLockForTests()
    // The dead pass wrote nothing, so give it one chunk that reached the store but not the manifest:
    await memoryWrite({ agentId: 'claude-notes', source: 'claude-notes', kind: 'fact', content: 'n \u2014 \n\nStray chunk from the killed pass', tags: ['type:reference', 'note:n.md'], hash: 'killed-pass-hash', importance: 0.9, memoryType: 'summary', project: CWD })
    fs.writeFileSync(p, '---\nname: n\ntype: reference\n---\nThe second wording of this note.'); touch(p, 9)
    restart()
    await runClaudeNotesIngest(deps(realStore))
    expect(stored().map((r) => r.content).join('\n')).not.toContain('Stray chunk')
    expect(stored()).toHaveLength(1)
    expect(stored()[0].content).toContain('second wording')
    expectConsistent()
    restart()
    expect(stored()).toHaveLength(1)
  })

  // The flag that makes the sweep happen is set by the first change a pass makes, not by the manifest being new: a manifest
  // from a COMPLETE pass is clean, and an edit pass killed right after its first store write leaves a chunk nothing records.
  // If the note is edited again before the next pass, only the sweep can find that chunk.
  it('sweeps a chunk a killed edit pass left behind even though the manifest was clean, when the note is edited again before the next pass', async () => {
    const line = (tag: string): string => `${tag} ${'w'.repeat(1500)}`
    const body = (second: string): string => `---\nname: n\ntype: reference\n---\n${line('First')}\n\n${line(second)}\n\n${line('Third')}`
    const p = note(FOLDER, 'n.md', body('Second'))
    session(FOLDER, CWD)
    await runClaudeNotesIngest(deps(realStore)) // a complete pass: the manifest is clean
    expect(manifestJson().dirty).toBe(false)
    expect(stored()).toHaveLength(3)
    fs.writeFileSync(p, body('SecondEDIT1')); touch(p, 5)
    // The next pass is killed right after its first store write: the manifest saves after that write are lost.
    let frozen = false
    const disk = deps(realStore).manifest
    const killed = deps({
      ...realStore,
      write: async (i) => { try { return await realStore.write(i) } finally { frozen = true } },
    }, { manifest: { read: () => disk.read(), write: (t) => { if (!frozen) disk.write(t) } } })
    await runClaudeNotesIngest(killed)
    const orphan = stored().find((r) => r.content.includes('SecondEDIT1'))! // it reached the store...
    expect(orphan).toBeDefined()
    expect(JSON.stringify(manifestJson())).not.toContain(orphan.id) // ...and no record of it did
    expect(manifestJson().dirty).toBe(true) // but the manifest was flagged before the first change was made
    restart()
    fs.writeFileSync(p, body('SecondEDIT2')); touch(p, 9) // edited again before the next pass
    await runClaudeNotesIngest(deps(realStore))
    const texts = stored().map((r) => r.content)
    expect(texts.some((c) => c.includes('SecondEDIT1'))).toBe(false) // the orphan is gone
    expect(texts.some((c) => c.includes('SecondEDIT2'))).toBe(true)
    expect(texts).toHaveLength(3)
    expectConsistent()
    expect(manifestJson().dirty).toBe(false)
  })

  it('a manifest lost entirely costs a re-import and a sweep, not a duplicate', async () => {
    three()
    await runClaudeNotesIngest(deps(realStore))
    fs.rmSync(path.join(data, 'claude-notes-manifest.json'))
    const stats = await runClaudeNotesIngest(deps(realStore))
    expect(stats).toMatchObject({ chunksWritten: 3, swept: 3 })
    expect(stored()).toHaveLength(3)
    expectConsistent()
    restart()
    expect(stored()).toHaveLength(3)
  })

  it('a removal killed after it was written ahead is finished by the next pass, and the note is stored again', async () => {
    const p = note(FOLDER, 'n.md', '---\nname: n\ntype: reference\n---\nAn old wording.')
    session(FOLDER, CWD)
    await runClaudeNotesIngest(deps(realStore))
    fs.writeFileSync(p, '---\nname: n\ntype: reference\n---\nA new wording.'); touch(p, 8)
    let removes = 0
    const dying: NotesStore = { ...realStore, remove: (id) => { removes++; return new Promise<void>(() => {}) } }
    void runClaudeNotesIngest(deps(dying))
    await vi.waitFor(() => expect(removes).toBe(1), { timeout: 10_000 })
    _resetNotesLockForTests()
    restart()
    await runClaudeNotesIngest(deps(realStore))
    expect(stored()).toHaveLength(1)
    expect(stored()[0].content).toContain('new wording')
    expectConsistent()
    restart()
    expect(stored()).toHaveLength(1)
  })
})

describe('secrets in a note', () => {
  it('are redacted before they reach the store, and the pass counts them', async () => {
    note(FOLDER, 'n.md', `---\nname: n\ntype: reference\n---\nThe deploy key is ${FAKE_KEY} for the staging account.`)
    session(FOLDER, CWD)
    const stats = await runClaudeNotesIngest(deps(realStore))
    expect(stats.secretsRedacted).toBeGreaterThanOrEqual(1)
    expect(stored()).toHaveLength(1)
    expect(stored()[0].content).not.toContain(FAKE_KEY)
    expect(stored()[0].content).toContain('staging account')
    const disk = fs.readdirSync(storeDir).filter((f) => f.endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(storeDir, f), 'utf8')).join('\n')
    expect(disk).not.toContain(FAKE_KEY)
    expect(manifestJson().last.secretsRedacted).toBe(stats.secretsRedacted)
  })

  // The panel and the README say the redaction is the Memory scrub (Settings > AI Security), the one switch that covers all of
  // memory, and that a note is stored as it is when that is off: the sentence is true only while this holds.
  it('are stored as they are, and counted as none redacted, when the Memory scrub is switched off', async () => {
    setMemoryScrub(false)
    note(FOLDER, 'n.md', `---\nname: n\ntype: reference\n---\nThe deploy key is ${FAKE_KEY} for the staging account.`)
    session(FOLDER, CWD)
    const stats = await runClaudeNotesIngest(deps(realStore))
    expect(stats.secretsRedacted).toBe(0)
    expect(stored()).toHaveLength(1)
    expect(stored()[0].content).toContain(FAKE_KEY)
    expect(manifestJson().last.secretsRedacted).toBe(0)
  })
})

describe('what an agent gets back', () => {
  const handlers = (): McpToolHandlers => ({ memoryWrite, memorySearch, memoryList } as unknown as McpToolHandlers)

  it('memory_search returns a note that came from a Claude folder, to any agent that asks (Codex included)', async () => {
    note(FOLDER, 'feedback_widget.md', FEEDBACK)
    session(FOLDER, CWD)
    await runClaudeNotesIngest(deps(realStore))
    // No agent filter: the search is the shared tool every agent calls, and the note was written by none of them.
    const res = (await executeTool('memory_search', { query: 'invalidate widget cache write timer', project: CWD }, handlers())) as Array<{ content: string; source?: string; agentId?: string }>
    expect(res.length).toBeGreaterThan(0)
    expect(res[0]).toMatchObject({ source: 'claude-notes', agentId: 'claude-notes' })
    expect(res[0].content).toContain('Invalidate on write')
  })

  it('with sharing off, another project\'s search never returns the note, whatever its type', async () => {
    const other = { cwd: 'C:\\work\\other', folder: encodeProjectFolder('C:\\work\\other') }
    for (const t of ['reference', 'feedback', 'user', 'project']) note(FOLDER, `${t}.md`, `---\nname: ${t}\ntype: ${t}\n---\nInvalidate the widget cache on write: ${t}.`)
    session(FOLDER, CWD)
    note(other.folder, 'own.md', '---\nname: own\ntype: reference\n---\nThe other project has a note of its own about caches.')
    session(other.folder, other.cwd)
    await runClaudeNotesIngest(deps(realStore))
    const res = (await executeTool('memory_search', { query: 'invalidate widget cache write', project: other.cwd }, handlers())) as Array<{ content: string; project?: string }>
    expect(res.every((r) => r.project === 'other')).toBe(true)
    expect(res.some((r) => r.content.includes('Invalidate the widget cache'))).toBe(false)
  })
})

describe('a locked memory', () => {
  /** The store as main leaves it when it could not unwrap the memory key: nothing may be appended. */
  const lock = (): void => {
    _resetForTests()
    initSwarmMemory(storeDir, { encKey: null, keyProblem: 'key-unreadable' })
    _setEmbeddingsAvailable(false)
    setMemoryScrubber(productionScrubber)
  }

  it('takes no write from the pass, and the pass is finished once memory unlocks', async () => {
    for (let i = 0; i < 3; i++) note(FOLDER, `n${i}.md`, `---\nname: n${i}\ntype: reference\n---\nNote number ${i} has its own words.`)
    session(FOLDER, CWD)
    lock()
    const during = await runClaudeNotesIngest(deps(realStore))
    expect(during).toMatchObject({ chunksWritten: 0, writeFailed: 1 })
    expect(stored()).toHaveLength(0)
    expect(fs.existsSync(path.join(storeDir, 'swarm-memory.jsonl')) ? fs.readFileSync(path.join(storeDir, 'swarm-memory.jsonl'), 'utf8') : '').not.toContain('Note number')
    // Nothing is recorded as done: the notes are all still pending.
    expect(Object.values(manifestJson().files as Record<string, { mtimeMs: number }>).every((f) => f.mtimeMs === -1)).toBe(true)

    openStore() // the key came back
    const after = await runClaudeNotesIngest(deps(realStore))
    expect(after.chunksWritten).toBe(3)
    expect(stored()).toHaveLength(3)
  })

  it('takes no removal either: "Remove imported notes" reports every copy as failed and loses none', async () => {
    note(FOLDER, 'a.md', '---\nname: a\ntype: reference\n---\nAlpha words.')
    session(FOLDER, CWD)
    await runClaudeNotesIngest(deps(realStore))
    lock()
    expect(await removeImportedNotes(deps(realStore))).toEqual({ removed: 0, failed: 1 })
    openStore()
    expect(stored()).toHaveLength(1)
    expect(await removeImportedNotes(deps(realStore))).toEqual({ removed: 1, failed: 0 }) // retried and finished
    expect(stored()).toHaveLength(0)
  })
})

describe('what the primer does with the notes, against the real store', () => {
  const OTHER_CWD = 'C:\\work\\billing'
  const OTHER_FOLDER = encodeProjectFolder(OTHER_CWD)

  it('leads its own project\'s block with the note, ahead of conversation chunks that match better, and shows nothing of another project\'s', async () => {
    const { buildContextPrimer } = await import('../../src/main/contextPrimer')
    note(FOLDER, 'feedback_widget.md', FEEDBACK)
    session(FOLDER, CWD)
    note(OTHER_FOLDER, 'billing.md', '---\nname: billing_rules\ndescription: how billing caches\ntype: reference\n---\nBilling invalidates the widget cache when a charge settles.')
    session(OTHER_FOLDER, OTHER_CWD)
    await runClaudeNotesIngest(deps(realStore))
    // Two transcript chunks of the app project that repeat the query's words more closely than the note does.
    for (const text of ['user: how should the widget cache be invalidated?\n\nassistant: invalidate the widget cache on write', 'assistant: widget cache invalidation on write is what we settled on for the cache']) {
      await memoryWrite({ agentId: 'claude-history', kind: 'message', content: text, source: 'claude', project: CWD })
    }
    const app = (await buildContextPrimer(memorySearch, { query: 'invalidate widget cache on write', project: normalizeProjectSlug(CWD), projectPath: CWD }))!
    const lines = app.split('\n').filter((l) => l.startsWith('- ['))
    expect(lines[0]).toMatch(/^- \[note \u00b7 /)
    expect(lines[0]).toContain('Invalidate on write, not on a timer')
    expect(app).toContain('saved notes, then past conversations')
    expect(app).not.toContain('Billing invalidates')

    const billing = (await buildContextPrimer(memorySearch, { query: 'invalidate widget cache on write', project: normalizeProjectSlug(OTHER_CWD), projectPath: OTHER_CWD }))!
    expect(billing).toContain('Billing invalidates the widget cache')
    expect(billing).not.toContain('Invalidate on write, not on a timer')
  })
})

describe('Remove imported notes against the real store', () => {
  it('takes every imported note out, and nothing else', async () => {
    note(FOLDER, 'a.md', '---\nname: a\ntype: reference\n---\nAlpha words.')
    session(FOLDER, CWD)
    await runClaudeNotesIngest(deps(realStore))
    await memoryWrite({ agentId: 'claude', kind: 'note', content: 'An ordinary memory that is not a saved note.', project: CWD })
    expect(await removeImportedNotes(deps(realStore))).toEqual({ removed: 1, failed: 0 })
    restart()
    expect(stored()).toHaveLength(0)
    expect(memoryList({ limit: 50 }).map((r) => r.content)).toEqual(['An ordinary memory that is not a saved note.'])
  })
})

// Wiping a project's notes means deleting its memory folder; the project folder and its sessions stay. Checked against the real
// store, because the copies leaving it is the point, and because a deleted memory also retires its content hash for good: the same
// words saved again afterwards must still be there after a restart.
describe('A project whose whole notes folder was deleted, against the real store', () => {
  it('takes its copies out, keeps them out across a restart, and takes the same words in again when the folder comes back', async () => {
    note(FOLDER, 'a.md', '---\nname: a\ntype: reference\n---\nAlpha words.')
    note(FOLDER, 'b.md', '---\nname: b\ntype: feedback\n---\nBeta words.')
    session(FOLDER, CWD)
    await runClaudeNotesIngest(deps(realStore))
    expect(stored()).toHaveLength(2)
    fs.rmSync(path.join(root, FOLDER, 'memory'), { recursive: true })
    expect(await runClaudeNotesIngest(deps(realStore))).toMatchObject({ filesRemoved: 2, chunksDeleted: 2 })
    expect(stored()).toHaveLength(0)
    expect(manifestJson().files).toEqual({})
    restart()
    expect(stored()).toHaveLength(0)
    note(FOLDER, 'a.md', '---\nname: a\ntype: reference\n---\nAlpha words.') // the very same note, written again
    await runClaudeNotesIngest(deps(realStore))
    expect(stored()).toHaveLength(1)
    restart()
    expect(stored()).toHaveLength(1)
    expect(stored()[0].content).toContain('Alpha words.')
  })

  it('leaves another project\'s copies alone', async () => {
    const OTHER = encodeProjectFolder('C:\\work\\other')
    note(FOLDER, 'a.md', '---\nname: a\ntype: reference\n---\nAlpha words.')
    note(OTHER, 'z.md', '---\nname: z\ntype: reference\n---\nZulu words.')
    session(FOLDER, CWD)
    session(OTHER, 'C:\\work\\other')
    await runClaudeNotesIngest(deps(realStore))
    expect(stored()).toHaveLength(2)
    fs.rmSync(path.join(root, FOLDER, 'memory'), { recursive: true })
    await runClaudeNotesIngest(deps(realStore))
    expect(stored().map((r) => r.content).join('\n')).toContain('Zulu words.')
    expect(stored().map((r) => r.content).join('\n')).not.toContain('Alpha words.')
  })
})

// A note's words are all this store sees; this guards the assumption the pass is built on.
describe('the store\'s own behaviour the pass relies on', () => {
  it('drops, on reload, an entry whose content hash was retired by a delete', async () => {
    const first = await memoryWrite({ agentId: 'claude-notes', kind: 'fact', content: 'hello there', hash: 'h-one', project: CWD })
    memoryDelete(first.id)
    await memoryWrite({ agentId: 'claude-notes', kind: 'fact', content: 'hello there again', hash: 'h-one', project: CWD })
    expect(memoryList({ agentId: 'claude-notes' })).toHaveLength(1) // alive in this session...
    restart()
    expect(memoryList({ agentId: 'claude-notes' })).toHaveLength(0) // ...gone after a restart: the reason hashes carry an epoch
  })

  it('lists by author with the cursor the sweep pages with: strictly older, and a window of equal times', async () => {
    for (let i = 0; i < 6; i++) await memoryWrite({ agentId: 'claude-notes', kind: 'fact', content: `row ${i}`, ts: 1000 + Math.floor(i / 2), project: CWD })
    expect(memoryList({ agentId: 'claude-notes', before: 1002 })).toHaveLength(4)
    expect(memoryList({ agentId: 'claude-notes', since: 1001, before: 1002 })).toHaveLength(2)
  })
})

// Round 3, against the real store: the two ways the record of what was stored and the store itself can disagree.
describe('the manifest and the store disagree', () => {
  /** `count` notes that all carry one modified time, as a copied or extracted folder does; each is one chunk of its own wording. */
  function seedSameTime(count: number): void {
    const stamp = Date.UTC(2026, 8, 5)
    for (let i = 0; i < count; i++) {
      const p = note(FOLDER, `rule_${i}.md`, FEEDBACK.replace('Invalidate on write, not on a timer.', `Rule number ${i}: invalidate on write, and only then, because a timer serves stale data (${i}).`))
      fs.utimesSync(p, new Date(stamp), new Date(stamp))
    }
    session(FOLDER, CWD)
  }

  it('a lost manifest over 600 notes that share one modified time leaves exactly 600 copies, and settles', async () => {
    seedSameTime(600)
    for (let pass = 0; pass < 4; pass++) await runClaudeNotesIngest(deps(realStore), { maxChunks: 1000 })
    expect(memoryCount()).toBe(600) // this store holds nothing but the notes; a listing shows at most 500, a count shows all
    fs.rmSync(path.join(data, NOTES_MANIFEST_FILE)) // the manifest is lost; the store is not
    for (let pass = 0; pass < 4; pass++) await runClaudeNotesIngest(deps(realStore), { maxChunks: 1000 })
    expect(memoryCount()).toBe(600) // not 1,200: a full page of one time's new copies cannot hide the old ones from the sweep
    restart()
    expect(memoryCount()).toBe(600)
    expect(manifestJson().dirty).toBe(false)
  })

  it('a store replaced by an empty one is imported into again, and Settings counts what it really holds', async () => {
    seedSameTime(3)
    await runClaudeNotesIngest(deps(realStore))
    expect(await stored()).toHaveLength(3)
    // A new memory key: the old log is left unread and the store the app sees is empty.
    fs.rmSync(storeDir, { recursive: true, force: true })
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-store-'))
    openStore()
    expect(await stored()).toHaveLength(0)
    expect(notesStatus(fileManifest(data)).chunks).toBe(3) // what the record claims, before a pass looks
    for (let pass = 0; pass < 3; pass++) await runClaudeNotesIngest(deps(realStore))
    expect(await stored()).toHaveLength(3)
    expect(notesStatus(fileManifest(data))).toMatchObject({ notes: 3, chunks: 3 })
  })
})

// Keeps the harness' unused exports honest.
void root
