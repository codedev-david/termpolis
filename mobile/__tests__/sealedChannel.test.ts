import {
  COUNTER_BYTES,
  readCounter,
  SEAL_OVERHEAD_BYTES,
  SealedSession,
  writeCounter,
} from '../src/wire/sealedChannel'

const KEY_A = new Uint8Array(32).fill(0x11)
const KEY_B = new Uint8Array(32).fill(0x22)

/** Two ends of one channel: what A sends, B receives. */
function pair(): { a: SealedSession; b: SealedSession } {
  return { a: new SealedSession(KEY_A, KEY_B), b: new SealedSession(KEY_B, KEY_A) }
}

const HEADER = Uint8Array.from([0x04])
const HELLO = Uint8Array.from([0x68, 0x69]) // "hi"

describe('counter encoding', () => {
  it('is six bytes big-endian', () => {
    const buf = new Uint8Array(COUNTER_BYTES)
    writeCounter(buf, 1)
    expect(Array.from(buf)).toEqual([0, 0, 0, 0, 0, 1])
    writeCounter(buf, 256)
    expect(Array.from(buf)).toEqual([0, 0, 0, 0, 1, 0])
  })

  it('round-trips the whole 2^48 range at its edges', () => {
    for (const v of [0, 1, 255, 256, 65535, 2 ** 32, 2 ** 48 - 1]) {
      const buf = new Uint8Array(COUNTER_BYTES)
      writeCounter(buf, v)
      expect(readCounter(buf)).toBe(v)
    }
  })

  it('reserves 22 bytes of overhead: six of counter and sixteen of tag', () => {
    expect(SEAL_OVERHEAD_BYTES).toBe(22)
    expect(COUNTER_BYTES).toBe(6)
  })
})

