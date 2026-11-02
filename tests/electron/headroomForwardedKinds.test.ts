import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { DECAY_FIRST_THRESHOLD } from '../../src/main/headroomProxy/prefixDecay'
const { classifyForwardedResults, classifyMessages, emptyKinds } = await import('../../src/main/headroomProxy/forwardedKinds')
const { rewriteMessagesBody, setWireWindow } = await import('../../src/main/headroomProxy/wireCompress')

/**
 * R1 criterion 7. The research could not say why, in one live session, the first tool results
 * arrived as content-free "Aged out" stubs when the code makes those only after 128 messages. The
 * next occurrence must be countable, so every request's forwarded body is classified: how many
 * tool-result texts reached the model plain, compacted behind a footer, collapsed to a dedup stub,
 * sent as a patch, or aged out, and how many of the aged-out ones sat in a body too short for the
 * decay pass to have produced them.
 *
 * The golden bodies are produced by the real rewriter, not typed by hand, so the classifier cannot
 * agree with a stub text the compressor no longer emits.
 */

const lines = (n: number, tag = 'v'): string =>
  Array.from({ length: n }, (_, i) => `  const ${tag}${i} = compute(${i}) // a reasonably long source line`).join('\n')

function bodyOf(texts: string[], tool = 'Read'): string {
  const messages: unknown[] = []
  texts.forEach((t, i) => {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `tu${i}`, name: tool, input: {} }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu${i}`, content: t }] })
  })
  return JSON.stringify({ model: 'claude-x', messages })
}
const kinds = (over: Partial<ReturnType<typeof emptyKinds>> = {}) => ({ ...emptyKinds(), ...over })

describe('classifyForwardedResults — where it is found', () => {
  it('is reachable from wireCompress, which the design names, and is the same function', async () => {
    // Both from one registry. The top-level imports above are the first one; a test further down resets the
    // modules, after which a fresh import of wireCompress brings a fresh forwardedKinds with it, so comparing
    // that with the top-level function would pass or fail by the order the tests ran in.
    const kindsModule = await import('../../src/main/headroomProxy/forwardedKinds')
    const viaWire = await import('../../src/main/headroomProxy/wireCompress')
    expect(viaWire.classifyForwardedResults).toBe(kindsModule.classifyForwardedResults)
  })

  it('agrees with the tally the rewriter keeps on its stats, for the body it forwards', () => {
    const raw = bodyOf([lines(80), 'ok', lines(80)])
    const r = rewriteMessagesBody(raw)
    expect(classifyForwardedResults(r.body)).toEqual(r.stats.kinds)
  })
})

describe('classifyForwardedResults — one golden body per kind', () => {
  it('a short result is plain', () => {
    expect(classifyForwardedResults(rewriteMessagesBody(bodyOf(['ok'])).body)).toEqual(kinds({ plain: 1 }))
  })

  it('a long result compacted behind a footer is compact', () => {
    const r = rewriteMessagesBody(bodyOf([lines(60)]))
    expect(r.stashes[0].meta?.kind).toBe('compact') // the fixture is what it claims to be
    expect(classifyForwardedResults(r.body)).toEqual(kinds({ compact: 1 }))
  })

  it('a repeat of an identical result is a dedup stub', () => {
    const same = lines(60)
    const r = rewriteMessagesBody(bodyOf([same, same]))
    expect(r.stashes.map((s) => s.meta?.kind)).toEqual(['compact', 'dedup'])
    expect(classifyForwardedResults(r.body)).toEqual(kinds({ compact: 1, dedup: 1 }))
  })

  it('a near-repeat sent as a patch is a diff, not a compaction', () => {
    setWireWindow({ headLines: 5000, tailLines: 5000, maxChars: 1_000_000, floorChars: 0 })
    try {
      const r = rewriteMessagesBody(bodyOf([lines(60), lines(60).replace('compute(30)', 'compute(30) + 1 // EDITED')]))
      expect(r.stashes.map((s) => s.meta?.kind)).toEqual(['diff'])
      expect(classifyForwardedResults(r.body)).toEqual(kinds({ plain: 1, diff: 1 }))
    } finally { setWireWindow({ headLines: 12, tailLines: 6, maxChars: 1000, floorChars: 1600 }) }
  })

  it('a result aged out of a long conversation is aged, and not early', () => {
    const msgs: unknown[] = []
    const n = DECAY_FIRST_THRESHOLD + DECAY_FIRST_THRESHOLD / 4
    for (let i = 0; i < n; i += 2) {
      msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `ls ${i}` } }] })
      msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: lines(12, `r${i}`) }] })
    }
    const r = rewriteMessagesBody(JSON.stringify({ messages: msgs }), { decay: true })
    expect(r.stashes.some((s) => s.meta?.kind === 'decay')).toBe(true)
    const k = classifyForwardedResults(r.body)
    expect(k.aged).toBeGreaterThan(0)
    expect(k.agedEarly).toBe(0)
    // everything that reached the model is accounted for exactly once
    expect(k.plain + k.compact + k.dedup + k.diff + k.aged).toBe(n / 2)
  })

  it('an aged-out stub in a body shorter than the decay threshold is counted as early', () => {
    // The section 9 case. Nothing in the proxy can produce this below 128 messages, so the body is
    // typed by hand: the stub text is exactly what stubFor writes.
    const stub = '[headroom] Aged out of this conversation\'s active context — call the retrieve_full tool with token "hr_0123456789abcdef" to expand it.'
    const short = JSON.stringify({ messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: stub }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'a plain result' }] },
    ] })
    expect(classifyForwardedResults(short)).toEqual(kinds({ plain: 1, aged: 1, agedEarly: 1 }))
  })

  it('draws the early line at the decay threshold itself', () => {
    const stub = '[headroom] Aged out of this conversation\'s active context — call the retrieve_full tool with token "hr_0123456789abcdef" to expand it.'
    const mk = (messageCount: number): string => {
      const msgs: unknown[] = []
      for (let i = 0; i < messageCount; i += 2) {
        msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: {} }] })
        msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: i === 0 ? stub : 'x' }] })
      }
      return JSON.stringify({ messages: msgs })
    }
    expect(classifyForwardedResults(mk(DECAY_FIRST_THRESHOLD - 2)).agedEarly).toBe(1) // 126 messages
    expect(classifyForwardedResults(mk(DECAY_FIRST_THRESHOLD)).agedEarly).toBe(0) //     128: decay is allowed to have run
    expect(classifyForwardedResults(mk(DECAY_FIRST_THRESHOLD)).aged).toBe(1)
  })
})

describe('classifyForwardedResults — text that only looks like a stub', () => {
  const footer = '[headroom] Full result cached — call the retrieve_full tool with token "hr_0123456789abcdef" to expand it.'
  const aged = '[headroom] Aged out of this conversation\'s active context — call the retrieve_full tool with token "hr_0123456789abcdef" to expand it.'
  const dedup = '[headroom] Identical to an earlier tool result in this conversation — call the retrieve_full tool with token "hr_0123456789abcdef" to expand it.'
  const one = (text: string) => classifyForwardedResults(bodyOf([text]))

  it('counts a tool output that quotes the stub text inside a code fence as plain', () => {
    expect(one('Here is what the proxy writes:\n```\n' + footer + '\n```\nThat is all.')).toEqual(kinds({ plain: 1 }))
    expect(one('```\n' + footer + '\n```')).toEqual(kinds({ plain: 1 }))
    expect(one('```text\n' + aged + '\n```')).toEqual(kinds({ plain: 1 }))
    expect(one('```\n' + dedup + '\n```')).toEqual(kinds({ plain: 1 }))
  })

  it('still counts a real compaction whose text contains a closed fence', () => {
    expect(one('```\ncode\n```\nmore\n\n' + footer)).toEqual(kinds({ compact: 1 }))
  })

  it('counts a real compaction of a markdown file cut inside a fence as compact', () => {
    // A head/tail window often ends inside a fence, with the closing one elided; calling that plain
    // because the fences do not pair would hide exactly the compactions this tally exists to show.
    const view = '# Notes\n```ts\nconst a = 1\n… [40 lines elided] …\nconst z = 26\n\n' + footer
    expect(one(view)).toEqual(kinds({ compact: 1 }))
  })

  it('counts a stub quoted in the middle of other text as plain', () => {
    expect(one('The stub reads ' + aged + ' and the next one ' + dedup + ' end')).toEqual(kinds({ plain: 1 }))
    expect(one('prefix ' + aged)).toEqual(kinds({ plain: 1 }))
    expect(one(aged + ' suffix')).toEqual(kinds({ plain: 1 }))
    // A stub is the whole text, so a tool output that begins with one and goes on is not a stub.
    expect(one(dedup + ' suffix')).toEqual(kinds({ plain: 1 }))
    expect(one(dedup + '\nmore lines of the output')).toEqual(kinds({ plain: 1 }))
    expect(one(aged + '\nmore lines of the output')).toEqual(kinds({ plain: 1 }))
  })

  it('needs a token of the shape the proxy mints', () => {
    for (const tok of ['hr_zzzzzzzzzzzzzzzz', 'hr_0123', 'hr_0123456789ABCDEF', 'x_0123456789abcdef', '']) {
      const bad = footer.replace('hr_0123456789abcdef', tok)
      expect(one('text\n\n' + bad)).toEqual(kinds({ plain: 1 }))
      expect(one(aged.replace('hr_0123456789abcdef', tok))).toEqual(kinds({ plain: 1 }))
    }
  })

  it('does not take the footer for a stub unless a blank line precedes it', () => {
    expect(one('text\n' + footer)).toEqual(kinds({ plain: 1 }))
    expect(one('text ' + footer)).toEqual(kinds({ plain: 1 }))
  })

  it('reads a footer after a patch header as a diff, and one after plain text as a compaction', () => {
    const patch = '[headroom] Identical to an earlier tool result in this conversation except for the lines below.\n@@ -1,1 +1,1 @@ (0 identical lines before, 3 identical lines after)\n-a\n+b\n\n' + footer
    expect(one(patch)).toEqual(kinds({ diff: 1 }))
    expect(one('first line\nsecond line\n\n' + footer)).toEqual(kinds({ compact: 1 }))
  })
})

