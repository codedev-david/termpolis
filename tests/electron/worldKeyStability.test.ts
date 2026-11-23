// WPA fix M2: what keys on a folder's project key keeps its key for a normal Windows root, and the annotations a person made
// under a key WPA changed follow the folder to its new key.
import * as crypto from 'crypto'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { adoptAnnotationAliases, createAnnotationStore } from '../../src/main/world/annotations'
import { graphKeyForRoot } from '../../src/main/codeGraph'
import { entityDedupHash } from '../../src/main/swarmMemory'
import { legacyProjectKeyOf, projectKeyAliases, projectKeyOf } from '../../src/main/projectKey'
import type { Claim } from '../../src/shared/world/types'

const sha1 = (s: string): string => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)
const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex')
const claim = (text: string): Claim => ({ text, state: 'verified', evidence: [{ kind: 'person', ref: 'confirmed in Lumopolis' }] })

// Normal Windows roots, spelled as the folder picker and the terminals (shared/cwdPath) hand them over.
const ROOTS = [
  'C:\\Users\\DavidEngelhart\\repos\\termpolis',
  'C:\\Users\\X\\My Repo',
  'D:\\work\\api',
  '\\\\server\\share\\repo',
]

describe('keys that must not move for a normal Windows root', () => {
  it.runIf(process.platform === 'win32')('world stores, code graphs and annotations (graphKeyForRoot) keep the key they had before WPA', () => {
    for (const r of ROOTS) {
      expect(graphKeyForRoot(r)).toBe(legacyProjectKeyOf(r))
      expect(graphKeyForRoot(r)).toBe(projectKeyOf(r))
    }
    expect(graphKeyForRoot('C:\\Users\\DavidEngelhart\\repos\\termpolis')).toBe(sha1('c:/users/davidengelhart/repos/termpolis'))
  })
  it('on any platform, the Windows spelling keeps its pre-WPA key', () => {
    for (const r of ROOTS) expect(projectKeyOf(r, 'win32')).toBe(legacyProjectKeyOf(r))
  })
  it('entity dedup hashes (index.ts: entityDedupHash with projectKeyOf) are unchanged', () => {
    const r = 'C:\\Users\\DavidEngelhart\\repos\\termpolis'
    expect(entityDedupHash('MemoryClient', projectKeyOf(r, 'win32'))).toBe(entityDedupHash('MemoryClient', legacyProjectKeyOf(r)))
  })
  it('a key WPA did change (a Git Bash root) still lists its old key among the aliases', () => {
    const r = '/c/Users/X/repo'
    expect(projectKeyOf(r, 'win32')).not.toBe(legacyProjectKeyOf(r))
    expect(projectKeyAliases(r, 'win32')).toContain(legacyProjectKeyOf(r))
  })
})

describe('adoptAnnotationAliases', () => {
  let dir = ''
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'world-annot-alias-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
  const fileFor = (key: string): string => join(dir, 'world', 'annotations', `${sha256(key)}.json`)

  it('copies the annotations of an older key to the new one, once, and keeps the old file', async () => {
    const store = createAnnotationStore(dir)
    await store.add('old-key', 'b1', claim('the billing door'))
    expect(await adoptAnnotationAliases(dir, 'new-key', ['new-key', 'missing', 'old-key'])).toBe('old-key')
    expect((await store.list('new-key')).b1[0].text).toBe('the billing door')
    expect((await store.list('old-key')).b1[0].text).toBe('the billing door')
    // The new key has its own file now: a second open copies nothing, and never overwrites what was added since.
    await store.add('new-key', 'b2', claim('added after'))
    expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'])).toBeNull()
    expect(Object.keys(await store.list('new-key')).sort()).toEqual(['b1', 'b2'])
  })
  it('a root whose key did not change, no aliases, an empty key, or no older file: nothing is read or copied', async () => {
    expect(await adoptAnnotationAliases(dir, 'k', ['k'])).toBeNull()
    expect(await adoptAnnotationAliases(dir, 'k', [])).toBeNull()
    expect(await adoptAnnotationAliases(dir, '', ['a'])).toBeNull()
    expect(await adoptAnnotationAliases(dir, 'k', ['a', ''])).toBeNull()
  })
  it('a copy that cannot be made leaves the old key as it was and never throws', async () => {
    // The older key's "file" is a folder: it exists, but cannot be copied.
    await mkdir(fileFor('old-key'), { recursive: true })
    expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'])).toBeNull()
    await expect(readFile(fileFor('new-key'), 'utf8')).rejects.toThrow()
  })
})
