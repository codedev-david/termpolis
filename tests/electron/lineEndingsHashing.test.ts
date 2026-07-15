// Content hashes must be identical across operating systems: the same text with CRLF (Windows) and
// LF (macOS/Linux) has to produce the same hash, or the synced memory store dedups against nothing
// and the Safe-Import allowlist re-prompts after a sync. See lineEndings.ts.
import { describe, it, expect } from 'vitest'
import { normalizeNewlines } from '../../src/main/lineEndings'
import { contentHash } from '../../src/main/swarmMemory'
import { artifactHash } from '../../src/main/importTrust'
import { chunkCode } from '../../src/main/codeIngest'

const crlf = (s: string) => s.replace(/\n/g, '\r\n')

describe('normalizeNewlines', () => {
  it('collapses CRLF and lone CR to LF', () => {
    expect(normalizeNewlines('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
  })
  it('is idempotent and null-safe', () => {
    expect(normalizeNewlines('a\nb')).toBe('a\nb')
    expect(normalizeNewlines('' as unknown as string)).toBe('')
  })
})

describe('contentHash — memory store dedup is OS-independent', () => {
  it('hashes CRLF and LF copies of the same content identically', () => {
    const lf = 'def hello():\n    return 1\n\nx = 2\n'
    expect(contentHash(crlf(lf))).toBe(contentHash(lf))
  })
  it('still distinguishes genuinely different content', () => {
    expect(contentHash('alpha')).not.toBe(contentHash('beta'))
  })
})

describe('artifactHash — Safe-Import pins survive a cross-OS sync (and dir-vs-zip)', () => {
  it('hashes a CRLF artifact the same as its LF twin', () => {
    const lf = [{ path: 'skill.md', content: 'line one\nline two\n' }]
    const asCrlf = [{ path: 'skill.md', content: crlf('line one\nline two\n') }]
    expect(artifactHash(asCrlf)).toBe(artifactHash(lf))
  })
  it('a genuinely different artifact still hashes differently', () => {
    expect(artifactHash([{ path: 'a', content: 'x' }])).not.toBe(artifactHash([{ path: 'a', content: 'y' }]))
  })
})

describe('code chunk hashes — same repo on Windows and Linux dedups', () => {
  it('a CRLF file and its LF twin produce identical chunk hashes', () => {
    const lf = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n') + '\n'
    const lfChunks = chunkCode('src/x.ts', lf, { maxLines: 60 })
    const crlfChunks = chunkCode('src/x.ts', crlf(lf), { maxLines: 60 })
    expect(crlfChunks.length).toBeGreaterThan(0)
    expect(crlfChunks.map((c) => c.hash)).toEqual(lfChunks.map((c) => c.hash))
  })
})
