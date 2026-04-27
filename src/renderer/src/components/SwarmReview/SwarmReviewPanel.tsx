import { useEffect, useMemo, useState } from 'react'
import { parseUnifiedDiff, type DiffFile, type DiffHunk } from '../../lib/diffParser'
import { detectTestCommand, reviewProgress, reviewStat, runTests, suggestCommitMessage, type ReviewState } from '../../lib/swarmReview'

interface Props {
  preSwarmSha: string
  cwd: string
  taskDescription?: string
  onClose: () => void
  onCommitted?: (commitMessage: string) => void
  onRefineWithSwarm?: (refinement: string) => void
}

type DecisionMap = Record<string, 'accept' | 'reject'>

export function SwarmReviewPanel({ preSwarmSha, cwd, taskDescription, onClose, onCommitted, onRefineWithSwarm }: Props) {
  const [refinement, setRefinement] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [files, setFiles] = useState<DiffFile[]>([])
  const [decisions, setDecisions] = useState<DecisionMap>({})
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [testCommand, setTestCommand] = useState<string>('npm test')
  const [running, setRunning] = useState(false)
  const [testOutput, setTestOutput] = useState<string>('')
  const [testPassed, setTestPassed] = useState<boolean | null>(null)
  const [commitMsg, setCommitMsg] = useState('')
  const [confirmRevertAll, setConfirmRevertAll] = useState(false)
  const [actionMsg, setActionMsg] = useState<{ text: string; kind: 'info' | 'error' | 'success' } | null>(null)

  const loadDiff = async () => {
    setLoading(true)
    setLoadError(null)
    const res = await window.termpolis.gitDiffRange(cwd, preSwarmSha)
    if (!res.success) {
      setLoadError(res.error || 'Failed to load diff')
      setLoading(false)
      return
    }
    const parsed = parseUnifiedDiff(res.data || '')
    setFiles(parsed)
    if (parsed.length > 0 && !selectedFile) setSelectedFile(parsed[0].file)
    setLoading(false)
  }

  useEffect(() => {
    loadDiff()
    detectTestCommand(cwd).then(setTestCommand)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, preSwarmSha])

  useEffect(() => {
    const state: ReviewState = { preSha: preSwarmSha, files, hunkDecisions: decisions, lastTestPassed: testPassed, lastTestOutput: testOutput }
    setCommitMsg(prev => prev || suggestCommitMessage(state, taskDescription))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files])

  const stat = useMemo(() => reviewStat({ preSha: preSwarmSha, files, hunkDecisions: decisions, lastTestPassed: null, lastTestOutput: '' }), [files, preSwarmSha, decisions])
  const prog = useMemo(() => reviewProgress({ preSha: preSwarmSha, files, hunkDecisions: decisions, lastTestPassed: null, lastTestOutput: '' }), [files, preSwarmSha, decisions])

  const selected = files.find(f => f.file === selectedFile)

  const setHunk = (id: string, decision: 'accept' | 'reject') => {
    setDecisions(prev => ({ ...prev, [id]: decision }))
  }

  const bulkAccept = () => {
    const next: DecisionMap = { ...decisions }
    for (const f of files) for (const h of f.hunks) next[h.id] = 'accept'
    setDecisions(next)
  }

  const bulkReject = () => {
    const next: DecisionMap = { ...decisions }
    for (const f of files) for (const h of f.hunks) next[h.id] = 'reject'
    setDecisions(next)
  }

  const applyRejections = async (): Promise<boolean> => {
    // Reverse-apply every hunk the user rejected so the working tree matches
    // their decisions. Hunks default to 'accept' (keep the swarm change).
    const rejected: DiffHunk[] = []
    for (const f of files) {
      for (const h of f.hunks) {
        if (decisions[h.id] === 'reject') rejected.push(h)
      }
    }
    if (rejected.length === 0) return true
    // Apply in reverse file-order to minimise conflicts in the same file
    for (const h of rejected.reverse()) {
      const res = await window.termpolis.gitApplyPatch(cwd, h.patch, true)
      if (!res.success) {
        setActionMsg({ text: `Failed to reject hunk in ${h.file}: ${res.error || 'unknown'}`, kind: 'error' })
        return false
      }
    }
    return true
  }

  const handleRunTests = async () => {
    if (!testCommand.trim()) {
      setActionMsg({ text: 'Enter a test command first', kind: 'error' })
      return
    }
    setRunning(true)
    setTestOutput('Running...')
    setTestPassed(null)
    const result = await runTests(cwd, testCommand)
    setTestPassed(result.passed)
    setTestOutput(result.output)
    setRunning(false)
  }

  const handleCommit = async () => {
    if (!commitMsg.trim()) {
      setActionMsg({ text: 'Commit message is required', kind: 'error' })
      return
    }
    setRunning(true)
    setActionMsg(null)
    const rejOk = await applyRejections()
    if (!rejOk) { setRunning(false); return }
    const res = await window.termpolis.gitCommitAll(cwd, commitMsg)
    setRunning(false)
    if (!res.success) {
      setActionMsg({ text: `Commit failed: ${res.error}`, kind: 'error' })
      return
    }
    setActionMsg({ text: 'Swarm changes committed', kind: 'success' })
    onCommitted?.(commitMsg)
    await loadDiff()
  }

  const handleRevertAll = async () => {
    setRunning(true)
    setActionMsg(null)
    const res = await window.termpolis.gitResetHard(cwd, preSwarmSha)
    setRunning(false)
    setConfirmRevertAll(false)
    if (!res.success) {
      setActionMsg({ text: `Revert failed: ${res.error}`, kind: 'error' })
      return
    }
    setActionMsg({ text: 'All swarm changes reverted', kind: 'success' })
    await loadDiff()
  }

  const handleRejectFile = async (file: DiffFile) => {
    // Shortcut: restore entire file to pre-swarm state.
    setRunning(true)
    setActionMsg(null)
    const res = await window.termpolis.gitCheckoutFile(cwd, preSwarmSha, [file.file])
    setRunning(false)
    if (!res.success) {
      setActionMsg({ text: `Could not reject ${file.file}: ${res.error}`, kind: 'error' })
      return
    }
    // Mark every hunk of that file as rejected and reload so UI matches disk.
    setDecisions(prev => {
      const next = { ...prev }
      for (const h of file.hunks) next[h.id] = 'reject'
      return next
    })
    await loadDiff()
  }

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60"
      onClick={onClose}
      data-testid="swarm-review-panel"
    >
      <div
        className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-xl shadow-2xl flex flex-col"
        style={{ width: '90vw', maxWidth: 1200, height: '88vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#3c3c3c]">
          <div className="flex items-center gap-3">
            <i className="fa-solid fa-code-compare text-[#22D3EE]"></i>
            <h2 className="text-base font-semibold text-[#d4d4d4]">Swarm Review</h2>
            <span className="text-xs text-[#9ca3af]">
              base <span className="font-mono text-[#888]">{preSwarmSha.slice(0, 7)}</span>
            </span>
            {files.length > 0 && (
              <span className="text-xs text-[#9ca3af]" data-testid="review-summary">
                {`${stat.files} file${stat.files !== 1 ? 's' : ''} · `}
                <span className="text-[#98c379]">{`+${stat.added}`}</span>{' '}
                <span className="text-[#e06c75]">{`-${stat.removed}`}</span>
                <span className="text-[#888]">{` · ${stat.hunks} hunk${stat.hunks !== 1 ? 's' : ''}`}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={bulkAccept}
              disabled={files.length === 0 || running}
              className="text-[11px] px-2 py-1 rounded bg-[#1a3a1a] text-[#98c379] hover:bg-[#214421] border border-[#2d5a2d] disabled:opacity-40"
              data-testid="review-accept-all"
            >
              Accept all
            </button>
            <button
              onClick={bulkReject}
              disabled={files.length === 0 || running}
              className="text-[11px] px-2 py-1 rounded bg-[#3a1a1a] text-[#e06c75] hover:bg-[#4a2222] border border-[#5a2d2d] disabled:opacity-40"
              data-testid="review-reject-all"
            >
              Reject all
            </button>
            <button onClick={onClose} className="text-[#9ca3af] hover:text-white px-2 py-1 rounded hover:bg-[#37373d]">
              <i className="fa-solid fa-xmark"></i>
            </button>
          </div>
        </div>

        {/* Progress bar */}
        {files.length > 0 && (
          <div className="px-5 py-1.5 border-b border-[#3c3c3c] flex items-center gap-3 text-[11px] text-[#888]">
            <span data-testid="review-progress">
              <span className="text-[#98c379]">{`${prog.accepted} accepted`}</span>{' · '}
              <span className="text-[#e06c75]">{`${prog.rejected} rejected`}</span>{' · '}
              <span className="text-[#e5c07b]">{`${prog.pending} pending`}</span>
            </span>
            <div className="flex-1 h-1.5 bg-[#2d2d2d] rounded overflow-hidden flex">
              <div className="h-full bg-[#2d5a2d]" style={{ width: `${(prog.accepted / Math.max(1, prog.total)) * 100}%` }} />
              <div className="h-full bg-[#5a2d2d]" style={{ width: `${(prog.rejected / Math.max(1, prog.total)) * 100}%` }} />
            </div>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 flex overflow-hidden">
          {/* File tree */}
          <div className="w-60 border-r border-[#3c3c3c] overflow-y-auto py-1" data-testid="review-file-list">
            {loading && <div className="px-3 py-4 text-xs text-[#888]">Loading diff…</div>}
            {!loading && loadError && <div className="px-3 py-4 text-xs text-[#e06c75]">{loadError}</div>}
            {!loading && !loadError && files.length === 0 && (
              <div className="px-3 py-4 text-xs text-[#888]">No changes detected since swarm started.</div>
            )}
            {files.map(f => {
              const decided = f.hunks.every(h => decisions[h.id])
              const anyReject = f.hunks.some(h => decisions[h.id] === 'reject')
              return (
                <button
                  key={f.file}
                  onClick={() => setSelectedFile(f.file)}
                  className={`w-full text-left px-3 py-1.5 text-xs font-mono flex items-center gap-2 ${
                    selectedFile === f.file ? 'bg-[#094771] text-[#d4d4d4]' : 'text-[#bbb] hover:bg-[#2a2d2e]'
                  }`}
                  data-testid={`review-file-${f.file}`}
                >
                  <span
                    className={`text-[9px] px-1 rounded font-bold shrink-0 ${
                      f.status === 'A' ? 'bg-[#1a3a1a] text-[#98c379]'
                      : f.status === 'D' ? 'bg-[#3a1a1a] text-[#e06c75]'
                      : f.status === 'R' ? 'bg-[#1a1a3a] text-[#82aaff]'
                      : 'bg-[#3a3a1a] text-[#e5c07b]'
                    }`}
                  >{f.status}</span>
                  <span className="truncate flex-1">{f.file}</span>
                  {decided && (
                    <i className={`fa-solid ${anyReject ? 'fa-rotate-left text-[#e06c75]' : 'fa-check text-[#98c379]'} text-[9px]`}></i>
                  )}
                </button>
              )
            })}
          </div>

          {/* Diff viewer */}
          <div className="flex-1 overflow-y-auto font-mono text-[12px] leading-5" data-testid="review-diff-viewer">
            {selected ? (
              <div>
                <div className="sticky top-0 bg-[#2a2d3a] px-4 py-1.5 border-b border-[#3c3c3c] text-[#82aaff] font-semibold text-[11px] flex items-center justify-between z-10">
                  <div>
                    <i className="fa-solid fa-file-code mr-2 text-[10px]"></i>
                    {selected.file}
                    <span className="text-[#888] ml-2 font-normal">
                      <span className="text-[#98c379]">+{selected.added}</span> <span className="text-[#e06c75]">-{selected.removed}</span>
                    </span>
                  </div>
                  <button
                    onClick={() => handleRejectFile(selected)}
                    disabled={running}
                    className="text-[10px] px-2 py-0.5 rounded bg-[#3a1a1a] text-[#e06c75] hover:bg-[#4a2222] border border-[#5a2d2d] disabled:opacity-40"
                  >
                    Reject entire file
                  </button>
                </div>
                {selected.binary && (
                  <div className="px-4 py-6 text-[#888] text-center">Binary file — no inline diff</div>
                )}
                {!selected.binary && selected.hunks.length === 0 && (
                  <div className="px-4 py-6 text-[#888] text-center">No hunks (pure rename or mode change)</div>
                )}
                {selected.hunks.map(h => (
                  <HunkBlock
                    key={h.id}
                    hunk={h}
                    decision={decisions[h.id]}
                    onAccept={() => setHunk(h.id, 'accept')}
                    onReject={() => setHunk(h.id, 'reject')}
                  />
                ))}
              </div>
            ) : (
              <div className="px-4 py-10 text-center text-[#888] text-xs">Select a file to review its hunks.</div>
            )}
          </div>
        </div>

        {/* Footer: test + commit */}
        <div className="border-t border-[#3c3c3c] px-5 py-3 space-y-2 bg-[#252526]">
          {actionMsg && (
            <div
              className={`text-[11px] ${
                actionMsg.kind === 'error' ? 'text-[#e06c75]' : actionMsg.kind === 'success' ? 'text-[#98c379]' : 'text-[#9ca3af]'
              }`}
              data-testid="review-action-msg"
            >{actionMsg.text}</div>
          )}
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-[#9ca3af] shrink-0">Test cmd:</label>
            <input
              type="text"
              value={testCommand}
              onChange={e => setTestCommand(e.target.value)}
              className="flex-1 bg-[#1e1e1e] border border-[#3c3c3c] text-[#d4d4d4] text-[11px] font-mono rounded px-2 py-1"
              placeholder="npm test"
              data-testid="review-test-cmd"
            />
            <button
              onClick={handleRunTests}
              disabled={running}
              className="text-[11px] px-3 py-1 rounded bg-[#1a3a5f] text-[#82aaff] hover:bg-[#22477a] border border-[#2d5a7a] disabled:opacity-40"
              data-testid="review-run-tests"
            >
              {running ? 'Running…' : 'Run tests'}
            </button>
            {testPassed !== null && (
              <span className={`text-[11px] ${testPassed ? 'text-[#98c379]' : 'text-[#e06c75]'}`}>
                {testPassed ? '✓ passing' : '✗ failing'}
              </span>
            )}
          </div>
          {testOutput && (
            <div className="max-h-24 overflow-y-auto font-mono text-[10px] bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 whitespace-pre-wrap text-[#bbb]">
              {testOutput.slice(-2000)}
            </div>
          )}
          {onRefineWithSwarm && (
            <div className="flex items-start gap-2 pb-2 border-b border-[#3c3c3c]">
              <i className="fa-solid fa-rotate text-[#22D3EE] text-[10px] mt-1.5 shrink-0" title="Refine with another swarm"></i>
              <textarea
                value={refinement}
                onChange={e => setRefinement(e.target.value)}
                rows={2}
                className="flex-1 bg-[#1e1e1e] border border-[#3c3c3c] text-[#d4d4d4] text-[11px] font-mono rounded px-2 py-1"
                placeholder="Don't like the result? Describe what to fix and run another swarm…"
                data-testid="review-refine-input"
              />
              <button
                onClick={() => {
                  if (!refinement.trim()) return
                  onRefineWithSwarm(refinement.trim())
                }}
                disabled={!refinement.trim() || running}
                className="text-[11px] px-3 py-1 rounded bg-[#22D3EE]/15 text-[#22D3EE] hover:bg-[#22D3EE]/25 border border-[#22D3EE]/30 disabled:opacity-40 self-stretch flex items-center gap-1.5"
                data-testid="review-refine-btn"
                title="Launch a new swarm to refine these results"
              >
                <i className="fa-solid fa-rotate text-[10px]"></i>
                Refine
              </button>
            </div>
          )}
          <div className="flex items-center gap-2">
            <textarea
              value={commitMsg}
              onChange={e => setCommitMsg(e.target.value)}
              rows={2}
              className="flex-1 bg-[#1e1e1e] border border-[#3c3c3c] text-[#d4d4d4] text-[11px] font-mono rounded px-2 py-1"
              placeholder="Commit message"
              data-testid="review-commit-msg"
            />
            <div className="flex flex-col gap-1">
              <button
                onClick={handleCommit}
                disabled={running || files.length === 0 || (testPassed === false)}
                title={testPassed === false ? 'Tests failing — fix or rerun first' : 'Commit accepted changes'}
                className="text-[11px] px-3 py-1 rounded bg-[#1a3a1a] text-[#98c379] hover:bg-[#214421] border border-[#2d5a2d] disabled:opacity-40"
                data-testid="review-commit"
              >
                <i className="fa-solid fa-check mr-1"></i>Commit
              </button>
              <button
                onClick={() => setConfirmRevertAll(true)}
                disabled={running || files.length === 0}
                className="text-[11px] px-3 py-1 rounded bg-[#3a1a1a] text-[#e06c75] hover:bg-[#4a2222] border border-[#5a2d2d] disabled:opacity-40"
                data-testid="review-revert-all"
              >
                <i className="fa-solid fa-rotate-left mr-1"></i>Revert all
              </button>
            </div>
          </div>
        </div>

        {confirmRevertAll && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 rounded-xl" onClick={() => setConfirmRevertAll(false)}>
            <div className="bg-[#252526] border border-[#3c3c3c] rounded-lg p-5 w-96 space-y-3" onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-2">
                <i className="fa-solid fa-triangle-exclamation text-[#e06c75]"></i>
                <h3 className="text-sm font-semibold text-[#d4d4d4]">Revert all swarm changes</h3>
              </div>
              <p className="text-xs text-[#bbb] leading-relaxed">
                This will hard-reset the working tree to <span className="font-mono text-[#888]">{preSwarmSha.slice(0, 7)}</span>,
                discarding every file the swarm touched. <span className="text-[#e06c75] font-medium">Uncommitted work will be lost.</span>
              </p>
              <div className="flex justify-end gap-2 pt-1">
                <button onClick={() => setConfirmRevertAll(false)} className="px-3 py-1.5 text-xs text-[#999] hover:text-white rounded hover:bg-[#37373d]">Cancel</button>
                <button
                  onClick={handleRevertAll}
                  className="px-3 py-1.5 text-xs bg-[#e06c75]/20 text-[#e06c75] rounded hover:bg-[#e06c75]/30 font-medium"
                  data-testid="review-revert-all-confirm"
                >
                  Revert everything
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function HunkBlock({ hunk, decision, onAccept, onReject }: {
  hunk: DiffHunk
  decision?: 'accept' | 'reject'
  onAccept: () => void
  onReject: () => void
}) {
  const lines = hunk.body.split('\n')
  return (
    <div
      className={`border-b border-[#3c3c3c] ${decision === 'reject' ? 'opacity-50' : ''}`}
      data-testid={`review-hunk-${hunk.id}`}
    >
      <div className="sticky top-[32px] bg-[#1e3a5f] text-[#82aaff] px-4 py-1 flex items-center justify-between text-[11px] z-[5]">
        <span className="font-mono truncate">{hunk.header}</span>
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[10px] text-[#888]">
            <span className="text-[#98c379]">+{hunk.added}</span> <span className="text-[#e06c75]">-{hunk.removed}</span>
          </span>
          <button
            onClick={onAccept}
            className={`text-[10px] px-2 py-0.5 rounded border ${
              decision === 'accept'
                ? 'bg-[#1a3a1a] text-[#98c379] border-[#2d5a2d]'
                : 'bg-[#2d2d2d] text-[#9ca3af] border-[#3c3c3c] hover:bg-[#37373d]'
            }`}
          >Accept</button>
          <button
            onClick={onReject}
            className={`text-[10px] px-2 py-0.5 rounded border ${
              decision === 'reject'
                ? 'bg-[#3a1a1a] text-[#e06c75] border-[#5a2d2d]'
                : 'bg-[#2d2d2d] text-[#9ca3af] border-[#3c3c3c] hover:bg-[#37373d]'
            }`}
          >Reject</button>
        </div>
      </div>
      <div>
        {lines.slice(1).map((line, i) => (
          <div
            key={i}
            className={`flex hover:brightness-110 ${
              line.startsWith('+') ? 'bg-[#1a3a1a] text-[#98c379]'
              : line.startsWith('-') ? 'bg-[#3a1a1a] text-[#e06c75]'
              : 'text-[#abb2bf]'
            }`}
          >
            <pre className="pl-4 whitespace-pre-wrap break-all flex-1">{line}</pre>
          </div>
        ))}
      </div>
    </div>
  )
}
