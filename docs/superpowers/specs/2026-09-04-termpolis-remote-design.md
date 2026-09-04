# Termpolis Remote — Design Spec

**Date:** 2026-09-04
**Status:** Approved for planning (design locked in brainstorming)
**Scope:** New subsystem — remote control of a running Termpolis desktop app from a paired
iOS/Android client, over a zero-knowledge relay.

---

## 1. Goal

Let a user keep working with their running Termpolis desktop app — typing into live agent
terminals, reading output, starting a new AI terminal — from a phone, while away from the
desktop machine.

The phone is a **thin pass-through**. It holds no memory brain, no embeddings, no model
credentials, and no project data at rest beyond UI state. All work continues to execute on the
desktop, as the desktop user, using whatever Claude / Codex / Gemini account that machine is
already signed into. Nothing about the existing agent, memory, or credential model changes.

### Non-goals

- No cloud execution. If the desktop app is closed, remote does nothing. This is deliberate.
- No memory / RAG / embeddings on the phone.
- No second brain, no divergent state, no offline queue of work to replay later.
- No change to the `127.0.0.1` bind of the MCP server.

---

## 2. Why this is worth building

The verified competitive-gap review (2026-07, recorded in memory) put **cloud / async / remote
execution** as the single largest cluster of real gaps versus OpenCode (`opencode serve`),
Factory (`droid exec`), and Kiro (cloud agents + schedules). Termpolis is local-only.

Termpolis Remote closes that gap *without* abandoning the local-first identity: execution stays
on the user's own machine, and the only hosted component is a relay that cannot read anything it
forwards.

---

## 3. Architecture

```
                                                 ┌ Termpolis desktop ─────────────┐
                                                 │                                │
  ┌──────────────┐         ┌─────────────┐       │  ┌ utilityProcess ──────────┐  │
  │  Phone app   │  WSS    │    Relay    │  WSS  │  │      Remote Bridge       │  │
  │ (iOS/Android)│ ──────► │  (Worker +  │ ◄─────┼──┤                          │  │
  │              │         │  Durable    │       │  │  only capability:        │  │
  │  thin client │ ◄────── │   Object)   │ ──────┼─►│  HTTP → 127.0.0.1:9315   │  │
  └──────────────┘         └─────────────┘       │  └────────────┬─────────────┘  │
         │                        │              │      MessagePort │ HTTP        │
         │                   forwards            │  ┌───────────────▼──────────┐  │
         │                sealed frames          │  │  main: mcpServer.ts      │  │
         │                                       │  │  (unchanged, loopback)   │  │
         └── holds: device keypair,              │  └──────────────────────────┘  │
             paired-desktop pubkey,              └────────────────────────────────┘
             UI state. Nothing else.                runs the agent CLI as the desktop
                                                    user; memory and credentials
                                                    never leave the machine
```

The bridge is a separate OS process (§5.0). Main forks and supervises it, but is not on the
request hot path — the bridge calls the local MCP endpoint over HTTP itself.

**Both endpoints dial out.** The desktop opens an outbound WSS to the relay and holds it. There
is no inbound port, no port forwarding, no firewall exception, and no change to the loopback
bind. The bridge is a *client* of the app's own local MCP server, so the localhost-only
guarantee is preserved rather than weakened. This is the load-bearing property of the design.

### 3.1 Component boundaries

| Component | Owns | Depends on |
|---|---|---|
| Remote Bridge (desktop) | Relay connection, sealed channel, device registry, capability policy, output fan-out, push triggers | Local MCP server over HTTP; `terminalOutputBuffer`; shared status detector |
| Relay (hosted) | Frame routing between a desktop and its paired devices, quotas, abuse limits | Nothing. Holds no keys and no plaintext. |
| Phone client | Pairing UX, terminal rendering, input, notification handling | Relay WSS; OS keystore; APNs / FCM |

Each is independently testable: the bridge against a fake relay, the relay against two fake
sockets, the phone against a fake relay + recorded frame fixtures.

---

## 4. Security model

### 4.1 Threat model

