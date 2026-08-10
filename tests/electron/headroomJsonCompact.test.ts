import { describe, it, expect } from 'vitest'
const {
  compactJson, looksLikeJson, hasUnsafeNumbers,
  JSON_ARRAY_KEEP, JSON_STR_MAX, JSON_MAX_DEPTH, JSON_MIN_CHARS, UNSAFE_DIGITS,
} = await import('../../src/main/headroomProxy/jsonCompact')

const pad = (n: number, ch = 'x'): string => ch.repeat(n)

describe('looksLikeJson', () => {
  it('accepts objects and arrays once they are worth compacting', () => {
    expect(looksLikeJson(JSON.stringify({ a: pad(JSON_MIN_CHARS) }))).toBe(true)
    expect(looksLikeJson(JSON.stringify([pad(JSON_MIN_CHARS)]))).toBe(true)
    expect(looksLikeJson(`\n  ${JSON.stringify({ a: pad(JSON_MIN_CHARS) })}  \n`)).toBe(true)
  })

  it('rejects anything below the floor, where there is nothing to win', () => {
    expect(looksLikeJson('{"a":1}')).toBe(false)
    expect(looksLikeJson(JSON.stringify({ a: pad(JSON_MIN_CHARS - 20) }).slice(0, JSON_MIN_CHARS - 1))).toBe(false)
  })

  it('rejects bare scalars and text that merely contains JSON', () => {
    expect(looksLikeJson(`"${pad(JSON_MIN_CHARS)}"`)).toBe(false)
    expect(looksLikeJson(`Result: ${JSON.stringify({ a: pad(JSON_MIN_CHARS) })}`)).toBe(false)
    expect(looksLikeJson(pad(JSON_MIN_CHARS))).toBe(false)
  })
})

describe('hasUnsafeNumbers — the v1.29 big-integer trap', () => {
  it('flags a long integer in value position, after any of : , or [', () => {
    expect(hasUnsafeNumbers('{"id":12345678901234567890}')).toBe(true)
    expect(hasUnsafeNumbers('{"a":1,"b":9007199254740993000}')).toBe(true)
    expect(hasUnsafeNumbers('[12345678901234567890]')).toBe(true)
    expect(hasUnsafeNumbers('{"id": 12345678901234567890}')).toBe(true)
    expect(hasUnsafeNumbers('{"id":-12345678901234567890}')).toBe(true)
  })

  it('leaves short numbers, string digits and key names alone', () => {
    expect(hasUnsafeNumbers(`{"id":${'9'.repeat(UNSAFE_DIGITS - 1)}}`)).toBe(false)
    expect(hasUnsafeNumbers('{"id":"12345678901234567890"}')).toBe(false)
    expect(hasUnsafeNumbers('{"12345678901234567890":1}')).toBe(false)
  })

  it('is the reason the round trip is unsafe at all — proof, not folklore', () => {
    expect(JSON.stringify(JSON.parse('{"id":12345678901234567890}'))).toBe('{"id":12345678901234567000}')
  })
})

