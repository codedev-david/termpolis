# Termpolis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Termpolis — a cross-platform Electron terminal manager with named/colored tabs, grid view, workspaces, Monaco config editing, and cross-terminal history search.

**Architecture:** Electron main process owns all node-pty shell processes and communicates with the React renderer via a typed IPC bridge (preload context bridge). React+Zustand manages UI state; xterm.js renders terminals; session and history are persisted as JSON in the Electron userData directory.

**Tech Stack:** Electron, React 18, TypeScript, Vite (via electron-vite), xterm.js, node-pty, Zustand, @monaco-editor/react, Tailwind CSS, Vitest, React Testing Library, uuid

**Spec:** `docs/superpowers/specs/2026-03-18-termpolis-design.md`

---

## File Map

```
termpolis/
├── package.json                          # deps + scripts
├── tsconfig.json                         # base TS config
├── tsconfig.node.json                    # main process TS config
├── tsconfig.web.json                     # renderer TS config
├── vite.config.ts                        # electron-vite config
├── electron-builder.config.ts            # packaging config
├── tailwind.config.js                    # Tailwind setup
├── postcss.config.js                     # PostCSS for Tailwind
│
├── electron/                             # MAIN PROCESS
│   ├── main.ts                           # entry: BrowserWindow, IPC wiring
│   ├── preload.ts                        # contextBridge API surface
│   ├── terminalManager.ts               # node-pty spawn/kill/write/resize
│   ├── shellDetector.ts                 # detect available shells per OS
│   ├── sessionStore.ts                  # read/write session.json
│   ├── historyStore.ts                  # read/write history.json, search
│   └── configFileManager.ts             # read/write shell config files
│
├── src/                                  # RENDERER
│   ├── main.tsx                          # React entry
│   ├── App.tsx                           # root layout: Sidebar + MainArea
│   ├── index.css                         # Tailwind directives + global styles
│   ├── store/
│   │   └── terminalStore.ts             # Zustand store (all UI state)
│   ├── lib/
│   │   └── homedir.ts                   # shared homedir promise (IPC, cached)
│   ├── types/
│   │   └── index.ts                     # shared TS types
│   └── components/
│       ├── Sidebar/
│       │   ├── Sidebar.tsx              # wrapper: fixed buttons + scrollable list
│       │   ├── TerminalTab.tsx          # single tab row (color, name, icon, X)
│       │   ├── WorkspaceList.tsx        # collapsible workspace section
│       │   └── AddTerminalModal.tsx     # modal: name + shell + color picker
│       ├── TabView/
│       │   └── TabView.tsx              # renders all TerminalPanes, CSS show/hide
│       ├── GridView/
│       │   └── GridView.tsx             # auto CSS Grid layout + cell title bars
│       ├── TerminalPane/
│       │   └── TerminalPane.tsx         # xterm.js instance + IPC wiring + resize
│       ├── TabPopover/
│       │   └── TabPopover.tsx           # rename + recolor popover
│       ├── HistorySearch/
│       │   └── HistorySearchModal.tsx   # Ctrl+Shift+H full-screen search
│       └── SettingsPane/
│           └── SettingsPane.tsx         # default shell + Monaco config editors
│
└── tests/
    ├── electron/
    │   ├── shellDetector.test.ts
    │   ├── sessionStore.test.ts
    │   ├── historyStore.test.ts
    │   └── configFileManager.test.ts
    └── components/
        ├── AddTerminalModal.test.tsx
        ├── TabPopover.test.tsx
        ├── GridView.test.tsx
        ├── WorkspaceList.test.tsx
        └── HistorySearchModal.test.tsx
```

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `vite.config.ts`
- Create: `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`
- Create: `tailwind.config.js`, `postcss.config.js`
- Create: `electron-builder.config.ts`
- Create: `src/index.css`

- [ ] **Step 1: Scaffold with electron-vite**

```bash
cd C:/Users/DavidEngelhart/repos/termpolis
npm create electron-vite@latest . --template react-ts
```

If the CLI prompts for a project name, press Enter to use the current directory. This generates the base Electron+React+TypeScript+Vite project.

> **Note on node-pty on Windows:** Verify native build tools are available before continuing. Run `npm rebuild node-pty` after install. If it fails, install Visual Studio Build Tools (C++ workload) from https://visualstudio.microsoft.com/visual-cpp-build-tools/ and retry.

- [ ] **Step 2: Install all dependencies**

```bash
npm install xterm @xterm/addon-fit @xterm/addon-web-links node-pty zustand @monaco-editor/react uuid tailwindcss postcss autoprefixer
npm install --save-dev @types/uuid vitest @vitest/coverage-v8 @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom electron-builder
```

> **Note on node-pty:** It requires native compilation. On Windows, ensure `windows-build-tools` or Visual Studio Build Tools are installed. Run `npm rebuild node-pty` if you see build errors.

- [ ] **Step 3: Initialize Tailwind**

```bash
npx tailwindcss init -p
```

- [ ] **Step 4: Configure Tailwind**

Edit `tailwind.config.js`:
```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{tsx,ts,jsx,js}'],
  theme: { extend: {} },
  plugins: [],
}
```

- [ ] **Step 5: Add Tailwind directives to `src/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; padding: 0; background: #1e1e1e; color: #d4d4d4; font-family: 'Segoe UI', system-ui, sans-serif; }
```

- [ ] **Step 6: Configure Vitest in `vite.config.ts`**

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
  },
})
```

- [ ] **Step 7: Create test setup file**

Create `tests/setup.ts`:
```ts
import '@testing-library/jest-dom'
```

- [ ] **Step 8: Configure electron-builder**

Create `electron-builder.config.ts`:
```ts
import type { Configuration } from 'electron-builder'

const config: Configuration = {
  appId: 'com.termpolis.app',
  productName: 'Termpolis',
  directories: { output: 'dist-electron-builder' },
  files: ['dist/**/*', 'dist-electron/**/*'],
  win: { target: 'nsis', icon: 'assets/icon.ico' },
  mac: { target: 'dmg', icon: 'assets/icon.icns' },
  linux: { target: 'AppImage', icon: 'assets/icon.png' },
}

export default config
```

- [ ] **Step 9: Add npm scripts to `package.json`**

Ensure these scripts exist:
```json
{
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "package": "electron-vite build && electron-builder",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

- [ ] **Step 10: Verify scaffold runs**

```bash
npm run dev
```

Expected: Electron window opens with the default vite+react boilerplate. Close it.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: scaffold electron-vite react-ts project with dependencies"
```

---

## Task 2: Shared TypeScript Types

**Files:**
- Create: `src/types/index.ts`

- [ ] **Step 1: Write types**

Create `src/types/index.ts`:
```ts
export type ShellType = 'bash' | 'zsh' | 'cmd' | 'powershell' | 'gitbash'

export type ViewMode = 'tabs' | 'grid'

export interface ShellInfo {
  type: ShellType
  label: string       // display name e.g. "Git Bash"
  executable: string  // full path to binary
}

export interface TerminalSession {
  id: string
  name: string
  color: string       // hex e.g. "#4FC3F7"
  shellType: ShellType
  cwd: string         // absolute path
}

export interface Workspace {
  id: string
  name: string
  terminals: Omit<TerminalSession, 'id' | 'cwd'>[]  // no id/cwd — assigned fresh on spawn
}

export interface SessionData {
  terminals: TerminalSession[]
  workspaces: Workspace[]
  defaultShell: ShellType
  viewMode: ViewMode
}

export interface HistoryEntry {
  terminalId: string
  terminalName: string
  command: string
  timestamp: number   // Unix ms
}

export interface IpcResponse<T = undefined> {
  success: boolean
  data?: T
  error?: string
}

// The API exposed by preload.ts via contextBridge
export interface TermpolisAPI {
  createTerminal: (id: string, shellType: ShellType, cwd: string) => Promise<IpcResponse>
  killTerminal: (id: string) => Promise<IpcResponse>
  writeToTerminal: (id: string, data: string) => void
  resizeTerminal: (id: string, cols: number, rows: number) => void
  onTerminalData: (cb: (id: string, data: string) => void) => () => void
  getAvailableShells: () => Promise<IpcResponse<ShellInfo[]>>
  readConfigFile: (filePath: string) => Promise<IpcResponse<string>>
  writeConfigFile: (filePath: string, content: string) => Promise<IpcResponse>
  appendHistory: (terminalId: string, terminalName: string, command: string) => void
  searchHistory: (query: string) => Promise<IpcResponse<HistoryEntry[]>>
  getHomedir: () => Promise<IpcResponse<string>>
  loadSession: () => Promise<IpcResponse<SessionData>>
  saveSession: (data: SessionData) => void
}

declare global {
  interface Window {
    termpolis: TermpolisAPI
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add shared TypeScript types"
```

---

## Task 3: ShellDetector (Main Process)

**Files:**
- Create: `electron/shellDetector.ts`
- Create: `tests/electron/shellDetector.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/electron/shellDetector.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync } from 'fs'

vi.mock('fs')
vi.mock('os', () => ({ homedir: () => '/home/user', platform: () => 'linux' }))

// We import after mocks are set up
const { detectAvailableShells, getDefaultShell } = await import('../../electron/shellDetector')

describe('detectAvailableShells', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns bash when /bin/bash exists on linux', async () => {
    vi.mocked(existsSync).mockImplementation((p) => p === '/bin/bash')
    const shells = await detectAvailableShells()
    expect(shells.some(s => s.type === 'bash')).toBe(true)
  })

  it('excludes zsh when not present', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    const shells = await detectAvailableShells()
    expect(shells.some(s => s.type === 'zsh')).toBe(false)
  })

  it('always returns at least one shell or empty array', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    const shells = await detectAvailableShells()
    expect(Array.isArray(shells)).toBe(true)
  })
})

