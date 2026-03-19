# Termpolis Feature Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add font size selection, terminal themes, auto-completion, command auto-fix, grid performance optimization, Unicode support, output export, and bundled CLI tools to Termpolis.

**Architecture:** Features are implemented bottom-up: data model + types first, then UI components, then the complex engines (autocomplete, correction). Each task produces a working, testable increment. The TerminalPane is the integration point for most features — it gains theme, font, Unicode addon, WebGL, output throttling, autocomplete overlay, and correction banner.

**Tech Stack:** Electron 30, React 18, TypeScript, xterm.js 5.3, Zustand, Tailwind, Vitest, node-pty

**Spec:** `docs/superpowers/specs/2026-03-19-termpolis-features-design.md`

---

## File Structure

### New files to create:
| File | Purpose |
|------|---------|
| `src/renderer/src/themes/terminalThemes.ts` | 7 curated xterm ITheme definitions |
| `src/renderer/src/components/CompletionDropdown/CompletionDropdown.tsx` | Autocomplete overlay UI |
| `src/renderer/src/completions/completionEngine.ts` | Orchestrates spec, shell, history sources |
| `src/renderer/src/completions/inputParser.ts` | Parses terminal input line into tokens |
| `src/renderer/src/completions/specLoader.ts` | Lazy-loads command completion specs |
| `src/renderer/src/completions/specs/` | Directory of JSON completion spec files |
| `src/renderer/src/components/CommandFix/CommandFixBanner.tsx` | Inline correction suggestion banner |
| `src/renderer/src/corrections/correctionEngine.ts` | Matches failed commands against rules |
| `src/renderer/src/corrections/rules/commandNotFound.ts` | Levenshtein match rule |
| `src/renderer/src/corrections/rules/extractSuggestion.ts` | Parse "Did you mean" from stderr |
| `src/renderer/src/corrections/rules/permissionDenied.ts` | Prepend sudo rule |
| `src/renderer/src/corrections/rules/index.ts` | Re-exports all rules |
| `src/renderer/src/lib/exportTerminal.ts` | Extract xterm buffer + strip ANSI |
| `src/renderer/src/lib/outputThrottle.ts` | rAF-based write batching for xterm |
| `src/renderer/src/assets/fonts/` | JetBrains Mono + Nerd Font files |
| `src/main/completionService.ts` | PATH scanning, file listing, env vars for IPC |
| `scripts/convert-fig-specs.ts` | Build-time converter for Fig autocomplete specs |
| `scripts/download-tools.sh` | Download jq/yq/curl binaries per platform |
| `resources/tools/` | Bundled CLI tool binaries (per platform) |
| `tests/renderer/terminalThemes.test.ts` | Theme validation tests |
| `tests/renderer/inputParser.test.ts` | Input tokenization tests |
| `tests/renderer/correctionRules.test.ts` | Correction rule unit tests |
| `tests/renderer/exportTerminal.test.ts` | ANSI stripping tests |
| `tests/electron/completionService.test.ts` | PATH scanning tests |
| `tests/electron/sessionMigration.test.ts` | Session migration tests |
| `tests/renderer/completionEngine.test.ts` | Completion engine unit tests |
| `tests/renderer/completionDropdown.test.tsx` | Dropdown UI render/interaction tests |
| `tests/renderer/correctionEngine.test.ts` | Correction engine unit tests |
| `tests/renderer/outputThrottle.test.ts` | Output throttle utility tests |

### Existing files to modify:
| File | Changes |
|------|---------|
| `src/renderer/src/types/index.ts` | Add `fontSize`, `theme`, `fontFamily` to `TerminalSession`; new IPC methods to `TermpolisAPI` |
| `src/main/types.ts` | Mirror `TerminalSession` changes (independent copy of types used by main process) |
| `src/renderer/src/store/terminalStore.ts` | Widen `updateTerminal` type; update workspace snapshot destructuring |
| `src/renderer/src/components/Sidebar/AddTerminalModal.tsx` | Add font size stepper, theme picker, font selector, preview |
| `src/renderer/src/components/Sidebar/Sidebar.tsx` | Pass new fields through `handleCreate` |
| `src/renderer/src/components/TabPopover/TabPopover.tsx` | Add theme, font size, font family editing |
| `src/renderer/src/components/TerminalPane/TerminalPane.tsx` | Accept new props; load WebGL, Unicode, fit addons; wire throttling, autocomplete, correction |
| `src/renderer/src/components/GridView/GridView.tsx` | Pass new props to TerminalPane; add IntersectionObserver; add export button to header |
| `src/renderer/src/components/TabView/TabView.tsx` | Pass new props to TerminalPane |
| `src/renderer/src/App.tsx` | Session migration defaults on load |
| `src/main/index.ts` | New IPC handlers for completion, export, bundled tools PATH |
| `src/main/terminalManager.ts` | Add bundled tools to PTY env PATH |
| `src/main/sessionStore.ts` | Add defaults for new fields in loadSession |
| `src/preload/index.ts` | Expose new IPC methods |
| `package.json` | Add `@xterm/addon-webgl`, `@xterm/addon-unicode11` deps |
| `electron-builder.config.ts` | Add `extraResources` for bundled tools |
| `tests/components/AddTerminalModal.test.tsx` | Update for new fields |
| `tests/electron/sessionStore.test.ts` | Add migration tests |

---

### Task 1: Data Model + Type Updates + Session Migration

**Files:**
- Modify: `src/renderer/src/types/index.ts`
- Modify: `src/main/types.ts` (independent copy — must be updated in lockstep)
- Modify: `src/renderer/src/store/terminalStore.ts`
- Modify: `src/main/sessionStore.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/components/Sidebar/Sidebar.tsx`
- Modify: `src/renderer/src/components/Sidebar/TerminalTab.tsx` (widen `onUpdate` type)
- Create: `tests/electron/sessionMigration.test.ts`
- Modify: `tests/electron/sessionStore.test.ts`

- [ ] **Step 1: Write failing test for session migration**

Create `tests/electron/sessionMigration.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'fs'

vi.mock('fs')
vi.mock('electron', () => ({ app: { getPath: () => '/fake/userData' } }))

const { loadSession } = await import('../../src/main/sessionStore')

describe('session migration', () => {
  beforeEach(() => vi.clearAllMocks())

  it('applies default fontSize, theme, fontFamily to old sessions missing those fields', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const oldSession = {
      terminals: [{ id: '1', name: 'T1', color: '#fff', shellType: 'bash', cwd: '/home' }],
      workspaces: [],
      defaultShell: 'bash',
      viewMode: 'tabs',
    }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(oldSession) as any)
    const result = loadSession()
    expect(result.terminals[0]).toMatchObject({
      fontSize: 14,
      theme: 'dark',
      fontFamily: 'Consolas, "Courier New", monospace',
    })
  })

  it('preserves existing fontSize, theme, fontFamily when present', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const session = {
      terminals: [{ id: '1', name: 'T1', color: '#fff', shellType: 'bash', cwd: '/home', fontSize: 18, theme: 'nord', fontFamily: 'JetBrains Mono' }],
      workspaces: [],
      defaultShell: 'bash',
      viewMode: 'tabs',
    }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(session) as any)
    const result = loadSession()
    expect(result.terminals[0].fontSize).toBe(18)
    expect(result.terminals[0].theme).toBe('nord')
    expect(result.terminals[0].fontFamily).toBe('JetBrains Mono')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/electron/sessionMigration.test.ts`
