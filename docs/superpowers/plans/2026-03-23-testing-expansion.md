# Testing Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ~200 new tests (60 unit + 140 E2E) with mock agent infrastructure for comprehensive feature coverage.

**Architecture:** Mock agent scripts (Node.js) simulate AI agent startup, trust prompts, and swarm participation. A `testAgents.ts` helper centralizes command swapping when `TERMPOLIS_TEST_AGENTS=1`. Unit tests cover 8 untested renderer lib modules. E2E tests cover 10 feature areas using Playwright with Electron.

**Tech Stack:** Vitest (unit), Playwright (E2E), Node.js mock scripts, Electron launch API

**Spec:** `docs/superpowers/specs/2026-03-23-testing-expansion-design.md`

---

## Phase 1: Infrastructure (Tasks 1-3)

### Task 1: Create Mock Agent Scripts

**Files:**
- Create: `e2e/mocks/mock-claude.js`
- Create: `e2e/mocks/mock-codex.js`
- Create: `e2e/mocks/mock-gemini.js`
- Create: `e2e/mocks/mock-aider.js`

- [ ] **Step 1: Create mock-claude.js**

```js
// e2e/mocks/mock-claude.js
const readline = require('readline')
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })

// Simulate Claude Code startup with trust prompt
console.log('')
console.log(' Accessing workspace:')
console.log('')
console.log(' ' + process.cwd())
console.log('')
console.log(' Quick safety check: Is this a project you created or one you trust?')
console.log(' Claude Code\'ll be able to read, edit, and execute files here.')
console.log('')
console.log(' > 1. Yes, I trust this folder')
console.log('   2. No, exit')
console.log('')
console.log(' Enter to confirm')

// Wait for trust confirmation
rl.once('line', () => {
  console.log('')
  console.log('  Claude Code v1.0.0 (mock)')
  console.log('  Model: claude-opus-4-6')
  console.log('')
  process.stdout.write('claude> ')

  rl.on('line', (line) => {
    const cmd = line.trim()
    if (cmd === 'exit' || cmd === '/exit') {
      console.log('Goodbye!')
      process.exit(0)
    }
    // Canned response for swarm task prompts
    if (cmd.includes('swarm') || cmd.includes('Your role')) {
      console.log('Working on assigned task...')
      console.log('Claude Code processing...')
    } else if (cmd) {
      console.log(`I'll help with: ${cmd}`)
    }
    process.stdout.write('claude> ')
  })
})

rl.on('close', () => process.exit(0))
```

- [ ] **Step 2: Create mock-codex.js**

```js
// e2e/mocks/mock-codex.js
const readline = require('readline')
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })

console.log('')
console.log('OpenAI Codex v0.1 (mock)')
console.log('')
console.log('Do you trust this directory? [Y/n]')

rl.once('line', () => {
  console.log('')
  console.log('Codex ready.')
  console.log('')
  process.stdout.write('codex> ')

  rl.on('line', (line) => {
    const cmd = line.trim()
    if (cmd === 'exit') { process.exit(0) }
    if (cmd.includes('swarm') || cmd.includes('Your role')) {
      console.log('Codex working on task...')
    } else if (cmd) {
      console.log(`Processing: ${cmd}`)
    }
    process.stdout.write('codex> ')
  })
})

rl.on('close', () => process.exit(0))
```

- [ ] **Step 3: Create mock-gemini.js**

```js
// e2e/mocks/mock-gemini.js
const readline = require('readline')

// Simulate slower startup
setTimeout(() => {
  console.log('')
  console.log('Gemini CLI v0.1 (mock)')
  console.log('Welcome to Gemini!')
  console.log('')
  process.stdout.write('gemini> ')

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })
  rl.on('line', (line) => {
    const cmd = line.trim()
    if (cmd === 'exit') { process.exit(0) }
    if (cmd.includes('swarm') || cmd.includes('Your role')) {
      console.log('Gemini working on task...')
    } else if (cmd) {
      console.log(`Gemini response: ${cmd}`)
    }
    process.stdout.write('gemini> ')
  })
  rl.on('close', () => process.exit(0))
}, 500)
```

- [ ] **Step 4: Create mock-aider.js**

```js
// e2e/mocks/mock-aider.js
const readline = require('readline')
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })

console.log('Aider v0.86.2 (mock)')
console.log('Model: ollama/qwen3-coder with whole edit format')
console.log('Git repo: .')
console.log('Repo-map: disabled')
console.log('')
process.stdout.write('aider> ')

rl.on('line', (line) => {
  const cmd = line.trim()
  if (cmd === '/exit' || cmd === 'exit') { process.exit(0) }
  if (cmd.includes('swarm') || cmd.includes('Your role')) {
    console.log('Aider working on task...')
    console.log('done')
  } else if (cmd) {
    console.log(`Editing files for: ${cmd}`)
  }
  process.stdout.write('aider> ')
})

rl.on('close', () => process.exit(0))
```

- [ ] **Step 5: Verify mock scripts run**

Run: `node e2e/mocks/mock-claude.js < /dev/null`
Expected: Prints trust prompt then exits on EOF

- [ ] **Step 6: Commit**

```bash
git add e2e/mocks/
git commit -m "test: add mock agent scripts for E2E testing"
```

---

### Task 2: Create testAgents Helper

**Files:**
- Create: `src/renderer/src/lib/testAgents.ts`

- [ ] **Step 1: Create the helper module**

```ts
// src/renderer/src/lib/testAgents.ts
const TEST_AGENT_MAP: Record<string, string> = {
  'claude': 'node e2e/mocks/mock-claude.js',
  'codex': 'node e2e/mocks/mock-codex.js',
  'gemini': 'node e2e/mocks/mock-gemini.js',
  'aider --model ollama/qwen3-coder --no-show-model-warnings': 'node e2e/mocks/mock-aider.js',
}

export function resolveAgentCommand(command: string): string {
  if (typeof process !== 'undefined' && process.env?.TERMPOLIS_TEST_AGENTS === '1') {
    return TEST_AGENT_MAP[command] ?? command
  }
  return command
}

export function testDelay(ms: number): number {
  if (typeof process !== 'undefined' && process.env?.TERMPOLIS_TEST_TIMING === '1') {
    return Math.max(Math.round(ms / 10), 50)
  }
  return ms
}
```

- [ ] **Step 2: Wire into AIProfiles.tsx sidebar launch**

In `src/renderer/src/components/Sidebar/AIProfiles.tsx`, import and use:
```ts
import { resolveAgentCommand, testDelay } from '../../lib/testAgents'
```
Replace `window.termpolis.writeToTerminal(id, profile.command + '\r')` with:
```ts
window.termpolis.writeToTerminal(id, resolveAgentCommand(profile.command) + '\r')
```
Replace all `setTimeout` delay literals with `testDelay(N)`.

- [ ] **Step 3: Wire into App.tsx (welcome, command palette, session restore)**

Same pattern — import `resolveAgentCommand` and `testDelay`, apply to all agent command writes and setTimeout delays.

- [ ] **Step 4: Wire into StartSwarmModal.tsx**

Same pattern for swarm agent launches.

- [ ] **Step 5: Verify app still works in normal mode**

Run: `npm run dev` and launch a terminal. Ensure no behavior change when env vars are not set.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/lib/testAgents.ts src/renderer/src/components/Sidebar/AIProfiles.tsx src/renderer/src/App.tsx src/renderer/src/components/SwarmDashboard/StartSwarmModal.tsx
git commit -m "feat: add test agent command resolver and timing helpers"
```

---

### Task 3: Update Playwright Config

**Files:**
- Modify: `playwright.config.ts`

- [ ] **Step 1: Update config with test env vars and timeouts**

```ts
export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  retries: 0,
  use: {
    trace: 'on-first-retry',
  },
})
```

Increase default timeout to 60s for agent tests.

- [ ] **Step 2: Commit**

```bash
git add playwright.config.ts
git commit -m "test: increase Playwright timeout to 60s for agent E2E tests"
```

---

## Phase 2: Unit Tests (Tasks 4-11)

### Task 4: agentDetector Unit Tests

**Files:**
- Create: `tests/renderer/agentDetector.test.ts`
- Reference: `src/renderer/src/lib/agentDetector.ts`