describe('SealedSession', () => {
  it('round-trips in both directions', () => {
    const { a, b } = pair()
    expect(b.open(a.seal(HEADER, HELLO), 1)).toEqual(HELLO)
    expect(a.open(b.seal(HEADER, HELLO), 1)).toEqual(HELLO)
  })

  it('counts each direction independently, both from zero', () => {
    const { a, b } = pair()
    // Three frames one way, one the other. The reply must still be counter 0:
    // a shared counter would have it at 3 and the peer would refuse it.
    const first = a.seal(HEADER, HELLO)
    a.seal(HEADER, HELLO)
    a.seal(HEADER, HELLO)
    expect(readCounter(first.subarray(1))).toBe(0)
    const reply = b.seal(HEADER, HELLO)
    expect(readCounter(reply.subarray(1))).toBe(0)
    expect(a.open(reply, 1)).toEqual(HELLO)
  })

  it('increments the send counter by one per frame', () => {
    const { a } = pair()
    for (let i = 0; i < 5; i++) expect(readCounter(a.seal(HEADER, HELLO).subarray(1))).toBe(i)
  })

  it('seals an empty payload', () => {
    const { a, b } = pair()
    expect(b.open(a.seal(HEADER, new Uint8Array(0)), 1)).toEqual(new Uint8Array(0))
  })

  it('adds exactly the advertised overhead', () => {
    const { a } = pair()
    const body = new Uint8Array(100)
    expect(a.seal(HEADER, body).length).toBe(HEADER.length + body.length + SEAL_OVERHEAD_BYTES)
  })

  it('refuses a frame shorter than the header plus overhead without touching replay state', () => {
    // Below this a counter would be read off the end of the buffer, and the
    // garbage sequence number that produced would poison replay state for every
    // frame after it. The legitimate counter-0 frame that follows proves it did
    // not.
    const { a, b } = pair()
    const legitimate = a.seal(HEADER, HELLO)
    expect(b.open(new Uint8Array(1 + SEAL_OVERHEAD_BYTES - 1), 1)).toBeNull()
    expect(b.open(new Uint8Array(0), 1)).toBeNull()
    expect(b.open(legitimate, 1)).toEqual(HELLO)
  })

  it('refuses a replayed frame', () => {
    const { a, b } = pair()
    const frame = a.seal(HEADER, HELLO)
    expect(b.open(frame, 1)).toEqual(HELLO)
    expect(b.open(frame, 1)).toBeNull()
  })

  it('refuses a reordered frame, which authenticity alone would accept', () => {
    const { a, b } = pair()
    const first = a.seal(HEADER, HELLO)
    const second = a.seal(HEADER, HELLO)
    expect(b.open(second, 1)).toEqual(HELLO)
    expect(b.open(first, 1)).toBeNull()
  })

  it('refuses a frame with a flipped ciphertext byte', () => {
    const { a, b } = pair()
    const frame = a.seal(HEADER, HELLO)
    frame[frame.length - 1] ^= 0x01
    expect(b.open(frame, 1)).toBeNull()
  })

  it('refuses a frame with a flipped header byte, which proves the header is the AAD', () => {
    const { a, b } = pair()
    const frame = a.seal(HEADER, HELLO)
    frame[0] ^= 0x01
    expect(b.open(frame, 1)).toBeNull()
  })

  it('refuses a frame with a raised counter', () => {
    // The counter is in the clear and authenticated only implicitly: it derives
    // the nonce, so raising it makes decryption fail.
    const { a, b } = pair()
    const frame = a.seal(HEADER, HELLO)
    frame[1 + COUNTER_BYTES - 1] = 9
    expect(b.open(frame, 1)).toBeNull()
  })

  it('still opens the next legitimate frame after a rejection', () => {
    // The high-water mark advances only after the tag verifies. Advancing before
    // it would let anyone walk the counter forward with garbage and deafen the
    // peer for good.
    const { a, b } = pair()
    const good = a.seal(HEADER, HELLO)
    const forged = a.seal(HEADER, HELLO)
    forged[forged.length - 1] ^= 0xff
    expect(b.open(forged, 1)).toBeNull()
    expect(b.open(good, 1)).toEqual(HELLO)
  })

  it('cannot open the frame it sealed itself', () => {
    // A relay that reflects a peer's own frame back at it. With one key both
    // ways the tag would verify -- the peer sealed it -- and the reflected
    // counter would poison the receive high-water mark permanently.
    const { a } = pair()
    expect(a.open(a.seal(HEADER, HELLO), 1)).toBeNull()
  })

  it('cannot open a frame sealed under a different key', () => {
    const other = new SealedSession(new Uint8Array(32).fill(0x33), new Uint8Array(32).fill(0x44))
    const { b } = pair()
    expect(b.open(other.seal(HEADER, HELLO), 1)).toBeNull()
  })

  it('honours a wider header', () => {
    const wide = new Uint8Array(33).fill(0x03)
    const { a, b } = pair()
    expect(b.open(a.seal(wide, HELLO), 33)).toEqual(HELLO)
  })

  it('refuses a frame opened with the wrong header width', () => {
    // Reading a 33-byte header as 1 byte hands the AEAD a different AAD and a
    // different counter. It must fail, not silently return the wrong slice.
    const wide = new Uint8Array(33).fill(0x03)
    const { a, b } = pair()
    expect(b.open(a.seal(wide, HELLO), 1)).toBeNull()
  })

  it('reports how many frames it has sent', () => {
    const { a } = pair()
    expect(a.sentFrames).toBe(0)
    a.seal(HEADER, HELLO)
    a.seal(HEADER, HELLO)
    expect(a.sentFrames).toBe(2)
  })

  it('never throws on a hostile frame, whatever the bytes', () => {
    // open() is called straight from the socket message handler. A throw there
    // tears down the connection, which hands any peer a free disconnect.
    const { b } = pair()
    for (const len of [0, 1, 5, 22, 23, 64, 300]) {
      const junk = new Uint8Array(len).fill(0xab)
      expect(() => b.open(junk, 1)).not.toThrow()
    }
  })
})
