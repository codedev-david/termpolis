<p align="center">
  <img src="assets/logo-termpolis.png" alt="Termpolis Logo" width="200">
</p>

<h1 align="center">Termpolis — Secure AI-Assisted Development</h1>

<p align="center">
  <strong>The open-source multi-agent terminal where Claude, Codex, Gemini, and Qwen work together as a team — without your source code leaving the machine.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/🛡_Local--first-no_cloud_no_telemetry-1f6e3a?style=for-the-badge" alt="Local-first">
  <img src="https://img.shields.io/badge/🔒_No_browser/IDE_extension-0078d4?style=for-the-badge" alt="No extension">
  <img src="https://img.shields.io/badge/🔎_Auto--scan_every_prompt_(70+_patterns)-FFB74D?style=for-the-badge" alt="Auto-scan every prompt">
  <img src="https://img.shields.io/badge/📜_Auditable_outbound_log-7ee2a3?style=for-the-badge" alt="Audit log">
</p>

<p align="center">
  <a href="https://github.com/codedev-david/termpolis/issues/new?template=bug_report.md"><img src="https://img.shields.io/badge/%F0%9F%90%9B%20Found%20a%20bug%3F%20Report%20it-e53935?style=for-the-badge" alt="Submit a bug report"></a>
  &nbsp;
  <a href="https://github.com/codedev-david/termpolis/issues/new?template=feature_request.md"><img src="https://img.shields.io/badge/%E2%9C%A8%20Request%20a%20feature-1976D2?style=for-the-badge" alt="Request a feature"></a>
  &nbsp;
  <a href="https://github.com/codedev-david/termpolis/issues"><img src="https://img.shields.io/badge/%F0%9F%92%AC%20All%20issues-555555?style=for-the-badge" alt="All issues"></a>
</p>

<p align="center">
  <sub>🙏 <strong>We want to fix bugs fast.</strong> If anything is broken, please open an issue — we read every one.</sub>
</p>

<p align="center">
  Smart task routing assigns the right work to the right AI model.<br>
  An intelligent conductor that knows who plays what instrument best.<br>
  Local-first app — no Termpolis backend, no telemetry by default, no subscription.<br>
  <strong>Free and open source — your agents, your terminal, your rules.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="Apache 2.0 License">
  <img src="https://img.shields.io/badge/Windows-Code%20Signed-0078D4?logo=windows&logoColor=white" alt="Windows Code Signed">
  <img src="https://img.shields.io/badge/macOS-Notarized-000000?logo=apple&logoColor=white" alt="macOS Notarized">
  <a href="https://github.com/sponsors/codedev-david"><img src="https://img.shields.io/badge/sponsor-GitHub%20Sponsors-ea4aaa.svg" alt="Sponsor"></a>
</p>

---

### 🎯 Flagship Feature: Multi-Agent Swarm with Smart Routing

Describe your task. Termpolis analyzes it, breaks it into subtasks, and assigns each to the AI model that's best at that type of work — automatically.

```
You: "Refactor the auth module, write comprehensive tests,
      document the API, and review for security vulnerabilities"

Termpolis Smart Router:
  📝 Refactor auth module    → Claude Code (100/100) — strongest at refactoring
  🧪 Write tests             → Codex (95/100)        — top-rated for test writing
  📄 Document the API        → Gemini CLI (90/100)    — best at docs, lowest cost
  🔒 Security review         → Claude Code (95/100)   — best at code review

  💰 Token Budget: Claude ~$0.60 | Codex ~$0.23 | Gemini ~$0.10 | Total ~$0.93
```

A dedicated Claude Code instance acts as the conductor — it reasons about your task, delegates subtasks to agents via MCP tools, and monitors completion. You watch it happen in the Swarm Dashboard. Every assignment is transparent and overridable. When the swarm finishes, a summary dialog shows what each agent accomplished.

| Capability | Claude Code | Codex | Gemini CLI | Qwen Code |
|-----------|:-----------:|:-----:|:----------:|:---------:|
| Refactoring | ★★★★★ | ★★★★ | ★★★ | ★★★ |
| Testing | ★★★★ | ★★★★★ | ★★★ | ★★★ |
| Documentation | ★★★★ | ★★★★ | ★★★★★ | ★★★ |
| Code Review | ★★★★★ | ★★★ | ★★★★ | ★★★ |
| DevOps/Infra | ★★★ | ★★★ | ★★★★★ | ★★★ |
| Bulk Tasks | ★★★ | ★★★★ | ★★★ | ★★★★ |
| Token Cost | $$$$ | $$$ | $$ | $$ |

