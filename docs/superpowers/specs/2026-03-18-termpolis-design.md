# Termpolis — Design Spec
**Date:** 2026-03-18
**Status:** Approved

---

## Overview

Termpolis is a cross-platform (Windows, macOS, Linux) Electron-based terminal manager application. It provides a VS Code-inspired UX for managing multiple named, colored terminal sessions in a single window. It fills the gap left by iTerm2 (macOS-only) and differentiates from Tabby with a cleaner UI, Monaco-powered config file editing, a first-class grid view, cross-terminal command history search, and workspace grouping.

---

## Tech Stack

| Layer | Technology |
|---|---|
| App framework | Electron |
| Renderer | React (with Vite as bundler) |
| Terminal emulation | xterm.js |
| Shell process management | node-pty (main process) |
| State management | Zustand |
| Code editor (settings) | Monaco Editor (`@monaco-editor/react`) |
| Styling | Tailwind CSS |
| Session persistence | JSON file in Electron `userData` directory |

---

## Architecture

### Process Model

```
┌─────────────────────────────────────────────────────┐
│                  Electron Main Process               │
│                                                      │
│  TerminalManager                                     │
│  ├── spawn/kill node-pty processes per terminal      │
│  ├── IPC handlers (data in/out, resize, list)        │
│  ├── SessionStore (JSON in userData dir)             │
│  ├── HistoryStore (per-terminal command history)     │
│  └── ShellDetector (available shells per OS)         │
└──────────────────────┬──────────────────────────────┘
                       │ ipcMain / ipcRenderer
┌──────────────────────▼──────────────────────────────┐
│                 Electron Renderer Process            │
│                  (React + Vite)                      │
│                                                      │
│  App State (Zustand)                                 │
│  ├── terminals[] — id, name, color, shellType, cwd   │
│  ├── workspaces[] — id, name, terminalIds[]          │
│  ├── activeTerminalId                                │
│  ├── activeWorkspaceId                               │
│  └── viewMode — "tabs" | "grid"                     │
│                                                      │
│  Components                                          │
│  ├── Sidebar                                         │
│  ├── TabView                                         │
│  ├── GridView                                        │
│  ├── TerminalPane (xterm.js instance)                │
│  ├── HistorySearchModal                              │
│  └── SettingsPane (Monaco editor + defaults)         │
└─────────────────────────────────────────────────────┘
```

### IPC Channel Contracts

All IPC invoke calls return `{ success: boolean, data?: any, error?: string }`. Terminal operations that fail (e.g., shell not found, pty crash) return `{ success: false, error: "<reason>" }`. Timeouts on `terminal:create` are 5 seconds; if exceeded, return `{ success: false, error: "timeout" }`.

| Channel | Direction | Payload | Description |
|---|---|---|---|
| `terminal:create` | renderer → main | `{ id, shellType, cwd }` | Spawn a new pty process |
| `terminal:kill` | renderer → main | `{ id }` | Kill a pty process |
| `terminal:write` | renderer → main | `{ id, data }` | Send keystrokes to pty |
| `terminal:data` | main → renderer | `{ id, data }` | Receive output from pty |
| `terminal:resize` | renderer → main | `{ id, cols, rows }` | Notify pty of terminal resize |
| `terminal:list` | renderer → main | — | Get all active terminal IDs |
| `shell:available` | renderer → main | — | Get available shells on this OS |
| `config:read` | renderer → main | `{ file }` | Read a shell config file by absolute path |
| `config:write` | renderer → main | `{ file, content }` | Write a shell config file by absolute path |
| `history:append` | renderer → main | `{ terminalId, command }` | Append a command to history |
| `history:search` | renderer → main | `{ query }` | Search across all terminal histories |
| `session:load` | renderer → main | — | Load persisted session |
| `session:save` | renderer → main | `{ terminals[], workspaces[], viewMode, defaultShell }` | Persist session state |

---

## UI Components

### Sidebar (always visible, left panel)

- **Settings** button — opens SettingsPane in main area
- **Grid View / Tab View** toggle button — label reflects the mode you will switch TO (in tab view → button reads "Grid View"; in grid view → button reads "Tab View")
- **Workspaces section** — collapsible list of saved workspaces; clicking a workspace activates all its terminals
- **Terminal tab list** — vertical scrollable list; if terminal count exceeds visible height, the list scrolls. Settings and view toggle buttons are fixed at top; "+ Add Terminal" and "+ Save Workspace" are fixed at bottom. Each tab shows:
  - Color accent (left border)
  - Shell type icon (`$` for bash/zsh, `>_` for cmd/powershell/git bash)
  - Terminal name
  - X button on the far right to close
- **+ Add Terminal** button — fixed at bottom
- **+ Save Workspace** button — fixed at bottom, saves current open terminals as a named workspace

