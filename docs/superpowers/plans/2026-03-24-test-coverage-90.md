# Test Coverage — 90% Goal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise Vitest unit/component test coverage to ≥90% by filling the five major untested areas: swarmBridgeManager, sessionRecorder, SwarmCompleteDialog, SplitView, and the Electron preload IPC contract.

**Architecture:** Each task targets one previously-untested module. Tests follow the existing project pattern: `vi.mock` for all external APIs, `vi.useFakeTimers()` for intervals, React Testing Library for components, Node environment for Electron-side modules. IPC contract tests mock `electron` and verify the preload script calls the right channels with correct arguments.

**Tech Stack:** Vitest 4, React Testing Library, jsdom, @vitest/coverage-v8, TypeScript

---

## File Map

| Action | File |
|--------|------|
| Modify | `vitest.config.ts` |
| Create | `tests/renderer/swarmBridgeManager.test.ts` |
| Create | `tests/renderer/sessionRecorder.test.ts` |
| Create | `tests/components/SwarmCompleteDialog.test.tsx` |
| Create | `tests/components/SplitView.test.tsx` |
| Create | `tests/electron/ipcBridge.test.ts` |

---

## Task 1: Configure Coverage Reporting

**Files:**
- Modify: `vitest.config.ts`

- [ ] **Step 1: Add coverage config to vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    exclude: ['**/node_modules/**', '**/.worktrees/**', '**/e2e/**'],
    environmentMatchGlobs: [
      ['tests/electron/**', 'node'],
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'src/renderer/src/lib/**/*.ts',
        'src/renderer/src/components/**/*.tsx',
        'src/renderer/src/store/**/*.ts',
        'src/main/**/*.ts',
        'src/preload/**/*.ts',
      ],
      exclude: [
        '**/*.d.ts',
        '**/node_modules/**',
        '**/types/**',
        'src/renderer/src/lib/sentry.ts',
        'src/main/sentry.ts',
        'src/renderer/src/lib/terminalDefaults.ts',
        'src/renderer/src/lib/outputPatterns.ts',
        'src/renderer/src/lib/homedir.ts',
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
})
```

- [ ] **Step 2: Add coverage script to package.json**

In `package.json`, under `"scripts"`, add:
```json
"test:coverage": "vitest run --coverage",
"test:e2e": "playwright test"
```

- [ ] **Step 3: Run coverage to get baseline**

```bash
npm run test:coverage 2>&1 | tail -30
```

Expected: coverage report shows current percentages (likely 60-70% lines). This establishes the baseline before filling gaps.

- [ ] **Step 4: Commit config**

```bash
git add vitest.config.ts package.json
git commit -m "test: configure coverage reporting with 90% thresholds"
```

---

## Task 2: swarmBridgeManager Tests

**Files:**
- Create: `tests/renderer/swarmBridgeManager.test.ts`
- Reference: `src/renderer/src/lib/swarmBridgeManager.ts`

The manager exports three functions: `startBridgeForAgent`, `stopBridgeForAgent`, `stopAllBridges`. It uses `setInterval` (5s) to poll `window.termpolis.readTerminalBuffer`, calls `window.swarmAPI.sendMessage` when signals are detected, and calls `window.swarmAPI.getTasks` + `window.swarmAPI.updateTask` when a `result` signal is detected.

- [ ] **Step 1: Write the tests**

Create `tests/renderer/swarmBridgeManager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  startBridgeForAgent,
  stopBridgeForAgent,
  stopAllBridges,
} from '../../src/renderer/src/lib/swarmBridgeManager'

beforeEach(() => {
  vi.useFakeTimers()
  ;(window as any).termpolis = {
    readTerminalBuffer: vi.fn().mockResolvedValue({
      success: true,
      data: { output: '', length: 0 },
    }),
  }
  ;(window as any).swarmAPI = {
    sendMessage: vi.fn().mockResolvedValue({ success: true }),
    getTasks: vi.fn().mockResolvedValue({ success: true, data: [] }),
    updateTask: vi.fn().mockResolvedValue({ success: true }),
  }
})

