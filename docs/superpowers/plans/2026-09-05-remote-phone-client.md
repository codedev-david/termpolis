# Termpolis Remote — Phone Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Expo phone client — a second, independent implementation of the
Termpolis Remote wire protocol that pairs with a running desktop, renders its
terminals, and types into them, on both iOS and Android.

**Architecture:** A `mobile/` workspace beside `relay/`, split so the risky half is
provable off-device. `mobile/src/wire/` is **pure TypeScript with no React Native
import of any kind** — it is the protocol port, and because it is pure it is
exercised on every root CI run by an interop test that drives it against the real
desktop bridge. `mobile/src/net/`, `storage/`, `state/` and `screens/` sit on top and
are tested under `jest-expo` inside `mobile/`. Nothing above `wire/` is trusted to
get the bytes right.

**Tech Stack:** Expo (React Native, TypeScript), `@noble/curves` +
`@noble/ciphers` + `@noble/hashes`, `expo-camera` (QR), `expo-secure-store`
(private key), `zustand` (state, matching the desktop), `jest-expo` +
`@testing-library/react-native`.

**Spec:** `docs/superpowers/specs/2026-09-04-termpolis-remote-design.md` §6, and
`docs/remote-wire-format.md` — which is **normative** and is the document this
client is built from. Where the two disagree, the wire format wins.

## Global Constraints

Copied verbatim from `docs/remote-wire-format.md`. Every task's requirements
implicitly include this section. A wrong value here fails *silently* — that is the
defining property of this protocol and the reason the numbers are restated rather
than referenced.

- **`PROTOCOL_VERSION` is `2`.** It appears in `SESSION_HELLO`, `PAIRING_HELLO`
  and `PAIRING_ACK` payloads and each is refused if it names any other number.
  The QR envelope's `"v": 1` is **separate** and versions independently.
- **Frame tags:** `0x00` `KEEPALIVE`, `0x01` `PAIRING_HELLO`, `0x02` `PAIRING_ACK`,
  `0x03` `SESSION_HELLO`, `0x04` `SESSION`.
- **Header widths:** `PAIRING_HELLO` and `SESSION_HELLO` are **33** bytes
  (`tag ‖ publicKey[32]`); `PAIRING_ACK` and `SESSION` are **1**.
- **Seal overhead is 22 bytes** — 6 counter + 16 Poly1305 tag.
- **`seal(key, counter, header, plaintext)`:** `nonce = 6 zero bytes ‖ counter as
  6-byte big-endian`; `ct = ChaCha20-Poly1305(key, nonce).encrypt(plaintext, aad =
  header)`; `frame = header ‖ counter ‖ ct`.
- **Opening order is load-bearing:** (1) refuse shorter than `headerBytes + 22`;
  (2) read counter and refuse `counter <= highWaterMark` **before decrypting**;
  (3) decrypt with `aad = frame[0..headerBytes]`; (4) **only then** advance the
  high-water mark. High-water starts at `-1`.
- **HKDF argument order is `HKDF(hash, ikm, salt, info, length)`.** Where salt is
  *none* it is the RFC 5869 default — a 32-byte string of zeros. An empty
  `Uint8Array` is not the same thing in every library.
- **Info strings, exactly:** `termpolis-d2p-v2`, `termpolis-p2d-v2`,
  `termpolis-handshake-v2`, `termpolis-session-v2`, `termpolis-session-room-v2`,
  `termpolis-pair-v2`. The `-v2` suffix is part of the string.
- **Directions:** `device: tx = p2d, rx = d2p`. One key seals one direction. Each
  key carries its own counter and its own high-water mark.
- **Session root:** `ikm = DH(ownEphSk, peerEphPk) ‖ DH(ownIdSk, peerIdPk)`
  (ephemeral first, not negotiable); `salt = SHA-256(utf8(lo ‖ hi))` over the
  lexicographically sorted hex ephemeral public keys.
- **Session room id:** `hex(HKDF(SHA-256, DH(ownIdSk, peerIdPk), salt: none,
  info: "termpolis-session-room-v2", 16))` — 16 bytes, never announced.
- **Pairing root:** `HKDF(SHA-256, DH(ownIdSk, peerIdPk), salt: utf8(pairingId),
  info: "termpolis-pair-v2", 32)`.
- **`deviceId` = `SHA-256(utf8(devicePublicKeyHex))` truncated to the first 8
  bytes, hex.**
- **Safety number:** sort the two hex public keys lexicographically,
  `digest = SHA-256(utf8(lo ‖ ":" ‖ hi))`, then `SAFETY_WORDS[digest[0..8]]` joined
  by a single space. `SAFETY_WORDS` is the 256-entry list in
  `src/main/remoteBridge/wordlist.ts` and **must be ported verbatim, in order**.
- **Relay URL shape:** `wss://<host>/v1/pair/<roomId>?role=device`. `<roomId>`
  must match `^[0-9a-f]{32}$`.
- **Relay status codes:** `409` means *that role is already connected* — not
  transient, must not be retried in a tight loop.
- **Quotas:** max frame 1 MiB (`1048576`, sealed, header included); frame rate
  20/s burst 40; connection bytes 256 MiB; idle 300 s since the last **binary**
  frame. `frame-size` and `frame-rate` mean *this client is the problem* — latch
  and stop dialing. `idle` and `connection-bytes` are redialable.
- **Keepalive: one `0x00` byte every 120 s while seated.** Text does not refresh
  the idle timer. Drop a received `KEEPALIVE` **by tag, before consulting any key**.
- **The greeting rule (§3.4):** greet on `hello` with `"peer": true`, wait on
  `"peer": false`, greet on `peer-joined`, and on `peer-gone` **discard the session
  and any pending handshake**, stay connected, and report the *peer* as gone.
- **Pairing offer TTL is 90 s** and single-use.
- **All keys and ids in JSON and on the wire are lowercase hex.**
- **`@noble` rejects a Node `Buffer`** — pass real `Uint8Array`s.
- **The phone's private key lives in `expo-secure-store` with
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.** It is the whole of the phone's authority.
- **The phone holds no memory, no embeddings and no model credentials.** Ever.
- Root coverage gate is unchanged: lines 97 / functions 96 / branches 95 /
  statements 96. `mobile/` is not in the root coverage `include` list and carries
  its own thresholds, set just under what its suite achieves — the `relay/` pattern.
- Commit directly to `main`. No branches, no PRs.

---

## File Structure

The split at `wire/` is the one structural decision that matters. Everything in it
is pure TypeScript that imports nothing from React Native or Expo, which is what
lets `tests/electron/remoteMobileInterop.test.ts` run the phone's own crypto
against the desktop's on every root CI run. If a React Native import ever lands in
`wire/`, that gate stops running and the port loses its only proof.

```
mobile/
  package.json            jest-expo, @noble/* pinned to the SAME versions as root
  app.json                Expo config: name, slug, icons, plugins, iOS/Android ids
  babel.config.js         babel-preset-expo
  tsconfig.json           extends expo/tsconfig.base, strict
  jest.config.js          preset jest-expo, coverage thresholds
  index.ts                entry — imports react-native-get-random-values FIRST
  App.tsx                 shell: gate on paired-or-not, mount navigation
  src/
    wire/                 PURE TS. No react-native, no expo, no Node builtins.
      bytes.ts            toHex/fromHex, utf8Encode/utf8Decode, concat, equal
      wordlist.ts         SAFETY_WORDS — verbatim port, 256 entries
      safetyNumber.ts     deriveVerificationPhrase
      sealedChannel.ts    seal/open, counters, SealedSession, SEAL_OVERHEAD_BYTES
      sessionCrypto.ts    direction keys, roots, deriveSessionRoomId, Handshake
      pairing.ts          sealPairingHello, openPairingAck, deviceIdFor
      qr.ts               parseQrPayload — validates before it trusts
      protocol.ts         request/response types, frame tags
      version.ts          PROTOCOL_VERSION, QR_ENVELOPE_VERSION
    net/
      relaySocket.ts      socket lifecycle: binaryType, greeting rule, keepalive,
                          quota latch, backoff, peer-gone
      remoteSession.ts    envelope correlation, output/status routing
    storage/
      identity.ts         SecureStore: own keypair + paired desktop record
    state/
      remoteStore.ts      zustand: connection, terminals, output buffers, AppState
    ansi/
      render.ts           ANSI subset -> styled segments
    screens/
      PairScreen.tsx      camera scan + manual paste fallback
      SafetyNumberScreen.tsx
      TerminalListScreen.tsx
      TerminalScreen.tsx  output view + input bar
      SettingsScreen.tsx  safety number, unpair, relay status
  __tests__/              jest-expo suites, mirroring src/

tests/electron/
  remoteMobileInterop.test.ts   NEW. Root vitest. mobile/src/wire vs the desktop
                                bridge: full pair -> session -> request -> revoke.
```

