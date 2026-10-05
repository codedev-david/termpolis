# Linked Machines — Design Spec

**Date:** 2026-10-05
**Status:** Implemented 2026-10-05.
**Scope:** A new capability. Pair Termpolis desktops with each other the way a phone pairs with a desktop. An AI agent on one machine can then run a headless Claude, Codex or Gemini agent on another linked machine and get the answer back as a tool result. Delegation works in both directions, across any network, for up to 16 linked machines per install.

---

## 1. Goal

David, in his own words: *"ask claude or openAI agent in one machine to spin up a agent in the other machine on this app and have it do work behind the scenes and give it back...and vice versa...name the machines however I want similar to the mobile app and then refer to them in chat ... not have huge blobs of text pasted in the terminal window...headless communication behind the scenes"*, plus *"the option if i want to bring in another machine or another"*.

The finished flow looks like this:

```
You (to Claude on the laptop):  "Have Codex on linux implement the parser in ~/repos/foo,
                                  commit it, then review the commit yourself."
Claude ── linked_machines(run, machine:"linux", agent:"codex", cwd:"~/repos/foo", write:true, prompt) ──►
          Termpolis(laptop) ══ sealed relay session ══► Termpolis(linux) ── headless `codex exec` in ~/repos/foo
Claude ◄── tool result: Codex's final answer (commit sha, test results) ──────────────────────────────┘
Claude reviews the commit locally and reports to you.
```

Nothing is typed into any terminal, and no new terminal opens on either machine. The work runs as headless jobs, and each machine's Settings ▸ Linked machines lists the jobs in an activity view.

### Non-goals (v1)

- **No swarm.** The swarm bus, conductor and task board are not involved. This is one-to-one delegation.
- **No interactive delegation.** Nothing types into a live agent TUI on the other machine.
- **No file or Git transport.** Code moves through Git as usual, for example a shared remote. The delegated agent receives a working folder and a self-contained prompt.
- **No conversation continuity between runs.** Each run is a fresh headless session, and the caller carries any context forward (SHA, earlier findings). This is a follow-up item (§10).
- **No inbound listener and no LAN mode.** Both machines dial out to the relay, exactly as Remote does. MCP stays bound to `127.0.0.1`.
- **No mailbox.** The relay is a rendezvous, not a queue. If a machine is offline, a request fails fast with `offline`.

---

## 2. Why this shape

The 2026-10-05 audit (memory: `project_peer_collab_audit`) found two things that shape this design:

- Termpolis Remote already has the hard parts: pairing, end-to-end crypto, per-peer grants, revocation and outbound-only transport.
- `termpolis-cli exec` already runs Claude, Codex and Gemini headless and returns text.

What is missing is the link between two desktops and a small job protocol on top of it. The rejected alternatives were:

| Option | Why not |
|---|---|
| Linux "coordination service" (the GPT plan) | Adds a new LAN listener, its own auth/TLS stack and a single point of failure, and duplicates Remote. |
| Federating the swarm bus | The bus is RAM-only and uses destructive reads. Federating it would mean a durable rebuild that one-to-one delegation does not need. |
| Codex `mcp-server` over SSH | Works today for Codex only, and only in one direction (laptop → Linux). It also needs SSH keys and gives the caller the Linux account. |

---

## 3. User experience

### 3.1 Settings ▸ Linked machines

- **Off by default.** The section has its own enable switch, **Let this computer link with my other computers**. While it is off, no linked room opens and every request from another computer is refused.
- **Link a computer (host side).** The user picks what the new machine may do *here*, then gets a one-time pairing code shown as text with a Copy button, a countdown and Cancel. The code is single-use and expires after 5 minutes (§6.1). The user moves it to the other machine by any means: chat, a shared folder, or typing it.
- **Enter a code from another computer (joiner side).** The user pastes the code and picks what the host machine may do *here*.
- **Confirmation on both screens.** Both sides show the same 8 safety words and the other machine's suggested name (its hostname). Each side gets a name field so the user can call the machine whatever they want. The user clicks **"They match — link"** on both. A link is active only after that confirmation. This is stronger than phone pairing on purpose, because nobody may be watching a desktop.
- **Machine list.** Each entry shows:
  - the name, renamable inline;
  - online/offline;
  - two permission toggles for what *that* machine may do *on this one*:
    - **Run agents here (read-only)**, on by default;
    - **Let agents edit files and run commands here**, off by default, with the risk stated next to it;
  - last activity;
  - **Unlink** (two clicks), which revokes on both sides. The goodbye is best effort, so a machine that is offline at the time keeps its record until it is unlinked there too.
