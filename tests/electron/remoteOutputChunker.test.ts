import { describe, it, expect } from 'vitest'
import { chunkOutbound, MAX_PAYLOAD_BYTES } from '../../src/main/remoteBridge/outputChunker'
import { SEAL_OVERHEAD_BYTES } from '../../src/main/remoteBridge/sealedChannel'
import {
  SealedSession,
  SESSION_HEADER_BYTES,
  FRAME_SESSION,
} from '../../src/main/remoteBridge/sessionCrypto'
import { NO_CAPABILITIES, RELAY_MAX_FRAME_BYTES } from '../../src/main/remoteBridge/protocol'
import { MAX_FRAME_BYTES } from '../../relay/src/quota'
import type { DrainedChunk } from '../../src/main/remoteBridge/outputFanout'
import type { OutputChunk, RemoteMessage } from '../../src/main/remoteBridge/protocol'

function chunk(over: Partial<DrainedChunk> = {}): DrainedChunk {
  return { terminalId: 't1', chunk: 'hello', missed: 0, marker: null, ...over }
}

function wireSize(payload: unknown): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length
}

describe('output chunker', () => {
  // The budget is derived from two numbers that live elsewhere. If either moves
  // and this file does not, the bridge starts producing frames the relay cuts --
  // and the symptom is a phone that disconnects under load, which looks like a
  // network problem and is not.
  it('agrees with the relay about the frame cap', () => {
    expect(RELAY_MAX_FRAME_BYTES).toBe(MAX_FRAME_BYTES)
  })

  it('reserves exactly what a session frame costs, no more and no less', () => {
    // Measured against a real seal rather than restated from the constants, so
    // the budget cannot drift from the format. The header counts: it is one byte
    // on the wire and the relay's cap applies to the whole frame, so a budget
    // that reserved only the seal would put a full-size payload exactly one byte
    // over -- and the relay CUTS an oversized frame rather than truncating it,
    // which reads to a user as an unreliable network.
    const session = SealedSession.fromRoot(new Uint8Array(32).fill(7), 'desktop')
    const header = new Uint8Array([FRAME_SESSION])
    expect(header.length).toBe(SESSION_HEADER_BYTES)
    expect(session.seal(header, new Uint8Array(0)).length).toBe(
      SESSION_HEADER_BYTES + SEAL_OVERHEAD_BYTES,
    )
    expect(session.seal(header, new Uint8Array(100)).length).toBe(
      100 + SESSION_HEADER_BYTES + SEAL_OVERHEAD_BYTES,
    )
    expect(session.seal(header, new Uint8Array(MAX_PAYLOAD_BYTES)).length).toBe(
      RELAY_MAX_FRAME_BYTES,
    )
  })

  it('sends nothing when there is nothing queued', () => {
    expect(chunkOutbound([], MAX_PAYLOAD_BYTES)).toEqual([])
  })

  it('packs many small chunks into one payload', () => {
    const chunks = Array.from({ length: 50 }, (_, i) => chunk({ chunk: `line ${i}\n` }))
    const payloads = chunkOutbound(chunks, MAX_PAYLOAD_BYTES)

    // One frame, not fifty. Each frame costs a nonce, a tag and a token from the
    // relay's 40-frame burst; a payload per keystroke echo would exhaust the
    // frame-rate limit on ordinary typing.
    expect(payloads).toHaveLength(1)
    expect(payloads[0].chunks).toHaveLength(50)
  })

  it('keeps every payload under the budget, even for escape-dense output', () => {
    // \u001b is one character that JSON-escapes to six bytes. A full fan-out
    // queue of it is the case the naive "one drain, one frame" version got
    // wrong: 262144 characters that measure under the cap as a string and
    // 1.5 MiB once serialised.
    const chunks = [chunk({ chunk: '\u001b'.repeat(262_144) })]
    const payloads = chunkOutbound(chunks, MAX_PAYLOAD_BYTES)

    expect(payloads.length).toBeGreaterThan(1)
    for (const p of payloads) {
      expect(wireSize(p)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
      expect(wireSize(p) + SEAL_OVERHEAD_BYTES).toBeLessThanOrEqual(RELAY_MAX_FRAME_BYTES)
    }
  })

  it('splits without losing or reordering a byte', () => {
    const body = Array.from({ length: 60_000 }, (_, i) => `\u001b[${i}m`).join('')
    const payloads = chunkOutbound([chunk({ chunk: body })], MAX_PAYLOAD_BYTES)

    // The phone concatenates in arrival order. Anything less than an exact match
    // here is a corrupted terminal on the other end.
    const rebuilt = payloads.flatMap((p) => p.chunks).map((c) => c.chunk).join('')
    expect(rebuilt).toBe(body)
  })

  it('keeps each split piece with its own terminal', () => {
    const payloads = chunkOutbound(
      [
        chunk({ terminalId: 'a', chunk: '\u001b'.repeat(200_000) }),
        chunk({ terminalId: 'b', chunk: 'short' }),
      ],
      MAX_PAYLOAD_BYTES,
    )
    const all = payloads.flatMap((p) => p.chunks)
    expect(all.filter((c) => c.terminalId === 'a').map((c) => c.chunk).join('')).toBe(
      '\u001b'.repeat(200_000),
    )
    expect(all.filter((c) => c.terminalId === 'b').map((c) => c.chunk).join('')).toBe('short')
  })

  it('reports a gap once, on the first piece of a split chunk', () => {
    const payloads = chunkOutbound(
      [chunk({ chunk: '\u001b'.repeat(300_000), missed: 4096, marker: '[4096 chars lost]' })],
      MAX_PAYLOAD_BYTES,
    )
    const pieces = payloads.flatMap((p) => p.chunks)
    expect(pieces.length).toBeGreaterThan(1)

    // The marker is a rendered notice the phone prints. Carrying it on every
    // piece would print "output was lost" once per megabyte of the output that
    // survived, which reads as far worse loss than actually happened.
    expect(pieces[0].marker).toBe('[4096 chars lost]')
    expect(pieces[0].missed).toBe(4096)
    for (const p of pieces.slice(1)) {
      expect(p.marker).toBeNull()
      expect(p.missed).toBe(0)
    }
  })

  it('does not split a surrogate pair', () => {
    // Halving a string can land between the two code units of an astral
    // character. Each half is then a lone surrogate, and a phone that decodes
    // pieces independently renders a replacement character where the user typed
    // an emoji.
    //
    // The leading 'a' is load-bearing. A string of nothing but astral characters
    // has even length, so every halving lands cleanly BETWEEN pairs and the
    // guard is never reached -- the test passes whether or not the code has it.
    // One BMP character ahead of them makes the offsets odd, which is where the
    // cut actually falls mid-pair.
    const body = `a${'\u{1F680}'.repeat(5_000)}`
    const payloads = chunkOutbound([chunk({ chunk: body })], 4_096)
    for (const p of payloads.flatMap((x) => x.chunks)) {
      expect(/[\uD800-\uDBFF]$/.test(p.chunk)).toBe(false)
      expect(/^[\uDC00-\uDFFF]/.test(p.chunk)).toBe(false)
    }
    expect(payloads.flatMap((p) => p.chunks).map((c) => c.chunk).join('')).toBe(body)
  })

  it('terminates on a budget too small to satisfy', () => {
    // Fails loud rather than looping: a budget below the envelope overhead cannot
    // be met by any split, and silently halving forever would hang the bridge.
    const payloads = chunkOutbound([chunk({ chunk: 'abcdef' })], 8)
    expect(payloads.flatMap((p) => p.chunks).map((c) => c.chunk).join('')).toBe('abcdef')
    expect(payloads.length).toBeGreaterThan(1)
  })

  it('starts a new payload rather than overflowing an open one', () => {
    const half = 'x'.repeat(3_000)
    const payloads = chunkOutbound([chunk({ chunk: half }), chunk({ chunk: half })], 4_096)
    expect(payloads).toHaveLength(2)
    for (const p of payloads) expect(wireSize(p)).toBeLessThanOrEqual(4_096)
  })
})

describe('output wire shape', () => {
  // The phone switches on `kind`. Two different shapes behind one discriminator is
  // not a type smell -- it is a renderer that silently shows nothing. So assert
  // that what the chunker emits IS the union member the phone will destructure.
  it('emits messages assignable to the wire union', () => {
    const [payload] = chunkOutbound([chunk({ chunk: 'hello' })], MAX_PAYLOAD_BYTES)
    const message: RemoteMessage = payload
    expect(message.kind).toBe('output')
    if (message.kind !== 'output') throw new Error('unreachable')
    expect(message.chunks[0].chunk).toBe('hello')
  })

  it('has no member of the union a phone cannot render', () => {
    // An exhaustive switch. Adding a variant without teaching the phone about it
    // fails to compile here, which is the only place that failure is cheap.
    const render = (m: RemoteMessage): string => {
      switch (m.kind) {
        case 'ok':
          return 'ok'
        case 'error':
          return 'error'
        case 'output':
          return 'output'
        case 'status':
          return 'status'
        case 'capabilities':
          return 'capabilities'
        default: {
          const never: never = m
          return never
        }
      }
    }
    expect(render({ kind: 'ok', id: 1, data: null })).toBe('ok')
    expect(render({ kind: 'error', id: 1, message: 'no' })).toBe('error')
    expect(render({ kind: 'capabilities', capabilities: NO_CAPABILITIES })).toBe('capabilities')
  })

  it('hands a drained chunk straight to the wire with no adapter', () => {
    // DrainedChunk and the wire chunk are the same type by construction. They were
    // two structurally-identical declarations, which is exactly how a field gets
    // added to one and not the other.
    const drained: DrainedChunk = chunk()
    const wire: OutputChunk = drained
    expect(wire.marker).toBeNull()
  })
})
