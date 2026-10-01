// `--disconnect-agents` without Electron: the command the Linux .deb's prerm runs
// (build/linux/before-remove.sh) as each user, with the app's own binary in Node mode:
//
//   ELECTRON_RUN_AS_NODE=1 /opt/Termpolis/termpolis /opt/Termpolis/resources/disconnect-agents.cjs [userData]
//
// electron.vite.config.ts bundles disconnectAgentsEntry.ts, which calls this, into that one
// CommonJS file. It does what index.ts does for `Termpolis.exe --disconnect-agents` on Windows:
// the same disconnectAgentIntegration() as Settings ▸ Agent integration, and the same rows on
// stdout. Node mode has no `app`, so userData comes from argv (the prerm passes the folder it
// found), or else from Electron's own rule for Linux.
import { homedir } from 'os'
import { join } from 'path'
import type { AgentIntegrationChange } from '../shared/agentIntegration'
import { disconnectAgentIntegration, resolveAgentIntegrationPaths } from './agentIntegrationManager'

export interface DisconnectAgentsCliDeps {
  homedir?: () => string
  disconnect?: typeof disconnectAgentIntegration
  log?: (line: string) => void
  error?: (line: string) => void
}

/** What `app.getPath('userData')` is on Linux: Electron's appData, which is $XDG_CONFIG_HOME
 *  when that is set and non-empty and ~/.config otherwise, plus the name index.ts gives the
 *  app with app.setName(). */
export function linuxUserDataDir(home: string, env: Readonly<Record<string, string | undefined>>): string {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'termpolis')
}

/** One printed row, in the same format index.ts prints for `--disconnect-agents`. */
export function formatDisconnectRow(r: AgentIntegrationChange): string {
  return `${r.agent}: ${r.action} ${r.what} (${r.file})${r.error ? ` - ${r.error}` : ''}`
}

/** Run the disconnect for the current user. `argv` is what follows the script path. Returns
 *  the exit code: 0 once the disconnect has run, 1 if it threw. */
export function runDisconnectAgentsCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: DisconnectAgentsCliDeps = {},
): number {
  const log = deps.log ?? ((line: string) => console.log(line))
  const error = deps.error ?? ((line: string) => console.error(line))
  try {
    const home = (deps.homedir ?? homedir)()
    const userData = argv[0] || linuxUserDataDir(home, env)
    const rows = (deps.disconnect ?? disconnectAgentIntegration)(resolveAgentIntegrationPaths(home, userData, env))
    for (const r of rows) log(formatDisconnectRow(r))
    return 0
  } catch (e) {
    error(`Could not disconnect agents: ${(e as Error)?.message ?? e}`)
    return 1
  }
}
