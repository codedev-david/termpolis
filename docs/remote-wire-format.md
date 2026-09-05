# Termpolis Remote — wire format

Normative. This is the document a second implementation is built from.

The phone client is a second implementation of everything here, in another
language runtime, shipped through two app stores on its own schedule. Almost
every way of getting it wrong fails **silently**: a mismatched HKDF info string
produces a key that is merely different, a text frame is dropped by the relay
without a word, an unset `binaryType` turns every sealed frame into the literal
string `"[object Blob]"`, and a room name computed the other way round leaves a
phone sitting alone in a room that looks perfectly healthy.

So everything below is stated exactly, and pinned by
[`tests/electron/remoteWireVectors.test.ts`](../tests/electron/remoteWireVectors.test.ts).
When that test and this document disagree, the test is right — but one of them
is a bug.

The reference implementation is `src/main/remoteBridge/` (desktop) and
`relay/src/` (relay). `scripts/remote-test-client.cjs` drives a full pairing and
session against the built bridge and is the shortest executable example of the
whole flow.

The second implementation is `mobile/src/wire/`, and this document stays
normative for both. It is not a port to be kept in step by hand:
[`tests/electron/remoteMobileInterop.test.ts`](../tests/electron/remoteMobileInterop.test.ts)
imports the desktop's modules and the phone's side by side and makes each open
what the other sealed, so a change to one that this document does not sanction
fails the root gate rather than a phone in someone's hand.

---

## 1. Vocabulary

| Term | Meaning |
| --- | --- |
| **desktop** | The Termpolis app. Holds the terminals, the agent credentials and the memory. Always the `desktop` role. |
| **device** | The phone. A pass-through: it holds no memory, no embeddings and no model credentials. Always the `device` role. |
| **relay** | A Cloudflare Worker + Durable Object that forwards bytes between the two. Zero-knowledge — see §3. |
| **room** | One Durable Object, named by a 32-hex-character id. Holds at most one socket per role. |
| **pairing room** | The room named by the QR's `pairingId`. Used once, for at most 90 s. |
| **session room** | The room a paired desktop and phone meet in. **Derived**, never announced — see §5.2. |
| **identity key** | A long-lived X25519 keypair. One per desktop, one per phone. |
| **ephemeral key** | An X25519 keypair minted per attachment, for forward secrecy. |

Two rooms, not one, and that is load-bearing: a room holds one socket per role,
so a desktop that stayed in the pairing room would answer the paired phone's
reconnect with a `409`.

---

## 2. Cryptographic primitives

| Purpose | Primitive |
| --- | --- |
| Key agreement | X25519 |
| AEAD | ChaCha20-Poly1305 (IETF, 12-byte nonce, 16-byte tag) |
| KDF | HKDF-SHA-256 |
| Hash | SHA-256 |

The desktop uses `@noble/curves`, `@noble/ciphers` and `@noble/hashes` — pure
JS, no native module, which is what lets the bridge run in an Electron
`utilityProcess`. A port may use anything that computes the same bytes.

**HKDF argument order** throughout this document is
`HKDF(hash, ikm, salt, info, length)`. Where a salt is written as *none*, it is
the RFC 5869 default: a `HashLen`-byte string of zeros. Passing an empty
`Uint8Array` is **not** the same thing in every library — check yours.

All keys and ids in JSON and in this document are **lowercase hex**.

---

## 3. Transport

### 3.1 Connecting

```
wss://<relay-host>/v1/pair/<roomId>?role=desktop
wss://<relay-host>/v1/pair/<roomId>?role=device
```

`<roomId>` must match `^[0-9a-f]{32}$`. The relay refuses anything else before
it looks at the room.

| Status | Meaning |
| --- | --- |
| `404` | Path is not `/v1/pair/<id>`. |
| `400` | Room id fails the pattern, or `role` is not `desktop`/`device`. |
| `426` | Not a WebSocket upgrade. |
| `429` | Too many rooms opened from this source address. Back off. |
| `409` | **That role is already connected.** Someone else is in your seat. |
| `101` | Seated. |

A `409` is not a transient error and must not be retried in a tight loop. In
normal operation it cannot happen, because the two ends occupy different rooms
at different times; if you see one, another client is holding the seat.

### 3.2 Two frame types, and why it matters