### Add Terminal Modal

Triggered by clicking `+ Add Terminal`. A centered modal with:
- **Name** — text input, pre-filled with "Terminal N" where N is the next available integer (names are not required to be unique; auto-generated names are incremented to avoid immediate duplicates)
- **Shell type** — dropdown filtered to shells available on current OS; pre-selected to the user's saved default shell
- **Color** — 12 preset color swatches
- **Create** / **Cancel** buttons

On Create: `terminal:create` is called with `{ id: uuid(), shellType, cwd: homeDir }`. If it fails, show an inline error in the modal.

### Tab Popover (rename & recolor)

Triggered by right-clicking a tab OR clicking the pencil icon that appears on tab hover. An inline popover with:
- **Name** — text input
- **Color** — 12 preset color swatches
- **Save** / **Cancel**

Shell type is not changeable post-creation (set at creation time to avoid mid-session kill/respawn).

### Tab View (default view)

- Single active terminal fills the main area
- Clicking a tab in the sidebar switches the active terminal
- All xterm.js instances remain mounted but hidden via CSS `display: none` when not active — preserves scroll history without unmounting
- When a hidden terminal becomes active, `terminal:resize` is sent so xterm.js reflows to the current pane dimensions

### Grid View

Auto-layout based on terminal count using CSS Grid with 2 columns:

| Count | Layout |
|---|---|
| 1 | Full width / full height (1 column) |
| 2 | 2 columns, 1 row (50/50) |
| 3 | 2 top (50/50), 1 bottom centered (full width) |
| 4 | 2×2 grid |
| 5 | 2 top, 2 middle, 1 bottom centered |
| 6+ | 2-column wrapping grid; odd last item is full-width in its row |

On every grid layout change (window resize, terminal add/remove), `terminal:resize` is called for all visible terminals so xterm.js reflows correctly.

Each grid cell has a title bar showing:
- Color dot
- Terminal name
- X button to close that terminal

### History Search Modal

Triggered by a global keyboard shortcut (e.g., `Ctrl+Shift+H` / `Cmd+Shift+H`). A full-width modal overlay with:
- **Search input** — filters results as user types
- **Results list** — each result shows: command text, terminal name (color-coded), timestamp
- Clicking a result copies the command to clipboard and closes the modal
- Results are sorted by recency across all terminals

Command history is captured by intercepting `terminal:write` events — when a carriage return is detected, the buffered input is logged as a command entry with `{ terminalId, command, timestamp }`. History is persisted in `<userData>/history.json`. Maximum 1000 entries per terminal; older entries are dropped.

### Workspaces

A workspace is a named snapshot of the current terminal set (ids, names, colors, shell types). Workspaces are stored in `session.json`.

**Save Workspace:** clicking `+ Save Workspace` opens a small modal with a name input. On save, the current terminal list (id, name, color, shellType) is saved as a workspace entry.

**Activate Workspace:** clicking a workspace in the sidebar opens all its terminals (spawning new pty processes) in addition to any currently open terminals. If a workspace terminal name already exists in the current session, it is opened anyway (names are not unique). The user can optionally close existing terminals first.

**Delete Workspace:** right-clicking a workspace shows a "Delete Workspace" option. This removes the workspace definition but does not close any currently open terminals.

### Settings Pane

Opens in the main area (replaces terminal view). Contains:

1. **Default Shell** — dropdown of available shells on the current OS; saved as the default for new terminals. Initial default: `zsh` on macOS, `bash` on Linux, `powershell` on Windows. Falls back to the first available shell if saved default is not found.
2. **Edit Config Files** — tabs for each supported config file:
   - `.bashrc` → `~/.bashrc` (absolute path resolved at runtime)
   - `.bash_profile` → `~/.bash_profile`
   - `.zshrc` → `~/.zshrc` (shown on macOS/Linux only)
   - Each file opens in a Monaco Editor instance set to `shell` language mode for syntax highlighting. No validation is performed; users are responsible for correctness.
   - If a file does not exist, the editor opens empty; saving creates the file.
3. **Save** button per file — writes content to disk via `config:write`.

---

## Shell Support

Shell availability is detected per OS at startup using `ShellDetector` (checks for executable existence in PATH):

| Shell | Windows | macOS | Linux |
|---|---|---|---|
| bash | ✅ (Git Bash / WSL) | ✅ | ✅ |
| zsh | ❌ | ✅ (default) | ✅ |
| cmd | ✅ | ❌ | ❌ |
| PowerShell | ✅ (`pwsh` if available, else `powershell`) | ✅ (`pwsh`) | ✅ (`pwsh`) |
| Git Bash | ✅ | ❌ | ❌ |

