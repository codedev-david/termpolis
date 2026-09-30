import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { AgentConnectStep } from '../../src/renderer/src/components/AgentIntegration/AgentConnectStep'

const connectBox = () => screen.getByTestId('agent-connect-toggle') as HTMLInputElement
const hookBox = () => screen.getByTestId('agent-primer-hook-toggle') as HTMLInputElement

describe('AgentConnectStep', () => {
  it('explains the step, lists the writes and says how to undo it', () => {
    render(<AgentConnectStep connect primerHook onChange={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'Connect your coding agents' })).toBeInTheDocument()
    expect(screen.getByTestId('agent-writes-list')).toBeInTheDocument()
    // No status here, so nothing claims an agent is or is not installed.
    expect(screen.queryByTestId('agent-writes-claude-installed')).toBeNull()
    expect(screen.getByTestId('onboarding-agent-step')).toHaveTextContent(
      'Change or undo this any time in Settings ▸ Agent Integration. Disconnecting removes everything Termpolis wrote.',
    )
    expect(screen.getByRole('checkbox', { name: 'Connect agents' })).toBe(connectBox())
    expect(screen.getByRole('checkbox', { name: 'Also load project memory when any Claude Code session starts' })).toBe(hookBox())
  })

  it('shows the choice it is given', () => {
    const { rerender } = render(<AgentConnectStep connect primerHook={false} onChange={vi.fn()} />)
    expect(connectBox().checked).toBe(true)
    expect(hookBox().checked).toBe(false)
    rerender(<AgentConnectStep connect={false} primerHook onChange={vi.fn()} />)
    expect(connectBox().checked).toBe(false)
    expect(hookBox().checked).toBe(true)
  })

  it('reports the connect box, keeping the hook choice', () => {
    const onChange = vi.fn()
    const { rerender } = render(<AgentConnectStep connect primerHook onChange={onChange} />)
    fireEvent.click(connectBox())
    expect(onChange).toHaveBeenLastCalledWith({ connect: false, primerHook: true })
    rerender(<AgentConnectStep connect={false} primerHook={false} onChange={onChange} />)
    fireEvent.click(connectBox())
    expect(onChange).toHaveBeenLastCalledWith({ connect: true, primerHook: false })
  })

  it('reports the hook box while connecting', () => {
    const onChange = vi.fn()
    const { rerender } = render(<AgentConnectStep connect primerHook onChange={onChange} />)
    expect(hookBox()).toBeEnabled()
    expect(hookBox().closest('label')!.className).toContain('cursor-pointer')
    fireEvent.click(hookBox())
    expect(onChange).toHaveBeenLastCalledWith({ connect: true, primerHook: false })
    rerender(<AgentConnectStep connect primerHook={false} onChange={onChange} />)
    fireEvent.click(hookBox())
    expect(onChange).toHaveBeenLastCalledWith({ connect: true, primerHook: true })
  })

  it('greys out the hook box when not connecting', () => {
    render(<AgentConnectStep connect={false} primerHook onChange={vi.fn()} />)
    expect(hookBox()).toBeDisabled()
    const label = hookBox().closest('label')!
    expect(label.className).toContain('opacity-50')
    expect(label.className).not.toContain('cursor-pointer')
  })
})
