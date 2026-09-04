# Termpolis Remote — Relay Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hosted, multi-tenant, zero-knowledge relay that lets a paired desktop and phone exchange sealed frames without either opening an inbound port — plus the bridge-side client that dials it.

**Architecture:** A Cloudflare Worker routes WebSocket upgrades to a Durable Object named by an opaque pairing id. Each DO (`PairingRoom`) holds at most two sockets — `desktop` and `device` — and forwards binary frames between them without inspecting a single byte. Quotas live in the DO (frame size, frame rate, byte budget, idle timeout) and at the Worker edge (registration rate). On the desktop, `relayClient.ts` dials one room per paired device over the `ws` package, seals and opens frames with that device's `SealedChannel`, and fails closed with exponential backoff when the relay is unreachable.

**Tech Stack:** Cloudflare Workers + Durable Objects, `wrangler` 4.x, `@cloudflare/vitest-pool-workers`, `ws` (pure JS) on the desktop side, `@noble/*` 2.4.0 for the sealed channel (already present).

**Spec:** `docs/superpowers/specs/2026-09-04-termpolis-remote-design.md` — §3 architecture, §4 security model, §7 relay service.

**Prior plan:** `docs/superpowers/plans/2026-09-04-remote-bridge.md` (sub-project 1, shipped). This plan consumes its `SealedChannel`, `RemoteEnvelope`/`RemoteResponse` types, and `BridgeCore`.

---

## Global Constraints

- **The relay is zero-knowledge.** It holds no keys, stores no plaintext, and persists no frame body. It may see only: the pairing id, frame sizes, timing, and connection metadata. Any task that would make the relay able to read a frame is wrong, however convenient.
- **No native dependencies anywhere.** `ws` is pure JS; its optional `bufferutil` / `utf-8-validate` accelerators MUST NOT be installed. The app has been burned by native artifacts before (the memory embedder went WASM for this reason).
- **`relay/` is its own npm project.** It gets its own `package.json`, `node_modules`, and vitest config. It MUST NOT be added to the root `dependencies` or dragged into the Electron coverage gate.
- **Coverage gate (Windows CI), root project:** lines 97 / functions 96 / branches 95 / statements 96. **Never lower these** — backfill tests on the offending file. Bridge-side code added by this plan (`relayClient.ts`) is under `src/` and counts.
- **Relay coverage gate:** lines 95 / functions 95 / branches 90 / statements 95, enforced in `relay/vitest.config.ts`. Lower than the app's because Workers runtime edges (hibernation, DO eviction) are not all reachable in-process.
- **Commit directly to `main`.** No branches, no PRs. Releases are a version bump plus a `vX.Y.Z` tag.
- **Electron 30 runs Node 20.16, which has NO global `WebSocket`** (verified: `ELECTRON_RUN_AS_NODE=1 electron -p "typeof WebSocket"` → `undefined`). The desktop side must use the `ws` package. Do not write code that assumes a global.
- **Frame size cap: 256 KiB.** Matches `DEFAULT_CAPACITY_CHARS` in `outputFanout.ts` (262_144), so a full drain always fits in one frame.
- **Never commit a Cloudflare token.** Deployment uses `wrangler login` or a `CLOUDFLARE_API_TOKEN` set in CI secrets. `gh secret list` shows what already exists.
- **Test secrets must fail entropy heuristics** — use `'a'.repeat(N)`, not realistic-looking keys. GitHub push protection blocks the latter.

---

## File Structure

**New — relay project (its own npm workspace, not part of the Electron build):**

| File | Responsibility |
|---|---|
| `relay/package.json` | Relay-only deps and scripts. Not referenced by the root build. |
| `relay/wrangler.toml` | Worker name, DO binding, compatibility date, routes. |
| `relay/tsconfig.json` | Workers types only. |
| `relay/vitest.config.ts` | `@cloudflare/vitest-pool-workers` + the relay coverage gate. |
| `relay/src/index.ts` | Worker entry. Validates the upgrade request, applies the registration rate limit, routes to the DO. Nothing else. |
| `relay/src/pairingRoom.ts` | The Durable Object. Owns the two sockets, forwards frames, enforces per-connection quotas and the idle timeout. |
| `relay/src/quota.ts` | Pure token-bucket + byte-budget logic. No Workers API, so it is testable without a runtime. |
| `relay/src/wire.ts` | The control-frame vocabulary shared by relay and client (`hello`, `peer-joined`, `peer-gone`, `quota-exceeded`). Data frames are opaque and never parsed. |
| `relay/test/*.test.ts` | Worker + DO tests under the Workers pool; `quota.test.ts` runs pure. |
| `relay/PRIVACY.md` | The honest, short privacy statement §7 calls for. |
| `relay/DEPLOY.md` | Runbook: account setup, `wrangler deploy`, custom domain, rollback. |

**New — desktop side (inside the existing app, counts toward the app coverage gate):**

| File | Responsibility |
|---|---|
| `src/main/remoteBridge/relayClient.ts` | One `ws` connection per paired device. Dial, backoff, seal/open, and the outbound output pump. Owns no policy. |

**Modified:**

| File | Change |
|---|---|
| `src/main/remoteBridge/entry.ts` | Construct a `RelayClient` per paired device on `init`/`paired`; tear one down on `revokeDevice`. Route opened frames into `handleRemoteRequest`. |
| `src/main/remoteBridge/protocol.ts` | Add the `relayUrl` shape and the `deviceConnected` / `deviceDisconnected` messages to `BridgeToHost`. |
| `vitest.config.ts` | Add `'**/relay/**'` to `test.exclude` so the root run does not try to execute Workers tests in the Node pool. |
| `package.json` | Add `ws` + `@types/ws` to dependencies; add `test:relay` and `deploy:relay` scripts. |
| `.github/workflows/*` | Add a relay test job. Relay tests are blocking, like `e2e/`. |

---

## Task 1: Relay project scaffold that serves a rejection

The smallest deployable relay: a Worker that correctly refuses everything that is not a pairing WebSocket upgrade. Getting the scaffold, the Workers test pool, and the coverage gate green here means every later task is a normal TDD cycle.

**Files:**
- Create: `relay/package.json`, `relay/wrangler.toml`, `relay/tsconfig.json`, `relay/vitest.config.ts`
- Create: `relay/src/index.ts`
- Test: `relay/test/worker.test.ts`
- Modify: `vitest.config.ts` (exclude `relay/`), root `package.json` (add `test:relay`)

**Interfaces:**
- Consumes: nothing.
- Produces: `export default { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> }`; `interface Env { PAIRING_ROOM: DurableObjectNamespace }`.

- [x] **Step 1: Scaffold the relay project**

```bash
mkdir -p relay/src relay/test
cd relay
npm init -y
npm i -D wrangler@4 @cloudflare/vitest-pool-workers @cloudflare/workers-types vitest@4 typescript
npm pkg set name=termpolis-relay private=true type=module
npm pkg set scripts.test="vitest run" scripts.dev="wrangler dev" scripts.deploy="wrangler deploy"
```

