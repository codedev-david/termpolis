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
  readMemoryAudit,
  memoryAuditSummary,
  redactPreview,
  _resetMemoryAuditForTests,
  _setMaxBytesForTests,
} from '../../src/main/memoryAudit'

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

  it('records events and reads them back newest-first', () => {
    auditMemory({ event: 'write', id: 'a', kind: 'fact', preview: 'hello world' }, 1)
    auditMemory({ event: 'learn', kind: 'feedback', detail: 'a marked helpful' }, 2)
    const ev = readMemoryAudit()
    expect(ev.map((e) => e.event)).toEqual(['learn', 'write'])
    expect(ev[1]).toMatchObject({ event: 'write', id: 'a', kind: 'fact', ts: 1 })
  })

  it('redacts secrets in previews so none are ever written to disk', () => {
    const secret = 'sk-' + 'a'.repeat(40) // matches the OpenAI-key rule, low entropy (test-safe)
    const red = redactPreview('the token is ' + secret + ' keep it safe')
    expect(red).not.toContain(secret)
    expect(red).toContain('[REDACTED')
    // and end-to-end: a secret handed to auditMemory never lands in the file
    auditMemory({ event: 'write', id: 'z', kind: 'note', preview: redactPreview(secret) })
    expect(fs.readFileSync(auditFile(), 'utf8')).not.toContain(secret)
  })

  it('does not write when disabled (privacy opt-out)', () => {
    setMemoryAuditEnabled(false)
    expect(memoryAuditEnabled()).toBe(false)
    auditMemory({ event: 'write', id: 'x', kind: 'fact', preview: 'nope' })
    expect(readMemoryAudit()).toEqual([])
    setMemoryAuditEnabled(true)
  })

  it('summarizes event counts by type', () => {
    auditMemory({ event: 'write', id: 'a', kind: 'fact', preview: 'x' })
    auditMemory({ event: 'write', id: 'b', kind: 'fact', preview: 'y' })
    auditMemory({ event: 'recall', query: 'q', results: 2, topIds: ['a', 'b'] })
    auditMemory({ event: 'inject', target: 'claude', memoryIds: ['a'], approxTokens: 42 })
    expect(memoryAuditSummary()).toMatchObject({ write: 2, recall: 1, inject: 1 })
  })

  it('rotates the file when it exceeds the cap (bounded growth)', () => {
    _setMaxBytesForTests(4000) // small cap so rotation triggers cheaply
    for (let i = 0; i < 80; i++) auditMemory({ event: 'write', id: 'm' + i, kind: 'fact', preview: 'padding padding padding padding padding' }, i)
    expect(fs.existsSync(path.join(tmp, 'memory-audit.prev.jsonl'))).toBe(true) // previous generation kept
    expect(fs.statSync(auditFile()).size).toBeLessThan(4000 + 500) // live file stays near the cap, not unbounded
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

  it('writes events to its own file and leaves the host\'s file alone', () => {
    initMemoryAudit(tmp, 'main')
    auditMemory({ event: 'inject', target: 'primer', memoryIds: ['a', 'b'], approxTokens: 40 }, 5)
    expect(fs.existsSync(mainFile())).toBe(true)
    expect(fs.existsSync(hostFile())).toBe(false)
    expect(lines(mainFile())).toEqual([{ ts: 5, event: 'inject', target: 'primer', memoryIds: ['a', 'b'], approxTokens: 40 }])
  })

  it('keeps writing to the host\'s file when no role is given, as before', () => {
    initMemoryAudit(tmp)
    auditMemory({ event: 'learn', kind: 'reflect', detail: 'x' })
    expect(fs.existsSync(hostFile())).toBe(true)
    expect(fs.existsSync(mainFile())).toBe(false)
  })

  it('reads the host\'s file and main\'s together, newest first, and counts both', () => {
    // What the memory host process wrote (it is a different process: here, a file this one did not write).
    fs.writeFileSync(hostFile(),
      JSON.stringify({ ts: 10, event: 'write', id: 'w1', kind: 'fact', preview: 'x' }) + '\n' +
      JSON.stringify({ ts: 40, event: 'write', id: 'w2', kind: 'fact', preview: 'y' }) + '\n')
    initMemoryAudit(tmp, 'main')
    auditMemory({ event: 'recall', agentId: 'claude', query: 'q', results: 2, topIds: ['w1', 'w2'] }, 20)
    auditMemory({ event: 'inject', target: 'primer', memoryIds: [], approxTokens: 9 }, 30)
    expect(readMemoryAudit().map((e) => [e.ts, e.event])).toEqual([[40, 'write'], [30, 'inject'], [20, 'recall'], [10, 'write']])
    expect(memoryAuditSummary()).toEqual({ write: 2, recall: 1, inject: 1 })
  })

  it('honours the limit across both files, keeping the newest', () => {
    fs.writeFileSync(hostFile(), [1, 3, 5].map((ts) => JSON.stringify({ ts, event: 'write', id: `h${ts}`, kind: 'fact', preview: '' })).join('\n') + '\n')
    initMemoryAudit(tmp, 'main')
    for (const ts of [2, 4, 6]) auditMemory({ event: 'learn', kind: 'reflect', detail: `m${ts}` }, ts)
    expect(readMemoryAudit(4).map((e) => e.ts)).toEqual([6, 5, 4, 3])
    expect(readMemoryAudit(1).map((e) => e.ts)).toEqual([6])
    expect(readMemoryAudit(0).map((e) => e.ts)).toEqual([6]) // the floor of one, as before
  })

  it('reads either file alone in the order it always did, and nothing when there is none', () => {
    initMemoryAudit(tmp, 'main')
    expect(readMemoryAudit()).toEqual([])
    auditMemory({ event: 'learn', kind: 'reflect', detail: 'first' }, 7)
    auditMemory({ event: 'learn', kind: 'reflect', detail: 'second' }, 7) // same timestamp: newest-appended first
    expect(readMemoryAudit().map((e) => (e as { detail: string }).detail)).toEqual(['second', 'first'])
    fs.rmSync(mainFile())
    fs.writeFileSync(hostFile(), JSON.stringify({ ts: 1, event: 'write', id: 'only', kind: 'fact', preview: '' }) + '\n')
    expect(readMemoryAudit().map((e) => (e as { id: string }).id)).toEqual(['only'])
  })

  it('skips a corrupt line in either file without losing the rest', () => {
    fs.writeFileSync(hostFile(), 'not json\n' + JSON.stringify({ ts: 1, event: 'write', id: 'h', kind: 'fact', preview: '' }) + '\n\n')
    fs.writeFileSync(mainFile(), JSON.stringify({ ts: 2, event: 'learn', kind: 'reflect', detail: 'm' }) + '\n{"ts":3,"ev')
    initMemoryAudit(tmp, 'main')
    expect(readMemoryAudit().map((e) => e.ts)).toEqual([2, 1])
  })

  it('returns nothing before it is initialised', () => {
    expect(readMemoryAudit()).toEqual([])
    expect(memoryAuditSummary()).toEqual({})
  })

  it('rotates its own file at the cap and does not touch the host\'s generations', () => {
    fs.writeFileSync(hostFile(), JSON.stringify({ ts: 1, event: 'write', id: 'h', kind: 'fact', preview: '' }) + '\n')
    fs.writeFileSync(path.join(tmp, 'memory-audit.prev.jsonl'), 'host previous generation\n')
    initMemoryAudit(tmp, 'main')
    _setMaxBytesForTests(2000)
    for (let i = 0; i < 80; i++) auditMemory({ event: 'inject', target: 'primer', memoryIds: ['a', 'b', 'c'], approxTokens: i }, i)
    expect(fs.existsSync(path.join(tmp, 'memory-audit-main.prev.jsonl'))).toBe(true)
    expect(fs.statSync(mainFile()).size).toBeLessThan(2000 + 300)
    expect(fs.readFileSync(path.join(tmp, 'memory-audit.prev.jsonl'), 'utf8')).toBe('host previous generation\n')
    expect(fs.readFileSync(hostFile(), 'utf8')).toContain('"id":"h"')
  })

  it('writes nothing while the audit is switched off', () => {
    initMemoryAudit(tmp, 'main')
    setMemoryAuditEnabled(false)
    auditMemory({ event: 'inject', target: 'primer', memoryIds: [], approxTokens: 1 })
    expect(fs.existsSync(mainFile())).toBe(false)
    setMemoryAuditEnabled(true)
    auditMemory({ event: 'inject', target: 'primer', memoryIds: [], approxTokens: 1 })
    expect(fs.existsSync(mainFile())).toBe(true)
  })

  it('never lets a secret reach the file, however it got into a field', () => {
    initMemoryAudit(tmp, 'main')
    const secret = 'sk-' + 'a'.repeat(40) // low entropy: test-safe
    auditMemory({ event: 'write', id: 'z', kind: 'note', preview: redactPreview('the deploy secret is ' + secret) })
    expect(fs.readFileSync(mainFile(), 'utf8')).not.toContain(secret)
  })

  it('does not persist the query of a recall, whatever the caller passes (a prompt must not be stored)', () => {
    initMemoryAudit(tmp, 'main')
    const prompt = 'please refactor the billing module so the invoice totals match the ledger'
    auditMemory({ event: 'recall', agentId: 'claude', query: redactPreview(prompt), results: 3, topIds: ['a', 'b', 'c'] }, 11)
    const raw = fs.readFileSync(mainFile(), 'utf8')
    expect(raw).not.toContain('billing')
    expect(raw).not.toContain('invoice')
    expect(raw).not.toContain('query')
    // ...and what an auditor needs is still there: when, who, how many, which ids.
    expect(lines(mainFile())).toEqual([{ ts: 11, event: 'recall', agentId: 'claude', results: 3, topIds: ['a', 'b', 'c'] }])
    expect(readMemoryAudit()[0]).not.toHaveProperty('query')
  })

  it('does not persist a recall query on the host\'s side either', () => {
    initMemoryAudit(tmp)
    auditMemory({ event: 'recall', query: 'first words of a prompt', results: 0, topIds: [] })
    expect(fs.readFileSync(hostFile(), 'utf8')).not.toContain('first words')
  })

  it('goes back to the host\'s file when it is initialised again without a role', () => {
    initMemoryAudit(tmp, 'main')
    initMemoryAudit(tmp)
    auditMemory({ event: 'learn', kind: 'reflect', detail: 'x' })
    expect(fs.existsSync(hostFile())).toBe(true)
    expect(fs.existsSync(mainFile())).toBe(false)
  })

  it('is reset to the host\'s file by the test seam', () => {
    initMemoryAudit(tmp, 'main')
    _resetMemoryAuditForTests()
    initMemoryAudit(tmp)
    auditMemory({ event: 'learn', kind: 'reflect', detail: 'x' })
    expect(fs.existsSync(hostFile())).toBe(true)
  })
})
