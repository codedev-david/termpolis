// The sign-in steps (the in-app account UI, §2.3), shared by the sign-in sheet, the Add account
// wizard and agy's switch: how to sign in, then the CLI's own steps as main's hidden session reads
// them (signInSession.ts), and how it ended. Termpolis answers nothing on a sign-in: every button
// here is the user's own choice, which main passes on to the CLI. A pasted code goes straight to
// main from the field, which is cleared at once: it is never held in a React state.
import { useEffect, useRef, useState } from 'react'
import { ACCOUNT_AGENT_LABEL, isProfileAgent } from '../../../../shared/agentAccounts'
import type { AccountRowView, AccountsView, SignInMethod } from '../../../../shared/agentAccounts'
import type { SignInInput, SignInPhase } from '../../../../shared/signInScreens'
import { refreshAccounts } from '../../lib/accountsState'
import { SIGN_IN_METHODS, announce, keysFor, resignWarning, sentence, successWarnings } from '../../lib/signInSheet'
import { SHEET_CHOICE, SHEET_INPUT, SHEET_PRIMARY, SHEET_SECONDARY, SMALL_BUTTON, SPINNER } from './ui'

export interface SignInFlowProps {
  account: AccountRowView
  view: AccountsView
  /** agy's switch: sign the computer user's one agy out, and in to this account. */
  mode?: 'sign-in' | 'agy-switch'
  /** Start at once with this method: no method step. */
  method?: SignInMethod
  /** It signed in, and the user went on (or, with `autoDone`, at once when nothing needs saying). */
  onDone: (email: string | null) => void
  /** The done button's words. */
  doneLabel?: string
  autoDone?: boolean
  /** It ended with no sign-in: the user cancelled, or closed it after an error. */
  onCancel: () => void
}

type Stage = { kind: 'method' } | { kind: 'session'; phase: SignInPhase } | { kind: 'failed-start'; message: string }

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const ENDED: ReadonlySet<SignInPhase['kind']> = new Set(['success', 'error', 'cancelled'])