- [ ] **Step 1: Write 10 tests**

```ts
import { describe, it, expect } from 'vitest'
import { detectAgent } from '../../src/renderer/src/lib/agentDetector'

describe('detectAgent', () => {
  it('detects Claude Code from output', () => {
    expect(detectAgent('Welcome to Claude Code v1.0')).toEqual(
      expect.objectContaining({ name: 'Claude Code' })
    )
  })

  it('detects Claude from anthropic keyword', () => {
    expect(detectAgent('Powered by Anthropic')).toEqual(
      expect.objectContaining({ name: 'Claude Code' })
    )
  })

  it('detects Codex from output', () => {
    expect(detectAgent('OpenAI Codex ready')).toEqual(
      expect.objectContaining({ name: 'Codex' })
    )
  })

  it('detects Gemini from output', () => {
    expect(detectAgent('Gemini CLI starting')).toEqual(
      expect.objectContaining({ name: 'Gemini CLI' })
    )
  })

  it('detects Aider from output', () => {
    expect(detectAgent('Aider v0.86.2')).toEqual(
      expect.objectContaining({ name: 'Aider' })
    )
  })

  it('returns null for regular shell output', () => {
    expect(detectAgent('$ ls -la\ntotal 42')).toBeNull()
  })

  it('returns null for empty output', () => {
    expect(detectAgent('')).toBeNull()
  })

  it('returns correct AgentInfo fields for Claude', () => {
    const result = detectAgent('claude')!
    expect(result).toHaveProperty('name')
    expect(result).toHaveProperty('icon')
    expect(result).toHaveProperty('color')
  })

  it('is case-insensitive', () => {
    expect(detectAgent('CLAUDE')).not.toBeNull()
    expect(detectAgent('CODEX')).not.toBeNull()
  })

  it('detects first matching agent only', () => {
    const result = detectAgent('Claude and Codex running')
    expect(result?.name).toBe('Claude Code')
  })
})
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/renderer/agentDetector.test.ts`
Expected: 10 tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/renderer/agentDetector.test.ts
git commit -m "test: add agentDetector unit tests (10 tests)"
```

---

### Task 5: costTracker Unit Tests

**Files:**
- Create: `tests/renderer/costTracker.test.ts`
- Reference: `src/renderer/src/lib/costTracker.ts`

- [ ] **Step 1: Write 6 tests**

```ts
import { describe, it, expect } from 'vitest'
import { parseCostFromOutput, formatTokens } from '../../src/renderer/src/lib/costTracker'

describe('parseCostFromOutput', () => {
  it('parses cost from dollar amount', () => {
    const result = parseCostFromOutput('Total cost: $0.42')
    expect(result?.estimatedCost).toBe(0.42)
  })

  it('parses token count', () => {
    const result = parseCostFromOutput('Used 1,500 tokens')
    expect(result?.tokensIn).toBe(1500)
  })

  it('returns null for output without cost info', () => {
    expect(parseCostFromOutput('Hello world')).toBeNull()
  })

  it('handles partial cost info (tokens without dollar)', () => {
    const result = parseCostFromOutput('500 tokens used')
    expect(result?.tokensIn).toBeDefined()
    expect(result?.estimatedCost).toBeUndefined()
  })

  it('includes lastUpdated timestamp', () => {
    const result = parseCostFromOutput('cost $1.00')
    expect(result?.lastUpdated).toBeGreaterThan(0)
  })
})

describe('formatTokens', () => {
  it('formats millions', () => {
    expect(formatTokens(1500000)).toMatch(/1\.5M/)
  })
})
```

- [ ] **Step 2: Run and commit**

Run: `npx vitest run tests/renderer/costTracker.test.ts`

```bash
git add tests/renderer/costTracker.test.ts
git commit -m "test: add costTracker unit tests (6 tests)"
```

---

### Task 6: conversationParser Unit Tests

**Files:**
- Create: `tests/renderer/conversationParser.test.ts`
- Reference: `src/renderer/src/lib/conversationParser.ts`

- [ ] **Step 1: Write 8 tests**

```ts
import { describe, it, expect } from 'vitest'
import { parseConversation } from '../../src/renderer/src/lib/conversationParser'

