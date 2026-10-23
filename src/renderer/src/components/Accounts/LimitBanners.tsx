// The usage-limit banners (§8.4): one line each, under the title bar like the memory notice. An
// agent with one account (or none) out of usage, and until when, with [Add an account] and
// [Don't show again]; a chooser that couldn't open by itself (the window was elsewhere, a key was
// being typed, the terminal was hidden, or the chooser is switched off), with [Choose an account];
// an agent waiting on a menu, which only the user answers. A banner never takes a key: it is a line,
// not a dialog. One whose terminals all closed goes.
import { ACCOUNT_AGENT_LABEL } from '../../../../shared/agentAccounts'
import { bannerText } from '../../lib/limitWatch'
import type { LimitBanner } from '../../lib/limitWatch'
import { requestSettingsTab } from '../../lib/settingsNav'
import { useTerminalStore } from '../../store/terminalStore'

const BUTTON = 'text-xs px-2 py-1 rounded hover:bg-white/10'

export function LimitBanners() {
  const banners = useTerminalStore((s) => s.limitBanners)
  const terminals = useTerminalStore((s) => s.terminals)
  const view = useTerminalStore((s) => s.accountsView)
  const shown = banners.filter((b) => b.ctx.terminals.some((id) => terminals.some((t) => t.id === id)))
  if (shown.length === 0) return null
  const store = useTerminalStore.getState
  const addAccount = (b: LimitBanner): void => {
    const s = store()
    s.dismissLimitBanner(b.id)
    requestSettingsTab('accounts', s.showSettings)
    s.setShowSettings(true)
  }
  const choose = (b: LimitBanner): void => {
    const s = store()
    s.dismissLimitBanner(b.id)
    s.openLimitChooser(b.ctx)
  }
  const hideForGood = (b: LimitBanner): void => {
    store().dismissLimitBanner(b.id)
    void window.accounts?.hideAdvice('limitBanner').then((r) => { if (r.success) store().setAccountsView(r.data) }).catch(() => { /* shown again next time */ })
  }
  const show = (b: LimitBanner): void => {
    const s = store()
    s.dismissLimitBanner(b.id)
    s.setActiveTerminal(b.ctx.terminals[0])
  }
  return (
    <>
      {shown.map((b) => (
        <div
          key={b.id}
          data-testid="limit-banner"
          data-kind={b.kind}
          title={b.kind === 'menu' ? undefined : `${ACCOUNT_AGENT_LABEL[b.ctx.agent]}: ${b.ctx.words}`}
          className="px-4 py-2 flex items-center justify-between text-sm bg-[#e5c07b]/10 border-b border-[#e5c07b]/40 text-[#e5c07b]"
        >
          <div className="flex items-center gap-2 min-w-0">
            <i className="fa-solid fa-hourglass-half"></i>
            <span className="truncate">{bannerText(b, view, terminals, Date.now())}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {b.kind === 'single' && (
              <>
                <button type="button" className={BUTTON} onClick={() => addAccount(b)} data-testid="limit-banner-add">Add an account</button>
                <button type="button" className={BUTTON} onClick={() => hideForGood(b)} data-testid="limit-banner-hide">Don&apos;t show again</button>
              </>
            )}
            {b.kind === 'choose' && (
              <button type="button" className={BUTTON} onClick={() => choose(b)} data-testid="limit-banner-choose">Choose an account</button>
            )}
            {b.kind === 'menu' && (
              <button type="button" className={BUTTON} onClick={() => show(b)} data-testid="limit-banner-show">Show it</button>
            )}
            <button type="button" className="text-xs px-1.5 py-1 rounded hover:bg-white/10" onClick={() => store().dismissLimitBanner(b.id)} aria-label="Dismiss" data-testid="limit-banner-close">
              <i className="fa-solid fa-xmark"></i>
            </button>
          </div>
        </div>
      ))}
    </>
  )
}
