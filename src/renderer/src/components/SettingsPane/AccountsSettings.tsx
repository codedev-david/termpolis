import { useCallback, useEffect, useRef, useState } from 'react'
import { ACCOUNT_AGENTS, ACCOUNT_AGENT_LABEL, isProfileAgent, tildifyPath } from '../../../../shared/agentAccounts'
import type { AccountAgent, AccountChange, AccountRowView, AccountsView, ImportPreview } from '../../../../shared/agentAccounts'
import { useTerminalStore } from '../../store/terminalStore'
import { AGENT_COLOR, accountBadge, accountsOf, folderLine } from '../../lib/accountsView'
import type { BadgeTone } from '../../lib/accountsView'
import { signedInEmail } from '../../lib/accountChip'
import { CONNECT_DATA_LINE } from '../Accounts/AddAccountSheet'
import { ActiveTerminalAccount } from '../Accounts/ActiveTerminalAccount'
import { SMALL_BUTTON as BUTTON } from '../Accounts/ui'

// Settings ▸ Accounts (design §4, the in-app account UI §2.5): the account manager. One section per
// agent, a card per account: its colour, its name (renamed in place), the email and plan its CLI
// reports, its status, whether new terminals start on it, the terminals on it now, and what can be
// done with it; its folder and the rest under Advanced. Add account is a wizard in a sheet
// (AddAccountSheet.tsx); a sign-in is the sign-in sheet. Main owns the registry and answers every
// action with what it did (src/main/accountsIpc.ts); this tab never builds a path, reads a config or
// sees a sign-in. A Claude Code or Codex account is a profile folder; an agy account is a label,
// because the Antigravity CLI keeps one Google sign-in per computer user.

const INPUT = 'bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-xs text-[#d4d4d4]'

const TONE: Record<BadgeTone, string> = {
  good: 'text-[#7ee2a3] border-[#7ee2a3]/40',
  warn: 'text-[#e5c07b] border-[#e5c07b]/40',
  bad: 'text-[#e06c75] border-[#e06c75]/40',
  muted: 'text-[#9ca3af] border-[#3c3c3c]',
}

/** The check a StopFailure hook needs to stand down inside Termpolis (design §8.6). */
export const HOOK_CHECK = 'if [ "${TERMPOLIS_LIMIT_CHOOSER:-}" = "1" ]; then exit 0; fi'

const AGY_TEXT = 'The Antigravity CLI keeps one Google sign-in for your whole computer user, in the OS keyring, so it has no separate profiles. An account here is a name and the Google email it signs in with. Switching to one moves every agy terminal on this computer to it.'

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** What a card is doing right now: one action at a time per tab. */
type RowAction = { id: string; kind: 'rename' | 'email' | 'remove' | 'recopy' }

function Changes({ changes }: { changes: AccountChange[] }) {
  if (changes.length === 0) return <span className="text-xs text-[#9ca3af]" data-testid="accounts-changes">Nothing needed to change.</span>
  return (
    <ul className="text-[11px] text-[#bbb] list-disc pl-5" data-testid="accounts-changes">
      {changes.map((c, i) => <li key={i}>{c.action} {c.what} <code className="text-[#9ca3af] break-all">{c.file}</code>{c.error ? `: ${c.error}` : ''}</li>)}
    </ul>
  )
}

/** The name, renamed in place: Enter keeps it, Esc (or leaving it) doesn't. */
function RenameField({ r, busy, onSave, onCancel }: { r: AccountRowView; busy: boolean; onSave: (label: string) => void; onCancel: () => void }) {
  const [label, setLabel] = useState(r.label)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.select() }, [])
  return (
    <input
      ref={ref}
      autoFocus
      className={`${INPUT} text-sm w-40`}
      aria-label={`Rename ${r.label}`}
      value={label}
      maxLength={40}
      disabled={busy}
      onChange={(e) => setLabel(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          if (label.trim() && label.trim() !== r.label) onSave(label.trim())
          else onCancel()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onCancel()
        }
      }}
      onBlur={onCancel}
      data-testid={`account-edit-label-${r.id}`}
    />
  )
}

