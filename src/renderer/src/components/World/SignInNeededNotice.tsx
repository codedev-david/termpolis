// Lumopolis: a remembered repository that needs a sign-in before it can update. The saved copy is
// still showing; this notice offers Sign in (when git has a login helper for the host), Use a token,
// or Dismiss. It sits in the same top-of-world slot as WorldView's other notice.
import { btnCls, signInLabel } from './worldTargets'


export interface SignInNeededNoticeProps {
  host: string
  helper: boolean
  busy: boolean
  /** Why the last Sign in or token try failed. */
  error: string | null
  onSignIn(): void
  onUseToken(): void
  onDismiss(): void
}

export function SignInNeededNotice({ host, helper, busy, error, onSignIn, onUseToken, onDismiss }: SignInNeededNoticeProps): JSX.Element {
  return (
    <div
      role="status"
      data-testid="world-sign-in-needed"
      className="text-xs px-3 py-2 rounded border border-[#3c3c3c] flex flex-col gap-2"
      style={{ background: '#252526', maxWidth: 420 }}
    >
      <span>This repository needs you to sign in before Lumopolis can update it. You're seeing the saved copy.</span>
      {error !== null && <span role="alert" className="text-[#f14c4c]">{error}</span>}
      <div className="flex justify-end gap-2">
        {helper && <button type="button" className={btnCls} disabled={busy} onClick={onSignIn}>{signInLabel(host)}</button>}
        <button type="button" className={btnCls} disabled={busy} onClick={onUseToken}>Use a token</button>
        <button type="button" className={btnCls} disabled={busy} onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  )
}
