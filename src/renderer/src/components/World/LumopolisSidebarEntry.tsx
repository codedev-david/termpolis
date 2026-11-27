// The sidebar's labelled way into Lumopolis: the globe and the word, with a New badge until Lumopolis has
// been opened once, and under it a one-time hint that names every way in. Both are remembered in the
// Lumopolis settings (worldSettings.ts: worldOpened, worldHintDismissed), not in this browser's storage,
// so they stay gone across updates and profiles. Nothing shows until the settings have answered, so a
// returning user never sees the badge flash. Small and engine-free: the sidebar is in App's main chunk.
// "or type lumopolis" is said only where typing it works (#29): main answers for the active terminal
// (world:terminal-typable), and a terminal answered no (a zsh whose Termpolis .zshrc never ran) gets the hint without
// those words. With no terminal, while main has not answered, or when it cannot say, the whole hint shows: every
// shell Termpolis integrates has the command. A no is asked again when that terminal prints the zsh ready mark
// (LUMOPOLIS_READY_EVENT): a .zshrc slower than main waits is answered no, then has the command at its first prompt.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import { LUMOPOLIS_READY_EVENT, openLumopolis, WORLD_OPENED_EVENT } from './worldOpen'

export const LUMOPOLIS_HINT = 'Lumopolis: see any project as a 3D city. Open it here, click the globe on a terminal, or type lumopolis.'
/** The hint for an active terminal where typing lumopolis does not work (#29). PENDING SIGN-OFF. */
export const LUMOPOLIS_HINT_UNTYPED = 'Lumopolis: see any project as a 3D city. Open it here, or click the globe on a terminal.'

interface Flags { opened: boolean; dismissed: boolean }

export function LumopolisSidebarEntry(): JSX.Element {
  const [flags, setFlags] = useState<Flags | null>(null)
  useEffect(() => {
    let live = true
    // Through a promise, so a build without these settings (or a test's partial bridge) only shows nothing.
    Promise.resolve().then(() => window.termpolis.worldSettingsGet()).then(
      // Merged, not replaced: an open that lands before this answer stays an open (the answer was read before it).
      (res) => { if (live && res.success) setFlags((f) => ({ opened: res.data.worldOpened || !!f?.opened, dismissed: res.data.worldHintDismissed })) },
      () => undefined,
    )
    // The pane saves "opened" itself; this only hides the badge and the hint at once.
    const onOpened = (): void => setFlags((f) => ({ opened: true, dismissed: f ? f.dismissed : false }))
    window.addEventListener(WORLD_OPENED_EVENT, onOpened)
    return () => { live = false; window.removeEventListener(WORLD_OPENED_EVENT, onOpened) }
  }, [])

  const isNew = flags !== null && !flags.opened
  const hint = isNew && !(flags as Flags).dismissed

  // Main's answer for each terminal asked about while the hint shows: asked once, and only an answer is kept.
  const active = useTerminalStore((s) => s.activeTerminalId)
  const [typable, setTypable] = useState<Record<string, boolean>>({})
  const asked = useRef(new Set<string>())
  const toldNo = useRef(new Set<string>())
  const ask = useCallback((id: string): void => {
    // Through a promise, so a build or a test bridge without the call keeps the whole hint.
    Promise.resolve().then(() => window.termpolis.worldTerminalTypable(id)).then(
      (res) => {
        if (!res.success) return
        if (res.data) toldNo.current.delete(id)
        else toldNo.current.add(id)
        setTypable((t) => ({ ...t, [id]: res.data }))
      },
      () => undefined,
    )
  }, [])
  useEffect(() => {
    if (!hint || active === null || asked.current.has(active)) return
    asked.current.add(active)
    ask(active)
  }, [hint, active, ask])
  // A no, asked again when that terminal's shell prints the ready mark (holdb-review M3).
  useEffect(() => {
    if (!hint) return
    const onReady = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail
      if (toldNo.current.has(id)) ask(id)
    }
    window.addEventListener(LUMOPOLIS_READY_EVENT, onReady)
    return () => window.removeEventListener(LUMOPOLIS_READY_EVENT, onReady)
  }, [hint, ask])

  const dismiss = (): void => {
    setFlags((f) => ({ ...(f as Flags), dismissed: true })) // the hint only shows once the flags have answered
    Promise.resolve().then(() => window.termpolis.worldSettingsSet({ worldHintDismissed: true })).catch(() => undefined)
  }

  return (
    <div className="px-1.5 py-1.5">
      <button
        type="button"
        onClick={() => openLumopolis()}
        title="Open Lumopolis on the active terminal's project (Ctrl+Shift+R)"
        data-testid="sidebar-lumopolis-entry"
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-[#d4d4d4] hover:text-white hover:bg-[#37373d]"
      >
        <i aria-hidden="true" className="fa-solid fa-earth-americas text-[#4fc1ff] w-4 text-center"></i>
        <span>Lumopolis</span>
        {isNew && (
          <span data-testid="sidebar-lumopolis-new" className="ml-auto rounded-full bg-[#0078d4] px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-white">New</span>
        )}
      </button>
      {hint && (
        <div role="note" data-testid="sidebar-lumopolis-hint" className="relative mt-1 rounded border border-[#0078d4]/60 bg-[#0078d4]/10 px-2.5 py-2 pr-7 text-xs leading-snug text-[#d4d4d4]">
          {/* Points up at the entry it describes. */}
          <span aria-hidden="true" className="absolute -top-1.5 left-4 h-3 w-3 rotate-45 border-l border-t border-[#0078d4]/60 bg-[#1f2d3a]"></span>
          {active !== null && typable[active] === false ? LUMOPOLIS_HINT_UNTYPED : LUMOPOLIS_HINT}
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss the Lumopolis hint"
            title="Dismiss"
            data-testid="sidebar-lumopolis-hint-dismiss"
            className="absolute right-1 top-1 rounded px-1 text-[#9ca3af] hover:text-white hover:bg-[#37373d]"
          ><i aria-hidden="true" className="fa-solid fa-xmark text-[11px]"></i></button>
        </div>
      )}
    </div>
  )
}
