# Remote Protocol Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze a correct, phone-ready wire protocol for Termpolis Remote — fixing the replay, reflection and safety-number defects in the shipped channel, and giving pairing an actual transport — before a second implementation exists to break.

**Architecture:** The sealed channel becomes a *session*: an ephemeral-static Diffie-Hellman handshake per connection derives a root key, HKDF splits it into two directional keys, and the frame counter becomes the AEAD nonce. Pairing gets its own short-lived relay room and a two-frame handshake; the long-lived session room is derived from the static shared secret, so only the two parties can name it. Every peer-to-peer frame is binary, type-tagged, and the type is authenticated as associated data.

**Tech Stack:** TypeScript, Electron `utilityProcess`, `@noble/curves` / `@noble/ciphers` / `@noble/hashes` @ 2.4.0 (pure JS, no native deps), `ws` for the desktop socket, Cloudflare Workers + Durable Objects for the relay, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-04-termpolis-remote-design.md`

**Why this plan exists:** an adversarial review of the shipped bridge (workflow `wf_484686d6-f8b`, 28 agents, 16 findings surviving refutation) established that the current channel is *static-static* — one key for the life of a pairing, shared by both directions, with per-instance counters. That combination means (a) a bridge restart replays recorded frames verbatim and they re-execute, (b) a phone that correctly persists its replay high-water is permanently deafened by a desktop restart, (c) a relay that echoes a peer's own frame back at it wedges the counter forever, and (d) the six-word safety number is 30 bits and grindable in under an hour. None of these can be fixed after a phone ships without a three-way breaking change, so they are fixed here.

## Global Constraints

- **Commit directly to `main`.** No branches, no PRs. Releases are a version bump plus a `vX.Y.Z` tag.
- **Coverage gate (Windows CI): lines 97 / functions 96 / branches 95 / statements 96.** Never lower it; backfill tests on the offending file.
- **Every peer-to-peer relay frame is BINARY.** `relay/src/pairingRoom.ts:80` drops text from a peer unread, *above* the `lastSeen` update — a text frame is invisible and does not even hold off the idle cut.
- **Both ends must set `binaryType = 'arraybuffer'` on their own socket.** The relay sets it on its half only (`relay/src/pairingRoom.ts:56`); workerd's `send()` coerces a Blob to the literal string `"[object Blob]"`, destroying every byte while the frame count still looks healthy.
- **Relay frame ceiling: 1 MiB** (`MAX_FRAME_BYTES`, `relay/src/quota.ts:16`), 20 frames/sec with a burst of 40, 256 MiB per connection, 300 s idle cut.
- **No new runtime dependency.** `@noble/hashes/hkdf.js` is already installed and exports `hkdf(hash, ikm, salt, info, length)`.
- **Never log a frame, a frame body, or any part of one** — in the bridge or the relay. See `relay/PRIVACY.md`.
- **This feature has never shipped to a user.** There are no paired devices in the field, so `PairedDevice` may be renamed and the wire format may be broken freely — this is the last moment that is true.

---

## Wire format v2 (normative)

Every peer-to-peer frame is binary and begins with a one-byte type. The bytes before the counter are the frame's **header**, and the header is passed to ChaCha20-Poly1305 as associated data, so flipping a type byte or substituting a public key fails authentication rather than being reinterpreted.

```
0x01  PAIRING HELLO   device → desktop, pairing room only
      0x01 || devicePublicKey[32] || counter[6] || AEAD(K_pair_dev, nonce, aad=header, JSON)
      JSON: { v: 2, label: string, oneTimeSecret: string }

0x02  PAIRING ACK     desktop → device, pairing room only
      0x02 || counter[6] || AEAD(K_pair_desk, nonce, aad=header, JSON)
      JSON: { v: 2, deviceId: string, verificationPhrase: string }

0x03  SESSION HELLO   both ends, session room, first frame
      0x03 || ephemeralPublicKey[32] || counter[6] || AEAD(K_hs_own, nonce, aad=header, JSON)
      JSON: { v: 2, role: 'desktop' | 'device' }

0x04  SESSION FRAME   both ends, session room, after the handshake
      0x04 || counter[6] || AEAD(K_sess_own, nonce, aad=header, JSON)
      JSON: a RemoteEnvelope (device → desktop) or a RemoteMessage (desktop → device)
```

`counter` is 6 bytes big-endian. `nonce` is 12 bytes: six zero bytes followed by the counter. Each key is used in exactly one direction, so a counter-derived nonce can never repeat under a key. Seal overhead is therefore `6 + 16 = 22` bytes plus the header.

Key schedule — all HKDF-SHA256, `dh(a, b)` is X25519:

```
K_pair      = HKDF(ikm = dh(deviceSk, desktopPk), salt = pairingId,          info = "termpolis-pair-v2")
K_hs        = HKDF(ikm = dh(ownSk,    peerPk),    salt = (none),             info = "termpolis-handshake-v2")
K_session   = HKDF(ikm = dh(ownEphSk, peerEphPk) || dh(ownSk, peerPk),
                                                   salt = sha256(loEph || hiEph),
                                                                             info = "termpolis-session-v2")
sessionRoom = HKDF(ikm = dh(ownSk,    peerPk),    salt = (none),             info = "termpolis-session-room-v2")[0..16]

for each root K above:
  K_desktop→device = HKDF(ikm = K, salt = (none), info = "termpolis-d2p-v2")
  K_device→desktop = HKDF(ikm = K, salt = (none), info = "termpolis-p2d-v2")
