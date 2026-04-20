import React, { useCallback, useRef } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import { TerminalPane } from '../TerminalPane/TerminalPane'
import { SplitDivider } from './SplitDivider'
import { extractBuffer, generateFilename } from '../../lib/exportTerminal'
import type { PaneNode } from '../../types'

interface Props {
  node: PaneNode
  onSplitRatioChange?: (path: number[], ratio: number) => void
  path?: number[]
}

function TerminalPaneWrapper({ terminalId }: { terminalId: string }) {
  const terminal = useTerminalStore(s => s.terminals.find(t => t.id === terminalId))
  const activeTerminalId = useTerminalStore(s => s.activeTerminalId)
  const setActiveTerminal = useTerminalStore(s => s.setActiveTerminal)
  const removeTerminal = useTerminalStore(s => s.removeTerminal)
  const splitTerminal = useTerminalStore(s => s.splitTerminal)
  const termInstanceRef = useRef<any>(null)

  const handleTerminalReady = useCallback((term: any) => {
    termInstanceRef.current = term
  }, [])

  const handleExport = useCallback(() => {
    const term = termInstanceRef.current
    if (!term || !terminal) return
    const content = extractBuffer(term)
    const defaultFilename = generateFilename(terminal.name)
    window.termpolis.exportTerminal({ content, defaultFilename })
  }, [terminal])

  const handleClose = useCallback(() => {
    window.termpolis.killTerminal(terminalId)
    removeTerminal(terminalId)
  }, [terminalId, removeTerminal])

  const handleSplit = useCallback(
    async (direction: 'horizontal' | 'vertical') => {
      if (!terminal) return
      const { v4: uuidv4 } = await import('uuid')
      const newId = uuidv4()
      const res = await window.termpolis.createTerminal(newId, terminal.shellType, terminal.cwd)
      if (!res.success) return
      const newTerminal = {
        id: newId,
        name: `${terminal.name} (split)`,
        color: terminal.color,
        shellType: terminal.shellType,
        cwd: terminal.cwd,
        fontSize: terminal.fontSize,
        theme: terminal.theme,
        fontFamily: terminal.fontFamily,
      }
      useTerminalStore.setState(s => ({
        terminals: [...s.terminals, newTerminal],
      }))
      splitTerminal(terminalId, direction, newId)
    },
    [terminal, terminalId, splitTerminal]
  )

  if (!terminal) return null

  const isActive = activeTerminalId === terminalId

  return (
    <div
      className={`flex flex-col h-full w-full overflow-hidden ${isActive ? 'ring-1 ring-[#007acc]' : ''}`}
      onClick={() => setActiveTerminal(terminalId)}
    >
      {/* Header bar */}
      <div
        className="flex items-center gap-2 px-2 py-1 bg-[#2d2d2d] shrink-0"
        style={{ borderLeft: `3px solid ${terminal.color}` }}
      >
        <span className="text-xs font-medium truncate flex-1">{terminal.name}</span>
        <button
          onClick={(e) => { e.stopPropagation(); handleSplit('vertical') }}
          className="text-[#9ca3af] hover:text-white text-xs px-1"
          title="Split Right"
        >
          <i className="fa-solid fa-columns"></i>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); handleSplit('horizontal') }}
          className="text-[#9ca3af] hover:text-white text-xs px-1"
          title="Split Down"
        >
          <i className="fa-solid fa-grip-lines"></i>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); handleExport() }}
          className="text-[#9ca3af] hover:text-white text-xs px-1"
          title="Export terminal output"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13 11v3H3v-3H1v3a2 2 0 002 2h10a2 2 0 002-2v-3h-2zM8 0L4 4h3v6h2V4h3L8 0z" transform="rotate(180 8 8)" />
          </svg>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); handleClose() }}
          className="text-[#9ca3af] hover:text-white text-xs px-1"
          aria-label={`Close ${terminal.name}`}
        >&#x2715;</button>
      </div>
      {/* Terminal */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        <TerminalPane
          terminalId={terminal.id}
          terminalName={terminal.name}
          shellType={terminal.shellType}
          cwd={terminal.cwd}
          isVisible={true}
          fontSize={terminal.fontSize}
          theme={terminal.theme}
          fontFamily={terminal.fontFamily}
          onTerminalReady={handleTerminalReady}
          onSplitRight={() => handleSplit('vertical')}
          onSplitDown={() => handleSplit('horizontal')}
        />
      </div>
    </div>
  )
}

export function PaneRenderer({ node, onSplitRatioChange, path = [] }: Props) {
  // All hooks must run in the same order on every render — do not place any
  // hook call after a conditional early return, otherwise a node transitioning
  // from terminal → split (e.g. after clicking Split Right) changes the hook
  // count and React tears down the tree with "Rendered more hooks" error.
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const handleDrag = useCallback(
    (ratio: number) => {
      onSplitRatioChange?.(path, ratio)
    },
    [onSplitRatioChange, path]
  )

  if (node.type === 'terminal') {
    return <TerminalPaneWrapper terminalId={node.terminalId} />
  }

  const isHorizontal = node.direction === 'horizontal'

  return (
    <div
      ref={splitContainerRef}
      className={`flex ${isHorizontal ? 'flex-col' : 'flex-row'} w-full h-full`}
    >
      <div style={{ flex: `${node.ratio} 1 0%`, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        <PaneRenderer
          node={node.children[0]}
          onSplitRatioChange={onSplitRatioChange}
          path={[...path, 0]}
        />
      </div>
      <SplitDivider
        direction={node.direction}
        onDrag={handleDrag}
        parentRef={splitContainerRef}
      />
      <div style={{ flex: `${1 - node.ratio} 1 0%`, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        <PaneRenderer
          node={node.children[1]}
          onSplitRatioChange={onSplitRatioChange}
          path={[...path, 1]}
        />
      </div>
    </div>
  )
}
