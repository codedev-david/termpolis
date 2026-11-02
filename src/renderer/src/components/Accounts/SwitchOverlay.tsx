// What a terminal's pane shows while its account is switched in place (the in-app account UI,
// §2.2): an overlay with the two accounts and the switch's three steps while it runs, keys held
// (typing there says so); then a toast with Switch back for 10 s; or, when it didn't finish, an
// error card that says what happened and what the terminal shows now, with the next steps.
// The plumbing main types (exit, account line, resume) runs under the overlay.
import { useEffect, useState } from 'react'
import { ACCOUNT_AGENT_LABEL } from '../../../../shared/agentAccounts'
import { useTerminalStore } from '../../store/terminalStore'
import { actOnRun, stepLabels } from '../../lib/accountSwitchRun'
import { focusTerminal } from '../../lib/accountMenu'
import type { Endpoint, StepState, SwitchRun } from '../../lib/accountSwitchRun'
import { SMALL_BUTTON, SMALL_PRIMARY, SPINNER } from './ui'

/** How long the "keys are held" hint stays after a key. */
export const HELD_HINT_MS = 3000

function Avatar({ who }: { who: Endpoint | null }) {
  return (
    <span className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold text-[#1e1e1e]" style={{ backgroundColor: who?.color ?? '#6b7280' }} title={who?.label ?? 'unknown account'}>
      {(who?.label.charAt(0) ?? '?').toUpperCase()}
    </span>
  )
}

const STEP_ICON: Readonly<Record<StepState, string>> = {
  pending: 'fa-regular fa-circle text-[#6b7280]',
  working: `${SPINNER} text-[#22D3EE]`,
  done: 'fa-solid fa-circle-check text-[#7ee2a3]',
  failed: 'fa-solid fa-circle-xmark text-[#e06c75]',
}

function Steps({ run }: { run: SwitchRun }) {
  const labels = stepLabels(run)
  return (
    <ol className="flex flex-col gap-1.5" data-testid="switch-steps">
      {labels.map((label, i) => (
        <li key={label} className="flex items-center gap-2 text-xs" data-state={run.steps[i]}>
          <i className={`w-3.5 ${STEP_ICON[run.steps[i]]}`} aria-hidden="true"></i>
          <span className={run.steps[i] === 'pending' ? 'text-[#9ca3af]' : 'text-[#d4d4d4]'}>{label}</span>
          <span className="sr-only">{run.steps[i]}</span>
        </li>
      ))}
    </ol>
  )
}

function Progress({ run, now }: { run: SwitchRun; now: number }) {
  const held = run.heldAt !== undefined && now - run.heldAt < HELD_HINT_MS
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50" data-testid="switch-overlay">
      <div role="status" aria-live="polite" className="w-[340px] max-w-[90%] bg-[#252526] border border-[#3c3c3c] rounded-lg shadow-2xl p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2" aria-hidden="true">
          <Avatar who={run.from} />
          <i className="fa-solid fa-arrow-right text-[#9ca3af] text-xs"></i>
          <Avatar who={run.to} />
        </div>
        <p className="text-sm text-[#e0e0e0]">Switching {ACCOUNT_AGENT_LABEL[run.agent]} to {run.to.label}</p>
        {run.status === 'checking'
          ? <p className="text-xs text-[#9ca3af]" data-testid="switch-checking"><i className={`${SPINNER} mr-1.5`} aria-hidden="true"></i>Checking {run.to.label}&apos;s sign-in…</p>
          : <Steps run={run} />}
        {held && <p className="text-[11px] text-[#e5c07b]" data-testid="switch-keys-held">Switching accounts: your keys are held until it finishes</p>}
      </div>
    </div>
  )
}