- **Text frames** are the relay's own control messages. The relay is the only
  thing that ever authors one, and the only thing that ever parses one. Text a
  *peer* sends is **dropped unread** — there is no branch in which peer text
  reaches a parser.
- **Binary frames** are peer payload. The relay measures them, bills them, and
  forwards them byte-for-byte. It never opens one.

That split is what makes "the relay cannot read your traffic" structural rather
than a promise. It also means a client that sends its sealed frames as text has
built a client that silently does nothing.

**A binary frame that arrives for an empty room is DROPPED, not queued.** This
single fact shapes the whole handshake: see §3.4.

### 3.3 Control frames (relay → peer, JSON text)

```json
{"kind":"hello","role":"desktop","peer":false}
{"kind":"peer-joined","role":"device"}
{"kind":"peer-gone","role":"device"}
{"kind":"quota-exceeded","limit":"frame-rate"}
```

`limit` is one of `frame-size`, `frame-rate`, `connection-bytes`, `idle`.

`hello.peer` says whether the partner was **already seated** when you arrived.
Anything unparseable, or of a kind you do not know, must be dropped: the relay
is untrusted and a control frame is a hint, never an instruction worth a
disconnect.

### 3.4 The greeting rule

A peer sends its session greeting (§6.1) **only into a room that has someone in
it**:

- on `hello` with `"peer": true` → greet immediately;
- on `hello` with `"peer": false` → wait;
- on `peer-joined` → greet;
- on `peer-gone` → discard the session and any pending handshake, stay
  connected, and report the peer as gone rather than yourself as offline.

Greeting on socket-open instead is the single most expensive mistake available
here. The desktop is almost always first into the room, so its half of the
handshake goes into the void and the phone waits forever for a key that was
already thrown away.

`peer-gone` must clear the session. Whoever takes the role next is a different
connection with a different ephemeral key; holding the old session routes their
greeting down the frame path, where it cannot open, and leaves a socket that is
connected, attached and permanently mute.

### 3.5 Quotas

| Limit | Value | Close code |
| --- | --- | --- |
| Max frame | 1 MiB (`1048576` bytes) — the **sealed** frame, header included | `1009` |
| Frame rate | 20/s, burst 40 | `1008` |
| Connection bytes | 256 MiB | `1008` |
| Idle | 300 s since the last **binary** frame | `1000` |

The relay sends `quota-exceeded` and then closes. `frame-size` and `frame-rate`
mean *this client is the problem*: latch and stop dialing. `idle` and
`connection-bytes` are normal enough to redial after — never redialing on an
idle cut takes remote dark until the app restarts.

### 3.6 Keepalive

Send a `KEEPALIVE` frame (§4, one `0x00` byte) every **120 s** while seated.
Text does not refresh the idle timer — only a binary frame does. A desktop
waiting for a phone that has not arrived sends nothing at all, so without this
it is cut every five minutes, redials a second later, forever, and each cycle
opens a window in which the phone finds an empty room.

Drop a received `KEEPALIVE` **by tag, before consulting any key**. One that
reached the greeting path would fail to open and cost you the connection — for
a frame whose entire purpose is to keep it.

---

## 4. Frame types

Every frame's first byte is its tag, and the tag is inside the AEAD's
associated data (§5.1). Retagging a frame fails authentication rather than
being reinterpreted as another type.

| Tag | Name | Layout |
| --- | --- | --- |
| `0x00` | `KEEPALIVE` | `0x00` — one byte, unsealed, always identical |
| `0x01` | `PAIRING_HELLO` | `0x01 ‖ devicePublicKey[32] ‖ sealed` |
| `0x02` | `PAIRING_ACK` | `0x02 ‖ sealed` |
| `0x03` | `SESSION_HELLO` | `0x03 ‖ ephemeralPublicKey[32] ‖ sealed` |
| `0x04` | `SESSION` | `0x04 ‖ sealed` |

`sealed` is `counter[6] ‖ ChaCha20-Poly1305(plaintext, aad = header)` where
`header` is every byte before the counter — see §5.1.

Header widths: `PAIRING_HELLO` and `SESSION_HELLO` are 33 bytes; `PAIRING_ACK`
and `SESSION` are 1. Seal overhead is 22 bytes (6 counter + 16 tag). A
`SESSION` frame therefore costs `1 + 22 + len(plaintext)` on the wire, and it is
*that* number the 1 MiB cap applies to.

