// agy's switch-all, in a sheet (the in-app account UI, §2.4). Gemini CLI (agy) keeps one Google
// sign-in for the whole computer, so picking another agy account moves every agy terminal: after
// the user's confirmation, each one is exited by the switch's rules (R2: its own /exit, a turn at
// work waited for), the sign-in moves in main's hidden agy (signInSession.ts: agy's own /logout and
// /login, agy's choices as buttons here), and each terminal resumes its conversation by its id.
// Nothing is typed into a terminal for the sign-in, and the user is never handed a command. Onto
// or off an account not offered automatically (work), a second confirmation first (D14).
import { useEffect, useRef, useState } from 'react'
import type { AccountRowView } from '../../../../shared/agentAccounts'
import type { AgyStepOutcome } from '../../../../shared/accountSwitch'
import { useTerminalStore } from '../../store/terminalStore'
import type { TerminalSession } from '../../types'
import { agyTerminals, agyWorkQuestion, whyOf } from '../../lib/agySwitchAll'
import { refreshAccounts } from '../../lib/accountsState'
import { Sheet } from './Sheet'
import { SignInFlow } from './SignInFlow'
import { SHEET_PRIMARY, SHEET_SECONDARY, SPINNER } from './ui'

/** What the live region says at each phase (the sign-in's own steps are SignInFlow's). */
const ANNOUNCE: Readonly<Record<string, string>> = {
  confirm: '', 'confirm-work': '', exiting: 'Ending agy in the Gemini terminals.', ask: 'Termpolis can\'t tell whether agy still runs in a terminal.',
  stopped: 'The switch stopped before signing agy out.', 'signing-in': '', interrupted: 'The sign-in didn\'t finish.',
  resuming: 'Resuming the conversations.', done: 'Gemini CLI switched.',
}

/** How often a busy agy terminal is looked at again, while the switch waits for its turn. */
export const AGY_WAIT_MS = 2000

type Mark = 'waiting' | 'working' | 'exited' | 'resumed' | 'fresh' | 'failed'
interface Line {
  terminal: TerminalSession
  mark: Mark | null
  conversationId?: string | null
  why?: string
  /** agy was at work there when the sheet opened: the switch waits for its turn to end. */
  busy?: boolean
}

type Phase =
  | { kind: 'confirm' }
  | { kind: 'confirm-work'; question: string; yes: string }
  | { kind: 'exiting' }
  | { kind: 'ask'; terminalId: string }
  | { kind: 'stopped'; why: string }
  | { kind: 'signing-in' }
  | { kind: 'interrupted' }
  | { kind: 'resuming' }
  | { kind: 'done'; email: string | null }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function AgySwitchSheet() {
  const open = useTerminalStore((s) => s.agySwitchSheet)
  const view = useTerminalStore((s) => s.accountsView)
  if (!open) return null
  const target = view?.accounts.find((r) => r.id === open.targetId)
  const close = (): void => useTerminalStore.getState().closeAgySwitchSheet()
  if (!view || !target) {
    return (
      <Sheet title="Switch Gemini CLI" icon="fa-user-group" onClose={close} testId="agy-switch">
        <p data-testid="agy-switch-gone">That account isn&apos;t registered any more.</p>
        <div><button type="button" className={SHEET_SECONDARY} onClick={close}>Close</button></div>
      </Sheet>
    )
  }
  return <SwitchAll key={target.id} target={target} close={close} />
}