describe('classifyForwardedResults — where the text sits', () => {
  const footer = '\n\n[headroom] Full result cached — call the retrieve_full tool with token "hr_0123456789abcdef" to expand it.'
  const reminder = '<system-reminder>\nMind the commit rules.\n</system-reminder>'
  const withContent = (content: unknown): string => JSON.stringify({ messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content }] },
  ] })

  it('classifies the text outside a harness reminder and ignores the reminder itself', () => {
    // The compressor works on the stretch before a reminder, so its footer is the last thing in
    // that stretch and the reminder follows it directly.
    expect(classifyForwardedResults(withContent('head\n' + 'x'.repeat(50) + footer + reminder))).toEqual(kinds({ compact: 1 }))
    expect(classifyForwardedResults(withContent(reminder))).toEqual(kinds())
    expect(classifyForwardedResults(withContent('plain\n' + reminder))).toEqual(kinds({ plain: 1 }))
  })

  it('counts each text segment around a reminder on its own', () => {
    expect(classifyForwardedResults(withContent('one' + footer + reminder + '\ntwo'))).toEqual(kinds({ compact: 1, plain: 1 }))
  })

  it('does not count the blank stretches between reminders', () => {
    expect(classifyForwardedResults(withContent(reminder + '\n' + reminder + '  \n'))).toEqual(kinds())
  })

  it('takes a reminder that real compression leaves in place as it is: the rewriter output classifies as compact', () => {
    const rewritten = rewriteMessagesBody(bodyOf([lines(60) + '\n' + reminder]))
    expect(rewritten.body).toContain('Mind the commit rules.')
    expect(classifyForwardedResults(rewritten.body)).toEqual(kinds({ compact: 1 }))
  })

  it('reads the text items of a content array and skips the images', () => {
    const content = [
      { type: 'text', text: 'first' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'second' + footer },
      { type: 'text' }, { type: 'text', text: 5 }, null, 7, 'loose string',
    ]
    expect(classifyForwardedResults(withContent(content))).toEqual(kinds({ plain: 1, compact: 1 }))
  })

  it('ignores a stub typed by the user or written by the assistant', () => {
    const body = JSON.stringify({ messages: [
      { role: 'user', content: 'the footer is ' + footer.trim() },
      { role: 'assistant', content: [{ type: 'text', text: footer.trim() }, { type: 'thinking', thinking: footer.trim() }] },
      { role: 'user', content: [{ type: 'text', text: footer.trim() }] },
    ] })
    expect(classifyForwardedResults(body)).toEqual(kinds())
  })

  it('counts every tool_result in a user message, in every message', () => {
    const body = JSON.stringify({ messages: [
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'one' },
        { type: 'tool_result', tool_use_id: 'b', content: 'two' + footer },
        { type: 'tool_result', tool_use_id: 'c', content: [{ type: 'text', text: 'three' }] },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'd', content: 'four' }] },
    ] })
    expect(classifyForwardedResults(body)).toEqual(kinds({ plain: 3, compact: 1 }))
  })

  it('counts nothing for a result with no content at all', () => {
    for (const content of [undefined, null, 5, {}, '']) {
      expect(classifyForwardedResults(withContent(content))).toEqual(kinds())
    }
  })
})