---

---

### 🛡 AI Security Center — what it actually does

**Honest framing first.** Any tool that lets you talk to a hosted model (Claude, Codex, Gemini, Qwen) is, by definition, sending your prompt to that provider. Termpolis cannot air-gap a prompt you choose to send, cannot guarantee a provider's stated retention policy is enforced server-side, and cannot stop a provider from later changing their terms. If your threat model requires those guarantees, run a local model — but accept the quality + hardware trade-off that comes with it.

What Termpolis **can** do is make the hosted path *substantially* safer than typing into a stock terminal, a browser, or a VS Code plug-in:

| Risk | What Termpolis does | Limit |
| --- | --- | --- |
| Pasted secret leaves the machine | Auto-scan: every Enter / paste in an AI terminal is matched against **70+ regex rules** (AWS, GitHub PATs, Stripe, GCP service accounts, JWTs, PEM keys, `.env`-style URLs…) before it reaches the PTY. Hits are redacted, banner shown. | Regex-shaped secrets only — a custom-format token nobody publishes a pattern for can still slip through. |
| Whole `.env` or source file pasted | **Code-chunk + env-dump detectors (v1.11.52)** flag prompts >2 KB that look like code (indentation + braces + keywords) or contain 5+ `KEY=value` lines. The renderer surfaces a notice + audit entry. | Heuristic — false negatives possible on minified or unusual code shapes. The prompt is not blocked; you decide. |
| Free-tier Gemini sending prompts to Google for product improvement | **Gemini account-mode auto-detection** reads `GEMINI_API_KEY` / `GOOGLE_GENAI_USE_GCA` / `GOOGLE_APPLICATION_CREDENTIALS`+`GOOGLE_CLOUD_PROJECT` to classify the active session. **Strict Mode** intercepts `gemini` launches that look free-tier and refuses to forward them. Blocked launches are audited. | Detection is env-var based; if you ship credentials some other way the heuristic can't see, it can't classify them. |
| Provider quietly changes their ToS / data-controls page | **Weekly ToS drift watcher (v1.11.52)** GitHub Action fetches the four provider pages we cite (Anthropic, OpenAI, Google, Alibaba), normalizes the HTML, hashes it, and opens a tracking issue when the hash changes — so the docs in *this* repo stay aligned with what the providers actually publish. | Detects rendered-text changes, not legal intent. A human still reads the diff. |
| Agent silently talking to an unexpected endpoint | **Egress audit (v1.11.52)** polls `netstat` (Windows) / `ss` (Linux) / `lsof` (macOS) once a minute for the AI agent's PID and records each unique remote `host:port` to the audit log + Security panel. So you can answer "did Claude talk to anything other than `api.anthropic.com` today?". | Polling, not packet capture — sub-minute bursts can be missed. No DNS reverse-lookup, no payload inspection. |
| Tampering surface beyond the terminal itself | No browser extension, no IDE plug-in, no ad-hoc cloud sync. The MCP server is bound to `127.0.0.1` with a token that rotates on every restart. No Termpolis telemetry, no Termpolis cloud accounts. | Termpolis is itself an Electron app — same caveats apply as any local desktop process running with your privileges. |
| Forensic record of what was typed at agents | **Local JSONL audit log**: every AI terminal open/close, every redaction hit, every code-chunk / env-dump detection, every Strict-Mode block. 10 MB rotated, append-only, on disk only, wipeable. | Local. We don't ship it anywhere. If your machine is compromised, so is the log. |

**What this is and isn't:** Termpolis is *defense in depth* for the hosted-model path — it raises the cost of accidental disclosure and gives you a record to audit. It is **not** a guarantee that source code cannot reach a provider — only not running the agent at all gives you that. The honest answer to *"can a hosted model leak my code?"* is "yes, if you send it; the question is whether the controls catch the obvious accidents and whether you trust the provider's terms for the rest." Termpolis is built for the engineers who've decided that trade-off is acceptable for the productivity hosted models give them.

See [`PRIVACY.md`](PRIVACY.md) for the data-flow spec, [`TERMS.md`](TERMS.md) for the Apache-2.0 / "AS IS" disclaimer.

### 🧠 Persistent Shared Memory — context that lasts across agents, terminals, and restarts

