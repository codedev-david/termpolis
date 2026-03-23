# Testing Expansion Design

**Date:** 2026-03-23
**Status:** Approved
**Target:** ~200 new tests (60 unit + 140 E2E)

## Problem

Termpolis has 230 unit tests and 132 E2E tests, but coverage gaps exist in the areas that produce the most bugs:
- Agent launch flows (trust prompts, loading overlay, command timing)
- View switching (split/tabs confusion, buffer loss, freezes)
- Session restore (agent re-launch, cwd preservation)
- Swarm execution (wizard, agent coordination, dashboard)
- 29 of 34 React components have no unit tests
- 12 renderer lib modules have no unit tests

## Approach

E2E-heavy with targeted unit tests. Mock agent scripts simulate Claude/Codex/Gemini/Aider for repeatable E2E testing without API keys.

## Mock Agent Infrastructure

### Location
```
e2e/mocks/
  mock-claude.sh
  mock-codex.sh
  mock-gemini.sh
  mock-aider.sh
```

### Behavior
Each mock script simulates the real agent's startup sequence:

**mock-claude.sh:**
- Prints the Claude Code trust prompt (exact text: "Quick safety check", "Yes, I trust this folder")
- Waits for stdin (Enter to confirm trust)
- Prints Claude startup banner with version
- Shows `claude> ` prompt
- Accepts input, returns canned responses
- Responds to swarm task prompts with simulated work output
- Exits on `/exit` or `exit`

**mock-codex.sh:**
- Prints Codex trust/sandbox prompt
- Waits for stdin confirmation
- Prints Codex startup banner
- Shows `codex> ` prompt
- Accepts input, returns canned responses
- Exits on `exit`

**mock-gemini.sh:**
- Prints Gemini CLI welcome (slower startup, ~2s delay with `sleep`)
- Shows `gemini> ` prompt
- Accepts input, returns canned responses
- Exits on `exit`

**mock-aider.sh:**
- Prints Aider startup banner with model info
- Shows `aider> ` prompt
- Accepts input, returns canned responses
- Exits on `/exit`

### Test Mode Activation
Environment variable `TERMPOLIS_TEST_AGENTS=1` switches agent commands:
- `claude` -> `bash e2e/mocks/mock-claude.sh`
- `codex` -> `bash e2e/mocks/mock-codex.sh`
- `gemini` -> `bash e2e/mocks/mock-gemini.sh`
- `aider --model ollama/qwen3-coder --no-show-model-warnings` -> `bash e2e/mocks/mock-aider.sh`

This is checked in the renderer at launch time. The mock path is resolved relative to the app root.

### Swarm Simulation
Mock agents support swarm workflows:
- Accept multi-line task prompts (the swarm wizard sends role/task/coordination messages)
- Output status lines that the agent detector recognizes (e.g., "Claude Code" in output triggers detection)
- Produce periodic output so the swarm health monitor sees them as "running"
- Output swarm-compatible messages that the bridge can parse (for non-MCP agents like Aider)

## E2E Test Plan (~140 tests)

### agent-launch.spec.ts (20 tests)
- Launch Claude from sidebar: directory picker opens, command sent, trust prompt auto-confirmed, agent prompt appears
- Launch Codex from sidebar: same flow with Codex trust
- Launch Gemini from sidebar: 15s overlay, slower startup
- Launch Aider+Qwen from sidebar: 15s overlay, Ollama path injection
- Launch Claude from Welcome screen: directory picker, overlay, trust
- Launch Codex from Welcome screen
- Launch Gemini from Welcome screen
- Launch from command palette (Ctrl+K): each agent type
- Cancel directory picker: no terminal created
- Loading overlay appears and auto-dismisses at correct timing per agent
- Loading overlay click-to-dismiss works
- Agent detection fires (status bar shows agent badge)
- Not-installed agent shows InstallHint modal
- InstallHint shows correct platform-specific instructions (Windows PATH for Ollama)

### agent-swarm.spec.ts (25 tests)
- Open swarm dashboard (Ctrl+Shift+S)
- Swarm wizard auto-opens when no swarm active
- Agent selection step: all 5 agents shown with install status
- Agent selection: checkboxes toggle, minimum 2 required
- Describe task step: textarea, selected agents shown as chips
- Smart routing step: subtasks displayed with scores, agent assignments, token estimates
- Reassign subtask to different agent
- Launch swarm: terminals created in split view
- Loading progress messages shown during launch
- Each agent receives its task prompt
- Swarm dashboard Agents tab shows all agents with health status
- Swarm dashboard Tasks tab shows kanban columns (pending/in-progress/completed)
- Swarm dashboard Messages tab shows chronological message log
- Create new task from dashboard
- Broadcast message to all agents
- Update task status (start, complete, fail)
- Clear swarm: all state reset
- Swarm bridge detects output from non-MCP agents (Aider mock)
- Agent health monitoring: status transitions (starting -> running)
- Close swarm dashboard with Escape
- Reopen dashboard: state preserved
- Multiple agents in split panes: correct layout (grid, not stacked)
- Swarm with 2 agents: horizontal split
- Swarm with 3 agents: grid layout
- Swarm with 4 agents: 2x2 grid

