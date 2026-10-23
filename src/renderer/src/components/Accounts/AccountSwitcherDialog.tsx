// The account switch dialog (§7.1, D12): an in-app dialog for one agent terminal, opened from its
// chip, Ctrl+Shift+N, the command palette, the terminal's context menu or Settings ▸ Accounts. It
// lists the other accounts of the terminal's agent with [Switch here] (the conversation moves, in
// place) and [New terminal] (a fresh session beside it), asks what a switch must ask first, and
// says how it went. Main does the switching (accounts:switch); this never types into a terminal.
import { useEffect, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { ACCOUNT_AGENT_LABEL, isProfileAgent } from '../../../../shared/agentAccounts'
import type { AccountRowView } from '../../../../shared/agentAccounts'
import type { SwitchAnswers, SwitchTarget, OutcomeView } from '../../lib/accountSwitchFlow'
import {
  checkSignIn, openOnAccount, outcomeView, runSwitch, switchQuestions, switchTargets, terminalAgent,
} from '../../lib/accountSwitchFlow'
import type { SwitchProgress } from '../../../../shared/accountSwitch'
import { AGENT_COLOR } from '../../lib/accountsView'
import { launchAgents } from '../../lib/agentLaunch'
import { refreshAccounts } from '../../lib/accountsState'
import { requestSettingsTab } from '../../lib/settingsNav'
import { isAutoPrimerEnabled } from '../../hooks/useAutoPrimer'
import { useTerminalStore } from '../../store/terminalStore'

const BUTTON = 'text-xs px-2 py-1 rounded bg-[#2d2d2d] text-[#d4d4d4] hover:bg-[#3a3a3a] disabled:opacity-50'
const PRIMARY = 'text-xs px-2 py-1 rounded bg-[#0e639c] text-white hover:bg-[#1177bb] disabled:opacity-50'

const TONE: Record<OutcomeView['tone'], string> = { good: 'text-[#7ee2a3]', warn: 'text-[#e5c07b]', bad: 'text-[#e06c75]' }

const STEP_WORDS: Record<SwitchProgress['step'], (agent: string, to: string) => string> = {
  exiting: (agent) => `Exiting ${agent}…`,
  confirming: (agent) => `Waiting for ${agent} to exit…`,
  carrying: (_agent, to) => `Copying the conversation to ${to}…`,
  typing: () => 'Typing the account line…',
  waiting: (agent, to) => `Waiting for ${agent} to start on ${to}…`,
}

type Phase =
  | { kind: 'pick' }
  | { kind: 'confirm'; target: AccountRowView; questions: string[] }
  | { kind: 'checking'; target: AccountRowView }
  | { kind: 'signed-out'; target: AccountRowView }
  | { kind: 'unknown-sign-in'; target: AccountRowView; why: string }
  | { kind: 'running'; target: AccountRowView; step: SwitchProgress['step'] | null }
  | { kind: 'result'; target: AccountRowView; view: OutcomeView }
  | { kind: 'error'; text: string }

export function AccountSwitcherDialog() {
  const open = useTerminalStore((s) => s.accountSwitch)
  const close = useTerminalStore((s) => s.closeAccountSwitch)
  const terminal = useTerminalStore((s) => s.terminals.find((t) => t.id === s.accountSwitch?.terminalId))
  const view = useTerminalStore((s) => s.accountsView)
  const byHand = useTerminalStore((s) => !!(s.accountSwitch && s.accountsByHand[s.accountSwitch.terminalId]))
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' })
  const [copied, setCopied] = useState(false)

  // Each time it opens: the accounts as main has them now, and the list.
  useEffect(() => {
    if (!open) return
    setPhase({ kind: 'pick' })
    setCopied(false)
    void refreshAccounts()
  }, [open])

  // A switch's steps, as main reports them.
  useEffect(() => {
    if (!open || !window.accounts?.onSwitchProgress) return undefined
    return window.accounts.onSwitchProgress((p) => {
      if (p.terminalId !== open.terminalId) return
      setPhase((ph) => (ph.kind === 'running' ? { ...ph, step: p.step } : ph))
    })
  }, [open])

  const running = phase.kind === 'running' || phase.kind === 'checking'
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !running) close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, running, close])

  if (!open) return null
  const agent = terminalAgent(terminal)
  const frame = (body: React.ReactNode) => (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" data-testid="account-switcher-overlay">
      <div role="dialog" aria-label="Switch account" data-testid="account-switcher" className="w-[520px] max-w-[92vw] max-h-[85vh] overflow-y-auto bg-[#1f1f1f] border border-[#3c3c3c] rounded-lg p-4 flex flex-col gap-3 text-xs text-[#d4d4d4]">
        {body}
        <div className="flex justify-end">
          <button type="button" className={BUTTON} onClick={close} disabled={running} data-testid="account-switcher-close">Close</button>
        </div>
      </div>
    </div>
  )

  if (!terminal || !agent || !view) {
    return frame(<p data-testid="account-switcher-none">Open an agent terminal Termpolis launched to switch its account.</p>)
  }
  const name = ACCOUNT_AGENT_LABEL[agent]
  const current = terminal.agentAccountId ? view.accounts.find((r) => r.id === terminal.agentAccountId) : undefined
  const targets = switchTargets(view, agent, byHand ? undefined : current?.id, Date.now())
  const header = (
    <div>
      <h2 className="text-sm font-semibold text-[#e0e0e0]">Switch account · {name}</h2>
      <p className="text-[#9ca3af]" data-testid="account-switcher-current">
        <em>{terminal.name}</em> runs on <strong>{byHand ? 'an account changed by hand' : current ? current.label : 'its default profile, probably'}</strong>
      </p>
    </div>
  )

  if (agent === 'agy') {
    return frame(<>
      {header}
      <p data-testid="account-switcher-agy">
        The Antigravity CLI keeps one Google sign-in for your whole computer user, in the OS keyring, so it has no separate profiles. To use another Google account, type /logout in agy and sign in again. Every agy terminal moves to that account.
      </p>
    </>)
  }

  const go = async (target: AccountRowView, answers: SwitchAnswers): Promise<void> => {
    const store = useTerminalStore.getState()
    if (!store.beginRelaunch(terminal.id, 'account')) {
      setPhase({ kind: 'error', text: `A model change or another switch is running in ${terminal.name}: wait for it to finish.` })
      return
    }
    setPhase({ kind: 'running', target, step: null })
    try {
      const outcome = await runSwitch(terminal, agent, target, answers, {
        accounts: window.accounts!,
        termpolis: window.termpolis,
        primerEnabled: isAutoPrimerEnabled,
      })
      const shown = outcomeView(outcome, agent, target)
      void refreshAccounts()
      if (shown.done && shown.tone !== 'bad') {
        useTerminalStore.getState().setMemoryNotice(shown.text)
        close()
        return
      }
      setPhase({ kind: 'result', target, view: shown })
    } finally {
      useTerminalStore.getState().endRelaunch(terminal.id)
    }
  }

  /** The checks, then the switch: the questions first, then whether the target is signed in. */
  const start = async (target: AccountRowView, asked: boolean): Promise<void> => {
    const questions = switchQuestions(agent, current, target)
    if (!asked && questions.length > 0) {
      setPhase({ kind: 'confirm', target, questions })
      return
    }
    setPhase({ kind: 'checking', target })
    const signIn = await checkSignIn(window.accounts!, target)
    if (signIn.kind === 'signed-out') return setPhase({ kind: 'signed-out', target })
    if (signIn.kind === 'unknown') return setPhase({ kind: 'unknown-sign-in', target, why: signIn.why })
    await go(target, {})
  }

  const newTerminal = async (target: AccountRowView): Promise<void> => {
    const r = await openOnAccount(terminal, target, {
      createTerminal: window.termpolis.createTerminal,
      addTerminal: useTerminalStore.getState().addTerminal,
      launch: (targets) => launchAgents(targets),
      newId: uuid,
    })
    if (r.ok) close()
    else setPhase({ kind: 'error', text: r.error })
  }

  const openSettings = (): void => {
    const store = useTerminalStore.getState()
    requestSettingsTab('accounts', store.showSettings)
    store.setShowSettings(true)
    close()
  }

  const row = (t: SwitchTarget) => (
    <div key={t.account.id} className="flex items-center gap-2 py-1 border-b border-[#2d2d2d]" data-testid="account-switcher-row">
      <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: t.account.color ?? AGENT_COLOR[agent] }} />
      <span className="font-medium">{t.account.label}</span>
      <span className="text-[#9ca3af] flex-1 truncate">
        {t.account.email ?? ''} · {t.blocked ?? t.state}
        {!t.account.autoOffer && ' · not offered automatically'}
        {isProfileAgent(agent) && !t.account.isDefault && !t.account.connect && ' · not connected: loses Termpolis\'s tools'}
      </span>
      {/* From an account not offered automatically (work), a fresh session is the first choice. */}
      {current && !current.autoOffer && (
        <button type="button" className={PRIMARY} disabled={!!t.blocked} onClick={() => { void newTerminal(t.account) }} data-testid="account-switcher-new">New terminal</button>
      )}
      <button type="button" className={current && !current.autoOffer ? BUTTON : PRIMARY} disabled={!!t.blocked} onClick={() => { void start(t.account, false) }} data-testid="account-switcher-switch">Switch here</button>
      {!(current && !current.autoOffer) && (
        <button type="button" className={BUTTON} disabled={!!t.blocked} onClick={() => { void newTerminal(t.account) }} data-testid="account-switcher-new">New terminal</button>
      )}
    </div>
  )

  let body: React.ReactNode
  switch (phase.kind) {
    case 'pick':
      body = targets.length === 0
        ? <p data-testid="account-switcher-empty">{name} has no other account. Add one in Settings ▸ Accounts. <button type="button" className="underline text-[#22D3EE]" onClick={openSettings}>Open Settings ▸ Accounts</button></p>
        : <div>{targets.map(row)}</div>
      break
    case 'confirm':
      body = (
        <div data-testid="account-switcher-confirm" className="flex flex-col gap-2">
          {phase.questions.map((q) => <p key={q}>{q}</p>)}
          <div className="flex gap-2">
            <button type="button" className={PRIMARY} onClick={() => { void start(phase.target, true) }} data-testid="account-switcher-confirm-yes">Switch to {phase.target.label}</button>
            <button type="button" className={BUTTON} onClick={() => setPhase({ kind: 'pick' })}>Back</button>
          </div>
        </div>
      )
      break
    case 'checking':
      body = <p data-testid="account-switcher-checking">Asking {name} whether {phase.target.label} is signed in…</p>
      break
    case 'signed-out':
      body = (
        <div data-testid="account-switcher-signed-out" className="flex flex-col gap-2">
          <p>{phase.target.label} is signed out: {name} would start on its sign-in screen there. Sign in to it first.</p>
          <div className="flex gap-2">
            <button type="button" className={PRIMARY} onClick={openSettings}>Sign in to {phase.target.label}…</button>
            <button type="button" className={BUTTON} onClick={() => setPhase({ kind: 'pick' })}>Back</button>
          </div>
        </div>
      )
      break
    case 'unknown-sign-in':
      body = (
        <div data-testid="account-switcher-unknown-sign-in" className="flex flex-col gap-2">
          <p>Termpolis couldn&apos;t tell whether {phase.target.label} is signed in: {phase.why}</p>
          <div className="flex gap-2">
            <button type="button" className={PRIMARY} onClick={() => { void go(phase.target, {}) }} data-testid="account-switcher-anyway">Switch anyway</button>
            <button type="button" className={BUTTON} onClick={() => setPhase({ kind: 'pick' })}>Back</button>
          </div>
        </div>
      )
      break
    case 'running':
      body = <p data-testid="account-switcher-running">Switching to {phase.target.label}… {phase.step ? STEP_WORDS[phase.step](name, phase.target.label) : ''}</p>
      break
    case 'result': {
      const v = phase.view
      body = (
        <div data-testid="account-switcher-result" className="flex flex-col gap-2">
          <p className={TONE[v.tone]}>{v.text}</p>
          <div className="flex gap-2 flex-wrap">
            {v.retry && <button type="button" className={PRIMARY} onClick={() => { void go(phase.target, v.retry!.answers) }} data-testid="account-switcher-retry">{v.retry.label}</button>}
            {v.line && (
              <button
                type="button"
                className={BUTTON}
                data-testid="account-switcher-copy"
                onClick={() => { void window.termpolis.clipboardWriteText(v.line!).then(() => setCopied(true)) }}
              >
                {copied ? 'Copied' : 'Copy the line'}
              </button>
            )}
            {!v.done && <button type="button" className={BUTTON} onClick={() => setPhase({ kind: 'pick' })}>Back</button>}
          </div>
        </div>
      )
      break
    }
    default:
      body = <p className="text-[#e06c75]" data-testid="account-switcher-error">{phase.text}</p>
  }

  return frame(<>
    {header}
    {body}
  </>)
}