describe('classifyForwardedResults — total and read-only', () => {
  it('returns zeros, never throws, for a body it cannot read', () => {
    for (const bad of ['', 'not json{', '[]', 'null', '5', '"x"', '{}', '{"messages":5}', '{"messages":null}', '{"messages":{}}', '{"messages":[null,5,"x",[],{}]}']) {
      expect(() => classifyForwardedResults(bad)).not.toThrow()
      expect(classifyForwardedResults(bad)).toEqual(kinds())
    }
    expect(classifyForwardedResults(undefined as unknown as string)).toEqual(kinds())
    expect(classifyForwardedResults(null as unknown as string)).toEqual(kinds())
  })

  it('does not assign into what it reads: a deeply frozen message list classifies the same', () => {
    const footer = '\n\n[headroom] Full result cached — call the retrieve_full tool with token "hr_0123456789abcdef" to expand it.'
    const messages = JSON.parse(JSON.stringify([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x'.repeat(100) + footer }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'plain' }] }] },
    ]))
    const freeze = (o: unknown): void => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) freeze(v) } }
    const before = JSON.stringify(messages)
    freeze(messages)
    expect(classifyMessages(messages)).toEqual(kinds({ compact: 1, plain: 1 }))
    expect(JSON.stringify(messages)).toBe(before)
  })

  it('is a function of the body: the same body gives the same answer, and a fresh module agrees', async () => {
    const body = rewriteMessagesBody(bodyOf([lines(60), lines(60), 'short'])).body
    const a = classifyForwardedResults(body)
    expect(classifyForwardedResults(body)).toEqual(a)
    vi.resetModules()
    const fresh = await import('../../src/main/headroomProxy/forwardedKinds')
    expect(fresh.classifyForwardedResults(body)).toEqual(a)
  })

  it('is total on an object that throws when read: it keeps what it had counted and never throws', () => {
    const fine = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'plain text' }] }
    const hostile = { role: 'user', get content(): unknown { throw new Error('unreadable') } }
    const never = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'not reached' }] }
    let k = emptyKinds()
    expect(() => { k = classifyMessages([fine, hostile, never] as never) }).not.toThrow()
    expect(k).toEqual(kinds({ plain: 1 }))
    // A list whose length cannot be read at all counts as nothing.
    const noLength = new Proxy([], { get(t, p, r) { if (p === 'length') throw new Error('unreadable'); return Reflect.get(t, p, r) } })
    expect(classifyMessages(noLength as never)).toEqual(kinds())
  })

  it('survives 1,000 seeded random bodies with the right total', () => {
    let a = 0x1234abcd
    const next = (): number => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
    const pool = ['plain text', '\n\n[headroom] Full result cached — call the retrieve_full tool with token "hr_0123456789abcdef" to expand it.', '```', '<system-reminder>x</system-reminder>', '[headroom] Aged out of this conversation\'s active context — call the retrieve_full tool with token "hr_0123456789abcdef" to expand it.', ' ', '\n']
    for (let n = 0; n < 1000; n++) {
      const results = 1 + Math.floor(next() * 5)
      const msgs: unknown[] = []
      for (let i = 0; i < results; i++) {
        let text = ''
        for (let j = 0, parts = Math.floor(next() * 5); j < parts; j++) text += pool[Math.floor(next() * pool.length)]
        msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: text }] })
      }
      const k = classifyMessages(msgs as never)
      const total = k.plain + k.compact + k.dedup + k.diff + k.aged
      expect(total).toBeLessThanOrEqual(results * 5) // a result splits into at most a few segments around reminders
      expect(k.agedEarly).toBeLessThanOrEqual(k.aged)
    }
  })
})

