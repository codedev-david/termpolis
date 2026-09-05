# Termpolis Remote Bridge (Sub-project 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the desktop-side Remote Bridge — an Electron `utilityProcess` that pairs with a remote client over a sealed channel and proxies terminal control to the local MCP server — verifiable end-to-end by a CLI test client, with no mobile code and no relay service.

**Architecture:** The bridge runs as a second main-process entry point (following the existing `headroomProxy` precedent) spawned and supervised from main (following the existing `memoryClient` precedent). It holds exactly one outward capability: HTTP to `127.0.0.1:<mcpPort>` with the existing bearer token. All remote traffic is X25519 + ChaCha20-Poly1305 sealed frames. Main provisions the identity key (because `safeStorage` is unavailable in a `utilityProcess`) and supervises restarts; the bridge does the rest.

**Tech Stack:** TypeScript, Electron `utilityProcess`, `@noble/curves` + `@noble/ciphers` + `@noble/hashes` (all v2.4.0, pure JS, no native modules), `ws`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-04-termpolis-remote-design.md`

## Global Constraints

- **No native modules.** Crypto is `@noble/curves` + `@noble/ciphers` + `@noble/hashes` only, pinned at 2.4.0. Import paths are the v2 ones and carry an explicit `.js` (`@noble/curves/ed25519.js`, `@noble/ciphers/chacha.js`, `@noble/hashes/sha2.js`) — verified against a real round-trip; the v1 extensionless paths do not resolve. The app has been burned by native deps repeatedly; the memory embedder went WASM for this reason.
- **Coverage gate (Windows CI), never lowered:** lines 97 / functions 96 / **branches 95** / statements 96. Backfill tests on the offending file instead.
- **Remote is default OFF.** No code path may enable it without explicit user opt-in.
- **The MCP server's `127.0.0.1` bind is unchanged.** No task may alter `server.listen(candidate, '127.0.0.1')` in `src/main/mcpServer.ts`.
- **`safeStorage` does not exist in a `utilityProcess`.** Identity-key provisioning happens in main and is passed to the child at init.
- **Fail closed.** Unlike `memoryClient`, which falls back to in-process on repeated crashes, the bridge **disables remote** and surfaces an error. Never degrade to a less-protected path.
- **Do not describe this feature as "like Telegram"** in code comments, UI copy, or docs. Telegram is not E2E by default; the model here is Signal's.
- Commit directly to `main`. No branches, no PRs.
- Existing commands: `npm test` (vitest run), `npm run typecheck`, `npm run lint`.
- **Use `npm run lint`, NOT `lint:strict`.** CI gates on `lint` (`.github/workflows/test.yml:34`), which tolerates warnings; `lint:strict` adds `--max-warnings 0` and already fails on a clean checkout of `main` with 327 pre-existing warnings, 0 errors. Chasing it is a dead end — the bar is "add no new warnings", not "get to zero".

---

## File Structure

**Bridge process (`src/main/remoteBridge/`)** — runs in the `utilityProcess`, no Electron APIs:

| File | Responsibility |
|---|---|
| `entry.ts` | `utilityProcess` entry; owns the MessagePort protocol with main |
| `sealedChannel.ts` | Handshake, frame seal/open, rekey. Pure crypto, no I/O. |
| `pairing.ts` | QR payload, one-time secret, verification-phrase derivation. Pure. |
| `deviceRegistry.ts` | Paired devices: add, list, revoke, idle-expire. Pure + serializable. |
| `remotePolicy.ts` | Per-device capability grants and enforcement. Pure. |
| `mcpClient.ts` | HTTP client for the local MCP endpoint |
| `outputFanout.ts` | Per-device replay buffer, delta computation, gap markers |
| `protocol.ts` | Shared wire types between bridge and test client |

**Main process:**

| File | Responsibility |
|---|---|
| `src/main/remoteBridgeSupervisor.ts` | Fork, supervise, restart-with-backoff, fail closed; provision identity key |

**Shared:**

| File | Responsibility |
|---|---|
| `src/shared/agentStatusDetector.ts` | Moved from `src/renderer/src/lib/` (see spec §5.3) |

**Harness:**

| File | Responsibility |
|---|---|
| `scripts/remote-test-client.cjs` | CLI client: pair, attach, write, read, revoke |

Tests live in `tests/electron/` following the existing convention.

---

## Task 1: Move `agentStatusDetector` to shared

**Files:**
- Create: `src/shared/agentStatusDetector.ts` (moved content)
- Delete: `src/renderer/src/lib/agentStatusDetector.ts`
- Modify: `src/main/index.ts:119`, `src/renderer/src/App.tsx:48`
- Modify: `tests/renderer/agentStatusDetector.test.ts:2`, `tests/renderer/rendererLibsCoverage.test.ts:31`

**Interfaces:**
- Consumes: nothing.
- Produces: `detectAgentStatus(recentOutput: string, agentName: string, previousStatus?: AgentStatus): AgentStatusResult`, `type AgentStatus = 'starting' | 'thinking' | 'waiting_for_input' | 'working' | 'idle' | 'errored' | 'completed' | 'blocked'`, `interface AgentStatusResult { status: AgentStatus; summary: string }` — all importable from `src/shared/agentStatusDetector`.

This is a pure move. The file's contents do not change; only its location and its importers do. Doing it first means every later task imports from the final path.

- [x] **Step 1: Move the file verbatim**

```bash
git mv src/renderer/src/lib/agentStatusDetector.ts src/shared/agentStatusDetector.ts
```

- [x] **Step 2: Repoint all four importers**

```bash
sed -i "s#from '../renderer/src/lib/agentStatusDetector'#from '../shared/agentStatusDetector'#" src/main/index.ts
sed -i "s#from './lib/agentStatusDetector'#from '../../shared/agentStatusDetector'#" src/renderer/src/App.tsx
sed -i "s#'../../src/renderer/src/lib/agentStatusDetector'#'../../src/shared/agentStatusDetector'#" tests/renderer/agentStatusDetector.test.ts tests/renderer/rendererLibsCoverage.test.ts
```

- [x] **Step 3: Fix the stale doc-comment reference**

`tests/renderer/rendererLibsCoverage.test.ts:3` names the old path in a comment. Update it to `src/shared/agentStatusDetector.ts`.

- [x] **Step 4: Verify nothing still points at the old path**

Run: `grep -rn "renderer/src/lib/agentStatusDetector" src tests e2e`
Expected: no output.

- [x] **Step 5: Typecheck and test**

Run: `npm run typecheck && npm test -- agentStatusDetector rendererLibsCoverage`
Expected: PASS. This is a move with no behavior change, so the existing suites must pass untouched.

- [x] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor: move agentStatusDetector to src/shared

The bridge is a separate electron-vite entry point; having that bundle reach
into src/renderer/src/lib/ for a pure utility is a bundling problem waiting to
happen. One detector, one home, three consumers (main, renderer, bridge).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Wire protocol types

**Files:**
- Create: `src/main/remoteBridge/protocol.ts`
- Test: none (types only; exercised by every later task)

**Interfaces:**
- Consumes: `AgentStatus` from `src/shared/agentStatusDetector`.
- Produces: every type below.

- [x] **Step 1: Write the protocol module**

```typescript
import type { AgentStatus } from '../../shared/agentStatusDetector'

/** Capabilities a paired device may be granted. Each is opt-in, default false. */
export interface Capabilities {
  /** List terminals and read their output. */
  read: boolean
  /** Create a new AI terminal. Commands go through sanitizeAgentCommand. */
  createTerminal: boolean
  /** Type into an EXISTING terminal. Bypasses the command allowlist entirely —
   *  see spec §4.5. Off until explicitly granted. */
  writeToTerminal: boolean
  /** Close a terminal. */
  closeTerminal: boolean
}

export const NO_CAPABILITIES: Capabilities = {
  read: false,
  createTerminal: false,
  writeToTerminal: false,
  closeTerminal: false,
}

/** A device the user has paired and not revoked. */
export interface PairedDevice {
  /** Stable id, derived from the device public key. */
  id: string
  /** Human label shown in Settings, supplied by the device at pairing. */
  label: string
  /** X25519 public key, hex. */
  publicKey: string
  capabilities: Capabilities
  pairedAt: number
  lastSeenAt: number
}

/** Requests a remote device may send. */
export type RemoteRequest =
  | { kind: 'listTerminals' }
  | { kind: 'createTerminal'; name: string; cwd?: string }
  | { kind: 'runCommand'; terminalId: string; command: string }
  | { kind: 'writeToTerminal'; terminalId: string; text: string }
  | { kind: 'closeTerminal'; terminalId: string }
  | { kind: 'subscribe'; terminalId: string }
  | { kind: 'unsubscribe'; terminalId: string }

/** Responses and pushes the bridge may send back. */
export type RemoteResponse =
  | { kind: 'ok'; id: number; data: unknown }
  | { kind: 'error'; id: number; message: string }
  | { kind: 'output'; terminalId: string; chunk: string; missed: number }
  | { kind: 'status'; terminalId: string; status: AgentStatus; summary: string }

/** Envelope carrying a request with its correlation id. */
export interface RemoteEnvelope {
  id: number
  request: RemoteRequest
}

/** Messages main sends down to the bridge process. */
export type HostToBridge =
  | { kind: 'init'; mcpPort: number; mcpToken: string; identitySecretKey: string; devices: PairedDevice[] }
  | { kind: 'beginPairing'; label: string }
  | { kind: 'cancelPairing' }
  | { kind: 'revokeDevice'; deviceId: string }
  | { kind: 'setCapabilities'; deviceId: string; capabilities: Capabilities }
  | { kind: 'shutdown' }

/** Messages the bridge sends up to main. */
export type BridgeToHost =
  | { kind: 'ready' }
  | { kind: 'pairingCode'; qrPayload: string; verificationPhrase: string; expiresAt: number }
  | { kind: 'paired'; device: PairedDevice }
  | { kind: 'devicesChanged'; devices: PairedDevice[] }
  | { kind: 'attachedChanged'; attachedDeviceIds: string[] }
  | { kind: 'error'; message: string }
```

- [x] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [x] **Step 3: Commit**

```bash
git add src/main/remoteBridge/protocol.ts
git commit -m "feat(remote): wire protocol types for the remote bridge

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Sealed channel

