/**
 * Byte primitives for the wire format.
 *
 * Everything here is hand-rolled on purpose. React Native's `TextEncoder` is
 * whatever the Hermes build shipped, and a shim that writes UTF-16 or escapes
 * non-ASCII produces frames that seal and open cleanly while carrying the wrong
 * bytes. Owning the encoder means the golden vector in the wire format doc
 * (`Téléphone — 9`: 13 characters, 17 bytes) tests something real.
 *
 * Every function takes and returns a real `Uint8Array`. Never a Node `Buffer` --
 * `@noble` rejects it outright, and it does not exist on a phone anyway.
 */

const HEX = '0123456789abcdef'

/** Lowercase hex. Every identifier on the wire is lowercase hex; see §2. */
export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    out += HEX[b >> 4]
    out += HEX[b & 0x0f]
  }
  return out
}

/**
 * Parse hex, case-insensitively, refusing anything that is not exactly hex.
 *
 * Odd length and stray characters throw rather than yielding a short array: a
 * short array reaches `@noble` as a short scalar, and a curve library complaining
 * about scalar length is a poor way to learn that a frame was truncated.
 */
export function fromHex(hex: string): Uint8Array {
  const s = hex.toLowerCase()
  if (s.length % 2 !== 0) throw new Error(`hex string has odd length: ${hex.length}`)
  if (!/^[0-9a-f]*$/.test(s)) throw new Error('hex string contains non-hex characters')
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/**
 * UTF-8 encode. An unpaired surrogate becomes U+FFFD, matching every conforming
 * encoder -- emitting its raw code point would put bytes on the wire that no
 * decoder accepts.
 */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    let cp = text.codePointAt(i) as number
    if (cp >= 0xd800 && cp <= 0xdfff) {
      // A high surrogate with a valid low following it was already consumed as a
      // single code point by codePointAt, so anything still in this range here is
      // unpaired.
      cp = 0xfffd
    } else if (cp > 0xffff) {
      i++ // codePointAt consumed a surrogate pair
    }
    if (cp < 0x80) {
      out.push(cp)
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      )
    }
  }
  return Uint8Array.from(out)
}

/**
 * UTF-8 decode, strictly.
 *
 * Truncated sequences, bad continuation bytes, overlong forms, surrogate halves
 * and code points above U+10FFFF all throw. They cannot occur in a frame that
 * decrypted honestly, so their presence means the plaintext is not what it claims
 * -- and silently substituting replacement characters hands the caller a string
 * it will go on to treat as a terminal name.
 */
export function utf8Decode(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b0 = bytes[i] as number
    let cp: number
    let width: number
    let min: number
    if (b0 < 0x80) {
      cp = b0
      width = 1
      min = 0
    } else if ((b0 & 0xe0) === 0xc0) {
      cp = b0 & 0x1f
      width = 2
      min = 0x80
    } else if ((b0 & 0xf0) === 0xe0) {
      cp = b0 & 0x0f
      width = 3
      min = 0x800
    } else if ((b0 & 0xf8) === 0xf0) {
      cp = b0 & 0x07
      width = 4
      min = 0x10000
    } else {
      throw new Error(`invalid UTF-8 lead byte 0x${b0.toString(16)} at ${i}`)
    }
    if (i + width > bytes.length) throw new Error(`truncated UTF-8 sequence at ${i}`)
    for (let k = 1; k < width; k++) {
      const bk = bytes[i + k] as number
      if ((bk & 0xc0) !== 0x80) throw new Error(`invalid UTF-8 continuation byte at ${i + k}`)
      cp = (cp << 6) | (bk & 0x3f)
    }
    if (cp < min) throw new Error(`overlong UTF-8 encoding at ${i}`)
    if (cp >= 0xd800 && cp <= 0xdfff) throw new Error(`UTF-8 surrogate half at ${i}`)
    if (cp > 0x10ffff) throw new Error(`UTF-8 code point out of range at ${i}`)
    out += String.fromCodePoint(cp)
    i += width
  }
  return out
}

/** Join byte arrays in order. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/**
 * Constant-time comparison. Every byte is folded in, so the time taken does not
 * depend on where the first difference falls. Length is compared first, which is
 * not secret: it is visible on the wire.
 */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number)
  return diff === 0
}