describe('parseConversation', () => {
  it('parses user turn from > prompt', () => {
    const turns = parseConversation('> hello world', 't1', 'Terminal', 'Claude')
    expect(turns.length).toBeGreaterThan(0)
    expect(turns[0].role).toBe('user')
  })

  it('parses user turn from $ prompt', () => {
    const turns = parseConversation('$ echo hello', 't1', 'Terminal', 'Claude')
    expect(turns.some(t => t.role === 'user')).toBe(true)
  })

  it('parses user turn from Human: prefix', () => {
    const turns = parseConversation('Human: what is this?', 't1', 'Terminal', 'Claude')
    expect(turns.some(t => t.role === 'user')).toBe(true)
  })

  it('handles multi-line content', () => {
    const output = '> fix the bug\nAssistant: I found the issue.\nThe problem is in line 42.'
    const turns = parseConversation(output, 't1', 'Term', 'Claude')
    expect(turns.length).toBeGreaterThanOrEqual(1)
  })

  it('returns correct turn structure', () => {
    const turns = parseConversation('> test', 't1', 'Term1', 'Claude')
    if (turns.length > 0) {
      expect(turns[0]).toHaveProperty('role')
      expect(turns[0]).toHaveProperty('content')
      expect(turns[0]).toHaveProperty('timestamp')
      expect(turns[0]).toHaveProperty('terminalId', 't1')
      expect(turns[0]).toHaveProperty('terminalName', 'Term1')
      expect(turns[0]).toHaveProperty('agentName', 'Claude')
    }
  })

  it('returns empty array for empty output', () => {
    expect(parseConversation('', 't1', 'Term', 'Claude')).toEqual([])
  })

  it('strips ANSI codes before parsing', () => {
    const output = '\x1b[32m> \x1b[0mhello'
    const turns = parseConversation(output, 't1', 'Term', 'Claude')
    expect(turns.length).toBeGreaterThan(0)
  })

  it('attaches agent name to all turns', () => {
    const turns = parseConversation('> question\nAssistant: answer', 't1', 'Term', 'TestAgent')
    turns.forEach(t => expect(t.agentName).toBe('TestAgent'))
  })
})
```

- [ ] **Step 2: Run and commit**

Run: `npx vitest run tests/renderer/conversationParser.test.ts`

```bash
git add tests/renderer/conversationParser.test.ts
git commit -m "test: add conversationParser unit tests (8 tests)"
```

---

### Task 7: promptParser Unit Tests

**Files:**
- Create: `tests/renderer/promptParser.test.ts`
- Reference: `src/renderer/src/lib/promptParser.ts`

- [ ] **Step 1: Write 6 tests**

```ts
import { describe, it, expect } from 'vitest'
import { parsePromptFromOutput } from '../../src/renderer/src/lib/promptParser'

