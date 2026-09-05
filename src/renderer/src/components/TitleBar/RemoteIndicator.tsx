import React, { useEffect, useState } from 'react'
import type { RemoteStatusView } from '../../types'
import { setPendingSettingsTab } from '../../lib/settingsNav'
import { useTerminalStore } from '../../store/terminalStore'

function attachedCount(status: RemoteStatusView): number {
  return status.devices.filter((d) => d.attached).length
}

/**
 * A phone count in the title bar, shown only while a paired device is actually
 * connected.
 *
 * Its own component rather than lines in `TitleBar`, which is excluded from the
 * coverage gate as chrome with no logic. This has logic -- a subscription, a
 * count, and a jump into Settings -- and belongs where the gate can see it.
 *
 * Rendering nothing at zero is the feature, not a shortcut. A permanent
 * "0 phones" badge would make a remote session look like an ordinary one;
 * something appearing in the title bar is what makes "someone is attached to
 * this machine right now" hard to miss.
 */
export function RemoteIndicator(): JSX.Element | null {
  const [count, setCount] = useState(0)
  const setShowSettings = useTerminalStore((s) => s.setShowSettings)

  useEffect(() => {
    // The title bar renders in tests and tools that never load the remote
    // preload namespace. Absent means "no remote in this window", which is
    // exactly what rendering nothing already says.
    const api = window.remote
    if (!api) return
    let live = true
    void api.status().then((res) => {
      if (live && res.success) setCount(attachedCount(res.data))
    })
    const off = api.onStatus((status) => setCount(attachedCount(status)))
    return () => {
      live = false
      off()
    }
  }, [])

  if (count === 0) return null

  const label = count === 1 ? '1 phone connected' : `${count} phones connected`
  return (
    <button
      data-testid="remote-indicator"
      onClick={() => {
        setPendingSettingsTab('remote')
        setShowSettings(true)
      }}
      title={`${label} - open Remote settings`}
      aria-label={label}
      className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-[#7ee2a3] hover:bg-[#333] transition-colors"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true" fill="currentColor">
        <path d="M1.5 0h7A1.5 1.5 0 0 1 10 1.5v11A1.5 1.5 0 0 1 8.5 14h-7A1.5 1.5 0 0 1 0 12.5v-11A1.5 1.5 0 0 1 1.5 0Zm0 1.5v9h7v-9h-7ZM5 11.4a.85.85 0 1 0 0 1.7.85.85 0 0 0 0-1.7Z" />
      </svg>
      <span data-testid="remote-indicator-count">{count}</span>
    </button>
  )
}