function Waiting({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 text-[#9ca3af]" data-testid="sign-in-waiting">
      <i className={SPINNER} aria-hidden="true"></i>
      {text}
    </p>
  )
}

export function SignInFlow({ account, view, mode = 'sign-in', method, onDone, doneLabel = 'Done', autoDone = false, onCancel }: SignInFlowProps) {
  const api = window.accounts!
  const name = ACCOUNT_AGENT_LABEL[account.agent]
  const methods = isProfileAgent(account.agent) ? SIGN_IN_METHODS[account.agent] : []
  const askMethod = mode === 'sign-in' && !method && methods.length > 0
  const [stage, setStage] = useState<Stage>(askMethod ? { kind: 'method' } : { kind: 'session', phase: { kind: 'starting' } })
  const [copied, setCopied] = useState<string | null>(null)
  const [inputError, setInputError] = useState<string | null>(null)
  const [details, setDetails] = useState(false)
  const session = useRef<string | null>(null)
  const ended = useRef(false)
  /** The flow was cancelled or went away: a session main answers for after that is ended at once. */
  const closed = useRef(false)
  // A state that came before its session's id did (main sends the first one as it starts).
  const early = useRef(new Map<string, SignInPhase>())
  const field = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => api.onSignInState((s) => {
    if (s.sessionId !== session.current) {
      early.current.set(s.sessionId, s.phase)
      return
    }
    if (ENDED.has(s.phase.kind)) ended.current = true
    // Main keeps the new sign-in before it says "success" and pushes nothing else: read again now, so every way out of
    // this flow (Done, Skip, Esc, the X, Cancel, the wizard's own finish) leaves Settings, the menu and a swarm offer
    // seeing the account signed in, not as it stood when the flow began (UI2-1).
    if (s.phase.kind === 'success') void refreshAccounts()
    setStage({ kind: 'session', phase: s.phase })
  }), [api])

  const start = async (m?: SignInMethod): Promise<void> => {
    closed.current = false
    setStage({ kind: 'session', phase: { kind: 'starting' } })
    setInputError(null)
    setDetails(false)
    try {
      const r = await api.signInStart({ accountId: account.id, ...(m ? { method: m } : {}), ...(mode === 'agy-switch' ? { mode } : {}) })
      if (!r.success) return setStage({ kind: 'failed-start', message: r.error })
      // Cancelled, or gone, before main gave the session its id: it would live on in its hidden
      // process (and could still sign the profile in) until its timeout. It ends now.
      if (closed.current) {
        void api.signInInput(r.data.sessionId, { kind: 'cancel' }).catch(() => undefined)
        return
      }
      session.current = r.data.sessionId
      ended.current = false
      const first = early.current.get(r.data.sessionId)
      early.current.clear()
      if (first) {
        if (ENDED.has(first.kind)) ended.current = true
        setStage({ kind: 'session', phase: first })
      }
    } catch (e) {
      setStage({ kind: 'failed-start', message: errorText(e) })
    }
  }

  // Started at once, with no method step to wait on.
  useEffect(() => {
    if (!askMethod) void start(method)
    // Once, as the flow opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A session still running when the flow goes away is ended, its process with it.
  useEffect(() => {
    // Set again as it mounts: the dev build mounts, unmounts and mounts a component once more.
    closed.current = false
    return () => {
      closed.current = true
      const id = session.current
      if (id && !ended.current) void api.signInInput(id, { kind: 'cancel' }).catch(() => undefined)
    }
  }, [api])

  const send = async (input: SignInInput): Promise<string | null> => {
    const id = session.current as string
    try {
      const r = await api.signInInput(id, input)
      if (!r.success) return r.error
      return r.data.ok ? null : r.data.why
    } catch (e) {
      return errorText(e)
    }
  }

  const cancel = (): void => {
    closed.current = true
    const id = session.current
    if (id && !ended.current) {
      ended.current = true
      void api.signInInput(id, { kind: 'cancel' }).catch(() => undefined)
    }
    onCancel()
  }

  /** The code or value in the field: sent to main, and cleared from the field before anything else. */
  const submit = async (kind: 'code' | 'text'): Promise<void> => {
    const el = field.current as HTMLInputElement
    const value = el.value
    el.value = ''
    if (!value.trim()) return
    setInputError(await send({ kind, value }))
  }

  const copy = async (what: string, text: string): Promise<void> => {
    try {
      setCopied((await window.termpolis.clipboardWriteText(text)).success ? what : null)
    } catch {
      setCopied(null)
    }
  }

  const phase: SignInPhase | null = stage.kind === 'session' ? stage.phase : null
  const kind = phase ? phase.kind : stage.kind
  const success = phase && phase.kind === 'success' ? phase : null
  const warnings = success ? successWarnings(view, account, success.email) : []

  // At each new step, its main control takes the focus, so the keyboard follows the sign-in.
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [kind])

  useEffect(() => {
    if (success && autoDone && warnings.length === 0) onDone(success.email)
    // When it signs in, once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [success?.kind])

  const address = (url: string | null, canOpen: boolean) => url && (
    <div className="flex flex-col gap-1.5" data-testid="sign-in-address">
      <code className="block text-[11px] text-[#bbb] bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1.5 break-all max-h-20 overflow-y-auto select-all">{url}</code>
      <div className="flex items-center gap-2">
        <button type="button" className={SMALL_BUTTON} onClick={() => { void copy('url', url) }} data-testid="sign-in-copy-url">{copied === 'url' ? 'Copied' : 'Copy'}</button>
        <button
          type="button"
          className={SMALL_BUTTON}
          disabled={!canOpen}
          title={canOpen ? undefined : 'Termpolis opens only the provider\'s own sign-in page.'}
          onClick={() => { void send({ kind: 'open' }).then(setInputError) }}
          data-testid="sign-in-open"
        >
          Open again
        </button>
      </div>
    </div>
  )

  const codeField = (label: string, kindOf: 'code' | 'text', button: string) => (
    <form className="flex flex-col gap-1.5" onSubmit={(e) => { e.preventDefault(); void submit(kindOf) }} data-testid="sign-in-field">
      <label className="flex flex-col gap-1 text-xs text-[#9ca3af]">
        {label}
        <input ref={field} className={SHEET_INPUT} autoComplete="off" spellCheck={false} data-autofocus="" data-testid="sign-in-input" />
      </label>
      <div><button type="submit" className={SHEET_PRIMARY} data-testid="sign-in-submit">{button}</button></div>
    </form>
  )

  let body: React.ReactNode
  if (stage.kind === 'method') {
    const warning = resignWarning(account)
    body = (
      <div className="flex flex-col gap-2" data-testid="sign-in-methods">
        <p>How do you sign in to {name}?</p>
        {methods.map((m, i) => (
          <button key={m.id} type="button" className={SHEET_CHOICE} onClick={() => { void start(m.id) }} {...(i === 0 ? { 'data-autofocus': '' } : {})} data-testid={`sign-in-method-${m.id}`}>
            <span className="block font-medium text-[#e0e0e0]">{m.label}</span>
            <span className="block text-xs text-[#9ca3af]">{m.hint}</span>
          </button>
        ))}
        {warning && <p className="text-xs text-[#e5c07b] leading-relaxed" data-testid="sign-in-resign-warning">{warning}</p>}
        <p className="text-xs text-[#9ca3af]">{name} signs in in your browser and keeps its own sign-in. Termpolis never sees it.</p>
      </div>
    )
  } else if (stage.kind === 'failed-start') {
    body = (
      <div className="flex flex-col gap-2" data-testid="sign-in-failed-start">
        <p className="text-[#e06c75]">Termpolis couldn&apos;t start {name}&apos;s sign-in: {stage.message}.</p>
        <div className="flex gap-2">
          <button type="button" className={SHEET_PRIMARY} onClick={() => { void (askMethod ? setStage({ kind: 'method' }) : start(method)) }} data-autofocus="" data-testid="sign-in-retry">Try again</button>
          <button type="button" className={SHEET_SECONDARY} onClick={onCancel} data-testid="sign-in-close">Close</button>
        </div>
      </div>
    )
  } else {
    const p = stage.phase
    switch (p.kind) {
      case 'starting':
        body = <Waiting text={mode === 'agy-switch' ? 'Starting agy…' : `Starting ${name}'s sign-in…`} />
        break
      case 'signing-out':
        body = <Waiting text="Signing agy out…" />
        break
      case 'browser':
        body = (
          <div className="flex flex-col gap-3" data-testid="sign-in-browser">
            <p className="font-medium text-[#e0e0e0]">Finish signing in in your browser.</p>
            <p className="text-xs text-[#9ca3af]">{name} opened your browser at its sign-in page. If it didn&apos;t, open the address below.</p>
            {address(p.url, p.canOpen)}
            {p.codeField && codeField('If the page shows a code, paste it here.', 'code', 'Submit')}
            <Waiting text="Waiting for you to finish in the browser…" />
          </div>
        )
        break
      case 'code-wanted':
        body = (
          <div className="flex flex-col gap-3" data-testid="sign-in-code-wanted">
            <p className="font-medium text-[#e0e0e0]">Sign in in your browser, then paste the code.</p>
            <p className="text-xs text-[#9ca3af]">The browser can&apos;t hand the sign-in back to {name} by itself. Open the address, sign in, and paste the code the page shows.</p>
            {address(p.url, p.canOpen)}
            {codeField('The code from the page', 'code', 'Submit')}
          </div>
        )
        break
      case 'device-code':
        body = (
          <div className="flex flex-col gap-3" data-testid="sign-in-device-code">
            <p className="font-medium text-[#e0e0e0]">Enter this code in your browser.</p>
            <div className="flex items-center gap-3">
              <span className="font-mono text-3xl tracking-[0.2em] text-[#e0e0e0] select-all" data-testid="sign-in-code">{p.code}</span>
              <button type="button" className={SMALL_BUTTON} onClick={() => { void copy('code', p.code) }} data-autofocus="" data-testid="sign-in-copy-code">{copied === 'code' ? 'Copied' : 'Copy code'}</button>
            </div>
            {p.url && <p className="text-xs text-[#9ca3af]">at the address below. It expires in 15 minutes.</p>}
            {address(p.url, p.canOpen)}
            <Waiting text="Waiting for you to finish in the browser…" />
          </div>
        )
        break
      case 'choose':
        body = (
          <div className="flex flex-col gap-2" data-testid="sign-in-choose">
            <p className="font-medium text-[#e0e0e0]">{p.question}</p>
            {p.detail.map((d) => <p key={d} className="text-xs text-[#9ca3af]">{d}</p>)}
            {p.options.map((o, i) => (
              <button key={o} type="button" className={SHEET_CHOICE} onClick={() => { void send({ kind: 'pick', index: i, label: o }).then(setInputError) }} {...(i === p.selected ? { 'data-autofocus': '' } : {})} data-testid={`sign-in-option-${i}`}>
                {o}
              </button>
            ))}
            <p className="text-xs text-[#9ca3af]">Termpolis passes your choice to agy.</p>
          </div>
        )
        break
      case 'text-wanted':
        body = codeField(p.label, 'text', 'Continue')
        break
      case 'working':
        body = <Waiting text="Signing you in…" />
        break
      case 'confirming':
        body = <Waiting text="Checking your sign-in…" />
        break
      case 'success':
        body = (
          <div className="flex flex-col gap-2" data-testid="sign-in-success">
            <p className="text-[#7ee2a3] font-medium">
              <i className="fa-solid fa-circle-check mr-1.5" aria-hidden="true"></i>
              {p.email ? `Signed in as ${p.email}` : 'Signed in'}{p.plan ? ` · ${p.plan}` : ''}
            </p>
            {warnings.map((w) => <p key={w} className="text-xs text-[#e5c07b]" data-testid="sign-in-warning">{w}</p>)}
            <div className="flex gap-2">
              <button type="button" className={SHEET_PRIMARY} onClick={() => onDone(p.email)} data-autofocus="" data-testid="sign-in-done">{doneLabel}</button>
              {warnings.length > 0 && askMethod && <button type="button" className={SHEET_SECONDARY} onClick={() => setStage({ kind: 'method' })} data-testid="sign-in-again">Sign in again</button>}
            </div>
          </div>
        )
        break
      case 'error':
        body = (
          <div className="flex flex-col gap-2" data-testid="sign-in-error">
            <p className="text-[#e06c75]" data-testid="sign-in-error-text">{p.timeout ? p.message : `${name} didn't sign in: ${sentence(p.message)}`}</p>
            {details && (
              <pre className="text-[11px] text-[#bbb] bg-[#1e1e1e] border border-[#3c3c3c] rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap" data-testid="sign-in-details">{p.details.join('\n')}</pre>
            )}
            <div className="flex gap-2 flex-wrap">
              <button type="button" className={SHEET_PRIMARY} onClick={() => { void (askMethod ? setStage({ kind: 'method' }) : start(method)) }} data-autofocus="" data-testid="sign-in-retry">Try again</button>
              {p.details.length > 0 && <button type="button" className={SHEET_SECONDARY} onClick={() => setDetails(!details)} data-testid="sign-in-show-details">{details ? 'Hide details' : 'Show details'}</button>}
              <button type="button" className={SHEET_SECONDARY} onClick={onCancel} data-testid="sign-in-close">Close</button>
            </div>
          </div>
        )
        break
      case 'unknown':
        body = (
          <div className="flex flex-col gap-2" data-testid="sign-in-unknown">
            <p>Termpolis can&apos;t read {name}&apos;s screen, so here it is. Termpolis types nothing into it.</p>
            <pre
              className="text-[11px] leading-snug text-[#d4d4d4] bg-[#1e1e1e] border border-[#3c3c3c] rounded p-2 max-h-64 overflow-auto whitespace-pre focus:outline-none focus:border-[#22D3EE]"
              data-testid="sign-in-screen"
              {...(p.typing ? {
                tabIndex: 0,
                role: 'textbox',
                'aria-label': `Type into ${name}`,
                onKeyDown: (e: React.KeyboardEvent) => {
                  const data = keysFor(e)
                  if (data === null) return
                  e.preventDefault()
                  // The CLI's key (Esc among them) is not the sheet's: it must not also close it.
                  e.stopPropagation()
                  void send({ kind: 'keys', data })
                },
              } : {})}
            >
              {p.screen.join('\n')}
            </pre>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={p.typing} onChange={(e) => { void send({ kind: 'live', on: e.target.checked }) }} data-testid="sign-in-type-here" />
              Let me type here
            </label>
          </div>
        )
        break
      default:
        body = <p data-testid="sign-in-cancelled">The sign-in was cancelled.</p>
    }
  }

  const live = phase ? announce(phase, account.agent) : ''
  return (
    <div ref={root} className="flex flex-col gap-3" data-testid="sign-in-flow">
      {body}
      {inputError && <p className="text-xs text-[#e06c75]" role="alert" data-testid="sign-in-input-error">{inputError}</p>}
      <p className="sr-only" role="status" aria-live="polite" data-testid="sign-in-live">{live}</p>
      {phase && !ENDED.has(phase.kind) && (
        <div className="flex justify-end">
          <button type="button" className={SHEET_SECONDARY} onClick={cancel} data-testid="sign-in-cancel">Cancel</button>
        </div>
      )}
    </div>
  )
}
