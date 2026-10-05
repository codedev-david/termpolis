# Linked Machines — Implementation Plan

Spec: `docs/superpowers/specs/2026-10-05-linked-machines-design.md`. Read it first.

The work is built in slices, A to F. A and B are independent of each other. C depends on both. D and E depend on C's contracts, which are fixed below, so they can run in parallel. F is the last slice: integration, docs and verification.

## House rules for every slice

- **TDD.** Write the failing test, then the code. Every new file needs about 100% coverage. The global gate is lines 97, functions 96, branches 95, statements 96, and it is never lowered.
- **Do not commit, and do not touch `PRIVACY.md`.** It carries someone else's uncommitted edit. Leave your changes in the working tree and report the files you changed.
- **Run only your own test files:** `npx vitest run <files>`. First run `unset PROMPT_COMMAND` in Git Bash. Do not run whole-suite coverage, because another slice may be running tests at the same time.
- **Typecheck before you finish:** `npm run typecheck` covers node, web and test. Run `npx eslint <your files>` too: 0 errors.
- **`PROTOCOL_VERSION` stays 2 and the QR stays `v:1`.** Phone app 1.1.0 must keep working, so do not edit `mobile/`. If a test there would need changing, stop and report.
- **Never log a relay frame or any part of one.** Log the room id and frame length only.
- **No raw control bytes or NUL in source files.** Write `\u0000`-style escapes. Edit TypeScript with the Edit/Write tools, not heredocs: the Bash tool strips control characters and collapses `\\`.
- **Test files named `tests/electron/remote*.ts` are strictly type-checked by `typecheck:test`.** New bridge tests should use that prefix.
- **Mirror existing patterns and comment density.** This codebase explains *why* in comments. Keep doing that, but briefly.

---

## Slice A — exec hardening

Files: `src/main/headlessExec.ts`, `src/main/secondOpinion.ts`, `src/main/secondOpinionDeliver.ts`, the `agentExec` handler in `src/main/index.ts` (~3647), `src/main/headroom/router.ts`, and their tests.

1. **Thread `cwd` into the spawn.**
   - `DeliverFn` opts become `{ timeoutMs: number; cwd?: string; env?: Record<string, string>; signal?: AbortSignal }`.
   - `deliverWithDeadline` gains a 7th parameter, `extra: { cwd?; env?; signal? } = {}`, placed **after** `graceMs`, and forwards it.
   - `secondOpinionDeliver` spawns with `cwd`, merges `env` over its base env, and stops the run when `signal` aborts. Stopping uses the same tree kill as the deadline; the result is `code: 1` with stderr note `cancelled`.
   - On Windows, spawn PowerShell by **absolute path** (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, the `taskkillPath` pattern in `processTree.ts`). Once cwd is a repo, a planted `powershell.exe` there would otherwise run.
2. **`ExecRequest` gains `isolateMcp?: boolean`, `env?: Record<string,string>`, `signal?: AbortSignal` and `noRemember?: boolean`.**
   - `runHeadless` validates `cwd` when given: it must exist and be a directory, else `{ ok:false, error:'cwd does not exist or is not a directory: …' }`. It then passes `{ cwd, env, signal }` to deliver.
   - With `noRemember`, `runHeadless` skips `deps.remember`.
3. **`execCommand(agent, model, write, timeoutMs, opts?: { isolateMcp?: boolean; cwd?: string })`:**
   - claude: write mode gains `--strict-mcp-config` when `isolateMcp`. Read-only already has it.
   - codex: when `isolateMcp`, insert `-c mcp_servers.termpolis.enabled=false` before the prompt. Verified: `-c 'mcp_servers={}'` does NOT work. When `cwd` is given, also insert `-C <cwd>`.
   - agy: unchanged. It has no per-run MCP switch, and agy does not read Termpolis's registration anyway.
4. **The `agentExec` handler in index.ts must:**
   - validate `agent` ∈ claude|codex|gemini (else throw `Invalid agent`);
   - clamp `timeoutMs` to [10_000, 3_600_000], with undefined → default;
   - pass through the new optional fields if present (`isolateMcp` etc. are not exposed on the MCP verb; only linked jobs call `runHeadless` with them directly).
5. **Headroom.** Add `'agent_exec'` to `EXEMPT_TOOLS` (`headroom/router.ts`). This fixes the CLI `JSON.parse` breakage on long output. Then update `headroomRouter` tests.
6. **Tests.**
   - Update the `toEqual({ timeoutMs })` assertions (`headlessExec.test.ts` :148/:160/:261) to the new shape.
   - Add the new cases: cwd validation, cwd/env/signal passed through, argv for `isolateMcp` + `-C`, abort stops the run, `noRemember`.
   - Update `cov-main-index.test.ts` mocks if index.ts imports anything new from these modules.

Export for slice C: `runHeadless` with the new `ExecRequest` fields.

---

## Slice B — relay transport and bridge links

Files: `src/main/remoteBridge/{relayClient,protocol,pairing,entry,deviceRegistry}.ts`, a new `src/main/remoteBridge/linkCode.ts`, `src/main/remoteBridgeSupervisor.ts`, `src/main/remoteDeviceStore.ts`, and tests (`tests/electron/remote*.test.ts` + new `tests/electron/remoteLinked*.test.ts`).

### B1. `RelayClient` (`relayClient.ts`)

