import { describe, it, expect, vi } from 'vitest'
import { createBridgeCore } from '../../src/main/remoteBridge/entry'
import { SealedChannel, generateIdentity, deriveVerificationPhrase } from '../../src/main/remoteBridge/sealedChannel'
import { NO_CAPABILITIES, type BridgeToHost, type RemoteResponse } from '../../src/main/remoteBridge/protocol'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** The QR code the desktop paints. The phone scans exactly this and nothing else. */
interface QrPayload {
  v: number
  relayUrl: string
  pairingId: string
  desktopPublicKey: string
  oneTimeSecret: string
}

describe('remote bridge end-to-end', () => {
  // Everything below goes through createBridgeCore — the same entry point the
  // utilityProcess bootstrap calls — rather than the pairing/policy primitives
  // underneath it. The primitives already have their own unit tests; what is
  // untested until here is the WIRING: that beginPairing's QR really carries a
  // secret acceptPairing will honour, that accepting really reaches the registry
  // the dispatcher consults, and that revoking really unhooks it. Reaching past
  // the core to drive PairingSession directly would prove none of that.
  it('pairs, grants, serves, and revokes — with every frame sealed', async () => {
    const desktop = generateIdentity()
    const phone = generateIdentity()

    const sent: BridgeToHost[] = []
    const callTool = vi.fn().mockResolvedValue({ terminals: [{ id: 't1', name: 'agent' }] })
    const core = createBridgeCore({
      send: (m) => sent.push(m),
      mcp: { callTool },
      relayUrl: 'wss://relay.test',
    })

    // 1. Boot with no devices at all. Pairing has to create the only one.
    core.handleHostMessage({
      kind: 'init',
      mcpPort: 1,
      mcpToken: 'tok',
      identitySecretKey: desktop.secretKey,
      devices: [],
    })
    expect(sent.map((m) => m.kind)).toEqual(['ready'])

    // 2. User taps "Pair a phone". The desktop paints a QR.
    core.handleHostMessage({ kind: 'beginPairing', label: 'desk' })
    const code = sent.find((m) => m.kind === 'pairingCode')
    if (code?.kind !== 'pairingCode') throw new Error('no pairing code was emitted')
    const qr = JSON.parse(code.qrPayload) as QrPayload
    expect(qr.v).toBe(1)
    expect(qr.relayUrl).toBe('wss://relay.test')
    // The QR carries the desktop's PUBLIC key. If this ever leaked the secret key,
    // pairing would hand the whole identity to anyone who photographed the screen.
    expect(qr.desktopPublicKey).toBe(desktop.publicKey)
    expect(qr.desktopPublicKey).not.toBe(desktop.secretKey)

    // 3. The phone scans it and answers with its own public key.
    const { device, verificationPhrase } = core.acceptPairing({
      oneTimeSecret: qr.oneTimeSecret,
      devicePublicKey: phone.publicKey,
      label: 'iPhone',
    })
    expect(device.label).toBe('iPhone')
    // Ungranted on arrival: pairing establishes WHO, never WHAT.
    expect(device.capabilities).toEqual(NO_CAPABILITIES)

    // Both ends independently derive the same phrase — this is what defeats a MITM
    // relay. The phone computes it from the two keys it holds; the desktop emits it
    // to the host so the user can read the two aloud and compare.
    expect(verificationPhrase).toBe(deriveVerificationPhrase(phone.publicKey, desktop.publicKey))
    const announced = sent.find((m) => m.kind === 'verificationPhrase')
    if (announced?.kind !== 'verificationPhrase') throw new Error('no phrase was announced')
    expect(announced.deviceId).toBe(device.id)
    expect(announced.phrase).toBe(verificationPhrase)
    expect(sent.some((m) => m.kind === 'paired')).toBe(true)
    expect(sent.some((m) => m.kind === 'devicesChanged')).toBe(true)

    // 4. The offer is spent. A second phone photographing the same QR gets nothing.
    expect(() =>
      core.acceptPairing({
        oneTimeSecret: qr.oneTimeSecret,
        devicePublicKey: generateIdentity().publicKey,
        label: 'attacker',
      }),
    ).toThrow(/no pairing offer/)

    // 5. Paired is not granted. The device is refused and MCP is never touched.
    const denied = await core.handleRemoteRequest(device.id, { id: 1, request: { kind: 'listTerminals' } })
    expect(denied.kind).toBe('error')
    expect(callTool).not.toHaveBeenCalled()

    // 6. User grants read in Settings.
    core.handleHostMessage({
      kind: 'setCapabilities',
      deviceId: device.id,
      capabilities: { ...NO_CAPABILITIES, read: true },
    })

    // 7. Now it is served — and the response survives a sealed round-trip.
    const ok = await core.handleRemoteRequest(device.id, { id: 2, request: { kind: 'listTerminals' } })
    expect(ok.kind).toBe('ok')
    expect(callTool).toHaveBeenCalledWith('list_terminals', {})

    const toPhone = new SealedChannel(desktop.secretKey, phone.publicKey)
    const atPhone = new SealedChannel(phone.secretKey, desktop.publicKey)
    const frame = toPhone.seal(enc.encode(JSON.stringify(ok)))
    const received = JSON.parse(dec.decode(atPhone.open(frame))) as RemoteResponse
    expect(received).toEqual(ok)

    // 8. A relay that tampers with the frame gets nothing through.
    const tampered = toPhone.seal(enc.encode(JSON.stringify(ok)))
    tampered[tampered.length - 1] ^= 0xff
    expect(() => atPhone.open(tampered)).toThrow()

    // 9. Revoke takes effect immediately — no reconnect, no restart.
    core.handleHostMessage({ kind: 'revokeDevice', deviceId: device.id })
    const afterRevoke = await core.handleRemoteRequest(device.id, { id: 3, request: { kind: 'listTerminals' } })
    expect(afterRevoke.kind).toBe('error')
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it('never lets an unpaired device reach MCP even with a valid-looking request', async () => {
    const callTool = vi.fn()
    const core = createBridgeCore({ send: () => {}, mcp: { callTool }, relayUrl: 'wss://relay.test' })
    core.handleHostMessage({
      kind: 'init', mcpPort: 1, mcpToken: 'tok', identitySecretKey: generateIdentity().secretKey, devices: [],
    })
    const res = await core.handleRemoteRequest('never-paired', { id: 1, request: { kind: 'listTerminals' } })
    expect(res.kind).toBe('error')
    expect(callTool).not.toHaveBeenCalled()
  })
})