afterEach(() => {
  stopAllBridges()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('startBridgeForAgent', () => {
  it('does not start a duplicate bridge if already running', () => {
    startBridgeForAgent('t1', 'Agent')
    startBridgeForAgent('t1', 'Agent') // second call should be a no-op
    vi.advanceTimersByTime(5000)
    // readTerminalBuffer called once (from one interval), not twice
    expect(window.termpolis.readTerminalBuffer).toHaveBeenCalledTimes(1)
  })

  it('polls readTerminalBuffer on each interval tick', async () => {
    startBridgeForAgent('t1', 'Claude')
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.termpolis.readTerminalBuffer).toHaveBeenCalledWith('t1', 0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.termpolis.readTerminalBuffer).toHaveBeenCalledTimes(2)
  })

  it('tracks output offset across ticks', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: true, data: { output: 'hello', length: 5 } })
      .mockResolvedValue({ success: true, data: { output: '', length: 0 } })

    startBridgeForAgent('t1', 'Claude')
    await vi.advanceTimersByTimeAsync(5000) // offset becomes 5
    await vi.advanceTimersByTimeAsync(5000) // next call uses offset 5
    expect(window.termpolis.readTerminalBuffer).toHaveBeenNthCalledWith(2, 't1', 5)
  })

  it('does NOT post a message when output has no meaningful signal', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ success: true, data: { output: 'just some random text', length: 21 } })

    startBridgeForAgent('t1', 'Claude')
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.swarmAPI.sendMessage).not.toHaveBeenCalled()
  })

  it('posts a message when a completion signal is detected', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockResolvedValue({
        success: true,
        data: { output: 'Task is now complete and done.', length: 30 },
      })

    startBridgeForAgent('t1', 'Gemini')
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.swarmAPI.sendMessage).toHaveBeenCalledWith(
      'Gemini',
      'all',
      expect.any(String),
      expect.stringContaining('Gemini'),
    )
  })

  it('auto-completes in-progress task when result signal detected', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockResolvedValue({
        success: true,
        data: { output: 'All done — work is finished successfully', length: 40 },
      })
    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: [{ id: 'task-1', assignedTo: 't1', status: 'in_progress' }],
    })

    startBridgeForAgent('t1', 'Gemini')
    await vi.advanceTimersByTimeAsync(5000)

    expect(window.swarmAPI.updateTask).toHaveBeenCalledWith(
      'task-1',
      'completed',
      expect.any(String),
    )
  })

  it('does not update tasks if there is no matching in-progress task', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockResolvedValue({
        success: true,
        data: { output: 'All done — work is finished', length: 26 },
      })
    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: [{ id: 'task-2', assignedTo: 'other-terminal', status: 'in_progress' }],
    })

    startBridgeForAgent('t1', 'Gemini')
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.swarmAPI.updateTask).not.toHaveBeenCalled()
  })

  it('swallows errors silently if readTerminalBuffer fails', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error('IPC error'))

    startBridgeForAgent('t1', 'Claude')
    await expect(vi.advanceTimersByTimeAsync(5000)).resolves.not.toThrow()
  })
})

describe('stopBridgeForAgent', () => {
  it('stops polling after stop is called', async () => {
    startBridgeForAgent('t1', 'Claude')
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.termpolis.readTerminalBuffer).toHaveBeenCalledTimes(1)

    stopBridgeForAgent('t1')
    await vi.advanceTimersByTimeAsync(5000)
    // No additional calls after stop
    expect(window.termpolis.readTerminalBuffer).toHaveBeenCalledTimes(1)
  })

  it('is safe to call on a terminal that was never started', () => {
    expect(() => stopBridgeForAgent('never-started')).not.toThrow()
  })

  it('resets the output offset so a restarted bridge starts from 0', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ success: true, data: { output: 'abc', length: 3 } })

    startBridgeForAgent('t1', 'Claude')
    await vi.advanceTimersByTimeAsync(5000)
    stopBridgeForAgent('t1')

    // Restart — offset should reset to 0
    startBridgeForAgent('t1', 'Claude')
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.termpolis.readTerminalBuffer).toHaveBeenLastCalledWith('t1', 0)
  })
})

describe('stopAllBridges', () => {
  it('stops all running bridges', async () => {
    startBridgeForAgent('t1', 'Claude')
    startBridgeForAgent('t2', 'Gemini')
    await vi.advanceTimersByTimeAsync(5000)

    stopAllBridges()
    vi.clearAllMocks()
    await vi.advanceTimersByTimeAsync(5000)

    expect(window.termpolis.readTerminalBuffer).not.toHaveBeenCalled()
  })

  it('is safe to call when no bridges are running', () => {
    expect(() => stopAllBridges()).not.toThrow()
  })
})
```

- [ ] **Step 2: Run and verify tests pass**

```bash
npx vitest run tests/renderer/swarmBridgeManager.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/renderer/swarmBridgeManager.test.ts
git commit -m "test: full coverage for swarmBridgeManager — polling, signals, task auto-complete"
```

---

## Task 3: sessionRecorder Tests

**Files:**
- Create: `tests/renderer/sessionRecorder.test.ts`
- Reference: `src/renderer/src/lib/sessionRecorder.ts`

Pure logic — no mocks needed. Tests cover recording lifecycle, entry appending, formatting, and filename generation.

- [ ] **Step 1: Write the tests**

Create `tests/renderer/sessionRecorder.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createSessionRecorder,
  appendEntry,
  formatRecording,
  generateRecordingFilename,
  type SessionRecording,
} from '../../src/renderer/src/lib/sessionRecorder'