function SwitchAll({ target, close }: { target: AccountRowView; close: () => void }) {
  const view = useTerminalStore((s) => s.accountsView)!
  const [lines, setLines] = useState<Line[]>(() => agyTerminals(useTerminalStore.getState().terminals).map((terminal) => ({ terminal, mark: null })))
  const [phase, setPhase] = useState<Phase>({ kind: 'confirm' })
  /** The user stopped the switch: the next look, between two terminals' steps, stops it. */
  const stopped = useRef(false)
  const [stopping, setStopping] = useState(false)
  const answer = useRef<((exited: boolean) => void) | null>(null)
  const who = target.email ?? target.label
  const n = lines.length

  const mark = (id: string, m: Partial<Line>): void => setLines((ls) => ls.map((l) => (l.terminal.id === id ? { ...l, ...m } : l)))

  // Which of them is at work now, so the confirmation can say it waits for those.
  useEffect(() => {
    let alive = true
    for (const l of lines) {
      void window.accounts?.limitLook(l.terminal.id)
        .then((r) => { if (alive && r.success && r.data.live && r.data.status.status === 'working') mark(l.terminal.id, { busy: true }) })
        .catch(() => undefined)
    }
    return () => { alive = false }
    // Once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** The accounts the agy terminals run on now. */
  const onNow = (): AccountRowView[] => lines.flatMap((l) => view.accounts.filter((r) => r.id === l.terminal.agentAccountId))

  const go = (): void => {
    const q = agyWorkQuestion(target, onNow(), n)
    if (q) return setPhase({ kind: 'confirm-work', ...q })
    void exitAll()
  }

  /** One step of one terminal, in main, holding it while it types. */
  const step = async (t: TerminalSession, kind: 'exit' | 'resume', extra: { conversationId?: string | null; assumeExited?: boolean } = {}): Promise<AgyStepOutcome> => {
    const store = useTerminalStore.getState()
    if (!store.beginRelaunch(t.id, 'account')) return { kind: 'refused', why: 'a model change or another switch is running there' }
    try {
      const r = await window.accounts!.agySwitch({ terminalId: t.id, targetId: target.id, shellType: t.shellType, step: kind, ...extra })
      return r.success ? r.data : { kind: 'refused', why: r.error }
    } catch (e) {
      return { kind: 'refused', why: e instanceof Error ? e.message : String(e) }
    } finally {
      useTerminalStore.getState().endRelaunch(t.id)
    }
  }

  /** Resumes every terminal the switch exited, on the sign-in agy has now. */
  const resumeAll = async (done: Line[]): Promise<void> => {
    setPhase({ kind: 'resuming' })
    for (const l of done) {
      mark(l.terminal.id, { mark: 'working' })
      const r = await step(l.terminal, 'resume', { conversationId: l.conversationId ?? null })
      if (r.kind === 'resumed') mark(l.terminal.id, { mark: r.fresh ? 'fresh' : 'resumed' })
      else mark(l.terminal.id, { mark: 'failed', why: whyOf(r) })
    }
    void refreshAccounts()
  }

  const exitAll = async (): Promise<void> => {
    setPhase({ kind: 'exiting' })
    const done: Line[] = []
    for (const l of lines) {
      let assume = false
      for (;;) {
        if (stopped.current) return finishStopped(done, 'you asked it to.')
        mark(l.terminal.id, { mark: 'working' })
        const r = await step(l.terminal, 'exit', assume ? { assumeExited: true } : {})
        if (r.kind === 'exited') {
          mark(l.terminal.id, { mark: 'exited', conversationId: r.conversationId })
          done.push({ ...l, conversationId: r.conversationId })
          break
        }
        if (r.kind === 'busy') {
          mark(l.terminal.id, { mark: 'waiting' })
          await sleep(AGY_WAIT_MS)
          continue
        }
        if (r.kind === 'unknown-exit') {
          setPhase({ kind: 'ask', terminalId: l.terminal.id })
          const exited = await new Promise<boolean>((resolve) => { answer.current = resolve })
          if (!exited) return finishStopped(done, `agy may still be running in ${l.terminal.name}.`)
          assume = true
          setPhase({ kind: 'exiting' })
          continue
        }
        const why = whyOf(r)
        mark(l.terminal.id, { mark: 'failed', why })
        return finishStopped(done, why ? `${l.terminal.name}: ${why}.` : `${l.terminal.name} couldn't be switched.`)
      }
    }
    // Stop pressed in the last terminal's own step lands here, with no look left before the sign-out.
    if (stopped.current) return finishStopped(done, 'you asked it to.')
    setPhase({ kind: 'signing-in' })
  }

  /** A terminal that couldn't be exited, or the user's Stop: nothing was signed out, and the ones
   *  exited already go back to their conversations on the sign-in they had. */
  const finishStopped = async (done: Line[], why: string): Promise<void> => {
    setPhase({ kind: 'stopped', why })
    for (const l of done) {
      mark(l.terminal.id, { mark: 'working' })
      const r = await step(l.terminal, 'resume', { conversationId: l.conversationId ?? null })
      if (r.kind === 'resumed') mark(l.terminal.id, { mark: r.fresh ? 'fresh' : 'resumed' })
      else mark(l.terminal.id, { mark: 'failed', why: whyOf(r) })
    }
  }

  const cancel = (): void => {
    stopped.current = true
    answer.current?.(false)
    close()
  }

  /** The sheet's X and Esc. Never a way out that leaves a terminal this switch ended without its
   *  conversation: mid sign-in it is the flow's own Cancel (the unmount ends the hidden session), and
   *  with terminals still ended it resumes them before it lets go. */
  const leave = (): void => {
    if (phase.kind === 'signing-in') return setPhase({ kind: 'interrupted' })
    if (phase.kind === 'interrupted' && exitedLines().length > 0) {
      void resumeAll(exitedLines()).then(() => setPhase({ kind: 'done', email: null }))
      return
    }
    cancel()
  }

  const exitedLines = (): Line[] => lines.filter((l) => l.mark === 'exited')

  const LINE_WORDS: Readonly<Record<Mark, string>> = {
    waiting: 'agy is working: waiting for its turn to end',
    working: '…',
    exited: 'agy ended here',
    resumed: 'Conversation resumed',
    fresh: 'A new conversation: agy couldn\'t find this one',
    failed: 'Couldn\'t switch here',
  }
  const list = n > 0 && (
    <ul className="flex flex-col gap-1 text-xs" data-testid="agy-switch-terminals">
      {lines.map((l) => (
        <li key={l.terminal.id} className="flex items-center gap-2" data-mark={l.mark ?? 'none'}>
          {l.mark === 'working' ? <i className={SPINNER} aria-hidden="true"></i> : <i className="fa-solid fa-terminal text-[#9ca3af] text-[10px]" aria-hidden="true"></i>}
          <span className="text-[#e0e0e0]">{l.terminal.name}</span>
          {l.mark && <span className="text-[#9ca3af]">{LINE_WORDS[l.mark]}{l.why ? `: ${l.why}` : ''}</span>}
          {!l.mark && l.busy && <span className="text-[#e5c07b]" data-testid="agy-switch-busy">working: Termpolis waits for its turn to end first</span>}
        </li>
      ))}
    </ul>
  )

  let body: React.ReactNode
  switch (phase.kind) {
    case 'confirm':
      body = (
        <div className="flex flex-col gap-3" data-testid="agy-switch-confirm">
          <p>
            Gemini CLI has one Google sign-in for this whole computer. Switching to {who} moves {n === 0 ? 'new Gemini terminals' : n === 1 ? 'your Gemini terminal' : `all ${n} Gemini terminals`}
            {n > 0 ? `; ${n === 1 ? 'it resumes its' : 'each one resumes its'} conversation.` : '.'}
          </p>
          <p className="text-xs text-[#9ca3af]">A Gemini terminal that is working is left to finish its turn first. Termpolis signs agy out and in for you here, in its own hidden agy.</p>
          <p className="text-xs text-[#9ca3af]">An agy running anywhere else on this computer (a swarm worker, another window) moves to the new sign-in too, and Termpolis does not resume it.</p>
          {list}
          <div className="flex gap-2">
            <button type="button" className={SHEET_PRIMARY} data-autofocus="" onClick={go} data-testid="agy-switch-go">{n > 1 ? 'Switch all Gemini terminals' : 'Switch Gemini CLI'}</button>
            <button type="button" className={SHEET_SECONDARY} onClick={close} data-testid="agy-switch-cancel">Cancel</button>
          </div>
        </div>
      )
      break
    case 'confirm-work':
      body = (
        <div className="flex flex-col gap-3" data-testid="agy-switch-confirm-work">
          <p>{phase.question}</p>
          <div className="flex gap-2">
            <button type="button" className={SHEET_PRIMARY} data-autofocus="" onClick={() => { void exitAll() }} data-testid="agy-switch-confirm-work-yes">{phase.yes}</button>
            <button type="button" className={SHEET_SECONDARY} onClick={close} data-testid="agy-switch-confirm-work-no">Cancel</button>
          </div>
        </div>
      )
      break
    case 'exiting':
      body = (
        <div className="flex flex-col gap-2" data-testid="agy-switch-exiting">
          <p>Ending agy in {n === 1 ? 'your Gemini terminal' : `${n} Gemini terminals`}…</p>
          {list}
          <div>
            <button type="button" className={SHEET_SECONDARY} disabled={stopping} onClick={() => { stopped.current = true; setStopping(true) }} data-testid="agy-switch-stop-exiting">
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          </div>
        </div>
      )
      break
    case 'ask': {
      const t = lines.find((l) => l.terminal.id === phase.terminalId)!.terminal
      body = (
        <div className="flex flex-col gap-2" data-testid="agy-switch-ask">
          <p>Termpolis can&apos;t tell whether agy still runs in {t.name}, so it typed nothing there.</p>
          <div className="flex gap-2">
            <button type="button" className={SHEET_PRIMARY} data-autofocus="" onClick={() => answer.current?.(true)} data-testid="agy-switch-exited">It has exited, go on</button>
            <button type="button" className={SHEET_SECONDARY} onClick={() => answer.current?.(false)} data-testid="agy-switch-stop">Stop</button>
          </div>
        </div>
      )
      break
    }
    case 'stopped':
      body = (
        <div className="flex flex-col gap-2" data-testid="agy-switch-stopped">
          <p className="text-[#e06c75]">Termpolis stopped before signing agy out: {phase.why}</p>
          <p className="text-xs text-[#9ca3af]">agy&apos;s sign-in is as it was. Any terminal it ended goes back to its conversation.</p>
          {list}
          <div><button type="button" className={SHEET_SECONDARY} data-autofocus="" onClick={close} data-testid="agy-switch-stopped-close">Close</button></div>
        </div>
      )
      break
    case 'signing-in':
      body = (
        <SignInFlow
          account={target}
          view={view}
          mode="agy-switch"
          autoDone
          doneLabel="Resume the conversations"
          onDone={(email) => { void resumeAll(exitedLines()).then(() => setPhase({ kind: 'done', email })) }}
          onCancel={() => setPhase({ kind: 'interrupted' })}
        />
      )
      break
    case 'interrupted':
      body = (
        <div className="flex flex-col gap-2" data-testid="agy-switch-interrupted">
          <p>The sign-in didn&apos;t finish.{n > 0 ? ` ${n === 1 ? 'Your Gemini terminal is' : `Your ${n} Gemini terminals are`} waiting.` : ''}</p>
          {n > 0 && <p className="text-xs text-[#9ca3af]">Resuming now goes back on the sign-in agy has: if agy is signed out, each one shows agy&apos;s sign-in. Closing this resumes them now.</p>}
          <div className="flex gap-2">
            <button type="button" className={SHEET_PRIMARY} data-autofocus="" onClick={() => setPhase({ kind: 'signing-in' })} data-testid="agy-switch-retry">Try the sign-in again</button>
            {n > 0 && <button type="button" className={SHEET_SECONDARY} onClick={() => { void resumeAll(exitedLines()).then(() => setPhase({ kind: 'done', email: null })) }} data-testid="agy-switch-resume-now">Resume them now</button>}
            {n === 0 && <button type="button" className={SHEET_SECONDARY} onClick={close} data-testid="agy-switch-interrupted-close">Close</button>}
          </div>
        </div>
      )
      break
    case 'resuming':
      body = <div className="flex flex-col gap-2" data-testid="agy-switch-resuming"><p>Resuming {n === 1 ? 'the conversation' : `${n} conversations`}…</p>{list}</div>
      break
    default: {
      const back = lines.filter((l) => l.mark === 'resumed' || l.mark === 'fresh').length
      body = (
        <div className="flex flex-col gap-2" data-testid="agy-switch-done">
          <p className="text-[#7ee2a3]">
            {phase.email ? `Gemini CLI is on ${phase.email} now.` : 'Gemini CLI is back on its sign-in.'}
            {n > 0 ? ` ${back} of ${n} conversation${n === 1 ? '' : 's'} resumed.` : ' New Gemini terminals start on it.'}
          </p>
          {list}
          <div><button type="button" className={SHEET_PRIMARY} data-autofocus="" onClick={close} data-testid="agy-switch-done-close">Done</button></div>
        </div>
      )
    }
  }

  const busyPhase = phase.kind === 'exiting' || phase.kind === 'resuming'
  return (
    <Sheet title={`Switch Gemini CLI to ${target.label}`} subtitle={target.email} icon="fa-user-group" testId="agy-switch" {...(busyPhase ? {} : { onClose: leave })}>
      {body}
      <p className="sr-only" role="status" aria-live="polite" data-testid="agy-switch-live">{ANNOUNCE[phase.kind]}</p>
    </Sheet>
  )
}