describe('getDefaultShell', () => {
  it('returns bash on linux when available', async () => {
    vi.mocked(existsSync).mockImplementation((p) => p === '/bin/bash')
    const shells = await detectAvailableShells()
    const def = getDefaultShell(shells, 'linux')
    expect(def?.type).toBe('bash')
  })
})
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npx vitest run tests/electron/shellDetector.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `electron/shellDetector.ts`**

```ts
import { existsSync } from 'fs'
import { platform } from 'os'
import type { ShellInfo, ShellType } from '../src/types'

const SHELL_CANDIDATES: Record<string, { type: ShellType; label: string; paths: string[] }[]> = {
  win32: [
    { type: 'powershell', label: 'PowerShell', paths: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'] },
    { type: 'cmd', label: 'Command Prompt', paths: ['C:\\Windows\\System32\\cmd.exe'] },
    { type: 'gitbash', label: 'Git Bash', paths: ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'] },
    { type: 'bash', label: 'Bash (WSL)', paths: ['C:\\Windows\\System32\\bash.exe'] },
  ],
  darwin: [
    { type: 'zsh', label: 'Zsh', paths: ['/bin/zsh'] },
    { type: 'bash', label: 'Bash', paths: ['/bin/bash'] },
    { type: 'powershell', label: 'PowerShell', paths: ['/usr/local/bin/pwsh', '/opt/homebrew/bin/pwsh'] },
  ],
  linux: [
    { type: 'bash', label: 'Bash', paths: ['/bin/bash', '/usr/bin/bash'] },
    { type: 'zsh', label: 'Zsh', paths: ['/bin/zsh', '/usr/bin/zsh'] },
    { type: 'powershell', label: 'PowerShell', paths: ['/usr/bin/pwsh', '/usr/local/bin/pwsh'] },
  ],
}

export async function detectAvailableShells(): Promise<ShellInfo[]> {
  const os = platform()
  const key = os === 'win32' ? 'win32' : os === 'darwin' ? 'darwin' : 'linux'
  const candidates = SHELL_CANDIDATES[key] ?? []
  const found: ShellInfo[] = []

  for (const candidate of candidates) {
    const exe = candidate.paths.find(p => existsSync(p))
    if (exe) {
      found.push({ type: candidate.type, label: candidate.label, executable: exe })
    }
  }

  return found
}

export function getDefaultShell(shells: ShellInfo[], os: string): ShellInfo | undefined {
  const preferredByOs: Record<string, ShellType> = {
    darwin: 'zsh',
    linux: 'bash',
    win32: 'powershell',
  }
  const preferred = preferredByOs[os] ?? 'bash'
  return shells.find(s => s.type === preferred) ?? shells[0]
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npx vitest run tests/electron/shellDetector.test.ts
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add electron/shellDetector.ts tests/electron/shellDetector.test.ts
git commit -m "feat: implement ShellDetector with per-OS shell detection"
```

---

## Task 4: SessionStore (Main Process)

**Files:**
- Create: `electron/sessionStore.ts`
- Create: `tests/electron/sessionStore.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/electron/sessionStore.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'fs'

vi.mock('fs')
vi.mock('electron', () => ({ app: { getPath: () => '/fake/userData' } }))

const { loadSession, saveSession } = await import('../../electron/sessionStore')

const defaultSession = {
  terminals: [],
  workspaces: [],
  defaultShell: 'bash' as const,
  viewMode: 'tabs' as const,
}

describe('loadSession', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns default session when file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    const result = loadSession()
    expect(result).toMatchObject(defaultSession)
  })

  it('parses and returns session when file exists', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const stored = { ...defaultSession, defaultShell: 'zsh', terminals: [{ id: '1', name: 'T1', color: '#fff', shellType: 'zsh', cwd: '/home' }] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stored) as any)
    const result = loadSession()
    expect(result.defaultShell).toBe('zsh')
    expect(result.terminals).toHaveLength(1)
  })

  it('returns default session when file is corrupt JSON', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue('not-json' as any)
    const result = loadSession()
    expect(result).toMatchObject(defaultSession)
  })
})

describe('saveSession', () => {
  it('writes session to disk as JSON', () => {
    saveSession(defaultSession)
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('session.json'),
      JSON.stringify(defaultSession, null, 2),
      'utf-8'
    )
  })
})
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npx vitest run tests/electron/sessionStore.test.ts
```

- [ ] **Step 3: Implement `electron/sessionStore.ts`**

```ts
import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { SessionData, ShellType, ViewMode } from '../src/types'

const DEFAULT_SESSION: SessionData = {
  terminals: [],
  workspaces: [],
  defaultShell: 'bash',
  viewMode: 'tabs',
}

function getSessionPath(): string {
  return join(app.getPath('userData'), 'session.json')
}

export function loadSession(): SessionData {
  const path = getSessionPath()
  if (!existsSync(path)) return { ...DEFAULT_SESSION }
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as SessionData
    return { ...DEFAULT_SESSION, ...parsed }
  } catch {
    return { ...DEFAULT_SESSION }
  }
}

export function saveSession(data: SessionData): void {
  writeFileSync(getSessionPath(), JSON.stringify(data, null, 2), 'utf-8')
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npx vitest run tests/electron/sessionStore.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add electron/sessionStore.ts tests/electron/sessionStore.test.ts
git commit -m "feat: implement SessionStore with load/save and corrupt-file fallback"
```

---

## Task 5: HistoryStore (Main Process)

**Files:**
- Create: `electron/historyStore.ts`
- Create: `tests/electron/historyStore.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/electron/historyStore.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'fs'

vi.mock('fs')
vi.mock('electron', () => ({ app: { getPath: () => '/fake/userData' } }))

const { appendCommand, searchHistory, loadHistory } = await import('../../electron/historyStore')

describe('appendCommand', () => {
  beforeEach(() => vi.clearAllMocks())

  it('appends a command to history', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    appendCommand('t1', 'T1', 'ls -la')
    expect(writeFileSync).toHaveBeenCalled()
    const written = JSON.parse((writeFileSync as any).mock.calls[0][1])
    expect(written.t1[0].command).toBe('ls -la')
  })

  it('prunes entries beyond 1000 per terminal', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const existing = Array.from({ length: 1000 }, (_, i) => ({
      terminalId: 't1', terminalName: 'T1', command: `cmd${i}`, timestamp: i,
    }))
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ t1: existing }) as any)
    appendCommand('t1', 'T1', 'new-cmd')
    const written = JSON.parse((writeFileSync as any).mock.calls[0][1])
    expect(written.t1.length).toBe(1000)
    expect(written.t1[999].command).toBe('new-cmd')
  })
})

describe('searchHistory', () => {
  it('returns entries matching query across all terminals', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      t1: [{ terminalId: 't1', terminalName: 'T1', command: 'git status', timestamp: 1 }],
      t2: [{ terminalId: 't2', terminalName: 'T2', command: 'npm install', timestamp: 2 }],
    }) as any)
    const results = searchHistory('git')
    expect(results).toHaveLength(1)
    expect(results[0].command).toBe('git status')
  })

  it('returns results sorted by recency descending', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      t1: [
        { terminalId: 't1', terminalName: 'T1', command: 'git log', timestamp: 100 },
        { terminalId: 't1', terminalName: 'T1', command: 'git status', timestamp: 200 },
      ],
    }) as any)
    const results = searchHistory('git')
    expect(results[0].timestamp).toBe(200)
  })
})
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npx vitest run tests/electron/historyStore.test.ts
```