Every Claude session today starts cold; you re-explain what you're doing and burn 20–50K tokens reloading context. Termpolis fixes that with a **local memory brain that all four agents share** and that **persists between terminals, between agents, and between app restarts.**

- **One memory, four agents.** Claude, Codex, Gemini, and Qwen all read and write the same store over the built-in MCP server (`memory_search` / `memory_write` / `memory_list`). A fact one agent figures out is instantly available to the others — no copy-paste, no re-discovery.
- **It survives quitting the app.** Stored as plain JSONL on disk (`~/.termpolis/swarm-memory.jsonl`) and reloaded with its embeddings at startup — close Termpolis, reopen it tomorrow, the context is still there.
- **It feeds itself.** A background indexer ingests your past Claude / Codex / Gemini transcripts automatically (10 s after launch, then every 30 min). Idempotent (content-hash dedup), so it only ever embeds genuinely new content — no action required from you.
- **Fully offline, no server, no secrets.** Embeddings run in-process via WASM with a bundled `bge-small-en-v1.5` model — **no Ollama, no native binaries, nothing leaves your machine.** The indexer reuses the same sensitive-file denylist as the read watcher, so `.env` files, keys, and cloud credentials are never embedded.

**How it works:**

1. **Capture** — your on-disk AI transcripts are parsed (tool-call / reasoning / system-prompt noise stripped) and split into chunks.
2. **Embed** — each chunk becomes a 384-dim vector locally, in-process, via `onnxruntime-web` (WASM).
3. **Store** — chunks + vectors persist in a durable on-disk log, deduplicated by content hash so re-indexing is cheap.
4. **Recall** — any agent calls `memory_search` over MCP and gets the most relevant past context back, blending semantic vector search with keyword matching.

The result: stop re-explaining context every session, and stop paying to reload it.

**Controls** — open the **Memory panel** (`Ctrl+Shift+M`, or the Command Palette → "Memory") to see what's remembered (chunk count), search it, feed it on demand ("Index past conversations" / "Index this repo's code"), and **inject the most relevant context into the active agent** with one click.

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

> **\* Windows SmartScreen note:** SmartScreen may show a "Windows protected your PC" warning for newly signed software. Click **"More info"** then **"Run anyway"** to proceed. Termpolis is digitally signed and safe to install — the warning disappears as download reputation builds.

## Features

### Terminal Management
- **Multi-terminal sessions** — open as many terminals as you need in one window
- **Tab View** — single terminal at a time, switch via sidebar
- **Split View** — split any terminal horizontally or vertically with draggable dividers
- **Nested splits** — split panes recursively for complex layouts (like VS Code or iTerm2)
- **Workspaces** — save and restore terminal configurations including names, shells, themes, and working directories
- **Session persistence** — terminals, workspaces, and settings auto-restore on relaunch
- **Single-instance lock** — only one Termpolis window runs at a time to prevent session conflicts
- **Drag and drop** — drag files onto a terminal to paste their quoted file paths

### Shell Support
- **PowerShell**, **Bash**, **Zsh**, **Cmd**, **Git Bash** — auto-detected per OS
- **Shell config editor** — edit .bashrc, .zshrc, PowerShell profiles with Monaco Editor

### AI-Native Features
- **AI Session Profiles** — one-click launch profiles for Claude Code, Codex, Gemini CLI, and Qwen Code with custom profiles support
- **Command Palette** — `Ctrl+K` opens a natural language command bar to control the app (new terminal, split panes, launch agents, run commands)
- **Prompt Templates** — save reusable prompt snippets (Fix Tests, Code Review, Refactor, etc.) and insert them with `Ctrl+Shift+P` (accessible via Command Palette)
- **Multi-Agent Workflow Templates** — built-in split-pane layouts (Claude + Shell, Full Stack Dev, Code Review) plus a visual editor to create, edit, and save your own custom workflows (name, icon, layout, 1–8 terminals each with shell + startup command + color, persisted across restarts)
- **Agent Status Detection** — automatically detects when Claude Code, Codex, Gemini, or Qwen Code is running and shows a colored badge in the status bar
- **Cost Tracking** — parses token usage and cost from AI agent output, displays running totals in the status bar
- **Session Recording** — record terminal sessions with timestamps, export as shareable text logs
- **Output Pinning** — pin important output blocks to a persistent panel that stays visible as the terminal scrolls
- **Diff Viewer** — detects `git diff` output and renders it with syntax highlighting (green/red for additions/deletions)
- **Smart Context Panel** — `Ctrl+Shift+E` opens a side panel showing file tree, git status, and recent commits for the current directory
- **Conversation History** — `Ctrl+Shift+I` searches across all AI agent conversations indexed from terminal output