---

## 5. Sealing

### 5.1 One frame

```
seal(key, counter, header, plaintext):
    nonce  = 6 zero bytes ‖ counter as 6-byte big-endian
    ct     = ChaCha20-Poly1305(key, nonce).encrypt(plaintext, aad = header)
    frame  = header ‖ counter ‖ ct
```

- **The header is in the clear and is the associated data.** It has to be clear
  — the receiver reads it to know which key to try — and making it the AAD is
  what keeps that from being a hole. An altered tag, or a substituted public
  key in a `PAIRING_HELLO`, fails Poly1305 instead of being believed.
- **The counter is in the clear and is authenticated implicitly.** It derives
  the nonce, so raising it makes decryption fail; lowering it trips the replay
  check.
- **The nonce is derived, never random.** A key seals in exactly one direction,
  so its counter never repeats and neither does the nonce. Uniqueness is
  structural, with no birthday bound to reason about, and 12 bytes per frame
  stay off the wire.
- Counters are 6 bytes: 2^48 frames, which fits exactly in a JS number, so the
  arithmetic stays integer-exact with no BigInt.

Opening, in order:

1. Refuse a frame shorter than `headerBytes + 22`. Below that the counter is
   read off the end of the buffer, and the garbage that produces poisons replay
   state for every frame after it.
2. Read the counter. **Refuse `counter <= highWaterMark`** — strictly
   increasing, so a replayed *or reordered* frame is refused. Authenticity alone
   would happily accept both. Check this *before* decryption, so a replay flood
   costs an integer compare instead of a Poly1305 verification over an
   attacker-chosen length.
3. Decrypt with `aad = frame[0..headerBytes]`.
4. **Only now** advance the high-water mark. Advancing before the tag verifies
   lets anyone walk the counter forward with garbage and deafen the peer for
   good.

The high-water mark starts at `-1`, so the peer's first frame (counter `0`) is
accepted.

### 5.2 Directions

One root produces two keys, and the role decides which one you seal with:

```
d2p = HKDF(SHA-256, root, salt: none, info: "termpolis-d2p-v2", 32)
p2d = HKDF(SHA-256, root, salt: none, info: "termpolis-p2d-v2", 32)

desktop:  tx = d2p,  rx = p2d
device:   tx = p2d,  rx = d2p
```

Each key carries its own counter and its own high-water mark. A single key used
both ways would let the relay reflect a peer's own frame back at it — the tag
verifies, because the peer sealed it — and the reflected counter poisons the
receive high-water mark permanently.

---

## 6. Key schedule

Write `DH(a, B)` for the raw X25519 shared secret between secret key `a` and
public key `B`. All four roots below are 32 bytes and feed §5.2.

### 6.1 Session handshake

Ephemeral-static, both directions in flight at once. The ephemeral term gives
forward secrecy; the static term authenticates.

**The greeting** is sealed under a root only the two identity holders can
derive, so accepting one is already proof of identity:

```
handshakeRoot = HKDF(SHA-256, DH(ownIdSk, peerIdPk),
                     salt: none, info: "termpolis-handshake-v2", 32)

header    = 0x03 ‖ ownEphemeralPk[32]
plaintext = {"v":2,"role":"desktop"}          // or "device"
greeting  = seal(handshakeRoot → tx key for your role, counter 0, header, plaintext)
```

Build a **fresh** `handshakeRoot` session for the seal and for the open. They
are independent counters that both start at zero; reusing one object makes the
second operation fail.

**Accepting a greeting:**

1. Refuse if shorter than 33 bytes, or if `frame[0] != 0x03`.
2. Take `peerEphemeralPk = frame[1..33]`.
3. Open under `handshakeRoot` with `headerBytes = 33`. *This is the
   authentication step.*
4. Refuse if `payload.v != 2` — say so, rather than letting a changed payload
   shape surface as an unexplained decryption failure.
5. Refuse if `payload.role` is not the opposite of your own.

**The session root:**

```
ikm  = DH(ownEphemeralSk, peerEphemeralPk) ‖ DH(ownIdSk, peerIdPk)     // 64 bytes
lo, hi = sort([hex(ownEphemeralPk), hex(peerEphemeralPk)])             // lexicographic
salt = SHA-256(utf8(lo ‖ hi))
sessionRoot = HKDF(SHA-256, ikm, salt, info: "termpolis-session-v2", 32)
```

