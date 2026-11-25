// Settings ▸ Lumopolis: the agent Lumopolis runs on, "Describe parts with AI", "Read Lumopolis answers aloud" and "Show frame rate". They live in main
// (world-settings.json) because main's labeller reads it; this switch reads it on mount and writes
// it on click, optimistically, putting the old value back if the write fails. A read or a change that failed says so in
// its own words (M4), beside what failed; main has logged why.
import { useEffect, useState } from 'react'
import { FRAME_RATE_EVENT } from '../World/worldOpen'

/** PENDING SIGN-OFF (M4): the settings could not be read; main's world:settings-get answers the same words. */
export const SETTINGS_LOAD_FAILED = "Lumopolis couldn't load its settings. Try again."
/** PENDING SIGN-OFF (#65): a change did not go through and was put back; main's world:settings-set answers the same. */
export const SETTINGS_CHANGE_FAILED = "Lumopolis couldn't change that setting. Try again."

type Row = 'agent' | 'labelling' | 'speak' | 'ci' | 'rate'

/** The line under a setting whose change did not go through. */
function ChangeFailed({ shown }: { shown: boolean }): JSX.Element | null {
  return shown ? <span role="alert" className="text-xs text-[#f48771]" data-testid="lumopolis-settings-failed">{SETTINGS_CHANGE_FAILED}</span> : null
}

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
  // ON by default, as in main: only a stored `false` turns it off. Reading CI runs the `gh` command,
  // which uses its stored GitHub login.
  const [ci, setCi] = useState(true)
  const [agent, setAgent] = useState<WorldAgent>('claude')
  // The settings could not be read: they show their defaults, with a line to read them again.
  const [loadFailed, setLoadFailed] = useState(false)
  // Bumped by Try again, to read the settings again.
  const [reads, setReads] = useState(0)
  // The setting whose last change did not go through, said beside it until a change goes through.
  const [failedRow, setFailedRow] = useState<Row | null>(null)
  // OFF by default, as in main: only a stored `true` turns it on. An open map hears each change at once.
  const [rate, setRateState] = useState(false)
  const setRate = (v: boolean): void => {
    setRateState(v)
    window.dispatchEvent(new CustomEvent(FRAME_RATE_EVENT, { detail: v }))
  }

  useEffect(() => {
    let live = true
    const failed = (): void => { if (live) setLoadFailed(true) }
    window.termpolis.worldSettingsGet?.()
      ?.then((res) => {
        if (!live) return
        if (!res.success) { failed(); return }
        setLabelling(res.data.worldLabelling); setSpeak(res.data.worldSpeakAnswers === true); setCi(res.data.worldCiResults !== false); setRateState(res.data.showFrameRate === true); if (isWorldAgent(res.data.worldAgent)) setAgent(res.data.worldAgent)
      })
      ?.catch(failed)
    return () => { live = false }
  }, [reads])

  const retryLoad = (): void => { setLoadFailed(false); setReads((n) => n + 1) }

  /** Writes one change: `took` keeps what main stored and says whether it did; a refusal or a throw calls `revert`. */
  const change = (row: Row, patch: Parameters<NonNullable<typeof window.termpolis.worldSettingsSet>>[0], revert: () => void, took: (data: { worldLabelling: boolean; worldSpeakAnswers?: boolean; worldCiResults?: boolean; showFrameRate?: boolean; worldAgent?: string }) => boolean): void => {
    setFailedRow(null)
    const back = (): void => { revert(); setFailedRow(row) }
    window.termpolis.worldSettingsSet?.(patch)
      ?.then((res) => { if (!res.success || !took(res.data)) back() })
      ?.catch(back)
  }

  const toggle = (): void => {
    const prev = labelling
    setLabelling(!prev)
    change('labelling', { worldLabelling: !prev }, () => setLabelling(prev), (d) => { setLabelling(d.worldLabelling); return true })
  }

  const toggleSpeak = (): void => {
    const prev = speak
    setSpeak(!prev)
    change('speak', { worldSpeakAnswers: !prev }, () => setSpeak(prev), (d) => { setSpeak(d.worldSpeakAnswers === true); return true })
  }

  const toggleCi = (): void => {
    const prev = ci
    setCi(!prev)
    change('ci', { worldCiResults: !prev }, () => setCi(prev), (d) => { setCi(d.worldCiResults !== false); return true })
  }

  const toggleRate = (): void => {
    const prev = rate
    setRate(!prev)
    change('rate', { showFrameRate: !prev }, () => setRate(prev), (d) => { setRate(d.showFrameRate === true); return true })
  }

  const chooseAgent = (next: string): void => {
    if (!isWorldAgent(next)) return
    const prev = agent
    setAgent(next)
    change('agent', { worldAgent: next }, () => setAgent(prev), (d) => {
      if (!isWorldAgent(d.worldAgent)) return false
      setAgent(d.worldAgent)
      return true
    })
  }

  return (
    <div className="flex flex-col gap-2" data-testid="lumopolis-settings-list">
      {loadFailed && (
        <div role="alert" className="flex items-center gap-2 text-xs text-[#f48771]" data-testid="lumopolis-settings-load-failed">
          <span>{SETTINGS_LOAD_FAILED}</span>
          <button
            type="button"
            onClick={retryLoad}
            className="px-2 py-0.5 rounded bg-[#0078d4] hover:bg-[#106ebe] text-white"
          >Try again</button>
        </div>
      )}
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
          <ChangeFailed shown={failedRow === 'agent'} />
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
          <ChangeFailed shown={failedRow === 'labelling'} />
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
          <ChangeFailed shown={failedRow === 'speak'} />
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
            passed there shows as verified. <code>gh</code> uses the GitHub login it already has. It runs only for a project with a
            GitHub remote, when <code>gh</code> is installed. On by default; turn it off and Lumopolis never runs <code>gh</code>.
          </span>
          <ChangeFailed shown={failedRow === 'ci'} />
        </div>
      </div>
      <div className="flex items-start gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]" data-testid="lumopolis-frame-rate-settings">
        <button
          onClick={toggleRate}
          role="switch"
          aria-checked={rate}
          aria-label="Toggle the Lumopolis frame rate readout"
          data-testid="settings-world-frame-rate-toggle"
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors mt-0.5 flex-shrink-0 ${
            rate ? 'bg-[#0078d4]' : 'bg-[#555]'
          }`}
        >
          <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
            rate ? 'translate-x-5' : 'translate-x-0.5'
          }`} />
        </button>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">
            <i className="fa-solid fa-gauge-high text-[#4fc1ff] mr-1.5" aria-hidden="true"></i>
            Show frame rate
          </span>
          <span className="text-xs text-[#9ca3af] leading-relaxed">
            Shows how smoothly the 3D map draws in a corner of the pane: frames per second, the slow-frame time and the
            graphics level. Off by default.
          </span>
          <ChangeFailed shown={failedRow === 'rate'} />
        </div>
      </div>
    </div>
  )
}