describe('compactJson', () => {
  it('samples long arrays and reports how many went', () => {
    const raw = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ i, name: `row-${i}` })) })
    const r = compactJson(raw)
    expect(r).not.toBeNull()
    expect(r!.elided).toBe(true)
    const back = JSON.parse(r!.text) as { items: unknown[] }
    expect(back.items).toHaveLength(JSON_ARRAY_KEEP + 1)
    expect(back.items[JSON_ARRAY_KEEP]).toBe(`… (${200 - JSON_ARRAY_KEEP} more items elided)`)
    expect(r!.text.length).toBeLessThan(raw.length)
  })

  it('leaves short arrays whole', () => {
    const raw = JSON.stringify({ items: [1, 2, 3], filler: pad(JSON_MIN_CHARS) })
    const r = compactJson(raw)
    expect(r).not.toBeNull()
    expect((JSON.parse(r!.text) as { items: number[] }).items).toEqual([1, 2, 3])
  })

  it('truncates long strings in place and states the loss', () => {
    const raw = JSON.stringify({ blob: pad(5000), keep: 'short' })
    const r = compactJson(raw)
    expect(r!.elided).toBe(true)
    const back = JSON.parse(r!.text) as { blob: string; keep: string }
    expect(back.blob).toBe(`${pad(JSON_STR_MAX)}… (+${5000 - JSON_STR_MAX} chars)`)
    expect(back.keep).toBe('short')
  })

  it('prunes nesting past the depth limit', () => {
    let node: Record<string, unknown> = { leaf: pad(JSON_MIN_CHARS) }
    for (let i = 0; i < JSON_MAX_DEPTH + 3; i++) node = { [`d${i}`]: node }
    const r = compactJson(JSON.stringify(node))
    expect(r!.elided).toBe(true)
    expect(r!.text).toContain('… (object, depth elided)')
    expect(r!.text).not.toContain('leaf')
  })

  it('reports an elided deep array with its length', () => {
    // The array must sit exactly AT the limit: d0's value is walked at depth 1, so with
    // JSON_MAX_DEPTH wrappers the array is the value walked at depth JSON_MAX_DEPTH.
    let node: unknown = Array.from({ length: 60 }, (_, i) => i)
    for (let i = JSON_MAX_DEPTH - 1; i >= 0; i--) node = { [`d${i}`]: node, filler: pad(60) }
    const r = compactJson(JSON.stringify(node))
    expect(r!.text).toContain('… (60 items, depth elided)')
  })

  it('wins on whitespace alone when there is nothing to elide — and says so', () => {
    // Nothing here trips a limit: no string over JSON_STR_MAX, no array over JSON_ARRAY_KEEP,
    // no nesting past JSON_MAX_DEPTH — so the only saving available is the indentation.
    const value = { alpha: 1, beta: 'two', gamma: { delta: true, epsilon: null }, zeta: [1, 2, 3] }
    const notes = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`note${i}`, pad(100, 'n')]))
    const pretty = JSON.stringify({ ...value, ...notes }, null, 2)
    const r = compactJson(pretty)
    expect(r).not.toBeNull()
    expect(r!.elided).toBe(false) // nothing hidden → the caller must NOT stash a retrieve token
    expect(r!.text.length).toBeLessThan(pretty.length)
    expect(JSON.parse(r!.text)).toEqual(JSON.parse(pretty)) // and it is still the same payload
  })

  it('preserves key order, so the same bytes always produce the same bytes', () => {
    const raw = JSON.stringify({ zebra: pad(JSON_MIN_CHARS), alpha: 1, middle: [1, 2, 3, 4, 5, 6] })
    const a = compactJson(raw)!
    const b = compactJson(raw)!
    expect(a.text).toBe(b.text)
    expect(Object.keys(JSON.parse(a.text) as object)).toEqual(['zebra', 'alpha', 'middle'])
  })

  it('is idempotent enough to be cache-safe: re-compacting its own output is stable', () => {
    const raw = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => `row-${i}`) })
    const once = compactJson(raw)!.text
    const twice = compactJson(once)
    // Either it refuses (already minimal) or it lands on the identical bytes — never a third form.
    expect(twice === null || twice.text === once).toBe(true)
  })

  it('REFUSES a payload carrying an unsafe integer rather than corrupting it', () => {
    // The id stays TEXT on purpose: as a JS number literal it is already lost before the test
    // starts. The round trip below is the corruption the refusal exists to prevent.
    const BIG = '12345678901234567890'
    expect(JSON.stringify(JSON.parse(`{"id":${BIG}}`))).toBe('{"id":12345678901234567000}')
    // Long enough to clear JSON_MIN_CHARS and compressible enough to be worth compacting, so the
    // null can only come from the unsafe-number veto — not from the payload being too small.
    const items = JSON.stringify(Array.from({ length: 200 }, (_, i) => i))
    const withBig = `{"id":${BIG},"items":${items}}`
    expect(withBig.length).toBeGreaterThan(JSON_MIN_CHARS)
    expect(compactJson(withBig.replace(`"id":${BIG}`, '"id":1'))).not.toBeNull() // control
    expect(compactJson(withBig)).toBeNull()
  })

  it('returns null for text that is not JSON at all', () => {
    expect(compactJson(pad(1000))).toBeNull()
    expect(compactJson(`{${pad(1000)}`)).toBeNull()
  })

  it('returns null when the braces match but the body does not parse', () => {
    expect(compactJson(`{"a":1,${pad(500)}}`)).toBeNull()
    expect(compactJson(`[1,2,${pad(500)}]`)).toBeNull()
  })

  it('returns null when there is nothing to gain', () => {
    const raw = JSON.stringify(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i])))
    expect(raw.length).toBeGreaterThan(JSON_MIN_CHARS)
    expect(compactJson(raw)).toBeNull()
  })

  it('handles top-level arrays, not just objects', () => {
    const raw = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ i })))
    const r = compactJson(raw)!
    const back = JSON.parse(r.text) as unknown[]
    expect(back).toHaveLength(JSON_ARRAY_KEEP + 1)
  })

  it('passes primitives through untouched', () => {
    const raw = JSON.stringify({ t: true, f: false, n: null, num: 3.5, neg: -7, filler: pad(JSON_MIN_CHARS), big: [1, 2, 3, 4] })
    const back = JSON.parse(compactJson(raw)!.text) as Record<string, unknown>
    expect(back.t).toBe(true)
    expect(back.f).toBe(false)
    expect(back.n).toBeNull()
    expect(back.num).toBe(3.5)
    expect(back.neg).toBe(-7)
  })
})
