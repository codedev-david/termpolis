# Termpolis Remote — Desktop Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the finished-but-unreferenced Remote Bridge into a feature of the shipping app — spawned from main, fed real PTY output, and driven from a Settings → Remote tab.

**Architecture:** `src/main/remoteBridge/**` and `remoteBridgeSupervisor.ts` already exist, are fully tested, and nothing imports them. This plan adds the *host* half: three small persistence modules (identity, devices, settings), a subscription-driven output pump, one `remoteBridgeHost.ts` that owns the lifecycle and is the only thing `index.ts` calls, an IPC surface, and the renderer UI. The bridge itself is touched in exactly one place — a new `subscriptionsChanged` message so main pumps only the terminals a phone is actually watching.

**Tech Stack:** Electron `utilityProcess`, `safeStorage` via `secureKeyStore`, React + Tailwind renderer, `qrcode-generator` (new, zero-dependency, MIT) for the pairing QR.

**Spec:** `docs/superpowers/specs/2026-09-04-termpolis-remote-design.md` (§4.4 desktop surfaces, §4.5 capabilities, §8 UX)

## Global Constraints

- Coverage gate (Windows CI): lines 97 / functions 96 / **branches 95** / statements 96. NEVER lower — backfill tests on the offending file.
- Renderer components under `src/renderer/src/components/**/*.tsx` ARE in the gate. A new `.tsx` needs tests.
- Commit directly to `main`. No branches, no PRs.
- `safeStorage` does not exist in a `utilityProcess`. The identity secret key is resolved in **main** and handed to the child in `init`.
- Remote is **off by default**. A network-facing bridge must be opt-in.
- Every capability defaults false. `writeToTerminal` is never implied by `createTerminal`.
- Never log a relay frame or any part of one. Room id and frame length only.
- The renderer never receives `identitySecretKey`. It receives the public key, the safety phrase, and device metadata.
- e2e must never assert on `.xterm` textContent — use `__termpolis_terminal_text`.
- App-boot rule: every wiring block in `index.ts` is wrapped in try/catch so a fault cannot fatal `whenReady`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/main/remoteIdentityStore.ts` (new) | This desktop's X25519 identity, minted once, OS-encrypted at rest. Mirrors `groqKeyStore.ts`. |
| `src/main/remoteDeviceStore.ts` (new) | Paired devices as JSON in userData. Load/save/validate. No rules — `DeviceRegistry` owns those. |
| `src/main/remoteSettings.ts` (new) | `{ enabled, relayUrl }`, persisted. |
| `src/main/remoteOutputPump.ts` (new) | Coalesces PTY writes and pushes contiguous slices for **subscribed terminals only**. Pure; timers injected. |
| `src/main/remoteBridgeHost.ts` (new) | Lifecycle + glue: start/stop, persist on `devicesChanged`, forward events to the renderer, own the pump. The only remote module `index.ts` imports. |
| `src/main/remoteBridge/protocol.ts` | +`subscriptionsChanged` in `BridgeToHost`. |
| `src/main/remoteBridge/outputFanout.ts` | +`subscribedTerminals()`. |
| `src/main/remoteBridge/entry.ts` | Emit `subscriptionsChanged` whenever the subscribed set changes. |
| `src/main/remoteBridgeSupervisor.ts` | `createRemoteBridgeTransport` takes a relay URL and passes it in the child env. |
| `src/main/index.ts` | Call `startRemoteBridgeHost(...)` after MCP binds; feed the pump from the PTY data handler; register IPC. |
| `src/preload/index.ts` | `remote*` methods + `onRemoteEvent` subscription. |
| `src/renderer/src/types/index.ts` | `RemoteDeviceView`, `RemoteStatusView`, `TermpolisAPI` additions. |
| `src/renderer/src/lib/settingsNav.ts` | +`'remote'` tab id. |
| `src/renderer/src/components/SettingsPane/RemoteSettings.tsx` (new) | The tab: enable toggle, pairing, device list, capabilities, revoke. |
| `src/renderer/src/components/SettingsPane/PairingModal.tsx` (new) | QR + countdown + safety phrase. |
| `src/renderer/src/components/RemoteIndicator.tsx` (new) | "N phones attached" badge, rendered by TitleBar. |

---

## Task 1: Desktop identity store

**Files:**
- Create: `src/main/remoteIdentityStore.ts`
- Test: `tests/electron/remoteIdentityStore.test.ts`

**Interfaces:**
- Consumes: `writeSecret`/`readSecret` from `./secureKeyStore`; `generateIdentity` from `./remoteBridge/sealedChannel`.
- Produces: `remoteIdentityPath(userDataDir): string`, `getOrCreateRemoteIdentity(userDataDir): { secretKey: string; publicKey: string }`, `clearRemoteIdentity(userDataDir): void`.

- [x] **Step 1: Write the failing tests**

```ts
it('mints once and returns the same identity thereafter', ...)
it('derives the public key from the stored secret rather than storing it', ...)
it('re-mints when the stored value is not 64 hex chars', ...)
it('does not throw when the directory is unwritable', ...)
```

- [x] **Step 2: Run to verify failure.** `npx vitest run tests/electron/remoteIdentityStore.test.ts` → FAIL (module not found).
- [x] **Step 3: Implement.** File `remote-identity-key` in userData, written through `writeSecret` so it is DPAPI/Keychain-encrypted. Validate `/^[0-9a-f]{64}$/` on read; anything else re-mints. The public key is always derived, never stored — a stored pair can disagree with itself, and a wrong public key means every device pairs against an identity this desktop cannot prove.
- [x] **Step 4: Run to verify pass.**
- [x] **Step 5: Commit.** `feat(remote): persist the desktop's X25519 identity`

