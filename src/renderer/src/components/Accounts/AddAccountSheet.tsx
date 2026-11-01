// Add account (the in-app account UI, §2.5; design §4.2): a short wizard in a sheet, from Settings ▸
// Accounts, the account menu and the limit card. 1, Name and colour: the email it signs in with,
// whether it is offered automatically, Connect with what that writes (ticked by default only for
// an account offered automatically, R17); its folder, what it shares and the settings copy are
// under Advanced (a new ~/.claude-<slug> by default, made behind the scenes). 2, Sign in: the
// sign-in sheet's own steps, inline, or Skip for now. 3, Done, with the email it signed in as.
// An agy account is a label (a name, a colour, its Google email): its one sign-in moves with agy's
// switch, so there is no sign-in step.
import { useState } from 'react'
import {
  ACCOUNT_AGENT_LABEL, DEFAULT_PROFILE_FOLDER, SHAREABLE_FOLDERS, isPlainEmail, isProfileAgent, slugOf, tildifyPath,
} from '../../../../shared/agentAccounts'
import type { AccountAgent, AccountsView, AddAccountResult, PickFolderResult, ProfileAgent } from '../../../../shared/agentAccounts'
import { AGENT_INTEGRATION_WRITES, PRIMER_HOOK_DESCRIPTION } from '../../../../shared/agentIntegration'
import { useTerminalStore } from '../../store/terminalStore'
import { ACCOUNT_COLORS, ACCOUNT_COLOR_NAMES, freeColor } from '../../lib/accountsView'
import { refreshAccounts } from '../../lib/accountsState'
import { Sheet } from './Sheet'
import { SignInFlow } from './SignInFlow'
import { SHEET_INPUT, SHEET_PRIMARY, SHEET_SECONDARY, SMALL_BUTTON } from './ui'

/** What connecting means for the data: shown above every Connect tick (R17). */
export const CONNECT_DATA_LINE = 'Termpolis\'s memory is shared by every connected account: what you work on in this account is recalled in your others, and theirs in this one. Learning reads the conversations of every registered account, connected or not.'

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function AddAccountSheet() {
  const open = useTerminalStore((s) => s.addAccountSheet)
  const view = useTerminalStore((s) => s.accountsView)
  if (!open) return null
  const close = (): void => useTerminalStore.getState().closeAddAccount()
  const title = `Add a ${ACCOUNT_AGENT_LABEL[open.agent]} account`
  if (!window.accounts || !view) {
    return (
      <Sheet title={title} icon="fa-user-plus" onClose={close} testId="add-account">
        <p data-testid="add-account-unavailable">Termpolis hasn&apos;t read your accounts yet. Open Settings ▸ Accounts, then try again.</p>
        <div><button type="button" className={SHEET_SECONDARY} onClick={close} data-autofocus="">Close</button></div>
      </Sheet>
    )
  }
  return <Wizard key={open.agent} agent={open.agent} view={view} title={title} close={close} />
}

type Step = { kind: 'form' } | { kind: 'sign-in'; result: AddAccountResult } | { kind: 'done'; result: AddAccountResult; email: string | null | undefined }

