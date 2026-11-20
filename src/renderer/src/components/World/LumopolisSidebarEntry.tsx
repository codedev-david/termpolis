// The sidebar's labelled way into Lumopolis: the globe and the word, with a New badge until Lumopolis has
// been opened once, and under it a one-time hint that names every way in. Both are remembered in the
// Lumopolis settings (worldSettings.ts: worldOpened, worldHintDismissed), not in this browser's storage,
// so they stay gone across updates and profiles. Nothing shows until the settings have answered, so a
// returning user never sees the badge flash. Small and engine-free: the sidebar is in App's main chunk.
import { useEffect, useState } from 'react'
import { openLumopolis, WORLD_OPENED_EVENT } from './worldOpen'

export const LUMOPOLIS_HINT = 'Lumopolis: see any project as a 3D city. Open it here, click the globe on a terminal, or type lumopolis.'

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

  const dismiss = (): void => {
    setFlags((f) => ({ ...(f as Flags), dismissed: true })) // the hint only shows once the flags have answered
    Promise.resolve().then(() => window.termpolis.worldSettingsSet({ worldHintDismissed: true })).catch(() => undefined)
  }

  const isNew = flags !== null && !flags.opened
  const hint = isNew && !(flags as Flags).dismissed
  return (
    <div className="px-1.5 py-1.5">
      <button
        type="button"
        onClick={() => openLumopolis()}
        title="Open Lumopolis on the active terminal's project (Ctrl+Shift+R)"
        data-testid="sidebar-lumopolis-entry"
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-[#d4d4d4] hover:text-white hover:bg-[#37373d]"
      >
        <i className="fa-solid fa-earth-americas text-[#4fc1ff] w-4 text-center"></i>
        <span>Lumopolis</span>
        {isNew && (
          <span data-testid="sidebar-lumopolis-new" className="ml-auto rounded-full bg-[#0078d4] px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-white">New</span>
        )}
      </button>
      {hint && (
        <div role="note" data-testid="sidebar-lumopolis-hint" className="relative mt-1 rounded border border-[#0078d4]/60 bg-[#0078d4]/10 px-2.5 py-2 pr-7 text-xs leading-snug text-[#d4d4d4]">
          {/* Points up at the entry it describes. */}
          <span aria-hidden="true" className="absolute -top-1.5 left-4 h-3 w-3 rotate-45 border-l border-t border-[#0078d4]/60 bg-[#1f2d3a]"></span>
          {LUMOPOLIS_HINT}
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss the Lumopolis hint"
            title="Dismiss"
            data-testid="sidebar-lumopolis-hint-dismiss"
            className="absolute right-1 top-1 rounded px-1 text-[#9ca3af] hover:text-white hover:bg-[#37373d]"
          ><i className="fa-solid fa-xmark text-[11px]"></i></button>
        </div>
      )}
    </div>
  )
}
