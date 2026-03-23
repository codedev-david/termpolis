# Swarm AI Conductor Design

**Date:** 2026-03-23
**Status:** Approved

## Problem

The swarm feature uses regex keyword matching to break down tasks and a scoring function to assign them. No AI is involved in orchestration. This leads to poor task decomposition (e.g., "build a tic-tac-toe game and docs" produces two documentation tasks) and no active coordination between agents.

## Solution

A dedicated Claude Code CLI instance runs as the "Swarm Conductor" — a headless AI agent that breaks down tasks, selects agents, assigns work, monitors progress, and notifies the user when done.

## User Flow

1. User clicks "Start Swarm" (sidebar or welcome screen)
2. System checks if Claude Code is installed — if not, shows notification that swarm requires Claude Code
3. System picks a project directory (native dialog)
4. Wizard shows "Preparing conductor..." spinner
5. Hidden terminal spawns, runs `claude` command
6. Auto-trust fires, auth is checked
7. If auth needed — dialog tells user to sign in via browser, waits for completion
8. Once conductor is ready — wizard shows task description textarea
9. User types task, clicks "Launch"
10. Conductor takes over: analyzes task, detects installed agents, picks best agents, creates terminals, assigns work
11. All conductor updates appear in Swarm Dashboard Messages tab
12. When all tasks complete — notification banner shown to user
13. Agents stay open for user review. Conductor stays running for follow-up.

## Architecture

### Conductor Terminal

- Created as a `TerminalSession` with `hidden: true` and `isConductor: true` flags
- Not rendered in TabView, SplitView, or sidebar terminal list
- PTY process runs normally, receives/sends data
- Output buffered in `terminalOutputBuffers` like any terminal
- Can be revealed via "Debug Conductor" button in swarm dashboard or error dialog

### Conductor Lifecycle

```
[Start Swarm clicked]
    ↓
[Check: is `claude` installed?] → No → Show "Claude Code required" dialog → Stop
    ↓ Yes
[Pick directory]
    ↓
[Create hidden terminal, run `claude`]
    ↓
[Auto-trust (Enter at 9s)]
    ↓
[Poll output for auth state]
    ↓
[Auth prompt detected?] → Yes → Show "Sign in via browser" dialog → Poll until auth completes
    ↓ No (already authed)
[Conductor ready — show task textarea]
    ↓
[User submits task]
    ↓
[Send conductor prompt with task + installed agents list]
    ↓
[Conductor uses MCP tools to: detect agents, create tasks, launch agent terminals, assign work]
    ↓
[Monitoring loop: poll tasks + messages every 10-15s]
    ↓
[All tasks completed] → Post summary → Show notification banner
```

### Conductor System Prompt

The conductor receives a carefully crafted prompt via terminal input (not CLAUDE.md, since we need dynamic context). The prompt is sent after the conductor passes auth:

```
You are the Swarm Conductor for Termpolis. Your job is to orchestrate a multi-agent swarm.

TASK FROM USER:
{taskDescription}

INSTALLED AGENTS:
{list of detected agents with capabilities}

YOUR TOOLS (via MCP):
- swarm_list_agents: see all agent terminals
- swarm_create_task: assign tasks to agents
- swarm_list_tasks: check task status
- swarm_update_task: update task status
- swarm_send_message: communicate with agents and post updates
- swarm_read_messages: read messages from agents
- create_terminal: create new agent terminals
- run_command: run commands in agent terminals
- read_output: read agent terminal output
- write_to_terminal: send text to agent terminals

INSTRUCTIONS:
1. Analyze the task and break it into subtasks
2. For each subtask, pick the best installed agent based on their strengths
3. Create a terminal for each selected agent using create_terminal
4. Send each agent their task via write_to_terminal
5. Post your plan to the message bus: swarm_send_message(from='conductor', to='all', type='info', content='...')
6. Monitor progress by periodically calling swarm_list_tasks and swarm_read_messages
7. If an agent gets stuck, send them guidance via write_to_terminal
8. When all tasks are complete, post a summary via swarm_send_message(from='conductor', to='all', type='result', content='...')
9. Post regular status updates so the user can track progress

AGENT CAPABILITIES:
- Claude Code: Best at refactoring (5/5), architecture (5/5), code review (5/5), debugging (5/5). High cost.
- OpenAI Codex: Best at testing (5/5). Strong at frontend, data analysis. Medium cost.
- Gemini CLI: Best at documentation (5/5), devops (5/5), data analysis (5/5). Low cost.
- Aider + Qwen3: Best at bulk tasks (5/5). Free, local, no MCP support.

Begin now.
```

### Agent Detection for Conductor

Before showing the task textarea, the conductor needs to know which agents are available. Use the existing `agents:detect` IPC handler which checks for `claude`, `codex`, `gemini`, `aider` binaries. Pass the results to the conductor prompt.

### Wizard UI Changes

**Current wizard (4 steps):** Select agents → Describe task → Review breakdown → Launching

**New wizard (2 steps):**
- Step 1: "Preparing conductor..." (spinner with status messages: checking Claude, starting conductor, authenticating...)
- Step 2: "Describe your task" (textarea + tips + Launch button)

