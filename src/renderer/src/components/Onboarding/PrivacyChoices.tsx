import { useEffect, useState, type ReactNode } from 'react'

// The two telemetry tiers and the compression proxy, as the tour's last step and the consent
// review show them. The tiers are the caller's to hold and save (both off until the user ticks
// one). The proxy switch applies at once, as it does in Settings ▸ Token Savings: it is on by
// default and needs no answer to stay that way, so the point here is to say so, not to ask.

// One wording for each tier, wherever it is asked (tour, review, Settings ▸ General ▸ Privacy).
export const CRASH_LABEL = 'Send crash reports'
export const CRASH_DETAIL =
  'When something goes wrong, sends the error with its stack trace and the app events just before it, ' +
  'the app version and basic system details (OS, Electron version, CPU, memory, screen size), with your ' +
  'user name and home-folder paths removed.'
export const USAGE_LABEL = 'Send anonymous usage statistics'
export const USAGE_DETAIL =
  'Once a day, sends a one-line “launched” ping carrying only the Termpolis version, so we can count ' +
  'active installs — nothing about you, your files or your terminals.'

/** The proxy setting main holds, or null when main can't be asked. */
export async function readWireProxy(): Promise<boolean | null> {
  try {
    const res = await window.termpolis.tokenSavingsGetSettings()
    return res.success ? res.data.wireProxy !== false : null
  } catch {
    return null
  }
}

/** Turn the proxy on or off for new Claude Code sessions; resolves to what main now holds, or null. */
export async function writeWireProxy(on: boolean): Promise<boolean | null> {
  try {
    const res = await window.termpolis.tokenSavingsSetSettings({ wireProxy: on })
    return res.success ? res.data.wireProxy !== false : null
  } catch {
    return null
  }
}

function Choice({ label, testId, checked, onChange, children }: {
  label: string
  testId: string
  checked: boolean
  onChange: (on: boolean) => void
  children: ReactNode
}) {
  return (
    <label className="flex items-start gap-3 p-3 rounded-lg border border-[#3c3c3c] bg-[#1e1e1e] cursor-pointer hover:border-[#22D3EE]/40">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 accent-[#22D3EE]"
        aria-label={label}
        data-testid={testId}
      />
      <span className="flex flex-col gap-1">
        <span className="text-xs font-medium text-[#d4d4d4]">{label}</span>
        <span className="text-[11px] text-[#9ca3af]">{children}</span>
      </span>
    </label>
  )
}

export function PrivacyChoices({ crash, usage, onCrashChange, onUsageChange, slotTestId, children }: {
  crash: boolean
  usage: boolean
  onCrashChange: (on: boolean) => void
  onUsageChange: (on: boolean) => void
  /** Stable test id for the slot other features render into (agent integrations). */
  slotTestId: string
  children?: ReactNode
}) {
  // null until main answers; the switch stays disabled until then rather than guess.
  const [wireProxy, setWireProxy] = useState<boolean | null>(null)

  useEffect(() => { void readWireProxy().then(setWireProxy) }, [])

  const flipProxy = async () => {
    const now = await writeWireProxy(!wireProxy)
    if (now !== null) setWireProxy(now)
  }

  return (
    <div className="flex flex-col gap-3">
      <Choice label={CRASH_LABEL} testId="privacy-crash-toggle" checked={crash} onChange={onCrashChange}>
        {CRASH_DETAIL}
      </Choice>
      <Choice label={USAGE_LABEL} testId="privacy-usage-toggle" checked={usage} onChange={onUsageChange}>
        {USAGE_DETAIL}
      </Choice>

      <div className="flex flex-col gap-2 p-3 rounded-lg border border-[#3c3c3c] bg-[#1e1e1e]" data-testid="privacy-proxy">
        <span className="text-xs font-medium text-[#d4d4d4]">Compression proxy for Claude Code — on by default</span>
        <span className="text-[11px] text-[#9ca3af]">
          Each Claude Code session Termpolis launches sends its API requests through a small proxy on
          127.0.0.1, which shrinks tool-result text (large Read/Bash output, search dumps, MCP results) and
          pasted images, then forwards them to api.anthropic.com and nowhere else. What the agent writes or
          runs is forwarded byte-for-byte. If you have set your own <code>ANTHROPIC_BASE_URL</code>, an
          HTTP(S) proxy, or Bedrock, Vertex or Foundry, the proxy steps aside and leaves your route alone.
        </span>
        <label className="flex items-center gap-2 text-[11px] text-[#d4d4d4] cursor-pointer">
          <input
            type="checkbox"
            role="switch"
            aria-checked={wireProxy !== false}
            checked={wireProxy !== false}
            disabled={wireProxy === null}
            onChange={() => { void flipProxy() }}
            className="w-4 h-4 accent-[#22D3EE]"
            aria-label="Route new Claude Code sessions through the compression proxy"
            data-testid="privacy-proxy-toggle"
          />
          <span>
            Route new Claude Code sessions through the proxy{' '}
            <span className="text-[#9ca3af]">— also in Settings → Token Savings</span>
          </span>
        </label>
      </div>

      <div data-testid={slotTestId}>{children}</div>
    </div>
  )
}