Expected: FAIL — `fontSize`, `theme`, `fontFamily` not present on loaded terminals

- [ ] **Step 3: Update TerminalSession type and TermpolisAPI**

In `src/renderer/src/types/index.ts`, update `TerminalSession`:

```typescript
export interface TerminalSession {
  id: string
  name: string
  color: string
  shellType: ShellType
  cwd: string
  fontSize: number
  theme: string
  fontFamily: string
}
```

**Also update `src/main/types.ts`** — this is an independent copy of the same types used by the main process. Add the same three fields (`fontSize`, `theme`, `fontFamily`) to its `TerminalSession` interface.

Add new methods to `TermpolisAPI`:

```typescript
completionPathEntries: (dirPath: string) => Promise<IpcResponse<{ name: string; isDir: boolean }[]>>
completionPathCommands: () => Promise<IpcResponse<string[]>>
completionEnvVars: () => Promise<IpcResponse<Record<string, string>>>
exportTerminal: (opts: { content: string; defaultFilename: string }) => Promise<IpcResponse<{ filePath: string }>>
```

- [ ] **Step 4: Update Zustand store**

In `src/renderer/src/store/terminalStore.ts`:

Change `updateTerminal` type from:
```typescript
updateTerminal: (id: string, patch: Partial<Pick<TerminalSession, 'name' | 'color'>>) => void
```
to:
```typescript
updateTerminal: (id: string, patch: Partial<Omit<TerminalSession, 'id'>>) => void
```

Update `addWorkspace` terminal mapping (line 67) from:
```typescript
terminals: s.terminals.map(({ name, color, shellType }) => ({ name, color, shellType })),
```
to:
```typescript
terminals: s.terminals.map(({ name, color, shellType, fontSize, theme, fontFamily }) => ({ name, color, shellType, fontSize, theme, fontFamily })),
```

Apply same change to `updateWorkspace` (line 77).

- [ ] **Step 5: Update sessionStore to apply migration defaults**

In `src/main/sessionStore.ts`, update `loadSession`:

```typescript
const TERMINAL_DEFAULTS = {
  fontSize: 14,
  theme: 'dark',
  fontFamily: 'Consolas, "Courier New", monospace',
}

export function loadSession(): SessionData {
  const path = getSessionPath()
  if (!existsSync(path)) return { ...DEFAULT_SESSION }
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = { ...DEFAULT_SESSION, ...JSON.parse(raw) }
    // Migrate terminals missing new fields
    parsed.terminals = parsed.terminals.map((t: any) => ({ ...TERMINAL_DEFAULTS, ...t }))
    // Migrate workspace terminal templates missing new fields
    parsed.workspaces = parsed.workspaces.map((w: any) => ({
      ...w,
      terminals: w.terminals.map((t: any) => ({ ...TERMINAL_DEFAULTS, ...t }))
    }))
    return parsed
  } catch {
    return { ...DEFAULT_SESSION }
  }
}
```

- [ ] **Step 6: Widen TerminalTab.onUpdate prop type**

In `src/renderer/src/components/Sidebar/TerminalTab.tsx`, change the `onUpdate` prop type from:
```typescript
onUpdate: (patch: { name: string; color: string }) => void
```
to:
```typescript
onUpdate: (patch: Partial<Omit<TerminalSession, 'id'>>) => void
```
Import `TerminalSession` from `../../types`.

- [ ] **Step 7: Update Sidebar handleCreate to pass new fields**

In `src/renderer/src/components/Sidebar/Sidebar.tsx`, update `handleCreate`:

```typescript
const handleCreate = async (opts: { name: string; shellType: any; color: string; fontSize: number; theme: string; fontFamily: string }) => {
  const id = uuid()
  const cwd = await getHomedir()
  const res = await window.termpolis.createTerminal(id, opts.shellType, cwd)
  if (!res.success) { alert(`Failed to open terminal: ${res.error}`); return }
  addTerminal({ id, name: opts.name, color: opts.color, shellType: opts.shellType, cwd, fontSize: opts.fontSize, theme: opts.theme, fontFamily: opts.fontFamily })
  setShowAddModal(false)
}
```

- [ ] **Step 8: Update App.tsx session restore to apply defaults**

In `src/renderer/src/App.tsx`, in the session restore effect, add defaults:

```typescript
const TERMINAL_DEFAULTS = { fontSize: 14, theme: 'dark', fontFamily: 'Consolas, "Courier New", monospace' }
// Inside the loadSession callback:
const migrated = saved.map(t => ({ ...TERMINAL_DEFAULTS, ...t }))
```

Use `migrated` instead of `saved` when setting state and creating terminals.

- [ ] **Step 9: Add workspace migration test**

Add to `tests/electron/sessionMigration.test.ts`:

```typescript
it('applies defaults to workspace terminal templates missing new fields', () => {
  vi.mocked(existsSync).mockReturnValue(true)
  const oldSession = {
    terminals: [],
    workspaces: [{ id: 'w1', name: 'Dev', terminals: [{ name: 'T1', color: '#fff', shellType: 'bash' }] }],
    defaultShell: 'bash',
    viewMode: 'tabs',
  }
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify(oldSession) as any)
  const result = loadSession()
  expect(result.workspaces[0].terminals[0]).toMatchObject({
    fontSize: 14,
    theme: 'dark',
    fontFamily: 'Consolas, "Courier New", monospace',
  })
})
```

- [ ] **Step 10: Run all tests**

Run: `npm test`
Expected: sessionMigration tests PASS, existing tests may need updates for new required fields

- [ ] **Step 11: Fix any broken existing tests**

Update `tests/components/AddTerminalModal.test.tsx` and `tests/electron/sessionStore.test.ts` to include `fontSize`, `theme`, `fontFamily` where terminals are constructed.

- [ ] **Step 12: Run tests again, verify all pass**

Run: `npm test`
Expected: All PASS

- [ ] **Step 13: Commit**

```bash
git add src/renderer/src/types/index.ts src/main/types.ts \
  src/renderer/src/store/terminalStore.ts \
  src/main/sessionStore.ts src/renderer/src/App.tsx \
  src/renderer/src/components/Sidebar/Sidebar.tsx \
  src/renderer/src/components/Sidebar/TerminalTab.tsx \
  tests/electron/sessionMigration.test.ts tests/electron/sessionStore.test.ts \
  tests/components/AddTerminalModal.test.tsx
git commit -m "feat: add fontSize, theme, fontFamily to TerminalSession with migration"
```

---

### Task 2: Terminal Themes Definitions

**Files:**
- Create: `src/renderer/src/themes/terminalThemes.ts`
- Create: `tests/renderer/terminalThemes.test.ts`

- [ ] **Step 1: Write failing test for theme definitions**

