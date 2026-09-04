import { describe, it, expect, vi } from 'vitest'
import { createBridgeCore } from '../../src/main/remoteBridge/entry'
import { generateIdentity, deriveVerificationPhrase } from '../../src/main/remoteBridge/sealedChannel'
import { NO_CAPABILITIES, type BridgeToHost, type PairedDevice } from '../../src/main/remoteBridge/protocol'

function device(id = 'd1'): PairedDevice {
  return { id, label: 'phone', publicKey: 'pk', capabilities: { ...NO_CAPABILITIES, read: true }, pairedAt: 0, lastSeenAt: 0 }
}

function core(devices: PairedDevice[] = []) {
  const sent: BridgeToHost[] = []
  const callTool = vi.fn().mockResolvedValue({ terminals: [] })
  const c = createBridgeCore({ send: (m) => sent.push(m), mcp: { callTool }, relayUrl: 'wss://relay.test' })
  c.handleHostMessage({ kind: 'init', mcpPort: 1, mcpToken: 't', identitySecretKey: 'a'.repeat(64), devices })
  return { c, sent, callTool }
}

describe('bridge core', () => {
  it('announces ready on init', () => {
    expect(core().sent.some((m) => m.kind === 'ready')).toBe(true)
  })

  it('emits a QR payload on beginPairing', () => {
    const { c, sent } = core()
    c.handleHostMessage({ kind: 'beginPairing', label: 'Pixel' })
    const code = sent.find((m) => m.kind === 'pairingCode')
    expect(code).toBeDefined()
    const payload = JSON.parse((code as Extract<BridgeToHost, { kind: 'pairingCode' }>).qrPayload)
    expect(payload.desktopPublicKey).toMatch(/^[0-9a-f]{64}$/)
    expect(payload.oneTimeSecret).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does NOT emit a verification phrase before a device has answered', () => {
    // The safety number is a function of both public keys. Before the device
    // replies there is no second key, so any phrase shown here would encode
    // nothing about who the user is actually talking to -- while looking exactly
    // like one that did. Comparing it against the phone would be a ritual, not a
    // check, so there must be nothing to compare yet.
    const { c, sent } = core()
    c.handleHostMessage({ kind: 'beginPairing', label: 'Pixel' })
    expect(sent.some((m) => m.kind === 'verificationPhrase')).toBe(false)
    expect(sent.find((m) => m.kind === 'pairingCode')).not.toHaveProperty('verificationPhrase')
  })

  it('emits the real 6-word phrase once a device completes pairing', () => {
    const { c, sent } = core()
    c.handleHostMessage({ kind: 'beginPairing', label: 'Pixel' })
    const code = sent.find((m) => m.kind === 'pairingCode')
    const payload = JSON.parse((code as Extract<BridgeToHost, { kind: 'pairingCode' }>).qrPayload)
    const phone = generateIdentity()

    const { device, verificationPhrase } = c.acceptPairing({
      oneTimeSecret: payload.oneTimeSecret,
      devicePublicKey: phone.publicKey,
      label: 'Pixel',
    })

    expect(verificationPhrase.split(' ')).toHaveLength(6)
    // Derived from both keys, so the phone computes the identical words and a
    // relay that swapped in its own key makes the two screens disagree.
    expect(verificationPhrase).toBe(
      deriveVerificationPhrase(payload.desktopPublicKey, phone.publicKey),
    )
    expect(sent.some((m) => m.kind === 'paired')).toBe(true)
    expect(sent.some((m) => m.kind === 'verificationPhrase')).toBe(true)
    expect(device.capabilities).toEqual(NO_CAPABILITIES)
  })

  it('refuses a second pairing against a spent offer', () => {
    const { c, sent } = core()
    c.handleHostMessage({ kind: 'beginPairing', label: 'Pixel' })
    const code = sent.find((m) => m.kind === 'pairingCode')
    const payload = JSON.parse((code as Extract<BridgeToHost, { kind: 'pairingCode' }>).qrPayload)
    c.acceptPairing({
      oneTimeSecret: payload.oneTimeSecret,
      devicePublicKey: generateIdentity().publicKey,
      label: 'First',
    })
    expect(() =>
      c.acceptPairing({
        oneTimeSecret: payload.oneTimeSecret,
        devicePublicKey: generateIdentity().publicKey,
        label: 'Second',
      }),
    ).toThrow(/no pairing offer is open/)
  })

  it('refuses a device that did not see the QR', () => {
    const { c } = core()
    c.handleHostMessage({ kind: 'beginPairing', label: 'Pixel' })
    expect(() =>
      c.acceptPairing({
        oneTimeSecret: 'f'.repeat(64),
        devicePublicKey: generateIdentity().publicKey,
        label: 'Attacker',
      }),
    ).toThrow(/secret/i)
  })

  it('serves an allowed request', async () => {
    const { c, callTool } = core([device()])
    const res = await c.handleRemoteRequest('d1', { id: 7, request: { kind: 'listTerminals' } })
    expect(res.kind).toBe('ok')
    expect(callTool).toHaveBeenCalledWith('list_terminals', {})
  })

  it('refuses a request from an unknown device', async () => {
    const { c, callTool } = core([])
    const res = await c.handleRemoteRequest('ghost', { id: 1, request: { kind: 'listTerminals' } })
    expect(res.kind).toBe('error')
    expect(callTool).not.toHaveBeenCalled()
  })

  it('refuses a request the device lacks capability for', async () => {
    const { c, callTool } = core([device()])
    const res = await c.handleRemoteRequest('d1', { id: 2, request: { kind: 'writeToTerminal', terminalId: 't', text: 'x' } })
    expect(res.kind).toBe('error')
    expect(callTool).not.toHaveBeenCalled()
  })

  it('stops serving a revoked device immediately', async () => {
    const { c } = core([device()])
    c.handleHostMessage({ kind: 'revokeDevice', deviceId: 'd1' })
    const res = await c.handleRemoteRequest('d1', { id: 3, request: { kind: 'listTerminals' } })
    expect(res.kind).toBe('error')
  })

  it('applies a capability change without a restart', async () => {
    const { c, callTool } = core([device()])
    c.handleHostMessage({ kind: 'setCapabilities', deviceId: 'd1', capabilities: { ...NO_CAPABILITIES, read: true, writeToTerminal: true } })
    const res = await c.handleRemoteRequest('d1', { id: 4, request: { kind: 'writeToTerminal', terminalId: 't', text: 'hi' } })
    expect(res.kind).toBe('ok')
    expect(callTool).toHaveBeenCalledWith('write_to_terminal', { terminalId: 't', text: 'hi' })
  })

  it('reports device changes to the host after a revoke', () => {
    const { c, sent } = core([device()])
    c.handleHostMessage({ kind: 'revokeDevice', deviceId: 'd1' })
    const changed = sent.filter((m) => m.kind === 'devicesChanged')
    expect(changed.length).toBeGreaterThan(0)
  })

  it('returns an error response rather than throwing when MCP fails', async () => {
    const sent: BridgeToHost[] = []
    const c = createBridgeCore({
      send: (m) => sent.push(m),
      mcp: { callTool: vi.fn().mockRejectedValue(new Error('mcp down')) },
      relayUrl: 'wss://relay.test',
    })
    c.handleHostMessage({ kind: 'init', mcpPort: 1, mcpToken: 't', identitySecretKey: 'a'.repeat(64), devices: [device()] })
    const res = await c.handleRemoteRequest('d1', { id: 5, request: { kind: 'listTerminals' } })
    expect(res.kind).toBe('error')
    expect((res as Extract<typeof res, { kind: 'error' }>).message).toMatch(/mcp down/)
  })
})
