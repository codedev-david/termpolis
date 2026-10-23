// agy's guided switch, in the account switch dialog (scope for v1.55.0). agy keeps one Google
// sign-in for the computer user, so a switch signs every agy on this computer out, and into the
// account the user signs in with, in the terminal: Termpolis never answers that sign-in. Main runs
// each step (accounts:agy-switch, agySwitch.ts); this asks first, says what to do at each step,
// follows the sign-in from main's looks, and resumes the conversation by its id once it is done.
// While the user signs in, the dialog stands aside: a card, not a modal, so the terminal takes
// their keys.
import { useEffect, useRef, useState } from 'react'
import type { AccountRowView } from '../../../../shared/agentAccounts'
import type { AgyStepOutcome, AgyStepRequest } from '../../../../shared/accountSwitch'
import type { TerminalSession } from '../../types'
import { useTerminalStore } from '../../store/terminalStore'
import { AGENT_COLOR } from '../../lib/accountsView'
import { refreshAccounts } from '../../lib/accountsState'

const BUTTON = 'text-xs px-2 py-1 rounded bg-[#2d2d2d] text-[#d4d4d4] hover:bg-[#3a3a3a] disabled:opacity-50'
const PRIMARY = 'text-xs px-2 py-1 rounded bg-[#0e639c] text-white hover:bg-[#1177bb] disabled:opacity-50'

/** How often the dialog looks whether the user finished signing in. */
export const SIGN_IN_POLL_MS = 2000

type Phase =
  | { kind: 'pick' }
  | { kind: 'confirm'; target: AccountRowView }
  | { kind: 'running'; target: AccountRowView; words: string }
  | { kind: 'signing-in'; target: AccountRowView; conversationId: string | null; mark: number }
  | { kind: 'needs-login'; target: AccountRowView; conversationId: string | null; mark: number }
  | { kind: 'unknown-exit'; target: AccountRowView }
  | { kind: 'diy'; target: AccountRowView; say: string; line?: string }
  | { kind: 'error'; text: string }

interface Props {
  terminal: TerminalSession
  rows: AccountRowView[]
  header: React.ReactNode
  close: () => void
  /** The dialog's modal frame, for every phase but the sign-in's. */
  frame: (body: React.ReactNode, closable: boolean) => React.ReactElement
}

