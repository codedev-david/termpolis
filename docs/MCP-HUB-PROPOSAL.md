# Termpolis MCP Hub Proposal

## Executive Summary

This document proposes evolving Termpolis from a multi-model AI terminal into the **central MCP (Model Context Protocol) hub for development teams**. The core thesis: every AI client (Claude Code, Codex, Gemini, Cursor, Windsurf) manages MCP servers independently — fragmented configs, no shared visibility, no security layer. Termpolis becomes the single gateway that all AI clients connect through, providing unified configuration, traffic visibility, access control, and a community registry — without ever executing third-party code.

**Design principles:**
- Free forever for maximum adoption velocity
- Zero third-party code execution — gateway architecture only
- Security as a feature, not an afterthought
- Build on existing Termpolis architecture, not alongside it

---

## Part 1: Current State Assessment

### What Termpolis Already Has

**MCP Server (src/main/mcpServer.ts):**
- 14 built-in tools across terminal management, context, and swarm coordination
- HTTP server on localhost:9315 with bearer token auth
- Per-endpoint rate limiting (create: 10/min, run: 60/min, global: 200/min)
- JSON-lined audit logging with 1MB rotation
- Localhost-only binding, no wildcard CORS

**Auto-Registration (src/main/index.ts):**
- Writes MCP config to Claude Code (~/.mcp.json), Codex (~/.codex/config.toml), Gemini (~/.gemini/settings.json)
- Registers as Claude Code plugin via local marketplace
- Handles cross-platform config paths

**Swarm System (src/main/swarmManager.ts):**
- Message bus (500 max) with typed messages (task/result/question/info/review)
- Task queue (200 max) with status tracking
- Smart router with capability scoring across Claude, Codex, Gemini, Aider+Qwen
- Conductor pattern: Claude Code orchestrates other agents via MCP

**Security Model:**
- 256-bit random auth token per launch
- Electron context isolation (contextIsolation: true, nodeIntegration: false)
- Command sanitization for swarm agents (agentCommandSanitizer.ts)
- No plugin system (intentional design decision)
- Single-instance lock

### What Needs to Change for MCP Hub

The current MCP server exposes Termpolis's own tools to external AI clients. The hub architecture inverts this: Termpolis also becomes a **proxy** that routes external AI clients to third-party MCP servers, adding security, visibility, and management.

---

## Part 2: Architecture — The Gateway Model

### 2.1 Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     TERMPOLIS MCP HUB                       │
│                                                             │
│  ┌─────────────┐   ┌──────────────┐   ┌────────────────┐   │
│  │   Built-in   │   │   Gateway     │   │   Registry     │   │
│  │   MCP Tools  │   │   Proxy       │   │   (configs)    │   │
│  │   (14 tools) │   │              │   │                │   │
│  └──────┬───────┘   └──────┬───────┘   └───────┬────────┘   │
│         │                  │                   │            │
│  ┌──────┴──────────────────┴───────────────────┴────────┐   │
│  │              Unified MCP Endpoint                     │   │
│  │          localhost:9315 (existing port)                │   │
│  │                                                       │   │
│  │  ┌─────────┐  ┌──────────┐  ┌─────────┐             │   │
│  │  │  Auth    │  │  Rate    │  │  Audit  │             │   │
│  │  │  Layer   │  │  Limiter │  │  Log    │             │   │
│  │  └─────────┘  └──────────┘  └─────────┘             │   │
│  └──────────────────────┬────────────────────────────────┘   │
│                         │                                    │
└─────────────────────────┼────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
    ┌─────┴─────┐   ┌────┴────┐   ┌──────┴──────┐
    │ Claude    │   │ Codex   │   │ Gemini CLI  │
    │ Code      │   │         │   │ / Cursor    │
    └───────────┘   └─────────┘   └─────────────┘
