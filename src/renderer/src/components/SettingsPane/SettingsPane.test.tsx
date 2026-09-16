import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Profiler } from 'react'
import { render, act } from '@testing-library/react'
import { SettingsPane } from './SettingsPane'
import { useTerminalStore } from '../../store/terminalStore'

vi.mock('@monaco-editor/react', () => ({ default: () => null }))

const ok = <T,>(data: T) => Promise.resolve({ success: true, data })

beforeEach(() => {
  useTerminalStore.setState({
    terminals: [{ id: 't1', name: 'one', cwd: '/a', shellType: 'bash' }] as never,
    activeTerminalId: 't1',
    defaultShell: 'bash',
    allowAppMouseControl: false,
    swarmNotification: null,
  })
  ;(window as any).termpolis = {
    getAvailableShells: () => ok([]),
    getHomedir: () => ok('/home/d'),
    readConfigFile: () => ok(''),
    getAppVersion: () => ok({ version: '1.0.0' }),
    memoryGetPrimerLimit: () => ok(10),
  }
})

/** Counts commits of the SettingsPane subtree once its mount effects have settled. */
const renderCounted = async (): Promise<{ current: number }> => {
  const commits = { current: 0 }
  render(
    <Profiler id="settings-pane" onRender={() => { commits.current++ }}>
      <SettingsPane />
    </Profiler>,
  )
  // Flush the mount promises (shells, homedir, config files) so their commits
  // land before the counter is sampled.
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return commits
}

describe('SettingsPane store subscription', () => {
  it('does not re-render on the cwd churn of a shell it is not showing', async () => {
    const commits = await renderCounted()
    const before = commits.current

    act(() => { useTerminalStore.getState().updateTerminal('t1', { name: 'renamed' }) })

    expect(commits.current).toBe(before)
  })

  it('does not re-render on an unrelated store write', async () => {
    const commits = await renderCounted()
    const before = commits.current

    act(() => { useTerminalStore.getState().setSwarmNotification({ message: 'hi', type: 'success' }) })

    expect(commits.current).toBe(before)
  })

  it('still re-renders when a setting it renders changes', async () => {
    const commits = await renderCounted()
    const before = commits.current

    act(() => { useTerminalStore.getState().setDefaultShell('zsh') })

    expect(commits.current).toBeGreaterThan(before)
  })

  it('still tracks the active terminal cwd it displays', async () => {
    const commits = await renderCounted()
    const before = commits.current

    act(() => { useTerminalStore.getState().updateTerminal('t1', { cwd: '/moved' }) })

    expect(commits.current).toBeGreaterThan(before)
  })
})
