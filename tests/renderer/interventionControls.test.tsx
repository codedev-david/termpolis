import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { InterventionControls } from '../../src/renderer/src/components/ActivityFeed/InterventionControls'

describe('InterventionControls', () => {
  let writer: { writeToTerminal: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    writer = { writeToTerminal: vi.fn() }
  })

  it('renders all three control buttons and the steer input', () => {
    render(<InterventionControls terminalId="t1" writer={writer} />)
    expect(screen.getByTestId('intervention-pause')).toBeInTheDocument()
    expect(screen.getByTestId('intervention-cancel')).toBeInTheDocument()
    expect(screen.getByTestId('intervention-interrupt')).toBeInTheDocument()
    expect(screen.getByTestId('intervention-steer-input')).toBeInTheDocument()
  })

  it('shows agent label when provided', () => {
    render(<InterventionControls terminalId="t1" writer={writer} agentLabel="claude-1" />)
    expect(screen.getByTestId('intervention-agent-label').textContent).toBe('claude-1')
  })

  it('Pause button writes ESC to the terminal', () => {
    render(<InterventionControls terminalId="t1" writer={writer} />)
    fireEvent.click(screen.getByTestId('intervention-pause'))
    expect(writer.writeToTerminal).toHaveBeenCalledWith('t1', '\x1b')
  })

  it('Cancel button writes Ctrl-C', () => {
    render(<InterventionControls terminalId="t1" writer={writer} />)
    fireEvent.click(screen.getByTestId('intervention-cancel'))
    expect(writer.writeToTerminal).toHaveBeenCalledWith('t1', '\x03')
  })

  it('Interrupt button writes double Ctrl-C', () => {
    render(<InterventionControls terminalId="t1" writer={writer} />)
    fireEvent.click(screen.getByTestId('intervention-interrupt'))
    expect(writer.writeToTerminal).toHaveBeenCalledWith('t1', '\x03\x03')
  })

  it('Steer button disabled when input is empty', () => {
    render(<InterventionControls terminalId="t1" writer={writer} />)
    const btn = screen.getByTestId('intervention-steer-send') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('Steer button enabled when input has text, writes on click and clears input', () => {
    render(<InterventionControls terminalId="t1" writer={writer} />)
    const input = screen.getByTestId('intervention-steer-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'use the other library' } })
    const btn = screen.getByTestId('intervention-steer-send') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(writer.writeToTerminal).toHaveBeenCalledWith('t1', 'use the other library\n')
    expect(input.value).toBe('')
  })

  it('Enter in steer input submits', () => {
    render(<InterventionControls terminalId="t1" writer={writer} />)
    const input = screen.getByTestId('intervention-steer-input')
    fireEvent.change(input, { target: { value: 'pivot' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(writer.writeToTerminal).toHaveBeenCalledWith('t1', 'pivot\n')
  })

  it('Shift+Enter in steer input does not submit', () => {
    render(<InterventionControls terminalId="t1" writer={writer} />)
    const input = screen.getByTestId('intervention-steer-input')
    fireEvent.change(input, { target: { value: 'hold' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(writer.writeToTerminal).not.toHaveBeenCalled()
  })

  it('Enter with empty input is a no-op', () => {
    render(<InterventionControls terminalId="t1" writer={writer} />)
    const input = screen.getByTestId('intervention-steer-input')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(writer.writeToTerminal).not.toHaveBeenCalled()
  })

  it('shows last action after a successful dispatch', () => {
    render(<InterventionControls terminalId="t1" writer={writer} />)
    fireEvent.click(screen.getByTestId('intervention-pause'))
    const last = screen.getByTestId('intervention-last-action')
    expect(last.textContent).toMatch(/Pause/)
  })

  it('falls back to window.termpolis when writer prop is omitted', () => {
    const winWrite = vi.fn()
    ;(window as any).termpolis = { writeToTerminal: winWrite }
    render(<InterventionControls terminalId="t1" />)
    fireEvent.click(screen.getByTestId('intervention-cancel'))
    expect(winWrite).toHaveBeenCalledWith('t1', '\x03')
    delete (window as any).termpolis
  })

  it('no-ops when neither writer nor window.termpolis is available', () => {
    // Remove window.termpolis just in case a prior test set it
    const prev = (window as any).termpolis
    delete (window as any).termpolis
    render(<InterventionControls terminalId="t1" />)
    fireEvent.click(screen.getByTestId('intervention-pause'))
    // nothing to assert other than no throw; restore any prior state
    if (prev) (window as any).termpolis = prev
  })
})