```

**Key concept:** AI clients connect to Termpolis's single MCP endpoint. When they call a tool, Termpolis either handles it (built-in tools) or proxies it to the appropriate upstream MCP server (gateway mode). The AI client doesn't know or care which — it sees one unified tool catalog.

### 2.2 Gateway Proxy — How It Works

**New component: `src/main/mcpGateway.ts`**

The gateway maintains a registry of upstream MCP servers and proxies tool calls to them.

```typescript
interface UpstreamMCPServer {
  id: string;                          // unique identifier
  name: string;                        // display name
  description: string;                 // what it does
  connectionType: 'stdio' | 'sse' | 'http';
  command?: string;                    // for stdio: command to spawn
  args?: string[];                     // for stdio: command args
  url?: string;                        // for http/sse: server URL
  env?: Record<string, string>;        // env vars (references, not values)
  tools: UpstreamTool[];               // tools this server exposes
  status: 'connected' | 'disconnected' | 'error';
  permissions: ToolPermissions;        // what this server is allowed to do
  addedAt: string;                     // ISO timestamp
  source: 'manual' | 'registry' | 'imported';
}

interface UpstreamTool {
  name: string;
  description: string;
  inputSchema: object;
  approved: boolean;                   // user must approve each tool
  allowedModels: string[];             // which AI models can call this tool
  callCount: number;                   // usage tracking
  lastCalled: string | null;
}

interface ToolPermissions {
  fileRead: boolean;
  fileWrite: boolean;
  networkAccess: boolean;
  shellExec: boolean;
  envAccess: boolean;
}
```

**Proxy flow:**

1. AI client calls tool via Termpolis MCP endpoint
2. Termpolis checks: is this a built-in tool? → handle directly
3. If not, look up which upstream server owns this tool
4. Check permissions: is this tool approved? Is this model allowed to call it?
5. If approved, proxy the call to the upstream server
6. Log the call in audit log (tool name, server, model, input summary, response summary)
7. Return response to AI client

**What Termpolis does NOT do:**
- Does not download, install, or execute server code
- Does not manage server processes (user starts them)
- Does not store credentials (env vars are references, user sets them)
- Does not modify upstream requests or responses (transparent proxy)

### 2.3 Tool Discovery & Aggregation

When a user adds an upstream MCP server, Termpolis:

1. Connects to the server
2. Calls `tools/list` to discover available tools
3. Presents the tool list to the user for approval
4. Approved tools are merged into Termpolis's unified tool catalog
5. AI clients see built-in + approved upstream tools as one flat list

**Namespace collision handling:**
- If two upstream servers expose a tool with the same name, prefix with server ID
- Example: `github__create_issue` vs `linear__create_issue`
- Built-in Termpolis tools always take priority (no prefix)

### 2.4 Integration with Existing Architecture

**Modifications to existing files:**

| File | Change |
|------|--------|
| `src/main/mcpServer.ts` | Add gateway proxy routing after built-in tool lookup. Extend `tools/list` response to include approved upstream tools. |
| `src/main/index.ts` | Initialize mcpGateway on app launch. Load saved upstream server configs from session store. |
| `src/main/sessionStore.ts` | Add `upstreamServers: UpstreamMCPServer[]` to persisted session data. |
| `src/preload/index.ts` | Add `mcpHub` API surface for renderer to manage upstream servers. |
| `src/renderer/src/store/terminalStore.ts` | Add upstream server state, approval state, permission state. |

**New files:**

| File | Purpose |
|------|---------|
| `src/main/mcpGateway.ts` | Gateway proxy logic, upstream connection management, tool aggregation |
| `src/main/mcpRegistry.ts` | Registry client — fetch, search, and import server configs |
| `src/renderer/src/components/MCPHub/` | UI components for hub management |

---

## Part 3: Security Architecture

### 3.1 Design Philosophy

**Termpolis never executes third-party code.** The gateway proxies requests to MCP servers that the user has installed and started independently. Termpolis adds visibility and control, but the execution boundary stays with the user's OS.

This is fundamentally different from a plugin system:

| Plugin System (e.g., OpenClaw) | Gateway Model (Termpolis) |
|------|------|
| Downloads and runs third-party code | Never downloads executables |
| Plugin runs inside the app process | MCP servers run as separate OS processes |
| Compromise of one plugin = compromise of app | Compromise of upstream server is isolated |
| Must audit all plugin code | Only audits configuration (JSON) |
| Attack surface grows with each plugin | Attack surface is fixed (proxy logic only) |

### 3.2 Threat Model

| Threat | Mitigation |
|--------|------------|
| Malicious MCP server exfiltrates data | Traffic visibility dashboard shows all tool calls. User can see exactly what data flows through each server. Per-tool approval means servers can't silently add new tools. |
| MCP server calls tools it shouldn't | Permission system restricts what categories of operations each server can perform (fileRead, fileWrite, shellExec, etc.). Model-to-tool access control limits which AI models can invoke which tools. |
| Man-in-the-middle on MCP traffic | Localhost-only binding (existing). Upstream stdio servers communicate via stdin/stdout (no network). HTTP/SSE upstreams should use TLS (Termpolis warns if not). |
| Malicious registry config | Registry configs are JSON metadata only — no code. Configs go through community review before "verified" badge. Unverified configs show clear warning. User must still install the server themselves. |
| Supply chain attack via registry | Registry shares configurations, not executables. Install instructions point to official package managers (npm, pip, cargo). Termpolis never runs `npm install` or equivalent. |
| Credential theft | Env vars stored as references (`${GITHUB_TOKEN}`), not values. Termpolis reads them from the user's environment at connection time. Never persisted to disk. |
| Denial of service via upstream | Per-upstream rate limits. Circuit breaker: if upstream fails 5 times in 60 seconds, temporarily disconnect. Upstream timeout: 30 seconds per tool call. |
| Unauthorized tool access | Every tool requires explicit user approval before it appears in the unified catalog. Revoked tools are immediately removed from the catalog. |

### 3.3 Permission Model

**Three levels of control:**

**Level 1 — Server Permissions (coarse)**
When adding an upstream server, user sees what permission categories it needs:
```
GitHub MCP Server wants:
  [x] Network access (API calls to github.com)
  [x] File read (read local repo files)
  [ ] File write
  [ ] Shell execution
  [ ] Environment variable access
