# Termpolis Agent Observability & Efficiency Plan

## Executive Summary

Six linked features that turn Termpolis from "a multi-model terminal" into **the control plane for AI coding work**. Every feature works in both **standalone mode** (one AI agent running in one terminal) and **swarm mode** (multiple coordinated agents). All data stays local — no provider API calls, no telemetry, no cloud.

**The features:**

1. **Agent Activity Stream** (foundation) — unified event feed across all AI sessions
2. **Context Window Pressure** — live gauge of how full each agent's context is, warning before compaction
3. **Context Visibility + Pinning** — inspect what's in context, pin items that must survive compaction
4. **Redundant Work Detection** — flag repeated file reads, tool calls, or questions
5. **Cross-Agent Efficiency** — side-by-side resource use across agents for comparable tasks
6. **Swarm UX Polish** — conductor reasoning trace, live agent handoffs, decision log

**Design principles:**

- Ride on existing infrastructure — audit log, session recorder, status detector already exist and are load-bearing
- Tiered data sources with graceful fallback — structured transcripts where possible, regex inference where not
- Standalone-first — swarm is one consumer of the activity stream, not the only one
- Persist between sessions — users want to look back at yesterday's Claude session, not just today's

---

## Part 1: The Data Problem

Observability features are only as good as the data feeding them. Termpolis today has three data sources; this plan leverages all three in priority order.

### Tier 1: Provider Transcript Files (structured, authoritative)

Every major AI coding tool writes its conversation to disk in a structured format. These are **gold** — real token counts, real tool calls, real context state. No inference needed.

| Agent | Transcript Path | Format | Data Available |
|-------|----------------|--------|----------------|
| Claude Code | `~/.claude/projects/<mangled-cwd>/*.jsonl` | JSONL | user/assistant messages, tool calls + args, token usage per message, model, timestamps, context compaction events |
| Codex | `~/.codex/sessions/*.jsonl` (to verify) | JSONL | messages, tool calls, tokens (format subject to Codex CLI version) |
| Gemini CLI | varies by version — inspect `~/.gemini/` | mixed | depends on config; may need buffer fallback |
| Aider | `.aider.chat.history.md` + `.aider.llm.history` | markdown + log | messages, token counts (approximate) |

**New module: `src/main/transcriptWatchers/`**
- `claudeCodeWatcher.ts` — most important, best data
- `codexWatcher.ts` — second priority
- `geminiWatcher.ts` — buffer-first, transcripts if available
- `aiderWatcher.ts` — markdown parser

Each watcher exposes the same interface:

```typescript
interface AgentEvent {
  ts: number
  terminalId: string
  agentType: 'claude' | 'codex' | 'gemini' | 'aider'
  kind: 'message' | 'tool_call' | 'tool_result' | 'token_update' | 'compaction' | 'error'
  payload: unknown // kind-specific
}

interface TranscriptWatcher {
  attach(terminalId: string, cwd: string): Promise<void>
  detach(terminalId: string): void
  subscribe(cb: (event: AgentEvent) => void): () => void
}
```

Watchers use `chokidar` (already a dep via Electron) or `fs.watch` to tail-read new JSONL lines as the agent writes them.

### Tier 2: Termpolis MCP Audit Log (already exists)

