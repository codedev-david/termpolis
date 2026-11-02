// @vitest-environment node
// The two channels behind Settings > Memory & Learning > Activity record: how big the record is, and clear it. They answer
// with the app-data folder they are handed, never a path the renderer names, and they never throw into the renderer.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AUDIT_IPC, registerMemoryAuditIpc, type AuditIpcLike } from '../../src/main/memoryAuditIpc'
import { AUDIT_FILES } from '../../src/main/memoryAudit'

let tmp = ''
let handlers: Map<string, (event: unknown, input?: unknown) => unknown>

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-ipc-'))
  handlers = new Map()
  const ipc: AuditIpcLike = { handle: (channel, listener) => { handlers.set(channel, listener) } }
  registerMemoryAuditIpc(ipc, { dir: () => tmp })
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const call = (channel: string, input?: unknown): Promise<any> => Promise.resolve(handlers.get(channel)!(undefined, input))

describe('the activity record: its IPC', () => {
  it('registers exactly two channels', () => {
    expect([...handlers.keys()].sort()).toEqual(['memory:audit-clear', 'memory:audit-size'])
    expect(AUDIT_IPC).toEqual({ size: 'memory:audit-size', clear: 'memory:audit-clear' })
  })

  it('says how big the record is in the app-data folder', async () => {
    expect(await call(AUDIT_IPC.size)).toEqual({ success: true, data: { files: 0, bytes: 0 } })
    fs.writeFileSync(path.join(tmp, 'memory-audit.jsonl'), 'a'.repeat(30))
    fs.writeFileSync(path.join(tmp, 'memory-audit-main.jsonl'), 'b'.repeat(12))
    expect(await call(AUDIT_IPC.size)).toEqual({ success: true, data: { files: 2, bytes: 42 } })
  })

  it('clears the record, and says what it removed', async () => {
    for (const name of AUDIT_FILES) fs.writeFileSync(path.join(tmp, name), 'x')
    fs.writeFileSync(path.join(tmp, 'swarm-memory.jsonl'), 'a memory')
    expect(await call(AUDIT_IPC.clear)).toEqual({ success: true, data: { removed: 4, failed: 0 } })
    expect(fs.existsSync(path.join(tmp, 'memory-audit.jsonl'))).toBe(false)
    expect(fs.existsSync(path.join(tmp, 'swarm-memory.jsonl'))).toBe(true)
    expect(await call(AUDIT_IPC.size)).toEqual({ success: true, data: { files: 0, bytes: 0 } })
  })

  it('ignores whatever the renderer sends along: the folder is the one it was handed', async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-ipc-other-'))
    try {
      fs.writeFileSync(path.join(elsewhere, 'memory-audit.jsonl'), 'keep me')
      fs.writeFileSync(path.join(tmp, 'memory-audit.jsonl'), 'x')
      expect(await call(AUDIT_IPC.clear, { dir: elsewhere, path: elsewhere })).toEqual({ success: true, data: { removed: 1, failed: 0 } })
      expect(fs.readFileSync(path.join(elsewhere, 'memory-audit.jsonl'), 'utf8')).toBe('keep me')
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  // A renderer can send any value: the folder as text, a list, a number, nothing. None of them is read as a folder, on either channel.
  it.each([
    ['the folder as plain text', (dir: string) => dir],
    ['a list holding the folder', (dir: string) => [dir]],
    ['an object with the folder under several names', (dir: string) => ({ dir, path: dir, folder: dir, userData: dir })],
    ['null', () => null],
    ['a number', () => 7],
  ])('does not take %s for the folder, on either channel', async (_label, send) => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-ipc-other-'))
    try {
      fs.writeFileSync(path.join(elsewhere, 'memory-audit.jsonl'), 'keep me')
      fs.writeFileSync(path.join(tmp, 'memory-audit.jsonl'), 'x')
      expect(await call(AUDIT_IPC.size, send(elsewhere))).toEqual({ success: true, data: { files: 1, bytes: 1 } }) // the handed folder's one byte, not 'keep me'
      expect(await call(AUDIT_IPC.clear, send(elsewhere))).toEqual({ success: true, data: { removed: 1, failed: 0 } })
      expect(fs.existsSync(path.join(tmp, 'memory-audit.jsonl'))).toBe(false)
      expect(fs.readFileSync(path.join(elsewhere, 'memory-audit.jsonl'), 'utf8')).toBe('keep me')
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('reports a file it could not remove', async () => {
    fs.mkdirSync(path.join(tmp, 'memory-audit.jsonl')) // a folder where the file should be: it cannot be unlinked as a file
    expect(await call(AUDIT_IPC.clear)).toEqual({ success: true, data: { removed: 0, failed: 1 } })
  })

  it('answers with the error, and does not throw, when the app-data folder cannot be found', async () => {
    const throwing = new Map<string, (event: unknown, input?: unknown) => unknown>()
    registerMemoryAuditIpc({ handle: (channel, listener) => { throwing.set(channel, listener) } }, { dir: () => { throw new Error('no userData') } })
    expect(await Promise.resolve(throwing.get(AUDIT_IPC.size)!(undefined))).toEqual({ success: false, error: 'no userData' })
    expect(await Promise.resolve(throwing.get(AUDIT_IPC.clear)!(undefined))).toEqual({ success: false, error: 'no userData' })
  })

  it('names an error that is not an Error', async () => {
    const throwing = new Map<string, (event: unknown, input?: unknown) => unknown>()
    registerMemoryAuditIpc({ handle: (channel, listener) => { throwing.set(channel, listener) } }, { dir: () => { throw 'plain text' } })
    expect(await Promise.resolve(throwing.get(AUDIT_IPC.clear)!(undefined))).toEqual({ success: false, error: 'plain text' })
  })
})
