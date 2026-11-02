// The terminal header's account chip (§6.4): which account this terminal's agent runs on, red when
// it was changed by hand, removed, or its profile is signed in to another email. Shown only once
// the agent has two accounts or something is wrong (D13). Clicking it opens the account menu. A
// switch waiting for the agent's turn to end shows on it, with Cancel.
import { useTerminalStore } from '../../store/terminalStore'
import { ACCOUNT_AGENT_LABEL } from '../../../../shared/agentAccounts'
import { accountChipFor } from '../../lib/accountChip'

export function AccountChip({ terminalId }: { terminalId: string }) {
  const terminal = useTerminalStore((s) => s.terminals.find((t) => t.id === terminalId))
  // A store that holds no accounts state (a pane's tests mock one) shows no chip.
  const view = useTerminalStore((s) => s.accountsView ?? null)
  const byHand = useTerminalStore((s) => !!s.accountsByHand?.[terminalId])
  const openAccountSwitch = useTerminalStore((s) => s.openAccountSwitch)
  const closeAccountMenu = useTerminalStore((s) => s.closeAccountMenu)
  const queued = useTerminalStore((s) => s.queuedSwitches?.[terminalId])
  const menuOpen = useTerminalStore((s) => s.accountMenu?.terminalId === terminalId)
  const queuedTo = queued ? view?.accounts.find((r) => r.id === queued.targetId)?.label : undefined
  const chip = accountChipFor(terminal, view, byHand)
  if (!chip) return null
  const button = (
    <button
      type="button"
      data-testid="account-chip"
      data-account-chip={terminalId}
      data-alert={chip.alert ? 'true' : 'false'}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      aria-label={`${ACCOUNT_AGENT_LABEL[chip.agent]} account: ${chip.label}. Switch account`}
      onClick={(e) => { e.stopPropagation(); if (menuOpen) closeAccountMenu(); else openAccountSwitch(terminalId) }}
      title={queued ? `${chip.title} Switching to ${queuedTo ?? 'another account'} when it finishes.` : chip.title}
      className={`flex items-center gap-1.5 text-[10px] font-medium bg-[#2d2d2d]/90 border rounded px-2 py-1 transition-colors hover:bg-[#0e639c] ${
        chip.alert ? 'text-[#e06c75] border-[#e06c75]' : 'text-[#e0e0e0] border-[#3c3c3c] hover:border-[#1177bb]'
      }`}
    >
      <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: chip.alert ? '#e06c75' : chip.color }} />
      {chip.label}
      {queued && <i className="fa-solid fa-hourglass-half text-[9px] text-[#e5c07b]" aria-label="switch waiting" data-testid="account-chip-queued"></i>}
    </button>
  )
  if (!queued) return button
  return (
    <span className="flex items-center gap-0.5">
      {button}
      <button
        type="button"
        aria-label={`Cancel the switch to ${queuedTo ?? 'another account'}`}
        title={`Cancel the switch to ${queuedTo ?? 'another account'}`}
        className="text-[10px] px-1 py-1 rounded text-[#9ca3af] hover:bg-white/10"
        onClick={(e) => { e.stopPropagation(); useTerminalStore.getState().dropQueuedSwitch(terminalId) }}
        data-testid="account-chip-cancel"
      >
        <i className="fa-solid fa-xmark" aria-hidden="true"></i>
      </button>
    </span>
  )
}