export function AccountsSettings() {
  const api = window.accounts
  const [view, setView] = useState<AccountsView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [changes, setChanges] = useState<AccountChange[] | null>(null)
  const [rowAction, setRowAction] = useState<RowAction | null>(null)
  // The keyboard keeps its place: when a card's field or panel closes (a rename done, a question answered "Keep
  // it") the focus it held goes with it, so it comes back to the button that opened it.
  const lastAction = useRef<RowAction | null>(null)
  const restore = useRef<RowAction | null>(null)
  useEffect(() => {
    if (lastAction.current && !rowAction) restore.current = lastAction.current
    lastAction.current = rowAction
    const want = restore.current
    if (!want || rowAction) return
    // Where the user put the focus meanwhile (Tab to another control) is theirs.
    if (document.activeElement && document.activeElement !== document.body) { restore.current = null; return }
    const button = document.querySelector<HTMLButtonElement>(`[data-row-action="${want.id}:${want.kind}"]`)
    if (!button) { restore.current = null; return }
    // A card is disabled while its change is saved: tried again when that is done.
    if (button.disabled) return
    button.focus()
    restore.current = null
  }, [rowAction, busy])
  const [emailDraft, setEmailDraft] = useState('')
  const [importing, setImporting] = useState<{ preview: ImportPreview; keys: string[]; connect: Record<string, boolean> } | null>(null)
  const [copiedCheck, setCopiedCheck] = useState(false)
  // Settings a re-copy left out, by name: shown with the changes it made.
  const [leftOut, setLeftOut] = useState<string[]>([])
  // A sign-in the sheet finished, an account the wizard added, or a switch: main's view as the
  // store has it now.
  const storeView = useTerminalStore((s) => s.accountsView)
  const terminals = useTerminalStore((s) => s.terminals)
  const byHand = useTerminalStore((s) => s.accountsByHand)

  const load = useCallback(async () => {
    if (!api) return
    try {
      const res = await api.list()
      if (res.success) {
        setView(res.data)
        // The chips and the account menu read the same view.
        useTerminalStore.getState().setAccountsView(res.data)
        setLoadError(null)
      } else {
        setLoadError(res.error)
      }
    } catch (e) {
      setLoadError(errorText(e))
    }
  }, [api])

  useEffect(() => { void load() }, [load])

  useEffect(() => { if (storeView) setView(storeView) }, [storeView])

  /** One action at a time: every button is disabled until it settles, and the view is re-read. */
  const act = async (action: () => Promise<AccountChange[] | void>) => {
    setBusy(true)
    setError(null)
    setChanges(null)
    setLeftOut([])
    try {
      const done = await action()
      if (done) setChanges(done)
      await load()
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  const must = <T,>(res: { success: true; data: T } | { success: false; error: string }): T => {
    if (!res.success) throw new Error(res.error)
    return res.data
  }

  if (!api) {
    return (
      <div className="settings-section" data-testid="accounts-settings">
        <h2 className="text-sm font-semibold text-[#e0e0e0] mb-2">Accounts</h2>
        <p className="text-xs text-[#9ca3af]" data-testid="accounts-unavailable">Accounts aren&apos;t available in this build.</p>
      </div>
    )
  }

  if (!view) {
    return (
      <div className="settings-section" data-testid="accounts-settings">
        <h2 className="text-sm font-semibold text-[#e0e0e0] mb-2">Accounts</h2>
        {loadError === null ? (
          <p className="text-xs text-[#9ca3af]" data-testid="accounts-loading">Reading your accounts…</p>
        ) : (
          <p className="text-xs text-[#e06c75]" data-testid="accounts-load-error">
            Couldn&apos;t read your accounts: {loadError}{' '}
            <button onClick={() => { void load() }} className="underline text-[#22D3EE] hover:text-[#67e8f9]">Try again</button>
          </p>
        )}
      </div>
    )
  }

  const now = Date.now()

  const openImport = () => act(async () => {
    const preview = must(await api.importPreview())
    const keys = preview.rows.filter((r) => !r.registered).map((r) => r.key)
    // An account not offered automatically (work) is never connected by default (D14).
    const connect: Record<string, boolean> = {}
    for (const r of preview.rows) connect[r.key] = r.autoOffer && view.integrationConnected
    setImporting({ preview, keys, connect })
  })

  const runImport = (state: NonNullable<typeof importing>) => act(async () => {
    const r = must(await api.import(state.keys, state.connect))
    setImporting(null)
    return r.changes
  })

  const copyCheck = async () => {
    try {
      setCopiedCheck((await window.termpolis.clipboardWriteText(HOOK_CHECK)).success)
    } catch {
      setCopiedCheck(false)
    }
  }

  /** A terminal on the account, shown: Settings closes over it. */
  const focusTerminal = (id: string): void => {
    const s = useTerminalStore.getState()
    s.setShowSettings(false)
    s.setActiveTerminal(id)
  }

  const actions = (r: AccountRowView, list: AccountRowView[], i: number) => {
    const profile = isProfileAgent(r.agent)
    const removing = rowAction?.id === r.id && rowAction.kind === 'remove'
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {profile && r.folderExists && (
          <>
            <button className={BUTTON} disabled={busy} aria-label={`${signedInEmail(r) ? 'Sign in again' : 'Sign in'}, ${r.label}`} onClick={() => useTerminalStore.getState().openSignInSheet(r.id)} data-testid={`account-sign-in-${r.id}`}>{signedInEmail(r) ? 'Sign in again' : 'Sign in'}</button>
            <button className={BUTTON} disabled={busy} aria-label={`Check ${r.label}`} onClick={() => { void act(async () => { must(await api.check(r.id)) }) }} data-testid={`account-check-${r.id}`}>Check</button>
          </>
        )}
        {profile && r.folderExists && !r.isDefault && (
          r.connect
            ? <button className={BUTTON} disabled={busy} aria-label={`Disconnect ${r.label}`} title="Take Termpolis's tools and memory out of this profile" onClick={() => { void act(async () => must(await api.setConnect(r.id, false)).changes) }} data-testid={`account-disconnect-${r.id}`}>Disconnect</button>
            : <button className={BUTTON} disabled={busy || !view.integrationConnected} aria-label={`Connect ${r.label}`} title={view.integrationConnected ? CONNECT_DATA_LINE : 'Turn on Agent Integration first'} onClick={() => { void act(async () => must(await api.setConnect(r.id, true)).changes) }} data-testid={`account-connect-${r.id}`}>Connect</button>
        )}
        {r.limit && <button className={BUTTON} disabled={busy} aria-label={`Mark ${r.label} available`} onClick={() => { void act(async () => { must(await api.clearLimit(r.id)) }) }} data-testid={`account-mark-available-${r.id}`}>Mark available</button>}
        {r.recopyAvailable && <button className={BUTTON} disabled={busy} aria-label={`Re-copy ${r.label} from the main profile`} onClick={() => setRowAction({ id: r.id, kind: 'recopy' })} data-row-action={`${r.id}:recopy`} data-testid={`account-recopy-${r.id}`}>Re-copy from main profile</button>}
        <label className="flex items-center gap-1 text-[11px] text-[#d4d4d4]">
          <input type="checkbox" checked={r.autoOffer} disabled={busy} aria-label={`Offer ${r.label} automatically when another account runs out`} onChange={(e) => { const on = e.target.checked; void act(async () => { must(await api.update(r.id, { autoOffer: on })) }) }} data-testid={`account-auto-offer-${r.id}`} />
          Offer automatically
        </label>
        <button className={BUTTON} disabled={busy || i === 0} aria-label={`Move ${r.label} up`} onClick={() => { void act(async () => { must(await api.move(r.id, -1)) }) }} data-testid={`account-up-${r.id}`}>↑</button>
        <button className={BUTTON} disabled={busy || i === list.length - 1} aria-label={`Move ${r.label} down`} onClick={() => { void act(async () => { must(await api.move(r.id, 1)) }) }} data-testid={`account-down-${r.id}`}>↓</button>
        <button className={BUTTON} disabled={busy} aria-label={`Remove ${r.label}`} aria-expanded={removing} onClick={() => setRowAction(removing ? null : { id: r.id, kind: 'remove' })} data-row-action={`${r.id}:remove`} data-testid={`account-remove-${r.id}`}>Remove…</button>
      </div>
    )
  }

  const panel = (r: AccountRowView) => {
    if (rowAction?.id !== r.id || rowAction.kind === 'rename' || rowAction.kind === 'email') return null
    if (rowAction.kind === 'recopy') {
      return (
        <div className="flex flex-wrap items-center gap-2 pt-1 text-xs" data-testid={`account-recopy-confirm-${r.id}`}>
          <span className="text-[#d4d4d4]">
            Your main profile&apos;s settings changed since {r.label} was copied from it. Re-copying replaces {r.label}&apos;s copy with a fresh one, leaving out anything that can hold a key or a token{r.connect ? ', and connects it again' : ''}.
          </span>
          <button
            className={BUTTON}
            disabled={busy}
            onClick={() => { void act(async () => { const d = must(await api.recopy(r.id)); setRowAction(null); setLeftOut(d.leftOut); return d.changes }) }}
            data-testid={`account-recopy-yes-${r.id}`}
          >
            Re-copy
          </button>
          <button className={BUTTON} onClick={() => setRowAction(null)}>Keep it</button>
        </div>
      )
    }
    return (
      <div className="flex flex-wrap items-center gap-2 pt-1 text-xs" data-testid={`account-remove-confirm-${r.id}`}>
        <span className="text-[#d4d4d4]">
          {!isProfileAgent(r.agent)
            ? `Termpolis forgets ${r.label}. agy's own sign-in stays as it is.`
            : r.isDefault
              // The main profile holds no entries of its own to take out: Agent Integration connects it.
              ? `Termpolis forgets ${r.label}. Your main profile stays connected through Agent Integration, and its folder, its sign-in and its links stay.`
              : `Termpolis forgets ${r.label} and takes its entries out of the profile. The folder, its sign-in and its links stay.`}
        </span>
        <button className={BUTTON} disabled={busy} onClick={() => { void act(async () => { const c = must(await api.remove(r.id)).changes; setRowAction(null); return c }) }} data-testid={`account-remove-yes-${r.id}`}>Remove</button>
        <button className={BUTTON} onClick={() => setRowAction(null)}>Keep it</button>
      </div>
    )
  }

  const advanced = (r: AccountRowView) => {
    const copiedEntries = r.agent === 'claude' && !r.isDefault && !r.connect && !!r.connection && (r.connection.hook || r.connection.allow)
    const editingEmail = rowAction?.id === r.id && rowAction.kind === 'email'
    return (
      <details className="text-xs" data-testid={`account-advanced-${r.id}`}>
        <summary className="cursor-pointer text-[#9ca3af] select-none">Advanced</summary>
        <div className="flex flex-col gap-1.5 pt-1.5">
          {r.folder && <code className="text-[11px] text-[#9ca3af] break-all">{folderLine(r, view.home)}</code>}
          {r.shares.length > 0 && <span className="text-[11px] text-[#9ca3af]">Shares {r.shares.join(', ')} with your main profile</span>}
          {/* A swarm worker runs with --dangerously-skip-permissions: its warning, which Termpolis never answers, would hold it (R16). */}
          {r.agent === 'claude' && r.folderExists && !r.bypassReady && <span className="text-[11px] text-[#9ca3af]" data-testid={`account-bypass-${r.id}`}>Can&apos;t take over swarm workers until you accept bypass mode in it once.</span>}
          {copiedEntries && (
            <div className="flex flex-wrap items-center gap-2 text-[11px]" data-testid={`account-copied-entries-${r.id}`}>
              <span className="text-[#e5c07b]">Termpolis&apos;s memory hook or tool permissions are in this profile (copied), but it isn&apos;t connected.</span>
              <button className={BUTTON} disabled={busy} onClick={() => { void act(async () => must(await api.stripCopied(r.id)).changes) }} data-testid={`account-strip-${r.id}`}>Remove the copied entries</button>
            </div>
          )}
          {editingEmail ? (
            <div className="flex flex-wrap items-center gap-2" data-testid={`account-edit-form-${r.id}`}>
              <input className={INPUT} aria-label={`The email ${r.label} signs in with`} value={emailDraft} onChange={(e) => setEmailDraft(e.target.value)} data-testid={`account-edit-email-${r.id}`} />
              <button className={BUTTON} disabled={busy} onClick={() => { void act(async () => { must(await api.update(r.id, { email: emailDraft })); setRowAction(null) }) }} data-testid={`account-edit-save-${r.id}`}>Save</button>
              <button className={BUTTON} onClick={() => setRowAction(null)}>Cancel</button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#9ca3af]">
              <span>{r.agent === 'agy' ? 'Its Google email' : 'The email it should sign in with'}: {r.email ?? 'none given'}</span>
              <button className={BUTTON} disabled={busy} onClick={() => { setRowAction({ id: r.id, kind: 'email' }); setEmailDraft(r.email ?? '') }} data-row-action={`${r.id}:email`} data-testid={`account-edit-${r.id}`}>Change</button>
            </div>
          )}
        </div>
      </details>
    )
  }

  const card = (r: AccountRowView, list: AccountRowView[], i: number) => {
    const badge = accountBadge(r, now)
    const profile = isProfileAgent(r.agent)
    const color = r.color ?? AGENT_COLOR[r.agent]
    const renaming = rowAction?.id === r.id && rowAction.kind === 'rename'
    // The CLI's own email (an agy account's badge is its email already), and its plan.
    const email = profile ? signedInEmail(r) ?? r.email : undefined
    const plan = r.identity?.signedIn ? r.identity.plan : undefined
    // New terminals start on the preferred account, else on the main profile.
    const preferred = view.preferred[r.agent] ?? list.find((x) => x.isDefault)?.id
    const on = terminals.filter((t) => t.agentAccountId === r.id && !byHand[t.id] && !t.hidden && !t.isConductor)
    return (
      <div key={r.id} className="flex flex-col gap-2 p-3 rounded-lg border border-[#3c3c3c] bg-[#1e1e1e]" data-testid={`account-row-${r.id}`}>
        <div className="flex items-start gap-3">
          <span className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-sm font-semibold text-[#1e1e1e]" style={{ backgroundColor: color }} aria-hidden="true">
            {(r.label.trim().charAt(0) || '?').toUpperCase()}
          </span>
          <div className="flex-1 min-w-0 flex flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {renaming
                ? <RenameField r={r} busy={busy} onCancel={() => setRowAction(null)} onSave={(label) => { void act(async () => { must(await api.update(r.id, { label })); setRowAction(null) }) }} />
                : (
                  <button type="button" className="text-sm font-medium text-[#e0e0e0] hover:underline decoration-dotted" title={`Rename ${r.label}`} disabled={busy} onClick={() => setRowAction({ id: r.id, kind: 'rename' })} data-row-action={`${r.id}:rename`} data-testid={`account-label-${r.id}`}>
                    {r.label}
                  </button>
                )}
              <span className={`text-[11px] px-1.5 py-0.5 rounded-full border ${TONE[badge.tone]}`} data-testid={`account-badge-${r.id}`}>{badge.text}</span>
              {profile && r.folderExists && !r.connect && !r.isDefault && <span className="text-[11px] text-[#9ca3af]" data-testid={`account-not-connected-${r.id}`}>not connected</span>}
              {!r.autoOffer && <span className="text-[11px] text-[#9ca3af]">not offered automatically</span>}
            </div>
            {(email || plan) && <span className="text-xs text-[#9ca3af]" data-testid={`account-email-line-${r.id}`}>{[email, plan].filter(Boolean).join(' · ')}</span>}
            {profile && (preferred === r.id
              ? <span className="text-[11px] text-[#22D3EE]" data-testid={`account-default-${r.id}`}>Default for new terminals</span>
              : (
                <span>
                  <button type="button" className="text-[11px] text-[#9ca3af] underline decoration-dotted hover:text-[#d4d4d4] disabled:opacity-50" disabled={busy || !r.folderExists} onClick={() => { void act(async () => { must(await api.setPreferred(r.agent, r.isDefault ? null : r.id)) }) }} data-testid={`account-make-default-${r.id}`}>
                    Make it the default for new terminals
                  </button>
                </span>
              ))}
            {on.length > 0 && (
              <span className="flex flex-wrap items-center gap-1 text-[11px] text-[#9ca3af]" data-testid={`account-terminals-${r.id}`}>
                On it now:
                {on.map((t) => (
                  <button key={t.id} type="button" className="text-[#d4d4d4] underline decoration-dotted hover:text-white" onClick={() => focusTerminal(t.id)} data-testid={`account-terminal-${t.id}`}>{t.name}</button>
                ))}
              </span>
            )}
          </div>
        </div>
        {actions(r, list, i)}
        {panel(r)}
        {advanced(r)}
      </div>
    )
  }

  const importPanel = () => {
    const state = importing
    if (!state) return null
    return (
    <div className="flex flex-col gap-2 p-3 border border-[#3c3c3c] rounded bg-[#252526]" data-testid="accounts-import-panel">
      <span className="text-sm font-medium">Import from ~/.claude/accounts.sh</span>
      <span className="text-xs text-[#9ca3af]">Termpolis reads the file and never changes it. Each folder is used as it is.</span>
      {importing.preview.rows.map((r) => (
        <div key={r.key} className="flex flex-wrap items-center gap-2 text-xs" data-testid={`accounts-import-row-${r.key}`}>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              disabled={r.registered}
              checked={!r.registered && importing.keys.includes(r.key)}
              onChange={(e) => setImporting({ ...importing, keys: e.target.checked ? [...importing.keys, r.key] : importing.keys.filter((k) => k !== r.key) })}
              data-testid={`accounts-import-pick-${r.key}`}
            />
            {r.label}
          </label>
          {r.email && <span className="text-[#9ca3af]">{r.email}</span>}
          <span className="text-[#9ca3af]">{r.profile === null ? 'main profile' : tildifyPath(r.profile, view.home)}</span>
          {r.registered && <span className="text-[#9ca3af]">already added</span>}
          {!r.folderExists && <span className="text-[#e5c07b]">folder missing</span>}
          {!r.autoOffer && <span className="text-[#9ca3af]">not offered automatically</span>}
          {!r.registered && r.profile !== null && (
            <label className={`flex items-center gap-1 ${view.integrationConnected ? '' : 'opacity-50'}`}>
              <input
                type="checkbox"
                disabled={!view.integrationConnected}
                checked={!!importing.connect[r.key]}
                onChange={(e) => setImporting({ ...importing, connect: { ...importing.connect, [r.key]: e.target.checked } })}
                data-testid={`accounts-import-connect-${r.key}`}
              />
              Connect
            </label>
          )}
        </div>
      ))}
      {importing.preview.refused.length > 0 && (
        <ul className="text-[11px] text-[#e5c07b] list-disc pl-5" data-testid="accounts-import-refused">
          {importing.preview.refused.map((l) => <li key={l}>{l}</li>)}
        </ul>
      )}
      <span className="text-[11px] text-[#9ca3af]">{CONNECT_DATA_LINE}</span>
      <div className="flex items-center gap-2">
        <button className={BUTTON} disabled={busy || state.keys.length === 0} onClick={() => { void runImport(state) }} data-testid="accounts-import-go">Import</button>
        <button className={BUTTON} onClick={() => setImporting(null)} data-testid="accounts-import-cancel">Cancel</button>
      </div>
    </div>
    )
  }

  const section = (agent: AccountAgent) => {
    const list = accountsOf(view.accounts, agent)
    const profile = isProfileAgent(agent)
    return (
      <div key={agent} className="flex flex-col gap-2 p-3 border border-[#3c3c3c] rounded-lg bg-[#252526]" data-testid={`accounts-card-${agent}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-[#e0e0e0]">{ACCOUNT_AGENT_LABEL[agent]}</span>
          <button className={BUTTON} disabled={busy} onClick={() => useTerminalStore.getState().openAddAccount(agent)} data-testid={`accounts-add-${agent}`}>+ Add account</button>
        </div>
        {agent === 'agy' && <span className="text-xs text-[#9ca3af] leading-relaxed" data-testid="accounts-agy-text">{AGY_TEXT}</span>}
        {agent === 'claude' && view.importAvailable && !importing && (
          <div className="flex flex-wrap items-center gap-2 text-xs p-2 rounded border border-[#22D3EE]/40 bg-[#22D3EE]/5" data-testid="accounts-import-banner">
            <span className="flex-1 text-[#d4d4d4]">~/.claude/accounts.sh lists your Claude Code accounts. Termpolis can add the ones it doesn&apos;t have yet.</span>
            <button className={BUTTON} disabled={busy} onClick={() => { void openImport() }} data-testid="accounts-import">Import</button>
          </div>
        )}
        {agent === 'claude' && importPanel()}
        {list.length === 0
          ? <span className="text-xs text-[#9ca3af]" data-testid={`accounts-empty-${agent}`}>{profile ? 'No accounts yet: Termpolis uses your main profile.' : 'No accounts yet.'}</span>
          : list.map((r, i) => card(r, list, i))}
      </div>
    )
  }

  const hooks = view.advice.stopFailureHooks
  const overrides = view.advice.authOverrides

  return (
    <div className="settings-section flex flex-col gap-3" data-testid="accounts-settings">
      <div>
        <h2 className="text-sm font-semibold text-[#e0e0e0] mb-1">Accounts</h2>
        <p className="text-xs text-[#9ca3af]">
          More than one sign-in for an agent: each Claude Code or Codex account has a profile folder of its own, and signs in there by itself. Termpolis never reads, copies or keeps a sign-in.
        </p>
      </div>
      <ActiveTerminalAccount view={view} />

      {!view.integrationConnected && (
        <p className="text-xs text-[#9ca3af]" data-testid="accounts-integration-off">
          Agent Integration is off, so no account&apos;s profile is connected to Termpolis. Turn it on in Settings ▸ Agent Integration to connect them.
        </p>
      )}

      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={view.chooser} disabled={busy} onChange={(e) => { const on = e.target.checked; void act(async () => { must(await api.setChooser(on)) }) }} data-testid="accounts-chooser" />
        Offer another account by itself when an agent runs out of usage
      </label>

      {view.drift.length > 0 && (
        <div className="flex flex-col gap-1 p-3 border border-[#e5c07b]/50 rounded bg-[#252526]" data-testid="accounts-drift">
          <span className="text-xs font-medium text-[#e5c07b]">~/.claude/accounts.sh and Termpolis differ</span>
          <ul className="text-[11px] text-[#d4d4d4] list-disc pl-5">{view.drift.map((l) => <li key={l}>{l}</li>)}</ul>
          <span className="text-[11px] text-[#9ca3af]">Termpolis never changes accounts.sh.</span>
        </div>
      )}

      {hooks.length > 0 && !view.hidden.hookAdvice && (
        <div className="flex flex-col gap-1 p-3 border border-[#e5c07b]/50 rounded bg-[#252526]" data-testid="accounts-hook-advice">
          <span className="text-xs text-[#d4d4d4] leading-relaxed">
            Your Claude settings run a StopFailure hook (<code>{hooks[0].command}</code>, in {hooks.map((h) => h.label).join(', ')}). If it opens a window or switches accounts, make it skip when <code>TERMPOLIS_LIMIT_CHOOSER=1</code>, which Termpolis sets in the agent terminals it watches; otherwise both act.
          </span>
          <code className="text-[11px] text-[#bbb]">{HOOK_CHECK}</code>
          <div className="flex items-center gap-2">
            <button className={BUTTON} onClick={() => { void copyCheck() }} data-testid="accounts-hook-copy">Copy the check</button>
            {copiedCheck && <span className="text-xs text-[#7ee2a3]">Copied</span>}
            <button className={BUTTON} disabled={busy} onClick={() => { void act(async () => { must(await api.hideAdvice('hookAdvice')) }) }} data-testid="accounts-hook-hide">Don&apos;t show again</button>
          </div>
        </div>
      )}

      {overrides.length > 0 && !view.hidden.authEnvAdvice && (
        <div className="flex flex-col gap-1 p-3 border border-[#e5c07b]/50 rounded bg-[#252526]" data-testid="accounts-auth-advice">
          <span className="text-xs text-[#d4d4d4] leading-relaxed">
            These outrank every profile&apos;s own sign-in, so switching account won&apos;t change which account Claude Code uses while they are set:
          </span>
          <ul className="text-[11px] text-[#bbb] list-disc pl-5">{overrides.map((o) => <li key={o}><code>{o}</code></li>)}</ul>
          <div>
            <button className={BUTTON} disabled={busy} onClick={() => { void act(async () => { must(await api.hideAdvice('authEnvAdvice')) }) }} data-testid="accounts-auth-hide">Don&apos;t show again</button>
          </div>
        </div>
      )}

      {changes !== null && <Changes changes={changes} />}
      {leftOut.length > 0 && <span className="text-xs text-[#e5c07b]" data-testid="accounts-left-out">Left out of the copy (they can hold a key or a token): {leftOut.join(', ')}</span>}
      {error !== null && <p className="text-xs text-[#e06c75]" role="alert" data-testid="accounts-error">{error}</p>}

      {ACCOUNT_AGENTS.map(section)}
    </div>
  )
}
