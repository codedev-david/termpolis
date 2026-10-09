# Privacy Policy

**Termpolis — Secure AI-Assisted Development**
Last updated: October 8, 2026 (connecting Gemini now reaches the Antigravity CLI's own config; crash reports and usage statistics are separate opt-ins; connecting your coding agents is asked, not assumed; the Claude Code compression proxy)

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
  proxy](#the-claude-code-compression-proxy).
- Termpolis changes Claude Code, Codex and Gemini CLI settings **only if you
  connect them**, and Disconnect removes everything it wrote — see [Your
  coding agents' settings](#your-coding-agents-settings).

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
  what was saved.
- If you turn on **Termpolis Remote**: this desktop's X25519 identity key
  (`userData/remote-identity-key`, encrypted at rest through the OS keystore —
  DPAPI on Windows, Keychain on macOS, libsecret on Linux), one record per
  paired device (`userData/remote-devices.json`: its label, its public key, the
  capabilities you granted it, and when it paired and was last seen), and the
  Remote settings themselves (`userData/remote-settings.json`).

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
Claude Code compression proxy described above, which only shrinks what is
sent and forwards it to Anthropic. Otherwise it simply provides a terminal
environment in which these tools run.

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
  does nothing once Termpolis is gone.
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

## Your Choices

- **Turn crash reports or usage statistics on or off** — Settings → General →
  Privacy has a switch for each. Both are off unless you turn them on, and a
  change applies at once.
- **Turn the compression proxy off** — Settings → Token Savings. New Claude
  Code sessions then go straight to Anthropic.
- **Disconnect your coding agents** — Disconnect in Settings → Agent
  Integration removes everything Termpolis wrote into their settings. Folders
  trusted before v1.49 stay trusted (see above).
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