describe('parsePromptFromOutput', () => {
  it('extracts cwd from Git Bash prompt', () => {
    const result = parsePromptFromOutput('MINGW64 ~/repos/termpolis (main)\n$ ', 'gitbash')
    expect(result.cwd).toContain('repos/termpolis')
  })

  it('extracts git branch from Git Bash prompt', () => {
    const result = parsePromptFromOutput('MINGW64 ~/repos/termpolis (feature-branch)\n$ ', 'gitbash')
    expect(result.gitBranch).toBe('feature-branch')
  })

  it('extracts cwd from PowerShell prompt', () => {
    const result = parsePromptFromOutput('PS C:\\Users\\David\\repos> ', 'powershell')
    expect(result.cwd).toContain('C:\\Users\\David\\repos')
  })

  it('handles prompt without git branch', () => {
    const result = parsePromptFromOutput('~/repos $ ', 'bash')
    expect(result.gitBranch).toBeNull()
  })

  it('handles Windows-style paths', () => {
    const result = parsePromptFromOutput('PS C:\\Users\\Test\\Project> ', 'powershell')
    expect(result.cwd).toMatch(/C:\\/)
  })

  it('returns nulls for unrecognized output', () => {
    const result = parsePromptFromOutput('just some random text', 'bash')
    expect(result.cwd).toBeNull()
    expect(result.gitBranch).toBeNull()
  })
})
```

- [ ] **Step 2: Run and commit**

Run: `npx vitest run tests/renderer/promptParser.test.ts`

```bash
git add tests/renderer/promptParser.test.ts
git commit -m "test: add promptParser unit tests (6 tests)"
```

---

### Task 8: pollingService Unit Tests

**Files:**
- Create: `tests/renderer/pollingService.test.ts`
- Reference: `src/renderer/src/lib/pollingService.ts`

- [ ] **Step 1: Write 5 tests**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { subscribe, unsubscribe } from '../../src/renderer/src/lib/pollingService'

describe('pollingService', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('subscribe registers a callback', () => {
    const cb = vi.fn()
    subscribe('test-1', cb, 2000)
    vi.advanceTimersByTime(3000)
    expect(cb).toHaveBeenCalled()
    unsubscribe('test-1')
  })

  it('callback fires at specified interval', () => {
    const cb = vi.fn()
    subscribe('test-2', cb, 2000)
    vi.advanceTimersByTime(5000)
    expect(cb.mock.calls.length).toBeGreaterThanOrEqual(2)
    unsubscribe('test-2')
  })

  it('unsubscribe stops polling', () => {
    const cb = vi.fn()
    subscribe('test-3', cb, 1000)
    vi.advanceTimersByTime(1500)
    const count = cb.mock.calls.length
    unsubscribe('test-3')
    vi.advanceTimersByTime(3000)
    expect(cb.mock.calls.length).toBe(count)
  })

  it('supports multiple subscribers', () => {
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    subscribe('a', cb1, 1000)
    subscribe('b', cb2, 2000)
    vi.advanceTimersByTime(4000)
    expect(cb1.mock.calls.length).toBeGreaterThan(cb2.mock.calls.length)
    unsubscribe('a')
    unsubscribe('b')
  })

  it('handles unsubscribe of non-existent id', () => {
    expect(() => unsubscribe('nonexistent')).not.toThrow()
  })
})
```

- [ ] **Step 2: Run and commit**

Run: `npx vitest run tests/renderer/pollingService.test.ts`

```bash
git add tests/renderer/pollingService.test.ts
git commit -m "test: add pollingService unit tests (5 tests)"
```

---

### Task 9: taskAnalyzer Unit Tests

**Files:**
- Create: `tests/renderer/taskAnalyzer.test.ts`
- Reference: `src/renderer/src/lib/taskAnalyzer.ts`

- [ ] **Step 1: Write 8 tests**

```ts
import { describe, it, expect } from 'vitest'
import { analyzeTask } from '../../src/renderer/src/lib/taskAnalyzer'

describe('analyzeTask', () => {
  it('decomposes multi-part task', () => {
    const result = analyzeTask('Refactor the auth module, write tests, and update documentation')
    expect(result.subtasks.length).toBeGreaterThanOrEqual(2)
  })

  it('categorizes refactoring tasks', () => {
    const result = analyzeTask('Refactor the login component')
    expect(result.subtasks.some(s => s.category === 'refactoring')).toBe(true)
  })

  it('categorizes testing tasks', () => {
    const result = analyzeTask('Write unit tests for the parser')
    expect(result.subtasks.some(s => s.category === 'testing')).toBe(true)
  })

  it('categorizes documentation tasks', () => {
    const result = analyzeTask('Document the API endpoints')
    expect(result.subtasks.some(s => s.category === 'documentation')).toBe(true)
  })

  it('handles single-focus task', () => {
    const result = analyzeTask('Fix the login bug')
    expect(result.subtasks.length).toBeGreaterThanOrEqual(1)
  })

  it('returns subtasks with required fields', () => {
    const result = analyzeTask('Review code for security issues')
    result.subtasks.forEach(s => {
      expect(s).toHaveProperty('title')
      expect(s).toHaveProperty('description')
      expect(s).toHaveProperty('category')
      expect(s).toHaveProperty('complexity')
      expect(s).toHaveProperty('tokenIntensity')
    })
  })

  it('clamps complexity to 1-5 range', () => {
    const result = analyzeTask('Simple quick fix')
    result.subtasks.forEach(s => {
      expect(s.complexity).toBeGreaterThanOrEqual(1)
      expect(s.complexity).toBeLessThanOrEqual(5)
    })
  })

  it('creates fallback subtask for vague input', () => {
    const result = analyzeTask('do stuff')
    expect(result.subtasks.length).toBeGreaterThanOrEqual(1)
  })
})
```