```

**Level 2 — Tool Approval (per-tool)**
After connecting, user sees each tool and approves individually:
```
Tools from GitHub MCP:
  [x] list_issues — List issues in a repository
  [x] get_pull_request — Get PR details
  [ ] create_issue — Create a new issue (REQUIRES APPROVAL)
  [ ] merge_pull_request — Merge a PR (REQUIRES APPROVAL)
```

Write/mutating tools are unapproved by default. Read-only tools can be auto-approved (user configurable).

**Level 3 — Model Access Control (per-model)**
Which AI models can call which tools:
```
Tool: merge_pull_request
  [x] Claude Code (Opus/Sonnet) — allowed
  [ ] Codex — blocked
  [ ] Gemini — blocked
  [ ] Aider+Qwen — blocked
```

This integrates with the existing capability rating system in `agentCapabilities.ts`. Dangerous tools get restricted to the most capable/trusted models.

### 3.4 Audit & Visibility

**Extend existing audit log (src/main/mcpServer.ts) to include:**

```jsonl
{"ts":"2026-04-16T14:30:00Z","type":"proxy","upstream":"github-mcp","tool":"create_issue","model":"claude","input_summary":"repo:termpolis title:Fix auth bug","status":"ok","latency_ms":340}
{"ts":"2026-04-16T14:30:05Z","type":"proxy","upstream":"slack-mcp","tool":"send_message","model":"gemini","input_summary":"channel:#dev msg:PR ready","status":"denied","reason":"model_not_allowed"}
```

**New dashboard panel: MCP Traffic View**
- Real-time feed of all proxied tool calls
- Filter by upstream server, model, tool, status
- Highlights denied calls in red
- Shows input/output summaries (truncated, no credentials)
- Export to JSON for compliance

### 3.5 Security Notifications

Termpolis should surface security-relevant events in the UI:

| Event | Display |
|-------|---------|
| New tool discovered on upstream | Banner: "GitHub MCP added tool `delete_repo` — approve?" |
| Upstream server unreachable | Status indicator turns red in hub dashboard |
| Rate limit hit on upstream | Warning in status bar |
| Denied tool call | Flash notification with details |
| Unverified registry config imported | Warning modal before connection |

---

## Part 4: MCP Registry

### 4.1 What the Registry Is

A searchable catalog of MCP server **configurations** — not code. Each entry is a JSON recipe that tells the user how to install and configure a server, and tells Termpolis how to connect to it.

### 4.2 Registry Entry Schema

```json
{
  "id": "github-mcp",
  "name": "GitHub MCP Server",
  "description": "Issues, PRs, reviews, actions, and repository management",
  "author": "anthropic",
  "version": "2.1.0",
  "license": "MIT",
  "repository": "https://github.com/anthropics/github-mcp-server",
  "verified": true,
  "category": "version-control",
  "tags": ["github", "git", "issues", "pull-requests", "ci"],

  "install": {
    "npm": "npm install -g @anthropic/github-mcp-server",
    "brew": "brew install github-mcp-server",
    "manual": "https://github.com/anthropics/github-mcp-server#install"
  },

  "connection": {
    "type": "stdio",
    "command": "github-mcp-server",
    "args": ["--token", "${GITHUB_TOKEN}"]
  },

  "requires_env": [
    {
      "name": "GITHUB_TOKEN",
      "description": "Personal access token with repo scope",
      "setup_url": "https://github.com/settings/tokens"
    }
  ],

  "declared_permissions": {
    "networkAccess": true,
    "fileRead": true,
    "fileWrite": false,
    "shellExec": false,
    "envAccess": true
  },

  "expected_tools": [
    "list_issues",
    "get_issue",
    "create_issue",
    "list_pull_requests",
    "get_pull_request",
    "create_pull_request",
    "merge_pull_request"
  ],

  "compatibility": {
    "claude": "verified",
    "codex": "community-reported",
    "gemini": "community-reported",
    "aider": "untested"
  },

  "community": {
    "installs": 12400,
    "rating": 4.7,
    "reviews": 89
  }
}
```

### 4.3 Registry Hosting

**Two options (implement both):**

**Option A — Bundled Registry (offline-capable)**
- Ship a curated JSON file of verified server configs with each Termpolis release
- Located at `resources/registry/mcp-servers.json`
- Updated via app updates
- Works offline, no network dependency

**Option B — Community Registry (GitHub-backed)**
- GitHub repository: `termpolis/mcp-registry`
- Each server config is a JSON file in the repo
- Contributions via pull request (community review)
- Termpolis fetches latest registry on launch (with local cache fallback)
- No custom backend needed — Git is the database

**Verification tiers:**

| Tier | Badge | Criteria |
|------|-------|----------|
| Verified | Green checkmark | Reviewed by Termpolis maintainers, author verified |
| Community | Blue circle | 3+ community reviews, no reported issues |
| Unverified | Yellow warning | New submission, not yet reviewed |

### 4.4 Registry UI

**New component: `src/renderer/src/components/MCPHub/Registry.tsx`**

```
┌─────────────────────────────────────────────────────────────┐
│  MCP Server Registry                              [Search]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Categories: All | Version Control | Databases | Messaging  │
│              Cloud | Monitoring | Productivity | Local       │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ [✓] GitHub MCP                        ★4.7 (89)      │  │
│  │     Issues, PRs, reviews, actions                     │  │
│  │     by: anthropic | verified | 12.4k installs         │  │
│  │     [View Setup] [Connect]                            │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │ [○] Linear MCP                        ★4.5 (34)      │  │
│  │     Issues, projects, cycles                          │  │
│  │     by: linear-team | verified | 5.2k installs        │  │
│  │     [View Setup] [Connect]                            │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │ [!] Custom Internal API               unverified     │  │
│  │     Company-specific REST API bridge                  │  │
│  │     by: community | 12 installs                       │  │
│  │     [View Setup] [Connect — unverified, use caution]  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**"View Setup" shows:**
- Install command for the user's platform
- Required environment variables with setup links
- Expected tools the server exposes
- Compatibility matrix with each AI model
- Link to source repository for audit