`relay/wrangler.toml`:

```toml
name = "termpolis-relay"
main = "src/index.ts"
compatibility_date = "2026-09-01"

[[durable_objects.bindings]]
name = "PAIRING_ROOM"
class_name = "PairingRoom"

[[migrations]]
tag = "v1"
new_classes = ["PairingRoom"]
```

`relay/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`relay/vitest.config.ts`:

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    poolOptions: { workers: { wrangler: { configPath: './wrangler.toml' } } },
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      // Lower than the app's 97/96/95/96: Workers runtime edges (hibernation,
      // DO eviction, socket teardown races) are not all reachable in-process.
      thresholds: { lines: 95, functions: 95, branches: 90, statements: 95 },
    },
  },
})
```

- [x] **Step 2: Keep the relay out of the app's test run**

The root vitest config has no `include` restriction on test files, so `relay/**/*.test.ts` would be collected into the Node pool and fail on missing Workers globals. Add the exclusion in `vitest.config.ts`:

```ts
    exclude: ['**/node_modules/**', '**/.worktrees/**', '**/e2e/**', '**/relay/**'],
```

And in the root `package.json`:

```json
    "test:relay": "npm --prefix relay test",
```

- [x] **Step 3: Write the failing test**

`relay/test/worker.test.ts`:

```ts
import { env, SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'

describe('worker routing', () => {
  it('refuses a plain GET on the pairing path with 426', async () => {
    const res = await SELF.fetch('https://relay.test/v1/pair/abc123')
    expect(res.status).toBe(426)
    expect(await res.text()).toMatch(/websocket/i)
  })

  it('404s an unknown path', async () => {
    const res = await SELF.fetch('https://relay.test/nope')
    expect(res.status).toBe(404)
  })

  // The pairing id is the ONLY routing key, and it comes from a stranger. A
  // permissive parse would let a caller address arbitrary DO names.
  it('rejects a pairing id that is not 32 lowercase hex chars', async () => {
    for (const bad of ['', 'short', 'A'.repeat(32), 'g'.repeat(32), 'a'.repeat(33), '../admin']) {
      const res = await SELF.fetch(`https://relay.test/v1/pair/${bad}`, {
        headers: { Upgrade: 'websocket' },
      })
      expect(res.status, `pairing id ${JSON.stringify(bad)}`).toBe(400)
    }
  })

  it('exposes no build or platform detail in error bodies', async () => {
    const res = await SELF.fetch('https://relay.test/nope')
    const body = await res.text()
    expect(body).not.toMatch(/cloudflare|worker|durable|stack/i)
  })
})
```

- [x] **Step 4: Run it to verify it fails**

Run: `npm --prefix relay test`
Expected: FAIL — `src/index.ts` does not exist.

- [x] **Step 5: Write the minimal implementation**

`relay/src/index.ts`:

```ts
export interface Env {
  PAIRING_ROOM: DurableObjectNamespace
}

/** Pairing ids are 16 random bytes rendered lowercase hex — see `createPairingOffer`
 *  in the desktop bridge. Validated here rather than trusted because this string
 *  names a Durable Object: a permissive parse lets a stranger address any name they
 *  can spell, including ones this Worker uses for something else later. */
const PAIRING_ID = /^[0-9a-f]{32}$/

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const match = /^\/v1\/pair\/([^/]*)$/.exec(url.pathname)
    if (!match) return new Response('not found', { status: 404 })

    const pairingId = match[1]
    if (!PAIRING_ID.test(pairingId)) return new Response('bad pairing id', { status: 400 })

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 })
    }

    const id = env.PAIRING_ROOM.idFromName(pairingId)
    return env.PAIRING_ROOM.get(id).fetch(request)
  },
}

export { PairingRoom } from './pairingRoom'
```

`relay/src/pairingRoom.ts` — a stub for now, filled in by Task 2:

```ts
export class PairingRoom {
  async fetch(_request: Request): Promise<Response> {
    return new Response('not implemented', { status: 501 })
  }
}
```

- [x] **Step 6: Run the tests and make sure they pass**

Run: `npm --prefix relay test`
Expected: PASS, 4 tests.

- [x] **Step 7: Commit**

```bash
git add relay vitest.config.ts package.json
git commit -m "feat(relay): worker scaffold that routes only valid pairing upgrades"
```

---

## Task 2: The pairing room accepts exactly two peers

**Files:**
- Modify: `relay/src/pairingRoom.ts`
- Create: `relay/src/wire.ts`
- Test: `relay/test/pairingRoom.test.ts`

**Interfaces:**
- Consumes: `Env` from Task 1.
- Produces: `class PairingRoom implements DurableObject`; `type ControlFrame` in `wire.ts` with kinds `hello`, `peer-joined`, `peer-gone`, `quota-exceeded`, `error`; `const ROLES = ['desktop', 'device'] as const`.

- [x] **Step 1: Write the failing test**

`relay/test/pairingRoom.test.ts`:

```ts
import { SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'

const ROOM = 'a'.repeat(32)

async function connect(room: string, role: string): Promise<WebSocket> {
  const res = await SELF.fetch(`https://relay.test/v1/pair/${room}?role=${role}`, {
    headers: { Upgrade: 'websocket' },
  })
  const ws = res.webSocket
  if (!ws) throw new Error(`no socket: ${res.status} ${await res.text()}`)
  ws.accept()
  return ws
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.addEventListener('message', (e) => resolve(String(e.data)), { once: true })
  })
}