**Repo wiring changes** (Task 1): `vitest.config.ts` adds `'**/mobile/**'` to
`test.exclude` so root vitest does not collect the jest suites;
`tsconfig.test.json` adds `mobile/src/wire/**/*` to `include` so the port is
typechecked by the root gate; root `.eslintrc.cjs` needs **no** change — `mobile/`
is linted by the root config exactly as `relay/` is.

---

## A note on where the code lives

`docs/remote-wire-format.md` is normative and already states every algorithm in
this client, byte for byte. This plan therefore **cites** it per task rather than
restating it. Copying those algorithms here would create a second source of truth
for the same bytes, and the wire doc's own warning applies to it as much as to the
test: when two statements of the same encoding disagree, one of them is a bug.

What this plan does carry in full is everything it is the only source of — test
code, config, repo wiring, and the reasoning behind each boundary.

---

## Task 1: Scaffold `mobile/` and wire it into the repo's gates

**Files:**
- Create: `mobile/package.json`, `mobile/app.json`, `mobile/babel.config.js`,
  `mobile/tsconfig.json`, `mobile/jest.config.js`, `mobile/index.ts`, `mobile/App.tsx`
- Create: `mobile/src/wire/version.ts`
- Create: `mobile/__tests__/scaffold.test.ts`
- Modify: `vitest.config.ts` (`test.exclude`), `tsconfig.test.json` (`include`),
  `package.json` (root scripts), `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: `mobile/src/wire/version.ts` exporting `PROTOCOL_VERSION = 2` and
  `QR_ENVELOPE_VERSION = 1`. Every later wire task imports these rather than
  restating the literals.

- [ ] **Step 1: Make the directories**

```bash
mkdir -p mobile/src/wire mobile/src/net mobile/src/storage mobile/src/state mobile/src/ansi mobile/src/screens mobile/__tests__
```

Do **not** use `npx create-expo-app` — it wants an empty directory and installs a
router template this app does not need. Write the files directly.

- [ ] **Step 2: Write `mobile/package.json` and install**

```json
{
  "name": "termpolis-remote-mobile",
  "version": "1.0.0",
  "private": true,
  "description": "Termpolis Remote - the phone client. A pass-through to a running desktop: no memory, no embeddings, no model credentials.",
  "main": "index.ts",
  "scripts": {
    "start": "expo start",
    "android": "expo run:android",
    "ios": "expo run:ios",
    "test": "jest",
    "typecheck": "tsc --noEmit"
  }
}
```

Then, from `mobile/`:

```bash
npx expo install expo expo-camera expo-secure-store expo-status-bar react react-native react-native-get-random-values react-native-safe-area-context react-native-screens
npm i -D jest jest-expo @testing-library/react-native @types/react @types/jest typescript babel-preset-expo
npm i zustand
```

`@noble/curves`, `@noble/ciphers` and `@noble/hashes` are installed **last and
explicitly at the versions the root `package.json` already resolves** — read them
out of the root file, do not guess:

```bash
node -e "const p=require('../package.json');console.log(['@noble/curves','@noble/ciphers','@noble/hashes'].map(n=>n+'@'+(p.dependencies[n]||p.devDependencies[n])).join(' '))"
```

Install exactly what that prints. The interop test resolves `mobile/src/wire`'s
imports through root `node_modules`, so a version skew between the two trees is a
silent behavioural difference in the one layer that must not have one.

Record the resolved Expo SDK version in the commit message.

- [ ] **Step 3: Write the config files**

`mobile/babel.config.js`:

```js
module.exports = function (api) {
  api.cache(true)
  return { presets: ['babel-preset-expo'] }
}
```

`mobile/tsconfig.json`:

```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true
  },
  "include": ["index.ts", "App.tsx", "src/**/*", "__tests__/**/*"]
}
```

`noUncheckedIndexedAccess` is on deliberately. This codebase indexes into byte
arrays constantly, and an out-of-range read that yields `undefined` rather than a
number is exactly the class of bug that produces a frame which is merely wrong
instead of one that throws.

`mobile/jest.config.js`:

```js
module.exports = {
  preset: 'jest-expo',
  collectCoverageFrom: ['src/**/*.{ts,tsx}'],
  // Raised to just under what the suite achieves as each task lands, in the
  // relay/vitest.config.ts style. Starting at zero and never revisiting is how a
  // gate becomes decoration.
  coverageThreshold: { global: { lines: 0, functions: 0, branches: 0, statements: 0 } },
}
```

`mobile/app.json` — minimal for now; icons, splash and store metadata are
sub-project 4. Set the bundle identifiers here so they are stable from the first
build, and set `ITSAppUsesNonExemptEncryption` explicitly to `true`: this app ships
ChaCha20-Poly1305 and X25519, which is not exempt, and the declaration is the most
commonly missed submission gate.

```json
{
  "expo": {
    "name": "Termpolis Remote",
    "slug": "termpolis-remote",
    "version": "1.0.0",
    "orientation": "portrait",
    "scheme": "termpolis",
    "userInterfaceStyle": "dark",
    "ios": {
      "bundleIdentifier": "com.termpolis.remote",
      "supportsTablet": true,
      "infoPlist": { "ITSAppUsesNonExemptEncryption": true }
    },
    "android": { "package": "com.termpolis.remote" },
    "plugins": [
      ["expo-camera", { "cameraPermission": "Termpolis Remote uses the camera only to scan the pairing code shown on your desktop." }]
    ]
  }
}
```

- [ ] **Step 4: Write the entry point**

`mobile/index.ts` — the import order here is not stylistic.

```ts
// MUST be first. `@noble` reads `globalThis.crypto.getRandomValues` at call time
// and React Native does not provide one. Importing this after any module that
// generates a key means the key was drawn from something that is not a CSPRNG --
// a total break that passes every test you would think to write.
import 'react-native-get-random-values'

import { registerRootComponent } from 'expo'
import App from './App'

registerRootComponent(App)
```

`mobile/App.tsx` — placeholder; Task 16 replaces it.

```tsx
import React from 'react'
import { Text, View } from 'react-native'

export default function App(): React.JSX.Element {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text>Termpolis Remote</Text>
    </View>
  )
}
```

React Native components annotate `React.JSX.Element`. The desktop renderer's bare
`JSX.Element` convention comes from its own global JSX namespace and does not
apply in this workspace.

- [ ] **Step 5: Write the failing test**

```ts
// mobile/__tests__/scaffold.test.ts
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
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npm --prefix mobile test`
Expected: FAIL — `Cannot find module '../src/wire/version'`

- [ ] **Step 7: Write the implementation**

```ts
// mobile/src/wire/version.ts

/** Named in SESSION_HELLO, PAIRING_HELLO and PAIRING_ACK. Each is refused if it
 *  carries any other number, and the refusal is reported as a version mismatch
 *  rather than surfacing as an unexplained decryption failure. */
export const PROTOCOL_VERSION = 2

/** The QR envelope's own version, deliberately independent of the protocol's.
 *  A scanner reads this before it knows whether it can speak to this desktop. */