function Card({ run }: { run: SwitchRun }) {
  const [steps, setSteps] = useState(false)
  const card = run.card!
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40" data-testid="switch-error">
      <div role="alert" className="w-[380px] max-w-[90%] bg-[#252526] border border-[#e06c75]/60 rounded-lg shadow-2xl p-4 flex flex-col gap-2">
        <p className="text-sm text-[#e0e0e0]">{card.what}</p>
        <p className="text-xs text-[#9ca3af]">{card.now}</p>
        {steps && <Steps run={run} />}
        <div className="flex flex-wrap gap-2 pt-1">
          {card.actions.map((a, i) => (
            <button key={a.kind + a.label} type="button" className={i === 0 && a.kind !== 'close' ? SMALL_PRIMARY : SMALL_BUTTON} autoFocus={i === 0} onClick={() => { void actOnRun(run.terminalId, a.kind); focusTerminal(run.terminalId) }} data-testid={`switch-action-${a.kind}`}>
              {a.label}
            </button>
          ))}
          <button type="button" className={SMALL_BUTTON} onClick={() => setSteps(!steps)} data-testid="switch-show-steps">{steps ? 'Hide steps' : 'Show steps'}</button>
        </div>
      </div>
    </div>
  )
}

/** The toast; it goes by itself at its time (accountSwitchRun's startSwitch). */
function Toast({ run }: { run: SwitchRun }) {
  const toast = run.toast!
  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 max-w-[90%]" data-testid="switch-toast">
      <div role="status" className="flex items-center gap-3 bg-[#252526] border border-[#3c3c3c] rounded-lg shadow-xl px-3 py-2 text-xs text-[#d4d4d4]">
        <i className="fa-solid fa-circle-check text-[#7ee2a3]" aria-hidden="true"></i>
        <span>{toast.text}</span>
        {toast.back && <button type="button" className={SMALL_BUTTON} onClick={() => { void actOnRun(run.terminalId, 'back'); focusTerminal(run.terminalId) }} data-testid="switch-back">Switch back</button>}
        <button type="button" aria-label="Dismiss" className="px-1 rounded hover:bg-white/10" onClick={() => { useTerminalStore.getState().dropSwitchRun(run.terminalId); focusTerminal(run.terminalId) }} data-testid="switch-toast-close">
          <i className="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  )
}

export function SwitchOverlay({ terminalId }: { terminalId: string }) {
  // A store that holds no switches (a pane's tests mock one) shows nothing.
  const run = useTerminalStore((s) => s.switchRuns?.[terminalId])
  const [now, setNow] = useState(() => Date.now())
  // The held-keys hint follows the clock while it shows.
  useEffect(() => {
    if (!run?.heldAt) return undefined
    setNow(Date.now())
    const timer = setTimeout(() => setNow(Date.now()), HELD_HINT_MS)
    return () => clearTimeout(timer)
  }, [run?.heldAt])
  if (!run) return null
  if (run.status === 'done') return <Toast run={run} />
  if (run.status === 'failed') return <Card run={run} />
  return <Progress run={run} now={now} />
}

/** A switch's state in one line, where its terminal has no pane to show it on: a swarm worker's, in
 *  the swarm dashboard. Its card's buttons, or its toast's Switch back, are there too. */
export function SwitchStatusLine({ terminalId }: { terminalId: string }) {
  const run = useTerminalStore((s) => s.switchRuns?.[terminalId])
  if (!run) return null
  const drop = (): void => useTerminalStore.getState().dropSwitchRun(terminalId)
  if (run.status === 'done') {
    return (
      <span className="flex items-center gap-1.5 text-[#7ee2a3]" role="status" data-testid="switch-status-done">
        {run.toast!.text}
        <button type="button" aria-label="Dismiss" className="px-1 rounded hover:bg-white/10 text-[#9ca3af]" onClick={drop}><i className="fa-solid fa-xmark" aria-hidden="true"></i></button>
      </span>
    )
  }
  if (run.status === 'failed') {
    return (
      <span className="flex flex-wrap items-center gap-1.5 text-[#e06c75]" role="alert" data-testid="switch-status-failed">
        {run.card!.what}
        {run.card!.actions.map((a) => (
          <button key={a.kind + a.label} type="button" className={SMALL_BUTTON} onClick={() => { void actOnRun(terminalId, a.kind) }} data-testid={`switch-status-${a.kind}`}>{a.label}</button>
        ))}
      </span>
    )
  }
  return <span className="text-[#9ca3af]" role="status" data-testid="switch-status-running"><i className={`${SPINNER} mr-1`} aria-hidden="true"></i>Switching to {run.to.label}…</span>
}
