// Per-run MCP plumbing for a Linked machines job (headlessExec's LinkedJobMcp). claude gets a
// config file holding only Termpolis's server, with the job marker in that server's env, because
// `--strict-mcp-config` would otherwise leave it no server at all. codex needs to know whether its
// config.toml holds Termpolis's own server, which the marker is then set on for the run. agy needs
// nothing: it hands its own environment, marker included, to its MCP servers.
//
// Plain fs + paths, no electron import, so it is tested on its own.

import { unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ServerEntry } from './agentMcpRegistry'
import type { ExecAgent, LinkedJobMcp } from './headlessExec'

export interface LinkedJobMcpDeps {
  /** Termpolis's server entry, as agent configs get it; null when it can't be built. */
  serverEntry(): ServerEntry | null
  /** codex's config.toml holds Termpolis's own server. */
  codexHasTermpolis(): boolean
  /** Where the claude config file goes. */
  tempDir(): string
  writeFile?(file: string, data: string): void
  unlink?(file: string): void
}

/** Job ids are 12 lowercase hex; anything else never becomes part of a file name. */
const JOB_ID = /^[0-9a-z-]{1,64}$/

export function createLinkedJobMcp(deps: LinkedJobMcpDeps): (jobId: string, agent: ExecAgent) => LinkedJobMcp | null {
  // Owner-only: the file holds no secret (the adapter reads its own token), but nobody else needs it.
  const writeFile = deps.writeFile ?? ((file: string, data: string): void => writeFileSync(file, data, { encoding: 'utf8', mode: 0o600 }))
  const unlink = deps.unlink ?? ((file: string): void => unlinkSync(file))
  return (jobId, agent) => {
    if (agent === 'codex') return deps.codexHasTermpolis() ? { codexHasTermpolis: true } : null
    if (agent !== 'claude' || !JOB_ID.test(jobId)) return null
    const entry = deps.serverEntry()
    if (!entry) return null
    const file = join(deps.tempDir(), `termpolis-linked-${jobId}.mcp.json`)
    const termpolis = {
      type: 'stdio',
      command: entry.command,
      args: [...entry.args],
      env: { ...(entry.env ?? {}), TERMPOLIS_LINKED_JOB: jobId },
    }
    writeFile(file, JSON.stringify({ mcpServers: { termpolis } }, null, 2) + '\n')
    return {
      claudeMcpConfig: file,
      dispose: () => {
        try {
          unlink(file)
        } catch {
          /* already gone */
        }
      },
    }
  }
}