export const QR_ENVELOPE_VERSION = 1
```

- [ ] **Step 8: Run it and watch it pass**

Run: `npm --prefix mobile test` — expect PASS, 2 tests.

- [ ] **Step 9: Wire the repo gates**

`vitest.config.ts` — add `'**/mobile/**'` to the existing `test.exclude`, which
currently reads `['**/node_modules/**', '**/.worktrees/**', '**/e2e/**', '**/relay/**']`.

`tsconfig.test.json` — widen `include` to
`["tests/electron/remote*.ts", "src/main/remoteBridge/**/*", "mobile/src/wire/**/*"]`.

Root `package.json` scripts, beside `test:relay`:

```json
"test:mobile": "npm --prefix mobile test",
"typecheck:mobile": "npm --prefix mobile run typecheck",
```

`.gitignore` — add `mobile/node_modules` and `mobile/.expo`.

- [ ] **Step 10: Prove nothing at the root regressed**

```bash
npm run typecheck && npm run lint && npx vitest run
```

Expected: typecheck clean, lint exit 0, vitest green, and `mobile/`'s jest suite
absent from the vitest run.

- [ ] **Step 11: Commit**

```bash
git add mobile .gitignore vitest.config.ts tsconfig.test.json package.json
git commit -m "feat(remote): scaffold the phone client workspace"
```

---

## Task 2: `wire/bytes.ts` — hex and UTF-8, hand-rolled

**Spec:** wire format §2 (lowercase hex), §10 (the React Native notes).

**Files:**
- Create: `mobile/src/wire/bytes.ts`, `mobile/__tests__/bytes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `toHex(b: Uint8Array): string`, `fromHex(s: string): Uint8Array`,
  `utf8Encode(s: string): Uint8Array`, `utf8Decode(b: Uint8Array): string`,
  `concat(...parts: Uint8Array[]): Uint8Array`,
  `equalBytes(a: Uint8Array, b: Uint8Array): boolean` (constant time).

**Why hand-rolled:** the wire format doc keeps a golden vector whose only purpose
is to catch a `TextEncoder` shim that writes UTF-16 or escapes non-ASCII. Rather
than depend on a platform `TextEncoder` whose behaviour varies by Hermes version
and then test for the variance, this module encodes UTF-8 itself. `fromHex` must
also reject odd-length and non-hex input rather than producing a short array —
`@noble` reports a short scalar as a curve error, which is a poor way to learn a
frame was truncated.

- [ ] **Step 1: Write the failing test**

```ts
// mobile/__tests__/bytes.test.ts
import { concat, equalBytes, fromHex, toHex, utf8Decode, utf8Encode } from '../src/wire/bytes'

describe('hex', () => {
  it('round-trips', () => {
    const b = Uint8Array.from([0x00, 0x0f, 0xa0, 0xff])
    expect(toHex(b)).toBe('000fa0ff')
    expect(fromHex('000fa0ff')).toEqual(b)
  })

  it('emits lowercase, because every id on the wire is lowercase hex', () => {
    expect(toHex(Uint8Array.from([0xab, 0xcd]))).toBe('abcd')
  })

  it('refuses odd length rather than returning a short array', () => {
    // A short array reaches @noble as a short scalar, and a curve library
    // complaining about scalar length is a poor way to learn the input was bad.
    expect(() => fromHex('abc')).toThrow()
  })

  it('refuses non-hex rather than returning NaN bytes', () => {
    expect(() => fromHex('zz')).toThrow()
  })
})

describe('utf8', () => {
  it('encodes ASCII one byte per character', () => {
    expect(utf8Encode('Pixel 9 Pro')).toHaveLength(11)
  })

  it('encodes the vector label as 17 bytes from 13 characters', () => {
    // This is the golden-vector label from wire format §12, and it exists to
    // catch an encoder that writes UTF-16 or escapes non-ASCII.
    const label = 'Téléphone — 9'
    expect(label).toHaveLength(13)
    expect(utf8Encode(label)).toHaveLength(17)
  })

  it('round-trips multi-byte text', () => {
    for (const s of ['', 'a', 'Téléphone — 9', '日本語', '🔒 sealed']) {
      expect(utf8Decode(utf8Encode(s))).toBe(s)
    }
  })

  it('encodes a 4-byte astral character as four bytes', () => {
    expect(utf8Encode('🔒')).toEqual(Uint8Array.from([0xf0, 0x9f, 0x94, 0x92]))
  })
})

describe('concat', () => {
  it('joins in order', () => {
    expect(concat(Uint8Array.from([1]), Uint8Array.from([2, 3]))).toEqual(Uint8Array.from([1, 2, 3]))
  })

  it('handles no parts and empty parts', () => {
    expect(concat()).toEqual(new Uint8Array(0))
    expect(concat(new Uint8Array(0), Uint8Array.from([9]))).toEqual(Uint8Array.from([9]))
  })
})

describe('equalBytes', () => {
  it('compares content, not identity', () => {
    expect(equalBytes(Uint8Array.from([1, 2]), Uint8Array.from([1, 2]))).toBe(true)
    expect(equalBytes(Uint8Array.from([1, 2]), Uint8Array.from([1, 3]))).toBe(false)
  })

  it('is false for different lengths without reading past either end', () => {
    expect(equalBytes(Uint8Array.from([1]), Uint8Array.from([1, 2]))).toBe(false)
  })

  it('does not short-circuit on the first differing byte', () => {
    // Not observable from a unit test, so this asserts the property that makes it
    // possible: every byte is folded in. Both inputs differ only at the last
    // position, and the result must still be false.
    const a = new Uint8Array(32).fill(7)
    const b = new Uint8Array(32).fill(7)
    b[31] = 8
    expect(equalBytes(a, b)).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix mobile test bytes`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mobile/src/wire/bytes.ts`**

Write the six functions. `utf8Encode` walks code points with `codePointAt` and
emits the 1/2/3/4-byte forms; `utf8Decode` reverses it and uses
`String.fromCodePoint`. `fromHex` validates with `/^[0-9a-f]*$/` on a lowercased
copy and rejects odd length before allocating. `equalBytes` accumulates
`diff |= a[i] ^ b[i]` across the whole array and returns `diff === 0`, with a
length check first.

Every function takes and returns real `Uint8Array` — never a Node `Buffer`, which
`@noble` rejects.

- [ ] **Step 4: Run it and watch it pass**

Run: `npm --prefix mobile test bytes` — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/wire/bytes.ts mobile/__tests__/bytes.test.ts
git commit -m "feat(remote): hex and UTF-8 codecs for the phone client"
```

---

## Task 3: `wire/wordlist.ts` + `wire/safetyNumber.ts`

**Spec:** wire format §8.

**Files:**
- Create: `mobile/src/wire/wordlist.ts`, `mobile/src/wire/safetyNumber.ts`,
  `mobile/__tests__/safetyNumber.test.ts`
- Read (do not modify): `src/main/remoteBridge/wordlist.ts`

**Interfaces:**
- Consumes: `toHex`, `utf8Encode` from `wire/bytes`.
- Produces: `SAFETY_WORDS: readonly string[]`,
  `deriveVerificationPhrase(aPublicKeyHex: string, bPublicKeyHex: string): string`.

- [ ] **Step 1: Copy the wordlist verbatim**

```bash
sed 's#^##' src/main/remoteBridge/wordlist.ts > mobile/src/wire/wordlist.ts
```

Then check the copy is byte-identical apart from any comment header, and that the
array still has exactly 256 entries in the original order. One digest byte maps to
one word with **no modulo**; a reordered or short list produces a phrase that is
merely different, which is a phrase the user compares, sees mismatch, and reads as
an attack that is not happening — or worse, the inverse.

- [ ] **Step 2: Write the failing test**

