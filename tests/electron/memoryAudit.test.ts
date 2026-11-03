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
})
