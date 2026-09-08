import { fromHex, toHex } from '../src/wire/bytes'
import { MAX_DEVICE_LABEL } from '../src/wire/deviceLabel'
import { deviceIdFor, openPairingAck, sealPairingHello } from '../src/wire/pairing'
import { pairingRoot, sessionFromRoot } from '../src/wire/sessionCrypto'
import { PROTOCOL_VERSION } from '../src/wire/version'
import { utf8Encode } from '../src/wire/bytes'

// Wire format section 12.
const DESKTOP_ID_SK = '11'.repeat(32)
const DEVICE_ID_SK = '22'.repeat(32)
const DESKTOP_ID_PK = '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13'
const DEVICE_ID_PK = '0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20'
const PAIRING_ID = '0123456789abcdef0123456789abcdef'
const ONE_TIME_SECRET = 'aa'.repeat(32)
const DEVICE_ID = '12faa049f0ec7720'

const HELLO_ASCII =
  '010faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f2000000000000020' +
  '81553da47997d20ba9ead687b5284bc29952a3fa91efcff877f847813c9b10cddd32a7d112f4ee6' +
  '45add4095efbc5f45797dcacdd271e925ecab97466b3a7ecb3fba9bd3cd247ce0f2ea6ee5313cf1' +
  '323e3e5fd8f54fafcad27a09d5b774cb629d9953544b558a9e8c8f35157d4a630821b9da811a465' +
  'aa39c3d02029d4a58'

const HELLO_UTF8 =
  '010faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f2000000000000020' +
  '81553da47997d20ba9ead687b5284bc63383aa5518a687c76bf2454f9e605e91ab77e8db2ff4d97' +
  'f52cc31caaeaf5b503a2689cdd271e925ecab97466b3a7ecb3fba9bd3cd247ce0f2ea6ee5313cf1' +
  '323e3e5fd8f54fafcad27a09d5b774cb629d9953544b558a9e8c8f35157d097f09908f284212b23' +
  '62736c1792e001968ccad6b75b8b2'

const ACK =
  '02000000000000d58c0735797b5b7a4a055b26fff0cb3cc88c3a055e9452feee281c91e91cd4859f' +
  '6c24be770d00f17470eb1a8f69659a9cccb79167'

function hello(label: string): Uint8Array {
  return sealPairingHello({
    deviceSecretKey: DEVICE_ID_SK,
    devicePublicKey: DEVICE_ID_PK,
    desktopPublicKey: DESKTOP_ID_PK,
    pairingId: PAIRING_ID,
    label,
    oneTimeSecret: ONE_TIME_SECRET,
  })
}

