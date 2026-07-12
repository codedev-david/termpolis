// Memory-at-rest secret scrub — a secret must be REDACTED OUT of a memory BEFORE the brain
// stores it. Without this, an agent transcript or an indexed code chunk carrying an API key
// gets written to swarm-memory.jsonl, embedded into a vector, and later RECALLED and
// re-injected into another agent's context. The scrub therefore has to run on the WRITE path,
// ahead of the hash, the embed and the persist.
//
// NOTE: the secret samples below use repeated characters on purpose — they satisfy the rule
// regexes while failing entropy heuristics, so GitHub push protection won't block this test
// file (see reference_secret_scanner_test_gotcha).
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// aiSecurity reads app.getPath('userData') at init. Give it a stable dir of its own so the
// per-test swarmMemory dir can be torn down without disturbing it.
const secDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-scrub-sec-'))
vi.mock('electron', () => ({ app: { getPath: () => secDir } }))

const mockRecordSwarmError = vi.fn()
vi.mock('../../src/main/telemetry', () => ({
  recordSwarmError: (...args: any[]) => mockRecordSwarmError(...args),
}))

import {
  initSwarmMemory,
  memoryWrite,
  memoryList,
  memoryCount,
  memoryScrubStats,
  setMemoryScrubber,
  _resetForTests,
  _setScrubFnForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
} from '../../src/main/swarmMemory'
import { scanText, getSettings, setMemoryScrub } from '../../src/main/aiSecurity'

const AWS_KEY = 'AKIA' + 'A'.repeat(16)
const AWS_KEY_2 = 'AKIA' + 'B'.repeat(16)
const OPENAI_KEY = 'sk-' + 'a'.repeat(24)

// The EXACT scrubber src/main/index.ts is expected to install: the real ~70-rule scanner,
// gated on the real `memoryScrub` setting. Testing through this (not a hand-rolled fake)
// proves the production wiring actually redacts.
const productionScrubber = (content: string) => {
  if (!getSettings().memoryScrub) return { redacted: content, hitCount: 0 }
  return scanText(content)
}

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-scrub-'))
  _resetForTests()
  initSwarmMemory(tmpDir)
  _setEmbeddingsAvailable(false) // keyword fallback unless a test injects an embedder
  setMemoryScrub(true)           // default-on gate; a test that flips it restores here
  setMemoryScrubber(productionScrubber)
  mockRecordSwarmError.mockReset()
})

afterEach(() => {
  _resetForTests()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  vi.restoreAllMocks()
})