**Files:**
- Create: `src/main/remoteBridge/sealedChannel.ts`
- Test: `tests/electron/remoteSealedChannel.test.ts`
- Modify: `package.json` (add `@noble/curves`, `@noble/ciphers`, `@noble/hashes`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `generateIdentity(): { secretKey: string; publicKey: string }` (hex)
  - `class SealedChannel` with `constructor(ownSecretKey: string, peerPublicKey: string)`, `seal(plaintext: Uint8Array): Uint8Array`, `open(frame: Uint8Array): Uint8Array` (throws on tamper), `readonly sentFrames: number`
  - `deriveVerificationPhrase(aPublicKey: string, bPublicKey: string): string` — order-independent, 6 words

- [x] **Step 1: Add the crypto dependencies**

```bash
npm install @noble/curves@2.4.0 @noble/ciphers@2.4.0 @noble/hashes@2.4.0
```

Verify they are pure JS (no `binding.gyp`, no prebuilds):

```bash
ls node_modules/@noble/curves | grep -i "binding\|prebuild\|\.node$" ; echo "exit=$?"
```
Expected: no matches (`exit=1`). If anything matches, STOP — the no-native-modules constraint is violated.

- [x] **Step 2: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { generateIdentity, SealedChannel, deriveVerificationPhrase } from '../../src/main/remoteBridge/sealedChannel'

const enc = new TextEncoder()
const dec = new TextDecoder()

describe('SealedChannel', () => {
  it('round-trips a message between two peers', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    const ac = new SealedChannel(a.secretKey, b.publicKey)
    const bc = new SealedChannel(b.secretKey, a.publicKey)

    const frame = ac.seal(enc.encode('hello agent'))
    expect(dec.decode(bc.open(frame))).toBe('hello agent')
  })

  it('produces a different ciphertext each time (nonce is not reused)', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    const ac = new SealedChannel(a.secretKey, b.publicKey)

    const one = ac.seal(enc.encode('same'))
    const two = ac.seal(enc.encode('same'))
    expect(Buffer.from(one).toString('hex')).not.toBe(Buffer.from(two).toString('hex'))
  })

  it('rejects a tampered frame rather than returning garbage', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    const ac = new SealedChannel(a.secretKey, b.publicKey)
    const bc = new SealedChannel(b.secretKey, a.publicKey)

    const frame = ac.seal(enc.encode('transfer 10'))
    frame[frame.length - 1] ^= 0xff
    expect(() => bc.open(frame)).toThrow()
  })

  it('rejects a frame from a third party', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    const evil = generateIdentity()
    const ec = new SealedChannel(evil.secretKey, b.publicKey)
    const bc = new SealedChannel(b.secretKey, a.publicKey)

    expect(() => bc.open(ec.seal(enc.encode('malicious')))).toThrow()
  })

  it('derives the same verification phrase regardless of argument order', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    expect(deriveVerificationPhrase(a.publicKey, b.publicKey))
      .toBe(deriveVerificationPhrase(b.publicKey, a.publicKey))
  })

  it('derives a 6-word phrase that differs for different peers', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    const c = generateIdentity()
    const phrase = deriveVerificationPhrase(a.publicKey, b.publicKey)
    expect(phrase.split(' ')).toHaveLength(6)
    expect(phrase).not.toBe(deriveVerificationPhrase(a.publicKey, c.publicKey))
  })
})
```

- [x] **Step 3: Run it to confirm it fails**

Run: `npm test -- remoteSealedChannel`
Expected: FAIL — cannot resolve `src/main/remoteBridge/sealedChannel`.

- [x] **Step 4: Implement**

```typescript
import { x25519 } from '@noble/curves/ed25519.js'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from 'crypto'

const NONCE_BYTES = 12

function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex')
}
function fromHex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'hex'))
}

export function generateIdentity(): { secretKey: string; publicKey: string } {
  const secretKey = new Uint8Array(randomBytes(32))
  return { secretKey: toHex(secretKey), publicKey: toHex(x25519.getPublicKey(secretKey)) }
}

/**
 * An authenticated channel between two X25519 identities.
 *
 * The shared secret is hashed rather than used raw: the raw ECDH output is not
 * uniformly distributed, and feeding it straight to a cipher is a classic footgun.
 */
export class SealedChannel {
  private readonly key: Uint8Array
  private frames = 0

  constructor(ownSecretKey: string, peerPublicKey: string) {
    const shared = x25519.getSharedSecret(fromHex(ownSecretKey), fromHex(peerPublicKey))
    this.key = sha256(shared)
  }

  get sentFrames(): number {
    return this.frames
  }

  seal(plaintext: Uint8Array): Uint8Array {
    const nonce = new Uint8Array(randomBytes(NONCE_BYTES))
    const ct = chacha20poly1305(this.key, nonce).encrypt(plaintext)
    this.frames++
    const out = new Uint8Array(nonce.length + ct.length)
    out.set(nonce, 0)
    out.set(ct, nonce.length)
    return out
  }

  /** Throws if the frame was tampered with or came from another peer. */
  open(frame: Uint8Array): Uint8Array {
    if (frame.length <= NONCE_BYTES) throw new Error('frame too short')
    const nonce = frame.subarray(0, NONCE_BYTES)
    const ct = frame.subarray(NONCE_BYTES)
    return chacha20poly1305(this.key, nonce).decrypt(ct)
  }
}

/** Small, unambiguous wordlist — no homophones, no near-anagrams. */
const WORDS = [
  'anchor', 'bishop', 'cactus', 'dolphin', 'ember', 'falcon', 'granite', 'harbor',
  'igloo', 'jasmine', 'kestrel', 'lantern', 'marble', 'nectar', 'orchid', 'pepper',
  'quartz', 'ribbon', 'saddle', 'timber', 'umbrella', 'velvet', 'walnut', 'xenon',
  'yonder', 'zephyr', 'amber', 'basalt', 'cobalt', 'dogwood', 'elm', 'fjord',
]

/**
 * Signal-style safety numbers. Both ends render this and the user confirms they match,
 * which is what stops a malicious relay from MITM-ing the pairing handshake.
 * Sorting the keys makes it order-independent, so both sides derive the same phrase.
 */
export function deriveVerificationPhrase(aPublicKey: string, bPublicKey: string): string {
  const [lo, hi] = [aPublicKey, bPublicKey].sort()
  const digest = sha256(new TextEncoder().encode(`${lo}:${hi}`))
  return Array.from({ length: 6 }, (_, i) => WORDS[digest[i] % WORDS.length]).join(' ')
}
```

- [x] **Step 5: Add replay protection**

The code above authenticates frames but does not make them single-use. A random
nonce does not help: the Poly1305 tag still verifies on a byte-identical frame an
attacker captured earlier, so a recorded `run_command` can be re-sent and
re-executed. Spec §97 asks for this; it is not optional for a feature whose
purpose is remote command execution.

Seal a 6-byte big-endian counter INSIDE the ciphertext — `nonce || AEAD(counter ||
plaintext)` — so it is covered by the tag and cannot be edited. `open()` refuses any
counter at or below the highest already accepted from that peer, which rejects
replayed *and* reordered frames. Each `SealedChannel` instance tracks only its own
peer's high-water mark, so the two directions never collide (both start at 0).

6 bytes = 2^48 frames, unreachable in practice and exactly representable as a JS
number, so the comparison needs no BigInt.

- [x] **Step 6: Run tests**

Run: `npm test -- remoteSealedChannel`
Expected: PASS, all 11 — the 6 above plus replay, reorder, a 500-frame in-order run,
per-direction independence, and a truncated frame.

Verify the replay tests are not vacuous: neutralise the counter comparison and
re-run. Exactly `refuses a replayed frame` and `refuses a frame delivered out of
order` must fail.

- [x] **Step 7: Commit**

```bash
git add package.json package-lock.json src/main/remoteBridge/sealedChannel.ts tests/electron/remoteSealedChannel.test.ts
git commit -m "feat(remote): sealed channel (X25519 + ChaCha20-Poly1305)

Pure-JS @noble, no native modules. ECDH output is hashed before use rather
than fed to the cipher raw. Verification phrase is order-independent so both
ends derive the same 6 words.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Device registry

**Files:**
- Create: `src/main/remoteBridge/deviceRegistry.ts`
- Test: `tests/electron/remoteDeviceRegistry.test.ts`

**Interfaces:**
- Consumes: `PairedDevice`, `Capabilities`, `NO_CAPABILITIES` from `./protocol`.
- Produces: `class DeviceRegistry` with `constructor(devices?: PairedDevice[])`, `add(device: PairedDevice): void`, `get(id: string): PairedDevice | undefined`, `list(): PairedDevice[]`, `revoke(id: string): boolean`, `setCapabilities(id: string, caps: Capabilities): boolean`, `touch(id: string, now?: number): void`, `expireIdle(maxIdleMs: number, now?: number): string[]`, `toJSON(): PairedDevice[]`.

- [x] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { DeviceRegistry } from '../../src/main/remoteBridge/deviceRegistry'
import { NO_CAPABILITIES, type PairedDevice } from '../../src/main/remoteBridge/protocol'

function device(id: string, lastSeenAt = 1000): PairedDevice {
  return {
    id,
    label: `phone-${id}`,
    publicKey: `pk-${id}`,
    capabilities: { ...NO_CAPABILITIES },
    pairedAt: 500,
    lastSeenAt,
  }
}

describe('DeviceRegistry', () => {
  it('starts empty and grants nothing', () => {
    const r = new DeviceRegistry()
    expect(r.list()).toEqual([])
    expect(r.get('nope')).toBeUndefined()
  })

  it('adds and retrieves a device', () => {
    const r = new DeviceRegistry()
    r.add(device('a'))
    expect(r.get('a')?.label).toBe('phone-a')
    expect(r.list()).toHaveLength(1)
  })

  it('new devices hold no capabilities by default', () => {
    const r = new DeviceRegistry()
    r.add(device('a'))
    expect(r.get('a')?.capabilities).toEqual(NO_CAPABILITIES)
  })

  it('revokes a device and reports whether it existed', () => {
    const r = new DeviceRegistry([device('a')])
    expect(r.revoke('a')).toBe(true)
    expect(r.get('a')).toBeUndefined()
    expect(r.revoke('a')).toBe(false)
  })

  it('updates capabilities and reports unknown ids', () => {
    const r = new DeviceRegistry([device('a')])
    expect(r.setCapabilities('a', { ...NO_CAPABILITIES, read: true })).toBe(true)
    expect(r.get('a')?.capabilities.read).toBe(true)
    expect(r.setCapabilities('ghost', NO_CAPABILITIES)).toBe(false)
  })

  it('touch advances lastSeenAt', () => {
    const r = new DeviceRegistry([device('a', 1000)])
    r.touch('a', 9999)
    expect(r.get('a')?.lastSeenAt).toBe(9999)
  })

  it('touch on an unknown id is a no-op, not a throw', () => {
    const r = new DeviceRegistry()
    expect(() => r.touch('ghost', 1)).not.toThrow()
  })

  it('expires only devices idle beyond the window, returning their ids', () => {
    const r = new DeviceRegistry([device('fresh', 9_000), device('stale', 1_000)])
    expect(r.expireIdle(5_000, 10_000)).toEqual(['stale'])
    expect(r.list().map((d) => d.id)).toEqual(['fresh'])
  })

  it('round-trips through toJSON so main can persist it', () => {
    const r = new DeviceRegistry([device('a')])
    expect(new DeviceRegistry(r.toJSON()).get('a')?.label).toBe('phone-a')
  })
})
```

- [x] **Step 2: Run it to confirm it fails**

Run: `npm test -- remoteDeviceRegistry`
Expected: FAIL — cannot resolve `deviceRegistry`.

- [x] **Step 3: Implement**

```typescript
import { NO_CAPABILITIES, type Capabilities, type PairedDevice } from './protocol'

