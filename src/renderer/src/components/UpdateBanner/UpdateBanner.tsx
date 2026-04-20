import { useEffect, useState } from 'react'

interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  releaseNotes?: string
  error?: string
  downloadedBytes?: number
  totalBytes?: number
}

// Thin banner above the status bar. Hidden unless an update has finished
// downloading and is waiting for the user to restart and install.
export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' })
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const updater = (window as any).updater
    if (!updater) return

    updater.getStatus().then((s: UpdateState) => s && setState(s)).catch(() => {})
    const unsub = updater.onState((next: UpdateState) => {
      setState(next)
      if (next.status === 'downloaded') setDismissed(false)
    })
    return () => unsub?.()
  }, [])

  if (dismissed) return null
  if (state.status !== 'downloaded') return null

  const handleRestart = async () => {
    const updater = (window as any).updater
    if (!updater) return
    await updater.quitAndInstall()
  }

  return (
    <div className="px-4 py-2 flex items-center justify-between text-sm bg-[#22D3EE]/10 border-t border-[#22D3EE]/30 text-[#22D3EE]">
      <div className="flex items-center gap-2">
        <i className="fa-solid fa-circle-arrow-down"></i>
        <span>
          Termpolis {state.version ? `v${state.version} ` : ''}is ready — restart to install.
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={handleRestart}
          className="text-xs px-3 py-1 rounded bg-[#22D3EE]/20 hover:bg-[#22D3EE]/30 font-medium"
        >
          Restart now
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="text-xs px-1.5 py-1 rounded hover:bg-white/10"
          aria-label="Dismiss update banner"
        >
          <i className="fa-solid fa-xmark"></i>
        </button>
      </div>
    </div>
  )
}