The relay is treated as **untrusted** — assume it is compromised or subpoenaed. It must learn
nothing beyond routing metadata. Prompts, output, file paths, repo names, and keys must be
opaque to it.

### 4.2 Cryptography

- **Identity:** X25519 static keypair per device (desktop and each phone), generated locally.
  Private keys never leave the device; the phone's lives in the iOS Keychain / Android Keystore.
- **Session:** per-connection ephemeral ECDH → ChaCha20-Poly1305 sealed frames, with rekeying
  for forward secrecy.
- **Library:** `@noble/curves` + `@noble/ciphers` — audited, pure JS, **no native modules**.
  This is a deliberate constraint: the app has repeatedly been burned by native deps, and the
  memory embedder went WASM for the same reason. No native crypto module is acceptable here.

The relay routes on an opaque pairing id. It sees frame sizes and timing; nothing else.

**Key storage constraint.** `safeStorage` does not exist in a `utilityProcess` — `memoryClient.ts`
already documents this for the memory store's at-rest key. The bridge's X25519 private key is
therefore **provisioned in main** and handed to the child at init, mirroring
`provisionMemoryKey()`. The established house rule applies unchanged: where there is no real OS
keychain, stay honestly plaintext rather than writing a key next to the ciphertext it protects
and calling it encrypted.

### 4.3 Pairing

1. Desktop displays a QR encoding `{ relayUrl, pairingId, desktopPubKey, oneTimeSecret }`.
2. The QR is **single-use and expires in ~90 seconds**.
3. Phone scans, completes the handshake, and registers its own public key.
4. **Both screens display a 6-word verification phrase that the user must confirm matches.**

Step 4 is mandatory, not optional polish. Without an out-of-band confirmation, a malicious relay
can MITM the pairing handshake and the end-to-end claim becomes marketing rather than fact. It
is Signal-style safety numbers and is cheap to implement.

> Note for documentation and marketing copy: Telegram is **not** end-to-end encrypted by default
> — only Secret Chats are. Do not describe this feature as "like Telegram." The model here is
> Signal's, and it is stronger. Claims made about it must stay accurate.

### 4.4 Authorization

- Remote is **default OFF**. Opt-in lives under Settings → Remote.
- Capabilities are granted **per paired device**, not globally.
- A persistent on-screen indicator shows whenever a device is attached.
- Every paired device is individually revocable, and idle pairings auto-expire.
- Remote requests reach the app through the existing local MCP endpoint with the existing bearer
  token, so they inherit the current **auth, per-endpoint rate limits, and JSONL audit log** with
  no new privileged code path. Audit entries are tagged with the originating device.

### 4.5 Accepted risk — `write_to_terminal`

`sanitizeAgentCommand`'s allowlist only guards terminals tracked in `mcpCreatedTerminals`.
Writing into an *existing* agent session via `write_to_terminal` bypasses it completely: it is
arbitrary instruction injection into an agent that holds the user's filesystem.

This is also exactly the requested feature, so it cannot be blocked. Mitigation:

- It is a **separate capability grant**, off until explicitly enabled.
- The risk is stated plainly at grant time, not buried in documentation.
- A compromised phone is, by design, equivalent to sitting at the keyboard. The pairing
  verification phrase, per-device revocation, and audit trail are what bound that.

---

## 5. Desktop bridge

### 5.0 Process placement — the bridge runs off the main process

The bridge runs in its own **Electron `utilityProcess`**, not on the main process.

The reason is *not* crypto cost. `@noble` ChaCha20-Poly1305 runs at a few hundred MB/s in Node;
at the ~256 KB/s fan-out ceiling of §5.2 that is roughly 1 ms of CPU per second, which would be
unobjectionable on main. The reasons that do justify it:

1. **Crash isolation.** The bridge parses frames arriving from an untrusted network. A protocol
   bug, a malformed frame, or an OOM there must not be able to take down the app. In a
   `utilityProcess`, main observes an `exit` event and restarts it with backoff.
