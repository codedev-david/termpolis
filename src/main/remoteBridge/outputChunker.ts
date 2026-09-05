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

/** Bytes an empty envelope costs: `{"kind":"output","chunks":[]}`.
 *
 *  Measured once at module load so the packer below can price a piece on its own
 *  and add it to a running total, instead of re-serialising everything it has
 *  already packed. See `chunkOutbound`. */
const EMPTY_BYTES = wireSize(ENVELOPE)

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
 *  frame-rate limit during ordinary typing.
 *
 *  The running total is exact, not an estimate, so this packs identically to
 *  measuring the whole array each time -- and it has to be exact, because
 *  overshooting `maxBytes` by one byte gets the connection cut. A JSON array
 *  serialises as the envelope plus each element plus one comma between
 *  neighbours, and an element's own bytes do not depend on what sits beside it,
 *  so `EMPTY_BYTES + sum(element bytes) + (count - 1)` IS the wire size.
 *
 *  Measuring the accumulated array instead costs a full re-serialisation per
 *  piece: quadratic in both count and bytes. That is not a micro-optimisation
 *  here. Nothing bounds the piece count -- the fan-out evicts on a character
 *  budget, never on a count -- so a phone reattaching after a long detach hands
 *  this tens of thousands of small chunks at once, synchronously, in the
 *  utilityProcess that serves every paired device. Measured on the real modules,
 *  a full 256 KB backlog of escape-heavy output took ~33 seconds to pack that
 *  way and 23 ms this way. Thirty-three seconds is long enough for the relay to
 *  drop the socket for idleness, so the reattach that triggered it also fails. */
export function chunkOutbound(chunks: DrainedChunk[], maxBytes: number): OutputPayload[] {
  const pieces = chunks.flatMap((c) => splitChunk(c, maxBytes))
  const payloads: OutputPayload[] = []
  let open: DrainedChunk[] = []
  let openBytes = EMPTY_BYTES

  for (const piece of pieces) {
    const pieceBytes = wireSize({ ...ENVELOPE, chunks: [piece] }) - EMPTY_BYTES
    // The comma is only spent once there is a neighbour to separate it from.
    const withPiece = openBytes + pieceBytes + (open.length > 0 ? 1 : 0)
    if (open.length > 0 && withPiece > maxBytes) {
      payloads.push({ kind: 'output', chunks: open })
      open = [piece]
      openBytes = EMPTY_BYTES + pieceBytes
      continue
    }
    open.push(piece)
    openBytes = withPiece
  }
  if (open.length > 0) payloads.push({ kind: 'output', chunks: open })
  return payloads
}