- `RelayCommonDeps` gains `role?: Role` (default `'desktop'`; the dial URL uses it) and `onControl?: (c: RelayControlFrame) => void` (called for every parsed control frame, after the existing handling).
- New `request(request: unknown, timeoutMs: number): Promise<unknown>`:
  - Session mode only.
  - Rejects with `Error('offline')` immediately when there is no session.
  - Assigns `id` from a per-instance counter that is monotonic for the instance's lifetime, sends `{id, request}`, and keeps `pending: Map<id,{resolve,reject,timer}>`.
  - Rejects with `Error('timed out')` after `timeoutMs`.
- `handleFrame`: after opening, if the envelope has numeric `id` and string `request.kind`, use the existing path. Else if `kind === 'ok'` and numeric `id`, resolve the pending entry with `data`. Else if `kind === 'error'`, reject it with `message`. Anything else is dropped. The rule that frames which do not open are dropped silently is unchanged.
- Reject every pending request with `Error('offline')` in `down()`, on `peer-gone`, and in `stop()`.
- `RelayLike` (`entry.ts`) gains `request?(…)`.
- Handshake factory: rooms with `role:'device'` use `new Handshake({ ownSecretKey, peerPublicKey, role: 'device' })`. The caller supplies it.

### B2. Link code (`linkCode.ts`, new)

- `LINK_CODE_PREFIX = 'termpolis-link:'` and `LINK_OFFER_TTL_MS = 5 * 60_000`.
- `encodeLinkCode(qrPayloadJson: string): string`: prefix + base64url(utf8).
- `parseLinkCode(text: string): LinkOffer | null`:
  - trim; require the prefix; base64url-decode; `JSON.parse`;
  - validate exactly like `mobile/src/wire/qr.ts`: `v===1`, `new URL(relayUrl).protocol === 'wss:'`, `pairingId` `/^[0-9a-f]{32}$/`, keys `/^[0-9a-f]{64}$/`;
  - rebuild the result field by field.
- **Exception to `wss:` only.** Accept `ws:` only when the host is `127.0.0.1` or `localhost` (tests and local relays). Document it.

### B3. Pairing (`pairing.ts`, `entry.ts`)

- `sealPairingHello` / `openPairingHello` carry an optional `peer?: 'desktop'`. Opening returns `peer: 'desktop' | null`.
- `HostToBridge.beginPairing` gains `link?: boolean`.
  - Link offers use `LINK_OFFER_TTL_MS`.
  - The `pairingCode` event for a link offer carries `linkCode` (encoded) in addition to `qrPayload`.
  - Remember `requestedKind` beside `requestedCapabilities`, reset on every offer.
- In `onPairingFrame`:
  - a link offer with `hello.peer !== 'desktop'`: emit `{kind:'error', message:'That code is for linking another computer, not a phone.'}` and keep the room open;
  - a phone offer with `hello.peer === 'desktop'`: emit `{kind:'error', message:'That code is for a phone. Create a code under Settings ▸ Linked machines.'}`;
  - an accepted link: the `PairedDevice` gets `kind: 'desktop'` and capabilities `NO_CAPABILITIES`.
- **The 16-link cap.** If the host already has 16 desktop peers plus joined links, refuse the hello with an error. Links come from `init.links` / `setLinks`.

### B4. Joining (`entry.ts`)

New message `HostToBridge.joinLink { code: string; secretKey: string; label: string }`:
1. Parse with `parseLinkCode`, else emit `joinFailed`.
2. Open a `RelayClient` with `{mode:'pairing', role:'device', url: offer.relayUrl, roomId: offer.pairingId, onFrame, onControl}`. On `hello` with `peer:true`, or on `peer-joined`, send `sealPairingHello({…, label, peer:'desktop'})` **once** via `sendFrame`.
3. On a binary frame, try `openPairingAck`, catching errors (a frame that does not open is ignored). On success:
   - verify `ack.deviceId === sha256(utf8(ourPkHex)).slice(0,16)`;
   - compute `sessionRoomId = deriveSessionRoomId(secretKey, hostPk)` and `phrase = deriveVerificationPhrase(ourPk, hostPk)`;
   - emit `linkJoined { publicKey, hostPublicKey, hostName: ack.name, deviceId, sessionRoomId, relayUrl, phrase }`;
   - stop the room.
4. **Failure cases.**
   - `peer-gone` before the ack: `joinFailed('The other computer stopped showing that code.')`.
   - A 60 s timeout: `joinFailed('No answer. Check the code is still showing under Settings ▸ Linked machines on the other computer.')`.
   - `cancelJoin` aborts.
5. **Keep a permanent socket error listener** (the `ws` close-while-connecting trap).

### B5. Link rooms (`entry.ts`)

- `init.links?: BridgeLink[]` and `HostToBridge.setLinks { links: BridgeLink[] }`:
  - Open one session room per link: `role:'device'`, `url: link.relayUrl`, `roomId: link.sessionRoomId`, handshake as above.
  - Its `onRequest` is `handleLinkRequest(link.id, env)`.
  - `setLinks` diffs: it closes removed links and opens added ones.
- `init.phones?: boolean` (default true) and `init.linked?: boolean` (default false):
  - phone device rooms open only when `phones`;
  - `kind:'desktop'` device rooms and link rooms open only when `linked`;
  - `beginPairing` is refused when the requested kind is disabled.
