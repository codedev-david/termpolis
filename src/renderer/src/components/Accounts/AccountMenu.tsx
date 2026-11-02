// The account menu (the in-app account UI, §2.1): a popover anchored to the terminal's chip, from
// the chip, Ctrl+Shift+N, the palette's Switch account… or the terminal's context menu. One row per
// account of the terminal's agent, in registry order; picking one starts the switch at once, in
// place (§2.2): no dialog, but the work account's second confirmation (D14), a busy agent's "when
// it finishes", and a signed-out account's sign-in first. Its footer: New terminal on ▸, Add
// account… (the wizard, for this agent) and Manage accounts… (Settings ▸ Accounts). It shows what
// main last said and refreshes behind, never waiting
// on a CLI. Keyboard: arrows, Home/End, type-ahead, Enter; Esc back to the terminal.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ACCOUNT_AGENT_LABEL, isProfileAgent } from '../../../../shared/agentAccounts'
import type { AccountAgent, AccountsView } from '../../../../shared/agentAccounts'
import { useTerminalStore } from '../../store/terminalStore'
import type { TerminalSession } from '../../types'
import { terminalAgent } from '../../lib/accountSwitchFlow'
import { hasAccounts } from '../../lib/accountsView'
import { refreshAccounts } from '../../lib/accountsState'
import { requestSettingsTab } from '../../lib/settingsNav'
import { MENU_WIDTH, actionWords, confirmFor, focusTerminal, maybeOnUnoffered, menuPosition, menuRows, moveIndex, typeAhead } from '../../lib/accountMenu'
import type { MenuRow } from '../../lib/accountMenu'
import { newTerminalOn, queueSwitch, startSwitch } from '../../lib/accountSwitchRun'
import { SMALL_BUTTON, SMALL_PRIMARY } from './ui'

const TYPE_AHEAD_MS = 700

const TONE: Readonly<Record<MenuRow['tone'], string>> = { good: 'text-[#7ee2a3]', muted: 'text-[#9ca3af]', warn: 'text-[#e5c07b]', bad: 'text-[#e06c75]' }

type Item =
  | { key: string; kind: 'cancel-queued' }
  | { key: string; kind: 'row'; row: MenuRow }
  | { key: string; kind: 'sign-in'; row: MenuRow }
  | { key: string; kind: 'new-terminal' }
  | { key: string; kind: 'add' }
  | { key: string; kind: 'manage' }

export function AccountMenu() {
  const open = useTerminalStore((s) => s.accountMenu)
  const terminal = useTerminalStore((s) => s.terminals.find((t) => t.id === s.accountMenu?.terminalId))
  const view = useTerminalStore((s) => s.accountsView)
  const agent = terminal ? terminalAgent(terminal) : null
  // D13: with no account registered, there is no menu.
  const showable = !!open && !!terminal && !!view && !!agent && hasAccounts(view.accounts)
  // A request that can never show with what the store holds (a terminal that runs no agent, an agent with no
  // account) is dropped, or it would pop a menu up by itself when an account is added later. One for a
  // terminal or a view not read yet is kept: those may still arrive.
  const never = !!open && !!terminal && !!view && (!agent || !view.accounts.some((r) => r.agent === agent))
  useEffect(() => {
    if (never) useTerminalStore.getState().closeAccountMenu()
  }, [never])
  if (!showable) return null
  return <MenuBody key={terminal.id} terminal={terminal} agent={agent} view={view} />
}

