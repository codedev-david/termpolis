# Termpolis Feature Expansion — Design Spec

**Date:** 2026-03-19
**Status:** Draft
**Scope:** 7 must-have features + 1 nice-to-have

---

## Overview

This spec covers a significant feature expansion for Termpolis, adding terminal customization, intelligent auto-completion, command correction, output export, performance hardening, full Unicode support, and bundled CLI tools.

## Features

### 1. Font Size Selector in Add Terminal Modal

**What:** Users choose a font size when creating a new terminal, via a stepper control (−/+) with direct numeric input.

**Data model change:**
- `TerminalSession` gains `fontSize: number` field (default: 14, range: 8–32)

**UI:**
- Stepper control placed inline next to the shell selector in `AddTerminalModal`
- − button decrements, + button increments, center shows current value and is directly editable
- Font size also editable post-creation via `TabPopover`

**Implementation:**
- `TerminalPane` reads `fontSize` from session and passes to `new Terminal({ fontSize })`
- On font size change, call `terminal.options.fontSize = newSize` + `fitAddon.fit()` + `resizeTerminal()` IPC

---

### 2. Terminal Themes (Curated Set)

**What:** 7 curated xterm themes selectable per terminal. Each terminal can have a different theme.

**Themes:**
| ID | Name | Background | Foreground | Style |
|----|------|-----------|------------|-------|
| `dark` | Dark | `#1e1e1e` | `#d4d4d4` | VS Code Dark (current default) |
| `light` | Light | `#ffffff` | `#333333` | Clean light theme |
| `solarized-dark` | Solarized Dark | `#002b36` | `#839496` | Classic Solarized |
| `solarized-light` | Solarized Light | `#fdf6e3` | `#657b83` | Light Solarized |
| `monokai` | Monokai | `#272822` | `#f8f8f2` | Sublime-inspired |
| `dracula` | Dracula | `#282a36` | `#f8f8f2` | Popular dark theme |
| `nord` | Nord | `#2e3440` | `#d8dee9` | Arctic color palette |

Each theme definition includes full ANSI 16-color palette + cursor + selection colors.

**Data model change:**
- `TerminalSession` gains `theme: string` field (default: `'dark'`)

**UI:**
- Pill-style selector in `AddTerminalModal` showing actual bg/fg colors as preview
- Live mini-terminal preview at bottom of modal updates with theme + font size changes
- Theme also editable post-creation via `TabPopover`
- Accent color (tab border) remains independent from terminal theme

**Implementation:**
- Theme definitions stored in `src/renderer/src/themes/terminalThemes.ts` as a `Record<string, ITheme>`
- `TerminalPane` reads theme ID from session, resolves to `ITheme`, passes to `new Terminal({ theme })`
- On theme change, call `terminal.options.theme = newTheme`

---

### 3. Auto-Completion / Intellisense

**What:** VS Code-style dropdown overlay suggesting commands, subcommands, flags, file paths, and history matches as the user types.

**Architecture:**

```
User types → Keystroke Interceptor → Input Parser → Completion Engine → Dropdown Overlay
                                                          ↑
                                          ┌───────────────┼───────────────┐
                                    Bundled Specs    Shell Native      History
                                    (~300 commands)  (PATH, files,    (frequency-
                                                      env vars)       ranked)
```

**Completion sources (priority order):**
1. **Bundled completion specs** — JSON definitions for ~300 common commands (git, docker, npm, kubectl, aws, python, cargo, etc.). Sourced from the withfig/autocomplete project (MIT). Each spec defines: command name, description, subcommands, options (flags with descriptions), and argument types.
2. **Shell-native completions** — PATH-discovered commands, file/directory paths, environment variables, shell aliases. Resolved via IPC to main process.
3. **Command history** — previously used commands from `historyStore`, ranked by frequency.