The sort is what lets both ends compute the same salt without agreeing on who
spoke first — which they cannot, since both greetings are in flight at once.
The concatenation order of `ikm` is ephemeral-first and is not negotiable.

An attacker needs the ephemeral private key **and** an identity private key.
One is not enough.

### 6.2 The session room

```
sessionRoomId = hex(HKDF(SHA-256, DH(ownIdSk, peerIdPk),
                         salt: none, info: "termpolis-session-room-v2", 16))
```

Sixteen bytes, hex — exactly the 32 characters the relay's room-id pattern
wants. Both ends compute it from what they already hold, so it never crosses
the wire and never appears in a QR.

That is the point. A room name is not a credential: anyone who photographed the
QR could otherwise squat the session room forever and answer the real phone
with a `409`, with neither the offer's TTL nor its single-use flag touching it,
because the exposure is the *name* and the name outlives the secret.

A port that changed this label would not fail a handshake. It would sit in an
empty room forever, and the only symptom would be a phone that never connects.

### 6.3 The pairing root

```
pairingRoot = HKDF(SHA-256, DH(ownIdSk, peerIdPk),
                   salt: utf8(pairingId), info: "termpolis-pair-v2", 32)
```

Salted with the pairing id, so a hello is valid in the room it was sealed for
and nowhere else. Without that binding, a hello captured from one offer replays
into the next offer the same desktop shows — the identity keys have not changed.

---

## 7. Pairing

### 7.1 The QR payload

The desktop shows this as a QR for **90 s**:

```json
{
  "v": 1,
  "relayUrl": "wss://relay.termpolis.com",
  "pairingId": "0123456789abcdef0123456789abcdef",
  "desktopPublicKey": "<64 hex>",
  "oneTimeSecret": "<64 hex>"
}
```

`v` here is the **QR envelope** version and is deliberately not
`PROTOCOL_VERSION`: it is read by a scanner that has not yet decided whether it
can speak to this desktop at all. `pairingId` is 16 random bytes, hex;
`oneTimeSecret` is 32 random bytes, hex.

Treat the whole payload as a credential. It is a bearer token for exactly one
pairing, and the desktop stops honouring it the moment it is used or expires.

### 7.2 The exchange

```
desktop                          relay                          phone
   |  connect room=pairingId, role=desktop                        |
   |------------------------------->|                             |
   |  <-- hello{peer:false}         |                             |
   |                                | <---- connect role=device ---|
   |  <-- peer-joined               |  ---- hello{peer:true} ----> |
   |                                |                             |
   |  <---------------- 0x01 PAIRING_HELLO ---------------------- |
   |  ----------------- 0x02 PAIRING_ACK -----------------------> |
   |  (seated in the session room BEFORE the ack goes out)         |
   |  close pairing room            |                             |
```

The desktop is in the pairing room **before** the QR is on screen, and it is
seated in the session room **before** the ack leaves. Both orderings exist for
the same reason: a frame addressed to an empty room is dropped.

The phone does **not** greet in a pairing room. There is no session there and
there cannot be one — a session key needs two identity keys, and learning the
phone's is the entire purpose of this room. The phone speaks first, with a
hello sealed under the pairing root.

### 7.3 `PAIRING_HELLO` — phone → desktop

```
header    = 0x01 ‖ devicePublicKey[32]
plaintext = {"v":2,"label":"Pixel 9 Pro","oneTimeSecret":"<64 hex>"}
frame     = seal(pairingRoot(deviceIdSk, desktopIdPk, pairingId) → device tx key,
                 counter 0, header, plaintext)
```

The device key rides in the clear because it has to: the desktop has never seen
this phone and cannot derive the sealing key without the key it is deriving
against. Everything worth hiding — the label, and the one-time secret — is
inside the seal. The clear header is the AAD, so a relay that swaps in its own
public key to be paired *as itself* fails Poly1305 rather than being believed.

The desktop, on receipt:

1. Refuses a frame shorter than 33 bytes. (The length check comes first: slicing
   past the end of a short buffer yields a *short key* rather than an error, and
   a curve library complaining about scalar length is a poor way to learn the
   frame was truncated.)
