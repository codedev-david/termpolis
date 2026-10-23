// The usage-limit chooser (the in-app account UI, §2.6), as a card at the top of the stopped
// terminal's pane: "Claude Code is out of usage on personal until 4:00 pm." [Continue on codedev]
// runs the in-place switch (§2.2) in one click; [Other account ▾] lists the rest; [Not now] closes
// it. It never takes the focus or a key meant for the terminal. Terminals one limit stopped on one
// account are one chooser: each of their panes shows its own card, which acts on that terminal and
// says how many more ran out. The design's rules stand: only accounts
// offered automatically are a way out (D14), a work terminal's first choice is a fresh session
// there (R17), a model's limit offers that model's way out first (R15), and each way out is asked
// whether it is signed in now, at once and in parallel (§4.4, a minute's answer reused).
import { useEffect, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { ACCOUNT_AGENT_LABEL, isProfileAgent } from '../../../../shared/agentAccounts'
import type { AccountAgent, AccountRowView, AccountsView } from '../../../../shared/agentAccounts'
import { limitTargets, suggestedModel, untilText } from '../../../../shared/accountLimits'
import type { LimitTarget, TargetCheck } from '../../../../shared/accountLimits'
import { useTerminalStore } from '../../store/terminalStore'
import type { TerminalSession } from '../../types'
import { checkSignIn, openOtherAgent, terminalAgent } from '../../lib/accountSwitchFlow'
import type { LimitContext } from '../../lib/limitWatch'
import { AGENT_COMMAND, groupNote, limitOn, limitedAccount, noWayOut, otherAgents, recentCheck } from '../../lib/limitChooser'
import { newTerminalOn, startSwitch } from '../../lib/accountSwitchRun'
import { modelHoldBridge, relaunchHeld } from '../../lib/modelRelaunch'
import { launchAgents } from '../../lib/agentLaunch'
import { requestSettingsTab } from '../../lib/settingsNav'
import { SMALL_BUTTON, SMALL_PRIMARY } from './ui'

export function LimitCard({ terminalId }: { terminalId: string }) {
  // A store that holds no chooser (a pane's tests mock one) shows no card.
  const open = useTerminalStore((s) => s.accountSwitch ?? null)
  const terminal = useTerminalStore((s) => s.terminals.find((t) => t.id === terminalId))
  const view = useTerminalStore((s) => s.accountsView ?? null)
  const limit = open?.limit
  if (!limit || !limit.terminals.includes(terminalId) || !terminal || !view) return null
  const agent = terminalAgent(terminal)
  if (agent !== limit.agent) return null
  return <Card terminal={terminal} agent={agent} view={view} limit={limit} />
}

function Card({ terminal, agent, view, limit }: { terminal: TerminalSession; agent: AccountAgent; view: AccountsView; limit: LimitContext }) {
  const store = useTerminalStore.getState
  const byHand = useTerminalStore((s) => !!s.accountsByHand[terminal.id])
  const [checks, setChecks] = useState<Record<string, TargetCheck>>({})
  const [installed, setInstalled] = useState<Record<string, boolean> | null>(null)
  const [more, setMore] = useState(false)
  const [carry, setCarry] = useState<AccountRowView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const name = ACCOUNT_AGENT_LABEL[agent]
  const now = Date.now()
  const limited = limitedAccount(view, limit)
  const targets: LimitTarget[] = limitTargets(view.accounts, agent, { accountId: limit.accountId, email: limited.email }, now, checks)
  const ways = targets.filter((t) => t.state === 'available' || t.state === 'unknown')
  const current = terminal.agentAccountId ? view.accounts.find((r) => r.id === terminal.agentAccountId) : undefined
  // agy's own sheet asks the work account's question for every agy terminal it moves.
  const fromWork = isProfileAgent(agent) && !!current && !current.autoOffer
  const model = suggestedModel(agent, limit.kind)

  // Each way out asked, all at once, whether it is signed in now; and the agents installed here.
  useEffect(() => {
    let alive = true
    if (isProfileAgent(agent)) {
      for (const t of limitTargets(view.accounts, agent, { accountId: limit.accountId, email: limited.email }, Date.now())) {
        if (t.state !== 'available') continue
        const recent = recentCheck(t.row, Date.now())
        if (recent) setChecks((m) => ({ ...m, [t.row.id]: recent }))
        else void checkSignIn(window.accounts!, t.row).then((c) => { if (alive) setChecks((m) => ({ ...m, [t.row.id]: c })) })
      }
    }
    try {
      window.termpolis.detectAgents?.()?.then((res) => { if (alive && res?.success && res.data) setInstalled(res.data) })?.catch(() => undefined)
    } catch { /* none offered */ }
    return () => { alive = false }
    // Asked once for the stop, not at each view the accounts send.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit.words, terminal.id])

  /** This terminal's part of the prompt is over: on to its next terminal, if any. */
  const leave = (): void => store().leaveLimitChooser(terminal.id)

  const switchTo = (to: AccountRowView): void => {
    leave()
    if (agent === 'agy') return store().openAgySwitchSheet(to.id)
    const known = checks[to.id]
    void startSwitch(terminal.id, to.id, { reason: 'usage limit', ...(known?.kind === 'signed-in' ? { known } : {}) })
  }

  const go = (to: AccountRowView): void => {
    // Carrying a work conversation onto another account asks once more (R17).
    if (fromWork) return setCarry(to)
    switchTo(to)
  }

  const fresh = (to: AccountRowView): void => {
    leave()
    void newTerminalOn(terminal, to)
  }

  const signIn = (to: AccountRowView): void => {
    leave()
    store().openSignInSheet(to.id, () => { void startSwitch(terminal.id, to.id, { reason: 'usage limit', known: { kind: 'signed-in', email: null } }) })
  }

  const addAccount = (): void => {
    leave()
    requestSettingsTab('accounts', store().showSettings)
    store().setShowSettings(true)
  }

  const otherAgent = async (other: AccountAgent): Promise<void> => {
    const r = await openOtherAgent(terminal, AGENT_COMMAND[other], ACCOUNT_AGENT_LABEL[other], {
      createTerminal: window.termpolis.createTerminal,
      addTerminal: store().addTerminal,
      launch: (t) => launchAgents(t),
      newId: uuid,
    })
    if (r.ok) leave()
    else setError(r.error)
  }

  /** A model's limit (R15): the model Claude Code itself advises, resuming this terminal's session
   *  by its id. No account changes. */
  const toModel = async (alias: string, sessionId: string): Promise<void> => {
    const why = await relaunchHeld({
      terminalId: terminal.id, provider: 'claude', modelId: alias, catalog: null, sessionId,
      begin: () => store().beginRelaunch(terminal.id, 'model'),
      end: () => store().endRelaunch(terminal.id),
      main: modelHoldBridge(),
      write: window.termpolis.writeToTerminal,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    })
    if (why) return setError(`Termpolis didn't change the model: ${why}.`)
    leave()
  }

  const until = untilText(limit.resetsAt, now)
  const headline = `${name} is out of usage ${limitOn(view, limit, byHand)}${until ? ` ${until}` : ''}.`
  const first = ways[0]
  const others = targets.filter((t) => t.state !== 'this' && t !== first)
  const modelLabel = model ? model.charAt(0).toUpperCase() + model.slice(1) : ''
  const agents = otherAgents(installed, agent)
  const note = groupNote(limit, view)

  return (
    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 w-[min(560px,92%)]" data-testid="limit-card">
      <div role="status" className="bg-[#252526] border border-[#e5c07b]/60 rounded-lg shadow-xl px-3 py-2 flex flex-col gap-1.5 text-xs text-[#d4d4d4]">
        <div className="flex items-start gap-2">
          <i className="fa-solid fa-hourglass-half text-[#e5c07b] mt-0.5" aria-hidden="true"></i>
          <div className="flex-1 min-w-0">
            <p className="text-[#e0e0e0]" data-testid="limit-card-headline">{headline}</p>
            <p className="text-[11px] text-[#9ca3af] truncate" title={limit.words} data-testid="limit-card-words">&ldquo;{limit.words}&rdquo;</p>
            {note && <p className="text-[11px] text-[#9ca3af]" data-testid="limit-card-group">{note}</p>}
          </div>
        </div>
        {carry ? (
          <div className="flex flex-wrap items-center gap-2" data-testid="limit-card-carry">
            <span>This conversation is on {current!.label}, which isn&apos;t offered automatically. Carry it to {carry.label}?</span>
            <button type="button" className={SMALL_PRIMARY} onClick={() => fresh(carry)} data-testid="limit-card-carry-new">New terminal on {carry.label}</button>
            <button type="button" className={SMALL_BUTTON} onClick={() => switchTo(carry)} data-testid="limit-card-carry-yes">Carry it to {carry.label}</button>
            <button type="button" className={SMALL_BUTTON} onClick={() => setCarry(null)} data-testid="limit-card-carry-no">Cancel</button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {model && terminal.agentSessionId && (
              <button type="button" className={SMALL_PRIMARY} onClick={() => { void toModel(model, terminal.agentSessionId!) }} data-testid="limit-card-model">Switch this terminal to {modelLabel}</button>
            )}
            {first && (fromWork
              ? <button type="button" className={SMALL_PRIMARY} onClick={() => fresh(first.row)} data-testid="limit-card-new">New terminal on {first.row.label}</button>
              : <button type="button" className={model && terminal.agentSessionId ? SMALL_BUTTON : SMALL_PRIMARY} onClick={() => go(first.row)} data-testid="limit-card-continue">Continue on {first.row.label}</button>)}
            {first && fromWork && <button type="button" className={SMALL_BUTTON} onClick={() => go(first.row)} data-testid="limit-card-continue">Continue on {first.row.label}</button>}
            <button type="button" className={SMALL_BUTTON} aria-expanded={more} onClick={() => setMore(!more)} data-testid="limit-card-more">Other account <i className="fa-solid fa-caret-down" aria-hidden="true"></i></button>
            <button type="button" className={SMALL_BUTTON} onClick={leave} data-testid="limit-card-not-now">Not now</button>
          </div>
        )}
        {model && !terminal.agentSessionId && <p className="text-[11px] text-[#9ca3af]" data-testid="limit-card-model-advice">{name} ran out on this model only: pick {modelLabel} in this terminal&apos;s model picker to go on here.</p>}
        {!first && <p className="text-[11px] text-[#e5c07b]" data-testid="limit-card-none">{noWayOut(agent, targets, now)}</p>}
        {more && (
          <ul className="flex flex-col gap-1 border-t border-[#3c3c3c] pt-1.5" data-testid="limit-card-others">
            {others.map((t) => {
              const way = t.state === 'available' || t.state === 'unknown'
              return (
                <li key={t.row.id} className="flex items-center gap-2" data-state={t.state} data-testid="limit-card-other">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: t.row.color ?? '#6b7280' }} aria-hidden="true"></span>
                  <span className="text-[#e0e0e0]">{t.row.label}</span>
                  <span className="flex-1 text-[11px] text-[#9ca3af] truncate">{t.text}</span>
                  {way && <button type="button" className={SMALL_BUTTON} onClick={() => go(t.row)} data-testid="limit-card-switch">Switch</button>}
                  {t.state === 'signed-out' && <button type="button" className={SMALL_BUTTON} onClick={() => signIn(t.row)} data-testid="limit-card-sign-in">Sign in and switch</button>}
                  {way && agent !== 'agy' && <button type="button" className={SMALL_BUTTON} onClick={() => fresh(t.row)} data-testid="limit-card-fresh">New terminal</button>}
                </li>
              )
            })}
            {first && agent !== 'agy' && (
              <li><button type="button" className={SMALL_BUTTON} onClick={() => fresh(first.row)} data-testid="limit-card-fresh-first">New terminal on {first.row.label}, beside this one</button></li>
            )}
            <li className="flex flex-wrap gap-2 pt-1">
              <button type="button" className={SMALL_BUTTON} onClick={addAccount} data-testid="limit-card-add">Add an account</button>
              {agents.map((o) => (
                <button key={o} type="button" className={SMALL_BUTTON} onClick={() => { void otherAgent(o) }} data-testid={`limit-card-other-${o}`}>Use {ACCOUNT_AGENT_LABEL[o]} here instead</button>
              ))}
            </li>
          </ul>
        )}
        {error && <p className="text-[11px] text-[#e06c75]" role="alert" data-testid="limit-card-error">{error}</p>}
      </div>
    </div>
  )
}
