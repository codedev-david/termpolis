/**
 * stdio-adapter.cjs Contract Test
 * --------------------------------
 * The adapter is spawned as a subprocess by Claude Code. It reads:
 *   - `mcp-token` and `mcp-port` from the user's app-data dir
 *   - JSON-RPC messages from stdin
 * ...and proxies each request to Termpolis's HTTP MCP server at 127.0.0.1.
 *
 * If any of these contracts drift — e.g., the app starts writing to a
 * different directory, or the adapter stops sending the Authorization
 * header — the swarm conductor silently fails. There is NO runtime
 * error message visible to users.
 *
 * These are cheap regex-based invariants that guard against that drift.
 * They are intentionally loose (no mocked stdin/http test) — the goal
 * is "catch someone deleting half the adapter by accident", not
 * end-to-end verification. End-to-end is covered by the full-pipeline
 * swarm E2E and mcp-registration.spec.ts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const REPO_ROOT = resolve(__dirname, '..', '..')
const ADAPTER = resolve(REPO_ROOT, 'src/mcp-adapter/stdio-adapter.cjs')

describe('stdio-adapter.cjs — runtime contract', () => {
  const src = existsSync(ADAPTER) ? readFileSync(ADAPTER, 'utf-8') : ''

  it('file exists (the whole thing is moot otherwise)', () => {
    expect(existsSync(ADAPTER)).toBe(true)
    expect(src.length).toBeGreaterThan(0)
  })

  it('has a node shebang so it can be spawned directly by Claude Code', () => {
    // Not strictly required (since we launch via `node <file>` in MCP config)
    // but the shebang future-proofs direct-execution setups.
    expect(src.startsWith('#!/usr/bin/env node')).toBe(true)
  })

  it('reads the mcp-token file (auth)', () => {
    expect(src).toContain("'mcp-token'")
  })

  it('reads the mcp-port file (dynamic port)', () => {
    expect(src).toContain("'mcp-port'")
  })

  it('uses platform-specific app-data dirs that match main/index.ts writers', () => {
    // Windows: %APPDATA%\termpolis
    expect(src).toMatch(/APPDATA/)
    expect(src).toMatch(/['"]termpolis['"]/)
    // macOS: ~/Library/Application Support/termpolis
    expect(src).toMatch(/Library/)
    expect(src).toMatch(/Application Support/)
    // Linux: ~/.config/termpolis
    expect(src).toMatch(/\.config/)
  })

  it('POSTs to 127.0.0.1 on the /mcp endpoint', () => {
    // Regressions we want to catch: hard-coded "localhost" (fine) but
    // also hard-coded :9315 with no fallback read from the port file.
    expect(src).toMatch(/127\.0\.0\.1/)
    expect(src).toMatch(/['"]\/mcp['"]/)
  })

  it('sends Authorization: Bearer <token> — server rejects requests without it', () => {
    expect(src).toMatch(/Authorization[^\n]*Bearer/i)
  })

  it('writes JSON responses to stdout (newline-delimited JSON-RPC)', () => {
    // Must write to stdout; stderr would be ignored by Claude Code.
    expect(src).toMatch(/process\.stdout\.write/)
    // Must emit '\n' so Claude Code's line reader terminates each message.
    expect(src).toMatch(/\\n/)
  })

  it('silently consumes MCP notifications (no id) — forwarding them confuses the server', () => {
    // The adapter must NOT forward `notifications/*` or `initialized` to
    // the server; they are client→adapter fire-and-forget. Forwarding
    // them causes the server to reply, which then confuses Claude Code.
    expect(src).toMatch(/notifications\//)
    expect(src).toMatch(/initialized/)
  })

  it('returns a JSON-RPC error response on failure (so Claude Code sees an error, not a hang)', () => {
    expect(src).toMatch(/jsonrpc.*2\.0/)
    expect(src).toMatch(/-32603/) // JSON-RPC internal error code
  })

  it('performs a startup health check so humans can see "adapter connected" on stderr', () => {
    expect(src).toMatch(/\/health/)
  })
})

describe('stdio-adapter.cjs — packaging invariants', () => {
  it('is a .cjs file (CommonJS) — .mjs/.js would break under Electron asarUnpack', () => {
    expect(ADAPTER.endsWith('.cjs')).toBe(true)
  })

  it('does not import from node_modules — it must be self-contained in the installer', () => {
    const src = readFileSync(ADAPTER, 'utf-8')
    // Only core Node modules allowed. Anything else would not be shipped
    // by extraResources and would blow up at runtime.
    const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
    const nonCore = requires.filter((r) => {
      // Relative paths are fine — they go through extraResources
      if (r.startsWith('.') || r.startsWith('/')) return false
      // Core modules have no slash and are known
      const core = new Set([
        'fs',
        'path',
        'os',
        'http',
        'https',
        'net',
        'readline',
        'stream',
        'events',
        'url',
        'util',
        'crypto',
        'child_process',
      ])
      return !core.has(r)
    })
    expect(nonCore, `adapter imports non-core modules: ${nonCore.join(', ')}`).toEqual([])
  })
})