function Wizard({ agent, view, title, close }: { agent: AccountAgent; view: AccountsView; title: string; close: () => void }) {
  const api = window.accounts!
  const profileAgent = isProfileAgent(agent) ? agent : null
  const [step, setStep] = useState<Step>({ kind: 'form' })
  const [label, setLabel] = useState('')
  const [color, setColor] = useState(() => freeColor(view, agent))
  const [email, setEmail] = useState('')
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [picked, setPicked] = useState<PickFolderResult | null>(null)
  const [share, setShare] = useState<string[]>(() => (profileAgent ? SHAREABLE_FOLDERS[profileAgent].filter((f) => f.on).map((f) => f.name) : []))
  const [copy, setCopy] = useState(true)
  const [autoOffer, setAutoOffer] = useState(true)
  // Follows "Offer automatically" until the user ticks it themselves (R17).
  const [connectChoice, setConnectChoice] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const home = view.home
  const connect = view.integrationConnected && (connectChoice ?? autoOffer)
  const sep = home.includes('\\') ? '\\' : '/'
  const slug = slugOf(label)
  const newFolder = profileAgent ? tildifyPath(`${home}${sep}${DEFAULT_PROFILE_FOLDER[profileAgent]}-${slug ?? '…'}`, home) : ''
  const emailOk = !email.trim() || isPlainEmail(email.trim())
  const folderOk = !profileAgent || (mode === 'new' ? !!slug : !!picked?.folder && !picked.error)
  const canAdd = !!label.trim() && emailOk && folderOk && !busy

  const pick = async (forAgent: ProfileAgent): Promise<void> => {
    setError(null)
    try {
      const r = await api.pickFolder(forAgent)
      if (!r.success) throw new Error(r.error)
      setPicked(r.data.folder === null ? null : r.data)
    } catch (e) {
      setError(errorText(e))
    }
  }

  // Only the Add button calls this, and it is disabled until the form can be added.
  const add = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const base = { agent, label: label.trim(), email: email.trim() || undefined, autoOffer, color }
      const r = await api.add(profileAgent ? { ...base, folder: mode, share, copy, connect } : base)
      if (!r.success) throw new Error(r.error)
      // The chips, the menu and Settings read the new account; the sign-in step reads it too.
      await refreshAccounts(api)
      setStep(profileAgent ? { kind: 'sign-in', result: r.data } : { kind: 'done', result: r.data, email: undefined })
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  const copyLines = async (lines: string[]): Promise<void> => {
    try {
      setCopied((await window.termpolis.clipboardWriteText(lines.join('\n'))).success)
    } catch {
      setCopied(false)
    }
  }

  const toggleShare = (name: string, on: boolean): void => {
    setShare((prev) => (on ? [...prev.filter((s) => s !== name), name] : prev.filter((s) => s !== name)))
  }

  let body: React.ReactNode
  if (step.kind === 'sign-in') {
    const row = step.result.account
    body = (
      <div className="flex flex-col gap-3" data-testid="add-account-sign-in-step">
        <p className="text-xs text-[#9ca3af]">Step 2 of 3 · Sign in. {row.label} has a profile of its own: it signs in there, by itself, in your browser.</p>
        <SignInFlow
          account={row}
          view={view}
          doneLabel="Next"
          onDone={(signedIn) => setStep({ kind: 'done', result: step.result, email: signedIn })}
          onCancel={() => setStep({ kind: 'done', result: step.result, email: null })}
        />
        <div><button type="button" className={SMALL_BUTTON} onClick={() => setStep({ kind: 'done', result: step.result, email: null })} data-testid="add-account-skip">Skip for now</button></div>
      </div>
    )
  } else if (step.kind === 'done') {
    const { result } = step
    const name = result.account.label
    body = (
      <div className="flex flex-col gap-2" data-testid="add-account-done">
        <p className="text-[#7ee2a3]" data-testid="add-account-done-headline">
          {step.email ? `${name} is signed in as ${step.email}.` : step.email === null ? `Added ${name}. It isn't signed in yet.` : `Added ${name}.`}
        </p>
        {step.email === null && <p className="text-xs text-[#9ca3af]">Sign it in from its card in Settings ▸ Accounts, or when you first switch to it.</p>}
        {!profileAgent && <p className="text-xs text-[#9ca3af]">Switching Gemini CLI to it signs agy in as it, for every Gemini terminal.</p>}
        {(result.notes ?? []).map((n) => <p key={n} className="text-xs text-[#d4d4d4]" data-testid="add-account-note">{n}</p>)}
        {result.accountsShLines && (
          <div className="flex flex-col gap-1" data-testid="add-account-accounts-sh">
            <p className="text-xs text-[#d4d4d4]">
              Until ~/.claude/accounts.sh lists it, your status line and failover hook count this profile as your default account. These lines add it:
            </p>
            <pre className="text-[11px] text-[#bbb] bg-[#1e1e1e] p-2 rounded whitespace-pre-wrap">{result.accountsShLines.join('\n')}</pre>
            <div className="flex items-center gap-2">
              <button type="button" className={SMALL_BUTTON} onClick={() => { void copyLines(result.accountsShLines as string[]) }} data-testid="add-account-copy-lines">Copy</button>
              {copied && <span className="text-xs text-[#7ee2a3]">Copied</span>}
            </div>
          </div>
        )}
        {(result.account.folder || result.copied.length > 0 || result.leftOut.length > 0 || result.changes.length > 0) && (
          <details className="text-xs" data-testid="add-account-advanced-done">
            <summary className="cursor-pointer text-[#9ca3af]">Advanced</summary>
            <div className="flex flex-col gap-1 pt-1">
              {result.account.folder && <code className="text-[11px] text-[#9ca3af] break-all">{tildifyPath(result.account.folder, home)}</code>}
              {result.copied.length > 0 && <span className="text-[#9ca3af]" data-testid="add-account-copied">Copied: {result.copied.join(', ')}</span>}
              {result.leftOut.length > 0 && <span className="text-[#e5c07b]" data-testid="add-account-left-out">Left out of the copy (they can hold a key or a token): {result.leftOut.join(', ')}</span>}
              {result.changes.length > 0 && (
                <ul className="text-[11px] text-[#bbb] list-disc pl-5" data-testid="add-account-changes">
                  {result.changes.map((c, i) => <li key={i}>{c.action} {c.what}{c.error ? `: ${c.error}` : ''}</li>)}
                </ul>
              )}
            </div>
          </details>
        )}
        <div><button type="button" className={SHEET_PRIMARY} onClick={close} data-autofocus="" data-testid="add-account-finish">Done</button></div>
      </div>
    )
  } else {
    body = (
      <div className="flex flex-col gap-3" data-testid="add-account-dialog">
        <p className="text-xs text-[#9ca3af]">{profileAgent ? 'Step 1 of 3 · Name and colour' : 'A name, a colour and the Google account it signs in with'}</p>
        <label className="flex flex-col gap-1 text-xs">
          Name
          <input className={SHEET_INPUT} value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} data-autofocus="" data-testid="add-account-label" />
        </label>
        <div className="flex flex-col gap-1 text-xs">
          <span id="add-account-color-label">Colour</span>
          <div
            role="radiogroup"
            aria-labelledby="add-account-color-label"
            className="flex flex-wrap gap-1.5"
            data-testid="add-account-colors"
            onKeyDown={(e) => {
              // A radio group is one stop for Tab, and the arrows move the choice (and the focus) within it.
              const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
              if (step === 0) return
              e.preventDefault()
              const at = Math.max(0, ACCOUNT_COLORS.indexOf(color))
              const next = ACCOUNT_COLORS[(at + step + ACCOUNT_COLORS.length) % ACCOUNT_COLORS.length]
              setColor(next)
              e.currentTarget.querySelector<HTMLElement>(`[data-color="${next}"]`)?.focus()
            }}
          >
            {ACCOUNT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={ACCOUNT_COLOR_NAMES[c] ?? c}
                tabIndex={color === c ? 0 : -1}
                data-color={c}
                onClick={() => setColor(c)}
                className={`w-6 h-6 rounded-full border-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#22D3EE] ${color === c ? 'border-white' : 'border-transparent'}`}
                style={{ backgroundColor: c }}
                data-testid="add-account-color"
              />
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-1 text-xs">
          {agent === 'agy' ? 'Google email' : 'Email it signs in with (optional)'}
          <input className={SHEET_INPUT} value={email} onChange={(e) => setEmail(e.target.value)} data-testid="add-account-email" />
        </label>
        {!emailOk && <span className="text-xs text-[#e06c75]" data-testid="add-account-email-error">That isn&apos;t a plain email address.</span>}
        {agent === 'agy' && (
          <span className="text-xs text-[#9ca3af]">
            The Antigravity CLI keeps one Google sign-in for your whole computer user, so this account has no folder and nothing to connect.
          </span>
        )}
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={autoOffer} onChange={(e) => setAutoOffer(e.target.checked)} data-testid="add-account-auto-offer" />
          Offer it automatically when another {ACCOUNT_AGENT_LABEL[agent]} account runs out of usage
        </label>
        {profileAgent && (
          <div className="flex flex-col gap-1 text-xs" data-testid="add-account-connect">
            <span className="text-[#9ca3af]">{CONNECT_DATA_LINE}</span>
            <label className={`flex items-center gap-2 ${view.integrationConnected ? '' : 'opacity-50'}`}>
              <input type="checkbox" checked={connect} disabled={!view.integrationConnected} onChange={(e) => setConnectChoice(e.target.checked)} data-testid="add-account-connect-box" />
              Connect this profile to Termpolis
            </label>
            {!view.integrationConnected && <span className="text-[#9ca3af] pl-6" data-testid="add-account-connect-off">Turn on Agent Integration first.</span>}
            <ul className="text-[11px] text-[#bbb] list-disc pl-10 space-y-0.5" data-testid="add-account-writes">
              {AGENT_INTEGRATION_WRITES[profileAgent].map((line) => <li key={line}>{line}</li>)}
              {profileAgent === 'claude' && <li>When the memory hook is on in Agent Integration: {PRIMER_HOOK_DESCRIPTION}</li>}
            </ul>
          </div>
        )}
        {profileAgent && (
          <details className="text-xs" data-testid="add-account-advanced">
            <summary className="cursor-pointer text-[#9ca3af]">Advanced: its folder, and what it shares with your main profile</summary>
            <div className="flex flex-col gap-2 pt-2">
              <fieldset className="flex flex-col gap-1" data-testid="add-account-folder">
                <legend className="mb-1">Folder</legend>
                <label className="flex items-center gap-2">
                  <input type="radio" name="add-account-folder" checked={mode === 'new'} onChange={() => setMode('new')} data-testid="add-account-new" />
                  A new folder <code className="text-[#9ca3af]">{newFolder}</code>
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="add-account-folder" checked={mode === 'existing'} onChange={() => setMode('existing')} data-testid="add-account-existing" />
                  An existing folder
                  <button type="button" className={SMALL_BUTTON} disabled={mode !== 'existing'} onClick={() => { void pick(profileAgent) }} data-testid="add-account-choose">Choose…</button>
                </label>
                {mode === 'existing' && picked && (
                  <span className={picked.error ? 'text-[#e06c75]' : 'text-[#9ca3af]'} data-testid="add-account-picked">
                    <code>{picked.folder}</code>
                    {picked.error ? `: ${picked.error}` : picked.isDefault ? ' (your main profile)' : ''}
                    {!picked.error && picked.shares && picked.shares.length > 0 ? ` · shares ${picked.shares.join(', ')} with your main profile` : ''}
                  </span>
                )}
              </fieldset>
              {mode === 'new' && (
                <>
                  <fieldset className="flex flex-col gap-1" data-testid="add-account-share">
                    <legend className="mb-1">Share with your main profile (a link to its folder)</legend>
                    {SHAREABLE_FOLDERS[profileAgent].map((f) => (
                      <label key={f.name} className="flex items-center gap-2">
                        <input type="checkbox" checked={share.includes(f.name)} onChange={(e) => toggleShare(f.name, e.target.checked)} data-testid={`add-account-share-${f.name}`} />
                        <code>{f.name}</code>
                      </label>
                    ))}
                    {profileAgent === 'claude' && !share.includes('projects') && (
                      <span className="text-[#e5c07b]" data-testid="add-account-projects-warning">
                        Termpolis&apos;s live views and Claude&apos;s own memory won&apos;t follow this account, and its conversations can&apos;t continue on your others.
                      </span>
                    )}
                    {profileAgent === 'codex' && !share.includes('sessions') && (
                      <span className="text-[#e5c07b]" data-testid="add-account-sessions-warning">
                        Codex conversations can&apos;t continue between this account and your others.
                      </span>
                    )}
                  </fieldset>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} data-testid="add-account-copy" />
                    {profileAgent === 'claude' ? 'Start from a copy of my settings.json and CLAUDE.md' : 'Start from a copy of my config.toml'}
                  </label>
                  {copy && <span className="text-[11px] text-[#9ca3af] pl-6">Settings that can hold a key or a token are left out, and named.</span>}
                </>
              )}
            </div>
          </details>
        )}
        {profileAgent && mode === 'new' && label.trim() && !slug && (
          <span className="text-xs text-[#e06c75]" data-testid="add-account-slug-error">Use letters or digits in the name: it names the account&apos;s folder.</span>
        )}
        {error !== null && <p className="text-xs text-[#e06c75]" role="alert" data-testid="add-account-error">{error}</p>}
        <div className="flex items-center gap-2">
          <button type="button" className={SHEET_PRIMARY} disabled={!canAdd} onClick={() => { void add() }} data-testid="add-account-submit">
            {busy ? 'Adding…' : profileAgent ? 'Add and sign in' : 'Add'}
          </button>
          <button type="button" className={SHEET_SECONDARY} onClick={close} data-testid="add-account-cancel">Cancel</button>
        </div>
      </div>
    )
  }

  return (
    <Sheet title={title} icon="fa-user-plus" testId="add-account" {...(busy ? {} : { onClose: close })}>
      {body}
    </Sheet>
  )
}
