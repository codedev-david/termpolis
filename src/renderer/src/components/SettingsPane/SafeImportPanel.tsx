// Safe Import — bring in a third-party skill / plugin / MCP server, PROVE it is safe
// and LOCAL-ONLY before it is ever wired into an agent, then install it.
//
// WHY: skill + MCP marketplaces are a live supply-chain vector. A skill is just files
// an agent will happily execute; a malicious one can exfiltrate your repo, read ~/.ssh,
// or poison the agent's instructions. Every other tool asks you to trust the publisher.
// Termpolis scans the artifact first, shows you exactly what it found, and refuses to
// install anything that can phone home.
//
// The scan streams real progress from the main process (per-file), so the percentage is
// honest rather than a decorative spinner.

import { useEffect, useState, useCallback } from 'react'

type RiskLevel = 'green' | 'yellow' | 'red'

interface Finding {
  rule: string
  label: string
  severity: RiskLevel
  file: string
  line: number
  excerpt: string
}

interface ScanReport {
  canceled?: boolean
  name: string
  kind: string
  hash: string
  level: RiskLevel
  findings: Finding[]
  filesScanned: number
  summary: string
  targets: string[]
  alreadyApproved: boolean
}

interface InstalledArtifact {
  id: string
  name: string
  kind: string
  riskLevel: RiskLevel
  targets: string[]
  approvedAt: number
}

interface SafeImportAPI {
  scan: () => Promise<{ success: boolean; error?: string; data?: ScanReport }>
  approveInstall: (targets: string[]) => Promise<{ success: boolean; error?: string; data?: { installed: { target: string; path: string }[] } }>
  list: () => Promise<{ success: boolean; data?: InstalledArtifact[] }>
  revoke: (id: string) => Promise<{ success: boolean }>
  onProgress: (cb: (p: { pct: number; stage: string }) => void) => () => void
}

declare global {
  interface Window {
    safeImport?: SafeImportAPI
  }
}

const LEVEL_STYLE: Record<RiskLevel, { chip: string; label: string; icon: string }> = {
  green: { chip: 'bg-[#0d3a1a] text-[#7ee2a3] border-[#1f6e3a]', label: 'Safe to import', icon: 'fa-circle-check' },
  yellow: { chip: 'bg-[#3a2a0d] text-[#FFB74D] border-[#6e4d1f]', label: 'Review before importing', icon: 'fa-triangle-exclamation' },
  red: { chip: 'bg-[#3a0d0d] text-[#FFB4B4] border-[#6e1f1f]', label: 'Blocked — unsafe', icon: 'fa-ban' },
}

const ALL_TARGETS = ['claude', 'codex', 'gemini'] as const