export function AgySwitchFlow({ terminal, rows, header, close, frame }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' })
  const [copied, setCopied] = useState(false)
  const api = window.accounts!
  const busy = useRef(false)

  /** One step in main, holding the terminal's relaunch lock while it types. */
  const call = async (target: AccountRowView, step: AgyStepRequest['step'], extra: Partial<AgyStepRequest> = {}): Promise<AgyStepOutcome> => {
    const req: AgyStepRequest = { terminalId: terminal.id, targetId: target.id, shellType: terminal.shellType, step, ...extra }
    try {
      const res = await api.agySwitch(req)
      return res.success ? res.data : { kind: 'refused', why: res.error }
    } catch (e) {
      return { kind: 'refused', why: e instanceof Error ? e.message : String(e) }
    }
  }

  /** A typing step: the pane takes no keys and the pollers answer nothing while it runs. */
  const typing = async (target: AccountRowView, words: string, run: () => Promise<AgyStepOutcome>): Promise<AgyStepOutcome | null> => {
    const store = useTerminalStore.getState()
    // Our own hold for the user's sign-in gives way to the step; another relaunch's never does.
    if (store.relaunching[terminal.id] === 'sign-in') store.endRelaunch(terminal.id)
    if (!store.beginRelaunch(terminal.id, 'account')) {
      setPhase({ kind: 'error', text: `A model change or another switch is running in ${terminal.name}: wait for it to finish.` })
      return null
    }
    setPhase({ kind: 'running', target, words })
    try {
      return await run()
    } finally {
      useTerminalStore.getState().endRelaunch(terminal.id)
    }
  }

  /** What a step's outcome leads to. While the user signs in, the terminal is theirs: the pollers
   *  still answer nothing there (the sign-in decides an account). */
  const show = (target: AccountRowView, o: AgyStepOutcome): void => {
    if (o.kind === 'signing-in' || o.kind === 'needs-login') {
      useTerminalStore.getState().beginRelaunch(terminal.id, 'sign-in')
      setPhase({ kind: o.kind, target, conversationId: o.conversationId, mark: o.mark })
      return
    }
    if (o.kind === 'switched') {
      const parts = [o.fresh
        ? `agy is on ${target.label} now, with a new conversation: it couldn't find this one.`
        : `agy is on ${target.label} now, and this conversation continues. Every agy terminal on this computer moved with it.`]
      if (o.shownEmail) parts.push(`agy shows ${o.shownEmail}${target.email && o.shownEmail.toLowerCase() !== target.email.toLowerCase() ? `, not ${target.email}` : ''}.`)
      useTerminalStore.getState().setMemoryNotice(parts.join(' '))
      void refreshAccounts()
      close()
      return
    }
    if (o.kind === 'unknown-exit') return setPhase({ kind: 'unknown-exit', target })
    if (o.kind === 'do-it-yourself') return setPhase({ kind: 'diy', target, say: o.say, ...(o.line ? { line: o.line } : {}) })
    setPhase({ kind: 'error', text: o.kind === 'refused' ? `Termpolis didn't switch agy: ${o.why}.` : 'agy is still at its sign-in.' })
  }

  const signOut = async (target: AccountRowView, assumeExited = false): Promise<void> => {
    const o = await typing(target, 'Exiting agy and signing it out…', () => call(target, 'sign-out', assumeExited ? { assumeExited } : {}))
    if (o) show(target, o)
  }

  const resume = async (target: AccountRowView, conversationId: string | null): Promise<void> => {
    const o = await typing(target, 'Resuming the conversation…', () => call(target, 'resume', { conversationId }))
    if (o) show(target, o)
  }

  // While the user signs in: a look every SIGN_IN_POLL_MS, and the resume once agy's box is back.
  useEffect(() => {
    if (phase.kind !== 'signing-in') return undefined
    const { target, conversationId, mark } = phase
    const timer = setInterval(() => {
      if (busy.current) return
      busy.current = true
      void call(target, 'check', { mark }).then((o) => {
        busy.current = false
        if (o.kind === 'signed-in') {
          clearInterval(timer)
          void resume(target, conversationId)
        }
      })
    }, SIGN_IN_POLL_MS)
    return () => clearInterval(timer)
    // The phase object is the dependency: a new sign-in phase starts a new watch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  const cancel = (): void => {
    useTerminalStore.getState().endRelaunch(terminal.id)
    close()
  }

  // The sign-in is the user's, in the terminal: a card beside it, not a modal over it.
  if (phase.kind === 'signing-in' || phase.kind === 'needs-login') {
    const p = phase
    return (
      <div className="fixed bottom-4 right-4 z-50 w-[420px] max-w-[92vw] bg-[#1f1f1f] border border-[#3c3c3c] rounded-lg p-3 flex flex-col gap-2 text-xs text-[#d4d4d4]" data-testid="agy-sign-in-card">
        {p.kind === 'signing-in' ? (
          <p data-testid="agy-signing-in">
            Sign in{p.target.email ? ` as ${p.target.email}` : ''} in the agy terminal: pick your sign-in there and finish it in the browser. Termpolis doesn&apos;t answer it. Once agy shows its input again, Termpolis resumes this conversation.
          </p>
        ) : (
          <p data-testid="agy-needs-login">agy signed out, but didn&apos;t open its sign-in. Type /login in agy and sign in there.</p>
        )}
        <div className="flex gap-2 flex-wrap">
          {p.kind === 'needs-login' && (
            <button type="button" className={PRIMARY} data-testid="agy-type-login" onClick={() => {
              void typing(p.target, 'Typing /login…', () => call(p.target, 'login', { conversationId: p.conversationId, mark: p.mark })).then((o) => { if (o) show(p.target, o) })
            }}>Type /login for me</button>
          )}
          <button type="button" className={BUTTON} data-testid="agy-resume-now" onClick={() => { void resume(p.target, p.conversationId) }}>I&apos;ve signed in: resume now</button>
          <button type="button" className={BUTTON} data-testid="agy-cancel" onClick={cancel}>Cancel</button>
        </div>
      </div>
    )
  }

  let body: React.ReactNode
  switch (phase.kind) {
    case 'pick':
      body = rows.length === 0
        ? <p data-testid="account-switcher-empty">agy has no other account here. Add one in Settings ▸ Accounts: a name and its Google email.</p>
        : rows.map((r) => (
          <div key={r.id} className="flex items-center gap-2 py-1 border-b border-[#2d2d2d]" data-testid="account-switcher-row">
            <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: r.color ?? AGENT_COLOR.agy }} />
            <span className="font-medium">{r.label}</span>
            <span className="text-[#9ca3af] flex-1 truncate">{r.email ?? 'no email given'}</span>
            <button type="button" className={PRIMARY} onClick={() => setPhase({ kind: 'confirm', target: r })} data-testid="account-switcher-switch">Switch here…</button>
          </div>
        ))
      break
    case 'confirm':
      body = (
        <div className="flex flex-col gap-2" data-testid="agy-confirm">
          <p>
            agy keeps one Google sign-in for everyone on this computer user. Switching signs agy out here, and every agy terminal on this computer moves to the account you sign in with{phase.target.email ? ` (${phase.target.email})` : ''}. You sign in yourself, in this terminal; Termpolis then resumes this conversation.
          </p>
          <div className="flex gap-2">
            <button type="button" className={PRIMARY} onClick={() => { void signOut(phase.target) }} data-testid="agy-confirm-yes">Switch agy to {phase.target.label}</button>
            <button type="button" className={BUTTON} onClick={() => setPhase({ kind: 'pick' })}>Back</button>
          </div>
        </div>
      )
      break
    case 'running':
      body = <p data-testid="account-switcher-running">{phase.words}</p>
      break
    case 'unknown-exit':
      body = (
        <div className="flex flex-col gap-2" data-testid="agy-unknown-exit">
          <p>Termpolis can&apos;t tell whether agy still runs here, so it typed nothing. Has agy exited?</p>
          <div className="flex gap-2">
            <button type="button" className={PRIMARY} onClick={() => { void signOut(phase.target, true) }} data-testid="agy-exited">It has exited, go on</button>
            <button type="button" className={BUTTON} onClick={() => setPhase({ kind: 'pick' })}>Back</button>
          </div>
        </div>
      )
      break
    case 'diy':
      body = (
        <div className="flex flex-col gap-2" data-testid="agy-diy">
          <p className="text-[#e5c07b]">{phase.say}</p>
          {phase.line && (
            <div className="flex gap-2 items-center">
              <code className="bg-[#2d2d2d] px-1 rounded">{phase.line}</code>
              <button type="button" className={BUTTON} data-testid="agy-copy" onClick={() => { void window.termpolis.clipboardWriteText(phase.line!).then(() => setCopied(true)) }}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
          )}
        </div>
      )
      break
    default:
      body = <p className="text-[#e06c75]" data-testid="account-switcher-error">{phase.text}</p>
  }
  return frame(<>{header}{body}</>, phase.kind !== 'running')
}
