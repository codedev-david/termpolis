import { useEffect, useState, useCallback } from 'react'
import type { MemoryLockReason, MemorySearchResult, MemorySyncStatus } from '../../types'
import { CodeGraphPanel } from './CodeGraphPanel'

// Why memory is LOCKED, in words. Every one of these is recoverable without losing anything, which is
// why the panel says what would bring the memories back before it offers the way past.
const LOCK_COPY: Record<MemoryLockReason, string> = {
  'keychain-unavailable':
    "The OS keychain that protects this computer's memory key isn't available. If it comes back (unlock your keyring, or sign in again), restart Termpolis and every memory returns.",
  'key-unreadable':
    "This computer couldn't unwrap its memory key — this can happen after a password reset or when a profile moves to another computer. If the original account or profile comes back, restart Termpolis and every memory returns.",
  'key-invalid': 'The memory key file on this computer is damaged, so your memories cannot be opened with it.',
  'key-mismatch': "The memory key on this computer doesn't match the memories on disk, so they cannot be opened with it.",
}
const lockCopy = (reason: MemoryLockReason | null | undefined): string =>
  (reason && LOCK_COPY[reason]) || "Termpolis can't open your memories with the key on this computer."

interface Props {
  onClose: () => void
  activeTerminalId: string | null
  activeCwd: string
}

// Bracketed-paste markers so a multi-line primer is treated as one paste by the
// receiving agent's TUI, not a flurry of Enter-submitted lines.
const BP_START = '\x1b[200~'
const BP_END = '\x1b[201~'
function wrapAsBracketedPaste(text: string): string {
  return BP_START + text.replace(/\r\n|\r|\n/g, '\r') + BP_END
}