2. **PTY protection.** The app has already regressed here once: in-process WASM embedding pinned
   the main process while it was pumping PTY echo, and the symptom was typing lag. Sustained
   network + crypto work on main is the same shape of mistake. Main stays free to pump terminal
   I/O.
3. **Capability confinement.** In its own process the bridge holds exactly one capability —
   HTTP to `127.0.0.1:<mcpPort>` with the bearer token. It has no Electron APIs, no window
   handle, and no ambient filesystem access. That is a meaningful reduction in blast radius for
   the only network-facing component in the app.

**Consequences:**

- Main spawns the bridge via `utilityProcess.fork()`, passing the MCP port and bearer token, and
  supervises it (restart with backoff, surfacing status to the UI).
- The bridge makes its own HTTP calls to the local MCP endpoint. It does **not** proxy tool
  calls back through main, so main is not on the hot path at all.
- IPC between main and the bridge is `MessagePort`-based and carries only UI-facing events:
  pairing QR payload, device list changes, attached/detached indicator state, push triggers.
- The build gains a second entry point: the bridge must be bundled separately in the
  electron-vite config, and packaged with the app.
- Tests exercise the bridge as a plain Node module, with the `utilityProcess` supervision logic
  tested separately against a stub child. No test needs a live Electron instance to cover the
  protocol.

### 5.1 Modules

Module `src/main/remoteBridge/`, deliberately split into small focused files rather than
growing another monolith:

| File | Responsibility |
|---|---|
| `entry.ts` | `utilityProcess` entry point; wires MessagePort IPC to main |
| `supervisor.ts` | **Runs on main.** Forks, supervises, and restarts the bridge process |
| `mcpClient.ts` | HTTP client for the local MCP endpoint (bearer token, retries) |
| `bridgeClient.ts` | Outbound WSS to relay, reconnect with backoff |
| `sealedChannel.ts` | Handshake, frame seal/open, rekey |
| `pairing.ts` | QR payload, one-time secret, verification phrase derivation |
| `deviceRegistry.ts` | Paired devices — persisted, revocable, idle-expiring |
| `remotePolicy.ts` | Per-device capability grants and enforcement |
| `outputFanout.ts` | Per-device replay buffer and delta push |
| `pushNotifier.ts` | Notification trigger evaluation and dispatch |

### 5.2 Output delivery — and the loss problem

`MAX_TERMINAL_BUFFER_CHARS` is 32 KB, and `readOutputFrom` returns a `missed` count whose own
comment states the skipped output is *"gone for good."* A phone on cellular during a verbose
build will outrun that window and lose output permanently.

Three-part fix, all required:

1. The bridge **pushes** deltas over the already-open socket. The phone does not poll.
2. The bridge keeps a larger **per-device replay buffer** (~256 KB) so a lagging phone loses
   nothing the desktop still has.
3. When `missed > 0` regardless, the phone renders an explicit `— 4.2 KB skipped —` marker.
   A visible gap is correct; an invisible one is a bug that looks like corruption.

### 5.3 Refactor — move the status detector to shared

`src/renderer/src/lib/agentStatusDetector.ts` already classifies exactly the states worth
notifying on: `waiting_for_input`, `completed`, `errored`, `blocked`. It is a pure function over
terminal text with no DOM dependency.

**Correction to an earlier draft of this spec:** main is *not* blocked from reaching it —
`src/main/index.ts:119` already imports it directly across the boundary
(`from '../renderer/src/lib/agentStatusDetector'`). Push triggers are therefore not blocked
today.

The move to `src/shared/agentStatusDetector.ts` is still in scope for sub-project 1, but for
build hygiene rather than reachability: the bridge is a **separate electron-vite entry point**,
and having that bundle reach into `src/renderer/src/lib/` to pull a pure utility is the kind of
cross-tree import that quietly grows into a bundling problem. One detector, one home, three
consumers (main, renderer, bridge).

---

## 6. Phone client

- **Framework:** React Native via Expo — one codebase for iOS and Android, with the config
  plugins needed for camera (QR scan), secure keystore, and push.
- **Screens:** paired-desktop status → terminal list → terminal view (output + input) → new AI
  terminal → settings/revoke.
