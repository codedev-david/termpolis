// The swarm's workers' accounts (§9, T11), in the swarm dashboard: each worker's account chip, for a
// worker whose agent has two accounts or more (D13). A worker's terminal is hidden, so this is where
// its chip is: a click opens the account menu for it, which restarts the worker on another account
// in place, with its progress beside the chip, and the conductor is told as after the restart
// offer's (swarmRestart.ts).
import { useTerminalStore } from '../../store/terminalStore'
import { accountChipFor } from '../../lib/accountChip'
import { AccountChip } from './AccountChip'
import { SwitchStatusLine } from './SwitchOverlay'

export function SwarmWorkerAccounts() {
  // A store that holds no workers or accounts state (a dashboard's tests mock one) shows no chip.
  const workers = useTerminalStore((s) => s.swarmAgents) ?? []
  const terminals = useTerminalStore((s) => s.terminals)
  const view = useTerminalStore((s) => s.accountsView ?? null)
  const byHand = useTerminalStore((s) => s.accountsByHand)
  const shown = workers.filter((w) => accountChipFor(terminals.find((t) => t.id === w.terminalId), view, !!byHand?.[w.terminalId]))
  if (shown.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2 px-5 py-2 border-b border-[#3c3c3c] text-xs text-[#9ca3af]" data-testid="swarm-worker-accounts">
      <span>Workers&apos; accounts:</span>
      {shown.map((w) => (
        <span key={w.terminalId} className="flex items-center gap-1.5" data-testid="swarm-worker-account">
          {w.agentName} ({w.role})
          <AccountChip terminalId={w.terminalId} />
          <SwitchStatusLine terminalId={w.terminalId} />
        </span>
      ))}
    </div>
  )
}