export function Memory({ onClose, activeTerminalId, activeCwd }: Props): JSX.Element {
  const [stats, setStats] = useState<{ count: number; capacity: number } | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MemorySearchResult[]>([])
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [sync, setSync] = useState<MemorySyncStatus | null>(null)
  const [confirmNewKey, setConfirmNewKey] = useState(false)

  const refreshStats = useCallback(async () => {
    const res = await window.termpolis.memoryStats()
    if (res.success && res.data) setStats(res.data)
  }, [])

  const refreshSync = useCallback(async () => {
    const res = await window.termpolis.memorySyncStatus?.()
    if (res?.success && res.data) setSync(res.data)
  }, [])

  useEffect(() => {
    void refreshStats()
    void refreshSync()
  }, [refreshStats, refreshSync])

  // Only reachable while a sync session from before this version is still running: turning sync ON is
  // refused (it can lock or overwrite a brain), and turning it off just reopens this computer's own
  // memory exactly as it was left.
  const disableSync = useCallback(async () => {
    setBusy(true)
    try {
      const res = await window.termpolis.memorySetSyncDir(null)
      if (res.success && res.data) {
        setSync(res.data)
        setStatus("Sync turned off — this computer's own memory is back, exactly as it was.")
        await refreshStats()
      }
    } finally {
      setBusy(false)
    }
  }, [refreshStats])

  // The only way past a LOCKED brain, and deliberately a two-step one: it is the user's decision, never
  // the app's. Nothing is deleted — the old key is kept and retried at every launch.
  const startNewKey = useCallback(async () => {
    setBusy(true)
    try {
      const res = await window.termpolis.memoryStartNewKey()
      if (res.success && res.data) {
        setSync(res.data)
        setConfirmNewKey(false)
        setStatus('New memory key started — new memories are saved again. Older ones stay on disk under the old key.')
        await refreshStats()
      } else {
        setStatus(res.error || 'Could not start a new memory key.')
      }
    } finally {
      setBusy(false)
    }
  }, [refreshStats])

  const doSearch = useCallback(async () => {
    const q = query.trim()
    if (!q) return
    setBusy(true)
    try {
      const res = await window.termpolis.memorySearch({ query: q, limit: 10 })
      const hits = res.success && res.data ? res.data : []
      setResults(hits)
      setStatus(res.success ? `${hits.length} result${hits.length === 1 ? '' : 's'}` : 'Search failed')
    } finally {
      setBusy(false)
    }
  }, [query])

  const ingestConversations = useCallback(async () => {
    setBusy(true)
    setStatus('Indexing past conversations…')
    try {
      const res = await window.termpolis.memoryIngestConversations()
      setStatus(res.success && res.data ? `Conversations: +${res.data.chunksWritten} new chunks` : res.error || 'Ingest failed')
      await refreshStats()
    } finally {
      setBusy(false)
    }
  }, [refreshStats])

  const ingestCode = useCallback(async () => {
    if (!activeCwd) {
      setStatus('Open a terminal in a repo first.')
      return
    }
    setBusy(true)
    setStatus('Indexing this repo…')
    try {
      const res = await window.termpolis.memoryIngestCode(activeCwd)
      setStatus(
        res.success && res.data
          ? `Code: +${res.data.chunksWritten} chunks from ${res.data.filesScanned} files`
          : res.error || 'Ingest failed',
      )
      await refreshStats()
    } finally {
      setBusy(false)
    }
  }, [activeCwd, refreshStats])

  const injectPrimer = useCallback(async () => {
    const q = query.trim()
    if (!q) {
      setStatus('Type what you are working on, then inject.')
      return
    }
    if (!activeTerminalId) {
      setStatus('No active terminal to inject into.')
      return
    }
    setBusy(true)
    try {
      const res = await window.termpolis.memoryBuildPrimer(q)
      if (res.success && res.data) {
        window.termpolis.writeToTerminal(activeTerminalId, wrapAsBracketedPaste(res.data))
        setStatus('Primer injected into the active terminal.')
      } else {
        setStatus('No relevant memory found for that query.')
      }
    } finally {
      setBusy(false)
    }
  }, [query, activeTerminalId])

  return (
    <div
      className="flex flex-col h-full border-l border-[#3c3c3c] bg-[#252526] select-none"
      style={{ width: 300, minWidth: 300, maxWidth: 300 }}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#3c3c3c]">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[#888]">Memory</span>
        <button
          className="text-[#888] hover:text-[#d4d4d4] text-xs cursor-pointer"
          onClick={onClose}
          title="Close (Ctrl+Shift+M)"
          aria-label="Close memory panel"
        >
          <i className="fa-solid fa-xmark"></i>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto text-[12px] px-3 py-2 flex flex-col gap-3">
        {sync?.ownLocked && (
          <div className="border border-[#FFB74D] rounded px-2 py-2 flex flex-col gap-1" role="alert" data-testid="memory-locked">
            <div className="text-[11px] text-[#FFB74D] font-semibold">
              <i className="fa-solid fa-lock mr-1"></i>Memory is locked — nothing new is being saved
            </div>
            <div className="text-[11px] text-[#bbb] leading-relaxed">{lockCopy(sync.lockReason)}</div>
            {confirmNewKey ? (
              <div className="flex flex-col gap-1 mt-1">
                <div className="text-[11px] text-[#d4d4d4] leading-relaxed">
                  A new key lets Termpolis save memories again. <strong>Older memories stay on disk, unreadable until the old key works again.</strong>{' '}
                  The old key is kept and tried at every launch, so if it comes back, they come back too. Nothing is deleted.
                </div>
                <div className="flex gap-1">
                  <button
                    className="flex-1 bg-[#FFB74D] hover:opacity-90 text-[#2a1a00] rounded px-2 py-1 font-medium cursor-pointer disabled:opacity-50"
                    onClick={() => void startNewKey()}
                    disabled={busy}
                    data-testid="memory-new-key-confirm"
                  >Start a new key</button>
                  <button
                    className="flex-1 bg-[#2d2d30] hover:bg-[#37373a] border border-[#3c3c3c] rounded px-2 py-1 text-[#d4d4d4] cursor-pointer disabled:opacity-50"
                    onClick={() => setConfirmNewKey(false)}
                    disabled={busy}
                    data-testid="memory-new-key-cancel"
                  >Cancel</button>
                </div>
              </div>
            ) : (
              <button
                className="bg-[#2d2d30] hover:bg-[#37373a] border border-[#3c3c3c] rounded px-2 py-1 text-[#d4d4d4] cursor-pointer disabled:opacity-50 text-left"
                onClick={() => setConfirmNewKey(true)}
                disabled={busy}
                data-testid="memory-new-key"
              >Start a new memory key…</button>
            )}
          </div>
        )}

        <div className="text-[#bbb]">
          {stats ? (
            <span>
              <strong className="text-[#22D3EE]">{stats.count.toLocaleString()}</strong> chunks remembered{' '}
              <span className="text-[#666]">/ {stats.capacity.toLocaleString()} hot</span>
            </span>
          ) : (
            'Loading…'
          )}
        </div>

        <div className="flex flex-col gap-1">
          <input
            className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-[#d4d4d4] text-[12px] outline-hidden focus:border-[#22D3EE]"
            placeholder="What are you working on?"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doSearch()
            }}
            aria-label="Memory query"
          />
          <div className="flex gap-1">
            <button
              className="flex-1 bg-[#2d2d30] hover:bg-[#37373a] border border-[#3c3c3c] rounded px-2 py-1 text-[#d4d4d4] cursor-pointer disabled:opacity-50"
              onClick={() => void doSearch()}
              disabled={busy || !query.trim()}
            >
              Search
            </button>
            <button
              className="flex-1 bg-[#22D3EE] hover:opacity-90 text-[#062a30] rounded px-2 py-1 font-medium cursor-pointer disabled:opacity-50"
              onClick={() => void injectPrimer()}
              disabled={busy}
              title="Inject the most relevant memories into the active agent"
            >
              Inject primer
            </button>
          </div>
        </div>

        {results.length > 0 && (
          <ul className="flex flex-col gap-1">
            {results.map((r) => (
              <li key={r.id} className="bg-[#1e1e1e] border border-[#333] rounded px-2 py-1">
                <div className="text-[#777] text-[10px] uppercase">{r.source || r.kind}</div>
                <div className="text-[#cfcfcf]">{r.content}</div>
              </li>
            ))}
          </ul>
        )}

        <div className="border-t border-[#3c3c3c] pt-2 flex flex-col gap-1">
          <div className="text-[#666] text-[10px] uppercase tracking-wider">Feed the brain</div>
          <button
            className="bg-[#2d2d30] hover:bg-[#37373a] border border-[#3c3c3c] rounded px-2 py-1 text-[#d4d4d4] cursor-pointer disabled:opacity-50 text-left"
            onClick={() => void ingestConversations()}
            disabled={busy}
          >
            <i className="fa-solid fa-comments mr-1"></i> Index past conversations
          </button>
          <button
            className="bg-[#2d2d30] hover:bg-[#37373a] border border-[#3c3c3c] rounded px-2 py-1 text-[#d4d4d4] cursor-pointer disabled:opacity-50 text-left"
            onClick={() => void ingestCode()}
            disabled={busy || !activeCwd}
            title={activeCwd ? `Index ${activeCwd}` : 'Open a terminal in a repo first'}
          >
            <i className="fa-solid fa-code mr-1"></i> Index this repo&apos;s code
          </button>
        </div>

        <CodeGraphPanel cwd={activeCwd} />

        <div className="border-t border-[#3c3c3c] pt-2 flex flex-col gap-1" data-testid="memory-sync">
          <div className="text-[#666] text-[10px] uppercase tracking-wider flex items-center gap-1">
            <i className="fa-solid fa-arrows-rotate"></i> Sync across machines
          </div>
          {sync?.syncing ? (
            <>
              <div className="text-[11px] text-[#bbb]">
                <span className="text-[#7ee2a3]">On</span> · {sync.devices} device{sync.devices === 1 ? '' : 's'} sharing this brain
                <div className="text-[10px] text-[#777] break-all">{sync.dir}</div>
              </div>
              <button
                className="bg-[#2d2d30] hover:bg-[#37373a] border border-[#3c3c3c] rounded px-2 py-1 text-[#d4d4d4] cursor-pointer disabled:opacity-50 text-left"
                onClick={() => void disableSync()}
                disabled={busy}
                data-testid="memory-sync-off"
              >Turn off sync on this computer</button>
            </>
          ) : (
            <div className="text-[11px] text-[#777] leading-relaxed" data-testid="memory-sync-unavailable">
              Unavailable in this version — cross-machine sync is being rebuilt so that it can never lock or overwrite a
              computer&apos;s memory. Each computer keeps its own memory, untouched.
            </div>
          )}
        </div>

        {status && <div className="text-[#22D3EE] text-[11px]">{status}</div>}
      </div>
    </div>
  )
}
