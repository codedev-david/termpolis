import { useState } from 'react'
import {
  ACCOUNT_AGENT_LABEL, DEFAULT_PROFILE_FOLDER, SHAREABLE_FOLDERS, isPlainEmail, isProfileAgent, slugOf, tildifyPath,
} from '../../../../shared/agentAccounts'
import type { AccountAgent, AddAccountResult, PickFolderResult, ProfileAgent } from '../../../../shared/agentAccounts'
import type { AccountsAPI } from '../../types'
import { AGENT_INTEGRATION_WRITES, PRIMER_HOOK_DESCRIPTION } from '../../../../shared/agentIntegration'

// Settings ▸ Accounts ▸ Add account (design §4.2). For Claude Code and Codex an account is a
// profile folder: a new one Termpolis makes (`~/.claude-<slug>`, shared subfolders linked, a
// stripped copy of the main settings), or one the user picks in main's own dialog. For agy it is
// a label: a name and the Google email it signs in with. Connecting lists what it writes, and is
// ticked by default only when the account is offered automatically (R17).

const BUTTON = 'text-xs px-2 py-1 rounded bg-[#2d2d2d] text-[#d4d4d4] hover:bg-[#3a3a3a] disabled:opacity-50'
const PRIMARY = 'text-xs px-3 py-1 rounded bg-[#0078d4] text-white hover:bg-[#1a86d9] disabled:opacity-50'
const INPUT = 'bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-xs text-[#d4d4d4] w-full'

/** What connecting means for the data: shown above every Connect tick (R17). */
export const CONNECT_DATA_LINE = 'Termpolis\'s memory is shared by every connected account: what you work on in this account is recalled in your others, and theirs in this one.'

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export interface AddAccountDialogProps {
  /** The accounts bridge, which the tab has already found. */
  api: AccountsAPI
  agent: AccountAgent
  home: string
  integrationConnected: boolean
  onClose: () => void
  /** The account was added; the dialog then shows what was made. */
  onAdded: (result: AddAccountResult) => void
}

