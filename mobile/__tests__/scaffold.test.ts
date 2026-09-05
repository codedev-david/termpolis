import { PROTOCOL_VERSION, QR_ENVELOPE_VERSION } from '../src/wire/version'

describe('wire version constants', () => {
  it('pins the protocol version the desktop refuses to deviate from', () => {
    expect(PROTOCOL_VERSION).toBe(2)
  })

  it('versions the QR envelope separately from the protocol', () => {
    // Deliberately not the same number: the QR is read by a scanner that has not
    // yet decided whether it can speak to this desktop at all.
    expect(QR_ENVELOPE_VERSION).toBe(1)
    expect(QR_ENVELOPE_VERSION).not.toBe(PROTOCOL_VERSION)
  })
})
