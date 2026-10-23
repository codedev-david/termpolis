// The account switch dialog (§7.1, D12): an in-app dialog for one agent terminal, opened from its
// chip, Ctrl+Shift+N, the command palette, the terminal's context menu or Settings ▸ Accounts. It
// lists the other accounts of the terminal's agent with [Switch here] (the conversation moves, in
// place) and [New terminal] (a fresh session beside it), asks what a switch must ask first, and
// says how it went. Main does the switching (accounts:switch); this never types into a terminal.
//
// Opened for a usage limit (the chooser, §8.4: the store's accountSwitch.limit), it says what ran
// out, on which sign-in (R23), in the CLI's own words, and lists the accounts that are a way out
// (limitTargets: never one not offered automatically, D14), each asked whether it is signed in now;
// a model's limit offers that model's way out first (R15). [Wait for the reset], Esc and Close end
// the prompt for that terminal's stop only, and the dialog goes on to the next terminal the same
// limit stopped, one at a time.
import { useEffect, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { ACCOUNT_AGENT_LABEL, isProfileAgent } from '../../../../shared/agentAccounts'
import type { AccountAgent, AccountRowView } from '../../../../shared/agentAccounts'
import { limitTargets, suggestedModel } from '../../../../shared/accountLimits'
import type { LimitTarget, TargetCheck } from '../../../../shared/accountLimits'
import type { SignInCheck, SwitchAnswers, SwitchTarget, OutcomeView } from '../../lib/accountSwitchFlow'
import {
  checkSignIn, openOnAccount, openOtherAgent, outcomeView, runSwitch, switchQuestions, switchTargets, terminalAgent,
} from '../../lib/accountSwitchFlow'
import type { SwitchProgress } from '../../../../shared/accountSwitch'
import { AGENT_COMMAND, groupNote, limitOn, limitedAccount, noWayOut, otherAgents, recentCheck } from '../../lib/limitChooser'
import type { LimitContext } from '../../lib/limitWatch'
import { modelHoldBridge, relaunchHeld } from '../../lib/modelRelaunch'
import { AGENT_COLOR } from '../../lib/accountsView'
import { launchAgents } from '../../lib/agentLaunch'
import { refreshAccounts } from '../../lib/accountsState'
import { requestSettingsTab } from '../../lib/settingsNav'
import { isAutoPrimerEnabled } from '../../hooks/useAutoPrimer'
import { useTerminalStore } from '../../store/terminalStore'
import { AgySwitchFlow } from './AgySwitchFlow'

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
  | { kind: 'confirm'; target: AccountRowView; questions: string[]; known?: SignInCheck }
  | { kind: 'model'; alias: string }
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
  /** Limit mode: what each account's agent said when asked whether it is signed in now. */
  const [checks, setChecks] = useState<Record<string, TargetCheck>>({})
  /** Limit mode: the agents installed here, for "Use another agent". */
  const [installed, setInstalled] = useState<Record<string, boolean> | null>(null)
  // Which terminal it is open for, and how: another terminal the same limit stopped joining the
  // dialog changes neither, so a switch under way is never reset.
  const openFor = open?.terminalId
  const limitMode = !!open?.limit

  // Each time it opens: the accounts as main has them now, and the list. When it closes while agy's
  // switch waits for a sign-in, the pollers may answer in that terminal again.
  useEffect(() => {
    if (!openFor) return undefined
    setPhase({ kind: 'pick' })
    setCopied(false)
    setChecks({})
    void refreshAccounts()
    return () => {
      const store = useTerminalStore.getState()
      if (store.relaunching[openFor] === 'sign-in') store.endRelaunch(openFor)
    }
  }, [openFor, limitMode])

  // A switch's steps, as main reports them.
  useEffect(() => {
    if (!openFor || !window.accounts?.onSwitchProgress) return undefined
    return window.accounts.onSwitchProgress((p) => {
      if (p.terminalId !== openFor) return
      setPhase((ph) => (ph.kind === 'running' ? { ...ph, step: p.step } : ph))
    })
  }, [openFor])

  const agent = terminalAgent(terminal)
  const limit: LimitContext | undefined = open?.limit && agent === open.limit.agent ? open.limit : undefined
  /** Ends the dialog: in limit mode, the prompt for this terminal's stop only, and on to the next
   *  terminal the same limit stopped; for agy, whose one sign-in is every agy terminal's, the whole
   *  prompt. */
  const leave = (): void => {
    const store = useTerminalStore.getState()
    if (open?.limit && open.limit.agent !== 'agy') store.leaveLimitChooser(open.terminalId)
    else close()
  }

  // A limit's terminal that closed, or runs another agent now: on to the next one.
  useEffect(() => {
    if (open?.limit && !limit) useTerminalStore.getState().leaveLimitChooser(open.terminalId)
  }, [open, limit])

  // Limit mode: each account offered asked, all at once, whether it is signed in now (§4.4: a
  // signed-out one would relaunch into its sign-in), and the agents installed here.
  const limitAgent = limit?.agent
  useEffect(() => {
    if (!openFor || !limitAgent || !view || !isProfileAgent(limitAgent)) return undefined
    let alive = true
    // Only the accounts that are a way out by what Termpolis knows already: a check is a child
    // process, and never runs for nothing (§4.4).
    const lim = open!.limit!
    const now = Date.now()
    for (const t of limitTargets(view.accounts, limitAgent, { accountId: lim.accountId, email: limitedAccount(view, lim).email }, now)) {
      if (t.state !== 'available') continue
      // An answer younger than a minute stands (§3.4): no process for it.
      const recent = recentCheck(t.row, now)
      if (recent) setChecks((m) => ({ ...m, [t.row.id]: recent }))
      else void checkSignIn(window.accounts!, t.row).then((c) => { if (alive) setChecks((m) => ({ ...m, [t.row.id]: c })) })
    }
    try {
      window.termpolis.detectAgents?.()
        ?.then((res) => { if (alive && res?.success && res.data) setInstalled(res.data) })
        ?.catch(() => { /* none offered */ })
    } catch { /* none offered */ }
    return () => { alive = false }
    // Asked once each time it opens for a terminal, not at each view the accounts send.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFor, limitAgent])

  const running = phase.kind === 'running' || phase.kind === 'checking' || phase.kind === 'model'
  useEffect(() => {
    if (!openFor) return undefined
    // Not while a switch types, and not while the user signs in to agy: their Esc is agy's then.
    // Taken before the terminal under the dialog sees it, which keeps the focus: an Esc that also
    // reached the agent would answer its rate-limit menu, which only the user's own choice may.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || running || useTerminalStore.getState().relaunching[openFor]) return
      e.preventDefault()
      e.stopPropagation()
      leave()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  if (!open) return null
  const frame = (body: React.ReactNode, closable = !running) => (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" data-testid="account-switcher-overlay">
      <div role="dialog" aria-label="Switch account" data-testid="account-switcher" className="w-[520px] max-w-[92vw] max-h-[85vh] overflow-y-auto bg-[#1f1f1f] border border-[#3c3c3c] rounded-lg p-4 flex flex-col gap-3 text-xs text-[#d4d4d4]">
        {body}
        <div className="flex justify-end">
          <button type="button" className={BUTTON} onClick={leave} disabled={!closable} data-testid="account-switcher-close">Close</button>
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
  const now = Date.now()
  const limited = limit ? limitedAccount(view, limit) : null
  const offered: LimitTarget[] = limit ? limitTargets(view.accounts, agent, { accountId: limit.accountId, email: limited!.email }, now, checks) : []
  const header = limit ? (
    <div data-testid="limit-header">
      <h2 className="text-sm font-semibold text-[#e0e0e0]">{name} ran out of usage</h2>
      <p className="text-[#9ca3af]">
        <em>{terminal.name}</em> {limitOn(view, limit, byHand)} · <span data-testid="limit-words">&ldquo;{limit.words}&rdquo;</span>
      </p>
    </div>
  ) : (
    <div>
      <h2 className="text-sm font-semibold text-[#e0e0e0]">Switch account · {name}</h2>
      <p className="text-[#9ca3af]" data-testid="account-switcher-current">
        <em>{terminal.name}</em> runs on <strong>{byHand ? 'an account changed by hand' : current ? current.label : 'its default profile, probably'}</strong>
      </p>
    </div>
  )

  if (agent === 'agy') {
    // At a limit: the agy accounts that are a way out, by the email each was given.
    const rows = limit ? offered.filter((t) => t.state === 'available').map((t) => t.row) : targets.map((t) => t.account)
    return <AgySwitchFlow terminal={terminal} rows={rows} header={header} close={close} frame={frame} />
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
      }, limit ? 'usage limit' : 'by hand')
      const shown = outcomeView(outcome, agent, target)
      void refreshAccounts()
      if (shown.done && shown.tone !== 'bad') {
        useTerminalStore.getState().setMemoryNotice(shown.text)
        leave()
        return
      }
      setPhase({ kind: 'result', target, view: shown })
    } finally {
      useTerminalStore.getState().endRelaunch(terminal.id)
    }
  }

  /** The checks, then the switch: the questions first, then whether the target is signed in, unless
   *  the chooser just asked (`known`). */
  const start = async (target: AccountRowView, asked: boolean, known?: SignInCheck): Promise<void> => {
    const questions = switchQuestions(agent, current, target)
    if (!asked && questions.length > 0) {
      setPhase({ kind: 'confirm', target, questions, ...(known ? { known } : {}) })
      return
    }
    let signIn = known
    if (!signIn) {
      setPhase({ kind: 'checking', target })
      signIn = await checkSignIn(window.accounts!, target)
    }
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
    if (r.ok) leave()
    else setPhase({ kind: 'error', text: r.error })
  }

  /** "Use another agent": it opens beside this terminal, in the same folder; this one waits. */
  const otherAgent = async (other: AccountAgent): Promise<void> => {
    const r = await openOtherAgent(terminal, AGENT_COMMAND[other], ACCOUNT_AGENT_LABEL[other], {
      createTerminal: window.termpolis.createTerminal,
      addTerminal: useTerminalStore.getState().addTerminal,
      launch: (targets) => launchAgents(targets),
      newId: uuid,
    })
    if (r.ok) leave()
    else setPhase({ kind: 'error', text: r.error })
  }

  /** A model's limit (R15): the model Claude Code itself advises, through the model picker's
   *  relaunch, resuming this terminal's own session by its id. No account changes. */
  const toModel = async (alias: string, sessionId: string): Promise<void> => {
    setPhase({ kind: 'model', alias })
    const why = await relaunchHeld({
      terminalId: terminal.id,
      provider: 'claude',
      modelId: alias,
      catalog: null,
      sessionId,
      begin: () => useTerminalStore.getState().beginRelaunch(terminal.id, 'model'),
      end: () => useTerminalStore.getState().endRelaunch(terminal.id),
      main: modelHoldBridge(),
      write: window.termpolis.writeToTerminal,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    })
    if (why) return setPhase({ kind: 'error', text: `Termpolis didn't change the model: ${why}.` })
    useTerminalStore.getState().setMemoryNotice(`Moving ${terminal.name} to ${alias}: the conversation continues there.`)
    leave()
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

  /** A row of the limit list (§8.4): a way out gets the switch's buttons, the rest say why not. */
  const limitRow = (t: LimitTarget) => {
    const way = t.state === 'available' || t.state === 'unknown'
    const known = checks[t.row.id]
    const asking = way && t.state === 'available' && !known
    const fromWork = !!current && !current.autoOffer
    return (
      <div key={t.row.id} className="flex items-center gap-2 py-1 border-b border-[#2d2d2d]" data-testid="limit-row" data-state={t.state}>
        <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: t.row.color ?? AGENT_COLOR[agent] }} />
        <span className="font-medium">{t.row.label}</span>
        <span className="text-[#9ca3af] flex-1 truncate">
          {t.state === 'this' ? `this terminal's account · ${limit!.words}` : t.text}
          {asking && ' · checking…'}
          {way && !t.row.isDefault && !t.row.connect && ' · not connected: loses Termpolis\'s tools'}
        </span>
        {way && fromWork && <button type="button" className={PRIMARY} onClick={() => { void newTerminal(t.row) }} data-testid="limit-new">New terminal</button>}
        {way && <button type="button" className={fromWork ? BUTTON : PRIMARY} onClick={() => { void start(t.row, false, known?.kind === 'signed-in' ? known : undefined) }} data-testid="limit-switch">Switch here</button>}
        {way && !fromWork && <button type="button" className={BUTTON} onClick={() => { void newTerminal(t.row) }} data-testid="limit-new">New terminal</button>}
        {t.state === 'signed-out' && <button type="button" className={BUTTON} onClick={openSettings} data-testid="limit-sign-in">Sign in…</button>}
      </div>
    )
  }

  const limitPick = (lim: LimitContext) => {
    const model = suggestedModel(agent, lim.kind)
    const modelLabel = model ? model.charAt(0).toUpperCase() + model.slice(1) : ''
    const ways = offered.filter((t) => t.state === 'available' || t.state === 'unknown')
    const group = groupNote(lim, view)
    const others = otherAgents(installed, agent)
    return (
      <div className="flex flex-col gap-2">
        {model && (terminal.agentSessionId ? (
          <div className="flex items-center gap-2" data-testid="limit-model-row">
            <span className="flex-1">{name} ran out on this model only.</span>
            <button type="button" className={PRIMARY} onClick={() => { void toModel(model, terminal.agentSessionId!) }} data-testid="limit-model">Switch this terminal to {modelLabel}</button>
          </div>
        ) : (
          <p data-testid="limit-model-advice">{name} ran out on this model only: pick {modelLabel} in this terminal&apos;s model picker to go on here.</p>
        ))}
        <div>{offered.map(limitRow)}</div>
        {ways.length === 0 && <p data-testid="limit-none">{noWayOut(agent, offered, now)}</p>}
        {group && <p className="text-[#9ca3af]" data-testid="limit-group">{group}</p>}
        <div className="flex gap-2 flex-wrap">
          <button type="button" className={BUTTON} onClick={leave} data-testid="limit-wait">Wait for the reset</button>
          <button type="button" className={BUTTON} onClick={openSettings} data-testid="limit-add">Add an account</button>
          {others.map((o) => (
            <button key={o} type="button" className={BUTTON} onClick={() => { void otherAgent(o) }} data-testid={`limit-other-${o}`}>Use {ACCOUNT_AGENT_LABEL[o]} here instead</button>
          ))}
        </div>
      </div>
    )
  }

  let body: React.ReactNode
  switch (phase.kind) {
    case 'pick':
      body = limit ? limitPick(limit) : targets.length === 0
        ? <p data-testid="account-switcher-empty">{name} has no other account. Add one in Settings ▸ Accounts. <button type="button" className="underline text-[#22D3EE]" onClick={openSettings}>Open Settings ▸ Accounts</button></p>
        : <div>{targets.map(row)}</div>
      break
    case 'confirm':
      body = (
        <div data-testid="account-switcher-confirm" className="flex flex-col gap-2">
          {phase.questions.map((q) => <p key={q}>{q}</p>)}
          <div className="flex gap-2">
            <button type="button" className={PRIMARY} onClick={() => { void start(phase.target, true, phase.known) }} data-testid="account-switcher-confirm-yes">Switch to {phase.target.label}</button>
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
    case 'model':
      body = <p data-testid="limit-model-running">Moving {terminal.name} to {phase.alias}…</p>
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