describe('createSessionRecorder', () => {
  it('creates recorder with correct shape', () => {
    const rec = createSessionRecorder('My Terminal', 'bash')
    expect(rec.terminalName).toBe('My Terminal')
    expect(rec.shellLabel).toBe('bash')
    expect(rec.entries).toEqual([])
    expect(typeof rec.startTime).toBe('number')
  })

  it('sets startTime to current time', () => {
    const before = Date.now()
    const rec = createSessionRecorder('T', 'zsh')
    const after = Date.now()
    expect(rec.startTime).toBeGreaterThanOrEqual(before)
    expect(rec.startTime).toBeLessThanOrEqual(after)
  })
})

describe('appendEntry', () => {
  let rec: SessionRecording

  beforeEach(() => {
    rec = createSessionRecorder('T', 'bash')
  })

  it('appends an input entry', () => {
    appendEntry(rec, 'input', 'ls -la')
    expect(rec.entries).toHaveLength(1)
    expect(rec.entries[0].type).toBe('input')
    expect(rec.entries[0].data).toBe('ls -la')
  })

  it('appends an output entry', () => {
    appendEntry(rec, 'output', 'total 0\ndrwxr-xr-x 2 user group 40')
    expect(rec.entries[0].type).toBe('output')
  })

  it('records a timestamp for each entry', () => {
    const before = Date.now()
    appendEntry(rec, 'input', 'echo hi')
    expect(rec.entries[0].timestamp).toBeGreaterThanOrEqual(before)
  })

  it('accumulates multiple entries in order', () => {
    appendEntry(rec, 'input', 'l')
    appendEntry(rec, 'input', 's')
    appendEntry(rec, 'output', 'file.txt')
    expect(rec.entries).toHaveLength(3)
    expect(rec.entries.map(e => e.data)).toEqual(['l', 's', 'file.txt'])
  })
})

describe('formatRecording', () => {
  it('includes the header with terminal name, shell, and started date', () => {
    const rec = createSessionRecorder('Main', 'powershell')
    const output = formatRecording(rec)
    expect(output).toContain('Termpolis Session Recording')
    expect(output).toContain('Terminal: Main')
    expect(output).toContain('Shell: powershell')
    expect(output).toContain('Started:')
    expect(output).toContain('Duration:')
  })

  it('formats output entries as timestamped lines', () => {
    const rec = createSessionRecorder('T', 'bash')
    appendEntry(rec, 'output', 'hello world\nsecond line')
    const out = formatRecording(rec)
    expect(out).toContain('hello world')
    expect(out).toContain('second line')
  })

  it('accumulates input chars and flushes on carriage return', () => {
    const rec = createSessionRecorder('T', 'bash')
    appendEntry(rec, 'input', 'g')
    appendEntry(rec, 'input', 'i')
    appendEntry(rec, 'input', 't')
    appendEntry(rec, 'input', '\r')
    const out = formatRecording(rec)
    expect(out).toContain('$ git')
  })

  it('handles backspace in input accumulation', () => {
    const rec = createSessionRecorder('T', 'bash')
    appendEntry(rec, 'input', 'g')
    appendEntry(rec, 'input', 'x')
    appendEntry(rec, 'input', '\u007f') // backspace
    appendEntry(rec, 'input', 'i')
    appendEntry(rec, 'input', 't')
    appendEntry(rec, 'input', '\r')
    const out = formatRecording(rec)
    expect(out).toContain('$ git')
    expect(out).not.toContain('gx')
  })

  it('strips ANSI escape codes from output', () => {
    const rec = createSessionRecorder('T', 'bash')
    appendEntry(rec, 'output', '\x1b[32mgreen text\x1b[0m')
    const out = formatRecording(rec)
    expect(out).toContain('green text')
    expect(out).not.toContain('\x1b[32m')
  })

  it('returns a string even with empty entries', () => {
    const rec = createSessionRecorder('Empty', 'bash')
    const out = formatRecording(rec)
    expect(typeof out).toBe('string')
    expect(out).toContain('Termpolis Session Recording')
  })

  it('shows duration of 0s for empty recording', () => {
    const rec = createSessionRecorder('T', 'bash')
    const out = formatRecording(rec)
    expect(out).toContain('0s')
  })

  it('formats duration in minutes and seconds', () => {
    const rec = createSessionRecorder('T', 'bash')
    // Manually set startTime to 90 seconds ago
    rec.startTime = Date.now() - 90000
    appendEntry(rec, 'output', 'done')
    const out = formatRecording(rec)
    expect(out).toMatch(/1m \d+s/)
  })
})