Create `tests/renderer/terminalThemes.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { TERMINAL_THEMES, getTheme, THEME_IDS } from '../../src/renderer/src/themes/terminalThemes'

describe('terminalThemes', () => {
  it('exports exactly 7 themes', () => {
    expect(THEME_IDS).toHaveLength(7)
  })

  it('every theme has required ITheme fields', () => {
    const requiredColors = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']

    for (const id of THEME_IDS) {
      const theme = getTheme(id)
      expect(theme.background).toBeTruthy()
      expect(theme.foreground).toBeTruthy()
      expect(theme.cursor).toBeTruthy()
      expect(theme.selectionBackground).toBeTruthy()
      for (const color of requiredColors) {
        expect(theme[color], `${id} missing ${color}`).toBeTruthy()
      }
    }
  })

  it('getTheme returns dark theme for unknown id', () => {
    const theme = getTheme('nonexistent')
    expect(theme.background).toBe('#1e1e1e')
  })

  it('each theme has a display name', () => {
    for (const id of THEME_IDS) {
      const meta = TERMINAL_THEMES[id]
      expect(meta.name).toBeTruthy()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/renderer/terminalThemes.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create theme definitions**

Create `src/renderer/src/themes/terminalThemes.ts` with all 7 themes (Dark, Light, Solarized Dark, Solarized Light, Monokai, Dracula, Nord). Each has: `name`, `theme` (full ITheme with 16 ANSI colors + background, foreground, cursor, selectionBackground).

Source palettes from canonical definitions:
- Dark: VS Code default dark
- Light: VS Code default light
- Solarized: ethanschoonover.com/solarized
- Monokai: Sublime Text Monokai
- Dracula: draculatheme.com
- Nord: nordtheme.com

Export `TERMINAL_THEMES` (Record), `THEME_IDS` (string array), `getTheme(id)` helper.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/renderer/terminalThemes.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/themes/terminalThemes.ts tests/renderer/terminalThemes.test.ts
git commit -m "feat: add 7 curated terminal theme definitions"
```

---

### Task 3: Add Terminal Modal Redesign

**Files:**
- Modify: `src/renderer/src/components/Sidebar/AddTerminalModal.tsx`
- Modify: `tests/components/AddTerminalModal.test.tsx`

- [ ] **Step 1: Write failing tests for new modal fields**

Add to `tests/components/AddTerminalModal.test.tsx`:

```typescript
it('renders font size stepper defaulting to 14', () => {
  render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={vi.fn()} onCancel={vi.fn()} />)
  expect(screen.getByDisplayValue('14')).toBeInTheDocument()
})

it('renders theme pills', () => {
  render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={vi.fn()} onCancel={vi.fn()} />)
  expect(screen.getByText('Dark')).toBeInTheDocument()
  expect(screen.getByText('Light')).toBeInTheDocument()
  expect(screen.getByText('Nord')).toBeInTheDocument()
})

it('renders font family selector', () => {
  render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={vi.fn()} onCancel={vi.fn()} />)
  expect(screen.getByDisplayValue('Consolas')).toBeInTheDocument()
})

it('calls onCreate with all fields including fontSize, theme, fontFamily', () => {
  const onCreate = vi.fn()
  render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={onCreate} onCancel={vi.fn()} />)
  fireEvent.click(screen.getByText('Create'))
  expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
    name: 'Terminal 1',
    shellType: 'bash',
    color: expect.any(String),
    fontSize: 14,
    theme: 'dark',
    fontFamily: expect.any(String),
  }))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/components/AddTerminalModal.test.tsx`
Expected: FAIL — font size input, theme pills, font selector not found

- [ ] **Step 3: Implement the redesigned modal**

Update `AddTerminalModal.tsx`:
- Add state: `fontSize` (default 14), `theme` (default 'dark'), `fontFamily` (default 'Consolas, "Courier New", monospace')
- Add font size stepper: minus button, number input (8-32 range), plus button — placed inline with shell selector
- Add theme picker: pill buttons for each theme from `TERMINAL_THEMES`, styled with actual bg/fg colors, selected state with blue border
- Add font family dropdown: Consolas, JetBrains Mono, JetBrains Mono Nerd Font
- Add theme preview div: 3 lines of sample terminal text styled with selected theme colors, font size, and font family
- Update `onCreate` call to include `fontSize`, `theme`, `fontFamily`
- Update `Props.onCreate` type to include new fields

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/components/AddTerminalModal.test.tsx`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/Sidebar/AddTerminalModal.tsx tests/components/AddTerminalModal.test.tsx
git commit -m "feat: redesign Add Terminal modal with font size, theme, font selector"
```

---

### Task 4: TabPopover Updates (Edit After Creation)

**Files:**
- Modify: `src/renderer/src/components/TabPopover/TabPopover.tsx`
- Modify: `src/renderer/src/components/Sidebar/TerminalTab.tsx`
- Modify: `tests/components/TabPopover.test.tsx`

- [ ] **Step 1: Write failing test for new TabPopover fields**

Add to `tests/components/TabPopover.test.tsx` tests that check for font size, theme, and font family editing controls.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/components/TabPopover.test.tsx`

- [ ] **Step 3: Update TabPopover to include theme, fontSize, fontFamily**

Add props: `fontSize`, `theme`, `fontFamily` to `Props` interface.
Add state and controls matching the modal: font size stepper, theme pills, font dropdown.
Update `onSave` to include new fields.

- [ ] **Step 4: Update TerminalTab to pass new props to TabPopover**

The `TerminalTab` component renders the `TabPopover`. Update it to pass the terminal's `fontSize`, `theme`, `fontFamily` and update its `onUpdate` handler.

- [ ] **Step 5: Run tests, verify pass**

Run: `npm test`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/TabPopover/TabPopover.tsx \
  src/renderer/src/components/Sidebar/TerminalTab.tsx \
  tests/components/TabPopover.test.tsx
git commit -m "feat: add theme, font size, font family editing to TabPopover"
```

---

### Task 5: Install New Dependencies + Bundled Fonts

**Files:**
- Modify: `package.json`
- Create: `src/renderer/src/assets/fonts/` (font files)

- [ ] **Step 1: Install xterm addons**

Run: `npm install @xterm/addon-webgl @xterm/addon-unicode11`

- [ ] **Step 2: Download JetBrains Mono and Nerd Font**

Download JetBrains Mono (regular, bold, italic) and JetBrains Mono Nerd Font from their official releases. Place `.woff2` files in `src/renderer/src/assets/fonts/`.

- [ ] **Step 3: Create font-face CSS**

Add `@font-face` declarations in a new file `src/renderer/src/assets/fonts/fonts.css` (or in the main CSS file) for JetBrains Mono and JetBrains Mono Nerd Font.

- [ ] **Step 4: Import fonts CSS in main.tsx**

Add `import './assets/fonts/fonts.css'` to `src/renderer/src/main.tsx`.

- [ ] **Step 5: Verify app still builds**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json \
  src/renderer/src/assets/fonts/ \
  src/renderer/src/main.tsx