**"Connect" flow:**
1. Check if server binary is installed (which/where check)
2. If not, show install instructions — user runs them in their own terminal
3. If installed, show permission request modal
4. User approves permissions and tools
5. Termpolis connects and adds to gateway

---

## Part 5: Hub Management Dashboard

### 5.1 New UI Section: MCP Hub

Add to the existing sidebar alongside Terminals, Workspaces, Git, and AI Profiles.

**Location: Sidebar tab or dedicated Ctrl+Shift+M shortcut**

### 5.2 Dashboard Layout

```
┌────────────────────────────────────────────────────────────┐
│  MCP Hub                                                   │
├────────┬───────────────────────────────────────────────────┤
│        │                                                   │
│ Servers│  Connected Servers (3)                             │
│        │                                                   │
│ Tools  │  ┌─ GitHub MCP ──────────────── [●] Connected ─┐  │
│        │  │  Tools: 7 approved, 2 pending                │  │
│ Traffic│  │  Calls today: 142 | Errors: 0                │  │
│        │  │  Models: Claude, Codex                        │  │
│Registry│  │  [Manage Tools] [Disconnect]                  │  │
│        │  └──────────────────────────────────────────────┘  │
│        │                                                   │
│        │  ┌─ Slack MCP ───────────────── [●] Connected ─┐  │
│        │  │  Tools: 3 approved, 0 pending                │  │
│        │  │  Calls today: 28 | Errors: 1                 │  │
│        │  │  Models: Claude only                          │  │
│        │  │  [Manage Tools] [Disconnect]                  │  │
│        │  └──────────────────────────────────────────────┘  │
│        │                                                   │
│        │  ┌─ Postgres MCP ──────────── [!] 2 pending ──┐  │
│        │  │  Tools: 4 approved, 2 pending approval       │  │
│        │  │  ⚠ drop_table, truncate_table need approval  │  │
│        │  │  [Review Pending] [Manage Tools]              │  │
│        │  └──────────────────────────────────────────────┘  │
│        │                                                   │
│        │  [+ Add Server]  [Browse Registry]                │
│        │                                                   │
└────────┴───────────────────────────────────────────────────┘
```