describe('generateRecordingFilename', () => {
  it('includes the terminal name (sanitized)', () => {
    const name = generateRecordingFilename('My Terminal')
    expect(name).toContain('My_Terminal')
  })

  it('replaces special characters with underscores', () => {
    const name = generateRecordingFilename('node (dev) #1')
    expect(name).toMatch(/^[a-zA-Z0-9_-]+_recording_/)
  })

  it('includes _recording_ in the name', () => {
    expect(generateRecordingFilename('T')).toContain('_recording_')
  })

  it('ends with .txt', () => {
    expect(generateRecordingFilename('T')).toMatch(/\.txt$/)
  })

  it('two calls at the same second produce the same timestamp format', () => {
    const a = generateRecordingFilename('X')
    const b = generateRecordingFilename('X')
    // Both should match the same pattern
    expect(a).toMatch(/X_recording_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.txt/)
  })
})
```

- [ ] **Step 2: Run and verify tests pass**

```bash
npx vitest run tests/renderer/sessionRecorder.test.ts
```

Expected: all tests pass. If the `formatDuration` test flickers due to wall-clock timing, the Task 7 step shows how to pin `Date.now` with fake timers.

- [ ] **Step 3: Commit**

```bash
git add tests/renderer/sessionRecorder.test.ts
git commit -m "test: full coverage for sessionRecorder — create, append, format, filename"
```

---

## Task 4: SwarmCompleteDialog Component Tests

**Files:**
- Create: `tests/components/SwarmCompleteDialog.test.tsx`
- Reference: `src/renderer/src/components/SwarmDashboard/SwarmCompleteDialog.tsx`

No external deps — pure props-driven UI. Tests focus on conditional rendering, message stripping, and callback invocation.

- [ ] **Step 1: Write the tests**

Create `tests/components/SwarmCompleteDialog.test.tsx`:

```typescript
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SwarmCompleteDialog } from '../../src/renderer/src/components/SwarmDashboard/SwarmCompleteDialog'

const defaultProps = {
  message: '3 tasks completed successfully',
  tasks: [],
  onViewDashboard: vi.fn(),
  onDismiss: vi.fn(),
}

function make(overrides = {}) {
  return { ...defaultProps, onViewDashboard: vi.fn(), onDismiss: vi.fn(), ...overrides }
}

