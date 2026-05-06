# Privacy Policy

**Termpolis — Secure AI-Assisted Development**
Last updated: May 5, 2026

## Overview

Termpolis is a desktop terminal management application that runs entirely on
your local machine. Your privacy is important to us, and Termpolis is designed
to keep your data local.

## Summary

- Termpolis does **not** run a Termpolis-hosted server. The app talks directly
  to whatever tools and services you run inside it (shells, AI agents, git,
  etc.).
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

Tools and AI agents you launch inside Termpolis (Claude Code, Codex, Gemini
CLI, Qwen Code, your own shells) make their own network requests according
to their own privacy policies. Termpolis does not proxy or intercept that
traffic.

## What We Never Collect

- Terminal input or output.
- Contents of files you open or edit.
- Your username, email, machine name, or hostname.
- Git repository contents, remotes, or commit metadata.
- AI agent prompts or responses.

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
- **Pre-paste secret scanner.** Regex-based detection of well-shaped
  secrets (AWS keys, GitHub PATs, OpenAI/Anthropic/Google API keys, JWTs,
  PEM private keys, `.env` assignments). Returns redacted preview.
- **Local audit log** (`ai-security-audit.jsonl` in `userData`) — every
  AI-agent terminal launch, optionally with byte counts and hit counts.
  Append-only, 10MB-rotated, wipeable from Settings.

The redaction scanner is **not a comprehensive DLP solution** — it targets
high-confidence patterns to keep false-positive rates low. Custom corporate
secrets must be vetted separately. See `TERMS.md` for the full liability
disclaimer.

## Third-Party Services

Termpolis integrates with third-party AI tools (such as Claude Code, OpenAI
Codex, Gemini CLI, and Qwen Code) that you choose to install and run
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
