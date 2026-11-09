# Privacy Policy

**Termpolis — Secure AI-Assisted Development**
Last updated: November 9, 2026 (per-message model routing decides on this computer and keeps only vectors of your corrections, never their text; an optional smaller context window for Claude Code reads the env and window keys of your Claude Code settings when a Claude terminal opens; the memory hook also runs on a session's first prompt, around a compaction and before a whole-file read, and sends what it reads only to Termpolis on this computer; the Claude Code compression proxy now shortens a tool result only from 40,000 characters by default and keeps a local comparison of that against the old behavior, and what it reads of each answer is described; the Activity Feed's local event log is described; Linked machines keeps a job history on the computer that runs the jobs, and screens prompts and answers for credentials on both computers; a terminal opened on an account reads that account's profile for its context window and its own routing; once your agents are connected, Termpolis copies Claude Code's saved notes into memory, and the memory brain's record of its own work is described, with a way to clear it)

## Overview

Termpolis is a desktop terminal management application that runs entirely on
your local machine. Your privacy is important to us, and Termpolis is designed
to keep your data local.

## Summary

- Termpolis does **not** run a server that holds your work. The app talks
  directly to whatever tools and services you run inside it (shells, AI
  agents, git, etc.). The one Termpolis-hosted service that exists is the
  **pairing relay** used by Termpolis Remote, and it only ever carries
  end-to-end encrypted frames it cannot read. It is off until you turn Remote
  on — see [Termpolis Remote and the Pairing
  Relay](#termpolis-remote-and-the-pairing-relay).
- Termpolis does **not** collect terminal contents, file contents, command
  history, file paths, usernames, or any data that would identify you.
- **Optional**, opt-in crash reports and anonymous usage statistics go to our
  error-tracking service (Sentry). They are two separate choices, both off
  until you tick them, and either can be turned on or off at any time in
  Settings → General → Privacy; a change applies at once.
- By default, Claude Code sessions that Termpolis launches send their API
  requests through a **compression proxy on your own machine** (`127.0.0.1`),
  which forwards them only to `api.anthropic.com`. You can turn it off in
  Settings → Token Savings — see [The Claude Code compression
  proxy](#the-claude-code-compression-proxy). Since v1.55 it shortens a tool
  result only from 40,000 characters by default, and keeps a comparison on your
  machine of that against the old behavior (Late or Legacy, your choice).
- Termpolis changes Claude Code, Codex and Gemini CLI settings **only if you
  connect them**, and the same goes for the profile of each account you add;
  Disconnect removes everything it wrote — see [Your coding agents'
  settings](#your-coding-agents-settings).
- **Optional, off by default:** a smaller context window for Claude Code
  (Settings → Token Savings → Long conversations). Only if you choose one,
  Termpolis reads two kinds of key in your Claude Code settings files when it
  opens a Claude terminal, to leave a window you set yourself alone. It writes
  nothing to them — see [A smaller Claude Code context
  window](#a-smaller-claude-code-context-window-opt-in).
- Once you have connected your agents, Termpolis also **reads Claude Code's saved
  notes** and keeps a copy in its own memory, so your other agents can find
  them. It never writes into Claude's folders and Termpolis sends nothing off
  your machine, but an agent that finds a note passes it to its own provider.
  You can switch it off and remove the copies — see [Claude Code's saved
  notes](#claude-codes-saved-notes).

## Data Stored Locally

Termpolis stores the following data locally on your machine to provide its
functionality. This data never leaves your computer unless you explicitly
upload it.

- Terminal sessions and buffered output (kept in memory + `userData` on disk).
- Command history (`history.jsonl` in `userData`).
- Shell and agent configuration files (`.bashrc`, `.zshrc`, PowerShell
  profiles, `~/.codex/config.toml`, etc.) that you edit through the Settings
  pane.
- Saved workspaces, keybindings, prompt templates, AI profiles, agent ratings,
  pinned context snippets, and swarm memory.
- The MCP auth token and port (written to `userData/mcp-token` and
  `userData/mcp-port` with `0600` permissions).
- Your privacy choices (`userData/telemetry.json`), and your answer about
  connecting your coding agents with a record of the folders Termpolis marked
  trusted for them (`userData/agent-integration.json`).
- Token Headroom's originals: the full text of each block Termpolis
  compressed, on the Claude Code proxy or in its own MCP tool output, so an
  agent can ask for it back with `retrieve_full` (`userData/headroom/ccr`, one
  file per block, capped at 200 MB, **not encrypted**), plus running counts of
  what was saved. Beside each original it keeps the name of the tool whose
  result it was, the model's name, how it was shortened (a window of it, a
  reference to a repeat, a patch against a near-repeat, or aged out of a long
  conversation), the two sizes (the original and what replaced it) and which
  first-sight setting the request ran under. It also keeps counts,
  by kind of tool and size of result, of how many results were shortened and how
  many of those the agent later asked back for
  (`userData/headroom/elision-ledger.json`), and cost counters for the two
  groups of conversations that Settings → Token Savings compares (inside
  `userData/headroom/proxy-totals.json`). Counts, sizes and names only, never
  the content of a conversation.
- For **Model per message** (Settings → General → Default Models), the local
  embedding model's vectors of the router's built-in examples
  (`userData/router-seeds.json`) and of the messages you correct with the pane
  header's **Should have been…** menu, each with the model you picked
  (`userData/router-examples.json`, the newest 300). A vector is a list of
  numbers, never the message's text. The decision is made on this computer and
  nothing is sent anywhere to make it; the proxy changes only the model named in
  the request it already forwards to Anthropic, and drops the
  `X-Termpolis-Terminal` header it uses to tell terminals apart before the
  request leaves this computer.
- The Activity Feed's event log (`userData/agent-events.jsonl`, plus
  `agent-events.jsonl.old` once it passes 5 MB), which Termpolis builds from
  the transcripts that Claude Code, Codex and Gemini CLI write: one line per
  event, with a short summary and a size-capped payload. It holds the name and
  input of each tool call, the first 200 characters of each message, whether a
  tool result was an error (not the result itself), token counts and
  compactions. A compaction event also holds the size of the conversation when
  Claude Code compacted and whether it chose to. It stays on your machine and
  is not sent anywhere.
- If you turn on **Termpolis Remote**: this desktop's X25519 identity key
  (`userData/remote-identity-key`, encrypted at rest through the OS keystore —
  DPAPI on Windows, Keychain on macOS, libsecret on Linux), one record per
  paired device (`userData/remote-devices.json`: its label, its public key, the
  capabilities you granted it, and when it paired and was last seen), and the
  Remote settings themselves (`userData/remote-settings.json`).
- If you turn on **Linked machines**: its settings (`userData/linked-settings.json`),
  the links and what each linked computer may do here (`userData/linked-machines`,
  encrypted at rest through the OS keystore where one is available), and a job
  history (`userData/linked-jobs.jsonl`, plus `linked-jobs.prev.jsonl` once it
  passes 2 MiB): one line when another computer starts a job here, one when it
  ends and one when a request is refused, with the computer's name, the agent,
  read-only or edit, the folder, the first line of the screened prompt (at most
  80 characters, with anything that might be a credential taken out), the
  credential rules matched, how it ended and why a request
  was refused. Never the prompt or the answer.
- If you add **accounts** (Settings → Accounts): the accounts you registered
  (`userData/agent-accounts.json`). For each one: its name and color, the email
  you gave it, its profile folder and the links Termpolis made in it, its place
  in the order, whether it is offered automatically when another account runs
  out of usage, and whether you connected it. Also how it came to be (made by
  Termpolis, adopted, imported from `accounts.sh` under its key there, or a
  label), and when its settings were last copied from your main profile. Also
  the account new terminals
  start on; what each agent last said when Termpolis asked who is signed in
  (signed in or not, and the email and plan it reported); and the last usage
  limit each account hit: the agent's own words, when it resets, and the email
  of the sign-in it hit, kept until the next limit replaces it, you mark the
  account available, or you remove it. Never a sign-in, a token or a key: those
  stay in each agent's own profile, where the agent keeps them. Claude Code's
  own `.claude.json` can hold an Anthropic Console key; from that file Termpolis
  reads only the email of the account signed in there, besides the entries it
  writes itself, and never copies it. See [Signing in to an
  account](#signing-in-to-an-account).
- What the memory brain recorded about its own work (`userData/memory-audit.jsonl`
  and `userData/memory-audit-main.jsonl`, each with a `.prev.jsonl` copy once it
  passes 2 MB; the memory process writes the first and the main process the
  second): a line for each memory stored (its kind, which agent stored it and a
  clipped preview of its text, with anything that might be a credential taken
  out; no preview at all for a lesson held back as a candidate or a note copied
  from Claude Code's folders), each recall (the agent filter the search named, if
  any, how many memories it found and the ids of the top few), each context
  digest handed to an agent (its approximate size) and each learning pass (its
  kind and a one-line note, which for a commit or test run says whether it passed
  and how many memories it touched, never which project). Never what an agent
  asked for: the text of a search or a request is not kept. The `memory_audit`
  tool reads it back to an agent that asks, without the previews: an agent is
  told what was stored and by which agent, never the words.
- The lessons Termpolis writes down after a finished session, in swarm memory
  like any other memory. Since 1.55.0 a lesson that says nothing a later reader
  could use, such as "Root cause found." or a progress note, is not stored. One
  on the borderline is stored marked as a candidate: the Memory panel shows it
  and no agent is ever given its words (the activity record above notes only
  that it was stored). How many were not stored is counted in
  `userData/memory-metrics.jsonl`. A one-time re-check of the lessons already
  stored lowers the rank of those it would now refuse (recorded in
  `userData/memory-corrections.jsonl`; nothing is deleted) and leaves a marker,
  `userData/mneme-lesson-recheck-v2.json`, so it runs once.
- Claude Code's saved notes, once imported (see [Claude Code's saved
  notes](#claude-codes-saved-notes)): copies of their text in swarm memory like
  any other memory, and a record of what was copied
  (`userData/claude-notes-manifest.json`): each note's file name, size and
  modified time and a hash of its content, the ids and hashes of the memory
  entries made from it, the working directory each project folder was matched
  to, when the last pass ran and how many secrets it redacted.

The `userData` directory lives at:

- **Windows**: `%APPDATA%\termpolis`
- **macOS**: `~/Library/Application Support/termpolis`
- **Linux**: `~/.config/termpolis`

You can delete that directory at any time to wipe every piece of local state
Termpolis has kept.

## Network Requests Termpolis Makes

Termpolis itself only makes network requests for:

1. **Auto-updates** — on launch and every four hours, the app checks GitHub
   Releases for a newer version of Termpolis and, if available, downloads the
   signed installer in the background. The only data sent in this request is
   what every HTTPS client sends (user agent, your IP address to GitHub's
   servers).
2. **Crash reports** (opt-in only) — if you ticked _Send crash reports_ on the
   tour's last step or in Settings → General → Privacy, a report goes to our
   error-tracking service (Sentry) when something goes wrong: the error with
   its stack trace and the app events just before it, the app version, and
   basic system details (OS, Electron version, CPU, memory, screen size).
   Before it is sent, your home-folder paths become `<home>`, your user name
   becomes `<user>`, and the machine name, locale, time zone, cookies and URL
   query strings are removed. A report never includes a memory dump
   (minidump), a screenshot, local variables, the source code around the
   error, or console output. The same choice covers unclean exits, swarm
   errors, and update failures other than a lost connection, a full disk or a
   read-only install location (one report per kind of failure per version).
   Nothing is sent before you tick it, and nothing saved up is sent after you
   untick it.
3. **Usage statistics** (opt-in only) — if you ticked _Send anonymous usage
   statistics_, once a day the app sends a one-line "launched" event carrying
   only the Termpolis version (with the event's timestamp and a random event
   ID), so we can count active installs. Nothing about you, your files or your
   terminals. Short app events (for example, that a swarm started) are
   recorded only while this is on, and they leave the machine only inside a
   crash report.

4. **The pairing relay** (only if you turn on Termpolis Remote) — a WebSocket
   connection to the relay address in Settings, `wss://relay.termpolis.com` by
   default. Everything sent over it is encrypted end to end between your
   desktop and your phone; the relay sees an opaque room id, a frame size and a
   timestamp. Details in the next section. When Remote is off, this connection
   is never opened.

5. **Claude Code's own API requests** (while the compression proxy is on) —
   forwarded to `api.anthropic.com` and nowhere else. See [The Claude Code
   compression proxy](#the-claude-code-compression-proxy).

Tools and AI agents you launch inside Termpolis (Claude Code, Codex, Gemini
CLI, your own shells) make their own network requests according
to their own privacy policies. Termpolis does not intercept that traffic, with
one exception you can turn off: the Claude Code compression proxy.

### The Claude Code compression proxy

By default, each Claude Code session Termpolis launches sends its API
requests to a small proxy on your own machine (`127.0.0.1`). The proxy shrinks
tool-result text (large file reads, command output, search results, MCP
results) and pasted images, then forwards the request to `api.anthropic.com`
and nowhere else. It never rewrites a tool call's input: what Claude asked a
tool to do — a command, a file edit, a subagent prompt — is forwarded
byte-for-byte, however old it is. The full text of each compressed block stays
on your machine (see [Data Stored Locally](#data-stored-locally)) so the agent
can ask for it back; none of it is sent to Termpolis.

- **Turn it off** in Settings → Token Savings (the tour's last step and the
  one-time privacy review offer the same switch). New Claude Code sessions
  then talk to Anthropic directly; a session that is already running keeps
  its route until it ends.
- **Your own route wins.** If `ANTHROPIC_BASE_URL`, `HTTPS_PROXY`,
  `HTTP_PROXY` or `ALL_PROXY` (upper- or lower-case) is set, or Claude Code is
  switched to Bedrock, Vertex or Foundry (`CLAUDE_CODE_USE_BEDROCK`,
  `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`) — in Termpolis's
  environment or in the `env` block of Claude Code's own `settings.json`
  (`~/.claude/settings.json`) — the proxy steps aside. Claude Code keeps the
  route you configured, nothing is compressed, and Settings → Token Savings
  shows which variable it found.
- Codex, Gemini CLI and your shells never go through it.
- **When it shortens a tool result.** Since v1.55 the proxy leaves a tool
  result whole until it reaches 40,000 characters and shortens it from there
  (Settings → Token Savings → Shorten tool results: **Late**, the default).
  Choose **Legacy** and it shortens from the size of your tier, as v1.54 did. A
  change applies the next time Termpolis starts. Repeats still collapse and old
  history still ages out under both.
- **A comparison on your machine.** About one distinct opening message in ten,
  chosen by a hash of the conversation's first message, computed on your
  machine and kept for as long as that message stays the same (a compaction
  summarizes the start of a conversation, so a compacted one can be assigned
  again), always runs the Legacy behavior whichever setting is on, so that
  Termpolis can compare the two on your own work (the Elision health card).
  Which group a request belonged to is recorded with its cost, locally. The
  comparison is computed locally and nothing about it is sent anywhere.
- **What it reads of the answer.** The proxy also reads each answer as it
  streams back, for Anthropic's token counts and the names of the tools the
  model called, for whether the answer finished (a finished answer ends with a
  `message_stop` event, one the API broke off carries an `error` event), and
  for a ToolSearch call whether its query asks for `retrieve_full`. That is how
  Termpolis counts the turns that only fetched shortened text and the ToolSearch
  calls that led to them, and counts none for an answer that did not finish,
  since the client asks again. It keeps counts only, and forwards the answer to
  Claude Code unchanged.

## Signing in to an account

When you sign an account in from Termpolis (its card in Settings → Accounts,
the account menu, a switch or the usage-limit card), Termpolis runs **that
agent's own sign-in command** (`claude auth login`, `codex login`, or agy's own
`/logout` and `/login` when you switch Gemini CLI to another Google account) in
a hidden session of its own, with the account's profile folder, and shows what
the agent asks in a sheet: its sign-in choices as buttons, the address it
printed, a field for a code.

- The session is not a terminal: it is never in your terminal list, a
  workspace, the phone app or a swarm, and no agent, tool or MCP call can read
  it or type into it. Termpolis types into it only what you choose in the
  sheet: the option you click, a code you paste, the Google Cloud project you
  name, and the keys you type yourself after **Let me type here** (offered only
  when Termpolis can't read the agent's screen); and, for a Gemini CLI switch
  you confirmed, agy's own `/logout` and `/login`, and `/exit` once it is signed
  in again.
- **The browser is opened by the agent**, as when you sign in at a prompt.
  Termpolis opens an address itself only when you click Open again, and only
  the agent's own sign-in page (an `https` address on Anthropic's, OpenAI's or
  Google's sign-in host).
- **A code you paste goes to the agent and is not kept.** The field is cleared
  as you submit it; the code is never held by the page, written to a file, put
  in a log or sent anywhere else. Termpolis holds it in memory only to mask it
  where it shows on the agent's own screen, and forgets it when the session
  ends.
- **Nothing the session shows is logged.** The app log records only which
  account a sign-in was for and how it ended (signed in, canceled, an error).
  If the agent fails, its own words are shown to you in the sheet, masked for
  anything that looks like a credential, and kept nowhere.
- When the agent says it is done, Termpolis asks it who is signed in
  (`claude auth status`; for Codex, `codex login status` and Codex's own app
  server, for the email and plan) and keeps the email and plan it reports, as
  above. agy has no such command: Termpolis shows the email agy itself prints
  on its screen, and keeps none. Then the session ends, and its processes with
  it. Closing the sheet, the window, or Termpolis ends it too.

## What We Never Collect

- Terminal input or output.
- Contents of files you open or edit.
- Your username, email, machine name, or hostname.
- Git repository contents, remotes, or commit metadata.
- AI agent prompts or responses.

That list is unchanged by Termpolis Remote: the relay described below carries
ciphertext we cannot open, and we do not keep it.

## Termpolis Remote and the Pairing Relay

**Termpolis Remote** is a separate companion app for iPhone and Android that
lets you read and type into terminals already running on your desktop. It is
**off by default**. Until you turn Remote on in Settings and pair a device,
none of what follows happens at all.

The phone is a pass-through. It runs no agent, holds no memory, holds no
embeddings and holds no model credentials — the desktop keeps running the
agent it was already running, under the account it was already signed in to.
The desktop decides what a paired phone may do: reading, creating a terminal,
typing into an existing terminal and closing a terminal are four separate
grants, all off until you turn them on, revocable at any moment, and re-checked
on the desktop for every request.

### The relay

The phone and the desktop are usually on different networks, so they meet in a
room on a relay we operate (`wss://relay.termpolis.com` by default — the
address is a setting, and you can point it at your own). The relay is built so
that trusting it is not required:

- Every message is **end-to-end encrypted** between your phone and your
  desktop: X25519 key agreement, HKDF-SHA256 derivation, ChaCha20-Poly1305
  authenticated encryption. The keys are derived at pairing time from both
  devices' identities. The relay does not hold them and cannot derive them.
- What the relay can see is an **opaque room identifier, the size of each
  frame, and its timing**. Not your terminal, not what you typed, not what came
  back.
- The relay **stores no messages and keeps no traffic logs**. It forwards a
  frame to the other end of the room and forgets it; a room with nobody in it
  is discarded.
- Transport is TLS and the payload inside it is sealed separately. Both layers
  would have to fail to expose anything.
- When you pair, both screens show the **same eight words**, derived from the
  two device keys. They match only if nothing is sitting in the middle.
  Comparing them takes a couple of seconds and is the whole verification.

### What the phone stores

Its own private key, in the operating system's keystore (iOS Keychain /
Android Keystore), marked available only while the device is unlocked and not
backed up to another device; and one pairing record per desktop — that
desktop's public key, a session identifier, the relay address, a device id and
the name shown for it in the app. A phone may be paired with several desktops
(a work machine and a home one, say) and keeps a separate record, and a
separate private key, for each; they are written to the keystore individually,
so forgetting one leaves the others untouched. That is the whole list. Terminal output reaches the phone
encrypted, is held in memory while the app is open, and is never written to
disk. The camera is used for exactly one thing, scanning the pairing code your
desktop displays; frames are decoded on the device and discarded.

The phone app has no account, no analytics SDK, no crash reporter, no
advertising identifier and no server of ours that it talks to. Unpairing —
from either end — erases the key material for that desktop, and that channel
cannot be re-opened without pairing again; any other desktops the phone is
paired with are unaffected.

The combined policy covering the desktop app, the phone app and the relay
together is published at <https://termpolis.com/privacy.html>.

## AI Security Center (Settings → AI Security)

Starting in v1.11.43, Termpolis ships an in-app **AI Security Center** that
gives administrators verifiable controls over outbound AI traffic. None of
these features send data to Termpolis or any third party — every check runs
locally and every log stays on the machine.

- **Per-agent training-disposition facts**, sourced from the published
  commercial-tier ToS pages of each provider. Updated with each release.
- **Gemini account-mode auto-detection.** Reads
  `GEMINI_API_KEY` / `GOOGLE_API_KEY`, `GOOGLE_GENAI_USE_GCA`,
  `GOOGLE_APPLICATION_CREDENTIALS`+`GOOGLE_CLOUD_PROJECT` to identify whether
  the Gemini CLI will use a paid tier (training-excluded) or fall back to
  free OAuth (which Google may use for product improvement).
- **Strict Mode — block free-tier Gemini.** When enabled, Termpolis
  intercepts `gemini` invocations from any terminal and refuses to forward
  them unless paid-tier credentials are detected.
- **Auto-scan on every prompt.** Once the user types `claude`, `codex`,
  `gemini` in a terminal, every subsequent keystroke is staged
  in main-process memory and scanned with a 70+ rule regex catalog
  on each Enter or paste-sized chunk (≥32 bytes). Hits are redacted in
  place before reaching the PTY, audited as `redaction_hit` events, and
  surfaced via a dismissable banner in the renderer. Catalog covers AWS
  (access keys, secrets, session tokens), GitHub (classic + fine-grained
  PATs, OAuth client secrets), GitLab, Bitbucket, Azure (Storage, SAS,
  AD client secret, DevOps PAT, connection strings), GCP (service-account
  JSON, OAuth client IDs), AI providers (OpenAI, Anthropic, Google AI,
  HuggingFace, Cohere, Replicate), payments (Stripe, PayPal Braintree,
  Square), comms (Slack, Discord, Telegram, Twilio, SendGrid, Mailgun,
  Mailchimp, Postmark), cloud (Cloudflare, DigitalOcean, Heroku, Netlify,
  Vercel, Fly.io, Render, Pulumi), CI/CD (CircleCI, Travis, Codecov),
  observability (Sentry DSN, Datadog, New Relic, Rollbar, Honeycomb,
  Mapbox, Okta, Auth0), package registries (npm, PyPI, Docker Hub),
  secrets vaults (HashiCorp Vault, Doppler, 1Password Connect), database
  connection strings (Postgres, MySQL, MongoDB, Redis), HTTP basic-auth
  URLs, JWTs, PEM/GPG private key blocks, and the `.env`-style catch-all.
- **Manual pre-paste scanner.** The Settings → AI Security panel includes
  a paste-and-scan box and a "Scan clipboard" button for one-off checks.
- **Local audit log** (`ai-security-audit.jsonl` in `userData`) — every
  AI-agent terminal launch, optionally with byte counts and hit counts.
  Append-only, 10MB-rotated, wipeable from Settings.
- **Linked machines.** A prompt or an answer passed between two of your
  computers is screened with the same rules on both: a credential whose own
  shape names it (a vendor token such as `sk-ant-` / `ghp_` / `AKIA`, a
  private-key block) is replaced with `[REDACTED:<rule>]` before it leaves and
  again when it arrives; a value that only looks like one (a password in a test
  fixture, a URL with a user and password) is left in and named in a note to
  the agent. Each finding adds a line to the audit log on the computer that
  screened it, with the rule ids and counts only, never the value.

The redaction scanner is **not a comprehensive DLP solution** — it targets
high-confidence patterns to keep false-positive rates low. Custom corporate
secrets must be vetted separately. See `TERMS.md` for the full liability
disclaimer.

## Third-Party Services

Termpolis integrates with third-party AI tools (such as Claude Code, OpenAI
Codex, Gemini CLI) that you choose to install and run
independently. These tools have their own privacy policies and may
communicate with their respective cloud services. Termpolis does not control
these communications and intercepts none of them, apart from the optional
Claude Code compression proxy described above, which shrinks what is sent,
reads the token counts and tool names of each answer as it streams back
(counts only), and forwards the request to Anthropic and nowhere else.
Otherwise it simply provides a terminal environment in which these tools run.

Any data exchanged between AI tools and their cloud services is governed by
the respective provider's privacy policy:

- [Anthropic (Claude)](https://www.anthropic.com/privacy)
- [OpenAI (Codex)](https://openai.com/privacy)
- [Google (Gemini)](https://policies.google.com/privacy)

## Your coding agents' settings

Termpolis can connect Claude Code, Codex and Gemini CLI to its memory and code
search. It asks first — on the first step of the first-run tour, or in
Settings → Agent Integration — and shows exactly what it would change for each
agent installed on this machine. Nothing is written until you finish or skip
the tour; both boxes start ticked, and skipping keeps what is shown.
Connected, Termpolis:

- **Claude Code** — adds the Termpolis MCP server to your user config
  (`.claude.json`); lets 27 read-only and memory tools run without asking
  (`settings.json`), while tools that run commands or type into terminals
  still ask; and marks folders you open agents in as trusted, never your home
  folder or a drive root. Optionally, it adds a SessionStart hook to
  `settings.json` that loads your project memory whenever a Claude Code
  session starts, including sessions started outside Termpolis. The hook
  does nothing once Termpolis is gone. From 1.55.0 the same hook script is
  also registered for UserPromptSubmit, PreCompact, PostCompact and
  PreToolUse (Read only). On a session's first prompt, and on the last prompt
  again right after Claude Code compacts, it sends the prompt text (with
  credentials redacted) to Termpolis's own control server on this computer
  (127.0.0.1), which classifies it in memory to pick memory notes and to offer
  a better-fitting model; the text is never stored and never sent anywhere
  else. PreCompact prints a short instruction for Claude Code's summary and
  sends nothing. Before Claude Code reads a whole file, the Read hook sends the
  file's path, and nothing of its contents, to the same local server, which
  answers with an outline of the file when it is over 1,500 lines. When a
  Claude terminal is launched with the model set to Auto, Termpolis sets
  `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` for that terminal, unless your own
  environment already sets it. No output-style file is written: shorter
  answers come from the steering lines the compression proxy already adds.
- **Codex** — adds the Termpolis MCP server to `config.toml`, pre-approves
  the 14 memory tools unless you already chose a setting for them, and
  answers the folder-trust prompt for folders you open agents in, never your
  home folder or a drive root. Its memory instruction is passed on the launch
  command, for that session only; nothing is written into your projects.
- **Gemini / Antigravity CLI** — adds the Termpolis MCP server to the Antigravity
  CLI's `~/.gemini/config/mcp_config.json`, and lets the same read-only and memory
  tools Claude Code gets run without asking, in
  `~/.gemini/antigravity-cli/settings.json`. It also adds the server to Gemini
  CLI's `settings.json`, for the older CLI.

All of this stays on your machine. **Disconnect** in Settings → Agent
Integration removes everything Termpolis wrote, and so does uninstalling on
Windows or removing the Linux .deb (`sudo apt remove termpolis`); on any
platform, `Termpolis --disconnect-agents` does the same from the command line.
One limit: Disconnect un-trusts only the folders this version marked trusted.
Trust an older Termpolis version added can't be told apart from trust you
accepted yourself, so it stays.

Whatever you choose, this version also cleaned up once after older versions:
it removed a permission that let every Termpolis tool run without asking,
Termpolis's duplicate Claude Code plugin, its entry in `~/.mcp.json`, and trust
for your home folder or a drive root. Older versions also wrote a memory note
into `AGENTS.md` in project folders; Termpolis removes that note (and the file,
if the note was all it held) the next time you launch Codex from Termpolis in
that folder.

### More than one account

If you add accounts in Settings → Accounts, each Claude Code or Codex account
gets a profile folder of its own: a new one, such as `~/.claude-work` or, for
Codex, `~/.codex-work`, or one you already have. Termpolis starts the agent
there by setting `CLAUDE_CONFIG_DIR` or `CODEX_HOME` on the command it types
into the terminal. The setting stays in that terminal's shell, so an agent you
start there later runs on the same account. Each account signs in by itself,
in Termpolis's sign-in sheet (see [Signing in to an
account](#signing-in-to-an-account)).

A new folder shares some subfolders with your main profile through links, which
you can untick when you add the account. For Claude Code these are `projects`
(your conversations and Claude's own memory, so a conversation can continue on
another account), `commands`, `skills` and `agents`; for Codex, `sessions`.
Unless you untick it, Termpolis also copies your main `settings.json` and
`CLAUDE.md` (for Codex, `config.toml`) into the new folder once. The copy leaves
out the settings that are meant to hold a key or a token, and names them: for
Claude Code an `env` block and the key and credential helpers, for Codex MCP
servers and the headers, bearer tokens and query parameters of a model provider
or a telemetry exporter. It copies the rest as it is, so a command in a `hooks`
or `statusLine` entry that has a key typed into it is copied with it: look at
those two before you rely on the copy. Termpolis never copies, links or reads a
sign-in.

When you switch a conversation to an account whose `projects` folder isn't
shared, Termpolis copies that one conversation's transcript into the other
profile's folder, so the agent can continue it there. A copy already there is
replaced only when it is older and no longer; otherwise it is kept beside the
new one.

When you connect an account, Termpolis writes into that profile what it writes
into your main one, listed above; the Add account sheet lists it first.
Termpolis's memory is shared by every connected account, and an account you
don't let Termpolis offer automatically, such as a work account, isn't connected
unless you tick Connect for it. Learning still reads its conversations, connected
or not; remove the account to stop that. Termpolis's learning reads the conversations in
each registered Claude Code and Codex account's profile, as it reads your main
profile's.

To tell which account a profile is signed in to, Termpolis reads the email
address Claude Code keeps in that profile's `.claude.json`, whenever it shows
your accounts: when it starts, when you open Settings → Accounts or a
terminal's account menu, and after a change or a switch. It asks the agent
itself (`claude auth status`; for Codex, `codex login status` and Codex's own
app server, for the email and plan) only when you press Check, after a sign-in,
before a switch, and when an agent runs out of usage, for the accounts it could
offer. Except right after a sign-in, it never asks while a Termpolis terminal
runs on that account, since a check could refresh the sign-in that terminal
uses. An agent may contact its provider to answer, as it does when it starts.

Disconnect and uninstalling take Termpolis's entries out of every account's
profile. The profile folders, and the sign-ins in them, stay.

### A smaller Claude Code context window (opt-in)

Off by default. In Settings → Token Savings → Long conversations you can pick a
smaller window (500,000, 400,000, 300,000 or 200,000 tokens) at which Claude
Code compacts a long conversation into a summary. If you do, Termpolis adds
Claude Code's own `CLAUDE_CODE_AUTO_COMPACT_WINDOW` variable to the environment
of the terminals it opens for Claude Code, and to every terminal created through
Termpolis's MCP `create_terminal` tool: the terminals a swarm starts for its
workers, terminals an agent opens, and the shell a paired phone opens (the
command is not known yet when such a terminal is created, so all of them get
it; Codex and Gemini CLI never read it). Not to the other shells you open
yourself, and not to a terminal that is already open. The variable is read by
Claude Code on your machine. Nothing about it is sent to Termpolis or to anyone
else, and it does not use the compression proxy.

To leave a window you set yourself alone, Termpolis checks whether you already
have one, and only while this choice is on and only when it opens a terminal it
sets the variable for. It looks in your environment, then reads three files if
they exist: `settings.json` in Claude Code's config folder (`~/.claude`, or the
folder `CLAUDE_CONFIG_DIR` names in Termpolis's own environment; for a terminal opened on an account, that account's profile folder instead) and
`.claude/settings.json` and `.claude/settings.local.json` in the folder the
terminal opens in (the home folder, if the folder it was asked to open in has
been deleted: that is where the terminal opens then). From each it keeps two
things and drops the rest on the
spot: the value of the window variable in the `env` block (no other entry of
that block, which can hold keys of its own) and whether a window is saved
(`autoCompactWindow`, or the one `/autocompact` saves per model). Your
permissions, hooks, helpers and the rest of those files are not kept, not
logged and not sent anywhere, and Termpolis writes nothing to them. If a window
is already set in any of those places, Termpolis sets none. A file that is not
there, or is not valid JSON, counts as holding nothing, as it does for Claude
Code. A file that is there but cannot be read, because another program has it
locked for a moment, is tried once more; if it still cannot be read Termpolis
sets none, since it cannot tell. A file larger than 1 MiB is not read at all and
counts the same way: Claude Code would read it and Termpolis cannot tell what
window it holds, so it sets none.

It does not see every place a window can live. Claude Code lets this variable
win over a window saved in a subagent's definition, in a `--settings` argument
or in your organization's managed settings, none of which Termpolis reads (that
includes the managed-settings file), and a
`CLAUDE_CONFIG_DIR` that a script sets inside the terminal (to switch accounts,
say) names a folder Termpolis did not check. An `env` entry that sets the
variable itself in a `--settings` argument or in managed settings is different:
Claude Code writes it over the value Termpolis passed, so that one wins. Turn
the choice Off first if you rely on any of them. If you also set
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, it is a percentage of the window in force, so
with a smaller window compaction comes sooner than you chose. Claude Code's
subagents use the variable's window too, so they compact sooner as well, and
`/autocompact` typed inside a session is reported as overridden and not saved
while the window is on. Anthropic does not say what a resumed conversation that
is already longer than the window does. A Claude session
the Workflow Orchestrator's agent steps start themselves gets neither this
variable nor the proxy route.

It is yours to turn off: choose Off, and new terminals go back to Claude Code's
own behavior. Nothing is read while it is Off.
## Claude Code's saved notes

Claude Code keeps what it learns about a project as small markdown notes in its
own folder, `~/.claude/projects/<project folder>/memory/*.md`. Only Claude can
see them, and only in that project. Since 1.55.0, while you have connected your
coding agents (Settings → Agent Integration) and **Include Claude Code's saved
notes in memory** is on (Settings → Memory & Learning; on by default), the
indexer that already reads your agents' session history every 30 minutes reads
these notes too. An install that an older version connected, and that you have
not yet been asked about (the one-time review), does not count as connected for
this: it starts when you answer yes. An install that you had connected with a
yes before 1.55.0 is not asked again: it starts with the first pass after the
update (about ten seconds after Termpolis starts, while memory is unlocked).
Turn the switch off to stop it, and use *Remove imported notes* to take out the
copies.

- **What it reads.** The project folders under `~/.claude/projects`; in each,
  the names, sizes and modified times of the `.md` files in its `memory`
  folder, and the text of the ones that are new or changed. It skips
  `MEMORY.md` (an index of the others), files over 64 KB, binary files, links
  that lead outside the projects folder, and anything past 2,000 files. To find
  out which project a folder belongs to it also lists that folder's session
  files with their modified times (at most 5,000 of them), reads the first
  256 KB of the three newest and keeps only the working directory they record;
  the rest of a session is not used for this. For a project folder it has
  read notes from before, and for no other, a pass that finds its `memory`
  folder gone also lists the names of the folder's other entries, to tell a
  deleted notes folder from one it cannot read.
- **What it writes.** A copy of each note's text in Termpolis's memory, in
  pieces of at most 1,800 characters, under the project the folder belongs to,
  after the same secret redaction every memory gets, and the record listed
  under Data Stored Locally. Nothing is written into Claude Code's folders. An
  edited note updates its copy and a deleted one removes it, as does deleting a
  project's whole `memory` folder.
- **Who sees the copies.** Every agent you connected can find them through the
  memory tools (`memory_search`, `memory_list`, `memory_primer`) in that same
  project, so Codex and the Antigravity CLI get what Claude knew. One project's
  notes never go into another project's launch summary. Whether a search in one
  project may also return up to two general notes (the kinds `reference`,
  `feedback` and `user`, never notes about one project's own state) from
  another project is a separate choice, **Let general notes help in other
  projects**, and it is off until you turn it on. Notes from sessions you ran in
  your home folder belong to no project, so a search that names a project is
  never lent them. A search or a listing that
  names no project, and a walk of the knowledge graph, returns no saved note
  unless you turn that choice on, and then only those kinds; the rest of memory
  it covers as it did before.
- **Where it goes.** Termpolis sends nothing off your machine. But an agent that
  finds a note receives its text like any other memory and passes it to its own
  provider (Anthropic for Claude Code, OpenAI for Codex, Google for the
  Antigravity CLI), under that provider's policy. That is the point of the
  feature, and also why it is a choice: if you do not want another vendor's agent
  to see what Claude kept, turn the import off and remove the copies. The copies
  are part of your memory like any other, so they go anywhere else only if you
  move your memory yourself, with a brain export, say, or hand a job to another
  of your computers: that computer starts it with its own memory, and its answer
  can quote what it holds, a saved note among it, back to the computer that
  asked. A computer that imports such a brain export does not count the copies
  as its own. If it has imported notes before and its record of them is whole,
  they stay beside its own copies. If its record is new, lost, or was left
  unfinished by an interrupted pass, its next pass, while its own saved-notes
  import is on, removes every copy it cannot account for (those included) and
  imports its own from the notes on that computer. Turning the import off first
  keeps them for as long as it stays off.
- **Undo.** *Remove imported notes* (Settings → Memory & Learning) takes every
  copy out of memory (the ones a brain import brought in as well) and turns the
  import off; Claude's own notes are not touched. Turning the switch off stops
  the reading and leaves the existing copies until you remove them.
  Disconnecting your agents stops it too, and a locked memory pauses it; copies
  that could not be removed because memory was locked are removed by the next
  indexer pass once it opens. If Termpolis
  cannot read its settings file (a write cut short by a crash, say), it leaves
  the import off until you turn it on again, and a switch it could not save is
  reported as an error, not shown as changed (*Remove imported notes* then
  removes nothing, and says so). When memory cannot be searched all the way
  through at that moment (the memory process is busy, say), a copy this
  computer had lost track of may be missed; Settings says so, and choosing
  *Remove imported notes* again finds it.

## Your Choices

- **Stop Termpolis reading Claude Code's saved notes** — turn off *Include
  Claude Code's saved notes in memory* in Settings → Memory & Learning, and use
  *Remove imported notes* there to take out the copies already made.
- **Clear the record of what memory did** — Settings → Memory & Learning →
  *Activity record* has a *Clear activity record* button. It asks first, then
  removes `memory-audit.jsonl`, `memory-audit-main.jsonl` and their `.prev.jsonl`
  copies from the data folder and nothing else; no memory is touched, and the
  record starts again from then on. The record itself has no switch.
- **Turn crash reports or usage statistics on or off** — Settings → General →
  Privacy has a switch for each. Both are off unless you turn them on, and a
  change applies at once.
- **Turn the compression proxy off** — Settings → Token Savings. New Claude
  Code sessions then go straight to Anthropic.
- **Switch tool-result shortening between Late and Legacy** — Settings → Token
  Savings → Shorten tool results. It applies the next time Termpolis starts.
  The comparison group (about one opening message in ten, which always runs the
  old behavior) cannot be switched off while Late is on; it is what lets the
  app tell you whether Late helps on your work, and it stays on your machine.
- **Turn the smaller context window off** — Settings → Token Savings → Long
  conversations → Off. New terminals then go back to Claude Code's own
  behavior.
- **Disconnect your coding agents** — Disconnect in Settings → Agent
  Integration removes everything Termpolis wrote into their settings. Folders
  trusted before v1.49 stay trusted (see above).
- **Forget an account** — **Remove…** on its card in Settings → Accounts
  forgets the account, and takes Termpolis's entries out of its profile
  folder. The folder and the sign-in in it stay: Termpolis never deletes a
  profile folder, because some of its subfolders are links into your main
  profile. The documentation (Removing an account) says how to remove the links
  first, if you delete the folder yourself. Your main profile has no entries of this kind: it stays connected
  through Agent Integration, and Disconnect there removes them.
- **Delete local data** — quit Termpolis and delete the `userData` directory
  listed above.
- **Uninstall** — remove Termpolis through your OS's normal application
  uninstall flow. On Windows the uninstaller disconnects your coding agents
  first, and so does removing the Linux .deb; on macOS and with the Linux
  AppImage, use Disconnect (or run `Termpolis --disconnect-agents`) before you
  remove the app.
- **Turn Termpolis Remote off** — it is off to begin with. Once on, unticking
  it in Settings → Remote stops the bridge and closes the relay connection.
- **Cut a phone off** — revoke the device in Settings → Remote, or unpair from
  the phone. Either end is enough: the channel cannot be re-opened without
  pairing again from both. Each desktop is its own pairing, so revoking on one
  machine does not touch the phone's link to any other.
- **Use your own relay** — the relay address is a setting. Point it at a
  deployment of `relay/` you run, and no traffic touches ours.

## Children's Privacy

Termpolis is a developer tool and is not directed at children under 13. We do
not knowingly collect information from children.

## Changes to This Policy

If this privacy policy is updated, the revised version will be posted in the
application's repository. Material changes will be announced in the release
notes for the version that introduces them.

## Contact

If you have questions about this privacy policy, please open an issue at
<https://github.com/codedev-david/termpolis/issues>.