2. Refuses `frame[0] != 0x01`.
3. Derives the pairing root against the clear device key and opens with
   `headerBytes = 33`.
4. Refuses `payload.v != 2`.
5. Compares `oneTimeSecret` against the offer's **in constant time**, and
   refuses if the offer is used or expired.

A frame that does not open is ignored and the room stays open — the room's name
is on screen for 90 s, so anything at all can arrive in it, and closing on a
stray frame would let a photographed QR deny pairing. A frame that *opens* but
carries the wrong secret is reported to the user, and the offer stays usable,
because it is only marked used once every check has passed.

### 7.4 `PAIRING_ACK` — desktop → phone

```
header    = 0x02
plaintext = {"v":2,"deviceId":"12faa049f0ec7720"}
frame     = seal(pairingRoot(desktopIdSk, deviceIdPk, pairingId) → desktop tx key,
                 counter 0, header, plaintext)
```

`deviceId` is `SHA-256(utf8(devicePublicKeyHex))` truncated to the first 8
bytes, hex — the desktop's stable handle for this phone.

Deliberately thin. Everything the phone needs next — the session room, the
safety number — it *derives* from the two identity keys it already holds, and
sending either would invite a client that trusts the wire value instead. What
is left is the fact of acceptance, and acceptance has to be authenticated: a
relay that could forge one would send the phone off to a session room the
desktop is not in, where it would wait with no error to show.

It is sealed on a session built **fresh** from the pairing root, so its counter
is the first on the desktop→phone direction. That is what lets the phone open it
without having kept the session object it sealed its own hello with.

### 7.5 Afterwards

The phone stores the desktop's public key, its own keypair, and the derived
`sessionRoomId`; it may discard the pairing id and must discard the one-time
secret. Both ends then connect to the session room and run §6.1.

The phone's private key belongs in the platform keystore —
`expo-secure-store` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, or equivalent. It is
the whole of the phone's authority.

---

## 8. Safety numbers

```
lo, hi = sort([hex(aPublicKey), hex(bPublicKey)])       // lexicographic
digest = SHA-256(utf8(lo ‖ ":" ‖ hi))
phrase = SAFETY_WORDS[digest[0]] … SAFETY_WORDS[digest[7]]   // joined by " "
```

`SAFETY_WORDS` is the 256-entry list in
[`src/main/remoteBridge/wordlist.ts`](../src/main/remoteBridge/wordlist.ts) and
must be ported verbatim, in order. One digest byte per word, no modulo: 256
entries means every byte maps to a distinct word and the mapping is uniform by
construction.

Eight words over 256 is 64 bits. The number that matters is the **grinding**
cost, not the reading cost: the desktop public key is static and appears in
every QR that machine ever shows, so an attacker searches offline, for days,
from a photograph taken months ago — the 90-second offer TTL constrains none of
it. And a phrase ground to match does not merely evade the check; the user
compares it, sees it match, and the comparison *confirms* the attacker.

Both ends render this and the user confirms they match. It is the only thing
standing between a malicious relay and a MITM of the pairing handshake.

---

## 9. Application payloads

`SESSION` frames carry JSON. Phone → desktop is always an envelope:

```json
{"id": 1, "request": {"kind": "listTerminals"}}
```

`id` is a number and correlates exactly one response. Requests:

| `kind` | Fields | Capability |
| --- | --- | --- |
| `getCapabilities` | — | none |
| `listTerminals` | — | `read` |
| `subscribe` | `terminalId` | `read` |
| `unsubscribe` | `terminalId` | `read` |
| `createTerminal` | `name`, `cwd?` | `createTerminal` |
| `runCommand` | `terminalId`, `command` | `writeToTerminal` |
| `writeToTerminal` | `terminalId`, `text` | `writeToTerminal` |
| `closeTerminal` | `terminalId` | `closeTerminal` |

Every capability is opt-in and defaults to **false**; the user grants them per
device in Settings. `runCommand` requires `writeToTerminal`, not
`createTerminal`: it reaches the terminal as a write plus a carriage return, so
it is arbitrary shell execution under another name. An unrecognised `kind` is
refused outright.