```

`loEph`/`hiEph` are the two ephemeral public keys sorted bytewise, so both ends compute the same salt without knowing who spoke first. The static `dh(ownSk, peerPk)` term in `K_session` authenticates: only a holder of one of the two identity private keys can derive it. The ephemeral term supplies forward secrecy, which spec §4.2 already promises and the shipped code does not deliver.

**What each fix buys, and which finding it closes:**

| Property | Mechanism | Closes |
|---|---|---|
| A recorded session cannot be replayed after a restart | fresh ephemeral per connection | blocker: replay-on-restart |
| A restart does not deafen a correct phone | counters are per-connection *by construction*, and both ends know it | blocker: counter-reset deafening |
| A relay cannot reflect a peer's frames at itself | two directional keys | important: wedged counter |
| Recorded traffic stays unreadable if an identity key later leaks | ephemeral DH in the IKM | spec §4.2 forward secrecy |
| A stolen QR photograph cannot squat the session room | room id derived from the static shared secret | important: permanent remote DoS |
| A substituted key is visible to the user | 64-bit safety number | blocker: 30-bit grindable SAS |

---

## File Structure

**Created**

- `src/main/remoteBridge/wordlist.ts` — 256 words for safety numbers, plus the invariants that keep it 8 bits per word.
- `src/main/remoteBridge/sessionCrypto.ts` — `SealedSession`, `Handshake`, `deriveSessionRoomId`. All key derivation lives here; `sealedChannel.ts` keeps only the frame codec and identity.
- `tests/electron/remoteSessionCrypto.test.ts`
- `tests/electron/remoteWordlist.test.ts`
- `tests/electron/remotePairingTransport.test.ts`

**Modified**

- `src/main/remoteBridge/sealedChannel.ts` — `SealedChannel` (static ECDH, one key) → `SealedDirection` (one raw key, one counter, header-as-AAD); `deriveVerificationPhrase` rewritten against the 256-word list.
- `src/main/remoteBridge/protocol.ts` — one output shape; `PairedDevice.pairingId` → `sessionRoomId`; frame-type constants.
- `src/main/remoteBridge/outputChunker.ts` — `OutputPayload` moves to `protocol.ts`; `SEAL_OVERHEAD_BYTES` 34 → 22.
- `src/main/remoteBridge/relayClient.ts` — handshake state machine, control-frame parsing, keepalive, `roomId` instead of `pairingId`.
- `src/main/remoteBridge/entry.ts` — dial the pairing room on `beginPairing`; hand off to the session room on accept.
- `src/main/remoteBridge/pairing.ts` — hello/ack codec, `sessionRoomId` on the device record.
- `scripts/remote-test-client.cjs` — the stand-in phone; it is the executable specification the Expo client will mirror.
- Existing tests under `tests/electron/remote*.test.ts`.

**Not modified**

The relay. Every fix here is on the peer side; the relay's contract (binary forwarded opaquely, text authored only by the relay) is already right and is what the design leans on.

---

### Task 1: One output shape on the wire

`protocol.ts:55` declares `{ kind: 'output'; terminalId; chunk; missed }`. Nothing constructs it. What the bridge actually sends is `OutputPayload { kind: 'output'; chunks: DrainedChunk[] }` from `outputChunker.ts:6-9`, via `entry.ts:134`. Both carry the same `kind`, so a phone that switches on `kind` and reads `.chunk` gets `undefined` for every field and silently renders nothing. Fix the type, and make the union exhaustive so it cannot drift again.

**Files:**
- Modify: `src/main/remoteBridge/protocol.ts:51-56`
- Modify: `src/main/remoteBridge/outputChunker.ts:1-9`
- Modify: `tests/electron/remoteRelayClient.test.ts:364`
- Test: `tests/electron/remoteOutputChunker.test.ts`

**Interfaces:**
- Produces: `RemoteMessage` (everything the desktop may put on the wire), `RemoteResponse` (only what `onRequest` returns: `ok | error`), `OutputPayload` re-homed in `protocol.ts`.

- [ ] **Step 1: Write the failing test**

In `tests/electron/remoteOutputChunker.test.ts`:

```ts
import { chunkOutbound, MAX_PAYLOAD_BYTES } from '../../src/main/remoteBridge/outputChunker'
import type { RemoteMessage } from '../../src/main/remoteBridge/protocol'