describe('pairing room', () => {
  it('accepts a desktop and a device', async () => {
    const desktop = await connect(ROOM, 'desktop')
    expect(JSON.parse(await nextMessage(desktop))).toEqual({ kind: 'hello', role: 'desktop' })

    const device = await connect(ROOM, 'device')
    expect(JSON.parse(await nextMessage(device))).toEqual({ kind: 'hello', role: 'device' })
  })

  it('tells a waiting desktop when its device arrives', async () => {
    const room = 'b'.repeat(32)
    const desktop = await connect(room, 'desktop')
    await nextMessage(desktop) // hello
    const joined = nextMessage(desktop)
    await connect(room, 'device')
    expect(JSON.parse(await joined)).toEqual({ kind: 'peer-joined', role: 'device' })
  })

  it('refuses a role that is already taken', async () => {
    const room = 'c'.repeat(32)
    await connect(room, 'desktop')
    const res = await SELF.fetch(`https://relay.test/v1/pair/${room}?role=desktop`, {
      headers: { Upgrade: 'websocket' },
    })
    expect(res.status).toBe(409)
  })

  it('refuses an unknown role', async () => {
    const res = await SELF.fetch(`https://relay.test/v1/pair/${'d'.repeat(32)}?role=admin`, {
      headers: { Upgrade: 'websocket' },
    })
    expect(res.status).toBe(400)
  })
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `npm --prefix relay test pairingRoom`
Expected: FAIL — the stub returns 501.

- [x] **Step 3: Write `wire.ts`**

```ts
/** The two ends of a pairing. A room holds at most one socket per role, which is
 *  what makes a third connection an error rather than a silent extra listener. */
export const ROLES = ['desktop', 'device'] as const
export type Role = (typeof ROLES)[number]

export function isRole(value: string | null): value is Role {
  return value !== null && (ROLES as readonly string[]).includes(value)
}

/** Relay-to-peer control messages.
 *
 *  These are the ONLY frames the relay ever authors, and the only ones it parses.
 *  They are JSON text frames; everything a peer sends as BINARY is opaque payload
 *  and is forwarded byte-for-byte without being read. Keeping the two on different
 *  WebSocket frame types is what makes "the relay cannot read your traffic" a
 *  structural property rather than a promise: there is no branch in which a binary
 *  frame reaches a parser. */
export type ControlFrame =
  | { kind: 'hello'; role: Role }
  | { kind: 'peer-joined'; role: Role }
  | { kind: 'peer-gone'; role: Role }
  | { kind: 'quota-exceeded'; limit: 'frame-size' | 'frame-rate' | 'bytes' | 'idle' }
  | { kind: 'error'; message: string }

export function encode(frame: ControlFrame): string {
  return JSON.stringify(frame)
}
```

- [x] **Step 4: Write the minimal `PairingRoom`**

`relay/src/pairingRoom.ts`:

```ts
import { encode, isRole, type Role } from './wire'

export class PairingRoom {
  /** At most one socket per role. A Map rather than two fields so the peer lookup
   *  is `[...peers].find(r => r !== role)` instead of a conditional that has to be
   *  kept in step with the role list. */
  private readonly peers = new Map<Role, WebSocket>()

  async fetch(request: Request): Promise<Response> {
    const role = new URL(request.url).searchParams.get('role')
    if (!isRole(role)) return new Response('bad role', { status: 400 })
    if (this.peers.has(role)) return new Response('role already connected', { status: 409 })

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    server.accept()
    this.peers.set(role, server)

    server.send(encode({ kind: 'hello', role }))
    for (const [otherRole, sock] of this.peers) {
      if (otherRole !== role) sock.send(encode({ kind: 'peer-joined', role }))
    }

    server.addEventListener('close', () => this.drop(role))
    server.addEventListener('error', () => this.drop(role))

    return new Response(null, { status: 101, webSocket: client })
  }

  private drop(role: Role): void {
    this.peers.delete(role)
    for (const [otherRole, sock] of this.peers) {
      if (otherRole !== role) sock.send(encode({ kind: 'peer-gone', role }))
    }
  }
}
```

- [x] **Step 5: Run the tests and make sure they pass**

Run: `npm --prefix relay test`
Expected: PASS, 8 tests.

- [x] **Step 6: Commit**

```bash
git add relay
git commit -m "feat(relay): pairing room admits one desktop and one device"
```

---

## Task 3: Forward opaque frames, and only opaque frames

The heart of the zero-knowledge claim. A binary frame from one peer reaches the other byte-for-byte, and no code path reads it.

**Files:**
- Modify: `relay/src/pairingRoom.ts`
- Test: `relay/test/forwarding.test.ts`

**Interfaces:**
- Consumes: `PairingRoom`, `ControlFrame` from Task 2.
- Produces: no new exports; `PairingRoom` gains binary forwarding.

- [x] **Step 1: Write the failing test**

`relay/test/forwarding.test.ts`:

```ts
import { SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'

async function connect(room: string, role: string): Promise<WebSocket> {
  const res = await SELF.fetch(`https://relay.test/v1/pair/${room}?role=${role}`, {
    headers: { Upgrade: 'websocket' },
  })
  const ws = res.webSocket!
  ws.accept()
  return ws
}

function nextBinary(ws: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve) => {
    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string') resolve(new Uint8Array(e.data as ArrayBuffer))
    })
  })
}