- [ ] **Step 2: Run and commit**

Run: `npx vitest run tests/renderer/taskAnalyzer.test.ts`

```bash
git add tests/renderer/taskAnalyzer.test.ts
git commit -m "test: add taskAnalyzer unit tests (8 tests)"
```

---

### Task 10: swarmBridge Unit Tests

**Files:**
- Create: `tests/renderer/swarmBridge.test.ts`
- Reference: `src/renderer/src/lib/swarmBridge.ts`

- [ ] **Step 1: Write 9 tests**

```ts
import { describe, it, expect } from 'vitest'
import { detectSwarmSignals, formatIncomingMessage } from '../../src/renderer/src/lib/swarmBridge'

describe('detectSwarmSignals', () => {
  it('detects result signal from "done" keyword', () => {
    const result = detectSwarmSignals('Processing... done. All tests pass successfully.', 0)
    expect(result.type).toBe('result')
  })

  it('detects question signal', () => {
    const result = detectSwarmSignals('Should I proceed with the refactor?', 0)
    expect(result.type).toBe('question')
  })

  it('detects error signal', () => {
    const result = detectSwarmSignals('Error: Failed to compile module', 0)
    expect(result.type).toBe('error')
  })

  it('returns null for short output', () => {
    const result = detectSwarmSignals('ok', 0)
    expect(result.type).toBeNull()
  })

  it('returns null for no matching patterns', () => {
    const result = detectSwarmSignals('just typing some code here', 0)
    expect(result.type).toBeNull()
  })

  it('tracks offset correctly', () => {
    const output = 'line 1\nline 2\ndone with task'
    const result = detectSwarmSignals(output, 0)
    expect(result.newOffset).toBe(output.length)
  })

  it('only reads new content from offset', () => {
    const output = 'old stuff\nnew error detected'
    const result = detectSwarmSignals(output, 10)
    expect(result.type).toBe('error')
  })

  it('returns content with signal', () => {
    const result = detectSwarmSignals('Task completed successfully', 0)
    expect(result.content.length).toBeGreaterThan(0)
  })
})

describe('formatIncomingMessage', () => {
  it('formats message with sender name', () => {
    const msg = formatIncomingMessage('Claude', 'Hello from Claude')
    expect(msg).toContain('Claude')
    expect(msg).toContain('Hello from Claude')
  })
})
```

- [ ] **Step 2: Run and commit**

Run: `npx vitest run tests/renderer/swarmBridge.test.ts`

```bash
git add tests/renderer/swarmBridge.test.ts
git commit -m "test: add swarmBridge unit tests (9 tests)"
```

---

### Task 11: contextCapture Unit Tests

**Files:**
- Create: `tests/renderer/contextCapture.test.ts`
- Reference: `src/renderer/src/lib/contextCapture.ts`

- [ ] **Step 1: Write 8 tests**

These require mocking `window.termpolis` IPC calls.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { formatHandoffPrompt } from '../../src/renderer/src/lib/contextCapture'
import type { HandoffContext } from '../../src/renderer/src/lib/contextCapture'