```ts
// mobile/__tests__/safetyNumber.test.ts
import { deriveVerificationPhrase } from '../src/wire/safetyNumber'
import { SAFETY_WORDS } from '../src/wire/wordlist'

const DESKTOP_ID_PK = '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13'
const DEVICE_ID_PK = '0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20'
const GOLDEN = 'hurdle desert ember kelp velvet tundra thicket pebble'

describe('SAFETY_WORDS', () => {
  it('has exactly 256 entries so every digest byte maps without a modulo', () => {
    expect(SAFETY_WORDS).toHaveLength(256)
  })

  it('has no duplicates, so two digests cannot render the same phrase', () => {
    expect(new Set(SAFETY_WORDS).size).toBe(256)
  })
})

describe('deriveVerificationPhrase', () => {
  it('matches the golden vector', () => {
    expect(deriveVerificationPhrase(DESKTOP_ID_PK, DEVICE_ID_PK)).toBe(GOLDEN)
  })

  it('is identical in either order', () => {
    // The sort is what lets both ends render the same words without agreeing on
    // who is "first" -- neither end can know that.
    expect(deriveVerificationPhrase(DEVICE_ID_PK, DESKTOP_ID_PK)).toBe(GOLDEN)
  })

  it('is eight words', () => {
    expect(GOLDEN.split(' ')).toHaveLength(8)
  })

  it('changes completely when one key changes by one bit', () => {
    const flipped = DEVICE_ID_PK.slice(0, 63) + '1'
    expect(deriveVerificationPhrase(DESKTOP_ID_PK, flipped)).not.toBe(GOLDEN)
  })
})
```

- [ ] **Step 3: Run it and watch it fail.** `npm --prefix mobile test safetyNumber`

- [ ] **Step 4: Implement `safetyNumber.ts`** per §8: sort the two hex strings
lexicographically, `SHA-256(utf8(lo ‖ ":" ‖ hi))`, map the first eight digest bytes
through `SAFETY_WORDS`, join with a single space.

- [ ] **Step 5: Run it and watch it pass.**

- [ ] **Step 6: Commit**

```bash
git add mobile/src/wire/wordlist.ts mobile/src/wire/safetyNumber.ts mobile/__tests__/safetyNumber.test.ts
git commit -m "feat(remote): port the safety-number wordlist and derivation"
```

---

## Task 4: `wire/sealedChannel.ts`

**Spec:** wire format §4 (frame layout, header widths), §5.1 (seal, and the
four-step opening order), §5.2 (one key, one direction).

**Files:**
- Create: `mobile/src/wire/sealedChannel.ts`, `mobile/__tests__/sealedChannel.test.ts`

**Interfaces:**
- Consumes: `concat` from `wire/bytes`.
- Produces: `COUNTER_BYTES = 6`, `SEAL_OVERHEAD_BYTES = 22`,
  `writeCounter(buf: Uint8Array, value: number): void`,
  `readCounter(buf: Uint8Array): number`,
  `class SealedSession { constructor(txKey: Uint8Array, rxKey: Uint8Array); seal(header: Uint8Array, plaintext: Uint8Array): Uint8Array; open(frame: Uint8Array, headerBytes: number): Uint8Array | null }`.
  `open` returns `null` on every rejection and **never throws** — a hostile peer
  must not be able to tear down the message handler.

- [ ] **Step 1: Write the failing test.** Cover, at minimum:
  - a seal/open round trip in both directions across two `SealedSession`s;
  - counters increment independently per direction, both starting at 0;
  - a frame shorter than `headerBytes + 22` returns `null` **without** advancing
    the high-water mark (assert by then accepting a legitimate counter-0 frame);
  - a replayed frame returns `null`;
  - a reordered frame (counter lower than high-water) returns `null`;
  - a frame with one flipped ciphertext byte returns `null`;
  - a frame with one flipped **header** byte returns `null` — this is what proves
    the header is the AAD;
  - after a rejected frame, the *next* legitimate frame still opens — the
    high-water mark must not have advanced;
  - a session cannot open the frame it sealed itself (reflection).

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement.** `writeCounter` writes 6-byte big-endian; `readCounter`
reads it back. The nonce is `6 zero bytes ‖ counter`. `open` follows §5.1's order
exactly: length check, counter-vs-high-water check, decrypt with
`aad = frame.subarray(0, headerBytes)`, and only then advance. High-water starts at
`-1`. Wrap the decrypt in try/catch and return `null`.

- [ ] **Step 4: Run it and watch it pass.**

- [ ] **Step 5: Commit**

```bash
git add mobile/src/wire/sealedChannel.ts mobile/__tests__/sealedChannel.test.ts
git commit -m "feat(remote): sealed channel for the phone client"
```

---

## Task 5: `wire/sessionCrypto.ts`

**Spec:** wire format §4 (tags), §5.2 (direction keys), §6.1 (session handshake),
§6.2 (the session room), §6.3 (the pairing root).

**Files:**
- Create: `mobile/src/wire/sessionCrypto.ts`, `mobile/__tests__/sessionCrypto.test.ts`

**Interfaces:**
- Consumes: `wire/bytes`, `wire/sealedChannel`, `wire/version`.
- Produces:
  - `type Role = 'desktop' | 'device'`
  - `FRAME_KEEPALIVE = 0x00`, `FRAME_PAIRING_HELLO = 0x01`,
    `FRAME_PAIRING_ACK = 0x02`, `FRAME_SESSION_HELLO = 0x03`, `FRAME_SESSION = 0x04`
  - `SESSION_HEADER_BYTES = 1`, `GREETING_HEADER_BYTES = 33`
  - `sessionFromRoot(root: Uint8Array, role: Role): SealedSession`
  - `deriveSessionRoomId(ownSecretKeyHex: string, peerPublicKeyHex: string): string`
  - `pairingRoot(ownSecretKeyHex: string, peerPublicKeyHex: string, pairingId: string): Uint8Array`
  - `generateIdentity(): { secretKey: string; publicKey: string }`
  - `class Handshake` — `greeting(): Uint8Array`, and
    `accept(frame: Uint8Array): SealedSession | null`.

**The one that fails silently:** `sessionFromRoot` maps role to direction. A device
seals with `p2d` and opens with `d2p`. Getting this backwards does not throw — it
produces a session that seals frames the desktop cannot open and opens nothing,
and the socket stays connected and looks healthy throughout.

- [ ] **Step 1: Write the failing test.** Pin the golden vectors from §12 —
these are the gate, so write them as literals, not as computed values:
  - `desktopIdSk = 0x11 × 32` derives
    `desktopIdPk = 7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13`
  - `deviceIdSk = 0x22 × 32` derives
    `deviceIdPk = 0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20`
  - `deriveSessionRoomId` from either side is `c9dc49b87f0dc983be61f034ceab7c52`
    and matches `^[0-9a-f]{32}$`
  - `pairingRoot(·, ·, '0123456789abcdef0123456789abcdef')` from either side is
    `4bc2d5c4a6e0afc1271ef4bc1d5abbadcdbd6c8ab1d20580a76fcf84c7413762`
  - the two `SESSION_HELLO` frames, desktop then device, byte for byte
  - the three `SESSION` frames — desktop→phone counters 0 and 1 under the same
    key, then phone→desktop counter 0, proving the two directions count independently

Also cover the rejection paths, which the vectors cannot:
  - a greeting shorter than 33 bytes is refused;
  - a greeting whose `frame[0]` is not `0x03` is refused;
  - a greeting whose payload `v` is not `2` is refused **and is distinguishable
    from a decryption failure** — an old phone against a new desktop must be able
    to report a version mismatch;
  - a greeting whose `role` equals your own is refused;
  - two `Handshake`s, one per side, agree on the same session root.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement** per §5.2, §6.1, §6.2, §6.3. Note two traps the wire
doc calls out: build a **fresh** handshake-root session for the seal and for the
open (they are independent counters that both start at zero, so reusing one object
makes the second operation fail), and the session-root `ikm` is
ephemeral-DH-first, which is not negotiable.

- [ ] **Step 4: Run it and watch it pass.**

- [ ] **Step 5: Commit**

```bash
git add mobile/src/wire/sessionCrypto.ts mobile/__tests__/sessionCrypto.test.ts
git commit -m "feat(remote): session key schedule and handshake for the phone"
```

---

## Task 6: `wire/pairing.ts` and `wire/qr.ts`

**Spec:** wire format §7.1 (QR payload), §7.3 (`PAIRING_HELLO`), §7.4
(`PAIRING_ACK`), §7.5 (afterwards).

**Files:**
- Create: `mobile/src/wire/pairing.ts`, `mobile/src/wire/qr.ts`,
  `mobile/__tests__/pairing.test.ts`, `mobile/__tests__/qr.test.ts`

