# Termpolis — Design Spec
**Date:** 2026-03-18
**Status:** Approved

---

## Overview

Termpolis is a cross-platform (Windows, macOS, Linux) Electron-based terminal manager application. It provides a VS Code-inspired UX for managing multiple named, colored terminal sessions in a single window. It fills the gap left by iTerm2 (macOS-only) and differentiates from Tabby with a cleaner UI, Monaco-powered config file editing, and a first-class grid view.

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
| Styling | CSS Modules or Tailwind CSS |
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
│  └── ShellDetector (available shells per OS)         │
└──────────────────────┬──────────────────────────────┘
                       │ ipcMain / ipcRenderer
┌──────────────────────▼──────────────────────────────┐
│                 Electron Renderer Process            │
│                  (React + Vite)                      │
│                                                      │
│  App State (Zustand)                                 │
│  ├── terminals[] — id, name, color, shellType        │
│  ├── activeTerminalId                                │
│  └── viewMode — "tabs" | "grid"                     │
│                                                      │
│  Components                                          │
│  ├── Sidebar                                         │
│  ├── TabView                                         │
│  ├── GridView                                        │
│  ├── TerminalPane (xterm.js instance)                │
│  └── SettingsPane (Monaco editor + defaults)         │
└─────────────────────────────────────────────────────┘
```

### IPC Channel Contracts

| Channel | Direction | Payload | Description |
|---|---|---|---|
| `terminal:create` | renderer → main | `{ id, shellType, cwd }` | Spawn a new pty process |
| `terminal:kill` | renderer → main | `{ id }` | Kill a pty process |
| `terminal:write` | renderer → main | `{ id, data }` | Send keystrokes to pty |
| `terminal:data` | main → renderer | `{ id, data }` | Receive output from pty |
| `terminal:resize` | renderer → main | `{ id, cols, rows }` | Notify pty of terminal resize |
| `terminal:list` | renderer → main | — | Get all active terminal IDs |
| `shell:available` | renderer → main | — | Get available shells on this OS |
| `config:read` | renderer → main | `{ file }` | Read `.bashrc` or `.bash_profile` |
| `config:write` | renderer → main | `{ file, content }` | Write `.bashrc` or `.bash_profile` |
| `session:load` | renderer → main | — | Load persisted session |
| `session:save` | renderer → main | `{ terminals[], viewMode, defaultShell }` | Persist session state |

---

## UI Components

### Sidebar (always visible, left panel)

- **Settings** button — opens SettingsPane in main area
- **Grid View / Tab View** toggle button — label reflects the mode you'll switch TO (e.g., if in tab view, button says "Grid View")
- **Terminal tab list** — vertical list of terminal tabs, each showing:
  - Color accent (left border or dot)
  - Shell type icon (small icon: `$` for bash/zsh, `>_` for cmd/powershell)
  - Terminal name
  - X button on the far right to close
- **+ Add Terminal** button at bottom

### Add Terminal Modal

Triggered by clicking `+ Add Terminal`. A centered modal with:
- **Name** — text input, pre-filled with "Terminal N" (auto-incremented)
- **Shell type** — dropdown filtered to shells available on current OS
- **Color** — 12 preset color swatches
- **Create** / **Cancel** buttons

### Tab Popover (rename & recolor)

Triggered by right-clicking a tab or hovering to reveal an edit (pencil) icon. An inline popover with:
- **Name** — text input
- **Color** — 12 preset color swatches
- **Save** / **Cancel**

No shell switching in this popover (shell is set at creation time to avoid mid-session kill/respawn).

### Tab View (default view)

- Single active terminal fills the main area
- Clicking a tab in the sidebar switches the active terminal
- All xterm.js instances remain mounted but hidden (via CSS `display: none`) when not active — preserves scroll history without unmounting

### Grid View

Auto-layout based on terminal count:

| Count | Layout |
|---|---|
| 1 | Full width / full height |
| 2 | 2 columns, 1 row (50/50) |
| 3 | 2 top (50/50), 1 bottom (full width) |
| 4+ | 2-column wrapping grid |

Each grid cell has a title bar showing:
- Color dot
- Terminal name
- X button to close that terminal

When in grid view, the sidebar toggle button reads **"Tab View"**.
When in tab view, the sidebar toggle button reads **"Grid View"**.

### Settings Pane

Opens in the main area (replaces terminal view). Contains:

1. **Default Shell** — dropdown of available shells; saved as default for new terminals
2. **Edit Config Files** — two tabs:
   - `.bashrc` — Monaco Editor (full height, syntax highlighting)
   - `.bash_profile` — Monaco Editor (full height, syntax highlighting)
3. **Save** button per file to write changes to disk

---

## Shell Support

Shell availability is detected per OS at startup using `ShellDetector`:

| Shell | Windows | macOS | Linux |
|---|---|---|---|
| bash | ✅ (Git Bash / WSL) | ✅ | ✅ |
| zsh | ❌ | ✅ (default) | ✅ |
| cmd | ✅ | ❌ | ❌ |
| PowerShell | ✅ | ✅ (pwsh) | ✅ (pwsh) |
| Git Bash | ✅ | ❌ | ❌ |

Shells not present on the current OS are excluded from all dropdowns.

---

## Session Persistence

Session state is saved to `<userData>/session.json` on every meaningful state change (terminal added, removed, renamed, recolored, view mode changed).

```json
{
  "terminals": [
    {
      "id": "abc123",
      "name": "Terminal 1",
      "color": "#4FC3F7",
      "shellType": "bash"
    },
    {
      "id": "def456",
      "name": "Dev Server",
      "color": "#A5D6A7",
      "shellType": "zsh"
    }
  ],
  "defaultShell": "bash",
  "viewMode": "tabs"
}
```

**On launch:** session.json is read; each terminal's pty process is respawned fresh (prior processes are dead). Scroll history is not persisted.

**On terminal X close:** terminal is removed from session.json immediately and the pty process is killed. It does not return on next launch.

**On app quit:** session.json is left intact so the terminal list is restored on next launch.

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
│   └── configFileManager.ts  # Read/write .bashrc / .bash_profile
├── src/
│   ├── main.tsx              # React entry point
│   ├── App.tsx               # Root layout: Sidebar + MainArea
│   ├── store/
│   │   └── terminalStore.ts  # Zustand store
│   ├── components/
│   │   ├── Sidebar/
│   │   │   ├── Sidebar.tsx
│   │   │   ├── TerminalTab.tsx
│   │   │   └── AddTerminalModal.tsx
│   │   ├── TabView/
│   │   │   └── TabView.tsx
│   │   ├── GridView/
│   │   │   └── GridView.tsx
│   │   ├── TerminalPane/
│   │   │   └── TerminalPane.tsx  # xterm.js instance
│   │   ├── TabPopover/
│   │   │   └── TabPopover.tsx    # Rename + recolor
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
| Built-in `.bashrc`/`.bash_profile` editor | ❌ | ✅ Monaco Editor |
| Grid view auto-layout | Manual split panes | ✅ Auto count-based |
| Named + colored terminal tabs | Supported but cluttered | ✅ First-class, clean UX |
| VS Code-familiar interface | Different UX paradigm | ✅ Intentionally VS Code-like |
| Cross-platform | ✅ | ✅ |

---

## Out of Scope (v1)

- Terminal groups / workspaces
- SSH profile manager
- Command history search across terminals
- Terminal splitting within a single pane
- Themes beyond the default dark theme
