// WP-E — an ON-BY-DEFAULT, local, inspectable, secret-redacted audit of what the memory/learning
// system actually DID: what it stored, recalled, learned, and injected into an agent's context.
// (Distinct from the AI Security audit, which is default-OFF and about cloud egress.) Local-only,
// previews run through the secret scanner, file capped + rotated.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  initMemoryAudit,
  setMemoryAuditEnabled,
  memoryAuditEnabled,
  auditMemory,
  flushMemoryAudit,
  readMemoryAudit,
  memoryAuditSummary,
  redactPreview,
  _resetMemoryAuditForTests,
  _setMaxBytesForTests,
  MAX_BYTES,
  AUDIT_FILES,
  memoryAuditSize,
  clearMemoryAudit,
} from '../../src/main/memoryAudit'
import { offMainFiles } from '../../src/main/offMainFiles'

describe('memory/learning audit (WP-E)', () => {
  let tmp: string
  const auditFile = () => path.join(tmp, 'memory-audit.jsonl')
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memaudit-'))
    _resetMemoryAuditForTests()
    initMemoryAudit(tmp)
  })
  afterEach(() => {
    _resetMemoryAuditForTests()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('is ON by default', () => {
    expect(memoryAuditEnabled()).toBe(true)
  })

  it('records events and reads them back newest-first', async () => {
    auditMemory({ event: 'write', id: 'a', kind: 'fact', preview: 'hello world' }, 1)
    auditMemory({ event: 'learn', kind: 'feedback', detail: 'a marked helpful' }, 2)
    await offMainFiles.idle()
    const ev = readMemoryAudit()
    expect(ev.map((e) => e.event)).toEqual(['learn', 'write'])
    expect(ev[1]).toMatchObject({ event: 'write', id: 'a', kind: 'fact', ts: 1 })
  })

  it('redacts secrets in previews so none are ever written to disk', async () => {
    const secret = 'sk-' + 'a'.repeat(40) // matches the OpenAI-key rule, low entropy (test-safe)
    const red = redactPreview('the token is ' + secret + ' keep it safe')
    expect(red).not.toContain(secret)
    expect(red).toContain('[REDACTED')
    // and end-to-end: a secret handed to auditMemory never lands in the file
    auditMemory({ event: 'write', id: 'z', kind: 'note', preview: redactPreview(secret) })
    await offMainFiles.idle()
    expect(fs.readFileSync(auditFile(), 'utf8')).not.toContain(secret)
  })

  it('does not write when disabled (privacy opt-out)', async () => {
    setMemoryAuditEnabled(false)
    expect(memoryAuditEnabled()).toBe(false)
    auditMemory({ event: 'write', id: 'x', kind: 'fact', preview: 'nope' })
    await offMainFiles.idle()
    expect(readMemoryAudit()).toEqual([])
    setMemoryAuditEnabled(true)
  })

  it('summarizes event counts by type', async () => {
    auditMemory({ event: 'write', id: 'a', kind: 'fact', preview: 'x' })
    auditMemory({ event: 'write', id: 'b', kind: 'fact', preview: 'y' })
    auditMemory({ event: 'recall', query: 'q', results: 2, topIds: ['a', 'b'] })
    auditMemory({ event: 'inject', target: 'claude', memoryIds: ['a'], approxTokens: 42 })
    await offMainFiles.idle()
    expect(memoryAuditSummary()).toMatchObject({ write: 2, recall: 1, inject: 1 })
  })

  it('rotates the file when it exceeds the cap (bounded growth)', async () => {
    _setMaxBytesForTests(4000) // small cap so rotation triggers cheaply
    for (let i = 0; i < 80; i++) auditMemory({ event: 'write', id: 'm' + i, kind: 'fact', preview: 'padding padding padding padding padding' }, i)
    await offMainFiles.idle()
    expect(fs.existsSync(path.join(tmp, 'memory-audit.prev.jsonl'))).toBe(true) // previous generation kept
    expect(fs.statSync(auditFile()).size).toBeLessThan(4000 + 500) // live file stays near the cap, not unbounded
  })

  it('flushMemoryAudit waits for the lines asked for so far, and has nothing to wait for before the log is set up', async () => {
    auditMemory({ event: 'write', id: 'f1', kind: 'fact', preview: 'one' }, 1)
    auditMemory({ event: 'write', id: 'f2', kind: 'fact', preview: 'two' }, 2)
    await flushMemoryAudit()
    expect(fs.readFileSync(auditFile(), 'utf8').split('\n').filter(Boolean)).toHaveLength(2) // both are on disk when it resolves
    _resetMemoryAuditForTests() // no folder known any more
    await expect(flushMemoryAudit()).resolves.toBeUndefined()
  })

  // PRIVACY.md and the documentation say each file is "capped at about 2 MB". The tests above lower the cap to stay cheap, so this
  // pins the one that ships: a live file just under it takes one more line, one that the next line would push to it moves aside.
  it('keeps the live file to about 2 MB: the cap that ships', async () => {
    expect(MAX_BYTES).toBe(2_000_000)
    const prev = path.join(tmp, 'memory-audit.prev.jsonl')
    const line = (): void => auditMemory({ event: 'write', id: 'm', kind: 'fact', preview: 'x' }, 1)
    await offMainFiles.idle()
    const seed = (bytes: number): void => { _resetMemoryAuditForTests(); fs.rmSync(prev, { force: true }); initMemoryAudit(tmp); fs.writeFileSync(auditFile(), 'x'.repeat(bytes)) }
    seed(1_900_000)
    line()
    await offMainFiles.idle()
    expect(fs.existsSync(prev)).toBe(false) // 100 KB of room: appended, not rotated
    await offMainFiles.idle()
    expect(fs.statSync(auditFile()).size).toBeGreaterThan(1_900_000)
    seed(1_999_900)
    line()
    await offMainFiles.idle()
    expect(fs.existsSync(prev)).toBe(false) // the line fits under 2,000,000
    seed(1_999_990)
    line()
    await offMainFiles.idle()
    expect(fs.existsSync(prev)).toBe(true) // it would not
    await offMainFiles.idle()
    expect(fs.statSync(auditFile()).size).toBeLessThan(500) // and the live file starts again with it
  })
})

