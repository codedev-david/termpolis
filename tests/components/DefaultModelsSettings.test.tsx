import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { DefaultModelsSettings } from '../../src/renderer/src/components/SettingsPane/DefaultModelsSettings'
import { getAgentModelDefaults, setAgentModelDefault } from '../../src/renderer/src/lib/agentModelDefaults'

const CATALOG = {
  claude: { provider: 'claude', models: [{ id: 'opus', label: 'Opus' }], source: 'builtin', fetchedAt: 0 },
  codex: { provider: 'codex', models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }, { id: 'gpt-5.5', label: 'GPT-5.5' }], source: 'cli', fetchedAt: 1 },
  gemini: { provider: 'gemini', models: [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' }], source: 'cli', fetchedAt: 1 },
}
const NOTHING_FOUND = {
  claude: CATALOG.claude,
  codex: { provider: 'codex', models: [], source: 'builtin', fetchedAt: 0 },
  gemini: { provider: 'gemini', models: [], source: 'builtin', fetchedAt: 0 },
}

let getModelCatalog: ReturnType<typeof vi.fn>
let refreshModelCatalog: ReturnType<typeof vi.fn>
let onModelCatalogUpdated: ReturnType<typeof vi.fn>
let pushCatalog: ((c: unknown) => void) | undefined
let unsubscribe: ReturnType<typeof vi.fn>

const values = (el: HTMLElement): string[] =>
  Array.from(el.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value)
const select = (p: string) => screen.getByTestId(`settings-default-model-${p}`) as HTMLSelectElement

beforeEach(() => {
  localStorage.clear()
  pushCatalog = undefined
  unsubscribe = vi.fn()
  getModelCatalog = vi.fn(async () => ({ success: true, data: CATALOG }))
  refreshModelCatalog = vi.fn(async () => ({ success: true, data: CATALOG }))
  onModelCatalogUpdated = vi.fn((cb: (c: unknown) => void) => { pushCatalog = cb; return unsubscribe })
  ;(window as any).termpolis = { getModelCatalog, refreshModelCatalog, onModelCatalogUpdated }
})
afterEach(() => { delete (window as any).termpolis })

describe('DefaultModelsSettings', () => {
  it('lists the three agents, each starting on "Agent\'s own default"', async () => {
    render(<DefaultModelsSettings />)
    expect(screen.getByText('Default Models')).toBeInTheDocument()
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('OpenAI Codex')).toBeInTheDocument()
    expect(screen.getByText('Antigravity CLI')).toBeInTheDocument()
    for (const p of ['claude', 'codex', 'gemini']) {
      expect(select(p).value).toBe('')
      expect(select(p).options[0].textContent).toBe("Agent's own default")
    }
  })

  it('offers Claude its four always-latest aliases, whatever the catalog says', async () => {
    render(<DefaultModelsSettings />)
    expect(values(select('claude'))).toEqual(['', 'fable', 'opus', 'sonnet', 'haiku'])
    expect(select('claude').textContent).toContain('Fable · most capable')
    expect(select('claude').textContent).toMatch(/Haiku · \d+% cheaper/)
  })

  it("offers Codex and the Antigravity CLI the models each one's own list holds", async () => {
    render(<DefaultModelsSettings />)
    await waitFor(() => expect(values(select('codex'))).toEqual(['', 'gpt-5.6-sol', 'gpt-5.5']))
    expect(values(select('gemini'))).toEqual(['', 'gemini-3.8-flash-high'])
    // One agent's models never leak into another's menu.
    expect(select('codex').textContent).not.toContain('Gemini')
    expect(select('gemini').textContent).not.toContain('GPT')
  })

  it('saves a choice per agent and keeps the others untouched', async () => {
    render(<DefaultModelsSettings />)
    await waitFor(() => expect(values(select('codex')).length).toBeGreaterThan(1))
    fireEvent.change(select('claude'), { target: { value: 'haiku' } })
    fireEvent.change(select('codex'), { target: { value: 'gpt-5.5' } })
    expect(getAgentModelDefaults()).toEqual({ claude: 'haiku', codex: 'gpt-5.5' })
    expect(select('claude').value).toBe('haiku')
    expect(select('codex').value).toBe('gpt-5.5')
    expect(select('gemini').value).toBe('')
    fireEvent.change(select('gemini'), { target: { value: 'gemini-3.8-flash-high' } })
    expect(getAgentModelDefaults()).toEqual({ claude: 'haiku', codex: 'gpt-5.5', gemini: 'gemini-3.8-flash-high' })
  })

  it('clears one agent when it goes back to "Agent\'s own default"', async () => {
    setAgentModelDefault('claude', 'opus')
    setAgentModelDefault('codex', 'gpt-5.5')
    render(<DefaultModelsSettings />)
    expect(select('claude').value).toBe('opus')
    fireEvent.change(select('claude'), { target: { value: '' } })
    expect(getAgentModelDefaults()).toEqual({ codex: 'gpt-5.5' })
    expect(select('claude').value).toBe('')
  })

  it('shows what was saved earlier, across a reopen of Settings', async () => {
    setAgentModelDefault('gemini', 'gemini-3.8-flash-high')
    const { unmount } = render(<DefaultModelsSettings />)
    unmount()
    render(<DefaultModelsSettings />)
    await waitFor(() => expect(select('gemini').value).toBe('gemini-3.8-flash-high'))
  })

  it('keeps showing a saved model the agent no longer lists, so the setting is never hidden', async () => {
    setAgentModelDefault('codex', 'gpt-5.3-codex')
    render(<DefaultModelsSettings />)
    await waitFor(() => expect(values(select('codex'))).toContain('gpt-5.5'))
    expect(select('codex').value).toBe('gpt-5.3-codex')
    expect(select('codex').textContent).toContain('gpt-5.3-codex (not in the current list)')
  })

  it('says why a list is empty and what to do about it', async () => {
    getModelCatalog = vi.fn(async () => ({ success: true, data: NOTHING_FOUND }))
    ;(window as any).termpolis.getModelCatalog = getModelCatalog
    render(<DefaultModelsSettings />)
    expect(await screen.findByTestId('settings-default-model-codex-hint')).toHaveTextContent(/Codex publishes its model list after it has run once/)
    expect(screen.getByTestId('settings-default-model-gemini-hint')).toHaveTextContent(/ask the Antigravity CLI/)
    expect(screen.queryByTestId('settings-default-model-claude-hint')).not.toBeInTheDocument()
    // Only the "own default" row: nothing invented to fill the gap.
    expect(values(select('codex'))).toEqual([''])
  })

  it('drops the hint once a list arrives', async () => {
    getModelCatalog = vi.fn(async () => ({ success: true, data: NOTHING_FOUND }))
    ;(window as any).termpolis.getModelCatalog = getModelCatalog
    render(<DefaultModelsSettings />)
    await screen.findByTestId('settings-default-model-codex-hint')
    await waitFor(() => expect(pushCatalog).toBeTypeOf('function'))
    act(() => { pushCatalog!(CATALOG) })
    await waitFor(() => expect(values(select('codex'))).toContain('gpt-5.5'))
    expect(screen.queryByTestId('settings-default-model-codex-hint')).not.toBeInTheDocument()
  })

  it('refreshes the lists on request, and says so', async () => {
    getModelCatalog = vi.fn(async () => ({ success: true, data: NOTHING_FOUND }))
    ;(window as any).termpolis.getModelCatalog = getModelCatalog
    render(<DefaultModelsSettings />)
    await screen.findByTestId('settings-default-model-codex-hint')
    fireEvent.click(screen.getByTestId('settings-default-models-refresh'))
    expect(screen.getByTestId('settings-default-models-status')).toHaveTextContent('Asking each agent for its models…')
    expect(screen.getByTestId('settings-default-models-refresh')).toBeDisabled()
    await waitFor(() => expect(screen.getByTestId('settings-default-models-status')).toHaveTextContent('Model lists updated.'))
    expect(refreshModelCatalog).toHaveBeenCalledTimes(1)
    expect(values(select('codex'))).toContain('gpt-5.5')
    expect(screen.getByTestId('settings-default-models-refresh')).not.toBeDisabled()
  })

  it.each([
    ['a failed reply', async () => ({ success: false, error: 'nope' })],
    ['an empty reply', async () => ({ success: true })],
    ['a thrown error', async () => { throw new Error('agy not installed') }],
  ])('reports %s without losing the lists it already has', async (_label, impl) => {
    refreshModelCatalog = vi.fn(impl)
    ;(window as any).termpolis.refreshModelCatalog = refreshModelCatalog
    render(<DefaultModelsSettings />)
    await waitFor(() => expect(values(select('codex'))).toContain('gpt-5.5'))
    fireEvent.click(screen.getByTestId('settings-default-models-refresh'))
    await waitFor(() => expect(screen.getByTestId('settings-default-models-status')).toHaveTextContent('Could not read the model lists.'))
    expect(values(select('codex'))).toContain('gpt-5.5')
    expect(screen.getByTestId('settings-default-models-refresh')).not.toBeDisabled()
  })

  it('still renders Claude, with the other two empty, when the catalog read fails or is absent', async () => {
    getModelCatalog = vi.fn(async () => { throw new Error('ipc down') })
    ;(window as any).termpolis.getModelCatalog = getModelCatalog
    render(<DefaultModelsSettings />)
    await waitFor(() => expect(getModelCatalog).toHaveBeenCalled())
    expect(values(select('claude'))).toContain('sonnet')
    expect(values(select('codex'))).toEqual([''])
  })

  it('survives the model bridge being missing altogether', () => {
    ;(window as any).termpolis = {}
    render(<DefaultModelsSettings />)
    expect(values(select('claude'))).toContain('opus')
    expect(values(select('gemini'))).toEqual([''])
  })

  it('survives the bridge throwing on first contact', () => {
    ;(window as any).termpolis = { getModelCatalog: () => { throw new Error('boom') } }
    render(<DefaultModelsSettings />)
    expect(values(select('claude'))).toContain('opus')
  })

  it('stops listening for catalog updates when it closes', async () => {
    const { unmount } = render(<DefaultModelsSettings />)
    await waitFor(() => expect(onModelCatalogUpdated).toHaveBeenCalled())
    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('ignores a reply that lands after it closed', async () => {
    let resolve!: (v: unknown) => void
    ;(window as any).termpolis.getModelCatalog = vi.fn(() => new Promise((r) => { resolve = r }))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = render(<DefaultModelsSettings />)
    unmount()
    await act(async () => { resolve({ success: true, data: CATALOG }) })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
