import { useEffect, useState, useCallback } from 'react'
import type { CodeGraphStats, CodeSymbolHit, CodeExploreResult } from '../../types'

interface Props {
  /** Active terminal cwd — used to resolve the git root for a manual Rebuild. */
  cwd?: string
}

const base = (f: string): string => f.split(/[\\/]/).pop() || f

// Human-facing browser for the native code graph. The graph is BUILT automatically (per-session
// auto-index + a 15-min re-sweep) and consumed by agents via the code_* MCP tools; this panel lets
// you look at the same structure yourself — search a symbol, see its source + callers + callees,
// and its blast radius — or force a rebuild.
export function CodeGraphPanel({ cwd }: Props): JSX.Element {
  const [stats, setStats] = useState<CodeGraphStats | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CodeSymbolHit[]>([])
  const [selected, setSelected] = useState<CodeExploreResult | null>(null)
  const [impact, setImpact] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  const refreshStats = useCallback(async () => {
    try {
      const res = await window.termpolis.codeGraphStats()
      if (res.success) setStats(res.data)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void refreshStats()
  }, [refreshStats])

  const search = useCallback(async () => {
    const q = query.trim()
    setStatus('')
    if (!q) {
      setResults([])
      return
    }
    setBusy(true)
    try {
      const res = await window.termpolis.codeGraphSearch(q, 30)
      setResults(res.success ? res.data : [])
    } finally {
      setBusy(false)
    }
  }, [query])

  const explore = useCallback(async (name: string) => {
    setBusy(true)
    setStatus('')
    try {
      const [ex, imp] = await Promise.all([window.termpolis.codeGraphExplore(name), window.termpolis.codeGraphImpact(name)])
      setSelected(ex.success ? ex.data : null)
      setImpact(imp.success ? imp.data.length : null)
    } finally {
      setBusy(false)
    }
  }, [])

  const rebuild = useCallback(async () => {
    setStatus('')
    let root: string | null = null
    try {
      if (cwd && window.termpolis.gitFindRoot) {
        const r = await window.termpolis.gitFindRoot(cwd)
        root = r?.success ? r.data : null
      }
    } catch {
      root = null
    }
    if (!root) {
      setStatus('Open a terminal in a git repo to (re)build the graph.')
      return
    }
    setBusy(true)
    setStatus('Building the code graph…')
    try {
      const res = await window.termpolis.codeGraphBuild(root)
      if (res.success) {
        setStats(res.data)
        setStatus(`Indexed ${res.data.symbols} symbols across ${res.data.files} files (${res.data.edges} edges).`)
      } else {
        setStatus('Build failed.')
      }
    } finally {
      setBusy(false)
    }
  }, [cwd])

  const isEmpty = stats !== null && stats.symbols === 0

  return (
    <div data-testid="code-graph-panel" className="border border-[#2d2d30] rounded p-3 mt-3 text-[#d4d4d4]">
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium">Code Graph</span>
        <div className="flex items-center gap-2">
          <span data-testid="code-graph-stats" className="text-[11px] text-[#888]">
            {stats ? `${stats.symbols} symbols · ${stats.edges} edges` : '…'}
          </span>
          <button
            data-testid="code-graph-rebuild"
            className="bg-[#2d2d30] hover:bg-[#37373a] border border-[#3c3c3c] rounded px-2 py-1 text-[11px] cursor-pointer disabled:opacity-50"
            onClick={() => void rebuild()}
            disabled={busy}
          >
            Rebuild
          </button>
        </div>
      </div>
      <p className="text-[11px] text-[#888] mb-2">
        A structural map of your code, built automatically as you work. Agents use it via the code_* tools; browse it yourself here.
      </p>

      {isEmpty && (
        <p data-testid="code-graph-empty" className="text-[11px] text-[#c08a3e] mb-2">
          No graph yet — open a terminal in a Git repo (it auto-indexes), or click Rebuild.
        </p>
      )}

      <div className="flex gap-2 mb-2">
        <input
          data-testid="code-graph-search"
          className="flex-1 bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm outline-none focus:border-[#0078d4]"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search()
          }}
          placeholder="Search symbols (function, class, method…)"
        />
        <button
          data-testid="code-graph-search-btn"
          className="bg-[#0078d4] hover:opacity-90 rounded px-3 py-1 text-sm text-white cursor-pointer disabled:opacity-50"
          onClick={() => void search()}
          disabled={busy}
        >
          Find
        </button>
      </div>

      {results.length > 0 && (
        <ul data-testid="code-graph-results" className="max-h-40 overflow-auto mb-2 flex flex-col gap-0.5">
          {results.map((s) => (
            <li key={s.id}>
              <button
                data-testid={`cg-sym-${s.name}`}
                className="w-full text-left text-[12px] px-2 py-1 rounded hover:bg-[#2d2d30] cursor-pointer flex justify-between gap-2"
                onClick={() => void explore(s.name)}
              >
                <span className="truncate">
                  <span className="font-medium">{s.name}</span> <span className="text-[#888]">{s.kind}</span>
                </span>
                <span className="text-[#666] shrink-0">
                  {base(s.file)}:{s.startLine}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <div data-testid="code-graph-detail" className="border-t border-[#2d2d30] pt-2 text-[12px]">
          <div className="font-medium mb-1">
            {selected.symbol.name} <span className="text-[#888]">({selected.symbol.kind})</span>{' '}
            <span className="text-[#666]">
              {base(selected.symbol.file)}:{selected.symbol.startLine}-{selected.symbol.endLine}
            </span>
          </div>
          {impact !== null && (
            <div data-testid="code-graph-impact" className="text-[#c08a3e] mb-1">
              Blast radius: {impact} symbol{impact === 1 ? '' : 's'} could be affected by a change
            </div>
          )}
          <div className="mb-0.5">
            <span className="text-[#888]">Callers:</span> {selected.callers.map((c) => c.name).join(', ') || '—'}
          </div>
          <div className="mb-1">
            <span className="text-[#888]">Callees:</span> {selected.callees.map((c) => c.name).join(', ') || '—'}
          </div>
          {selected.source && (
            <pre data-testid="code-graph-source" className="bg-[#1e1e1e] border border-[#2d2d30] rounded p-2 text-[11px] overflow-auto max-h-48 whitespace-pre">
              {selected.source}
            </pre>
          )}
        </div>
      )}

      {status && (
        <div data-testid="code-graph-status" className="text-[11px] text-[#888] mt-2">
          {status}
        </div>
      )}
    </div>
  )
}