describe('output wire shape', () => {
  // The phone switches on `kind`. Two different shapes behind one discriminator is
  // not a type smell, it is a silent renderer that shows nothing -- so assert that
  // what the chunker emits IS the union member the phone will destructure.
  it('emits messages assignable to the wire union', () => {
    const [payload] = chunkOutbound(
      [{ terminalId: 't1', chunk: 'hello', missed: 0, marker: null }],
      MAX_PAYLOAD_BYTES,
    )
    const message: RemoteMessage = payload
    expect(message.kind).toBe('output')
    if (message.kind !== 'output') throw new Error('unreachable')
    expect(message.chunks[0].chunk).toBe('hello')
  })

  it('has no member of the union that a phone cannot render', () => {
    // An exhaustive switch. Adding a variant without teaching the phone about it
    // fails to compile here, which is the only place that failure is cheap.
    const render = (m: RemoteMessage): string => {
      switch (m.kind) {
        case 'ok': return 'ok'
        case 'error': return 'error'
        case 'output': return 'output'
        case 'status': return 'status'
        default: {
          const never: never = m
          return never
        }
      }
    }
    expect(render({ kind: 'ok', id: 1, data: null })).toBe('ok')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/electron/remoteOutputChunker.test.ts`
Expected: FAIL — `RemoteMessage` is not exported from `protocol.ts`.

- [ ] **Step 3: Make it pass**

In `protocol.ts`, delete the dead variant and split the union:

```ts
/** One drained slice of a terminal's output, as the fan-out hands it over. */
export interface OutputChunk {
  terminalId: string
  chunk: string
  /** Chars evicted before the fan-out got to them. Non-zero means output is gone. */
  missed: number
  /** Rendered gap marker, on the FIRST piece of a split chunk only. */
  marker: string | null
}

/** Terminal output, batched. Many chunks per frame: the relay bills per frame and
 *  allows a burst of 40, so one frame per chunk would spend the burst on a single
 *  noisy build. */
export interface OutputPayload {
  kind: 'output'
  chunks: OutputChunk[]
}

/** What `onRequest` returns: an answer to exactly one envelope. */
export type RemoteResponse =
  | { kind: 'ok'; id: number; data: unknown }
  | { kind: 'error'; id: number; message: string }

/** Everything the desktop may put on the wire, answers and pushes alike. The phone
 *  switches on `kind` over exactly this union. */
export type RemoteMessage =
  | RemoteResponse
  | OutputPayload
  | { kind: 'status'; terminalId: string; status: AgentStatus; summary: string }
```

In `outputChunker.ts`, delete the local `OutputPayload` and `DrainedChunk` re-declaration and import from `protocol.ts`, re-exporting `OutputPayload` for existing importers. Fix `tests/electron/remoteRelayClient.test.ts:364` to construct an `OutputPayload`.

- [ ] **Step 4: Run the remote suite**

Run: `npx vitest run tests/electron/remote --coverage.enabled=false`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/remoteBridge/protocol.ts src/main/remoteBridge/outputChunker.ts tests/electron/remoteOutputChunker.test.ts tests/electron/remoteRelayClient.test.ts
git commit -m "fix(remote): one output shape on the wire, exhaustively typed"
```

---

### Task 2: A safety number worth comparing

`deriveVerificationPhrase` picks 6 words from a 32-word list — 2^30, and the phrase is `sha256` over the sorted public keys with `desktopPublicKey` static and printed in every QR that machine ever shows. An attacker grinds candidate device keypairs offline until the phrase matches: measured at 3.6e-4 s per trial in pure JS, that is ~54 expected single-core hours, minutes on a few cores with a native X25519. The user compares six words, they match, and the hijack is *confirmed* by the check that exists to catch it.

256 words at one digest byte each is 8 bits per word with no modulo bias (256 divides 256 exactly), and 8 words is 64 bits.

**Files:**
- Create: `src/main/remoteBridge/wordlist.ts`
- Modify: `src/main/remoteBridge/sealedChannel.ts:104-121`
- Test: `tests/electron/remoteWordlist.test.ts`, `tests/electron/remoteSealedChannel.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SAFETY_WORDS: readonly string[]` (length 256), `PHRASE_WORDS = 8`, `deriveVerificationPhrase(a: string, b: string): string` (unchanged signature, new output).

- [ ] **Step 1: Write the failing invariant test**

`tests/electron/remoteWordlist.test.ts`:

```ts
import { SAFETY_WORDS } from '../../src/main/remoteBridge/wordlist'

describe('safety wordlist', () => {
  // 256 is not a round number chosen for looks. One digest byte indexes it with no
  // modulo, so every word is exactly 8 bits and the derivation is unbiased for free.
  // 255 words would silently reintroduce bias; 257 would throw on a valid digest.
  it('is exactly 256 words', () => {
    expect(SAFETY_WORDS).toHaveLength(256)
  })

  it('has no duplicates', () => {
    // A duplicate is the failure mode that costs entropy silently: the list still
    // has 256 entries, the code still works, and two byte values collide forever.
    expect(new Set(SAFETY_WORDS).size).toBe(256)
  })

  it('is lowercase ascii, three to eight letters', () => {
    for (const w of SAFETY_WORDS) expect(w).toMatch(/^[a-z]{3,8}$/)
  })

  it('has a unique three-letter prefix per word', () => {
    // Read aloud over a bad phone line, "cactus" and "cactoid" are one word. Unique
    // prefixes are what make a mishearing a mismatch instead of a false confirm.
    const prefixes = SAFETY_WORDS.map((w) => w.slice(0, 3))
    expect(new Set(prefixes).size).toBe(256)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/electron/remoteWordlist.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Author the list**

Create `src/main/remoteBridge/wordlist.ts` with a header comment stating the four invariants above and 256 common English nouns/adjectives satisfying them, sorted alphabetically (sorted so a human can audit it; the *derivation* does not depend on order, but the phone must ship the identical array — Task 2 Step 6 pins that with a golden vector). Start from concrete, picturable words — `anchor, apple, arrow, atlas, …` — and avoid: homophones (`flour`/`flower`), plurals of other entries, and anything that reads as an instruction.

- [ ] **Step 4: Run the invariant test until green**

Run: `npx vitest run tests/electron/remoteWordlist.test.ts`
Expected: PASS. Fix duplicates and prefix collisions the test names until it is clean.

- [ ] **Step 5: Rewrite the derivation**

In `sealedChannel.ts`, delete the 32-word `WORDS` array and replace:

```ts
import { SAFETY_WORDS } from './wordlist'

/** Words in a safety number. Eight words over a 256-word list is 64 bits.
 *
 *  The number that matters is the GRINDING cost, not the reading cost. The desktop
 *  public key is static and appears in every QR that machine ever shows, so an
 *  attacker can search offline, for days, from a photograph taken months ago: the
 *  90-second offer TTL constrains none of it. At 30 bits that search finished in
 *  under an hour and the user's comparison confirmed the attacker instead of
 *  catching them. At 64 bits it does not finish. */
export const PHRASE_WORDS = 8

export function deriveVerificationPhrase(aPublicKey: string, bPublicKey: string): string {
  const [lo, hi] = [aPublicKey, bPublicKey].sort()
  const digest = sha256(new TextEncoder().encode(`${lo}:${hi}`))
  // One byte per word, no modulo: SAFETY_WORDS has exactly 256 entries, so every
  // byte value maps to a distinct word and the mapping is uniform by construction.
  return Array.from({ length: PHRASE_WORDS }, (_, i) => SAFETY_WORDS[digest[i]]).join(' ')
}
```

- [ ] **Step 6: Pin a golden vector**

Generate it once from fixed keys, then paste the literal into the test — a golden vector the phone will mirror. Run:

```bash
node --input-type=module -e "
import { deriveVerificationPhrase } from './src/main/remoteBridge/sealedChannel.ts'
const a = '00'.repeat(31) + '01'
const b = '00'.repeat(31) + '02'
console.log(JSON.stringify(deriveVerificationPhrase(a, b)))
"
```

Add to `tests/electron/remoteSealedChannel.test.ts`:

```ts
it('matches the cross-implementation golden vector', () => {
  // The one test that catches a phone shipping a different wordlist or a different
  // index scheme. Without it the two ends produce six plausible words that never
  // match, the user is told the phrase is the MITM defence, and they conclude the
  // scan went wrong and re-pair -- training away the only check that matters.
  // Mirror this exact pair and expectation in the phone's conformance suite.
  const a = '00'.repeat(31) + '01'
  const b = '00'.repeat(31) + '02'
  expect(deriveVerificationPhrase(a, b)).toBe(/* paste the literal from the command above */)
  expect(deriveVerificationPhrase(b, a)).toBe(deriveVerificationPhrase(a, b))
})

it('yields eight words', () => {
  expect(deriveVerificationPhrase('aa', 'bb').split(' ')).toHaveLength(8)
})
```

- [ ] **Step 7: Run and commit**

Run: `npx vitest run tests/electron/remoteWordlist.test.ts tests/electron/remoteSealedChannel.test.ts`
Expected: PASS.

```bash
git add src/main/remoteBridge/wordlist.ts src/main/remoteBridge/sealedChannel.ts tests/electron/remoteWordlist.test.ts tests/electron/remoteSealedChannel.test.ts
git commit -m "fix(remote): 64-bit safety numbers with a pinned golden vector"
```

---

### Task 3: `SealedDirection` — one key, one direction, header authenticated

The codec change. `SealedChannel` currently derives one key by static ECDH and uses it to seal *and* open, with a random 12-byte nonce and the counter inside the ciphertext. Split it: a `SealedDirection` holds one raw key and one counter, and the frame header is associated data so a flipped type byte fails authentication instead of being reinterpreted.

**Files:**
- Modify: `src/main/remoteBridge/sealedChannel.ts:11-101`
- Modify: `src/main/remoteBridge/outputChunker.ts` (`SEAL_OVERHEAD_BYTES` 34 → 22)
- Test: `tests/electron/remoteSealedChannel.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const SEAL_OVERHEAD_BYTES = 22 // counter(6) + Poly1305 tag(16)
  export class SealedDirection {
    constructor(key: Uint8Array)
    seal(header: Uint8Array, plaintext: Uint8Array): Uint8Array  // header || counter || ct
    open(frame: Uint8Array, headerBytes: number): Uint8Array      // throws on tamper/replay
    get sentFrames(): number
  }
  ```
- Consumed by: Task 4's `SealedSession`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/electron/remoteSealedChannel.test.ts`:

```ts
import { SealedDirection, SEAL_OVERHEAD_BYTES } from '../../src/main/remoteBridge/sealedChannel'

const key = () => new Uint8Array(32).fill(7)
const H = new Uint8Array([0x04])
const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

describe('SealedDirection', () => {
  it('round-trips through a matching direction', () => {
    const tx = new SealedDirection(key())
    const rx = new SealedDirection(key())
    expect(text(rx.open(tx.seal(H, bytes('hello')), 1))).toBe('hello')
  })

  it('costs exactly SEAL_OVERHEAD_BYTES beyond the header and plaintext', () => {
    // The chunker budgets against this number. If it drifts, output frames cross the
    // relay's 1 MiB ceiling and the relay CUTS the connection rather than truncating,
    // which reads to a user as an unreliable network.
    const frame = new SealedDirection(key()).seal(H, bytes('x'.repeat(100)))
    expect(frame.length).toBe(H.length + 100 + SEAL_OVERHEAD_BYTES)
  })

  it('rejects a frame whose header was altered', () => {
    // The header is outside the ciphertext, so it is only safe if it is authenticated.
    // Flipping 0x04 to 0x03 must fail, not be reinterpreted as a handshake.
    const frame = new SealedDirection(key()).seal(H, bytes('hello'))
    frame[0] = 0x03
    expect(() => new SealedDirection(key()).open(frame, 1)).toThrow()
  })

  it('rejects a replayed frame', () => {
    const tx = new SealedDirection(key())
    const rx = new SealedDirection(key())
    const frame = tx.seal(H, bytes('once'))
    rx.open(frame)
    expect(() => rx.open(frame, 1)).toThrow(/replay/)
  })

  it('derives the nonce from the counter, so two seals of the same plaintext differ', () => {
    // A fixed nonce would be catastrophic and a random one wastes 12 bytes a frame.
    // The counter is unique per key because a key is used in ONE direction only.
    const tx = new SealedDirection(key())
    expect(tx.seal(H, bytes('same'))).not.toEqual(tx.seal(H, bytes('same')))
  })

  it('rejects a frame too short to hold a counter', () => {
    expect(() => new SealedDirection(key()).open(new Uint8Array([1, 2, 3]), 1)).toThrow(/short/)
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/electron/remoteSealedChannel.test.ts`
Expected: FAIL — `SealedDirection` is not exported.

- [ ] **Step 3: Implement**

Replace the `SealedChannel` class in `sealedChannel.ts`:

```ts
/** Seal overhead: the 6-byte counter plus the Poly1305 tag. The nonce is DERIVED
 *  from the counter rather than carried, which is where the old format's 12 bytes
 *  a frame went. */
export const SEAL_OVERHEAD_BYTES = COUNTER_BYTES + 16

/** One direction of a sealed conversation: one key, one monotonic counter.
 *
 *  Directional by construction, not by convention. A single key used both ways lets
 *  an untrusted relay echo a peer's own frame back at it: the frame authenticates,
 *  the high-water mark jumps to that peer's own send counter -- which for a desktop
 *  streaming terminal output runs far ahead of anything the phone has sent -- and
 *  every genuine frame afterwards is rejected as a replay. Output keeps arriving,
 *  keystrokes silently stop, and reconnecting never fixes it. Two keys make the
 *  echo fail to open at all. */
export class SealedDirection {
  private frames = 0
  private peerHighWater = -1

  constructor(private readonly key: Uint8Array) {}

  get sentFrames(): number {
    return this.frames
  }

  /** `header || counter || AEAD(plaintext)`, with the header as associated data.
   *
   *  The header carries the frame type and, for the two handshake frames, a public
   *  key. Both sit outside the ciphertext because the receiver must read them to
   *  know which key to try. Feeding them to the AEAD is what stops that from being
   *  a hole: a substituted public key or a flipped type byte fails Poly1305. */
  seal(header: Uint8Array, plaintext: Uint8Array): Uint8Array {
    const counter = this.frames++
    const out = new Uint8Array(header.length + COUNTER_BYTES + plaintext.length + 16)
    out.set(header, 0)
    writeCounter(out.subarray(header.length), counter)
    const ct = chacha20poly1305(this.key, nonceFor(counter), header).encrypt(plaintext)
    out.set(ct, header.length + COUNTER_BYTES)
    return out
  }

  /** Throws if the frame was tampered with, sealed by the wrong direction, or replayed. */
  open(frame: Uint8Array, headerBytes: number): Uint8Array {
    if (frame.length < headerBytes + COUNTER_BYTES + 16) throw new Error('frame too short')
    const header = frame.subarray(0, headerBytes)
    const counter = readCounter(frame.subarray(headerBytes))
    // Counter check BEFORE decryption so a flood of replays costs a comparison
    // rather than a Poly1305 verification each.
    if (counter <= this.peerHighWater) {
      throw new Error(`replayed sealed frame (counter ${counter} <= ${this.peerHighWater})`)
    }
    const plaintext = chacha20poly1305(this.key, nonceFor(counter), header).decrypt(
      frame.subarray(headerBytes + COUNTER_BYTES),
    )
    // Only advance once the frame is proven authentic. Advancing first would let an
    // attacker walk the high-water mark forward with garbage and deafen the peer.
    this.peerHighWater = counter
    return plaintext
  }
}

/** Twelve bytes: six zero, then the counter. Unique per key because a key seals in
 *  exactly one direction, so this is a structural guarantee rather than a
 *  probabilistic one -- there is no birthday bound to reason about. */
function nonceFor(counter: number): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES)
  writeCounter(nonce.subarray(NONCE_BYTES - COUNTER_BYTES), counter)
  return nonce
}
```

Delete the `randomBytes` import if it becomes unused. Update `outputChunker.ts` to import the new `SEAL_OVERHEAD_BYTES` (the value is imported, not restated, so `MAX_PAYLOAD_BYTES` follows automatically).

- [ ] **Step 4: Run and fix the fallout**

Run: `npx vitest run tests/electron/remote --coverage.enabled=false`
Expected: FAIL in `remoteBridgeEntry`, `remoteRelayClient`, `remoteEndToEnd` — they construct `SealedChannel`. Leave them failing; Task 4 introduces the replacement they need. Confirm `remoteSealedChannel` and `remoteOutputChunker` are green.

- [ ] **Step 5: Verify the overhead pin still measures**

`tests/electron/remoteOutputChunker.test.ts` pins `SEAL_OVERHEAD_BYTES` by sealing a real frame. Update it to the `SealedDirection` API and confirm it measures 22, rather than hard-coding it.

- [ ] **Step 6: Commit (with the entry tests still red)**

Do not commit a red suite. Fold Steps 4–6 into Task 4 and commit once, at Task 4 Step 6.

---

### Task 4: `SealedSession` and the per-connection handshake

The blocker. Give every connection its own key.

**Files:**
- Create: `src/main/remoteBridge/sessionCrypto.ts`
- Create: `tests/electron/remoteSessionCrypto.test.ts`
- Modify: `src/main/remoteBridge/relayClient.ts`, `src/main/remoteBridge/entry.ts`
- Modify: `tests/electron/remoteRelayClient.test.ts`, `tests/electron/remoteBridgeEntry.test.ts`, `tests/electron/remoteEndToEnd.test.ts`

**Interfaces:**
- Consumes: `SealedDirection`, `SEAL_OVERHEAD_BYTES` (Task 3).
- Produces:
  ```ts
  export type Role = 'desktop' | 'device'
  export const FRAME_PAIRING_HELLO = 0x01
  export const FRAME_PAIRING_ACK   = 0x02
  export const FRAME_SESSION_HELLO = 0x03
  export const FRAME_SESSION       = 0x04

  export class SealedSession {
    static fromRoot(root: Uint8Array, role: Role): SealedSession
    seal(header: Uint8Array, plaintext: Uint8Array): Uint8Array
    open(frame: Uint8Array, headerBytes: number): Uint8Array
  }

  /** One end of a session handshake. Construct, send `greeting`, feed the peer's
   *  greeting to `accept`, use the returned session. */
  export class Handshake {
    constructor(opts: { ownSecretKey: string; peerPublicKey: string; role: Role
                        ephemeralSecretKey?: string /* tests only */ })
    readonly greeting: Uint8Array
    accept(peerGreeting: Uint8Array): SealedSession
  }

  export function deriveSessionRoomId(ownSecretKey: string, peerPublicKey: string): string
  ```

- [ ] **Step 1: Write the failing tests**

`tests/electron/remoteSessionCrypto.test.ts`:

```ts
import { generateIdentity } from '../../src/main/remoteBridge/sealedChannel'
import {
  Handshake, SealedSession, deriveSessionRoomId, FRAME_SESSION,
} from '../../src/main/remoteBridge/sessionCrypto'

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)
const H = new Uint8Array([FRAME_SESSION])

function handshake() {
  const desktop = generateIdentity()
  const device = generateIdentity()
  const d = new Handshake({ ownSecretKey: desktop.secretKey, peerPublicKey: device.publicKey, role: 'desktop' })
  const p = new Handshake({ ownSecretKey: device.secretKey, peerPublicKey: desktop.publicKey, role: 'device' })
  return { desktop, device, d, p, ds: d.accept(p.greeting), ps: p.accept(d.greeting) }
}

describe('Handshake', () => {
  it('agrees on a session both ends can use', () => {
    const { ds, ps } = handshake()
    expect(text(ps.open(ds.seal(H, bytes('down')), 1))).toBe('down')
    expect(text(ds.open(ps.seal(H, bytes('up')), 1))).toBe('up')
  })

  it('gives every connection a different key', () => {
    // THE fix. The old channel was static-static: one key for the life of a pairing,
    // with counters that reset to zero on every bridge restart. A relay that recorded
    // a session replayed it verbatim after any restart and the commands re-executed --
    // and the supervisor tolerates three crashes a minute, so the window was
    // attacker-triggerable, not incidental.
    const a = handshake()
    const b = handshake()
    const frame = a.ds.seal(H, bytes('replay me'))
    expect(() => b.ps.open(frame, 1)).toThrow()
  })

  it('refuses a greeting from a third party', () => {
    // The static DH term is the authentication. Someone who does not hold one of the
    // two identity private keys cannot produce an openable greeting.
    const { desktop, device } = handshake()
    const impostor = generateIdentity()
    const d = new Handshake({ ownSecretKey: desktop.secretKey, peerPublicKey: device.publicKey, role: 'desktop' })
    const x = new Handshake({ ownSecretKey: impostor.secretKey, peerPublicKey: desktop.publicKey, role: 'device' })
    expect(() => d.accept(x.greeting)).toThrow()
  })

  it('refuses a greeting whose ephemeral key was substituted', () => {
    const { desktop, device } = handshake()
    const d = new Handshake({ ownSecretKey: desktop.secretKey, peerPublicKey: device.publicKey, role: 'desktop' })
    const p = new Handshake({ ownSecretKey: device.secretKey, peerPublicKey: desktop.publicKey, role: 'device' })
    const forged = Uint8Array.from(p.greeting)
    forged[1] ^= 0xff // first byte of the ephemeral public key, inside the AAD
    expect(() => d.accept(forged)).toThrow()
  })

  it('separates the two directions', () => {
    // A relay that echoes a peer's frame back at it must fail to open, not wedge the
    // counter. Sealing and opening on the SAME end is exactly that echo.
    const { ds } = handshake()
    const own = ds.seal(H, bytes('mine'))
    expect(() => ds.open(own, 1)).toThrow()
  })
})

describe('deriveSessionRoomId', () => {
  it('is the same on both ends and hides from everyone else', () => {
    const desktop = generateIdentity()
    const device = generateIdentity()
    const mine = deriveSessionRoomId(desktop.secretKey, device.publicKey)
    const theirs = deriveSessionRoomId(device.secretKey, desktop.publicKey)
    expect(mine).toBe(theirs)
    expect(mine).toMatch(/^[0-9a-f]{32}$/)
  })

  it('differs per pairing', () => {
    // The QR's pairingId is a room NAME, and a name is not a credential: anyone who
    // photographed a QR could squat that room forever and answer the real phone with
    // a 409, with no TTL touching it because the exposure was never the secret. A
    // room only the two parties can compute has no such photograph.
    const desktop = generateIdentity()
    expect(deriveSessionRoomId(desktop.secretKey, generateIdentity().publicKey))
      .not.toBe(deriveSessionRoomId(desktop.secretKey, generateIdentity().publicKey))
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/electron/remoteSessionCrypto.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `sessionCrypto.ts`**

```ts
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { SealedDirection } from './sealedChannel'

export type Role = 'desktop' | 'device'

export const FRAME_PAIRING_HELLO = 0x01
export const FRAME_PAIRING_ACK = 0x02
export const FRAME_SESSION_HELLO = 0x03
export const FRAME_SESSION = 0x04

const KEY_BYTES = 32
const PUBLIC_KEY_BYTES = 32

const label = (s: string) => new TextEncoder().encode(s)
const D2P = label('termpolis-d2p-v2')
const P2D = label('termpolis-p2d-v2')

const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'))
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex')

/** Two directional keys from one root. Which one seals is decided by role, so both
 *  ends derive the same pair and use them in opposite directions. */
export class SealedSession {
  private constructor(
    private readonly tx: SealedDirection,
    private readonly rx: SealedDirection,
  ) {}

  static fromRoot(root: Uint8Array, role: Role): SealedSession {
    const d2p = new SealedDirection(hkdf(sha256, root, undefined, D2P, KEY_BYTES))
    const p2d = new SealedDirection(hkdf(sha256, root, undefined, P2D, KEY_BYTES))
    return role === 'desktop' ? new SealedSession(d2p, p2d) : new SealedSession(p2d, d2p)
  }

  seal(header: Uint8Array, plaintext: Uint8Array): Uint8Array {
    return this.tx.seal(header, plaintext)
  }

  open(frame: Uint8Array, headerBytes: number): Uint8Array {
    return this.rx.open(frame, headerBytes)
  }
}

/** The room a paired desktop and phone meet in, derived rather than announced.
 *
 *  Sixteen bytes of HKDF over the static shared secret. Both ends compute it from
 *  what they already hold, so it never crosses the wire and never appears in a QR --
 *  which is the point: the pairing room's name is public the moment someone
 *  photographs the code, and a name is enough to squat a room. */
export function deriveSessionRoomId(ownSecretKey: string, peerPublicKey: string): string {
  const shared = x25519.getSharedSecret(fromHex(ownSecretKey), fromHex(peerPublicKey))
  return toHex(hkdf(sha256, shared, undefined, label('termpolis-session-room-v2'), 16))
}

/** The root for the two PAIRING frames, before either end knows a session.
 *
 *  Salted with the pairing id so a hello is valid in the room it was sealed for and
 *  nowhere else. */
export function pairingRoot(ownSecretKey: string, peerPublicKey: string, pairingId: string): Uint8Array {
  const shared = x25519.getSharedSecret(fromHex(ownSecretKey), fromHex(peerPublicKey))
  return hkdf(sha256, shared, label(pairingId), label('termpolis-pair-v2'), KEY_BYTES)
}

/** One end of a session handshake.
 *
 *  Ephemeral-static: the ephemeral term gives forward secrecy (spec §4.2 promises it
 *  and the static-static channel never delivered it), the static term authenticates.
 *  Both are in the IKM, so an attacker needs the ephemeral private key AND an
 *  identity private key -- one is not enough. */
export class Handshake {
  readonly greeting: Uint8Array
  private readonly ephemeralSecret: Uint8Array
  private readonly ephemeralPublic: Uint8Array

  constructor(
    private readonly opts: {
      ownSecretKey: string
      peerPublicKey: string
      role: Role
      /** Injected in tests so a handshake is reproducible. Production omits it. */
      ephemeralSecretKey?: string
    },
  ) {
    this.ephemeralSecret = opts.ephemeralSecretKey
      ? fromHex(opts.ephemeralSecretKey)
      : x25519.utils.randomSecretKey()
    this.ephemeralPublic = x25519.getPublicKey(this.ephemeralSecret)

    // The greeting is sealed under a key only the two identity holders can derive,
    // so accepting one is already proof of identity. The ephemeral public key rides
    // in the header, and the header is the AEAD's associated data -- substituting it
    // fails Poly1305 rather than silently redirecting the session.
    const hs = SealedSession.fromRoot(
      hkdf(
        sha256,
        x25519.getSharedSecret(fromHex(opts.ownSecretKey), fromHex(opts.peerPublicKey)),
        undefined,
        label('termpolis-handshake-v2'),
        KEY_BYTES,
      ),
      opts.role,
    )
    const header = new Uint8Array(1 + PUBLIC_KEY_BYTES)
    header[0] = FRAME_SESSION_HELLO
    header.set(this.ephemeralPublic, 1)
    this.greeting = hs.seal(header, new TextEncoder().encode(JSON.stringify({ v: 2, role: opts.role })))
  }

  accept(peerGreeting: Uint8Array): SealedSession {
    if (peerGreeting.length < 1 + PUBLIC_KEY_BYTES) throw new Error('greeting too short')
    if (peerGreeting[0] !== FRAME_SESSION_HELLO) throw new Error('not a session greeting')
    const peerEphemeral = peerGreeting.subarray(1, 1 + PUBLIC_KEY_BYTES)

    const peerRole: Role = this.opts.role === 'desktop' ? 'device' : 'desktop'
    const hs = SealedSession.fromRoot(
      hkdf(
        sha256,
        x25519.getSharedSecret(fromHex(this.opts.ownSecretKey), fromHex(this.opts.peerPublicKey)),
        undefined,
        label('termpolis-handshake-v2'),
        KEY_BYTES,
      ),
      this.opts.role,
    )
    // Throws unless the peer holds an identity private key for this pairing. This is
    // the authentication step; everything after it is key agreement.
    hs.open(peerGreeting, 1 + PUBLIC_KEY_BYTES)

    const ikm = new Uint8Array(KEY_BYTES * 2)
    ikm.set(x25519.getSharedSecret(this.ephemeralSecret, peerEphemeral), 0)
    ikm.set(
      x25519.getSharedSecret(fromHex(this.opts.ownSecretKey), fromHex(this.opts.peerPublicKey)),
      KEY_BYTES,
    )

    // Sorted, so both ends compute the same salt without needing to agree on who
    // spoke first -- which they cannot, since both greetings are in flight at once.
    const [lo, hi] = [toHex(this.ephemeralPublic), toHex(peerEphemeral)].sort()
    const salt = sha256(label(`${lo}${hi}`))

    return SealedSession.fromRoot(
      hkdf(sha256, ikm, salt, label('termpolis-session-v2'), KEY_BYTES),
      this.opts.role,
    )
  }
}
```

- [ ] **Step 4: Run the crypto tests**

Run: `npx vitest run tests/electron/remoteSessionCrypto.test.ts`
Expected: PASS, all seven.

- [ ] **Step 5: Wire it into `RelayClient`**

`RelayClientDeps.channel: SealedChannel` becomes `handshake(): Handshake` — a factory, because a fresh handshake is needed per dial. `RelayClient` gains a `session: SealedSession | null`, sends `greeting` on `open`, and treats the first binary frame as the peer's greeting:

```ts
sock.on('open', (() => {
  this.attempt = 0
  // The session is not ready yet -- state stays `connecting` until the peer's
  // greeting lands. Reporting `online` on a raw socket would have the fan-out
  // drain into a channel that cannot seal, and draining is destructive.
  this.pending = this.deps.handshake()
  this.session = null
  sock.send(this.pending.greeting)
}) as never)
```

and in the message handler:

```ts
if (!this.session) {
  try {
    this.session = this.pending!.accept(frame)
  } catch {
    // A greeting that will not open is an impostor or a corrupted frame. Drop the
    // connection rather than sit in a half-open state the user cannot see.
    this.socket?.close()
    return
  }
  this.setState('online')
  return
}
```

`send` and `handleFrame` use `this.session`, with `FRAME_SESSION` as a one-byte header and `headerBytes = 1`.

- [ ] **Step 6: Update `entry.ts`, fix every red test, commit**

In `openRoom`, replace `channel: new SealedChannel(identitySecretKey, dev.publicKey)` with
`handshake: () => new Handshake({ ownSecretKey: identitySecretKey, peerPublicKey: dev.publicKey, role: 'desktop' })`,
and `pairingId: dev.pairingId` with `roomId: dev.sessionRoomId`. Update the comment at `entry.ts:92-94` — the replay counter is no longer what makes the channel long-lived; say instead that a fresh handshake per dial is what makes per-connection counters sound.

Update `scripts/remote-test-client.cjs` to run the same handshake.

Run: `npx vitest run tests/electron/remote --coverage.enabled=false`
Expected: PASS.

```bash
git add src/main/remoteBridge tests/electron/remote*.test.ts scripts/remote-test-client.cjs
git commit -m "feat(remote): per-connection sealed sessions with forward secrecy

Ephemeral-static handshake per dial, HKDF-split directional keys, and a
counter-derived nonce. Closes replay-after-restart, the reflected-frame counter
wedge, and the silent deafening of a phone that correctly persists its
high-water mark."
```

---

### Task 5: Read the relay's control frames

`relayClient.ts:75` is `if (!isBinary) return` — every control frame the relay authors is discarded. The relay sends `hello`, `peer-joined`, `peer-gone` and `quota-exceeded` (`relay/src/wire.ts:22-26`), and `pairingRoom.ts:150-154` explains that naming the limit exists precisely so a client does not "reconnect in a loop and turn its own bug into a denial of service against the relay". The desktop drops that diagnosis on the floor. Task 7's pairing UI needs `peer-joined` anyway.

**Files:**
- Modify: `src/main/remoteBridge/relayClient.ts:72-90`
- Modify: `src/main/remoteBridge/protocol.ts` (add `'attached'` to `RelayState`)
- Test: `tests/electron/remoteRelayClient.test.ts`

**Interfaces:**
- Produces: `RelayState = 'connecting' | 'online' | 'attached' | 'offline'` and `RelayClientDeps.onQuota?(limit: QuotaLimit): void`.
  `online` = this end is seated in the room. `attached` = the peer is seated too.

- [ ] **Step 1: Write the failing tests**

```ts
it('reports attached when the peer joins', async () => {
  const { client, sock, states } = connected()
  sock.emit('message', Buffer.from(JSON.stringify({ kind: 'peer-joined', role: 'device' })), false)
  expect(states).toContain('attached')
})

it('drops back to online when the peer leaves', async () => {
  const { client, sock, states } = connected()
  sock.emit('message', Buffer.from(JSON.stringify({ kind: 'peer-joined', role: 'device' })), false)
  sock.emit('message', Buffer.from(JSON.stringify({ kind: 'peer-gone', role: 'device' })), false)
  // Not `offline`: this desktop is still seated and still reachable. Conflating the
  // two would show the user "disconnected" for their own machine when it was the
  // phone that walked away.
  expect(states.at(-1)).toBe('online')
})

it('stops retrying after a quota cut', async () => {
  // The one case where reconnecting is the wrong answer: the relay is telling us we
  // are the problem. An undifferentiated retry here is how a client bug becomes an
  // outage for everyone else on the relay.
  const { client, sock, onQuota } = connected()
  sock.emit('message', Buffer.from(JSON.stringify({ kind: 'quota-exceeded', limit: 'frame-rate' })), false)
  sock.emit('close')
  vi.advanceTimersByTime(120_000)
  expect(onQuota).toHaveBeenCalledWith('frame-rate')
  expect(client.state).toBe('offline')
})

it('ignores text that is not a control frame', async () => {
  const { sock } = connected()
  expect(() => sock.emit('message', Buffer.from('not json'), false)).not.toThrow()
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/electron/remoteRelayClient.test.ts`
Expected: FAIL — states never include `attached`.

- [ ] **Step 3: Implement**

Replace the `if (!isBinary) return` early exit with a branch that parses text as a control frame, tolerating anything unrecognised, and set a `quotaCut` flag that `retry()` honours by refusing to schedule.

- [ ] **Step 4: Run, then commit**

Run: `npx vitest run tests/electron/remote --coverage.enabled=false`

```bash
git add src/main/remoteBridge/relayClient.ts src/main/remoteBridge/protocol.ts tests/electron/remoteRelayClient.test.ts
git commit -m "feat(remote): act on the relay's control frames instead of dropping them"
```

---

### Task 6: Keepalive, so a waiting desktop is not cut every five minutes

`IDLE_TIMEOUT_MS` is 300 s and the alarm cuts any peer whose `lastSeen` is older (`relay/src/pairingRoom.ts:119-128`). A desktop holding a room open for a phone that has not arrived sends nothing, so it is cut with `close(1000, 'idle')`, `attempt` has already been reset to 0 by the successful open, and it re-dials a second later — forever. That is one Durable Object instantiation and one registration-limiter token per paired device per ~301 s, and, worse, a window every five minutes in which the phone finds an empty room. Only a binary frame refreshes `lastSeen`; text is dropped above the update at line 80.

**Files:**
- Modify: `src/main/remoteBridge/relayClient.ts`
- Modify: `src/main/remoteBridge/entry.ts` (ignore `ping` in the request path)
- Test: `tests/electron/remoteRelayClient.test.ts`

**Interfaces:**
- Produces: `KEEPALIVE_MS = 120_000`, and a sealed `{ kind: 'ping' }` payload on the session channel.

- [ ] **Step 1: Write the failing test**

```ts
it('sends a sealed keepalive well inside the relay idle window', () => {
  // The relay cuts at 300s and only BINARY refreshes lastSeen, so the keepalive has
  // to be a sealed frame like any other -- a text ping is dropped unread and would
  // not hold the room. 120s leaves room for one lost frame.
  const { sock } = connected()
  const before = sock.sent.length
  vi.advanceTimersByTime(120_000)
  expect(sock.sent.length).toBe(before + 1)
})

it('stops pinging once stopped', () => {
  const { client, sock } = connected()
  client.stop()
  const before = sock.sent.length
  vi.advanceTimersByTime(600_000)
  expect(sock.sent.length).toBe(before)
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/electron/remoteRelayClient.test.ts -t keepalive`
Expected: FAIL — nothing is sent.

- [ ] **Step 3: Implement**

Start the interval when the session is established, clear it in `down` and in `stop`.

- [ ] **Step 4: Teach the request path to ignore a ping**

A `ping` reaching `handleRemoteRequest` would be answered `unknown request`, which is noise, not an error. Drop it in `handleFrame` before dispatch.

- [ ] **Step 5: Run and commit**

```bash
git add src/main/remoteBridge/relayClient.ts src/main/remoteBridge/entry.ts tests/electron/remoteRelayClient.test.ts
git commit -m "feat(remote): keepalive so a waiting desktop holds its room"
```

---

### Task 7: The session room, derived rather than announced

`PairedDevice.pairingId` is the QR's pairing id, persisted and reused forever (`protocol.ts:31-35`). So the room printed in a QR is the *session* room's address for the life of the pairing, and anyone who photographed that QR — secret long expired — can connect as `role=device`, hold the slot, and the real phone gets a 409 with `RelayClient` retrying forever without telling anyone why. The exposure is the room name, which no TTL and no single-use flag touches.

**Files:**
- Modify: `src/main/remoteBridge/protocol.ts:31-35`
- Modify: `src/main/remoteBridge/pairing.ts:70-78`
- Modify: `src/main/remoteBridge/entry.ts:78-101`
- Test: `tests/electron/remotePairing.test.ts`, `tests/electron/remoteBridgeEntry.test.ts`

**Interfaces:**
- Consumes: `deriveSessionRoomId` (Task 4).
- Produces: `PairedDevice.sessionRoomId: string` replacing `pairingId`.

- [ ] **Step 1: Write the failing test**

```ts
it('gives the device a session room that never appeared in the QR', () => {
  const offer = createPairingOffer({ relayUrl: 'wss://r', desktopPublicKey: desktop.publicKey })
  const { device } = new PairingSession(offer, desktop.publicKey, desktop.secretKey).accept({
    oneTimeSecret: offer.oneTimeSecret,
    devicePublicKey: phone.publicKey,
    label: 'phone',
  })
  expect(device.sessionRoomId).not.toBe(offer.pairingId)
  expect(offer.qrPayload).not.toContain(device.sessionRoomId)
  // The phone derives the same id from what it already holds, so it is never sent.
  expect(device.sessionRoomId).toBe(deriveSessionRoomId(phone.secretKey, desktop.publicKey))
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/electron/remotePairing.test.ts`
Expected: FAIL — `sessionRoomId` is undefined.

- [ ] **Step 3: Implement**

`PairingSession` takes the desktop's *secret* key as well (it needs it for the DH) and sets `sessionRoomId: deriveSessionRoomId(desktopSecretKey, input.devicePublicKey)`. Rename the field in `protocol.ts` with a comment saying why it is derived and not announced. `entry.ts` passes `identitySecretKey` when constructing the session, and `openRoom` keys on `dev.sessionRoomId`.

- [ ] **Step 4: Update the room-identity test in `remoteBridgeEntry.test.ts`**

The existing "re-pairs into the new room" test asserted on `pairingId`. It still holds — a device that re-pairs with a *new* keypair gets a new session room — but the field name changes. A device that re-pairs with the *same* keypair now keeps its room, which is the intended behaviour and worth its own test.

- [ ] **Step 5: Run and commit**

```bash
git add src/main/remoteBridge tests/electron/remote*.test.ts
git commit -m "fix(remote): derive the session room so a stale QR cannot squat it"
```

---

### Task 8: Pairing over the relay

The last hole. `acceptPairing` is documented as "sub-project 2's transport calls this" and no transport does; `beginPairing` mints a QR and opens no socket, so a phone that scans it arrives in an empty room. Give pairing its own connection in its own room, and hand off to the session room on success — which also dissolves the 409 problem, because the pairing room and the session room are different rooms.

**Files:**
- Modify: `src/main/remoteBridge/entry.ts:157-176, 240-260`
- Modify: `src/main/remoteBridge/pairing.ts`
- Modify: `scripts/remote-test-client.cjs`
- Test: `tests/electron/remotePairingTransport.test.ts` (new), `tests/electron/remoteEndToEnd.test.ts`

**Interfaces:**
- Consumes: `pairingRoot`, `SealedSession`, `FRAME_PAIRING_HELLO`, `FRAME_PAIRING_ACK` (Task 4).
- Produces:
  ```ts
  export function sealPairingHello(opts: {
    deviceSecretKey: string; devicePublicKey: string; desktopPublicKey: string
    pairingId: string; label: string; oneTimeSecret: string
  }): Uint8Array

  export function openPairingHello(opts: {
    desktopSecretKey: string; pairingId: string; frame: Uint8Array
  }): { devicePublicKey: string; label: string; oneTimeSecret: string }
  ```

- [ ] **Step 1: Write the failing transport test**

`tests/electron/remotePairingTransport.test.ts`:

```ts
describe('pairing hello', () => {
  it('round-trips the device key, label and secret', () => {
    const hello = sealPairingHello({ ...phoneSide, pairingId: offer.pairingId, label: 'Pixel', oneTimeSecret: offer.oneTimeSecret })
    const opened = openPairingHello({ desktopSecretKey: desktop.secretKey, pairingId: offer.pairingId, frame: hello })
    expect(opened).toEqual({ devicePublicKey: phone.publicKey, label: 'Pixel', oneTimeSecret: offer.oneTimeSecret })
  })

  it('keeps the one-time secret from the relay', () => {
    // The secret is a bearer token: anyone holding it can pair. It travels sealed to
    // the desktop's QR-published public key, so the relay -- which sees the frame and
    // the clear device key -- cannot read it and therefore cannot pair itself in.
    const hello = sealPairingHello({ ...phoneSide, pairingId: offer.pairingId, label: 'Pixel', oneTimeSecret: offer.oneTimeSecret })
    expect(Buffer.from(hello).toString('hex')).not.toContain(offer.oneTimeSecret)
  })

  it('refuses a hello sealed for a different room', () => {
    // The pairing root is salted with the pairing id, so a hello captured from one
    // offer cannot be resent into another.
    const hello = sealPairingHello({ ...phoneSide, pairingId: offer.pairingId, label: 'Pixel', oneTimeSecret: offer.oneTimeSecret })
    expect(() => openPairingHello({ desktopSecretKey: desktop.secretKey, pairingId: 'other', frame: hello })).toThrow()
  })

  it('refuses a hello whose clear device key was swapped', () => {
    // The device key rides in the clear because the desktop must read it to derive
    // the key. It is in the AAD, so swapping it fails Poly1305 -- a relay cannot put
    // its own key in front of an honest phone's sealed body.
    const hello = sealPairingHello({ ...phoneSide, pairingId: offer.pairingId, label: 'Pixel', oneTimeSecret: offer.oneTimeSecret })
    hello.set(Uint8Array.from(Buffer.from(impostor.publicKey, 'hex')), 1)
    expect(() => openPairingHello({ desktopSecretKey: desktop.secretKey, pairingId: offer.pairingId, frame: hello })).toThrow()
  })
})

describe('pairing over the relay', () => {
  it('dials the pairing room when the offer opens', () => {
    const { c, rooms } = core()
    c.handleHostMessage({ kind: 'beginPairing', label: 'desk' })
    expect(rooms).toHaveLength(1)
    expect(rooms[0].deps.roomId).toBe(JSON.parse(sent('pairingCode').qrPayload).pairingId)
  })

  it('closes the pairing room and opens the session room on accept', () => {
    // Two DIFFERENT rooms, so there is no 409 to design around: the relay refuses a
    // second socket in the same role in the SAME room, and these are not the same
    // room. Reusing the pairing id for the session was what forced a socket swap.
    const { c, rooms } = core()
    c.handleHostMessage({ kind: 'beginPairing', label: 'desk' })
    deliverHello(rooms[0])
    expect(rooms[0].stopped).toBe(true)
    expect(rooms[1].deps.roomId).toBe(deriveSessionRoomId(desktop.secretKey, phone.publicKey))
  })

  it('closes the pairing room when the offer is cancelled', () => {
    const { c, rooms } = core()
    c.handleHostMessage({ kind: 'beginPairing', label: 'desk' })
    c.handleHostMessage({ kind: 'cancelPairing' })
    expect(rooms[0].stopped).toBe(true)
  })

  it('replaces the room when a second offer opens', () => {
    // A user who cancels by pressing the button again must not leave a socket behind
    // holding role=desktop in a room nobody is watching.
    const { c, rooms } = core()
    c.handleHostMessage({ kind: 'beginPairing', label: 'desk' })
    c.handleHostMessage({ kind: 'beginPairing', label: 'desk' })
    expect(rooms[0].stopped).toBe(true)
    expect(rooms[1].stopped).toBe(false)
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/electron/remotePairingTransport.test.ts`
Expected: FAIL — `sealPairingHello` is not exported, and `beginPairing` opens no room.

- [ ] **Step 3: Implement the hello codec in `pairing.ts`**

Header is `0x01 || devicePublicKey[32]`; body is `{ v: 2, label, oneTimeSecret }` sealed on a `SealedSession.fromRoot(pairingRoot(...), 'device')`. `openPairingHello` reads the clear key from the header, rebuilds the root with the desktop's secret, and opens with `role: 'desktop'`.

- [ ] **Step 4: Implement the transport in `entry.ts`**

`beginPairing` closes any open pairing room, then opens one on `offer.pairingId` with a raw-frame callback rather than the session request path. On a `0x01` frame: `openPairingHello`, then `acceptPairing`, then send the `0x02` ack on the same socket, then `closePairingRoom()` and `openRoom(device)` — which dials the *session* room. `cancelPairing` closes it. `shutdown` closes it.

A pairing room needs `RelayClient` to skip the session handshake, since neither end can run one before the device key is known. Add `RelayClientDeps.mode: 'session' | 'pairing'`; in `pairing` mode `onFrame(raw)` is called with the frame as received and `handshake` is not consulted.

- [ ] **Step 5: Update the CLI test client**

`scripts/remote-test-client.cjs` is the executable specification the Expo client mirrors, so it must do exactly what the phone will: dial the pairing room with `binaryType = 'arraybuffer'`, send the `0x01` hello as **binary**, read the `0x02` ack, derive the session room locally, dial it, run the handshake, and print the safety number for comparison against the desktop's.

- [ ] **Step 6: Extend the end-to-end test**

`tests/electron/remoteEndToEnd.test.ts` currently calls `acceptPairing` in-process. Drive it through the frames instead: build a hello, feed it to the pairing room's `onFrame`, assert the ack opens on the phone side, assert the phone's locally derived session room matches the desktop's, and assert the two safety numbers agree.

- [ ] **Step 7: Full suite, coverage, commit**

Run: `npx vitest run tests/electron/remote` then the gate:
`npx vitest run --coverage`
Expected: PASS, with `lines ≥ 97 / functions ≥ 96 / branches ≥ 95 / statements ≥ 96`.

```bash
git add src/main/remoteBridge scripts/remote-test-client.cjs tests/electron
git commit -m "feat(remote): pair over the relay, then hand off to a derived session room"
```

---

### Task 9: Freeze the wire format in a document the phone can be built from

The phone is a second implementation of everything above. Every constant it gets wrong fails silently — a mismatched HKDF info string produces six plausible words, an unset `binaryType` produces frames of `"[object Blob]"`, a text hello vanishes with no error at all. Write the format down once, with vectors.

**Files:**
- Create: `docs/remote-wire-format.md`
- Test: `tests/electron/remoteWireVectors.test.ts`

- [ ] **Step 1: Write the vector test**

Fixed identity keys and a fixed ephemeral key produce a fixed greeting, a fixed session key and a fixed sealed frame. Assert every one against a literal. Generate the literals once, from the implementation, and paste them in — the value is not that they are right today but that they cannot change unnoticed.

- [ ] **Step 2: Write the document**

Contents: the four frame types with byte layouts; the key schedule with exact info strings; the counter/nonce rule; the two 409-avoiding rooms; the four gotchas that cost a day each (binary-only, `binaryType = 'arraybuffer'` on your own socket, header-as-AAD, one direction per key); and the golden vectors from Task 2 and Step 1 above.

- [ ] **Step 3: Commit**

```bash
git add docs/remote-wire-format.md tests/electron/remoteWireVectors.test.ts
git commit -m "docs(remote): normative wire format with cross-implementation vectors"
```

---

## Self-Review

**Spec coverage.** §4.2's "per-connection ephemeral ECDH … with rekeying for forward secrecy" was unimplemented; Task 4 delivers the ephemeral half. Rekeying *within* a connection is deliberately still absent — a connection's key already dies with it, and a phone reconnects on every foreground, so the rekey interval is bounded by app lifecycle rather than by a timer. §4.3's pairing gets its transport in Task 8. §4.5's capability model is untouched and correct.

**Placeholders.** Two steps produce a literal by running a command and pasting the result (Task 2 Step 6, Task 9 Step 1). That is the golden-vector workflow, not a gap: a vector asserted against a value computed by the same code is vacuous, and one invented by hand is wrong.

**Type consistency.** `SealedChannel` is gone; `SealedDirection` (Task 3) is consumed only by `SealedSession` (Task 4). `PairedDevice.pairingId` → `sessionRoomId` lands in Task 7, and Task 8 is the only later task that reads it. `RelayClientDeps.pairingId` → `roomId` and `channel` → `handshake` both land in Task 4, before Task 5 and Task 6 touch that file.

**What this plan does not cover.** Desktop app integration — spawning the bridge from `src/main/index.ts`, the IPC surface, feeding `terminalOutput` from `terminalOutputBuffer.ts`, and the Settings → Remote tab — is the next plan. The Expo client, push notifications and the store release follow it.
