// WP-D — entity nodes must be PROJECT-SCOPED. Before this, entity dedup was contentHash(name) with
// no project component, so `parse` in repoA and `parse` in repoB collapsed into ONE shared node,
// manufacturing false cross-repo connections (two unrelated functions appearing linked). The fix
// salts only the DEDUP HASH with projectKey (content stays the bare name, so entities:[content]
// downstream stays clean). Directly serves correct cross-repo behavior.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  initSwarmMemory,
  memoryWrite,
  entityDedupHash,
  contentHash,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'
import { projectKeyOf } from '../../src/main/projectKey'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

describe('entityDedupHash — project-scoped entity identity (WP-D)', () => {
  it('is the bare contentHash when unscoped, and distinct per projectKey when scoped', () => {
    const keyA = projectKeyOf('/repo/a')!
    const keyB = projectKeyOf('/repo/b')!
    expect(entityDedupHash('parse')).toBe(contentHash('parse')) // unscoped == back-compat
    expect(entityDedupHash('parse', keyA)).not.toBe(entityDedupHash('parse', keyB)) // repoA != repoB
    expect(entityDedupHash('parse', keyA)).toBe(entityDedupHash('parse', keyA)) // stable
    expect(entityDedupHash('parse', keyA)).not.toBe(entityDedupHash('parse')) // scoped != global
  })
})

describe('entity nodes no longer collapse across repos (WP-D)', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ent-'))
    _resetForTests()
    _setEmbeddingsAvailable(false)
    initSwarmMemory(tmp)
  })
  afterEach(() => {
    _resetForTests()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  // Mirrors what ensureEntityNode does: content = bare name, dedup hash = projectKey-scoped.
  const writeEntity = (name: string, projectKey?: string) =>
    memoryWrite({ agentId: 'mneme', kind: 'fact', memoryType: 'entity', content: name, importance: 0.3, hash: entityDedupHash(name, projectKey) })

  it('same-named entity in two repos → DISTINCT nodes; same repo → deduped; content stays the bare name', async () => {
    const keyA = projectKeyOf('/repo/a')!
    const keyB = projectKeyOf('/repo/b')!
    const a1 = await writeEntity('parse', keyA)
    const a2 = await writeEntity('parse', keyA) // same repo → dedup to the same node
    const b1 = await writeEntity('parse', keyB) // different repo → distinct node

    expect(a2.id).toBe(a1.id) // same-repo dedup preserved
    expect(b1.id).not.toBe(a1.id) // cross-repo NO LONGER collapses (the bug)
    expect(a1.content).toBe('parse') // content is the clean bare name...
    expect(b1.content).toBe('parse') // ...so entities:[content] downstream stays clean
  })

  it('unscoped (global) entities still dedup by name', async () => {
    const g1 = await writeEntity('ECONNRESET')
    const g2 = await writeEntity('ECONNRESET')
    expect(g2.id).toBe(g1.id)
  })
})