function MenuBody({ terminal, agent, view }: { terminal: TerminalSession; agent: AccountAgent; view: AccountsView }) {
  const store = useTerminalStore.getState
  const byHand = useTerminalStore((s) => !!s.accountsByHand[terminal.id])
  const queued = useTerminalStore((s) => s.queuedSwitches[terminal.id])
  const [busy, setBusy] = useState(false)
  // The item at hand, by its key: the list can grow above it while the menu is open (a switch
  // queued meanwhile), and the focus stays on the same item.
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [sub, setSub] = useState<number | null>(null)
  const [confirm, setConfirm] = useState<{ row: MenuRow; question: string; newTerminal: boolean } | null>(null)
  const [pos] = useState(() => menuPosition(terminal.id))
  const root = useRef<HTMLDivElement>(null)
  const items = useRef<Array<HTMLElement | null>>([])
  const subItems = useRef<Array<HTMLElement | null>>([])
  const typed = useRef({ text: '', at: 0 })

  const name = ACCOUNT_AGENT_LABEL[agent]
  const worker = !!terminal.isSwarm
  const currentId = byHand ? undefined : terminal.agentAccountId
  const rows = menuRows(view, agent, currentId, Date.now(), { busy, worker })
  const current = rows.find((r) => r.current)?.account
  const queuedTo = queued ? view.accounts.find((r) => r.id === queued.targetId) : undefined
  const others = rows.filter((r) => !r.current && !(isProfileAgent(agent) && !r.account.folderExists))
  const list: Item[] = [
    ...(queued ? [{ key: 'cancel-queued', kind: 'cancel-queued' } as Item] : []),
    ...rows.flatMap((row): Item[] => [{ key: row.account.id, kind: 'row', row }, ...(row.action === 'sign-in-and-switch' ? [{ key: `${row.account.id}-sign-in`, kind: 'sign-in', row } as Item] : [])]),
    ...(!worker && agent !== 'agy' && others.length > 0 ? [{ key: 'new-terminal', kind: 'new-terminal' } as Item] : []),
    { key: 'add', kind: 'add' },
    { key: 'manage', kind: 'manage' },
  ]
  const enabled = list.map((it) => !(it.kind === 'row' && it.row.disabled))
  const active = list.findIndex((it) => it.key === activeKey)
  const setActive = (i: number): void => setActiveKey(list[i].key)

  // The statuses as main has them now, and whether the agent is mid-turn: behind the menu, which
  // shows what it has meanwhile.
  useEffect(() => {
    let alive = true
    void refreshAccounts()
    void window.accounts?.limitLook(terminal.id)
      .then((r) => { if (alive && r.success) setBusy(r.data.live && r.data.status.status === 'working') })
      .catch(() => undefined)
    return () => { alive = false }
  }, [terminal.id])

  // The current account takes the focus first, else the first item.
  useEffect(() => {
    const at = list.findIndex((it) => it.kind === 'row' && it.row.current)
    setActive(at >= 0 ? at : moveIndex(enabled, -1, 'first'))
    // Once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (sub === null && !confirm && active >= 0) items.current[active]?.focus()
  }, [active, sub, confirm])

  useEffect(() => {
    if (sub !== null) subItems.current[sub]?.focus()
  }, [sub])

  const close = (back = true): void => {
    store().closeAccountMenu()
    if (back) focusTerminal(terminal.id)
  }

  // A click outside it, or the window losing the focus, closes it.
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (root.current && e.target instanceof Node && root.current.contains(e.target)) return
      close(false)
    }
    const onBlur = (): void => close(false)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', onBlur)
    }
    // The listeners close this menu, whichever render added them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** `confirmed`: the user said yes to the second question (D14, R17), which main insists on. */
  const go = (row: MenuRow, confirmed = false): void => {
    close()
    const id = terminal.id
    const to = row.account.id
    if (row.action === 'sign-in-and-switch') {
      return store().openSignInSheet(to, () => { void startSwitch(id, to, { known: { kind: 'signed-in', email: null }, ...(confirmed ? { confirmed } : {}) }) })
    }
    if (row.action === 'queue') return confirmed ? queueSwitch(id, to, 'by hand', true) : queueSwitch(id, to)
    void (confirmed ? startSwitch(id, to, { confirmed }) : startSwitch(id, to))
  }

  const pick = (row: MenuRow): void => {
    if (row.disabled) return
    if (row.action === 'none') return close()
    if (row.action === 'agy') {
      close(false)
      return store().openAgySwitchSheet(row.account.id)
    }
    const c = confirmFor(current, row.account, maybeOnUnoffered(view.accounts, agent, current))
    if (c) return setConfirm({ row, ...c })
    go(row)
  }

  const openSettings = (): void => {
    close(false)
    requestSettingsTab('accounts', store().showSettings)
    store().setShowSettings(true)
  }

  const activate = (it: Item): void => {
    switch (it.kind) {
      case 'cancel-queued':
        store().dropQueuedSwitch(terminal.id)
        return close()
      case 'row':
        return pick(it.row)
      case 'sign-in':
        close(false)
        return store().openSignInSheet(it.row.account.id)
      case 'new-terminal':
        // Its item stays the one at hand: the submenu's Esc comes back to it.
        setActive(list.indexOf(it))
        return setSub(0)
      case 'add':
        close(false)
        return store().openAddAccount(agent)
      default:
        return openSettings()
    }
  }

  const openOn = (row: MenuRow): void => {
    close(false)
    if (row.action === 'sign-in-and-switch') return store().openSignInSheet(row.account.id, () => { void newTerminalOn(terminal, row.account) })
    void newTerminalOn(terminal, row.account)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (confirm) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setConfirm(null)
      }
      return
    }
    if (sub !== null) {
      e.stopPropagation()
      const subEnabled = others.map(() => true)
      if (e.key === 'ArrowDown') setSub(moveIndex(subEnabled, sub, 'next'))
      else if (e.key === 'ArrowUp') setSub(moveIndex(subEnabled, sub, 'prev'))
      else if (e.key === 'Enter' || e.key === ' ') openOn(others[sub])
      else if (e.key === 'ArrowLeft' || e.key === 'Escape') setSub(null)
      else return
      e.preventDefault()
      return
    }
    const move = (how: 'next' | 'prev' | 'first' | 'last'): void => setActive(moveIndex(enabled, active, how))
    if (e.key === 'ArrowDown') move('next')
    else if (e.key === 'ArrowUp') move('prev')
    else if (e.key === 'Home') move('first')
    else if (e.key === 'End') move('last')
    // Something is always at hand once it opens: Add account… and Manage accounts… always are.
    else if (e.key === 'Enter' || e.key === ' ') activate(list[Math.max(0, active)])
    else if (e.key === 'ArrowRight' && list[active]?.kind === 'new-terminal') setSub(0)
    else if (e.key === 'Escape' || e.key === 'Tab') close()
    else if (e.key.length === 1 && e.key !== ' ') {
      const now = Date.now()
      const text = now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text + e.key : e.key
      typed.current = { text, at: now }
      const labels = list.map((it) => (it.kind === 'row' ? it.row.account.label : ''))
      const at = typeAhead(labels, text, text.length > 1 ? active - 1 : active)
      if (at >= 0) setActive(at)
    } else return
    e.preventDefault()
    e.stopPropagation()
  }

  const ref = (i: number) => (el: HTMLElement | null): void => { items.current[i] = el }
  const itemClass = (i: number, off = false): string =>
    `flex items-start gap-2 w-full px-3 py-1.5 text-left focus:outline-none ${off ? 'cursor-default opacity-60' : 'cursor-pointer hover:bg-[#2a2d2e]'} ${active === i ? 'bg-[#2a2d2e]' : ''}`

  const body = confirm ? (
    <div role="group" aria-label="Confirm the switch" className="p-3 flex flex-col gap-2 text-xs" data-testid="account-menu-confirm">
      <p className="text-[#d4d4d4]">{confirm.question}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={SMALL_PRIMARY} autoFocus onClick={() => go(confirm.row, true)} data-testid="account-menu-confirm-yes">
          {confirm.newTerminal ? `Carry it to ${confirm.row.account.label}` : `Switch to ${confirm.row.account.label}`}
        </button>
        {confirm.newTerminal && <button type="button" className={SMALL_BUTTON} onClick={() => openOn(confirm.row)} data-testid="account-menu-confirm-new">New terminal on {confirm.row.account.label}</button>}
        <button type="button" className={SMALL_BUTTON} onClick={() => setConfirm(null)} data-testid="account-menu-confirm-no">Cancel</button>
      </div>
    </div>
  ) : (
    <>
      {list.map((it, i) => {
        if (it.kind === 'cancel-queued') {
          return (
            <div key={it.key} className="px-3 py-1.5 border-b border-[#3c3c3c]">
              <p className="text-[11px] text-[#e5c07b]">Switching to {queuedTo?.label ?? 'another account'} when {name} finishes</p>
              <button ref={ref(i)} type="button" role="menuitem" tabIndex={active === i ? 0 : -1} className={`${SMALL_BUTTON} mt-1`} onClick={() => activate(it)} onMouseEnter={() => setActive(i)} data-testid="account-menu-cancel-queued">Cancel</button>
            </div>
          )
        }
        if (it.kind === 'row') {
          const row = it.row
          const words = actionWords(row)
          return (
            <div
              key={it.key}
              ref={ref(i)}
              role="menuitemradio"
              aria-checked={row.current}
              aria-disabled={row.disabled ? true : undefined}
              tabIndex={active === i ? 0 : -1}
              className={itemClass(i, !!row.disabled)}
              onClick={() => pick(row)}
              onMouseEnter={() => setActive(i)}
              data-testid="account-menu-row"
              data-action={row.action}
            >
              <span className="mt-0.5 w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-[11px] font-semibold text-[#1e1e1e]" style={{ backgroundColor: row.color }} aria-hidden="true">{row.initial}</span>
              <span className="flex-1 min-w-0">
                <span className="block text-[12px] text-[#e0e0e0] truncate">{row.account.label}</span>
                {row.email && <span className="block text-[11px] text-[#9ca3af] truncate">{row.email}</span>}
                <span className={`block text-[11px] ${TONE[row.tone]}`}>{row.status}</span>
                {row.note && <span className="block text-[11px] text-[#e5c07b]">{row.note}</span>}
                {words && <span className="block text-[11px] text-[#22D3EE]">{words}</span>}
              </span>
              {row.current && <i className="fa-solid fa-check text-[11px] text-[#7ee2a3] mt-1" aria-hidden="true"></i>}
            </div>
          )
        }
        if (it.kind === 'sign-in') {
          return (
            <div key={it.key} className="pl-11 pr-3 pb-1.5">
              <button ref={ref(i)} type="button" role="menuitem" tabIndex={active === i ? 0 : -1} className={SMALL_BUTTON} onClick={() => activate(it)} onMouseEnter={() => setActive(i)} data-testid="account-menu-sign-in">
                Sign in to {it.row.account.label}
              </button>
            </div>
          )
        }
        const label = it.kind === 'new-terminal' ? 'New terminal on' : it.kind === 'add' ? 'Add account…' : 'Manage accounts…'
        return (
          <div key={it.key} className={it.kind === 'new-terminal' ? 'border-t border-[#3c3c3c] relative' : 'relative'}>
            <button
              ref={ref(i)}
              type="button"
              role="menuitem"
              tabIndex={active === i ? 0 : -1}
              {...(it.kind === 'new-terminal' ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': sub !== null } : {})}
              className={`${itemClass(i)} text-[12px] text-[#d4d4d4]`}
              onClick={() => activate(it)}
              onMouseEnter={() => setActive(i)}
              data-testid={`account-menu-${it.kind}`}
            >
              <span className="flex-1">{label}</span>
              {it.kind === 'new-terminal' && <i className="fa-solid fa-chevron-right text-[10px] mt-1" aria-hidden="true"></i>}
            </button>
            {it.kind === 'new-terminal' && sub !== null && (
              <div role="menu" aria-label={`New terminal on another ${name} account`} className="absolute top-0 right-full mr-1 w-56 py-1 rounded border border-[#3c3c3c] bg-[#252526] shadow-2xl" data-testid="account-menu-submenu">
                {others.map((row, k) => (
                  <button
                    key={row.account.id}
                    ref={(el) => { subItems.current[k] = el }}
                    type="button"
                    role="menuitem"
                    tabIndex={sub === k ? 0 : -1}
                    className={`block w-full text-left px-3 py-1.5 text-[12px] text-[#d4d4d4] hover:bg-[#2a2d2e] focus:outline-none ${sub === k ? 'bg-[#2a2d2e]' : ''}`}
                    onClick={() => openOn(row)}
                    data-testid="account-menu-new-on"
                  >
                    {row.account.label}
                    {row.action === 'sign-in-and-switch' && <span className="block text-[11px] text-[#9ca3af]">Signs in first</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </>
  )

  return createPortal(
    <div
      ref={root}
      role="menu"
      aria-label={`${name} accounts for ${terminal.name}`}
      className="fixed z-[200] py-1 rounded border border-[#3c3c3c] bg-[#252526] shadow-2xl"
      style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
      data-testid="account-menu"
    >
      <p className="px-3 pt-1 pb-1.5 text-[11px] text-[#9ca3af] border-b border-[#3c3c3c] truncate">{name} · {terminal.name}</p>
      {body}
    </div>,
    document.body,
  )
}