- Emit `linkStateChanged { id, attached }` for link rooms. Hosted desktop peers keep the existing `deviceConnected` / `deviceDisconnected`.

### B6. Peer request routing (`entry.ts`)

- `isPeerKind(k)` covers `peerHello`, `peerRun`, `peerResult`, `peerCancel` and `peerBye`.
- **Host, `handleRemoteRequest(deviceId, env)`.** For peer kinds, beside `getCapabilities`/`unpair`, and **only** when `device.kind === 'desktop'` (otherwise the standard unrecognised-kind error):
  - `peerBye`: revoke the sender, exactly as `unpair` does, and emit `linkBye { from:{via:'device', id} }`.
  - Every other peer kind: emit `peerRequest { callId, from:{via:'device', id}, request }` and await `peerReply { callId }`.
    - Timeout is `request.waitMs + 15_000` for `peerResult`, else 30_000.
    - Resolve with `data`, or throw `Error(message)`.
- **Joiner, `handleLinkRequest(linkId, env)`.** Only peer kinds are accepted (the rest get the unrecognised-kind error).
  - `peerBye`: answer ok, then close that link room and emit `linkBye { from:{via:'link', id} }`.
  - Everything else is forwarded as above, with `from:{via:'link', id}`.
- **Outbound, `HostToBridge.linkCall { callId, target: LinkTarget, request, timeoutMs }`.**
  - Find the room: `via:'device'` only for `kind:'desktop'` devices; `via:'link'` uses the link rooms.
  - If it is missing or not attached, answer `linkCallResult { callId, ok:false, message:'offline' }` at once.
  - Otherwise call `room.request(request, timeoutMs)` and answer `linkCallResult` with the outcome.
- `HostToBridge.renameDevice { deviceId, label }` calls `registry.setLabel` (new), then announces `devicesChanged`.

### B7. Registry and store

- `DeviceRegistry.setLabel(id, label): boolean`.
- `expireIdle` skips `kind === 'desktop'`.
- `remoteDeviceStore.device()` keeps `kind` when it is exactly `'desktop'`.

### B8. Supervisor

- `startRemoteBridge(init: InitParams | (() => InitParams))`. A respawn calls the factory, so it replays the **current** devices and links instead of the launch-time snapshot. This fixes the existing stale-respawn bug.

### B9. Types (`protocol.ts`, additive)

```ts
export type LinkTarget = { via: 'device'; id: string } | { via: 'link'; id: string }
export interface BridgeLink { id: string; hostPublicKey: string; relayUrl: string; sessionRoomId: string; secretKey: string }
export type PeerAgent = 'claude' | 'codex' | 'gemini'
export type PeerRequest = | { kind: 'peerHello' } | { kind: 'peerRun'; agent: PeerAgent; prompt: string; cwd?: string; write?: boolean; model?: string; timeoutMs?: number } | { kind: 'peerResult'; jobId: string; waitMs?: number } | { kind: 'peerCancel'; jobId: string } | { kind: 'peerBye' }
export interface PeerHelloInfo { name: string; agents: { claude: boolean; codex: boolean; gemini: boolean }; grants: { run: boolean; write: boolean }; confirmed: boolean; version: string }
export interface PeerJobView { jobId: string; agent: PeerAgent; status: 'running' | 'done' | 'failed' | 'cancelled'; output?: string; truncated?: boolean; error?: string; startedAt: number; durationMs?: number }
// PairedDevice gains: kind?: 'desktop'
// HostToBridge: init {+links?, phones?, linked?}; beginPairing {+link?}; joinLink; cancelJoin; setLinks; renameDevice; linkCall; peerReply
// BridgeToHost: pairingCode {+linkCode?}; linkJoined; joinFailed; linkCallResult; peerRequest; linkStateChanged; linkBye
```

`PeerRequest` stays **out** of the phone `RemoteRequest` union, so the mobile parity tests are untouched.

### B10. Tests

- Add `RelayClient` request/response, role and `onControl` cases to `remoteRelayClient.test.ts`.
- Add a new **`tests/electron/fixtures/memoryRelay.ts`**: an in-memory relay keyed by room id with `desktop`/`device` seats, a 409 on a duplicate seat, `hello{peer}`/`peer-joined`/`peer-gone` encoded with `relay/src/wire`'s `encode`, and binary forwarding. Its `openSocket` produces `ws`-style emitter fakes.
- Add `tests/electron/remoteLinkedBridge.test.ts`, which drives two `createBridgeCore`s through that relay and covers:
  - link pairing with matching phrases;
  - kind enforcement in both directions;
  - `peerHello` in both directions, forwarded via `peerRequest`/`peerReply`;
  - `linkCall` to an offline target;
  - `peerBye` from each side;
  - the phones/linked room filters;
  - `setLinks` diffing;
  - `renameDevice`;
  - the 16 cap;
  - `joinFailed` paths.
- Add `linkCode` unit tests and update the store, registry and supervisor tests.

---

## Slice C — main service, stores and IPC

New files in `src/main/`, each with an injectable-deps core and tests:

- **`linkedSettings.ts`:** `loadLinkedSettings(dir): { enabled: boolean }` / `saveLinkedSettings(dir, s)` for `linked-settings.json`. Default `{enabled:false}`; only `=== true` enables.
- **`linkedStore.ts`:**
  - `loadLinkedState(dir): { links: JoinedLink[]; meta: LinkMeta[] }` and `saveLinkedState(dir, state)`, through `secureKeyStore` `readSecret`/`writeSecret` on the file `linked-machines`.
  - Rebuild records field by field and validate the hex shapes.
