# Termpolis Documentation

The definitive guide to Termpolis — **Secure AI-Assisted Development**. The local-first multi-agent terminal where Claude, Codex, and Gemini work as a team, coordinated by a dedicated AI conductor, **without your source code leaving the machine**.

This document covers installation, the AI Security Center, the share-to-Slack/Teams workflow, every feature, every panel, every keyboard shortcut, and the architecture behind the swarm. Screenshots live in `../e2e/screenshots/docs/` and are mirrored to the website at `termpolis-web/docs/screenshots/`.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Installation](#2-installation)
3. [First Launch & Welcome Screen](#3-first-launch--welcome-screen)
4. [The Sidebar](#4-the-sidebar)
5. [Terminals](#5-terminals)
6. [Tab & Split Views](#6-tab--split-views)
7. [Settings](#7-settings)
8. [Themes](#8-themes)
9. [Keybindings](#9-keybindings)
10. [Agent Capability Ratings](#10-agent-capability-ratings)
11. [Command Palette](#11-command-palette)
12. [Prompt Templates](#12-prompt-templates)
13. [Workflow Orchestrator](#13-workflow-orchestrator)
14. [Context Panel](#14-context-panel)
15. [History Search](#15-history-search)
16. [Conversation Search](#16-conversation-search)
17. [Git Panel](#17-git-panel)
18. [AI Agent Profiles](#18-ai-agent-profiles)
19. [MCP Server](#19-mcp-server)
20. [Swarm Dashboard](#20-swarm-dashboard)
21. [AI Conductor](#21-ai-conductor)
22. [Activity Feed](#22-activity-feed)
23. [Intervention Controls](#23-intervention-controls)
24. [Swarm Review Panel](#24-swarm-review-panel)
25. [Persistent Memory](#25-persistent-memory--the-growing-brain)
26. [Observability](#26-observability)
27. [Status Bar](#27-status-bar)
28. [Troubleshooting](#28-troubleshooting)
29. [Termpolis Remote (phone app)](#29-termpolis-remote-phone-app)
30. [Linked machines](#30-linked-machines)
31. [Architecture](#31-architecture)
32. [Keyboard Shortcut Reference](#32-keyboard-shortcut-reference)

---

## 1. Overview

![Welcome screen](../e2e/screenshots/docs/01-welcome-screen.png)

Termpolis is a cross-platform desktop terminal manager (Windows, macOS, Linux) built on Electron + React + TypeScript with `node-pty` powering the underlying shells. It ships as a native app — code signed on Windows, notarized on macOS.

**What makes it different:**

- **Secure AI-Assisted Development**: a built-in AI Security Center (Settings → AI Security) auto-scans every AI prompt against 90+ secret patterns (AWS, GitHub, Azure, GCP, Stripe, Slack, JWT, PEM, …), can block free-tier Gemini launches (Strict Mode, off by default), keeps a local JSONL audit log, and surfaces per-provider training-disposition facts sourced from live ToS pages. See the [Security](#security-center) section.
- **Multi-agent swarm**: Claude Code, Codex, and Gemini CLI work together on a task. A dedicated Claude Code instance acts as the conductor.
- **MCP server** baked in: AI agents can control Termpolis via Model Context Protocol — open terminals, run commands, send messages.
- **Transparent routing**: every subtask shows *which* agent got it, *why*, and *what it cost*.
- **Activity observability**: every token, every tool call, every message from every agent is visible in real time.
- **Intervention controls**: pause, cancel, or steer any agent mid-task without leaving the feed.
- **Shared memory**: a RAG-backed memory store that any agent can read and write via MCP.
- **MCP-native end to end**: all three agents speak MCP — no terminal-output bridges, no parser glue, no special-case code paths.
- **Share-ready output**: three fixed copy shortcuts turn any terminal selection into plain text, a Slack/Teams-ready message, or a code block for a PR. See [Copy for Slack / Teams / PRs](#copy-for-slack--teams--prs).

Everything is built around the idea that **you're not writing code alone anymore** — you're orchestrating a team, and you need the tools to do it well, securely.

## Security Center

The **AI Security Center** at Settings → AI Security is the security backbone of Termpolis. Every check runs on the local machine. None of these features send data to Termpolis or any third party.

- **Per-provider training-disposition facts.** Live ToS-sourced summaries: Claude (default off), Codex (default off), Gemini paid (excluded), Gemini free OAuth (Google may use prompts, flagged yellow).
- **Prompt watching (always on).** Once you launch `claude`, `codex`, or `gemini` in a terminal, every Enter and every paste-sized chunk (32+ characters) is scanned in main-process memory against the same secret rules Commit Shield uses. The scan works on a copy: your text reaches the agent unchanged, never modified, delayed or held back. A hit is recorded in the audit log as a `prompt_secret_sent` event (the rule and the variable name, never the value) and shown in a dismissable banner that names what was sent, so you know what to rotate. The catalog covers AWS (access/secret/session), GitHub (classic/fine-grained/OAuth/runner), GitLab, Bitbucket, Azure (Storage, SAS, conn-string, AD client secret, DevOps PAT), GCP (SA JSON, OAuth client), AI providers (OpenAI, Anthropic, Google, HuggingFace, Cohere, Replicate), payments (Stripe, PayPal Braintree, Square), comms (Slack, Discord, Telegram, Twilio, SendGrid, Mailgun, Mailchimp, Postmark), cloud (Cloudflare, DigitalOcean, Heroku, Netlify, Vercel, Fly.io, Render, Pulumi), CI/CD (CircleCI, Travis, Codecov), observability (Sentry DSN, Datadog, New Relic, Rollbar, Honeycomb, Mapbox, Okta, Auth0), package registries (npm, PyPI, Docker Hub), secrets vaults (HashiCorp Vault, Doppler, 1Password Connect), database connection strings (Postgres/MySQL/MongoDB/Redis), HTTP basic-auth URLs, JWTs, PEM/GPG private key blocks, and the `.env`-style catch-all. Non-AI terminals are not scanned (zero overhead). A manual paste-and-scan box is also available in the Settings panel.
- **Gemini account-mode auto-detection.** Reads `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_USE_GCA`, and `GOOGLE_APPLICATION_CREDENTIALS`+`GOOGLE_CLOUD_PROJECT` to identify which tier the Gemini CLI will hit (Vertex / Code Assist / Paid API key / Free OAuth).
- **Strict Mode — block free-tier Gemini.** When ON, Termpolis intercepts shell-level `gemini` invocations and refuses to forward them unless paid-tier credentials are detected. Blocked launches are recorded in the audit log as `BLOCKED: strict-mode + free-tier`.
- **Local JSONL audit log.** On by default: AI-agent terminal launches and closes, secrets sent in a prompt, Commit Shield results and other security events are appended to `ai-security-audit.jsonl` in the data directory. Append-only, rotated at 10 MB. You can turn it off or wipe it in Settings → AI Security.
- **Legal disclaimer.** Apache 2.0 "AS IS". Full disclaimer in `TERMS.md` §5a and inline in Settings → AI Security.

## Copy for Slack / Teams / PRs

Copying is keyboard-driven: select text in a terminal, then press one of three shortcuts. They are fixed (they can't be remapped), and the terminal's right-click menu lists them as a reminder.

- **Copy** (`Ctrl+Shift+C`) — the selection as plain text.
- **Copy for Teams/Slack** (`Ctrl+Shift+K`) — the selection as a chat message: tight line breaks, emoji kept, no code box.
- **Copy as Code Block** (`Ctrl+Shift+Q`) — the selection as a code block: formatted HTML plus a fenced markdown copy, so it pastes cleanly into Slack, Teams, GitHub, GitLab or Notion.

---

## 2. Installation

### Download

Grab the latest build from the [Termpolis website](https://termpolis.com/#downloads) or directly from [GitHub Releases](https://github.com/codedev-david/termpolis/releases/latest).

| Platform         | File                                     | Signed        |
|------------------|------------------------------------------|---------------|
| Windows          | `termpolis-setup-<ver>.exe`             | ✅ Code-signed |
| macOS (Apple Si) | `termpolis-<ver>-arm64.dmg`             | ✅ Notarized   |
| macOS (Intel)    | `termpolis-<ver>.dmg`                    | ✅ Notarized   |
| Linux            | `termpolis-<ver>.AppImage`              | —              |

### Requirements

- **Windows**: 10 or 11 (x64)
- **macOS**: 11 (Big Sur) or later — Apple Silicon and Intel builds both ship
- **Linux**: AppImage runs on any modern glibc distro
- **Disk**: ~200 MB
- **RAM**: 512 MB minimum; 2 GB recommended when running multiple agents

### First run

On first launch, Termpolis creates its data directory:

| Platform | Path                                               |
|----------|----------------------------------------------------|
| Windows  | `%APPDATA%\termpolis\`                              |
| macOS    | `~/Library/Application Support/termpolis/`          |
| Linux    | `~/.config/termpolis/`                              |

Inside you'll find `session.json` (your workspaces, tabs, and open terminals) and later `swarm-memory.jsonl` (shared agent memory). Delete either file to reset that layer without losing the app.

---

## 3. First Launch & Welcome Screen

![Welcome screen — full](../e2e/screenshots/docs/01-welcome-screen.png)

The welcome screen is where you start from when no terminals are open. It shows:

- **New Terminal** — opens the new-terminal modal, where you pick the shell and theme.
- **Launch AI Agent** — a picker for Claude Code, OpenAI Codex and Gemini CLI. Agents that aren't installed are marked **Install**; click one to see how to install it.
- **Start Swarm** — coordinate several agents on a new or existing project (see [Swarm Dashboard](#20-swarm-dashboard)).
- **Tips and shortcuts** — a line of highlights (the command palette, split panes, smart routing, the MCP server, session recording) and the shortcuts for the observability panels: activity feed, redundancy, efficiency and swarm.

Press **`Ctrl+Shift+T`** (`⌘⇧T` on macOS) to open the new-terminal modal from anywhere, or **`Ctrl+K`** for the command palette.

### The first-run tour

The first time you open Termpolis, a six-step tour walks you through it: connecting your coding agents, what Termpolis is, setting an API key, launching your first agent or swarm, security, and your privacy choices.

- **Connect your coding agents** (first step) shows exactly what Termpolis would change for each of Claude Code, Codex and Gemini CLI installed on this machine. It has two boxes, both ticked to start: one connects the agents, the other adds the optional SessionStart hook (**Also load project memory when any Claude Code session starts**). Nothing is written to an agent's settings until you finish or skip the tour — see [Connecting your coding agents](#connecting-your-coding-agents).
- **Your privacy choices** (last step) has two separate boxes, one for crash reports and one for anonymous usage statistics, which start unticked, plus the switch for the [Claude Code compression proxy](#token-savings--the-claude-code-compression-proxy).
- **Skip tour** (or `Esc`) closes the tour at once and keeps the choices exactly as shown. On a first run, that means your agents are connected and nothing is sent.

Reopen it any time with **Show tour again** in the Help drawer. If you updated from a version before v1.49, Termpolis asks the two questions once instead, in two short reviews — your coding agents first, then privacy — and sends no crash reports or usage statistics until you answer.

---

## 4. The Sidebar

![Sidebar — default state](../e2e/screenshots/docs/02-sidebar-default.png)

The sidebar is the navigation spine of the app. From top to bottom:

1. **Toolbar** — **Settings**, **Split View** / **Tab View** (switches between the two), **Git Panel**, **Swarm Dashboard** and **Collapse sidebar**. A collapsed sidebar shows only an **Expand sidebar** button.
2. **AI Agents** — launch Claude Code, Codex or Gemini CLI, or add a custom profile with **+**.
3. **Workspaces** — one row per saved workspace. Click one to reopen its set of terminals (see [Workspaces](#workspaces)).
4. **Workflows** — your saved workflows, with **Start Workflow** to create one (see [§13](#13-workflow-orchestrator)).
5. **Terminals** — one row per open terminal, with **+ Add Terminal** below the list.

### Workspaces

Workspaces are **saved sets of terminals**: snapshots of your terminal layout that you can bring back with one click. They're handy for switching between projects, say a "Frontend" workspace with Node and build terminals and a "Backend" one with API and database terminals.

**What a workspace saves:** each terminal's name, shell, working directory, color, theme and font, and the AI agent it was running, if any. It doesn't save output or running processes, so restoring a workspace starts fresh sessions.

**Saving a workspace.** With at least one terminal open, click **+ Save Workspace** in the sidebar's Workspaces section, give it a name, and press **Save**.

**Restoring a workspace.** Click a workspace to close the terminals you have open and reopen its saved set. Each terminal starts in its saved working directory, and a terminal that was running an AI agent starts that agent again.

**Managing workspaces.** Each workspace row has buttons to **update** it with your current terminals, **rename** it, and **delete** it. Workspaces are kept in `session.json` in the Termpolis data directory (see [§2](#2-installation) for the per-platform path), with the rest of your session.

**How workspaces differ from workflows.** A workspace is a saved set of terminals; a workflow is a *pipeline of steps* the app executes for you. A workflow never rearranges your terminals — it runs its steps, streams their output, and records the result. See [§13](#13-workflow-orchestrator).

---

## 5. Terminals

![New terminal modal](../e2e/screenshots/docs/03-new-terminal-modal.png)

Every pane in Termpolis is a full pty-backed terminal powered by `node-pty`. That means xterm-compatible escapes, real TTY semantics, signal forwarding — not a shim.

### Creating a terminal

`Ctrl+Shift+T` opens the New Terminal dialog (shown above). Fill in:

- **Name + color**: help you tell terminals apart in split view.
- **Folder**: where the terminal starts. It begins as the active terminal's folder. If you leave it empty, or the folder doesn't exist, the terminal starts in your home folder.
- **Shell**: whichever your system has of PowerShell, Command Prompt and Git Bash on Windows, or Zsh, Bash and PowerShell on macOS and Linux. It begins as your default shell.
- **Font size, theme and font family**: begin as the terminal defaults from Settings → General.

To open a terminal with an AI CLI already running, use **Launch AI Agent** instead. See [AI Agent Profiles](#18-ai-agent-profiles).

### Running terminal

![Terminal running](../e2e/screenshots/docs/04-terminal-running.png)

Once running, the terminal supports:

- Copy with `Ctrl+Shift+C`, or with `Ctrl+C` while text is selected, and paste with `Ctrl+V` or `Ctrl+Shift+V`. On macOS, `⌘C` and `⌘V`.
- Mouse scroll, and links you can click to open.
- Full 256-color + truecolor palettes.
- Right-click for a context menu: the three copy shortcuts, **Paste**, **Select All**, **Find...**, **Export Full Scrollback...** and **Export Visible Output...**, **Start Recording**, **Pin Selection** (keeps the selected text pinned above the terminal until you unpin it), **View as Diff**, and in split view **Split Right** and **Split Down**.

### Close confirmation

Closing a single terminal doesn't ask first: it ends whatever is running in it. Closing Termpolis while AI agents are running shows **AI Agents Running**, where you choose **Cancel** or **Close Anyway**.

---

## 6. Tab & Split Views

![Tab view with multiple terminals](../e2e/screenshots/docs/05-tab-view-multiple.png)

Terminals are shown in one of two view modes.

### Tab view (default)

The active terminal fills the window. Switch terminals by clicking one in the sidebar's **Terminals** list, with `Alt+1`…`Alt+9`, or with `Ctrl+Tab` / `Ctrl+Shift+Tab`.

### Split view

![Split view](../e2e/screenshots/docs/06-split-view.png)

Every open terminal gets its own pane, sized evenly. Each pane's header has **Split Right** and **Split Down**, which open a new terminal with the same shell and folder beside or below it; the terminal's right-click menu has them too. Splits nest, so you can split a split. Drag a divider to resize. Click a pane to make it the active terminal, and use the close button in its header (or `Ctrl+Shift+W`) to close it.

### Switching views

Click **Split View** / **Tab View** in the sidebar toolbar, press `Ctrl+Shift+G`, or run **Toggle Split View** from the command palette (`Ctrl+K`). Termpolis remembers the view when you restart it, and lays split panes out evenly again.

---

## 7. Settings

![Settings panel](../e2e/screenshots/docs/07-settings-panel.png)

Open with the gear icon at the top of the sidebar, or choose **Open Settings** in the command palette (`Ctrl+K`). `Ctrl+/` opens it straight on the Keybindings tab. Settings takes the place of the terminals in the main area until you close it, and the installed version and a **Check for updates** button sit at the top. Tabs across the top group the settings:

- **General** — Safe Import (scan a third-party skill, plugin or MCP server before you install it), the default shell, terminal defaults (theme, font size, font family), naming agent terminals after their folder, whether terminal apps may capture the mouse, memory recall on agent launch, **Import / Export Memory**, and **Privacy**: crash reports and anonymous usage statistics are two separate switches, both off unless you turn them on, and a change applies at once (details in `PRIVACY.md`).
- **Memory & Learning** — the memory dashboard: what is stored and where it came from, the knowledge graph, learning over time, self-competence by domain, receipts, and every recent memory operation. It also shows whether memory runs in its own process, and can store vectors as int8 to use 4× less RAM.
- **AI Security** — Strict Mode, the Gemini account mode, what each agent does with your data, always-on prompt watching (it records a secret you send to an agent but never changes or holds back what you type), Commit Shield and its git hooks (block a commit or push that carries a secret), Egress Guard (flags agent traffic to unexpected hosts), memory scrub (redacts secrets before they are stored), the always-on background watchers, the cloud-bound audit log, and a manual pre-paste secret scan.
- **Voice** — voice dictation: the on/off switch, your Groq API key, hold or tap activation, and auto-submit (see [Voice Dictation](#voice-dictation)).
- **Keybindings** — rebind the core shortcuts, and add custom shortcuts that type a snippet into the active terminal (see [§9](#9-keybindings)).
- **Agent Ratings** — score each agent from 1 to 5 in 10 categories; the swarm conductor uses the scores when it hands out work (see [§10](#10-agent-capability-ratings)).
- **Shell Config** — edit your shell profiles in a built-in editor: the PowerShell 7 and 5 profiles on Windows, plus `.bashrc`, `.bash_profile` and `.zshrc`.
- **Token Savings** — Token Headroom, including the switch for the Claude Code compression proxy (see [below](#token-savings--the-claude-code-compression-proxy)).
- **Remote** — let the Termpolis Remote phone app connect, set the relay address, and pair a phone (see [§29](#29-termpolis-remote-phone-app)).
- **Agent Integration** — whether Claude Code, Codex and Gemini CLI are connected to Termpolis, every change Termpolis made to their settings, and **Disconnect** (see [Connecting your coding agents](#connecting-your-coding-agents)).
- **MCP Servers** — the MCP servers your agents reach through Termpolis, what each agent on this machine has configured for itself, and the gateway policy for a tool call that no rule covers.
- **Processes** — find and end what is quietly slowing the machine down (see below).

Changes save immediately. There is no "apply" button, except in the Shell Config editor, which writes a profile only when you press **Save**.

### Token Savings — the Claude Code compression proxy

By default, each Claude Code session Termpolis launches sends its API requests through a small compression proxy on your own machine (`127.0.0.1`), which forwards them to `api.anthropic.com` and nowhere else. It shrinks tool results — large file reads, command output, search results, MCP results — and pasted images, and the agent can call `retrieve_full` to get any compressed block back in full. It never rewrites a tool call's input: what Claude asked a tool to do — a Bash command, a file edit, a subagent prompt — is forwarded byte-for-byte, however old it is. Codex, Gemini CLI and your shells never go through the proxy.

- **Turn it off** with **Route new Claude Code sessions through the local compression proxy** in Settings → Token Savings (the tour's last step and the one-time privacy review offer the same switch). New sessions then talk to Anthropic directly; a session that is already running keeps its route until it ends.
- **Your own route wins.** If `ANTHROPIC_BASE_URL`, `HTTPS_PROXY`, `HTTP_PROXY` or `ALL_PROXY` (upper- or lower-case) is set, or `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` or `CLAUDE_CODE_USE_FOUNDRY` is on — in Termpolis's environment, or in the `env` block of Claude Code's own `settings.json` (`~/.claude/settings.json`, or the one in your `CLAUDE_CONFIG_DIR`) — the proxy steps aside. Settings → Token Savings names the variable it found; Claude Code keeps the route you configured, and nothing is compressed.
- **Age out old history** (on by default) swaps old tool results in very long conversations for stubs that `retrieve_full` expands. It never ages out the result of a `retrieve_full` or memory call.
- The full text of every compressed block stays on your machine, **unencrypted**, in `headroom/ccr` in your data directory (capped at 200 MB).

### Processes (stuck-process cleanup)

Headless AI runs, hooks and crashed sessions can leave processes behind that hold memory, CPU and file handles long after anyone needs them. The **Processes** tab lists them in three groups:

- **Headless AI agents** — Claude Code (`-p`, `--print`, stream-json, `mcp serve`), Codex (`exec`, `app-server`, `mcp-server`) and Gemini CLI (`-p`, `--acp`) running non-interactively, including ones started through `node`, `npx` or `python` — by a script, hook, scheduled job or swarm worker, by an editor or app that drives it and may be using it right now (an IDE extension, an MCP or ACP client), or by hand in a terminal. Interactive sessions in a terminal are not listed.
- **Git** — git that is frozen (Windows), lost the program that started it, or has run for more than 30 minutes. Git daemons (fsmonitor, credential cache, `cat-file --batch`) are not listed, and neither is git someone is using: `git gui`, `gitk`, `git difftool` or `git mergetool`, or git waiting on a common pager or editor.
- **Leftover shells & tools** — shells, `cmd /c` / PowerShell wrappers, MCP servers, console hosts and tools whose parent is gone, or (on Windows) that are frozen. A wrapper is listed only while it still runs something. On macOS and Linux, where closing a terminal or a GUI launcher orphans everything it started, an orphaned shell, wrapper or tool is listed only while its tree still holds git, a headless agent or an MCP server.

Each row shows who started it (Termpolis, another program, or *parent exited*), age, CPU time, memory, any child processes, and the command line. For a shell left by an agent's Bash tool, the command that tool actually ran is shown instead of the harness around it. Common secret formats (tokens, passwords, URL credentials, auth headers and cookies) are masked, best effort, and your home folder is shortened to `~`.

A **STUCK** badge marks what is usually safe to end: something that serves no TCP port, has nothing interactive open in it (see below), and is either frozen on Windows (every thread suspended, in a process over a minute old — Git Bash can leave a git or jq frozen for good when the script that started it exits at the wrong moment) or orphaned: the program that started it has exited. Only a process's own state counts: a frozen process inside a healthy tree gets a row of its own, so it never marks the tree around it stuck. On macOS and Linux a stopped git is listed after 30 minutes but not marked stuck while the shell that stopped it is still running, since it is usually a job paused with Ctrl+Z. An orphaned headless agent is only marked stuck once it has been running for an hour, since it may be a deliberate `nohup` job — a scan keeps no history, so how long ago it lost its parent is not known. An orphaned git is only marked stuck once it has run for 30 minutes, since it may be a long clone, and never for being orphaned when it is git's own `gc` or `maintenance`, which detaches on purpose and ends by itself. Any other orphan (a shell, wrapper, tool or MCP server with no git or headless agent in its tree) counts as soon as it is listed. An orphan is listed only once it is 5 minutes old, except a headless agent (always listed) and, on Windows, a frozen process (listed once it is a minute old). Stuck is judged from process state alone, so a download or script you detached on purpose looks the same — check the command before you kill.

Some processes are never taken for orphans. On macOS a running launchd job (a LaunchAgent) was started by launchd, not adopted by it. On Linux everything inside a systemd service counts as that service's job, and a process stays in its service when its parent dies, so the service's own processes and anything they leave running (on Debian and Ubuntu, whatever a cron job started) are never taken for orphans and never marked stuck. On Windows, a Git Bash program whose Windows parent has exited (Git Bash starts each stage of a pipeline that way) is traced to its real parent with that Git install's own `ps`, so a pipeline that is still running is never taken for an orphan; when that cannot be confirmed, the program is not marked orphaned and a note says so.

Anything listening on a TCP port is never marked stuck — it may be a server you started on purpose — but only TCP counts: a server on UDP, a named pipe, a Unix socket or stdio can still be marked stuck. If the port table cannot be read in full (netstat on Windows, lsof on macOS or ss on Linux failed, is missing or timed out), nothing is marked stuck and a note says so. A process tree that holds something a person is using — an agent CLI open in a terminal, a git GUI or merge tool (`git gui`, `gitk`, `git difftool`, `git mergetool`), or a common pager or editor — is never marked stuck, and is not listed for being orphaned or for being long-running git. A headless agent is the exception to the second part: every headless agent is listed, so one that holds something in use still appears, and can still show *parent exited* and the *orphaned* or *long-running* reasons — it is just never marked stuck.

**Kill selected** and **Kill all stuck** end the whole process tree after an inline confirmation. Before anything is signalled, each target is checked again against a fresh scan by pid *and* start time, and skipped (and reported) if it has exited, is still running but no longer listed, or its pid now belongs to a different process; **Kill all stuck** also skips anything that is no longer stuck. Anything not skipped is ended together with the child processes that the fresh scan finds under it. On macOS and Linux a kill is SIGTERM, then SIGKILL after 3 seconds. A git killed mid-write can leave a stale `.git/index.lock` — delete it if the next git command complains.

Scanning happens only when the tab opens or you press **Refresh**, never on a timer. Termpolis itself, the programs that launched it, and its own windows and terminal shells are never listed. Processes in other Windows sessions (other users' processes on macOS and Linux) are not listed; elevated ones can only be killed from an elevated Termpolis.

---

## Voice Dictation

Talk instead of type. Transcription uses **Groq's cloud Whisper API** — your recorded audio is sent to Groq for transcription. It is **off by default** and opt-in; turn it on in **Settings → Voice** and connect a Groq API key.

**Engine.** Transcription runs on **Groq's hosted Whisper API** (`whisper-large-v3-turbo` by default; `whisper-large-v3` is selectable for maximum accuracy). The call happens in Termpolis's **main process**, so your **API key never enters the renderer** — it is validated when you connect and stored encrypted in your **OS keychain** (Windows DPAPI / macOS Keychain / Linux libsecret), never in settings or logs. Groq is fast (~200–300 ms for a short clip) and cheap: the **free tier** covers everyday dictation, and paid is about **$0.04 per hour of audio**.

**How to use it.**

- **Hold `Ctrl+Shift+L` and speak; release to send** (true push-to-talk). Prefer hands-free? Switch to **tap-to-start / tap-to-stop** under *Activation*. The hotkey is rebindable.
- **Wait for the "Listening…" badge, then speak normally.** Level doesn't matter much — the model handles quiet and loud speech — but it does need to actually hear words.
- **In an AI-agent terminal** (Claude · Codex · Gemini) your words are **sent straight to the agent as a prompt** — the agent absorbs minor mis-hearings, so just talk naturally. (Optionally auto-submit so the prompt sends the moment you finish.)
- **In a plain shell** the transcript is **inserted but never run automatically** — you review it and press `Enter` yourself, so a mis-heard command is never executed for you.
- When dictation ends the caret returns to the terminal so you can keep typing or dictate again without clicking back in.

**"No speech detected."** If the microphone captured silence or no clear speech, Termpolis shows a brief **"No speech detected"** notice and does nothing — it will **never inject a guessed phrase** when it didn't actually hear you. (This is what eliminates the old "I'm sorry, what is that?" phantom transcripts: on no-speech audio a speech model invents filler, so Termpolis gates that out at the source — and silence is never sent to Groq, since the speech/noise gate runs locally first.) Just hold the key, speak, and release again. To improve capture, speak after the badge appears and reduce background noise; the model itself is robust to volume.

**Privacy & reliability.** Only the few seconds you actually dictate are sent, and only to Groq — never your files, terminal output, or other context. By default Groq **does not train on or retain** API audio; for the hardened setup, enable **Zero Data Retention** in your Groq console (the Connect dialog links you straight there). The transcript Groq returns is re-scanned by the secret scanner before it's injected, the same as anything else you send to an agent. If transcription fails, the red error bar tells you what went wrong — usually a missing/invalid key (**Settings → Voice**) or no internet connection.

---

## 8. Themes

![Themes picker](../e2e/screenshots/docs/08-themes-picker.png)

Termpolis ships seven terminal themes: **Dark** (default), Light, Solarized Dark, Solarized Light, Monokai, Dracula and Nord. A theme sets the terminal's background, foreground, cursor, selection and 16-color ANSI palette; the app chrome around the terminals keeps its own colors.

- **Default for new terminals:** Settings → General → Terminal Defaults.
- **One terminal:** pick a theme in the New Terminal dialog, or change it later from that terminal's edit menu (right-click the terminal in the sidebar).

---

## 9. Keybindings

![Keybindings settings](../e2e/screenshots/docs/09-keybindings.png)

Settings → Keybindings lists the core actions and their shortcuts: copy and paste, history search, find in terminal, new, close, next and previous terminal, the sidebar, split view, the app log, clearing the terminal, and launching agents 1–3. To rebind one:

1. Click its shortcut.
2. Press the new combo. Press Escape, or click anywhere outside, to cancel.
3. The new binding takes effect at once. If another shortcut already uses that combo, the row says **Conflicts with …**.

Each row's reset button restores its default, and **Reset All** restores them all. The three copy shortcuts (`Ctrl+Shift+C`, `Ctrl+Shift+K`, `Ctrl+Shift+Q`) are reserved and cannot be changed. The panel shortcuts, such as `Ctrl+K` for the command palette and `Ctrl+Shift+S` for the swarm dashboard, are fixed.

**Custom Shortcuts**, below the table, bind a key (with Ctrl or Alt) to a snippet that is typed into the active terminal; turn on **Run** to press Enter after it. They are saved unencrypted in your app data, so don't store passwords or tokens in them.

On macOS, `⌘` works wherever a binding says `Ctrl`.

See [§32](#32-keyboard-shortcut-reference) for the complete default list.

---

## 10. Agent Capability Ratings

![Agent capability ratings](../e2e/screenshots/docs/10-agent-capability-ratings.png)

The heart of smart swarm routing. **Settings → Agent Ratings** lets you score each agent (Claude Code, OpenAI Codex, Gemini CLI) from 1 to 5 in 10 categories:

1. Refactoring
2. Architecture
3. Testing
4. Documentation
5. Code Review
6. Debugging
7. Frontend
8. DevOps
9. Data Analysis
10. Bulk Tasks

Defaults reflect model-family strengths as of release. You can tune them to match your own experience: each score has its own reset button, and **Reset All** restores the defaults. The conductor and the smart router treat the scores as hints (the conductor is told which categories each agent scores 4 or 5 in) and still make their own call.

Each agent also carries a relative token cost (high, medium or low) that the conductor weighs for cost-aware routing.

---

## 11. Command Palette

![Command palette](../e2e/screenshots/docs/11-command-palette.png)

`Ctrl+K` (or `⌘K`) opens the command palette. Everything you can do from a menu is here, plus a lot that isn't:

![Filtered command palette](../e2e/screenshots/docs/11b-command-palette-filtered.png)

Type to filter:

- **Actions** — "launch claude", "split horizontal", "clear terminal".
- **Workspaces** — "switch to ~/work/frontend".
- **Recent commands** — from your terminal history.
- **Files** — with results ranked by edit recency in the current workspace.

Fuzzy matching is weighted, and exact matches always float to the top. Press `Enter` to execute, `Esc` to close, `↑`/`↓` to navigate.

---

## 12. Prompt Templates

![Prompt templates](../e2e/screenshots/docs/12-prompt-templates.png)

A library of reusable prompts you send to agents. Open with `Ctrl+Shift+P`.

Built-in templates include:
- **Explain this code**
- **Write tests for this**
- **Refactor for readability**
- **Find security issues**
- **Document this API**
- **Code review — strict**

Each template supports `{{variables}}` that are filled from the current selection, the focused terminal's working directory, or free-form input. Add your own with the **+ New template** button; they're saved to `prompt-templates.json` in your data directory.

---

## 13. Workflow Orchestrator

![Workflow designer](../e2e/screenshots/docs/13-workflow-templates.png)

A workflow is an ordered pipeline of steps that Termpolis runs for you. Open the **Workflows** section in the sidebar and press the inline **+** (**Start Workflow**) to author one on a blank canvas. Every saved workflow appears as a row in that section — press it to open the run view.

### Steps

Four kinds, in any order:

- **Command** — a shell line (inline or a script file) on a real terminal, with its own shell and timeout.
- **Agent** — launches Claude Code, OpenAI Codex, or Gemini CLI on a prompt and waits for it to finish.
- **Skill** — calls one of Termpolis's own tools: code search, memory, git.
- **Control** — `wait`, `branch`, `loop`, or `notify`.

Each step takes an optional `when` gate and an optional *continue even if this step fails*. Later steps read earlier results (`${steps.build.exitCode}`, a step's captured output) inside gates, branch conditions, loop guards, and notify messages. Expressions run through a small, pure, sandboxed evaluator — never `eval`.

### Availability, categories, and inputs

![Workflow designer — availability, category, and inputs](../e2e/screenshots/docs/13b-workflow-create.png)

- **Availability** — **Project** stores the workflow in `<repo>/.termpolis/workflows/<id>.yml` and shows it only in that repo. **Global** stores it in your Termpolis data directory and offers it in *every* project. Switching availability moves the file between the two stores; scope is derived from where the file lives and is never written into the YAML, so moving a `.yml` by hand re-scopes it.
- **Category** — a free-text label (`Build`, `Release/Nightly`, …). The sidebar files every workflow with that label into a collapsible folder; uncategorized workflows stay at the top level.
- **Inputs** — named values the workflow asks for before it runs. Each has a name, an optional label and description, an optional default, and a *required* flag. Termpolis collects them in the run view and keeps **Run** locked until every required input is filled. Reference them as `${inputs.NAME}` in any step field, gate, branch, or loop condition.

A global workflow always runs against the directory you're standing in, so `${project.cwd}`, `${project.name}`, and `${project.branch}` resolve to the repo you're actually in — one workflow, reused everywhere, parameterized by inputs.

### Triggers

Give a workflow a trigger and it stops needing you:

- **Manual** — only when you press Run.
- **Schedule** — a real cron expression (`0 2 * * *`, or `@daily`) in your local time, with an optional catch-up for a run missed while the app was closed.
- **Git commit** — fires when a new commit lands on the checked-out branch, optionally narrowed to one branch. This is the post-commit hook: lint, test, or hand the diff to an agent.
- **Git push** — watches the remote-tracking ref for a chosen remote and branch.
- **File change** — a debounced recursive watch you can narrow to specific paths.

Triggers survive restarts, and a triggered run takes the exact same path as pressing Run — including the workspace-trust gate, so an untrusted folder never fires. A global workflow arms in every project the app has open, and each project keeps its own trigger state, so a commit in one repo only fires that repo's run.

### Watching a run

The run view streams each step's output live, marks it succeeded, failed, or skipped, and shows how long it took. Cancel mid-run and every in-flight step is torn down cleanly. Run history is appended to `.termpolis/workflows/runs/<workflowId>.jsonl` next to the store the workflow came from.

---

## 14. Context Panel

![Context panel](../e2e/screenshots/docs/14-context-panel.png)

`Ctrl+Shift+E` toggles the context panel, as does **Show Context Panel** in the command palette. It shows the active terminal's folder:

- **File Tree** — the files and folders in it.
- **Git Status** — the changed files, or "Clean working tree" ("Not a git repo" outside a repository).
- **Recent Commits** — the latest commits, each with its hash and message.

The folder's path is at the bottom. Click a section's header to collapse it. Snippets and notes you want to keep for a project go in the separate pinned context panel (`Ctrl+Shift+B`).

---

## 15. History Search

![History search](../e2e/screenshots/docs/15-history-search.png)

`Ctrl+Shift+H` opens terminal history search. It spans **every terminal you've ever opened** in Termpolis, not just the current shell's history file. Search by:

- Command
- Working directory
- Exit code (e.g. find all failures)
- Time range
- Shell type

Click a result to copy, re-run in the focused terminal, or pin to context.

---

## 16. Conversation Search

![Conversation search](../e2e/screenshots/docs/16-conversation-search.png)

`Ctrl+Shift+I` opens conversation search — the AI-session equivalent of history search. Search across every agent session Termpolis has recorded:

- Filter by agent (Claude / Codex / Gemini).
- Filter by kind (prompt, tool call, tool result, error).
- Full-text search with highlighting.
- Time range.

Each hit deep-links into the original session so you can reopen it, re-prompt, or copy a successful flow.

---

## 17. Git Panel

![Git panel](../e2e/screenshots/docs/17-git-panel.png)

Open it with the **Git Panel** button in the sidebar toolbar. It opens on the repository that holds the active terminal's folder; otherwise click **Open Folder** to pick one, and click the folder path in the header to switch to another. The Git panel is a lightweight GUI for what you usually do at the CLI:

- **Current branch** in the header, with **Pull**, **Push** and **Refresh** buttons.
- **Staged Changes** and **Changes** — each file shows its status. Click a file to see its diff.
- **Stage and unstage** — the **+** / **−** next to a file, or **Stage All** / **Unstage All**.
- **Commit** — type a message in **Commit message...** and press Enter or click **Commit**.

Every action runs as a real git command in a spawned process — no reimplementation — so you can always drop to the CLI and see the same state.

---

## 18. AI Agent Profiles

Launch any AI CLI as a profiled terminal: Claude Code, Codex, Gemini CLI. Profiles come pre-configured with:

- The correct shell + startup command.
- A color + label for visual distinction.
- An MCP bootstrap so the agent can control Termpolis.
- A distinct working directory if you want one.

Custom profiles take any command — if it's in your PATH, you can profile it. Add one with the **+** button on the sidebar's **AI Agents** section.

### Second Opinion

Want another model to check what your agent just did? Every AI terminal has a **Second Opinion…** menu in its header. Pick a provider, or one of its models, from the agents you have installed (Claude Code, Codex, Gemini). Termpolis sends the last 160 lines of the terminal's output to that agent for review, and the menu reads **Reviewing…** until the answer comes back.

The feedback is pasted into the terminal between a `=== Second Opinion (…) ===` line and an `=== end second opinion … ===` line, but not sent, so you can read it first. Press Enter to pass it on to your agent, or clear it.

Since v1.49 the reviewing agent is **read-only**. It runs headless and can't change anything:

- **Claude Code** runs in plan mode with no tools. `Bash`, `PowerShell`, `Edit`, `Write` and `NotebookEdit` are also explicitly disallowed, and none of your MCP servers are loaded.
- **Codex** runs as `codex exec --sandbox read-only`.
- **Gemini** runs through the Antigravity CLI in plan mode (`agy --mode plan`).

A review gets 90 seconds. Termpolis stops one that runs longer, and any still running when you quit, and since v1.49.1 it ends the agent's whole process tree, so on Windows nothing the agent started keeps running in the background.

The terminal output never passes through a shell's command line (on Windows it travels in a temporary file), so text in your terminal can't become a command.

A review gets 90 seconds. If it runs out of time, or is still running when you quit Termpolis, Termpolis ends the reviewing agent and everything it started, so nothing is left running in the background.

---

## 19. MCP Server

Termpolis ships an **MCP (Model Context Protocol) server** so AI agents can control the app from inside a conversation. It listens on `http://127.0.0.1:9315` — reachable from this machine only — and moves up to the next free port, as far as 9319, if that one is taken.

### Available tools

The tools come in seven groups. The authoritative list is the one your agent shows for the `termpolis` server (for example `/mcp` in Claude Code), because it comes straight from the running app.

| Group | Tools | What they're for |
|-------|-------|------------------|
| Terminals and files | `list_terminals`, `create_terminal`, `run_command`, `run_and_wait`, `read_output`, `write_to_terminal`, `close_terminal`, `get_file_tree`, `get_git_status` | Open, drive and read terminals, run a command to completion and get its exit code, list files, and read git status and recent commits |
| Swarm | `swarm_send_message`, `swarm_read_messages`, `swarm_create_task`, `swarm_list_tasks`, `swarm_update_task`, `swarm_list_agents` | Message other agents, keep the shared task queue, and see which agents are running |
| Memory | `memory_write`, `memory_search`, `memory_list`, `memory_primer`, `memory_related`, `memory_graph`, `memory_link`, `memory_audit`, `memory_anticipate`, `memory_feedback`, `memory_selfcheck`, `memory_pool`, `memory_conflicts`, `memory_correct` | Read and write the shared memory, follow its knowledge graph, and rate, correct or audit what it recalls |
| Code intelligence | `code_search`, `code_locate`, `code_explore`, `code_callers`, `code_callees`, `code_impact`, `test_coverage` | Find symbols, predict where a bug lives, trace callers and callees, size the blast radius of a change, and read which lines the project's last coverage run covered |
| Gateway | `gateway_list_tools`, `gateway_call` | Reach tools on the MCP servers you add in Settings → MCP Servers, under its gateway policy |
| Token Headroom | `retrieve_full` | Expand a tool result that Token Headroom shortened |
| Linked machines | `linked_machines` | Have a Claude, Codex or Gemini agent on another linked machine do a task headlessly and return its final answer: `list` the machines, `run` a task, and fetch the `result` of one still running. See [§30](#30-linked-machines) |

The server is authenticated via a token generated at each launch, which Termpolis writes to `mcp-token` in its data directory, next to `mcp-port`. An agent's Termpolis MCP entry starts a small stdio adapter that reads both. Misuse resistance includes tight origin checks, rate limits, and an audit log.

### Connecting your coding agents

Termpolis doesn't register itself with an agent until you say so. The first step of the first-run tour, or **Settings → Agent Integration** at any time, lists exactly what it would change for each of Claude Code, Codex and Gemini CLI installed on this machine. Connected, Termpolis:

- **Claude Code** — adds the `termpolis` MCP server at user scope in `~/.claude.json`, as `claude mcp add -s user` would (under your `CLAUDE_CONFIG_DIR` if you set one). It allows 27 read-only and memory tools in `settings.json` so they run without asking; tools that run commands or type into terminals still ask. It marks each folder you open an agent in as trusted — never your home folder, a folder above it, a drive root or a network share root. Optionally, it adds a **SessionStart hook** that loads your project memory whenever a Claude Code session starts, including sessions started outside Termpolis. Since v1.49.1 the hook does nothing once Termpolis is gone, so removing the app without disconnecting first doesn't leave Claude Code with a failing hook (an existing hook is upgraded the first time v1.49.1 starts).
- **Codex** — adds the `termpolis` MCP server to its `config.toml` (a different server you already named `termpolis` is left alone), pre-approves the 14 `memory_*` tools unless you already chose a setting for them, and answers the folder-trust prompt for a folder you open it in, with the same exclusions. Its memory instruction is passed on the launch command (`-c developer_instructions`) for that session only, and not at all if you set your own; nothing is written into your projects.
- **Gemini / Antigravity CLI** — adds the `termpolis` MCP server where the Antigravity CLI (`agy`, which the Gemini profile runs) reads it, `~/.gemini/config/mcp_config.json`, and lets the same read-only and memory tools Claude Code gets run without asking, in `~/.gemini/antigravity-cli/settings.json` (rules like `mcp(termpolis/memory_search)`, never a wildcard). Each file is written only once `agy` has created its folder. It also keeps the entry in Gemini CLI's `settings.json` for the older CLI. Disconnect removes exactly these entries and rules, and nothing `agy` wrote.

When Termpolis answers a folder-trust prompt, it selects the trust option itself instead of pressing Enter on whatever is highlighted. It never answers a permission, approval or MCP prompt, a `[Y/n]` question or a numbered choice — those wait for you — and while your agents aren't connected it doesn't answer the folder-trust prompt either. On an agent's first-run screens it still presses Enter and takes the default: Claude Code's intro splash, its theme and login-method pickers, and Gemini CLI's terms and sign-in screens.

**Disconnect** in Settings → Agent Integration removes everything Termpolis wrote. Uninstalling on Windows or removing the Linux .deb does the same (an update doesn't), and `Termpolis --disconnect-agents` does it from the command line on any platform.

Whatever you choose, v1.49 also cleans up once after older versions: it removes a permission that let every Termpolis tool run without asking, the duplicate Termpolis plugin for Claude Code, Termpolis's entry in `~/.mcp.json`, and any trust for your home folder or a drive root.

**Known limitations**

- Disconnect un-trusts only the folders this version marked trusted. Trust that an older Termpolis version added can't be told apart from trust you accepted yourself, so it stays.
- Older versions wrote a memory note into `AGENTS.md` in project folders. Termpolis removes that note (and the file, if the note was all it held) the next time you launch Codex from Termpolis in that folder, not before.

---

## 20. Swarm Dashboard

![Swarm dashboard](../e2e/screenshots/docs/18-swarm-dashboard.png)

`Ctrl+Shift+S` opens the swarm dashboard — the nerve center for multi-agent work. It has three tabs: Tasks, Messages and Trace. A fourth, **Review**, appears once a swarm has recorded the commit it started from.

### Tasks tab

![Swarm tasks tab](../e2e/screenshots/docs/19-swarm-tasks-tab.png)

Every task in the current swarm run, in three columns: **Pending**, **In Progress** and **Completed** (failed tasks land there too). Each card shows the task's title and description, the agent it's assigned to, and, once it's finished, a summary of the result.

You can also move a task along by hand: **Start** or **Cancel** a pending task, and mark one in progress **Done** or **Fail**. A cancelled task counts as failed.

### Messages tab

![Swarm messages tab](../e2e/screenshots/docs/20-swarm-messages-tab.png)

A live stream of every message the conductor sends, every broadcast, every handoff. Think of it as the "Slack channel" for your agent team — useful for debugging, reviewing, or understanding exactly how a decision was made.

### Trace tab

![Swarm trace tab](../e2e/screenshots/docs/21-swarm-trace-tab.png)

A timeline of what the conductor is doing: every tool call it makes, the tasks it assigns and sees completed, what it writes as it works, and any errors.

### Review tab

The changes the swarm has made since it started, file by file. Accept or reject each hunk and run a test command, then commit the changes you accepted, or revert everything the swarm changed. See [Swarm Review Panel](#24-swarm-review-panel).

---

## 21. AI Conductor

The conductor is a **dedicated Claude Code instance** that runs headless in a hidden terminal (while a swarm runs, a button in the dashboard reveals it), with instructions purpose-built for orchestration. It:

1. Reads your task, the project folder, and the installed agents, with each one's strongest categories and relative cost.
2. Posts its plan to the swarm's messages.
3. Creates a task record for every subtask, so the plan shows up on the dashboard.
4. Opens a terminal for each subtask and starts an agent in it (see [Swarm permission flags](#swarm-permission-flags)).
5. Types each agent's task prompt into its terminal.
6. Checks the task list, the messages and each agent's output every 15–20 seconds, and sends guidance to an agent that looks stuck.
7. Marks each task completed as its agent finishes, then posts a final summary.

The conductor is **not keyword matching** — it reasons with the same capability as any frontier model, because it *is* one. Follow what it's doing in the dashboard's [Trace tab](#trace-tab).

### Starting a swarm

![Start swarm wizard](../e2e/screenshots/docs/22-start-swarm-wizard.png)

Click **Start Swarm** on the welcome screen, or in the swarm dashboard's header while no swarm is running, and pick the folder the swarm should work in. The wizard asks for:

- **Goal** — what you want built, in plain language. It's the only required field.
- **Constraints** — platforms, languages, or anything else to avoid or insist on.
- **Expected Output** — what "done" looks like.
- **Failure Conditions** — what would count as a failed result.

Click **Launch Swarm**. The conductor spins up, reads the task, and the dashboard populates with subtasks within seconds. The conductor itself runs on Claude Code, so a swarm needs the `claude` CLI installed.

### Swarm permission flags

Swarm agents run unattended, so the conductor starts each one with flags that keep it from stopping to ask for approval. These are the only agent launch commands a swarm terminal accepts:

| Agent | Command |
|-------|---------|
| Claude Code | `claude --dangerously-skip-permissions`, optionally with `--model fable`, `opus`, `sonnet` or `haiku` |
| Codex | `codex -a never -s workspace-write` |
| Gemini | `agy --dangerously-skip-permissions` (the Antigravity CLI) |

If the conductor starts one of these agents any other way — with a prompt, `-p`, a sandbox flag or anything else added — Termpolis rewrites the command to the one in the table before it runs, keeping only a valid `--model` for Claude. The older `gemini` CLI is still accepted as a fallback, but only as a plain `gemini` with nothing after it.

- **Claude Code workers keep `--dangerously-skip-permissions` by design.** No one is watching a worker, so a single approval prompt would stall the whole swarm. The conductor runs Claude Code the same way.
- **Codex workers run with `-a never -s workspace-write`.** `-a never` means Codex never stops to ask: a command that would need approval goes back to the model as failed. `-s workspace-write` keeps Codex's sandbox, so it writes only inside the project and, by default, has no network access. Codex 0.153 rejects the old `--full-auto` flag.
- Start a swarm only in a folder you're happy for agents to change. The [Review tab](#review-tab) lets you accept, reject or revert what they did.

Outside a swarm, Termpolis starts an agent without permission prompts only when you ask for it: a headless run from the Termpolis CLI with `--write` (`termpolis-cli exec "<task>" --write`). Headless runs are read-only otherwise, and [Second Opinion](#second-opinion) is always read-only.

---

## 22. Activity Feed

![Activity feed](../e2e/screenshots/docs/23-activity-feed.png)

The activity feed is the observability layer for every agent, every session. Press `Ctrl+Shift+A` to open it.

### Event types

- `message` — text output from the agent.
- `tool_call` — when an agent invokes a tool (with args).
- `tool_result` — the result of a tool call.
- `token_update` — token usage deltas.
- `compaction` — when an agent compacts context.
- `error` — agent or tool error.
- `status_change` — idle → working, etc.
- `mcp_audit` — every MCP request + response.

### Filters

Three filter rows: **search** (full-text), **kind** (dropdown), **agent type** (dropdown). All combine.

### Scoped vs global

With a terminal active, the feed shows that terminal's session, with the [intervention controls](#23-intervention-controls) above the events. With no terminal active, it shows every agent across every session. The header tells you which: "Agent Activity (terminal)" or "Agent Activity".

---

## 23. Intervention Controls

Every scoped Activity Feed includes a row of intervention controls above the event list:

- **Pause** — sends `ESC` (0x1B) to the agent's pty, which most CLIs interpret as "cancel current input".
- **Cancel** — sends a single `Ctrl+C` (0x03).
- **Interrupt** — sends a double `Ctrl+C` (0x03 0x03), which Claude Code and Codex treat as a hard stop.
- **Steer** — a text input with a send button. Type a new instruction and the agent receives it directly at the prompt.

The rationale: every agent is a pty, so writing control characters or text to its stdin is the fastest, most reliable way to take over. No new IPC surface — just the pty API we already have.

The controls show the last action you sent, for example "Hard interrupt (Ctrl-C x2)". Interventions aren't added to the event list.

---

## 24. Swarm Review Panel

When a swarm starts in a git repository, Termpolis records the commit it started from. Once the swarm finishes, the **Swarm Review Panel** shows everything it changed since that commit, so you decide what to keep. It's the dashboard's **Review** tab; **Review Changes** in the Swarm Complete dialog opens the dashboard for you. A folder that isn't a git repository has no starting commit to compare against, so it gets no Review tab.

- **Files and hunks.** Select a changed file to see its hunks, then **Accept** or **Reject** each one. **Accept all** and **Reject all** decide every hunk at once. **Reject entire file** puts that file back the way it was before the swarm, straight away. The list covers files git already tracks; a new file the swarm hasn't added to git doesn't appear in it.
- **Tests.** The test command is filled in for you (from the project's `package.json` and lockfile, falling back to `npm test`). Edit it if you need to, then click **Run tests**. The command must start with a known runner such as `npm`, `pnpm`, `pytest`, `cargo`, `go` or `make`, and can't use shell operators like `&&` or pipes. While the tests are failing, **Commit** stays disabled.
- **Commit.** Termpolis suggests a commit message. **Commit** undoes the hunks you rejected, then commits everything that's left in the folder, including new files the panel doesn't list.
- **Revert all.** After you confirm, resets every file git tracks to the commit the swarm started from. Any uncommitted change to those files is lost, yours included. A new file that was never added to git stays where it is.
- **Refine.** Not happy with the result? Describe what to fix and click **Refine**. The Start Swarm wizard opens with your note and the previous swarm's summary filled in, ready to launch a follow-up swarm.

---

## 25. Persistent Memory — the growing brain

A local, cross-agent memory store that **never forgets and feeds itself**, so every agent can semantically recall past work instead of you re-explaining context each session.

### What's in it

- **Past AI conversations** — Claude Code (`~/.claude/projects/**`), Codex (`~/.codex/sessions/**`), and Gemini (`~/.gemini/tmp/**`) transcripts are parsed, noise-stripped (tool calls / reasoning / system prompts removed), chunked, and embedded.
- **Your repo's code** — git-tracked files (so `node_modules`/`dist` are excluded), chunked by line-window. The indexer reuses the **same sensitive-file denylist as the read watcher**, so `.env`, keys, and cloud credentials are never embedded.

### How it works

- **Embeddings are local & offline.** A bundled `bge-small-en-v1.5` model (q8, 384-dim, MIT) runs in-process via `onnxruntime-web` (WASM) — no Ollama, no server, and **zero native binaries** in the installer. If the model is absent, search degrades gracefully to keyword matching.
- **Shared across all three agents** over the MCP server (`memory_search` / `memory_write` / `memory_list`), once you connect them (see [Connecting your coding agents](#connecting-your-coding-agents)). One store backs Claude/Codex/Gemini, so a fact one learns is instantly available to the others.
- **Durable across restarts, updates, and reinstalls.** Stored as JSONL in Termpolis's app-data folder — `%APPDATA%\termpolis\swarm-memory.jsonl` on Windows, `~/Library/Application Support/termpolis/` on macOS, `~/.config/termpolis/` on Linux — and reloaded with embeddings at startup. When an OS keychain is available, each line is encrypted at rest (AES-256-GCM) with a random per-device key that the keychain protects; without one, the file stays plain text. Aged memories that idle consolidation moves to the cold archive (`swarm-memory.archive.jsonl`, in the same folder) are currently written there in plain text either way. Because it lives in your user profile, not the install folder, it **survives app updates and even an uninstall/reinstall** (the uninstaller leaves app data in place). A hot window of up to 500k chunks is kept in RAM for vector search; the on-disk log retains everything written.
- **Feeds itself.** A background indexer runs ~10 s after launch and every 30 min, ingesting new sessions. Ingestion is idempotent (content-hash dedup), so steady-state runs only embed genuinely new chunks.
- **Pre-context primer.** `memory:build-primer` pulls the most relevant memories for a query and formats a shell-paste-safe block that can be injected as an agent's first input — so it starts already knowing the context (the token-saver). With **Auto-recall context on agent launch** on (Settings → General; on by default), every agent you launch is pointed at it: Claude through its system prompt, Codex and Gemini through a one-line pointer typed into their input. The pointer waits while the agent's screen shows something waiting for an answer, such as a trust or approval prompt, or can't be read, so its Enter never answers a prompt for you. If you connected Claude Code with the optional SessionStart hook, sessions you start outside Termpolis load your project memory too.
- **Current-directory precedence.** The primer leads with context for the project you're standing in — past conversations from this repo first, then its code/notes — and anything from other projects is appended under a "may NOT apply" label. Ingested chunks are tagged with their project (derived from the transcript cwd / repo root), legacy chunks get back-tagged on the next indexer pass, and `memory_search` accepts a `project` filter so agents can scope recall themselves.

### What memory can and can't tell an agent

- **Recall returns excerpts.** A past conversation is stored in pieces of about 2,000 characters, so a search hit can start or end mid-sentence. Pieces from one session are usually linked in order: `memory_graph` with the hit's id and relation `follows` reads on, and `precedes` reads back. If reading on stops early, search again. The primer tells agents this.
- **Search ranks by similarity, and rarely comes back empty.** Even a search with no relevant memory usually returns its closest matches with high-looking scores, so judge a hit by what it says, not by its score. To see the latest entries in order, use `memory_list` with your project instead.
- **Memory records what was said, not what is true now.** A note that a disk was 48% full was true when it was written. Agents are told to verify anything they rely on.
- **Each computer has its own memory.** Something you did or discussed on another machine isn't in this one's memory, and something that happened without an agent session (plugging in a drive, say) isn't in any.
- **Lessons are extracted automatically, and the extractor can be wrong.** Termpolis reads finished sessions for problems that got fixed, decisions and gotchas. Through 1.50.0 it read many ordinary sentences as problems and decisions; 1.50.1 tightens its rules and, once, demotes the lessons it wrote by mistake, so they rank lower in search. A demoted lesson is still stored and still returned, ranked lower. Correct a bad lesson as it surfaces with `memory_correct`; nothing is deleted.

### Using the Memory panel

Open the panel with **Ctrl+Shift+M**, or from **Settings → General → Open the Memory panel**. From there you can:

- **See what's stored** — the number of remembered chunks (and how many sit in the in-RAM hot window for fast search).
- **Search** — type what you're working on and hit **Search** for a semantic lookup across your past conversations and indexed code.
- **Inject primer** — type a topic and click **Inject primer** to paste the most relevant memories straight into the *active agent's* terminal, so it starts already knowing the context. This is the token-saver: you stop re-explaining background every session.
- **Index this repo's code** — pull the current project's git-tracked files into memory on demand (`.env`/keys are always skipped). Conversations index themselves automatically; code indexing is opt-in per repo so you decide what's searchable.
- **Sync across machines — leave it off for now.** This setting points the memory at a folder you already sync, but it doesn't work reliably in current versions: Termpolis forgets the chosen folder when it restarts, and turning it on for a store that is already encrypted can conflict with that store's key. Each computer keeps its own memory. To use what another of your computers knows, link the two with [Linked machines](#30-linked-machines).

**Why it matters:** when Claude figures out how your auth module works, Codex doesn't need to re-discover it, and you stop burning 20–50k tokens re-pasting context every session. The store is JSONL in your app-data folder (see above); without an OS keychain it stays plain text, readable and hand-editable.

---

## 26. Observability

Termpolis ships with a full observability stack for AI work — the "watchers" system. It's a lightweight in-process event bus that watches for:

- **Token pressure** — when an agent is approaching compaction.
- **Stuck sessions** — when an agent has been silent for > N seconds.
- **Error cascades** — repeated errors in a short window.
- **Redundancy** — two agents doing overlapping work.
- **Efficiency** — the token-cost-per-task rolling average.

Watchers can surface alerts in the status bar, in the activity feed, or fire a system notification. Thresholds are tunable in settings.

---

## 27. Status Bar

![Status bar](../e2e/screenshots/docs/24-status-bar.png)

The bottom strip shows, left to right:

- Active workspace + git branch (click to switch).
- Focused terminal's shell type + cwd.
- Active agent summary — how many are working, how many idle.
- Swarm status — if a run is active, shows progress %.
- Token counter — session total across all agents.
- Notifications — watcher alerts live here.
- MCP server indicator — green when healthy.

---

## 28. Troubleshooting

> **Found a bug that isn't here?** **[Open an issue on GitHub →](https://github.com/codedev-david/termpolis/issues/new?template=bug_report.md)** Include your OS + version, the Termpolis version (shown at the top of Settings), and the most recent entries from the app log (`Ctrl+Shift+O`, or `app.log` in your data directory) — that's usually enough to reproduce the problem.

### Installation & first-run

**Windows: "Windows protected your PC" SmartScreen warning.** Click **More info** → **Run anyway**. Termpolis is code-signed (SSL.com), but newly signed builds need reputation time before SmartScreen stops flagging them. The warning disappears once enough people download the release.

**macOS: "Termpolis is damaged and can't be opened."** This means Gatekeeper couldn't verify the signature — usually a partial download. Re-download the DMG from GitHub Releases, verify the file size matches, and mount again. If it still fails, open **System Settings → Privacy & Security**, scroll to the bottom, and click **Open Anyway** next to the Termpolis entry.

**macOS: "Permission denied" when launching a terminal.** Grant Termpolis **Full Disk Access** in System Settings → Privacy & Security → Full Disk Access. Re-launch after granting.

**Linux: AppImage won't run.** Mark it executable: `chmod +x Termpolis-*.AppImage`. On systems with hardened FUSE, extract and run the inner binary: `./Termpolis-*.AppImage --appimage-extract && ./squashfs-root/termpolis`.

**Data directory didn't appear.** Termpolis creates the data directory on first run — make sure you actually clicked "Open" rather than dismissing the first-launch dialog. Paths by platform: `%APPDATA%\termpolis\` (Windows), `~/Library/Application Support/termpolis/` (macOS), `~/.config/termpolis/` (Linux).

### Terminals

**Terminal won't start.** Check which shell it uses: **Settings → General → Default Shell** for new terminals, or the **Shell** field in the New Terminal dialog. Termpolis offers only the shells it finds at their standard install paths; on Windows, PowerShell 7 lives at `C:\Program Files\PowerShell\7\pwsh.exe`. **Press `Ctrl+Shift+O`** to open the app log and see why the terminal failed to spawn. On macOS, if `/bin/zsh` gives "permission denied", re-grant Termpolis Full Disk Access (above) — launchd blocks unsigned/unapproved apps from spawning shells by default.

**Terminal hangs on first prompt.** Your shell's startup files (`.bashrc`, `.zshrc`, `powershell $PROFILE`) may be waiting on input or hitting a slow network check. Open the shell outside Termpolis to confirm; the fix is in your dotfiles, not the app.

**Output looks garbled / escape codes show as text.** On macOS and Linux, Termpolis starts every terminal with `TERM=xterm-256color`, so a program that prints raw escape codes has usually been told otherwise. Check whether your shell's startup files (`.bashrc`, `.zshrc`, PowerShell `$PROFILE`) set `TERM` to something like `dumb`, and open a fresh terminal from the New Terminal dialog to confirm.

**Copy/paste shortcuts don't work.** On Windows/Linux, `Ctrl+C` copies only when text is selected; with nothing selected it interrupts the running program. `Ctrl+Shift+C` always copies, and `Ctrl+V` or `Ctrl+Shift+V` pastes. On macOS, `⌘C`/`⌘V` copy and paste, and `Ctrl+C` always interrupts.

**Font looks wrong / icons are boxes.** The app ships with its own icon font. If a terminal's text looks wrong, check the font family and size in **Settings → General → Terminal Defaults**, or right-click a terminal in the sidebar to change them for that terminal alone. If the icons in the app itself show as boxes, the bundled font failed to load: restart Termpolis, and reinstall if it keeps happening.

### Agents & CLI tools

**Agent launch button fails silently.** The CLI isn't on your PATH. Open any shell in Termpolis and run `claude --version` (or `codex`, `gemini`) to confirm. On macOS, GUI-launched apps don't always inherit `$PATH` from your shell — restart Termpolis after updating `~/.zprofile` (not just `~/.zshrc`), or relaunch from Terminal with `open -a Termpolis` so the shell PATH is inherited.

**Wrong `claude` / `codex` binary runs.** If you've installed the CLI via multiple package managers (Homebrew, npm, cargo), PATH order decides the winner. Use `which claude` to see which one Termpolis will launch. To pin a specific one, add a custom profile with the **+** on the sidebar's **AI Agents** section and give it the full path as its command.

**An agent can't run `sudo` (Linux and macOS).** An agent runs its commands without a terminal, so plain `sudo` has nowhere to ask for your password. Every Termpolis terminal sets `SUDO_ASKPASS`, so `sudo -A` there asks through a Termpolis password dialog that shows the whole command about to run. Termpolis tells Codex, and Claude Code in projects with saved memory, to use it; for other agents, mention `sudo -A` in your prompt. Type your password only for a command you expected, because whatever you approve runs as administrator. The helper behind the dialog (`askpass/sudo-askpass` in the data directory, set as `SUDO_ASKPASS` in every terminal) won't run unless sudo started it, and won't ask at all for a command too long to show in full. It can't protect you from a program that is already hostile and running as you, which could show a lookalike dialog of its own. A `SUDO_ASKPASS` you set yourself is left alone. On Linux the dialog uses zenity, kdialog or ssh-askpass, tried in that order; with none of them installed, `sudo -A` fails with a message saying so. On macOS it uses the system dialog.

**`sudo` fails in every terminal with *sudo: The "no new privileges" flag is set* (Linux).** In-app updates of the .deb from Termpolis 1.50.0 and earlier reopened the app in a way Linux marks "no new privileges", which stops sudo, su and pkexec in every terminal it opens. Termpolis shows a notice when it starts in that state and, where `systemd-run` is available, offers to restart itself properly. You can also quit Termpolis and open it again from your applications menu. Later in-app updates no longer cause it.

**Agent exits with "API key not set".** Each agent's env vars come from the login shell, not from a `.env` file in your workspace. `export ANTHROPIC_API_KEY=...` in `~/.zprofile` / `~/.bash_profile` / PowerShell `$PROFILE`, then relaunch Termpolis.

### Swarm, MCP, and memory

**Agents can't reach the MCP server.** The server may have failed to start. Open the app log (`Ctrl+Shift+O`) and look for the lines about the MCP server's port. Common causes:

- **No free port.** The server tries port 9315, then the next four (up to 9319). If all five are taken — usually by stray Termpolis processes left behind by a crash — it can't start. Kill any stray `termpolis` processes and relaunch.
- **Firewall blocking localhost.** Rare but possible. Add an exception for `termpolis.exe` / the Termpolis binary.
- **Token file write failed.** `mcp-token` in the data directory (see [First run](#first-run)) couldn't be written due to permissions. Fix that folder's permissions so your user account can write to it.

**An agent doesn't see Termpolis's tools or memory.** Since v1.49, Termpolis registers itself with Claude Code, Codex and Gemini CLI only after you connect them. Check **Settings → Agent Integration**, connect if needed, then start a new agent session.

**Swarm conductor doesn't launch.** The conductor runs Claude Code in a hidden terminal, so it needs `claude` on PATH (see agent troubleshooting above). While a swarm is active, press **Debug** in the Swarm Dashboard header to show that terminal and its startup output.

**Swarm hangs mid-task / agents stop posting activity.** Open Activity Feed — if the agent is still running but not emitting events, its MCP connection may have dropped. Use the intervention controls in that agent's Activity Feed to recover: **Interrupt** stops what it is doing, and **Steer** gives it a new instruction (see [§23](#23-intervention-controls)). If a specific agent keeps dropping, restart Termpolis; the MCP server gets a fresh token at each launch.

**Memory search returns nothing.** Embeddings now run in-process via a bundled offline model (`bge-small-en-v1.5`) — no Ollama or any server required. If semantic results are missing, the embedding model failed to load on this machine; keyword-only matching still works as a fallback, and writes always succeed.

### Updates & performance

**Update notification appears but the update doesn't install.** The auto-updater needs write access to the app bundle. On Windows, run the installer manually from GitHub Releases if the in-app updater fails. On macOS, drag the new DMG contents over the existing app (it'll prompt for admin). On Linux, download and replace the AppImage.

**App is slow to start / very high memory.** A corrupted session file occasionally causes runaway restoration. Back up `session.json` in your data directory, then delete it and relaunch — you lose restored workspace state but the app is back to a clean baseline.

**Terminal scrollback is sluggish.** The default xterm scrollback is 10,000 lines. If you've pasted very large logs, scrolling slows down. Press `Ctrl+Shift+X` (Clear Terminal) to wipe the active terminal's screen and scrollback without restarting it.

### Session corruption & reset

**App opens to a blank screen.** Sign of a broken `session.json`. Close Termpolis, rename `session.json` in the data directory, relaunch — the app creates a fresh session. Your workspaces will be empty but the app is usable again; the old file is preserved if you want to diff it later.

**Reset everything.** Close Termpolis, delete the entire data directory (see [§2](#2-installation)), relaunch. This wipes workspaces, settings, themes, prompt templates, custom workflows, swarm history, and memory — start from a clean slate.

### Reporting a bug

If none of the above fixes your problem, **[open an issue](https://github.com/codedev-david/termpolis/issues/new?template=bug_report.md)**. Please include:

1. OS + version (e.g., Windows 11 23H2, macOS 14.3, Ubuntu 22.04).
2. Termpolis version (shown at the top of Settings).
3. Steps to reproduce — as minimal as you can make them.
4. The relevant tail of the app log: press `Ctrl+Shift+O`, or open `app.log` in the data directory (`%APPDATA%\termpolis\` on Windows, `~/Library/Application Support/termpolis/` on macOS, `~/.config/termpolis/` on Linux). Swarm and MCP problems land in the same log.
5. A screenshot or short screen recording if it's a UI bug.

---

## 29. Termpolis Remote (phone app)

**Termpolis Remote** is an iPhone app (on the App Store as
[Termpolis R](https://apps.apple.com/us/app/termpolis-r/id6809306362)) that
shows the terminals running in Termpolis on your desktop and lets you type into
them while you are away from the machine. It is a **pass-through**, not a second
Termpolis: nothing runs on the phone — no agent, no memory, no embeddings, no
API keys. The desktop keeps running the Claude/Codex/Gemini session it was
already running, signed in the way it was already signed in; the phone sends
keystrokes and receives output. Lose the phone and you have lost a display, not
an account.

Remote is **off by default**. It shares the relay and one background process
with [Linked machines](#30-linked-machines), but each has its own switch: a
phone has no direct way to send work to a linked computer (an agent it types
into still can), and a linked computer can't see your terminals. Switching either one on or off restarts that process, so the other's
connections drop for a moment.

Relay access is a subscription in the phone app ($4.99 a month on the App
Store, first week free for new subscribers). The desktop app stays free.

### Turning it on

*Settings → Remote.*

1. Tick **Allow phones to connect**. The desktop half runs in its own
   `utilityProcess`, off the main thread, so a stalled relay connection cannot
   slow the terminals down. If it crashes it is restarted; a fourth crash
   inside a minute turns Remote off rather than restarting forever, and the
   pane says so.
2. Leave **Relay address** at `wss://relay.termpolis.com` unless you are
   running your own. The relay's source (Apache-2.0, like the rest of the repo) is in `relay/` (a Cloudflare Worker plus
   a Durable Object), and pointing the setting at your own deployment is
   supported. The phone takes the address from the pairing QR code and only
   accepts `wss://`; phones paired before a change keep using the old relay and
   must pair again.
3. Under **Pair a device**, type a label for the phone (it defaults to
   "Phone") and tick what it will be allowed to do. Only **Read terminal
   output** is ticked to begin with. Press **Pair a device**.
4. A QR code appears with a countdown. It works **once** and is valid for
   **90 seconds**; closing the dialog withdraws it. Scan it with Termpolis
   Remote. The desktop shows the code only as a picture, so the app needs
   camera access to pair.
5. Both screens show the **same eight words**, derived from the two devices'
   long-term keys. If they match, nothing is sitting in the middle. If they
   differ, tap **They do not match — unpair** on the phone and **Revoke** the
   device on the desktop.

**Treat the QR code as a password for its 90 seconds.** Whoever scans it first
is paired — including through a screen share or a recording — and gets the
ticked permissions straight away: nothing waits for the words to be compared.
Pair where nobody else can see the screen, and revoke any device you don't
recognise.

### What the phone is allowed to do

Each phone has four permissions, chosen when it is paired and changed at any
time with the checkboxes in its row under **Paired devices**. They are checked
on the desktop for every request, and a change takes effect at once. The phone
only reports them (its Settings screen lists *What the desktop allows*) and
hides the controls it isn't allowed to use.

| Permission | Default | What it allows |
|---|---|---|
| **Read terminal output** | on | List the terminals saved in the desktop's session, i.e. the sidebar (name and working folder; swarm workers are excluded), and stream the output of the one the phone has open. |
| **Start terminals** | off | Start a terminal. The app offers Claude, Codex or Gemini (`agy`) in a folder picked by browsing the folders under the desktop's home folder; the desktop itself accepts any folder, and a plain shell. The terminal is created over MCP like a swarm worker's, so `sanitizeAgentCommand` launches it the same way: Claude and Gemini with `--dangerously-skip-permissions`, Codex with `-a never -s workspace-write`. |
| **Type into terminals** | off | Send text to any open terminal, then Enter. This bypasses the command checks — it is a keyboard, and anything typed runs as you. Deliberately **not** implied by *Start terminals*. |
| **Close terminals** | off | Close a terminal. The current phone app has no control for this. |

### Using it

- **Terminal list** — the terminals in the desktop's sidebar (from
  `list_terminals`, i.e. the saved session, so swarm workers are not in it),
  titled with the desktop's name; pull to refresh.
  While a terminal is open the phone shows its agent's status (*Thinking*,
  *Working*, *Waiting for you*, …) and a one-line summary; the list keeps the
  last status seen.
- **Output** — streamed as it is printed, for the terminals the phone has
  open. The desktop flattens it through a headless terminal first, so cursor
  moves and redraws arrive as edits and colour survives. Opening a terminal
  brings back what its last 32,768 characters of raw output draw.
- **Send** — types the text, then presses Enter 150 ms later; several lines go
  in as one bracketed paste. There are no special keys (Esc, Ctrl+C, Tab,
  arrows, or Enter on its own).
- **Up to 16 desktops** on one phone, each with its own key pair; *Desktops*
  at the top left of the terminal list switches between them.
- **New AI terminal** — the terminal is created over MCP, but the bridge tags
  the request with the phone's device id, so the renderer adds it as an
  ordinary AI terminal: in the sidebar, in the saved session (and so in the
  phone's list), and relaunched with its agent when a workspace holding it is
  restored. Main lists it from the moment it opens, until the session's
  debounced save records it. It still counts towards the eight-terminal MCP
  cap, and closing it on the desktop frees its slot.
- **Backgrounding** disconnects the phone; it reconnects on return. The
  desktop keeps the newest 262,144 characters of output per phone meanwhile,
  dropping older output and marking the gap as skipped.
- **On the desktop**, the title bar shows a phone icon while a phone is
  connected, and each device row shows connected / last seen, its four
  permissions, **Show safety words** and **Revoke**.

### Unpairing and revoking

- **Revoke** (click again on *Really revoke?*) deletes the device record and
  closes its connection at once. The phone isn't told; it sees the desktop as
  offline until it is paired again. Terminals it started keep running.
  Revoking and changing permissions need *Allow phones to connect* on.
- **Unpairing on the phone** erases that desktop's key and works offline. The
  desktop is told only if it is the phone's current, reachable desktop;
  otherwise revoke it there too.
- Unticking *Allow phones to connect* ends every session but keeps the
  pairings. A phone not seen for **30 days** is forgotten.
- Deleting the app is not a reliable unpair: iOS can keep Keychain items after
  an app is deleted.

### How it is secured

- **End-to-end encrypted.** X25519 key agreement, HKDF-SHA256 derivation and
  ChaCha20-Poly1305, with a key per direction and a counter in every sealed
  frame that rejects replayed or reordered frames. Every connection mixes in fresh ephemeral keys,
  so recorded traffic stays sealed even if a long-term key later leaks; the
  pairing exchange itself is sealed under the long-term keys only.
- **Pairing the relay can't step into.** The desktop's public key and a
  one-time secret travel only in the QR code, so a relay that never saw it can't
  open or forge the pairing. The eight words are the check against a swapped
  code; they are stable for the life of the pairing.
- **The relay is not trusted.** It sees both IP addresses, which side is which,
  connection times, a room id that is stable for the life of the pairing, the
  size and timing of every frame (frames are not padded) and the unencrypted
  frame headers (type, public keys during pairing and connection setup, a
  counter). It can drop or delay frames but not read or alter them. It stores
  no frames; Cloudflare's own logs keep request metadata.
- **Desktop-side checks.** Every request is checked against the device's
  grants. Terminal actions then go to the desktop's own MCP server over
  localhost — limited to `list_terminals`, `create_terminal`, `run_command`,
  `write_to_terminal` and `close_terminal`, with the same rate limits and audit
  log (tool name and device id, not the text) as any MCP client. Folder
  browsing (home-rooted, folder names only) and the output stream are handled
  in the bridge and are not audited. The phone's own requests reach no memory,
  swarm or other tools; an agent it types into still has its own.
- **Keys.** The desktop's identity key never reaches the renderer, and is
  encrypted with the OS keychain (DPAPI / Keychain / libsecret) where one is
  available; on Linux without a keyring it is stored unencrypted in the data
  directory. `remote-devices.json` (labels, public keys, room ids, grants) is plain. The
  phone makes a new key pair per desktop and keeps it in the iOS Keychain,
  available only while the device is unlocked and never synced to another
  device.

Privacy details are in `PRIVACY.md`; the combined policy for the desktop app,
the phone app and the relay is at <https://termpolis.com/privacy.html>.

---

## 30. Linked machines

**Linked machines** pairs your Termpolis desktops with each other, the way a
phone pairs with one. An agent on one computer can then have a Claude, Codex or
Gemini agent on another do a task **headlessly** and get its final answer back
as an ordinary tool result. It works in both directions and across any network:

> *"Have Claude on linux implement the parser in ~/repos/foo and commit it, then
> review the commit yourself."*

Nothing is typed into a terminal and no terminal opens on either machine. The
work runs as a background job, and both computers list it under **Activity**.

Linked machines is **off by default**. It uses the same relay and the same
background process as [Termpolis Remote](#29-termpolis-remote-phone-app), but
the two switch on separately: turning on one never lets the other's devices
connect.

### Turning it on

*Settings → Linked machines*, on **both** computers.

1. Tick **Let this computer link with my other computers**. The pane shows the
   relay in use, which you change under *Settings → Remote*. It has to be an
   encrypted `wss://` address.
2. On one computer, go to **Link a computer**. Choose what the new computer may
   do here (see below) and click **Create code**. A code starting
   `termpolis-link:` appears with **Copy**, a countdown and **Cancel**. It works
   **once** and expires after **5 minutes**.
3. Carry the code to the other computer any way you like: a chat message, a
   shared folder, or typing it. Paste it under **Enter a code from another
   computer**, choose what the first computer may do there, and click
   **Link**.
4. Both screens show the **same eight words**, and each suggests the other
   computer's hostname as its name. Change the name to whatever you want to
   call that machine. Compare the words, then click **They match — link** on
   **both** computers. The words come from the two computers' keys, so they
   match only if nothing sits in the middle.

Each computer runs nothing for the other until you confirm the words **on
it**. Your agent will not send work to a machine you have not confirmed, and a
machine refuses work from one it has not confirmed.

Each linked computer gets a row in **Linked computers**:

- an online dot;
- its name, which you can rename by clicking it (Enter saves, Escape cancels);
- *waiting for confirmation*, until you confirm it;
- its two permissions;
- when it last did anything;
- **Unlink**, which asks you to click again.

Names are yours, and each computer names the other. Two machines given the same
name are numbered: `linux`, `linux (2)`. **Activity** lists the 20 latest jobs
in both directions, with the machine, the agent, the first line of the prompt,
the status and how long each took.

### What a linked computer may do here

Each computer decides what the **other** may do **on it**, per linked machine.
You choose when the link is made, and you can change it at any time:

| Permission | Default | What it allows |
|---|---|---|
| **Run agents here (read-only)** | on | Start a headless agent here in its own read-only mode. It can read any file you can read. Claude runs with only Read, Grep and Glob, Codex in its `read-only` sandbox, and Gemini (`agy`) in plan mode. Each gets this machine's memory and code index as read-only Termpolis tools (see *Read-only tools* below). Codex and `agy` keep MCP servers you added to their own configs. |
| **Let agents edit files and run commands here** | off | The agent here runs unattended, as you: Claude and Gemini with permission prompts skipped, Codex in its `workspace-write` sandbox. Turning it on turns on *Run agents here* too. |

The risk is stated plainly. A machine with *Run agents here* can have an agent
read any file you can read on this computer and send it back. With *edit*, it
can change files and run commands. Grant *edit* only to a machine you trust as
much as this one.

Permissions are checked **on the computer that does the work**, before any
agent starts. They are checked again when you change them:

- switching *edit* off stops that machine's running edit jobs;
- switching *Run agents here* off stops all of its jobs;
- unlinking stops all of its jobs.

Stopping a job doesn't undo what it already changed.

### How your agent decides to use another machine

Termpolis doesn't split your work or schedule anything across machines. Your
agent gets one MCP tool, `linked_machines`, and uses it the way it uses any
tool: when you ask it to, naming the machine you gave a name to (*"have codex
on linux run the integration tests and summarise the failures"*), or when it
judges a task belongs on the other computer, say because Codex is blocked on
this network, or the repo, the hardware or the test environment is over there.
A [workflow](#13-workflow-orchestrator) you build can also call it as a step.

A typical exchange:

1. `list`: which machines are linked and online, which agents each has
   installed, and whether this computer may run or edit there.
2. `run`: a machine, an agent and a **self-contained** prompt, optionally a
   folder on that machine and `write: true`. The agent over there has none of
   this conversation, so the prompt carries what it needs: a commit SHA,
   earlier findings.
3. The answer comes back as the tool result, or, for a job still going after
   the wait, as a `jobId` the agent collects with `result`.
4. Your agent reviews the answer like any other and carries on: it can check
   the commit the other agent pushed, ask a follow-up in a new `run`, or report
   back to you.

### Asking another machine: the `linked_machines` tool

Agents get one MCP tool, `linked_machines`, with three actions:

| Action | Arguments | Returns |
|---|---|---|
| `list` | — | `thisMachine`, and for each linked machine `name`, `online`, `confirmed`, `agents` (installed there), `canRun`, `canWrite`, and a `note` explaining anything it could not find out |
| `run` | `machine`, `agent` (`claude`, `codex` or `gemini`), `prompt`; optional `cwd`, `write`, `model`, `waitSec` | `jobId`, `machine`, `agent`, `status` (`running`, `done`, `failed` or `cancelled`), plus `output`, `truncated`, `error`, `durationMs` and `note` where they apply |
| `result` | `jobId`; optional `waitSec` | the same as `run` |

- **`machine`** is the name you gave it on this computer, in any case. If no
  machine has that name, the error lists the names of the linked machines.
- **`prompt`** must be self-contained, up to 20,000 characters, because the
  agent over there has none of this conversation. It gets the prompt after one
  line. That line names the computer that asked and the working folder, and
  says its final message is returned to the agent that asked. Like any
  headless run there, it also starts with that computer's own memory primer
  (up to 6,000 characters), so its answer can quote that machine's memory.
- **`cwd`** is a folder on the other machine, absolute or starting with `~`.
  It defaults to the home folder and must exist there. UNC network paths
  (`\\server\share`) are refused.
- **`write: true`** works only if that machine lets this one edit.
- **`model`** picks the agent's model there. By default the agent uses its own.

`run` waits up to **45 seconds** by default for the answer (`waitSec`, at most
50). That stays under the 60 seconds Codex gives a single tool call. A job
still going when the wait ends comes back with `status: "running"`, its
`jobId`, and a note saying to call `result` with that `jobId`, which waits the
same way.

The `jobId` names the link, not the machine's name. It still works after a
rename or after this computer restarts, as long as the other computer still
holds the job. A finished job is kept there for up to 2 hours (at most 100),
in memory, so restarting that computer forgets it.

Losing touch with the other computer while `run` waits on a job is not
reported as a failure. You get the job's last known status and a note to check
again with `result`. Every failure comes back as data, `{ "error": "…" }`,
worded for the agent to act on or pass on to you.

Termpolis never pre-approves this tool. Claude Code asks you before using it,
unless the session skips permission prompts (as swarm workers do), and Codex is
not told to trust it. Agents can call it at most 30 times a minute; a workflow
step that calls it is not counted.

### Limits

- **Both computers need Termpolis running**, with Linked machines on and a
  connection to the relay. The relay is a meeting point, not a mailbox, so a
  request to a machine that isn't there fails at once with *"linux" is offline
  — Termpolis must be running there.* instead of waiting.
- **A computer that is asleep or shut down is offline.** While it runs a job
  for another computer, Termpolis keeps it from idle-sleeping, and lets go
  when the last such job finishes, fails or is cancelled. Only idle sleep is
  held off: the display can still turn off, and closing a laptop's lid or
  choosing Sleep can still put it to sleep.
- **On a Mac, closing the window does not take the computer offline.**
  Termpolis keeps running in the Dock, and its links with it, as do Remote
  and the agents' MCP connection. Quit it (⌘Q, or Quit from the Dock) to go
  offline.
- **Every run is a fresh headless session.** No conversation carries over
  (its memory digest can include earlier jobs once the indexer has picked them
  up), so the prompt carries what the other agent needs: a commit
  SHA, earlier findings. Code moves between the machines through Git as
  usual. Linked machines does not copy files.
- **A job runs for up to 15 minutes by default.** After that it is stopped.
- **A computer runs at most 2 jobs at a time for any one machine, and 4 in
  all.** Past that a request is refused with a message starting `busy:`.
- **The end of a long answer is kept.** That is up to the last 200,000
  characters, fewer if the answer is dense with control characters, so it
  still fits in one relay frame. Agents put their conclusion last. A
  shortened answer says `truncated: true`.
- **Up to 16 linked machines** per computer, counting the ones this computer
  made codes for and the ones whose codes it entered.
- **Jobs live in memory.** Quitting Termpolis stops every job it is running for
  other computers, and forgets the finished ones.

### How it is secured

- **End-to-end encrypted.** It uses the same X25519 pairing,
  ChaCha20-Poly1305 sealing and untrusted relay as
  [Termpolis Remote](#29-termpolis-remote-phone-app). Prompts, answers, folders
  and machine names are sealed under keys derived with HKDF-SHA256; each
  direction has its own key, and a counter in every frame rejects replays.
- **Fresh keys on every connection.** Each connection mixes in new ephemeral
  keys, so prompts and answers recorded today can't be decrypted later, even if a
  computer's long-term key leaks.
- **An encrypted relay.** Making or entering a code requires a `wss://` relay
  (`ws://` only to localhost). Keep *Settings → Remote* on a `wss://` address:
  links this computer created reconnect through that setting. The relay's
  source is in [`relay/`](../relay/), so you can run your own.
- **What the relay does see:** both computers' IP addresses, a room id for the
  link, when each computer connects, the size and timing of each frame, and each
  frame's unencrypted header (public keys while pairing and connecting, a frame
  counter). It stores no frames; the hosting provider's logs keep connection
  metadata.
- **Keys.** The computer that enters a code makes a fresh key pair for that
  link alone, as a phone does for each desktop. The computer that made the code
  uses its one identity key for all its links. Private keys are encrypted with
  the OS keychain (DPAPI, Keychain or libsecret) where one is available; on
  Linux without a keyring they are stored unencrypted in the data directory.
- **Confirmed on each computer.** A computer runs nothing for another until you
  confirm the eight words on it. Before that, the other computer can learn only
  this one's name and Termpolis version. Treat the code like a one-time
  password: whoever uses it first can ask to link, so cancel if the other
  screen shows no words or different ones.
- **Read-only by default.** Every request is checked on the computer that would
  do the work, before any agent starts. The computer doing the work doesn't ask
  you per job: the permissions are the decision.
- **Jobs, nothing else.** A linked computer is never given a phone's abilities.
  It cannot list, read or type into your terminals; it can only ask for the
  jobs described here. A job with *edit* permission runs as you, though, and
  can do whatever you can.
- **Read-only tools, and no passing the work on (v1.51).**
  - A delegated job keeps Termpolis's MCP server, cut down to this machine's
    memory and code index: `memory_search`, `memory_list`, `memory_related`,
    `memory_graph`, `memory_anticipate`, `memory_selfcheck`,
    `memory_conflicts`, the six `code_*` tools, `get_git_status`,
    `test_coverage` and `retrieve_full`. No memory writes, terminals, swarm,
    gateway or other machines.
  - The job is marked in its environment (`TERMPOLIS_LINKED_JOB`), and
    Termpolis's agent connection (the stdio adapter) enforces the list: it
    offers the job only those tools, and refuses anything else as a tool
    result. `linked_machines` is refused with *Nested delegation is not
    allowed: this agent was itself started by a linked machine.*
  - Claude gets a per-run config holding only Termpolis's server with the
    marker (`--mcp-config` plus `--strict-mcp-config`, so none of your other
    servers load), those tools pre-approved, and in a read-only job only Read,
    Grep and Glob besides. Codex gets the marker on its `termpolis` server for
    that one run, and the tools pre-approved, when its `config.toml` holds
    Termpolis's own server; otherwise the server is switched off for the run.
    `agy` passes its environment, marker included, to the server itself.
  - A job with *edit* permission has a shell and runs as you, so it could reach
    Termpolis's local MCP server directly.
- **Answers are scanned.** What comes back from another machine passes the
  gateway's prompt-injection scan before your agent sees it. That covers the
  answer, its error and any refusal worded over there. A flagged answer
  arrives under an **UNTRUSTED CONTENT** banner telling the agent not to
  follow it; a clean one arrives as it is. Prompts and answers are not scanned
  for secrets, so don't put secrets in a prompt.
- **Memory.** The agent doing the work starts with that computer's own memory
  primer (up to 6,000 characters), as a local run would, so its answer can
  quote that machine's memory. Termpolis doesn't write the answer into memory
  there itself, but a Claude or Codex job's session is saved like any other, and
  the memory indexer can pick it up.
- **Your AI providers.** Each agent's provider sees what that agent is asked
  and answers, as always, and a job uses the doing computer's AI account.
- **Records.** The asking computer's MCP audit log records each call an agent
  makes over MCP (not the prompt). The doing computer keeps its *Activity* list in memory until
  Termpolis quits.

### Unlinking

Click **Unlink** twice on either computer. The other computer drops the link
too and says so (*"laptop" unlinked this computer.*), and any job either one
still had running on the other is stopped. If the other computer is offline at the
time, it keeps showing this one as offline until you unlink it there as well.

The wire format is in [`docs/remote-wire-format.md` §13](remote-wire-format.md#13-linked-machines).

---

## 31. Architecture

```
┌─────────────────────────────────────────────────────┐
│  Renderer (React)                                   │
│  ├── Sidebar, Terminals, Panels                     │
│  ├── Activity Feed (observability UI)               │
│  ├── Swarm Dashboard + Conductor view               │
│  └── IPC client → window.termpolis bridge           │
└──────────────────┬──────────────────────────────────┘
                   │  Electron IPC
┌──────────────────▼──────────────────────────────────┐
│  Main process (Node)                                │
│  ├── Terminal manager (node-pty)                    │
│  ├── Session persistence (session.json)             │
│  ├── Git adapter                                    │
│  ├── MCP server (HTTP, 127.0.0.1 only)              │
│  ├── Swarm memory (JSONL + embeddings)              │
│  ├── AI conductor (spawns Claude Code as a child)   │
│  └── Watchers (event bus + alerts)                  │
└──────────────────┬──────────────────────────────────┘
                   │  localhost:9315 (MCP)
┌──────────────────▼──────────────────────────────────┐
│  AI agents (Claude, Codex, Gemini)                  │
│  Each in its own pty-backed terminal                │
└─────────────────────────────────────────────────────┘
```

**Tech stack:**
- Electron 29, React 18, TypeScript 5, Vite 5 (electron-vite)
- `node-pty` for terminals, `xterm.js` for rendering
- Vitest for unit tests (2100+ tests, >90% line coverage)
- Playwright for E2E + screenshot captures
- electron-builder for packaging, Azure Trusted Signing for Windows, notarytool for macOS

---

## 32. Keyboard Shortcut Reference

Everything listed in Settings → Keybindings can be rebound there, except the three copy shortcuts. The panel shortcuts (the command palette, the Swarm dashboard and so on) are fixed. Defaults:

| Action                                  | Windows / Linux                | macOS               |
|-----------------------------------------|--------------------------------|---------------------|
| New terminal                            | `Ctrl+Shift+T`                 | `⌘⇧T`               |
| Close terminal                          | `Ctrl+Shift+W`                 | `⌘⇧W`               |
| Next terminal                           | `Ctrl+Tab`                     | `⌃Tab`              |
| Previous terminal                       | `Ctrl+Shift+Tab`               | `⌃⇧Tab`             |
| Jump to terminal 1–9                    | `Alt+1…9`                      | —                   |
| Launch Claude Code / Codex / Gemini CLI | `Ctrl+1` / `Ctrl+2` / `Ctrl+3` | `⌘1` / `⌘2` / `⌘3`  |
| Toggle split view                       | `Ctrl+Shift+G`                 | `⌘⇧G`               |
| Toggle sidebar                          | `Ctrl+B`                       | `⌘B`                |
| Find in terminal                        | `Ctrl+Shift+F`                 | `⌘⇧F`               |
| History search                          | `Ctrl+Shift+H`                 | `⌘⇧H`               |
| Clear terminal and scrollback           | `Ctrl+Shift+X`                 | `⌘⇧X`               |
| Keyboard select mode                    | `Ctrl+Shift+Space`             | `⌘⇧Space`           |
| Anchor select (click start, click end)  | `Alt+Shift+Click`              | `⌥⇧Click`           |
| Copy (when text is selected)            | `Ctrl+C`                       | `⌘C`                |
| Copy as plain text                      | `Ctrl+Shift+C`                 | `⌘⇧C`               |
| Copy for Teams/Slack                    | `Ctrl+Shift+K`                 | `⌘⇧K`               |
| Copy as code block                      | `Ctrl+Shift+Q`                 | `⌃⇧Q`               |
| Paste                                   | `Ctrl+V` or `Ctrl+Shift+V`     | `⌘V`                |
| Voice dictation (when enabled)          | `Ctrl+Shift+L`                 | `⌘⇧L`               |
| Command palette                         | `Ctrl+K`                       | `⌘K`                |
| Settings → Keybindings                  | `Ctrl+/`                       | `⌘/`                |
| Prompt templates                        | `Ctrl+Shift+P`                 | `⌘⇧P`               |
| Context panel                           | `Ctrl+Shift+E`                 | `⌘⇧E`               |
| Pinned context panel                    | `Ctrl+Shift+B`                 | `⌘⇧B`               |
| Changes panel                           | `Ctrl+Shift+J`                 | `⌘⇧J`               |
| Conversation search                     | `Ctrl+Shift+I`                 | `⌘⇧I`               |
| Activity feed                           | `Ctrl+Shift+A`                 | `⌘⇧A`               |
| Redundancy panel                        | `Ctrl+Shift+D`                 | `⌘⇧D`               |
| Efficiency panel                        | `Ctrl+Shift+Y`                 | `⌘⇧Y`               |
| Memory panel                            | `Ctrl+Shift+M`                 | `⌘⇧M`               |
| Swarm dashboard                         | `Ctrl+Shift+S`                 | `⌘⇧S`               |
| App log                                 | `Ctrl+Shift+O`                 | `⌘⇧O`               |
| New terminal, system-wide               | `Win+Shift+T`                  | `⌃⌥T`               |
| Swarm dashboard, system-wide            | `Win+Shift+S`                  | `⌃⌥S`               |
| Settings                                | Sidebar gear icon              | Sidebar gear icon   |
| Git panel                               | Sidebar → Git Panel            | Sidebar → Git Panel |
| Workflow Orchestrator                   | Sidebar → Workflows            | Sidebar → Workflows |

`Ctrl+C` copies only when text is selected; with nothing selected it reaches the shell as the usual interrupt. On macOS, `⌃C` always interrupts and `⌘C` copies.

The system-wide shortcuts work even while Termpolis is minimized, but only when no other program already owns the combo. If one does, Termpolis skips it and notes that in the app log. On Windows, `Win+Shift+S` is normally taken by the Snipping Tool.

On macOS, `⌘⇧Q` is the system Log Out shortcut, so use `⌃⇧Q` for Copy as Code Block.

---

## Final note

Termpolis is under active development. If you hit a rough edge, open an issue at [github.com/codedev-david/termpolis](https://github.com/codedev-david/termpolis/issues). If it's useful to you, consider [sponsoring the project](https://github.com/sponsors/codedev-david).

— David