### session-restore.spec.ts (15 tests)
- Save session with 1 agent terminal, restart, verify terminal restored
- Restored terminal has correct cwd from last session
- Restored terminal has correct name, color, shell type
- Restored agent terminal re-sends agent command after 3s
- Restored Claude terminal auto-trusts (Enter at 9s)
- Restored Codex terminal auto-trusts (Enter at 9s)
- Loading overlay shows during restore for agent terminals
- Welcome screen shows while terminals restore in background
- Restore with mixed agent + normal terminals: agents re-launch, normals just open shell
- Restore with no saved terminals: Welcome screen shown, no errors
- Restore preserves viewMode (tabs vs split)
- Restore in split mode rebuilds correct pane tree
- Legacy session (no agentCommand field): infers from terminal name
- Multiple agent terminals restore in parallel
- Workspace restore: all terminals from workspace reopen with correct config

### view-switching.spec.ts (15 tests)
- Switch from tabs to split: all terminals visible in grid
- Switch from split to tabs: correct terminal shown per tab
- Click each tab after switch: shows correct terminal content (no confusion)
- Buffer replay: terminal output preserved after view switch
- No trust re-prompt after view switch (buffer replayed)
- Rapid toggle (tabs->split->tabs->split): no freeze, no errors
- Close terminal in split view: pane removed, others reflow
- Close terminal in tab view: tab removed, next tab activated
- Split view with 2 terminals: side by side
- Split view with 3 terminals: grid layout
- Split view with 4 terminals: 2x2 grid
- Add terminal while in split view: appended to layout
- Resize split panes: drag divider works
- Switch view with active AI agents: agents keep running
- Split view ResizeObserver doesn't cause layout thrashing

### workspaces.spec.ts (12 tests)
- Save workspace: all current terminals captured
- Workspace appears in sidebar list
- Rename workspace
- Delete workspace
- Restore workspace: terminals reopen with correct names, shells, cwd
- Restore workspace with agent terminals: agents re-launch
- Save workspace with split view: viewMode preserved
- Overwrite (update) existing workspace
- Multiple workspaces: save and restore different ones
- Workspace terminal count badge in sidebar
- Empty workspace handling
- Workspace with custom AI profiles included

### terminal-features.spec.ts (18 tests)
- Create new terminal via modal: shell picker, name, theme preview
- Copy text (Ctrl+Shift+C)
- Paste text (Ctrl+Shift+V)
- Context menu: copy, paste, export, pin, split, close options
- Export terminal output (full scrollback)
- Drag and drop file: path pasted into terminal
- Clickable URL in output
- Output pinning: pin selection, persistent panel, unpin
- Command history search (Ctrl+Shift+H): results shown, select to paste
- Command autocomplete: dropdown appears, select suggestion
- Command fix banner: typo detected, suggestion shown, Enter to apply
- Font size change: terminal updates
- Per-terminal theme: theme applies to correct terminal only
- Terminal status bar: shell type, cwd, git branch shown
- Terminal index numbers: Alt+1-9 switching
- Scrollback: 10,000 line cap verified
- Single instance lock (prevent session corruption)
- Global hotkey: Win+Shift+T creates new terminal

### themes-settings.spec.ts (12 tests)
- Apply each of 7 themes: Dark, Light, Solarized Dark/Light, Monokai, Dracula, Nord
- Theme persists after terminal restart
- Font size slider: 8px to 32px range enforced
- Font family change (Consolas, JetBrains Mono)
- 12 accent colors selectable
- Default shell change in settings
- Autocomplete enable/disable toggle
- Keybinding customization: record new binding
- Reset keybindings to defaults
- Settings panel opens/closes (gear icon)
- Shell config editor opens (Monaco lazy-loaded)
- Sidebar collapse/expand persists

### mcp-swarm-tools.spec.ts (10 tests)
- MCP health endpoint: /health returns ok
- MCP auth: valid token accepted, invalid rejected
- swarm_send_message: message appears in dashboard
- swarm_read_messages: returns sent messages
- swarm_create_task: task appears in kanban
- swarm_list_tasks: returns all tasks with status
- swarm_update_task: status transitions work
- swarm_list_agents: returns active swarm agents
- Rate limiting: excessive requests throttled
- MCP server survives rapid sequential tool calls