/** Paired devices, in memory. Main owns persistence; this owns the rules. */
export class DeviceRegistry {
  private readonly devices = new Map<string, PairedDevice>()

  constructor(devices: PairedDevice[] = []) {
    for (const d of devices) this.devices.set(d.id, { ...d })
  }

  add(device: PairedDevice): void {
    this.devices.set(device.id, { ...device, capabilities: { ...NO_CAPABILITIES, ...device.capabilities } })
  }

  get(id: string): PairedDevice | undefined {
    return this.devices.get(id)
  }

  list(): PairedDevice[] {
    return [...this.devices.values()]
  }

  revoke(id: string): boolean {
    return this.devices.delete(id)
  }

  setCapabilities(id: string, capabilities: Capabilities): boolean {
    const d = this.devices.get(id)
    if (!d) return false
    d.capabilities = { ...capabilities }
    return true
  }

  touch(id: string, now: number = Date.now()): void {
    const d = this.devices.get(id)
    if (d) d.lastSeenAt = now
  }

  /** Drops devices unseen for longer than maxIdleMs. Returns the ids removed. */
  expireIdle(maxIdleMs: number, now: number = Date.now()): string[] {
    const expired: string[] = []
    for (const [id, d] of this.devices) {
      if (now - d.lastSeenAt > maxIdleMs) expired.push(id)
    }
    for (const id of expired) this.devices.delete(id)
    return expired
  }

  toJSON(): PairedDevice[] {
    return this.list()
  }
}
```

- [x] **Step 4: Run tests**

Run: `npm test -- remoteDeviceRegistry`
Expected: PASS, all 9.

- [x] **Step 5: Commit**

```bash
git add src/main/remoteBridge/deviceRegistry.ts tests/electron/remoteDeviceRegistry.test.ts
git commit -m "feat(remote): paired-device registry with revoke and idle expiry

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Capability policy

**Files:**
- Create: `src/main/remoteBridge/remotePolicy.ts`
- Test: `tests/electron/remotePolicy.test.ts`

**Interfaces:**
- Consumes: `Capabilities`, `RemoteRequest` from `./protocol`.
- Produces: `requiredCapability(request: RemoteRequest): keyof Capabilities | null`, `isAllowed(request: RemoteRequest, caps: Capabilities): boolean`, `assertAllowed(request: RemoteRequest, caps: Capabilities): void` (throws `CapabilityError`), `class CapabilityError extends Error`.

- [x] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { isAllowed, assertAllowed, requiredCapability, CapabilityError } from '../../src/main/remoteBridge/remotePolicy'
import { NO_CAPABILITIES, type Capabilities, type RemoteRequest } from '../../src/main/remoteBridge/protocol'

const all: Capabilities = { read: true, createTerminal: true, writeToTerminal: true, closeTerminal: true }

describe('remotePolicy', () => {
  it('denies every request when no capability is granted', () => {
    const requests: RemoteRequest[] = [
      { kind: 'listTerminals' },
      { kind: 'createTerminal', name: 't' },
      { kind: 'runCommand', terminalId: 't', command: 'ls' },
      { kind: 'writeToTerminal', terminalId: 't', text: 'hi' },
      { kind: 'closeTerminal', terminalId: 't' },
      { kind: 'subscribe', terminalId: 't' },
      { kind: 'unsubscribe', terminalId: 't' },
    ]
    for (const r of requests) expect(isAllowed(r, NO_CAPABILITIES)).toBe(false)
  })

  it('allows every request when all capabilities are granted', () => {
    expect(isAllowed({ kind: 'listTerminals' }, all)).toBe(true)
    expect(isAllowed({ kind: 'writeToTerminal', terminalId: 't', text: 'x' }, all)).toBe(true)
  })

  it('maps each request to the capability it needs', () => {
    expect(requiredCapability({ kind: 'listTerminals' })).toBe('read')
    expect(requiredCapability({ kind: 'subscribe', terminalId: 't' })).toBe('read')
    expect(requiredCapability({ kind: 'unsubscribe', terminalId: 't' })).toBe('read')
    expect(requiredCapability({ kind: 'createTerminal', name: 't' })).toBe('createTerminal')
    expect(requiredCapability({ kind: 'runCommand', terminalId: 't', command: 'ls' })).toBe('createTerminal')
    expect(requiredCapability({ kind: 'writeToTerminal', terminalId: 't', text: 'x' })).toBe('writeToTerminal')
    expect(requiredCapability({ kind: 'closeTerminal', terminalId: 't' })).toBe('closeTerminal')
  })

  it('does NOT let createTerminal imply writeToTerminal', () => {
    const caps: Capabilities = { ...NO_CAPABILITIES, read: true, createTerminal: true }
    expect(isAllowed({ kind: 'writeToTerminal', terminalId: 't', text: 'x' }, caps)).toBe(false)
  })

  it('assertAllowed throws CapabilityError naming the missing capability', () => {
    expect(() => assertAllowed({ kind: 'writeToTerminal', terminalId: 't', text: 'x' }, NO_CAPABILITIES))
      .toThrow(CapabilityError)
    expect(() => assertAllowed({ kind: 'writeToTerminal', terminalId: 't', text: 'x' }, NO_CAPABILITIES))
      .toThrow(/writeToTerminal/)
  })

  it('assertAllowed is silent when permitted', () => {
    expect(() => assertAllowed({ kind: 'listTerminals' }, all)).not.toThrow()
  })
})
```

- [x] **Step 2: Run it to confirm it fails**

Run: `npm test -- remotePolicy`
Expected: FAIL — cannot resolve `remotePolicy`.

- [x] **Step 3: Implement**

```typescript
import type { Capabilities, RemoteRequest } from './protocol'

export class CapabilityError extends Error {
  constructor(public readonly capability: keyof Capabilities) {
    super(`remote device lacks the "${capability}" capability`)
    this.name = 'CapabilityError'
  }
}

/**
 * Which grant a request needs.
 *
 * writeToTerminal is deliberately NOT implied by createTerminal: typing into an
 * existing agent session bypasses sanitizeAgentCommand entirely (spec §4.5), so it
 * is its own grant and must be turned on deliberately.
 */
export function requiredCapability(request: RemoteRequest): keyof Capabilities | null {
  switch (request.kind) {
    case 'listTerminals':
    case 'subscribe':
    case 'unsubscribe':
      return 'read'
    case 'createTerminal':
    case 'runCommand':
      return 'createTerminal'
    case 'writeToTerminal':
      return 'writeToTerminal'
    case 'closeTerminal':
      return 'closeTerminal'
  }
}

export function isAllowed(request: RemoteRequest, caps: Capabilities): boolean {
  const needed = requiredCapability(request)
  return needed === null ? false : caps[needed] === true
}

export function assertAllowed(request: RemoteRequest, caps: Capabilities): void {
  const needed = requiredCapability(request)
  if (needed === null || caps[needed] !== true) {
    throw new CapabilityError(needed ?? 'read')
  }
}
```

- [x] **Step 4: Run tests**

Run: `npm test -- remotePolicy`
Expected: PASS, all 9 — the 6 above plus three for input outside the union.

**Amendment applied during execution.** The switch had no `default`, because
TypeScript proves it exhaustive over `RemoteRequest`. But `RemoteRequest` is a
claim about *our* code, not about the wire: this function's argument is a decoded
network frame from a device that may be compromised, malicious, or simply newer
than this desktop. An unknown `kind` fell through to an implicit `undefined`, which
happened to fail closed only through `caps[undefined] !== true`. Security behaviour
should not rest on an accident, so the `default` returns `null` explicitly,
`CapabilityError` accepts `null` and says "unrecognised request kind" instead of
blaming whichever capability sorted first, and three tests pin it.

- [x] **Step 5: Commit**

```bash
git add src/main/remoteBridge/remotePolicy.ts tests/electron/remotePolicy.test.ts
git commit -m "feat(remote): per-device capability policy

createTerminal deliberately does not imply writeToTerminal -- typing into an
existing agent session bypasses the command allowlist, so it is its own grant.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Output fan-out with replay buffer

**Files:**
- Create: `src/main/remoteBridge/outputFanout.ts`
- Test: `tests/electron/remoteOutputFanout.test.ts`

**Interfaces:**
- Consumes: nothing (takes `OutputSlice`-shaped input; does not import from `terminalOutputBuffer`).
- Produces: `class OutputFanout` with `constructor(capacityChars?: number)`, `ingest(terminalId: string, slice: { output: string; nextOffset: number; missed: number }): void`, `subscribe(deviceId: string, terminalId: string): void`, `unsubscribe(deviceId: string, terminalId: string): void`, `drain(deviceId: string): Array<{ terminalId: string; chunk: string; missed: number }>`, `dropDevice(deviceId: string): void`.

**Why this exists:** `MAX_TERMINAL_BUFFER_CHARS` is 32 KB and `readOutputFrom`'s `missed` count means output is gone for good (spec §5.2). The fan-out keeps a larger per-device queue so a lagging remote device loses nothing the desktop still has, and surfaces a `missed` count when loss happened anyway.

- [x] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { OutputFanout } from '../../src/main/remoteBridge/outputFanout'

describe('OutputFanout', () => {
  it('delivers nothing to a device that never subscribed', () => {
    const f = new OutputFanout()
    f.ingest('t1', { output: 'hello', nextOffset: 5, missed: 0 })
    expect(f.drain('phone')).toEqual([])
  })

  it('delivers output for a subscribed terminal', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'hello', nextOffset: 5, missed: 0 })
    expect(f.drain('phone')).toEqual([{ terminalId: 't1', chunk: 'hello', missed: 0 }])
  })

  it('drains exactly once', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'hello', nextOffset: 5, missed: 0 })
    f.drain('phone')
    expect(f.drain('phone')).toEqual([])
  })

  it('does not deliver terminals the device did not subscribe to', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.ingest('t2', { output: 'other', nextOffset: 5, missed: 0 })
    expect(f.drain('phone')).toEqual([])
  })

  it('fans the same output out to two devices independently', () => {
    const f = new OutputFanout()
    f.subscribe('a', 't1')
    f.subscribe('b', 't1')
    f.ingest('t1', { output: 'x', nextOffset: 1, missed: 0 })
    expect(f.drain('a')).toHaveLength(1)
    expect(f.drain('b')).toHaveLength(1)
  })

  it('propagates a missed count from the source slice', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'tail', nextOffset: 999, missed: 4200 })
    expect(f.drain('phone')[0].missed).toBe(4200)
  })

  it('evicts oldest chars past capacity and reports them as missed', () => {
    const f = new OutputFanout(10)
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'abcdefgh', nextOffset: 8, missed: 0 })
    f.ingest('t1', { output: 'ijklmn', nextOffset: 14, missed: 0 })

    const drained = f.drain('phone')
    const text = drained.map((d) => d.chunk).join('')
    const missed = drained.reduce((n, d) => n + d.missed, 0)

    expect(text.length).toBeLessThanOrEqual(10)
    expect(text.endsWith('ijklmn')).toBe(true)
    expect(missed).toBe(4)
  })

  it('stops delivering after unsubscribe', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.unsubscribe('phone', 't1')
    f.ingest('t1', { output: 'x', nextOffset: 1, missed: 0 })
    expect(f.drain('phone')).toEqual([])
  })

  it('drops all state for a revoked device', () => {
    const f = new OutputFanout()
    f.subscribe('phone', 't1')
    f.ingest('t1', { output: 'x', nextOffset: 1, missed: 0 })
    f.dropDevice('phone')
    expect(f.drain('phone')).toEqual([])
  })
})
```

- [x] **Step 2: Run it to confirm it fails**

Run: `npm test -- remoteOutputFanout`
Expected: FAIL — cannot resolve `outputFanout`.

- [x] **Step 3: Implement**

```typescript
interface QueuedChunk {
  terminalId: string
  chunk: string
  missed: number
}

