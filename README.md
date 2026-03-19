# Termpolis

A cross-platform terminal manager built with Electron. Run multiple terminal sessions in a single window with split panes, command autocomplete, auto-fix for mistyped commands, per-terminal themes, and much more.

![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)

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

### Shell Support
- **PowerShell**, **Bash**, **Zsh**, **Cmd**, **Git Bash** — auto-detected per OS
- **Shell config editor** — edit .bashrc, .zshrc, PowerShell profiles with Monaco Editor

### Intelligence
- **Command autocomplete** — VS Code-style dropdown with command names, subcommands, and flags. Bundled specs for 20+ common tools (git, docker, npm, kubectl, curl, and more)
- **Command auto-fix** — mistype a command? A green banner suggests the correction. Press Enter to run or Esc to ignore. Detects typos, permission errors, wrong flags, and more
- **Command history search** — search across all terminals with Ctrl+Shift+H

### Customization
- **7 terminal themes** — Dark, Light, Solarized Dark, Solarized Light, Monokai, Dracula, Nord
- **Per-terminal theming** — each terminal can have its own theme, font size (8-32px), and font family
- **Color-coded terminals** — 12 accent colors for visual identification in the sidebar
- **Configurable keybindings** — 10 customizable keyboard shortcuts with a recording UI in Settings
- **Collapsible sidebar** — toggle with Ctrl+B or the chevron button

### Productivity
- **Terminal output export** — save scrollback to a text file (full or visible portion) via header button or right-click
- **Copy/paste** — Ctrl+Shift+C/V with right-click context menu (Copy, Paste, Select All)
- **Clickable URLs** — links in terminal output open in your default browser
- **Per-terminal status bar** — blue bar showing shell type, current directory, and git branch
- **Live git branch detection** — status bar updates by parsing prompt output (works on all platforms)