**Interfaces:**
- Consumes: `wire/bytes`, `wire/sealedChannel`, `wire/sessionCrypto`, `wire/version`.
- Produces:
  - `interface QrPayload { v: number; relayUrl: string; pairingId: string; desktopPublicKey: string; oneTimeSecret: string }`
  - `parseQrPayload(raw: string): QrPayload | null`
  - `deviceIdFor(devicePublicKeyHex: string): string`
  - `sealPairingHello(opts: { deviceSecretKey: string; devicePublicKey: string; desktopPublicKey: string; pairingId: string; label: string; oneTimeSecret: string }): Uint8Array`
  - `openPairingAck(opts: { frame: Uint8Array; deviceSecretKey: string; desktopPublicKey: string; pairingId: string }): { deviceId: string } | null`

**`parseQrPayload` validates before it trusts.** It is fed by a camera pointed at
an arbitrary surface. Reject: non-JSON; `v !== QR_ENVELOPE_VERSION`; a `relayUrl`
that is not `wss:`; a `pairingId` that is not `^[0-9a-f]{32}$`; a
`desktopPublicKey` or `oneTimeSecret` that is not `^[0-9a-f]{64}$`. Return `null`
rather than throwing — a scan of a cereal box should show "that is not a pairing
code", not a crash.

- [ ] **Step 1: Write the failing tests.**

For `qr.test.ts`: a good payload parses; each of the five rejections above returns
`null`; an `http://` or `ws://` relay URL is refused (the transport is not
negotiable); extra unknown fields are tolerated, because the QR envelope versions
independently and a future desktop may add one.

For `pairing.test.ts`, pin from §12:
  - `deviceIdFor(deviceIdPk) === '12faa049f0ec7720'`
  - `sealPairingHello` with label `Pixel 9 Pro` equals the first golden frame
  - `sealPairingHello` with label `Téléphone — 9` equals the second golden frame —
    this is the UTF-8 gate, and it must be a literal comparison against the vector
  - `openPairingAck` on the golden `PAIRING_ACK` yields `deviceId 12faa049f0ec7720`
  - a `PAIRING_ACK` sealed under a *different* `pairingId` returns `null`, proving
    the salt binding: without it, an ack captured from one offer replays into the
    next offer the same desktop shows
  - a tampered ack returns `null` rather than throwing

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement.** `sealPairingHello` header is
`0x01 ‖ devicePublicKey[32]`, sealed on a fresh pairing-root session at counter 0
with the device's tx key. `openPairingAck` opens `headerBytes = 1` on a **fresh**
session built from the pairing root — that freshness is what lets the phone open
the ack without having kept the session it sealed its own hello with.

- [ ] **Step 4: Run them and watch them pass.**

- [ ] **Step 5: Commit**

```bash
git add mobile/src/wire/pairing.ts mobile/src/wire/qr.ts mobile/__tests__/pairing.test.ts mobile/__tests__/qr.test.ts
git commit -m "feat(remote): pairing frames and QR parsing for the phone"
```

---

## Task 7: `wire/protocol.ts` — payload types and envelope guards

**Spec:** wire format §9.

**Files:**
- Create: `mobile/src/wire/protocol.ts`, `mobile/__tests__/protocol.test.ts`

**Interfaces:**
- Consumes: nothing outside `wire/`.
- Produces: `RemoteRequest`, `RemoteEnvelope`, `OutputChunk`, `OutputPayload`,
  `RemoteResponse`, `RemoteMessage`, `Capabilities`, and
  `parseRemoteMessage(plaintext: Uint8Array): RemoteMessage | null`.

The type union must match `src/main/remoteBridge/protocol.ts` exactly. The desktop
file carries a comment recording why: a previous `RemoteResponse` declared an
`output` variant with a `chunk` field that nothing constructed, while the bridge
actually sent an `OutputPayload` with `chunks`. A phone reading `.chunk` off that
gets `undefined` for every field, with no error anywhere. Read the desktop file
and mirror it rather than retyping from the doc.

**`parseRemoteMessage` returns `null` on anything it does not recognise and never
throws.** §9: a frame that does not open, or that opens and is not a valid
envelope, is dropped silently — and neither may throw out of the message handler,
because an unhandled rejection there tears down a connection a hostile phone could
then drop at will. The same discipline applies in the other direction.

- [ ] **Step 1: Write the failing test.** Cover: each of the four desktop→phone
shapes parses; malformed JSON returns `null`; valid JSON with an unknown `kind`
returns `null`; an `output` message with a non-array `chunks` returns `null`; an
`output` chunk missing `terminalId` returns `null`; a `status` message carries
`terminalId`, `status` and `summary` through unchanged; nothing throws for any
input, asserted over a table of hostile strings including `'null'`, `'[]'`,
`'{"kind":"ok"}'` (no `id`) and a 1 MiB string.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement**, mirroring the desktop union and guarding every field
that is read.

- [ ] **Step 4: Run it and watch it pass.**

- [ ] **Step 5: Commit**

```bash
git add mobile/src/wire/protocol.ts mobile/__tests__/protocol.test.ts
git commit -m "feat(remote): application payload types and guards for the phone"
```

---

## Task 8: The interop gate — the phone's wire code against the real desktop

This is the task the whole `wire/` split exists for. Golden vectors prove the port
matches a recording; this proves it matches the *implementation*, on every root CI
run, in both directions, including the paths no vector covers.

**Files:**
- Create: `tests/electron/remoteMobileInterop.test.ts`

**Interfaces:**
- Consumes: `mobile/src/wire/*` and `src/main/remoteBridge/*` — both as TypeScript
  sources, both under root vitest. No build step, so a source change on either side
  fails here immediately rather than at the next `npm run build`.
- Produces: nothing. It is a gate.

- [ ] **Step 1: Write the test.** There is no red-then-green cycle here: every
module it imports already exists and already passes its own suite. The test is
red only if the port is wrong, which is the point.

Structure it as one `describe` per protocol stage, mirroring
`scripts/remote-test-client.cjs` but with the phone side supplied by
`mobile/src/wire` rather than by the desktop's own modules:

  1. **Pairing.** Desktop mints an offer; phone parses the QR payload with
     `parseQrPayload`; phone seals a `PAIRING_HELLO` with
     `mobile/src/wire/pairing`; desktop opens it with its own `openPairingHello`
     and pairs. Assert the desktop derives the same `deviceId` the phone does.
  2. **The ack.** Desktop seals `PAIRING_ACK`; phone opens it with
     `mobile/src/wire/pairing`. Assert the deviceId matches.
  3. **The safety number.** Both sides derive it independently — desktop with
     `src/main/remoteBridge`, phone with `mobile/src/wire/safetyNumber` — and the
     two strings are equal. This is the assertion that would catch a wordlist
     that drifted by one entry.
  4. **The session room.** Both sides derive it independently and agree. A port
     that got this wrong would not fail a handshake; it would sit in an empty room
     forever, and this is the only place that shows up as a failure rather than a
     hang.
  5. **The session handshake.** Both greet; both accept; the resulting sessions
     seal and open each other's frames.
  6. **A request/response round trip.** Phone seals
     `{"id":1,"request":{"kind":"listTerminals"}}`, desktop opens and answers,
     phone opens the answer and parses it with `parseRemoteMessage`.
  7. **Rejections, phone-side.** The desktop's frames, tampered: a flipped
     ciphertext byte, a flipped header byte, a replay, and the phone's own frame
     reflected back. Each must return `null` from the phone's `open` — not throw.
  8. **Direction independence.** Desktop→phone counter 1 opens after counter 0,
     while phone→desktop is still at its own counter 0.

- [ ] **Step 2: Run it**

```bash
npx vitest run tests/electron/remoteMobileInterop.test.ts
```

Expected: PASS. If it fails, the failure is in `mobile/src/wire` — the desktop side
is already gated by `tests/electron/remoteWireVectors.test.ts` and the smoke
client.

- [ ] **Step 3: Prove it is actually in the root gate**

```bash
npm run typecheck:test && npx vitest run --coverage
```

