/** The two ends of a pairing. A room holds at most one socket per role, which is
 *  what makes a third connection an error rather than a silent extra listener
 *  quietly receiving a copy of someone else's traffic. */
export const ROLES = ['desktop', 'device'] as const
export type Role = (typeof ROLES)[number]

export function isRole(value: string | null): value is Role {
  return value !== null && (ROLES as readonly string[]).includes(value)
}

/** Which limit a peer hit, sent to it before it is cut. */
export type QuotaLimit = 'frame-size' | 'frame-rate' | 'connection-bytes' | 'idle'

/** Relay-to-peer control messages.
 *
 *  These are the ONLY frames the relay ever authors, and the only ones it parses.
 *  They are JSON TEXT frames; everything a peer sends as BINARY is opaque payload,
 *  forwarded byte-for-byte without being read. Keeping the two on different
 *  WebSocket frame types is what makes "the relay cannot read your traffic" a
 *  structural property rather than a promise: there is no branch in which a binary
 *  frame reaches a parser. */
export type ControlFrame =
  | { kind: 'hello'; role: Role }
  | { kind: 'peer-joined'; role: Role }
  | { kind: 'peer-gone'; role: Role }
  | { kind: 'quota-exceeded'; limit: QuotaLimit }

export function encode(frame: ControlFrame): string {
  return JSON.stringify(frame)
}

/** Size of an inbound binary frame, whatever shape the runtime hands us.
 *
 *  With binaryType='arraybuffer' this is always the first branch; the others exist
 *  so that a runtime change cannot silently make every frame measure zero and slip
 *  past the size cap. Returning MAX_SAFE_INTEGER for an unrecognised shape fails
 *  CLOSED -- an unmeasurable frame is refused rather than waved through. */
export function byteLength(data: unknown): number {
  if (data instanceof ArrayBuffer) return data.byteLength
  if (ArrayBuffer.isView(data)) return data.byteLength
  if (typeof data === 'string') return new TextEncoder().encode(data).length
  return Number.MAX_SAFE_INTEGER
}