- **Activity.** The 20 most recent jobs in and out, each with time, direction, machine, agent, the first line of the prompt, status and duration.
- **Cap.** At most 16 linked machines. A 17th pairing is refused with a clear message.

### 3.2 Agents

Agents get **one** new MCP tool, `linked_machines`, with three actions:

| action | params | returns |
|---|---|---|
| `list` | — | `thisMachine`, and each linked machine: `name`, `online`, `confirmed`, `agents` (installed there), `canRun`, `canWrite`, `note?` |
| `run` | `machine`, `agent` (`claude`/`codex`/`gemini`), `prompt`, `cwd?`, `write?`, `model?`, `waitSec?` | `{ jobId, machine, agent, status, output?, truncated?, error?, durationMs?, note? }` |
| `result` | `jobId`, `waitSec?` | same shape as `run` |

- `run` waits up to `waitSec` seconds (default 45, max 50) for the job to finish. Codex's default MCP tool timeout is 60 s, so a single blocking call must stay under it.
- If the job is still going when the wait ends, `run` returns `status: "running"` with the `jobId`, and the agent calls `result` until the job is done.
- Machines are addressed by their local name, matched case-insensitively.
- The result goes back to the calling agent as a normal tool result. The agent's TUI collapses it, and nothing lands in the terminal.

---

## 4. Security model

### 4.1 Threat model

- **The relay is untrusted**, exactly as in Remote §4.1. It learns routing metadata only.
- **A linked machine is trusted only up to the grants it was given.** A compromised linked machine with **Run agents (read-only)** can make an agent read any file the user can read and return it. With **edit** it can make an agent change files and run commands. The grant copy says so plainly.
- **Text crossing machines is data.** Inbound prompts are framed as delegated tasks. Results returning to the caller go through the gateway guard (§4.5).

### 4.2 Cryptography

Unchanged from Remote: X25519 identities, an ephemeral-static handshake, ChaCha20-Poly1305 sealed frames, `@noble/*`, no native modules. Each pairing gets fresh identity keys on the joining side, as the phone does, so unlinking one machine says nothing about the others. It also keeps two machines that each host a link to the other from deriving the same session room from the same two keys, where one of them would get a 409 forever. Keys are provisioned in main and handed to the bridge child (Remote §4.2, "Key storage constraint").

### 4.3 Pairing

- **Same pairing flow and wire format** as the phone: offer, PAIRING_HELLO, PAIRING_ACK, safety words.
- **Desktop-peer marker.** The joiner's hello carries an additive optional `peer` field marking it as a desktop peer. An older host ignores it and treats the joiner as a phone; the joiner then sees no `peer.*` support and reports *"update Termpolis on the other machine"*.
- **Explicit confirmation required.** The host does not serve any `peer.*` request from a joiner until the user has confirmed the safety words on the host. The joiner does not serve requests from the host until it has confirmed on its own side.

### 4.4 Authorization

- **Grants are per linked machine and per direction.** Each side stores and enforces what the *other* machine may do here. Grants are `run` (read-only agents) and `write` (agents may edit files and run commands); `write` implies `run`.
- **Enforcement happens on the executing side**, in main's `linkedJobs` (the bridge is transport, §5), before any agent is spawned.
- **Enforcement holds for running jobs too.** Grants were first checked only when a job started, and the end-to-end test found a job running on after its grant was withdrawn or its machine was unlinked. Now:
  - withdrawing `write` cancels that machine's running write jobs;
  - withdrawing `run` cancels all of that machine's jobs;
  - unlinking, from either side, cancels everything the unlinked machine has running here.
