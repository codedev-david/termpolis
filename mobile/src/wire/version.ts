/** Named in SESSION_HELLO, PAIRING_HELLO and PAIRING_ACK. Each is refused if it
 *  carries any other number, and the refusal is reported as a version mismatch
 *  rather than surfacing as an unexplained decryption failure. */
export const PROTOCOL_VERSION = 2

/** The QR envelope's own version, deliberately independent of the protocol's.
 *  A scanner reads this before it knows whether it can speak to this desktop. */
export const QR_ENVELOPE_VERSION = 1