// 1.55.0 (research section 6.4): the audit was blind in exactly the process the agents talk to. The store runs
// in a utility process that initialises it, but every recall, inject and outcome event is raised in MAIN, whose
// copy of this module was never initialised, so those events went nowhere and memory_audit showed only the
// host's writes. Main now writes a file of its own, so the two processes never race on one file's rotation,
// and reading merges both. What main may persist is narrower than what a write preview already is: counts,
// ids, kinds, the agent and the project, and NEVER the beginning of a query (or, with the prompt-time recall
// hook, of the user's first prompt).
describe('memory/learning audit written from the main process', () => {
  let tmp: string
  const hostFile = () => path.join(tmp, 'memory-audit.jsonl')
  const mainFile = () => path.join(tmp, 'memory-audit-main.jsonl')
  const lines = (file: string) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memaudit-main-'))
    _resetMemoryAuditForTests()
  })
  afterEach(() => {
    _resetMemoryAuditForTests()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('writes events to its own file and leaves the host\'s file alone', async () => {
    initMemoryAudit(tmp, 'main')
    auditMemory({ event: 'inject', target: 'primer', memoryIds: ['a', 'b'], approxTokens: 40 }, 5)
    await offMainFiles.idle()
    expect(fs.existsSync(mainFile())).toBe(true)
    await offMainFiles.idle()
    expect(fs.existsSync(hostFile())).toBe(false)
    await offMainFiles.idle()
    expect(lines(mainFile())).toEqual([{ ts: 5, event: 'inject', target: 'primer', memoryIds: ['a', 'b'], approxTokens: 40 }])
  })

  it('keeps writing to the host\'s file when no role is given, as before', async () => {
    initMemoryAudit(tmp)
    auditMemory({ event: 'learn', kind: 'reflect', detail: 'x' })
    await offMainFiles.idle()
    expect(fs.existsSync(hostFile())).toBe(true)
    await offMainFiles.idle()
    expect(fs.existsSync(mainFile())).toBe(false)
  })

  it('reads the host\'s file and main\'s together, newest first, and counts both', async () => {
    // What the memory host process wrote (it is a different process: here, a file this one did not write).
    fs.writeFileSync(hostFile(),
      JSON.stringify({ ts: 10, event: 'write', id: 'w1', kind: 'fact', preview: 'x' }) + '\n' +
      JSON.stringify({ ts: 40, event: 'write', id: 'w2', kind: 'fact', preview: 'y' }) + '\n')
    initMemoryAudit(tmp, 'main')
    auditMemory({ event: 'recall', agentId: 'claude', query: 'q', results: 2, topIds: ['w1', 'w2'] }, 20)
    auditMemory({ event: 'inject', target: 'primer', memoryIds: [], approxTokens: 9 }, 30)
    await offMainFiles.idle()
    expect(readMemoryAudit().map((e) => [e.ts, e.event])).toEqual([[40, 'write'], [30, 'inject'], [20, 'recall'], [10, 'write']])
    await offMainFiles.idle()
    expect(memoryAuditSummary()).toEqual({ write: 2, recall: 1, inject: 1 })
  })

  it('honours the limit across both files, keeping the newest', async () => {
    fs.writeFileSync(hostFile(), [1, 3, 5].map((ts) => JSON.stringify({ ts, event: 'write', id: `h${ts}`, kind: 'fact', preview: '' })).join('\n') + '\n')
    initMemoryAudit(tmp, 'main')
    for (const ts of [2, 4, 6]) auditMemory({ event: 'learn', kind: 'reflect', detail: `m${ts}` }, ts)
    await offMainFiles.idle()
    expect(readMemoryAudit(4).map((e) => e.ts)).toEqual([6, 5, 4, 3])
    await offMainFiles.idle()
    expect(readMemoryAudit(1).map((e) => e.ts)).toEqual([6])
    await offMainFiles.idle()
    expect(readMemoryAudit(0).map((e) => e.ts)).toEqual([6]) // the floor of one, as before
  })

  it('treats a limit that is not a usable number as the default, not as "nothing"', async () => {
    fs.writeFileSync(hostFile(), [1, 3].map((ts) => JSON.stringify({ ts, event: 'write', id: `h${ts}`, kind: 'fact', preview: '' })).join('\n') + '\n')
    initMemoryAudit(tmp, 'main')
    auditMemory({ event: 'learn', kind: 'reflect', detail: 'm' }, 2)
    for (const odd of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      expect(readMemoryAudit(odd).length).toBeGreaterThanOrEqual(1)
    }
    await offMainFiles.idle()
    expect(readMemoryAudit(Number.NaN).map((e) => e.ts)).toEqual([3, 2, 1])
    await offMainFiles.idle()
    expect(readMemoryAudit(2.9).map((e) => e.ts)).toEqual([3, 2])
  })

  it('reads either file alone in the order it always did, and nothing when there is none', async () => {
    initMemoryAudit(tmp, 'main')
    await offMainFiles.idle()
    expect(readMemoryAudit()).toEqual([])
    auditMemory({ event: 'learn', kind: 'reflect', detail: 'first' }, 7)
    auditMemory({ event: 'learn', kind: 'reflect', detail: 'second' }, 7) // same timestamp: newest-appended first
    await offMainFiles.idle()
    expect(readMemoryAudit().map((e) => (e as { detail: string }).detail)).toEqual(['second', 'first'])
    fs.rmSync(mainFile())
    fs.writeFileSync(hostFile(), JSON.stringify({ ts: 1, event: 'write', id: 'only', kind: 'fact', preview: '' }) + '\n')
    await offMainFiles.idle()
    expect(readMemoryAudit().map((e) => (e as { id: string }).id)).toEqual(['only'])
  })

  it('skips a corrupt line in either file without losing the rest', async () => {
    fs.writeFileSync(hostFile(), 'not json\n' + JSON.stringify({ ts: 1, event: 'write', id: 'h', kind: 'fact', preview: '' }) + '\n\n')
    fs.writeFileSync(mainFile(), JSON.stringify({ ts: 2, event: 'learn', kind: 'reflect', detail: 'm' }) + '\n{"ts":3,"ev')
    initMemoryAudit(tmp, 'main')
    await offMainFiles.idle()
    expect(readMemoryAudit().map((e) => e.ts)).toEqual([2, 1])
  })

  it('returns nothing before it is initialised', async () => {
    await offMainFiles.idle()
    expect(readMemoryAudit()).toEqual([])
    await offMainFiles.idle()
    expect(memoryAuditSummary()).toEqual({})
  })

  it('rotates its own file at the cap and does not touch the host\'s generations', async () => {
    fs.writeFileSync(hostFile(), JSON.stringify({ ts: 1, event: 'write', id: 'h', kind: 'fact', preview: '' }) + '\n')
    fs.writeFileSync(path.join(tmp, 'memory-audit.prev.jsonl'), 'host previous generation\n')
    initMemoryAudit(tmp, 'main')
    _setMaxBytesForTests(2000)
    for (let i = 0; i < 80; i++) auditMemory({ event: 'inject', target: 'primer', memoryIds: ['a', 'b', 'c'], approxTokens: i }, i)
    await offMainFiles.idle()
    expect(fs.existsSync(path.join(tmp, 'memory-audit-main.prev.jsonl'))).toBe(true)
    await offMainFiles.idle()
    expect(fs.statSync(mainFile()).size).toBeLessThan(2000 + 300)
    await offMainFiles.idle()
    expect(fs.readFileSync(path.join(tmp, 'memory-audit.prev.jsonl'), 'utf8')).toBe('host previous generation\n')
    await offMainFiles.idle()
    expect(fs.readFileSync(hostFile(), 'utf8')).toContain('"id":"h"')
  })

  it('writes nothing while the audit is switched off', async () => {
    initMemoryAudit(tmp, 'main')
    setMemoryAuditEnabled(false)
    auditMemory({ event: 'inject', target: 'primer', memoryIds: [], approxTokens: 1 })
    await offMainFiles.idle()
    expect(fs.existsSync(mainFile())).toBe(false)
    setMemoryAuditEnabled(true)
    auditMemory({ event: 'inject', target: 'primer', memoryIds: [], approxTokens: 1 })
    await offMainFiles.idle()
    expect(fs.existsSync(mainFile())).toBe(true)
  })

  it('never lets a secret reach the file, however it got into a field', async () => {
    initMemoryAudit(tmp, 'main')
    const secret = 'sk-' + 'a'.repeat(40) // low entropy: test-safe
    auditMemory({ event: 'write', id: 'z', kind: 'note', preview: redactPreview('the deploy secret is ' + secret) })
    await offMainFiles.idle()
    expect(fs.readFileSync(mainFile(), 'utf8')).not.toContain(secret)
  })

  it('reads a file it cannot open as empty, and carries on with the other', async () => {
    fs.mkdirSync(hostFile()) // a directory where the host's file should be: it exists, and reading it throws
    initMemoryAudit(tmp, 'main')
    auditMemory({ event: 'learn', kind: 'reflect', detail: 'm' }, 4)
    await offMainFiles.idle()
    expect(readMemoryAudit().map((e) => e.ts)).toEqual([4])
  })

  it('rotates without a live file to move aside, and keeps writing', async () => {
    initMemoryAudit(tmp, 'main')
    _setMaxBytesForTests(10) // smaller than one line, so the very first append rotates
    auditMemory({ event: 'inject', target: 'primer', memoryIds: [], approxTokens: 1 }, 1)
    await offMainFiles.idle()
    expect(fs.existsSync(path.join(tmp, 'memory-audit-main.prev.jsonl'))).toBe(false) // nothing to keep
    await offMainFiles.idle()
    expect(readMemoryAudit().map((e) => e.ts)).toEqual([1])
  })

  it('redacts a preview that is not text as nothing', async () => {
    expect(redactPreview(undefined as unknown as string)).toBe('')
    expect(redactPreview(42 as unknown as string)).toBe('')
  })

  it('does not persist the query of a recall, whatever the caller passes (a prompt must not be stored)', async () => {
    initMemoryAudit(tmp, 'main')
    const prompt = 'please refactor the billing module so the invoice totals match the ledger'
    auditMemory({ event: 'recall', agentId: 'claude', query: redactPreview(prompt), results: 3, topIds: ['a', 'b', 'c'] }, 11)
    await offMainFiles.idle()
    const raw = fs.readFileSync(mainFile(), 'utf8')
    expect(raw).not.toContain('billing')
    expect(raw).not.toContain('invoice')
    expect(raw).not.toContain('query')
    // ...and what an auditor needs is still there: when, who, how many, which ids.
    await offMainFiles.idle()
    expect(lines(mainFile())).toEqual([{ ts: 11, event: 'recall', agentId: 'claude', results: 3, topIds: ['a', 'b', 'c'] }])
    await offMainFiles.idle()
    expect(readMemoryAudit()[0]).not.toHaveProperty('query')
  })

  it('does not persist a recall query on the host\'s side either', async () => {
    initMemoryAudit(tmp)
    auditMemory({ event: 'recall', query: 'first words of a prompt', results: 0, topIds: [] })
    await offMainFiles.idle()
    expect(fs.readFileSync(hostFile(), 'utf8')).not.toContain('first words')
  })

  it('goes back to the host\'s file when it is initialised again without a role', async () => {
    initMemoryAudit(tmp, 'main')
    initMemoryAudit(tmp)
    auditMemory({ event: 'learn', kind: 'reflect', detail: 'x' })
    await offMainFiles.idle()
    expect(fs.existsSync(hostFile())).toBe(true)
    await offMainFiles.idle()
    expect(fs.existsSync(mainFile())).toBe(false)
  })

  it('is reset to the host\'s file by the test seam', async () => {
    initMemoryAudit(tmp, 'main')
    _resetMemoryAuditForTests()
    initMemoryAudit(tmp)
    auditMemory({ event: 'learn', kind: 'reflect', detail: 'x' })
    await offMainFiles.idle()
    expect(fs.existsSync(hostFile())).toBe(true)
  })
})