- **`linkedDirectory.ts`:** pure functions over `{ devices (desktop peers from the bridge), links, meta, online map }`:
  - `machines(): LinkedMachineView[]`;
  - `resolve(nameOrRef)`, case-insensitive on name;
  - `uniqueName(base, exceptRef?)`, numbering duplicates `X (2)`;
  - `metaFor(target)`;
  - `prune(devices, links)`, which drops meta whose device or link is gone.
- **`linkedJobs.ts`:** the executor. `createLinkedJobs(deps: { runHeadless, agentsInstalled(): Promise<{claude,codex,gemini}>, localName(): string, version: string, homedir(): string, now(), randomId(): string, onActivity(a) })`, exposing `handlePeerRequest(from: LinkTarget, meta: LinkMeta, callerName: string, req: PeerRequest): Promise<unknown>`.
  - **Gating.** Requests are refused unless `meta.confirmed`. `peerRun` needs `grants.run`, and `write` also needs `grants.write`. The agent must be in the enum and installed.
  - **`prompt` rules.** It must be 1..20_000 chars.
  - **`cwd` rules.** It defaults to home. `~` and `~/` are expanded. It must be absolute and must exist as a directory.
  - **`model` rules.** It must pass `isSafeModelId` from `modelCatalog`/`secondOpinion` (reuse the existing validator).
  - **`timeoutMs` rules.** It is clamped to [10 s, 60 min] and defaults to 15 min.
  - **Concurrency caps.** At most 2 jobs per link and 4 in total; past that, the error starts `busy:`.
  - **How a job runs.**
    - It calls `runHeadless({ task: framed, agent, model, cwd, write, timeoutMs, isolateMcp: true, noRemember: true, env: { TERMPOLIS_LINKED_JOB: jobId }, signal })`.
    - `framed` is `[Delegated by "<callerName>" over Termpolis Linked machines. Working folder: <cwd>. Your final message is returned to the agent that asked.]\n\n<prompt>`.
    - Output is capped at 200_000 chars keeping the TAIL, with `truncated: true` set when capped.
  - **`peerResult`** long-polls up to `min(waitMs ?? 0, 50_000)`.
  - **`peerResult` and `peerCancel`** work only on jobs owned by the same `from` (else `unknown job`).
  - **Retention.** Finished jobs are kept 2 h, at most 100.
  - **`peerHello`** returns `PeerHelloInfo`, where `grants` is `meta.grants`.
- **`linkedTool.ts`:** the requester. `createLinkedTool(deps: { call(target, req, timeoutMs): Promise<unknown>, directory(): {...}, localName(), onActivity(a), inspect(text): { text: string } })` exposing `run(opts)`, for the MCP handler:
  - `list` / `run` / `result` follow spec §8.
  - **The returned `jobId`** is `<refId>-<remoteJobId>`, where `refId` is the 16-hex link id, and `result` parses it back.
  - **Machine names that don't resolve** produce `Unknown machine "x". Linked machines: a, b`.
- **`linkedHost.ts`:** the singleton and wiring.
  - `startLinkedHost(binding)`, `registerLinkedIpc(ipc)` and `_resetLinkedHostForTests()`, mirroring `remoteHost.ts`.
  - It owns the state and talks to the bridge through `remoteBridgeHost`'s new hooks (below).
  - It mints the joiner keypair with `generateIdentity()` in main, keeps the pending secret until `linkJoined` matches its public key, then persists the `JoinedLink` plus `LinkMeta{confirmed:false}`.
  - **IPC channels.** Each returns `ok(LinkedStatusView)` / `err(msg)`:

    | Channel | Input |
    |---|---|
    | `linked:status` | — |
    | `linked:set-enabled` | `{enabled}` |
    | `linked:create-code` | `{grants}` |
    | `linked:cancel-code` | — |
    | `linked:join` | `{code, grants}` |
    | `linked:cancel-join` | — |
    | `linked:confirm` | `{ref, name}` |
    | `linked:rename` | `{ref, name}` |
    | `linked:set-grants` | `{ref, grants}` |
    | `linked:unlink` | `{ref}` |

  - **`linked:create-code` and `linked:join` record their grants before pairing.** `linked:create-code` stores its grants as pending, applied to the new desktop-peer's meta. `linked:join` stores them for the link it creates.
  - **`linked:unlink` sends `peerBye` (2 s, best effort).** Then it revokes the device (hosted) or removes the link and sends `setLinks` (joined).
  - **Pushes.** `linked:status-changed` with `LinkedStatusView`, and `linked:event` with `{kind:'pending', ref, phrase, suggestedName} | {kind:'error', message}`. Use literal `webContents.send('linked:…')` at the binding site; the `ipcChannelSync` guard needs that.
- **`remoteBridgeHost.ts` integration.**
  - Add `setLinkedEnabled(enabled)` and a `linkedHooks` dependency or setter.
  - The bridge runs iff `remote.enabled || linked.enabled`; init carries `{phones: remote.enabled, linked: linked.enabled, links}`. A toggle restarts the bridge, and init comes from a factory (B8).
  - Forward the new `BridgeToHost` kinds to the linked hooks, and give linked a way to `sendToBridge`.
  - **Remote views exclude `kind:'desktop'` devices.** That covers the device list and the `RemoteIndicator` count via `RemoteStatusView.devices`, plus `remote:begin-pairing`, which never creates link offers.
  - **`RemoteStatusView.running` reflects phones being enabled.**