### command-palette.spec.ts (8 tests)
- Open command palette (Ctrl+K)
- Filter commands by typing
- Launch Claude from palette
- Launch Codex from palette
- Launch Gemini from palette
- New terminal command
- Split terminal command
- Close palette with Escape

### error-resilience.spec.ts (5 tests)
- ErrorBoundary: component crash shows recovery UI, not white screen
- Close terminal during agent launch: no orphaned processes
- Rapid view switching (10x in 2 seconds): app doesn't freeze
- Close all terminals: returns to Welcome screen cleanly
- MCP server restart: reconnects without crash

## Unit Test Plan (~60 tests)

### agentDetector.test.ts (10 tests)
- Detect "Claude Code" from terminal output
- Detect "Codex" from terminal output
- Detect "Gemini" from terminal output
- Detect "Aider" from terminal output
- No false positive on regular shell output
- Detection within first 2KB only (scan limit)
- Returns correct AgentInfo (name, icon, color)
- Handles ANSI-stripped output
- Multiple agents in sequence (only first detected)
- Empty output returns null

### contextCapture.test.ts (8 tests)
- Captures current cwd
- Captures git branch
- Captures git status (modified files)
- Captures recent commits
- Captures diff summary
- Builds complete HandoffContext object
- Handles non-git directory gracefully
- Handles missing git binary

### conversationParser.test.ts (8 tests)
- Parses user/assistant turns from Claude output
- Parses turns from Codex output
- Handles multi-line responses
- Handles code blocks in output
- Returns correct turn count
- Incremental parsing (new turns only)
- Empty output returns no turns
- Agent name attached to turns

### costTracker.test.ts (6 tests)
- Parses token count from Claude output (tokensIn, tokensOut)
- Parses estimated cost
- Handles partial cost info (tokens without cost)
- Updates incrementally (preserves previous values)
- Handles missing cost info gracefully
- Parses different cost output formats

### promptParser.test.ts (6 tests)
- Extracts cwd from bash prompt
- Extracts cwd from PowerShell prompt
- Extracts git branch from prompt
- Handles prompt without git branch
- Handles Windows-style paths
- Handles Unix-style paths

### pollingService.test.ts (5 tests)
- Subscribe registers callback
- Callback fires at specified interval
- Unsubscribe stops polling
- Multiple subscribers with different intervals
- Cleanup removes all subscriptions

### taskAnalyzer.test.ts (8 tests)
- Decomposes multi-part task into subtasks
- Categorizes subtasks (refactoring, testing, docs, review, etc.)
- Handles single-focus task
- Handles vague task description
- Returns title and description per subtask
- Categories match CATEGORY_LABELS
- Keyword matching for category detection
- Empty input returns empty subtasks

### swarmBridge.test.ts (9 tests)
- Parses agent output for swarm signals
- Detects task completion signal
- Detects question/help signal
- Forwards parsed message to swarm bus
- Handles output without signals (no-op)
- Bridge starts and stops cleanly
- Multiple bridges for multiple terminals
- Buffer offset tracking (reads new output only)
- Handles terminal close during bridge operation

## CI Integration

- Mock agent scripts are cross-platform (bash, works in Git Bash on Windows)
- `TERMPOLIS_TEST_AGENTS=1` set in Playwright config
- Test order: unit tests first (fast, ~15s), E2E second (~3-5 min)
- E2E screenshots on failure saved to `e2e/screenshots/`
- Swarm tests tagged `@slow` — can be skipped with `--grep-invert @slow` for fast CI
- All tests run in GitHub Actions CI on push/PR

## File Structure

```
e2e/
  mocks/
    mock-claude.sh
    mock-codex.sh
    mock-gemini.sh
    mock-aider.sh
  agent-launch.spec.ts
  agent-swarm.spec.ts
  session-restore.spec.ts
  view-switching.spec.ts
  workspaces.spec.ts
  terminal-features.spec.ts
  themes-settings.spec.ts
  mcp-swarm-tools.spec.ts
  command-palette.spec.ts
  error-resilience.spec.ts
tests/
  renderer/
    agentDetector.test.ts
    contextCapture.test.ts
    conversationParser.test.ts
    costTracker.test.ts
    promptParser.test.ts
    pollingService.test.ts
    taskAnalyzer.test.ts
    swarmBridge.test.ts
```

## Success Criteria

- All 200 new tests pass locally and in CI
- No regressions in existing 362 tests
- Agent launch -> trust -> use -> switch view -> close -> restore flow fully covered
- Full swarm lifecycle tested end-to-end
- View switching never shows wrong terminal content
- Session restore correctly re-launches all agent types
