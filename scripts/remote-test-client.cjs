#!/usr/bin/env node
'use strict'
/**
 * Manual harness for the remote bridge — the stand-in for the phone app until
 * sub-project 3 exists.
 *
 * It walks the whole flow the phone will walk: scan the QR, answer with a public
 * key, compare safety numbers, get refused while ungranted, get served once the
 * user grants, and go dark the moment the device is revoked. Every frame on the
 * wire is sealed, and the harness opens them with its own key to prove the relay
 * could not have.
 *
 * It runs against the BUILT bundle (`out/main/remoteBridge.js`), not the sources,
 * so it also proves the utilityProcess entry actually bundles and exports what a
 * peer needs. Run `npm run build` first if `out/` is stale.
 *
 * Usage: node scripts/remote-test-client.cjs
 */
const path = require('path')
const {
  createBridgeCore,
  generateIdentity,
  deriveVerificationPhrase,
  Handshake,
  FRAME_SESSION,
} = require(path.join(__dirname, '..', 'out', 'main', 'remoteBridge.js'))

const enc = new TextEncoder()
const dec = new TextDecoder()

let failures = 0
function check(label, ok) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failures++
}

async function main() {
  const desktop = generateIdentity()
  const phone = generateIdentity()

  const sent = []
  const core = createBridgeCore({
    send: (m) => sent.push(m),
    // Stub MCP: the point here is the bridge, not the terminals behind it.
    mcp: { callTool: async (name, args) => ({ stub: name, args }) },
    relayUrl: 'wss://relay.test',
  })

  console.log('1. boot the bridge with no paired devices')
  core.handleHostMessage({
    kind: 'init',
    mcpPort: 1,
    mcpToken: 'stub-token',
    identitySecretKey: desktop.secretKey,
    devices: [],
  })
  check('bridge reports ready', sent.some((m) => m.kind === 'ready'))

  console.log('\n2. desktop paints a pairing QR')
  core.handleHostMessage({ kind: 'beginPairing' })
  const code = sent.find((m) => m.kind === 'pairingCode')
  check('a pairing code was emitted', Boolean(code))
  if (!code) return
  const qr = JSON.parse(code.qrPayload)
  console.log('   QR payload:', code.qrPayload.replace(qr.oneTimeSecret, '<secret>'))
  check('QR carries the PUBLIC key, never the secret', qr.desktopPublicKey === desktop.publicKey)

  console.log('\n3. phone scans the QR and answers with its public key')
  const { device, verificationPhrase } = core.acceptPairing({
    oneTimeSecret: qr.oneTimeSecret,
    devicePublicKey: phone.publicKey,
    label: 'CLI Test Client',
  })
  console.log('   device id:', device.id)
  console.log('   safety number (compare on both screens):')
  console.log('     ', verificationPhrase)
  check(
    'phone derives the same safety number independently',
    verificationPhrase === deriveVerificationPhrase(phone.publicKey, desktop.publicKey),
  )
  check('device arrives with no capabilities', Object.values(device.capabilities).every((v) => v !== true))

  console.log('\n4. the offer is single-use')
  let reused = false
  try {
    core.acceptPairing({
      oneTimeSecret: qr.oneTimeSecret,
      devicePublicKey: generateIdentity().publicKey,
      label: 'second scanner',
    })
    reused = true
  } catch {
    /* expected */
  }
  check('a second scan of the same QR is refused', !reused)

  console.log('\n5. paired but ungranted — MCP must stay unreachable')
  const denied = await core.handleRemoteRequest(device.id, { id: 1, request: { kind: 'listTerminals' } })

  // A refusal must also refuse the SIDE EFFECT. Registering the fan-out
  // subscription before the capability check made `read` advisory: the device got
  // an error back and the output stream anyway. Asserting only that the response
  // says "no" would have passed against the leaking build.
  const deniedSub = await core.handleRemoteRequest(device.id, {
    id: 99,
    request: { kind: 'subscribe', terminalId: 'probe' },
  })
  core.handleHostMessage({
    kind: 'terminalOutput',
    terminalId: 'probe',
    slice: { output: 'SECRET=hunter2', nextOffset: 14, missed: 0 },
  })
  check('refused subscribe leaks no output', deniedSub.kind === 'error' && core.drainOutput(device.id).length === 0)
  check('ungranted request is refused', denied.kind === 'error')

  console.log('\n6. user grants read in Settings')
  core.handleHostMessage({
    kind: 'setCapabilities',
    deviceId: device.id,
    // The full shape, exactly as Settings sends it. Read only: the phone can look
    // at terminals and at nothing else until the user grants more.
    capabilities: { read: true, createTerminal: false, writeToTerminal: false, closeTerminal: false },
  })
  const ok = await core.handleRemoteRequest(device.id, { id: 2, request: { kind: 'listTerminals' } })
  check('granted request is served', ok.kind === 'ok')

  console.log('\n7. the two ends greet, then the response crosses the wire sealed')
  // Both greet unprompted -- the relay forwards blind and neither end learns who
  // arrived first, so a side that waited for the other would deadlock. The
  // session key is fresh per connection, which is what makes recorded traffic
  // useless to a relay that keeps it.
  const dh = new Handshake({
    ownSecretKey: desktop.secretKey,
    peerPublicKey: phone.publicKey,
    role: 'desktop',
  })
  const ph = new Handshake({
    ownSecretKey: phone.secretKey,
    peerPublicKey: desktop.publicKey,
    role: 'device',
  })
  console.log(`   greetings: ${dh.greeting.length} + ${ph.greeting.length} bytes`)
  const toPhone = dh.accept(ph.greeting)
  const atPhone = ph.accept(dh.greeting)

  const H = new Uint8Array([FRAME_SESSION])
  const frame = toPhone.seal(H, enc.encode(JSON.stringify(ok)))
  console.log(`   ${frame.length} opaque bytes on the wire; the relay sees only this`)
  check('phone opens the frame', dec.decode(atPhone.open(frame, 1)) === JSON.stringify(ok))

  const refuses = (label, fn) => {
    let opened = false
    try {
      fn()
      opened = true
    } catch {
      /* expected */
    }
    check(label, !opened)
  }

  const tampered = toPhone.seal(H, enc.encode(JSON.stringify(ok)))
  tampered[tampered.length - 1] ^= 0xff
  refuses('a tampered frame is rejected', () => atPhone.open(tampered, 1))
  refuses('a replayed frame is rejected', () => atPhone.open(frame, 1))
  refuses('the phone cannot open its own frame reflected back', () =>
    atPhone.open(atPhone.seal(H, enc.encode('echo')), 1),
  )

  // A second connection between the SAME two identities. Nothing recorded from
  // the first one may open here -- that is the forward secrecy the static
  // channel never had.
  const dh2 = new Handshake({
    ownSecretKey: desktop.secretKey,
    peerPublicKey: phone.publicKey,
    role: 'desktop',
  })
  const ph2 = new Handshake({
    ownSecretKey: phone.secretKey,
    peerPublicKey: desktop.publicKey,
    role: 'device',
  })
  dh2.accept(ph2.greeting)
  const atPhone2 = ph2.accept(dh2.greeting)
  refuses('a frame from the previous connection will not open in a new one', () =>
    atPhone2.open(frame, 1),
  )

  console.log('\n8. live output streams to a subscribed device')
  await core.handleRemoteRequest(device.id, { id: 3, request: { kind: 'subscribe', terminalId: 't1' } })
  core.handleHostMessage({
    kind: 'terminalOutput', terminalId: 't1',
    slice: { output: 'build finished\r\n', nextOffset: 16, missed: 0 },
  })
  const streamed = core.drainOutput(device.id)
  check('subscribed device receives terminal output', streamed.map((c) => c.chunk).join('') === 'build finished\r\n')
  check('drain is destructive, nothing is delivered twice', core.drainOutput(device.id).length === 0)

  console.log('\n9. withdrawing read stops the stream, not just future requests')
  core.handleHostMessage({
    kind: 'setCapabilities', deviceId: device.id,
    capabilities: { read: false, createTerminal: false, writeToTerminal: false, closeTerminal: false },
  })
  core.handleHostMessage({
    kind: 'terminalOutput', terminalId: 't1',
    slice: { output: 'secret\r\n', nextOffset: 24, missed: 0 },
  })
  check('output stops the moment read is withdrawn', core.drainOutput(device.id).length === 0)

  console.log('\n10. revoke takes effect immediately')
  core.handleHostMessage({ kind: 'revokeDevice', deviceId: device.id })
  const after = await core.handleRemoteRequest(device.id, { id: 4, request: { kind: 'listTerminals' } })
  check('revoked device is refused', after.kind === 'error')

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
