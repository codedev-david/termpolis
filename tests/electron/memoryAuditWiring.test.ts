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
})
