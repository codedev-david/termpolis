// WP-E — the audit is wired into the live memory path: a write and a feedback (learning) event are
// recorded through the real swarmMemory API, and a secret in the written content is redacted before
// it reaches the audit file.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  initSwarmMemory,
  memoryWrite,
  memoryFeedback,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'
import { readMemoryAudit, _resetMemoryAuditForTests } from '../../src/main/memoryAudit'
import { executeTool } from '../../src/main/mcpServer'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

describe('memory audit wiring (WP-E)', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memauditwire-'))
    _resetForTests()
    _resetMemoryAuditForTests()
    _setEmbeddingsAvailable(false)
    initSwarmMemory(tmp) // must also initialize the memory audit at this data dir
  })
  afterEach(() => {
    _resetForTests()
    _resetMemoryAuditForTests()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('records a write (secret-redacted) and a feedback learning event', async () => {
    const secret = 'sk-' + 'a'.repeat(40)
    const e = await memoryWrite({ agentId: 'agentX', kind: 'fact', content: 'the deploy token is ' + secret })
    memoryFeedback({ id: e.id, helpful: true })

    const ev = readMemoryAudit()
    const write = ev.find((x) => x.event === 'write') as { event: 'write'; id: string; kind: string; agentId?: string; preview: string } | undefined
    const learn = ev.find((x) => x.event === 'learn') as { event: 'learn'; kind: string; detail: string } | undefined

    expect(write).toMatchObject({ event: 'write', id: e.id, kind: 'fact', agentId: 'agentX' })
    expect(write!.preview).not.toContain(secret) // secret masked before hitting disk
    expect(learn).toMatchObject({ event: 'learn', kind: 'feedback' })
    expect(learn!.detail).toContain(e.id)
    // nothing secret anywhere in the audit file
    expect(fs.readFileSync(path.join(tmp, 'memory-audit.jsonl'), 'utf8')).not.toContain(secret)
  })
  // 1.55.0 starts the main process's side of the audit, so memory_audit (open to every agent, no prompt) now reads the
  // host's file. Two kinds of row are kept from agents, and this tool must not undo that: a lesson Termpolis stored
  // as a candidate, and a note copied from Claude Code's folders (which "Remove imported notes" promises to take out
  // whole). Their words stay out of the audit file, and no preview goes to an agent at all.
  const noHandlers = {} as unknown as Parameters<typeof executeTool>[2]
  async function writeThree() {
    const lesson = await memoryWrite({ agentId: 'mneme', kind: 'decision', tags: ['candidate'], project: '/work/alpha', content: 'CANDIDATEMARK we decided to rename the retry helper and move its backoff settings after the release' })
    const note = await memoryWrite({ agentId: 'claude-notes', source: 'claude-notes', kind: 'fact', tags: ['type:reference', 'note:deploy.md'], project: '/work/employer', content: 'NOTEMARK how the employer build farm is reached over the vpn gateway' })
    const chunk = await memoryWrite({ agentId: 'claude-history', source: 'claude-history', kind: 'message', project: '/work/alpha', content: 'CHUNKMARK user: how do we restart the worker after a crash' })
    return { lesson, note, chunk }
  }

  it('keeps the words of a held-back lesson and of an imported note out of the audit file, and still records that they were stored', async () => {
    const { lesson, note, chunk } = await writeThree()
    const onDisk = fs.readFileSync(path.join(tmp, 'memory-audit.jsonl'), 'utf8')
    expect(onDisk).not.toContain('CANDIDATEMARK')
    expect(onDisk).not.toContain('NOTEMARK')
    expect(onDisk).toContain('CHUNKMARK') // every other row keeps the clipped preview it always had
    const writes = readMemoryAudit().filter((e) => e.event === 'write') as Array<{ id: string; kind: string; agentId?: string; preview: string }>
    expect(writes.map((w) => w.id).sort()).toEqual([lesson.id, note.id, chunk.id].sort())
    expect(writes.find((w) => w.id === lesson.id)).toMatchObject({ kind: 'decision', agentId: 'mneme', preview: '' })
    expect(writes.find((w) => w.id === note.id)).toMatchObject({ kind: 'fact', agentId: 'claude-notes', preview: '' })
  })

  it('does not take a lesson tagged candidate by someone else out of the audit: only the lesson writer holds one back', async () => {
    await memoryWrite({ agentId: 'codex', kind: 'note', tags: ['candidate'], content: 'OWNTAGMARK a person tagged this note candidate themselves' })
    expect(fs.readFileSync(path.join(tmp, 'memory-audit.jsonl'), 'utf8')).toContain('OWNTAGMARK')
  })

  it('memory_audit tells an agent what was stored and by whom, never the words', async () => {
    const { lesson, note, chunk } = await writeThree()
    const out = (await executeTool('memory_audit', { limit: 50 }, noHandlers)) as
      { events: Array<{ event: string; id?: string; kind?: string; agentId?: string }>; summary: Record<string, number> }
    const writes = out.events.filter((e) => e.event === 'write')
    expect(writes.map((w) => w.id).sort()).toEqual([lesson.id, note.id, chunk.id].sort())
    for (const w of writes) expect(w).not.toHaveProperty('preview')
    expect(JSON.stringify(out)).not.toMatch(/MARK|retry helper|vpn gateway|restart the worker/)
    expect(out.summary).toMatchObject({ write: 3 })
    expect(writes.find((w) => w.id === chunk.id)).toMatchObject({ kind: 'message', agentId: 'claude-history' })
  })
})