git commit -m "feat: add xterm WebGL/Unicode addons and bundled JetBrains Mono fonts"
```

---

### Task 6: TerminalPane — Theme, Font, WebGL, Unicode Integration

**Files:**
- Modify: `src/renderer/src/components/TerminalPane/TerminalPane.tsx`
- Modify: `src/renderer/src/components/TabView/TabView.tsx`
- Modify: `src/renderer/src/components/GridView/GridView.tsx`

- [ ] **Step 1: Update TerminalPane Props to accept new fields**

```typescript
interface Props {
  terminalId: string
  terminalName: string
  isVisible: boolean
  fontSize: number
  theme: string
  fontFamily: string
}
```

- [ ] **Step 2: Integrate theme, font, WebGL, Unicode in TerminalPane**

In the `useEffect` that creates the Terminal:
- Import `getTheme` from `../../themes/terminalThemes`
- Import `WebglAddon` from `@xterm/addon-webgl`
- Import `Unicode11Addon` from `@xterm/addon-unicode11`
- Use props: `new Terminal({ theme: getTheme(theme), fontFamily, fontSize, cursorBlink: true, scrollback: 10000 })`
- **Critical: change initialization order.** Current code calls `term.open()` then `fitAddon.fit()`. New order must be:
  1. Create Terminal instance
  2. Load WebGL addon (try/catch, fallback to canvas)
  3. Load Unicode11 addon, activate: `term.unicode.activeVersion = '11'`
  4. Load Fit addon
  5. **Then** call `term.open(containerRef.current)` — must come after addons are loaded
  6. Call `fitAddon.fit()`
- This is a **breaking change** to the existing initialization sequence in TerminalPane

- [ ] **Step 3: Add effect to update theme/font/fontSize dynamically**

Add a `useEffect` depending on `[fontSize, theme, fontFamily]` that updates the existing terminal instance:

```typescript
useEffect(() => {
  if (!termRef.current) return
  termRef.current.options.fontSize = fontSize
  termRef.current.options.fontFamily = fontFamily
  termRef.current.options.theme = getTheme(theme)
  fitRef.current?.fit()
  window.termpolis.resizeTerminal(terminalId, termRef.current.cols, termRef.current.rows)
}, [fontSize, theme, fontFamily])
```

- [ ] **Step 4: Update TabView to pass new props**

In `TabView.tsx`, pass `fontSize={t.fontSize}`, `theme={t.theme}`, `fontFamily={t.fontFamily}` to each `TerminalPane`.

- [ ] **Step 5: Update GridView to pass new props**

In `GridView.tsx`, pass `fontSize={t.fontSize}`, `theme={t.theme}`, `fontFamily={t.fontFamily}` to each `TerminalPane`.

- [ ] **Step 6: Run tests and verify app builds**

Run: `npm test && npm run build`
Expected: All pass, build succeeds

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/TerminalPane/TerminalPane.tsx \
  src/renderer/src/components/TabView/TabView.tsx \
  src/renderer/src/components/GridView/GridView.tsx
git commit -m "feat: integrate themes, font selection, WebGL rendering, Unicode support in TerminalPane"
```

---

### Task 7: Grid View Performance — Output Throttling + IntersectionObserver

**Files:**
- Create: `src/renderer/src/lib/outputThrottle.ts`
- Create: `tests/renderer/outputThrottle.test.ts`
- Modify: `src/renderer/src/components/TerminalPane/TerminalPane.tsx`
- Modify: `src/renderer/src/components/GridView/GridView.tsx`

- [ ] **Step 1: Write failing test for output throttle**

Create `tests/renderer/outputThrottle.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createOutputThrottle } from '../../src/renderer/src/lib/outputThrottle'

describe('createOutputThrottle', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 0 })
  })

  it('batches multiple writes into one', () => {
    const writeFn = vi.fn()
    const throttled = createOutputThrottle(writeFn)
    throttled('hello ')
    throttled('world')
    // After rAF fires, should have been called once with concatenated data
    expect(writeFn).toHaveBeenCalledTimes(1)
    expect(writeFn).toHaveBeenCalledWith('hello world')
  })

  it('calls write function at least once per rAF cycle', () => {
    const writeFn = vi.fn()
    const throttled = createOutputThrottle(writeFn)
    throttled('data1')
    expect(writeFn).toHaveBeenCalledTimes(1)
    throttled('data2')
    expect(writeFn).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/renderer/outputThrottle.test.ts`

- [ ] **Step 3: Create output throttle utility**

Create `src/renderer/src/lib/outputThrottle.ts`:

```typescript
export function createOutputThrottle(writeFn: (data: string) => void) {
  let buffer = ''
  let scheduled = false

  return (data: string) => {
    buffer += data
    if (!scheduled) {
      scheduled = true
      requestAnimationFrame(() => {
        writeFn(buffer)
        buffer = ''
        scheduled = false
      })
    }
  }
}
```

- [ ] **Step 2: Integrate throttle in TerminalPane**

In `TerminalPane.tsx`, replace direct `term.write(data)` calls with throttled writer:

```typescript
import { createOutputThrottle } from '../../lib/outputThrottle'
// In useEffect:
const throttledWrite = createOutputThrottle((data) => term.write(data))
const unsub = window.termpolis.onTerminalData((id, data) => {
  if (id === terminalId) throttledWrite(data)
})
```

- [ ] **Step 5: Run throttle tests**

Run: `npm test -- tests/renderer/outputThrottle.test.ts`
Expected: All PASS

- [ ] **Step 6: Add IntersectionObserver support to TerminalPane**

Add optional `onVisibilityChange` prop or handle via a new `isInViewport` state using IntersectionObserver in GridView that passes down to TerminalPane.

- [ ] **Step 7: Run all tests, verify build**

Run: `npm test && npm run build`

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/lib/outputThrottle.ts \
  tests/renderer/outputThrottle.test.ts \
  src/renderer/src/components/TerminalPane/TerminalPane.tsx \
  src/renderer/src/components/GridView/GridView.tsx
git commit -m "feat: add output throttling, scrollback limit, viewport-aware rendering for grid performance"
```

---

### Task 8: Terminal Output Export

**Files:**
- Create: `src/renderer/src/lib/exportTerminal.ts`
- Create: `tests/renderer/exportTerminal.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/components/GridView/GridView.tsx`
- Modify: `src/renderer/src/components/TerminalPane/TerminalPane.tsx`

- [ ] **Step 1: Write failing test for ANSI stripping**

Create `tests/renderer/exportTerminal.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { stripAnsi } from '../../src/renderer/src/lib/exportTerminal'

describe('stripAnsi', () => {
  it('removes color codes', () => {
    expect(stripAnsi('\x1b[31mred text\x1b[0m')).toBe('red text')
  })

  it('removes cursor movement codes', () => {
    expect(stripAnsi('\x1b[2J\x1b[Hhello')).toBe('hello')
  })

  it('preserves plain text', () => {
    expect(stripAnsi('hello world')).toBe('hello world')
  })

  it('removes OSC sequences', () => {
    expect(stripAnsi('\x1b]0;title\x07text')).toBe('text')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/renderer/exportTerminal.test.ts`

- [ ] **Step 3: Implement exportTerminal utility**

Create `src/renderer/src/lib/exportTerminal.ts`:

```typescript
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '')       // CSI sequences (colors, cursor, etc.)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences (title, etc.) with BEL or ST terminator
    .replace(/\x1b[()][0-9A-B]/g, '')                   // Character set selection
    .replace(/\x1b[\x20-\x2f]*[\x40-\x7e]/g, '')       // Other escape sequences
}

export function extractBuffer(terminal: { buffer: { active: { length: number; getLine: (i: number) => { translateToString: (trim?: boolean) => string } | undefined } } }): string {
  const buf = terminal.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)
    if (line) lines.push(line.translateToString(true))
  }
  return stripAnsi(lines.join('\n'))
}

export function generateFilename(terminalName: string): string {
  const date = new Date()
  const ts = date.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const safe = terminalName.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `${safe}_${ts}.txt`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/renderer/exportTerminal.test.ts`

- [ ] **Step 5: Add IPC handler in main process**

In `src/main/index.ts`, add:

```typescript
import { dialog } from 'electron'
import { writeFileSync } from 'fs'

ipcMain.handle('terminal:export', async (_, { content, defaultFilename }) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: defaultFilename,
      filters: [{ name: 'Text Files', extensions: ['txt'] }],
    })
    if (result.canceled || !result.filePath) return ok()
    writeFileSync(result.filePath, content, 'utf-8')
    return ok({ filePath: result.filePath })
  } catch (e: any) { return err(e.message) }
})
```

- [ ] **Step 6: Add export method to preload**

In `src/preload/index.ts`, add:

```typescript
exportTerminal: (opts) =>
  ipcRenderer.invoke('terminal:export', opts),
