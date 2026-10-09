import { AgentWritesList, PRIMER_HOOK_LABEL } from './AgentWritesList'

// The tour's first step. Controlled: the tour owns the choice and applies it only when it
// closes, so ticking and unticking here writes nothing.

export interface AgentChoice {
  connect: boolean
  primerHook: boolean
}

export function AgentConnectStep({ connect, primerHook, onChange }: AgentChoice & {
  onChange: (next: AgentChoice) => void
}) {
  return (
    <div className="flex flex-col gap-3" data-testid="onboarding-agent-step">
      <h3 className="text-base font-medium text-[#22D3EE]">Connect your coding agents</h3>
      <p>
        Termpolis can connect Claude Code, Codex and Gemini / Antigravity CLI to its memory and code search.
        This is exactly what that writes, for each of them installed on this machine, and nothing
        is written until you finish or skip the tour.
      </p>
      <AgentWritesList />
      <label className="flex items-start gap-3 p-3 rounded-lg border border-[#3c3c3c] bg-[#1e1e1e] cursor-pointer hover:border-[#22D3EE]/40">
        <input
          type="checkbox"
          checked={connect}
          onChange={e => onChange({ connect: e.target.checked, primerHook })}
          className="mt-0.5 w-4 h-4 accent-[#22D3EE]"
          data-testid="agent-connect-toggle"
        />
        <span className="text-xs font-medium text-[#d4d4d4]">Connect agents</span>
      </label>
      <label
        className={`flex items-start gap-3 p-3 rounded-lg border border-[#3c3c3c] bg-[#1e1e1e] ${
          connect ? 'cursor-pointer hover:border-[#22D3EE]/40' : 'opacity-50'
        }`}
      >
        <input
          type="checkbox"
          checked={primerHook}
          disabled={!connect}
          onChange={e => onChange({ connect, primerHook: e.target.checked })}
          className="mt-0.5 w-4 h-4 accent-[#22D3EE]"
          data-testid="agent-primer-hook-toggle"
        />
        <span className="text-xs font-medium text-[#d4d4d4]">{PRIMER_HOOK_LABEL}</span>
      </label>
      <p className="text-xs text-[#9ca3af]">
        Change or undo this any time in Settings ▸ Agent Integration. Disconnecting removes
        everything Termpolis wrote.
      </p>
    </div>
  )
}