---

## Task 2: Paired-device store

**Files:**
- Create: `src/main/remoteDeviceStore.ts`
- Test: `tests/electron/remoteDeviceStore.test.ts`

**Interfaces:**
- Produces: `remoteDevicesPath(dir)`, `loadRemoteDevices(dir): PairedDevice[]`, `saveRemoteDevices(dir, devices: PairedDevice[]): void`.

- [x] **Step 1: Write the failing tests**

```ts
it('round-trips a device list', ...)
it('returns [] for a missing or unparseable file', ...)
it('drops entries missing an id, publicKey or sessionRoomId', ...)
it('fills absent capability flags with false rather than trusting the file', ...)
it('swallows a write error', ...)
```

- [x] **Step 2: Run to verify failure.**
- [x] **Step 3: Implement.** Validation is the point: this file decides what a phone is allowed to do, so a capability that is `undefined` on disk must read as `false`, never as truthy-by-omission. Unknown keys are dropped.
- [x] **Step 4: Run to verify pass.**
- [x] **Step 5: Commit.** `feat(remote): persist paired devices`

---

## Task 3: Remote settings store

**Files:**
- Create: `src/main/remoteSettings.ts`
- Test: `tests/electron/remoteSettings.test.ts`

**Interfaces:**
- Produces: `DEFAULT_RELAY_URL`, `RemoteSettings { enabled: boolean; relayUrl: string }`, `loadRemoteSettings(dir)`, `saveRemoteSettings(dir, patch: Partial<RemoteSettings>): RemoteSettings`.

- [x] **Step 1: Write the failing tests** — defaults are `{ enabled: false, relayUrl: DEFAULT_RELAY_URL }`; a missing file yields defaults; a partial patch merges; a relay URL that is not `ws:`/`wss:` is rejected and the previous value kept.
- [x] **Step 2: Run to verify failure.**
- [x] **Step 3: Implement.** Reject any relay URL that is not `ws:`/`wss:` — an `http:` URL would fail at dial time with a message that names neither the setting nor the reason.
- [x] **Step 4: Run to verify pass.**
- [x] **Step 5: Commit.** `feat(remote): remote settings with an off-by-default switch`

---

## Task 4: Subscription-driven output pump

**Files:**
- Modify: `src/main/remoteBridge/protocol.ts`, `src/main/remoteBridge/outputFanout.ts`, `src/main/remoteBridge/entry.ts`
- Create: `src/main/remoteOutputPump.ts`
- Test: `tests/electron/remoteOutputPump.test.ts`; extend `remoteOutputFanout.test.ts`, `remoteBridgeEntry.test.ts`

**Interfaces:**
- Produces: `BridgeToHost | { kind: 'subscriptionsChanged'; terminalIds: string[] }`; `OutputFanout.subscribedTerminals(): string[]`; `createOutputPump(deps): OutputPump` with `setSubscriptions`, `markDirty`, `dropTerminal`, `flushNow`, `stop`.

**Why:** main must not serialise every terminal's output across IPC when a phone is watching one. The bridge knows the subscribed set; nothing tells main. Without this message the pump either sends everything (the cost the user explicitly asked to avoid) or nothing.

- [x] **Step 1: Write the failing tests**

```ts
// outputFanout
it('reports the union of subscribed terminals across devices', ...)
it('drops a terminal from the union when the last subscriber unsubscribes', ...)
// entry
it('announces subscriptions after a granted subscribe', ...)
it('does not announce when the set is unchanged', ...)
it('announces after a revoke drops the last subscriber', ...)
it('does not announce for a subscribe the policy refused', ...)
// pump
it('coalesces many markDirty calls into one flush', ...)
it('sends contiguous slices, echoing nextOffset', ...)
it('reports missed output rather than resuming mid-stream', ...)
it('sends nothing for an unsubscribed terminal', ...)
it('sends a final slice for a terminal that just lost its last subscriber', ...)
it('forgets the offset of a closed terminal', ...)
it('stops the timer on stop()', ...)
```