- **`index.ts` wiring.**
  - `registerLinkedIpc(ipcMain)` at module scope, beside `registerRemoteIpc`.
  - `startLinkedHost({...})` beside `startRemoteBridgeHost`, with literal channel sends.
  - Inject `agentsInstalled` by extracting the `agents:detect` probe into a reusable function: export it from a small module, or inject it as a closure.
- **Preload and types.**
  - `window.linked: LinkedAPI`, built as an **annotated** object literal (`const linked: LinkedAPI = {…}`).
  - Add the types to `src/renderer/src/types/index.ts` (`LinkedStatusView`, `LinkedMachineView`, `LinkedActivityView`, `LinkedGrants`, `LinkedEvent`, `LinkedAPI`, plus `linked: LinkedAPI` on `Window`).
  - Add preload tests for invoke channels and unsubscribe.

`LinkedStatusView` is:
```ts
{ enabled: boolean; running: boolean; relayUrl: string; thisMachine: string;
  code: { code: string; expiresAt: number } | null; joining: boolean;
  machines: LinkedMachineView[]; activity: LinkedActivityView[] }
```
- `LinkedMachineView`: `{ ref, name, online, confirmed, phrase?, grants:{run,write}, linkedAt, lastActivityAt? }`
- `LinkedActivityView`: `{ id, direction:'in'|'out', machine, agent, summary, status, startedAt, durationMs? }`

The MCP handler contract, for slice D: `linkedMachines(opts: { action: string; machine?: string; agent?: string; prompt?: string; cwd?: string; write?: boolean; model?: string; jobId?: string; waitSec?: number }): Promise<unknown>`. It is implemented in `linkedHost.ts` as `linkedToolCall(opts)` and is safe to call before start; it then returns an error result saying Linked machines is off.

---

## Phase 2 split and exact contracts

Slice C is split so it can run in parallel with D and E. When A and B are done, **C1, C2, D and E run concurrently**, and C3 follows. Each slice edits only the files it owns:

