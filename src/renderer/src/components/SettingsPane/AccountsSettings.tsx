import { useCallback, useEffect, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { ACCOUNT_AGENTS, ACCOUNT_AGENT_LABEL, isProfileAgent, tildifyPath } from '../../../../shared/agentAccounts'
import type {
  AccountAgent, AccountChange, AccountRowView, AccountsView, ImportPreview, SignInLineResult, SignInMethod, SignInProgress,
  ProfileAgent,
} from '../../../../shared/agentAccounts'
import { useTerminalStore } from '../../store/terminalStore'
import type { ShellType } from '../../types'
import { accountBadge, accountsOf, folderLine, signInShell } from '../../lib/accountsView'
import type { BadgeTone } from '../../lib/accountsView'
import { startSignIn } from '../../lib/accountSignIn'
import type { SignInIO } from '../../lib/accountSignIn'
import { PROMPT_ECHO_CEILING_MS, SHELL_QUIET_MS, SHELL_READY_CEILING_MS, waitForShellReady } from '../../lib/launchSequence'
import { testDelay } from '../../lib/testAgents'
import { getTerminalDefaults } from '../../lib/terminalDefaults'
import { AddAccountDialog, CONNECT_DATA_LINE } from '../Accounts/AddAccountDialog'

// Settings ▸ Accounts (design §4): more than one sign-in per agent. Main owns the registry and
// answers every action with what it did (src/main/accountsIpc.ts); this tab never builds a path,
// reads a config or sees a sign-in. A Claude Code or Codex account is a profile folder; an agy
// account is a label, because the Antigravity CLI keeps one Google sign-in per computer user.

const BUTTON = 'text-xs px-2 py-1 rounded bg-[#2d2d2d] text-[#d4d4d4] hover:bg-[#3a3a3a] disabled:opacity-50'
const INPUT = 'bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-xs text-[#d4d4d4]'

const TONE: Record<BadgeTone, string> = {
  good: 'text-[#7ee2a3]',
  warn: 'text-[#e5c07b]',
  bad: 'text-[#e06c75]',
  muted: 'text-[#9ca3af]',
}

/** Each agent's colour, as its terminal tab and badge show it. */
const AGENT_COLOR: Record<AccountAgent, string> = { claude: '#D97706', codex: '#10B981', agy: '#4285F4' }

type MethodChoice = { id: SignInMethod; label: string; hint?: string }

const SIGN_IN_METHODS: Record<ProfileAgent, MethodChoice[]> = {
  claude: [
    { id: 'claudeai', label: 'Claude account (claude.ai)' },
    { id: 'console', label: 'Anthropic Console' },
    { id: 'sso', label: 'Single sign-on (SSO)' },
  ],
  codex: [
    { id: 'browser', label: 'In the browser' },
    { id: 'device', label: 'With a device code', hint: 'use this if the browser can\'t reach this computer' },
  ],
}

/** The check a StopFailure hook needs to stand down inside Termpolis (design §8.6). */
export const HOOK_CHECK = 'if [ "${TERMPOLIS_LIMIT_CHOOSER:-}" = "1" ]; then exit 0; fi'

const AGY_TEXT = 'The Antigravity CLI keeps one Google sign-in for your whole computer user, in the OS keyring, so it has no separate profiles. An account here is a name and the Google email it signs in with. Switching to one moves every agy terminal on this computer to it.'

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** What a row is doing right now: one action at a time per tab. */
type RowAction = { id: string; kind: 'edit' | 'remove' }

interface SignInState {
  row: AccountRowView
  methods: MethodChoice[]
  method: SignInMethod
  /** The line main built for the shell the terminal opens in: null until it is built. */
  ready: { prep: SignInLineResult; shell: ShellType } | null
  error: string | null
}

function Changes({ changes }: { changes: AccountChange[] }) {
  if (changes.length === 0) return <span className="text-xs text-[#9ca3af]" data-testid="accounts-changes">Nothing needed to change.</span>
  return (
    <ul className="text-[11px] text-[#bbb] list-disc pl-5" data-testid="accounts-changes">
      {changes.map((c, i) => <li key={i}>{c.action} {c.what} <code className="text-[#9ca3af] break-all">{c.file}</code>{c.error ? `: ${c.error}` : ''}</li>)}
    </ul>
  )
}

export function AccountsSettings() {
  const api = window.accounts
  const [view, setView] = useState<AccountsView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [changes, setChanges] = useState<AccountChange[] | null>(null)
  const [adding, setAdding] = useState<AccountAgent | null>(null)
  const [rowAction, setRowAction] = useState<RowAction | null>(null)
  const [edit, setEdit] = useState<{ label: string; email: string }>({ label: '', email: '' })
  const [importing, setImporting] = useState<{ preview: ImportPreview; keys: string[]; connect: Record<string, boolean> } | null>(null)
  const [signIn, setSignIn] = useState<SignInState | null>(null)
  const [shells, setShells] = useState<ShellType[]>([])
  const [copiedCheck, setCopiedCheck] = useState(false)
  const defaultShell = useTerminalStore((s) => s.defaultShell)

  const load = useCallback(async () => {
    if (!api) return
    try {
      const res = await api.list()
      if (res.success) {
        setView(res.data)
        setLoadError(null)
      } else {
        setLoadError(res.error)
      }
    } catch (e) {
      setLoadError(errorText(e))
    }
  }, [api])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    let alive = true
    window.termpolis.getAvailableShells().then((res) => {
      if (alive && res.success) setShells(res.data.map((s) => s.type))
    }).catch(() => undefined)
    return () => { alive = false }
  }, [])

  // A sign-in's progress: a new email in the profile as it lands, then the agent's own answer.
  useEffect(() => {
    if (!api) return undefined
    return api.onSignInProgress((p: SignInProgress) => {
      if (p.done) void load()
      else setView((v) => v && { ...v, accounts: v.accounts.map((r) => (r.id === p.accountId ? { ...r, lastEmail: p.email } : r)) })
    })
  }, [api, load])

  /** One action at a time: every button is disabled until it settles, and the view is re-read. */
  const act = async (action: () => Promise<AccountChange[] | void>) => {
    setBusy(true)
    setError(null)
    setChanges(null)
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

  const openSignIn = async (row: AccountRowView, methods: MethodChoice[], method: SignInMethod) => {
    const shell = signInShell(defaultShell, shells)
    const state: SignInState = { row, methods, method, ready: null, error: null }
    if (!shell) {
      setSignIn({ ...state, error: 'There is no shell Termpolis can type a sign-in into.' })
      return
    }
    try {
      setSignIn({ ...state, ready: { prep: must(await api.signInLine({ accountId: row.id, shellType: shell, method })), shell } })
    } catch (e) {
      setSignIn({ ...state, error: errorText(e) })
    }
  }

  const runSignIn = async (s: SignInState, ready: NonNullable<SignInState['ready']>) => {
    const io: SignInIO = {
      newId: () => uuid(),
      createTerminal: (id, shellType, cwd) => window.termpolis.createTerminal(id, shellType, cwd),
      addTerminal: (t) => useTerminalStore.getState().addTerminal(t),
      waitShellReady: async (terminalId, phase) => {
        await waitForShellReady({
          terminalId,
          subscribe: (cb) => window.termpolis.onTerminalData(cb),
          quietMs: testDelay(SHELL_QUIET_MS),
          ceilingMs: testDelay(phase === 'ready' ? SHELL_READY_CEILING_MS : PROMPT_ECHO_CEILING_MS),
        })
      },
      write: (terminalId, data) => { window.termpolis.writeToTerminal(terminalId, data) },
      outputEnd: async (terminalId) => {
        try {
          const r = await window.termpolis.readTerminalBuffer(terminalId)
          return r.success ? r.data.nextOffset : null
        } catch {
          return null
        }
      },
      watch: (accountId, terminalId, mark) => api.watchSignIn(accountId, terminalId, mark),
      terminalDefaults: () => getTerminalDefaults(),
    }
    const r = await startSignIn({ accountId: s.row.id, line: ready.prep.line, name: ready.prep.name, shellType: ready.shell, home: view.home, color: AGENT_COLOR[s.row.agent] }, io)
    if ('error' in r) setSignIn({ ...s, error: `Couldn't open the sign-in terminal: ${r.error}` })
    else setSignIn(null)
  }

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

  const rowButtons = (r: AccountRowView, list: AccountRowView[], i: number) => {
    const profile = isProfileAgent(r.agent)
    const methods = isProfileAgent(r.agent) ? SIGN_IN_METHODS[r.agent] : null
    const editing = rowAction?.id === r.id && rowAction.kind === 'edit'
    const removing = rowAction?.id === r.id && rowAction.kind === 'remove'
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <button className={BUTTON} disabled={busy || i === 0} aria-label={`Move ${r.label} up`} onClick={() => { void act(async () => { must(await api.move(r.id, -1)) }) }} data-testid={`account-up-${r.id}`}>↑</button>
        <button className={BUTTON} disabled={busy || i === list.length - 1} aria-label={`Move ${r.label} down`} onClick={() => { void act(async () => { must(await api.move(r.id, 1)) }) }} data-testid={`account-down-${r.id}`}>↓</button>
        {methods && r.folderExists && (
          <>
            <button className={BUTTON} disabled={busy} onClick={() => { void openSignIn(r, methods, methods[0].id) }} data-testid={`account-sign-in-${r.id}`}>Sign in</button>
            <button className={BUTTON} disabled={busy} onClick={() => { void act(async () => { must(await api.check(r.id)) }) }} data-testid={`account-check-${r.id}`}>Check</button>
          </>
        )}
        {profile && r.folderExists && !r.isDefault && (
          r.connect
            ? <button className={BUTTON} disabled={busy} onClick={() => { void act(async () => must(await api.setConnect(r.id, false)).changes) }} data-testid={`account-disconnect-${r.id}`}>Disconnect</button>
            : <button className={BUTTON} disabled={busy || !view.integrationConnected} title={view.integrationConnected ? CONNECT_DATA_LINE : 'Turn on Agent Integration first'} onClick={() => { void act(async () => must(await api.setConnect(r.id, true)).changes) }} data-testid={`account-connect-${r.id}`}>Connect</button>
        )}
        {r.limit && <button className={BUTTON} disabled={busy} onClick={() => { void act(async () => { must(await api.clearLimit(r.id)) }) }} data-testid={`account-mark-available-${r.id}`}>Mark available</button>}
        <label className="flex items-center gap-1 text-[11px] text-[#d4d4d4]">
          <input type="checkbox" checked={r.autoOffer} disabled={busy} onChange={(e) => { const on = e.target.checked; void act(async () => { must(await api.update(r.id, { autoOffer: on })) }) }} data-testid={`account-auto-offer-${r.id}`} />
          Offer automatically
        </label>
        <button className={BUTTON} disabled={busy} onClick={() => { setRowAction(editing ? null : { id: r.id, kind: 'edit' }); setEdit({ label: r.label, email: r.email ?? '' }) }} data-testid={`account-edit-${r.id}`}>Rename</button>
        <button className={BUTTON} disabled={busy} onClick={() => setRowAction(removing ? null : { id: r.id, kind: 'remove' })} data-testid={`account-remove-${r.id}`}>Remove…</button>
      </div>
    )
  }

  const rowPanel = (r: AccountRowView) => {
    if (rowAction?.id !== r.id) return null
    if (rowAction.kind === 'edit') {
      return (
        <div className="flex flex-wrap items-center gap-2 pt-1" data-testid={`account-edit-form-${r.id}`}>
          <input className={INPUT} aria-label="Name" value={edit.label} maxLength={40} onChange={(e) => setEdit({ ...edit, label: e.target.value })} data-testid={`account-edit-label-${r.id}`} />
          <input className={INPUT} aria-label="Email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} data-testid={`account-edit-email-${r.id}`} />
          <button className={BUTTON} disabled={busy} onClick={() => { void act(async () => { must(await api.update(r.id, { label: edit.label, email: edit.email })); setRowAction(null) }) }} data-testid={`account-edit-save-${r.id}`}>Save</button>
        </div>
      )
    }
    return (
      <div className="flex flex-wrap items-center gap-2 pt-1 text-xs" data-testid={`account-remove-confirm-${r.id}`}>
        <span className="text-[#d4d4d4]">
          {isProfileAgent(r.agent)
            ? `Termpolis forgets ${r.label} and takes its entries out of the profile. The folder, its sign-in and its links stay.`
            : `Termpolis forgets ${r.label}. agy's own sign-in stays as it is.`}
        </span>
        <button className={BUTTON} disabled={busy} onClick={() => { void act(async () => { const c = must(await api.remove(r.id)).changes; setRowAction(null); return c }) }} data-testid={`account-remove-yes-${r.id}`}>Remove</button>
        <button className={BUTTON} onClick={() => setRowAction(null)}>Keep it</button>
      </div>
    )
  }

  const row = (r: AccountRowView, list: AccountRowView[], i: number) => {
    const badge = accountBadge(r, now)
    const copiedEntries = r.agent === 'claude' && !r.isDefault && !r.connect && !!r.connection && (r.connection.hook || r.connection.allow)
    return (
      <div key={r.id} className="flex flex-col gap-1 p-2 rounded border border-[#3c3c3c] bg-[#1e1e1e]" data-testid={`account-row-${r.id}`}>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: r.color ?? AGENT_COLOR[r.agent] }} />
          <span className="text-sm font-medium text-[#e0e0e0]">{r.label}</span>
          {r.email && <span className="text-xs text-[#9ca3af]">{r.email}</span>}
          <span className={`text-xs ${TONE[badge.tone]}`} data-testid={`account-badge-${r.id}`}>{badge.text}</span>
          {isProfileAgent(r.agent) && !r.isDefault && r.folderExists && !r.connect && <span className="text-xs text-[#9ca3af]" data-testid={`account-not-connected-${r.id}`}>not connected</span>}
          {r.terminals > 0 && <span className="text-[11px] text-[#9ca3af]">{r.terminals} terminal{r.terminals === 1 ? '' : 's'} on it</span>}
        </div>
        {r.folder && <code className="text-[11px] text-[#9ca3af] break-all">{folderLine(r, view.home)}</code>}
        {r.shares.length > 0 && <span className="text-[11px] text-[#9ca3af]">Shares {r.shares.join(', ')} with your main profile</span>}
        {copiedEntries && (
          <div className="flex flex-wrap items-center gap-2 text-[11px]" data-testid={`account-copied-entries-${r.id}`}>
            <span className="text-[#e5c07b]">Termpolis&apos;s memory hook or tool permissions are in this profile (copied), but it isn&apos;t connected.</span>
            <button className={BUTTON} disabled={busy} onClick={() => { void act(async () => must(await api.stripCopied(r.id)).changes) }} data-testid={`account-strip-${r.id}`}>Remove the copied entries</button>
          </div>
        )}
        {rowButtons(r, list, i)}
        {rowPanel(r)}
      </div>
    )
  }

  const signInPanel = (s: SignInState) => {
    const ready = s.ready
    return (
      <div className="flex flex-col gap-2 p-3 border border-[#3c3c3c] rounded bg-[#252526]" data-testid="account-sign-in-panel">
        <span className="text-sm font-medium">Sign in to {s.row.label}</span>
        <fieldset className="flex flex-col gap-1 text-xs">
          {s.methods.map((m) => (
            <label key={m.id} className="flex items-center gap-2">
              <input type="radio" name="sign-in-method" checked={s.method === m.id} onChange={() => { void openSignIn(s.row, s.methods, m.id) }} data-testid={`account-sign-in-method-${m.id}`} />
              {m.label}{m.hint ? <span className="text-[#9ca3af]">: {m.hint}</span> : null}
            </label>
          ))}
        </fieldset>
        {ready && (
          <>
            <span className="text-xs text-[#e5c07b]" data-testid="account-sign-in-warning">{ready.prep.warning}</span>
            <span className="text-xs text-[#9ca3af]">
              Termpolis opens a terminal and types this; the agent opens your browser and keeps its own sign-in. Termpolis answers none of its screens.
            </span>
            <code className="text-[11px] text-[#bbb] break-all" data-testid="account-sign-in-line">{ready.prep.line}</code>
          </>
        )}
        {s.error && <span className="text-xs text-[#e06c75]" role="alert" data-testid="account-sign-in-error">{s.error}</span>}
        <div className="flex items-center gap-2">
          {ready
            ? <button className={BUTTON} onClick={() => { void runSignIn(s, ready) }} data-testid="account-sign-in-go">Open the sign-in terminal</button>
            : <button className={BUTTON} disabled data-testid="account-sign-in-go">Open the sign-in terminal</button>}
          <button className={BUTTON} onClick={() => setSignIn(null)} data-testid="account-sign-in-cancel">Cancel</button>
        </div>
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

  const card = (agent: AccountAgent) => {
    const list = accountsOf(view.accounts, agent)
    const profile = isProfileAgent(agent)
    return (
      <div key={agent} className="flex flex-col gap-2 p-3 border border-[#3c3c3c] rounded bg-[#252526]" data-testid={`accounts-card-${agent}`}>
        <span className="text-sm font-medium text-[#e0e0e0]">{ACCOUNT_AGENT_LABEL[agent]}</span>
        {agent === 'agy' && <span className="text-xs text-[#9ca3af] leading-relaxed" data-testid="accounts-agy-text">{AGY_TEXT}</span>}
        {list.length === 0
          ? <span className="text-xs text-[#9ca3af]" data-testid={`accounts-empty-${agent}`}>{profile ? 'No accounts yet: Termpolis uses your main profile.' : 'No accounts yet.'}</span>
          : list.map((r, i) => row(r, list, i))}
        {profile && list.length > 0 && (
          <label className="flex items-center gap-2 text-xs">
            New terminals launch on
            <select
              className={INPUT}
              value={view.preferred[agent] ?? ''}
              disabled={busy}
              onChange={(e) => { const id = e.target.value || null; void act(async () => { must(await api.setPreferred(agent, id)) }) }}
              data-testid={`accounts-preferred-${agent}`}
            >
              <option value="">the main profile</option>
              {list.filter((r) => !r.isDefault).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </label>
        )}
        {adding === agent
          ? <AddAccountDialog api={api} agent={agent} home={view.home} integrationConnected={view.integrationConnected} onClose={() => setAdding(null)} onAdded={() => { void load() }} />
          : (
            <div className="flex flex-wrap items-center gap-2">
              <button className={BUTTON} disabled={busy} onClick={() => setAdding(agent)} data-testid={`accounts-add-${agent}`}>+ Add account</button>
              {agent === 'claude' && view.importAvailable && (
                <button className={BUTTON} disabled={busy} onClick={() => { void openImport() }} data-testid="accounts-import">Import from ~/.claude/accounts.sh</button>
              )}
            </div>
          )}
        {agent === 'claude' && importPanel()}
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

      {!view.integrationConnected && (
        <p className="text-xs text-[#9ca3af]" data-testid="accounts-integration-off">
          Agent Integration is off, so no account&apos;s profile is connected to Termpolis. Turn it on in Settings ▸ Agent Integration to connect them.
        </p>
      )}

      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={view.chooser} disabled={busy} onChange={(e) => { const on = e.target.checked; void act(async () => { must(await api.setChooser(on)) }) }} data-testid="accounts-chooser" />
        Open the account chooser by itself when an agent runs out of usage
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

      {signIn && signInPanel(signIn)}
      {changes !== null && <Changes changes={changes} />}
      {error !== null && <p className="text-xs text-[#e06c75]" role="alert" data-testid="accounts-error">{error}</p>}

      {ACCOUNT_AGENTS.map(card)}
    </div>
  )
}
