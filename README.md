<p align="center">
  <img src="assets/logo-termpolis.png" alt="Termpolis Logo" width="200">
</p>

<h1 align="center">Termpolis</h1>

<p align="center">
  <strong>Stop re-explaining your codebase to AI.</strong>
</p>

<p align="center">
  Claude, Codex and Gemini share <strong>one local memory that learns as you work</strong> —<br>
  so every agent already knows your project, your decisions, and what got figured out yesterday.<br>
  <strong>Local by default. No cloud account. No telemetry unless you opt in.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/🧠_One_shared_memory-across_all_3_agents-6E56CF?style=for-the-badge" alt="One shared memory across all three agents">
  <img src="https://img.shields.io/badge/🌱_Learns_every_session-never_re--explain-1f6e3a?style=for-the-badge" alt="Learns from every session">
  <img src="https://img.shields.io/badge/🔀_Second_Opinion-agents_review_each_other-b07407?style=for-the-badge" alt="Second Opinion — agents review each other">
  <img src="https://img.shields.io/badge/🔒_Local_by_default-no_cloud_account,_opt--in_telemetry_only-0078d4?style=for-the-badge" alt="Local by default, no cloud account, opt-in telemetry only">
</p>

<p align="center">
  <a href="https://github.com/codedev-david/termpolis/releases/latest"><img src="https://img.shields.io/badge/%E2%AC%87%20Download-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-1976D2?style=for-the-badge" alt="Download for Windows, macOS, Linux"></a>
  &nbsp;
  <a href="https://termpolis.com"><img src="https://img.shields.io/badge/%F0%9F%8C%90%20termpolis.com-How%20it%20works-0078d4?style=for-the-badge" alt="termpolis.com"></a>
  &nbsp;
  <a href="https://github.com/codedev-david/termpolis/issues/new?template=bug_report.md"><img src="https://img.shields.io/badge/%F0%9F%90%9B%20Report%20a%20bug-e53935?style=for-the-badge" alt="Report a bug"></a>
</p>

<p align="center">
  <sub>🙏 <strong>Free &amp; open source.</strong> Found a bug? Open an issue — we read every one.</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="Apache 2.0 License">
  <img src="https://img.shields.io/badge/Windows-Code%20Signed-0078D4?logo=windows&logoColor=white" alt="Windows Code Signed">
  <img src="https://img.shields.io/badge/macOS-Notarized-000000?logo=apple&logoColor=white" alt="macOS Notarized">
  <a href="https://github.com/sponsors/codedev-david"><img src="https://img.shields.io/badge/sponsor-GitHub%20Sponsors-ea4aaa.svg" alt="Sponsor"></a>
</p>

---

## 🧠 Meet Mneme — one memory, every agent, that learns as you work

Every AI session normally starts cold — you re-explain the task and burn 20–50K tokens reloading context. **Mneme** (named for the Greek muse of memory) is the local brain at the heart of Termpolis: **one shared memory** that Claude, Codex and Gemini all read and write, that **remembers across sessions and learns from each one**, so you stop repeating yourself. (Since v1.51, Gemini through the Antigravity CLI, `agy`, which Termpolis now connects to its MCP server.)

- **One memory, three agents.** Claude, Codex and Gemini all read and write the same store over the built-in MCP server. A fact one agent figures out is instantly recalled by the others — no copy-paste, no re-discovery.
- **It learns from every session.** When an agent finishes a chunk of work, Termpolis quietly distills the lesson — the fix, the decision, the gotcha — plus its own track record into the brain, so the fleet gets smarter the more you use it. Automatic for Claude and Codex (from their session transcripts).
- **Every new agent starts warm.** Open a fresh Claude or Codex terminal and it already knows your project — the relevant memory loads at launch, behind the scenes, no wall of text.
- **Local & private.** Embeddings run locally (bundled `bge-small-en-v1.5`, WASM) — no server, no telemetry; the memory never leaves your machine. The local store is encrypted at rest (AES-256-GCM) by default whenever the OS keychain is available (DPAPI on Windows, Keychain on macOS, libsecret/KWallet on Linux): each device gets a random key, which is itself stored encrypted by the OS. With no keychain (for example a Linux box without a keyring) the memory stays plaintext rather than sitting next to an unprotected key. One exception today: aged memories that idle consolidation moves to the cold archive (`swarm-memory.archive.jsonl`) are written there in plain text. Each computer keeps its own memory.
- **Built to trust.** Content-addressed dedup (never stores the same thing twice), millisecond HNSW retrieval at scale, staleness-guarded recall, and an observable `🧠 Loaded N memories` banner so you always know it fired.

> **Proven, not just claimed.** A CI gate has one agent write a decision and a *different* agent recall it from a keyword-free paraphrase over the real MCP wire; semantic recall scores **0.97+** similarity on paraphrases. Backed by **7,000+ tests** (97.5% statements / 98.5% lines).

**The result: stop re-explaining context every session — and stop paying to reload it.**

---

### 🆚 Why not just use Claude Code or Codex on their own?

Termpolis **runs those exact CLIs, unchanged** — and fixes the one thing they can't do alone: remember.

| What you get | Claude Code / Codex on their own | The same agent inside Termpolis |
| --- | --- | --- |
| **Long-term memory** | Starts cold every launch; you re-explain and re-pay tokens to reload context | **Mneme** — a local brain holding months of context, surviving restarts, recalled in ms |
| **Shared across tools** | Siloed — Codex can't see what Claude just figured out | Claude, Codex and Gemini read/write **one memory**; a fact one learns, the others recall |
| **It learns** | No learning — every session is a blank slate | Distills a lesson from every finished task + tracks its own competence |
| **Every new session** | Re-explain your codebase from scratch | Opens already knowing the project; one-click cross-agent handoff, no re-explaining |
| **Your data & lock-in** | One vendor's account + cloud; telemetry varies | Local by default, Apache-2.0, no account/backend; prompts to Claude Code, Codex and Gemini scanned for secrets |

**Same agents, same accounts you already pay for** — Termpolis is the workspace around them that remembers and learns.

---

### 🛡 AI Security Center — what it actually does

**Honest framing first.** Any tool that lets you talk to a hosted model (Claude, Codex, Gemini) is, by definition, sending your prompt to that provider. Termpolis cannot air-gap a prompt you choose to send, cannot guarantee a provider's stated retention policy is enforced server-side, and cannot stop a provider from later changing their terms. If your threat model requires those guarantees, run a local model — but accept the quality + hardware trade-off that comes with it.

What Termpolis **can** do is make the hosted path *substantially* safer than typing into a stock terminal, a browser, or a VS Code plug-in:

| Risk | What Termpolis does | Limit |
| --- | --- | --- |
| Secret leaves the machine in a prompt | **Always-on prompt watch (v1.25.2)** — no toggle, cannot be switched off. Every Enter / paste in an AI terminal is scanned against **97 rules**: token shapes (AWS, GitHub PATs, Stripe, GCP, JWTs, PEM keys), **named assignments** in `.env` / `appsettings.json` / YAML / connection strings / URLs-with-credentials, and a contextual rule that catches the most human leak of all — *"here is the api key for this code, add it to line 42: 8f3a9b2c…"*. Your text is **forwarded untouched** — nothing is withheld, nothing is rewritten. A hit is **recorded**, naming **what** leaked (`DB_PASSWORD`) so you know what to rotate. | **It records; it does not prevent — and we no longer pretend otherwise.** By the time you press Enter the agent's TUI already holds the text; nothing can un-send it. (The old "redaction" toggle claimed it could. It couldn't, and it was broken: it withheld keystrokes and never wrote them back, so typing `hello⏎` delivered only `\r`. It is deleted.) Prevention lives at the two boundaries where it is genuinely possible: the **git shield** and the **memory scrub**. **The secret's value is never written to the log** — names and rule ids only. A shapeless secret pasted with no surrounding words remains undetectable. |
| Secret gets **committed**, then **pushed to a remote** | **Commit/Push Secret Shield (v1.25)** — the same 97-rule engine now also runs at the **git boundary**. Commit through Termpolis (the built-in Git panel, or Swarm Review's commit) and it scans the **staged diff** — exactly what `git commit` is about to capture. Push through Termpolis and it scans the **full patch of every commit not yet on any remote** — exactly what `git push` is about to send. A hit **blocks the operation** and names the rule that fired. The outbound scanner only ever saw text typed *at* an agent; it structurally never saw git, so a leaked key could still land in history and reach a remote. On by default. | Out of the box it gates the git operations you run **through Termpolis**. To cover a `git commit` typed straight into a terminal — or run from an IDE, a script, anything — install the **`pre-commit` / `pre-push` hooks**: *Settings → AI Security → Protect a repository*. They shell out to a **standalone scanner** carrying its own copy of the rule table, so they keep working **even with Termpolis closed** (a hook that only guards you while the app is running would silently stop guarding you the moment you quit — worse than no hook, because you'd still believe you had one). An existing hook (husky, lint-staged) is **chained, never overwritten**, and its exit code still gates the commit. The hook **fails open**: if Node or the scanner is missing, git is never blocked. `--no-verify` bypasses any git hook — this is a strong net, not a cage. Regex-shaped secrets only, as above. |
| Secret gets *remembered* — persisted into the shared brain | **Memory-at-rest scrub (v1.25)** — secrets are redacted **before** a memory is hashed, embedded, or written to disk, so a key sitting in a transcript or an indexed source file never lands in the brain and can never be recalled back into an agent's context later. On by default. | Applies at **write time** — it redacts what's being stored now, not what a pre-v1.25 store already holds. Regex-shaped secrets only. |
| Whole `.env` or source file pasted | **Code-chunk + env-dump detectors (v1.11.52)** flag prompts >2 KB that look like code (indentation + braces + keywords) or contain 5+ `KEY=value` lines. The renderer surfaces a notice + audit entry. | Heuristic — false negatives possible on minified or unusual code shapes. The prompt is not blocked; you decide. |
| Free-tier Gemini sending prompts to Google for product improvement | **Gemini account-mode auto-detection** reads `GEMINI_API_KEY` / `GOOGLE_GENAI_USE_GCA` / `GOOGLE_APPLICATION_CREDENTIALS`+`GOOGLE_CLOUD_PROJECT` to classify the active session. **Strict Mode** intercepts `gemini` launches that look free-tier and refuses to forward them. Blocked launches are audited. | Detection is env-var based; if you ship credentials some other way the heuristic can't see, it can't classify them. |
| Provider quietly changes their ToS / data-controls page | **Weekly ToS drift watcher (v1.11.52)** GitHub Action fetches the three provider pages we cite (Anthropic, OpenAI, Google), normalizes the HTML, hashes it, and opens a tracking issue when the hash changes — so the docs in *this* repo stay aligned with what the providers actually publish. | Detects rendered-text changes, not legal intent. A human still reads the diff. |
| Agent silently talking to an unexpected endpoint | **Egress audit (v1.11.52)** polls `netstat` (Windows) / `ss` (Linux) / `lsof` (macOS) once a minute for the AI agent's PID and records each unique remote `host:port` to the audit log + Security panel. **As of v1.25 that record is a *policy*: Egress Guard** judges every observed endpoint against a published allowlist of AI-provider domains and raises anything else as a **violation** in the audit trail. Suffix matching is **dot-anchored** (an exact host, or a true dot-delimited subdomain of one), so `evil-anthropic.com` and `anthropic.com.evil.net` do **not** pass as Anthropic. Loopback and LAN addresses are never violations — a local model server is not exfiltration. On by default. | Polling, not packet capture — sub-minute bursts can be missed. No payload inspection. **It flags; it never kills a connection.** The poller only yields IP literals, so the allowlist is forward-resolved — when DNS is unavailable the guard stays silent rather than reporting every provider IP as exfiltration. |
| A third-party **skill / plugin / MCP server** you import | **Safe Import (v1.25)** — a skill, plugin, slash-command, subagent, or MCP server is not data: it's *code* plus *instruction text* handed to an agent that already holds your credentials, your repo, and a live PTY. Termpolis statically scans it **before it touches your machine** — **41 rules** across outbound network calls, shell / `eval` execution, credential + `~/.ssh` access, obfuscated payloads, and **prompt injection hidden in the artifact's own instructions** (tool poisoning — no dangerous API call appears anywhere; the *agent* is the exploit), plus context-sensitive checks that judge a construct by what surrounds it: a base64 decode feeding an execution sink is red, a decode on its own is yellow. You get a red / yellow / green report with `file:line` and the offending line. **Red can never be installed** — the refusal is enforced in the main process, not the UI. Approvals are **hash-pinned**, so editing an approved artifact re-prompts (no trust-on-first-use-then-swap). Zip-slip and TOML injection are refused by the installer. | **A static review aid, not a sandbox** — nothing is executed, in a jail or otherwise. It is line-based, and a determined attacker can obfuscate past any of it. Its job is to put the three lines that matter in front of you *before* you click Import — not to prove the artifact is safe. |
| Tampering surface beyond the terminal itself | No browser extension, no IDE plug-in, no ad-hoc cloud sync. The MCP server is bound to `127.0.0.1` with a token that rotates on every restart. No Termpolis telemetry unless you opt in, no Termpolis cloud accounts. | Termpolis is itself an Electron app — same caveats apply as any local desktop process running with your privileges. |
| Forensic record of what was typed at agents | **Local JSONL audit log**: every AI terminal open/close, **every secret observed leaving in a prompt** (`prompt_secret_sent` — names and rule ids only, never values), every code-chunk / env-dump detection, every Strict-Mode block — plus, as of v1.25, every blocked commit/push, every import scan and refusal, and every egress violation. 10 MB rotated, append-only, on disk only, wipeable. **On by default as of v1.25** (it previously defaulted to off, so for most installs it never existed). | Local. We don't ship it anywhere. If your machine is compromised, so is the log. |