- [ ] **Step 3: Implement `electron/historyStore.ts`**

```ts
import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { HistoryEntry } from '../src/types'

const MAX_PER_TERMINAL = 1000

type HistoryFile = Record<string, HistoryEntry[]>

function getHistoryPath(): string {
  return join(app.getPath('userData'), 'history.json')
}

export function loadHistory(): HistoryFile {
  const path = getHistoryPath()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as HistoryFile
  } catch {
    return {}
  }
}

function saveHistory(data: HistoryFile): void {
  writeFileSync(getHistoryPath(), JSON.stringify(data, null, 2), 'utf-8')
}

export function appendCommand(terminalId: string, terminalName: string, command: string): void {
  const trimmed = command.trim()
  if (!trimmed) return
  const history = loadHistory()
  if (!history[terminalId]) history[terminalId] = []
  history[terminalId].push({ terminalId, terminalName, command: trimmed, timestamp: Date.now() })
  if (history[terminalId].length > MAX_PER_TERMINAL) {
    history[terminalId] = history[terminalId].slice(-MAX_PER_TERMINAL)
  }
  saveHistory(history)
}

export function searchHistory(query: string): HistoryEntry[] {
  const history = loadHistory()
  const lower = query.toLowerCase()
  const all: HistoryEntry[] = Object.values(history).flat()
  return all
    .filter(e => e.command.toLowerCase().includes(lower))
    .sort((a, b) => b.timestamp - a.timestamp)
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npx vitest run tests/electron/historyStore.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add electron/historyStore.ts tests/electron/historyStore.test.ts
git commit -m "feat: implement HistoryStore with per-terminal cap and cross-terminal search"
```

---

## Task 6: ConfigFileManager (Main Process)

**Files:**
- Create: `electron/configFileManager.ts`
- Create: `tests/electron/configFileManager.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/electron/configFileManager.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

vi.mock('fs')

const { readConfigFile, writeConfigFile } = await import('../../electron/configFileManager')

describe('readConfigFile', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns file contents when file exists', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue('export PATH=$PATH:/usr/local/bin' as any)
    const result = readConfigFile('/home/user/.bashrc')
    expect(result).toBe('export PATH=$PATH:/usr/local/bin')
  })

  it('returns empty string when file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    const result = readConfigFile('/home/user/.bashrc')
    expect(result).toBe('')
  })
})

describe('writeConfigFile', () => {
  it('writes content to the specified path', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    writeConfigFile('/home/user/.bashrc', 'export EDITOR=vim')
    expect(writeFileSync).toHaveBeenCalledWith('/home/user/.bashrc', 'export EDITOR=vim', 'utf-8')
  })

  it('creates parent directories if they do not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    writeConfigFile('/home/user/.bashrc', '')
    expect(mkdirSync).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npx vitest run tests/electron/configFileManager.test.ts
```

- [ ] **Step 3: Implement `electron/configFileManager.ts`**

```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

export function readConfigFile(filePath: string): string {
  if (!existsSync(filePath)) return ''
  return readFileSync(filePath, 'utf-8')
}

export function writeConfigFile(filePath: string, content: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(filePath, content, 'utf-8')
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npx vitest run tests/electron/configFileManager.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add electron/configFileManager.ts tests/electron/configFileManager.test.ts
git commit -m "feat: implement ConfigFileManager with auto-create on missing file"
```

---

## Task 7: TerminalManager (Main Process)

**Files:**
- Create: `electron/terminalManager.ts`

> **Note:** node-pty involves native OS processes. Unit testing it directly would require spawning real shells. Skip unit tests here — this module is integration-tested implicitly when the full app runs. Focus on clean types and error handling.

- [ ] **Step 1: Implement `electron/terminalManager.ts`**

```ts
import * as pty from 'node-pty'
import { homedir } from 'os'
import type { ShellType } from '../src/types'

interface PtyProcess {
  pty: pty.IPty
  onData: ((data: string) => void) | null
}

const processes = new Map<string, PtyProcess>()

export function spawnTerminal(
  id: string,
  executable: string,
  cwd: string,
  onData: (data: string) => void
): void {
  const resolvedCwd = (() => {
    try {
      // Verify cwd exists; fall back to home
      const { existsSync } = require('fs')
      return existsSync(cwd) ? cwd : homedir()
    } catch {
      return homedir()
    }
  })()

  const args = getShellArgs(executable)

  const proc = pty.spawn(executable, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: resolvedCwd,
    env: { ...process.env } as Record<string, string>,
  })

  proc.onData(onData)
  processes.set(id, { pty: proc, onData })
}

export function killTerminal(id: string): void {
  const proc = processes.get(id)
  if (proc) {
    try { proc.pty.kill() } catch {}
    processes.delete(id)
  }
}

export function writeToTerminal(id: string, data: string): void {
  processes.get(id)?.pty.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  processes.get(id)?.pty.resize(cols, rows)
}

export function killAll(): void {
  for (const [id] of processes) killTerminal(id)
}

function getShellArgs(executable: string): string[] {
  if (executable.endsWith('bash') || executable.endsWith('zsh')) return ['--login']
  if (executable.endsWith('pwsh') || executable.endsWith('pwsh.exe')) return []
  if (executable.endsWith('powershell.exe')) return []
  return []
}
```

- [ ] **Step 2: Commit**

```bash
git add electron/terminalManager.ts
git commit -m "feat: implement TerminalManager wrapping node-pty"
```

---

## Task 8: Main Process Entry + Preload (IPC Bridge)

**Files:**
- Create/replace: `electron/main.ts`
- Create/replace: `electron/preload.ts`

- [ ] **Step 1: Implement `electron/preload.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron'
import type { TermpolisAPI, ShellType } from '../src/types'

const api: TermpolisAPI = {
  createTerminal: (id, shellType, cwd) =>
    ipcRenderer.invoke('terminal:create', { id, shellType, cwd }),

  killTerminal: (id) =>
    ipcRenderer.invoke('terminal:kill', { id }),

  writeToTerminal: (id, data) =>
    ipcRenderer.send('terminal:write', { id, data }),

  resizeTerminal: (id, cols, rows) =>
    ipcRenderer.send('terminal:resize', { id, cols, rows }),

  onTerminalData: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, id: string, data: string) => cb(id, data)
    ipcRenderer.on('terminal:data', handler)
    return () => ipcRenderer.removeListener('terminal:data', handler)
  },

  getAvailableShells: () =>
    ipcRenderer.invoke('shell:available'),

  readConfigFile: (filePath) =>
    ipcRenderer.invoke('config:read', { filePath }),

  writeConfigFile: (filePath, content) =>
    ipcRenderer.invoke('config:write', { filePath, content }),

  appendHistory: (terminalId, terminalName, command) =>
    ipcRenderer.send('history:append', { terminalId, terminalName, command }),

  getHomedir: () =>
    ipcRenderer.invoke('fs:homedir'),

  searchHistory: (query) =>
    ipcRenderer.invoke('history:search', { query }),

  loadSession: () =>
    ipcRenderer.invoke('session:load'),

  saveSession: (data) =>
    ipcRenderer.send('session:save', data),
}

contextBridge.exposeInMainWorld('termpolis', api)
```

- [ ] **Step 2: Implement `electron/main.ts`**

```ts
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { detectAvailableShells } from './shellDetector'
import { spawnTerminal, killTerminal, writeToTerminal, resizeTerminal, killAll } from './terminalManager'
import { loadSession, saveSession } from './sessionStore'
import { appendCommand, searchHistory } from './historyStore'
import { readConfigFile, writeConfigFile } from './configFileManager'
import type { SessionData } from '../src/types'

function ok<T>(data?: T) { return { success: true, data } }
function err(error: string) { return { success: false, error } }

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    backgroundColor: '#1e1e1e',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => { mainWindow = null })
}

// IPC Handlers
ipcMain.handle('terminal:create', async (_, { id, shellType, cwd }) => {
  try {
    const shells = await detectAvailableShells()
    const shell = shells.find(s => s.type === shellType) ?? shells[0]
    if (!shell) return err('No shell available')
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 5000)
    )
    await Promise.race([
      new Promise<void>(resolve => {
        spawnTerminal(id, shell.executable, cwd, (data) => {
          mainWindow?.webContents.send('terminal:data', id, data)
        })
        resolve()
      }),
      timeout,
    ])
    return ok()
  } catch (e: any) {
    return err(e.message ?? 'Failed to create terminal')
  }
})

ipcMain.handle('terminal:kill', async (_, { id }) => {
  try { killTerminal(id); return ok() }
  catch (e: any) { return err(e.message) }
})

ipcMain.on('terminal:write', (_, { id, data }) => writeToTerminal(id, data))

ipcMain.on('terminal:resize', (_, { id, cols, rows }) => resizeTerminal(id, cols, rows))

ipcMain.handle('shell:available', async () => {
  try { return ok(await detectAvailableShells()) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('config:read', async (_, { filePath }) => {
  try { return ok(readConfigFile(filePath)) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('config:write', async (_, { filePath, content }) => {
  try { writeConfigFile(filePath, content); return ok() }
  catch (e: any) { return err(e.message) }
})

ipcMain.on('history:append', (_, { terminalId, terminalName, command }) => {
  appendCommand(terminalId, terminalName ?? terminalId, command)
})

ipcMain.handle('fs:homedir', () => ok(homedir()))

ipcMain.handle('history:search', async (_, { query }) => {
  try { return ok(searchHistory(query)) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('session:load', async () => {
  try { return ok(loadSession()) }
  catch (e: any) { return err(e.message) }
})

ipcMain.on('session:save', (_, data: SessionData) => {
  try { saveSession(data) } catch {}
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { killAll(); if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (!mainWindow) createWindow() })
```