### Built-in Tools
- **jq**, **yq**, **curl**, and **nano** — bundled and available in every terminal, even if not installed on your system
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
| `Ctrl+Shift+T` | New terminal |
| `Ctrl+Shift+W` | Close terminal |
| `Ctrl+Tab` | Next terminal |
| `Ctrl+Shift+Tab` | Previous terminal |
| `Ctrl+Shift+H` | Search command history |
| `Ctrl+Shift+C` | Copy selection |
| `Ctrl+Shift+V` | Paste |
| `Ctrl+Space` | Trigger autocomplete |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+Shift+G` | Toggle split view |

> On macOS, use `Cmd` instead of `Ctrl`.

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

89 tests across 19 test files (unit + component + integration tests).

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
git tag v1.0.0
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
| Icons | [Font Awesome](https://fontawesome.com/) 6 |
| Styling | [Tailwind CSS](https://tailwindcss.com/) 3 |
| Testing | [Vitest](https://vitest.dev/) + React Testing Library |
| Packaging | [electron-builder](https://www.electron.build/) |

### Project Structure

```
termpolis/
├── src/
│   ├── main/                        # Electron main process
│   │   ├── index.ts                 # App entry, IPC handlers, single-instance lock
│   │   ├── terminalManager.ts       # node-pty wrapper + bundled tools PATH injection
│   │   ├── completionService.ts     # PATH scanning, file listing, env vars for autocomplete
│   │   ├── shellDetector.ts         # OS-aware shell discovery
│   │   ├── sessionStore.ts          # JSON session persistence with migration
│   │   ├── historyStore.ts          # Cross-terminal command history
│   │   ├── configFileManager.ts     # Read/write shell config files
│   │   └── types.ts                 # Main process type definitions
│   ├── preload/
│   │   └── index.ts                 # contextBridge API (window.termpolis)
│   └── renderer/src/
│       ├── App.tsx                   # Root layout, session restore, global shortcuts
│       ├── main.tsx                  # React entry point
│       ├── store/
│       │   └── terminalStore.ts     # Zustand (terminals, workspaces, pane tree, keybindings)
│       ├── lib/
│       │   ├── terminalDefaults.ts  # Default fontSize, theme, fontFamily
│       │   ├── keybindings.ts       # Keybinding types, defaults, matching utilities
│       │   ├── outputThrottle.ts    # rAF-based write batching with 64KB rate limit
│       │   ├── exportTerminal.ts    # Buffer extraction + ANSI stripping
│       │   ├── promptParser.ts      # Parse cwd and git branch from terminal output
│       │   └── homedir.ts           # Cached IPC homedir lookup
│       ├── themes/
│       │   └── terminalThemes.ts    # 7 curated xterm ITheme definitions
│       ├── completions/
│       │   ├── completionEngine.ts  # Orchestrates spec, shell, history sources
│       │   ├── inputParser.ts       # Tokenizes terminal input for context detection
│       │   ├── specLoader.ts        # Lazy-loads JSON completion specs
│       │   └── specs/               # 20 command completion specs (git, docker, npm, etc.)
│       ├── corrections/
│       │   ├── correctionEngine.ts  # Matches failed commands against rules
│       │   └── rules/               # Pure function rules (typo, permission, stderr parsing)
│       ├── types/
│       │   └── index.ts             # Shared TypeScript types
│       ├── assets/fonts/            # JetBrains Mono WOFF2 fonts
│       └── components/
│           ├── TitleBar/            # Custom frameless title bar
│           ├── StatusBar/           # App footer + Quick Start Guide modal
│           │   └── TerminalStatusBar.tsx  # Per-terminal status bar (shell, cwd, git branch)
│           ├── Sidebar/             # Terminal tabs, workspace list, add modal, collapse
│           ├── TabView/             # Single-terminal view
│           ├── SplitView/           # Split pane layout with draggable dividers
│           │   ├── SplitView.tsx    # Top-level split view
│           │   ├── PaneRenderer.tsx # Recursive pane tree renderer
│           │   └── SplitDivider.tsx # Draggable divider bar
│           ├── TerminalPane/        # xterm.js terminal with autocomplete + auto-fix
│           ├── CompletionDropdown/  # Autocomplete dropdown overlay
│           ├── CommandFix/          # Inline correction banner
│           ├── TabPopover/          # Edit terminal properties popover
│           ├── SettingsPane/        # Settings + keybindings + Monaco config editor
│           └── HistorySearch/       # Command history search modal
├── tests/
│   ├── electron/                    # Main process unit tests
│   ├── renderer/                    # Renderer unit tests
│   └── components/                  # React component tests
├── scripts/
│   └── download-tools.sh           # Download latest jq, yq, curl, nano per platform
├── resources/tools/                 # Bundled CLI tool binaries (per platform)
├── assets/                          # App icons (ico, png, svg)
├── .github/workflows/release.yml   # CI/CD: build all platforms on tag push
├── electron.vite.config.ts
├── electron-builder.config.ts
├── vitest.config.ts
├── tailwind.config.js
└── package.json
```

### IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `terminal:create` | invoke | Spawn a new pty process |
| `terminal:kill` | invoke | Kill a pty process |
| `terminal:write` | send | Write input to pty |
| `terminal:resize` | send | Resize pty dimensions |
| `terminal:data` | main→renderer | Stream pty output to xterm |
| `terminal:export` | invoke | Save dialog + write terminal output to file |
| `terminal:status` | invoke | Get terminal cwd + git branch |
| `shell:available` | invoke | Get detected shells |
| `config:read` | invoke | Read a config file |
| `config:write` | invoke | Write a config file |
| `history:append` | send | Log a command to history |
| `history:search` | invoke | Search command history |
| `completion:path-entries` | invoke | List files/dirs at a path |
| `completion:path-commands` | invoke | List all commands in PATH |
| `completion:env-vars` | invoke | List environment variables |
| `session:load` | invoke | Load persisted session |
| `session:save` | send | Persist current session |
| `fs:homedir` | invoke | Get user home directory |
| `window:minimize` | send | Minimize window |
| `window:maximize` | send | Toggle maximize |
| `window:close` | send | Close window |

### Session Persistence

Session data is stored as JSON in the Electron `userData` directory:
- **Windows:** `%APPDATA%/termpolis/session.json`
- **macOS:** `~/Library/Application Support/termpolis/session.json`
- **Linux:** `~/.config/termpolis/session.json`

Saved state includes: open terminals (name, color, shell, cwd, theme, font size, font family), workspaces with working directories, default shell, view mode, and keybindings.

Old sessions are automatically migrated — missing fields receive defaults on load.

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit changes (`git commit -m 'feat: add my feature'`)
4. Push to branch (`git push origin feature/my-feature`)
5. Open a Pull Request

## License

MIT
