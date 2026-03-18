# Termpolis

A cross-platform terminal manager built with Electron. Run multiple terminal sessions in a single window with tabbed or grid layouts, save workspace configurations, customize terminal appearance, and edit shell config files.

![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)

## Downloads

| Platform | Download | Format |
|----------|----------|--------|
| Windows | [Termpolis Setup.exe](https://github.com/codedev-david/termpolis/releases/latest) | NSIS Installer |
| macOS | [Termpolis.dmg](https://github.com/codedev-david/termpolis/releases/latest) | DMG |
| Linux | [Termpolis.AppImage](https://github.com/codedev-david/termpolis/releases/latest) | AppImage |

> Download links point to the latest GitHub Release. See [Building Installers](#building-installers) to compile from source.

## Features

- **Multi-terminal management** — open as many terminals as you need in one window
- **Tab View** — single terminal at a time, switch via sidebar
- **Grid View** — all terminals visible simultaneously in an auto-layout grid
- **Workspaces** — save, rename, update, and restore terminal configurations
- **Session persistence** — terminals and workspaces auto-restore on relaunch
- **Shell support** — PowerShell, Bash, Zsh, Cmd, Git Bash (auto-detected per OS)
- **Color-coded terminals** — 12 color swatches for visual identification
- **Terminal renaming & recoloring** — right-click or pencil icon on any tab
- **Command history search** — search across all terminals with Ctrl+Shift+H
- **Shell config editor** — edit .bashrc, .zshrc, PowerShell profiles with Monaco Editor
- **Custom title bar** — frameless window with Termpolis branding
- **Cross-platform** — Windows, macOS, Linux

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+H` (`Cmd+Shift+H` on Mac) | Toggle command history search |
| `Escape` | Close modals and search |

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

This starts the Vite dev server and launches the Electron app. Close the Electron window, then Ctrl+C to stop the dev server.

### Run Tests

```bash
npm test
```

28 tests across 9 test files (unit + component tests).

## Building Installers

### Windows (NSIS Installer)

```bash
npm run package
```

Output: `dist-electron-builder/Termpolis Setup X.X.X.exe`

### macOS (DMG)

```bash
npm run package
```

Output: `dist-electron-builder/Termpolis-X.X.X.dmg`

> Note: macOS builds must be run on macOS. For code signing, set `CSC_LINK` and `CSC_KEY_PASSWORD` environment variables.

### Linux (AppImage)

```bash
npm run package
```

Output: `dist-electron-builder/Termpolis-X.X.X.AppImage`

> Note: Linux builds must be run on Linux.

### Cross-Platform CI

To build for all platforms automatically, set up GitHub Actions:

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    tags: ['v*']

jobs:
  build:
    strategy:
      matrix:
        os: [windows-latest, macos-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: npm run package
      - uses: softprops/action-gh-release@v2
        with:
          files: dist-electron-builder/*
```

Tag a release (`git tag v1.0.0 && git push --tags`) and GitHub Actions will build installers for all three platforms and attach them to the release.

## Architecture

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | [Electron](https://www.electronjs.org/) 30 |
| Build Tool | [electron-vite](https://electron-vite.org/) |
| Renderer | [React](https://react.dev/) 18 + TypeScript |
| Terminal Emulator | [xterm.js](https://xtermjs.org/) 5 |
| Shell Process | [node-pty](https://github.com/nickolasburr/node-pty) |
| State Management | [Zustand](https://zustand-demo.pmnd.rs/) |
| Code Editor | [Monaco Editor](https://microsoft.github.io/monaco-editor/) |
| Styling | [Tailwind CSS](https://tailwindcss.com/) 3 |
| Testing | [Vitest](https://vitest.dev/) + React Testing Library |
| Packaging | [electron-builder](https://www.electron.build/) |

### Project Structure

```
termpolis/
├── src/
│   ├── main/                    # Electron main process
│   │   ├── index.ts             # App entry, IPC handlers, window management
│   │   ├── terminalManager.ts   # node-pty wrapper (spawn, kill, resize)
│   │   ├── shellDetector.ts     # OS-aware shell discovery
│   │   ├── sessionStore.ts      # JSON session persistence
│   │   ├── historyStore.ts      # Cross-terminal command history
│   │   ├── configFileManager.ts # Read/write shell config files
│   │   └── types.ts             # Main process type definitions
│   ├── preload/
│   │   └── index.ts             # contextBridge API (window.termpolis)
│   └── renderer/
│       ├── index.html           # Entry HTML
│       └── src/
│           ├── App.tsx           # Root layout, session restore, shortcuts
│           ├── main.tsx          # React entry point
│           ├── store/
│           │   └── terminalStore.ts  # Zustand state (terminals, workspaces)
│           ├── lib/
│           │   └── homedir.ts    # Cached IPC homedir lookup
│           ├── types/
│           │   └── index.ts      # Shared TypeScript types
│           └── components/
│               ├── TitleBar/     # Custom frameless title bar
│               ├── StatusBar/    # Bottom bar (copyright, links)
│               ├── Sidebar/      # Terminal tabs, workspace list, add modal
│               ├── TabView/      # Single-terminal view
│               ├── GridView/     # Multi-terminal grid layout
│               ├── TerminalPane/ # xterm.js terminal instance
│               ├── TabPopover/   # Rename/recolor popover
│               ├── SettingsPane/ # Default shell + Monaco config editor
│               └── HistorySearch/ # Command history search modal
├── tests/
│   ├── electron/                # Main process unit tests (node env)
│   └── components/              # React component tests (jsdom env)
├── assets/                      # App icons (ico, png, svg)
├── electron.vite.config.ts      # electron-vite build config
├── vitest.config.ts             # Test configuration
├── tailwind.config.js           # Tailwind CSS config
└── package.json                 # Dependencies, scripts, electron-builder config
```

### IPC Architecture

Termpolis uses Electron's `contextBridge` for secure renderer-to-main communication. The renderer never has direct Node.js access.

```
Renderer (React)  ←→  Preload (contextBridge)  ←→  Main (Node.js)
window.termpolis      ipcRenderer/invoke            ipcMain.handle
```

**IPC Channels:**

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `terminal:create` | invoke | Spawn a new pty process |
| `terminal:kill` | invoke | Kill a pty process |
| `terminal:write` | send | Write input to pty |
| `terminal:resize` | send | Resize pty dimensions |
| `terminal:data` | main→renderer | Stream pty output to xterm |
| `shell:available` | invoke | Get detected shells |
| `config:read` | invoke | Read a config file |
| `config:write` | invoke | Write a config file |
| `history:append` | send | Log a command to history |
| `history:search` | invoke | Search command history |
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

Saved state includes: open terminals (name, color, shell, cwd), workspaces, default shell, and view mode.

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit changes (`git commit -m 'feat: add my feature'`)
4. Push to branch (`git push origin feature/my-feature`)
5. Open a Pull Request

## License

MIT