### MCP Server & Agent Integration
- **MCP Server** — built-in HTTP/SSE server on `localhost:9315` with 14 tools for AI agents to control terminals programmatically
- **Auto-registers with Claude Code** — on launch, Termpolis injects itself into `~/.claude/settings.json` so Claude Code can use it as an MCP server immediately. Zero configuration needed.
- **Stdio Adapter** — for agents that use stdio-based MCP, a standalone adapter script proxies to the HTTP server
- **CLI Tool** — `termpolis-cli` lets you control Termpolis from any terminal (`list`, `create`, `run`, `read`, `close`, `files`, `git`)
- **Auth Token** — 256-bit random token per launch, required on all endpoints. Localhost only, CORS restricted.

### Context Handoff
- **Seamless agent switching** — when an AI agent runs out of context/tokens, an amber banner offers to switch to another agent
- **Automatic context capture** — captures your task, git branch, modified files, recent commands, diff summary, and recent output
- **One-click handoff** — click "Switch to Codex" (or Gemini/Qwen Code) to launch the new agent with your full context pre-loaded
- **Editable handoff prompt** — preview and customize the context before switching via the "More Options" modal
- **Keep or close** — choose whether to keep the old terminal for reference or close it

### Multi-Agent Swarm

No AI company has built a tool that brings together competing models to work as a team — because it helps their competitors. Termpolis does it anyway, because it moves AI forward.

- **AI Conductor** — a dedicated Claude Code instance runs as the swarm conductor. It receives your task description, reasons about how to break it into subtasks, assigns each subtask to the best agent via MCP tools, and monitors completion. This is live AI orchestration — not keyword matching.

- **Smart Task Routing** — the conductor assigns subtasks to the best agent based on a customizable capability matrix. Scores are transparent (0-100) with human-readable reasons explaining every assignment. Token-heavy work is routed to cheaper agents for cost efficiency. Every assignment can be manually overridden. Default ratings are estimates based on general model capabilities — customize them in **Settings > Agent Capability Ratings** based on your experience. The conductor uses ratings as hints but makes its own judgment.

  | Capability | Claude Code | Codex | Gemini CLI | Qwen Code |
  |-----------|:-----------:|:-----:|:----------:|:---------:|
  | Refactoring | ★★★★★ | ★★★★ | ★★★ | ★★★ |
  | Testing | ★★★★ | ★★★★★ | ★★★ | ★★★ |
  | Documentation | ★★★★ | ★★★★ | ★★★★★ | ★★★ |
  | Code Review | ★★★★★ | ★★★ | ★★★★ | ★★★ |
  | DevOps/Infra | ★★★ | ★★★ | ★★★★★ | ★★★ |
  | Bulk Tasks | ★★★ | ★★★★ | ★★★ | ★★★★ |
  | Token Cost | $$$$ | $$$ | $$ | $$ |