```

- [ ] **Step 7: Expose terminal ref from TerminalPane for export**

Add a way for parent components to access the xterm Terminal instance for buffer reading. Options:
- Pass a ref callback: `onTerminalReady?: (term: Terminal) => void`
- Or use `useImperativeHandle` with `forwardRef`

Use `onTerminalReady` callback approach for simplicity. Store terminal refs in GridView/TabView.

- [ ] **Step 8: Add export button to GridView terminal header**

In `GridView.tsx`, add a save icon button next to the close button in each terminal card header. On click, call `extractBuffer()` + `generateFilename()` + `window.termpolis.exportTerminal()`.

- [ ] **Step 9: Add context menu export to TerminalPane**

In `TerminalPane.tsx`, add right-click context menu handling:
- Listen for `contextmenu` event on the terminal container
- Show a custom context menu with: "Copy", "Select All", "Export Full Scrollback...", "Export Visible Output..."
- "Export Full Scrollback" extracts entire buffer, "Export Visible Output" extracts only visible viewport rows
- Both call `stripAnsi()` then `window.termpolis.exportTerminal()`

This makes export available in both TabView and GridView since TerminalPane is used in both.

- [ ] **Step 10: Run tests, verify build**

Run: `npm test && npm run build`

- [ ] **Step 11: Commit**

```bash
git add src/renderer/src/lib/exportTerminal.ts tests/renderer/exportTerminal.test.ts \
  src/main/index.ts src/preload/index.ts \
  src/renderer/src/components/TerminalPane/TerminalPane.tsx \
  src/renderer/src/components/GridView/GridView.tsx
git commit -m "feat: add terminal output export to text file with ANSI stripping"
```

---

### Task 9: Completion Service (Main Process IPC)

**Files:**
- Create: `src/main/completionService.ts`
- Create: `tests/electron/completionService.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Write failing tests for completion service**

Create `tests/electron/completionService.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { readdirSync, statSync } from 'fs'

vi.mock('fs')
vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

const { listPathEntries, listPathCommands, listEnvVars } = await import('../../src/main/completionService')

describe('completionService', () => {
  it('listPathEntries returns files and dirs with isDir flag', () => {
    vi.mocked(readdirSync).mockReturnValue(['file.txt', 'subdir'] as any)
    vi.mocked(statSync).mockImplementation((p: any) => ({
      isDirectory: () => String(p).includes('subdir'),
    } as any))
    const result = listPathEntries('/some/path')
    expect(result).toContainEqual({ name: 'file.txt', isDir: false })
    expect(result).toContainEqual({ name: 'subdir', isDir: true })
  })

  it('listEnvVars returns process.env as record', () => {
    const result = listEnvVars()
    expect(typeof result).toBe('object')
    expect(result.PATH ?? result.Path).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/electron/completionService.test.ts`

- [ ] **Step 3: Implement completionService**

Create `src/main/completionService.ts`:

```typescript
import { readdirSync, statSync, accessSync, constants } from 'fs'
import { join } from 'path'

export function listPathEntries(dirPath: string): { name: string; isDir: boolean }[] {
  try {
    return readdirSync(dirPath).map(name => {
      try {
        return { name, isDir: statSync(join(dirPath, name)).isDirectory() }
      } catch {
        return { name, isDir: false }
      }
    })
  } catch {
    return []
  }
}

export function listPathCommands(): string[] {
  const pathDirs = (process.env.PATH || process.env.Path || '').split(process.platform === 'win32' ? ';' : ':')
  const winExts = ['.exe', '.cmd', '.bat', '.ps1', '.com']
  const seen = new Set<string>()
  const commands: string[] = []

  for (const dir of pathDirs) {
    try {
      for (const name of readdirSync(dir)) {
        const lower = name.toLowerCase()
        if (process.platform === 'win32') {
          if (winExts.some(ext => lower.endsWith(ext))) {
            const base = name.replace(/\.[^.]+$/, '')
            if (!seen.has(base.toLowerCase())) {
              seen.add(base.toLowerCase())
              commands.push(base)
            }
          }
        } else {
          try {
            accessSync(join(dir, name), constants.X_OK)
            if (!seen.has(name)) {
              seen.add(name)
              commands.push(name)
            }
          } catch {}
        }
      }
    } catch {}
  }
  return commands.sort()
}

export function listEnvVars(): Record<string, string> {
  return { ...process.env } as Record<string, string>
}
```

- [ ] **Step 4: Wire IPC handlers and preload**

In `src/main/index.ts`, add:

```typescript
import { listPathEntries, listPathCommands, listEnvVars } from './completionService'

ipcMain.handle('completion:path-entries', async (_, { dirPath }) => {
  try { return ok(listPathEntries(dirPath)) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('completion:path-commands', async () => {
  try { return ok(listPathCommands()) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('completion:env-vars', async () => {
  try { return ok(listEnvVars()) }
  catch (e: any) { return err(e.message) }
})
```

In `src/preload/index.ts`, add:

```typescript
completionPathEntries: (dirPath) =>
  ipcRenderer.invoke('completion:path-entries', { dirPath }),
completionPathCommands: () =>
  ipcRenderer.invoke('completion:path-commands'),
completionEnvVars: () =>
  ipcRenderer.invoke('completion:env-vars'),
```

- [ ] **Step 5: Run tests**

Run: `npm test -- tests/electron/completionService.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/main/completionService.ts tests/electron/completionService.test.ts \
  src/main/index.ts src/preload/index.ts
git commit -m "feat: add completion service IPC for PATH commands, file entries, env vars"
```

---

### Task 10: Input Parser + Spec Loader

**Files:**
- Create: `src/renderer/src/completions/inputParser.ts`
- Create: `src/renderer/src/completions/specLoader.ts`
- Create: `tests/renderer/inputParser.test.ts`

- [ ] **Step 1: Write failing tests for input parser**

Create `tests/renderer/inputParser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { parseInput } from '../../src/renderer/src/completions/inputParser'

describe('parseInput', () => {
  it('parses empty input', () => {
    const result = parseInput('')
    expect(result.command).toBe('')
    expect(result.tokens).toEqual([])
    expect(result.context).toBe('command')
  })

  it('parses partial command', () => {
    const result = parseInput('gi')
    expect(result.command).toBe('gi')
    expect(result.context).toBe('command')
  })

  it('parses command with subcommand', () => {
    const result = parseInput('git com')
    expect(result.command).toBe('git')
    expect(result.partial).toBe('com')
    expect(result.context).toBe('subcommand')
  })

  it('detects flag context after dash', () => {
    const result = parseInput('git commit -')
    expect(result.command).toBe('git')
    expect(result.subcommand).toBe('commit')
    expect(result.context).toBe('flag')
  })

  it('detects flag context after double dash', () => {
    const result = parseInput('git commit --am')
    expect(result.context).toBe('flag')
    expect(result.partial).toBe('--am')
  })

  it('detects path context after slash', () => {
    const result = parseInput('cat /etc/hos')
    expect(result.context).toBe('path')
    expect(result.partial).toBe('/etc/hos')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/renderer/inputParser.test.ts`

