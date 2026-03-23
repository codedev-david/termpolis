import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { TerminalStatusBar } from '../../src/renderer/src/components/StatusBar/TerminalStatusBar'

// Mock the pollingService module to avoid real subscriptions
vi.mock('../../src/renderer/src/lib/pollingService', () => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}))

beforeAll(() => {
  ;(window as any).termpolis = {
    ...(window as any).termpolis,
    getTerminalStatus: vi.fn().mockResolvedValue({ success: true, data: { gitBranch: '' } }),
  }
})

describe('TerminalStatusBar', () => {
  it('renders shell type', () => {
    render(<TerminalStatusBar terminalId="t1" shellType="bash" cwd="/home/user" />)
    expect(screen.getByText('Bash')).toBeInTheDocument()
  })

  it('renders cwd', () => {
    render(<TerminalStatusBar terminalId="t1" shellType="powershell" cwd="/home/dev/project" />)
    expect(screen.getByText('/home/dev/project')).toBeInTheDocument()
  })

  it('renders git branch when provided via parsedBranch prop', () => {
    render(<TerminalStatusBar terminalId="t1" shellType="bash" cwd="/repo" parsedBranch="feature/xyz" />)
    expect(screen.getByText('feature/xyz')).toBeInTheDocument()
  })
})