`getCapabilities` is the one request that needs no grant, and it answers with
the capability record itself — `{"read":…,"createTerminal":…,
"writeToTerminal":…,"closeTerminal":…}`. A device that has been granted
nothing must still be able to learn that: without it a phone can only discover a
missing capability by attempting the action and reading the refusal, which means
offering a control that errors. It is granted by being answered *above* the
capability check rather than by a rule inside it, so a desktop that loses that
branch refuses the request instead of admitting it.

A phone should ask on every attach, because grants change while it is away.
The desktop also **pushes** the record, unprompted, whenever the user edits the
grants in Settings:

```json
{"kind":"capabilities","capabilities":{"read":true,"createTerminal":false,"writeToTerminal":false,"closeTerminal":false}}
```

The push is a courtesy, not a guarantee — it is dropped if the phone is not
attached, which is exactly why the phone re-asks on attach rather than relying
on it. It is not authorization either: the desktop re-checks every request
against its own record, so a phone that never receives the push is refused
normally rather than trusted.

Desktop → phone is one of:

```json
{"kind":"ok","id":1,"data": …}
{"kind":"error","id":1,"message":"…"}
{"kind":"output","chunks":[{"terminalId":"t1","chunk":"…","missed":0,"marker":null}]}
{"kind":"status","terminalId":"t1","status":"working","summary":"…"}
{"kind":"capabilities","capabilities":{"read":true,"createTerminal":false,"writeToTerminal":false,"closeTerminal":false}}
```

Output is **batched** — many chunks per frame, never a frame per chunk. The
relay bills per frame and allows a burst of 40, so a frame per echoed keystroke
would spend the whole burst on ordinary typing. `missed` counts characters
evicted before the fan-out reached them; `marker` is the rendered gap notice and
appears on the first piece of a split chunk only.

A frame that does not open, or that opens and is not a valid envelope, is
**dropped silently**. Neither may throw out of the message handler: an unhandled
rejection there tears down a connection a hostile phone could then drop at will.

Sizing: the desktop splits any payload that would seal larger than 1 MiB. A
client need not, but must not exceed the cap — the relay **cuts** an oversized
frame rather than truncating it, which reads to a user as an unreliable network.

---

## 10. Four mistakes that cost a day each

1. **Set `binaryType = 'arraybuffer'` on your own socket.** Both workerd and
   browsers default to `"blob"`, and `send()` does not accept a Blob — it
   coerces the argument to a string, so the far end receives the literal text
   `"[object Blob]"`. Every byte of every sealed frame is destroyed and the
   connection still looks healthy, because the frame count and the timing are
   right.
2. **Speak binary only.** Peer text is dropped unread and unreported. A client
   that sends its frames as text does nothing at all, silently, forever.
3. **Do not greet into an empty room.** §3.4. A frame with no partner seated is
   dropped, not queued.
4. **One key, one direction.** §5.2. Sharing a key between directions makes a
   reflected frame verify, and its counter permanently poisons your receive
   state.

Two more, for React Native specifically:

- `@noble` rejects a Node `Buffer` — pass real `Uint8Array`s. Use the
  hex helpers rather than `Buffer.from(hex, 'hex')`.
- Polyfill `crypto.getRandomValues` before generating an identity, and use a
  real CSPRNG. `Math.random()` here is a total break, and it will pass every
  test you write.

---

## 11. Versioning

`PROTOCOL_VERSION` is **2**. It appears in the `SESSION_HELLO`,
`PAIRING_HELLO` and `PAIRING_ACK` payloads, and each is refused if it names any
other number. The QR envelope's `"v": 1` is separate and versions independently.

Bump it only for a breaking wire change, and bump it in the same commit as the
change. A peer that sees a version it does not know must **say so** — an old
phone against a new desktop should report a version mismatch, not a decryption
failure.

The `-v2` suffix on every HKDF info string is part of the string, not a
separate field. Changing a label changes every key derived from it, which is a
silent break in exactly the way §6.2 describes; if you must, bump
`PROTOCOL_VERSION` alongside it so at least one end can name the problem.

---

## 12. Golden vectors

Pinned in `tests/electron/remoteWireVectors.test.ts`. Every frame below is also
opened there against the counterpart implementation, so a vector cannot drift
into a stable encoding of the wrong thing.

**Inputs** (fixed for reproducibility; production draws all of these at random):

