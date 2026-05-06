# Termpolis Documentation

The definitive guide to Termpolis — **Secure AI-Assisted Development**. The local-first multi-agent terminal where Claude, Codex, Gemini, and Qwen work as a team, coordinated by a dedicated AI conductor, **without your source code leaving the machine**.

This document covers installation, the AI Security Center, the share-to-Slack/Teams workflow, every feature, every panel, every keyboard shortcut, and the architecture behind the swarm. Screenshots live in `../e2e/screenshots/docs/` and are mirrored to the website at `termpolis-web/docs/screenshots/`.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Installation](#2-installation)
3. [First Launch & Welcome Screen](#3-first-launch--welcome-screen)
4. [The Sidebar](#4-the-sidebar)
5. [Terminals](#5-terminals)
6. [Tab, Split & Grid Views](#6-tab-split--grid-views)
7. [Settings](#7-settings)
8. [Themes](#8-themes)
9. [Keybindings](#9-keybindings)
10. [Agent Capability Ratings](#10-agent-capability-ratings)
11. [Command Palette](#11-command-palette)
12. [Prompt Templates](#12-prompt-templates)
13. [Workflow Templates](#13-workflow-templates)
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
25. [Shared Memory (RAG)](#25-shared-memory-rag)
26. [Observability](#26-observability)
27. [Status Bar](#27-status-bar)
28. [Troubleshooting](#28-troubleshooting)
29. [Architecture](#29-architecture)
30. [Keyboard Shortcut Reference](#30-keyboard-shortcut-reference)

---

## 1. Overview

![Welcome screen](../e2e/screenshots/docs/01-welcome-screen.png)

Termpolis is a cross-platform desktop terminal manager (Windows, macOS, Linux) built on Electron + React + TypeScript with `node-pty` powering the underlying shells. It ships as a native app — code signed on Windows, notarized on macOS.

**What makes it different:**

- **Secure AI-Assisted Development**: a built-in AI Security Center (Settings → Security) ships a pre-paste secret scanner, Gemini paid-tier auto-detection, Strict Mode enforcement, a local JSONL audit log, and per-provider training-disposition facts sourced from live ToS pages. See the [Security](#security-center) section.
- **Multi-agent swarm**: Claude Code, Codex, Gemini CLI, and Qwen Code work together on a task. A dedicated Claude Code instance acts as the conductor.
- **MCP server** baked in: AI agents can control Termpolis via Model Context Protocol — open terminals, run commands, send messages.
- **Transparent routing**: every subtask shows *which* agent got it, *why*, and *what it cost*.
- **Activity observability**: every token, every tool call, every message from every agent is visible in real time.
- **Intervention controls**: pause, cancel, or steer any agent mid-task without leaving the feed.
- **Shared memory**: a RAG-backed memory store that any agent can read and write via MCP.
- **MCP-native end to end**: all four agents speak MCP — no terminal-output bridges, no parser glue, no special-case code paths.
- **Share-ready output**: a four-way Copy submenu (`Ctrl+Shift+M`) — Copy as Code Block, Plain Text, With Command, or PNG Image — turns any terminal selection into a Slack/Teams/PR-ready paste. See [Copy for Slack / Teams / PRs](#copy-for-slack-teams-prs).

Everything is built around the idea that **you're not writing code alone anymore** — you're orchestrating a team, and you need the tools to do it well, securely.

## Security Center

The **AI Security Center** at Settings → Security is the security backbone of Termpolis. Every check runs on the local machine. None of these features send data to Termpolis or any third party.

- **Per-provider training-disposition facts.** Live ToS-sourced summaries: Claude (default off), Codex (default off), Gemini paid (excluded), Gemini free OAuth (Google may use prompts, flagged yellow), Qwen Code paid DashScope (excluded) / local Ollama (never leaves machine).
- **Pre-paste secret scanner.** Regex detection of AWS keys, GitHub PATs, OpenAI/Anthropic/Google API keys, JWTs, PEM private keys, and `.env`-style assignments. Returns redacted preview. Not a full DLP — custom corporate tokens may not match.
- **Gemini account-mode auto-detection.** Reads `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_USE_GCA`, and `GOOGLE_APPLICATION_CREDENTIALS`+`GOOGLE_CLOUD_PROJECT` to identify which tier the Gemini CLI will hit (Vertex / Code Assist / Paid API key / Free OAuth).
- **Strict Mode — block free-tier Gemini.** When ON, Termpolis intercepts shell-level `gemini` invocations and refuses to forward them unless paid-tier credentials are detected. Blocked launches are recorded in the audit log as `BLOCKED: strict-mode + free-tier`.
- **Local JSONL audit log.** Every AI-agent terminal launch can be appended to `ai-security-audit.jsonl` in userData. Append-only, 10 MB rotated. Wipeable from Settings.
- **Legal disclaimer.** Apache 2.0 "AS IS". Full disclaimer in `TERMS.md` §5a and inline in Settings → Security.

## Copy for Slack / Teams / PRs

The terminal right-click menu has a **Copy →** submenu with four share-ready actions, plus the `Ctrl+Shift+M` keybinding (rebindable).

- **Copy as Code Block** — wraps the selection (or the visible buffer) in triple-backtick fences. Drop into Slack, Teams, GitHub, GitLab, Notion — any markdown surface.
- **Copy as Plain Text** — strips ANSI color escapes and copies clean text. Email-, Jira-, doc-ready.
- **Copy with Command** — prepends the last shell command before fencing. Reproducer-ready snippets for bug reports.
- **Copy as Image (PNG)** — renders the xterm.js canvas to a PNG with `canvas.toBlob`, writes via `ClipboardItem`. Pastes into Slack/Teams/Loom with colors, glyphs, and layout intact.

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

- **Quick launch buttons** for PowerShell, Bash, Zsh, WSL, plus any AI agent profiles you have.
- **Recent workspaces** on the left sidebar.
- **Tips and shortcuts** — an at-a-glance primer on the command palette, splits, and the swarm.

Press **`Ctrl+T`** (`⌘T` on macOS) to open the new-terminal modal, or click any launch button to spawn one immediately.

---

## 4. The Sidebar

![Sidebar — default state](../e2e/screenshots/docs/02-sidebar-default.png)

The sidebar is the navigation spine of the app. From top to bottom:

1. **Termpolis logo / brand** — click to return to the welcome view.
2. **Workspaces** — one row per open workspace. Each workspace is a named container of terminals, preserved across restarts.
3. **Tool buttons** — Settings, Git Panel, Workflows, Activity, Swarm — each toggleable.
4. **Collapse / expand** — click the chevron at the bottom to hide labels and save space.

### Workspaces

Workspaces are the **project-level container** in Termpolis — think of them as the tabs in a browser, except each one holds a full set of terminals, a split/grid layout, an active agent, a scrollback history, per-workspace settings, and any panels you've left pinned (activity, context, git, swarm). You can run many workspaces side-by-side and switch between them without losing state.

**What a workspace owns:**

- **Terminals** — every open pty in that workspace, with its shell, working directory, label, color, and scrollback buffer.
- **Layout** — tab view, split view (the full pane tree), or grid view. Restored exactly on relaunch.
- **Focus** — which terminal was active, cursor position, selection.
- **Agent sessions** — any Claude Code, Codex, Gemini, or Qwen Code runs tied to terminals in the workspace.
- **Panel state** — which side panels are open and their size.
- **Per-workspace overrides** — if you've changed a setting scoped to this workspace (shell default, font size, etc.).

**How workspaces persist.** Everything above is written to `session.json` in the Termpolis data directory (see [§2](#2-installation) for the per-platform path) as soon as it changes — so an unclean shutdown still leaves you with last-known-good state. Re-opening the app restores the workspaces in the same order with the same terminals, split layouts, and focus.

**Creating a workspace.** Use the **+ Workspace** button at the top of the sidebar or the `Ctrl+Shift+N` shortcut. Each new workspace starts empty; pick a shell to open the first terminal, or apply a workflow template (see [§13](#13-workflow-templates)) to stamp a whole pre-built layout into it.

**Managing workspaces.** Right-click any workspace row in the sidebar for:

- **Rename** — changes the label in the sidebar and the window title when the workspace is active.
- **Duplicate** — creates a new workspace with the same terminal configuration (shell, cwd, label) but fresh, empty pty sessions. Handy when you want to mirror a setup for a second feature branch.
- **Close** — removes the workspace. If any terminals in it have live child processes, you'll get a confirmation dialog listing what's still running.
- **Show in file explorer** — opens the workspace's working directory in Finder / Explorer / your Linux file manager.

**Switching between workspaces.** Click a workspace row to activate it. Keyboard users can cycle with `Ctrl+Alt+[` / `Ctrl+Alt+]`. Unsaved terminal output in background workspaces keeps streaming — nothing is paused just because it's not visible.

**Workspace root directory.** Each workspace has a default working directory that new terminals start in. Set it when you create the workspace, or change it later from Settings → Workspace. Terminals started with the agent launcher or a workflow template inherit this unless they override it per-terminal.

**How workspaces differ from workflows.** Workspaces are *long-lived containers* that own state across restarts; workflows are *one-shot recipes* that populate the current workspace with a pre-configured set of terminals, commands, and a split layout. You can think of a workspace as the room you're working in, and a workflow as the "set the room up like this" macro. Launching a workflow inside a workspace closes any existing terminals in that workspace and replaces them with the workflow's terminals — the workspace stays, the contents get reset. Workflows have no independent persistence beyond the template itself. See [§13](#13-workflow-templates).

---

## 5. Terminals

![New terminal modal](../e2e/screenshots/docs/03-new-terminal-modal.png)

Every pane in Termpolis is a full pty-backed terminal powered by `node-pty`. That means xterm-compatible escapes, real TTY semantics, signal forwarding — not a shim.

### Creating a terminal

`Ctrl+T` opens the new-terminal modal (shown above). Pick:

- **Shell**: PowerShell 7, Windows PowerShell, CMD, Bash, Zsh, Fish, WSL — whatever your system has.
- **Working directory**: defaults to the workspace root; override per-terminal.
- **Agent profile** (optional): launches with an AI CLI already running. See [AI Agent Profiles](#18-ai-agent-profiles).
- **Label + color**: helps you tell terminals apart in split view.

### Running terminal

![Terminal running](../e2e/screenshots/docs/04-terminal-running.png)

Once running, the terminal supports:

- Copy on selection (configurable), paste via `Ctrl+Shift+V` / `⌘V`.
- Mouse scroll, link clicks (`Ctrl+Click` to open), image rendering via Sixel when the shell emits it.
- Full 256-color + truecolor palettes.
- Right-click for a context menu: copy, paste, clear, split, close.

### Close confirmation

Closing a terminal that has an active process prompts for confirmation. This protects against accidental loss of long-running tasks like model downloads, build jobs, or agent sessions.

---

## 6. Tab, Split & Grid Views

![Tab view with multiple terminals](../e2e/screenshots/docs/05-tab-view-multiple.png)

Terminals are arranged inside a workspace in one of three view modes:

### Tab view (default)

![Split view](../e2e/screenshots/docs/06-split-view.png)

Each terminal gets a tab. Click a tab to focus, drag to reorder, middle-click to close. `Ctrl+1`…`Ctrl+9` jumps to the Nth tab.

### Split view

Splits are horizontal or vertical — recursive, so you can split a split. Drag the divider to resize.

Keyboard shortcuts:
- `Ctrl+\` — split horizontally
- `Ctrl+Shift+\` — split vertically
- `Alt+Arrow` — focus adjacent pane
- `Ctrl+Shift+W` — close focused pane

### Grid view

Turns open terminals into a grid — great for watching 4 or 6 agents at once. Sizes auto-fit the window.

### View mode toggle

The top-right toolbar has three buttons: **Tab View**, **Split View**, **Grid View**. Your choice is remembered per workspace.

---

## 7. Settings

![Settings panel](../e2e/screenshots/docs/07-settings-panel.png)

Open with the gear icon in the sidebar, or press `Ctrl+,`. The settings panel slides in from the right. Tabs across the top group the settings:

- **Themes** — color palette, syntax, and terminal colors.
- **Keybindings** — every shortcut is rebindable.
- **Agent Capability** — score each AI model across 10 capability categories, influencing swarm routing.
- **Shells** — default shell per OS, custom shell commands, startup arguments.
- **Behavior** — confirm on close, copy on select, scrollback size, cursor style, font.
- **Advanced** — experimental flags, telemetry (off by default), log levels.

Changes save immediately. There is no "apply" button — edits are persisted to `settings.json` in your data directory.

---

## 8. Themes

![Themes picker](../e2e/screenshots/docs/08-themes-picker.png)

Termpolis ships with a curated set of dark themes tuned for long coding sessions: **Termpolis Dark** (default), Dracula, Solarized Dark, Nord, Gruvbox Dark, Tokyo Night, Monokai. Each applies to:

- The terminal background, foreground, and ANSI palette.
- The app chrome (sidebar, status bar, title bar).
- Syntax highlighting inside AI conversation panels.

You can import any VS Code theme JSON via the **Import theme** button. The parser maps VS Code tokenColors to xterm colors automatically.

---

## 9. Keybindings

![Keybindings settings](../e2e/screenshots/docs/09-keybindings.png)

Every user-facing action has a keybinding. The Keybindings tab lists them grouped by category (Navigation, Terminals, View, Agents, Swarm, Git). To rebind:

1. Click the current binding.
2. Press the new combo. The modal shows conflicts inline.
3. Press **Save** or **Reset** to restore default.

Bindings are platform-aware — `Ctrl` becomes `⌘` on macOS automatically. Conflicts across OS are flagged.

See [§30](#30-keyboard-shortcut-reference) for the complete default list.

---

## 10. Agent Capability Ratings

![Agent capability ratings](../e2e/screenshots/docs/10-agent-capability-ratings.png)

The heart of smart swarm routing. This tab lets you score each agent (Claude Code, Codex, Gemini CLI, Qwen Code) across 10 categories:

1. Refactoring
2. Testing
3. Documentation
4. Code review
5. DevOps / Infra
6. Debugging
7. Frontend
8. Backend / API
9. Data / SQL
10. Bulk / long-running

Scores are 0–100. Defaults reflect model-family strengths as of release. You can tune them to match your own experience — the conductor uses these weights when it decides who gets what subtask.

The **Token Cost** column is a relative indicator ($, $$, $$$) used for cost-aware routing.

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

## 13. Workflow Templates

![Workflow templates](../e2e/screenshots/docs/13-workflow-templates.png)

Workflows are **one-shot setup recipes** for a workspace. Each template describes a set of terminals — their names, colors, shell, optional startup command — and a layout (vertical splits or a 2×2 grid). Clicking **Launch** closes the terminals you have open, spawns the template's terminals in the configured split layout, and fires the startup commands after a brief delay so the shells finish initializing first.

Open the Workflows panel from the **Workflows** sidebar button.

### Built-in templates

- **Claude Code + Shell** — Claude Code on the left, plain shell on the right (2-pane vertical split).
- **Full Stack Dev** — AI agent + Frontend + Backend + Tests in a 2×2 grid.
- **Code Review** — AI reviewer + Git pane (2-pane vertical split).

Built-ins are read-only. Use **Duplicate** on a built-in to get an editable copy with the `(copy)` suffix.

### Creating your own

Click **+ New Workflow** at the bottom of the picker. You get a form for:

- **Name** and **Description**
- **Icon** (Font Awesome solid) and **Layout** (vertical splits or 2×2 grid — the grid requires exactly four terminals to tile cleanly)
- **Terminals** (1–8) — per terminal: name, startup command (optional), shell, and color

Saved workflows appear with a **Custom** badge in the picker, are persisted as part of your session alongside workspaces and prompt templates, and sync via the same save mechanism (`session.json` in your Termpolis data directory). You can **edit** or **delete** any custom workflow from its row. On Windows, templates that specify `bash` are auto-resolved to Git Bash.

### Difference from workspaces

Workflows don't *own* state the way workspaces do — they're a template you apply. After launch, the terminals they spawn live inside your current workspace and behave like any other terminals. Closing and re-launching the same workflow gives you fresh terminals, not the ones from last time.

---

## 14. Context Panel

![Context panel](../e2e/screenshots/docs/14-context-panel.png)

`Ctrl+Shift+E` toggles the context panel. It shows what's "in scope" right now:

- Current git branch, ahead/behind counts, dirty state.
- Focused terminal, working directory, running command.
- Active agent session (if any) with a live token count.
- Recent files edited in the workspace.
- Pins — anything you've pinned from the activity feed or the memory store.

The context panel is also the pane agents read from when you ask "what am I looking at?" — it's explicit context sharing, not implicit slurp.

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

- Filter by agent (Claude / Codex / Gemini / Qwen Code).
- Filter by kind (prompt, tool call, tool result, error).
- Full-text search with highlighting.
- Time range.

Each hit deep-links into the original session so you can reopen it, re-prompt, or copy a successful flow.

---

## 17. Git Panel

![Git panel](../e2e/screenshots/docs/17-git-panel.png)

Sidebar button or `Ctrl+Shift+G`. The Git panel is a lightweight GUI for what you usually do at the CLI:

- **Current branch**, ahead / behind counts.
- **Staged** and **unstaged** sections with file-by-file diff inline.
- **Commits** — graph view of the last 50 commits on the current branch.
- **Actions** — stage/unstage, commit (with message input), push, pull, fetch, stash, create branch, switch branch.
- **AI-assisted commit message** — click the ✨ next to the message input, and an agent drafts a message from the staged diff.

Every action runs as a real git command in a spawned process — no reimplementation — so you can always drop to the CLI and see the same state.

---

## 18. AI Agent Profiles

Launch any AI CLI as a profiled terminal: Claude Code, Codex, Gemini CLI, Qwen Code. Profiles come pre-configured with:

- The correct shell + startup command.
- A color + label for visual distinction.
- An MCP bootstrap so the agent can control Termpolis.
- A distinct working directory if you want one.

Custom profiles take any command — if it's in your PATH, you can profile it. Add them in Settings → Agents.

---

## 19. MCP Server

Termpolis ships an **MCP (Model Context Protocol) server** so AI agents can control the app from inside a conversation. It listens on `http://localhost:48211` by default (port configurable).

### Available tools (17 total)

| Tool                | Description                                           |
|---------------------|-------------------------------------------------------|
| `list_terminals`    | Enumerate open terminals with IDs, labels, cwd        |
| `open_terminal`     | Spawn a new terminal with a given shell + cwd         |
| `close_terminal`    | Close a terminal by ID                                |
| `focus_terminal`    | Bring a terminal to the foreground                    |
| `send_input`        | Send raw text + control chars to a terminal           |
| `read_buffer`       | Read the last N lines of a terminal's output          |
| `wait_for_prompt`   | Wait until a terminal emits a regex match             |
| `list_workspaces`   | Enumerate workspaces                                  |
| `switch_workspace`  | Change active workspace                               |
| `git_status`        | JSON summary of the current repo                      |
| `broadcast_message` | Send a swarm-wide notification                        |
| `get_session_id`    | Returns the calling session's opaque ID               |
| `post_activity`     | Push an AgentActivity event into the feed             |
| `memory_write`      | Persist a labeled memory entry into the shared store  |
| `memory_search`     | RAG search across shared memory (semantic + keyword)  |
| `memory_list`       | List recent memory entries                            |

The server is authenticated via a per-launch token that lives in `~/.termpolis/mcp-token` — agents read it at startup. Misuse resistance includes tight origin checks, rate limits, and an audit log.

---

## 20. Swarm Dashboard

![Swarm dashboard](../e2e/screenshots/docs/18-swarm-dashboard.png)

`Ctrl+Shift+S` opens the swarm dashboard — the nerve center for multi-agent work.

### Agents tab

![Swarm agents tab](../e2e/screenshots/docs/19-swarm-agents-tab.png)

Shows every agent currently registered with the swarm:

- **Status** — idle, working, blocked, error.
- **Active task** — what it's doing right now.
- **Token usage** — running total per agent.
- **Capability chips** — the categories this agent was chosen for.

Click an agent row to jump to its terminal.

### Tasks tab

![Swarm tasks tab](../e2e/screenshots/docs/20-swarm-tasks-tab.png)

The complete task DAG for the current swarm run. Each task shows:

- Title, assignee, depends-on, blocks.
- Status (queued, running, waiting for review, done, failed).
- Duration + estimated token cost.
- A one-line summary of what was produced when complete.

Dependency arrows let you see at a glance which tasks are parallelizable and which are on the critical path.

### Messages tab

![Swarm messages tab](../e2e/screenshots/docs/21-swarm-messages-tab.png)

A live stream of every message the conductor sends, every broadcast, every handoff. Think of it as the "Slack channel" for your agent team — useful for debugging, reviewing, or understanding exactly how a decision was made.

---

## 21. AI Conductor

The conductor is a **dedicated Claude Code instance** that runs as a separate agent with a system prompt purpose-built for orchestration. It:

1. Reads your initial task description.
2. Calls `memory_search` on shared memory to find relevant prior work.
3. Decomposes the task into subtasks.
4. For each subtask, picks the best-fit agent using capability scores, current load, and cost.
5. Delegates via MCP `post_activity` + `send_input`.
6. Watches the activity feed for progress, errors, and completion signals.
7. Decides when to merge partial results, when to re-plan, and when to declare done.

The conductor is **not keyword matching** — it reasons with the same capability as any frontier model, because it *is* one. You can open its terminal and see its thinking live.

### Starting a swarm

![Start swarm wizard](../e2e/screenshots/docs/22-start-swarm-wizard.png)

Click **Start Swarm** in the dashboard. The wizard asks for:

- **Task description** — natural language, as detailed as you want.
- **Agents to include** — defaults to all four.
- **Budget** — optional soft cap on token spend.
- **Working directory** — defaults to current workspace.

Click **Start**. The conductor spins up, reads the task, and the dashboard populates with subtasks within seconds.

---

## 22. Activity Feed

![Activity feed](../e2e/screenshots/docs/23-activity-feed.png)

The activity feed is the observability layer for every agent, every session. Open it from the sidebar (`Ctrl+Shift+A`) or from any terminal's context menu.

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

Open the feed from a terminal and it's scoped to that terminal's session. Open it from the sidebar and it shows every agent across every session. Scope is visible in the header: "Agent Activity (terminal)" or "Agent Activity".

### Pinning

Right-click any event → **Pin**. Pinned events appear at the top of the [Context Panel](#14-context-panel) until you unpin them. Great for "this tool call is the thing I'm tracking".

---

## 23. Intervention Controls

Every scoped Activity Feed includes a row of intervention controls above the event list:

- **Pause** — sends `ESC` (0x1B) to the agent's pty, which most CLIs interpret as "cancel current input".
- **Cancel** — sends a single `Ctrl+C` (0x03).
- **Interrupt** — sends a double `Ctrl+C` (0x03 0x03), which Claude Code and Codex treat as a hard stop.
- **Steer** — a text input with a send button. Type a new instruction and the agent receives it directly at the prompt.

The rationale: every agent is a pty, so writing control characters or text to its stdin is the fastest, most reliable way to take over. No new IPC surface — just the pty API we already have.

Each intervention is also logged as an event in the feed (`status_change`), so you have an audit trail of every mid-flight correction you made.

---

## 24. Swarm Review Panel

When a task is configured to require review before handing off (default for code-review tasks, optionally enabled for others), the conductor pauses and opens the **Swarm Review Panel**.

The panel shows:

- The task title and assignee's output.
- A diff (if the task produced file changes).
- Three buttons: **Approve**, **Request Changes**, **Reject**.
- An optional comment field.

**Approve** hands off to the downstream task. **Request Changes** reassigns to the same agent with your comment appended. **Reject** drops the output and re-plans.

---

## 25. Shared Memory (RAG)

A cross-agent memory store backed by JSONL + embeddings. Any agent can:

- **Write** via `memory_write` — stores `{label, content, tags, terminalId, ts}` and computes an embedding via Ollama's `nomic-embed-text`.
- **Search** via `memory_search` — cosine similarity over embeddings, blended with keyword overlap.
- **List** via `memory_list` — recent entries with filters.

**Why it matters:** when Claude figures out how your auth module works, Codex doesn't need to figure it out again — it searches memory, finds Claude's note, and skips the discovery step. Context sharing at the swarm level.

Memory lives at `~/.termpolis/swarm-memory.jsonl` and is readable/editable as plain text.

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

> **Found a bug that isn't here?** **[Open an issue on GitHub →](https://github.com/codedev-david/termpolis/issues/new?template=bug_report.md)** Include your OS + version, Termpolis version (Settings → About), and the most recent entries from `~/.termpolis/logs/` — that's usually enough to reproduce the problem.

### Installation & first-run

**Windows: "Windows protected your PC" SmartScreen warning.** Click **More info** → **Run anyway**. Termpolis is code-signed (SSL.com), but newly signed builds need reputation time before SmartScreen stops flagging them. The warning disappears once enough people download the release.

**macOS: "Termpolis is damaged and can't be opened."** This means Gatekeeper couldn't verify the signature — usually a partial download. Re-download the DMG from GitHub Releases, verify the file size matches, and mount again. If it still fails, open **System Settings → Privacy & Security**, scroll to the bottom, and click **Open Anyway** next to the Termpolis entry.

**macOS: "Permission denied" when launching a terminal.** Grant Termpolis **Full Disk Access** in System Settings → Privacy & Security → Full Disk Access. Re-launch after granting.

**Linux: AppImage won't run.** Mark it executable: `chmod +x Termpolis-*.AppImage`. On systems with hardened FUSE, extract and run the inner binary: `./Termpolis-*.AppImage --appimage-extract && ./squashfs-root/termpolis`.

**Data directory didn't appear.** Termpolis creates the data directory on first run — make sure you actually clicked "Open" rather than dismissing the first-launch dialog. Paths by platform: `%APPDATA%\termpolis\` (Windows), `~/Library/Application Support/termpolis/` (macOS), `~/.config/termpolis/` (Linux).

### Terminals

**Terminal won't start.** Check the shell path in Settings → Shells. On Windows, PowerShell 7 lives at `C:\Program Files\PowerShell\7\pwsh.exe`; WSL needs `wsl.exe` on PATH. On macOS, if `/bin/zsh` gives "permission denied", re-grant Termpolis Full Disk Access (above) — launchd blocks unsigned/unapproved apps from spawning shells by default.

**Terminal hangs on first prompt.** Your shell's startup files (`.bashrc`, `.zshrc`, `powershell $PROFILE`) may be waiting on input or hitting a slow network check. Open the shell outside Termpolis to confirm; the fix is in your dotfiles, not the app.

**Output looks garbled / escape codes show as text.** The shell detected a non-TTY environment. Make sure the **Agent profile** field is empty if you're launching a plain shell (some agent launchers set `TERM=dumb`). Resetting via Settings → Shells → Reset defaults fixes most cases.

**Copy/paste shortcuts don't work.** On Windows/Linux, use `Ctrl+Shift+C` / `Ctrl+Shift+V` inside terminals (bare `Ctrl+C` sends SIGINT). On macOS, `⌘C`/`⌘V` work as expected everywhere.

**Font looks wrong / icons are boxes.** The app ships with its own icon font, but if it failed to load (usually due to an override in Settings → Themes), re-select a built-in theme or run **Reset theme** from Settings → Themes.

### Agents & CLI tools

**Agent launch button fails silently.** The CLI isn't on your PATH. Open any shell in Termpolis and run `claude --version` (or `codex`, `gemini`, `qwen`) to confirm. On macOS, GUI-launched apps don't always inherit `$PATH` from your shell — restart Termpolis after updating `~/.zprofile` (not just `~/.zshrc`), or relaunch from Terminal with `open -a Termpolis` so the shell PATH is inherited.

**Wrong `claude` / `codex` binary runs.** If you've installed the CLI via multiple package managers (Homebrew, npm, cargo), PATH order decides the winner. Use `which claude` to see which one Termpolis will launch. Override per-agent in Settings → Agents.

**Agent exits with "API key not set".** Each agent's env vars come from the login shell, not from a `.env` file in your workspace. `export ANTHROPIC_API_KEY=...` in `~/.zprofile` / `~/.bash_profile` / PowerShell `$PROFILE`, then relaunch Termpolis.

### Swarm, MCP, and memory

**MCP indicator in status bar is red.** The MCP server failed to start. Look at `~/.termpolis/logs/mcp.log`. Common causes:

- **Port 48211 already in use.** Another instance of Termpolis (or an old crashed one) still owns the port. Kill any stray `termpolis` processes, or change the port in Settings → Advanced.
- **Firewall blocking localhost.** Rare but possible. Add an exception for `termpolis.exe` / the Termpolis binary.
- **Token file write failed.** `~/.termpolis/mcp-token` couldn't be written due to permissions. Fix the directory permissions (`chmod 700 ~/.termpolis`).

**Swarm conductor doesn't launch.** The conductor spawns a Claude Code child process that needs `claude` on PATH (see agent troubleshooting above). Watch `~/.termpolis/logs/conductor.log` for its startup output.

**Swarm hangs mid-task / agents stop posting activity.** Open Activity Feed — if the agent is still running but not emitting events, its MCP connection may have dropped. Use **Pause → Reset session** in the Swarm Dashboard to recover. If a specific agent repeatedly drops, its MCP token probably expired — restart Termpolis to issue fresh tokens.

**Memory search returns nothing.** `memory_search` needs embeddings, which require Ollama running with the `nomic-embed-text` model pulled. Start Ollama (`ollama serve`) and run `ollama pull nomic-embed-text`. New writes will succeed; historical entries without embeddings still match keyword-only searches.

### Updates & performance

**Update notification appears but the update doesn't install.** The auto-updater needs write access to the app bundle. On Windows, run the installer manually from GitHub Releases if the in-app updater fails. On macOS, drag the new DMG contents over the existing app (it'll prompt for admin). On Linux, download and replace the AppImage.

**App is slow to start / very high memory.** A corrupted session file occasionally causes runaway restoration. Back up `session.json` in your data directory, then delete it and relaunch — you lose restored workspace state but the app is back to a clean baseline.

**Terminal scrollback is sluggish.** The default xterm scrollback is 10,000 lines. If you've pasted very large logs, scrolling slows down. Settings → Terminals → Clear scrollback resets without restarting.

### Session corruption & reset

**App opens to a blank screen.** Sign of a broken `session.json`. Close Termpolis, rename `session.json` in the data directory, relaunch — the app creates a fresh session. Your workspaces will be empty but the app is usable again; the old file is preserved if you want to diff it later.

**Reset everything.** Close Termpolis, delete the entire data directory (see [§2](#2-installation)), relaunch. This wipes workspaces, settings, themes, prompt templates, custom workflows, swarm history, and memory — start from a clean slate.

### Reporting a bug

If none of the above fixes your problem, **[open an issue](https://github.com/codedev-david/termpolis/issues/new?template=bug_report.md)**. Please include:

1. OS + version (e.g., Windows 11 23H2, macOS 14.3, Ubuntu 22.04).
2. Termpolis version (Settings → About).
3. Steps to reproduce — as minimal as you can make them.
4. Relevant log tail from `~/.termpolis/logs/` (the main log, plus `mcp.log` or `conductor.log` if the issue involves swarm/MCP).
5. A screenshot or short screen recording if it's a UI bug.

---

## 29. Architecture

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
│  ├── MCP server (HTTP, 17 tools)                    │
│  ├── Swarm memory (JSONL + embeddings)              │
│  ├── AI conductor (spawns Claude Code as a child)   │
│  └── Watchers (event bus + alerts)                  │
└──────────────────┬──────────────────────────────────┘
                   │  localhost:48211 (MCP)
┌──────────────────▼──────────────────────────────────┐
│  AI agents (Claude, Codex, Gemini, Qwen Code)       │
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

## 30. Keyboard Shortcut Reference

All shortcuts are rebindable in Settings → Keybindings. Defaults:

| Action                     | Windows / Linux     | macOS              |
|----------------------------|----------------------|---------------------|
| New terminal               | `Ctrl+T`             | `⌘T`                |
| Close focused terminal     | `Ctrl+W`             | `⌘W`                |
| Next tab                   | `Ctrl+Tab`           | `⌘]`                |
| Previous tab               | `Ctrl+Shift+Tab`     | `⌘[`                |
| Jump to tab N              | `Ctrl+1…9`           | `⌘1…9`              |
| Split horizontal           | `Ctrl+\`             | `⌘\`                |
| Split vertical             | `Ctrl+Shift+\`       | `⌘⇧\`               |
| Focus adjacent pane        | `Alt+Arrow`          | `⌥Arrow`            |
| Command palette            | `Ctrl+K`             | `⌘K`                |
| Settings                   | `Ctrl+,`             | `⌘,`                |
| Prompt templates           | `Ctrl+Shift+P`       | `⌘⇧P`               |
| Workflow templates         | Sidebar → Workflows  | Sidebar → Workflows |
| Context panel              | `Ctrl+Shift+E`       | `⌘⇧E`               |
| History search             | `Ctrl+Shift+H`       | `⌘⇧H`               |
| Conversation search        | `Ctrl+Shift+I`       | `⌘⇧I`               |
| Git panel                  | `Ctrl+Shift+G`       | `⌘⇧G`               |
| Activity feed              | `Ctrl+Shift+A`       | `⌘⇧A`               |
| Swarm dashboard            | `Ctrl+Shift+S`       | `⌘⇧S`               |
| New workspace              | `Ctrl+Shift+N`       | `⌘⇧N`               |
| Copy                       | `Ctrl+C` (selection) | `⌘C`                |
| Paste                      | `Ctrl+Shift+V`       | `⌘V`                |
| Clear terminal             | `Ctrl+L`             | `⌘K`* in shell      |
| Zoom in / out              | `Ctrl+=` / `Ctrl+-`  | `⌘=` / `⌘-`         |
| Reset zoom                 | `Ctrl+0`             | `⌘0`                |

---

## Final note

Termpolis is under active development. If you hit a rough edge, open an issue at [github.com/codedev-david/termpolis](https://github.com/codedev-david/termpolis/issues). If it's useful to you, consider [sponsoring the project](https://github.com/sponsors/codedev-david).

— David