describe('formatHandoffPrompt', () => {
  const baseContext: HandoffContext = {
    task: 'Fix the login bug',
    recentCommands: ['git status', 'npm test'],
    recentOutput: 'FAIL src/auth.test.ts',
    gitDiff: '+fixed the thing\n-old broken thing',
    gitBranch: 'fix/login',
    cwd: '/home/user/project',
    filesModified: ['src/auth.ts', 'src/auth.test.ts'],
    previousAgent: 'Claude Code',
    timestamp: new Date().toISOString(),
  }

  it('includes task description', () => {
    expect(formatHandoffPrompt(baseContext)).toContain('Fix the login bug')
  })

  it('includes cwd', () => {
    expect(formatHandoffPrompt(baseContext)).toContain('/home/user/project')
  })

  it('includes git branch', () => {
    expect(formatHandoffPrompt(baseContext)).toContain('fix/login')
  })

  it('includes recent commands', () => {
    const prompt = formatHandoffPrompt(baseContext)
    expect(prompt).toContain('git status')
  })

  it('includes modified files', () => {
    const prompt = formatHandoffPrompt(baseContext)
    expect(prompt).toContain('src/auth.ts')
  })

  it('includes previous agent name', () => {
    expect(formatHandoffPrompt(baseContext)).toContain('Claude Code')
  })

  it('truncates very long output', () => {
    const longContext = { ...baseContext, recentOutput: 'x'.repeat(5000) }
    const prompt = formatHandoffPrompt(longContext)
    expect(prompt.length).toBeLessThan(5000)
  })

  it('handles empty fields gracefully', () => {
    const minimal: HandoffContext = {
      ...baseContext,
      task: '',
      recentCommands: [],
      gitDiff: '',
      filesModified: [],
    }
    expect(() => formatHandoffPrompt(minimal)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run and commit**

Run: `npx vitest run tests/renderer/contextCapture.test.ts`

```bash
git add tests/renderer/contextCapture.test.ts
git commit -m "test: add contextCapture unit tests (8 tests)"
```

---

## Phase 3: E2E Tests (Tasks 12-21)

Each E2E spec follows the existing pattern: build app, launch Electron, get page, run tests, close.

### Task 12: agent-launch.spec.ts (20 tests)

**Files:**
- Create: `e2e/agent-launch.spec.ts`

- [ ] **Step 1: Write the spec file**

Tests: Launch each agent from sidebar, welcome screen, command palette. Verify directory picker, loading overlay, trust auto-confirmation, agent prompt appears. Cancel directory picker. InstallHint for missing agents.

The spec should set `TERMPOLIS_TEST_AGENTS=1` and `TERMPOLIS_TEST_TIMING=1` in the Electron launch env. Use mock agents. Each test verifies UI state via Playwright selectors.

Key patterns:
- `await page.click('text=Claude Code')` to launch from sidebar
- `await page.waitForSelector('.fixed.inset-0')` to detect loading overlay
- `await page.waitForSelector('text=claude>')` to verify mock agent started
- Check `await page.locator('.download-card').count()` for install hints

- [ ] **Step 2: Run tests**

Run: `npx playwright test e2e/agent-launch.spec.ts`

- [ ] **Step 3: Commit**

```bash
git add e2e/agent-launch.spec.ts
git commit -m "test: add agent launch E2E tests (20 tests)"
```

---

### Task 13: agent-swarm.spec.ts (25 tests)

**Files:**
- Create: `e2e/agent-swarm.spec.ts`

- [ ] **Step 1: Write the spec file**

Tests: Full swarm lifecycle — open dashboard, wizard auto-opens, select 2+ agents, describe task, review routing, launch, verify split panes, task prompts sent, dashboard tabs (agents/tasks/messages), create task, broadcast, update status, clear, health monitoring.

Key patterns:
- Open swarm: `await page.keyboard.press('Control+Shift+S')`
- Select agents: click checkbox buttons in wizard
- Describe task: fill textarea
- Verify split panes: check `.flex-col` and `.flex-row` containers
- Dashboard tabs: click tab buttons, verify content

- [ ] **Step 2: Run and commit**

```bash
git add e2e/agent-swarm.spec.ts
git commit -m "test: add swarm E2E tests (25 tests)"
```

---

### Task 14: session-restore.spec.ts (15 tests)

**Files:**
- Create: `e2e/session-restore.spec.ts`

- [ ] **Step 1: Write the spec file**

Tests: Save session with agent terminals, close and relaunch app, verify terminals restored with correct cwd/name/agent, agent commands re-sent, loading overlay shows, welcome screen during restore, legacy session migration.

Key pattern for restart:
```ts
// Save session state
await page.waitForTimeout(2000) // let debounced save fire
await app.close()
// Relaunch
app = await electron.launch({ args: [...], env: { ...process.env, TERMPOLIS_TEST_AGENTS: '1' } })
page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
```

- [ ] **Step 2: Run and commit**

```bash
git add e2e/session-restore.spec.ts
git commit -m "test: add session restore E2E tests (15 tests)"
```

---

### Task 15: view-switching.spec.ts (15 tests)

**Files:**
- Create: `e2e/view-switching.spec.ts`

- [ ] **Step 1: Write the spec file**

Tests: Switch tabs/split, verify correct content per tab, buffer replay, no trust re-prompt, rapid toggle doesn't freeze, close terminal in each view, grid layouts for 2/3/4 terminals, resize divider.

- [ ] **Step 2: Run and commit**

```bash
git add e2e/view-switching.spec.ts
git commit -m "test: add view switching E2E tests (15 tests)"
```

---

### Task 16: workspaces.spec.ts (12 tests)

**Files:**
- Create: `e2e/workspaces.spec.ts`

- [ ] **Step 1: Write spec — save, restore, rename, delete workspaces**

- [ ] **Step 2: Run and commit**

```bash
git add e2e/workspaces.spec.ts
git commit -m "test: add workspace E2E tests (12 tests)"
```

---

### Task 17: terminal-features.spec.ts (18 tests)

**Files:**
- Create: `e2e/terminal-features.spec.ts`

- [ ] **Step 1: Write spec — copy/paste, context menu, export, pinning, history search, autocomplete, fix banner, font/theme changes, status bar, Alt+N switching, scrollback**

- [ ] **Step 2: Run and commit**

```bash
git add e2e/terminal-features.spec.ts
git commit -m "test: add terminal features E2E tests (18 tests)"
```

---

### Task 18: themes-settings.spec.ts (12 tests)

**Files:**
- Create: `e2e/themes-settings.spec.ts`

- [ ] **Step 1: Write spec — 7 themes, font size/family, accent colors, keybindings, default shell, autocomplete toggle, settings panel, sidebar collapse**

- [ ] **Step 2: Run and commit**

```bash
git add e2e/themes-settings.spec.ts
git commit -m "test: add themes and settings E2E tests (12 tests)"
```

---

### Task 19: mcp-swarm-tools.spec.ts (10 tests)

**Files:**
- Create: `e2e/mcp-swarm-tools.spec.ts`

- [ ] **Step 1: Write spec — MCP health, auth, all 6 swarm tools via HTTP, rate limiting**

- [ ] **Step 2: Run and commit**

```bash
git add e2e/mcp-swarm-tools.spec.ts
git commit -m "test: add MCP swarm tools E2E tests (10 tests)"
```

---

### Task 20: command-palette.spec.ts (8 tests)

**Files:**
- Create: `e2e/command-palette.spec.ts`

- [ ] **Step 1: Write spec — open/close palette, filter, launch agents, new/split terminal**

- [ ] **Step 2: Run and commit**

```bash
git add e2e/command-palette.spec.ts
git commit -m "test: add command palette E2E tests (8 tests)"
```

---

### Task 21: error-resilience.spec.ts (5 tests)

**Files:**
- Create: `e2e/error-resilience.spec.ts`

- [ ] **Step 1: Write spec — ErrorBoundary, close during launch, rapid view switch, close all terminals, MCP restart**

- [ ] **Step 2: Run and commit**

```bash
git add e2e/error-resilience.spec.ts
git commit -m "test: add error resilience E2E tests (5 tests)"
```

---

## Phase 4: Verification (Task 22)

### Task 22: Full Test Suite Verification

- [ ] **Step 1: Run all unit tests**

Run: `npx vitest run`
Expected: All ~290 tests pass (230 existing + 60 new)

- [ ] **Step 2: Run all E2E tests**

Run: `npx playwright test`
Expected: All ~272 tests pass (132 existing + 140 new)

- [ ] **Step 3: Verify no regressions**

Check that existing test files still pass unchanged.

- [ ] **Step 4: Final commit and version bump**

```bash
# Bump patch version
# Update package.json version
git add -A
git commit -m "test: complete testing expansion — 200 new tests, mock agents, full E2E coverage"
```