- [x] **Step 2: Run to verify failure.**
- [x] **Step 3: Implement.**

```ts
export interface OutputPumpDeps {
  read(terminalId: string, fromOffset: number): OutputSlice
  send(terminalId: string, slice: OutputSlice): void
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  intervalMs?: number
}
```

Keep `offsets: Map<string, number>`, `subscribed: Set<string>`, `dirty: Set<string>`. `markDirty` records the id and schedules a flush only if none is pending — that single guard is what turns a keystroke storm into one IPC message per interval. `flush` iterates `dirty ∩ subscribed`, reads from the stored offset, sends when `output !== '' || missed > 0`, and stores `nextOffset`. `setSubscriptions` flushes terminals leaving the set once more before forgetting them.

- [x] **Step 4: Run to verify pass.** Also re-run `remoteBridgeEntry.test.ts` and `remoteOutputFanout.test.ts`.
- [x] **Step 5: Commit.** `feat(remote): pump output only for subscribed terminals`

---

## Task 5: Relay URL reaches the child

**Files:**
- Modify: `src/main/remoteBridgeSupervisor.ts`
- Test: extend `tests/electron/remoteBridgeSupervisor.test.ts`

- [x] **Step 1: Write the failing test** — `createRemoteBridgeTransport(path, relayUrl)` forks with `env.TERMPOLIS_RELAY_URL === relayUrl`, and omitting the URL leaves the parent env untouched.
- [x] **Step 2: Run to verify failure.**
- [x] **Step 3: Implement.** `utilityProcess.fork(path, [], { serviceName, env: { ...process.env, TERMPOLIS_RELAY_URL: relayUrl } })`. `entry.ts` already reads that variable; without this the setting is inert and a local relay is untestable.
- [x] **Step 4: Run to verify pass.**
- [x] **Step 5: Commit.** `feat(remote): pass the relay URL to the bridge process`

---

## Task 6: Bridge host — lifecycle, persistence, event fan-out

**Files:**
- Create: `src/main/remoteBridgeHost.ts`
- Test: `tests/electron/remoteBridgeHost.test.ts`

**Interfaces:**
- Produces: `startRemoteBridgeHost(deps)`, `stopRemoteBridgeHost()`, `remoteStatus(): RemoteStatusView`, `beginPairing(label)`, `cancelPairing()`, `revokeDevice(id)`, `setDeviceCapabilities(id, caps)`, `setRemoteEnabled(enabled)`, `verificationPhraseFor(id)`, `noteTerminalOutput(id)`, `noteTerminalClosed(id)`.

**Why a module and not lines in `index.ts`:** `index.ts` is already ~3,700 lines and its uncovered IPC handlers were the single worst coverage offender in the repo's history. All of this logic is testable with no Electron.

- [x] **Step 1: Write the failing tests**

```ts
it('does not spawn while remote is disabled', ...)
it('spawns with the persisted identity and devices on enable', ...)
it('persists the device list on devicesChanged', ...)
it('stops the bridge and keeps the devices on disable', ...)
it('forwards bridge events to the renderer as remote:event', ...)
it('never puts identitySecretKey in a renderer event or in remoteStatus()', ...)
it('recomputes a verification phrase from stored public keys', ...)
it('tracks attached device ids from deviceConnected/deviceDisconnected', ...)
it('marks remote disabled after the supervisor gives up', ...)
it('drops a terminal offset when the terminal closes', ...)
it('survives a send to a destroyed renderer window', ...)
```

- [x] **Step 2: Run to verify failure.**
- [x] **Step 3: Implement.** Deps are injected (`userDataDir`, `mcpPort`, `mcpToken`, `sendToRenderer`, `readOutput`, plus the supervisor functions) so the whole module is unit-testable. `verificationPhraseFor` calls `deriveVerificationPhrase(ownPublicKey, device.publicKey)` directly — the phrase is a pure function of two public keys, so round-tripping through the child would add a failure mode and answer nothing extra.
- [x] **Step 4: Run to verify pass.**
- [x] **Step 5: Commit.** `feat(remote): host module owning bridge lifecycle and persistence`

---

## Task 7: Wire into main + IPC + preload + renderer types

**Files:**
- Modify: `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/types/index.ts`
- Test: extend the main IPC and preload suites