- **Swarm Wizard** — 3-step flow: prepare conductor → describe task → launch. Includes guidance on when to use a swarm (autonomous task completion) vs individual agent terminals (back-and-forth conversation). Live progress tracking shows conductor status in real time — the modal stays open until the first task or message appears (can take up to 30 seconds).
- **Agents run in the background** — swarm-spawned agent terminals are hidden from the sidebar. The conductor drives all work via MCP tools (creating files, running commands, coordinating agents) and posts progress to the dashboard. For back-and-forth conversations, launch individual agents from the AI Agents sidebar section — those still appear in the sidebar and work normally.
- **Swarm Complete Dialog** — when all tasks finish, a summary dialog appears showing completed vs failed tasks with the result from each agent. Includes "What next?" guidance for iterating with individual agents or starting a new swarm.
- **Swarm Review Panel** — a swarm can create a brand new project or modify an existing one. When it finishes, click **Review Changes** to open a per-hunk diff viewer showing the full delta from the pre-swarm HEAD. Accept or reject individual hunks (or entire files), run the project's test command against the result, then commit only the changes you want. `git reset --hard` back to the pre-swarm SHA cleanly reverts everything.
- **Agent Command Enforcement** — agents are guaranteed to launch correctly regardless of what the conductor attempts. A programmatic sanitizer intercepts all `run_command` calls on swarm terminals, stripping unauthorized flags (`-p`, `--sandbox`, `--print`) and enforcing the exact approved command for each agent. Claude gets `--dangerously-skip-permissions`, Codex gets `--full-auto` — no trust prompts, no permission dialogs during swarms.
- **Interactive Agent Mode** — all agents (including Gemini CLI) launch in interactive mode so they retain full tool access, including file writing and command execution.
- **Token Budget Estimates** — shows per-agent estimated tokens and cost before you launch, so you know what the swarm will cost
- **Swarm Dashboard** — `Ctrl+Shift+S` opens a real-time view with two tabs: **Tasks** (kanban: Pending · In Progress · Completed · Failed) and **Messages** (chronological log). Also accessible by clicking the "Swarm Active" indicator in the bottom status bar.
- **Clear Confirmation** — clearing a swarm requires explicit confirmation to prevent accidental loss of in-progress work
- **Agent Install Status** — the AI Agents sidebar shows green checkmarks for installed agents and red X icons for missing ones. Clicking a missing agent's icon shows installation instructions.
- **Message Bus** — agents communicate through a shared message queue with typed messages (task, result, question, info, review)
- **Task Queue** — create tasks, assign to agents, track status across Pending → In Progress → Completed
- **MCP-native end to end** — Claude Code, Codex, Gemini CLI, and Qwen Code all speak MCP. No terminal-output bridges, no parser glue, no special-case code paths.
- **6 swarm MCP tools** — `swarm_send_message`, `swarm_read_messages`, `swarm_create_task`, `swarm_list_tasks`, `swarm_update_task`, `swarm_list_agents`
- **Open-weight Qwen option** — Qwen Code is Alibaba's MCP-native CLI for the Qwen3-Coder family, a non-Anthropic, non-Google option in the swarm.

### AI Observability

When you're running multiple AI agents concurrently (or a whole swarm), you need to see what each is doing, spot when they duplicate work, and know when one is about to run out of context. Termpolis ships a full observability layer that doesn't require any external dashboard — everything is local, capped in memory, and tested end-to-end.

- **Activity Feed** — `Ctrl+Shift+A` opens a live stream of every agent event. Captures messages, tool calls, tool results, token updates, compaction events, errors, status changes, and MCP audit entries. Filter by agent (claude/codex/gemini/qwen-code), by kind, or search full text. Newest first.
- **Context Pins** — pin any snippet (migration rule, test policy, API contract) scoped to the current project. Pins are re-injected on agent handoff so the new agent doesn't lose the plot. Per-project storage, full CRUD.
- **Redundancy Detector** — `Ctrl+Shift+D` shows duplicate work across terminals. If two agents are running `npm test` at the same time or both editing the same file, you'll see a severity-ranked finding with the affected terminals.
- **Efficiency Panel** — `Ctrl+Shift+Y` aggregates per-agent stats: token totals, cost, error rate, average tool-call duration. Spot when one agent is burning budget while another is cruising.
- **Event Bus** — in-process, bounded ring buffer (10k events), rate-limited (500 events/sec burst) to prevent DoS from a runaway agent. Persisted to JSONL with automatic rotation. Subscriber callbacks are try/caught so a bad listener can't kill the bus. All event payloads are 64KB-capped before persistence.
- **Transcript Watchers** — native JSONL readers for Claude Code, Codex, and Gemini transcript formats. Tail-with-rotation: if the agent rotates its log mid-run, the watcher follows. Path traversal is blocked at the watcher boundary.
- **Swarm Dashboard enhancements** — the dashboard (`Ctrl+Shift+S`) now shows live token burn per agent, tasks in kanban columns, and the full conductor message log. Every panel streams from the same event bus — no polling lag.

### Intelligence
- **AI Command Suggestions** — type natural language in any terminal and get instant shell command suggestions. 30+ built-in patterns covering file search, git operations, npm/yarn, Docker, process management, system info, compression, and downloads. Captures values from your input (e.g., "kill port 3000" becomes `kill $(lsof -t -i:3000)`). Tab to accept, arrow keys to navigate, Esc to dismiss. Zero latency — all local pattern matching, no API calls.
- **Command autocomplete** — VS Code-style dropdown with command names, subcommands, and flags. Bundled specs for 20+ common tools (git, docker, npm, kubectl, curl, and more)
- **Command auto-fix** — mistype a command? A green banner suggests the correction. Press Enter to run or Esc to ignore. Detects typos, permission errors, wrong flags, and more
- **Command history search** — search across all terminals with Ctrl+Shift+H