On Windows, PowerShell Core (`pwsh`) is preferred over Windows PowerShell (`powershell`). If only `powershell` is found, it is used. Shells not present on the current OS are excluded from all dropdowns.

---

## Session Persistence

Session state is saved to `<userData>/session.json` only on explicit user actions: terminal add, terminal remove (X), terminal rename, terminal recolor, view mode toggle, workspace save/delete. Terminal scrollback and command history are not saved here (history is in `history.json`).

```json
{
  "terminals": [
    {
      "id": "abc123",
      "name": "Terminal 1",
      "color": "#4FC3F7",
      "shellType": "bash",
      "cwd": "/home/user/projects"
    },
    {
      "id": "def456",
      "name": "Dev Server",
      "color": "#A5D6A7",
      "shellType": "zsh",
      "cwd": "/home/user"
    }
  ],
  "workspaces": [
    {
      "id": "ws1",
      "name": "Frontend Dev",
      "terminals": [
        { "name": "Dev Server", "color": "#A5D6A7", "shellType": "zsh" },
        { "name": "Git", "color": "#CE93D8", "shellType": "bash" }
      ]
    }
  ],
  "defaultShell": "bash",
  "viewMode": "tabs"
}
```

**On launch:** `session.json` is read; each terminal's pty process is respawned fresh (old processes are dead). On respawn, the saved `cwd` is used as the starting directory; if the `cwd` no longer exists, the user's home directory is used. Shells are spawned as login shells to load `.bash_profile` / `.zprofile`. Scroll history is not restored.

**On terminal X close:** terminal is removed from `session.json` immediately and the pty process is killed. It does not return on next launch.

**On app quit:** `session.json` is left intact so the terminal list is restored on next launch.

---

## Color Palette (12 preset swatches)

| Name | Hex |
|---|---|
| Sky Blue | `#4FC3F7` |
| Mint Green | `#A5D6A7` |
| Soft Purple | `#CE93D8` |
| Coral | `#EF9A9A` |
| Amber | `#FFE082` |
| Teal | `#80CBC4` |
| Peach | `#FFCC80` |
| Lavender | `#9FA8DA` |
| Rose | `#F48FB1` |
| Lime | `#C5E1A5` |
| Cyan | `#80DEEA` |
| Slate | `#B0BEC5` |

---

## File Structure

```
termpolis/
├── package.json
├── vite.config.ts
├── electron/
│   ├── main.ts               # Electron main process entry
│   ├── preload.ts            # Context bridge (exposes safe IPC API to renderer)
│   ├── terminalManager.ts    # node-pty spawn/kill/write/resize
│   ├── shellDetector.ts      # Detect available shells per OS
│   ├── sessionStore.ts       # Read/write session.json
│   ├── historyStore.ts       # Read/write history.json, search
│   └── configFileManager.ts  # Read/write shell config files
├── src/
│   ├── main.tsx              # React entry point
│   ├── App.tsx               # Root layout: Sidebar + MainArea
│   ├── store/
│   │   └── terminalStore.ts  # Zustand store
│   ├── components/
│   │   ├── Sidebar/
│   │   │   ├── Sidebar.tsx
│   │   │   ├── TerminalTab.tsx
│   │   │   ├── WorkspaceList.tsx
│   │   │   └── AddTerminalModal.tsx
│   │   ├── TabView/
│   │   │   └── TabView.tsx
│   │   ├── GridView/
│   │   │   └── GridView.tsx
│   │   ├── TerminalPane/
│   │   │   └── TerminalPane.tsx  # xterm.js instance
│   │   ├── TabPopover/
│   │   │   └── TabPopover.tsx    # Rename + recolor
│   │   ├── HistorySearch/
│   │   │   └── HistorySearchModal.tsx
│   │   └── SettingsPane/
│   │       └── SettingsPane.tsx  # Monaco + shell default
│   └── types/
│       └── index.ts          # Shared TypeScript types
└── docs/
    └── superpowers/
        └── specs/
            └── 2026-03-18-termpolis-design.md
```

---

## Key Differentiators vs Tabby

| Feature | Tabby | Termpolis |
|---|---|---|
| Built-in `.bashrc`/`.bash_profile`/`.zshrc` editor | ❌ | ✅ Monaco Editor |
| Grid view auto-layout | Manual split panes | ✅ Auto count-based |
| Named + colored terminal tabs | Supported but cluttered | ✅ First-class, clean UX |
| Cross-terminal command history search | ❌ | ✅ |
| Workspace grouping | ❌ | ✅ Save/restore named terminal sets |
| VS Code-familiar interface | Different UX paradigm | ✅ Intentionally VS Code-like |
| Cross-platform | ✅ | ✅ |

---

## Out of Scope (v1)

- SSH profile manager
- Terminal splitting within a single pane
- Themes beyond the default dark theme
- Syntax validation in config file editor