export function AddAccountDialog({ api, agent, home, integrationConnected, onClose, onAdded }: AddAccountDialogProps) {
  const profileAgent = isProfileAgent(agent) ? agent : null
  const [label, setLabel] = useState('')
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
  const [result, setResult] = useState<AddAccountResult | null>(null)
  const [copied, setCopied] = useState(false)

  const connect = integrationConnected && (connectChoice ?? autoOffer)
  const sep = home.includes('\\') ? '\\' : '/'
  const slug = slugOf(label)
  const newFolder = profileAgent ? tildifyPath(`${home}${sep}${DEFAULT_PROFILE_FOLDER[profileAgent]}-${slug ?? '…'}`, home) : ''
  const emailOk = !email.trim() || isPlainEmail(email.trim())
  const folderOk = !profileAgent || (mode === 'new' ? !!slug : !!picked?.folder && !picked.error)
  const canAdd = !!label.trim() && emailOk && folderOk && !busy

  const pick = async (forAgent: ProfileAgent) => {
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
  const add = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.add(profileAgent
        ? { agent, label: label.trim(), email: email.trim() || undefined, folder: mode, share, copy, connect, autoOffer }
        : { agent, label: label.trim(), email: email.trim() || undefined, autoOffer })
      if (!r.success) throw new Error(r.error)
      setResult(r.data)
      onAdded(r.data)
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  const copyLines = async (lines: string[]) => {
    try {
      const r = await window.termpolis.clipboardWriteText(lines.join('\n'))
      setCopied(r.success)
    } catch {
      setCopied(false)
    }
  }

  const toggleShare = (name: string, on: boolean) => {
    setShare((prev) => (on ? [...prev.filter((s) => s !== name), name] : prev.filter((s) => s !== name)))
  }

  const title = `Add a ${ACCOUNT_AGENT_LABEL[agent]} account`

  if (result) {
    return (
      <section aria-label={title} className="flex flex-col gap-2 p-3 border border-[#3c3c3c] rounded bg-[#1e1e1e]" data-testid="add-account-done">
        <span className="text-sm font-medium">Added {result.account.label}</span>
        {result.account.folder && <code className="text-[11px] text-[#9ca3af] break-all">{tildifyPath(result.account.folder, home)}</code>}
        {(result.notes ?? []).map((n) => <span key={n} className="text-xs text-[#d4d4d4]" data-testid="add-account-note">{n}</span>)}
        {result.copied.length > 0 && <span className="text-xs text-[#9ca3af]" data-testid="add-account-copied">Copied: {result.copied.join(', ')}</span>}
        {result.leftOut.length > 0 && (
          <span className="text-xs text-[#e5c07b]" data-testid="add-account-left-out">
            Left out of the copy (they can hold a key or a token): {result.leftOut.join(', ')}
          </span>
        )}
        {result.changes.length > 0 && (
          <ul className="text-[11px] text-[#bbb] list-disc pl-5" data-testid="add-account-changes">
            {result.changes.map((c, i) => <li key={i}>{c.action} {c.what}{c.error ? `: ${c.error}` : ''}</li>)}
          </ul>
        )}
        {profileAgent && <span className="text-xs text-[#9ca3af]">Next: Sign in, in its row. Each account signs in by itself.</span>}
        {result.accountsShLines && (
          <div className="flex flex-col gap-1" data-testid="add-account-accounts-sh">
            <span className="text-xs text-[#d4d4d4]">
              Until ~/.claude/accounts.sh lists it, your status line and failover hook count this profile as your default account. These lines add it:
            </span>
            <pre className="text-[11px] text-[#bbb] bg-[#252526] p-2 rounded whitespace-pre-wrap">{result.accountsShLines.join('\n')}</pre>
            <div className="flex items-center gap-2">
              <button className={BUTTON} onClick={() => { void copyLines(result.accountsShLines as string[]) }} data-testid="add-account-copy-lines">Copy</button>
              {copied && <span className="text-xs text-[#7ee2a3]">Copied</span>}
            </div>
          </div>
        )}
        <div><button className={PRIMARY} onClick={onClose} data-testid="add-account-close">Done</button></div>
      </section>
    )
  }

  return (
    <section aria-label={title} className="flex flex-col gap-2 p-3 border border-[#3c3c3c] rounded bg-[#1e1e1e]" data-testid="add-account-dialog">
      <span className="text-sm font-medium">{title}</span>
      <label className="flex flex-col gap-0.5 text-xs">
        Name
        <input className={INPUT} value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} data-testid="add-account-label" />
      </label>
      <label className="flex flex-col gap-0.5 text-xs">
        {agent === 'agy' ? 'Google email' : 'Email it signs in with (optional)'}
        <input className={INPUT} value={email} onChange={(e) => setEmail(e.target.value)} data-testid="add-account-email" />
      </label>
      {!emailOk && <span className="text-xs text-[#e06c75]" data-testid="add-account-email-error">That isn&apos;t a plain email address.</span>}

      {agent === 'agy' && (
        <span className="text-xs text-[#9ca3af]">
          The Antigravity CLI keeps one Google sign-in for your whole computer user, so this account has no folder and nothing to connect.
        </span>
      )}

      {profileAgent && (
        <>
          <fieldset className="flex flex-col gap-1 text-xs" data-testid="add-account-folder">
            <legend className="mb-1">Folder</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="folder" checked={mode === 'new'} onChange={() => setMode('new')} data-testid="add-account-new" />
              A new folder <code className="text-[#9ca3af]">{newFolder}</code>
            </label>
            {mode === 'new' && label.trim() && !slug && (
              <span className="text-[#e06c75]">Use letters or digits in the name: it names the folder.</span>
            )}
            <label className="flex items-center gap-2">
              <input type="radio" name="folder" checked={mode === 'existing'} onChange={() => setMode('existing')} data-testid="add-account-existing" />
              An existing folder
              <button className={BUTTON} disabled={mode !== 'existing'} onClick={() => { void pick(profileAgent) }} data-testid="add-account-choose">Choose…</button>
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
              <fieldset className="flex flex-col gap-1 text-xs" data-testid="add-account-share">
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
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} data-testid="add-account-copy" />
                {profileAgent === 'claude'
                  ? 'Start from a copy of my settings.json and CLAUDE.md'
                  : 'Start from a copy of my config.toml'}
              </label>
              {copy && <span className="text-[11px] text-[#9ca3af] pl-6">Settings that can hold a key or a token are left out, and named.</span>}
            </>
          )}

          <div className="flex flex-col gap-1 text-xs" data-testid="add-account-connect">
            <span className="text-[#9ca3af]">{CONNECT_DATA_LINE}</span>
            <label className={`flex items-center gap-2 ${integrationConnected ? '' : 'opacity-50'}`}>
              <input
                type="checkbox"
                checked={connect}
                disabled={!integrationConnected}
                onChange={(e) => setConnectChoice(e.target.checked)}
                data-testid="add-account-connect-box"
              />
              Connect this profile to Termpolis
            </label>
            {!integrationConnected && <span className="text-[#9ca3af] pl-6" data-testid="add-account-connect-off">Turn on Agent Integration first.</span>}
            <ul className="text-[11px] text-[#bbb] list-disc pl-10 space-y-0.5" data-testid="add-account-writes">
              {AGENT_INTEGRATION_WRITES[profileAgent].map((line) => <li key={line}>{line}</li>)}
              {profileAgent === 'claude' && <li>When the memory hook is on in Agent Integration: {PRIMER_HOOK_DESCRIPTION}</li>}
            </ul>
          </div>
        </>
      )}

      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={autoOffer} onChange={(e) => setAutoOffer(e.target.checked)} data-testid="add-account-auto-offer" />
        Offer it automatically when another {ACCOUNT_AGENT_LABEL[agent]} account runs out of usage
      </label>

      {error !== null && <p className="text-xs text-[#e06c75]" role="alert" data-testid="add-account-error">{error}</p>}
      <div className="flex items-center gap-2">
        <button className={PRIMARY} disabled={!canAdd} onClick={() => { void add() }} data-testid="add-account-submit">Add</button>
        <button className={BUTTON} onClick={onClose} data-testid="add-account-cancel">Cancel</button>
      </div>
    </section>
  )
}
