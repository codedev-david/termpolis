/**
 * MCP Adapter Packaging — Regression Guard
 * -----------------------------------------
 * The Termpolis MCP server is bridged to Claude Code via a stdio adapter
 * (src/mcp-adapter/stdio-adapter.cjs). In production the installed app points
 * ~/.mcp.json at `<resources>/mcp-adapter/stdio-adapter.cjs`.
 *
 * If that file isn't physically shipped in the installer, EVERY swarm conductor
 * session silently fails to load MCP tools — the conductor just answers the
 * prompt directly instead of orchestrating agents. There's no hard error;
 * the swarm just never does anything interesting.
 *
 * This was exactly the v1.11.5 bug: package.json's `files: ["out/**\/*"]` did
 * not include src/mcp-adapter/, and there was no extraResources mapping. These
 * tests pin:
 *   (a) the adapter source files still exist where we expect them
 *   (b) package.json.build.extraResources ships them to `resources/mcp-adapter/`
 *   (c) package.json.build.extraResources only ships .cjs (no dev junk)
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

const REPO_ROOT = resolve(__dirname, '..', '..')

describe('MCP stdio adapter packaging', () => {
  it('stdio-adapter.cjs exists at the source path that production references', () => {
    expect(existsSync(resolve(REPO_ROOT, 'src/mcp-adapter/stdio-adapter.cjs'))).toBe(true)
  })

  it('termpolis-cli.cjs exists at the source path referenced by package.json bin', () => {
    expect(existsSync(resolve(REPO_ROOT, 'src/mcp-adapter/termpolis-cli.cjs'))).toBe(true)
  })

  it('package.json bin points at the .cjs files that actually exist', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8'))
    expect(pkg.bin).toBeDefined()
    expect(pkg.bin['termpolis-mcp']).toBe('src/mcp-adapter/stdio-adapter.cjs')
    expect(pkg.bin['termpolis-cli']).toBe('src/mcp-adapter/termpolis-cli.cjs')
  })

  it('electron-builder extraResources ships src/mcp-adapter to resources/mcp-adapter', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8'))
    const extras = pkg.build?.extraResources
    expect(Array.isArray(extras), 'build.extraResources must be an array').toBe(true)

    const adapterEntry = extras.find((e: any) => e?.from === 'src/mcp-adapter')
    expect(adapterEntry, 'extraResources must include { from: "src/mcp-adapter", ... }').toBeDefined()
    // IMPORTANT: the destination `to` must be "mcp-adapter" — the code resolves
    // the adapter via join(process.resourcesPath, "mcp-adapter", "stdio-adapter.cjs").
    // A typo here silently breaks the swarm.
    expect(adapterEntry.to).toBe('mcp-adapter')

    // Only .cjs gets shipped — skips hypothetical .ts, .md, etc.
    expect(adapterEntry.filter).toContain('**/*.cjs')
  })

  it('stdio-adapter.cjs uses the mcp-port and mcp-token files that main/index.ts writes', () => {
    // Defensive contract test: if someone renames the file paths on one side
    // (main/index.ts writes, stdio-adapter reads) the swarm silently breaks.
    const adapter = readFileSync(resolve(REPO_ROOT, 'src/mcp-adapter/stdio-adapter.cjs'), 'utf-8')
    expect(adapter).toContain("'mcp-token'")
    expect(adapter).toContain("'mcp-port'")
  })
})