- [ ] **Step 3: Start app and verify IPC loads without crash**

```bash
npm run dev
```

Expected: Electron window opens. No IPC errors in DevTools console. Close window.

- [ ] **Step 4: Commit**

```bash
git add electron/main.ts electron/preload.ts
git commit -m "feat: wire IPC bridge — preload context bridge + all ipcMain handlers"
```

---

## Task 9: Zustand Store (Renderer)

**Files:**
- Create: `src/store/terminalStore.ts`

- [ ] **Step 1: Implement `src/store/terminalStore.ts`**

```ts
import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import type { TerminalSession, Workspace, ViewMode, ShellType } from '../types'

interface TerminalStore {
  terminals: TerminalSession[]
  workspaces: Workspace[]
  activeTerminalId: string | null
  viewMode: ViewMode
  defaultShell: ShellType
  showSettings: boolean

  // Terminal actions
  addTerminal: (t: TerminalSession) => void
  removeTerminal: (id: string) => void
  updateTerminal: (id: string, patch: Partial<Pick<TerminalSession, 'name' | 'color'>>) => void
  setActiveTerminal: (id: string | null) => void

  // View actions
  toggleViewMode: () => void
  setShowSettings: (show: boolean) => void
  setDefaultShell: (shell: ShellType) => void

  // Workspace actions
  addWorkspace: (name: string) => void
  removeWorkspace: (id: string) => void
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  terminals: [],
  workspaces: [],
  activeTerminalId: null,
  viewMode: 'tabs',
  defaultShell: 'bash',
  showSettings: false,

  addTerminal: (t) => set(s => ({
    terminals: [...s.terminals, t],
    activeTerminalId: t.id,
  })),

  removeTerminal: (id) => set(s => {
    const remaining = s.terminals.filter(t => t.id !== id)
    const nextActive = s.activeTerminalId === id
      ? (remaining[remaining.length - 1]?.id ?? null)
      : s.activeTerminalId
    return { terminals: remaining, activeTerminalId: nextActive }
  }),

  updateTerminal: (id, patch) => set(s => ({
    terminals: s.terminals.map(t => t.id === id ? { ...t, ...patch } : t),
  })),

  setActiveTerminal: (id) => set({ activeTerminalId: id, showSettings: false }),

  toggleViewMode: () => set(s => ({ viewMode: s.viewMode === 'tabs' ? 'grid' : 'tabs' })),

  setShowSettings: (show) => set({ showSettings: show, activeTerminalId: show ? null : get().activeTerminalId }),

  setDefaultShell: (shell) => set({ defaultShell: shell }),

  addWorkspace: (name) => set(s => ({
    workspaces: [...s.workspaces, {
      id: uuid(),
      name,
      terminals: s.terminals.map(({ name, color, shellType }) => ({ name, color, shellType })),
    }],
  })),

  removeWorkspace: (id) => set(s => ({
    workspaces: s.workspaces.filter(w => w.id !== id),
  })),
}))
```

- [ ] **Step 2: Commit**

```bash
git add src/store/terminalStore.ts
git commit -m "feat: implement Zustand store with terminal, workspace, and view state"
```

---

## Task 9.5: Shared Homedir Utility (Renderer)

**Files:**
- Create: `src/lib/homedir.ts`

Node.js `homedir()` is unavailable in the renderer. This module fetches the home directory once via IPC and exports a promise so any component can `await getHomedir()` without each making its own IPC call.

- [ ] **Step 1: Create `src/lib/homedir.ts`**

```ts
// Fetches homedir from main process once and caches the result.
// Import this instead of using 'os'.homedir() — that API is unavailable in the renderer.
let cached: string | null = null

export async function getHomedir(): Promise<string> {
  if (cached !== null) return cached
  const res = await window.termpolis.getHomedir()
  cached = (res.success && res.data) ? res.data : '~'
  return cached
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/homedir.ts
git commit -m "feat: add shared homedir utility for renderer (IPC-backed)"
```

---

## Task 10: App Layout

**Files:**
- Create/replace: `src/App.tsx`
- Create/replace: `src/main.tsx`

- [ ] **Step 1: Implement `src/main.tsx`**

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

- [ ] **Step 2: Implement `src/App.tsx`**

```tsx
import React, { useEffect } from 'react'
import { Sidebar } from './components/Sidebar/Sidebar'
import { TabView } from './components/TabView/TabView'
import { GridView } from './components/GridView/GridView'
import { SettingsPane } from './components/SettingsPane/SettingsPane'
import { HistorySearchModal } from './components/HistorySearch/HistorySearchModal'
import { useTerminalStore } from './store/terminalStore'

export default function App() {
  const { viewMode, showSettings, terminals, addTerminal, removeTerminal, defaultShell } = useTerminalStore()
  const [historyOpen, setHistoryOpen] = React.useState(false)

  // Restore session on mount
  useEffect(() => {
    window.termpolis.loadSession().then(res => {
      if (!res.success || !res.data) return
      const { terminals: savedTerminals, workspaces, defaultShell: ds, viewMode: vm } = res.data
      useTerminalStore.setState({ workspaces, defaultShell: ds, viewMode: vm })
      savedTerminals.forEach(t => {
        useTerminalStore.getState().addTerminal(t)
        window.termpolis.createTerminal(t.id, t.shellType, t.cwd)
      })
    })
  }, [])

  // Persist session on state changes
  useEffect(() => {
    const state = useTerminalStore.getState()
    window.termpolis.saveSession({
      terminals: state.terminals,
      workspaces: state.workspaces,
      defaultShell: state.defaultShell,
      viewMode: state.viewMode,
    })
  }, [terminals])

  // Global keyboard shortcut for history search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'H') {
        e.preventDefault()
        setHistoryOpen(v => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const renderMain = () => {
    if (showSettings) return <SettingsPane />
    if (viewMode === 'grid') return <GridView />
    return <TabView />
  }

  return (
    <div className="flex h-screen bg-[#1e1e1e] text-[#d4d4d4] overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-hidden">
        {renderMain()}
      </main>
      {historyOpen && <HistorySearchModal onClose={() => setHistoryOpen(false)} />}
    </div>
  )
}
```

- [ ] **Step 3: Verify app renders without crash**

```bash
npm run dev
```

Expected: Dark window with placeholder sidebars. No console errors.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/main.tsx
git commit -m "feat: implement root App layout with session restore and keyboard shortcuts"
```

---

## Task 11: TerminalPane Component

**Files:**
- Create: `src/components/TerminalPane/TerminalPane.tsx`

- [ ] **Step 1: Implement `src/components/TerminalPane/TerminalPane.tsx`**

```tsx
import React, { useEffect, useRef } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import 'xterm/css/xterm.css'

interface Props {
  terminalId: string
  terminalName: string
  isVisible: boolean
}

