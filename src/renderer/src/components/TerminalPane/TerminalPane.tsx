import React, { useEffect, useRef } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import 'xterm/css/xterm.css'

interface Props {
  terminalId: string
  terminalName: string
  isVisible: boolean
}

export function TerminalPane({ terminalId, terminalName, isVisible }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const inputBufferRef = useRef('')

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      theme: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#aeafad' },
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 14,
      cursorBlink: true,
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    fitAddon.fit()
    termRef.current = term
    fitRef.current = fitAddon

    term.onData((data) => {
      window.termpolis.writeToTerminal(terminalId, data)
      if (data === '\r') {
        const cmd = inputBufferRef.current.trim()
        if (cmd) window.termpolis.appendHistory(terminalId, terminalName, cmd)
        inputBufferRef.current = ''
      } else if (data === '\u007f') {
        inputBufferRef.current = inputBufferRef.current.slice(0, -1)
      } else if (!data.startsWith('\x1b')) {
        inputBufferRef.current += data
      }
    })

    const unsub = window.termpolis.onTerminalData((id, data) => {
      if (id === terminalId) term.write(data)
    })

    const ro = new ResizeObserver(() => {
      fitAddon.fit()
      window.termpolis.resizeTerminal(terminalId, term.cols, term.rows)
    })
    ro.observe(containerRef.current)

    return () => {
      unsub()
      ro.disconnect()
      term.dispose()
    }
  }, [terminalId])

  useEffect(() => {
    if (isVisible && fitRef.current && termRef.current) {
      setTimeout(() => {
        fitRef.current!.fit()
        window.termpolis.resizeTerminal(terminalId, termRef.current!.cols, termRef.current!.rows)
      }, 0)
    }
  }, [isVisible, terminalId])

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      style={{ visibility: isVisible ? 'visible' : 'hidden', padding: 4 }}
    />
  )
}
