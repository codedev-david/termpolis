import React, { useEffect, useRef } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { getTheme } from '../../themes/terminalThemes'
import 'xterm/css/xterm.css'

interface Props {
  terminalId: string
  terminalName: string
  isVisible: boolean
  fontSize: number
  theme: string
  fontFamily: string
}

export function TerminalPane({ terminalId, terminalName, isVisible, fontSize, theme, fontFamily }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const inputBufferRef = useRef('')

  useEffect(() => {
    if (!containerRef.current) return

    // 1. Create Terminal instance
    const term = new Terminal({
      theme: getTheme(theme),
      fontFamily,
      fontSize,
      cursorBlink: true,
      scrollback: 10000,
    })

    // 2. Load FitAddon
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    // 3. Open terminal (attach to DOM) — must come before WebGL
    term.open(containerRef.current)

    // 4. Load WebGL addon (requires DOM attachment)
    try {
      const webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => {
        webglAddon.dispose()
      })
      term.loadAddon(webglAddon)
    } catch {
      // WebGL not available — falls back to canvas renderer automatically
    }

    // 5. Load Unicode11 addon
    const unicode11 = new Unicode11Addon()
    term.loadAddon(unicode11)
    term.unicode.activeVersion = '11'

    // 6. Fit
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

  // Dynamically update theme, font, and fontSize
  useEffect(() => {
    if (!termRef.current) return
    termRef.current.options.fontSize = fontSize
    termRef.current.options.fontFamily = fontFamily
    termRef.current.options.theme = getTheme(theme)
    fitRef.current?.fit()
    window.termpolis.resizeTerminal(terminalId, termRef.current.cols, termRef.current.rows)
  }, [fontSize, theme, fontFamily])

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