/** Default per-device queue. 8x the 32 KB terminal window, so a lagging phone
 *  loses nothing the desktop itself still holds. */
const DEFAULT_CAPACITY_CHARS = 262_144

export class OutputFanout {
  private readonly subs = new Map<string, Set<string>>()
  private readonly queues = new Map<string, QueuedChunk[]>()

  constructor(private readonly capacityChars: number = DEFAULT_CAPACITY_CHARS) {}

  subscribe(deviceId: string, terminalId: string): void {
    let set = this.subs.get(deviceId)
    if (!set) this.subs.set(deviceId, (set = new Set()))
    set.add(terminalId)
    if (!this.queues.has(deviceId)) this.queues.set(deviceId, [])
  }

  unsubscribe(deviceId: string, terminalId: string): void {
    this.subs.get(deviceId)?.delete(terminalId)
  }

  dropDevice(deviceId: string): void {
    this.subs.delete(deviceId)
    this.queues.delete(deviceId)
  }

  ingest(terminalId: string, slice: { output: string; nextOffset: number; missed: number }): void {
    if (slice.output === '' && slice.missed === 0) return
    for (const [deviceId, terminals] of this.subs) {
      if (!terminals.has(terminalId)) continue
      const q = this.queues.get(deviceId)
      if (!q) continue
      q.push({ terminalId, chunk: slice.output, missed: slice.missed })
      this.trim(q)
    }
  }

  /** Enforces the per-device ceiling, converting evicted chars into a missed count
   *  on the oldest surviving chunk. A visible gap beats an invisible one. */
  private trim(q: QueuedChunk[]): void {
    let total = q.reduce((n, c) => n + c.chunk.length, 0)
    let evicted = 0
    while (total > this.capacityChars && q.length > 0) {
      const overshoot = total - this.capacityChars
      const head = q[0]
      if (head.chunk.length <= overshoot) {
        evicted += head.chunk.length
        total -= head.chunk.length
        q.shift()
      } else {
        head.chunk = head.chunk.slice(overshoot)
        evicted += overshoot
        total -= overshoot
      }
    }
    if (evicted > 0 && q.length > 0) q[0].missed += evicted
  }

  drain(deviceId: string): QueuedChunk[] {
    const q = this.queues.get(deviceId)
    if (!q || q.length === 0) return []
    this.queues.set(deviceId, [])
    return q
  }
}
```

- [x] **Step 4: Run tests**

Run: `npm test -- remoteOutputFanout`
Expected: PASS, all 13 — the 9 above plus four for gap markers.

**Amendment applied during execution.** The file-structure table promises "gap
markers" and spec §215 requires the user to SEE lost output, but the drafted
module only propagated a numeric `missed` and left rendering to whoever consumed
it. Dropped output is the one failure of this design a user cannot detect
unaided: a silent gap reads exactly like an agent that went quiet, and they may
act on truncated text believing they saw all of it. So `drain()` now returns a
rendered `marker: string | null` alongside the numeric count, and
`formatGapMarker` is exported — no client gets the chance to forget it. Small
losses report in chars, not a misleading `0.0 KB`.

Note the shape change: `drain()` returns `DrainedChunk[]`, so the one existing
`toEqual` on the exact object needs `marker: null` added.

- [x] **Step 5: Commit**

```bash
git add src/main/remoteBridge/outputFanout.ts tests/electron/remoteOutputFanout.test.ts
git commit -m "feat(remote): per-device output fan-out with replay buffer

readOutputFrom's 32 KB window drops output for good; a lagging remote device
needs a bigger queue and an honest missed count when loss happens anyway.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Local MCP client

**Files:**
- Create: `src/main/remoteBridge/mcpClient.ts`
- Test: `tests/electron/remoteMcpClient.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class LocalMcpClient` with `constructor(port: number, token: string)`, `callTool(name: string, args: Record<string, unknown>): Promise<unknown>`.

**Why over HTTP:** going through the existing `127.0.0.1:<port>` endpoint means remote traffic inherits the MCP server's auth, per-endpoint rate limits, and JSONL audit log with no new privileged path (spec §4.4).

**Two facts about this server's envelope, verified in `src/main/mcpServer.ts`, that the client must respect:**

1. **Tool failures come back as `result`, not as JSON-RPC `error`.** `mcpServer.ts:770-772` returns `{ result: { content: [...], isError: true } }` on a thrown tool. A client that only checks `parsed.error` would treat `"Error: Tool execution failed"` as a successful result and hand it to the phone as data. Check `isError`.
2. **Result text is compressed unless the tool is exempt.** `mcpServer.ts:761` wraps every result in `compressToolResult`, which returns `JSON.stringify(result, null, 2)` only when the tool is exempt — otherwise a compressed form plus a `[headroom] Full result cached — call the retrieve_full tool…` footer, which is not parseable JSON. `src/main/headroom/router.ts:3-6` currently exempts exactly the five tools this bridge dispatches (`list_terminals`, `create_terminal`, `run_command`, `close_terminal`, `write_to_terminal`), so parsing is safe today. **`read_output` is NOT exempt** — the transport pass, which will need it for the fan-out, must either add it to `EXEMPT_TOOLS` or read the buffer directly rather than through MCP. Task 7 therefore parses when it can and passes the raw text through when it cannot, instead of throwing on a footer it did not expect.

- [x] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as http from 'http'
import { LocalMcpClient } from '../../src/main/remoteBridge/mcpClient'

let server: http.Server
let port: number
let lastAuth: string | undefined

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastAuth = req.headers.authorization
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (lastAuth !== 'Bearer good-token') {
        res.writeHead(401); res.end('unauthorized'); return
      }
      const parsed = JSON.parse(body)
      if (parsed.params.name === 'explodes') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { message: 'tool blew up' } }))
        return
      }
      // How mcpServer.ts ACTUALLY reports a failed tool: inside result, with isError.
      if (parsed.params.name === 'fails_softly') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: parsed.id,
          result: { content: [{ type: 'text', text: 'Error: Tool execution failed' }], isError: true },
        }))
        return
      }
      // A non-exempt tool comes back Headroom-compressed: not JSON.
      if (parsed.params.name === 'compressed') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: parsed.id,
          result: { content: [{ type: 'text', text: 'summary line\n\n[headroom] Full result cached — call the retrieve_full tool with token "hr_abc".' }] },
        }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        jsonrpc: '2.0', id: parsed.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ echoed: parsed.params.name }) }] },
      }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port
})

afterAll(() => new Promise<void>((r) => server.close(() => r())))

describe('LocalMcpClient', () => {
  it('calls a tool and returns the parsed result', async () => {
    const c = new LocalMcpClient(port, 'good-token')
    expect(await c.callTool('list_terminals', {})).toEqual({ echoed: 'list_terminals' })
  })

  it('sends the bearer token', async () => {
    await new LocalMcpClient(port, 'good-token').callTool('list_terminals', {})
    expect(lastAuth).toBe('Bearer good-token')
  })

  it('rejects when the server returns a JSON-RPC error', async () => {
    const c = new LocalMcpClient(port, 'good-token')
    await expect(c.callTool('explodes', {})).rejects.toThrow(/tool blew up/)
  })

  it('rejects an isError result instead of passing it off as data', async () => {
    const c = new LocalMcpClient(port, 'good-token')
    await expect(c.callTool('fails_softly', {})).rejects.toThrow(/Tool execution failed/)
  })

  it('passes Headroom-compressed text through instead of throwing on it', async () => {
    const c = new LocalMcpClient(port, 'good-token')
    const out = await c.callTool('compressed', {})
    expect(typeof out).toBe('string')
    expect(out as string).toMatch(/summary line/)
  })

  it('rejects on a bad token rather than returning undefined', async () => {
    const c = new LocalMcpClient(port, 'wrong-token')
    await expect(c.callTool('list_terminals', {})).rejects.toThrow()
  })

  it('rejects when nothing is listening', async () => {
    const c = new LocalMcpClient(1, 'good-token')
    await expect(c.callTool('list_terminals', {})).rejects.toThrow()
  })
})
```

- [x] **Step 2: Run it to confirm it fails**

Run: `npm test -- remoteMcpClient`
Expected: FAIL — cannot resolve `mcpClient`.

- [x] **Step 3: Implement**

```typescript
import * as http from 'http'

/**
 * Talks to Termpolis's own MCP server over loopback.
 *
 * Deliberately HTTP rather than an in-process call: this way remote traffic goes
 * through the same auth, rate limiting, and audit logging every other MCP client
 * does, and the bridge gains no privileged path of its own.
 */
export class LocalMcpClient {
  private nextId = 1

  constructor(
    private readonly port: number,
    private readonly token: string,
  ) {}

  callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++
    const payload = JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
    })

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
          path: '/mcp',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            Authorization: `Bearer ${this.token}`,
          },
        },
        (res) => {
          let body = ''
          res.on('data', (d) => (body += d))
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`MCP ${name}: HTTP ${res.statusCode}`))
              return
            }
            let parsed: {
              error?: { message?: string }
              result?: { isError?: boolean; content?: Array<{ text?: string }> }
            }
            try {
              parsed = JSON.parse(body)
            } catch (err) {
              reject(new Error(`MCP ${name}: bad response — ${(err as Error).message}`))
              return
            }

            // Transport-level JSON-RPC error.
            if (parsed.error) {
              reject(new Error(`MCP ${name}: ${parsed.error.message || 'unknown error'}`))
              return
            }

            const text = parsed.result?.content?.[0]?.text

            // Tool-level failure. This server reports it INSIDE result with isError,
            // not as a JSON-RPC error — miss it and "Error: Tool execution failed"
            // sails through to the phone dressed as data.
            if (parsed.result?.isError) {
              reject(new Error(`MCP ${name}: ${text ?? 'tool reported an error'}`))
              return
            }

            if (text === undefined) {
              resolve(parsed.result)
              return
            }

            // Exempt tools yield JSON; a non-exempt one yields Headroom-compressed
            // prose. Pass that through as text rather than throwing — the caller
            // gets something useful either way.
            try {
              resolve(JSON.parse(text))
            } catch {
              resolve(text)
            }
          })
        },
      )
      req.on('error', reject)
      req.write(payload)
      req.end()
    })
  }
}
```

- [x] **Step 4: Run tests**

Run: `npm test -- remoteMcpClient`
Expected: PASS, all 7.

- [x] **Step 5: Commit**

```bash
git add src/main/remoteBridge/mcpClient.ts tests/electron/remoteMcpClient.test.ts
git commit -m "feat(remote): loopback MCP client for the bridge