describe('frame forwarding', () => {
  it('delivers a sealed frame byte-for-byte in both directions', async () => {
    const room = '1'.repeat(32)
    const desktop = await connect(room, 'desktop')
    const device = await connect(room, 'device')

    // Every byte value, so a charset-mangling round trip cannot pass.
    const payload = new Uint8Array(256).map((_, i) => i)
    const arriving = nextBinary(device)
    desktop.send(payload)
    expect(Array.from(await arriving)).toEqual(Array.from(payload))

    const back = new Uint8Array([0, 255, 0, 255])
    const arrivingBack = nextBinary(desktop)
    device.send(back)
    expect(Array.from(await arrivingBack)).toEqual(Array.from(back))
  })

  it('drops a frame addressed at nobody rather than buffering it', async () => {
    const room = '2'.repeat(32)
    const desktop = await connect(room, 'desktop')
    desktop.send(new Uint8Array([1, 2, 3])) // no device yet

    const device = await connect(room, 'device')
    // The device must NOT receive the frame sent before it existed. Buffering it
    // would mean the relay stores plaintext-shaped state between connections,
    // which is exactly the property the design promises it does not have.
    const seen: unknown[] = []
    device.addEventListener('message', (e) => { if (typeof e.data !== 'string') seen.push(e.data) })
    await new Promise((r) => setTimeout(r, 50))
    expect(seen).toEqual([])
  })

  it('ignores a text frame from a peer instead of acting on it', async () => {
    const room = '3'.repeat(32)
    const desktop = await connect(room, 'desktop')
    const device = await connect(room, 'device')

    const seen: string[] = []
    device.addEventListener('message', (e) => { if (typeof e.data === 'string') seen.push(e.data) })
    // A peer must not be able to forge the relay's own control vocabulary at its
    // partner, nor address the relay itself.
    desktop.send(JSON.stringify({ kind: 'peer-gone', role: 'device' }))
    await new Promise((r) => setTimeout(r, 50))
    expect(seen).toEqual([])
  })
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `npm --prefix relay test forwarding`
Expected: FAIL — nothing forwards yet; the first assertion times out.

- [x] **Step 3: Add forwarding**

In `PairingRoom.fetch`, after the `close`/`error` listeners:

```ts
    server.addEventListener('message', (event) => {
      // Text is a peer trying to talk to the relay, or to forge a control frame at
      // its partner. Neither is part of the protocol: peers speak to each other in
      // BINARY only, and the relay authors every control frame itself. Dropping
      // text unread means there is no parser for a peer to reach.
      if (typeof event.data === 'string') return

      const peer = this.peer(role)
      // No partner: drop. Queueing would make the relay hold frame bodies between
      // connections, which is the one thing it promises not to do.
      if (!peer) return
      peer.send(event.data)
    })
```

and the lookup:

```ts
  private peer(role: Role): WebSocket | undefined {
    for (const [otherRole, sock] of this.peers) if (otherRole !== role) return sock
    return undefined
  }
```

- [x] **Step 4: Run the tests and make sure they pass**

Run: `npm --prefix relay test`
Expected: PASS, 11 tests.

- [x] **Step 5: Prove the forwarding test is not vacuous**

Temporarily change `peer.send(event.data)` to `peer.send(new Uint8Array([0]))`. Re-run: the byte-for-byte test must fail. Restore.

- [x] **Step 6: Commit**

```bash
git add relay
git commit -m "feat(relay): forward binary frames untouched, drop text unread"
```

---

## Task 4: Quotas

Abuse controls from §7. The pure logic lives in `quota.ts` so it is testable without a Workers runtime; the DO only wires it to sockets.

**Files:**
- Create: `relay/src/quota.ts`
- Modify: `relay/src/pairingRoom.ts`
- Test: `relay/test/quota.test.ts`, `relay/test/quotaEnforcement.test.ts`

**Interfaces:**
- Consumes: `ControlFrame` from Task 2.
- Produces: `MAX_FRAME_BYTES`, `class TokenBucket { constructor(capacity: number, refillPerMs: number); take(now: number, cost?: number): boolean }`, `class ByteBudget { constructor(limit: number); spend(n: number): boolean }`.

- [x] **Step 1: Write the failing test**

`relay/test/quota.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { TokenBucket, ByteBudget, MAX_FRAME_BYTES } from '../src/quota'

describe('token bucket', () => {
  it('allows a burst up to capacity then refuses', () => {
    const b = new TokenBucket(3, 0) // no refill
    expect(b.take(0)).toBe(true)
    expect(b.take(0)).toBe(true)
    expect(b.take(0)).toBe(true)
    expect(b.take(0)).toBe(false)
  })

  it('refills over time but never past capacity', () => {
    const b = new TokenBucket(2, 1 / 1000) // one token per second
    expect(b.take(0)).toBe(true)
    expect(b.take(0)).toBe(true)
    expect(b.take(0)).toBe(false)
    expect(b.take(1000)).toBe(true)
    // A long idle must not bank an unbounded burst.
    expect(b.take(1_000_000)).toBe(true)
    expect(b.take(1_000_000)).toBe(true)
    expect(b.take(1_000_000)).toBe(false)
  })

  it('does not go backwards when a clock reading regresses', () => {
    const b = new TokenBucket(2, 1 / 1000)
    expect(b.take(5000)).toBe(true)
    // Workers clocks can read non-monotonically across a hibernation boundary.
    // A negative elapsed must not subtract tokens or push `last` into the future.
    expect(b.take(1000)).toBe(true)
    expect(b.take(1000)).toBe(false)
  })
})

describe('byte budget', () => {
  it('spends down to zero and then refuses', () => {
    const b = new ByteBudget(100)
    expect(b.spend(60)).toBe(true)
    expect(b.spend(40)).toBe(true)
    expect(b.spend(1)).toBe(false)
  })

  it('refuses a single spend larger than the whole budget', () => {
    expect(new ByteBudget(100).spend(101)).toBe(false)
  })
})

describe('frame cap', () => {
  it('matches the desktop fan-out capacity so a full drain always fits', () => {
    expect(MAX_FRAME_BYTES).toBe(262_144)
  })
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `npm --prefix relay test quota`
Expected: FAIL — `src/quota.ts` does not exist.

- [x] **Step 3: Write `quota.ts`**

```ts
/** Largest frame the relay will forward. Matches `DEFAULT_CAPACITY_CHARS` in the
 *  desktop's outputFanout.ts (262_144), so a full drain always fits in one frame
 *  and the cap can never be the reason a legitimate burst of output is lost. */
export const MAX_FRAME_BYTES = 262_144

/** Frames per connection per second, and the burst allowance. A phone that is
 *  typing generates a few frames a second; 20/s with a 40 burst is far above any
 *  real use and far below what it takes to make the relay a useful amplifier. */
export const FRAME_RATE_PER_SEC = 20
export const FRAME_BURST = 40

/** Bytes one connection may forward before it is cut. 256 MiB is roughly a
 *  full day of heavy terminal output; past it, something is wrong. */
export const CONNECTION_BYTE_BUDGET = 256 * 1024 * 1024

export class TokenBucket {
  private tokens: number
  private last = 0

  constructor(private readonly capacity: number, private readonly refillPerMs: number) {
    this.tokens = capacity
  }

  /** Take one token, refilling for elapsed time first.
   *
   *  `elapsed` is clamped at zero: a Durable Object can be evicted and revived,
   *  and a clock that reads BACKWARDS across that boundary would otherwise
   *  subtract tokens and let `last` jump into the future, permanently throttling
   *  an innocent connection. Refusing to move backwards is the safe direction. */
  take(now: number, cost = 1): boolean {
    const elapsed = Math.max(0, now - this.last)
    this.last = Math.max(this.last, now)
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs)
    if (this.tokens < cost) return false
    this.tokens -= cost
    return true
  }
}

export class ByteBudget {
  private spent = 0
  constructor(private readonly limit: number) {}

  spend(n: number): boolean {
    if (this.spent + n > this.limit) return false
    this.spent += n
    return true
  }
}
```

- [x] **Step 4: Run the pure tests**

Run: `npm --prefix relay test quota.test`
Expected: PASS, 6 tests.

- [x] **Step 5: Write the enforcement test**

`relay/test/quotaEnforcement.test.ts`:

```ts
import { SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { MAX_FRAME_BYTES } from '../src/quota'

async function connect(room: string, role: string): Promise<WebSocket> {
  const res = await SELF.fetch(`https://relay.test/v1/pair/${room}?role=${role}`, {
    headers: { Upgrade: 'websocket' },
  })
  const ws = res.webSocket!
  ws.accept()
  return ws
}

describe('quota enforcement', () => {
  it('closes a peer that sends an oversized frame, and tells it why', async () => {
    const room = '4'.repeat(32)
    const desktop = await connect(room, 'desktop')
    await connect(room, 'device')

    const said: string[] = []
    desktop.addEventListener('message', (e) => { if (typeof e.data === 'string') said.push(e.data) })
    const closed = new Promise<number>((r) => desktop.addEventListener('close', (e) => r(e.code)))

    desktop.send(new Uint8Array(MAX_FRAME_BYTES + 1))

    expect(await closed).toBe(1009) // "message too big"
    expect(said.map((s) => JSON.parse(s).limit)).toContain('frame-size')
  })

  it('does not forward the oversized frame before closing', async () => {
    const room = '5'.repeat(32)
    const desktop = await connect(room, 'desktop')
    const device = await connect(room, 'device')

    const seen: unknown[] = []
    device.addEventListener('message', (e) => { if (typeof e.data !== 'string') seen.push(e.data) })
    desktop.send(new Uint8Array(MAX_FRAME_BYTES + 1))
    await new Promise((r) => setTimeout(r, 50))
    expect(seen).toEqual([])
  })

  it('cuts a peer that floods past the burst allowance', async () => {
    const room = '6'.repeat(32)
    const desktop = await connect(room, 'desktop')
    await connect(room, 'device')

    const closed = new Promise<number>((r) => desktop.addEventListener('close', (e) => r(e.code)))
    for (let i = 0; i < 200; i++) desktop.send(new Uint8Array([i & 0xff]))

    expect(await closed).toBe(1008) // "policy violation"
  })
})
```

- [x] **Step 6: Run it to verify it fails**

Run: `npm --prefix relay test quotaEnforcement`
Expected: FAIL — nothing enforces yet; frames forward freely.

- [x] **Step 7: Wire the quotas into `PairingRoom`**

Give each accepted socket its own limiter set, and replace the message handler:

```ts
import {
  TokenBucket, ByteBudget, MAX_FRAME_BYTES,
  FRAME_RATE_PER_SEC, FRAME_BURST, CONNECTION_BYTE_BUDGET,
} from './quota'
```

```ts
    const bucket = new TokenBucket(FRAME_BURST, FRAME_RATE_PER_SEC / 1000)
    const budget = new ByteBudget(CONNECTION_BYTE_BUDGET)

    server.addEventListener('message', (event) => {
      if (typeof event.data === 'string') return

      const bytes = (event.data as ArrayBuffer).byteLength

      // Every check happens BEFORE the forward. A frame that violates a quota must
      // never reach the partner: enforcing after the send would make the limit a
      // report rather than a control.
      if (bytes > MAX_FRAME_BYTES) return this.cut(server, role, 'frame-size', 1009)
      if (!bucket.take(Date.now())) return this.cut(server, role, 'frame-rate', 1008)
      if (!budget.spend(bytes)) return this.cut(server, role, 'bytes', 1008)

      this.peer(role)?.send(event.data)
    })
```

```ts
  /** Tell the peer why, then close. The order matters: a close frame sent first
   *  can race the text frame out of existence, and a client that is cut without
   *  being told reports "the relay dropped me" — which sends the user hunting a
   *  network fault instead of the quota they actually hit. */
  private cut(sock: WebSocket, role: Role, limit: ControlFrame extends { limit: infer L } ? L : never, code: number): void {
    sock.send(encode({ kind: 'quota-exceeded', limit }))
    sock.close(code, 'quota exceeded')
    this.drop(role)
  }
```

> Note: the conditional type above is cute but unreadable. Use a plain named type instead:
> ```ts
> export type QuotaLimit = 'frame-size' | 'frame-rate' | 'bytes' | 'idle'
> ```
> in `wire.ts`, referenced by both `ControlFrame` and `cut`.

- [x] **Step 8: Run the tests and make sure they pass**

Run: `npm --prefix relay test`
Expected: PASS, 20 tests.

- [x] **Step 9: Commit**

```bash
git add relay
git commit -m "feat(relay): frame-size, frame-rate and per-connection byte quotas"
```

---

## Task 5: Registration rate limit at the edge

A quota inside the DO cannot stop someone creating a million DOs. That has to be refused before the room exists.

**Files:**
- Modify: `relay/src/index.ts`, `relay/wrangler.toml`
- Test: `relay/test/rateLimit.test.ts`

**Interfaces:**
- Consumes: `Env` from Task 1.
- Produces: `Env` gains `REGISTRATIONS: RateLimit`.

- [x] **Step 1: Write the failing test**

`relay/test/rateLimit.test.ts`:

```ts
import { SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'

describe('registration rate limit', () => {
  it('refuses a source that opens rooms faster than the limit', async () => {
    const headers = { Upgrade: 'websocket', 'CF-Connecting-IP': '203.0.113.7' }
    const codes: number[] = []
    for (let i = 0; i < 40; i++) {
      const room = i.toString(16).padStart(32, '0')
      const res = await SELF.fetch(`https://relay.test/v1/pair/${room}?role=desktop`, { headers })
      codes.push(res.status)
    }
    expect(codes).toContain(429)
  })

  it('does not penalise a different source', async () => {
    const res = await SELF.fetch(`https://relay.test/v1/pair/${'7'.repeat(32)}?role=desktop`, {
      headers: { Upgrade: 'websocket', 'CF-Connecting-IP': '198.51.100.2' },
    })
    expect(res.status).toBe(101)
  })
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `npm --prefix relay test rateLimit`
Expected: FAIL — no 429 is ever returned.

- [x] **Step 3: Add the binding**

`relay/wrangler.toml`:

```toml
[[unsafe.bindings]]
name = "REGISTRATIONS"
type = "ratelimit"
namespace_id = "1001"
simple = { limit = 30, period = 60 }
```

- [x] **Step 4: Enforce it in the Worker**

```ts
export interface Env {
  PAIRING_ROOM: DurableObjectNamespace
  REGISTRATIONS: { limit(opts: { key: string }): Promise<{ success: boolean }> }
}
```

```ts
    // Keyed on source IP, not pairing id: limiting per id is free to evade by
    // picking a new id, which is exactly what a room-flood does.
    const source = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    const { success } = await env.REGISTRATIONS.limit({ key: source })
    if (!success) return new Response('slow down', { status: 429 })
```

placed after the pairing-id validation and before the DO lookup.

- [x] **Step 5: Run the tests and make sure they pass**

Run: `npm --prefix relay test`
Expected: PASS, 22 tests.

- [x] **Step 6: Commit**

```bash
git add relay
git commit -m "feat(relay): per-source registration rate limit"
```

---

## Task 6: Idle timeout and room teardown

A room whose peers vanished must not hold a Durable Object alive indefinitely.

**Files:**
- Modify: `relay/src/pairingRoom.ts`
- Test: `relay/test/lifecycle.test.ts`

**Interfaces:**
- Consumes: `PairingRoom`.
- Produces: `const IDLE_TIMEOUT_MS = 300_000`.

- [x] **Step 1: Write the failing test**

`relay/test/lifecycle.test.ts`:

```ts
import { SELF, runInDurableObject, env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'

async function connect(room: string, role: string): Promise<WebSocket> {
  const res = await SELF.fetch(`https://relay.test/v1/pair/${room}?role=${role}`, {
    headers: { Upgrade: 'websocket' },
  })
  const ws = res.webSocket!
  ws.accept()
  return ws
}

describe('room lifecycle', () => {
  it('tells the surviving peer when its partner leaves', async () => {
    const room = '8'.repeat(32)
    const desktop = await connect(room, 'desktop')
    const device = await connect(room, 'device')

    const gone = new Promise<string>((r) => {
      desktop.addEventListener('message', (e) => { if (typeof e.data === 'string') r(e.data) })
    })
    device.close()
    expect(JSON.parse(await gone)).toEqual({ kind: 'peer-gone', role: 'device' })
  })

  it('frees the role so the same peer can reconnect', async () => {
    const room = '9'.repeat(32)
    const first = await connect(room, 'desktop')
    first.close()
    await new Promise((r) => setTimeout(r, 20))
    const res = await SELF.fetch(`https://relay.test/v1/pair/${room}?role=desktop`, {
      headers: { Upgrade: 'websocket' },
    })
    expect(res.status).toBe(101)
  })

  it('closes an idle room rather than holding it open forever', async () => {
    const room = 'a1'.padEnd(32, '0')
    const desktop = await connect(room, 'desktop')
    const closed = new Promise<number>((r) => desktop.addEventListener('close', (e) => r(e.code)))

    const id = env.PAIRING_ROOM.idFromName(room)
    await runInDurableObject(env.PAIRING_ROOM.get(id), (instance: any) => instance.alarm())

    expect(await closed).toBe(1000)
  })
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `npm --prefix relay test lifecycle`
Expected: FAIL on the third test — `alarm` is not a function.

- [x] **Step 3: Add the alarm**

```ts
/** How long a room may sit without a forwarded frame before it is closed. Long
 *  enough that a phone in a lift or on a train reconnects into the same room;
 *  short enough that an abandoned room is not a free foothold. */
export const IDLE_TIMEOUT_MS = 300_000
```

In the constructor, take the state:

```ts
  constructor(private readonly state: DurableObjectState) {}
```

Arm the alarm on every accepted connection and every forwarded frame:

```ts
  private touch(): void {
    void this.state.storage.setAlarm(Date.now() + IDLE_TIMEOUT_MS)
  }
```

and:

```ts
  async alarm(): Promise<void> {
    for (const [, sock] of this.peers) sock.close(1000, 'idle')
    this.peers.clear()
    // No storage to delete: the room persists nothing. Clearing the map and
    // letting the DO evict IS the teardown.
  }
```

- [x] **Step 4: Run the tests and make sure they pass**

Run: `npm --prefix relay test`
Expected: PASS, 25 tests.

- [x] **Step 5: Verify the relay coverage gate**

Run: `npm --prefix relay test -- --coverage`
Expected: lines ≥95, functions ≥95, branches ≥90, statements ≥95. Backfill on the offending file if not — do not lower the gate.

- [x] **Step 6: Commit**

```bash
git add relay
git commit -m "feat(relay): peer-gone notification, role release, idle teardown"
```

---

## Task 7: The desktop relay client

**Files:**
- Create: `src/main/remoteBridge/relayClient.ts`
- Test: `tests/electron/remoteRelayClient.test.ts`
- Modify: root `package.json` (add `ws`, `@types/ws`)

**Interfaces:**
- Consumes: `SealedChannel` from `sealedChannel.ts`; `RemoteEnvelope`, `RemoteResponse` from `protocol.ts`.
- Produces:
  ```ts
  export interface RelayClientDeps {
    url: string
    pairingId: string
    channel: SealedChannel
    onRequest(env: RemoteEnvelope): Promise<RemoteResponse>
    onStateChange(state: 'connecting' | 'online' | 'offline'): void
    openSocket?(url: string): SocketLike   // injected in tests
    now?(): number
  }
  export class RelayClient {
    constructor(deps: RelayClientDeps)
    start(): void
    send(payload: unknown): void
    stop(): void
    readonly state: 'connecting' | 'online' | 'offline'
  }
  export function backoffDelay(attempt: number): number
  ```

- [x] **Step 1: Add the dependency**

```bash
npm i ws@8 && npm i -D @types/ws
```

Then confirm no native artifact was pulled in:

```bash
npm ls bufferutil utf-8-validate
```

Expected: both absent (they are optional peers of `ws`). If either appears, remove it — the no-native-dependencies constraint is not negotiable.

- [x] **Step 2: Write the failing test**

`tests/electron/remoteRelayClient.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { RelayClient, backoffDelay } from '../../src/main/remoteBridge/relayClient'
import { SealedChannel, generateIdentity } from '../../src/main/remoteBridge/sealedChannel'

/** A socket that records what was written and lets the test push frames in. */
function fakeSocket() {
  const listeners = new Map<string, ((...a: any[]) => void)[]>()
  return {
    sent: [] as Uint8Array[],
    closed: false,
    on(event: string, fn: (...a: any[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn])
      return this
    },
    send(data: Uint8Array) { this.sent.push(data) },
    close() { this.closed = true; this.emit('close') },
    emit(event: string, ...args: unknown[]) {
      for (const fn of listeners.get(event) ?? []) fn(...args)
    },
  }
}

function pair() {
  const desktop = generateIdentity()
  const phone = generateIdentity()
  return {
    desktopSide: new SealedChannel(desktop.secretKey, phone.publicKey),
    phoneSide: new SealedChannel(phone.secretKey, desktop.publicKey),
  }
}

describe('relay client', () => {
  it('opens a sealed request, dispatches it, and seals the response back', async () => {
    const { desktopSide, phoneSide } = pair()
    const sock = fakeSocket()
    const onRequest = vi.fn().mockResolvedValue({ kind: 'ok', id: 1, data: { terminals: [] } })

    const client = new RelayClient({
      url: 'wss://relay.test', pairingId: 'a'.repeat(32),
      channel: desktopSide, onRequest, onStateChange: () => {},
      openSocket: () => sock as never,
    })
    client.start()
    sock.emit('open')

    const request = phoneSide.seal(new TextEncoder().encode(
      JSON.stringify({ id: 1, request: { kind: 'listTerminals' } }),
    ))
    sock.emit('message', Buffer.from(request), true)
    await vi.waitFor(() => expect(sock.sent.length).toBe(1))

    expect(onRequest).toHaveBeenCalledWith({ id: 1, request: { kind: 'listTerminals' } })
    const reply = JSON.parse(new TextDecoder().decode(phoneSide.open(sock.sent[0])))
    expect(reply).toEqual({ kind: 'ok', id: 1, data: { terminals: [] } })
  })

  // The relay is untrusted and the phone may be hostile. Neither may make the
  // desktop throw its way out of the message handler and kill the connection.
  it('ignores a frame it cannot open instead of dying', async () => {
    const { desktopSide } = pair()
    const sock = fakeSocket()
    const onRequest = vi.fn()
    const client = new RelayClient({
      url: 'wss://relay.test', pairingId: 'a'.repeat(32),
      channel: desktopSide, onRequest, onStateChange: () => {},
      openSocket: () => sock as never,
    })
    client.start()
    sock.emit('open')

    sock.emit('message', Buffer.from([1, 2, 3, 4]), true) // not a sealed frame
    await new Promise((r) => setTimeout(r, 20))

    expect(onRequest).not.toHaveBeenCalled()
    expect(sock.closed).toBe(false)
  })

  it('ignores an authentic frame whose plaintext is not a request envelope', async () => {
    const { desktopSide, phoneSide } = pair()
    const sock = fakeSocket()
    const onRequest = vi.fn()
    const client = new RelayClient({
      url: 'wss://relay.test', pairingId: 'a'.repeat(32),
      channel: desktopSide, onRequest, onStateChange: () => {},
      openSocket: () => sock as never,
    })
    client.start()
    sock.emit('open')

    sock.emit('message', Buffer.from(phoneSide.seal(new TextEncoder().encode('not json'))), true)
    await new Promise((r) => setTimeout(r, 20))
    expect(onRequest).not.toHaveBeenCalled()
  })

  it('reports offline and does not send when the socket is gone', () => {
    const { desktopSide } = pair()
    const states: string[] = []
    const sock = fakeSocket()
    const client = new RelayClient({
      url: 'wss://relay.test', pairingId: 'a'.repeat(32),
      channel: desktopSide, onRequest: vi.fn(), onStateChange: (s) => states.push(s),
      openSocket: () => sock as never,
    })
    client.start()
    sock.emit('open')
    expect(states).toContain('online')
    sock.emit('close')
    expect(states).toContain('offline')

    // Fails closed: a send with no socket is dropped, never buffered forever.
    expect(() => client.send({ any: 'thing' })).not.toThrow()
  })

  it('backs off exponentially with a ceiling', () => {
    expect(backoffDelay(0)).toBe(1000)
    expect(backoffDelay(1)).toBe(2000)
    expect(backoffDelay(2)).toBe(4000)
    expect(backoffDelay(10)).toBe(60_000)  // ceiling
    expect(backoffDelay(100)).toBe(60_000)
  })
})
```

- [x] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/electron/remoteRelayClient.test.ts`
Expected: FAIL — `relayClient.ts` does not exist.

- [x] **Step 4: Write `relayClient.ts`**

```ts
import WebSocket from 'ws'
import type { SealedChannel } from './sealedChannel'
import type { RemoteEnvelope, RemoteResponse } from './protocol'

export type RelayState = 'connecting' | 'online' | 'offline'

/** The subset of `ws` this module uses. Named so tests can inject a fake without
 *  standing up a server, and so the `ws` import stays in exactly one place. */
export interface SocketLike {
  on(event: string, fn: (...args: never[]) => void): unknown
  send(data: Uint8Array): void
  close(): void
}

export interface RelayClientDeps {
  url: string
  pairingId: string
  channel: SealedChannel
  onRequest(env: RemoteEnvelope): Promise<RemoteResponse>
  onStateChange(state: RelayState): void
  /** Injected in tests. Production dials the real relay. */
  openSocket?(url: string): SocketLike
}

const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 60_000

/** Doubling backoff with a one-minute ceiling.
 *
 *  The ceiling matters more than the curve: a desktop left running overnight
 *  against a relay that is down would otherwise reach delays measured in days
 *  and never notice the relay coming back. */
export function backoffDelay(attempt: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt)
}

export class RelayClient {
  private socket: SocketLike | null = null
  private attempt = 0
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | null = null
  state: RelayState = 'offline'

  constructor(private readonly deps: RelayClientDeps) {}

  start(): void {
    this.stopped = false
    this.dial()
  }

  private dial(): void {
    if (this.stopped) return
    this.setState('connecting')
    const open = this.deps.openSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike)
    const sock = open(`${this.deps.url}/v1/pair/${this.deps.pairingId}?role=desktop`)
    this.socket = sock

    sock.on('open', (() => {
      this.attempt = 0
      this.setState('online')
    }) as never)

    sock.on('message', ((data: Buffer, isBinary: boolean) => {
      // Control frames are text and are not part of the request path. Only binary
      // carries sealed payload.
      if (!isBinary) return
      void this.handleFrame(new Uint8Array(data))
    }) as never)

    const down = () => {
      this.socket = null
      this.setState('offline')
      this.retry()
    }
    sock.on('close', down as never)
    sock.on('error', down as never)
  }

  private async handleFrame(frame: Uint8Array): Promise<void> {
    let envelope: RemoteEnvelope
    try {
      // Two distinct rejections, both silent: a frame that does not open (forged,
      // replayed, or corrupted in transit) and one that opens but is not an
      // envelope. Neither may throw out of here — an unhandled rejection in the
      // message handler tears down a connection that a hostile phone can then
      // drop at will.
      envelope = JSON.parse(new TextDecoder().decode(this.deps.channel.open(frame)))
      if (typeof envelope?.id !== 'number' || typeof envelope?.request?.kind !== 'string') return
    } catch {
      return
    }

    let response: RemoteResponse
    try {
      response = await this.deps.onRequest(envelope)
    } catch (err) {
      response = { kind: 'error', id: envelope.id, message: (err as Error).message }
    }
    this.send(response)
  }

  /** Seal and write. Drops the payload when there is no socket: the fan-out is
   *  the buffer for output, and a second queue here would double-store it. */
  send(payload: unknown): void {
    if (!this.socket) return
    try {
      this.socket.send(this.deps.channel.seal(new TextEncoder().encode(JSON.stringify(payload))))
    } catch {
      // A write to a socket the peer already closed. `close` will follow.
    }
  }

  private retry(): void {
    if (this.stopped) return
    const delay = backoffDelay(this.attempt++)
    this.timer = setTimeout(() => this.dial(), delay)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.socket?.close()
    this.socket = null
    this.setState('offline')
  }

  private setState(next: RelayState): void {
    if (this.state === next) return
    this.state = next
    this.deps.onStateChange(next)
  }
}
```

- [x] **Step 5: Run the tests and make sure they pass**

Run: `npx vitest run tests/electron/remoteRelayClient.test.ts`
Expected: PASS, 5 tests.

- [x] **Step 6: Verify the app coverage gate still holds**

Run: `npm run test:coverage`
Expected: lines ≥97, functions ≥96, branches ≥95, statements ≥96. Backfill on `relayClient.ts` if it dropped — the gate does not move.

- [x] **Step 7: Commit**

```bash
git add src/main/remoteBridge/relayClient.ts tests/electron/remoteRelayClient.test.ts package.json package-lock.json
git commit -m "feat(remote): relay client with sealed framing and bounded backoff"
```

---

## Task 8: Wire the relay client into the bridge

**Files:**
- Modify: `src/main/remoteBridge/entry.ts`, `src/main/remoteBridge/protocol.ts`
- Test: `tests/electron/remoteBridgeEntry.test.ts` (extend), `tests/electron/remoteEndToEnd.test.ts` (extend)

**Interfaces:**
- Consumes: `RelayClient` from Task 7; `BridgeCore` from sub-project 1.
- Produces: `BridgeCoreDeps` gains `openRelay?(deps: RelayClientDeps): RelayClient`; `BridgeToHost` gains `{ kind: 'deviceConnected' | 'deviceDisconnected'; deviceId: string }`.

- [x] **Step 1: Write the failing test**

Append to `tests/electron/remoteBridgeEntry.test.ts`:

```ts
  it('dials one relay room per paired device and tears it down on revoke', () => {
    const opened: { pairingId: string; stopped: boolean }[] = []
    const sent: BridgeToHost[] = []
    const c = createBridgeCore({
      send: (m) => sent.push(m),
      mcp: { callTool: vi.fn() },
      relayUrl: 'wss://relay.test',
      openRelay: (d) => {
        const rec = { pairingId: d.pairingId, stopped: false }
        opened.push(rec)
        return { start() {}, send() {}, stop() { rec.stopped = true }, state: 'offline' } as never
      },
    })
    c.handleHostMessage({
      kind: 'init', mcpPort: 1, mcpToken: 't',
      identitySecretKey: 'a'.repeat(64), devices: [device()],
    })
    expect(opened).toHaveLength(1)

    c.handleHostMessage({ kind: 'revokeDevice', deviceId: 'd1' })
    expect(opened[0].stopped).toBe(true)
  })

  it('reports connection state up to the host so Settings can show it', () => {
    const sent: BridgeToHost[] = []
    let report: ((s: string) => void) | undefined
    const c = createBridgeCore({
      send: (m) => sent.push(m),
      mcp: { callTool: vi.fn() },
      relayUrl: 'wss://relay.test',
      openRelay: (d) => {
        report = d.onStateChange
        return { start() {}, send() {}, stop() {}, state: 'offline' } as never
      },
    })
    c.handleHostMessage({
      kind: 'init', mcpPort: 1, mcpToken: 't',
      identitySecretKey: 'a'.repeat(64), devices: [device()],
    })
    report?.('online')
    expect(sent).toContainEqual({ kind: 'deviceConnected', deviceId: 'd1' })
    report?.('offline')
    expect(sent).toContainEqual({ kind: 'deviceDisconnected', deviceId: 'd1' })
  })
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/electron/remoteBridgeEntry.test.ts`
Expected: FAIL — `openRelay` is not part of `BridgeCoreDeps`.

- [x] **Step 3: Implement**

In `protocol.ts`, extend `BridgeToHost`:

```ts
  | { kind: 'deviceConnected'; deviceId: string }
  | { kind: 'deviceDisconnected'; deviceId: string }
```

In `entry.ts`:

```ts
  /** One relay room per paired device, keyed by device id.
   *
   *  Per DEVICE, not per desktop: a pairing IS a desktop-device pair, so the relay
   *  never has to multiplex and never learns how many devices a user has beyond
   *  the rooms it happens to hold. It also means revoking one device closes
   *  exactly one socket and cannot disturb the others. */
  const rooms = new Map<string, RelayClient>()

  function openRoom(dev: PairedDevice): void {
    if (rooms.has(dev.id)) return
    const channel = new SealedChannel(identitySecretKey, dev.publicKey)
    const client = (deps.openRelay ?? ((d) => new RelayClient(d)))({
      url: deps.relayUrl,
      pairingId: dev.pairingId,
      channel,
      onRequest: (env) => handleRemoteRequest(dev.id, env),
      onStateChange: (state) => deps.send({
        kind: state === 'online' ? 'deviceConnected' : 'deviceDisconnected',
        deviceId: dev.id,
      }),
    })
    rooms.set(dev.id, client)
    client.start()
  }

  function closeRoom(deviceId: string): void {
    rooms.get(deviceId)?.stop()
    rooms.delete(deviceId)
  }
```

Call `openRoom` for each device on `init` and on `acceptPairing`; call `closeRoom` in `revokeDevice` and for every room on `shutdown`.

> `PairedDevice` needs a `pairingId` field carried from `createPairingOffer`. It is
> already in the QR payload; add it to the record so a restart can re-dial the same
> room without a re-pair.

- [x] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run tests/electron/remoteBridgeEntry.test.ts tests/electron/remoteEndToEnd.test.ts`
Expected: PASS.

- [x] **Step 5: Pump drained output into the room**

Output currently sits in the fan-out until someone drains it. Wire the pump: after `fanout.ingest`, drain each connected device and send.

```ts
      case 'terminalOutput': {
        fanout.ingest(msg.terminalId, msg.slice)
        // Drain immediately for every device that has somewhere to put it. A
        // device that is offline keeps its queue, which is what the fan-out is
        // for; draining into a dead socket would silently discard it.
        for (const [deviceId, client] of rooms) {
          if (client.state !== 'online') continue
          const chunks = fanout.drain(deviceId)
          if (chunks.length > 0) client.send({ kind: 'output', chunks })
        }
        return
      }
```

Add a test proving an offline device keeps its output and receives it on reconnect.

- [x] **Step 6: Run the full gate**

Run: `npm run typecheck && npm run lint && npm run test:coverage && npm --prefix relay test`
Expected: all green, app gate at 97/96/95/96.

- [x] **Step 7: Commit**

```bash
git add src tests
git commit -m "feat(remote): dial one relay room per paired device, pump output"
```

---

## Task 9: Privacy statement, deploy runbook, and CI

**Files:**
- Create: `relay/PRIVACY.md`, `relay/DEPLOY.md`
- Modify: `.github/workflows/ci.yml` (or the equivalent), root `package.json`

- [x] **Step 1: Write `relay/PRIVACY.md`**

Short and honest, because there is little to disclose. It must state exactly what the relay can see — pairing ids, frame sizes, timing, connection metadata, source IP for rate limiting — and exactly what it cannot: frame contents, terminal output, commands, file paths, model credentials. It must say frames are never persisted and that the operator cannot decrypt traffic even under compulsion, because no key ever reaches the relay.

Do not claim more than the design delivers. In particular: **traffic analysis is possible.** Frame sizes and timing leak activity patterns. Say so.

- [x] **Step 2: Write `relay/DEPLOY.md`**

Cover: Cloudflare account and `wrangler login`; `wrangler deploy`; binding the custom domain; where the rate-limit namespace id comes from; how to roll back (`wrangler rollback`); and how to read logs without capturing frame bodies (`wrangler tail --format json`, which shows metadata only). State explicitly that no Cloudflare token is committed — CI reads `CLOUDFLARE_API_TOKEN` from repository secrets, and `gh secret list` shows the current inventory.

- [x] **Step 3: Add the CI job**

Relay tests are blocking, like `e2e/`:

```yaml
  relay:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci --prefix relay
      - run: npm --prefix relay test -- --coverage
```

- [x] **Step 4: Verify the whole thing once more**

Run: `npm run typecheck && npm run lint && npm run test:coverage && npm --prefix relay test -- --coverage`

- [x] **Step 5: Commit**

```bash
git add relay .github package.json
git commit -m "docs(relay): privacy statement and deploy runbook; ci: relay test job"
```

---

## Deployment gate — needs David

Deployment is the one step this plan cannot complete unattended:

1. A Cloudflare account with Workers Paid (Durable Objects require it).
2. `wrangler login` in an interactive terminal, or `CLOUDFLARE_API_TOKEN` in repo secrets.
3. A hostname for the relay — `relay.termpolis.com` is the obvious choice given the existing `termpolis.com` deploy.

Everything up to `wrangler deploy` is testable locally with `wrangler dev` and the Workers test pool.

---

## Self-Review

**Spec coverage.** §7's six bullets map to tasks: runtime → 1–2; multi-tenant → 1 (DO per pairing id); zero-knowledge → 3 (binary forwarded unread, text dropped, nothing persisted); abuse controls → 4–5; availability → 7 (fail-closed, bounded backoff); privacy statement → 9. §4.2's sealed framing is consumed, not re-implemented.

**Gaps deliberately left.** The phone's half of the relay conversation is sub-project 3 — this plan builds only the desktop end. Relay observability beyond `wrangler tail` is not designed; there is nothing to alert on until there are users.

**Known rough edge.** `PairedDevice` gains a `pairingId` field in Task 8. Devices paired by a sub-project-1 build predate that field, so a stored registry from before this change will re-dial nothing. Since no build has shipped with remote enabled, there are no such records in the wild — but if that changes before this lands, Task 8 needs a migration step that re-pairs rather than silently failing.