describe('SwarmCompleteDialog', () => {
  it('renders "Swarm Complete" heading', () => {
    render(<SwarmCompleteDialog {...make()} />)
    expect(screen.getByText('Swarm Complete')).toBeInTheDocument()
  })

  it('shows the summary message', () => {
    render(<SwarmCompleteDialog {...make({ message: 'All work is done' })} />)
    expect(screen.getByText('All work is done')).toBeInTheDocument()
  })

  it('strips "SWARM COMPLETE:" prefix from message', () => {
    render(<SwarmCompleteDialog {...make({ message: 'SWARM COMPLETE: 2 tasks done' })} />)
    expect(screen.getByText('2 tasks done')).toBeInTheDocument()
    expect(screen.queryByText(/SWARM COMPLETE:/)).not.toBeInTheDocument()
  })

  it('strips prefix case-insensitively', () => {
    render(<SwarmCompleteDialog {...make({ message: 'swarm complete: built the app' })} />)
    expect(screen.getByText('built the app')).toBeInTheDocument()
  })

  it('shows "finished its work" subtitle when no tasks provided', () => {
    render(<SwarmCompleteDialog {...make({ tasks: [] })} />)
    expect(screen.getByText(/finished its work/)).toBeInTheDocument()
  })

  it('shows completed task count when tasks are present', () => {
    const tasks = [
      { id: '1', title: 'Build feature', status: 'completed', result: 'Done' },
      { id: '2', title: 'Write tests', status: 'completed' },
    ]
    render(<SwarmCompleteDialog {...make({ tasks })} />)
    expect(screen.getByText(/2 tasks completed/)).toBeInTheDocument()
  })

  it('shows failed task count separately', () => {
    const tasks = [
      { id: '1', title: 'Build', status: 'completed' },
      { id: '2', title: 'Deploy', status: 'failed', result: 'timeout' },
    ]
    render(<SwarmCompleteDialog {...make({ tasks })} />)
    expect(screen.getByText(/1 task completed/)).toBeInTheDocument()
    expect(screen.getByText(/1 failed/)).toBeInTheDocument()
  })

  it('renders each completed task title', () => {
    const tasks = [
      { id: '1', title: 'Write the README', status: 'completed', result: 'Done' },
      { id: '2', title: 'Add unit tests', status: 'completed' },
    ]
    render(<SwarmCompleteDialog {...make({ tasks })} />)
    expect(screen.getByText('Write the README')).toBeInTheDocument()
    expect(screen.getByText('Add unit tests')).toBeInTheDocument()
  })

  it('renders task result text when provided', () => {
    const tasks = [{ id: '1', title: 'T', status: 'completed', result: 'Created 3 files' }]
    render(<SwarmCompleteDialog {...make({ tasks })} />)
    expect(screen.getByText('Created 3 files')).toBeInTheDocument()
  })

  it('renders failed tasks', () => {
    const tasks = [{ id: '1', title: 'Deploy', status: 'failed', result: 'timed out' }]
    render(<SwarmCompleteDialog {...make({ tasks })} />)
    expect(screen.getByText('Deploy')).toBeInTheDocument()
    expect(screen.getByText('timed out')).toBeInTheDocument()
  })

  it('calls onDismiss when backdrop is clicked', () => {
    const props = make()
    render(<SwarmCompleteDialog {...props} />)
    // Click the fixed overlay div (the backdrop)
    const backdrop = document.querySelector('.fixed')!
    fireEvent.click(backdrop)
    expect(props.onDismiss).toHaveBeenCalled()
  })

  it('does NOT call onDismiss when clicking inside the card', () => {
    const props = make()
    render(<SwarmCompleteDialog {...props} />)
    fireEvent.click(screen.getByText('Swarm Complete'))
    expect(props.onDismiss).not.toHaveBeenCalled()
  })

  it('calls onDismiss when X button is clicked', () => {
    const props = make()
    render(<SwarmCompleteDialog {...props} />)
    // The X button is the close icon in the header — find the button near the heading
    const buttons = screen.getAllByRole('button')
    const xButton = buttons.find(b => b.querySelector('.fa-xmark'))!
    fireEvent.click(xButton)
    expect(props.onDismiss).toHaveBeenCalled()
  })

  it('calls onDismiss when Dismiss button is clicked', () => {
    const props = make()
    render(<SwarmCompleteDialog {...props} />)
    fireEvent.click(screen.getByText('Dismiss'))
    expect(props.onDismiss).toHaveBeenCalled()
  })

  it('calls onViewDashboard when View Dashboard button is clicked', () => {
    const props = make()
    render(<SwarmCompleteDialog {...props} />)
    fireEvent.click(screen.getByText('View Dashboard'))
    expect(props.onViewDashboard).toHaveBeenCalled()
  })

  it('shows singular "task" for exactly 1 task', () => {
    const tasks = [{ id: '1', title: 'T', status: 'completed' }]
    render(<SwarmCompleteDialog {...make({ tasks })} />)
    expect(screen.getByText(/1 task completed/)).toBeInTheDocument()
    expect(screen.queryByText(/1 tasks/)).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run and verify tests pass**

```bash
npx vitest run tests/components/SwarmCompleteDialog.test.tsx
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/components/SwarmCompleteDialog.test.tsx
git commit -m "test: full coverage for SwarmCompleteDialog — rendering, callbacks, task counts"
```

---

## Task 5: SplitView Component Tests

**Files:**
- Create: `tests/components/SplitView.test.tsx`
- Reference: `src/renderer/src/components/SplitView/SplitView.tsx`

SplitView is a thin wrapper around PaneRenderer. Mock PaneRenderer and the store; test the three code paths: no pane tree, pane tree present, ratio change propagation.

- [ ] **Step 1: Write the tests**

Create `tests/components/SplitView.test.tsx`:

```typescript
import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PaneNode } from '../../src/renderer/src/types'

// Mock PaneRenderer — it requires live xterm instances
vi.mock('../../src/renderer/src/components/SplitView/PaneRenderer', () => ({
  PaneRenderer: vi.fn(({ node, onSplitRatioChange }: { node: PaneNode; onSplitRatioChange: Function }) => (
    <div data-testid="pane-renderer" data-node-type={node.type}>
      <button onClick={() => onSplitRatioChange([0], 0.7)}>change-ratio</button>
    </div>
  )),
}))

// Mock the store
vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: vi.fn(),
}))

import { SplitView } from '../../src/renderer/src/components/SplitView/SplitView'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'

const mockSetPaneTree = vi.fn()

function setupStore(paneTree: PaneNode | null) {
  ;(useTerminalStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: Function) => {
    const state = { paneTree, setPaneTree: mockSetPaneTree }
    return selector(state)
  })
}

describe('SplitView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows empty state message when paneTree is null', () => {
    setupStore(null)
    render(<SplitView />)
    expect(screen.getByText(/No terminals open/)).toBeInTheDocument()
    expect(screen.getByText('+ Add Terminal')).toBeInTheDocument()
  })

  it('renders PaneRenderer when paneTree is set', () => {
    const tree: PaneNode = { type: 'terminal', terminalId: 'term-1' }
    setupStore(tree)
    render(<SplitView />)
    expect(screen.getByTestId('pane-renderer')).toBeInTheDocument()
  })

  it('passes the pane tree node to PaneRenderer', () => {
    const tree: PaneNode = { type: 'terminal', terminalId: 'term-1' }
    setupStore(tree)
    render(<SplitView />)
    expect(screen.getByTestId('pane-renderer').dataset.nodeType).toBe('terminal')
  })

  it('calls setPaneTree with updated ratio when onSplitRatioChange fires', () => {
    const tree: PaneNode = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        { type: 'terminal', terminalId: 't1' },
        { type: 'terminal', terminalId: 't2' },
      ],
    }
    setupStore(tree)
    render(<SplitView />)
    screen.getByText('change-ratio').click()
    expect(mockSetPaneTree).toHaveBeenCalledWith(
      expect.objectContaining({ ratio: 0.7 })
    )
  })

  it('does not render PaneRenderer in the empty state', () => {
    setupStore(null)
    render(<SplitView />)
    expect(screen.queryByTestId('pane-renderer')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run and verify tests pass**

```bash
npx vitest run tests/components/SplitView.test.tsx
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/components/SplitView.test.tsx
git commit -m "test: SplitView — empty state, pane rendering, ratio change propagation"
```

---

## Task 6: IPC Bridge Contract Tests

**Files:**
- Create: `tests/electron/ipcBridge.test.ts`
- Reference: `src/preload/index.ts`

These tests verify the preload script's contract: that each `window.termpolis`, `window.swarmAPI`, and `window.globalEvents` method calls the correct IPC channel with the correct arguments. Run in Node environment (electron test context). Mock `electron` to capture `contextBridge.exposeInMainWorld` calls and verify individual method behavior.

- [ ] **Step 1: Write the tests**

Create `tests/electron/ipcBridge.test.ts`:

```typescript
import { describe, it, expect, vi, beforeAll } from 'vitest'

// Capture what contextBridge.exposeInMainWorld registers
const exposed: Record<string, any> = {}
const mockInvoke = vi.fn().mockResolvedValue({ success: true })
const mockSend = vi.fn()
const mockOn = vi.fn().mockReturnValue(undefined)
const mockRemoveListener = vi.fn()

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: any) => {
      exposed[key] = api
    },
  },
  ipcRenderer: {
    invoke: mockInvoke,
    send: mockSend,
    on: mockOn,
    removeListener: mockRemoveListener,
  },
}))