- **Terminal rendering:** read-mostly. Full xterm emulation on mobile is not warranted; render
  the ANSI subset the agent CLIs actually emit, with a monospace view, selectable text, and the
  skipped-output markers from §5.2.
- **Offline:** the phone shows last-known state clearly marked stale and queues nothing. Work
  does not silently execute later.
- **Notifications:** APNs / FCM, triggered by the shared status detector on the desktop, for
  `waiting_for_input`, `completed`, `errored`, `blocked`. Payloads carry no content — only a
  pairing id and a state — so the push providers learn nothing.

---

## 7. Relay service

- **Runtime:** Cloudflare Worker + Durable Object, one DO per pairing, holding the two sockets.
- **Multi-tenant**, operated as part of the product.
- **Zero-knowledge:** routes sealed frames on an opaque pairing id. Holds no keys, stores no
  plaintext, and persists no frame bodies.
- **Abuse controls:** per-pairing connection and bandwidth quotas, frame-rate limits,
  registration rate limits.
- **Availability:** if the relay is down, remote is unavailable and the desktop app is otherwise
  unaffected. The bridge fails closed and reconnects with backoff.
- **Privacy statement:** short and honest, because there is little to disclose — pairing ids,
  frame sizes, timing, and connection logs.

---

## 8. Testing

- **Unit:** sealed-channel round-trip; handshake rejection on tampered frames; verification-phrase
  determinism; policy enforcement per capability; replay-buffer correctness including the
  `missed > 0` path; status-detector parity after the shared move.
- **Integration:** bridge against a fake relay; full pair → attach → write → read → revoke cycle;
  reconnect under socket loss; revocation taking effect immediately on an open session.
- **E2E:** existing Playwright suite covers the desktop surfaces (Settings → Remote, pairing QR,
  device list, indicator). Per project convention, E2E must assert on
  `__termpolis_terminal_text`, never on `.xterm` textContent.
- **Coverage gate:** the existing Windows CI thresholds apply unchanged — lines 97 / functions 96
  / branches 95 / statements 96. New modules backfill tests rather than lowering the gate.
- **Security:** an explicit test that the relay never observes plaintext, asserted against
  recorded frames.

---

## 9. Decomposition

This is too large for a single implementation plan. Four sub-projects, in dependency order. Each
gets its own plan and its own ship.

| # | Sub-project | Outcome | Depends on |
|---|---|---|---|
| 1 | **Desktop bridge + sealed channel** | Desktop can pair with, and serve, a test client. Verifiable with a CLI harness — no phone needed. | — |
| 2 | **Relay service** | Hosted, multi-tenant, quota'd, zero-knowledge. | 1 (protocol shape) |
| 3 | **Phone client** | Expo app, full feature set, running on both platforms via TestFlight / internal track. | 1, 2 |
| 4 | **Store release** | App Store + Play Store submission, export-compliance declaration, privacy labels, listings. | 3 |

**Sub-project 1 is the one to build first**, and it is independently verifiable: a CLI test
client exercises pairing, the sealed channel, capability policy, and output fan-out end to end
before any mobile code exists. That keeps the riskiest work (crypto, protocol, output loss) off
the critical path of the store submissions.

### Known lead-time items for sub-project 4

- **Apple Developer Program** membership is required for App Store Connect. Memory records Apple
  signing secrets already in CI for macOS notarization — confirm whether that is full membership.
- **Encryption export compliance** (`ITSAppUsesNonExemptEncryption`) is a real submission gate
  once non-exempt crypto ships, and is the most commonly missed one.
- Google Play requires a one-time registration and a privacy policy URL.
- Remote-terminal apps are well-precedented on both stores (Termius, Blink, Prompt), so the
  category itself is not a review risk.

---

## 10. Open items

None blocking sub-project 1. Items below are resolved during their own sub-project:

- Relay hosting region / domain choice (sub-project 2).
- Whether notification payloads carry a terminal *name* or only a pairing id — a usability vs.
  metadata-leak tradeoff, decided in sub-project 3.