describe('deviceIdFor', () => {
  it('matches the golden vector', () => {
    expect(deviceIdFor(DEVICE_ID_PK)).toBe(DEVICE_ID)
  })

  it('is eight bytes of hex, the desktop stable handle for this phone', () => {
    expect(deviceIdFor(DEVICE_ID_PK)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('differs for a different key', () => {
    expect(deviceIdFor(DESKTOP_ID_PK)).not.toBe(DEVICE_ID)
  })
})

describe('sealPairingHello', () => {
  it('matches the golden ASCII vector', () => {
    expect(toHex(hello('Pixel 9 Pro'))).toBe(HELLO_ASCII)
  })

  it('matches the golden multi-byte vector', () => {
    // 13 characters, 17 UTF-8 bytes. This vector exists to catch an encoder that
    // writes UTF-16 or escapes non-ASCII, so it must be a literal comparison.
    expect(toHex(hello('Téléphone — 9'))).toBe(HELLO_UTF8)
  })

  it('carries the device public key in the clear header', () => {
    // It has to ride in the clear: the desktop has never seen this phone and
    // cannot derive the sealing key without the key it is deriving against.
    const frame = hello('Pixel 9 Pro')
    expect(frame[0]).toBe(0x01)
    expect(toHex(frame.subarray(1, 33))).toBe(DEVICE_ID_PK)
  })

  it('keeps the label and the one-time secret inside the seal', () => {
    const frame = hello('Pixel 9 Pro')
    const clear = toHex(frame)
    expect(clear).not.toContain(toHex(utf8Encode('Pixel 9 Pro')))
    expect(clear).not.toContain(ONE_TIME_SECRET)
  })

  it('is bound to the pairing id', () => {
    const other = sealPairingHello({
      deviceSecretKey: DEVICE_ID_SK,
      devicePublicKey: DEVICE_ID_PK,
      desktopPublicKey: DESKTOP_ID_PK,
      pairingId: 'f'.repeat(32),
      label: 'Pixel 9 Pro',
      oneTimeSecret: ONE_TIME_SECRET,
    })
    expect(toHex(other)).not.toBe(HELLO_ASCII)
  })
})

type Ack = { deviceId: string; desktopName: string | null } | null

describe('openPairingAck', () => {
  function open(frame: Uint8Array, pairingId = PAIRING_ID): Ack {
    return openPairingAck({
      frame,
      deviceSecretKey: DEVICE_ID_SK,
      desktopPublicKey: DESKTOP_ID_PK,
      pairingId,
    })
  }

  it('opens the golden ack and reads the device id back', () => {
    // The golden vector predates the name field, which is exactly the point:
    // it is what a 1.39 desktop still sends, and it must still pair.
    expect(open(fromHex(ACK))).toEqual({ deviceId: DEVICE_ID, desktopName: null })
  })

  it('opens without the session the hello was sealed with', () => {
    // The ack is sealed on a session built fresh from the pairing root, so its
    // counter is the first on the desktop-to-phone direction. That is what lets
    // the phone open it having kept nothing.
    hello('Pixel 9 Pro')
    expect(open(fromHex(ACK))?.deviceId).toBe(DEVICE_ID)
  })

  it('refuses an ack sealed under a different pairing id', () => {
    // The salt binding. Without it, an ack captured from one offer replays into
    // the next offer the same desktop shows -- the identity keys have not
    // changed.
    expect(open(fromHex(ACK), 'f'.repeat(32))).toBeNull()
  })

  it('refuses a tampered ack rather than throwing', () => {
    const frame = fromHex(ACK)
    frame[frame.length - 1] = (frame[frame.length - 1] as number) ^ 0xff
    expect(() => open(frame)).not.toThrow()
    expect(open(frame)).toBeNull()
  })

  it('refuses a truncated ack', () => {
    expect(open(fromHex(ACK).subarray(0, 10))).toBeNull()
    expect(open(new Uint8Array(0))).toBeNull()
  })

  it('refuses a frame whose tag is not 0x02', () => {
    const frame = fromHex(ACK)
    frame[0] = 0x04
    expect(open(frame)).toBeNull()
  })

  it('refuses an ack whose payload version is not 2', () => {
    // A relay that could forge an ack would send the phone off to a session room
    // the desktop is not in, where it would wait with no error to show. So the
    // ack is authenticated -- and its shape is still checked.
    const root = pairingRoot(DESKTOP_ID_SK, DEVICE_ID_PK, PAIRING_ID)
    const forged = sessionFromRoot(root, 'desktop').seal(
      Uint8Array.from([0x02]),
      utf8Encode(JSON.stringify({ v: 99, deviceId: DEVICE_ID })),
    )
    expect(open(forged)).toBeNull()
  })

  it('refuses an ack carrying a device id that is not the shape of one', () => {
    const root = pairingRoot(DESKTOP_ID_SK, DEVICE_ID_PK, PAIRING_ID)
    for (const bad of ['', 'nope', 'A'.repeat(16), 42, null]) {
      const forged = sessionFromRoot(root, 'desktop').seal(
        Uint8Array.from([0x02]),
        utf8Encode(JSON.stringify({ v: 2, deviceId: bad })),
      )
      expect(open(forged)).toBeNull()
    }
  })

  it('refuses an ack whose payload is not JSON', () => {
    const root = pairingRoot(DESKTOP_ID_SK, DEVICE_ID_PK, PAIRING_ID)
    const forged = sessionFromRoot(root, 'desktop').seal(
      Uint8Array.from([0x02]),
      utf8Encode('not json'),
    )
    expect(open(forged)).toBeNull()
  })
})

describe('an ack whose payload is valid JSON but not an object', () => {
  /** The desktop half, sealing whatever text the test wants to send. */
  function ackOf(json: string): Uint8Array {
    const header = Uint8Array.from([fromHex(ACK)[0] as number])
    const root = pairingRoot(DESKTOP_ID_SK, DEVICE_ID_PK, PAIRING_ID)
    return sessionFromRoot(root, 'desktop').seal(header, utf8Encode(json))
  }

  function open(json: string): Ack {
    return openPairingAck({
      frame: ackOf(json),
      deviceSecretKey: DEVICE_ID_SK,
      desktopPublicKey: DESKTOP_ID_PK,
      pairingId: PAIRING_ID,
    })
  }

  it('refuses a bare number', () => {
    // JSON.parse succeeds on `42`, so the try/catch around it does not catch
    // this one. Reading `.v` off a number happens to yield undefined and the
    // version check would refuse it -- by accident, and only for numbers.
    expect(open('42')).toBeNull()
  })

  it('refuses a literal null', () => {
    // `typeof null` is 'object', so the type check alone lets this through and
    // the destructuring on the next line throws inside a socket callback.
    expect(open('null')).toBeNull()
  })

  it('still opens the object form those were built against', () => {
    // Otherwise the two above would pass against a function that refused
    // everything this helper produced.
    expect(open(JSON.stringify({ v: PROTOCOL_VERSION, deviceId: DEVICE_ID }))).toEqual({
      deviceId: DEVICE_ID,
      desktopName: null,
    })
  })
})

describe('the name the desktop calls itself in its ack', () => {
  /** The desktop half, with whatever `name` the test wants -- including none. */
  function ackWith(extra: Record<string, unknown>): Uint8Array {
    const root = pairingRoot(DESKTOP_ID_SK, DEVICE_ID_PK, PAIRING_ID)
    const payload = { v: PROTOCOL_VERSION, deviceId: DEVICE_ID, ...extra }
    return sessionFromRoot(root, 'desktop').seal(
      Uint8Array.from([0x02]),
      utf8Encode(JSON.stringify(payload)),
    )
  }

  function nameOf(extra: Record<string, unknown>): string | null | undefined {
    return openPairingAck({
      frame: ackWith(extra),
      deviceSecretKey: DEVICE_ID_SK,
      desktopPublicKey: DESKTOP_ID_PK,
      pairingId: PAIRING_ID,
    })?.desktopName
  }

  it('reads the name the desktop sent', () => {
    // What makes a switcher with four machines in it usable: the desktop's own
    // hostname rather than four identical rows.
    expect(nameOf({ name: 'DAVID-DESKTOP' })).toBe('DAVID-DESKTOP')
  })

  it('pairs anyway with a desktop too old to send one', () => {
    // The field is additive on protocol 2 precisely so this holds. Refusing here
    // would strand every 1.39 desktop behind a phone update.
    expect(nameOf({})).toBeNull()
  })

  it('keeps a name with non-ASCII in it whole', () => {
    expect(nameOf({ name: 'Büro-Rechner — 2' })).toBe('Büro-Rechner — 2')
  })

  it('strips control characters out of a name before it is ever stored', () => {
    // The name crosses the relay and lands in the keystore. A stray NUL is not
    // an injection in a React <Text>, but it is a value that will not survive
    // the round trip through storage intact.
    expect(nameOf({ name: 'work\u0000box\u001b[31m' })).toBe('workbox[31m')
  })

  it('caps a name long enough to push a row off the switcher', () => {
    expect(nameOf({ name: 'z'.repeat(400) })).toBe('z'.repeat(MAX_DEVICE_LABEL))
  })

  it('reports whitespace as no name at all, so the caller can pick a fallback', () => {
    // `null` and `''` have to be told apart: the client turns the first into
    // "Termpolis desktop" and would otherwise draw a nameless row.
    expect(nameOf({ name: '   ' })).toBeNull()
  })

  it('reports a name of the wrong type as no name, without refusing the pairing', () => {
    // The seal proves WHICH desktop sent this, not that it was running a version
    // that cared what it put in the field.
    for (const bad of [42, null, { name: 'nope' }, ['x']]) {
      expect(nameOf({ name: bad })).toBeNull()
    }
  })
})