// Import the preload as a side effect — it calls exposeInMainWorld on load
beforeAll(async () => {
  await import('../../src/preload/index')
})

// ---------------------------------------------------------------------------
// window.termpolis (TermpolisAPI)
// ---------------------------------------------------------------------------
describe('window.termpolis IPC channels', () => {
  it('createTerminal invokes terminal:create', async () => {
    await exposed.termpolis.createTerminal('id-1', 'bash', '/tmp', [])
    expect(mockInvoke).toHaveBeenCalledWith('terminal:create', {
      id: 'id-1', shellType: 'bash', cwd: '/tmp', extraPaths: [],
    })
  })

  it('killTerminal invokes terminal:kill', async () => {
    await exposed.termpolis.killTerminal('id-1')
    expect(mockInvoke).toHaveBeenCalledWith('terminal:kill', { id: 'id-1' })
  })

  it('writeToTerminal sends terminal:write', () => {
    exposed.termpolis.writeToTerminal('id-1', 'ls -la\r')
    expect(mockSend).toHaveBeenCalledWith('terminal:write', { id: 'id-1', data: 'ls -la\r' })
  })

  it('resizeTerminal sends terminal:resize', () => {
    exposed.termpolis.resizeTerminal('id-1', 80, 24)
    expect(mockSend).toHaveBeenCalledWith('terminal:resize', { id: 'id-1', cols: 80, rows: 24 })
  })

  it('readTerminalBuffer invokes terminal:read-buffer', async () => {
    await exposed.termpolis.readTerminalBuffer('id-1', 100)
    expect(mockInvoke).toHaveBeenCalledWith('terminal:read-buffer', {
      terminalId: 'id-1', fromOffset: 100,
    })
  })

  it('getAvailableShells invokes shell:available', async () => {
    await exposed.termpolis.getAvailableShells()
    expect(mockInvoke).toHaveBeenCalledWith('shell:available')
  })

  it('readConfigFile invokes config:read', async () => {
    await exposed.termpolis.readConfigFile('/path/to/file')
    expect(mockInvoke).toHaveBeenCalledWith('config:read', { filePath: '/path/to/file' })
  })

  it('writeConfigFile invokes config:write', async () => {
    await exposed.termpolis.writeConfigFile('/path/to/file', 'content')
    expect(mockInvoke).toHaveBeenCalledWith('config:write', {
      filePath: '/path/to/file', content: 'content',
    })
  })

  it('getHomedir invokes fs:homedir', async () => {
    await exposed.termpolis.getHomedir()
    expect(mockInvoke).toHaveBeenCalledWith('fs:homedir')
  })

  it('detectAgents invokes agents:detect', async () => {
    await exposed.termpolis.detectAgents()
    expect(mockInvoke).toHaveBeenCalledWith('agents:detect')
  })

  it('pickDirectory invokes dialog:pick-directory', async () => {
    await exposed.termpolis.pickDirectory('/default')
    expect(mockInvoke).toHaveBeenCalledWith('dialog:pick-directory', { defaultPath: '/default' })
  })

  it('appendHistory sends history:append', () => {
    exposed.termpolis.appendHistory('t1', 'Main', 'git status')
    expect(mockSend).toHaveBeenCalledWith('history:append', {
      terminalId: 't1', terminalName: 'Main', command: 'git status',
    })
  })

  it('searchHistory invokes history:search', async () => {
    await exposed.termpolis.searchHistory('git')
    expect(mockInvoke).toHaveBeenCalledWith('history:search', { query: 'git' })
  })

  it('onTerminalData registers terminal:data listener and returns unsubscribe', () => {
    const cb = vi.fn()
    const unsub = exposed.termpolis.onTerminalData(cb)
    expect(mockOn).toHaveBeenCalledWith('terminal:data', expect.any(Function))
    expect(typeof unsub).toBe('function')
    unsub()
    expect(mockRemoveListener).toHaveBeenCalledWith('terminal:data', expect.any(Function))
  })

  it('getTerminalStatus invokes terminal:status', async () => {
    await exposed.termpolis.getTerminalStatus('t1', '/cwd')
    expect(mockInvoke).toHaveBeenCalledWith('terminal:status', {
      terminalId: 't1', fallbackCwd: '/cwd',
    })
  })

  it('getGitInfo invokes terminal:git-info', async () => {
    await exposed.termpolis.getGitInfo('/repo')
    expect(mockInvoke).toHaveBeenCalledWith('terminal:git-info', { cwd: '/repo' })
  })

  it('getGitDiff invokes terminal:git-diff', async () => {
    await exposed.termpolis.getGitDiff('/repo')
    expect(mockInvoke).toHaveBeenCalledWith('terminal:git-diff', { cwd: '/repo' })
  })
})