export function SafeImportPanel(): JSX.Element {
  const api = typeof window !== 'undefined' ? window.safeImport : undefined
  const [busy, setBusy] = useState(false)
  const [pct, setPct] = useState(0)
  const [stage, setStage] = useState('')
  const [report, setReport] = useState<ScanReport | null>(null)
  const [installed, setInstalled] = useState<InstalledArtifact[]>([])
  const [targets, setTargets] = useState<string[]>([])
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  const refresh = useCallback(async () => {
    if (!api) return
    const res = await api.list()
    if (res.success && res.data) setInstalled(res.data)
  }, [api])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (!api) return
    return api.onProgress(({ pct: p, stage: s }) => { setPct(p); setStage(s) })
  }, [api])

  const doImport = async (): Promise<void> => {
    if (!api) return
    setBusy(true); setPct(0); setStage('Reading artifact'); setReport(null); setError(''); setDone('')
    try {
      const res = await api.scan()
      if (!res.success) { setError(res.error || 'Scan failed'); return }
      if (!res.data || res.data.canceled) return
      setReport(res.data)
      setTargets(res.data.targets)
    } finally {
      setBusy(false)
    }
  }

  const doInstall = async (): Promise<void> => {
    if (!api || !report || report.level === 'red' || targets.length === 0) return
    setBusy(true)
    try {
      const res = await api.approveInstall(targets)
      if (!res.success) { setError(res.error || 'Install failed'); return }
      setDone(`Wired "${report.name}" into ${res.data?.installed.map((i) => i.target).join(', ') || 'no agent'}.`)
      setReport(null)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const doRevoke = async (id: string): Promise<void> => {
    if (!api) return
    await api.revoke(id)
    await refresh()
  }

  const toggleTarget = (t: string): void => {
    setTargets((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))
  }

  if (!api) return <div className="text-xs text-[#9ca3af]">Safe Import is unavailable in this build.</div>

  return (
    <div className="flex flex-col gap-3" data-testid="safe-import">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <i className="fa-solid fa-file-shield text-[#22D3EE]"></i>
          Import a skill or plugin &mdash; scanned before it touches your machine
        </h3>
        <p className="text-xs text-[#9ca3af] leading-relaxed">
          Drop in a skill, plugin, slash-command, subagent, or MCP server from a marketplace. Termpolis statically scans every file for
          outbound network calls, shell/<code>eval</code> execution, credential and <code>~/.ssh</code> access, obfuscated payloads, and
          prompt-injection hidden in the instructions. <strong>Anything that can phone home is blocked from installing.</strong> Only
          after it passes is it wired into your agents &mdash; local use only.
        </p>
      </div>

      {/* Upload / drop area */}
      <button
        onClick={doImport}
        disabled={busy}
        data-testid="safe-import-pick"
        className="flex flex-col items-center justify-center gap-2 p-6 border-2 border-dashed border-[#3c3c3c] rounded bg-[#1e1e1e] hover:border-[#22D3EE] hover:bg-[#252526] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <i className="fa-solid fa-cloud-arrow-up text-2xl text-[#22D3EE]"></i>
        <span className="text-sm font-medium">{busy ? 'Scanning…' : 'Choose a skill / plugin (.zip or folder)'}</span>
        <span className="text-[10px] text-[#6b7280]">It is scanned in quarantine &mdash; nothing is installed until you approve it</span>
      </button>

      {/* Live progress — real per-file percentage from the scanner, not a fake spinner */}
      {busy && (
        <div className="flex flex-col gap-1" data-testid="safe-import-progress">
          <div className="flex justify-between text-[10px] text-[#9ca3af] font-mono">
            <span>{stage || 'Processing skill/plugin'}</span>
            <span className="tabular-nums">{pct}%</span>
          </div>
          <div className="h-1.5 w-full rounded bg-[#2d2d2d] overflow-hidden">
            <div className="h-full bg-[#22D3EE] transition-[width] duration-150" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {error && <div className="text-xs text-[#FFB4B4] p-2 rounded bg-[#3a0d0d] border border-[#6e1f1f]">{error}</div>}
      {done && <div className="text-xs text-[#7ee2a3] p-2 rounded bg-[#0d3a1a] border border-[#1f6e3a]" data-testid="safe-import-done">{done}</div>}

      {/* Risk report */}
      {report && (
        <div className="flex flex-col gap-2 p-3 border border-[#3c3c3c] rounded bg-[#252526]" data-testid="safe-import-report">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[10px] px-2 py-0.5 rounded border font-medium ${LEVEL_STYLE[report.level].chip}`}>
              <i className={`fa-solid ${LEVEL_STYLE[report.level].icon} mr-1`}></i>
              {LEVEL_STYLE[report.level].label}
            </span>
            <span className="text-sm font-medium">{report.name}</span>
            <span className="text-[10px] text-[#9ca3af] font-mono">{report.kind} · {report.filesScanned} files · {report.summary}</span>
          </div>

          {report.findings.length > 0 && (
            <div className="flex flex-col gap-1 max-h-52 overflow-y-auto">
              {report.findings.map((f, i) => (
                <div key={`${f.rule}-${f.file}-${f.line}-${i}`} className="text-[11px] font-mono p-2 rounded bg-[#1e1e1e] flex flex-col gap-0.5">
                  <span className={f.severity === 'red' ? 'text-[#FFB4B4]' : 'text-[#FFB74D]'}>
                    <i className="fa-solid fa-circle-exclamation mr-1"></i>{f.label} <span className="text-[#6b7280]">({f.rule})</span>
                  </span>
                  <span className="text-[#9ca3af]">{f.file}:{f.line}</span>
                  <code className="text-[#c9d1d9] whitespace-pre-wrap break-all">{f.excerpt}</code>
                </div>
              ))}
            </div>
          )}

          {report.level === 'red' ? (
            <div className="text-xs text-[#FFB4B4] leading-relaxed">
              This artifact can exfiltrate data or execute code on your machine. Installing it is blocked &mdash; that is the whole point of Safe Import.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-xs text-[#9ca3af]">Wire into:</span>
                {ALL_TARGETS.map((t) => (
                  <label key={t} className={`text-xs flex items-center gap-1.5 ${report.targets.includes(t) ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed'}`}>
                    <input
                      type="checkbox"
                      disabled={!report.targets.includes(t)}
                      checked={targets.includes(t)}
                      onChange={() => toggleTarget(t)}
                    />
                    {t}
                  </label>
                ))}
              </div>
              <button
                onClick={doInstall}
                disabled={busy || targets.length === 0}
                data-testid="safe-import-approve"
                className="self-start text-xs px-3 py-1.5 rounded bg-[#0d9488] hover:bg-[#0f766e] disabled:opacity-40 disabled:cursor-not-allowed font-medium"
              >
                Approve &amp; wire in
              </button>
            </>
          )}
        </div>
      )}

      {/* Already imported */}
      {installed.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="safe-import-list">
          <span className="text-[10px] uppercase tracking-wide text-[#6b7280] font-mono">Imported</span>
          {installed.map((a) => (
            <div key={a.id} className="flex items-center gap-2 text-xs p-2 rounded bg-[#1e1e1e]">
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${LEVEL_STYLE[a.riskLevel].chip}`}>{a.riskLevel}</span>
              <span className="font-medium">{a.name}</span>
              <span className="text-[#6b7280] font-mono text-[10px]">{a.kind} → {a.targets.join(', ')}</span>
              <button onClick={() => doRevoke(a.id)} className="ml-auto text-[10px] text-[#FFB4B4] hover:underline">
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