HTTP rather than in-process, so remote traffic inherits the existing auth,
rate limits, and audit log instead of getting a privileged side door.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Pairing

**Files:**
- Create: `src/main/remoteBridge/pairing.ts`
- Test: `tests/electron/remotePairing.test.ts`

**Interfaces:**
- Consumes: `generateIdentity`, `deriveVerificationPhrase` from `./sealedChannel`; `PairedDevice`, `NO_CAPABILITIES` from `./protocol`.
- Produces: `interface PairingOffer { pairingId: string; oneTimeSecret: string; qrPayload: string; expiresAt: number }`, `createPairingOffer(opts: { relayUrl: string; desktopPublicKey: string; now?: number; ttlMs?: number }): PairingOffer`, `class PairingSession` with `constructor(offer: PairingOffer, desktopPublicKey: string)`, `accept(input: { oneTimeSecret: string; devicePublicKey: string; label: string; now?: number }): { device: PairedDevice; verificationPhrase: string }` (throws on wrong secret, reuse, or expiry).

- [x] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { createPairingOffer, PairingSession } from '../../src/main/remoteBridge/pairing'
import { generateIdentity } from '../../src/main/remoteBridge/sealedChannel'
import { NO_CAPABILITIES } from '../../src/main/remoteBridge/protocol'

const desktop = generateIdentity()
const phone = generateIdentity()

function offer(now = 1_000) {
  return createPairingOffer({ relayUrl: 'wss://relay.test', desktopPublicKey: desktop.publicKey, now })
}

describe('pairing', () => {
  it('builds a QR payload carrying relay, pairing id and desktop key', () => {
    const parsed = JSON.parse(offer().qrPayload)
    expect(parsed.relayUrl).toBe('wss://relay.test')
    expect(parsed.desktopPublicKey).toBe(desktop.publicKey)
    expect(parsed.pairingId).toBeTruthy()
    expect(parsed.oneTimeSecret).toBeTruthy()
  })

  it('expires 90 seconds out by default', () => {
    expect(offer(1_000).expiresAt).toBe(1_000 + 90_000)
  })

  it('accepts a device presenting the correct secret', () => {
    const o = offer()
    const s = new PairingSession(o, desktop.publicKey)
    const { device } = s.accept({
      oneTimeSecret: o.oneTimeSecret, devicePublicKey: phone.publicKey, label: 'Pixel', now: 1_500,
    })
    expect(device.label).toBe('Pixel')
    expect(device.publicKey).toBe(phone.publicKey)
    expect(device.capabilities).toEqual(NO_CAPABILITIES)
  })

  it('returns a verification phrase both ends can compare', () => {
    const o = offer()
    const s = new PairingSession(o, desktop.publicKey)
    const { verificationPhrase } = s.accept({
      oneTimeSecret: o.oneTimeSecret, devicePublicKey: phone.publicKey, label: 'Pixel', now: 1_500,
    })
    expect(verificationPhrase.split(' ')).toHaveLength(6)
  })

  it('rejects a wrong secret', () => {
    const o = offer()
    const s = new PairingSession(o, desktop.publicKey)
    expect(() => s.accept({
      oneTimeSecret: 'nope', devicePublicKey: phone.publicKey, label: 'Evil', now: 1_500,
    })).toThrow(/secret/i)
  })

  it('is single-use — a second accept fails even with the right secret', () => {
    const o = offer()
    const s = new PairingSession(o, desktop.publicKey)
    s.accept({ oneTimeSecret: o.oneTimeSecret, devicePublicKey: phone.publicKey, label: 'A', now: 1_500 })
    expect(() => s.accept({
      oneTimeSecret: o.oneTimeSecret, devicePublicKey: generateIdentity().publicKey, label: 'B', now: 1_600,
    })).toThrow(/used/i)
  })

  it('rejects after expiry', () => {
    const o = offer(1_000)
    const s = new PairingSession(o, desktop.publicKey)
    expect(() => s.accept({
      oneTimeSecret: o.oneTimeSecret, devicePublicKey: phone.publicKey, label: 'Late', now: 1_000 + 90_001,
    })).toThrow(/expired/i)
  })

  it('derives distinct device ids for distinct keys', () => {
    const a = new PairingSession(offer(), desktop.publicKey)
    const oa = offer()
    const sa = new PairingSession(oa, desktop.publicKey)
    const one = sa.accept({ oneTimeSecret: oa.oneTimeSecret, devicePublicKey: phone.publicKey, label: 'A', now: 1_500 })
    const ob = offer()
    const sb = new PairingSession(ob, desktop.publicKey)
    const two = sb.accept({ oneTimeSecret: ob.oneTimeSecret, devicePublicKey: generateIdentity().publicKey, label: 'B', now: 1_500 })
    expect(one.device.id).not.toBe(two.device.id)
    void a
  })
})
```

- [x] **Step 2: Run it to confirm it fails**

Run: `npm test -- remotePairing`
Expected: FAIL — cannot resolve `pairing`.

- [x] **Step 3: Implement**

```typescript
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { deriveVerificationPhrase } from './sealedChannel'
import { NO_CAPABILITIES, type PairedDevice } from './protocol'

const DEFAULT_TTL_MS = 90_000

export interface PairingOffer {
  pairingId: string
  oneTimeSecret: string
  qrPayload: string
  expiresAt: number
}

export function createPairingOffer(opts: {
  relayUrl: string
  desktopPublicKey: string
  now?: number
  ttlMs?: number
}): PairingOffer {
  const now = opts.now ?? Date.now()
  const pairingId = randomBytes(16).toString('hex')
  const oneTimeSecret = randomBytes(32).toString('hex')
  const expiresAt = now + (opts.ttlMs ?? DEFAULT_TTL_MS)
  return {
    pairingId,
    oneTimeSecret,
    expiresAt,
    qrPayload: JSON.stringify({
      v: 1,
      relayUrl: opts.relayUrl,
      pairingId,
      desktopPublicKey: opts.desktopPublicKey,
      oneTimeSecret,
    }),
  }
}

function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * One pairing attempt. Single-use and time-boxed: a QR left on screen is a
 * credential, so it stops being one the moment it is used or expires.
 */
export class PairingSession {
  private used = false

  constructor(
    private readonly offer: PairingOffer,
    private readonly desktopPublicKey: string,
  ) {}

  accept(input: {
    oneTimeSecret: string
    devicePublicKey: string
    label: string
    now?: number
  }): { device: PairedDevice; verificationPhrase: string } {
    const now = input.now ?? Date.now()
    if (this.used) throw new Error('pairing offer already used')
    if (now > this.offer.expiresAt) throw new Error('pairing offer expired')
    if (!secretsMatch(input.oneTimeSecret, this.offer.oneTimeSecret)) {
      throw new Error('pairing secret mismatch')
    }
    this.used = true

    const device: PairedDevice = {
      id: createHash('sha256').update(input.devicePublicKey).digest('hex').slice(0, 16),
      label: input.label,
      publicKey: input.devicePublicKey,
      capabilities: { ...NO_CAPABILITIES },
      pairedAt: now,
      lastSeenAt: now,
    }

    return {
      device,
      verificationPhrase: deriveVerificationPhrase(this.desktopPublicKey, input.devicePublicKey),
    }
  }
}
```

- [x] **Step 4: Run tests**

Run: `npm test -- remotePairing`
Expected: PASS, all 8.

- [x] **Step 5: Commit**

```bash
git add src/main/remoteBridge/pairing.ts tests/electron/remotePairing.test.ts
git commit -m "feat(remote): single-use, time-boxed pairing with verification phrase

A QR on screen is a credential, so the offer is single-use and expires in 90s.
Secret comparison is timing-safe.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: Request dispatcher

**Files:**
- Create: `src/main/remoteBridge/dispatcher.ts`
- Test: `tests/electron/remoteDispatcher.test.ts`

**Interfaces:**
- Consumes: `LocalMcpClient` (Task 7), `assertAllowed` (Task 5), `RemoteRequest`/`Capabilities` (Task 2).
- Produces: `class RequestDispatcher` with `constructor(mcp: Pick<LocalMcpClient, 'callTool'>)`, `dispatch(request: RemoteRequest, caps: Capabilities): Promise<unknown>`.

- [x] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { RequestDispatcher } from '../../src/main/remoteBridge/dispatcher'
import { CapabilityError } from '../../src/main/remoteBridge/remotePolicy'
import { NO_CAPABILITIES, type Capabilities } from '../../src/main/remoteBridge/protocol'

const all: Capabilities = { read: true, createTerminal: true, writeToTerminal: true, closeTerminal: true }
const fakeMcp = () => ({ callTool: vi.fn().mockResolvedValue({ ok: true }) })