The agent selection step is removed — conductor picks agents.
The breakdown review step is removed — conductor decides.
The launching step becomes invisible — conductor handles it via MCP.

### Swarm Dashboard Changes

**New elements:**
- Conductor status indicator in dashboard header (preparing / running / error / done)
- "Debug Conductor" button — reveals the hidden conductor terminal
- Completion notification banner (toast-style, appears at top of app)

**Messages tab:** Conductor posts all its updates here:
- Task analysis: "Breaking down: build a tic-tac-toe game..."
- Agent selection: "Selected Claude Code for building, Gemini CLI for docs"
- Progress: "Claude Code: implementing game board (in progress)"
- Completion: "All tasks complete. Summary: ..."

### Error Handling

**Conductor crashes:** Detect via PTY `onExit` event. Show error dialog: "Conductor stopped unexpectedly. [Debug Conductor] [Restart] [Cancel Swarm]". Debug opens the hidden terminal. Restart re-launches the conductor with the same task.

**Token limit:** If conductor output contains context limit indicators, show warning: "Conductor reached token limit. Agents will continue working but without coordination. [Debug Conductor]"

**Auth failure:** If auth polling times out (60s), show: "Could not authenticate Claude Code. Please run `claude` in a terminal to sign in, then try again."

**Agent not installed:** If no agents besides Claude are installed, conductor can still work — it just runs everything in its own terminal. Show info message: "Only Claude Code is available. The conductor will handle all tasks directly."

### Hidden Terminal Implementation

Add to `TerminalSession`:
```typescript
interface TerminalSession {
  // ... existing fields
  hidden?: boolean      // don't render in UI
  isConductor?: boolean // this is the swarm conductor
}
```

Filter hidden terminals from:
- TabView rendering
- SplitView/PaneRenderer rendering
- Sidebar terminal list
- Session persistence (like isSwarm)

The conductor terminal:
- Created via `window.termpolis.createTerminal(id, shellType, cwd)`
- Added to store with `hidden: true, isConductor: true, isSwarm: true`
- Output still buffered (readable via MCP read_output)
- Killable via normal `killTerminal`

### Conductor Auto-Trust & Auth Detection

**Trust prompt:** Same timed Enter approach at 9s after launch.

**Auth detection patterns:**
- Login needed: `/sign in|log in|authenticate|https:\/\/.*auth|visit.*to sign in/i`
- Login success: `/authenticated|logged in|welcome|ready/i` (after login prompt was detected)

**Auth flow:**
1. Spawn conductor terminal, send `claude` command
2. Poll output every 1s for first 15s
3. If auth pattern detected → show dialog with the URL from the output
4. Continue polling for success pattern (up to 60s timeout)
5. If success → proceed to task input
6. If timeout → show error

### Notification Banner

When swarm completes, show a toast-style banner at the top of the main content area:

```
[✓ Swarm Complete] All 2 tasks finished successfully. [View Summary] [Dismiss]
```

- Green background, auto-dismisses after 15s or on click
- "View Summary" opens the swarm dashboard Messages tab
- Managed via a `swarmNotification` state in the Zustand store

### What Stays the Same

- Individual agent launches from sidebar (unchanged)
- MCP server, tools, message bus (unchanged, conductor uses them)
- Swarm bridge for non-MCP agents (unchanged)
- Swarm dashboard structure (Agents/Tasks/Messages tabs — unchanged)
- Terminal features, workspaces, settings (unchanged)
- Session restore (conductor terminal excluded via isSwarm+hidden)

### What Gets Replaced

- `taskAnalyzer.ts` — no longer used for swarm (kept for other uses)
- `smartRouter.ts` — no longer used for swarm routing (kept for other uses)
- Swarm wizard steps 1 (agent selection) and 3 (breakdown review) — removed
- `StartSwarmModal.tsx` — major rewrite: simplified to warmup + textarea

## Files to Create/Modify

### New Files
- `src/renderer/src/lib/conductorManager.ts` — conductor lifecycle: spawn, warmup, auth check, send prompt, monitor, teardown
- `src/renderer/src/lib/conductorPrompt.ts` — builds the conductor system prompt with dynamic context

### Modified Files
- `src/renderer/src/components/SwarmDashboard/StartSwarmModal.tsx` — rewrite wizard to 2 steps
- `src/renderer/src/components/SwarmDashboard/SwarmDashboard.tsx` — add conductor status, debug button, notification
- `src/renderer/src/store/terminalStore.ts` — add swarmNotification state
- `src/renderer/src/types/index.ts` — add hidden, isConductor to TerminalSession
- `src/renderer/src/components/TabView/TabView.tsx` — filter hidden terminals
- `src/renderer/src/components/SplitView/PaneRenderer.tsx` — filter hidden terminals
- `src/renderer/src/components/Sidebar/Sidebar.tsx` — filter hidden terminals from list
- `src/renderer/src/App.tsx` — render notification banner, filter hidden from session save

## Success Criteria

- User types a task, conductor handles everything else
- Conductor picks installed agents intelligently
- Progress updates visible in Messages tab in real-time
- Notification banner when swarm completes
- Error dialog with debug option if conductor fails
- Auth flow works for first-time Claude Code users
- Hidden conductor terminal not visible in normal UI
- Swarm cleanup kills conductor + all agent terminals