/**
 * Where the tally is taken from, held in the source, because two ways of getting it wrong cost nothing a
 * correctness test can see. The tally reads the messages the rewriter has already parsed; reading it from a
 * re-parsed copy (`JSON.parse(JSON.stringify(...))`) would add a second parse of the whole body to every
 * request in the one thread that serves every Claude session, and reading the reminders by rebuilding the
 * text (mapOutsideReminders) would add a copy of every tool result. Both give the same counts as the right
 * way, so nothing that checks the counts notices; the cost tests compare parse counts with the tally
 * stubbed out, and the re-parse sits in the argument of the stubbed call, so it is in both runs.
 */
describe('the tally is read-only and adds no parse and no copy (source pins)', () => {
  const SRC = join(__dirname, '..', '..', 'src', 'main', 'headroomProxy')
  const kindsSource = readFileSync(join(SRC, 'forwardedKinds.ts'), 'utf8')
  const wireSource = readFileSync(join(SRC, 'wireCompress.ts'), 'utf8')
  const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1

  it('forwardedKinds walks reminders in place with eachOutsideReminder, and never rebuilds the text with mapOutsideReminders', () => {
    expect(kindsSource).toContain("import { eachOutsideReminder } from './reminders'")
    expect(count(kindsSource, 'eachOutsideReminder(')).toBeGreaterThanOrEqual(1)
    expect(kindsSource).not.toContain('mapOutsideReminders')
  })

  it('wireCompress takes the tally from the messages it holds, at both places it takes one, and parses nothing for it', () => {
    expect(count(wireSource, 'stats.kinds = classifyMessages(obj.messages as unknown[])')).toBe(2)
    expect(count(wireSource, 'classifyMessages(')).toBe(2)
    expect(wireSource).not.toMatch(/classifyMessages\(\s*JSON\.parse/)
    expect(wireSource).not.toMatch(/JSON\.parse\(\s*JSON\.stringify\(\s*obj\.messages/)
    expect(wireSource).not.toContain('classifyForwardedResults(out')
  })

  it('and these pins are not vacuous: the shapes they forbid are caught by the same checks', () => {
    const reparsed = 'stats.kinds = classifyMessages(JSON.parse(JSON.stringify(obj.messages)) as unknown[])'
    expect(reparsed.includes('stats.kinds = classifyMessages(obj.messages as unknown[])')).toBe(false)
    expect(/classifyMessages\(\s*JSON\.parse/.test(reparsed)).toBe(true)
    expect('const t = mapOutsideReminders(text, f)'.includes('mapOutsideReminders')).toBe(true)
  })
})
