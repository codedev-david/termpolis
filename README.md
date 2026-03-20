# Termpolis

An AI-native, cross-platform terminal manager built with Electron. Split panes, command autocomplete, auto-fix, per-terminal themes, AI agent profiles, MCP server integration, and much more.

> **A note on AI-assisted development:** There may be critique that this application is built in conjunction with using AI; however, if you are still exclusively using an IDE or manually writing every line of code, then you are doing it wrong. This is the new path for AI-native engineering as a programmer. Code review is often still needed, but beyond this, software engineering has a new path. Termpolis itself is built with AI and built *for* AI workflows — and that's the point.

![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)
[![Sponsor](https://img.shields.io/badge/sponsor-GitHub%20Sponsors-ea4aaa.svg)](https://github.com/sponsors/codedev-david)

> **Support this project** — Termpolis is free and open source. If you find it useful, consider [sponsoring the project](https://github.com/sponsors/codedev-david) to help cover AI token costs and development time.

## Downloads

| Platform | Download | Format |
|----------|----------|--------|
| Windows | [Termpolis Setup.exe](https://github.com/codedev-david/termpolis/releases/latest) | NSIS Installer |
| macOS | [Termpolis.dmg](https://github.com/codedev-david/termpolis/releases/latest) | DMG |
| Linux | [Termpolis.AppImage](https://github.com/codedev-david/termpolis/releases/latest) | AppImage |

> Download links point to the latest GitHub Release. See [Building from Source](#building-from-source) to compile locally.

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
- **AI Session Profiles** — one-click launch profiles for Claude Code, Codex, Gemini CLI, and Aider with custom profiles support
- **Command Palette** — `Ctrl+K` opens a natural language command bar to control the app (new terminal, split panes, launch agents, run commands)
- **Prompt Templates** — save reusable prompt snippets (Fix Tests, Code Review, Refactor, etc.) and insert them with `Ctrl+Shift+P`
- **Multi-Agent Workflow Templates** — pre-built split-pane layouts for common AI workflows (Claude + Shell, Full Stack Dev, Code Review)
- **Agent Status Detection** — automatically detects when Claude Code, Codex, Gemini, or Aider is running and shows a colored badge in the status bar
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
- **One-click handoff** — click "Switch to Codex" (or Gemini/Aider) to launch the new agent with your full context pre-loaded
- **Editable handoff prompt** — preview and customize the context before switching via the "More Options" modal
- **Keep or close** — choose whether to keep the old terminal for reference or close it

### Multi-Agent Swarm
- **Swarm Orchestrator** — step-by-step wizard to launch a swarm: pick agents (Claude, Codex, Gemini, Aider), describe the task, review auto-generated role assignments, and launch. Each agent gets a split pane with their task prompt.
- **Swarm Dashboard** — `Ctrl+Shift+S` opens real-time view of agents (health status), tasks (kanban columns), and messages
- **Message Bus** — agents communicate through a shared message queue with typed messages (task, result, question, info, review)
- **Task Queue** — create tasks, assign to agents, track status across Pending → In Progress → Completed
- **Agent Bridge** — non-MCP agents (Codex, Gemini) are automatically bridged: Termpolis reads their terminal output, detects completions/errors, and posts to the swarm bus on their behalf
- **6 swarm MCP tools** — `swarm_send_message`, `swarm_read_messages`, `swarm_create_task`, `swarm_list_tasks`, `swarm_update_task`, `swarm_list_agents`
- **Cross-model collaboration** — Claude, Codex, and Gemini working on the same task simultaneously, each in their own terminal

### Intelligence
- **Command autocomplete** — VS Code-style dropdown with command names, subcommands, and flags. Bundled specs for 20+ common tools (git, docker, npm, kubectl, curl, and more)
- **Command auto-fix** — mistype a command? A green banner suggests the correction. Press Enter to run or Esc to ignore. Detects typos, permission errors, wrong flags, and more
- **Command history search** — search across all terminals with Ctrl+Shift+H

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

### Performance
- **Output throttling** — rAF-based batching with 64KB per-frame rate limit prevents UI freezing from heavy output
- **10,000-line scrollback buffer** per terminal (prevents unbounded memory growth)
- **Viewport-aware rendering** — off-screen terminals in split view get deferred rendering
- **Lazy-loaded settings** — Monaco editor and settings pane load on demand, not at startup
- **Full Unicode support** — emoji, CJK characters, and special glyphs render correctly

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
- No telemetry, no analytics, no cloud accounts — everything stays on your machine

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

121 total tests:
- `npm test` — 89 unit tests (Vitest)
- `npx playwright test` — 32 E2E tests (Playwright, launches the actual Electron app)
- E2E tests capture 25 screenshots automatically in `e2e/screenshots/`

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

Output: `dist-electron-builder/Termpolis-X.X.X.dmg`

> macOS builds must be run on macOS.

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
│           ├── Sidebar/             # Terminal tabs, AI profiles, workspace list, collapse
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
├── tests/                           # Vitest test suites (89 tests, 19 files)
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

Termpolis is free, open source, and MIT licensed. Building and maintaining it (including AI token costs for development) takes time and resources.

If you find Termpolis useful, please consider sponsoring:

**[Sponsor on GitHub](https://github.com/sponsors/codedev-david)**

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit changes (`git commit -m 'feat: add my feature'`)
4. Push to branch (`git push origin feature/my-feature`)
5. Open a Pull Request

## License

MIT
