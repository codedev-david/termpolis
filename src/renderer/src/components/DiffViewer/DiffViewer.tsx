import React, { useMemo, useState } from 'react'
import { stripAnsi } from '../../lib/exportTerminal'

interface Props {
  rawDiff: string
  onClose: () => void
}

interface DiffLine {
  type: 'header' | 'hunk' | 'add' | 'remove' | 'context' | 'meta'
  text: string
  lineNumber?: number
}

interface DiffFile {
  header: string
  lines: DiffLine[]
}

function parseDiff(raw: string): DiffFile[] {
  const cleaned = stripAnsi(raw)
  const lines = cleaned.split('\n')
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let lineNum = 0

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      current = { header: line, lines: [] }
      files.push(current)
      lineNum = 0
      continue
    }

    if (!current) {
      // If there's no diff --git header, create a default file section
      if (line.startsWith('@@') || line.startsWith('+') || line.startsWith('-')) {
        current = { header: 'Diff Output', lines: [] }
        files.push(current)
      } else {
        continue
      }
    }

    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) {
      current.lines.push({ type: 'meta', text: line })
    } else if (line.startsWith('@@')) {
      // Parse hunk header for line numbers
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/)
      if (match) lineNum = parseInt(match[1], 10) - 1
      current.lines.push({ type: 'hunk', text: line })
    } else if (line.startsWith('+')) {
      lineNum++
      current.lines.push({ type: 'add', text: line, lineNumber: lineNum })
    } else if (line.startsWith('-')) {
      current.lines.push({ type: 'remove', text: line })
    } else {
      lineNum++
      current.lines.push({ type: 'context', text: line, lineNumber: lineNum })
    }
  }

  return files
}

const lineStyles: Record<DiffLine['type'], string> = {
  header: 'bg-[#2d2d2d] text-[#d4d4d4] font-bold',
  hunk: 'bg-[#1e3a5f] text-[#82aaff]',
  add: 'bg-[#1a3a1a] text-[#98c379]',
  remove: 'bg-[#3a1a1a] text-[#e06c75]',
  context: 'text-[#abb2bf]',
  meta: 'text-[#888]',
}

export function DiffViewer({ rawDiff, onClose }: Props) {
  const [copied, setCopied] = useState(false)
  const files = useMemo(() => parseDiff(rawDiff), [rawDiff])

  const handleCopy = () => {
    navigator.clipboard.writeText(stripAnsi(rawDiff))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const extractFilename = (header: string) => {
    // "diff --git a/foo/bar.ts b/foo/bar.ts" -> "foo/bar.ts"
    const match = header.match(/diff --git a\/(.+?) b\//)
    return match ? match[1] : header
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 animate-fadeIn" onClick={onClose}>
      <div
        className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg shadow-2xl flex flex-col"
        style={{ width: '80vw', maxWidth: 900, height: '80vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#3c3c3c]">
          <div className="flex items-center gap-2">
            <i className="fa-solid fa-code-compare text-[#61afef]"></i>
            <span className="text-sm font-semibold text-[#d4d4d4]">Diff Viewer</span>
            <span className="text-xs text-[#888]">({files.length} file{files.length !== 1 ? 's' : ''})</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="px-3 py-1 text-xs bg-[#2d2d2d] hover:bg-[#3c3c3c] text-[#d4d4d4] rounded border border-[#454545] cursor-pointer"
              onClick={handleCopy}
            >
              <i className={`fa-solid ${copied ? 'fa-check' : 'fa-copy'} mr-1`}></i>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              className="text-[#888] hover:text-[#d4d4d4] cursor-pointer px-1"
              onClick={onClose}
            >
              <i className="fa-solid fa-xmark text-lg"></i>
            </button>
          </div>
        </div>

        {/* Diff content */}
        <div className="flex-1 overflow-auto font-mono text-[12px] leading-5">
          {files.length === 0 && (
            <div className="flex items-center justify-center h-full text-[#999]">
              No diff content to display
            </div>
          )}
          {files.map((file, fi) => (
            <div key={fi} className="mb-2">
              {/* File header */}
              <div className="sticky top-0 bg-[#2a2d3a] px-4 py-1.5 border-b border-[#3c3c3c] text-[#82aaff] font-semibold text-[11px]">
                <i className="fa-solid fa-file-code mr-2 text-[10px]"></i>
                {extractFilename(file.header)}
              </div>
              {/* Lines */}
              <div>
                {file.lines.map((line, li) => (
                  <div key={li} className={`flex ${lineStyles[line.type]} hover:brightness-110`}>
                    <span className="w-12 text-right pr-2 text-[10px] text-[#888] select-none flex-shrink-0 border-r border-[#333] leading-5">
                      {line.lineNumber ?? ''}
                    </span>
                    <pre className="pl-2 whitespace-pre-wrap break-all flex-1">{line.text}</pre>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
