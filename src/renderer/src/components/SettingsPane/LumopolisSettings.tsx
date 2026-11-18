// Settings ▸ Lumopolis: the agent Lumopolis runs on, "Describe parts with AI" and "Read Lumopolis answers aloud". They live in main
// (world-settings.json) because main's labeller reads it; this switch reads it on mount and writes
// it on click, optimistically, putting the old value back if the write fails.
import { useEffect, useState } from 'react'

type WorldAgent = 'claude' | 'codex' | 'gemini'
const AGENT_CHOICES: { id: WorldAgent; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'gemini', label: 'Gemini CLI' },
]
const isWorldAgent = (v: unknown): v is WorldAgent => AGENT_CHOICES.some((c) => c.id === v)

export function LumopolisSettings(): JSX.Element {
  // ON by default, as in main: only a stored `false` turns it off.
  const [labelling, setLabelling] = useState(true)
  // OFF by default, as in main: only a stored `true` turns it on.
  const [speak, setSpeak] = useState(false)
  // OFF by default, as in main: reading CI runs the `gh` command, which uses its stored GitHub login.
  const [ci, setCi] = useState(false)
  const [agent, setAgent] = useState<WorldAgent>('claude')

  useEffect(() => {
    let live = true
    window.termpolis.worldSettingsGet?.()
      ?.then((res) => { if (live && res.success) { setLabelling(res.data.worldLabelling); setSpeak(res.data.worldSpeakAnswers === true); setCi(res.data.worldCiResults === true); if (isWorldAgent(res.data.worldAgent)) setAgent(res.data.worldAgent) } })
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

  const toggleCi = (): void => {
    const prev = ci
    const next = !prev
    setCi(next)
    const revert = (): void => setCi(prev)
    window.termpolis.worldSettingsSet?.({ worldCiResults: next })
      ?.then((res) => { if (res.success) setCi(res.data.worldCiResults === true); else revert() })
      ?.catch(revert)
  }

  const chooseAgent = (next: string): void => {
    if (!isWorldAgent(next)) return
    const prev = agent
    setAgent(next)
    const revert = (): void => setAgent(prev)
    window.termpolis.worldSettingsSet?.({ worldAgent: next })
      ?.then((res) => { if (res.success && isWorldAgent(res.data.worldAgent)) setAgent(res.data.worldAgent); else revert() })
      ?.catch(revert)
  }

  return (
    <div className="flex flex-col gap-2" data-testid="lumopolis-settings-list">
      <p className="text-xs text-[#9ca3af] leading-relaxed" data-testid="lumopolis-cost-note">
        Describing parts and asking questions use tokens on your own agent account. Lumopolis shows an estimate after each one.
      </p>
      <div className="flex items-start gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]" data-testid="lumopolis-agent-settings">
        <div className="flex flex-col gap-1">
          <label htmlFor="settings-world-agent" className="text-sm font-medium">
            <i className="fa-solid fa-robot text-[#4fc1ff] mr-1.5" aria-hidden="true"></i>
            Lumopolis agent
          </label>
          <span className="text-xs text-[#9ca3af] leading-relaxed">
            The agent that answers your questions, drafts designs and describes parts. It uses its model from Settings, Default Models, and goes through the same token saving and memory as your terminals.
          </span>
          <select
            id="settings-world-agent"
            data-testid="settings-world-agent"
            value={agent}
            onChange={(e) => chooseAgent(e.target.value)}
            className="mt-1 w-48 px-2 py-1 text-sm bg-[#1e1e1e] border border-[#3c3c3c] rounded"
          >
            {AGENT_CHOICES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          {agent === 'gemini' && (
            <span className="text-xs text-[#d7ba7d]" data-testid="lumopolis-gemini-note">Gemini: not compressed (no proxy route)</span>
          )}
        </div>
      </div>
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
            Lumopolis: Describe parts with AI (uses your agent&apos;s cheapest model)
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
      <div className="flex items-start gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]" data-testid="lumopolis-ci-settings">
        <button
          onClick={toggleCi}
          role="switch"
          aria-checked={ci}
          aria-label="Toggle reading CI results with GitHub CLI"
          data-testid="settings-world-ci-toggle"
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors mt-0.5 flex-shrink-0 ${
            ci ? 'bg-[#0078d4]' : 'bg-[#555]'
          }`}
        >
          <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
            ci ? 'translate-x-5' : 'translate-x-0.5'
          }`} />
        </button>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">
            <i className="fa-solid fa-circle-check text-[#4fc1ff] mr-1.5" aria-hidden="true"></i>
            Read CI results with GitHub CLI
          </span>
          <span className="text-xs text-[#9ca3af] leading-relaxed">
            Lumopolis runs the <code>gh</code> command to read your project&apos;s latest CI result, so a part whose tests
            passed there shows as verified. <code>gh</code> uses the GitHub login it already has. Off by default.
          </span>
        </div>
      </div>
    </div>
  )
}