export function TerminalPane({ terminalId, terminalName, isVisible }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const inputBufferRef = useRef('')

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      theme: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#aeafad' },
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 14,
      cursorBlink: true,
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    fitAddon.fit()
    termRef.current = term
    fitRef.current = fitAddon

    // Send keystrokes to pty; buffer input for history capture
    term.onData((data) => {
      window.termpolis.writeToTerminal(terminalId, data)
      if (data === '\r') {
        const cmd = inputBufferRef.current.trim()
        if (cmd) window.termpolis.appendHistory(terminalId, terminalName, cmd)
        inputBufferRef.current = ''
      } else if (data === '\u007f') {
        inputBufferRef.current = inputBufferRef.current.slice(0, -1)
      } else if (!data.startsWith('\x1b')) {
        inputBufferRef.current += data
      }
    })

    // Receive data from pty
    const unsub = window.termpolis.onTerminalData((id, data) => {
      if (id === terminalId) term.write(data)
    })

    // Resize observer
    const ro = new ResizeObserver(() => {
      fitAddon.fit()
      window.termpolis.resizeTerminal(terminalId, term.cols, term.rows)
    })
    ro.observe(containerRef.current)

    return () => {
      unsub()
      ro.disconnect()
      term.dispose()
    }
  }, [terminalId])

  // Refit when becoming visible (tab switch)
  useEffect(() => {
    if (isVisible && fitRef.current && termRef.current) {
      setTimeout(() => {
        fitRef.current!.fit()
        window.termpolis.resizeTerminal(terminalId, termRef.current!.cols, termRef.current!.rows)
      }, 0)
    }
  }, [isVisible, terminalId])

  return (
    <div
      ref={containerRef}
      style={{ display: isVisible ? 'block' : 'none', width: '100%', height: '100%', padding: 4 }}
    />
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/TerminalPane/TerminalPane.tsx
git commit -m "feat: implement TerminalPane with xterm.js, resize observer, and history capture"
```

---

## Task 12: TabView Component

**Files:**
- Create: `src/components/TabView/TabView.tsx`

- [ ] **Step 1: Implement `src/components/TabView/TabView.tsx`**

```tsx
import React from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import { TerminalPane } from '../TerminalPane/TerminalPane'

export function TabView() {
  const { terminals, activeTerminalId } = useTerminalStore()

  if (terminals.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[#6b7280]">
        <p>No terminals open. Click <strong>+ Add Terminal</strong> to get started.</p>
      </div>
    )
  }

  return (
    <div className="w-full h-full">
      {terminals.map(t => (
        <TerminalPane
          key={t.id}
          terminalId={t.id}
          terminalName={t.name}
          isVisible={t.id === activeTerminalId}
        />
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/TabView/TabView.tsx
git commit -m "feat: implement TabView with CSS show/hide for terminal instances"
```

---

## Task 13: GridView Component

**Files:**
- Create: `src/components/GridView/GridView.tsx`
- Create: `tests/components/GridView.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `tests/components/GridView.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react'
import { GridView } from '../../src/components/GridView/GridView'
import { useTerminalStore } from '../../src/store/terminalStore'
import { vi } from 'vitest'

vi.mock('../../src/components/TerminalPane/TerminalPane', () => ({
  TerminalPane: ({ terminalId }: any) => <div data-testid={`pane-${terminalId}`} />,
}))

vi.mock('../../src/store/terminalStore')

describe('GridView', () => {
  it('shows empty state when no terminals', () => {
    vi.mocked(useTerminalStore).mockReturnValue({ terminals: [], removeTerminal: vi.fn() } as any)
    render(<GridView />)
    expect(screen.getByText(/No terminals/i)).toBeInTheDocument()
  })

  it('renders a pane for each terminal', () => {
    const terminals = [
      { id: 't1', name: 'T1', color: '#fff', shellType: 'bash', cwd: '/' },
      { id: 't2', name: 'T2', color: '#000', shellType: 'zsh', cwd: '/' },
    ]
    vi.mocked(useTerminalStore).mockReturnValue({ terminals, removeTerminal: vi.fn() } as any)
    render(<GridView />)
    expect(screen.getByTestId('pane-t1')).toBeInTheDocument()
    expect(screen.getByTestId('pane-t2')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npx vitest run tests/components/GridView.test.tsx
```

- [ ] **Step 3: Implement `src/components/GridView/GridView.tsx`**

```tsx
import React from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import { TerminalPane } from '../TerminalPane/TerminalPane'

function getGridStyle(count: number): React.CSSProperties {
  if (count === 1) return { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }
  return { gridTemplateColumns: '1fr 1fr', gridAutoRows: '1fr' }
}

function getCellStyle(index: number, total: number): React.CSSProperties {
  // Odd last item in a multi-terminal grid spans both columns
  if (total > 2 && total % 2 !== 0 && index === total - 1) {
    return { gridColumn: '1 / -1' }
  }
  return {}
}

export function GridView() {
  const { terminals, removeTerminal } = useTerminalStore()

  if (terminals.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[#6b7280]">
        <p>No terminals open. Click <strong>+ Add Terminal</strong> to get started.</p>
      </div>
    )
  }

  return (
    <div
      className="w-full h-full grid gap-1 p-1 bg-[#252526]"
      style={getGridStyle(terminals.length)}
    >
      {terminals.map((t, i) => (
        <div
          key={t.id}
          className="flex flex-col bg-[#1e1e1e] overflow-hidden rounded"
          style={getCellStyle(i, terminals.length)}
        >
          {/* Title bar */}
          <div
            className="flex items-center gap-2 px-2 py-1 bg-[#2d2d2d] shrink-0"
            style={{ borderLeft: `3px solid ${t.color}` }}
          >
            <span className="text-xs font-medium truncate flex-1">{t.name}</span>
            <button
              onClick={() => {
                window.termpolis.killTerminal(t.id)
                removeTerminal(t.id)
              }}
              className="text-[#6b7280] hover:text-white text-xs px-1"
              aria-label={`Close ${t.name}`}
            >
              ✕
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            <TerminalPane terminalId={t.id} terminalName={t.name} isVisible={true} />
          </div>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npx vitest run tests/components/GridView.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add src/components/GridView/GridView.tsx tests/components/GridView.test.tsx
git commit -m "feat: implement GridView with auto CSS Grid layout and per-cell close button"
```

---

## Task 14: AddTerminalModal Component

**Files:**
- Create: `src/components/Sidebar/AddTerminalModal.tsx`
- Create: `tests/components/AddTerminalModal.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `tests/components/AddTerminalModal.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { AddTerminalModal } from '../../src/components/Sidebar/AddTerminalModal'
import { vi } from 'vitest'

const shells = [
  { type: 'bash', label: 'Bash', executable: '/bin/bash' },
  { type: 'zsh', label: 'Zsh', executable: '/bin/zsh' },
]

describe('AddTerminalModal', () => {
  it('renders name input pre-filled with "Terminal 1"', () => {
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByDisplayValue('Terminal 1')).toBeInTheDocument()
  })

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn()
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(onCancel).toHaveBeenCalled()
  })

  it('calls onCreate with name, shellType, and color when Create is clicked', () => {
    const onCreate = vi.fn()
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={onCreate} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByText('Create'))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Terminal 1',
      shellType: 'bash',
      color: expect.any(String),
    }))
  })
})
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npx vitest run tests/components/AddTerminalModal.test.tsx
```

- [ ] **Step 3: Implement `src/components/Sidebar/AddTerminalModal.tsx`**

```tsx
import React, { useState } from 'react'
import type { ShellInfo, ShellType } from '../../types'

const COLOR_SWATCHES = [
  '#4FC3F7','#A5D6A7','#CE93D8','#EF9A9A','#FFE082',
  '#80CBC4','#FFCC80','#9FA8DA','#F48FB1','#C5E1A5','#80DEEA','#B0BEC5',
]

interface Props {
  shells: ShellInfo[]
  nextIndex: number
  defaultShell: ShellType
  onCreate: (opts: { name: string; shellType: ShellType; color: string }) => void
  onCancel: () => void
}

