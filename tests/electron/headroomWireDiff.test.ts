import { describe, it, expect, beforeEach, afterEach } from 'vitest'
const { rewriteMessagesBody, setWireWindow } = await import('../../src/main/headroomProxy/wireCompress')

const file = (n: number, edit?: [number, string]): string => {
  const out = Array.from({ length: n }, (_, i) => `  const value${i} = compute(${i}) // a reasonably long source line`)
  if (edit) out[edit[0]] = edit[1]
  return out.join('\n')
}

/** Two tool_results in one body, in wire order. */
function bodyWith(...texts: string[]): string {
  const messages: unknown[] = []
  texts.forEach((t, i) => {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `tu${i}`, name: 'Read', input: {} }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu${i}`, content: t }] })
  })
  return JSON.stringify({ model: 'claude-x', messages })
}

const resultText = (body: string, idx: number): string =>
  JSON.parse(body).messages[idx * 2 + 1].content[0].content

/**
 * Idea B end-to-end. Exact-duplicate collapse already existed and already covered the cached
 * prefix (the prefix is re-sent verbatim every turn, so a repeat always finds its twin in the
 * same body). What it always missed is the read-edit-reread shape, which is the DOMINANT one in
 * an editing loop: near-identical, never byte-identical.
 */
describe('rewriteMessagesBody — near-duplicate patching', () => {
  // A window wide enough that ordinary compaction does nothing, so this isolates the diff path.
  beforeEach(() => setWireWindow({ headLines: 5000, tailLines: 5000, maxChars: 1_000_000 }))
  afterEach(() => setWireWindow({ headLines: 12, tailLines: 6, maxChars: 1000 }))

  it('sends a re-read file as a patch against the earlier read in the same body', () => {
    const first = file(60)
    const second = file(60, [30, '  const value30 = compute(30) + 1 // EDITED'])
    const r = rewriteMessagesBody(bodyWith(first, second))
    expect(r.changed).toBe(true)
    expect(resultText(r.body, 0)).toBe(first) // the base is forwarded untouched
    const patched = resultText(r.body, 1)
    expect(patched).toContain('except for the lines below')
    expect(patched).toContain('+  const value30 = compute(30) + 1 // EDITED')
    expect(patched.length).toBeLessThan(second.length / 2)
  })

  it('stashes the TRUE original behind the patch, so retrieve_full is still lossless', () => {
    const first = file(60)
    const second = file(60, [30, '  const value30 = EDITED'])
    const r = rewriteMessagesBody(bodyWith(first, second))
    const token = /token "(hr_[a-z0-9]+)"/.exec(resultText(r.body, 1))?.[1]
    expect(token).toBeTruthy()
    const stash = r.stashes.find((s) => s.token === token)
    expect(stash?.original).toBe(second) // not the patch, not the base
  })

  it('is byte-stable across turns — recompressing the same body gives identical output', () => {
    // The whole transform must be a pure function of the body or the Anthropic prompt cache dies.
    const raw = bodyWith(file(60), file(60, [30, '  const value30 = EDITED']))
    expect(rewriteMessagesBody(raw).body).toBe(rewriteMessagesBody(raw).body)
  })

  it('still collapses a byte-identical repeat to the shorter stub, not a patch', () => {
    const same = file(60)
    const r = rewriteMessagesBody(bodyWith(same, same))
    const second = resultText(r.body, 1)
    expect(second).toContain('Identical to an earlier tool result')
    expect(second).not.toContain('@@') // stub, no hunk header
    expect(second.split('\n')).toHaveLength(1)
  })

  it('never enlarges a block — an unrelated second result is left as-is', () => {
    const a = file(60)
    const b = Array.from({ length: 60 }, (_, i) => `totally different content ${i} nothing shared here at all`).join('\n')
    const r = rewriteMessagesBody(bodyWith(a, b))
    expect(resultText(r.body, 1)).toBe(b)
  })

  it('counts the patched block in trBlocks so the receipt reflects it', () => {
    const r = rewriteMessagesBody(bodyWith(file(60), file(60, [30, '  const value30 = EDITED'])))
    expect(r.stats.trBlocks).toBe(1)
    expect(r.stats.trCompChars).toBeLessThan(r.stats.trOrigChars)
  })

  it('prefers whichever is smaller — normal compaction wins when the window is tight', () => {
    setWireWindow({ headLines: 2, tailLines: 1, maxChars: 1000 })
    const first = file(60)
    const second = file(60, [30, '  const value30 = EDITED'])
    const patched = resultText(rewriteMessagesBody(bodyWith(first, second)).body, 1)
    expect(patched.length).toBeLessThan(second.length)
    expect(patched).not.toContain('@@') // a 3-line window beats a 2-line patch + framing
  })
})