### 5.3 Tools View

```
┌─────────────────────────────────────────────────────────────┐
│  All MCP Tools (24 total)                    [Search tools] │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Source        Tool                 Models     Calls  Status│
│  ─────────    ────                 ──────     ─────  ──────│
│  [built-in]   list_terminals       all        89     ✓     │
│  [built-in]   run_command          all        234    ✓     │
│  [built-in]   swarm_send_message   all        45     ✓     │
│  ...14 built-in tools...                                    │
│                                                             │
│  [github]     list_issues          Claude,Codex 52   ✓     │
│  [github]     create_issue         Claude       18   ✓     │
│  [github]     merge_pull_request   Claude       3    ✓     │
│                                                             │
│  [slack]      send_message         Claude       28   ✓     │
│  [slack]      list_channels        Claude       12   ✓     │
│                                                             │
│  [postgres]   query                Claude,Codex 31   ✓     │
│  [postgres]   drop_table           —            0    ⏳     │
│  [postgres]   truncate_table       —            0    ⏳     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 5.4 Traffic View

```
┌─────────────────────────────────────────────────────────────┐
│  MCP Traffic                    [Filter ▾]  [Export JSON]   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  14:30:05  ✓ claude → github:create_issue                   │
│            repo:termpolis title:"Fix auth flow"    340ms    │
│                                                             │
│  14:30:02  ✗ gemini → slack:send_message           DENIED   │
│            reason: model not in allowed list                 │
│                                                             │
│  14:29:58  ✓ claude → postgres:query                        │
│            SELECT count(*) FROM users WHERE...     120ms    │
│                                                             │
│  14:29:45  ✓ codex → github:list_issues                     │
│            repo:termpolis state:open               280ms    │
│                                                             │
│  14:29:30  ⚠ claude → postgres:drop_table          BLOCKED  │
│            reason: tool not approved                         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Part 6: Configuration Sharing & Import/Export

### 6.1 Export Hub Config

Users can export their entire MCP hub setup as a single JSON file:

```json
{
  "termpolis_hub_version": "1.0",
  "exported_at": "2026-04-16T14:30:00Z",
  "servers": [
    {
      "registry_id": "github-mcp",
      "custom_permissions": { ... },
      "approved_tools": ["list_issues", "create_issue", ...],
      "model_access": { "claude": true, "codex": true, "gemini": false }
    },
    ...
  ]
}
```

**What's NOT exported:** Environment variable values, auth tokens, credentials.

### 6.2 Import Hub Config

A team lead exports their config, shares it on Slack/Teams. Teammates import it:

1. Open Termpolis → MCP Hub → Import Config
2. Select JSON file
3. Termpolis shows which servers are in the config
4. For each server: check if installed → show install instructions if not
5. Apply permissions and tool approvals from the config
6. User still sets their own env vars

This enables team-wide MCP standardization without sharing credentials.

### 6.3 Team Config Sync (Future)

For organizations: a shared config file in the team's repo (`.termpolis/mcp-hub.json`) that Termpolis reads on launch. Same as import, but auto-synced via git pull.

---

## Part 7: Integration with Existing Swarm System

### 7.1 MCP-Aware Smart Router

The existing smart router (`smartRouter.ts`) assigns tasks based on agent capability scores. Extend this to factor in which MCP tools each agent has access to:

```typescript
// Existing: capability score
let score = strength * 20;

// New: MCP tool availability bonus
if (taskRequiresTool('github:create_issue') && agentHasTool('github:create_issue')) {
  score += 15;
}
if (taskRequiresTool('github:create_issue') && !agentHasTool('github:create_issue')) {
  score -= 50; // can't do the job without the tool
}
```

