// Settings ▸ Accounts' first line (§4.1): the active terminal's agent and the account it runs on,
// with Switch account…, which opens the same dialog as the terminal's chip.
import { ACCOUNT_AGENT_LABEL } from '../../../../shared/agentAccounts'
import type { AccountsView } from '../../../../shared/agentAccounts'
import { useTerminalStore } from '../../store/terminalStore'
import { agentOfTerminal, canSwitchAccount } from '../../lib/accountsView'

export function ActiveTerminalAccount({ view }: { view: AccountsView }) {
  const terminal = useTerminalStore((s) => s.terminals.find((t) => t.id === s.activeTerminalId))
  const byHand = useTerminalStore((s) => !!s.activeTerminalId && !!s.accountsByHand[s.activeTerminalId])
  const openAccountSwitch = useTerminalStore((s) => s.openAccountSwitch)
  // As the chip, Ctrl+Shift+N and the palette read it: a swarm worker counts by the agent started in it, the conductor never.
  const agent = agentOfTerminal(terminal)
  if (!terminal || !agent) {
    return <p className="text-xs text-[#9ca3af]" data-testid="accounts-active-terminal">Open an agent terminal to switch its account.</p>
  }
  // An agent with no account of its own has nothing to switch to: no button that would do nothing.
  if (!canSwitchAccount(terminal, view)) {
    return (
      <p className="text-xs text-[#9ca3af]" data-testid="accounts-active-terminal">
        Active terminal: <em>{terminal.name}</em> — {ACCOUNT_AGENT_LABEL[agent]} has no account of its own yet: add one to switch it.
      </p>
    )
  }
  const row = terminal.agentAccountId ? view.accounts.find((r) => r.id === terminal.agentAccountId) : undefined
  const on = byHand ? 'an account changed by hand' : row ? row.label : terminal.agentAccountId ? 'a removed account' : 'probably its default profile'
  return (
    <p className="text-xs text-[#d4d4d4]" data-testid="accounts-active-terminal">
      Active terminal: <em>{terminal.name}</em> — {ACCOUNT_AGENT_LABEL[agent]} on <strong>{on}</strong>{' '}
      <button
        type="button"
        data-testid="accounts-switch-active"
        onClick={() => {
          // Settings replaces the main area, and the terminal's pane is where the switch shows its progress, its toast and
          // its error card: the terminal comes first (a click on one of the card's terminals does the same; it closes Settings),
          // then the menu opens over it. The menu is drawn after the main area, so its own effects take the focus last.
          useTerminalStore.getState().setActiveTerminal(terminal.id)
          openAccountSwitch(terminal.id)
        }}
        className="underline text-[#22D3EE] hover:text-[#67e8f9]"
      >
        Switch account…
      </button>
    </p>
  )
}