export function AddTerminalModal({ shells, nextIndex, defaultShell, onCreate, onCancel }: Props) {
  const [name, setName] = useState(`Terminal ${nextIndex}`)
  const [shellType, setShellType] = useState<ShellType>(defaultShell)
  const [color, setColor] = useState(COLOR_SWATCHES[0])

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#252526] rounded-lg p-6 w-80 shadow-xl flex flex-col gap-4">
        <h2 className="text-base font-semibold">New Terminal</h2>

        <label className="flex flex-col gap-1 text-sm">
          Name
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-none focus:border-[#0078d4]"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Shell
          <select
            value={shellType}
            onChange={e => setShellType(e.target.value as ShellType)}
            className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-none"
          >
            {shells.map(s => (
              <option key={s.type} value={s.type}>{s.label}</option>
            ))}
          </select>
        </label>

        <div className="flex flex-col gap-1 text-sm">
          Color
          <div className="flex flex-wrap gap-2 mt-1">
            {COLOR_SWATCHES.map(c => (
              <button
                key={c}
                onClick={() => setColor(c)}
                style={{ background: c, width: 20, height: 20, borderRadius: 4, border: color === c ? '2px solid white' : '2px solid transparent' }}
                aria-label={c}
              />
            ))}
          </div>
        </div>

        <div className="flex gap-2 justify-end mt-2">
          <button onClick={onCancel} className="px-3 py-1 text-sm rounded hover:bg-[#3c3c3c]">Cancel</button>
          <button
            onClick={() => onCreate({ name: name.trim() || `Terminal ${nextIndex}`, shellType, color })}
            className="px-3 py-1 text-sm rounded bg-[#0078d4] hover:bg-[#106ebe] text-white"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npx vitest run tests/components/AddTerminalModal.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar/AddTerminalModal.tsx tests/components/AddTerminalModal.test.tsx
git commit -m "feat: implement AddTerminalModal with name, shell, and color picker"
```

---

## Task 15: TabPopover Component

**Files:**
- Create: `src/components/TabPopover/TabPopover.tsx`
- Create: `tests/components/TabPopover.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `tests/components/TabPopover.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { TabPopover } from '../../src/components/TabPopover/TabPopover'
import { vi } from 'vitest'

describe('TabPopover', () => {
  const defaultProps = {
    name: 'My Terminal',
    color: '#4FC3F7',
    onSave: vi.fn(),
    onClose: vi.fn(),
  }

  it('shows current name in input', () => {
    render(<TabPopover {...defaultProps} />)
    expect(screen.getByDisplayValue('My Terminal')).toBeInTheDocument()
  })

  it('calls onSave with updated name and color', () => {
    const onSave = vi.fn()
    render(<TabPopover {...defaultProps} onSave={onSave} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New Name' } })
    fireEvent.click(screen.getByText('Save'))
    expect(onSave).toHaveBeenCalledWith({ name: 'New Name', color: '#4FC3F7' })
  })

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn()
    render(<TabPopover {...defaultProps} onClose={onClose} />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npx vitest run tests/components/TabPopover.test.tsx
```

- [ ] **Step 3: Implement `src/components/TabPopover/TabPopover.tsx`**

```tsx
import React, { useState, useRef, useEffect } from 'react'

const COLOR_SWATCHES = [
  '#4FC3F7','#A5D6A7','#CE93D8','#EF9A9A','#FFE082',
  '#80CBC4','#FFCC80','#9FA8DA','#F48FB1','#C5E1A5','#80DEEA','#B0BEC5',
]

interface Props {
  name: string
  color: string
  onSave: (opts: { name: string; color: string }) => void
  onClose: () => void
}

export function TabPopover({ name, color, onSave, onClose }: Props) {
  const [editName, setEditName] = useState(name)
  const [editColor, setEditColor] = useState(color)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div
      ref={ref}
      className="absolute left-full top-0 ml-1 z-50 bg-[#252526] border border-[#3c3c3c] rounded-lg shadow-xl p-4 w-56 flex flex-col gap-3"
    >
      <input
        value={editName}
        onChange={e => setEditName(e.target.value)}
        className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-none focus:border-[#0078d4]"
      />
      <div className="flex flex-wrap gap-1">
        {COLOR_SWATCHES.map(c => (
          <button
            key={c}
            onClick={() => setEditColor(c)}
            style={{ background: c, width: 18, height: 18, borderRadius: 3, border: editColor === c ? '2px solid white' : '2px solid transparent' }}
            aria-label={c}
          />
        ))}
      </div>
      <div className="flex gap-2 justify-end">
        <button onClick={onClose} className="text-xs px-2 py-1 rounded hover:bg-[#3c3c3c]">Cancel</button>
        <button
          onClick={() => onSave({ name: editName.trim() || name, color: editColor })}
          className="text-xs px-2 py-1 rounded bg-[#0078d4] hover:bg-[#106ebe] text-white"
        >
          Save
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npx vitest run tests/components/TabPopover.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add src/components/TabPopover/TabPopover.tsx tests/components/TabPopover.test.tsx
git commit -m "feat: implement TabPopover for rename and recolor"
```

---

## Task 16: Sidebar + TerminalTab Components

**Files:**
- Create: `src/components/Sidebar/Sidebar.tsx`
- Create: `src/components/Sidebar/TerminalTab.tsx`

- [ ] **Step 1: Implement `src/components/Sidebar/TerminalTab.tsx`**

```tsx
import React, { useState, useRef } from 'react'
import { TabPopover } from '../TabPopover/TabPopover'
import type { TerminalSession } from '../../types'

const SHELL_ICON: Record<string, string> = {
  bash: '$', zsh: '%', cmd: '>', powershell: 'PS', gitbash: '$',
}

interface Props {
  terminal: TerminalSession
  isActive: boolean
  onClick: () => void
  onClose: () => void
  onUpdate: (patch: { name: string; color: string }) => void
}

export function TerminalTab({ terminal, isActive, onClick, onClose, onUpdate }: Props) {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const tabRef = useRef<HTMLDivElement>(null)

  return (
    <div
      ref={tabRef}
      className={`relative flex items-center gap-2 px-3 py-2 cursor-pointer select-none group ${
        isActive ? 'bg-[#37373d]' : 'hover:bg-[#2a2d2e]'
      }`}
      style={{ borderLeft: `3px solid ${terminal.color}` }}
      onClick={onClick}
      onContextMenu={e => { e.preventDefault(); setPopoverOpen(true) }}
    >
      <span className="text-[#6b7280] text-xs w-4 text-center font-mono">
        {SHELL_ICON[terminal.shellType] ?? '$'}
      </span>
      <span className="flex-1 text-sm truncate">{terminal.name}</span>

      {/* Pencil icon on hover */}
      <button
        onClick={e => { e.stopPropagation(); setPopoverOpen(true) }}
        className="opacity-0 group-hover:opacity-100 text-[#6b7280] hover:text-white text-xs px-1"
        aria-label="Edit terminal"
      >
        ✎
      </button>

      {/* Close button */}
      <button
        onClick={e => { e.stopPropagation(); onClose() }}
        className="text-[#6b7280] hover:text-white text-xs px-1"
        aria-label={`Close ${terminal.name}`}
      >
        ✕
      </button>

      {popoverOpen && (
        <TabPopover
          name={terminal.name}
          color={terminal.color}
          onSave={patch => { onUpdate(patch); setPopoverOpen(false) }}
          onClose={() => setPopoverOpen(false)}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Implement `src/components/Sidebar/Sidebar.tsx`**

```tsx
import React, { useEffect, useState } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import { TerminalTab } from './TerminalTab'
import { AddTerminalModal } from './AddTerminalModal'
import { WorkspaceList } from './WorkspaceList'
import { getHomedir } from '../../lib/homedir'
import { v4 as uuid } from 'uuid'
import type { ShellInfo } from '../../types'

export function Sidebar() {
  const {
    terminals, activeTerminalId, viewMode, showSettings, defaultShell,
    addTerminal, removeTerminal, updateTerminal,
    setActiveTerminal, toggleViewMode, setShowSettings,
  } = useTerminalStore()

  const [showAddModal, setShowAddModal] = useState(false)
  const [availableShells, setAvailableShells] = useState<ShellInfo[]>([])

  useEffect(() => {
    window.termpolis.getAvailableShells().then(res => {
      if (res.success && res.data) setAvailableShells(res.data)
    })
  }, [])

  const handleCreate = async (opts: { name: string; shellType: any; color: string }) => {
    const id = uuid()
    const cwd = await getHomedir()
    const res = await window.termpolis.createTerminal(id, opts.shellType, cwd)
    if (!res.success) return alert(`Failed to open terminal: ${res.error}`)
    addTerminal({ id, name: opts.name, color: opts.color, shellType: opts.shellType, cwd })
    setShowAddModal(false)
  }

  const handleClose = (id: string) => {
    window.termpolis.killTerminal(id)
    removeTerminal(id)
  }

  return (
    <aside className="w-52 shrink-0 flex flex-col bg-[#252526] border-r border-[#3c3c3c] h-full">
      {/* Top fixed buttons */}
      <div className="flex flex-col gap-1 p-2 border-b border-[#3c3c3c]">
        <button
          onClick={() => setShowSettings(!showSettings)}
          className={`flex items-center gap-2 px-3 py-2 rounded text-sm hover:bg-[#37373d] ${showSettings ? 'bg-[#37373d]' : ''}`}
        >
          ⚙ Settings
        </button>
        <button
          onClick={toggleViewMode}
          className="flex items-center gap-2 px-3 py-2 rounded text-sm hover:bg-[#37373d]"
        >
          {viewMode === 'tabs' ? '⊞ Grid View' : '☰ Tab View'}
        </button>
      </div>

      {/* Workspaces */}
      <WorkspaceList />

      {/* Scrollable terminal tab list */}
      <div className="flex-1 overflow-y-auto">
        {terminals.map(t => (
          <TerminalTab
            key={t.id}
            terminal={t}
            isActive={t.id === activeTerminalId && !showSettings}
            onClick={() => setActiveTerminal(t.id)}
            onClose={() => handleClose(t.id)}
            onUpdate={patch => updateTerminal(t.id, patch)}
          />
        ))}
      </div>

      {/* Bottom fixed buttons */}
      <div className="p-2 border-t border-[#3c3c3c] flex flex-col gap-1">
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 px-3 py-2 rounded text-sm hover:bg-[#37373d] text-[#4FC3F7]"
        >
          + Add Terminal
        </button>
      </div>

      {showAddModal && (
        <AddTerminalModal
          shells={availableShells}
          nextIndex={terminals.length + 1}
          defaultShell={defaultShell}
          onCreate={handleCreate}
          onCancel={() => setShowAddModal(false)}
        />
      )}
    </aside>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/Sidebar/Sidebar.tsx src/components/Sidebar/TerminalTab.tsx
git commit -m "feat: implement Sidebar and TerminalTab with add, close, rename, recolor"
```

---

## Task 17: WorkspaceList Component

**Files:**
- Create: `src/components/Sidebar/WorkspaceList.tsx`
- Create: `tests/components/WorkspaceList.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `tests/components/WorkspaceList.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { WorkspaceList } from '../../src/components/Sidebar/WorkspaceList'
import { useTerminalStore } from '../../src/store/terminalStore'
import { vi } from 'vitest'

vi.mock('../../src/store/terminalStore')

describe('WorkspaceList', () => {
  it('renders workspace names', () => {
    vi.mocked(useTerminalStore).mockReturnValue({
      workspaces: [{ id: 'w1', name: 'Frontend', terminals: [] }],
      addWorkspace: vi.fn(),
      removeWorkspace: vi.fn(),
      terminals: [],
    } as any)
    render(<WorkspaceList />)
    expect(screen.getByText('Frontend')).toBeInTheDocument()
  })

  it('calls addWorkspace when save is confirmed', () => {
    const addWorkspace = vi.fn()
    vi.mocked(useTerminalStore).mockReturnValue({
      workspaces: [],
      addWorkspace,
      removeWorkspace: vi.fn(),
      terminals: [{ id: 't1', name: 'T1', color: '#fff', shellType: 'bash', cwd: '/' }],
    } as any)
    render(<WorkspaceList />)
    fireEvent.click(screen.getByText('+ Save Workspace'))
    const input = screen.getByPlaceholderText(/workspace name/i)
    fireEvent.change(input, { target: { value: 'My WS' } })
    fireEvent.click(screen.getByText('Save'))
    expect(addWorkspace).toHaveBeenCalledWith('My WS')
  })
})
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npx vitest run tests/components/WorkspaceList.test.tsx
```

- [ ] **Step 3: Implement `src/components/Sidebar/WorkspaceList.tsx`**

```tsx
import React, { useState } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import { getHomedir } from '../../lib/homedir'
import { v4 as uuid } from 'uuid'

export function WorkspaceList() {
  const { workspaces, addWorkspace, removeWorkspace, terminals } = useTerminalStore()
  const [saving, setSaving] = useState(false)
  const [wsName, setWsName] = useState('')

  const handleActivate = async (wsId: string) => {
    const ws = workspaces.find(w => w.id === wsId)
    if (!ws) return
    const cwd = await getHomedir()
    for (const t of ws.terminals) {
      const id = uuid()
      await window.termpolis.createTerminal(id, t.shellType as any, cwd)
      useTerminalStore.getState().addTerminal({ id, name: t.name, color: t.color, shellType: t.shellType as any, cwd })
    }
  }

  if (workspaces.length === 0 && !saving) {
    return (
      <div className="p-2 border-b border-[#3c3c3c]">
        <button
          onClick={() => { setSaving(true); setWsName('') }}
          className="w-full text-left text-xs text-[#6b7280] hover:text-[#d4d4d4] px-1 py-1"
          disabled={terminals.length === 0}
        >
          + Save Workspace
        </button>
      </div>
    )
  }

  return (
    <div className="border-b border-[#3c3c3c]">
      <div className="px-3 py-1 text-xs text-[#6b7280] uppercase tracking-wider">Workspaces</div>

      {workspaces.map(ws => (
        <div
          key={ws.id}
          className="flex items-center gap-1 px-3 py-1 hover:bg-[#2a2d2e] group cursor-pointer"
          onClick={() => handleActivate(ws.id)}
        >
          <span className="flex-1 text-xs truncate">{ws.name}</span>
          <button
            onClick={e => { e.stopPropagation(); removeWorkspace(ws.id) }}
            className="opacity-0 group-hover:opacity-100 text-[#6b7280] hover:text-white text-xs"
            aria-label={`Delete ${ws.name}`}
          >
            ✕
          </button>
        </div>
      ))}

      {saving ? (
        <div className="px-2 py-2 flex flex-col gap-1">
          <input
            autoFocus
            placeholder="Workspace name"
            value={wsName}
            onChange={e => setWsName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { addWorkspace(wsName.trim() || 'Workspace'); setSaving(false) } if (e.key === 'Escape') setSaving(false) }}
            className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-xs focus:outline-none"
          />
          <div className="flex gap-1">
            <button onClick={() => setSaving(false)} className="text-xs px-2 py-0.5 rounded hover:bg-[#3c3c3c]">Cancel</button>
            <button onClick={() => { addWorkspace(wsName.trim() || 'Workspace'); setSaving(false) }} className="text-xs px-2 py-0.5 rounded bg-[#0078d4] text-white">Save</button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => { setSaving(true); setWsName('') }}
          className="w-full text-left text-xs text-[#6b7280] hover:text-[#d4d4d4] px-3 py-1"
          disabled={terminals.length === 0}
        >
          + Save Workspace
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npx vitest run tests/components/WorkspaceList.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar/WorkspaceList.tsx tests/components/WorkspaceList.test.tsx
git commit -m "feat: implement WorkspaceList with save, activate, and delete"
```

---

## Task 18: SettingsPane Component

**Files:**
- Create: `src/components/SettingsPane/SettingsPane.tsx`

- [ ] **Step 1: Implement `src/components/SettingsPane/SettingsPane.tsx`**

```tsx
import React, { useState, useEffect } from 'react'
import Editor from '@monaco-editor/react'
import { useTerminalStore } from '../../store/terminalStore'
import type { ShellInfo, ShellType } from '../../types'

// Config file paths are resolved via IPC (homedir/join not available in renderer)
const CONFIG_FILE_NAMES = ['.bashrc', '.bash_profile', '.zshrc']

export function SettingsPane() {
  const { defaultShell, setDefaultShell } = useTerminalStore()
  const [shells, setShells] = useState<ShellInfo[]>([])
  const [configFiles, setConfigFiles] = useState<{ label: string; path: string }[]>([])
  const [activeFile, setActiveFile] = useState('')
  const [fileContents, setFileContents] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [saved, setSaved] = useState<Record<string, boolean>>({})

  useEffect(() => {
    window.termpolis.getAvailableShells().then(res => {
      if (res.success && res.data) setShells(res.data)
    })
    // Resolve homedir via IPC — Node.js APIs not available in renderer
    window.termpolis.getHomedir().then(res => {
      if (!res.success || !res.data) return
      const home = res.data
      // Detect path separator: Windows paths start with a drive letter (e.g. C:\)
      const sep = /^[A-Za-z]:\\/.test(home) ? '\\' : '/'
      const files = CONFIG_FILE_NAMES.map(name => ({ label: name, path: `${home}${sep}${name}` }))
      setConfigFiles(files)
      setActiveFile(files[0].path)
      files.forEach(f => {
        window.termpolis.readConfigFile(f.path).then(r => {
          setFileContents(prev => ({ ...prev, [f.path]: r.data ?? '' }))
        })
      })
    })
  }, [])

  const handleSave = async (filePath: string) => {
    setSaving(prev => ({ ...prev, [filePath]: true }))
    await window.termpolis.writeConfigFile(filePath, fileContents[filePath] ?? '')
    setSaving(prev => ({ ...prev, [filePath]: false }))
    setSaved(prev => ({ ...prev, [filePath]: true }))
    setTimeout(() => setSaved(prev => ({ ...prev, [filePath]: false })), 2000)
  }

  return (
    <div className="flex flex-col h-full p-6 gap-6 overflow-y-auto">
      <h1 className="text-lg font-semibold">Settings</h1>

      {/* Default shell */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Default Shell</label>
        <select
          value={defaultShell}
          onChange={e => setDefaultShell(e.target.value as ShellType)}
          className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm w-48 focus:outline-none"
        >
          {shells.map(s => <option key={s.type} value={s.type}>{s.label}</option>)}
        </select>
      </div>

      {/* Config file tabs */}
      <div className="flex flex-col gap-2 flex-1 min-h-0">
        <div className="flex gap-1 border-b border-[#3c3c3c] pb-1">
          {configFiles.map(f => (
            <button
              key={f.path}
              onClick={() => setActiveFile(f.path)}
              className={`text-sm px-3 py-1 rounded-t ${activeFile === f.path ? 'bg-[#1e1e1e] text-white' : 'text-[#6b7280] hover:text-white'}`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex-1 min-h-0 border border-[#3c3c3c] rounded overflow-hidden">
          <Editor
            height="100%"
            language="shell"
            theme="vs-dark"
            value={fileContents[activeFile] ?? ''}
            onChange={val => setFileContents(prev => ({ ...prev, [activeFile]: val ?? '' }))}
            options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false }}
          />
        </div>

        <div className="flex justify-end">
          <button
            onClick={() => handleSave(activeFile)}
            disabled={saving[activeFile]}
            className="px-4 py-1.5 text-sm rounded bg-[#0078d4] hover:bg-[#106ebe] text-white disabled:opacity-50"
          >
            {saved[activeFile] ? '✓ Saved' : saving[activeFile] ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/SettingsPane/SettingsPane.tsx
git commit -m "feat: implement SettingsPane with Monaco editor and default shell picker"
```

---

## Task 19: HistorySearchModal Component

**Files:**
- Create: `src/components/HistorySearch/HistorySearchModal.tsx`
- Create: `tests/components/HistorySearchModal.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `tests/components/HistorySearchModal.test.tsx`:
```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { HistorySearchModal } from '../../src/components/HistorySearch/HistorySearchModal'
import { vi } from 'vitest'

const mockResults = [
  { terminalId: 't1', terminalName: 'Terminal 1', command: 'git status', timestamp: Date.now() },
]

describe('HistorySearchModal', () => {
  beforeEach(() => {
    window.termpolis = {
      searchHistory: vi.fn().mockResolvedValue({ success: true, data: mockResults }),
    } as any
  })

  it('shows search results matching query', async () => {
    render(<HistorySearchModal onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'git' } })
    await waitFor(() => expect(screen.getByText('git status')).toBeInTheDocument())
  })

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn()
    render(<HistorySearchModal onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npx vitest run tests/components/HistorySearchModal.test.tsx
```

- [ ] **Step 3: Implement `src/components/HistorySearch/HistorySearchModal.tsx`**

```tsx
import React, { useState, useEffect, useCallback } from 'react'
import type { HistoryEntry } from '../../types'

interface Props {
  onClose: () => void
}

export function HistorySearchModal({ onClose }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<HistoryEntry[]>([])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    const timer = setTimeout(async () => {
      const res = await window.termpolis.searchHistory(query)
      if (res.success && res.data) setResults(res.data)
    }, 150)
    return () => clearTimeout(timer)
  }, [query])

  const handleSelect = (entry: HistoryEntry) => {
    navigator.clipboard.writeText(entry.command)
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-start justify-center pt-24 z-50">
      <div className="bg-[#252526] rounded-lg shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden">
        <div className="p-3 border-b border-[#3c3c3c]">
          <input
            autoFocus
            placeholder="Search command history…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#0078d4]"
          />
        </div>
        <div className="overflow-y-auto max-h-80">
          {results.length === 0 && query && (
            <p className="text-center text-sm text-[#6b7280] py-6">No results for "{query}"</p>
          )}
          {results.map((r, i) => (
            <button
              key={i}
              onClick={() => handleSelect(r)}
              className="w-full text-left flex items-center gap-3 px-4 py-2 hover:bg-[#37373d] border-b border-[#2d2d2d]"
            >
              <code className="flex-1 text-sm font-mono text-[#d4d4d4] truncate">{r.command}</code>
              <span className="text-xs text-[#6b7280] shrink-0">{r.terminalName}</span>
              <span className="text-xs text-[#4b5563] shrink-0">
                {new Date(r.timestamp).toLocaleTimeString()}
              </span>
            </button>
          ))}
        </div>
        <div className="px-4 py-2 text-xs text-[#6b7280] border-t border-[#3c3c3c]">
          Click a result to copy to clipboard • Esc to close
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npx vitest run tests/components/HistorySearchModal.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add src/components/HistorySearch/HistorySearchModal.tsx tests/components/HistorySearchModal.test.tsx
git commit -m "feat: implement HistorySearchModal with debounced search and clipboard copy"
```

---

## Task 20: Run All Tests

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run
```

Expected: All tests pass. Zero failures.

- [ ] **Step 2: Fix any failures**

If tests fail, diagnose and fix before proceeding. Do not skip.

- [ ] **Step 3: Commit if any fixes made**

```bash
git add -A
git commit -m "fix: resolve test failures before integration"
```

---

## Task 21: Full App Integration Verification

- [ ] **Step 1: Launch the app in dev mode**

```bash
npm run dev
```

- [ ] **Step 2: Verify each feature manually**

Walk through this checklist:

- [ ] App launches with dark theme, sidebar visible
- [ ] Click `+ Add Terminal` → modal opens with name, shell dropdown, color swatches
- [ ] Create a terminal → it appears in sidebar and in the main area, shell prompt shows
- [ ] Type commands → they execute in the terminal
- [ ] Create a second terminal → both appear in sidebar; clicking switches between them
- [ ] Right-click a tab → popover opens with rename + recolor; save works
- [ ] Click `Grid View` → both terminals show in grid; button changes to "Tab View"
- [ ] Click `Tab View` → returns to tab view
- [ ] X on tab → terminal closes and is removed from sidebar
- [ ] X on grid cell → terminal closes
- [ ] Click Settings → Monaco editors load for .bashrc / .bash_profile / .zshrc
- [ ] Change default shell, verify it pre-selects when opening new terminal
- [ ] Type several commands → press `Ctrl+Shift+H` → history modal opens
- [ ] Search for a command → results appear → click to copy to clipboard
- [ ] Save a workspace → it appears in sidebar; click it → terminals spawn
- [ ] Close app and reopen → terminal tabs are restored

- [ ] **Step 3: Fix any integration bugs found**

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: complete Termpolis v1 integration"
```

---

## Task 22: Packaging

**Files:**
- Create: `assets/icon.png` (placeholder — replace with real icon)

- [ ] **Step 1: Add placeholder icon**

Create a simple 512×512 PNG icon and save as `assets/icon.png`. For dev purposes, a solid color square works. For production, use a real icon.

- [ ] **Step 2: Build the app**

```bash
npm run build
```

Expected: `dist/` and `dist-electron/` folders are created without errors.

- [ ] **Step 3: Package for current platform**

```bash
npm run package
```

Expected: `dist-electron-builder/` contains the installer for the current OS (`.exe` on Windows, `.dmg` on macOS, `.AppImage` on Linux).

- [ ] **Step 4: Test the packaged app**

Install/run the packaged binary and verify it works identically to dev mode.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: add packaging config and assets for cross-platform distribution"
```

---

## Summary

| Task | What it builds |
|---|---|
| 1 | Project scaffold (electron-vite, React, TypeScript, Tailwind, Vitest) |
| 2 | Shared TypeScript types |
| 3 | ShellDetector — OS-aware shell detection |
| 4 | SessionStore — persist/restore terminal list |
| 5 | HistoryStore — per-terminal history with search |
| 6 | ConfigFileManager — read/write shell config files |
| 7 | TerminalManager — node-pty process lifecycle |
| 8 | Main process + IPC bridge (preload) |
| 9 | Zustand store — all UI state |
| 10 | App layout — Sidebar + MainArea |
| 11 | TerminalPane — xterm.js + IPC + resize + history capture |
| 12 | TabView — CSS show/hide terminal instances |
| 13 | GridView — auto CSS Grid by count |
| 14 | AddTerminalModal — name + shell + color |
| 15 | TabPopover — rename + recolor |
| 16 | Sidebar + TerminalTab — full sidebar UI |
| 17 | WorkspaceList — save/activate/delete workspaces |
| 18 | SettingsPane — Monaco editors + default shell |
| 19 | HistorySearchModal — Ctrl+Shift+H search |
| 20 | Run all tests |
| 21 | Full integration verification |
| 22 | Cross-platform packaging |