describe('RequestDispatcher', () => {
  it('maps listTerminals to the list_terminals tool', async () => {
    const mcp = fakeMcp()
    await new RequestDispatcher(mcp).dispatch({ kind: 'listTerminals' }, all)
    expect(mcp.callTool).toHaveBeenCalledWith('list_terminals', {})
  })

  it('maps createTerminal with its arguments', async () => {
    const mcp = fakeMcp()
    await new RequestDispatcher(mcp).dispatch({ kind: 'createTerminal', name: 'agent-1', cwd: '/repo' }, all)
    expect(mcp.callTool).toHaveBeenCalledWith('create_terminal', { name: 'agent-1', cwd: '/repo' })
  })

  it('maps writeToTerminal', async () => {
    const mcp = fakeMcp()
    await new RequestDispatcher(mcp).dispatch({ kind: 'writeToTerminal', terminalId: 't1', text: 'hi' }, all)
    expect(mcp.callTool).toHaveBeenCalledWith('write_to_terminal', { terminalId: 't1', text: 'hi' })
  })

  it('refuses a request the device lacks capability for, without touching MCP', async () => {
    const mcp = fakeMcp()
    const d = new RequestDispatcher(mcp)
    await expect(d.dispatch({ kind: 'writeToTerminal', terminalId: 't', text: 'x' }, NO_CAPABILITIES))
      .rejects.toThrow(CapabilityError)
    expect(mcp.callTool).not.toHaveBeenCalled()
  })

  it('checks capability BEFORE dispatching, for every request kind', async () => {
    const mcp = fakeMcp()
    const d = new RequestDispatcher(mcp)
    const readOnly: Capabilities = { ...NO_CAPABILITIES, read: true }
    await expect(d.dispatch({ kind: 'createTerminal', name: 'x' }, readOnly)).rejects.toThrow(CapabilityError)
    await expect(d.dispatch({ kind: 'closeTerminal', terminalId: 't' }, readOnly)).rejects.toThrow(CapabilityError)
    expect(mcp.callTool).not.toHaveBeenCalled()
  })

  it('handles subscribe/unsubscribe locally without calling MCP', async () => {
    const mcp = fakeMcp()
    const d = new RequestDispatcher(mcp)
    await d.dispatch({ kind: 'subscribe', terminalId: 't1' }, all)
    await d.dispatch({ kind: 'unsubscribe', terminalId: 't1' }, all)
    expect(mcp.callTool).not.toHaveBeenCalled()
  })

  it('propagates an MCP failure rather than swallowing it', async () => {
    const mcp = { callTool: vi.fn().mockRejectedValue(new Error('mcp down')) }
    await expect(new RequestDispatcher(mcp).dispatch({ kind: 'listTerminals' }, all))
      .rejects.toThrow(/mcp down/)
  })
})
```

- [x] **Step 2: Run it to confirm it fails**

Run: `npm test -- remoteDispatcher`
Expected: FAIL — cannot resolve `dispatcher`.

- [x] **Step 3: Implement**

```typescript
import { assertAllowed } from './remotePolicy'
import type { Capabilities, RemoteRequest } from './protocol'

interface McpLike {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
}

/** Translates remote requests into MCP tool calls, after checking capability. */
export class RequestDispatcher {
  constructor(private readonly mcp: McpLike) {}

  async dispatch(request: RemoteRequest, caps: Capabilities): Promise<unknown> {
    // Capability first, always — never let an unauthorized request reach MCP.
    assertAllowed(request, caps)

    switch (request.kind) {
      case 'listTerminals':
        return this.mcp.callTool('list_terminals', {})
      case 'createTerminal':
        return this.mcp.callTool('create_terminal', {
          name: request.name,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        })
      case 'runCommand':
        return this.mcp.callTool('run_command', {
          terminalId: request.terminalId, command: request.command,
        })
      case 'writeToTerminal':
        return this.mcp.callTool('write_to_terminal', {
          terminalId: request.terminalId, text: request.text,
        })
      case 'closeTerminal':
        return this.mcp.callTool('close_terminal', { terminalId: request.terminalId })
      case 'subscribe':
      case 'unsubscribe':
        // Subscription state lives in OutputFanout; nothing to ask MCP for.
        return { ok: true }
    }
  }
}
```

- [x] **Step 4: Run tests**

Run: `npm test -- remoteDispatcher`
Expected: PASS, all 8 — the 7 above plus one for a kind outside the union.

**Amendment applied during execution.** The switch has no `default`, and unlike
`remotePolicy` that is genuinely safe here — but only because `assertAllowed`
runs first and now rejects unknown kinds. Those two facts are load-bearing
together and were nowhere pinned: remove the guard and the switch falls through
to `undefined`, which the phone reads as a success. The added test asserts an
unrecognised kind rejects AND that MCP was never called.

- [x] **Step 5: Commit**

```bash
git add src/main/remoteBridge/dispatcher.ts tests/electron/remoteDispatcher.test.ts
git commit -m "feat(remote): request dispatcher, capability-checked before MCP

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: Supervisor (main process)

**Files:**
- Create: `src/main/remoteBridgeSupervisor.ts`
- Test: `tests/electron/remoteBridgeSupervisor.test.ts`

**Interfaces:**
- Consumes: `HostToBridge`, `BridgeToHost`, `PairedDevice` from `./remoteBridge/protocol`.
- Produces:
  - `type BridgeSpawner = () => BridgeHandle`
  - `interface BridgeHandle { postMessage(msg: HostToBridge): void; on(event: 'message', cb: (m: BridgeToHost) => void): void; on(event: 'exit', cb: (code: number) => void): void; kill(): void }`
  - `setBridgeSpawner(fn: BridgeSpawner | null): void`
  - `startRemoteBridge(init: Omit<Extract<HostToBridge, { kind: 'init' }>, 'kind'>): void`
  - `stopRemoteBridge(): void`
  - `isRemoteBridgeRunning(): boolean`
  - `isRemoteDisabled(): boolean`
  - `onBridgeMessage(cb: (m: BridgeToHost) => void): void`
  - `resolveRemoteBridgePath(): string`
  - `createRemoteBridgeTransport(bridgePath?: string): BridgeHandle` — the real fork; the app wires it via `setBridgeSpawner(() => createRemoteBridgeTransport())`
  - `_resetSupervisorForTests(): void`

Mirrors `memoryClient.ts`'s injectable-spawner pattern so tests never need a real `utilityProcess`. **Differs deliberately in one way:** on repeated crashes `memoryClient` falls back to in-process; the bridge instead **disables remote entirely**. A network-facing component must fail closed.

- [x] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  setBridgeSpawner, startRemoteBridge, stopRemoteBridge, isRemoteBridgeRunning,
  isRemoteDisabled, onBridgeMessage, _resetSupervisorForTests, type BridgeHandle,
} from '../../src/main/remoteBridgeSupervisor'
import type { BridgeToHost, HostToBridge } from '../../src/main/remoteBridge/protocol'

function fakeBridge() {
  const messageCbs: Array<(m: BridgeToHost) => void> = []
  const exitCbs: Array<(code: number) => void> = []
  const sent: HostToBridge[] = []
  const handle: BridgeHandle = {
    postMessage: (m) => sent.push(m),
    on: (event: string, cb: never) => {
      if (event === 'message') messageCbs.push(cb)
      else exitCbs.push(cb)
    },
    kill: vi.fn(),
  } as BridgeHandle
  return { handle, sent, emitExit: (c: number) => exitCbs.forEach((f) => f(c)), emit: (m: BridgeToHost) => messageCbs.forEach((f) => f(m)) }
}

const init = { mcpPort: 9315, mcpToken: 'tok', identitySecretKey: 'sk', devices: [] }

beforeEach(() => _resetSupervisorForTests())

describe('remoteBridgeSupervisor', () => {
  it('is not running before start', () => {
    expect(isRemoteBridgeRunning()).toBe(false)
  })

  it('spawns and sends init on start', () => {
    const b = fakeBridge()
    setBridgeSpawner(() => b.handle)
    startRemoteBridge(init)
    expect(isRemoteBridgeRunning()).toBe(true)
    expect(b.sent[0]).toEqual({ kind: 'init', ...init })
  })

  it('forwards bridge messages to subscribers', () => {
    const b = fakeBridge()
    setBridgeSpawner(() => b.handle)
    const seen: BridgeToHost[] = []
    onBridgeMessage((m) => seen.push(m))
    startRemoteBridge(init)
    b.emit({ kind: 'ready' })
    expect(seen).toEqual([{ kind: 'ready' }])
  })

  it('respawns after a crash', () => {
    let spawns = 0
    const bridges: ReturnType<typeof fakeBridge>[] = []
    setBridgeSpawner(() => { spawns++; const b = fakeBridge(); bridges.push(b); return b.handle })
    startRemoteBridge(init)
    bridges[0].emitExit(1)
    expect(spawns).toBe(2)
    expect(isRemoteDisabled()).toBe(false)
  })

  it('fails closed after too many crashes instead of falling back', () => {
    const bridges: ReturnType<typeof fakeBridge>[] = []
    setBridgeSpawner(() => { const b = fakeBridge(); bridges.push(b); return b.handle })
    startRemoteBridge(init)
    for (let i = 0; i < 5; i++) bridges[bridges.length - 1].emitExit(1)
    expect(isRemoteDisabled()).toBe(true)
    expect(isRemoteBridgeRunning()).toBe(false)
  })

  it('stop kills the child and does not respawn', () => {
    const b = fakeBridge()
    setBridgeSpawner(() => b.handle)
    startRemoteBridge(init)
    stopRemoteBridge()
    expect(b.handle.kill).toHaveBeenCalled()
    expect(isRemoteBridgeRunning()).toBe(false)
    b.emitExit(0)
    expect(isRemoteBridgeRunning()).toBe(false)
  })

  it('start is idempotent — a second call does not spawn twice', () => {
    let spawns = 0
    setBridgeSpawner(() => { spawns++; return fakeBridge().handle })
    startRemoteBridge(init)
    startRemoteBridge(init)
    expect(spawns).toBe(1)
  })
})
```

- [x] **Step 2: Run it to confirm it fails**

Run: `npm test -- remoteBridgeSupervisor`
Expected: FAIL — cannot resolve `remoteBridgeSupervisor`.

- [x] **Step 3: Implement**

```typescript
import { fileURLToPath } from 'url'
import { utilityProcess } from 'electron'
import type { BridgeToHost, HostToBridge } from './remoteBridge/protocol'

export interface BridgeHandle {
  postMessage(msg: HostToBridge): void
  on(event: 'message', cb: (m: BridgeToHost) => void): void
  on(event: 'exit', cb: (code: number) => void): void
  kill(): void
}

export type BridgeSpawner = () => BridgeHandle
type InitParams = Omit<Extract<HostToBridge, { kind: 'init' }>, 'kind'>

// Matches memoryClient's flap policy. The response differs: memory falls back
// in-process, but a network-facing bridge must fail CLOSED.
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 60_000

let spawner: BridgeSpawner | null = null
let handle: BridgeHandle | null = null
let params: InitParams | null = null
let disabled = false
let stopping = false
const restartTimes: number[] = []
const subscribers: Array<(m: BridgeToHost) => void> = []

export function setBridgeSpawner(fn: BridgeSpawner | null): void {
  spawner = fn
}

export function onBridgeMessage(cb: (m: BridgeToHost) => void): void {
  subscribers.push(cb)
}

export function isRemoteBridgeRunning(): boolean {
  return handle !== null
}

export function isRemoteDisabled(): boolean {
  return disabled
}

function emit(m: BridgeToHost): void {
  for (const cb of subscribers) cb(m)
}

function spawn(): void {
  if (!spawner || !params || disabled) return
  const child = spawner()
  handle = child
  child.on('message', emit)
  child.on('exit', (code) => {
    handle = null
    if (stopping || disabled) return

    const now = Date.now()
    restartTimes.push(now)
    while (restartTimes.length > 0 && now - restartTimes[0] > RESTART_WINDOW_MS) restartTimes.shift()

    if (restartTimes.length > MAX_RESTARTS) {
      disabled = true
      emit({ kind: 'error', message: `remote bridge crashed ${restartTimes.length}x in ${RESTART_WINDOW_MS / 1000}s — remote disabled` })
      return
    }
    void code
    spawn()
  })
  child.postMessage({ kind: 'init', ...params })
}

