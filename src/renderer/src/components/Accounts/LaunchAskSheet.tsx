// "Claude Code: personal is out of usage until 4:00 pm. Launch on codedev?" (the design's launch paths,
// §6.3, ask mode): the sheet a fresh launch opens when the agent's preferred account is out of usage and
// another is a way out. The user's word goes back to the launch (launchAsk.ts): on one of the ways out,
// on the account that is out anyway, or no launch at all. Esc is Cancel. It takes the focus, as a sheet
// does, so a key typed meanwhile goes to it and not to a terminal.
import { useTerminalStore } from '../../store/terminalStore'
import { answerLaunchAsk, launchAskHeadline } from '../../lib/launchAsk'
import { Sheet } from './Sheet'
import { SHEET_PRIMARY, SHEET_SECONDARY } from './ui'

export function LaunchAskSheet() {
  const ctx = useTerminalStore((s) => s.launchAsk)
  if (!ctx) return null
  const [first, ...rest] = ctx.options
  return (
    <Sheet title="Launch on another account?" subtitle={launchAskHeadline(ctx)} icon="fa-hourglass-half" testId="launch-ask" onClose={() => answerLaunchAsk({ kind: 'cancel' })}>
      <p className="text-sm text-[#d4d4d4]" data-testid="launch-ask-text">
        {ctx.limited.label} will not answer until it is back. {first.label} is free now.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={SHEET_PRIMARY} data-autofocus="" onClick={() => answerLaunchAsk({ kind: 'on', accountId: first.id })} data-testid="launch-ask-first">
          Launch on {first.label}
        </button>
        {rest.map((o) => (
          <button key={o.id} type="button" className={SHEET_SECONDARY} onClick={() => answerLaunchAsk({ kind: 'on', accountId: o.id })} data-testid="launch-ask-other">
            Launch on {o.label}
          </button>
        ))}
        <button type="button" className={SHEET_SECONDARY} onClick={() => answerLaunchAsk({ kind: 'anyway' })} data-testid="launch-ask-anyway">
          Launch on {ctx.limited.label} anyway
        </button>
        <button type="button" className={SHEET_SECONDARY} onClick={() => answerLaunchAsk({ kind: 'cancel' })} data-testid="launch-ask-cancel">
          Cancel
        </button>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{launchAskHeadline(ctx)}</p>
    </Sheet>
  )
}