| Slice | Owns |
|---|---|
| C1 | new `src/main/linked{Settings,Store,Directory,Jobs,Tool}.ts` + `tests/electron/linked{Settings,Store,Directory,Jobs,Tool}.test.ts` |
| C2 | `src/main/remoteBridgeHost.ts`, `src/main/remoteHost.ts` + their tests |
| D | `src/main/mcpServer.ts`, `src/shared/agentIntegration.ts`, `src/main/headroom/router.ts`, `src/mcp-adapter/stdio-adapter.cjs`, README/DOCUMENTATION tool counts, their tests; plus ONE stub line in `src/main/index.ts` `mcpHandlers` (`linkedMachines: async () => ({ error: 'Linked machines is not set up yet' })`) |
| E | renderer files listed in Slice E + `src/renderer/src/types/index.ts` (Linked* types and `Window.linked`) |
| C3 (later) | new `src/main/linkedHost.ts`, `src/main/index.ts` wiring (replaces D's stub), `src/preload/index.ts`, their tests |

Bridge types, as implemented in slice B, are in `src/main/remoteBridge/protocol.ts`: `LinkTarget`, `BridgeLink`, `PeerAgent`, `PeerRequest`, `PeerHelloInfo`, `PeerJobView`, `isPeerKind`, `MAX_LINKED_MACHINES = 16`. `linkCode.ts` exports `LINK_CODE_PREFIX`, `LINK_OFFER_TTL_MS`, `encodeLinkCode`, `parseLinkCode` and `isBridgeLink`.

### C1 contracts (pure modules, injectable deps, no Electron imports)

```ts
// linkedSettings.ts
export interface LinkedSettings { enabled: boolean }
export const LINKED_SETTINGS_FILE = 'linked-settings.json'
export function loadLinkedSettings(userDataDir: string): LinkedSettings          // missing/corrupt → {enabled:false}; only === true enables
export function saveLinkedSettings(userDataDir: string, s: LinkedSettings): void

// linkedStore.ts  (persisted through secureKeyStore.readSecret/writeSecret: 'osk:v1:' when a keyring exists, honest plaintext otherwise)
export interface LinkedGrants { run: boolean; write: boolean }
export const DEFAULT_GRANTS: LinkedGrants                                         // { run: true, write: false }
export interface JoinedLink { id: string; hostPublicKey: string; relayUrl: string; sessionRoomId: string; secretKey: string; linkedAt: number }
export interface LinkMeta { ref: string; name: string; grants: LinkedGrants; confirmed: boolean; linkedAt: number; phrase?: string /* kept only while unconfirmed */ }
export interface LinkedState { links: JoinedLink[]; meta: LinkMeta[] }
export const LINKED_STATE_FILE = 'linked-machines'
export function loadLinkedState(userDataDir: string): LinkedState                 // never throws; rebuilds field by field; drops malformed records (hex shapes as in protocol)
export function saveLinkedState(userDataDir: string, state: LinkedState): void
export function refOf(target: LinkTarget): string                                // 'device:<id>' | 'link:<id>'
export function targetOf(ref: string): LinkTarget | null                         // inverse; null when malformed
export function normalizeGrants(g: unknown): LinkedGrants | null                 // both booleans required; write ⇒ run is forced true

// linkedDirectory.ts  (pure)
export interface DesktopPeer { id: string; label: string; pairedAt: number }    // a bridge PairedDevice with kind 'desktop'
export interface LinkedMachineView { ref: string; name: string; online: boolean; confirmed: boolean; phrase?: string; grants: LinkedGrants; linkedAt: number; lastActivityAt?: number }
export interface DirectoryInput { peers: DesktopPeer[]; links: JoinedLink[]; meta: LinkMeta[]; online: ReadonlySet<string>; lastActivity: ReadonlyMap<string, number> }
export function machineViews(input: DirectoryInput): LinkedMachineView[]         // one view per peer and per link; missing meta → name from label (peer) or 'Computer' (link), unconfirmed, DEFAULT_GRANTS; sorted by name, case-insensitive
export function resolveMachine(views: LinkedMachineView[], nameOrRef: string): LinkedMachineView | null   // exact ref, else case-insensitive name; then trimmed
export function uniqueName(taken: string[], base: string): string               // sanitize (trim, strip controls, ≤ 64 chars, fallback 'Computer'); 'X', 'X (2)', 'X (3)'… compared case-insensitively
export function pruneMeta(meta: LinkMeta[], peers: DesktopPeer[], links: JoinedLink[]): LinkMeta[]

// linkedJobs.ts  (executor)
export interface LinkedActivity { id: string; direction: 'in' | 'out'; ref: string; machine: string; agent: string; summary: string; status: 'running' | 'done' | 'failed' | 'cancelled'; startedAt: number; durationMs?: number }
export interface LinkedJobsDeps {
  runHeadless(req: ExecRequest): Promise<ExecResult>              // the caller binds deliver/primer; ExecRequest from headlessExec.ts (slice A)
  agentsInstalled(): Promise<{ claude: boolean; codex: boolean; gemini: boolean }>
  localName(): string; version: string; homedir(): string
  isDirectory(p: string): boolean
  isSafeModel(model: string): boolean                             // wire modelCatalog.isSafeModelId
  now(): number; randomId(): string                               // 12 lowercase hex
  onActivity(a: LinkedActivity): void                             // called on start and on every status change, same id
}
export function createLinkedJobs(deps: LinkedJobsDeps): {
  handle(from: LinkTarget, meta: LinkMeta, req: PeerRequest): Promise<unknown>
  cancelAll(): void
}
```

The handle rules follow spec §4.5 and slice C:
- **`peerHello`** is always answered.
  - When `meta.confirmed` is false it returns agents all false and grants `{run:false, write:false}`.
  - When confirmed it returns `meta.grants`.
- **Every other kind** first requires `meta.confirmed`. Otherwise it throws `Error('Not confirmed yet on <localName> — confirm the link under Settings ▸ Linked machines there.')`.
- **Validation.**
  - Every field of the request is validated.
  - The thrown error messages are user-readable, because the bridge sends them back verbatim.
- **Finished jobs** are kept 2 h, at most 100.
- **`runHeadless`** is called with `{ task: framed, agent, model, cwd, write, timeoutMs, isolateMcp: true, noRemember: true, env: { TERMPOLIS_LINKED_JOB: jobId }, signal }`.
- **Output** is capped at 200_000 chars, keeping the tail and setting `truncated`.
- **Status.**
  - A run that resolves `ok:false` is `failed`, with `error`.
  - An aborted run is `cancelled`.
  - If `runHeadless` throws, the job is `failed`.

```ts
// linkedTool.ts  (requester; the MCP handler body)
export interface LinkedToolArgs { action?: string; machine?: string; agent?: string; prompt?: string; cwd?: string; write?: boolean; model?: string; jobId?: string; waitSec?: number }
export interface LinkedToolDeps {
  call(target: LinkTarget, request: PeerRequest, timeoutMs: number): Promise<unknown>   // rejects Error(message), e.g. 'offline'
  machines(): LinkedMachineView[]
  enabled(): boolean
  localName(): string
  inspect(text: string, machine: string, agent: string): string   // riskBanner(inspectResult(text, 210_000), machine, agent)
  onActivity(a: LinkedActivity): void
  now(): number
}
export function createLinkedTool(deps: LinkedToolDeps): { call(args: LinkedToolArgs): Promise<unknown> }
```

The tool never throws. Every failure comes back as data, `{ error: string, … }`, because `executeTool` masks thrown messages.
- **When Linked machines is off:** `{ error: 'Linked machines is off. Turn it on under Settings ▸ Linked machines.' }`.
- **`list`:** `{ thisMachine, machines: [{ name, online, confirmed, agents: string[] | null, canRun: boolean | null, canWrite: boolean | null, note? }] }`.
  - It fires a `peerHello` (8 s timeout) at each online, confirmed machine, in parallel.
  - When a hello fails, the null fields are explained in `note`.
- **`run`:**
  1. Validate `agent`, a non-empty `prompt` of at most 20_000 chars, and the machine (unknown → `Unknown machine "x". Linked machines: a, b`).
  2. Check the link is confirmed and online (offline → `"<name>" is offline — Termpolis must be running there.`).
  3. Send `peerRun` with a 20 s timeout.
  4. Long-poll `peerResult` with `waitMs = min(remaining, 25_000)` and timeout `waitMs + 20_000`, until the job is no longer running or `waitSec` (default 45, clamped 0..50) runs out.
- **`result`:** parses `jobId` (`<16hex>-<12hex>`) back to `{ ref: 'device:'|'link:' + id }`, checking which kind exists in `machines()`, then long-polls the same way.
- **Return shape for `run`/`result`:** `{ jobId, machine, agent, status, output?, truncated?, error?, durationMs?, note? }`.
  - `output` has been passed through `inspect`.
  - When the job is still running, `note` says to call `result` with this `jobId`.
  - Activity is recorded with `direction: 'out'`.

### C2 contracts (`remoteBridgeHost.ts` / `remoteHost.ts`)

```ts
// RemoteHostDeps gains:
linkedInit?: () => { enabled: boolean; links: BridgeLink[] }   // default: disabled, none
// RemoteHost gains:
refreshLinked(): void            // re-read linkedInit(): start/stop the bridge (runs iff remote.enabled || linked.enabled);
                                 // restart when the phones/linked flags change while running; send {kind:'setLinks'} when only links changed
beginLinkPairing(label?: string): void   // posts beginPairing {link:true,…}; marks the live offer as a LINK offer
linkedPort(): LinkedBridgePort
export interface LinkedBridgePort {
  running(): boolean
  send(msg: HostToBridge): void                                // no-op when the bridge is down
  onMessage(cb: (m: BridgeToHost) => void): () => void        // EVERY bridge message, unfiltered
  desktopPeers(): PairedDevice[]                              // current devices with kind 'desktop'
  attachedDeviceIds(): ReadonlySet<string>
  verificationPhraseFor(deviceId: string): string | null
  relayUrl(): string
}
```

- **Remote views.** `RemoteStatusView.devices` excludes `kind:'desktop'`. `RemoteStatusView.running` means running AND remote enabled. `RemoteStatusView.pairing` shows only a PHONE offer.
- **Remote events.** The Remote renderer events skip:
  - every link-only kind (`linkJoined`, `joinFailed`, `linkCallResult`, `peerRequest`, `linkStateChanged`, `linkBye`);
  - `paired`, `verificationPhrase`, `deviceConnected` and `deviceDisconnected` for desktop devices;
  - errors raised while the live offer is a link offer.
- **Bridge init** is built by a factory passed to `startRemoteBridge(() => init)`, which slice B supports. Init carries `phones: remote.enabled`, `linked: linkedInit().enabled` and `links: linkedInit().links`.

### D contract

`McpToolHandlers.linkedMachines: (opts: LinkedToolArgs) => Promise<unknown>`. Declare the args type locally in `mcpServer.ts`, with the same shape. Its case is `case 'linked_machines': return handlers.linkedMachines(args ?? {})`.

### E contract (`src/renderer/src/types/index.ts`)

```ts
export interface LinkedGrants { run: boolean; write: boolean }
export interface LinkedMachineView { ref: string; name: string; online: boolean; confirmed: boolean; phrase?: string; grants: LinkedGrants; linkedAt: number; lastActivityAt?: number }
export interface LinkedActivityView { id: string; direction: 'in' | 'out'; machine: string; agent: string; summary: string; status: 'running' | 'done' | 'failed' | 'cancelled'; startedAt: number; durationMs?: number }
export interface LinkedStatusView { enabled: boolean; running: boolean; relayUrl: string; thisMachine: string; code: { code: string; expiresAt: number } | null; joining: boolean; machines: LinkedMachineView[]; activity: LinkedActivityView[] }
export type LinkedEvent = { kind: 'pending'; ref: string; phrase: string; suggestedName: string } | { kind: 'error'; message: string } | { kind: 'linked'; ref: string; name: string }
export interface LinkedAPI {
  status(): Promise<IpcResponse<LinkedStatusView>>
  setEnabled(enabled: boolean): Promise<IpcResponse<LinkedStatusView>>
  createCode(grants: LinkedGrants): Promise<IpcResponse<LinkedStatusView>>
  cancelCode(): Promise<IpcResponse<LinkedStatusView>>
  join(code: string, grants: LinkedGrants): Promise<IpcResponse<LinkedStatusView>>
  cancelJoin(): Promise<IpcResponse<LinkedStatusView>>
  confirm(ref: string, name: string): Promise<IpcResponse<LinkedStatusView>>
  rename(ref: string, name: string): Promise<IpcResponse<LinkedStatusView>>
  setGrants(ref: string, grants: LinkedGrants): Promise<IpcResponse<LinkedStatusView>>
  unlink(ref: string): Promise<IpcResponse<LinkedStatusView>>
  onStatus(cb: (s: LinkedStatusView) => void): () => void
  onEvent(cb: (e: LinkedEvent) => void): () => void
}
// Window gains: linked?: LinkedAPI   (optional, so components must guard for it)
```

The IPC channels behind these methods are: `linked:status`, `linked:set-enabled`, `linked:create-code`, `linked:cancel-code`, `linked:join`, `linked:cancel-join`, `linked:confirm`, `linked:rename`, `linked:set-grants` and `linked:unlink`. The pushes are `linked:status-changed` and `linked:event`.

---

## Slice D — MCP tool and agent integration

- **`mcpServer.ts`.**
  - Add the `linked_machines` TOOLS entry: `name: '…',` immediately followed by `description:`, because `termpolis-web/scripts/sync-app-facts.mjs` depends on it.
  - Add `McpToolHandlers.linkedMachines`, an `executeTool` case, and `RATE_LIMITS.linked_machines = {max:30, windowMs:60_000}`.
  - **Description budget.** Keep the total ≤ 6000 (currently 5859). Write a short description and trim `memory_feedback` if needed, keeping `/helpful: ?false|wrong|misleading/i` matching.
  - **Tests.** Update `toHaveLength(39)` to 40, plus the description-budget test, the handler test and the rate-limit test.
- **`src/shared/agentIntegration.ts`.** Add `linked_machines` to `MCP_TOOLS_ASK`, then fix the computed-count tests (`agentIntegration.test.ts`, `agentMcpRegistry.test.ts`, `mcpToolPolicy.test.ts`).
- **`headroom/router.ts`.** Add `linked_machines` to `EXEMPT_TOOLS`.
- **`src/mcp-adapter/stdio-adapter.cjs`.** If `process.env.TERMPOLIS_LINKED_JOB` is set and a `tools/call` names `linked_machines`, answer locally with `isError` text `Nested delegation is not allowed: this agent was itself started by a linked machine.` Add a test in `stdioAdapterContract.test.ts`.
- **Wire the handler** in index.ts `mcpHandlers`: `linkedMachines: (opts) => linkedToolCall(opts)`.
- **Docs.** Update the tool counts and list in `README.md` and `docs/DOCUMENTATION.md`.

---

## Slice E — renderer UI

- **New `src/renderer/src/components/SettingsPane/LinkedMachinesSettings.tsx`**, plus small subcomponents in the same folder if it grows past ~350 lines.
  - **Three states**, as RemoteSettings does: unavailable (no `window.linked` or a failed status), loading, loaded.
  - **Enable switch:** "Let this computer link with my other computers". Show a short explanation, the relay in use (read-only), and the line "uses the Remote relay".
  - **"Link a computer"** has two pending-grant checkboxes: "Run agents here (read-only)", on by default, and "Let agents edit files and run commands here", off, with an amber warning line. Its **Create code** button shows the code in a monospace read-only box with a **Copy** button (`navigator.clipboard.writeText`), the countdown, and Cancel.
  - **"Enter a code from another computer"** has a textarea, the same grant checkboxes and a **Link** button. It shows `joining` progress and Cancel.
  - **Pending confirmation** happens on `linked:event` `pending`, or for any machine with `confirmed:false`. Show the 8 safety words in large type, a name input pre-filled with the suggested name, **They match — link**, which calls `confirm`, and **Cancel**, which unlinks.
  - **Machine list.** Each row has:
    - an online dot;
    - the name, editable inline with save on Enter or blur;
    - "waiting for confirmation" when relevant;
    - the two grant toggles;
    - the last activity;
    - a two-click Unlink.
  - **Activity list:** the latest 20 rows.
  - **Testids** use the `linked-` prefix: `linked-settings`, `linked-enable`, `linked-create-code`, `linked-code`, `linked-copy`, `linked-countdown`, `linked-join-input`, `linked-join-button`, `linked-phrase`, `linked-confirm`, `linked-machine-${ref}`, `linked-unlink-${ref}`, `linked-grant-${ref}-run|write`, `linked-activity`.
- **Settings registration.**
  - Add `'linked'` to the `SettingsTab` union in `lib/settingsNav.ts`.
  - Add `{ id: 'linked', label: 'Linked machines' }` after `remote` in `SettingsPane.tsx` with icon `fa-link`, and render it conditionally.
  - Update `SettingsCoverage.test.tsx` and `SettingsPane.test.tsx` for the new tab.
- **Remote UI copy.**
  - `RemoteSettings` and `RemoteIndicator` count and list phones only, since main already filters.
  - Guard `RemoteSettings` against a missing `window.remote`.
- **Tests.** Add `tests/renderer/linkedMachinesSettings.test.tsx`, mirroring `remoteSettings.test.tsx`: `window.linked = api` built from `vi.fn`s, with `ok`/`fail` helpers. Cover every state and action.

---

## Slice F — integration, e2e, docs and verification

- **`tests/electron/linkedEndToEnd.test.ts`.** Build two full stacks: `createRemoteHost` + `createBridgeCore` + linked host, joined through `memoryRelay`, with a fake `deliver`. It covers: pairing, confirm on both sides, A→B `run` with a long-poll returning output, B→A, grant refusals (write without permission), offline, unlink propagation, and the nested-delegation env marker reaching deliver.
- **`e2e/linked-machines.spec.ts`**, mirroring `remote-settings.spec.ts`. Use `DEAD_RELAY` via `TERMPOLIS_RELAY_URL` / the relay setting. The flow: open the tab → enable → create a code → a `termpolis-link:` code and the countdown are visible → cancel → disable (the teardown).
- **README.** Add a "Linked machines" section: what it is, setup, the security model, and its limits (both must be online, 60 s Codex tool timeout handled by start-then-check, fresh session per run).
- **Final gates:**
  - `npm run typecheck`, `npm run lint` (0 errors), `unset PROMPT_COMMAND && npx vitest run --coverage` (green thresholds), `npm run build`;
  - `npm run typecheck:test` covers the remote tests;
  - `npm run test:relay` and the mobile tests stay untouched and green.