**Example:** A task "create a GitHub issue for this bug" would strongly prefer Claude (which has github:create_issue approved) over Aider (which doesn't).

### 7.2 Conductor Awareness

Update the conductor prompt (`conductorPrompt.ts`) to include available MCP tools per agent:

```
Agent: Claude Code
  Role: Refactoring, Architecture, Code Review
  MCP Tools: github (7 tools), slack (3 tools), postgres (4 tools)

Agent: Codex
  Role: Testing, Documentation
  MCP Tools: github (5 tools — no write access)

Agent: Aider+Qwen
  Role: Bulk Tasks
  MCP Tools: none (local only)
```

This lets the conductor make smarter delegation decisions.

### 7.3 Cost Tracking Extension

The existing cost tracker (`costTracker.ts`) monitors AI token spend. Extend it to track MCP tool call costs:

- Some MCP servers have API rate limits (GitHub: 5000/hr)
- Track calls per server per hour
- Show in status bar alongside token costs
- Warn when approaching API rate limits

---

## Part 8: Implementation Roadmap

### Phase 1: Gateway Foundation (v1.7)
**Goal:** Termpolis can proxy tool calls to upstream MCP servers with full security.

**New files:**
- `src/main/mcpGateway.ts` — proxy logic, upstream connection management
- `src/main/mcpGatewayConfig.ts` — config persistence for upstream servers

**Modified files:**
- `src/main/mcpServer.ts` — route unknown tools to gateway
- `src/main/index.ts` — initialize gateway, load saved configs
- `src/main/sessionStore.ts` — persist upstream server configs
- `src/preload/index.ts` — expose `mcpHub` API

**New UI:**
- `src/renderer/src/components/MCPHub/ServerList.tsx` — list connected servers
- `src/renderer/src/components/MCPHub/AddServer.tsx` — manual server config form
- `src/renderer/src/components/MCPHub/ToolApproval.tsx` — approve/deny tools

**Tests:**
- Gateway proxy unit tests (tool routing, permission checks, rate limiting)
- Tool discovery and aggregation tests
- Permission enforcement tests
- E2E: add server → approve tools → AI client calls proxied tool

**Deliverables:**
- [ ] Gateway proxy routes tool calls to upstream stdio/http MCP servers
- [ ] Per-tool approval workflow
- [ ] Per-model access control
- [ ] Extended audit log with proxy events
- [ ] Add/remove upstream servers via UI
- [ ] Upstream server health monitoring (connected/disconnected/error)
- [ ] Circuit breaker for failing upstreams
- [ ] Persist upstream configs across sessions

### Phase 2: Registry & Discovery (v1.8)
**Goal:** Users can browse and install MCP servers from a curated registry.

**New files:**
- `src/main/mcpRegistry.ts` — fetch and cache registry data
- `resources/registry/mcp-servers.json` — bundled offline registry

**New UI:**
- `src/renderer/src/components/MCPHub/Registry.tsx` — browsable catalog
- `src/renderer/src/components/MCPHub/ServerDetail.tsx` — install instructions, compatibility

**External:**
- GitHub repo: `termpolis/mcp-registry` — community-contributed configs
- Contribution guide and review process

**Deliverables:**
- [ ] Bundled registry with 20+ verified server configs
- [ ] GitHub-backed community registry
- [ ] Search and filter by category, compatibility, rating
- [ ] Verification tiers (verified, community, unverified)
- [ ] One-click "Connect" for installed servers
- [ ] Install detection (is this server already installed?)

### Phase 3: Traffic Visibility (v1.9)
**Goal:** Full visibility into all MCP traffic flowing through the hub.

**New UI:**
- `src/renderer/src/components/MCPHub/TrafficView.tsx` — real-time tool call feed
- `src/renderer/src/components/MCPHub/ToolsOverview.tsx` — aggregated tool catalog

**Deliverables:**
- [ ] Real-time traffic dashboard with filtering
- [ ] Unified tool catalog view (built-in + upstream)
- [ ] Call count, error rate, latency per tool
- [ ] Export traffic log to JSON
- [ ] Security notifications for denied calls, new tools, server issues
- [ ] Status bar integration showing active upstream count

### Phase 4: Config Sharing & Smart Routing (v2.0)
**Goal:** Teams can share MCP configs. Swarm router is MCP-aware.

**Deliverables:**
- [ ] Export/import hub configs (JSON, no credentials)
- [ ] Team config file (`.termpolis/mcp-hub.json`) auto-loaded from repo
- [ ] Smart router factors in MCP tool availability
- [ ] Conductor prompt includes per-agent MCP tool inventory
- [ ] API rate limit tracking per upstream server

### Phase 5: Community & Network Effects (v2.1+)
**Goal:** Termpolis becomes the place where MCP configs are shared and discovered.

**Deliverables:**
- [ ] Publish MCP configs from within Termpolis (opens PR on registry repo)
- [ ] Compatibility reporting (report which model/tool combos work)
- [ ] Usage statistics (most popular servers, trending)
- [ ] Workflow templates: "Here's a pre-built GitHub + Slack + Linear setup"
- [ ] MCP server health dashboard (community-reported uptime)

---

## Part 9: What Termpolis Does NOT Become

This list is as important as what we build. These are anti-patterns to avoid:

| Do NOT | Why |
|--------|-----|
| Execute third-party code | Core security principle. Gateway only. |
| Auto-install MCP servers | User installs, Termpolis connects. No npm/pip/cargo execution. |
| Store credentials on disk | Env var references only. User manages their own secrets. |
| Build a custom backend | GitHub repo is the registry database. No servers to maintain. |
| Become a cloud service | Termpolis is a desktop app. No accounts, no telemetry, no SaaS. |
| Add a plugin system | MCP IS the extension mechanism. No need for plugins. |
| Proxy to remote MCP servers over the internet | Localhost only for v1. Remote proxy is a future consideration with additional security requirements. |

---

## Part 10: Competitive Positioning

### Termpolis MCP Hub vs. Alternatives

| Feature | Termpolis | OpenClaw | Claude Code | Cursor |
|---------|-----------|----------|-------------|--------|
| Multi-model orchestration | Yes (4 models) | Single model | Single model | Single model |
| MCP management UI | Yes (Phase 1+) | No | Config file only | Config file only |
| Traffic visibility | Yes (Phase 3) | No | No | No |
| Tool approval workflow | Yes (Phase 1) | No | Trust-all or deny | Trust-all or deny |
| Model-to-tool access control | Yes (Phase 1) | N/A | No | No |
| Community MCP registry | Yes (Phase 2) | No | No | No |
| Config sharing | Yes (Phase 4) | No | Manual JSON copy | Manual JSON copy |
| Third-party code execution | Never | Yes (security risk) | Via MCP servers | Via MCP servers |
| Security audit log | Yes (existing) | Limited | No | No |
| Free | Yes | Yes | $20-200/mo | $20/mo |

### One-Line Pitch

**"The secure, model-agnostic MCP hub where AI tools connect — configure once, use everywhere, see everything."**

---

## Appendix A: File Impact Summary

### New Files to Create

```
src/main/mcpGateway.ts              — Gateway proxy, upstream management
src/main/mcpGatewayConfig.ts        — Config types and persistence
src/main/mcpRegistry.ts             — Registry client
resources/registry/mcp-servers.json  — Bundled offline registry

src/renderer/src/components/MCPHub/
  ├── index.tsx                      — Hub container / tab router
  ├── ServerList.tsx                 — Connected servers overview
  ├── AddServer.tsx                  — Manual server config form
  ├── ToolApproval.tsx               — Per-tool approval UI
  ├── ToolsOverview.tsx              — Unified tool catalog
  ├── TrafficView.tsx                — Real-time traffic dashboard
  ├── Registry.tsx                   — Browsable server catalog
  ├── ServerDetail.tsx               — Server info, install guide
  ├── PermissionModal.tsx            — Permission request dialog
  └── ConfigExport.tsx               — Import/export hub configs

tests/electron/mcpGateway.test.ts    — Gateway unit tests
tests/electron/mcpRegistry.test.ts   — Registry client tests
tests/renderer/MCPHub.test.tsx       — Hub UI component tests
e2e/mcp-hub.spec.ts                  — E2E gateway integration tests
```

### Existing Files to Modify

```
src/main/mcpServer.ts               — Add gateway routing
src/main/index.ts                    — Initialize gateway
src/main/sessionStore.ts             — Persist upstream configs
src/preload/index.ts                 — Expose mcpHub API
src/renderer/src/store/terminalStore.ts — Upstream server state
src/renderer/src/App.tsx             — Add MCPHub route/keybinding
src/renderer/src/components/Sidebar/ — Add MCP Hub tab
src/renderer/src/lib/smartRouter.ts  — MCP-aware routing
src/renderer/src/lib/conductorPrompt.ts — Include MCP tool inventory
src/renderer/src/lib/costTracker.ts  — Track API rate limits
```

### External Repositories to Create

```
termpolis/mcp-registry               — Community MCP server configs
  ├── servers/                       — One JSON file per server
  ├── CONTRIBUTING.md                — How to submit a server config
  ├── REVIEW.md                      — Review criteria for verification
  └── schema.json                    — JSON schema for server configs
```

---

## Appendix B: Security Checklist for Each Phase

### Phase 1 Checklist
- [ ] All upstream tool calls require explicit user approval
- [ ] Proxy never modifies request/response payloads
- [ ] Auth token rotation remains per-launch
- [ ] Audit log captures all proxy events
- [ ] Circuit breaker prevents upstream failure cascade
- [ ] No credentials stored to disk
- [ ] Localhost-only binding maintained
- [ ] Rate limits applied per-upstream
- [ ] Namespace collision handled (no tool name spoofing)
- [ ] Permission revocation takes effect immediately

### Phase 2 Checklist
- [ ] Registry configs are JSON-only (no executable content)
- [ ] Verification tiers clearly displayed
- [ ] Unverified configs show warning modal
- [ ] Install instructions link to official package managers only
- [ ] No auto-install capability
- [ ] Registry cache has integrity check (hash verification)

### Phase 3 Checklist
- [ ] Traffic view truncates sensitive data (tokens, passwords)
- [ ] Export function strips credentials from logs
- [ ] No PII in traffic logs

### Phase 4 Checklist
- [ ] Config export excludes all credential values
- [ ] Config import validates schema before applying
- [ ] Team config file cannot override security settings