// The user's way to forget the record in the app: Settings > Memory & Learning > Activity record. It only ever touches the four
// files the record is kept in, in the app-data folder it is handed, and it is safe while the other process is still writing.
describe('the record, as the user sees it and clears it', () => {
  let tmp: string
  const file = (name: string): string => path.join(tmp, name)
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memaudit-clear-'))
    _resetMemoryAuditForTests()
  })
  afterEach(() => {
    _resetMemoryAuditForTests()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('is kept in exactly four files: the memory process\'s and the main process\'s, each with its earlier copy', async () => {
    expect([...AUDIT_FILES].sort()).toEqual(['memory-audit-main.jsonl', 'memory-audit-main.prev.jsonl', 'memory-audit.jsonl', 'memory-audit.prev.jsonl'])
  })

  it('has a size of nothing when nothing has been recorded, or when the folder is not there', async () => {
    await offMainFiles.idle()
    expect(memoryAuditSize(tmp)).toEqual({ files: 0, bytes: 0 })
    await offMainFiles.idle()
    expect(memoryAuditSize(path.join(tmp, 'not-a-folder'))).toEqual({ files: 0, bytes: 0 })
  })

  it('adds up the size of the files that are there, and counts them, without reading a line', async () => {
    fs.writeFileSync(file('memory-audit.jsonl'), 'a'.repeat(100))
    fs.writeFileSync(file('memory-audit.prev.jsonl'), 'b'.repeat(40))
    fs.writeFileSync(file('memory-audit-main.jsonl'), 'c'.repeat(7))
    await offMainFiles.idle()
    expect(memoryAuditSize(tmp)).toEqual({ files: 3, bytes: 147 })
  })

  it('does not count something that is not a file as part of the record', async () => {
    fs.mkdirSync(file('memory-audit.jsonl'))
    fs.writeFileSync(file('memory-audit-main.jsonl'), 'abc')
    await offMainFiles.idle()
    expect(memoryAuditSize(tmp)).toEqual({ files: 1, bytes: 3 })
  })

  it('removes all four, and says how many', async () => {
    for (const name of AUDIT_FILES) fs.writeFileSync(file(name), 'x\n')
    await offMainFiles.idle()
    expect(clearMemoryAudit(tmp)).toEqual({ removed: 4, failed: 0 })
    await offMainFiles.idle()
    for (const name of AUDIT_FILES) expect(fs.existsSync(file(name))).toBe(false)
    await offMainFiles.idle()
    expect(memoryAuditSize(tmp)).toEqual({ files: 0, bytes: 0 })
  })

  it('leaves everything else in the folder alone', async () => {
    for (const name of AUDIT_FILES) fs.writeFileSync(file(name), 'x\n')
    fs.writeFileSync(file('swarm-memory.jsonl'), 'a memory')
    fs.writeFileSync(file('memory-metrics.jsonl'), 'a metric')
    fs.writeFileSync(file('memory-audit.jsonl.bak'), 'not ours')
    await offMainFiles.idle()
    clearMemoryAudit(tmp)
    await offMainFiles.idle()
    expect(fs.readFileSync(file('swarm-memory.jsonl'), 'utf8')).toBe('a memory')
    await offMainFiles.idle()
    expect(fs.readFileSync(file('memory-metrics.jsonl'), 'utf8')).toBe('a metric')
    await offMainFiles.idle()
    expect(fs.readFileSync(file('memory-audit.jsonl.bak'), 'utf8')).toBe('not ours')
  })

  it('counts a file that is not there as already forgotten, not as a failure', async () => {
    fs.writeFileSync(file('memory-audit.jsonl'), 'x\n')
    await offMainFiles.idle()
    expect(clearMemoryAudit(tmp)).toEqual({ removed: 1, failed: 0 })
    await offMainFiles.idle()
    expect(clearMemoryAudit(tmp)).toEqual({ removed: 0, failed: 0 })
    await offMainFiles.idle()
    expect(clearMemoryAudit(path.join(tmp, 'not-a-folder'))).toEqual({ removed: 0, failed: 0 })
  })

  it('counts a file it cannot remove as failed, and still removes the others', async () => {
    for (const name of AUDIT_FILES) fs.writeFileSync(file(name), 'x\n')
    // A folder where a file should be cannot be unlinked as one: a refusal like the one an open file gives on Windows.
    fs.rmSync(file('memory-audit.prev.jsonl'))
    fs.mkdirSync(file('memory-audit.prev.jsonl'))
    await offMainFiles.idle()
    expect(clearMemoryAudit(tmp)).toEqual({ removed: 3, failed: 1 })
    await offMainFiles.idle()
    expect(fs.existsSync(file('memory-audit.jsonl'))).toBe(false)
    await offMainFiles.idle()
    expect(fs.existsSync(file('memory-audit-main.jsonl'))).toBe(false)
  })

  it('lets the process that writes the record start it again: the next event makes a new file', async () => {
    initMemoryAudit(tmp)
    auditMemory({ event: 'learn', kind: 'reflect', detail: 'first' })
    await offMainFiles.idle()
    expect(readMemoryAudit(10)).toHaveLength(1)
    await offMainFiles.idle()
    clearMemoryAudit(tmp)
    await offMainFiles.idle()
    expect(readMemoryAudit(10)).toEqual([])
    auditMemory({ event: 'learn', kind: 'reflect', detail: 'second' })
    await offMainFiles.idle()
    const after = readMemoryAudit(10)
    expect(after).toHaveLength(1)
    expect((after[0] as { detail: string }).detail).toBe('second')
  })

  it('does not stop the other process from rotating a file it still counts as big', async () => {
    // The other process keeps its own count of the size of its file; after the clear the count is stale, and a rotation it then
    // makes finds nothing to rename. It must carry on and write the line. (This module's own count is told, below; the other
    // process's is simulated by removing the file without going through clearMemoryAudit.)
    _setMaxBytesForTests(300)
    initMemoryAudit(tmp)
    for (let i = 0; i < 2; i++) auditMemory({ event: 'learn', kind: 'reflect', detail: 'x'.repeat(40) })
    await offMainFiles.idle()
    fs.rmSync(file('memory-audit.jsonl'))
    auditMemory({ event: 'learn', kind: 'reflect', detail: 'y'.repeat(40) })
    await offMainFiles.idle()
    expect(readMemoryAudit(10)).toHaveLength(1)
    await offMainFiles.idle()
    expect(fs.existsSync(file('memory-audit.prev.jsonl'))).toBe(false)
  })

  it('sizes its own live file again after the clear, so that it does not rotate early on a count of a file that is gone', async () => {
    _setMaxBytesForTests(400)
    initMemoryAudit(tmp)
    for (let i = 0; i < 2; i++) auditMemory({ event: 'learn', kind: 'reflect', detail: 'x'.repeat(40) }) // about 210 bytes
    await offMainFiles.idle()
    clearMemoryAudit(tmp)
    for (let i = 0; i < 2; i++) auditMemory({ event: 'learn', kind: 'reflect', detail: 'y'.repeat(40) }) // about 210 again: under the cap
    await offMainFiles.idle()
    expect(fs.existsSync(file('memory-audit.prev.jsonl'))).toBe(false) // a count of 210 left over would have rotated these two
    await offMainFiles.idle()
    expect(readMemoryAudit(10)).toHaveLength(2)
  })
})