`typecheck:test` must now be typechecking `mobile/src/wire/**` through the
`tsconfig.test.json` include added in Task 1. Confirm by introducing a deliberate
type error in a wire file, watching `typecheck:test` fail, then reverting it.

- [ ] **Step 4: Commit**

```bash
git add tests/electron/remoteMobileInterop.test.ts
git commit -m "test(remote): gate the phone's wire port against the desktop bridge"
```

---

## Task 9: `net/relaySocket.ts`

**Spec:** wire format §3 in full — §3.1 connecting, §3.2 binary-only, §3.3 control
frames, §3.4 the greeting rule, §3.5 quotas, §3.6 keepalive. Plus §10, all six
mistakes, four of which live in this file.

**Files:**
- Create: `mobile/src/net/relaySocket.ts`, `mobile/__tests__/relaySocket.test.ts`

**Interfaces:**
- Consumes: `wire/sessionCrypto` (frame tags), `wire/sealedChannel`.
- Produces:
  - `type RelayState = 'connecting' | 'online' | 'attached' | 'offline' | 'blocked'`
  - `interface SocketLike` — the minimum of the WebSocket surface this uses, so
    tests supply a fake and never open a real socket.
  - `interface RelaySocketDeps { url: string; roomId: string; open(url: string): SocketLike; onFrame(frame: Uint8Array): void; onControl(c: RelayControlFrame): void; onState(s: RelayState): void; now(): number; setTimer(fn: () => void, ms: number): unknown; clearTimer(t: unknown): void }`
  - `class RelaySocket { connect(): void; send(frame: Uint8Array): void; close(): void }`
  - `backoffDelay(attempt: number): number`

Timers and socket construction are injected because every behaviour worth testing
here is a timing behaviour, and a suite that waits 120 real seconds to check one
keepalive is a suite nobody runs.

**The five things this file must get right, each of which fails silently:**

1. **`binaryType = 'arraybuffer'`, set before anything is sent.** React Native's
   WebSocket defaults to `'blob'`, and `send()` does not accept a Blob — it
   coerces to a string, so the far end receives the literal text
   `"[object Blob]"`. Every byte of every sealed frame is destroyed and the
   connection still looks healthy, because the frame count and the timing are right.
2. **Send binary only.** Peer text is dropped unread by the relay, unreported. A
   client that sends its frames as text does nothing at all, silently, forever.
3. **The greeting rule.** Greet on `hello` with `"peer": true`; wait on
   `"peer": false`; greet on `peer-joined`. Greeting on socket-open is the single
   most expensive mistake available here.
4. **`peer-gone` clears the session.** Whoever takes the role next is a different
   connection with a different ephemeral key; holding the old session routes their
   greeting down the frame path, where it cannot open, leaving a socket that is
   connected, attached and permanently mute.
5. **Keepalive every 120 s, and drop an inbound `KEEPALIVE` by tag before
   consulting any key.** One that reached the greeting path would fail to open and
   cost the connection — for a frame whose entire purpose is to keep it.

- [ ] **Step 1: Write the failing test.** With a fake `SocketLike` and injected
timers, cover:
  - `binaryType` is set to `'arraybuffer'` on the socket before `connect` returns;
  - the URL is `wss://<host>/v1/pair/<roomId>?role=device`;
  - a room id failing `^[0-9a-f]{32}$` is refused before any socket is opened;
  - `hello{peer:false}` does **not** greet; the subsequent `peer-joined` does;
  - `hello{peer:true}` greets immediately;
  - `peer-gone` clears the session, keeps the socket, and reports state `online`,
    not `offline`;
  - a `KEEPALIVE` frame is emitted every 120 s while seated, and it is exactly
    `Uint8Array.from([0x00])`;
  - an inbound `0x00` frame is dropped and never reaches `onFrame`;
  - `quota-exceeded` with `frame-size` or `frame-rate` latches: state becomes
    `blocked` and no reconnect is scheduled, however long the test runs;
  - `quota-exceeded` with `idle` or `connection-bytes` **does** reconnect — never
    redialing on an idle cut takes remote dark until the app restarts;
  - a `409` close does not retry in a tight loop;
  - unparseable control text, and a control frame of an unknown kind, are dropped
    without disconnecting — the relay is untrusted and a control frame is a hint,
    never an instruction worth a disconnect;
  - `backoffDelay` is monotonic, jittered, and capped.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement.** Mirror `src/main/remoteBridge/relayClient.ts` where
the behaviour is shared — it already solved all five traps — but do not import it;
this is a second implementation on purpose.

- [ ] **Step 4: Run it and watch it pass.**

- [ ] **Step 5: Commit**

```bash
git add mobile/src/net/relaySocket.ts mobile/__tests__/relaySocket.test.ts
git commit -m "feat(remote): relay socket for the phone client"
```

---

## Task 10: `net/remoteSession.ts`

**Spec:** wire format §9.

**Files:**
- Create: `mobile/src/net/remoteSession.ts`, `mobile/__tests__/remoteSession.test.ts`

**Interfaces:**
- Consumes: `wire/protocol`, `wire/sealedChannel`, `net/relaySocket`.
- Produces:
  - `class RemoteSession` with
    `request<T>(req: RemoteRequest, timeoutMs?: number): Promise<T>`,
    `onOutput(cb: (chunks: OutputChunk[]) => void): () => void`,
    `onStatus(cb: (s: { terminalId: string; status: string; summary: string }) => void): () => void`,
    `handleFrame(plaintext: Uint8Array): void`.

- [ ] **Step 1: Write the failing test.** Cover:
  - `request` correlates by `id` and resolves the matching `ok`;
  - an `error` response rejects with its `message`;
  - ids increment and two concurrent requests resolve to their own answers, not
    to each other's;
  - an unsolicited `output` message reaches `onOutput` and resolves no request;
  - an `ok` for an unknown id is dropped and does not throw;
  - a response arriving after a timeout is dropped and does not throw;
  - `handleFrame` never throws for any input — table-drive it with the same
    hostile inputs as Task 7;
  - a request larger than `1048576 - 1 - 22` bytes is refused **locally** with a
    clear error rather than sent, because the relay cuts an oversized frame rather
    than truncating it, which reads to a user as an unreliable network;
  - unsubscribing a callback stops delivery.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run it and watch it pass.**

- [ ] **Step 5: Commit**

```bash
git add mobile/src/net/remoteSession.ts mobile/__tests__/remoteSession.test.ts
git commit -m "feat(remote): request correlation and output routing for the phone"
```

---

## Task 11: `storage/identity.ts`

**Spec:** wire format §7.5.

**Files:**
- Create: `mobile/src/storage/identity.ts`, `mobile/__tests__/identity.test.ts`

**Interfaces:**
- Consumes: `wire/sessionCrypto` (`generateIdentity`), `expo-secure-store`.
- Produces:
  - `interface PairedDesktop { desktopPublicKey: string; sessionRoomId: string; relayUrl: string; deviceId: string; label: string; pairedAt: number }`
  - `loadIdentity(): Promise<{ secretKey: string; publicKey: string }>` — mints and
    persists on first call, returns the same keypair thereafter
  - `loadPaired(): Promise<PairedDesktop | null>`
  - `savePaired(d: PairedDesktop): Promise<void>`
  - `clearPaired(): Promise<void>` — unpair
  - `wipeIdentity(): Promise<void>` — used only by the "forget this phone" path

**Both keys go in SecureStore with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.** The private
key is the whole of the phone's authority: anyone holding it is the paired device.
`THIS_DEVICE_ONLY` also keeps it out of an iCloud keychain backup, so restoring a
backup onto a second handset does not silently produce two devices the desktop
cannot tell apart. The one-time secret is **never** persisted — §7.5 requires it be
discarded, and a test asserts it never reaches SecureStore.

- [ ] **Step 1: Write the failing test.** Mock `expo-secure-store` with an
in-memory map. Cover: first `loadIdentity` mints and writes; the second returns the
same keypair without writing again; the write uses
`keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY`; `savePaired` /
`loadPaired` round-trip; `loadPaired` returns `null` when nothing is stored and
also when the stored JSON is corrupt, rather than throwing; `clearPaired` leaves
the identity intact; `wipeIdentity` removes both; and no call anywhere writes a
value containing the one-time secret.

- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it and watch it pass.**
- [ ] **Step 5: Commit**

```bash
git add mobile/src/storage/identity.ts mobile/__tests__/identity.test.ts
git commit -m "feat(remote): keystore-backed identity for the phone client"
```

---

## Task 12: `state/remoteStore.ts`

**Files:**
- Create: `mobile/src/state/remoteStore.ts`, `mobile/__tests__/remoteStore.test.ts`

**Interfaces:**
- Consumes: `net/relaySocket`, `net/remoteSession`, `storage/identity`,
  `wire/pairing`, `wire/qr`, `wire/safetyNumber`, `zustand`, React Native's
  `AppState`.
- Produces: `useRemoteStore` — a zustand store, matching the desktop's convention.
  State: `status: RelayState`, `paired: PairedDesktop | null`,
  `safetyPhrase: string | null`, `terminals: TerminalSummary[]`,
  `output: Record<string, string>`, `stale: boolean`, `error: string | null`.
  Actions: `boot()`, `pairFromQr(raw: string, label: string)`, `unpair()`,
  `refreshTerminals()`, `subscribe(id)`, `unsubscribe(id)`, `send(id, text)`,
  `runCommand(id, cmd)`, `createTerminal(name, cwd?)`, `closeTerminal(id)`.

**Two behaviours the spec calls for by name:**

- **Offline shows last-known state, clearly marked stale, and queues nothing.**
  `stale` is set the moment the socket leaves `attached`, and every write action
  refuses while stale rather than buffering. Work must not silently execute later —
  a queued `runCommand` that fires on reconnect is arbitrary shell execution the
  user has stopped expecting.
- **AppState.** Reconnect on foreground; drop the socket on background. Android
  fires `change` more eagerly than iOS, so debounce the foreground transition
  (250 ms) or a task-switcher swipe produces a reconnect storm.

- [ ] **Step 1: Write the failing test.** With `net/*` and `storage/*` mocked:
  - `boot()` with nothing paired lands in `paired: null` and does not open a socket;
  - `boot()` with a stored pairing connects to the **stored** `sessionRoomId`;
  - `pairFromQr` on a malformed payload sets `error` and does not touch storage;
  - `pairFromQr` on a good payload stores the pairing and computes `safetyPhrase`;
  - losing `attached` sets `stale: true`;
  - every write action rejects while `stale` and nothing is queued — assert the
    session received no request;
  - regaining `attached` clears `stale` and refreshes the terminal list;
  - output chunks append to the right terminal, and a chunk with `missed > 0`
    inserts its `marker` exactly once;
  - `unpair()` clears storage and closes the socket;
  - the AppState foreground transition is debounced: two `change` events 50 ms
    apart produce one reconnect.

- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it and watch it pass.**
- [ ] **Step 5: Commit**

```bash
git add mobile/src/state/remoteStore.ts mobile/__tests__/remoteStore.test.ts
git commit -m "feat(remote): phone client state store"
```

---

## Task 13: `ansi/render.ts`

**Spec:** design spec §6 — read-mostly, the ANSI subset the agent CLIs actually
emit, monospace, selectable, with the skipped-output markers from §5.2.

**Files:**
- Create: `mobile/src/ansi/render.ts`, `mobile/__tests__/ansiRender.test.ts`

**Interfaces:**
- Produces: `interface Segment { text: string; fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean }`
  and `renderAnsi(input: string): Segment[]`.

Full xterm emulation is explicitly not warranted here. Support SGR (`ESC[…m`) for
the 8 standard colours, their bright variants, 256-colour (`38;5;n`), truecolour
(`38;2;r;g;b`), bold/dim/italic/underline and reset. **Strip** cursor movement,
erase, scroll-region and OSC sequences rather than attempting them — a phone view
is a scrollback, not a grid, and a half-implemented cursor move corrupts text in a
way that stripping never does.

