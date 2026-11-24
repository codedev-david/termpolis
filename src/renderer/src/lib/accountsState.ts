// The accounts the renderer shows outside Settings (the chips, the switch dialog, the sidebar's
// Launch on ▸): main's view, read on start, after a change, and when main says a terminal's
// account changed, and again the moment a usage limit in it ends. What a terminal records about
// its account is what main told it.
import { currentAccountsView, nextLimitEnd } from '../../../shared/accountLimits'
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
 *  put it on (a switch); and for a swarm worker, which agent run_command started in it. */
export function noteTerminalAccount(e: TerminalAccountEvent): void {
  const store = useTerminalStore.getState()
  store.setAccountByHand(e.terminalId, e.byHand)
  if (e.agent) store.updateTerminal(e.terminalId, { swarmAgent: e.agent })
  if (!e.byHand) store.updateTerminal(e.terminalId, e.accountId ? { agentAccountId: e.accountId } : { agentAccountId: undefined })
}

/** A timer fires a little after the moment it was set for, so the limit has surely ended by then. */
const LIMIT_END_SLACK_MS = 250
/** setTimeout's longest delay (about 24.8 days); a later end is waited for in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * Keeps the store's view current as its usage limits end. One timer, set to the next moment a limit
 * or a failover-hook marker in the view ends (none while nothing is limited); then the ended ones are
 * dropped from the view at once, so every label that reads it (the sidebar's Launch on ▸, the chips,
 * the account menu, Settings ▸ Accounts, the launch ask) clears by itself, and main's view is read
 * again (main drops them too). Set again whenever the view changes. Returns the stop.
 */
export function watchLimitEnds(api: Pick<AccountsAPI, 'list'> | undefined = window.accounts): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  // The timer's callback, and the same check when the window wakes: a laptop that slept across a
  // limit's end fires the timer late, or not before the label is looked at again.
  const check = (): void => {
    const store = useTerminalStore.getState()
    const held = store.accountsView
    if (!held) return
    const current = currentAccountsView(held, Date.now())
    if (current === held) {
      arm(held) // nothing ended yet (woke early, or a far end waited for in steps): wait on
      return
    }
    store.setAccountsView(current)
    void refreshAccounts(api)
  }
  const arm = (view: AccountsView | null): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (!view) return
    const now = Date.now()
    const end = nextLimitEnd(view, now)
    if (end === null) return
    timer = setTimeout(() => { timer = null; check() }, Math.min(end - now + LIMIT_END_SLACK_MS, MAX_TIMER_MS))
  }
  arm(useTerminalStore.getState().accountsView)
  const stop = useTerminalStore.subscribe((s, prev) => { if (s.accountsView !== prev.accountsView) arm(s.accountsView) })
  const onVisible = (): void => { if (document.visibilityState === 'visible') check() }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  if (typeof window !== 'undefined') window.addEventListener('focus', check)
  return () => {
    stop()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
    if (typeof window !== 'undefined') window.removeEventListener('focus', check)
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
}

/** Follows main's word about terminals' accounts, reads the view now, and keeps it current as its
 *  limits end. Returns the unsubscribe. */
export function watchAccounts(api: Pick<AccountsAPI, 'list' | 'onTerminalAccount'> | undefined = window.accounts): () => void {
  if (!api) return () => undefined
  void refreshAccounts(api)
  const unwatchEnds = watchLimitEnds(api)
  const unwatchTerminals = api.onTerminalAccount(noteTerminalAccount)
  return () => {
    unwatchEnds()
    unwatchTerminals()
  }
}