### Git Panel
- **Built-in git panel** — accessible from the sidebar git icon. Shows current branch, staged and unstaged file lists with status indicators (M/A/D/R/U), stage or unstage individual files or all at once, commit with message, and pull/push buttons. Includes an inline diff viewer with syntax highlighting. Auto-detects git repos or lets you pick a folder (VS Code-style). Collapsible sections, auto-refreshes every 3 seconds.

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
- **Full Unicode support** — emoji, CJK characters, and special glyphs render correctly
- **React ErrorBoundary** — catches render crashes gracefully with a recovery UI instead of white screen of death. Terminals survive UI errors.
- **Sentry crash reporting** (optional) — set `VITE_SENTRY_DSN` and `SENTRY_DSN` env vars to enable. Strips PII, redacts paths. Disabled by default.
- **1,400+ automated tests** — 1,400+ unit tests (Vitest, 90% line coverage) + 140+ E2E tests (Playwright). Coverage is maintained at 90%+ as a hard gate — no commits allowed below this threshold.

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
| `Ctrl+Space` | Trigger autocomplete |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+Shift+G` | Toggle split view |
| `Ctrl+Shift+P` | Prompt templates |
| `Ctrl+Shift+E` | Smart context panel |
| `Ctrl+Shift+I` | Conversation history search |
| `Ctrl+Shift+S` | Swarm dashboard |
| `Ctrl+Shift+A` | Activity feed (agent events) |
| `Ctrl+Shift+D` | Redundancy panel (duplicate work) |
| `Ctrl+Shift+Y` | Efficiency panel (per-agent stats) |
| `Win+Shift+T` | New terminal (global, works when minimized) |

> On macOS, use `Cmd` instead of `Ctrl`.

## MCP Server

Termpolis runs an MCP (Model Context Protocol) server on `localhost:9315` that AI agents can connect to via HTTP/SSE.

### Claude Code Integration

Termpolis **auto-registers** with Claude Code on launch — it adds itself to `~/.claude/settings.json` so Claude Code sees it as an MCP server immediately. No manual configuration needed.

### Available Tools (14)

**Terminal Management:**

| Tool | Description |
|------|-------------|
| `list_terminals` | List all open terminals with IDs, names, shells, and cwds |
| `create_terminal` | Create a new terminal with name, shell, and working directory |
| `run_command` | Send a command to a terminal (types it and presses Enter) |
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
# {"status":"ok","name":"termpolis-mcp","version":"1.2.0","tools":8,"auth":"required"}
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

### What Users Should Know
- Terminal sessions run with your user permissions — same as any terminal application
- AI agents launched through profiles (Claude Code, Codex, etc.) have the same access as if you ran them manually
- The MCP token rotates on every app restart — a compromised token becomes invalid when you close the app
- No Termpolis telemetry, no analytics, no Termpolis cloud accounts — Termpolis stores everything (sessions, history, pins, audit log, settings) locally. (AI agents you launch still talk to their own providers per those providers' privacy policies; see [`PRIVACY.md`](PRIVACY.md) for the full data-flow spec.)

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

650+ total tests:
- `npm test` — 1,400+ unit tests (Vitest, 75 test files, 90% coverage)
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
│           ├── WorkflowTemplates/   # Multi-agent workspace templates
│           ├── ContextPanel/        # File tree, git status, recent commits
│           ├── ConversationSearch/  # AI conversation history search
│           ├── DiffViewer/          # Syntax-highlighted diff rendering
│           ├── PinnedOutput/        # Persistent pinned output panel
│           ├── CompletionDropdown/  # Autocomplete dropdown overlay
│           ├── CommandFix/          # Inline correction banner
│           ├── StatusBar/           # App footer + per-terminal status bar
│           ├── SettingsPane/        # Settings + keybindings + Monaco config editor
│           └── HistorySearch/       # Command history search modal
├── tests/                           # Vitest test suites (1,400+ tests, 75 files, 90% coverage)
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

Saved state includes: terminals, workspaces with working directories, default shell, view mode, keybindings, AI profiles, and prompt templates.

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
