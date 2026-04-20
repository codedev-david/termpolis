# Termpolis Documentation

The definitive guide to Termpolis — an AI-native terminal where Claude, Codex, Gemini, and Qwen work together as a team, coordinated by a dedicated AI conductor.

This document covers installation, every feature, every panel, every keyboard shortcut, and the architecture behind the swarm. Screenshots live in `../e2e/screenshots/docs/` and are mirrored to the website at `termpolis-web/docs/screenshots/`.

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

- **Multi-agent swarm**: Claude, Codex, Gemini, and Aider + Qwen can work together on a task. A dedicated Claude Code instance acts as the conductor.
- **MCP server** baked in: AI agents can control Termpolis via Model Context Protocol — open terminals, run commands, send messages.
- **Transparent routing**: every subtask shows *which* agent got it, *why*, and *what it cost*.
- **Activity observability**: every token, every tool call, every message from every agent is visible in real time.
- **Intervention controls**: pause, cancel, or steer any agent mid-task without leaving the feed.
- **Shared memory**: a RAG-backed memory store that any agent can read and write via MCP.
- **Free local agent**: Aider + Qwen3-Coder via Ollama means zero-cost work is always on the menu.

Everything is built around the idea that **you're not writing code alone anymore** — you're orchestrating a team, and you need the tools to do it well.

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

Right-click any workspace row for:
- Rename
- Duplicate
- Close (confirms if there are active terminals)
- Show in file explorer

New workspaces are created from the **+ Workspace** button or via `Ctrl+Shift+N`.

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

The heart of smart swarm routing. This tab lets you score each agent (Claude, Codex, Gemini, Aider+Qwen) across 10 categories:

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

The **Token Cost** column is a relative indicator ($, $$, $$$, Free) used for cost-aware routing.

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

Workflows are multi-step recipes — launch a terminal, run setup, send a prompt to an agent, wait for exit, open a file. Think of them as macros with a UI.

Open the Workflows panel from the sidebar or via `Ctrl+Shift+F`. Built-in flows:

- **Start a new feature** — creates a branch, opens Claude, sends a "plan this feature" prompt.
- **Bug repro** — spawns a terminal, runs the repro command, opens an agent with the output.
- **Pre-PR review** — runs lint + tests, opens Gemini with a review prompt against the diff.

You can edit any built-in flow or create your own with the visual editor. Flows save to `workflow-templates.json`.

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

- Filter by agent (Claude / Codex / Gemini / Aider).
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

Launch any AI CLI as a profiled terminal: Claude Code, Codex, Gemini CLI, Aider. Profiles come pre-configured with:

- The correct shell + startup command.
- A color + label for visual distinction.
- An MCP bootstrap (where supported) so the agent can control Termpolis.
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
| `run_workflow`      | Execute a named workflow template                     |
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

### Terminal won't start

- Check the shell path in Settings → Shells. On Windows, PowerShell 7 lives at `C:\Program Files\PowerShell\7\pwsh.exe`.
- On macOS, if you get a "permission denied" for `zsh`, re-grant Termpolis Full Disk Access in System Preferences → Privacy.

### Agent CLI not found

The launch button fails silently if the CLI isn't in your PATH. Open any shell in Termpolis and run `claude --version` (or `codex`, `gemini`, `aider`) to confirm. On macOS, GUI-launched apps don't always inherit `$PATH` from your shell — a restart of Termpolis after updating `~/.zprofile` usually fixes it.

### Swarm conductor can't reach MCP

Check the status bar MCP indicator. If it's red, look at `~/.termpolis/logs/mcp.log`. Common causes: port 48211 already in use (change it in Settings → Advanced), or firewall blocking localhost.

### Memory search returns nothing

If `memory_search` seems to ignore stored entries, embeddings probably failed (Ollama not running). Start Ollama, pull `nomic-embed-text`, and recent memory_writes will succeed. Historical entries without embeddings still match on keyword search.

### Reset everything

Close Termpolis, delete the data directory (see [§2](#2-installation)), relaunch.

---

## 29. Architecture

```
┌─────────────────────────────────────────────────────┐
│  Renderer (React)                                    │
│  ├── Sidebar, Terminals, Panels                     │
│  ├── Activity Feed (observability UI)               │
│  ├── Swarm Dashboard + Conductor view               │
│  └── IPC client → window.termpolis bridge          │
└──────────────────┬──────────────────────────────────┘
                   │  Electron IPC
┌──────────────────▼──────────────────────────────────┐
│  Main process (Node)                                 │
│  ├── Terminal manager (node-pty)                    │
│  ├── Session persistence (session.json)             │
│  ├── Workflow runner                                │
│  ├── Git adapter                                    │
│  ├── MCP server (HTTP, 17 tools)                    │
│  ├── Swarm memory (JSONL + embeddings)              │
│  ├── AI conductor (spawns Claude Code as a child)   │
│  └── Watchers (event bus + alerts)                  │
└──────────────────┬──────────────────────────────────┘
                   │  localhost:48211 (MCP)
┌──────────────────▼──────────────────────────────────┐
│  AI agents (Claude, Codex, Gemini, Aider+Qwen)      │
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
| Workflow templates         | `Ctrl+Shift+F`       | `⌘⇧F`               |
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
