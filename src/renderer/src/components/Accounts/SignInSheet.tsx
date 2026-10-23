// The sign-in sheet (the in-app account UI, §2.3): "Sign in to <label> · <agent>", opened from the
// account menu, Settings ▸ Accounts, a switch that needs it, the limit card and the swarm offer.
// Its steps are SignInFlow's; the CLI's own login runs in main, hidden (signInSession.ts). When the
// sign-in was asked for by a switch, the switch goes on by itself once it signed in.
import { ACCOUNT_AGENT_LABEL } from '../../../../shared/agentAccounts'
import { useTerminalStore } from '../../store/terminalStore'
import { refreshAccounts } from '../../lib/accountsState'
import { Sheet } from './Sheet'
import { SignInFlow } from './SignInFlow'
import { SHEET_SECONDARY } from './ui'

export function SignInSheet() {
  const open = useTerminalStore((s) => s.signInSheet)
  const view = useTerminalStore((s) => s.accountsView)
  if (!open) return null
  const store = useTerminalStore.getState
  const close = (): void => store().closeSignInSheet()
  const row = view?.accounts.find((r) => r.id === open.accountId)
  if (!view || !row) {
    return (
      <Sheet title="Sign in" icon="fa-right-to-bracket" onClose={close} testId="sign-in-sheet">
        <p data-testid="sign-in-gone">That account isn&apos;t registered any more.</p>
        <div><button type="button" className={SHEET_SECONDARY} onClick={close} data-autofocus="">Close</button></div>
      </Sheet>
    )
  }
  const then = open.then
  const done = (): void => {
    void refreshAccounts()
    close()
    then?.()
  }
  return (
    <Sheet title={`Sign in to ${row.label} · ${ACCOUNT_AGENT_LABEL[row.agent]}`} subtitle={row.email} icon="fa-right-to-bracket" onClose={close} testId="sign-in-sheet">
      <SignInFlow
        key={open.accountId}
        account={row}
        view={view}
        onDone={done}
        doneLabel={then ? `Switch to ${row.label}` : 'Done'}
        autoDone={!!then}
        onCancel={close}
      />
    </Sheet>
  )
}
