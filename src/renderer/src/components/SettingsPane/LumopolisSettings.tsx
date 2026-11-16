// Settings ▸ Lumopolis: the one Lumopolis setting, "Describe parts with AI". It lives in main
// (world-settings.json) because main's labeller reads it; this switch reads it on mount and writes
// it on click, optimistically, putting the old value back if the write fails.
import { useEffect, useState } from 'react'

export function LumopolisSettings(): JSX.Element {
  // ON by default, as in main: only a stored `false` turns it off.
  const [labelling, setLabelling] = useState(true)

  useEffect(() => {
    let live = true
    window.termpolis.worldSettingsGet?.()
      ?.then((res) => { if (live && res.success) setLabelling(res.data.worldLabelling) })
      ?.catch(() => undefined)
    return () => { live = false }
  }, [])

  const toggle = (): void => {
    const prev = labelling
    const next = !prev
    setLabelling(next)
    const revert = (): void => setLabelling(prev)
    window.termpolis.worldSettingsSet?.({ worldLabelling: next })
      ?.then((res) => { if (res.success) setLabelling(res.data.worldLabelling); else revert() })
      ?.catch(revert)
  }

  return (
    <div className="flex items-start gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]" data-testid="lumopolis-settings">
      <button
        onClick={toggle}
        role="switch"
        aria-checked={labelling}
        aria-label="Toggle describing Lumopolis parts with AI"
        data-testid="settings-world-labelling-toggle"
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors mt-0.5 flex-shrink-0 ${
          labelling ? 'bg-[#0078d4]' : 'bg-[#555]'
        }`}
      >
        <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
          labelling ? 'translate-x-5' : 'translate-x-0.5'
        }`} />
      </button>
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">
          <i className="fa-solid fa-earth-americas text-[#4fc1ff] mr-1.5" aria-hidden="true"></i>
          Lumopolis: Describe parts with AI (uses Claude&apos;s cheapest model, Haiku)
        </span>
        <span className="text-xs text-[#9ca3af] leading-relaxed">
          Names and explains the districts, buildings and connections on your project&apos;s Lumopolis
          map in plain words. Turn it off and the map still draws, with names taken from the code.
        </span>
      </div>
    </div>
  )
}
