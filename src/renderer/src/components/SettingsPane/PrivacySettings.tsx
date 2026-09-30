import { useEffect, useState } from 'react'
import { readConsentMirror, saveConsent, syncConsentFromMain } from '../../lib/sentry'
import { CRASH_DETAIL, CRASH_LABEL, USAGE_DETAIL, USAGE_LABEL } from '../Onboarding/PrivacyChoices'

// Settings ▸ General ▸ Privacy. A switch applies at once: main starts or stops sending that tier
// the moment it records the answer, so there is no relaunch to wait for.

function Switch({ on, label, testId, onClick }: { on: boolean; label: string; testId: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={on}
      data-testid={testId}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors mt-0.5 flex-shrink-0 ${
        on ? 'bg-[#0078d4]' : 'bg-[#555]'
      }`}
    >
      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
        on ? 'translate-x-4.5' : 'translate-x-0.5'
      }`} />
    </button>
  )
}

export function PrivacySettings({ onOpenTokenSavings }: { onOpenTokenSavings: () => void }) {
  // The renderer's mirror paints at once; main, which owns the answer, then confirms it.
  const [consent, setConsent] = useState(() => readConsentMirror())

  useEffect(() => {
    void syncConsentFromMain().then(v => { if (v) setConsent(v) })
  }, [])

  // Shown at once, then replaced by what main recorded (both off if main could not be told).
  const flip = async (tier: 'crash' | 'usage') => {
    const next = !consent[tier]
    setConsent(c => ({ ...c, [tier]: next }))
    setConsent(await saveConsent({ [tier]: next }))
  }

  return (
    <div className="border-t border-[#3c3c3c] pt-3 flex flex-col gap-2" data-testid="settings-privacy">
      <span className="text-sm font-medium">Privacy</span>
      <span className="text-xs text-[#9ca3af] leading-relaxed">
        Both are off unless you turn them on, and a change applies at once.
      </span>
      <div className="flex items-start gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]">
        <Switch on={consent.crash} label="Toggle crash reporting" testId="settings-crash-toggle" onClick={() => { void flip('crash') }} />
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">{CRASH_LABEL}</span>
          <span className="text-xs text-[#9ca3af] leading-relaxed">{CRASH_DETAIL}</span>
        </div>
      </div>
      <div className="flex items-start gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]">
        <Switch on={consent.usage} label="Toggle usage statistics" testId="settings-usage-toggle" onClick={() => { void flip('usage') }} />
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">{USAGE_LABEL}</span>
          <span className="text-xs text-[#9ca3af] leading-relaxed">{USAGE_DETAIL}</span>
        </div>
      </div>
      <span className="text-xs text-[#9ca3af] leading-relaxed">
        New Claude Code sessions go through a compression proxy on 127.0.0.1 by default, which forwards
        only to api.anthropic.com. To turn it off or see what it saves, open{' '}
        <button
          onClick={onOpenTokenSavings}
          className="underline text-[#22D3EE] hover:text-[#67e8f9] cursor-pointer"
          data-testid="settings-privacy-open-token-savings"
        >
          Settings → Token Savings
        </button>
        .
      </span>
      <div data-testid="settings-agent-integrations-slot" />
    </div>
  )
}
