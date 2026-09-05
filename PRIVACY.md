# Privacy Policy

**Termpolis — Secure AI-Assisted Development**
Last updated: September 5, 2026 (Termpolis Remote and the pairing relay)

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
- **Optional**, opt-in crash reporting sends anonymous error stack traces and
  the app version to our error-tracking service (Sentry). It is off by default
  and can be turned on or off at any time in Settings.

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
2. **Crash reports** (opt-in only) — if you opted in during onboarding or via
   Settings, anonymous error stack traces are sent to our error-tracking
   service. The payload contains: the error message, the JavaScript call
   stack, the app version, the platform, and a random non-reversible session
   ID. Before the report is sent, any Windows user-folder paths in
   breadcrumbs are redacted to `C:\Users\<redacted>`.

3. **The pairing relay** (only if you turn on Termpolis Remote) — a WebSocket
   connection to the relay address in Settings, `wss://relay.termpolis.com` by
   default. Everything sent over it is encrypted end to end between your
   desktop and your phone; the relay sees an opaque room id, a frame size and a
   timestamp. Details in the next section. When Remote is off, this connection
   is never opened.

Tools and AI agents you launch inside Termpolis (Claude Code, Codex, Gemini
CLI, your own shells) make their own network requests according
to their own privacy policies. Termpolis does not proxy or intercept that
traffic.

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
backed up to another device; and the pairing record — the desktop's public
key, a session identifier, the relay address, a device id and the label you
gave the desktop. That is the whole list. Terminal output reaches the phone
encrypted, is held in memory while the app is open, and is never written to
disk. The camera is used for exactly one thing, scanning the pairing code your
desktop displays; frames are decoded on the device and discarded.

The phone app has no account, no analytics SDK, no crash reporter, no
advertising identifier and no server of ours that it talks to. Unpairing —
from either end — erases the key material, and the channel cannot be re-opened
without pairing again.

The combined policy covering the desktop app, the phone app and the relay
together is published at <https://termpolis.com/privacy.html>.

## AI Security Center (Settings → Security)

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
- **Manual pre-paste scanner.** The Settings → Security panel includes
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
or intercept these communications — it simply provides a terminal environment
in which these tools run.

Any data exchanged between AI tools and their cloud services is governed by
the respective provider's privacy policy:

- [Anthropic (Claude)](https://www.anthropic.com/privacy)
- [OpenAI (Codex)](https://openai.com/privacy)
- [Google (Gemini)](https://policies.google.com/privacy)

## Your Choices

- **Turn crash reporting off** — open Settings and toggle _Send anonymous
  crash reports_ off. The change takes effect on the next launch.
- **Delete local data** — quit Termpolis and delete the `userData` directory
  listed above.
- **Uninstall** — remove Termpolis through your OS's normal application
  uninstall flow.
- **Turn Termpolis Remote off** — it is off to begin with. Once on, unticking
  it in Settings → Remote stops the bridge and closes the relay connection.
- **Cut a phone off** — revoke the device in Settings → Remote, or unpair from
  the phone. Either end is enough: the channel cannot be re-opened without
  pairing again from both.
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
