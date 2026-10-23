// The accounts the renderer shows outside Settings (the chips, the switch dialog, the sidebar's
// Launch on ▸): main's view, read on start, after a change, and when main says a terminal's
// account changed. What a terminal records about its account is what main told it.
import type { AccountsView, TerminalAccountEvent } from '../../../shared/agentAccounts'
import { useTerminalStore } from '../store/terminalStore'
import type { AccountsAPI } from '../types'

/** Reads main's view into the store; the view, or null when it couldn't be read (the store then
 *  keeps the last one it had). */
export async function refreshAccounts(api: Pick<AccountsAPI, 'list'> | undefined = window.accounts): Promise<AccountsView | null> {
  if (!api) return null
  try {
    const res = await api.list()
    if (!res.success) return null
    useTerminalStore.getState().setAccountsView(res.data)
    return res.data
  } catch {
    return null
  }
}

/** Main told the renderer where a terminal's account stands: changed by hand, or the account it
 *  put it on (a switch). */
export function noteTerminalAccount(e: TerminalAccountEvent): void {
  const store = useTerminalStore.getState()
  store.setAccountByHand(e.terminalId, e.byHand)
  if (!e.byHand) store.updateTerminal(e.terminalId, e.accountId ? { agentAccountId: e.accountId } : { agentAccountId: undefined })
}

/** Follows main's word about terminals' accounts, and reads the view now. Returns the unsubscribe. */
export function watchAccounts(api: Pick<AccountsAPI, 'list' | 'onTerminalAccount'> | undefined = window.accounts): () => void {
  if (!api) return () => undefined
  void refreshAccounts(api)
  return api.onTerminalAccount(noteTerminalAccount)
}
