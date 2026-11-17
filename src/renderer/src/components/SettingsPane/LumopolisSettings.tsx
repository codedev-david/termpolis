// Settings ▸ Lumopolis: the two Lumopolis settings, "Describe parts with AI" and "Read Lumopolis answers aloud". They live in main
// (world-settings.json) because main's labeller reads it; this switch reads it on mount and writes
// it on click, optimistically, putting the old value back if the write fails.
import { useEffect, useState } from 'react'

export function LumopolisSettings(): JSX.Element {
  // ON by default, as in main: only a stored `false` turns it off.
  const [labelling, setLabelling] = useState(true)
  // OFF by default, as in main: only a stored `true` turns it on.
  const [speak, setSpeak] = useState(false)

  useEffect(() => {
    let live = true
    window.termpolis.worldSettingsGet?.()
      ?.then((res) => { if (live && res.success) { setLabelling(res.data.worldLabelling); setSpeak(res.data.worldSpeakAnswers === true) } })
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

  const toggleSpeak = (): void => {
    const prev = speak
    const next = !prev
    setSpeak(next)
    const revert = (): void => setSpeak(prev)
    window.termpolis.worldSettingsSet?.({ worldSpeakAnswers: next })
      ?.then((res) => { if (res.success) setSpeak(res.data.worldSpeakAnswers === true); else revert() })
      ?.catch(revert)
  }

  return (
    <div className="flex flex-col gap-2" data-testid="lumopolis-settings-list">
      <p className="text-xs text-[#9ca3af] leading-relaxed" data-testid="lumopolis-cost-note">
        Describing parts and asking questions use tokens on your own agent account. Lumopolis shows an estimate after each one.
      </p>
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
      <div className="flex items-start gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]" data-testid="lumopolis-speak-settings">
        <button
          onClick={toggleSpeak}
          role="switch"
          aria-checked={speak}
          aria-label="Toggle reading Lumopolis answers aloud"
          data-testid="settings-world-speak-toggle"
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors mt-0.5 flex-shrink-0 ${
            speak ? 'bg-[#0078d4]' : 'bg-[#555]'
          }`}
        >
          <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
            speak ? 'translate-x-5' : 'translate-x-0.5'
          }`} />
        </button>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">
            <i className="fa-solid fa-volume-high text-[#4fc1ff] mr-1.5" aria-hidden="true"></i>
            Read Lumopolis answers aloud
          </span>
          <span className="text-xs text-[#9ca3af] leading-relaxed">
            When you ask Lumopolis a question, speak the answer with your computer&apos;s voice. Off by default.
          </span>
        </div>
      </div>
    </div>
  )
}
