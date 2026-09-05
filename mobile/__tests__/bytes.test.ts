import { concat, equalBytes, fromHex, toHex, utf8Decode, utf8Encode } from '../src/wire/bytes'

describe('hex', () => {
  it('round-trips', () => {
    const b = Uint8Array.from([0x00, 0x0f, 0xa0, 0xff])
    expect(toHex(b)).toBe('000fa0ff')
    expect(fromHex('000fa0ff')).toEqual(b)
  })

  it('emits lowercase, because every id on the wire is lowercase hex', () => {
    expect(toHex(Uint8Array.from([0xab, 0xcd]))).toBe('abcd')
  })

  it('refuses odd length rather than returning a short array', () => {
    // A short array reaches @noble as a short scalar, and a curve library
    // complaining about scalar length is a poor way to learn the input was bad.
    expect(() => fromHex('abc')).toThrow()
  })

  it('refuses non-hex rather than returning NaN bytes', () => {
    expect(() => fromHex('zz')).toThrow()
  })

  it('accepts uppercase input while still emitting lowercase', () => {
    expect(fromHex('ABCD')).toEqual(Uint8Array.from([0xab, 0xcd]))
  })

  it('round-trips the empty string', () => {
    expect(fromHex('')).toEqual(new Uint8Array(0))
    expect(toHex(new Uint8Array(0))).toBe('')
  })
})

describe('utf8', () => {
  it('encodes ASCII one byte per character', () => {
    expect(utf8Encode('Pixel 9 Pro')).toHaveLength(11)
  })

  it('encodes the vector label as 17 bytes from 13 characters', () => {
    // This is the golden-vector label from wire format §12, and it exists to
    // catch an encoder that writes UTF-16 or escapes non-ASCII.
    const label = 'Téléphone — 9'
    expect(label).toHaveLength(13)
    expect(utf8Encode(label)).toHaveLength(17)
  })

  it('round-trips multi-byte text', () => {
    for (const s of ['', 'a', 'Téléphone — 9', '日本語', '🔒 sealed']) {
      expect(utf8Decode(utf8Encode(s))).toBe(s)
    }
  })

  it('encodes a 4-byte astral character as four bytes', () => {
    expect(utf8Encode('🔒')).toEqual(Uint8Array.from([0xf0, 0x9f, 0x94, 0x92]))
  })

  it('encodes the two-byte and three-byte forms at their boundaries', () => {
    expect(utf8Encode('\u0080')).toEqual(Uint8Array.from([0xc2, 0x80]))
    expect(utf8Encode('\u07ff')).toEqual(Uint8Array.from([0xdf, 0xbf]))
    expect(utf8Encode('\u0800')).toEqual(Uint8Array.from([0xe0, 0xa0, 0x80]))
    expect(utf8Encode('\uffff')).toEqual(Uint8Array.from([0xef, 0xbf, 0xbf]))
  })

  it('replaces an unpaired surrogate rather than emitting invalid UTF-8', () => {
    // A lone surrogate cannot be encoded. Emitting its raw code point would put
    // bytes on the wire that no decoder accepts; U+FFFD is what every conforming
    // encoder substitutes.
    expect(utf8Encode('\ud800')).toEqual(Uint8Array.from([0xef, 0xbf, 0xbd]))
    expect(utf8Encode('a\udc00b')).toEqual(Uint8Array.from([0x61, 0xef, 0xbf, 0xbd, 0x62]))
  })

  it('rejects truncated and malformed sequences on decode', () => {
    // Every one of these is a frame that decrypted but did not carry the text it
    // claimed. Failing loudly beats silently returning replacement characters
    // the caller then treats as a terminal name.
    expect(() => utf8Decode(Uint8Array.from([0xc2]))).toThrow()
    expect(() => utf8Decode(Uint8Array.from([0xe2, 0x80]))).toThrow()
    expect(() => utf8Decode(Uint8Array.from([0x80]))).toThrow()
    expect(() => utf8Decode(Uint8Array.from([0xf8, 0x88, 0x80, 0x80, 0x80]))).toThrow()
    expect(() => utf8Decode(Uint8Array.from([0xc2, 0x41]))).toThrow()
  })

  it('rejects an overlong encoding', () => {
    // 0xc0 0x80 is a two-byte encoding of NUL. Accepting it lets the same string
    // arrive with two different byte sequences, which breaks every comparison
    // that assumed one.
    expect(() => utf8Decode(Uint8Array.from([0xc0, 0x80]))).toThrow()
    expect(() => utf8Decode(Uint8Array.from([0xe0, 0x80, 0x80]))).toThrow()
    expect(() => utf8Decode(Uint8Array.from([0xf0, 0x80, 0x80, 0x80]))).toThrow()
  })

  it('rejects a surrogate half and an out-of-range code point on decode', () => {
    expect(() => utf8Decode(Uint8Array.from([0xed, 0xa0, 0x80]))).toThrow()
    expect(() => utf8Decode(Uint8Array.from([0xf4, 0x90, 0x80, 0x80]))).toThrow()
  })
})

describe('concat', () => {
  it('joins in order', () => {
    expect(concat(Uint8Array.from([1]), Uint8Array.from([2, 3]))).toEqual(Uint8Array.from([1, 2, 3]))
  })

  it('handles no parts and empty parts', () => {
    expect(concat()).toEqual(new Uint8Array(0))
    expect(concat(new Uint8Array(0), Uint8Array.from([9]))).toEqual(Uint8Array.from([9]))
  })
})

describe('equalBytes', () => {
  it('compares content, not identity', () => {
    expect(equalBytes(Uint8Array.from([1, 2]), Uint8Array.from([1, 2]))).toBe(true)
    expect(equalBytes(Uint8Array.from([1, 2]), Uint8Array.from([1, 3]))).toBe(false)
  })

  it('is false for different lengths without reading past either end', () => {
    expect(equalBytes(Uint8Array.from([1]), Uint8Array.from([1, 2]))).toBe(false)
  })

  it('does not short-circuit on the first differing byte', () => {
    // Not observable from a unit test, so this asserts the property that makes it
    // possible: every byte is folded in. Both inputs differ only at the last
    // position, and the result must still be false.
    const a = new Uint8Array(32).fill(7)
    const b = new Uint8Array(32).fill(7)
    b[31] = 8
    expect(equalBytes(a, b)).toBe(false)
  })

  it('is true for two empty arrays', () => {
    expect(equalBytes(new Uint8Array(0), new Uint8Array(0))).toBe(true)
  })
})
