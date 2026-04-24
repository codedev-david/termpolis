import React, { useEffect, useRef, useState } from 'react'

// In-app bug reporter. Collects a short title + description + optional
// system diagnostics, then opens GitHub's new-issue page in the user's
// default browser with the body pre-filled. The existing issue-email
// GitHub Action picks up every new issue and emails the maintainer —
// so this path is the same signal channel as manual issues, just with
// friction removed from the user's side (no context switch to write
// down "what version am I on, what OS" etc).
//
// Deliberate non-goals:
//   - No direct API posting. That would require a bot token embedded
//     in the app or a hosted webhook. A pre-filled URL is zero-infra
//     and still collects everything we need.
//   - No in-app thread / reply UI. GitHub already owns that surface.
//   - No crash log upload. Sentry (initMainSentry in main/sentry.ts)
//     handles exception capture; this flow is for user-reported UX
//     issues the crash reporter can't see.

const REPO_ISSUES_NEW_URL = 'https://github.com/codedev-david/termpolis/issues/new'
const MAX_TITLE_LEN = 140
const MAX_DESCRIPTION_LEN = 4000

interface Diagnostics {
  appVersion: string
  platform: string
  osRelease: string
  arch: string
  electronVersion: string
  nodeVersion: string
  chromeVersion: string
}

function formatDiagnosticsBlock(d: Diagnostics): string {
  const lines = [
    `App version:     ${d.appVersion}`,
    `Platform:        ${d.platform}`,
    `OS release:      ${d.osRelease}`,
    `Architecture:    ${d.arch}`,
    `Electron:        ${d.electronVersion}`,
    `Node:            ${d.nodeVersion}`,
    `Chrome:          ${d.chromeVersion}`,
  ]
  return '```\n' + lines.join('\n') + '\n```'
}

// Exported for testing — builds the final GitHub new-issue URL with
// title + body pre-filled. `body` may exceed GitHub's URL-length limit;
// the 4000-char description cap keeps total URL under ~8KB even with
// diagnostics attached, which GitHub accepts.
export function buildIssueUrl(opts: {
  title: string
  description: string
  diagnostics: Diagnostics | null
}): string {
  const { title, description, diagnostics } = opts
  const body = [
    '### What happened?',
    '',
    description.trim() || '_(no description provided)_',
    '',
    '### System',
    '',
    diagnostics ? formatDiagnosticsBlock(diagnostics) : '_(diagnostics omitted by reporter)_',
  ].join('\n')
  const params = new URLSearchParams({
    title: title.trim(),
    body,
    labels: 'bug,user-report',
  })
  return `${REPO_ISSUES_NEW_URL}?${params.toString()}`
}

export function ReportProblemModal({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true)
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
    const api = window.termpolis
    if (!api?.collectDiagnostics) return
    void api.collectDiagnostics()
      .then(res => {
        if (res?.success && res.data) setDiagnostics(res.data as Diagnostics)
      })
      .catch(() => { /* non-fatal — user can still submit without diagnostics */ })
  }, [])

  const titleValid = title.trim().length > 0 && title.length <= MAX_TITLE_LEN
  const descriptionTooLong = description.length > MAX_DESCRIPTION_LEN
  const canSubmit = titleValid && !descriptionTooLong && !submitted

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitted(true)
    setError(null)
    const url = buildIssueUrl({
      title,
      description,
      diagnostics: includeDiagnostics ? diagnostics : null,
    })
    const api = window.termpolis
    try {
      if (api?.openExternal) {
        const res = await api.openExternal(url)
        if (!res?.success) throw new Error(res?.error || 'openExternal failed')
      } else {
        window.open(url, '_blank', 'noopener,noreferrer')
      }
      onClose()
    } catch (e: any) {
      setSubmitted(false)
      setError(e?.message || String(e))
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void handleSubmit()
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 animate-fadeIn"
      onKeyDown={handleKeyDown}
      data-testid="report-problem-modal"
    >
      <div className="bg-[#252526] rounded-lg shadow-xl border border-[#3c3c3c] w-[560px] max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#3c3c3c]">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <i className="fa-solid fa-bug text-[#D97706]"></i>
            Report a problem
          </h2>
          <button
            onClick={onClose}
            aria-label="Close report problem"
            className="text-[#9ca3af] hover:text-white text-lg px-1"
          >&times;</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4 text-sm text-[#d4d4d4]">
          <p className="text-xs text-[#9ca3af] leading-relaxed">
            Opens a pre-filled GitHub issue in your browser. You can edit anything before
            submitting. We never send anything automatically — nothing leaves your machine
            until you click <strong>Submit new issue</strong> on GitHub.
          </p>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-[#9ca3af]">Title <span className="text-red-400">*</span></span>
            <input
              ref={titleRef}
              value={title}
              onChange={e => setTitle(e.target.value)}
              maxLength={MAX_TITLE_LEN + 10}
              placeholder="Short summary of what went wrong"
              className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-2 text-sm text-[#d4d4d4] focus:outline-none focus:border-[#22D3EE]"
              data-testid="report-title-input"
            />
            <span className={`text-[10px] text-right ${title.length > MAX_TITLE_LEN ? 'text-red-400' : 'text-[#6b7280]'}`}>
              {title.length}/{MAX_TITLE_LEN}
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-[#9ca3af]">What happened?</span>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={6}
              placeholder={'Steps to reproduce, what you expected, what happened instead.\n\nCtrl+Enter to submit.'}
              className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-2 text-sm text-[#d4d4d4] focus:outline-none focus:border-[#22D3EE] resize-none font-mono"
              data-testid="report-description-input"
            />
            <span className={`text-[10px] text-right ${descriptionTooLong ? 'text-red-400' : 'text-[#6b7280]'}`}>
              {description.length}/{MAX_DESCRIPTION_LEN}
            </span>
          </label>

          <label className="flex items-start gap-3 p-3 rounded border border-[#3c3c3c] bg-[#1e1e1e] cursor-pointer hover:border-[#22D3EE]/40">
            <input
              type="checkbox"
              checked={includeDiagnostics}
              onChange={e => setIncludeDiagnostics(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-[#22D3EE]"
              data-testid="report-include-diagnostics"
            />
            <span className="flex flex-col gap-1 flex-1 min-w-0">
              <span className="text-xs font-medium text-[#d4d4d4]">Include system diagnostics</span>
              <span className="text-[11px] text-[#9ca3af]">
                App version, OS, Electron/Node versions. No terminal contents, file paths,
                credentials, or personal data. You can review the pre-filled issue body on
                GitHub before submitting.
              </span>
              {diagnostics && includeDiagnostics && (
                <pre
                  className="mt-1 text-[10px] bg-[#0e0e0e] border border-[#2a2a2a] rounded p-2 overflow-x-auto text-[#9ca3af]"
                  data-testid="report-diagnostics-preview"
                >{formatDiagnosticsBlock(diagnostics)}</pre>
              )}
            </span>
          </label>

          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded p-2" role="alert">
              Could not open browser: {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-6 py-3 border-t border-[#3c3c3c]">
          <span className="text-[10px] text-[#6b7280]">GitHub login required to submit</span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-sm rounded bg-[#3c3c3c] hover:bg-[#4a4a4a] text-white"
            >Cancel</button>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="px-4 py-1.5 text-sm rounded bg-[#D97706] hover:bg-[#b45309] disabled:bg-[#3c3c3c] disabled:text-[#6b7280] disabled:cursor-not-allowed text-white"
              data-testid="report-submit"
            >Open in browser</button>
          </div>
        </div>
      </div>
    </div>
  )
}