export function startRemoteBridge(init: InitParams): void {
  if (handle || disabled) return
  stopping = false
  params = init
  spawn()
}

export function stopRemoteBridge(): void {
  stopping = true
  handle?.kill()
  handle = null
}

// ── Real fork ────────────────────────────────────────────────────────────────
// Only reachable inside a packaged/dev Electron run, exactly like
// createMemoryHostTransport, so it carries the same coverage exemption.
/* c8 ignore start */

/** The bundled bridge entry, emitted next to the main `index.js` as a fourth
 *  electron-vite input. `import.meta.url`, not `__dirname`: package.json is
 *  `"type": "module"` and the built main bundle is real ESM. Same resolution
 *  `resolveMemoryHostPath()` uses. */
export function resolveRemoteBridgePath(): string {
  return fileURLToPath(new URL('./remoteBridge.js', import.meta.url))
}

/**
 * Fork the real utilityProcess. Wired by the app via
 *   setBridgeSpawner(() => createRemoteBridgeTransport())
 *
 * GOTCHA (asymmetric, and it bites — memoryClient.ts:655 documents the same trap):
 * in the CHILD, `parentPort.on('message', e => …)` receives an Electron MessageEvent
 * and the payload is `e.data`. In the PARENT, `child.on('message', m => …)` receives
 * the payload DIRECTLY. Unwrap `.data` on both sides and every message arrives
 * undefined — which looks exactly like a phone that paired but never responds.
 */
export function createRemoteBridgeTransport(
  bridgePath: string = resolveRemoteBridgePath(),
): BridgeHandle {
  const child = utilityProcess.fork(bridgePath, [], { serviceName: 'termpolis-remote-bridge' })
  return {
    postMessage: (msg) => child.postMessage(msg),
    on: (event: 'message' | 'exit', cb: never) => {
      if (event === 'message') child.on('message', cb as unknown as (m: BridgeToHost) => void)
      else child.on('exit', cb as unknown as (code: number) => void)
    },
    kill: () => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    },
  } as BridgeHandle
}
/* c8 ignore stop */

/** @internal test-only */
export function _resetSupervisorForTests(): void {
  stopping = false
  disabled = false
  handle = null
  params = null
  spawner = null
  restartTimes.length = 0
  subscribers.length = 0
}
```

- [x] **Step 4: Run tests**

Run: `npm test -- remoteBridgeSupervisor`
Expected: PASS, all 7.

- [x] **Step 5: Commit**

```bash
git add src/main/remoteBridgeSupervisor.ts tests/electron/remoteBridgeSupervisor.test.ts
git commit -m "feat(remote): utilityProcess supervisor with fail-closed restart policy

Mirrors memoryClient's injectable-spawner pattern so tests need no real child.
Differs deliberately: on repeated crashes the bridge DISABLES remote rather than
degrading to a less-protected path.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 11: Bridge entry point + build wiring

**Files:**
- Create: `src/main/remoteBridge/entry.ts`
- Modify: `electron.vite.config.ts` (add entry beside `headroomProxy`)
- Test: `tests/electron/remoteBridgeEntry.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–9.
- Produces: `createBridgeCore(deps): BridgeCore` — the testable core, with `handleHostMessage(m: HostToBridge): void` and `handleRemoteRequest(deviceId: string, env: RemoteEnvelope): Promise<RemoteResponse>`. `entry.ts`'s module side-effect wires it to `process.parentPort`; the core itself takes no Electron dependency so it is unit-testable.

- [x] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createBridgeCore } from '../../src/main/remoteBridge/entry'
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

  it('emits a pairing code with a verification phrase on beginPairing', () => {
    const { c, sent } = core()
    c.handleHostMessage({ kind: 'beginPairing', label: 'Pixel' })
    const code = sent.find((m) => m.kind === 'pairingCode')
    expect(code).toBeDefined()
    expect((code as Extract<BridgeToHost, { kind: 'pairingCode' }>).verificationPhrase.split(' ')).toHaveLength(6)
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
```

- [x] **Step 2: Run it to confirm it fails**

Run: `npm test -- remoteBridgeEntry`
Expected: FAIL — cannot resolve `entry`.

- [x] **Step 3: Implement the core plus the entry side-effect**

```typescript
import { DeviceRegistry } from './deviceRegistry'
import { RequestDispatcher } from './dispatcher'
import { OutputFanout } from './outputFanout'
import { LocalMcpClient } from './mcpClient'
import { createPairingOffer, PairingSession } from './pairing'
import { x25519 } from '@noble/curves/ed25519.js'
import type { BridgeToHost, HostToBridge, RemoteEnvelope, RemoteResponse } from './protocol'

interface McpLike {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
}

export interface BridgeCoreDeps {
  send(msg: BridgeToHost): void
  /** Injected in tests; built from init params in production. */
  mcp?: McpLike
  relayUrl: string
}

export interface BridgeCore {
  handleHostMessage(msg: HostToBridge): void
  handleRemoteRequest(deviceId: string, env: RemoteEnvelope): Promise<RemoteResponse>
}

export function createBridgeCore(deps: BridgeCoreDeps): BridgeCore {
  let registry = new DeviceRegistry()
  let dispatcher: RequestDispatcher | null = null
  let pairing: PairingSession | null = null
  let publicKey = ''
  const fanout = new OutputFanout()

  function announceDevices(): void {
    deps.send({ kind: 'devicesChanged', devices: registry.list() })
  }

  function handleHostMessage(msg: HostToBridge): void {
    switch (msg.kind) {
      case 'init': {
        registry = new DeviceRegistry(msg.devices)
        const mcp = deps.mcp ?? new LocalMcpClient(msg.mcpPort, msg.mcpToken)
        dispatcher = new RequestDispatcher(mcp)
        publicKey = Buffer.from(
          x25519.getPublicKey(new Uint8Array(Buffer.from(msg.identitySecretKey, 'hex'))),
        ).toString('hex')
        deps.send({ kind: 'ready' })
        return
      }
      case 'beginPairing': {
        const offer = createPairingOffer({ relayUrl: deps.relayUrl, desktopPublicKey: publicKey })
        pairing = new PairingSession(offer, publicKey)
        // The phrase shown here is against the desktop's own key until a device
        // completes the handshake; the device recomputes and both are compared.
        deps.send({
          kind: 'pairingCode',
          qrPayload: offer.qrPayload,
          verificationPhrase: offer.pairingId.slice(0, 12).match(/.{1,2}/g)!.slice(0, 6).join(' '),
          expiresAt: offer.expiresAt,
        })
        return
      }
      case 'cancelPairing':
        pairing = null
        return
      case 'revokeDevice':
        registry.revoke(msg.deviceId)
        fanout.dropDevice(msg.deviceId)
        announceDevices()
        return
      case 'setCapabilities':
        registry.setCapabilities(msg.deviceId, msg.capabilities)
        announceDevices()
        return
      case 'shutdown':
        dispatcher = null
        return
    }
  }

  async function handleRemoteRequest(deviceId: string, env: RemoteEnvelope): Promise<RemoteResponse> {
    const device = registry.get(deviceId)
    if (!device) return { kind: 'error', id: env.id, message: 'unknown or revoked device' }
    if (!dispatcher) return { kind: 'error', id: env.id, message: 'bridge not initialised' }

    if (env.request.kind === 'subscribe') fanout.subscribe(deviceId, env.request.terminalId)
    if (env.request.kind === 'unsubscribe') fanout.unsubscribe(deviceId, env.request.terminalId)

    try {
      const data = await dispatcher.dispatch(env.request, device.capabilities)
      registry.touch(deviceId)
      return { kind: 'ok', id: env.id, data }
    } catch (err) {
      return { kind: 'error', id: env.id, message: (err as Error).message }
    }
  }

  return { handleHostMessage, handleRemoteRequest }
}
```

Append the entry side-effect at the bottom of the same file, guarded so tests importing the module never touch Electron:

```typescript
// ── Child-process bootstrap ──────────────────────────────────────────────────
// `process.parentPort` exists ONLY when this module is running as a forked
// utilityProcess, so importing it from a test is a no-op — same guard as
// memoryHost.ts:317 and embedWorker.ts. Unreachable under vitest, hence the
// coverage exemption; the logic worth testing lives in createBridgeCore above.
//
// GOTCHA: here in the CHILD the payload is `e.data`. In the PARENT
// (remoteBridgeSupervisor) it arrives DIRECTLY. Unwrap on both sides and every
// message is undefined.
/* c8 ignore start */
interface ParentPortLike {
  on(event: 'message', cb: (e: { data: HostToBridge }) => void): void
  postMessage(msg: BridgeToHost): void
}
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort
if (parentPort) {
  const core = createBridgeCore({
    send: (m) => parentPort.postMessage(m),
    relayUrl: process.env.TERMPOLIS_RELAY_URL ?? 'wss://relay.termpolis.com',
  })
  parentPort.on('message', (e) => {
    try {
      core.handleHostMessage(e.data)
    } catch (err) {
      // Last-resort net: a throw escaping here kills the bridge and looks to the
      // user like remote silently stopped working.
      parentPort.postMessage({ kind: 'error', message: (err as Error).message })
    }
  })
}
/* c8 ignore stop */
```

- [x] **Step 4: Run tests**

Run: `npm test -- remoteBridgeEntry`
Expected: PASS, all 9.

- [x] **Step 5: Add the build entry**

In `electron.vite.config.ts`, inside `main.build.rollupOptions.input`, add beside `headroomProxy`:

```typescript
          // The remote bridge runs in its own utilityProcess: it parses frames from
          // an untrusted network, so a crash there must not take the app down, and
          // main stays free to pump PTY.
          remoteBridge: resolve(__dirname, 'src/main/remoteBridge/entry.ts'),
```

- [x] **Step 6: Verify the bundle emits**

Run: `npm run build`
Expected: build succeeds and `out/main/remoteBridge.js` exists. Confirm with:

```bash
ls out/main/remoteBridge.js
```

- [x] **Step 7: Commit**

```bash
git add src/main/remoteBridge/entry.ts electron.vite.config.ts tests/electron/remoteBridgeEntry.test.ts
git commit -m "feat(remote): bridge core + utilityProcess entry, wired into the build

Core is Electron-free so it unit-tests directly; the parentPort wiring is a
guarded side-effect that stays inert under vitest.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 12: CLI test client (end-to-end verification)

**Files:**
- Create: `scripts/remote-test-client.cjs`
- Test: `tests/electron/remoteEndToEnd.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: a runnable harness proving pair → grant → request → revoke without any mobile code.

- [x] **Step 1: Write the failing end-to-end test**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createBridgeCore } from '../../src/main/remoteBridge/entry'
import { SealedChannel, generateIdentity, deriveVerificationPhrase } from '../../src/main/remoteBridge/sealedChannel'
import { NO_CAPABILITIES, type BridgeToHost, type PairedDevice, type RemoteResponse } from '../../src/main/remoteBridge/protocol'
import { PairingSession, createPairingOffer } from '../../src/main/remoteBridge/pairing'