- [ ] **Step 1: Write the failing test.** Cover: plain text is one segment;
`ESC[31m` sets red and `ESC[0m` resets; nested attributes accumulate and reset
together; `ESC[38;5;208m` and `ESC[38;2;10;20;30m` parse; an unterminated escape at
end of input is dropped rather than emitted as text; cursor and erase sequences are
stripped; an OSC title sequence terminated by `BEL` and one terminated by `ESC\`
are both stripped; a lone `ESC` is dropped; CRLF and bare CR are normalised; and a
1 MiB input returns in reasonable time without quadratic string building.

- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it and watch it pass.**
- [ ] **Step 5: Commit**

```bash
git add mobile/src/ansi/render.ts mobile/__tests__/ansiRender.test.ts
git commit -m "feat(remote): ANSI subset renderer for the phone client"
```

---

## Task 14: Screens — pair and safety number

**Spec:** design spec §6 (pairing flow), §9 (the safety number is compared, not
merely displayed).

**Files:**
- Create: `mobile/src/screens/PairScreen.tsx`,
  `mobile/src/screens/SafetyNumberScreen.tsx`,
  `mobile/__tests__/pairScreen.test.tsx`,
  `mobile/__tests__/safetyNumberScreen.test.tsx`

**Interfaces:**
- Consumes: `state/remoteStore`, `expo-camera` (`CameraView`,
  `useCameraPermissions`).
- Produces: `PairScreen`, `SafetyNumberScreen` — both default-exported React
  components taking no props; they read and drive the store.

`PairScreen` asks for camera permission, scans a QR, and hands the raw string to
`pairFromQr`. Three states with no fourth, mirroring the desktop's `PairingModal`:
permission not yet granted (explain why the camera is needed, then a button),
permission denied (explain how to fix it in Settings, plus a manual-entry field —
the desktop already offers the payload as text for exactly this), and scanning.

`SafetyNumberScreen` shows the eight words with the same instruction the desktop
carries: read them against the other screen; if they differ, unpair. **Both a
"They match" and a "They do not match" control.** A screen with only a Continue
button trains the user to tap through, which is how safety numbers stop working.
"Do not match" unpairs immediately.

- [ ] **Step 1: Write the failing test.** With `expo-camera` mocked and the store
  mocked: permission-undetermined renders the rationale and a request button, and
  requests only on press; denied renders the manual-entry path; the scan callback
  passes the **raw** scanned string through untouched; a scan while
  `paired !== null` is ignored (double-fire is normal on both platforms); the
  safety screen renders all eight words from the store; "do not match" calls
  `unpair`; and no screen ever renders the identity secret — assert the rendered
  tree contains no 64-hex-char string other than the desktop public key.

- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it and watch it pass.**
- [ ] **Step 5: Commit**

```bash
git add mobile/src/screens/PairScreen.tsx mobile/src/screens/SafetyNumberScreen.tsx mobile/__tests__/pairScreen.test.tsx mobile/__tests__/safetyNumberScreen.test.tsx
git commit -m "feat(remote): pairing and safety-number screens"
```

---

## Task 15: Screens — terminal list and terminal view

**Spec:** design spec §6 — list the running terminals, open one, read output,
send input, start a new AI terminal.

**Files:**
- Create: `mobile/src/screens/TerminalListScreen.tsx`,
  `mobile/src/screens/TerminalScreen.tsx`,
  `mobile/src/components/OutputView.tsx`,
  `mobile/__tests__/terminalListScreen.test.tsx`,
  `mobile/__tests__/terminalScreen.test.tsx`

**Interfaces:**
- Consumes: `state/remoteStore`, `ansi/render`.
- Produces: `TerminalListScreen`, `TerminalScreen`, and
  `OutputView({ text }: { text: string })` — the ANSI-rendered scrollback.

The list shows name, cwd and busy state, pulls to refresh, and offers "New AI
terminal" **only when `createTerminal` is granted**. The terminal view subscribes
on mount and unsubscribes on unmount, keeps the scroll pinned to the bottom unless
the user has scrolled up, and renders a divider where the desktop reported dropped
output — §5.2's `marker` exists precisely so the phone never presents a gap as if
it were continuous.

**Capability-gated controls are hidden, not merely disabled.** A visible control
that always fails is a bug report; the desktop is the authority and the phone
reflects what it granted.

- [ ] **Step 1: Write the failing test.** With the store mocked: the list renders
  one row per terminal; the new-terminal control is absent without
  `createTerminal` and present with it; pull-to-refresh calls `refreshTerminals`;
  opening a terminal calls `subscribe` once and unmounting calls `unsubscribe`
  once; the input box and send control are absent without `writeToTerminal`; send
  calls `send` with the exact text and clears the box; the composer is disabled
  while `stale` and shows the offline notice; the skipped-output marker renders;
  and `OutputView` renders coloured segments from `renderAnsi` rather than raw
  escape bytes.

- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it and watch it pass.**
- [ ] **Step 5: Commit**

```bash
git add mobile/src/screens/TerminalListScreen.tsx mobile/src/screens/TerminalScreen.tsx mobile/src/components/OutputView.tsx mobile/__tests__/terminalListScreen.test.tsx mobile/__tests__/terminalScreen.test.tsx
git commit -m "feat(remote): terminal list and terminal screens"
```

---

## Task 16: Settings, unpair, and the app shell

**Spec:** design spec §6 (unpair from the phone), §9 (the phone can end the
relationship without reaching the desktop).

**Files:**
- Create: `mobile/src/screens/SettingsScreen.tsx`, `mobile/src/App.tsx` (replacing
  the Task 1 placeholder), `mobile/__tests__/settingsScreen.test.tsx`,
  `mobile/__tests__/appShell.test.tsx`
- Modify: `mobile/index.ts` (unchanged in content — verify the
  `react-native-get-random-values` import is still the first line)

**Interfaces:**
- Consumes: `state/remoteStore`, `@react-navigation/native`,
  `@react-navigation/native-stack`.
- Produces: `SettingsScreen`; `App` — the navigator.

Settings shows which desktop is paired, its safety phrase, the granted
capabilities as read-only facts (the desktop grants; the phone cannot), the
connection state, this device's id and the app version, and an unpair control
behind a confirmation.

**Unpair is local and unconditional.** It clears storage and closes the socket
whether or not the relay is reachable — a phone that can only be unpaired while
online is a phone that cannot be unpaired when it matters. The desktop keeps its
own revoke, and either side ending it is sufficient: the session key cannot be
re-derived without both identities.

Navigation: `Pair` when nothing is stored, otherwise `Terminals` as the root, with
`Terminal`, `SafetyNumber` and `Settings` pushed above it. `boot()` runs once on
mount.

- [ ] **Step 1: Write the failing test.** Settings renders the paired label,
  phrase, capabilities and device id; unpair prompts first and only calls
  `unpair` on confirm; unpair still calls it while `stale`; the identity secret
  never appears in the tree. Shell: unpaired boots to `Pair`; paired boots to
  `Terminals`; `boot()` is called exactly once across a re-render; completing a
  pairing navigates to `SafetyNumber`; unpairing returns to `Pair`.

- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it and watch it pass.**
- [ ] **Step 5: Commit**

```bash
git add mobile/src/screens/SettingsScreen.tsx mobile/src/App.tsx mobile/__tests__/settingsScreen.test.tsx mobile/__tests__/appShell.test.tsx
git commit -m "feat(remote): settings, unpair and the phone app shell"
```

---

## Task 17: Full gate, docs, and close-out

**Files:**
- Modify: `README.md`, `docs/remote-wire-format.md` (a pointer to the mobile
  implementation, nothing normative), `mobile/README.md` (create)
- Verify: `vitest.config.ts`, `tsconfig.test.json`, `.github/workflows/ci.yml`

- [ ] **Step 1: Run the mobile gate.**

```bash
cd mobile && npm run typecheck && npm run test:coverage
```

Expected: exit 0, all four floors clear. Mobile thresholds are set just under
achieved, per the `relay/` convention. `src/wire/**` and `src/net/**` should sit at
or very near 100% — they are pure and fully reachable; screens will be lower.
If a floor fails, **backfill tests**; never lower a threshold.

- [ ] **Step 2: Run the root gate, which now includes the interop test.**

```bash
export PATH="/c/Program Files/Git/cmd:$PATH"
npm run lint && npm run typecheck && npm run test:coverage
```

Expected: exit 0 with lines ≥ 97 / functions ≥ 96 / branches ≥ 95 /
statements ≥ 96, and `tests/electron/remoteMobileInterop.test.ts` among the
passing files. This is the gate that matters: it proves the phone's bytes and the
desktop's bytes are the same bytes, on every CI run, without a device.

- [ ] **Step 3: Confirm CI actually runs both.** Read
  `.github/workflows/ci.yml`. The root job must pick up the interop test with no
  change (it lives under `tests/electron/`, already in scope). Add a `mobile` job
  mirroring the `relay` job — `npm ci` then `npm run lint && npm run typecheck &&
  npm run test:coverage`, working directory `mobile`. If the relay job is
  `ubuntu-latest`, match it; the mobile unit tests are platform-independent.

- [ ] **Step 4: Write `mobile/README.md`.** How to run it (`npx expo start`,
  Expo Go for the JS-only paths, a dev build for the camera), how to point it at a
  relay, that `src/wire/` is pure by contract and why, and that
  `tests/electron/remoteMobileInterop.test.ts` is the cross-implementation gate —
  so the next person to add an RN import to `wire/` learns what it breaks before
  they break it.

- [ ] **Step 5: Update the root `README.md`.** One short section under the remote
  feature: the phone app exists, it is pass-through only, it holds no memory or
  model credentials, and pairing requires physical access to the desktop screen.

- [ ] **Step 6: Add the pointer to `docs/remote-wire-format.md`.** A single line
  naming `mobile/src/wire/` as the second implementation, and stating the doc
  stays normative for both. Change nothing else in that file — it is the source of
  truth both sides are tested against, and editing it to match an implementation
  inverts the relationship.

- [ ] **Step 7: Tick this plan's checkboxes and commit.**

```bash
git add -A
git commit -m "docs(remote): phone client docs and CI gate"
git push origin main
```

- [ ] **Step 8: Verify CI is green.**

```bash
gh run list --limit 3
```

Wait for the run to finish and confirm success. A red root gate here means the
interop test found a real disagreement between the two implementations — fix the
**phone**, not the wire doc.

---

## Self-Review

**Spec coverage.** §6's phone surface: pair by QR (Task 14), compare the safety
number (14), list terminals (15), read output with skip markers (13, 15), send
input (15), start an AI terminal (15), unpair (16), offline shows stale state and
queues nothing (12). §7's wire: bytes (2), safety number (3), sealed channel (4),
session crypto (5), pairing and QR (6), message types (7), relay socket (9),
session (10), key storage (11). Notifications are **deliberately out of scope** —
recorded here as the one §6 item not built, pending the Expo push token; the
resolved decision (pairing id and state only, never a terminal name) is in the
spec so whoever builds it inherits it.

**Placeholders.** None. Every task names its files, its interfaces, and the
specific behaviours its tests assert. Where a task's algorithm is already fixed by
`docs/remote-wire-format.md`, the task cites the section rather than restating the
bytes — a second copy of a wire format is a second source of truth, and the golden
vectors in §12 are what the tests actually assert against.

**Type consistency.** `PairedDesktop` (11) is what `remoteStore` (12) stores and
`SettingsScreen` (16) renders. `TerminalSummary` and `OutputChunk` come from
`wire/protocol.ts` (7), are routed by `remoteSession` (10), and are consumed by the
screens (15) — one definition, imported. `RelayState` is produced by `relaySocket`
(9) and surfaced by the store (12). `Segment` is produced by `ansi/render` (13) and
consumed only by `OutputView` (15).

**The load-bearing structural claim, restated.** `mobile/src/wire/` imports nothing
from React Native, Expo, or Node. That is what lets Task 8 run the phone's own
crypto against the real desktop bridge inside root vitest, on every push, with no
simulator and no device. If an RN import ever lands in `wire/`, that gate stops
running — and it will stop running *silently*, because the test will simply fail to
import rather than fail an assertion. Task 4's purity test and Task 17's typecheck
are both there to make that loud.