```
desktopIdSk  = 1111…11  (32 bytes of 0x11)
deviceIdSk   = 2222…22  (32 bytes of 0x22)
desktopEphSk = 3333…33  (32 bytes of 0x33)
deviceEphSk  = 4444…44  (32 bytes of 0x44)
pairingId    = 0123456789abcdef0123456789abcdef
oneTimeSecret= aaaa…aa  (32 bytes of 0xaa)
```

**Derived** — none of these cross the wire as an input; recomputing them is the
first thing a port should get right.

```
desktopIdPk = 7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13
deviceIdPk  = 0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20
deviceId    = 12faa049f0ec7720          (§7.4: SHA-256(utf8(deviceIdPk))[:8])
```

**Session room** — `deriveSessionRoomId`, identical from either side:

```
c9dc49b87f0dc983be61f034ceab7c52
```

**Safety number** — `deriveVerificationPhrase`, identical in either order:

```
hurdle desert ember kelp velvet tundra thicket pebble
```

**Pairing root** — `pairingRoot(·, ·, pairingId)`, identical from either side:

```
4bc2d5c4a6e0afc1271ef4bc1d5abbadcdbd6c8ab1d20580a76fcf84c7413762
```

**`PAIRING_HELLO`**, label `Pixel 9 Pro`:

```
010faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f2000000000000020
81553da47997d20ba9ead687b5284bc29952a3fa91efcff877f847813c9b10cddd32a7d112f4ee6
45add4095efbc5f45797dcacdd271e925ecab97466b3a7ecb3fba9bd3cd247ce0f2ea6ee5313cf1
323e3e5fd8f54fafcad27a09d5b774cb629d9953544b558a9e8c8f35157d4a630821b9da811a465
aa39c3d02029d4a58
```

**`PAIRING_HELLO`**, label `Téléphone — 9` (13 characters, 17 UTF-8 bytes — this
one exists to catch a `TextEncoder` shim that writes UTF-16 or escapes
non-ASCII):

```
010faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f2000000000000020
81553da47997d20ba9ead687b5284bc63383aa5518a687c76bf2454f9e605e91ab77e8db2ff4d97
f52cc31caaeaf5b503a2689cdd271e925ecab97466b3a7ecb3fba9bd3cd247ce0f2ea6ee5313cf1
323e3e5fd8f54fafcad27a09d5b774cb629d9953544b558a9e8c8f35157d097f09908f284212b23
62736c1792e001968ccad6b75b8b2
```

**`PAIRING_ACK`**:

```
02000000000000d58c0735797b5b7a4a055b26fff0cb3cc88c3a055e9452feee281c91e91cd4859f
6c24be770d00f17470eb1a8f69659a9cccb79167
```

**`SESSION_HELLO`**, desktop then device:

```
037b0d47d93427f8311160781c7c733fd89f88970aef490d8aa0ee19a4cb8a1b140000000000004e
3e2c52e1bf5db5275ed739c1ccf1213e2f439b8c85808d50840539048ec50df4560e0deed81054

03ff2ee45601ec1b67310c7790404585ae697331eee1c1f8cf2419731c1fff3e6b000000000000ff
9d3f9caf2252eda92794b52a8c84ca560016a24ef17718cc2a72c02262d859e881a5d8aac2a7
```

**`SESSION`** — desktop→phone counter 0, then counter 1 under the same key, then
phone→desktop counter 0 (the two directions count independently):

```
{"kind":"ok","id":1,"data":null}
04000000000000bffaf517d1df8789618e3ca2997945eb3c91937be39b360bc1d86dde6043cc98d7
9abd82e8c05592fb9c34e8ef0eda17

{"kind":"ok","id":2,"data":null}
040000000000019998de6962497e05e699698a3766a6ad231ccaeb5675e77ca4d60e9d98df86e2e4
9323a050c5f1de4d2bb87724832b94

{"id":1,"request":{"kind":"listTerminals"}}
040000000000008ef9a596d3ee7d5353b7dc6bd3da2d8b8fe43237783a9dd938d9f78c66625218cd
005aed0b0eb419434def65dc31ab9cf5236ed96dd3df0856d36c
```

**`KEEPALIVE`**: `00`.

Hex above is wrapped for width; concatenate the lines. The JSON payloads are
shown with the exact key order the vectors were generated from — order is free
for interoperability, since the receiver parses JSON, but it must match to
reproduce these bytes.