const enc = new TextEncoder()
const dec = new TextDecoder()

describe('remote bridge end-to-end', () => {
  it('pairs, grants, serves, and revokes — with every frame sealed', async () => {
    const desktop = generateIdentity()
    const phone = generateIdentity()

    // 1. Pair out of band, exactly as the QR flow does.
    const offer = createPairingOffer({ relayUrl: 'wss://relay.test', desktopPublicKey: desktop.publicKey })
    const session = new PairingSession(offer, desktop.publicKey)
    const { device, verificationPhrase } = session.accept({
      oneTimeSecret: JSON.parse(offer.qrPayload).oneTimeSecret,
      devicePublicKey: phone.publicKey,
      label: 'Test Phone',
    })

    // Both ends independently derive the same phrase — this is what defeats a MITM relay.
    expect(verificationPhrase).toBe(deriveVerificationPhrase(phone.publicKey, desktop.publicKey))

    // 2. Boot the bridge with that device paired but ungranted.
    const sent: BridgeToHost[] = []
    const callTool = vi.fn().mockResolvedValue({ terminals: [{ id: 't1', name: 'agent' }] })
    const core = createBridgeCore({ send: (m) => sent.push(m), mcp: { callTool }, relayUrl: 'wss://relay.test' })
    core.handleHostMessage({
      kind: 'init', mcpPort: 1, mcpToken: 'tok',
      identitySecretKey: desktop.secretKey,
      devices: [device as PairedDevice],
    })

    // 3. Ungranted device is refused.
    const denied = await core.handleRemoteRequest(device.id, { id: 1, request: { kind: 'listTerminals' } })
    expect(denied.kind).toBe('error')
    expect(callTool).not.toHaveBeenCalled()

    // 4. User grants read in Settings.
    core.handleHostMessage({
      kind: 'setCapabilities', deviceId: device.id,
      capabilities: { ...NO_CAPABILITIES, read: true },
    })

    // 5. Now it is served — and the response survives a sealed round-trip.
    const ok = await core.handleRemoteRequest(device.id, { id: 2, request: { kind: 'listTerminals' } })
    expect(ok.kind).toBe('ok')

    const toPhone = new SealedChannel(desktop.secretKey, phone.publicKey)
    const atPhone = new SealedChannel(phone.secretKey, desktop.publicKey)
    const frame = toPhone.seal(enc.encode(JSON.stringify(ok)))
    const received = JSON.parse(dec.decode(atPhone.open(frame))) as RemoteResponse
    expect(received).toEqual(ok)

    // 6. A relay that tampers with the frame gets nothing through.
    const tampered = toPhone.seal(enc.encode(JSON.stringify(ok)))
    tampered[tampered.length - 1] ^= 0xff
    expect(() => atPhone.open(tampered)).toThrow()

    // 7. Revoke takes effect immediately.
    core.handleHostMessage({ kind: 'revokeDevice', deviceId: device.id })
    const afterRevoke = await core.handleRemoteRequest(device.id, { id: 3, request: { kind: 'listTerminals' } })
    expect(afterRevoke.kind).toBe('error')
  })

  it('never lets an unpaired device reach MCP even with a valid-looking request', async () => {
    const callTool = vi.fn()
    const core = createBridgeCore({ send: () => {}, mcp: { callTool }, relayUrl: 'wss://relay.test' })
    core.handleHostMessage({
      kind: 'init', mcpPort: 1, mcpToken: 'tok', identitySecretKey: generateIdentity().secretKey, devices: [],
    })
    const res = await core.handleRemoteRequest('attacker', { id: 1, request: { kind: 'runCommand', terminalId: 't', command: 'rm -rf /' } })
    expect(res.kind).toBe('error')
    expect(callTool).not.toHaveBeenCalled()
  })
})
```

- [x] **Step 2: Run it**

Run: `npm test -- remoteEndToEnd`
Expected: PASS, both. If anything fails, the failure is real — fix the implementation, not the test.

- [x] **Step 3: Write the CLI harness**

```javascript
#!/usr/bin/env node
'use strict'
/**
 * Manual harness for the remote bridge — the stand-in for the phone app until
 * sub-project 3 exists. Drives a pairing offer through to a served request.
 *
 * Usage: node scripts/remote-test-client.cjs
 */
const path = require('path')
const { createBridgeCore } = require(path.join(__dirname, '..', 'out', 'main', 'remoteBridge.js'))
const { generateIdentity, deriveVerificationPhrase } = require(path.join(__dirname, '..', 'out', 'main', 'remoteBridge.js'))

const desktop = generateIdentity()
const phone = generateIdentity()

const sent = []
const core = createBridgeCore({
  send: (m) => { sent.push(m); console.log('[bridge→host]', JSON.stringify(m)) },
  mcp: { callTool: async (name, args) => ({ stub: name, args }) },
  relayUrl: 'wss://relay.test',
})

core.handleHostMessage({
  kind: 'init', mcpPort: 9315, mcpToken: 'stub', identitySecretKey: desktop.secretKey, devices: [],
})
core.handleHostMessage({ kind: 'beginPairing', label: 'CLI Test Client' })

console.log('\nverification phrase (compare on both ends):')
console.log('  ', deriveVerificationPhrase(desktop.publicKey, phone.publicKey))
console.log('\nrun the vitest suite for the full assertion-backed flow:')
console.log('   npm test -- remoteEndToEnd')
```

- [x] **Step 4: Run the harness**

Run: `npm run build && node scripts/remote-test-client.cjs`
Expected: prints a `ready` message, a `pairingCode` message, and a 6-word phrase. No stack trace.

- [x] **Step 5: Full gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all PASS, coverage thresholds (lines 97 / fn 96 / branches 95 / stmts 96) still met. If a new module drags branches under 95, backfill its tests — do not lower the gate.

- [x] **Step 6: Commit**

```bash
git add scripts/remote-test-client.cjs tests/electron/remoteEndToEnd.test.ts
git commit -m "test(remote): end-to-end pair -> grant -> serve -> revoke, plus CLI harness

Proves the bridge with no mobile code and no relay: sealed round-trip, tamper
rejection, capability enforcement, and immediate revocation.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage.**

| Spec section | Task |
|---|---|
| §4.2 Cryptography | 3 |
| §4.2 Key storage constraint | 10 (init carries `identitySecretKey` from main) |
| §4.3 Pairing (single-use, TTL, verification phrase) | 8 |
| §4.4 Authorization (default off, per-device, revocable, idle-expiring) | 4, 5, 11 |
| §4.5 `write_to_terminal` as its own grant | 5 |
| §5.0 Process placement | 10, 11 |
| §5.1 Modules | 2–9, 11 |
| §5.2 Output loss | 6 |
| §5.3 Shared status detector | 1 |
| §8 Testing | every task |

**Gaps deliberately deferred, and where they land:**
- **Relay transport (`bridgeClient.ts` / WSS).** Not in sub-project 1 — there is no relay to dial until sub-project 2. The core is transport-agnostic by construction (`handleRemoteRequest` takes a decoded envelope), so the socket drops in without touching the tested logic.
- **Settings → Remote UI, and the attached-device indicator.** Deferred to the same pass as the transport; until a device can actually attach, the UI has nothing to show. `devicesChanged` / `attachedChanged` messages already exist for it.
- **Push notifications (`pushNotifier.ts`).** Needs APNs/FCM credentials from sub-project 3. Task 1 moves the detector it will depend on.
- **Wiring `startRemoteBridge` into `src/main/index.ts` app startup.** Intentionally last, in the transport pass — wiring it now would ship a spawned process with nothing to talk to.

**2. Placeholder scan.** No TBD/TODO, no "add error handling", no "similar to Task N". Every code step carries runnable code.

**3. Type consistency.** `Capabilities`, `PairedDevice`, `RemoteRequest`, `RemoteResponse`, `RemoteEnvelope`, `HostToBridge`, `BridgeToHost` are defined once in Task 2 and used verbatim after. `OutputSlice`'s shape is structurally matched in Task 6 rather than imported, so the fan-out has no dependency on `terminalOutputBuffer`. `callTool(name, args)` is identical in Tasks 7, 9, and 11.

**4. Facts verified against the codebase rather than assumed.** Each of these was checked while writing the plan, and each would have produced a silent failure if guessed:

- **noble v2 import paths.** `@noble/curves/ed25519.js`, `@noble/ciphers/chacha.js`, `@noble/hashes/sha2.js` — confirmed by installing 2.4.0 and running a real ECDH + AEAD round-trip. The v1 extensionless paths (and `hashes/sha256`) do not resolve.
- **MCP tool argument shapes.** `create_terminal {name, shell?, cwd?}`, `run_command {terminalId, command}`, `write_to_terminal {terminalId, text}`, `close_terminal {terminalId}` — read from the `inputSchema` blocks at `src/main/mcpServer.ts:117-205`.
- **MCP failure envelope.** Tool errors return `result.isError`, not JSON-RPC `error` (`src/main/mcpServer.ts:770-772`). Task 7 checks both.
- **Headroom exemption.** `src/main/headroom/router.ts:3-6` exempts exactly the five tools the dispatcher calls, so their text is parseable JSON. `read_output` is not exempt — flagged for the transport pass.
- **Parent/child MessagePort asymmetry.** Child unwraps `e.data`; parent receives the payload directly (`src/main/memoryClient.ts:655-658`, `src/main/memoryHost.ts:306-310`). Task 10 and Task 11 sit on opposite sides of this and are written accordingly.
- **Coverage exemptions.** Fork and bootstrap blocks are unreachable under vitest, so both carry `/* c8 ignore start|stop */`, matching `memoryClient.ts` and `memoryHost.ts`. Without them the branches ≥95 gate fails on code no unit test can reach.

**That rough edge was fixed during execution, not deferred.** The drafted Task 11
emitted a placeholder `verificationPhrase` off the pairing id and left a note to
fix it when the transport landed. That was the wrong call. The safety number's
entire value is that it is a function of BOTH public keys — a placeholder encodes
nothing about who the user is talking to while looking exactly like one that
does, so the UI would render it, the user would compare it against the phone, and
the comparison would be a ritual rather than a check. A security control that
verifies nothing is worse than an absent one, because it stops anyone looking for
the real thing.

ESLint found it independently: `pairing` was assigned and never read, because
nothing ever accepted against the session. Both were the same defect.

`pairingCode` now carries no phrase at all. `BridgeCore` gained
`acceptPairing({ oneTimeSecret, devicePublicKey, label, now? })`, which spends the
offer, adds the device, and emits the real phrase from
`PairingSession.accept()` in a new `verificationPhrase` message. It is separate
from `handleHostMessage` because it is driven by the relay, not by main — which
is also what lets Task 12's CLI client complete a pairing with no mobile code and
no relay running.
