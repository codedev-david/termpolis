import {
  AGENT_INTEGRATION_WRITES,
  PRIMER_HOOK_DESCRIPTION,
  type AgentId,
  type AgentIntegrationStatus,
} from '../../../../shared/agentIntegration'

// What connecting writes into each agent's config, word for word from the shared list main
// writes by, so onboarding, the one-time review and Settings can never promise less than main
// does. Given a status it also says which agents are on this machine and where their config is.

export const AGENT_ORDER: readonly AgentId[] = ['claude', 'codex', 'gemini']

export const AGENT_LABELS: Readonly<Record<AgentId, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini / Antigravity CLI',
}

/** The hook checkbox, worded the same everywhere it appears. */
export const PRIMER_HOOK_LABEL = 'Also load project memory when any Claude Code session starts'

/** The home folder, read off Gemini's config path: main always keeps that at
 *  `<home>/.gemini/settings.json`, whatever CLAUDE_CONFIG_DIR or CODEX_HOME say. */
export function homeFromStatus(status: AgentIntegrationStatus): string | null {
  const path = status.agents.gemini.configPath
  const m = /[\\/]\.gemini[\\/]settings\.json$/.exec(path)
  return m && m.index > 0 ? path.slice(0, m.index) : null
}

/** `file` with the home folder shown as `~`; anything outside home is left as it is. */
export function tildify(file: string, home: string | null): string {
  if (!home) return file
  if (file === home) return '~'
  const sep = file.charAt(home.length)
  return file.startsWith(home) && (sep === '/' || sep === '\\') ? '~' + file.slice(home.length) : file
}

export function AgentWritesList({ status }: { status?: AgentIntegrationStatus | null }) {
  const home = status ? homeFromStatus(status) : null
  return (
    <div className="flex flex-col gap-2" data-testid="agent-writes-list">
      {AGENT_ORDER.map(id => {
        const agent = status?.agents[id]
        return (
          <div
            key={id}
            className="flex flex-col gap-1.5 p-3 rounded-lg border border-[#3c3c3c] bg-[#1e1e1e]"
            data-testid={`agent-writes-${id}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-[#d4d4d4]">{AGENT_LABELS[id]}</span>
              {agent && (
                <span
                  className={`text-[11px] ${agent.installed ? 'text-[#7ee2a3]' : 'text-[#9ca3af]'}`}
                  data-testid={`agent-writes-${id}-installed`}
                >
                  {agent.installed ? 'Installed' : 'Not installed: nothing is written for it'}
                </span>
              )}
            </div>
            {agent?.configPath && (
              <code className="text-[11px] text-[#9ca3af] break-all" data-testid={`agent-writes-${id}-path`}>
                {tildify(agent.configPath, home)}
              </code>
            )}
            <ul className="text-[11px] text-[#bbb] list-disc pl-5 space-y-1">
              {AGENT_INTEGRATION_WRITES[id].map(line => <li key={line}>{line}</li>)}
              {id === 'claude' && (
                <li data-testid="agent-writes-hook">Optional: {PRIMER_HOOK_DESCRIPTION}</li>
              )}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