**IPC surface** (all `remote:` prefixed, all returning the repo's `ok()` envelope):
`remote:status`, `remote:set-enabled`, `remote:begin-pairing`, `remote:cancel-pairing`, `remote:revoke-device`, `remote:set-capabilities`, `remote:verification-phrase`, `remote:set-relay-url`. Push: `remote:event`.

- [x] **Step 1: Write the failing tests** — each handler invokes its host function and returns `ok(...)`; `remote:set-capabilities` rejects a payload whose flags are not booleans; preload exposes each method and `onRemoteEvent` returns an unsubscribe function.
- [x] **Step 2: Run to verify failure.**
- [x] **Step 3: Implement.** In `index.ts`, after `mcpServer = startMcpServer(...)`: await the bound port, then `startRemoteBridgeHost({...})` inside try/catch. In the PTY `onData` handler beside `appendOutput(terminalOutputBuffers, id, data)` add `noteTerminalOutput(id)`; beside `terminalOutputBuffers.delete(terminalId)` add `noteTerminalClosed(terminalId)`. Validate capability payloads at the IPC boundary — this is the one place a compromised renderer could grant itself `writeToTerminal`.
- [x] **Step 4: Run to verify pass.**
- [x] **Step 5: Commit.** `feat(remote): spawn the bridge from main and expose it over IPC`

---

## Task 8: Settings → Remote tab

**Files:**
- Create: `src/renderer/src/components/SettingsPane/RemoteSettings.tsx`, `.../PairingModal.tsx`
- Modify: `src/renderer/src/lib/settingsNav.ts`, `.../SettingsPane/SettingsPane.tsx`
- Test: `tests/renderer/RemoteSettings.test.tsx`, `tests/renderer/PairingModal.test.tsx`
- Dependency: `npm i qrcode-generator`

- [x] **Step 1: Write the failing tests** — disabled state shows only the switch; enabling calls `remoteSetEnabled(true)`; a paired device renders its label, capability checkboxes and Revoke; toggling a checkbox sends the whole capability object; Revoke asks for confirmation first; a `pairingCode` event opens the modal; the modal renders a QR and counts down; an expired offer says so rather than showing a dead code; the safety phrase is shown with the words the host returned.
- [x] **Step 2: Run to verify failure.**
- [x] **Step 3: Implement.** The QR encodes `qrPayload` verbatim — re-serialising the JSON in the renderer risks a key order the phone's parser does not expect. Render as an SVG string from `qrcode-generator` at error-correction level M. The safety phrase sits directly beneath the QR with the instruction to compare it against the phone, because a safety number the user never looks at is decoration.
- [x] **Step 4: Run to verify pass.**
- [x] **Step 5: Commit.** `feat(remote): Settings tab with pairing, safety number and capabilities`

---

## Task 9: Attached-device indicator

**Files:**
- Create: `src/renderer/src/components/RemoteIndicator.tsx`
- Modify: `src/renderer/src/components/TitleBar/TitleBar.tsx`
- Test: `tests/renderer/RemoteIndicator.test.tsx`

- [x] **Step 1: Write the failing tests** — renders nothing with no attached device; renders a phone icon and the count with one or more; clicking opens Settings on the `remote` tab via `setPendingSettingsTab`.
- [x] **Step 2: Run to verify failure.**
- [x] **Step 3: Implement.** A separate component rather than markup inside `TitleBar.tsx`, which is excluded from the coverage gate — logic put there is logic nothing tests. Spec §4.4: the user must be able to tell at a glance that a phone is attached.
- [x] **Step 4: Run to verify pass.**
- [x] **Step 5: Commit.** `feat(remote): show when a phone is attached`

---

## Task 10: Full gate + release

- [x] **Step 1:** `npm run typecheck`
- [x] **Step 2:** `npx eslint <every touched file> --max-warnings 0`
- [x] **Step 3:** Prepend `C:\Program Files\Git\cmd` to PATH, then `npm run test:coverage` — expect exit 0 and all four floors clear.
- [x] **Step 4:** Manual smoke: enable Remote, pair with `node scripts/remote-test-client.cjs`, confirm the safety phrase matches on both sides, subscribe to a terminal, watch output arrive, revoke, confirm the socket closes.
- [x] **Step 5:** Commit and push to `main`.

## Self-Review

- **Spec coverage.** §4.4 desktop surfaces → Tasks 6–9. §4.5 capability model → Tasks 2, 7, 8. §8 UX → Tasks 8, 9. Relay URL configurability → Tasks 3, 5. Off-by-default → Task 3.
- **Type consistency.** `PairedDevice`, `Capabilities`, `OutputSlice` and `BridgeToHost` come from `src/main/remoteBridge/protocol.ts` throughout; the renderer's `RemoteDeviceView` is a structural copy declared in `src/renderer/src/types/index.ts` because the renderer cannot import from `src/main`.
- **Known gap.** Push notifications (spec §7) are deliberately out of scope: they need the Expo client's push token, so they belong to sub-project 3.