**v1.25 moved the perimeter to the boundaries that actually leak.** The secret engine used to watch exactly one of them — the keystrokes you send to an agent. It now also gates what a commit made through Termpolis captures, what a push made through Termpolis sends, and what gets written into the shared brain; an imported skill or MCP server is scanned before it is wired into an agent; and agent egress is *judged* against an allowlist rather than merely logged. Those gates — and the audit log — **default to on**, and an absent setting key keeps the secure default, so an existing install is protected on upgrade without touching Settings. Each can be turned off individually in **Settings → AI Security**; **Safe Import** lives in **Settings → General**.

**v1.25.6 — three controls that were quietly not firing.** Every one was found by writing a test against code nobody had tested. If you are on **1.25.5 or earlier, this is what was silently not protecting you**:

- **The GnuPG private-keyring rule could never fire.** `secring.gpg` — your *private* keyring — had been grouped into the sensitive-file rule's own **exclusion** list beside the *public* keyrings, so the exclusion returned before the match could. **A read of your private keyring was never flagged**, and the failure mode was total silence, which reads exactly like "nothing happened". Only the `pubring.*` entries are excluded now.
- **A `NaN` limit defeated the audit-log clamp and returned the entire log.** `typeof NaN === 'number'` is true, so a NaN limit took the clamp arm rather than the 200 default — and `Math.min`/`Math.max` **propagate** NaN rather than clamping it, so the read degraded to "return everything", which is the one thing the 2,000-entry cap exists to prevent. The guard is `Number.isFinite` now.
- **The Commit Shield reported repositories as PROTECTED after their hooks were removed.** The protected-repo list was compared with a bare `!==`, and install stores either the renderer's cwd (forward slashes) or the native picker's OS-native path (backslashes) — so install-by-picker followed by uninstall-by-cwd never matched, and the repo stayed on the list with its hooks already gone. **A security control that claims to be armed when it is not is worse than one that admits it is off.** It is keyed on a canonical path now (Windows-only separator/case folding — a backslash is a legal filename character on POSIX, and folding it there would conflate two genuinely different repos).

Also fixed: **the Strict-Mode Gemini refusal message never rendered on Windows.** The banner was written to the PTY as a typed `printf` command, which only works on a shell that *has* `printf` — so on cmd.exe / PowerShell you got `'printf' is not recognized` instead of the explanation, at the exact moment you most needed to know why the launch was refused. **The block always worked; the message was what failed.** It now goes straight to the renderer.

**What this is and isn't:** Termpolis is *defense in depth* for the hosted-model path — it raises the cost of accidental disclosure and gives you a record to audit. It is **not** a guarantee that source code cannot reach a provider — only not running the agent at all gives you that. The honest answer to *"can a hosted model leak my code?"* is "yes, if you send it; the question is whether the controls catch the obvious accidents and whether you trust the provider's terms for the rest." Termpolis is built for the engineers who've decided that trade-off is acceptable for the productivity hosted models give them.

See [`PRIVACY.md`](PRIVACY.md) for the data-flow spec, [`TERMS.md`](TERMS.md) for the Apache-2.0 / "AS IS" disclaimer.

### 🧠 Shared memory — the deep dive

The moat above in full — every capability of the brain that all three agents share:

- **The memory tools.** Every agent reaches the store over the built-in MCP server (`memory_search` / `memory_write` / `memory_list` / `memory_primer`). Claude and Codex sessions are learned from automatically; Gemini (`agy`) keeps its sessions where Termpolis can't read them, so it is asked at launch to record its own lessons with `memory_write`.
- **It survives quitting the app.** Stored as JSONL (`swarm-memory.jsonl`, one entry per line, each line encrypted when the OS keychain is available) in Termpolis's per-user app-data folder — `%APPDATA%\termpolis\` on Windows, `~/Library/Application Support/termpolis/` on macOS, `~/.config/termpolis/` on Linux — and reloaded with its embeddings at startup. Because it lives in your user profile (not the install folder), it survives app updates and even an uninstall/reinstall — close Termpolis, reopen it tomorrow, the context is still there.
- **Each computer keeps its own memory.** The Memory panel's **Sync across machines** setting (a shared synced folder) doesn't work reliably in current versions: Termpolis forgets the chosen folder when it restarts, and turning it on for a store that is already encrypted can conflict with that store's key. Leave it off. To use what another of your computers knows, link the two with [Linked machines](#-linked-machines--let-an-agent-hand-work-to-your-other-computer): an agent there starts with a digest of that machine's memory and works on its files.
- **It feeds itself.** A background indexer ingests your past Claude and Codex transcripts (and older Gemini CLI ones) automatically (10 s after launch, then every 30 min). Idempotent (content-hash dedup), so it only ever embeds genuinely new content — no action required from you.
- **Fully offline, no server, no secrets.** Embeddings run in-process via WASM with a bundled `bge-small-en-v1.5` model — **no Ollama, no native binaries, nothing leaves your machine.** The indexer reuses the same sensitive-file denylist as the read watcher, so `.env` files, keys, and cloud credentials are never embedded.
- **Scales into six figures.** Vectors are packed into a typed-array store (about half the RAM of boxed arrays), and past tens of thousands of entries an **HNSW** approximate-nearest-neighbour index engages automatically so search stays sub-linear (a few ms/query, measured). The graph lives *off* the JS heap and persists to disk. It builds once, lazily, in the background **without blocking your searches** — the first query after the store crosses the threshold returns instantly from the exact fallback while the index builds (frame-budgeted so the UI never stalls); every later search and launch uses the saved graph.
- **Auto-recovers from compaction.** When Claude Code compacts its conversation to fit the context window, it summarizes detail away — but that detail still lives in the brain. Termpolis watches the terminal, waits for the compaction to settle (debounced through the whole thing), and **re-adds a one-line memory pointer** to the agent's input — *ready to send, never auto-submitted* — so the agent reloads what it lost **behind the scenes** over MCP (`memory_primer`) instead of a wall of pasted text. Cooldown-guarded to fire once per compaction; opt-out in Settings. Your durable memory is the large working set; the model's window only holds the active task.
- **See compaction coming.** A live **context-pressure pill** in the status bar shows how full the focused agent's window is — *healthy → filling up → nearly full → compaction imminent* — from real token counts when the agent reports them (Claude's `token_update` stream) or a clearly-labeled heuristic otherwise. So you watch the pressure build and know recovery is handled, instead of being surprised by a compaction.
- **You can see it working — and trust what it returns (v1.16.7).** Memory used to load invisibly, so a successful recall looked identical to no recall at all. Now every primed launch shows a banner — `🧠 Loaded N memories for "<project>"` on success, or a clear `⚠️ Memory recall unavailable` if the brain couldn't be reached — so you always know whether context loaded. Four reliability fixes back it up: a **fast indexer tier** makes your *current* conversation searchable within seconds instead of waiting for the next 30-minute pass; recall **flags any code reference whose file has since been deleted** as `⚠ STALE — verify before use` instead of asserting it as fact; the memory hook **resolves an absolute Node path** so it still fires under thin-PATH login shells (NVM and friends); and an **adaptive relevance floor** keeps weak, off-topic hits out of the digest entirely — the agent gets the relevant slice, never padding.

**How it works:**

1. **Capture** — your on-disk AI transcripts are parsed (tool-call / reasoning / system-prompt noise stripped) and split into chunks.
2. **Embed** — each chunk becomes a 384-dim vector locally, in-process, via `onnxruntime-web` (WASM).
3. **Store** — chunks + vectors persist in a durable on-disk log, deduplicated by content hash so re-indexing is cheap; vectors are packed into a typed-array store and indexed with HNSW once the brain grows large.
4. **Recall** — any agent calls `memory_search` over MCP and gets the most relevant past context back, blending semantic vector search with keyword matching.

The result: stop re-explaining context every session, and stop paying to reload it.

**Controls** — open the **Memory panel** (`Ctrl+Shift+M`, or the Command Palette → "Memory") to see what's remembered (chunk count), search it, feed it on demand ("Index past conversations" / "Index this repo's code"), and **inject the most relevant context into the active agent** with one click. Launched agents are also auto-primed with the project's relevant context (toggle in Settings): a **one-line note** in the agent's input points it at the `memory_primer` MCP tool, so the digest loads **behind the scenes** — no giant dump on the terminal — and the agent **holds it as background** instead of acting on it or resuming old work uninvited. Context from the **current directory's project comes first** (its past conversations, then its code/notes), and anything recalled from other projects is clearly labeled as possibly not applying.

> **The digest reserves slots for what happened *most recently* (v1.33.0).** Relevance ranking answers "what is most similar to this query"; a session-start digest also has to answer "where did we leave off", and only a time-ordered read can. Recency used to be a *nudge* inside the score — with a 30-day half-life and a 0.25 weight, an hour-old memory outranked a 22-day-old one by under 9%, which semantic similarity routinely swamped. The result was a primer for an active repo that carried five-day and three-week-old items and skipped that same morning's work entirely. Now up to **3 of the digest's slots are filled newest-first**, scoped to the same repo, deduped against whatever relevance already picked — spent from the **same** budget, so the digest gets fresher, not bigger. The ranking weights themselves are untouched, so global recall is unchanged.

---

### 🕸 The Weave — one fabric across memory, code, and every repo (v1.23)

**v1.23 "The Weave"** turns the shared brain and the code graph into a single, self-weaving fabric. Recall no longer stops at *text* — it points at the *code* a lesson is about — and the non-obvious connections across your whole workspace are drawn **ahead of time**, so agents reason faster.