afterAll(() => {
  try { fs.rmSync(secDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

/** The raw bytes of this device's shard — what an attacker reading the disk would see. */
function shardBytes(): string {
  return fs.readFileSync(path.join(tmpDir, 'swarm-memory.jsonl'), 'utf8')
}

/** The persisted records, parsed back off disk. */
function shardEntries(): Array<Record<string, unknown>> {
  return shardBytes()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((o) => typeof o.content === 'string')
}

describe('memory-at-rest scrub: a secret never reaches the brain', () => {
  it('persists an AWS key REDACTED — the raw key is nowhere in the stored entry or on disk', async () => {
    const w = await memoryWrite({
      agentId: 'claude',
      kind: 'fact',
      content: `prod deploy uses ${AWS_KEY} for s3 access`,
    })

    // Returned entry
    expect(w.content).not.toContain(AWS_KEY)
    expect(w.content).toBe('prod deploy uses [REDACTED:aws_access_key] for s3 access')
    // Hot window
    expect(memoryList()[0].content).toBe('prod deploy uses [REDACTED:aws_access_key] for s3 access')
    // Disk — the whole point of the feature
    expect(shardBytes()).not.toContain(AWS_KEY)
    expect(shardEntries()[0].content).toBe('prod deploy uses [REDACTED:aws_access_key] for s3 access')
  })

  it('survives a reload — the redacted text is what comes back off disk', async () => {
    await memoryWrite({ agentId: 'claude', kind: 'note', content: `token dump ${OPENAI_KEY} end` })
    _resetForTests()
    initSwarmMemory(tmpDir)
    _setEmbeddingsAvailable(false)
    expect(memoryCount()).toBe(1)
    expect(memoryList()[0].content).toBe('token dump [REDACTED:openai_key] end')
    expect(memoryList()[0].content).not.toContain(OPENAI_KEY)
  })

  it('redacts every secret in a multi-secret memory', async () => {
    const w = await memoryWrite({ agentId: 'a', kind: 'fact', content: `creds: ${AWS_KEY} and ${OPENAI_KEY}` })
    expect(w.content).toBe('creds: [REDACTED:aws_access_key] and [REDACTED:openai_key]')
    expect(shardBytes()).not.toContain(AWS_KEY)
    expect(shardBytes()).not.toContain(OPENAI_KEY)
  })
})

describe('clean content is never mutated', () => {
  it('stores secret-free content byte-for-byte unchanged', async () => {
    // Whitespace-significant + non-ASCII: a scanner round-trip must not normalize any of it.
    const clean = 'def f():\n    return 1  \n\n# note: naïve — “curly” quotes\tand a tab'
    const w = await memoryWrite({ agentId: 'a', kind: 'note', content: clean })

    expect(w.content).toBe(clean)                    // byte-for-byte
    expect(memoryList()[0].content).toBe(clean)
    expect(shardEntries()[0].content).toBe(clean)
    expect(w.scrubbed).toBeUndefined()               // nothing was scrubbed
    expect(memoryScrubStats().scrubbedWrites).toBe(0)
  })

  it('leaves content verbatim when no scrubber is installed', async () => {
    setMemoryScrubber(null)
    const raw = `prod deploy uses ${AWS_KEY} for s3 access`
    const w = await memoryWrite({ agentId: 'a', kind: 'note', content: raw })
    expect(w.content).toBe(raw)
    expect(w.scrubbed).toBeUndefined()
    expect(memoryScrubStats().scrubbedWrites).toBe(0)
  })
})

describe('the scrub runs BEFORE hashing and BEFORE embedding', () => {
  it('hashes the REDACTED text — two memories differing only in the secret value dedupe to one', async () => {
    const w1 = await memoryWrite({ agentId: 'a', kind: 'fact', content: `deploy key for prod: ${AWS_KEY}` })
    const w2 = await memoryWrite({ agentId: 'a', kind: 'fact', content: `deploy key for prod: ${AWS_KEY_2}` })

    // Both redact to the SAME text ⇒ the same content hash ⇒ the second is a dedup hit.
    // This can only hold if the scrub happened before contentHash() ran.
    expect(w2.id).toBe(w1.id)
    expect(memoryCount()).toBe(1)
    expect(w1.hash).toBe(w2.hash)
    expect(memoryList()[0].content).toBe('deploy key for prod: [REDACTED:aws_access_key]')
  })

  it('embeds the REDACTED text — the raw secret never reaches the vector', async () => {
    const seen: string[] = []
    _setEmbedFnForTests(async (text: string) => { seen.push(text); return [0.1, 0.2, 0.3] })

    await memoryWrite({ agentId: 'a', kind: 'fact', content: `prod deploy uses ${AWS_KEY} for s3 access` })

    expect(seen.length).toBeGreaterThan(0)
    for (const t of seen) expect(t).not.toContain(AWS_KEY)
    expect(seen[0]).toContain('[REDACTED:aws_access_key]')
  })
})

describe('the setting is respected', () => {
  it('stores content verbatim when memoryScrub is turned OFF', async () => {
    setMemoryScrub(false)
    expect(getSettings().memoryScrub).toBe(false)

    const raw = `prod deploy uses ${AWS_KEY} for s3 access`
    const w = await memoryWrite({ agentId: 'a', kind: 'note', content: raw })

    expect(w.content).toBe(raw)                  // verbatim — the user opted out
    expect(shardBytes()).toContain(AWS_KEY)
    expect(w.scrubbed).toBeUndefined()
    expect(memoryScrubStats().scrubbedWrites).toBe(0)
  })

  it('scrubs again as soon as the setting is turned back ON', async () => {
    setMemoryScrub(false)
    await memoryWrite({ agentId: 'a', kind: 'note', content: `off: ${AWS_KEY}` })
    setMemoryScrub(true)
    const w = await memoryWrite({ agentId: 'a', kind: 'note', content: `on: ${AWS_KEY}` })
    expect(w.content).toBe('on: [REDACTED:aws_access_key]')
  })
})

describe('the scrub is observable (so the caller can audit it)', () => {
  it('reports the per-write hit count on the returned entry', async () => {
    const one = await memoryWrite({ agentId: 'a', kind: 'fact', content: `only ${AWS_KEY}` })
    expect(one.scrubbed).toBe(1)

    const two = await memoryWrite({ agentId: 'a', kind: 'fact', content: `both ${AWS_KEY} and ${OPENAI_KEY}` })
    expect(two.scrubbed).toBe(2)
  })

  it('accumulates scrubbed-write and redacted-secret totals', async () => {
    expect(memoryScrubStats()).toEqual({ scrubbedWrites: 0, secretsRedacted: 0 })
    await memoryWrite({ agentId: 'a', kind: 'note', content: `a ${AWS_KEY}` })
    await memoryWrite({ agentId: 'a', kind: 'note', content: `b ${AWS_KEY} ${OPENAI_KEY}` })
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'c is clean' })
    expect(memoryScrubStats()).toEqual({ scrubbedWrites: 2, secretsRedacted: 3 })
  })

  it('keeps the scrub count TRANSIENT — it is never persisted onto the stored entry', async () => {
    await memoryWrite({ agentId: 'a', kind: 'fact', content: `x ${AWS_KEY}` })
    expect(memoryList()[0].scrubbed).toBeUndefined()   // hot-window copy is clean
    const [onDisk] = shardEntries()
    expect('scrubbed' in onDisk).toBe(false)           // and so is the JSONL record
  })
})

describe('the scrubber can never break a write', () => {
  it('falls back to the unscrubbed content and surfaces a throwing scrubber', async () => {
    _setScrubFnForTests(() => { throw new Error('scanner blew up') })
    const w = await memoryWrite({ agentId: 'a', kind: 'note', content: 'still worth keeping' })
    expect(w.content).toBe('still worth keeping')      // the memory is NOT lost
    expect(memoryCount()).toBe(1)
    expect(mockRecordSwarmError).toHaveBeenCalledWith(
      'swarmMemory.scrub.failed',
      expect.any(Error),
      expect.anything(),
    )
  })

  it('ignores a malformed scrubber result rather than storing garbage', async () => {
    _setScrubFnForTests(() => ({ redacted: undefined as unknown as string, hitCount: 3 }))
    const w = await memoryWrite({ agentId: 'a', kind: 'note', content: 'intact content' })
    expect(w.content).toBe('intact content')
    expect(memoryScrubStats().scrubbedWrites).toBe(0)
  })
})
