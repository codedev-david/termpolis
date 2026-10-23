// agy's switch-all (the in-app account UI, §2.4), the logic under AgySwitchSheet.tsx: which
// terminals move with agy's one sign-in, the work account's second confirmation for them (D14,
// R17), and what main said went wrong at a terminal's step.
import type { AccountRowView } from '../../../shared/agentAccounts'
import type { AgyStepOutcome } from '../../../shared/accountSwitch'
import type { TerminalSession } from '../types'
import { agentOfCommand } from './accountsView'

/** The agy terminals Termpolis launched, now: every one moves with the switch. */
export function agyTerminals(terminals: readonly TerminalSession[]): TerminalSession[] {
  return terminals.filter((t) => !t.isConductor && !t.isSwarm && agentOfCommand(t.agentCommand) === 'agy')
}

/** The second confirmation (D14, R17): onto an agy account not offered automatically, or carrying
 *  conversations off one; null when the switch needs none. */
export function agyWorkQuestion(target: AccountRowView, on: readonly AccountRowView[], n: number): { question: string; yes: string } | null {
  if (!target.autoOffer) return { question: `${target.label} isn't offered automatically. Switch Gemini CLI to ${target.label}?`, yes: `Switch to ${target.label}` }
  const off = on.find((r) => !r.autoOffer)
  if (!off) return null
  const what = n === 1 ? 'A Gemini conversation is' : `${n} Gemini conversations are`
  return { question: `${what} on ${off.label}, which isn't offered automatically. Carry ${n === 1 ? 'it' : 'them'} to ${target.label}?`, yes: `Carry ${n === 1 ? 'it' : 'them'} to ${target.label}` }
}

/** What main said went wrong, or '' for an answer that names nothing. */
export function whyOf(r: AgyStepOutcome): string {
  return 'why' in r ? r.why : ''
}