**Trigger conditions:**
- After typing 2+ characters at command position
- Immediately after space following a known command (for subcommands)
- After `-` or `--` (for flags/options)
- After `/` or `\` in an argument position (for file paths)

**Dropdown behavior:**
- Positioned at cursor location in the terminal
- Shows up to 8 suggestions, each with name + short description
- Arrow keys navigate, Tab accepts, Esc dismisses
- Continues filtering as user types — non-blocking, never intercepts normal input
- Footer shows keyboard hints: `↑↓ navigate · Tab accept · Esc dismiss`

**Data model:**
- Specs stored in `src/renderer/src/completions/specs/` as JSON, loaded lazily per command
- Spec format: `{ name, description, subcommands: Spec[], options: Option[], args: Arg[] }`
- `Option`: `{ name: string[], description: string, args?: Arg[] }`

**New IPC channels:**
- `completion:path-entries` — list files/dirs at a given path
- `completion:path-commands` — list commands available in PATH
- `completion:env-vars` — list environment variables

**New components:**
- `src/renderer/src/components/CompletionDropdown/CompletionDropdown.tsx` — the overlay UI
- `src/renderer/src/completions/completionEngine.ts` — orchestrates all completion sources
- `src/renderer/src/completions/inputParser.ts` — parses current terminal line into tokens
- `src/renderer/src/completions/specLoader.ts` — lazy-loads spec files

---

### 4. Command Auto-Fix (thefuck-style)

**What:** When a command fails, detect the error pattern and show an inline suggestion banner with the corrected command.

**Detection:** After each command, monitor PTY output for:
- Non-zero exit code (tracked via shell prompt detection or `$?` monitoring)
- Error keywords in recent output (stderr patterns)

**Correction rules (~50-100 patterns):**

| Pattern | Detection | Fix Strategy |
|---------|-----------|-------------|
| Command not found | stderr: "not found" / "not recognized" | Levenshtein match against PATH commands |
| Git typo | stderr: "Did you mean" | Extract suggestion from stderr |
| Permission denied | stderr: "Permission denied" / "EACCES" | Prepend `sudo` (Linux/macOS only) |
| No such file/dir | stderr: "No such file" | Fuzzy match nearby filesystem entries |
| Wrong flag | stderr: "unknown option" / "unrecognized" | Match against bundled completion specs |
| Missing package | stderr: "MODULE_NOT_FOUND" / "not installed" | Suggest install command |
| Port in use | stderr: "EADDRINUSE" | Suggest `kill` or alternate port |

**UI:**
- Green banner appears below error output: `💡 Fix: <corrected command>`
- Right side shows: `Enter to run · Esc to ignore`
- Auto-dismisses after 10 seconds or when user starts typing a new command
- Never auto-executes — always requires explicit Enter

**Implementation:**
- `src/renderer/src/components/CommandFix/CommandFixBanner.tsx` — the inline banner
- `src/renderer/src/corrections/correctionEngine.ts` — matches output against rules
- `src/renderer/src/corrections/rules/` — individual rule modules (one per pattern category)
- Rules are pure functions: `(command: string, output: string) => string | null`

---

### 5. Grid View Performance

**What:** Ensure grid view handles heavy output from multiple terminals without degradation.

**Strategies:**

1. **Output throttling** — Batch PTY data writes using `requestAnimationFrame`. Maximum 1 render per 16ms per terminal. Queue excess data in a buffer and flush on the next frame.

2. **Scrollback buffer limit** — Set xterm.js `scrollback` option to 10,000 lines per terminal (default). Prevents unbounded memory growth. Configurable in settings.

3. **Viewport-aware rendering** — Terminals scrolled off-screen in grid view get reduced render priority. Data is still queued (no data loss) but DOM rendering is deferred until the terminal scrolls back into view. Uses `IntersectionObserver`.

4. **WebGL renderer** — Use `@xterm/addon-webgl` for GPU-accelerated terminal rendering. Falls back to canvas renderer if WebGL is unavailable. Significant performance improvement when rendering multiple terminals simultaneously.

**Implementation:**
- Add `@xterm/addon-webgl` dependency
- Modify `TerminalPane` to load WebGL addon, with canvas fallback
- Add throttle wrapper around `term.write()` calls using rAF batching
- Add `IntersectionObserver` in `GridView` to track terminal visibility
- Add `scrollback` option (default 10,000) to Terminal constructor

---

### 6. Full Unicode + Font Support

**What:** Correct rendering of emoji, CJK characters, and special glyphs with proper cursor alignment. Bundled fonts with broad glyph coverage.

**Unicode addon:**
- Add `@xterm/addon-unicode11` dependency
- Activate on terminal creation: `terminal.unicode.activeVersion = '11'`
- Fixes character width calculation for double-width characters (CJK, emoji)

**Bundled fonts:**
- **JetBrains Mono** — excellent Unicode coverage, ligatures, free (Apache 2.0)
- **JetBrains Mono Nerd Font** — same + powerline glyphs, devicons, weather icons, etc.
- Fonts stored in `src/renderer/src/assets/fonts/` and loaded via `@font-face`

**Font selector:**
- Added to `AddTerminalModal` as a dropdown alongside font size
- Options: Consolas (system default), JetBrains Mono, JetBrains Mono Nerd Font
- Also editable post-creation via `TabPopover`

**Data model change:**
- `TerminalSession` gains `fontFamily: string` field (default: `'Consolas, "Courier New", monospace'`)

---

### 7. Terminal Output Export

**What:** Export terminal scrollback to a plain text file via header button or context menu.

**Triggers:**
- **Header button** (save icon) — in the terminal card header, next to the close button. Exports full scrollback.
- **Right-click context menu** — two options: "Export Full Scrollback..." and "Export Visible Output..."

**Export behavior:**
- Opens system Save dialog via Electron's `dialog.showSaveDialog()`
- Default filename: `{terminal-name}_{YYYY-MM-DD}_{HHmmss}.txt`
- Content: plain text, ANSI escape codes stripped
- Reads lines from `terminal.buffer.active` (xterm.js API)

**New IPC channel:**
- `terminal:export` — receives `{ content: string, defaultFilename: string }`, opens save dialog, writes file

**Implementation:**
- Add save icon button to terminal headers in `GridView` and `TabView`
- Add context menu entries via xterm.js `onContextMenu` or custom right-click handler
- `src/renderer/src/lib/exportTerminal.ts` — utility to extract and strip buffer content
- Main process handler in `index.ts` for the file dialog + write

---

### 8. Bundled CLI Tools (Nice-to-Have)

**What:** Ship jq, yq, and curl as standalone binaries so they're available in every terminal out of the box.

**Tools:**
| Tool | Size | License | Notes |
|------|------|---------|-------|
| jq | ~1.5MB | MIT | JSON processor |
| yq | ~5MB | MIT | YAML/XML/TOML processor |
| curl | ~3MB | MIT-like | Only bundled as fallback if not detected in system PATH |

**Implementation:**
- Static binaries stored in `resources/tools/{platform}/` (win32, darwin, linux)
- `electron-builder` configured to include platform-specific binaries via `extraResources`
- On app startup, main process checks for each tool in system PATH
- If missing, prepends `resources/tools/{platform}` to the PATH environment for all spawned PTY sessions
- Tools immediately available in every terminal without user action

**Build pipeline:**
- Download script (`scripts/download-tools.sh`) fetches latest releases for all 3 platforms
- CI/CD runs download script before packaging
- Per-platform: only that platform's binaries are included in the installer

**Size impact:** ~10MB additional per platform installer

---

## Data Model Summary

Updated `TerminalSession` interface:

```typescript
interface TerminalSession {
  id: string
  name: string
  color: string           // accent color (tab/border)
  shellType: ShellType
  cwd: string
  fontSize: number        // NEW — default: 14, range: 8-32
  theme: string           // NEW — default: 'dark'
  fontFamily: string      // NEW — default: 'Consolas, "Courier New", monospace'
}
```

## New Dependencies

| Package | Purpose |
|---------|---------|
| `@xterm/addon-webgl` | GPU-accelerated terminal rendering |
| `@xterm/addon-unicode11` | Correct Unicode width calculation |

## New IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `completion:path-entries` | invoke | List files/dirs at path |
| `completion:path-commands` | invoke | List PATH commands |
| `completion:env-vars` | invoke | List environment variables |
| `terminal:export` | invoke | Save dialog + write file |

## New Components

| Path | Purpose |
|------|---------|
| `src/renderer/src/themes/terminalThemes.ts` | Theme definitions |
| `src/renderer/src/components/CompletionDropdown/` | Autocomplete overlay |
| `src/renderer/src/completions/` | Completion engine, parser, spec loader |
| `src/renderer/src/components/CommandFix/` | Correction banner |
| `src/renderer/src/corrections/` | Correction engine + rules |
| `src/renderer/src/lib/exportTerminal.ts` | Buffer extraction + ANSI stripping |
| `src/renderer/src/assets/fonts/` | JetBrains Mono + Nerd Font |
| `resources/tools/` | Bundled CLI binaries |