- [ ] **Step 3: Implement input parser**

Create `src/renderer/src/completions/inputParser.ts`:

```typescript
export interface ParsedInput {
  command: string
  subcommand?: string
  partial: string
  tokens: string[]
  context: 'command' | 'subcommand' | 'flag' | 'path' | 'arg'
}

export function parseInput(input: string): ParsedInput {
  const trimmed = input.trimStart()
  const tokens = trimmed.split(/\s+/).filter(Boolean)

  if (tokens.length === 0) {
    return { command: '', partial: '', tokens: [], context: 'command' }
  }

  const endsWithSpace = trimmed.endsWith(' ')
  const command = tokens[0]

  // Still typing the command name
  if (tokens.length === 1 && !endsWithSpace) {
    return { command, partial: command, tokens, context: 'command' }
  }

  const lastToken = endsWithSpace ? '' : tokens[tokens.length - 1]

  // Path detection
  if (lastToken.includes('/') || lastToken.includes('\\')) {
    return { command, partial: lastToken, tokens, context: 'path' }
  }

  // Flag detection
  if (lastToken.startsWith('-')) {
    const subcommand = tokens.length > 2 || (tokens.length === 2 && endsWithSpace)
      ? tokens[1] : undefined
    return { command, subcommand, partial: lastToken, tokens, context: 'flag' }
  }

  // Subcommand detection (second token, not a flag)
  if (tokens.length === 2 && !endsWithSpace) {
    return { command, partial: lastToken, tokens, context: 'subcommand' }
  }

  const subcommand = tokens[1]?.startsWith('-') ? undefined : tokens[1]
  return { command, subcommand, partial: lastToken, tokens, context: 'arg' }
}
```

- [ ] **Step 4: Create spec loader**

Create `src/renderer/src/completions/specLoader.ts`:

```typescript
export interface CompletionSpec {
  name: string
  description: string
  subcommands?: CompletionSpec[]
  options?: CompletionOption[]
}

export interface CompletionOption {
  name: string[]
  description: string
}

const specCache = new Map<string, CompletionSpec | null>()

export async function loadSpec(command: string): Promise<CompletionSpec | null> {
  if (specCache.has(command)) return specCache.get(command)!
  try {
    const mod = await import(`./specs/${command}.json`)
    const spec = mod.default as CompletionSpec
    specCache.set(command, spec)
    return spec
  } catch {
    specCache.set(command, null)
    return null
  }
}

export function clearSpecCache(): void {
  specCache.clear()
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -- tests/renderer/inputParser.test.ts`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/completions/inputParser.ts \
  src/renderer/src/completions/specLoader.ts \
  tests/renderer/inputParser.test.ts
git commit -m "feat: add terminal input parser and lazy spec loader for autocomplete"
```

---

### Task 11: Completion Engine

**Files:**
- Create: `src/renderer/src/completions/completionEngine.ts`
- Create: `tests/renderer/completionEngine.test.ts`

- [ ] **Step 1: Write failing tests for completion engine**

Create `tests/renderer/completionEngine.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getCompletions, CompletionResult } from '../../src/renderer/src/completions/completionEngine'

// Mock the termpolis API
const mockApi = {
  completionPathCommands: vi.fn().mockResolvedValue({ success: true, data: ['git', 'grep', 'go', 'docker', 'node'] }),
  completionPathEntries: vi.fn().mockResolvedValue({ success: true, data: [{ name: 'src', isDir: true }, { name: 'README.md', isDir: false }] }),
  searchHistory: vi.fn().mockResolvedValue({ success: true, data: [
    { terminalId: '1', terminalName: 'T1', command: 'git status', timestamp: 1 },
    { terminalId: '1', terminalName: 'T1', command: 'git push', timestamp: 2 },
  ]}),
}

vi.stubGlobal('window', { termpolis: mockApi })

