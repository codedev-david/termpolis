import { describe, it, expect, afterEach } from 'vitest'
const { rewriteMessagesBody, setWireWindow } = await import('../../src/main/headroomProxy/wireCompress')

// Edge + fail-open paths of the wire rewriter. Every case here asserts the SAME
// invariant the proxy is built on: when anything is off, the ORIGINAL body goes
// out byte-identical (cache-safe) and nothing is stashed.

function bodyWith(content: unknown): string {
  return JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] }] })
}
function imageBody(source: unknown): string {
  return JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'image', source }] }] })
}

afterEach(() => { setWireWindow({ headLines: 12, tailLines: 6, maxChars: 1000 }) })

describe('wire rewrite — no-shrink and pure-dedup paths', () => {
  it('forwards the original when compaction yields no net shrink', () => {
    // >=400 chars (past the short-circuit) but a single line: nothing to dedup,
    // nothing to elide — compaction can only break even, so the original wins.
    const oneLongLine = 'x'.repeat(600)
    const raw = bodyWith(oneLongLine)
    const r = rewriteMessagesBody(raw)
    expect(r.changed).toBe(false)
    expect(r.body).toBe(raw)
    expect(r.stashes).toHaveLength(0)
  })

  it('collapses identical consecutive lines and stashes the original for retrieve_full', () => {
    // A run collapse counts as elision, so the footer + stash must be present:
    // the hidden lines are only recoverable through the retrieve token.
    setWireWindow({ headLines: 500, tailLines: 500, maxChars: 1_000_000 })
    const dup = Array.from({ length: 40 }, () => 'the exact same repeated line of output').join('\n')
    const r = rewriteMessagesBody(bodyWith(dup))
    expect(r.changed).toBe(true)
    expect(r.body).toContain('(×39 identical lines)')
    expect(r.body).toContain('retrieve_full')
    expect(r.stashes).toHaveLength(1)
    expect(r.stashes[0].original).toBe(dup) // original recoverable byte-for-byte
  })
})

describe('wire rewrite — guards that fail open', () => {
  it('skips a body larger than maxBodyChars without parsing it', () => {
    const raw = bodyWith('y'.repeat(5000))
    const r = rewriteMessagesBody(raw, { maxBodyChars: 100 })
    expect(r.changed).toBe(false)
    expect(r.body).toBe(raw)
    expect(r.stats.trBlocks).toBe(0)
  })

  it('skips messages whose content is null or not an array', () => {
    const raw = JSON.stringify({ messages: [null, { role: 'user' }, { role: 'user', content: 'plain string' }] })
    const r = rewriteMessagesBody(raw)
    expect(r.changed).toBe(false)
    expect(r.body).toBe(raw)
  })

  it('skips content blocks that are null or primitives', () => {
    const raw = JSON.stringify({ messages: [{ role: 'user', content: [null, 42, 'text'] }] })
    const r = rewriteMessagesBody(raw)
    expect(r.changed).toBe(false)
    expect(r.body).toBe(raw)
  })
})

describe('wire rewrite — image block guards', () => {
  const big = 'A'.repeat(2000)

  it('ignores an image block with a missing or non-base64 source', () => {
    const compress = (): { data: string; mediaType: string; changed: boolean } => {
      throw new Error('compressor must not be called for an invalid source')
    }
    for (const src of [undefined, { type: 'url', data: big }, { type: 'base64', data: 12 }]) {
      const raw = imageBody(src)
      const r = rewriteMessagesBody(raw, { compressImage: compress })
      expect(r.changed).toBe(false)
      expect(r.body).toBe(raw)
    }
  })

  it('ignores a compressor that throws, returns nothing, or fails to shrink', () => {
    const cases = [
      () => { throw new Error('decode failed') },
      () => null as unknown as { data: string; mediaType: string; changed: boolean },
      () => ({ data: big, mediaType: 'image/png', changed: false }),
      () => ({ data: 7 as unknown as string, mediaType: 'image/png', changed: true }),
      () => ({ data: big + 'LONGER', mediaType: 'image/png', changed: true }), // grew → reject
    ]
    for (const compressImage of cases) {
      const raw = imageBody({ type: 'base64', media_type: 'image/png', data: big })
      const r = rewriteMessagesBody(raw, { compressImage })
      expect(r.changed).toBe(false)
      expect(r.body).toBe(raw)
      expect(r.stats.images).toBe(0)
    }
  })

  it('fails open when a misbehaving compressor throws mid-assignment', () => {
    let reads = 0
    const compressImage = (): { data: string; mediaType: string; changed: boolean } =>
      ({
        changed: true,
        mediaType: 'image/png',
        get data(): string {
          reads++
          if (reads > 2) throw new Error('exploded after validation')
          return 'A'.repeat(10)
        },
      })
    const raw = imageBody({ type: 'base64', media_type: 'image/png', data: big })
    const r = rewriteMessagesBody(raw, { compressImage })
    expect(r.changed).toBe(false)
    expect(r.body).toBe(raw)
    expect(r.stats.images).toBe(0) // stats reset by the fail-open path
    expect(r.stashes).toHaveLength(0)
  })

  it('fails open when the rewritten object can no longer be serialized', () => {
    // media_type is not validated (only data is), so a non-serializable value
    // survives into the object and blows up the final stringify.
    const compressImage = (): { data: string; mediaType: string; changed: boolean } =>
      ({ data: 'A'.repeat(10), mediaType: 1n as unknown as string, changed: true })
    const raw = imageBody({ type: 'base64', media_type: 'image/png', data: big })
    const r = rewriteMessagesBody(raw, { compressImage })
    expect(r.changed).toBe(false)
    expect(r.body).toBe(raw)
    expect(r.stats.images).toBe(0)
  })
})
