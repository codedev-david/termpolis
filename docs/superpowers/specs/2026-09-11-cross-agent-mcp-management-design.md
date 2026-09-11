# Cross-Agent MCP Management — Design

**Date:** 2026-09-11
**Ships as:** v1.41.0
**Status:** approved, implementing

## Problem

Termpolis has a complete MCP gateway subsystem that no human can reach.

`src/main/mcpGateway/` (policy, guard, audit, client) plus `src/main/mcpGatewayRuntime.ts`
is ~1,400 tested lines. Its management functions — `listGatewayServers`,
`addGatewayServer`, `removeGatewayServer`, `getGatewayPolicy`, `setGatewayPolicy` —
have exactly two call sites: their own definitions and
`tests/electron/mcpGatewayRuntime.test.ts`. There are zero references in
`src/preload/` and zero in `src/renderer/`. The only exposure is agent-facing:
`gatewayListTools` / `gatewayCall` at `src/main/index.ts:2991-2992`.

Worse, the subsystem is inert. `mcpGatewayRuntime.ts:122-129` constructs the gateway
with no `prompt` callback, and says why:

> No `prompt` wired yet: with none, `resolveAsk` denies. That is the correct default
> for the first release — the gateway starts closed and the user opens it explicitly
> through settings, rather than a dialog appearing the first time some agent probes
> an upstream server.

`defaultPolicy()` is `{ enabled: true, defaultDecision: 'ask', rules: [] }`. Ask, with
no prompt, resolves to deny. With no settings screen and no rules, **every upstream
gateway call fails closed today.** The code was written expecting a UI that never
shipped.

Separately, users cannot see which MCP servers are registered across their agent CLIs.
Each CLI knows only its own config. Termpolis already writes to all four
(`~/.claude/settings.json`, `~/.mcp.json`, `~/.codex/config.toml`,
`~/.gemini/settings.json`), so it is the only program positioned to show the union.
The motivating failure is mundane: a server times out at startup, the agent is quietly
less capable, and nothing surfaces it.

## What exists — verified

`src/main/agentMcpRegistry.ts` performs **write-only upsert with zero enumeration**.
Every access is a hardcoded single-key lookup on the literal `termpolis`
(`:213-217` Claude, `:324-326` Codex, `:385-390` Gemini). There is no
`Object.keys(mcpServers)` in the module. Foreign servers survive only incidentally
via JSON round-trip. **No existing code can be reused to list them.**

The nearest precedent for enumerating foreign config is `src/main/index.ts:3731-3738`,
which iterates `settings.extraKnownMarketplaces` — marketplaces, not MCP servers.

No TOML parser is a dependency, deliberately (`agentMcpRegistry.ts:313-315`):

> Codex config is TOML — we append a section if it's not already present. Treating the
> file as a text blob is deliberate: a proper TOML parser would choke on any user-made
> syntax error and block registration.

Registration runs unconditionally at every boot inside `app.whenReady()`
(`index.ts:3680, 3689, 3786, 3794`) with no feature flag, consent prompt, or first-run
marker. Results are logged only — never surfaced to the renderer.

## Scope

**Read-only across foreign configs. Read-write on Termpolis's own gateway.**

Rejected: full read-write cross-agent management. Writing arbitrary foreign entries
needs a backup/undo layer that does not exist anywhere in this repo (a grep for
`backup|\.bak|restore|rollback` under `src/main` returns only Termpolis's own log
rotation and memory export), and writing TOML is materially harder than scanning it.
The read path proves the parsing before anything mutates irreplaceable hand-edited
files. Revisit for v1.42.

Rejected: gateway-only. It leaves the differentiated claim unbuilt and the
silent-missing-server problem unsolved.

## Components

### 1. `src/main/mcpInventory.ts` — new

Enumerates MCP servers from all four foreign configs plus the gateway's own list.
Pure read. Never throws — returns per-source status using the existing skip
vocabulary from `RegistryResult` (`missing | corrupt`), so one broken config renders
as one bad row rather than blanking the panel.

```ts
export interface InventoryServer {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  /** Present-in map, keyed by source id. */
  sources: Record<InventorySourceId, boolean>
  /** True when the server is in some sources but not all. */
  drift: boolean
}

export interface InventorySource {
  id: InventorySourceId          // 'claude' | 'globalMcp' | 'codex' | 'gemini' | 'gateway'
  label: string
  path: string
  status: 'ok' | 'missing' | 'corrupt'
  error?: string
}

export interface McpInventory {
  sources: InventorySource[]
  servers: InventoryServer[]
}
```

Paths are injected by the caller, matching `agentMcpRegistry`'s contract that the
module never constructs a path itself. This keeps it unit-testable against fixtures.

### 2. `src/main/mcpToml.ts` — new, small

Enumerates `[mcp_servers.NAME]` table headers out of a Codex config and extracts
`command`, `args`, `url`, `env`. Text scan, no dependency — consistent with the
documented rationale above, and with the sibling text-blob implementations in
`codexParity.ts:109-155` and `artifactInstaller.ts:418-443`.