describe('completionEngine', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns command suggestions for partial command input', async () => {
    const results = await getCompletions('gi')
    expect(results.some(r => r.text === 'git')).toBe(true)
  })

  it('returns at most 8 results', async () => {
    mockApi.completionPathCommands.mockResolvedValue({
      success: true, data: Array.from({ length: 20 }, (_, i) => `cmd${i}`)
    })
    const results = await getCompletions('cmd')
    expect(results.length).toBeLessThanOrEqual(8)
  })

  it('deduplicates results from multiple sources', async () => {
    const results = await getCompletions('git')
    const gitResults = results.filter(r => r.text === 'git')
    expect(gitResults.length).toBeLessThanOrEqual(1)
  })

  it('returns history-based suggestions ranked by frequency', async () => {
    const results = await getCompletions('git ')
    expect(results.some(r => r.source === 'history')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/renderer/completionEngine.test.ts`

- [ ] **Step 3: Implement completion engine**

Create `src/renderer/src/completions/completionEngine.ts`:

```typescript
import { parseInput } from './inputParser'
import { loadSpec } from './specLoader'

export interface CompletionResult {
  text: string
  description: string
  source: 'spec' | 'shell' | 'history'
}

const MAX_RESULTS = 8

export async function getCompletions(input: string): Promise<CompletionResult[]> {
  const parsed = parseInput(input)
  const results: CompletionResult[] = []
  const seen = new Set<string>()

  function add(text: string, description: string, source: CompletionResult['source']) {
    if (seen.has(text) || results.length >= MAX_RESULTS) return
    seen.add(text)
    results.push({ text, description, source })
  }

  if (parsed.context === 'command') {
    // Spec-known commands first
    // Then PATH commands
    const res = await window.termpolis.completionPathCommands()
    if (res.success && res.data) {
      for (const cmd of res.data) {
        if (cmd.toLowerCase().startsWith(parsed.partial.toLowerCase())) {
          add(cmd, '', 'shell')
        }
      }
    }
  } else if (parsed.context === 'subcommand' || parsed.context === 'flag') {
    const spec = await loadSpec(parsed.command)
    if (spec) {
      if (parsed.context === 'subcommand' && spec.subcommands) {
        for (const sub of spec.subcommands) {
          if (sub.name.startsWith(parsed.partial)) {
            add(sub.name, sub.description, 'spec')
          }
        }
      }
      if (parsed.context === 'flag') {
        const target = parsed.subcommand
          ? spec.subcommands?.find(s => s.name === parsed.subcommand)
          : spec
        if (target?.options) {
          for (const opt of target.options) {
            for (const name of opt.name) {
              if (name.startsWith(parsed.partial)) {
                add(name, opt.description, 'spec')
              }
            }
          }
        }
      }
    }
  } else if (parsed.context === 'path') {
    const lastSlash = parsed.partial.lastIndexOf('/')
    const dir = lastSlash >= 0 ? parsed.partial.slice(0, lastSlash + 1) : './'
    const prefix = lastSlash >= 0 ? parsed.partial.slice(lastSlash + 1) : parsed.partial
    const res = await window.termpolis.completionPathEntries(dir)
    if (res.success && res.data) {
      for (const entry of res.data) {
        if (entry.name.startsWith(prefix)) {
          add(dir + entry.name + (entry.isDir ? '/' : ''), entry.isDir ? 'Directory' : 'File', 'shell')
        }
      }
    }
  }

  // History suggestions (query with the full command prefix)
  const histRes = await window.termpolis.searchHistory(parsed.command || '')
  if (histRes.success && histRes.data) {
    const commands = histRes.data.map(h => h.command)
    const freq = new Map<string, number>()
    for (const cmd of commands) freq.set(cmd, (freq.get(cmd) || 0) + 1)
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1])
    for (const [cmd] of sorted) {
      if (cmd.startsWith(input.trim())) {
        add(cmd, `Used ${freq.get(cmd)} times`, 'history')
      }
    }
  }

  return results.slice(0, MAX_RESULTS)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/renderer/completionEngine.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/completions/completionEngine.ts \
  tests/renderer/completionEngine.test.ts
git commit -m "feat: add completion engine orchestrating specs, shell, and history sources"
```

---

### Task 12: Completion Dropdown UI

**Files:**
- Create: `src/renderer/src/components/CompletionDropdown/CompletionDropdown.tsx`
- Create: `tests/renderer/completionDropdown.test.tsx`
- Modify: `src/renderer/src/components/TerminalPane/TerminalPane.tsx`

- [ ] **Step 1: Write failing test for CompletionDropdown**

Create `tests/renderer/completionDropdown.test.tsx`:

```typescript
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { CompletionDropdown } from '../../src/renderer/src/components/CompletionDropdown/CompletionDropdown'

const suggestions = [
  { text: 'commit', description: 'Record changes', source: 'spec' as const },
  { text: 'config', description: 'Get and set options', source: 'spec' as const },
]

describe('CompletionDropdown', () => {
  it('renders suggestions', () => {
    render(<CompletionDropdown suggestions={suggestions} selectedIndex={0} position={{ x: 0, y: 0 }} onAccept={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByText('commit')).toBeInTheDocument()
    expect(screen.getByText('config')).toBeInTheDocument()
  })

  it('highlights selected index', () => {
    render(<CompletionDropdown suggestions={suggestions} selectedIndex={1} position={{ x: 0, y: 0 }} onAccept={vi.fn()} onDismiss={vi.fn()} />)
    const configEl = screen.getByText('config').closest('[data-selected]')
    expect(configEl).toBeTruthy()
  })

  it('renders keyboard hints footer', () => {
    render(<CompletionDropdown suggestions={suggestions} selectedIndex={0} position={{ x: 0, y: 0 }} onAccept={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByText(/Tab accept/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/renderer/completionDropdown.test.tsx`

- [ ] **Step 3: Create CompletionDropdown component**

Create `src/renderer/src/components/CompletionDropdown/CompletionDropdown.tsx`:
- Receives `suggestions[]`, `selectedIndex`, `position: {x, y}`, `onAccept`, `onDismiss`
- Renders VS Code-style dropdown: dark background (`#252526`), border, shadow
- Each suggestion: name + description, highlighted row for selectedIndex
- Footer: `↑↓ navigate · Tab accept · Esc dismiss`
- Positioned absolutely at given x/y coordinates

- [ ] **Step 2: Wire CompletionDropdown into TerminalPane**

In `TerminalPane.tsx`:
- Add state: `suggestions`, `selectedIndex`, `dropdownPosition`, `dropdownVisible`
- In `onData` handler, after updating `inputBufferRef`, call completion engine asynchronously
- When suggestions come back and input matches trigger conditions, show dropdown
- Add keyboard interception: when dropdown visible, intercept Tab (accept), Arrow Up/Down (navigate), Esc (dismiss)
- On accept: write the completed text to PTY via `writeToTerminal`, close dropdown
- On any character typed: re-filter/re-query, or dismiss if no matches
- **Ctrl+Space** manually triggers the dropdown at any time (even if auto-trigger hasn't fired)
- Render `<CompletionDropdown>` as a portal/overlay positioned relative to cursor

- [ ] **Step 5: Add autocomplete toggle to settings**

Add a `autocompleteEnabled` boolean to the Zustand store (default `true`). Add a toggle in `SettingsPane` to enable/disable autocomplete. When disabled, the completion engine is never queried and the dropdown never shows. Persist in session data.

- [ ] **Step 6: Run dropdown tests**

Run: `npm test -- tests/renderer/completionDropdown.test.tsx`
Expected: All PASS

- [ ] **Step 7: Verify app builds**

Run: `npm run build`

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/CompletionDropdown/CompletionDropdown.tsx \
  tests/renderer/completionDropdown.test.tsx \
  src/renderer/src/components/TerminalPane/TerminalPane.tsx \
  src/renderer/src/store/terminalStore.ts \
  src/renderer/src/components/SettingsPane/SettingsPane.tsx
git commit -m "feat: add autocomplete dropdown UI with Ctrl+Space trigger and settings toggle"
```

---

### Task 13: Bundled Completion Specs (Initial Set)

**Files:**
- Create: `scripts/convert-fig-specs.ts`
- Create: `src/renderer/src/completions/specs/*.json` (initial batch)

- [ ] **Step 1: Create spec conversion script**

Create `scripts/convert-fig-specs.ts` that:
- Reads TypeScript completion specs from a local clone of withfig/autocomplete
- Converts a curated list of ~50 most common commands to simplified JSON format
- Outputs to `src/renderer/src/completions/specs/`

Start with a manually curated initial set of ~20 specs for the most common commands: `git`, `npm`, `yarn`, `docker`, `kubectl`, `curl`, `ssh`, `scp`, `ls`, `cd`, `cat`, `grep`, `find`, `mkdir`, `rm`, `cp`, `mv`, `chmod`, `node`, `python`.

- [ ] **Step 2: Generate initial spec files**

Run the converter or manually create JSON spec files for the initial 20 commands.

- [ ] **Step 3: Verify specs load**

Manually test in dev mode that typing `git ` shows subcommand suggestions.

- [ ] **Step 4: Commit**

```bash
git add scripts/convert-fig-specs.ts src/renderer/src/completions/specs/
git commit -m "feat: add initial 20 command completion specs (git, docker, npm, etc.)"
```

---

### Task 14: Correction Rules Engine

**Files:**
- Create: `src/renderer/src/corrections/rules/commandNotFound.ts`
- Create: `src/renderer/src/corrections/rules/extractSuggestion.ts`
- Create: `src/renderer/src/corrections/rules/permissionDenied.ts`
- Create: `src/renderer/src/corrections/rules/index.ts`
- Create: `tests/renderer/correctionRules.test.ts`

- [ ] **Step 1: Write failing tests for correction rules**

Create `tests/renderer/correctionRules.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { extractSuggestionFromStderr } from '../../src/renderer/src/corrections/rules/extractSuggestion'
import { fixPermissionDenied } from '../../src/renderer/src/corrections/rules/permissionDenied'

describe('extractSuggestion', () => {
  it('extracts git "Did you mean" suggestion', () => {
    const stderr = "git: 'comit' is not a git command. See 'git --help'.\n\nThe most similar command is\n    commit"
    expect(extractSuggestionFromStderr('git comit -m "fix"', stderr)).toBe('git commit -m "fix"')
  })

  it('returns null for unrecognized output', () => {
    expect(extractSuggestionFromStderr('foo', 'some random error')).toBeNull()
  })
})

describe('fixPermissionDenied', () => {
  it('prepends sudo for permission denied errors', () => {
    const stderr = 'E: Could not open lock file - open (13: Permission denied)'
    expect(fixPermissionDenied('apt install vim', stderr)).toBe('sudo apt install vim')
  })

  it('does not prepend sudo if already present', () => {
    const stderr = 'Permission denied'
    expect(fixPermissionDenied('sudo apt install vim', stderr)).toBeNull()
  })

  it('returns null for non-permission errors', () => {
    expect(fixPermissionDenied('ls', 'file not found')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/renderer/correctionRules.test.ts`

- [ ] **Step 3: Implement correction rules**

Create each rule file as a pure function `(command: string, output: string) => string | null`:

**`extractSuggestion.ts`** — regex-parse "Did you mean", "most similar command is", npm "did you mean" patterns from stderr, substitute into original command.

**`permissionDenied.ts`** — detect "Permission denied" / "EACCES" / "operation not permitted", prepend `sudo` if not already present. Skip on Windows.

**`commandNotFound.ts`** — detect "command not found" / "not recognized", use Levenshtein distance to find closest match from a provided command list.

**`index.ts`** — export all rules as an array of `CorrectionRule` functions.

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/renderer/correctionRules.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/corrections/ tests/renderer/correctionRules.test.ts
git commit -m "feat: add correction rules for command typos, permission errors, stderr suggestions"
```

---

### Task 15: Correction Engine + Command Fix Banner

**Files:**
- Create: `src/renderer/src/corrections/correctionEngine.ts`
- Create: `src/renderer/src/components/CommandFix/CommandFixBanner.tsx`
- Create: `tests/renderer/correctionEngine.test.ts`
- Modify: `src/renderer/src/components/TerminalPane/TerminalPane.tsx`

- [ ] **Step 1: Write failing test for correction engine**

Create `tests/renderer/correctionEngine.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { getSuggestion } from '../../src/renderer/src/corrections/correctionEngine'

vi.stubGlobal('window', {
  termpolis: {
    completionPathCommands: vi.fn().mockResolvedValue({
      success: true, data: ['git', 'docker', 'node', 'npm']
    })
  }
})

describe('correctionEngine', () => {
  it('suggests correction for git typo with stderr hint', async () => {
    const result = await getSuggestion(
      'git comit -m "fix"',
      "git: 'comit' is not a git command.\n\nThe most similar command is\n    commit"
    )
    expect(result).toBe('git commit -m "fix"')
  })

  it('suggests sudo for permission denied', async () => {
    const result = await getSuggestion('apt install vim', 'Permission denied')
    expect(result).toBe('sudo apt install vim')
  })

  it('suggests closest command for typo', async () => {
    const result = await getSuggestion('dockr ps', 'bash: dockr: command not found')
    expect(result).toBe('docker ps')
  })

  it('returns null when no fix available', async () => {
    const result = await getSuggestion('somecommand', 'some random error')
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/renderer/correctionEngine.test.ts`

- [ ] **Step 3: Create correction engine**

Create `src/renderer/src/corrections/correctionEngine.ts`:
- Takes last command + recent output buffer
- Runs all rules in order, returns first non-null result
- Needs access to PATH command list (from completion service) for Levenshtein matching

- [ ] **Step 2: Create CommandFixBanner component**

Create `src/renderer/src/components/CommandFix/CommandFixBanner.tsx`:
- Props: `suggestion: string`, `onAccept: () => void`, `onDismiss: () => void`
- Green banner with: `💡 Fix: <command>` and `Enter to run · Esc to ignore`
- Auto-dismisses after 10 seconds via `setTimeout`

- [ ] **Step 3: Wire into TerminalPane**

In `TerminalPane.tsx`:
- Add shell integration marker injection: after terminal creation, write the appropriate `PROMPT_COMMAND` / `precmd` hook based on shell type to emit `\e]633;E;$?\a`
- Parse incoming terminal data for the OSC 633 marker to detect command completion + exit code
- When exit code !== 0, run correctionEngine against last command + recent output
- If correction found, show `CommandFixBanner` overlay
- Handle Enter (execute fix via writeToTerminal) and Esc (dismiss)

- [ ] **Step 6: Run correction engine tests**

Run: `npm test -- tests/renderer/correctionEngine.test.ts`
Expected: All PASS

- [ ] **Step 7: Verify build**

Run: `npm run build`

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/corrections/correctionEngine.ts \
  tests/renderer/correctionEngine.test.ts \
  src/renderer/src/components/CommandFix/CommandFixBanner.tsx \
  src/renderer/src/components/TerminalPane/TerminalPane.tsx
git commit -m "feat: add command auto-fix with shell integration markers and inline banner"
```

---

### Task 16: Bundled CLI Tools (Nice-to-Have)

**Files:**
- Create: `scripts/download-tools.sh`
- Modify: `src/main/terminalManager.ts`
- Modify: `electron-builder.config.ts`

- [ ] **Step 1: Create download script**

Create `scripts/download-tools.sh` that downloads latest releases of jq, yq, and curl for win32, darwin, linux (amd64 + arm64 where available) into `resources/tools/{platform}/`.

- [ ] **Step 2: Update terminalManager to inject bundled tools PATH**

In `src/main/terminalManager.ts`, in `spawnTerminal`:

```typescript
import { app } from 'electron'
import { join } from 'path'
import { execSync } from 'child_process'

function isCommandAvailable(cmd: string): boolean {
  try {
    execSync(process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`, { stdio: 'ignore' })
    return true
  } catch { return false }
}

// In spawnTerminal, before pty.spawn:
const toolsDir = join(app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources'), 'tools', process.platform)
const existingPath = process.env.PATH || process.env.Path || ''
// Only prepend bundled tools dir if at least one tool is missing from system PATH
const needsBundled = !isCommandAvailable('jq') || !isCommandAvailable('yq') || !isCommandAvailable('curl')
const env = needsBundled
  ? { ...process.env, PATH: `${toolsDir}${process.platform === 'win32' ? ';' : ':'}${existingPath}` }
  : { ...process.env } as Record<string, string>
```

Pass this `env` to `pty.spawn`. Note: curl check ensures it's only bundled as fallback per spec.

- [ ] **Step 3: Configure electron-builder extraResources**

In `electron-builder.config.ts`, use per-platform config to correctly handle CI cross-compilation:

```typescript
win: {
  extraResources: [{ from: 'resources/tools/win32', to: 'tools', filter: ['**/*'] }]
},
mac: {
  extraResources: [{ from: 'resources/tools/darwin', to: 'tools', filter: ['**/*'] }]
},
linux: {
  extraResources: [{ from: 'resources/tools/linux', to: 'tools', filter: ['**/*'] }]
}
```

- [ ] **Step 4: Verify build**

Run: `npm run build`

- [ ] **Step 5: Commit**

```bash
git add scripts/download-tools.sh src/main/terminalManager.ts \
  electron-builder.config.ts resources/tools/
git commit -m "feat: bundle jq, yq, curl CLI tools with PATH injection"
```

---

### Task 17: Final Integration Test + Cleanup

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All PASS

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Manual smoke test**

Launch dev: `npm run dev`
- Create terminal with non-default font size, theme, font → verify renders correctly
- Switch themes on existing terminal via TabPopover → verify live update
- Type `git com` → verify autocomplete dropdown appears with `commit`, `config`
- Type `git comit` + Enter → verify correction banner appears with `git commit`
- Open grid view with 4+ terminals, run `find /` in one → verify no UI freezing
- Test emoji rendering: `echo 🚀🎉` → verify correct alignment
- Export terminal output → verify file saves with clean text
- Verify session persistence: close and reopen app → font size, theme, font preserved

- [ ] **Step 4: Add .superpowers/ to .gitignore if not present**

- [ ] **Step 5: Final commit**

```bash
git commit -m "chore: final integration cleanup"
```