`src/main/mcpServer.ts` writes a JSONL audit log of every MCP tool call. When agents use Termpolis's MCP tools (which they do constantly — it's how they list terminals, run commands, coordinate swarm), we get a first-class event stream already. Extend the existing `logMcpRequest` to enrich entries with caller agent identity (from the bearer token's client label once we add that).

### Tier 3: Terminal Buffer Heuristics (fallback)

`agentStatusDetector.ts`, `conversationParser.ts`, `costTracker.ts` — existing modules that regex-scrape the terminal buffer. Keep these as fallback when transcripts aren't available. Noisy but universal.

### Unified Event Bus

**New module: `src/main/agentEventBus.ts`**

A single in-process event bus that aggregates events from all three tiers, de-duplicates by `(terminalId, ts, kind, hash)`, and publishes a normalized stream to the renderer via IPC.

```typescript
interface AgentEventBus {
  subscribe(filter: EventFilter, cb: (event: AgentEvent) => void): () => void
  publish(event: AgentEvent): void
  query(filter: EventFilter & { since?: number; limit?: number }): AgentEvent[]
}
```

Ring buffer of last 10,000 events in memory, periodic flush to a SQLite file (`~/.termpolis/events.db`) for historical queries and cross-session analysis.

**Why SQLite?** Everything else in the plan (cross-agent comparison, redundancy detection, pressure trends) needs time-series queries over structured events. Flat JSONL doesn't scale past a day of heavy use. SQLite with a small schema is ~50 lines of setup and buys us all downstream queries cheaply. No custom backend, just a local file.

---

## Part 2: Feature Specs

### Feature 1: Agent Activity Stream (Foundation)

**What it is:** A live, filterable feed of everything every AI agent in Termpolis is doing — tool calls, messages, file edits, errors, context events — with timestamps and structured metadata.

**Why it's the foundation:** Every other feature in this plan consumes this stream. Build it once, reuse everywhere. It also ships as a visible feature on day one: users open the activity panel and immediately see what Claude Code is doing in their terminal.

**UI: `src/renderer/src/components/AgentActivity/`**

```
┌─────────────────────────────────────────────────────────────┐
│  Agent Activity                [Filter ▾] [Pause] [Clear]   │
├─────────────────────────────────────────────────────────────┤
│ 14:30:05 [Claude · term1]  🔧 Read src/main/mcpServer.ts    │
│                             220 lines, 4.2k tokens           │
│ 14:30:06 [Claude · term1]  🔧 Grep "rateLimit"              │
│                             3 matches                         │
│ 14:30:08 [Claude · term1]  💭 Analyzing rate limit structure │
│ 14:30:12 [Claude · term1]  ✏️  Edit src/main/mcpServer.ts   │
│                             +12 -3                            │
│ 14:30:15 [Codex · term2]   🔧 Read package.json             │
│                             ⚠ same file read 4× in 2 min    │
│ 14:30:18 [Claude · term1]  💬 "I've added rate limiting..."  │
└─────────────────────────────────────────────────────────────┘
```

**Filters:** agent, terminal, kind, time range, text search.

**Works in standalone:** this is the primary interface for "what is Claude/Codex doing right now in my one terminal session."

**Works in swarm:** filter to show only conductor, or interleave all swarm agents.

**Files:**
- `src/main/agentEventBus.ts` (new) — event aggregation, dedup, persistence
- `src/main/transcriptWatchers/*` (new) — per-agent transcript parsers
- `src/preload/index.ts` — expose `agentActivity` API to renderer
- `src/renderer/src/components/AgentActivity/ActivityFeed.tsx` (new)
- `src/renderer/src/components/AgentActivity/ActivityItem.tsx` (new)
- `src/renderer/src/store/terminalStore.ts` — activity subscription state

---

### Feature 2: Context Window Pressure

**What it is:** A live gauge per terminal showing % of the agent's context window used, with warnings when compaction is imminent and a breakdown of what's consuming tokens.

**Why it matters:** The single most-felt pain in long AI sessions. "Why did Claude forget what I told it 30 messages ago?" — because compaction silently evicted it. Users want a pressure gauge like the one they'd get on any real resource.

**Data sources:**
- Claude Code transcripts include per-message token counts and compaction events — direct data
- Codex similar (version-dependent)
- For agents without token data in transcripts, approximate via `gpt-tokenizer` npm package (~30KB, MIT) or a rough 4-chars-per-token heuristic

**UI: status bar integration + dedicated panel**

Status bar shows a compact gauge per active terminal:
```
[Claude · term1]  ████████░░ 82% · ~150k/200k tokens · compaction likely
```

Clicking opens the Context Panel (see Feature 3). At 85% shows warning color; at 95% triggers notification "Claude context at 95% — compaction imminent. Pin anything you can't lose."

**Breakdown view:**
```
Context Window — Claude (term1)           164,238 / 200,000 tokens (82%)
├─ System prompt                            4,120 tokens
├─ Tool definitions                         8,400 tokens
├─ File reads (22 files, 8 dupes)          68,500 tokens  ⚠ redundancy
├─ Tool results                            12,300 tokens
├─ Conversation                            71,000 tokens
│  ├─ Pinned (3)                            3,200 tokens  📌
│  └─ Recent                               67,800 tokens
└─ Estimated output reserve                     —        ← 35k remaining
```

**Works in standalone:** primary value here.

**Works in swarm:** one gauge per agent in the swarm dashboard. Lets the conductor (and the user) see when an agent is about to lose context and should hand off work.

**Files:**
- `src/renderer/src/lib/contextPressure.ts` (new) — token counting, tier calculation
- `src/renderer/src/components/StatusBar/ContextGauge.tsx` (new)
- `src/renderer/src/components/AgentActivity/ContextPanel.tsx` (new) — breakdown view
- Extend `src/renderer/src/lib/agentCapabilities.ts` with per-model context window sizes (Opus 4.7: 200k, Sonnet 4.6: 200k, Codex: varies, etc.)

---

### Feature 3: Context Visibility + Pinning

**What it is:** A panel that shows exactly what's in the agent's context window, organized by type (system prompt, tool definitions, file reads, conversation turns), with the ability to **pin** items so they survive compaction.

**The pinning mechanism:** Termpolis cannot directly control what's in the agent's context (that's up to the agent's own context manager). Instead, pinning works by **re-injection**: when Termpolis detects compaction pressure, it automatically prepends pinned items back into the next message the user sends, formatted as "Context from earlier: …". For supported providers (Claude Code), Termpolis can also write a pin file to `.termpolis/context-pins.md` in the working directory and instruct the agent to reference it.

**UI:**
```
┌─ Context Items (Claude · term1) ────────────────────────────┐
│  📌 Pinned (3)                                              │
│   ├─ User spec from 14:02 — "must not break swarm tests"   │
│   ├─ src/main/swarmManager.ts:25-50 — message bus logic    │
│   └─ Decision: using SQLite for event store                 │
│                                                             │
│  Recently read files (22)                                    │
│   ├─ src/main/mcpServer.ts  [📌 pin]  [🗑 evict]            │
│   ├─ src/main/index.ts      [📌 pin]  [🗑 evict]            │
│   └─ ...                                                     │
│                                                             │
│  Conversation (82 turns)                                     │
│   ├─ 14:02 user: "let's add observability..."  [📌 pin]     │
│   └─ ...                                                     │
└─────────────────────────────────────────────────────────────┘
```

**User flow — standalone terminal:**
1. Working with Claude on a refactor, gave a long spec at the start
2. 40 messages later, Claude seems to have forgotten constraints
3. User opens Context Panel, sees the spec is about to fall out of context
4. Clicks 📌 pin → Termpolis saves to pins file and re-injects on next message
5. Claude "remembers"

**User flow — swarm:**
- Conductor pins key decisions so worker agents see them when they start
- Pinned items are embedded in the conductor prompt and each worker's initial prompt

**Works in standalone:** core use case. This is the feature most users will touch every day.

**Works in swarm:** pins become part of inter-agent handoff context (integrates with existing `contextCapture.ts`).

**Persistence:** pins live in `~/.termpolis/pins/<project-hash>.json` so they survive app restarts. Per-project.

**Files:**
- `src/main/contextPinStore.ts` (new) — pin persistence, per-project
- `src/renderer/src/lib/contextInjection.ts` (new) — re-injection logic on next message
- `src/renderer/src/components/AgentActivity/ContextPanel.tsx` (extended from Feature 2)
- `src/renderer/src/components/AgentActivity/PinButton.tsx` (new)

---

### Feature 4: Redundant Work Detection

**What it is:** Detect when an agent is wasting tokens/time on redundant operations — reading the same file repeatedly, making the same tool call, asking the user the same question — and surface it clearly. When safe, allow Termpolis to serve cached results.

**Categories of redundancy:**

1. **Duplicate file reads** — agent read `App.tsx` 8 times this session when file hasn't changed. Most common form.
2. **Repeated tool calls with same args** — same `Grep "TODO"` three times in 5 minutes.
3. **Re-asking the user** — agent asked "which file should I edit?" twice in one session.
4. **Rebuilding mental model** — agent re-reads the same directory structure after each compaction. Related to Feature 3 (pinning could help).
5. **Loop detection** — agent in a tight edit-test-edit-test loop on the same file with no apparent progress (same errors, same edits).

**Detection approach:**

Runs on the event stream from Feature 1. Stateful detector keyed per terminal.

```typescript
interface RedundancyWarning {
  terminalId: string
  kind: 'duplicate_read' | 'repeated_tool' | 'repeated_question' | 'loop'
  items: AgentEvent[]
  tokensWasted: number // estimated
  suggestion: string
}
```

**UI:**
- Inline annotations in the Activity Stream (🔁 icon next to redundant events)
- Aggregated panel: "Claude re-read 3 files a total of 11 times this session (~45k tokens wasted)"
- Optional: intercept duplicate `Read` tool calls via the MCP gateway (if MCP Hub ships) and return cached content with a note

**Auto-caching (opt-in, conservative default):**

For Termpolis's own MCP tools (`read_output`, `get_file_tree`, `get_git_status`), if the agent calls the same tool with same args within 30s and no state change has happened, return the cached result. Mark the response with `"cached": true` so the agent knows. This is safe because it's Termpolis's own tools, but keep it off by default with a per-tool toggle.

**Works in standalone:** yes — a one-agent session has redundancy just as much as swarm.

**Works in swarm:** additional kind — **cross-agent redundancy**: agent A reads a file, agent B reads the same file 2 minutes later. Flag it; conductor could pre-share the file read result.

**Files:**
- `src/main/redundancyDetector.ts` (new) — stateful per-terminal detector
- `src/renderer/src/components/AgentActivity/RedundancyBadge.tsx` (new)
- `src/renderer/src/components/AgentActivity/RedundancySummary.tsx` (new)

---

### Feature 5: Cross-Agent Efficiency

**What it is:** Side-by-side comparison of how much each AI agent used to accomplish similar work. Since Termpolis uniquely orchestrates Claude + Codex + Gemini + Aider, it's the only tool positioned to show this.

**Metrics per agent per task:**

| Metric | Source |
|--------|--------|
| Tokens in / out | Transcripts (tier 1) |
| Wall time | Event timestamps |
| Tool calls total | Event stream |
| File reads | Event stream |
| Unique files touched | Event stream |
| Redundancy score | Feature 4 |
| Context compactions | Transcripts |
| Errors encountered | Event stream + status detector |
| Outcome (success/partial/fail) | Swarm task status or user rating |

**UI — swarm task comparison:**

```
Task: "Add rate limiting to MCP endpoints"

Agent     Tokens  Time    Tools  Files  Redund.  Result
──────    ──────  ─────   ─────  ─────  ──────   ──────
Claude    142k    8m 20s  34     12     4 dupes  ✓ success
Codex     89k     11m 4s  28     9      1 dupe   ✓ success
Aider+Q   —       14m 2s  N/A    6      —        ✓ success
─────────────────────────────────────────────────────────
Best efficiency: Codex (1.0x baseline)
Claude used 1.6x tokens for same outcome
```

**UI — standalone historical view:**

For single-terminal sessions, show personal trends: "Over the last 30 days, Claude averaged 48k tokens per 'bug fix' task, Codex averaged 31k — Codex is 35% more token-efficient for this category of work on your codebase."

**Task categorization for comparison:** infer from the conductor's task analyzer (already exists in `taskAnalyzer.ts`) or from user-assigned tags.

**Works in standalone:** "my Claude sessions today burned 2M tokens vs. yesterday's 800k — what changed?" Useful for self-awareness.

**Works in swarm:** headline feature — swarm dashboard shows per-agent efficiency badges next to each task.

**Files:**
- `src/main/efficiencyAnalyzer.ts` (new) — aggregation queries against event SQLite
- `src/renderer/src/components/Efficiency/ComparisonTable.tsx` (new)
- `src/renderer/src/components/Efficiency/HistoricalTrends.tsx` (new)
- Extend `src/renderer/src/components/SwarmDashboard/` to surface efficiency alongside each task

---

### Feature 6: Swarm UX Polish

**What it is:** Making the swarm feel magical instead of opaque. Today the conductor is a black box — user sees "3 tasks running" and has to click Debug to see what's happening. This feature replaces that with clear, live visibility.

**Sub-features:**

#### 6a. Conductor Reasoning Trace

Show the conductor's decision-making in a readable panel — not raw terminal output, but parsed into decisions:

```
Conductor Reasoning
├─ 14:30:00  Received task: "Add rate limiting to MCP endpoints"
├─ 14:30:02  Analyzed complexity: medium, 3 subtasks
├─ 14:30:05  Subtask 1 → Claude (refactoring, 5/5)
├─ 14:30:05  Subtask 2 → Codex (test writing, 4/5) + token-efficient
├─ 14:30:06  Subtask 3 → Claude (integration, depends on #1)
└─ 14:30:08  Dispatched 3 tasks
```

Parse from the conductor's MCP tool calls (`swarm_create_task`) and its output text. The router's reasoning (`smartRouter.ts` already produces `reason` strings) feeds this directly.

#### 6b. Live Agent Handoff Visualization

When a task completes and triggers the next, animate it in the dashboard. Today handoffs happen via the message bus invisibly; surface them:

```
┌─ Claude ──────┐                   ┌─ Codex ───────┐
│ Subtask 1      │ ──── result ──→  │ Subtask 2      │
│ ✓ completed    │                   │ ▶ in progress  │
└────────────────┘                   └────────────────┘
                       ↑
              "refactor complete, file paths: [...]"
```

#### 6c. Agent Status Richness

Extend `agentStatusDetector.ts` to emit richer sub-states beyond the current 7 (starting/thinking/waiting_for_input/working/idle/errored/completed):

- `working:reading_files` — agent is in an exploration phase
- `working:writing_code` — agent is producing output
- `working:running_tests` — agent invoked test runners
- `stuck` — same tool call 3+ times with no progress
- `blocked_on_user` — waiting for auth/trust prompt

These flow from the event stream + transcripts.

#### 6d. Swarm Decision Replay

After a swarm completes, offer a replay view: scrub a timeline and watch the conductor's reasoning and each agent's activity unfold. Debugging aid and teaching tool.

**Works in standalone:** 6c (richer status) applies directly. 6a/6b/6d are swarm-specific.

**Works in swarm:** primary use case.

**Files:**
- `src/renderer/src/lib/conductorTraceParser.ts` (new) — parse conductor output into structured decisions
- `src/renderer/src/components/SwarmDashboard/ConductorTrace.tsx` (new)
- `src/renderer/src/components/SwarmDashboard/HandoffAnimation.tsx` (new)
- `src/renderer/src/components/SwarmDashboard/SwarmReplay.tsx` (new)
- Extend `src/renderer/src/lib/agentStatusDetector.ts` with sub-states

---

## Part 3: Implementation Phases

Each phase is shippable on its own. Ordering is deliberate — earlier phases deliver the data infrastructure later phases need.

### Phase 0: Foundation — Event Bus + Transcript Watchers (v1.9)

**Goal:** Termpolis has structured, persistent observability data for every AI session.

**Deliverables:**
- `agentEventBus.ts` with in-memory ring + SQLite persistence
- Claude Code transcript watcher (the big one — working and tested)
- Codex transcript watcher (v1)
- Basic Gemini + Aider watchers (best-effort, buffer fallback OK)
- Existing audit log feeds into the event bus
- IPC API surface for renderer
- Zero user-facing UI — this is infrastructure only

**Success criteria:** open Claude Code in a terminal, run `console.log(await window.termpolis.agentActivity.query({ terminalId: X }))` — see a rich event stream.

**Effort:** ~1.5–2 weeks. The risk is in the Claude Code JSONL format being semi-private; need robust parsing that tolerates schema drift.

### Phase 1: Agent Activity Stream (v1.10)

**Goal:** Users can see what their AI agents are doing in real time.

**Deliverables:**
- `<ActivityFeed>` component with live event rendering
- Filtering, pausing, clearing, searching
- Persistence across sessions via SQLite queries
- Sidebar tab or keybind (Ctrl+Shift+A)

**Success criteria:** running a normal Claude Code session, user opens activity feed, sees every tool call and message as it happens, can scroll back to yesterday's session.

**Effort:** ~1 week (UI on top of Phase 0 infrastructure).

### Phase 2: Context Pressure + Visibility + Pinning (v1.11)

**Goal:** Users can see context state and keep important items alive across compaction.

**Deliverables:**
- Status bar context gauge per active AI terminal
- Context Panel with breakdown by category
- Pin/unpin UI for files, messages, decisions
- Pin persistence per-project
- Re-injection mechanism on next user message
- Compaction warning notifications

**Success criteria:** user pins the original spec, works with Claude for 2 hours through a compaction, Claude still references the spec correctly.

**Effort:** ~2 weeks. Core complexity is the re-injection strategy — needs careful UX to avoid being annoying (don't re-inject on every message, do it when compaction is detected).

### Phase 3: Redundant Work Detection (v1.12)

**Goal:** Users see and can act on wasted work.

**Deliverables:**
- Redundancy detector running on event stream
- Inline badges in activity feed
- Per-session summary panel
- Opt-in auto-caching for Termpolis's own MCP tools
- Telemetry-free "you saved X tokens this week via cache" footer

**Success criteria:** user runs a multi-hour Claude session, opens redundancy summary, sees "Claude read App.tsx 12 times (~45k tokens)" — actionable insight.

**Effort:** ~1 week.

### Phase 4: Cross-Agent Efficiency (v1.13)

**Goal:** Multi-agent users can see which agent is pulling its weight.

**Deliverables:**
- Efficiency comparison table in swarm dashboard
- Historical trends view for standalone users
- Task categorization (infer from task analyzer + user tags)
- Efficiency badges next to agent names in router reasoning

**Success criteria:** after running three swarms over a week, user can see "Codex is 35% more token-efficient than Claude for test-writing tasks on my codebase" with real data.

**Effort:** ~1 week.

### Phase 5: Swarm UX Polish (v1.14)

**Goal:** Swarm feels transparent and controllable.

**Deliverables:**
- Conductor reasoning trace panel
- Live handoff visualization
- Richer agent sub-statuses
- Swarm replay

**Success criteria:** user records a swarm demo video showing the reasoning trace — it's compelling enough to share on Twitter.

**Effort:** ~2 weeks.

**Total:** ~8–9 weeks to ship all five phases end-to-end. Phase 0 is load-bearing; everything after can ship independently.

---

## Part 4: Architecture — Files to Create / Modify

### New files

```
src/main/
├── agentEventBus.ts              — Event aggregation, dedup, persistence
├── eventStore.ts                 — SQLite wrapper for event history
├── transcriptWatchers/
│   ├── index.ts                   — Factory + lifecycle management
│   ├── claudeCodeWatcher.ts      — JSONL parser for ~/.claude/projects/
│   ├── codexWatcher.ts           — Codex transcript parser
│   ├── geminiWatcher.ts          — Gemini fallback
│   └── aiderWatcher.ts           — Aider markdown parser
├── contextPinStore.ts            — Pin persistence per-project
└── redundancyDetector.ts         — Stateful per-terminal detector

src/renderer/src/lib/
├── contextPressure.ts            — Token counting, tier math
├── contextInjection.ts           — Re-inject pinned items on next message
├── conductorTraceParser.ts       — Structured conductor reasoning
└── efficiencyAnalyzer.ts         — Cross-agent queries

src/renderer/src/components/
├── AgentActivity/
│   ├── index.tsx                 — Container
│   ├── ActivityFeed.tsx          — Live event list
│   ├── ActivityItem.tsx          — Per-event rendering
│   ├── ActivityFilters.tsx       — Filter controls
│   ├── ContextPanel.tsx          — What's in context
│   ├── ContextGauge.tsx          — Status bar gauge
│   ├── PinButton.tsx             — Pin/unpin UI
│   ├── RedundancyBadge.tsx       — Inline redundancy markers
│   └── RedundancySummary.tsx     — Aggregated view
├── Efficiency/
│   ├── ComparisonTable.tsx       — Side-by-side agents
│   └── HistoricalTrends.tsx      — Standalone time-series
└── SwarmDashboard/               (extend existing)
    ├── ConductorTrace.tsx        — Reasoning panel
    ├── HandoffAnimation.tsx      — Live transitions
    └── SwarmReplay.tsx           — Timeline scrubber
```

### Modified files

```
src/main/index.ts                 — Initialize event bus + watchers on launch
src/main/mcpServer.ts             — Feed audit events into event bus
src/main/sessionStore.ts          — Persist context pins, activity prefs
src/main/swarmManager.ts          — Emit swarm events into event bus
src/preload/index.ts              — Expose agentActivity + contextPins APIs
src/renderer/src/store/terminalStore.ts
                                   — Activity subscription state, pin state
src/renderer/src/lib/agentStatusDetector.ts
                                   — Add sub-statuses, consume events
src/renderer/src/lib/agentCapabilities.ts
                                   — Per-model context window sizes
src/renderer/src/lib/conductorManager.ts
                                   — Emit decision events for reasoning trace
src/renderer/src/components/StatusBar/
                                   — Context gauge integration
src/renderer/src/App.tsx          — Route/keybind for Activity panel
src/renderer/src/components/Sidebar/
                                   — Activity tab
```

### New dependencies

- `better-sqlite3` (~1MB) — synchronous SQLite, used for event store. Native binary; already common in Electron apps.
- `gpt-tokenizer` (~200KB) — token counting for models without first-class token data
- `chokidar` — likely already present for file watching; verify

---

## Part 5: Testing Approach

The existing 164-test suite and 85% coverage bar must stay intact. Observability code is particularly tricky to test because it's stateful, time-dependent, and I/O-bound.

**Unit tests:**
- Transcript parsers — fixture-based, real JSONL samples from each agent in `tests/fixtures/transcripts/`
- Event bus dedup logic
- Redundancy detector state machine
- Context pressure calculator
- Token counter accuracy (±5% of real token count)
- Pin store persistence

**Integration tests:**
- Activity feed live-updates when transcript file grows
- Pin survives app restart
- Event bus drops events gracefully under flood
- SQLite schema migration

**E2E tests (Playwright):**
- Extend `swarm-end-to-end.spec.ts` with activity stream assertions (see `project_swarm_e2e.md` in memory — don't regress the existing platform hooks/test shims)
- New spec: `observability-end-to-end.spec.ts` — standalone Claude session → verify events appear → pin a message → simulate compaction → verify re-injection
- Test shim for a fake transcript writer (simulates Claude Code writing JSONL over time)

**Coverage target:** 85% line coverage on new code per existing project standard. Transcript parsers will be the hardest — plan for 10+ JSONL fixture files covering edge cases (mid-message crashes, malformed lines, compaction markers, tool call variations).

---

## Part 6: What We Explicitly Don't Build

| Not building | Why |
|--------------|-----|
| Calls to provider APIs to fetch context | Privacy, cost, and most users don't have API keys — subscription-based usage is the norm |
| Cloud sync of activity data | Keep it local. "No telemetry" is a feature. |
| Modifying agent behavior directly | We don't inject into Claude Code's process. Re-injection is explicit, visible, and triggered by user pins. |
| Replacing provider transcripts with our own | Parsing is fine; owning the data is a maintenance burden |
| Context editing (removing things mid-session) | Unsafe, unpredictable. Only pin-to-survive-compaction. |
| Custom token counters per model | Use `gpt-tokenizer` or the provider's own counts. Don't reinvent. |
| Activity export to SaaS dashboards | Local-first. JSON export is enough. |
| Triggering agents based on activity patterns | Out of scope — automation is a separate feature. |

---

## Part 7: Open Questions / Risks

1. **Claude Code transcript format stability.** The JSONL format under `~/.claude/projects/` isn't a public contract. Anthropic may change it. Mitigation: tolerant parsing, schema version detection, buffer fallback if parsing fails.

2. **Codex transcript availability.** Need to verify Codex writes structured transcripts to a known location in current version. If not, fall back to buffer heuristics for Codex.

3. **Pin re-injection UX.** If we re-inject too aggressively, user gets frustrated ("why does my message keep growing?"). If too rarely, pins don't help. Needs live testing to tune. Start conservative: only re-inject when a pinned item is estimated to have fallen out of context.

4. **Token counter accuracy.** `gpt-tokenizer` is OpenAI-specific; Claude's tokenizer is different. For Claude, rely on transcript token counts where possible. For estimates when transcripts lack token info, accept ±10% error.

5. **Performance with large sessions.** 24-hour Claude session could produce 50k+ events. SQLite handles it but UI virtualization for the activity feed needs care. Use `react-window` or similar.

6. **Permission to read transcripts.** On some systems (sandboxed Electron), reading files outside the app's user-data directory needs explicit permissions. Verify Termpolis's Electron fuses allow `~/.claude/`, `~/.codex/`, etc.

7. **Multi-project sessions.** If user has two Termpolis windows on different projects, event bus should partition correctly. Use project-path hash as partition key.

---

## Part 8: The Pitch to Users

Per the earlier strategy discussion: the hero story is **"see everything your AI is doing"**, not **"save money on tokens"**. Tokens are a secondary metric; visibility is the primary product.

**Demo script (30-second video):**
1. User kicks off Claude Code in Termpolis on a bug fix
2. Cut to activity feed showing live tool calls and token pressure gauge climbing
3. Claude reads a file for the 4th time — redundancy badge appears
4. User pins the spec from earlier to survive upcoming compaction
5. Context gauge hits 90% — compaction happens, pinned spec survives
6. Claude finishes; side-by-side shows it used 40% fewer tokens than last week's similar bug fix because redundancy was caught

**One-line pitch:** *"Finally — see what your AI is actually doing, and why it keeps burning tokens on the same three files."*

This pitch lands with the early-adopter AI-coding crowd immediately. It doesn't require them to already care about MCP, swarms, or multi-model orchestration — but once they're in, the swarm features become the obvious upgrade path.