Must handle: sub-table headers (`[mcp_servers.foo.tools.bar]` must not register as a
server named `foo.tools.bar`), a `[` inside an `args = ["C:\\x[1].cjs"]` value,
CRLF, comments, and an unterminated final section.

### 3. IPC + preload

Channel namespace `mcp:`, following `camelCaseNamespace:kebab-case-verb`:

| Channel | Returns |
|---|---|
| `mcp:inventory` | `McpInventory` |
| `mcp:gateway-servers` | `ServerSpec[]` (env masked) |
| `mcp:gateway-add-server` | `ServerSpec[]` |
| `mcp:gateway-remove-server` | `ServerSpec[]` |
| `mcp:gateway-policy` | `GatewayPolicy` |
| `mcp:gateway-set-policy` | `GatewayPolicy` |
| `mcp:gateway-test` | `{ ok: boolean; tools?: number; error?: string }` |

All wrapped in `ok()` / `err()` from `./ipcResult`, returning the discriminated
`IpcResponse<T>` union. Single-object payloads. Preload methods join the existing
`const api: TermpolisAPI` object; types go in `src/renderer/src/types/index.ts`
alongside the other `…View` DTOs, with the `Window` interface updated in the
`declare global` block.

### 4. `McpServersSettings.tsx` — new tab

A tenth Settings tab, `id: 'mcp'`, label `MCP Servers`. Named export, Tailwind with
bracketed VS Code hexes, `data-testid` on every interactive element, `useState(null)`
plus `useEffect` on mount, explicit Refresh button, **no polling timers**, and
**non-optimistic writes** — the control renders what main confirmed, so a failed write
leaves the UI untouched instead of drifting.

Three render states: unavailable, loading, body. Two sections: the gateway (editable)
and the cross-agent inventory (read-only matrix with a drift marker).

### 5. Wire the `prompt` callback

Give `createGateway` a real `prompt` so `defaultDecision: 'ask'` reaches a dialog
instead of silently denying. Without this the panel can configure a gateway that still
refuses every call.

## Two decisions made without asking

**Health is probe-on-demand, never background.** `liveTransports()` memoizes stdio
transports as live child processes, because MCP servers expect `initialize` once.
A panel that auto-connected would spawn every configured server merely because
Settings was opened. Rows show `configured` until the user clicks Test.

**Env values are masked in main, before crossing IPC.** Foreign MCP configs routinely
carry credentials inline (`args: ["--token", "ghp_…"]`). Enumerating them means reading
secrets. The renderer receives `••••` and never the plaintext; masking happens at the
IPC boundary, not in the component, so the secret never enters a renderer process that
loads remote-ish content.

## Adjacent fixes

Both found while surveying, both in code this feature touches:

1. **Codex registration writes are not atomic.** `agentMcpRegistry.ts:335` and `:342`
   use `writeFileSync` / `appendFileSync` straight to the live file, while Claude and
   Gemini get `atomicWriteJson`'s tmp+rename. A crash mid-write truncates the user's
   Codex config. Fix: route through an atomic text write.
2. **`registerInGlobalMcp` ignores the resolved runner.** `:302` hardcodes
   `command: 'node'`, which is the exact ENOENT bug the comment blocks at `:64-80` and
   `:166-176` describe fixing for the other three agents. `index.ts:3691` passes no
   `node` argument. Fix: accept and use the runner, as its three siblings do.

## Error handling

Every source reports its own status independently. A corrupt `~/.gemini/settings.json`
shows as one `⚠ corrupt` row with its parse error; the other three still render. Foreign
reads are read-only, so corruption is displayed and never "repaired." Nothing throws:
the inventory module inherits `agentMcpRegistry`'s stated contract that a broken config
file should log-and-skip, never crash the main process.

## Testing

- `tests/electron/mcpInventory.test.ts` — fixtures per source per state (valid,
  missing, corrupt, empty), drift detection, env masking.
- `tests/electron/mcpToml.test.ts` — the adversarial cases named in Component 2.
- `tests/renderer/mcpServersSettings.test.tsx` — happy path, every-read-fails branch,
  non-optimistic write, Test button.
- `e2e/mcp-settings.spec.ts` — copied from `e2e/remote-settings.spec.ts`: open Settings,
  click `settings-tab-mcp`, assert the panel and a completed IPC round trip.

Coverage gate stays at 97 / 96 / 95 / 96 (`vitest.config.ts:110-113`). Never lowered;
backfill on the offending file.

## Out of scope

From `docs/MCP-HUB-PROPOSAL.md` Phases 2–4, deliberately not built: community registry,
ratings, verification tiers, per-model access control, traffic dashboard. Each needs an
audience this app does not yet have.

## Release

Direct to `main`, no branch, no PR. `npm version 1.41.0 --no-git-tag-version`, commit,
push, then push the `v1.41.0` tag — the tag is the user-facing trigger for
`.github/workflows/release.yml`, which is draft-first since v1.39.0.