// ---------------------------------------------------------------------------
// window.swarmAPI
// ---------------------------------------------------------------------------
describe('window.swarmAPI IPC channels', () => {
  it('getMessages invokes swarm:messages', async () => {
    await exposed.swarmAPI.getMessages()
    expect(mockInvoke).toHaveBeenCalledWith('swarm:messages')
  })

  it('getTasks invokes swarm:tasks', async () => {
    await exposed.swarmAPI.getTasks()
    expect(mockInvoke).toHaveBeenCalledWith('swarm:tasks')
  })

  it('sendMessage invokes swarm:send-message with correct params', async () => {
    await exposed.swarmAPI.sendMessage('conductor', 'all', 'info', 'hello')
    expect(mockInvoke).toHaveBeenCalledWith('swarm:send-message', {
      from: 'conductor', to: 'all', type: 'info', content: 'hello',
    })
  })

  it('createTask invokes swarm:create-task', async () => {
    await exposed.swarmAPI.createTask('Build feature', 'desc', 'conductor', 'agent-1')
    expect(mockInvoke).toHaveBeenCalledWith('swarm:create-task', {
      title: 'Build feature', description: 'desc',
      createdBy: 'conductor', assignTo: 'agent-1',
    })
  })

  it('updateTask invokes swarm:update-task', async () => {
    await exposed.swarmAPI.updateTask('task-1', 'completed', 'done')
    expect(mockInvoke).toHaveBeenCalledWith('swarm:update-task', {
      taskId: 'task-1', status: 'completed', result: 'done',
    })
  })

  it('clear invokes swarm:clear', async () => {
    await exposed.swarmAPI.clear()
    expect(mockInvoke).toHaveBeenCalledWith('swarm:clear')
  })
})