- **Memory ↔ code bridge.** Stored lessons and decisions now carry structured **code anchors** (file + symbol), so recall can cross straight from *"this is how we fixed the auth bug"* to the exact function it lives in — and, in reverse, from a function to everything the brain knows about it. The two stores used to be islands; now they're joined by a shared key.
- **Predict *where* to fix it — `code_locate`.** Give it an error or a problem description and it returns a ranked list of `{file, symbol, why: [past lessons]}` — the code sites most likely responsible, each with the fixes and decisions that point there. It's exposed as an **MCP tool**, so any agent can reach for it *first* when debugging instead of grepping blindly. (The bridge fills in over time: `why` gets richer as new lessons are anchored and the background weaver backfills older ones.)
- **The Weave — an always-on background connection-miner (flagship).** While you're idle, a weaver continuously draws connections across the *entire* unified brain: **cross-repo code-structure analogies** (a pattern in one repo that echoes one in another), **cross-repo answer/decision analogies**, and the memory↔code bridge edges above — materialized ahead of time with provenance and a weight floor so the graph stays high-signal. The connections are already there when an agent needs them.
- **Per-repo, durable code graph.** The code graph is now keyed **per repository** — a second repo no longer clobbers the first, and each repo's graph is a durable on-disk store, so a transient non-git directory (or git off the PATH) won't wipe one you've already built.
- **Automatic bug → fix edges.** When a task with a problem finishes, Mneme now mints the causal **`solves`** edge automatically, so *"this error → that fix"* is traversable later without anyone hand-linking it.
- **Rock-solid, never-delete memory.** Idle consolidation moves aged memories to a **cold-archive tier** instead of deleting them — nothing curated is ever lost — and **deep recall** can still reach archived entries and history beyond the hot search window. Cross-repo transfer is **relevance-scoped**, so one unified brain gives cross-project reuse without the noise.
- **Sharper learning.** An **opt-in LLM distiller** (`TERMPOLIS_MNEME_DISTILLER=1`) writes richer, more precise lessons; `memory_related` is now **undirected**, so a connection surfaces from either end.
- **The `explains` edge — the code ↔ purpose bridge (v1.25).** A semantic memory now links directly to the **code chunk it explains**, so the prose that says *why* a thing works the way it does hangs off the code itself. The edge is gated on **both** embedding similarity **and** a shared file/symbol anchor — a merely chatty neighbour can never claim to explain code it has no anchor into. In the same pass the weaver was fixed to actually mint what it mined: **intra-repo analogies are now allowed** (it was cross-repo only, so the most useful connections — the ones inside the repo you're in — were being discarded), and the similarity floor drops **0.82 → 0.72**.

---

### 🆚 How Termpolis improves on other AI harnesses

Termpolis doesn't replace Claude Code, Codex, or Gemini CLI — **it runs them, unchanged, and adds the layer they're all missing.** A bare AI CLI (or an IDE assistant like Cursor or Copilot) is a single vendor's model talking to a single session: no memory of yesterday, no awareness of the other tools you use, and no guardrail on what leaves your machine. Termpolis turns that into a coordinated, persistent, auditable workspace.

| What you actually get | A bare AI CLI / IDE assistant | The same agent inside Termpolis |
| --- | --- | --- |
| **Memory across sessions** | A per-session context window that resets cold every launch — you re-explain the task and re-pay the tokens to reload it | One local brain **all three agents share**, surviving restarts; auto-fed from past transcripts; **observable + staleness-guarded** (v1.16.7) |
| **More than one model** | Locked to one vendor's family | Claude + Codex + Gemini run **as a team** under a local conductor that routes each subtask to the best-suited model |
| **Secrets / code leaving the machine** | Whatever you type is sent as-is, and you never find out | Every prompt is scanned against **97 secret patterns**. Your text is forwarded untouched, and a hit is **logged by name** (`DB_PASSWORD`) so you know what to rotate — the value is never stored. And since v1.25 the same engine **actually blocks a `git commit` or `git push`** that would carry a secret into history or to a remote |
| **Importing a third-party skill / plugin / MCP server** | Wired straight into the agent's config — a zip nobody diffs, whose *instruction text* the agent reads as if you'd typed it | **Safe Import** statically scans it first (**41 rules**, including prompt injection hidden in the artifact's own prose). **Red is never installable**, and approvals are **hash-pinned** so an edited artifact re-prompts |
| **Knowing what the agent contacted** | Opaque — you can't tell who it talked to | **Per-agent egress audit** (netstat / ss / lsof) records every remote host the agent reached — and **Egress Guard** judges each one against a provider allowlist, raising anything else as a violation |
| **Telemetry on you** | Often product analytics or cloud-stored chat history | **None by default** — memory, history, and the audit log stay in local JSONL on your disk |
| **Lock-in** | Vendor account, cloud backend, or a specific IDE | **Apache-2.0, local-first, no Termpolis account, no Termpolis server** |
| **Coordinating parallel agents** | You juggle terminals by hand | Real-time **observability** — activity feed, redundancy detector, efficiency panel, and a swarm dashboard |

**The short version:** other harnesses optimize a single agent's loop. Termpolis optimizes *your whole agent fleet* — giving three competing models one shared, durable, trustworthy memory (hardened in v1.16.7 so a working recall is visible, fresh, and never cites a file that no longer exists), a security perimeter around the hosted-model path, and a single place to watch and review everything they do. See the full, sourced [feature-by-feature comparison vs Warp, Wave, JetBrains Air, and Tabby](https://termpolis.com/#compare).

---

## 🔀 Second Opinion — a different agent double-checks the last answer

Every model has blind spots. **Second Opinion** hands the most recent answer in any AI terminal to a *different* agent for a fast, read-only critique — the feedback is pasted back into the same terminal, ready for you to send to your primary agent or just read and discard.

- **Pick any installed agent — and any of its models.** A **Second Opinion** dropdown on each AI terminal has one group per agent you have installed — **Claude**, **OpenAI Codex**, **Gemini** — each with a *default* row plus that agent's own models: Claude's always-latest **Fable · Opus · Sonnet · Haiku**, and whichever models your installed Codex and Gemini CLIs currently offer. So while you're driving Opus, you can have **Fable** — or a specific Codex or Gemini model — sanity-check the last solution.
- **It reviews the real, recent work.** Termpolis captures the terminal's most recent output, asks the chosen agent to review the latest solution/answer/approach, and injects its concise feedback back into your terminal as an **unsent block** — you decide whether to act on it.
- **Read-only by design — enforced by each CLI (v1.49).** A review needs no file access, so it runs the agent in one-shot headless mode, in the mode its own CLI enforces as read-only and never with a permission-bypass flag: Claude in plan mode with no tools and no MCP servers, Codex in its read-only sandbox, `agy` in plan mode — nothing it says touches your repo. The captured text is passed **out-of-band** (never on a command line), so a prompt scraped from your terminal can't inject a command.
- **Only what's installed shows up**, and it appears only on AI terminals. Gemini runs through the **Antigravity CLI (`agy`)**, its current headless entry point.

> **Proven end-to-end.** A CI test drives a real review from **Claude, Codex, and Gemini (via `agy`)** against a deliberately-bad solution ("sort 1,000,000 items with bubble sort") and confirms each returns substantive feedback.

---

## ⚡ Token Headroom — compress what Claude Code sends, cut your burn rate (v1.35)

Long AI coding sessions chew through rate limits and hit compaction fast — and the biggest culprit isn't your prompts, it's the **file reads, command output, and pasted screenshots** the agent ships back to the model on every turn. **Token Headroom** compresses that traffic *before* it reaches Anthropic, so you get more work done per session before you hit a wall.

- **On by default for Claude Code — and yours to switch off (v1.49).** Every new Claude session launches through a **local, off-thread compression proxy** on `127.0.0.1` (its own process — never the UI/PTY thread), which forwards only to `api.anthropic.com`. No setup. The switch is in **Settings → Token Savings** (the tour's last step and the one-time privacy review offer it too): off means new sessions talk to Anthropic directly, and a session that is already running keeps its route until it ends. If you already route Claude Code yourself — your own `ANTHROPIC_BASE_URL`, an `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` (upper- or lower-case), or `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY`, set in Termpolis's environment **or in the `env` block of Claude Code's own `~/.claude/settings.json`** — the proxy **steps aside**, and Settings → Token Savings names the variable it found: Claude Code keeps the route you configured, and nothing is compressed. If the proxy is ever unhealthy the launch silently goes **direct**, and a live session self-heals when the proxy recovers — so a proxy hiccup costs you *compression*, not your agent.
- **It compresses what actually costs you.** Verbose **Bash/command output**, large **file Reads**, **fetched web pages** (HTML stripped to its readable text), and **pasted images** (downscaled below the model's cap, then emitted as PNG or JPEG — whichever is smaller) are shrunk deterministically. A result **repeated in the same session collapses to a one-line reference**, and — new in v1.34 — a **near**-duplicate is sent as a **patch against the earlier copy**: read a file, edit three lines, read it again, and only those lines go over the wire. Nothing is lost; the agent calls the `retrieve_full` tool to pull any compressed result back when it needs the detail.
- **Source code is compressed structurally, not by the line (v1.35).** Code is the dominant content in a coding session, and a head/tail line window throws away the middle of every file — usually the part the agent needed. Headroom now **outlines** source instead: imports, declarations and every class/function **signature** survive, while bodies collapse to `… 24 lines …`. You keep the API surface of the *whole* file for a fraction of the bytes — this repo's own `wireCompress.ts` outlines from 22,139 characters to 4,450, a **79.9% cut with all 20 exported signatures intact**, and the line budget then bounds the block to 2,127 characters (**90.4%**) when the file is larger than the window allows. It handles ~35 languages across both brace- and indentation-delimited families, sees through the `cat -n` gutter on a `Read` result so line numbers stay correct, and **refuses to fire** when the text isn't code or the outline wouldn't be meaningfully smaller. Structured content also gets **3× the line budget** of prose — a signature list is worth more per line than a log tail — while staying bounded and one `retrieve_full` away from the original.
- **JSON is compressed as JSON (v1.35).** A line window is nearly useless on JSON: minified payloads are one enormous line it can never split, and pretty-printed ones bury the interesting keys in the middle where head/tail discards them. Headroom now understands the shape — long arrays keep their first entries and say how many were elided, long string fields are truncated in place, deep nesting is pruned, and the survivors are re-emitted **minified** so none of the budget goes to indentation. Crucially it **refuses the entire payload** when any numeric literal is long enough to lose precision in a parse/stringify round trip: `12345678901234567890` silently becomes `12345678901234567000`, and a corrupted ID the agent *believes* is far worse than an uncompressed one.
- **The escape hatch actually works (v1.34).** `retrieve_full` used to resolve out of a small in-memory cache that a busy session evicted within minutes — and every miss made the agent re-run the tool and pay full price twice. The cache is now **disk-backed, byte-capped, and survives restarts**, so a token issued yesterday still expands today.
- **Tool results, never tool-call inputs (v1.49).** A tool call has two sides: the **result** that came back, and the **`tool_use` input** — what the model asked the tool to do: the `Bash` command, the file body in a `Write`, both sides of an `Edit`, a subagent prompt. v1.34 compressed both halves, and v1.37.1 stopped touching file bodies and commands. Since v1.49 the proxy **never rewrites a tool call's input, at any age** — not on the live wire, not when old history is aged out — because the model replays its own earlier inputs as templates, and an elided one would land in a real file, a real command or a subagent's prompt. It compresses tool results (and pasted images) only. Earlier inputs are still read, never changed, so a result that reads back a file the agent just wrote still collapses.
- **Prompt-cache safe — proven.** Naive compression *busts* Anthropic's prompt cache and costs you **more**. Headroom compresses **deterministically**: stash tokens are **content hashes**, not counters, so the same block gets the same token no matter what came before it. A dedicated test suite asserts the compressed prefix is **byte-identical across ten successive appends**, when a duplicate arrives, when a near-duplicate is diffed, and at the hardest tier. Measured over 62,716 real requests, with cache hits fully preserved.
- **Measured, not asserted.** 4,183 real requests from this machine's own transcripts — **35.2 GB of request bodies** — were replayed through the compressor. At the shipped default: **61.0% of compressible tool text removed** (63.5% of tool results, 51.6% of `tool_use` payloads — measured before v1.49 stopped compressing `tool_use` input), **median request 61.4%**, and **93.8% of requests clear 50%**. At the Maximum tier: **72.3%**, with **99.9%** of requests clearing 50%. A [regression test](tests/electron/headroomFloorRealistic.test.ts) now fails the build if a threshold is ever loosened.
- **The meter reports all three denominators (v1.34).** "50% saved" is meaningless without a stated base, and there are three honest ones: the **compressible wire text** the compressor actually sees (**61%**), **all input tokens** including the re-read cached prefix (~9%), and **effective cost** after cache-read/write weighting (~6%). Settings shows all three side by side, plus **worst-request** and **below-floor** counts. The reason the last two are small is arithmetic, not weakness — compressible tool text is only **42.3%** of a request body, so removing *all of it* would still cap at 42.3%. Headroom takes **25.8% of the entire body**, and the dashboard says so rather than quoting the flattering number alone.
- **A savings floor that enforces itself (v1.34).** The ledger tracks every request's saved percentage. If the measured floor isn't holding, **floor control** escalates the wire to a harder tier at the next launch — including a new **Maximum** tier that compresses blocks down to ~600 characters. It escalates only, never below what you configured, and it decides once per launch: re-tiering mid-conversation would invalidate the cached prefix it just built.
- **Prefix decay — on by default since v1.36, and honest about why.** On very long conversations, the tool results in the oldest half are aged down to retrievable stubs (tool-call inputs never are). It is the one control that can *cost* money: shortening the prefix forces a re-cache (~1.15× the prefix), which needs roughly **44 more turns** to repay at typical volumes — so the first cut waits for **128 messages**, about three times that margin, and every stub is one `retrieve_full` away. The cutoff advances only at **doublings** (128 → 256 → 512 messages), so a 300-turn session pays at most a handful of breaks instead of one per turn. Since v1.49 it never ages out the result of a `retrieve_full` or memory call — the content the agent just asked for — and it leaves a `<system-reminder>` riding inside a tool result in place. Turn it off with **Age out old history** in **Settings → Token Savings**.
- **It reaches your output tokens too (v1.34).** Output — thinking included — is billed at ~5× input and was **38% of measured effective spend**. An optional **thinking-budget cap** lowers an over-declared budget to a fixed per-session value (constant by design, or it would bust the cache), and **adaptive steering** picks the verbosity directive at launch from your own measured average. Both are honest about their limits: the cap trades reasoning depth, so it ships **off**.
- **Your memory/brain is never touched.** Compression lives only on the outbound wire to Anthropic; the shared memory store, recall, and learning are untouched.
- **One honest receipt.** **Settings → Token Savings** sums **both** compression surfaces — the wire proxy and Termpolis's own MCP tool output — into a single gross/net/give-back figure, computed from Anthropic's real usage numbers on your machine, plus prompt-cache health and the share of effective spend that is output. Before v1.34 the two ledgers were never added together and reversals were billed to the wrong one, which could show a *negative* total beside a proxy that had genuinely saved 450M tokens.

> **Built in-house, tested hard.** Deterministic compressors, a **source-level cache-safety guard** (no clock or randomness anywhere in the compression path), **mode-graded output steering** (conservative/balanced/aggressive), fail-open at every layer, and an end-to-end proof measuring real token reduction with the cache intact — all under Termpolis's 8,400+ test suite.

---

## 📱 Termpolis Remote — keep a session going from your phone

The desktop app is where the work happens. **Termpolis Remote** is a small companion app for iPhone ([Termpolis R](https://apps.apple.com/us/app/termpolis-r/id6809306362) on the App Store) that lets you read those terminals and type into them while you are away from the machine — nothing more. It is a **pass-through**, not a second Termpolis.

- **Nothing runs on the phone.** No agent, no memory, no embeddings, no API keys. The desktop runs the Claude/Codex/Gemini session it was already running, signed in the way it was already signed in; the phone sends keystrokes and receives output. Lose the phone and you have lost a display, not an account.
- **End-to-end encrypted, and the relay is not trusted.** Pairing is an X25519 exchange completed by scanning a QR code **off the desktop's own screen**, so the desktop's key never crosses the network — but whoever can see that screen during the code's 90 seconds (in person, or through a screen share or a recording) can pair in your place, so pair privately. Everything afterwards is ChaCha20-Poly1305 under fresh per-connection keys the relay never sees: it forwards sealed frames it cannot read or alter, and both ends reject replayed or reordered ones. Both ends show the same eight **safety words**; if they differ, something is in the middle.
- **The desktop decides what the phone may do.** Read, start a terminal, type into a terminal and close a terminal are four separate grants, chosen when you pair (only **Read** is ticked by default), changeable from the desktop at any moment, and re-checked on the desktop for every request — a phone that thinks it has a grant it does not simply gets refused. Typing into a terminal is deliberately *not* implied by starting one. An agent started from the phone runs the way swarm workers do, without permission prompts, so grant *start* and *type* only to a phone you trust as much as the desktop.
- **One phone, up to 16 desktops.** A work machine, a home one, a Linux box in the corner — pair with each, and switch between them from the header of the terminal list. Every pairing gets its **own keypair**, so each desktop sees a different device, grants capabilities to that device alone, and revoking on one machine says nothing about any other. Rows are named from the desktop's hostname and renameable on the phone; two machines with the same hostname are numbered, because a switcher with two identical rows is one where the wrong terminal gets the command.
- **Off by default, and unpairable from either end.** Remote is disabled until you enable it. The desktop can revoke a device; the phone can unpair itself even with no network, because a phone that can only be unpaired while online cannot be unpaired when it matters. Either side ending it is enough — the session key cannot be re-derived without both identities.
- **It runs off the main thread.** The bridge lives in its own Electron `utilityProcess`, so a busy relay connection can never make your terminals stutter.

The wire format is specified in [`docs/remote-wire-format.md`](docs/remote-wire-format.md) and implemented twice — `src/main/remoteBridge/` on the desktop, `mobile/src/wire/` on the phone — with a test that makes each side open what the other sealed on every CI run. See [`mobile/README.md`](mobile/README.md) to run the client.

---

## 🔗 Linked machines — let an agent hand work to your other computer

Link two Termpolis desktops, and an agent on one can have a Claude, Codex or Gemini agent on the other do a task **headlessly** and hand back its final answer as an ordinary tool result. It works in both directions, across any network: *"Have Claude on linux implement the parser in ~/repos/foo and commit it, then review the commit yourself."* Nothing is typed into a terminal and no terminal opens on either machine. Every job is listed under **Activity** on both computers.

**Setting it up**, once per pair of computers:

1. On **both** computers, open **Settings → Linked machines** and turn on **Let this computer link with my other computers**.
2. On one of them, under **Link a computer**, click **Create code**, then **Copy**. The code works once and expires after 5 minutes.
3. Carry it to the other computer any way you like (a chat, a shared folder, typing it). Paste it under **Enter a code from another computer** and click **Link**.
4. Both screens show the same **eight safety words**. Name the other computer whatever you like, check the words match, and click **They match — link** on **both** sides. Each computer runs nothing for the other until you confirm the words on it. Treat the code like a one-time password: if the other screen shows no words, or different ones, cancel.

**How your agent decides to use another machine.** Termpolis doesn't split your work or schedule anything across machines. Agents get one MCP tool, `linked_machines`, and use it the way they use any tool: when you ask (you refer to a machine by the name you gave it: *"have codex on linux run the integration tests and summarise the failures"*), or when the agent judges a task belongs on the other computer, say because Codex is blocked on this network or the repo, hardware or test environment is over there. It can `list` the machines to see which agents are installed on each and what it may do there, then `run` a task with a self-contained prompt and, optionally, a folder on that machine. The other agent's final message comes back as the tool result, and your agent reviews it like any other answer. A workflow you build can also call the tool as a step.

**What each permission means.** Each computer decides what the *other* may do *on it*, per linked machine, and you can change it at any time:

- **Run agents here (read-only)** — on by default. The other computer's agents may start an agent here in its own read-only mode: Claude with only Read/Grep/Glob, Codex in its read-only sandbox, Gemini (`agy`) in plan mode, each with this machine's memory and code index as read-only Termpolis tools and nothing else of Termpolis's. That agent can read any file you can read on this computer and send it back. Codex and `agy` keep MCP servers you added to their own configs.
- **Let agents edit files and run commands here** — off by default. The agent here then runs unattended, as you: Claude and Gemini with permission prompts skipped, Codex in its `workspace-write` sandbox. Grant it only to a machine you trust as much as this one. Switching it off stops any edit already running; it doesn't undo changes already made.

The computer doing the work doesn't ask you per job: the permissions are the decision.

**Limits.**

- **Both computers need Termpolis running and online.** The relay is a meeting point, not a mailbox, so a request to a machine that isn't there fails at once as offline instead of waiting.
- **A computer that is asleep or shut down is offline.** While it runs a job for another computer, Termpolis keeps it from idle-sleeping until the job ends; the display can still turn off.
- **On a Mac, closing the window keeps Termpolis running in the Dock**, links and all. Quit it (⌘Q) to take the Mac offline.
- **Each run is a fresh headless session**: no conversation carries over, though its memory digest can include earlier jobs once the indexer has picked them up. The prompt has to carry everything the other agent needs (commit SHAs, earlier findings), and code moves through Git as usual.
- **Long jobs come back as a job id.** A `run` waits up to 45 seconds, within the 60 seconds Codex gives one tool call. A job still going returns `running` with a `jobId`, and the agent collects it with `action: "result"`. A job runs for up to 15 minutes by default.
- **Up to 16 linked machines** per computer, counting both directions. A computer runs at most 2 jobs at a time for any one machine and 4 in all.

**Security.**

- **End-to-end encrypted through the relay**, with the same X25519 pairing and ChaCha20-Poly1305 sealing as Termpolis Remote. Prompts, answers, folders and machine names are sealed, and every connection gets fresh session keys, so prompts and answers recorded today can't be decrypted later. Making or entering a code requires a `wss://` relay, and the relay's source is in [`relay/`](relay/) if you'd rather run your own.
- **What the relay does see:** both computers' IP addresses, a room id for the link, when each connects, the size and timing of each frame, and each frame's unencrypted header (public keys while pairing and connecting, a frame counter). Each agent's AI provider sees what that agent is asked and answers, as always.
- **Read-only by default.** Every request is checked on the computer that would do the work, before any agent starts there.
- **Keys.** The computer that enters a code makes a new key pair for that link. Private keys are encrypted with the OS keychain where one is available; on Linux without a keyring they're stored unencrypted in the data directory.
- **Read-only tools, no passing the work on (v1.51).** A delegated job gets this machine's memory and code index (memory search and recall, the code graph, git status, coverage) and nothing else of Termpolis's: no memory writes, no terminals, no other machines. Termpolis's agent connection enforces it, refusing every other tool, `linked_machines` included, and offering the job only the tools it may use, so it also carries fewer tool definitions. A job with edit permission runs as you, though, so it can reach anything you can.
- **Answers are scanned.** What comes back from another machine is scanned for prompt injection, and a flagged answer reaches your agent under an **UNTRUSTED CONTENT** banner. Prompts and answers aren't scanned for secrets, so don't put secrets in a prompt.
- **Memory.** Termpolis doesn't save a job's result into the doing computer's memory itself, but a Claude or Codex job's session is saved like any other, and the memory indexer can pick it up there.
- **Unlink from either side.** The other computer drops the link too, and any job either one still had running on the other is stopped. If the other computer was offline at the time, unlink it there as well.

Full guide: [`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md#30-linked-machines). Wire format: [`docs/remote-wire-format.md`](docs/remote-wire-format.md#13-linked-machines).

---

## 📊 Memory & Learning dashboard — proof it's working, computed locally

A **Memory & Learning** tab in Settings turns the brain from a black box into an inspectable instrument — **every number computed on your machine, offline, from the append-only store.** No word-taking; nothing on the screen leaves your machine.

<p align="center">
  <img src="assets/memory-dashboard.png" alt="Termpolis Memory & Learning dashboard" width="820">
</p>

- **Vector memory — int8 quantization, and a straight answer about whether you want it.** Your embeddings live in the **main process** — the same thread that pumps the PTY — so storing them as `int8` instead of exact floats is **4× less vector RAM**. But a bare switch would be a trap — nobody can answer *"should I enable int8 quantization?"* in the abstract — so this is a **decision aid**, and the answer it gives almost everyone is **don't**: at a typical corpus (14k vectors ≈ 21 MB) it says *"not needed — turning int8 on would free about 16 MB, which is not enough to change anything."* A control that only ever markets itself is an upsell, not a tool. **Off by default. Settings → Memory & Learning.**
- **What's stored** — memories by cognitive type (episodic · semantic · procedural · entity · summary) and by which agent authored them.
- **Live knowledge graph** — a force-directed view of the real typed edges recall walks (bug → fix → what superseded it), colored by type.
- **Code connections (v1.25)** — the structural code graph (symbols, and the caller/callee edges between them) now has a tile of its own. Indexing a repo was already minting thousands of these edges into a store the dashboard simply never read — so "connections" looked empty while the graph underneath was full.
- **Competence, calibrated from real work (v1.25)** — per-domain self-competence now learns from what actually happened: a **landed commit** and a **passing *or* failing test run** both feed the calibration. It previously only fired on a completed swarm task, so for most people every domain sat at zero attempts and the panel stayed blank forever. A failing suite is what finally calibrates confidence **down**.
- **Learning over time** — cumulative growth of the store and the distilled lessons within it.
- **Reliability SLIs** — recall-fired rate, embedder availability, write durability, and typical (median) recall latency. **(v1.25.6: a UI search that had fallen back to keyword — because the embedder was down — was still being booked as a *vector* recall, so the dashboard over-counted them. It reports the path that actually ran now. A proof dashboard that flatters itself is worse than no dashboard.)**
- **Model portability & cross-agent learning** — which agents authored what, and where a lesson one agent learned was later reused by another.
- **Receipts** — recalls served, solutions reused, and estimated tokens saved.

> **These numbers are read when you open the tab and when you press Refresh — never on a timer (v1.25.16).** Computing them means scanning the whole store, and that scan runs in the **main process**, which is the same thread that echoes your keystrokes into the PTY. On a 5-second poll it stalled typing every 5 seconds and generated enough garbage to drive the very GC pauses the dashboard used to display. A dashboard paid for out of your typing latency is not worth having. The **freeze history** that used to sit above this section is gone for a worse version of the same reason — see *Diagnostics that cost more than they're worth*, below.

> **On int8, two guarantees worth stating plainly.** Recall parity against the exact-float baseline is **benchmarked and CI-gated** — the benchmark scores the quantized store against the same committed baseline as the float one on the real `bge` model, and **recall@10 is identical**; a change that degraded it would fail the build. And it is **losslessly reversible**: the JSONL on disk **always keeps exact floats**, so int8 is purely an in-RAM representation, **never a data migration**. Turning it off restores full precision — nothing is ever destroyed.

> The screenshot shows the dashboard's layout with representative sample data; your instance fills in with your own local numbers as you work.

### Diagnostics that cost more than they're worth (removed in v1.25.16)

v1.25.15 shipped a V8 sampling profiler so that a freeze in unlabelled code could still be *named*. The reasoning was sound and the measurement was not: `Profiler.stop` was clocked at **4–15 ms** in a small test script, so it was called straight from the stall watchdog. In a real main process — 1.1 GB heap, 1.75 GB RSS, an enormous loaded-code footprint — that same call blocked the thread for **~1000 ms**. And the watchdog called it *on every stall it detected*:

```
Profiler.stop blocks ~1000ms  ->  the next 250ms tick arrives 750ms late
750ms > the 400ms threshold   ->  "a freeze!" -> to name it, harvest -> Profiler.stop
...which blocks ~1000ms       ->  the next tick is 750ms late -> "a freeze!" -> ...
```

A closed loop, feeding itself, that never breaks: **every freeze it detected was one it had just caused.** One 21-minute session recorded **1,139 freezes blaming the profiler for 890 seconds** of main-thread block — with no application work running at all. The main thread is the thread that echoes your keystrokes, so it surfaced as a 5–10 second typing lag and an app that froze on every click.

The lesson generalises past this bug, so it is worth writing down: **an instrument whose cost you measured somewhere cheap, wired into the loop that reacts to that cost, is a positive feedback loop waiting for a big enough heap.** The profiler, the freeze detector and the live vector-RAM tiles beside them — RSS, heap, GC pauses, event-loop percentiles, all polled every 2 s off the thread that echoes your keystrokes — are removed, and `tests/electron/noMainThreadInstruments.test.ts` now fails the build if the V8 inspector is ever attached to the main process again.

What survived is the part that never needed any of it. **The int8 verdict is pure arithmetic on the vector count** — `count × 384 × 4` against `count × 384 × 1` — so it is answered by one cheap read on tab-open, and it is back. What it can no longer do is claim to know whether that RAM is *hurting* you: the two verdicts that asserted a stalling main thread are gone with the instrument that measured one. **A panel that cannot measure the harm does not get to assert it** — so it reports the size, offers the toggle, and does not push.

### The launch freeze (fixed in v1.25.17)

Killing the profiler fixed the *typing* lag. It did nothing for the other one: on a large store the app froze for **~18 seconds at launch**, painting "(Not Responding)" before it would take a keystroke. Three separate causes, all measured against a real 475 MB / 94,430-entry store in a real Electron main process — not a benchmark script, which is the mistake that produced v1.25.15.

**1. Loading the knowledge graph took 7–10 seconds — from a 3.4 MB file.** Not a data-volume problem; two compounding quadratics. Every `{removeNode}` marker in the append-log swept the *entire* adjacency map to find the edges pointing at one node — copying the whole map and allocating a fresh array per node — and the real log holds **1,625 of those markers**. Meanwhile `reverseAdjacency`, an index whose entire purpose is to answer *"who points at this node?"* in O(1), was already being maintained and simply wasn't used here. (Separately, `upsertEdge` re-sorted a node's whole edge list on *every insert*, making a bulk load O(d² log d) per node; the sort only needs to happen once, at the end.) Fixed: **10,363 ms → 110 ms, a 94× speedup, producing a byte-identical graph** — same 15,892 edges, same 11,240 nodes, same order, verified edge-for-edge against the old implementation on the real log.

**2. The BM25 keyword index cost 445 MB and blocked the thread for ~5 s while it built.** Its payload lived in `Map<docId, Map<term,tf>>` + `Map<term, Set<docId>>` — two JS collection entries per posting, each spending ~26–50 bytes of V8 bookkeeping to hold 4 bytes of information, 8.5 million times over. It now lives in flat `Int32Array`/`Uint32Array` runs: **4.8× less heap, ~550 MB saved**, with BM25 scores that are *bit-for-bit identical* (verified across 218 queries on the real corpus, worst score delta exactly `0`).

**3. …and it still had to stop blocking.** Packing the index made it cheaper to *hold*, not meaningfully cheaper to *build* — the build cost is hashing 16.4 million tokens, which no representation avoids. So the build was moved off the critical path: it now runs in the background, yielding to the event loop, and only a search that actually needs it ever waits. Launch no longer pays for it at all.

**Measured end-to-end on the real store: launch went from ~18 s of dead main thread to ~4 s**, and the index build that remains yields the event loop hundreds of times instead of zero. The yield is `setImmediate`, deliberately — `await` on an already-resolved promise queues a *microtask*, and Node drains the microtask queue to completion before the loop turns, so it does not yield at all. That is not a hypothetical: it was the v1.25.11 freeze, 2,777 ms of unbroken work with **zero** event-loop turns and the same wall-clock time as the version that yielded properly.

The tests are the point, though. Every previous test of this code passed throughout the entire period the app froze for eighteen seconds, because they all built the index over a handful of documents — where it finishes inside the first chunk and never yields at all. **A test for a freeze that never freezes anything proves nothing.** `tests/electron/lexicalBackgroundBuild.test.ts` forces the yielding path and watches the event loop with a self-rescheduling `setImmediate` counter: against the old synchronous build it ticks **zero** times, and all eight tests go red.

---

> **A note on AI-assisted development:** There may be critique that this application is built in conjunction with using AI; however, if you are still exclusively using an IDE or manually writing every line of code, then you are doing it wrong. This is the new path for AI-native engineering as a programmer. Code review is often still needed, but beyond this, software engineering has a new path. Termpolis itself is built with AI and built *for* AI workflows — and that's the point.

> **Support this project** — Termpolis is free and open source. If you find it useful, consider [sponsoring the project](https://github.com/sponsors/codedev-david) to help cover AI token costs and development time.

## Documentation

Full docs with screenshots: **[termpolis.com/docs](https://termpolis.com/docs.html)** — or see [`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md) in this repo. Covers every feature: terminals, splits, the swarm dashboard, AI conductor, activity feed, intervention controls, shared memory, MCP server, and the full keyboard shortcut reference.

## Downloads

| Platform | Download | Format | Signed |
|----------|----------|--------|--------|
| Windows | [Termpolis Setup.exe](https://github.com/codedev-david/termpolis/releases/latest) | NSIS Installer | Code signed (SSL.com) |
| macOS (Apple Silicon) | [Termpolis-arm64.dmg](https://github.com/codedev-david/termpolis/releases/latest) | DMG | Signed & notarized (Apple) |
| macOS (Intel) | [Termpolis-x64.dmg](https://github.com/codedev-david/termpolis/releases/latest) | DMG | Signed & notarized (Apple) |
| Linux (Debian / Ubuntu) | [termpolis_*.deb](https://github.com/codedev-david/termpolis/releases/latest) | .deb | — |
| Linux (other distros) | [Termpolis.AppImage](https://github.com/codedev-david/termpolis/releases/latest) | AppImage | — |

> The Windows installer is code signed via SSL.com and the macOS DMG is signed and notarized with Apple Developer ID — both platforms will recognize Termpolis as a verified application. Download links point to the latest GitHub Release. See [Building from Source](#building-from-source) to compile locally.

### Installing the Linux .deb

Use `dpkg`, **not** `sudo apt install ./termpolis*.deb`. On Ubuntu 22.04+ apt drops to a sandboxed `_apt` user that can't read files in your home directory, which fails with *"Permission denied / pkgAcquireRun: 13"*. `dpkg` doesn't drop privileges, so it works regardless of where the .deb is saved:

```bash
sudo dpkg -i ./termpolis_*.deb
```

That's the only command you need on v1.11.31+. The package's postinst takes care of the rest automatically:

- runs `apt-get install -f -y` to pull any missing transitive deps (libgtk, libnss3, …),
- refreshes the desktop + hicolor icon caches so the launcher icon shows up without a logout, and
- the .desktop entry ships with `--no-sandbox --disable-gpu` baked into the `Exec=` line, so clicking the dock icon launches a working window on NVIDIA / Wayland setups where Chromium's GPU compositor would otherwise produce a blank black box.

If you ever need to launch from a shell with the same flags applied: `/opt/Termpolis/termpolis --no-sandbox --disable-gpu`.

**`sudo` in Termpolis terminals.** If `sudo`, `su` or `pkexec` fail in every terminal with *"The 'no new privileges' flag is set"*, the window was reopened by an in-app update of the .deb from Termpolis 1.50.0 or earlier. Quit Termpolis and open it again from your applications menu. Since v1.50.1, updates no longer cause it, and a window that starts with the flag says so and, where `systemd-run` is available, offers to restart itself properly. Every Termpolis terminal also sets `SUDO_ASKPASS`, so `sudo -A` there asks for your password in a Termpolis dialog that shows the whole command (Linux and macOS). Termpolis tells Codex, and Claude Code in projects with saved memory, to use it; otherwise mention `sudo -A` in your prompt.

> **\* Windows SmartScreen note:** SmartScreen may show a "Windows protected your PC" warning for newly signed software. Click **"More info"** then **"Run anyway"** to proceed. Termpolis is digitally signed and safe to install — the warning disappears as download reputation builds.

## Features

### Terminal Management
- **Multi-terminal sessions** — open as many terminals as you need in one window
- **Tab View** — single terminal at a time, switch via sidebar
- **Split View** — split any terminal horizontally or vertically with draggable dividers
- **Nested splits** — split panes recursively for complex layouts (like VS Code or iTerm2)
- **Workspaces** — save and restore terminal configurations including names, shells, themes, and working directories. An AI terminal is saved *as* an AI terminal: reopening the workspace re-launches the agent it was running, in the repo it was running in
- **Session persistence** — workspaces and settings survive a relaunch; loose terminals deliberately do not, so every launch starts clean (restoring a saved group of terminals is a workspace's job)
- **Single-instance lock** — only one Termpolis window runs at a time to prevent session conflicts
- **Drag and drop** — drag files onto a terminal to paste their quoted file paths

### Shell Support
- **PowerShell**, **Bash**, **Zsh**, **Cmd**, **Git Bash** — auto-detected per OS
- **Shell config editor** — edit .bashrc, .zshrc, PowerShell profiles with Monaco Editor

### AI-Native Features
- **AI Session Profiles** — one-click launch profiles for Claude Code, Codex, and Gemini CLI with custom profiles support
- **Agents can use `sudo` (Linux, macOS)** — `sudo -A` in a Termpolis terminal asks for your password in a dialog that shows the whole command about to run. Type it only for commands you expected: whatever you approve runs as administrator
- **Command Palette** — `Ctrl+K` opens a natural language command bar to control the app (new terminal, split panes, launch agents, run commands)
- **Prompt Templates** — save reusable prompt snippets (Fix Tests, Code Review, Refactor, etc.) and insert them with `Ctrl+Shift+P` (accessible via Command Palette)
- **Workflow Orchestrator** — an Azure-Logic-Apps-style canvas that chains four kinds of step — **Command** (a shell line on a real terminal), **Agent** (Claude Code / Codex / Gemini CLI on a prompt), **Skill** (a built-in tool), and **Control** (wait / branch / loop / notify) — into one repeatable, saveable run. Real control flow with per-step `when` gates and `continueOnError`; later steps read earlier results (`steps.build.exitCode`, captured output) through a **sandboxed expression engine** (no `eval`); and a live Runner timeline streams every step and lets you cancel mid-run
- **Workflow Triggers** — a saved workflow can run itself. Pick **Schedule** (a real cron expression — `0 2 * * *`, or `@daily`-style aliases — evaluated in local time, with catch-up so a run missed while the app was closed still fires once), **Git commit** (fires *after* a commit lands on the checked-out branch — a post-commit hook that can lint, test, or hand the diff to an agent), **Git push** (the remote-tracking ref moves), or **File change** (a debounced recursive watch, optionally filtered to a path prefix). Triggers are watched in the main process with no polling child processes, survive restarts (last-seen state is persisted per project), and every automatic run takes the **exact same path as pressing Run** — same workspace-trust gate, same run history, same live timeline. Untrusted folders never fire
- **Reusable Workflows** — a workflow can be saved **Global** instead of per-project: one definition, offered in the sidebar in *every* repo you open, running against whichever project you're standing in (project workflows still live in `.termpolis/workflows` and travel with the code). Give it a **Category** to file it into a sidebar folder, and declare **Inputs** to point the same workflow at a different target each run — every input is substituted as `${inputs.NAME}` into commands, prompts, skill arguments and `when` gates, alongside the automatic `${project.cwd}`, `${project.name}` and `${project.branch}`. Required inputs are collected before the Run button unlocks, so a run never starts half-configured
- **Agent Status Detection** — automatically detects when Claude Code, Codex, or Gemini is running and shows a colored badge in the status bar
- **Cost Tracking** — parses token usage and cost from AI agent output, displays running totals in the status bar
- **Session Recording** — record terminal sessions with timestamps, export as shareable text logs
- **Output Pinning** — pin important output blocks to a persistent panel that stays visible as the terminal scrolls
- **Diff Viewer** — detects `git diff` output and renders it with syntax highlighting (green/red for additions/deletions)
- **Smart Context Panel** — `Ctrl+Shift+E` opens a side panel showing file tree, git status, and recent commits for the current directory
- **Conversation History** — `Ctrl+Shift+I` searches across all AI agent conversations indexed from terminal output
- **Voice Dictation** — talk instead of type (Groq Whisper, opt-in, off by default): tap `Ctrl+Shift+L` to start/stop hands-free, or hold to talk; the hotkey and the send key are rebindable
- **Cost-Aware Model Picker** — pin a Claude model per profile (launches with `--model`) or switch a running agent's model from the terminal header, with savings hints — Sonnet ≈40% cheaper than Opus, Haiku ≈80% — so routine work runs cheap while hard work stays on Opus. Each terminal lists **its own agent's models**: Claude's aliases (always the newest in each family), Codex's from Codex's own model cache, Gemini's from `agy models` — discovered at launch and cached for 12 h, so an offline start keeps the last-known list. In a terminal Termpolis launched, a switch restarts the agent on the new model and resumes the conversation; a Claude session you started by hand gets a live `/model` instead (hand-started Codex and Gemini sessions get no picker, since switching means restarting them)
- **Knowledge Graph** — the shared memory stores **typed connections** between entries (`bug → solved-by → fix`, `decision → supersedes → …`), built explicitly via `memory_link` and **automatically** as curated memories are written. Agents follow the chain with `memory_graph` to reuse prior solutions fast instead of re-deriving them — the graph gets denser, and the agents get smarter, the more you use it
- **No duplicate data** — every write is content-addressed (SHA-256 over normalized text); storing the same information twice is a no-op, so the vector store and the on-disk log never accumulate duplicates and never re-embed what they already hold
- **Code Graph** — a native, **AST-precise** map of your repository built with **web-tree-sitter** (WebAssembly — native-free, nothing compiled, nothing leaves your machine): every function, class, method, and the calls between them. Agents query it over MCP with `code_explore` / `code_callers` / `code_callees` / `code_impact` (change blast-radius) / `code_search` / `code_locate` (predict *where* an issue lives) instead of grepping the same files repeatedly. Deep support for TypeScript/JavaScript, Python, Go, Rust, Java, C#, Ruby, and Swift; Terraform and Bicep fall back to a regex heuristic for symbol discovery. **As of v1.23 the graph is keyed per repository** — opening a second repo no longer clobbers the first, and because each repo's graph is a durable on-disk store, a transient non-git directory (or git off the PATH) won't wipe one you've already built. **As of v1.23.1**, an edit re-indexes **just the changed file** (debounced, AST-first) rather than re-sweeping the whole tree, backstopped by a periodic full re-index. Auto-indexed (opt-out in Settings), with an in-app **Code Graph browser** (`Ctrl+Shift+M`)
- **Safe Import** — import a third-party **skill, plugin, slash-command, subagent, or MCP server** and Termpolis **statically scans it before it touches your machine**: 41 rules across outbound network calls, shell / `eval` execution, credential + `~/.ssh` access, obfuscated payloads, and **prompt injection hidden in the artifact's own instructions**, plus context-sensitive checks that judge a construct by its surroundings. You get a red / yellow / green report with `file:line`; **red can never be installed**, and approvals are **hash-pinned**, so editing an approved artifact re-prompts. On approval it wires the artifact into the agents that support its kind — an MCP server into all three (Claude Code, Codex, Gemini CLI), custom commands into Claude / Gemini, and skills, subagents, and plugins into Claude Code. **Settings → General.** It is a static review aid, not a sandbox — nothing is executed

### MCP Server & Agent Integration
- **MCP Server** — built-in HTTP/SSE server on `localhost:9315` with tools for AI agents to control terminals programmatically (incl. shared-memory search/write/list, the background primer, `memory_related` traversal, the knowledge graph `memory_link` + `memory_graph`, the learning tools `memory_anticipate` / `memory_pool` / `memory_selfcheck` / `memory_feedback` / `memory_conflicts`, the `memory_audit` self-inspection tool, the code-graph tools `code_explore` / `code_callers` / `code_callees` / `code_impact` / `code_search` / `code_locate`, and `linked_machines`, which has a Claude, Codex or Gemini agent on another of your linked machines do a task headlessly and hands back its final answer)
- **Connects to your coding agents — after it asks (v1.49)** — the first step of the first-run tour lists exactly what Termpolis would write for each of Claude Code, Codex and Gemini CLI installed on this machine, and nothing is written until you finish or skip the tour (both boxes start ticked, and **Skip tour** keeps what is shown). Connected, it adds the Termpolis MCP server to each agent's user config, lets Claude Code run 27 read-only and memory tools without asking (tools that run commands or type into terminals still ask), pre-approves Codex's 14 memory tools unless you already chose a setting for them, and answers the folder-trust prompt for project folders you open agents in — never your home folder or a drive root. An optional SessionStart hook loads project memory whenever a Claude Code session starts, including sessions started outside Termpolis. **Settings → Agent Integration** lists every change and has **Disconnect**, which removes everything Termpolis wrote; the Windows uninstaller and removing the Linux .deb do the same, and `Termpolis --disconnect-agents` does it from the command line.
- **Stdio Adapter** — for agents that use stdio-based MCP, a standalone adapter script proxies to the HTTP server
- **CLI Tool** — `termpolis-cli` lets you control Termpolis from any terminal (`list`, `create`, `run`, `read`, `close`, `files`, `git`) and reach the shared memory brain from a plain shell, CI job, or git hook (`primer`, `recall`, `remember`)
- **Auth Token** — 256-bit random token per launch, required on all endpoints. Localhost only, CORS restricted.

### Context Handoff
- **Seamless agent switching** — when an AI agent runs out of context/tokens, an amber banner offers to switch to another agent
- **Automatic context capture** — captures your task, git branch, modified files, recent commands, diff summary, and recent output
- **One-click handoff** — click "Switch to Codex" (or Gemini) to launch the new agent with your full context pre-loaded
- **Editable handoff prompt** — preview and customize the context before switching via the "More Options" modal
- **Keep or close** — choose whether to keep the old terminal for reference or close it

### Multi-Agent Swarm

No AI company has built a tool that brings together competing models to work as a team — because it helps their competitors. Termpolis does it anyway, because it moves AI forward.

- **AI Conductor** — a dedicated Claude Code instance runs as the swarm conductor. It receives your task description, reasons about how to break it into subtasks, assigns each subtask to the best agent via MCP tools, and monitors completion. This is live AI orchestration — not keyword matching.

- **Smart Task Routing** — the conductor assigns subtasks to the best agent based on a customizable capability matrix. Scores are transparent (0-100) with human-readable reasons explaining every assignment. Token-heavy work is routed to cheaper agents for cost efficiency. Every assignment can be manually overridden. Default ratings are estimates based on general model capabilities — customize them in **Settings → Agent Ratings** based on your experience. The conductor uses ratings as hints but makes its own judgment.

  | Capability | Claude Code | Codex | Gemini CLI |
  |-----------|:-----------:|:-----:|:----------:|
  | Refactoring | ★★★★★ | ★★★★ | ★★★ |
  | Testing | ★★★★ | ★★★★★ | ★★★ |
  | Documentation | ★★★★ | ★★★★ | ★★★★★ |
  | Code Review | ★★★★★ | ★★★ | ★★★★ |
  | DevOps/Infra | ★★★ | ★★★ | ★★★★★ |
  | Bulk Tasks | ★★★ | ★★★★ | ★★★ |
  | Token Cost | $$$$ | $$$ | $$ |

- **Swarm Wizard** — 3-step flow: prepare conductor → describe task → launch. Includes guidance on when to use a swarm (autonomous task completion) vs individual agent terminals (back-and-forth conversation). Live progress tracking shows conductor status in real time — the modal stays open until the first task or message appears (can take up to 30 seconds).
- **Agents run in the background** — swarm-spawned agent terminals are hidden from the sidebar. The conductor drives all work via MCP tools (creating files, running commands, coordinating agents) and posts progress to the dashboard. For back-and-forth conversations, launch individual agents from the AI Agents sidebar section — those still appear in the sidebar and work normally.
- **Swarm Complete Dialog** — when all tasks finish, a summary dialog appears showing completed vs failed tasks with the result from each agent. Includes "What next?" guidance for iterating with individual agents or starting a new swarm.
- **Swarm Review Panel** — a swarm can create a brand new project or modify an existing one. When it finishes, click **Review Changes** to open a per-hunk diff viewer showing the full delta from the pre-swarm HEAD. Accept or reject individual hunks (or entire files), run the project's test command against the result, then commit only the changes you want. `git reset --hard` back to the pre-swarm SHA cleanly reverts everything.
- **Agent Command Enforcement** — agents are guaranteed to launch correctly regardless of what the conductor attempts. A programmatic sanitizer intercepts all `run_command` calls on swarm terminals, stripping unauthorized flags (`-p`, `--sandbox`, `--print`) and enforcing the exact approved command for each agent. Claude gets `--dangerously-skip-permissions`, Codex gets `-a never -s workspace-write` — no permission dialogs during swarms. A new folder's trust prompt is answered for you only when you've connected your agents and it is a project folder (never your home folder); otherwise you answer it once.
- **Interactive Agent Mode** — all agents (including Gemini CLI) launch in interactive mode so they retain full tool access, including file writing and command execution.
- **Token Budget Estimates** — shows per-agent estimated tokens and cost before you launch, so you know what the swarm will cost
- **Swarm Dashboard** — `Ctrl+Shift+S` opens a real-time view with two tabs: **Tasks** (kanban: Pending · In Progress · Completed · Failed) and **Messages** (chronological log). Also accessible by clicking the "Swarm Active" indicator in the bottom status bar.
- **Clear Confirmation** — clearing a swarm requires explicit confirmation to prevent accidental loss of in-progress work
- **Agent Install Status** — the AI Agents sidebar shows green checkmarks for installed agents and red X icons for missing ones. Clicking a missing agent's icon shows installation instructions.
- **Message Bus** — agents communicate through a shared message queue with typed messages (task, result, question, info, review)
- **Task Queue** — create tasks, assign to agents, track status across Pending → In Progress → Completed
- **MCP-native end to end** — Claude Code, Codex, and Gemini CLI all speak MCP. No terminal-output bridges, no parser glue, no special-case code paths.
- **6 swarm MCP tools** — `swarm_send_message`, `swarm_read_messages`, `swarm_create_task`, `swarm_list_tasks`, `swarm_update_task`, `swarm_list_agents`

### AI Observability

When you're running multiple AI agents concurrently (or a whole swarm), you need to see what each is doing, spot when they duplicate work, and know when one is about to run out of context. Termpolis ships a full observability layer that doesn't require any external dashboard — everything is local, capped in memory, and tested end-to-end.

- **Activity Feed** — `Ctrl+Shift+A` opens a live stream of every agent event. Captures messages, tool calls, tool results, token updates, compaction events, errors, status changes, and MCP audit entries. Filter by agent (claude/codex/gemini), by kind, or search full text. Newest first.
- **Context Pins** — pin any snippet (migration rule, test policy, API contract) scoped to the current project. Pins are re-injected on agent handoff so the new agent doesn't lose the plot. Per-project storage, full CRUD.
- **Redundancy Detector** — `Ctrl+Shift+D` shows duplicate work across terminals. If two agents are running `npm test` at the same time or both editing the same file, you'll see a severity-ranked finding with the affected terminals.
- **Efficiency Panel** — `Ctrl+Shift+Y` aggregates per-agent stats: token totals, cost, error rate, average tool-call duration. Spot when one agent is burning budget while another is cruising.
- **Event Bus** — in-process, bounded ring buffer (10k events), rate-limited (500 events/sec burst) to prevent DoS from a runaway agent. Persisted to JSONL with automatic rotation. Subscriber callbacks are try/caught so a bad listener can't kill the bus. All event payloads are 64KB-capped before persistence.
- **Transcript Watchers** — native JSONL readers for Claude Code, Codex, and Gemini transcript formats. Tail-with-rotation: if the agent rotates its log mid-run, the watcher follows. Path traversal is blocked at the watcher boundary.
- **Swarm Dashboard enhancements** — the dashboard (`Ctrl+Shift+S`) now shows live token burn per agent, tasks in kanban columns, and the full conductor message log. Every panel streams from the same event bus — no polling lag.

### Intelligence
- **Command auto-fix** — mistype a command? A green banner suggests the correction. Press Enter to run or Esc to ignore. Detects typos, permission errors, wrong flags, and more
- **Command history search** — search across all terminals with Ctrl+Shift+H

### Git Panel
- **Built-in git panel** — accessible from the sidebar git icon. Shows current branch, staged and unstaged file lists with status indicators (M/A/D/R/U), stage or unstage individual files or all at once, commit with message, and pull/push buttons. Click a file for its inline diff (green additions, red deletions, blue `@@` hunk headers). Auto-detects git repos from the active terminal's working directory, or lets you pick a folder (VS Code-style). Collapsible sections, auto-refreshes every 3 seconds.
- **Git mark on every terminal** — each terminal row in the sidebar carries a small git indicator: inert outside a repo, grey when the tree is clean, and **amber and pulsing** when anything is staged, modified, untracked, conflicted, or **committed but not pushed**. Hover for the breakdown ("3 staged, 2 modified, 1 to push"). Being *behind* the remote is shown in the tooltip but deliberately never pulses — that's someone else's work arriving, not yours waiting, and on a busy repo it would pulse forever. Follows `cd` in every supported shell; polling is keyed by repository, so ten terminals on one repo cost one `git status`.
- **Commit/Push Secret Shield** — commit and push from this panel are gated by the same 97-rule secret engine that scans AI prompts. Commit scans the **staged diff**; push scans **every commit not yet on a remote**. A hit **blocks the operation** and names the rule, so a leaked key can't land in history or reach a remote. Fails open on a git error; on by default, toggle in **Settings → AI Security**.

### Customization
- **7 terminal themes** — Dark, Light, Solarized Dark, Solarized Light, Monokai, Dracula, Nord
- **Per-terminal theming** — each terminal can have its own theme, font size (8-32px), and font family
- **Color-coded terminals** — 12 accent colors for visual identification in the sidebar
- **Configurable keybindings** — customizable keyboard shortcuts with a recording UI in Settings
- **Collapsible sidebar** — toggle with Ctrl+B or the chevron button

### Productivity
- **Terminal output export** — save scrollback to a text file (full or visible portion) via header button or right-click
- **Copy/paste** — Ctrl+Shift+C/V with right-click context menu (Copy, Paste, Select All)
- **Clickable URLs** — links in terminal output open in your default browser
- **Per-terminal status bar** — blue bar showing shell type, current directory, git branch, AI agent badge, and cost tracking
- **Live git branch detection** — status bar updates by parsing prompt output (works on all platforms)

### Built-in Tools
- **jq**, **yq**, and **nano** — bundled and available in every terminal, even if not installed on your system
- Latest versions downloaded automatically on each build

### Accessibility
- **WCAG AA compliant contrast** — all text meets the 4.5:1 minimum contrast ratio against dark backgrounds. Audited and fixed across every component in the app (116 text elements upgraded).
- **Agent install indicators** — clear visual icons (green check / red X) show install status at a glance, with one-click access to setup instructions

### Performance & Reliability
- **Output throttling** — rAF-based batching with 64KB per-frame rate limit prevents UI freezing from heavy output
- **10,000-line scrollback buffer** per terminal (prevents unbounded memory growth)
- **Viewport-aware rendering** — off-screen terminals in split view get deferred rendering
- **Lazy-loaded settings** — Monaco editor and settings pane load on demand, not at startup
- **Stuck-process cleanup** (Settings → Processes) — lists headless AI agents (Claude Code, Codex, Gemini CLI), git that is frozen, orphaned or has run for 30+ minutes, and the shells, wrappers and MCP servers such runs leave behind. Each row shows who started it, age, CPU, memory and the real command (an agent's Bash-tool harness is unwrapped; common secret formats and your home path are masked, best effort). **STUCK** marks what is usually safe to end — it serves no TCP port, has nothing interactive open in it (an agent CLI in a terminal, a git GUI or merge tool, a common pager or editor), and is frozen (Windows) or orphaned (a headless agent once it has been running for an hour, git once it has run for 30 minutes and never its own gc or maintenance, anything else as soon as it is listed); a download or script you detached on purpose looks the same, so check the command first. Windows Git Bash can leave a git or jq suspended forever when its script exits at the wrong moment. Kill selected or kill all stuck, whole process tree, behind a confirmation; each target is re-checked by pid **and** start time against a fresh scan, and anything that exited, is no longer listed, or whose pid was reused since the list was drawn is skipped. Scans only when the tab opens or on Refresh — never in the background. Termpolis, whatever launched it, and its own shells are never listed.
- **Full Unicode support** — emoji, CJK characters, and special glyphs render correctly
- **React ErrorBoundary** — catches render crashes gracefully with a recovery UI instead of white screen of death. Terminals survive UI errors.
- **Sentry crash reporting** (optional) — set `VITE_SENTRY_DSN` and `SENTRY_DSN` env vars to enable it in a build. Crash reports and anonymous usage statistics are then two separate choices, **both off until you tick them** (the tour's last step, or **Settings → General → Privacy**). A report drops your user name, home-folder paths and machine name, and never carries a minidump or a screenshot.
- **6,700+ automated tests** — unit & component tests (Vitest, 336 test files) at **96.63% statements / 93.27% branches / 96.02% functions / 97.78% lines**, plus a Playwright end-to-end suite that launches the real Electron app. Coverage is enforced as a hard CI gate — no commits allowed below threshold. **v1.25.5 raised the gates to 95 / 92 / 95 / 96** (statements / branches / functions / lines): the old floors were being cleared by as little as 0.08 points, and a gate you clear by a rounding error is not a gate — it goes red on the next commit, and the cheapest way to make it green is to delete a test.

### Cross-Platform
- **Windows**, **macOS**, **Linux** — all features work on all platforms
- Builds via GitHub Actions CI/CD on tag push

## Keyboard Shortcuts

All shortcuts are customizable in **Settings → Keybindings**.

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` | Command palette |
| `Ctrl+Shift+T` | New terminal |
| `Ctrl+Shift+W` | Close terminal |
| `Ctrl+Tab` | Next terminal |
| `Ctrl+Shift+Tab` | Previous terminal |
| `Alt+1` – `Alt+9` | Jump to terminal by number |
| `Ctrl+Shift+H` | Search command history |
| `Ctrl+Shift+C` | Copy selection |
| `Ctrl+Shift+V` | Paste |
| `Ctrl+Shift+Space` | Keyboard select / copy mode (arrows move · Shift extends · Ctrl=word · Enter copies) |
| `Alt+Shift+Click` | **Anchor select** — click a start, scroll anywhere, click the end: everything between is selected + copied. Unlike dragging, it spans any amount of scrollback. Any plain click cancels. |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+Shift+G` | Toggle split view |
| `Ctrl+Shift+X` | Clear terminal — screen **and** scrollback (nothing is sent to the process, so an agent keeps its own context) |
| `Ctrl+Shift+O` | App log — what Termpolis itself has printed, secrets redacted on write |
| `Ctrl+Shift+P` | Prompt templates |
| `Ctrl+Shift+E` | Smart context panel |
| `Ctrl+Shift+I` | Conversation history search |
| `Ctrl+Shift+S` | Swarm dashboard |
| `Ctrl+Shift+A` | Activity feed (agent events) |
| `Ctrl+Shift+D` | Redundancy panel (duplicate work) |
| `Ctrl+Shift+Y` | Efficiency panel (per-agent stats) |
| `Win+Shift+T` | New terminal (global, works when minimized; `Ctrl+Option+T` on macOS) |

> On macOS, use `Cmd` instead of `Ctrl`.

## MCP Server

Termpolis runs an MCP (Model Context Protocol) server on `localhost:9315` that AI agents can connect to via HTTP/SSE.

### Claude Code Integration

Once you connect your agents — on the first step of the first-run tour, or in **Settings → Agent Integration** — Termpolis registers itself as a user-scope MCP server: in Claude Code's `~/.claude.json` (as `claude mcp add -s user` writes it), Codex's `config.toml`, the Antigravity CLI's `~/.gemini/config/mcp_config.json` (with permission for the same read-only and memory tools Claude Code gets, in `~/.gemini/antigravity-cli/settings.json`) and Gemini CLI's `settings.json`. Nothing is written before you agree, and **Disconnect** removes all of it.

### Available Tools (40)

**Terminal Management:**

| Tool | Description |
|------|-------------|
| `list_terminals` | List all open terminals with IDs, names, shells, and cwds |
| `create_terminal` | Create a new terminal with name, shell, and working directory |
| `run_command` | Send a command to a terminal (types it and presses Enter) |
| `run_and_wait` | Run a command to completion and return its exit code and output |
| `read_output` | Read recent output from a terminal (last N lines) |
| `write_to_terminal` | Write raw text to a terminal |
| `close_terminal` | Close a terminal by ID |
| `get_file_tree` | List files and directories at a path |
| `get_git_status` | Get git status, branch, and recent commits |

**Swarm Coordination:**

| Tool | Description |
|------|-------------|
| `swarm_send_message` | Send a message to another agent or broadcast to all |
| `swarm_read_messages` | Read unread messages addressed to you |
| `swarm_create_task` | Create a task and optionally assign to an agent |
| `swarm_list_tasks` | List all tasks with statuses |
| `swarm_update_task` | Update task status and report results |
| `swarm_list_agents` | List all active terminals/agents |

**Shared Memory & Learning:**

| Tool | Description |
|------|-------------|
| `memory_search` | Semantic + keyword search across the shared memory brain |
| `memory_write` | Persist a fact, decision, or note for every agent to recall |
| `memory_list` | List recent memory entries with filters — pass `project` (your cwd) for "what did we do here last?" |
| `memory_primer` | Load a background-memory digest for the current project: relevance-ranked, with reserved newest-first slots |
| `memory_related` | 1-hop traversal from a memory entry (or query) to its neighbours |
| `memory_link` | Record a typed edge between two memories (knowledge graph) |
| `memory_graph` | Multi-hop walk of the knowledge graph from a seed memory |
| `memory_anticipate` | Surface lessons the fleet already found for a task before you start |
| `memory_pool` | Pool cross-agent lessons multiple agents independently arrived at |
| `memory_selfcheck` | Report the brain's calibrated self-competence in a domain |
| `memory_feedback` | Mark a recalled memory as helpful so the useful ones rank higher |
| `memory_conflicts` | Surface pairs of lessons different agents learned that assert opposite things about the same subject |
| `memory_audit` | Inspect the brain's own behaviour — what it stored, recalled, and learned, computed from the local store |
| `memory_correct` | Retract, amend or demote a memory that recall got wrong; nothing is deleted, and the reason is kept with it |

**Code Intelligence** (the code graph is AST-precise via web-tree-sitter, native-free):

| Tool | Description |
|------|-------------|
| `code_explore` | A symbol's source plus its direct callers and callees, in one call |
| `code_callers` | List the symbols that call a given symbol |
| `code_callees` | List the symbols a given symbol calls |
| `code_impact` | Transitive blast radius of changing a symbol — what could break |
| `code_search` | Locate any symbol by name across the codebase |
| `code_locate` | Predict WHERE an issue lives: ranked `{file, symbol, why:[past lessons]}` from an error/problem — crosses the memory↔code bridge |
| `test_coverage` | Which lines of a file its own tests cover, from the project's last coverage run |

**Gateway:**

| Tool | Description |
|------|-------------|
| `gateway_list_tools` | List the tools on the MCP servers you added in Settings → MCP Servers |
| `gateway_call` | Call one of those tools, under the gateway's policy |

**Token Headroom:**

| Tool | Description |
|------|-------------|
| `retrieve_full` | Expand a tool result that Token Headroom shortened |

**Linked Machines:**

| Tool | Description |
|------|-------------|
| `linked_machines` | Have a Claude, Codex or Gemini agent on another linked machine do a task headlessly and return its final answer (`list`, `run`, `result`) |

### CLI Tool

Control Termpolis from any terminal without the MCP protocol:

```bash
termpolis-cli health                    # Check if MCP server is running
termpolis-cli list                      # List all open terminals
termpolis-cli create "Dev" bash         # Create a new terminal
termpolis-cli run <id> "npm test"       # Run a command in a terminal
termpolis-cli read <id> 20              # Read last 20 lines of output
termpolis-cli close <id>                # Close a terminal
termpolis-cli files ~/projects          # List files at a path
termpolis-cli git ~/projects/myapp      # Get git status

# Shared memory — the same brain every Termpolis agent reads and writes.
# Reachable from a plain shell, so a CI job, a git hook, or a script can use it too.
termpolis-cli primer                    # Print the project primer for the current directory
termpolis-cli recall "auth retry bug"   # Search the shared memory brain
termpolis-cli remember "Deploys need VPN"   # Write one memory to the shared brain
```

### Authentication

The MCP server requires a Bearer token on all endpoints except `/health`. A random token is generated on each app launch and written to:

| Platform | Token file |
|----------|-----------|
| Windows | `%APPDATA%\termpolis\mcp-token` |
| macOS | `~/Library/Application Support/termpolis/mcp-token` |
| Linux | `~/.config/termpolis/mcp-token` |

```bash
# Read token and make an authenticated request
TOKEN=$(cat ~/.config/termpolis/mcp-token)
curl -H "Authorization: Bearer $TOKEN" http://localhost:9315/mcp \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

### Health Check (no auth required)

```bash
curl http://localhost:9315/health
# {"status":"ok","name":"termpolis-mcp","version":"1.2.0","tools":40,"auth":"required"}
```

## Security

Termpolis takes security seriously, especially with AI agent integration.

### MCP Server Security
- **Localhost only** — bound to `127.0.0.1`, never exposed to the network
- **Auth token required** — random 256-bit token generated on each app launch, required via `Authorization: Bearer` header on all endpoints except health check
- **CORS restricted** — no wildcard origins, preventing browser-based CSRF attacks
- **Token file permissions** — `600` (owner read/write only) on macOS/Linux; per-user `%APPDATA%` on Windows

### Application Security
- **Single-instance lock** — prevents session data corruption from multiple windows
- **Context isolation** — Electron's `contextIsolation: true` with `nodeIntegration: false`, all main process access via secure `contextBridge`
- **No remote code execution** — no `eval()`, no remote module loading, no `webSecurity` bypasses
- **Bundled tools verified** — jq, yq, and nano downloaded from official GitHub releases only

### No Plugin System — By Design
- Termpolis intentionally does **not** have a plugin or extension system
- Third-party plugins are a major attack surface — they run with full app permissions, can access terminals, read output, and execute commands
- Every feature in Termpolis is built-in, auditable, and ships with the app
- If you need custom behavior, fork the repo — the codebase is open source and well-documented
- **Safe Import does not change this.** It never loads third-party code *into Termpolis* — nothing imported executes inside the app, in a sandbox or otherwise. It is a gate on artifacts you were going to hand to **your agents** anyway: it scans the skill / plugin / command / subagent / MCP server, refuses to install a red one, and — only on your approval — writes it into the agents' own config directories (`~/.claude`, `~/.codex`, `~/.gemini`), which is exactly where you'd have put it by hand. Termpolis's own attack surface is unchanged.

### What Users Should Know
- Terminal sessions run with your user permissions — same as any terminal application
- AI agents launched through profiles (Claude Code, Codex, etc.) have the same access as if you ran them manually
- The MCP token rotates on every app restart — a compromised token becomes invalid when you close the app
- **As of v1.25 the security gates ship on by default** — the audit log (previously off, so for most installs it never existed), the commit/push secret shield, the egress guard, and the memory-at-rest scrub. An absent setting keeps the secure default, so upgrading an existing install turns them on without you touching Settings. Each can be disabled individually in **Settings → AI Security** — notably, if the commit shield ever blocks a commit you know is clean, that's the switch
- The commit shield **fails open**: if git errors out, the commit proceeds. It is a guard against accidents, not a guarantee that no secret can ever reach a remote
- No Termpolis telemetry unless you opt in — crash reports and anonymous usage statistics are two separate choices, both off by default — and no Termpolis cloud accounts. Termpolis stores everything (sessions, history, pins, audit log, settings) locally. (AI agents you launch still talk to their own providers per those providers' privacy policies; see [`PRIVACY.md`](PRIVACY.md) for the full data-flow spec.)

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- npm 9+
- **Windows only:** Visual Studio Build Tools (for native `node-pty` compilation)
- **Linux only:** `build-essential`, `python3` (for native module compilation)

### Install & Run

```bash
git clone https://github.com/codedev-david/termpolis.git
cd termpolis
npm install
npm run dev
```

### Run Tests

```bash
npm test
```

6,700+ total tests:
- `npm test` — 6,700+ unit & component tests (Vitest, 336 test files, 95%+ coverage)
- `npm run test:coverage` — unit tests with v8 coverage report
- `npx playwright test` — 75 E2E tests (Playwright, launches the actual Electron app)
- E2E tests capture 55 screenshots automatically in `e2e/screenshots/`

## Building from Source

### Windows (NSIS Installer)

```bash
bash scripts/download-tools.sh  # Download bundled CLI tools
npm run package
```

Output: `dist-electron-builder/Termpolis Setup X.X.X.exe`

### macOS (DMG)

```bash
bash scripts/download-tools.sh
npm run package
```

Output: `dist-electron-builder/Termpolis-X.X.X-arm64.dmg` and `Termpolis-X.X.X-x64.dmg`

> macOS builds must be run on macOS. Both Apple Silicon (arm64) and Intel (x64) DMGs are produced.

### Linux (AppImage)

```bash
bash scripts/download-tools.sh
npm run package
```

Output: `dist-electron-builder/Termpolis-X.X.X.AppImage`

> Linux builds must be run on Linux.

### CI/CD

The project includes a GitHub Actions workflow (`.github/workflows/release.yml`) that builds for all three platforms on tag push:

```bash
git tag v1.2.0
git push --tags
```

The workflow automatically downloads the latest bundled CLI tools before packaging.

## Architecture

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | [Electron](https://www.electronjs.org/) 30 |
| Build Tool | [electron-vite](https://electron-vite.org/) |
| Renderer | [React](https://react.dev/) 18 + TypeScript |
| Terminal Emulator | [xterm.js](https://xtermjs.org/) 5 + addons (fit, unicode11, web-links) |
| Shell Process | [node-pty](https://github.com/nickolasburr/node-pty) |
| State Management | [Zustand](https://zustand-demo.pmnd.rs/) |
| Code Editor | [Monaco Editor](https://microsoft.github.io/monaco-editor/) (lazy-loaded) |
| MCP Server | HTTP/SSE on localhost:9315 |
| Icons | [Font Awesome](https://fontawesome.com/) 6 |
| Styling | [Tailwind CSS](https://tailwindcss.com/) 3 |
| Testing | [Vitest](https://vitest.dev/) + React Testing Library |
| Packaging | [electron-builder](https://www.electron.build/) |

### Project Structure

```
termpolis/
├── src/
│   ├── main/
│   │   ├── index.ts                 # App entry, IPC handlers, single-instance lock, MCP server
│   │   ├── mcpServer.ts             # MCP protocol server (HTTP/SSE, JSON-RPC 2.0)
│   │   ├── agentCommandSanitizer.ts  # Swarm agent command enforcement (allowlist + flag stripping)
│   │   ├── terminalManager.ts       # node-pty wrapper + bundled tools PATH injection
│   │   ├── completionService.ts     # PATH scanning, file listing, env vars for autocomplete
│   │   ├── shellDetector.ts         # OS-aware shell discovery
│   │   ├── sessionStore.ts          # JSON session persistence with migration
│   │   ├── historyStore.ts          # Cross-terminal command history
│   │   ├── configFileManager.ts     # Read/write shell config files
│   │   ├── workflow/                # Workflow Orchestrator engine (steps, sandboxed expr, YAML store, IPC,
│   │   │                            #   cron parser + schedule/git/file trigger supervisor)
│   │   └── types.ts                 # Main process type definitions
│   ├── preload/
│   │   └── index.ts                 # contextBridge API + MCP event bridge
│   └── renderer/src/
│       ├── App.tsx                   # Root layout, session restore, global shortcuts
│       ├── store/
│       │   └── terminalStore.ts     # Zustand state (terminals, workspaces, pane tree, AI state)
│       ├── lib/
│       │   ├── agentDetector.ts     # Detect AI agents from terminal output
│       │   ├── costTracker.ts       # Parse token/cost from AI agent output
│       │   ├── conversationParser.ts # Parse AI conversations from terminal output
│       │   ├── sessionRecorder.ts   # Session recording buffer + export
│       │   ├── promptParser.ts      # Parse cwd and git branch from prompt output
│       │   ├── keybindings.ts       # Keybinding types, defaults, matching utilities
│       │   ├── outputThrottle.ts    # rAF-based write batching with 64KB rate limit
│       │   ├── exportTerminal.ts    # Buffer extraction + ANSI stripping
│       │   └── terminalDefaults.ts  # Default fontSize, theme, fontFamily
│       ├── themes/
│       │   └── terminalThemes.ts    # 7 curated xterm ITheme definitions
│       ├── completions/             # Autocomplete engine, input parser, spec loader, 20 specs
│       ├── corrections/             # Command correction engine + rules
│       └── components/
│           ├── Sidebar/             # Terminal tabs, AI profiles, git panel, workspace list, collapse
│           ├── SplitView/           # Split pane layout with draggable dividers
│           ├── TerminalPane/        # xterm.js terminal with all integrations
│           ├── CommandPalette/      # Natural language command bar (Ctrl+K)
│           ├── PromptTemplates/     # Reusable prompt snippets (Ctrl+Shift+P)
│           ├── Workflow/            # Workflow Orchestrator UI (designer, runner, sidebar)
│           ├── ContextPanel/        # File tree, git status, recent commits
│           ├── ConversationSearch/  # AI conversation history search
│           ├── DiffViewer/          # Syntax-highlighted diff rendering
│           ├── PinnedOutput/        # Persistent pinned output panel
│           ├── CompletionDropdown/  # Autocomplete dropdown overlay
│           ├── CommandFix/          # Inline correction banner
│           ├── StatusBar/           # App footer + per-terminal status bar
│           ├── SettingsPane/        # Settings + keybindings + Monaco config editor
│           └── HistorySearch/       # Command history search modal
├── tests/                           # Vitest test suites (7,000+ tests, 344 files, 97%+ coverage)
├── scripts/
│   └── download-tools.sh           # Download latest jq, yq, nano per platform
├── resources/tools/                 # Bundled CLI tool binaries (per platform)
└── .github/workflows/release.yml   # CI/CD: build all platforms on tag push
```

### Session Persistence

Session data is stored as JSON in the Electron `userData` directory:
- **Windows:** `%APPDATA%/termpolis/session.json`
- **macOS:** `~/Library/Application Support/termpolis/session.json`
- **Linux:** `~/.config/termpolis/session.json`

Saved state includes: workspaces with working directories, default shell, view mode, keybindings, AI profiles, and prompt templates.

**Loose terminals are deliberately not restored.** Every launch starts on a clean slate. Auto-restore resurrected shells whose processes were long dead and competed with workspaces for ownership of "which terminals are open" — saving a group of terminals for a project is a **workspace's** job, and a workspace is restored when *you* open it, never silently at boot.

Old sessions are automatically migrated — missing fields receive defaults on load.

## Sponsor

Termpolis is free, open source, and Apache 2.0 licensed. Building and maintaining it (including AI token costs for development) takes time and resources.

If you find Termpolis useful, please consider sponsoring:

**[Sponsor on GitHub](https://github.com/sponsors/codedev-david)**

## Bug Reports & Feature Requests

Found a bug or have an idea? Open an issue on GitHub:

**[Submit a Bug Report](https://github.com/codedev-david/termpolis/issues/new?template=bug_report.md&labels=bug)**

**[Request a Feature](https://github.com/codedev-david/termpolis/issues/new?template=feature_request.md&labels=enhancement)**

When reporting a bug, please include:
- Your OS (Windows/macOS/Linux) and version
- Termpolis version (shown in the title bar or `package.json`)
- Steps to reproduce the issue
- Expected vs actual behavior
- Screenshots if applicable

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Run tests: `npm test` (unit) and `npx playwright test` (E2E)
4. Commit changes (`git commit -m 'feat: add my feature'`)
5. Push to branch (`git push origin feature/my-feature`)
6. Open a Pull Request

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Companies are free to use, modify, and redistribute Termpolis, including in commercial products, with attribution.
