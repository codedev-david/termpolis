import { useEffect, useState } from 'react'
import { useTerminalStore } from '../../store/terminalStore'

// Guided setup for Groq cloud transcription. Walks the user through the egress
// disclosure (consent), getting a free API key, the recommended Zero-Data-
// Retention hardening, and pasting + validating the key. The key is sent
// one-way into the MAIN process (OS keychain) — this modal never stores it and
// only ever sees a masked hint.

const GROQ_KEYS_URL = 'https://console.groq.com/keys'
// Groq's "Your Data" doc explains Zero Data Retention and how to enable it in
// Data Controls — the recommended hardened setup (nothing retained at all).
const GROQ_ZDR_URL = 'https://console.groq.com/docs/your-data'

export function GroqConnectModal({ onClose }: { onClose: () => void }) {
  const setVoiceSettings = useTerminalStore((s) => s.setVoiceSettings)
  const [consent, setConsent] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [hint, setHint] = useState('')

  useEffect(() => {
    window.termpolis
      .groqGetKeyStatus()
      .then((res) => {
        if (res?.success && res.data) {
          setConnected(res.data.connected)
          setHint(res.data.hint)
        }
      })
      .catch(() => {
        /* leave as disconnected */
      })
  }, [])

  const openExternal = (url: string) => {
    window.termpolis.openExternal(url).catch(() => {})
  }

  const connect = async () => {
    const key = apiKey.trim()
    if (!consent || !key || busy) return
    setBusy(true)
    setError(null)
    try {
      const v = await window.termpolis.groqValidateKey(key)
      if (!v?.success || !v.data?.ok) {
        const why = v?.data?.error || v?.error
        setError(why ? `Couldn't verify that key: ${why}` : "Couldn't verify that API key. Double-check it and try again.")
        return
      }
      const set = await window.termpolis.groqSetApiKey(key)
      if (!set?.success) {
        setError(set?.error || 'Failed to store the key.')
        return
      }
      setConnected(set.data?.connected ?? true)
      setHint(set.data?.hint ?? '')
      setApiKey('')
      // Record consent so the rest of the app knows the disclosure was accepted.
      setVoiceSettings({ consentAccepted: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await window.termpolis.groqClearApiKey()
      setConnected(res?.data?.connected ?? false)
      setHint(res?.data?.hint ?? '')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const canConnect = consent && apiKey.trim().length > 0 && !busy

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 animate-fadeIn" data-testid="groq-connect-modal">
      <div className="bg-[#252526] rounded-lg shadow-xl border border-[#3c3c3c] w-[520px] max-h-[88vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#3c3c3c]">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <i className="fa-solid fa-bolt text-[#f55036]"></i>
            Connect Groq Turbo
          </h2>
          <button onClick={onClose} aria-label="Close" className="text-[#9ca3af] hover:text-white text-lg px-1">
            &times;
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4 text-sm text-[#d4d4d4]">
          {connected ? (
            <div data-testid="groq-connected-status" className="flex flex-col gap-2 p-3 rounded border border-[#2d5a3d] bg-[#1d2a22]">
              <div className="flex items-center gap-2 text-[#7ee2a3]">
                <i className="fa-solid fa-circle-check"></i>
                <span className="font-medium">Connected to Groq</span>
                {hint && <span className="font-mono text-xs text-[#9ca3af]">({hint})</span>}
              </div>
              <p className="text-xs text-[#9ca3af]">
                Your key is stored in your OS keychain (encrypted at rest) and used only in the background to transcribe
                what you dictate. It is never written to settings or logs.
              </p>
              <div className="flex items-center gap-2 mt-1">
                <button
                  data-testid="groq-disconnect-btn"
                  onClick={disconnect}
                  disabled={busy}
                  className="px-3 py-1 text-xs rounded bg-[#3c3c3c] hover:bg-[#4a4a4a] text-[#e0e0e0] disabled:opacity-60"
                >
                  Disconnect &amp; remove key
                </button>
                <button onClick={() => openExternal(GROQ_ZDR_URL)} className="text-xs text-[#22D3EE] hover:underline">
                  Review Groq data settings ↗
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* ① Disclosure + consent */}
              <section className="flex flex-col gap-1.5">
                <h3 className="font-medium text-[#e0e0e0]">1. Heads-up: audio leaves your machine</h3>
                <p className="text-xs text-[#9ca3af] leading-relaxed">
                  Turbo sends each clip you dictate to Groq's API for transcription. By default Groq does not train on or
                  retain your audio; you can turn on <strong>Zero Data Retention</strong> so nothing is kept at all. This is
                  the same trust model as the AI agents you already send prompts to.
                </p>
                <label className="flex items-start gap-2 text-xs cursor-pointer mt-1">
                  <input
                    data-testid="groq-consent-checkbox"
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>I understand my recorded audio is sent to Groq for transcription, and I accept this.</span>
                </label>
              </section>

              {/* ② Get a key */}
              <section className="flex flex-col gap-1.5">
                <h3 className="font-medium text-[#e0e0e0]">2. Get a free Groq API key</h3>
                <ol className="text-xs text-[#9ca3af] leading-relaxed list-decimal ml-4 flex flex-col gap-0.5">
                  <li>Open the Groq Console and sign up (free).</li>
                  <li>Create an API key under <span className="font-mono">API Keys</span>.</li>
                  <li>Recommended: enable <strong>Zero Data Retention</strong> in Data Controls.</li>
                </ol>
                <div className="flex items-center gap-3 mt-1">
                  <button
                    data-testid="groq-open-console"
                    onClick={() => openExternal(GROQ_KEYS_URL)}
                    className="px-3 py-1 text-xs rounded bg-[#0e639c] hover:bg-[#1177bb] text-white"
                  >
                    Open Groq Console ↗
                  </button>
                  <button data-testid="groq-open-zdr" onClick={() => openExternal(GROQ_ZDR_URL)} className="text-xs text-[#22D3EE] hover:underline">
                    How to enable Zero Data Retention ↗
                  </button>
                </div>
              </section>

              {/* ③ Paste + connect */}
              <section className="flex flex-col gap-1.5">
                <h3 className="font-medium text-[#e0e0e0]">3. Paste your API key</h3>
                <input
                  data-testid="groq-key-input"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="gsk_…"
                  autoComplete="off"
                  spellCheck={false}
                  className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm font-mono focus:outline-none focus:border-[#0078d4]"
                />
                {error && (
                  <p data-testid="groq-error" className="text-xs text-[#ff8a8a]">
                    {error}
                  </p>
                )}
                <div className="flex items-center gap-2 mt-1">
                  <button
                    data-testid="groq-connect-btn"
                    onClick={connect}
                    disabled={!canConnect}
                    className="px-4 py-1 text-xs rounded bg-[#0078d4] hover:bg-[#106ebe] text-white disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {busy ? 'Verifying…' : 'Connect'}
                  </button>
                  <span className="text-[10px] text-[#6b7280]">Validated against Groq, then stored in your OS keychain.</span>
                </div>
              </section>
            </>
          )}
        </div>

        <div className="flex justify-end px-5 py-3 border-t border-[#3c3c3c]">
          <button onClick={onClose} className="px-4 py-1.5 text-sm rounded bg-[#0078d4] hover:bg-[#106ebe] text-white">
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