// ---------------------------------------------------------------------------
// window.globalEvents
// ---------------------------------------------------------------------------
describe('window.globalEvents IPC channels', () => {
  it('onToggleSwarm registers global:toggle-swarm listener', () => {
    const cb = vi.fn()
    const unsub = exposed.globalEvents.onToggleSwarm(cb)
    expect(mockOn).toHaveBeenCalledWith('global:toggle-swarm', expect.any(Function))
    expect(typeof unsub).toBe('function')
  })

  it('onNewTerminal registers global:new-terminal listener', () => {
    exposed.globalEvents.onNewTerminal(vi.fn())
    expect(mockOn).toHaveBeenCalledWith('global:new-terminal', expect.any(Function))
  })

  it('onConfirmClose registers app:confirm-close listener', () => {
    exposed.globalEvents.onConfirmClose(vi.fn())
    expect(mockOn).toHaveBeenCalledWith('app:confirm-close', expect.any(Function))
  })

  it('forceClose sends app:force-close', () => {
    exposed.globalEvents.forceClose()
    expect(mockSend).toHaveBeenCalledWith('app:force-close')
  })

  it('unsubscribe function removes the correct listener', () => {
    const cb = vi.fn()
    const unsub = exposed.globalEvents.onToggleSwarm(cb)
    unsub()
    expect(mockRemoveListener).toHaveBeenCalledWith('global:toggle-swarm', expect.any(Function))
  })
})

// ---------------------------------------------------------------------------
// window.windowControls
// ---------------------------------------------------------------------------
describe('window.windowControls IPC channels', () => {
  it('minimize sends window:minimize', () => {
    exposed.windowControls.minimize()
    expect(mockSend).toHaveBeenCalledWith('window:minimize')
  })

  it('maximize sends window:maximize', () => {
    exposed.windowControls.maximize()
    expect(mockSend).toHaveBeenCalledWith('window:maximize')
  })

  it('close sends window:close', () => {
    exposed.windowControls.close()
    expect(mockSend).toHaveBeenCalledWith('window:close')
  })
})

// ---------------------------------------------------------------------------
// window.mcpEvents
// ---------------------------------------------------------------------------
describe('window.mcpEvents IPC channels', () => {
  it('onTerminalCreated registers mcp:terminal-created listener', () => {
    exposed.mcpEvents.onTerminalCreated(vi.fn())
    expect(mockOn).toHaveBeenCalledWith('mcp:terminal-created', expect.any(Function))
  })

  it('onTerminalClosed registers mcp:terminal-closed listener', () => {
    exposed.mcpEvents.onTerminalClosed(vi.fn())
    expect(mockOn).toHaveBeenCalledWith('mcp:terminal-closed', expect.any(Function))
  })
})
```

- [ ] **Step 2: Run and verify tests pass**

```bash
npx vitest run tests/electron/ipcBridge.test.ts
```

Expected: all tests pass. If you see `exposed` as empty (module cached from a prior run), add `vi.resetModules()` before the `await import(...)` line inside `beforeAll` — not in `beforeEach`, which would clear `exposed` after it's populated.

- [ ] **Step 3: Commit**

```bash
git add tests/electron/ipcBridge.test.ts
git commit -m "test: IPC bridge contract — verify all channels and params for termpolis/swarmAPI/globalEvents"
```

---

## Task 7: Final Coverage Check and Cleanup

- [ ] **Step 1: Run full test suite with coverage**

```bash
npm run test:coverage 2>&1
```

Review the output. If any individual file is below 80%, identify which branches/lines are uncovered and add targeted tests.

- [ ] **Step 2: Fix any sessionRecorder timing test if flaky**

If the `formatDuration` test is timing-sensitive, pin `Date.now`:

```typescript
it('formats duration in minutes and seconds', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  const rec = createSessionRecorder('T', 'bash')
  vi.setSystemTime(new Date('2026-01-01T00:01:30Z'))
  appendEntry(rec, 'output', 'done')
  const out = formatRecording(rec)
  expect(out).toMatch(/1m \d+s/)
  vi.useRealTimers()
})
```

- [ ] **Step 3: Verify 90% threshold passes**

```bash
npm run test:coverage 2>&1 | grep -E "All files|Threshold"
```

Expected: no threshold violations.

- [ ] **Step 4: Run E2E smoke check (optional but recommended)**

```bash
npm run test:e2e -- --project=chromium e2e/app.spec.ts
```

Expected: basic app tests pass (verifies E2E infrastructure is wired up).

- [ ] **Step 5: Final commit**

```bash
git add package.json vitest.config.ts
git commit -m "test: all coverage gaps filled — swarmBridgeManager, sessionRecorder, SwarmCompleteDialog, SplitView, IPC bridge; 90% threshold passing"
git push
```

---

## Summary

| Task | New Tests | File |
|------|-----------|------|
| 1 | Coverage config | vitest.config.ts |
| 2 | ~12 tests | swarmBridgeManager.test.ts |
| 3 | ~15 tests | sessionRecorder.test.ts |
| 4 | ~14 tests | SwarmCompleteDialog.test.tsx |
| 5 | ~5 tests | SplitView.test.tsx |
| 6 | ~25 tests | ipcBridge.test.ts |
| **Total** | **~71 new tests** | |

Expected final count: ~463 tests, ≥90% line coverage across all included files.
