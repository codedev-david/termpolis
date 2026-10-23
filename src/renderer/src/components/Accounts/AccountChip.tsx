// The terminal header's account chip (§6.4): which account this terminal's agent runs on, red when
// it was changed by hand, removed, or its profile is signed in to another email. Shown only once
// the agent has two accounts or something is wrong (D13). Clicking it opens the switch dialog.
import { useTerminalStore } from '../../store/terminalStore'
import { accountChipFor } from '../../lib/accountChip'

export function AccountChip({ terminalId }: { terminalId: string }) {
  const terminal = useTerminalStore((s) => s.terminals.find((t) => t.id === terminalId))
  // A store that holds no accounts state (a pane's tests mock one) shows no chip.
  const view = useTerminalStore((s) => s.accountsView ?? null)
  const byHand = useTerminalStore((s) => !!s.accountsByHand?.[terminalId])
  const openAccountSwitch = useTerminalStore((s) => s.openAccountSwitch)
  const chip = accountChipFor(terminal, view, byHand)
  if (!chip) return null
  return (
    <button
      type="button"
      data-testid="account-chip"
      data-alert={chip.alert ? 'true' : 'false'}
      onClick={(e) => { e.stopPropagation(); openAccountSwitch(terminalId) }}
      title={chip.title}
      className={`flex items-center gap-1.5 text-[10px] font-medium bg-[#2d2d2d]/90 border rounded px-2 py-1 transition-colors hover:bg-[#0e639c] ${
        chip.alert ? 'text-[#e06c75] border-[#e06c75]' : 'text-[#e0e0e0] border-[#3c3c3c] hover:border-[#1177bb]'
      }`}
    >
      <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: chip.alert ? '#e06c75' : chip.color }} />
      {chip.label}
    </button>
  )
}
