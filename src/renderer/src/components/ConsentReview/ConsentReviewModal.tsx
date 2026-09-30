import { useEffect, useState } from 'react'
import { saveConsent } from '../../lib/sentry'
import { PrivacyChoices } from '../Onboarding/PrivacyChoices'

// Asked once, at launch, of someone who has seen the tour but whose telemetry answer predates what
// the tiers send now, or who has no answer on record (a first run answers in the tour's last step
// instead). Until they answer main sends nothing, so both tiers start off here too. Save and Not
// now both record the values shown: either way it is an answer, and only a new consent version
// asks again.

/** Whether main wants the user asked. False when main can't be asked: nothing is sent then either. */
export async function consentNeedsReview(): Promise<boolean> {
  try {
    const res = await window.termpolis.telemetryGetConsent()
    return res.success && res.data.needsReview
  } catch {
    return false
  }
}

export function ConsentReviewModal({ onDone }: { onDone: () => void }) {
  const [crash, setCrash] = useState(false)
  const [usage, setUsage] = useState(false)

  const answer = () => {
    void saveConsent({ crash, usage })
    onDone()
  }

  // Re-bound every render so Escape (as Not now) records the current choices.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') answer() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80" data-testid="consent-review-modal">
      <div
        className="bg-[#252526] border border-[#3c3c3c] rounded-xl shadow-2xl w-[600px] max-h-[95vh] overflow-y-auto p-7 flex flex-col gap-4"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="consent-review-title"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#22D3EE]/15 flex items-center justify-center">
            <i className="fa-solid fa-shield-halved text-[#22D3EE]"></i>
          </div>
          <div>
            <h2 id="consent-review-title" className="text-lg font-semibold text-[#d4d4d4]">Review your privacy choices</h2>
            <p className="text-xs text-[#9ca3af]">What Termpolis can send has changed, so it asks again, once.</p>
          </div>
        </div>

        <p className="text-xs text-[#bbb] leading-relaxed">
          Crash reports and usage statistics are now separate choices, and both are off until you
          tick them: until you answer, nothing is sent. Change either one any time in
          <strong> Settings → General → Privacy</strong>.
        </p>

        <PrivacyChoices
          crash={crash}
          usage={usage}
          onCrashChange={setCrash}
          onUsageChange={setUsage}
          slotTestId="consent-review-agent-integrations-slot"
        />

        <div className="flex items-center justify-between border-t border-[#3c3c3c] pt-4">
          <a
            href="https://github.com/codedev-david/termpolis/blob/main/PRIVACY.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-[#9ca3af] underline hover:text-[#22D3EE]"
          >
            Privacy policy
          </a>
          <div className="flex items-center gap-2">
            <button
              onClick={answer}
              className="px-4 py-1.5 text-sm rounded-lg border border-[#3c3c3c] text-[#d4d4d4] hover:bg-[#37373d]"
            >
              Not now
            </button>
            <button
              onClick={answer}
              className="px-5 py-1.5 text-sm rounded-lg bg-[#22D3EE]/20 text-[#22D3EE] hover:bg-[#22D3EE]/30 font-medium"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
