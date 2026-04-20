import React, { useCallback, useEffect, useState } from 'react'
import type { ContextPin } from '../../types'
import { buildInjectionPrompt, estimateTokens } from '../../lib/contextInjection'

interface Props {
  cwd: string
  onClose: () => void
}

export function ContextPinsPanel({ cwd, onClose }: Props) {
  const [pins, setPins] = useState<ContextPin[]>([])
  const [label, setLabel] = useState('')
  const [body, setBody] = useState('')
  const [tags, setTags] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)
  const [builtPrompt, setBuiltPrompt] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!cwd) return
    try {
      const res = await window.contextPins?.list(cwd)
      if (res?.success && Array.isArray(res.data)) setPins(res.data)
    } catch {}
  }, [cwd])

  useEffect(() => { refresh() }, [refresh])

  const handleAdd = useCallback(async () => {
    setError(null)
    if (!label.trim() || !body.trim()) {
      setError('Label and body are required')
      return
    }
    try {
      const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean)
      const res = await window.contextPins?.add(cwd, {
        label: label.trim(),
        body,
        tags: tagList.length ? tagList : undefined,
      })
      if (!res?.success) {
        setError(res?.error ?? 'failed to add pin')
        return
      }
      setLabel('')
      setBody('')
      setTags('')
      await refresh()
    } catch (e: any) {
      setError(e?.message ?? 'failed to add pin')
    }
  }, [cwd, label, body, tags, refresh])

  const handleRemove = useCallback(async (id: string) => {
    try {
      await window.contextPins?.remove(cwd, id)
      await refresh()
    } catch {}
  }, [cwd, refresh])

  const handleBuild = useCallback(async () => {
    setBuilding(true)
    try {
      const result = buildInjectionPrompt(pins, { header: 'Resuming project context' })
      setBuiltPrompt(result.prompt)
    } finally {
      setBuilding(false)
    }
  }, [pins])

  const handleCopy = useCallback(async () => {
    if (!builtPrompt) return
    try { await navigator.clipboard.writeText(builtPrompt) } catch {}
  }, [builtPrompt])

  return (
    <div
      className="flex flex-col h-full border-l border-[#3c3c3c] bg-[#252526] select-none"
      data-testid="context-pins-panel"
      style={{ minWidth: 360 }}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#3c3c3c]">
        <div className="text-xs font-semibold text-[#cccccc] uppercase tracking-wide">
          Pinned Context ({pins.length})
        </div>
        <button
          className="text-[#858585] hover:text-white text-xs px-2"
          onClick={onClose}
          aria-label="Close pinned context panel"
        >
          ×
        </button>
      </div>

      <div className="px-3 py-2 border-b border-[#3c3c3c] space-y-2">
        <input
          aria-label="Pin label"
          className="w-full bg-[#1e1e1e] border border-[#3c3c3c] text-xs text-[#cccccc] px-2 py-1 rounded"
          placeholder="Pin label (e.g. auth middleware notes)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <textarea
          aria-label="Pin body"
          className="w-full h-24 bg-[#1e1e1e] border border-[#3c3c3c] text-xs text-[#cccccc] px-2 py-1 rounded font-mono"
          placeholder="Paste the snippet or insight you want to preserve"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <input
          aria-label="Pin tags"
          className="w-full bg-[#1e1e1e] border border-[#3c3c3c] text-xs text-[#cccccc] px-2 py-1 rounded"
          placeholder="tags (comma-separated, optional)"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
        {error && <div className="text-[#e06c75] text-xs">{error}</div>}
        <button
          className="w-full bg-[#007acc] hover:bg-[#005a9e] text-white text-xs py-1 rounded disabled:opacity-50"
          onClick={handleAdd}
          disabled={!cwd}
        >
          Pin it
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {pins.length === 0 && (
          <div className="text-[#6a6a6a] text-xs text-center py-6">
            No pins yet for this project.
          </div>
        )}
        {pins.map((p) => (
          <div
            key={p.id}
            data-testid="pin-item"
            className="px-3 py-2 border-b border-[#2d2d2d] text-xs"
          >
            <div className="flex items-center gap-2">
              <span className="text-[#569cd6] truncate">{p.label}</span>
              <button
                className="ml-auto text-[#858585] hover:text-[#e06c75] text-[10px]"
                onClick={() => handleRemove(p.id)}
                aria-label={`Remove pin ${p.label}`}
              >
                remove
              </button>
            </div>
            {p.tags && p.tags.length > 0 && (
              <div className="text-[10px] text-[#858585] mt-0.5">{p.tags.join(' · ')}</div>
            )}
            <pre className="mt-1 text-[#cccccc] whitespace-pre-wrap break-words">
              {p.body.length > 400 ? p.body.slice(0, 400) + '…' : p.body}
            </pre>
          </div>
        ))}
      </div>

      <div className="border-t border-[#3c3c3c] p-2 space-y-2">
        <button
          className="w-full bg-[#2d2d2d] hover:bg-[#3c3c3c] text-[#cccccc] text-xs py-1 rounded disabled:opacity-50"
          onClick={handleBuild}
          disabled={building || pins.length === 0}
        >
          {building ? 'Building…' : 'Build re-injection prompt'}
        </button>
        {builtPrompt && (
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-[#858585]">
              <span>{builtPrompt.length} chars · ~{estimateTokens({ prompt: builtPrompt, includedPinIds: [], omittedPinIds: [], totalChars: builtPrompt.length })} tokens</span>
              <button
                className="text-[#569cd6] hover:underline"
                onClick={handleCopy}
              >
                copy
              </button>
            </div>
            <pre
              className="bg-[#1e1e1e] border border-[#3c3c3c] rounded text-[10px] text-[#cccccc] p-2 max-h-40 overflow-auto whitespace-pre-wrap"
              data-testid="built-prompt"
            >
              {builtPrompt}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}

export default ContextPinsPanel