- **Unlink** removes the pairing and its keys on this side and sends a best-effort goodbye so the other side removes its record too.
- **The existing phone capabilities** (`writeToTerminal`, `runCommand`, `launchAgent`, …) are **never** served to a desktop peer. A desktop peer's request kinds are the `peer.*` set only.

### 4.5 Execution confinement

Delegated jobs run through the existing headless executor with these extra rules:

1. **Termpolis MCP is off inside delegated jobs.**
   - Claude: `--strict-mcp-config` in both modes.
   - Codex: `-c mcp_servers.termpolis.enabled=false -c mcp_servers.termpolis.command=termpolis-mcp-disabled`. Both were verified against codex-cli 0.153.4.
     - The first override disables the server.
     - The second keeps Codex starting on a machine whose `config.toml` has no termpolis entry, where `enabled=false` alone fails with "invalid transport".
     - A hand-written `url` entry for termpolis cannot hold a command. Termpolis never writes one, but where one exists Codex refuses to start, and the run fails closed.
   - Gemini (`agy`): there is no per-run flag. Rule 2 covers it.
   - **The executing machine's memory primer is still included.** It gives the agent that machine's project context. This stays within what the `run` grant already allows, since the agent may read any file the user can read (§4.1).
2. **No nested delegation.** A delegated job is spawned with `TERMPOLIS_LINKED_JOB=<jobId>` in its environment. When the stdio adapter sees that variable, it answers any `linked_machines` call locally with an error and never forwards it. This is defense in depth for agents whose MCP cannot be switched off per run.
3. **Read-only by default.** `write` needs the `write` grant. Read-only keeps the exec shapes that already exist: Claude in plan mode with Read/Grep/Glob only, Codex with `--sandbox read-only`, `agy --mode plan`.
4. **Working folder.** `cwd` must be an existing directory on the executing machine, and defaults to the user's home. `~` and `~/…` are expanded, and the result must be absolute. A network (UNC) path is refused before it is touched: on Windows, opening `\\host\share` hands that host the user's NTLM hash. The folder is threaded into the spawn (this fixes the audit's exec-cwd bug for every caller). Codex also gets `-C <cwd>`.
5. **Limits.**
   - The prompt is capped at 20,000 characters. That leaves room for the framing line and the memory primer inside the Windows command-line limit of 32,767.
   - `peerRun.timeoutMs` is clamped to 10 s – 60 min and defaults to 15 min. The v1 `linked_machines` tool does not expose it, so every delegated job runs for at most 15 min.
   - At most 2 concurrent inbound jobs per linked machine and 4 in total; anything beyond that gets `busy`.
   - These executor-side caps are what bound the load on each machine.
     - An outbound cap was dropped. The requester only knows a job's last-seen status, so a job an agent never collected would block new runs forever.
     - Each tool call also polls at most 8 times.
6. **Prompt framing.** The delegated agent's prompt starts with one line naming the requesting machine, the folder, and the instruction that its final message is returned to that machine's agent.
7. **Output cap.** The executing side keeps the output's tail within 200,000 characters and within 600,002 bytes as a JSON string.
   - The byte cap was added after the end-to-end test showed the character cap was not enough. A control character is six bytes in JSON (`\u0001`), so 200,000 of them made a 1.2 MB answer.
   - The bridge refused to send that answer, and every poll lost the finished job.
8. **Result inspection.** Before an output reaches the calling agent, it goes through `mcpGateway/guard` injection inspection, up to 210,000 characters. So does any error or refusal the other machine worded. Flagged text is wrapped in the existing UNTRUSTED/DATA banner.
9. **Kept awake while it runs.** While at least one inbound job is running, the executing machine holds one `powerSaveBlocker.start('prevent-app-suspension')`: no idle sleep, no App Nap, the display may still sleep. A machine that sleeps drops off the relay, and the job's answer with it. `linkedHost` tells its binding's `keepAwake(on)` on the 0→1 and 1→0 transitions of inbound jobs, whether a job finishes, fails or is cancelled, and `stopLinkedHost` releases it. Outbound jobs run elsewhere and hold nothing.

### 4.6 Accepted risk — the `write` grant

The `write` grant means *"an agent on that machine may start an autonomous, permission-bypassed agent here"*. That is equivalent to running `termpolis-cli exec --write` locally. It is useful because it is exactly what David asked for ("Codex on linux implements"), so it cannot be blocked. Mitigation follows the Remote §4.5 pattern:

- the grant is off by default;
- it is granted per machine, with the risk stated where it is granted;
- it is revocable at any time, and revoking it cancels a write job that is already running;
- every job appears in the activity view on both machines.

---

## 5. Architecture

```
 Machine A (asks)                                        Machine B (does the work)
 ┌──────────────────────────────────────┐                ┌──────────────────────────────────────┐
 │ Claude ─MCP─► main: linked_machines   │                │ main: linkedJobs ─► runHeadless       │
 │               tool (linkedTool.ts)    │                │       (codex exec / claude -p / agy)  │
 │                 │ linkCall            │                │                 ▲ peerRequest         │
 │                 ▼                     │                │                 │                     │
 │ utilityProcess: remote bridge         │  sealed WSS    │ utilityProcess: remote bridge         │
 │   RelayClient room (role desktop      │◄═══ relay ════►│   RelayClient room (role device       │
 │   or device) — request()/onRequest    │                │   or desktop) — request()/onRequest   │
 └──────────────────────────────────────┘                └──────────────────────────────────────┘
```

- **One link = one sealed relay session that carries requests in both directions.**
  - The machine that created the code hosts the link. On the host, the other machine is a `PairedDevice` with `kind: 'desktop'`, in the room the host already opens for every device.
  - The machine that entered the code joins the link. It holds a per-link X25519 keypair and dials the same room as `?role=device`.
  - Each side's `RelayClient` both answers requests (`onRequest`) and sends them (`request()`). Envelope ids are per direction, so they never collide.
- **The bridge is transport; main is policy.**
  - The bridge checks only that a `peer*` request came from a desktop peer. It forwards the request to main and returns main's answer.
  - Main holds names, grants and confirmation, runs the jobs, and keeps the activity log.
  - A compromised bridge already holds the MCP bearer token, so the new main↔bridge messages add no authority it did not have.
- **The bridge runs when Remote *or* Linked machines is enabled.** `init` tells it which kinds of rooms to open (`phones`, `linked`), so enabling one never exposes the other.
- **Delegated jobs** go through the existing `runHeadless` with the confinement rules in §4.5. A delegated run's output is **not** written to the executing machine's memory brain (no `remember`): text from another machine must not become future primer context.
- **Lifetime: until the app quits.** The MCP server, the bridge (`remoteHost`) and `linkedHost` start once per run, and nothing starts them again. On macOS, closing the last window leaves the app running in the Dock and `activate` only makes a new window, so `window-all-closed` leaves all three running there; elsewhere it quits. `before-quit` stops them on every platform, and every quit (⌘Q, the Dock, an update restart, Playwright's `app.close()`) goes through `app.quit()`, which emits it. Only a quit takes a machine offline.

---

## 6. Wire additions (all additive on `PROTOCOL_VERSION` 2)

### 6.1 Link code

The link code is `termpolis-link:` + base64url(JSON), where the JSON is the existing offer payload `{v:1, relayUrl, pairingId, desktopPublicKey, oneTimeSecret}`.
- The prefix stops the phone's QR parser from ever accepting a link code.
- Link offers live **5 minutes**, not 90 s, because the code has to be carried between two computers.
- The joiner validates the code exactly as `mobile/src/wire/qr.ts` does: hex shapes, `v === 1`, and `wss:`.
  - There is one exception: `ws:` is accepted when the host is `127.0.0.1` or `localhost`, for tests and a relay run locally.
  - The host refuses to make a code at all over a relay a joiner would refuse.

### 6.2 Pairing hello

`PAIRING_HELLO` gains an optional `peer: 'desktop'` in its sealed JSON. The host enforces it both ways:
- A **link** offer accepts only `peer === 'desktop'`.
- A **phone** offer refuses `peer === 'desktop'`.

Either refusal shows an error on the host and leaves the offer unspent. The marker is checked before the one-time secret, so the right machine can still finish. A link offer also refuses a hello once the host holds 16 links.

The joiner gets no answer and gives up after 60 s with *No answer. Check the code is still showing under Settings ▸ Linked machines on the other computer.*

`PAIRING_ACK` is unchanged. Its optional `name` carries the host's machine name.

### 6.3 Peer request kinds

These go inside sealed session frames, in the existing `{id, request}` / `{kind:'ok'|'error', id, …}` envelopes.

```ts
type PeerRequest =
  | { kind: 'peerHello' }
  | { kind: 'peerRun'; agent: 'claude' | 'codex' | 'gemini'; prompt: string; cwd?: string;
      write?: boolean; model?: string; timeoutMs?: number }
  | { kind: 'peerResult'; jobId: string; waitMs?: number }   // long-poll, waitMs ≤ 50_000
  | { kind: 'peerCancel'; jobId: string }
  | { kind: 'peerBye' }                                       // "I unlinked you"

interface PeerHelloInfo {                                     // data of peerHello
  name: string                                                // the answering machine's own name
  agents: { claude: boolean; codex: boolean; gemini: boolean }
  grants: { run: boolean; write: boolean }                    // what the CALLER may do there
  confirmed: boolean
  version: string                                             // app version
}

interface PeerJobView {                                       // data of peerRun / peerResult / peerCancel
  jobId: string                                               // 12 hex, minted by the executor
  agent: 'claude' | 'codex' | 'gemini'
  status: 'running' | 'done' | 'failed' | 'cancelled'
  output?: string                                             // ≤ 200_000 chars; the TAIL is kept on truncation
  truncated?: boolean
  error?: string
  startedAt: number
  durationMs?: number
}
```

Handling rules:
- `peer*` kinds are **not** in `requiredCapability`, so they fail closed for phones even if the interception below is lost.
- `handleRemoteRequest` routes a request from a `device.kind === 'desktop'` peer before every phone branch. Such a peer is served the `peer*` kinds and nothing else, not even `getCapabilities` or `unpair`. From a phone, a `peer*` kind gets the standard `remote device sent an unrecognised request kind` refusal.
- `peerBye` is handled inside the bridge, and it is answered before it is acted on. It revokes the sender (host side) or closes the link (joiner side). The other kinds are forwarded to main.
- Requests flow in both directions on one session. Each end numbers its own requests, and an `ok`/`error` envelope settles the call with that id in the receiving end's own pending map.
- Responses stay below the relay's 1 MiB frame cap because output is capped at 200,000 chars **and** 600,002 bytes as a JSON string (§4.5). A response that still would not fit is replaced by a `response too large for the relay` error.

---

## 7. Data and storage

| Where | File | Contents |
|---|---|---|
| main | `linked-settings.json` | `{ enabled: boolean }`, default `false` |
| main | `linked-machines` (via `secureKeyStore`: `osk:v1:` when a keyring exists, otherwise honest plaintext) | `{ v: 1, links: JoinedLink[], meta: LinkMeta[] }` |
| bridge registry → main | `remote-devices.json` (existing) | the host's side of each link, as a `PairedDevice` with `kind: 'desktop'` (the field is kept by the loader) |

```ts
interface JoinedLink { id: string /* deviceId the host assigned = sha256(linkPk)[:16] */;
  hostPublicKey: string; relayUrl: string; sessionRoomId: string; secretKey: string; linkedAt: number }
interface LinkMeta { ref: string /* 'device:<id>' | 'link:<id>' */; name: string;
  grants: { run: boolean; write: boolean }; confirmed: boolean; linkedAt: number;
  phrase?: string /* kept only while unconfirmed */ }
```

- Names are unique across all links, case-insensitively. Duplicates are numbered `name (2)`, as on the phone.
- At most 16 links per install, counting hosted and joined together.
- Desktop peers are exempt from the 30-day idle expiry, which counts only inbound requests. A link is a deliberate machine relationship that the user ends by unlinking.
- The jobs and activity log live in memory only: up to 100 finished jobs, kept for 2 h. The activity view shows the latest 20.

---

## 8. Agent tool

```ts
{ name: 'linked_machines',
  description: '<≤ the remaining tool-description budget>',
  inputSchema: { action: 'list'|'run'|'result', machine?, agent?, prompt?, cwd?, write?, model?, jobId?, waitSec? } }
```

- **`list`** reads the directory. It asks `peerHello` (8 s timeout, in parallel) of each machine that is online and confirmed here, and returns `{ machines: [{ name, online, confirmed, agents, canRun, canWrite, note? }], thisMachine }`. Fields it could not learn are `null`, and `note` says why.
- **`run`**:
  1. Resolves the machine name. If no machine matches, the error lists the valid names.
  2. Requires the link to be confirmed here and online, and fails fast otherwise. An offline machine gets *"linux" is offline — Termpolis must be running there.*; an unconfirmed one gets its own message.
  3. Sends `peerRun` (20 s timeout).
  4. Long-polls `peerResult` until the job finishes or `waitSec` runs out (default 45, max 50). Each poll lasts at most 25 s, and a call makes at most 8 polls.
  5. Losing touch mid-poll is not a failure. The job's last known status comes back with a note to check again with `result`.
- **`result`** does the same long-poll for an existing `jobId`.
- **The agent-facing `jobId`** is `<linkRefId>-<remoteJobId>`. It is self-describing, so `result` still works after a rename or a local restart, as long as the executor still holds the job.
- **Output from another machine is untrusted.** It goes through `mcpGateway/guard`'s inspection, and a flagged result arrives under the existing UNTRUSTED/DATA banner.
- **Headroom.** The tool is added to Headroom's `EXEMPT_TOOLS`, so the answer is never truncated into a `retrieve_full` token that is valid only on this machine.
- **Approval.** It is classed **ASK** for Claude Code: the user approves it once in their agent. It is not auto-approved for Codex.
- **Rate limit.** 30 calls a minute.
- **Nested delegation.** The stdio adapter answers `linked_machines` locally with an error when `TERMPOLIS_LINKED_JOB` is set in its environment.

---

## 9. Testing

- **Unit.** Every new module is tested against the coverage gate: link code, `RelayClient` request/response, bridge peer routing, stores, directory, jobs, tool and IPC.
- **Two-core harness.** Two `createBridgeCore`s are joined through an in-memory relay that implements seats, `hello`/`peer-joined`/`peer-gone`, 409, and binary forwarding. It covers: link pairing, safety words matching on both sides, requests in both directions, `peerBye`, and offline errors.
- **End to end in-process** (`tests/electron/linkedEndToEnd.test.ts`).
  - Two complete desktops run in one process, each with the real bridge core, remote host and linked host, joined by the in-memory relay. Each is driven only through the Settings IPC and the `linked_machines` tool.
  - The agent is a fake `runHeadless`. One case uses the real `runHeadless` over a fake `deliver`, to pin the argv and spawn options.
  - It covers pairing and confirmation, delegation both ways and at once, the long-poll, grants and their withdrawal mid-job, unconfirmed and offline refusals, the busy cap, the injection banner, oversized output, restarts, and unlink from either side.
  - It found the two gaps fixed in §4.4 and §4.5.
- **Real CLI flags.** `--strict-mcp-config` for Claude write runs. For Codex, both `-c` overrides (`mcp_servers.termpolis.enabled=false` and `mcp_servers.termpolis.command=termpolis-mcp-disabled`) and `-C`. Each is asserted in its argv test, and the Codex overrides are verified against codex-cli 0.153.4.
- **E2E (Playwright).** Settings ▸ Linked machines opens; enabling it starts the bridge; creating a code shows a `termpolis-link:` code with a countdown. Disabling it is the teardown.

---

## 10. Follow-ups (not v1)

- Conversation continuity across runs (`codex exec resume`, `claude --resume`).
- A store-and-forward outbox for offline machines.
- An optional self-hosted or LAN relay recipe.
- A "linked machines" title-bar pill.
- Making read-only `termpolis-cli exec` drop Termpolis MCP for every caller, not only linked jobs.
