import type { DrainedChunk } from './outputFanout'
import { RELAY_MAX_FRAME_BYTES, type OutputPayload } from './protocol'
import { SEAL_OVERHEAD_BYTES } from './sealedChannel'
import { SESSION_HEADER_BYTES } from './sessionCrypto'

// Re-exported for the callers that already import it from here. The declaration
// lives in protocol.ts, with the rest of the wire contract, so there is one
// place to read when writing a second implementation of it.
export type { OutputPayload }

/** How much plaintext fits in a frame the relay will forward.
 *
 *  The relay cuts a connection that sends an oversized frame -- it does not
 *  truncate it and it does not warn first. What arrives there is the SEALED
 *  frame, so the plaintext budget is the cap less everything wrapped around it:
 *  the frame tag, the counter, and the Poly1305 tag. */
export const MAX_PAYLOAD_BYTES =
  RELAY_MAX_FRAME_BYTES - SESSION_HEADER_BYTES - SEAL_OVERHEAD_BYTES

const ENVELOPE: OutputPayload = { kind: 'output', chunks: [] }

function wireSize(payload: OutputPayload): number {
  // Measured, not estimated. Terminal output is dense in control characters, and
  // JSON escapes ESC to a six-byte  -- so a queue that measures 256 KB as a
  // string serialises to more than 1.5 MiB. Any fixed inflation factor is either
  // wrong for plain text (wasting most of every frame) or wrong for escape-heavy
  // output (which is the case that gets the connection cut).
  return new TextEncoder().encode(JSON.stringify(payload)).length
}

/** Split one chunk's text into pieces that each serialise under `maxBytes`.
 *
 *  Halving rather than computing an offset from the byte count: the mapping from
 *  characters to serialised bytes is not linear (one character can cost one byte
 *  or six), so there is no offset to compute. Halving converges in a handful of
 *  passes and cannot overshoot. */
function splitChunk(chunk: DrainedChunk, maxBytes: number): DrainedChunk[] {
  if (wireSize({ ...ENVELOPE, chunks: [chunk] }) <= maxBytes) return [chunk]

  let cut = Math.max(1, Math.floor(chunk.chunk.length / 2))
  // Never between the two code units of an astral character. Split there and each
  // half is a lone surrogate; a phone that decodes pieces as it receives them
  // renders a replacement character where the user typed an emoji.
  const code = chunk.chunk.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff && cut < chunk.chunk.length) cut += 1

  // A single code unit that still does not fit means the budget is smaller than
  // the envelope itself. Emitting it oversized loses nothing and ends the
  // recursion; halving forever would hang the bridge on a misconfiguration.
  if (cut >= chunk.chunk.length) return [chunk]

  const head: DrainedChunk = { ...chunk, chunk: chunk.chunk.slice(0, cut) }
  // The gap notice belongs to the first piece only. Repeating it would print
  // "output was lost" once per megabyte of the output that actually survived.
  const tail: DrainedChunk = {
    ...chunk,
    chunk: chunk.chunk.slice(cut),
    missed: 0,
    marker: null,
  }
  return [...splitChunk(head, maxBytes), ...splitChunk(tail, maxBytes)]
}

/** Pack a drain into as few frames as will hold it.
 *
 *  Few frames matters as much as small ones: every frame spends a token from the
 *  relay's 40-frame burst, so a payload per echoed keystroke would trip the
 *  frame-rate limit during ordinary typing. */
export function chunkOutbound(chunks: DrainedChunk[], maxBytes: number): OutputPayload[] {
  const pieces = chunks.flatMap((c) => splitChunk(c, maxBytes))
  const payloads: OutputPayload[] = []
  let open: DrainedChunk[] = []

  for (const piece of pieces) {
    const candidate = [...open, piece]
    if (open.length > 0 && wireSize({ ...ENVELOPE, chunks: candidate }) > maxBytes) {
      payloads.push({ kind: 'output', chunks: open })
      open = [piece]
      continue
    }
    open = candidate
  }
  if (open.length > 0) payloads.push({ kind: 'output', chunks: open })
  return payloads
}
