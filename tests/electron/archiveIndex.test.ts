// Tier-2 — deep-recall over the archive was an O(whole-file) re-read + re-parse on EVERY query
// ("unusable once the archive is large"). Now the parsed archive is cached and keyed by the file's
// size+mtime: repeated queries reuse it, and it self-invalidates the instant the file changes (a new
// archive append), so it can never serve stale results.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  initSwarmMemory,
  memoryWrite,
  memoryArchive,
  searchArchive,
  _resetForTests,
  _setEmbeddingsAvailable,
  _archiveReadCountForTests,
} from '../../src/main/swarmMemory'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

describe('archive deep-recall cache (Tier-2)', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'))
    _resetForTests()
    _setEmbeddingsAvailable(false)
    initSwarmMemory(tmp)
  })
  afterEach(() => {
    _resetForTests()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  const archive = async (content: string): Promise<void> => {
    const e = await memoryWrite({ agentId: 'a', kind: 'fact', content })
    memoryArchive(e.id)
  }

  it('finds archived content, and reflects newly-archived entries (cache invalidates on append)', async () => {
    await archive('archived note about the alpha subsystem')
    expect(searchArchive('alpha subsystem').map((e) => e.content)).toContain('archived note about the alpha subsystem')

    await archive('archived note about the bravo subsystem')
    // If the cache served stale results, bravo would be missing — it must appear (invalidated on append).
    expect(searchArchive('bravo subsystem').map((e) => e.content)).toContain('archived note about the bravo subsystem')
    expect(searchArchive('alpha subsystem').map((e) => e.content)).toContain('archived note about the alpha subsystem')
  })

  it('does not re-read the archive file on repeated unchanged queries, re-reads once after a change', async () => {
    await archive('archived note about the delta subsystem')
    expect(_archiveReadCountForTests()).toBe(0)
    searchArchive('delta subsystem') // cache miss → one read+parse
    searchArchive('delta subsystem') // unchanged file → cache hit, no read
    searchArchive('delta subsystem')
    expect(_archiveReadCountForTests()).toBe(1) // parsed once, reused across queries

    await archive('archived note about the echo subsystem') // file grows → key changes
    searchArchive('echo subsystem') // must re-read exactly once to pick up the new entry
    searchArchive('echo subsystem') // then cached again
    expect(_archiveReadCountForTests()).toBe(2)
  })
})
