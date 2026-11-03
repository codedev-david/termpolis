// @vitest-environment jsdom
import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TokenSavingsSettings } from '../../src/renderer/src/components/SettingsPane/TokenSavingsSettings'
import { CONTEXT_CAP_CHOICES } from '../../src/main/headroom/shapingEnv'

/**
 * The context-window control in Settings > Token Savings (R3, decision D6 as revised): Off, 500k, 400k,
 * 300k or 200k, Off by default, with copy that says it is opt-in, applies to new Claude Code terminals
 * only, what it does, what it is modelled to save, and that Termpolis cannot see what it does to answers.
 */

const tp = () => (window as unknown as { termpolis: Record<string, ReturnType<typeof vi.fn>> }).termpolis

const totals = (over: Record<string, number> = {}) => ({
  requests: 0, textOrigTokens: 0, textSavedTokens: 0, savedPct: 0, images: 0, imageOrigBytes: 0, imageSavedBytes: 0,
  cacheReadTokens: 0, cacheCreationTokens: 0, inputTokens: 0, outputTokens: 0, retrieves: 0, givebackTokens: 0, ...over,
})

const settingsWith = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: { enabled: true, wireProxy: true, mode: 'aggressive', steering: true, thinkingCap: 0, adaptiveSteering: true, floorControl: true, prefixDecay: true, firstSightElision: 'late', ...over },
})

/** A main process that remembers what it is sent, as the real one does. */
function serve(initial: Record<string, unknown> = {}): { patches: Array<Record<string, unknown>> } {
  let held = settingsWith(initial).data as Record<string, unknown>
  const patches: Array<Record<string, unknown>> = []
  tp().tokenSavingsGetSettings = vi.fn().mockImplementation(async () => ({ success: true, data: { ...held } }))
  tp().tokenSavingsSetSettings = vi.fn().mockImplementation(async (p: Record<string, unknown>) => {
    patches.push(p)
    held = { ...held, ...p }
    return { success: true, data: { ...held } }
  })
  return { patches }
}

beforeEach(() => {
  ;(window as unknown as { termpolis: Record<string, ReturnType<typeof vi.fn>> }).termpolis = {
    tokenSavingsGetSettings: vi.fn().mockResolvedValue(settingsWith()),
    tokenSavingsSetSettings: vi.fn().mockResolvedValue(settingsWith()),
    tokenSavingsGetReceipt: vi.fn().mockResolvedValue({ success: true, data: { session: { netSaved: 0, events: 0, byTool: {} }, cumulative: { netSaved: 0, events: 0, byTool: {} } } }),
    tokenSavingsGetProxyReceipt: vi.fn().mockResolvedValue({ success: true, data: { session: totals(), cumulative: totals() } }),
    tokenSavingsGetUnifiedReceipt: vi.fn().mockResolvedValue({ success: false, error: 'none yet' }),
    tokenSavingsGetProxyStatus: vi.fn().mockResolvedValue({ success: true, data: { enabled: true, running: true, healthy: true, bypassVar: null, selectedMode: 'aggressive', effectiveMode: 'aggressive' } }),
  }
})

const select = async (): Promise<HTMLSelectElement> => (await screen.findByTestId('hr-context-cap-select')) as HTMLSelectElement
const optionValues = (sel: HTMLSelectElement): number[] => [...sel.querySelectorAll('option')].map((o) => Number(o.getAttribute('value')))

describe('the context window control', () => {
  it('offers Off and four windows, largest first, and they are the windows the main process accepts', async () => {
    serve()
    render(<TokenSavingsSettings />)
    const values = optionValues(await select())
    expect(values).toEqual([0, 500_000, 400_000, 300_000, 200_000])
    // The pane cannot import from main, so it lists the windows itself; this keeps the two lists one list.
    expect(values).toEqual([...CONTEXT_CAP_CHOICES])
  })

  it('is Off for settings that do not carry the field, which is what the app does for them', async () => {
    serve()
    render(<TokenSavingsSettings />)
    expect((await select()).value).toBe('0')
  })

  it('shows what the settings hold', async () => {
    serve({ contextCap: 300_000 })
    render(<TokenSavingsSettings />)
    expect((await select()).value).toBe('300000')
  })

  it('shows a value that is not a window as Off, and invents no option for it', async () => {
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY, '300000', null, true, {}]) {
      serve({ contextCap: bad })
      const view = render(<TokenSavingsSettings />)
      const sel = await select()
      expect(sel.value, String(bad)).toBe('0')
      expect(optionValues(sel), String(bad)).toEqual([0, 500_000, 400_000, 300_000, 200_000])
      view.unmount()
    }
  })

  it('shows a window set outside this list as itself, in its place, rather than as one it is not', async () => {
    serve({ contextCap: 250_000 })
    render(<TokenSavingsSettings />)
    const sel = await select()
    expect(sel.value).toBe('250000')
    expect(optionValues(sel)).toEqual([0, 500_000, 400_000, 300_000, 250_000, 200_000])
    expect(sel.querySelector('option[value="250000"]')).toHaveTextContent('250,000 tokens')
    expect(sel.querySelector('option[value="250000"]')).toHaveTextContent('set outside Settings')
    // The windows it offers carry a modelled saving; one the research did not model carries none.
    expect(sel.querySelector('option[value="250000"]')).not.toHaveTextContent('modeled')
  })

  it('shows an unusual window above the list, or below it, in the right place too', async () => {
    serve({ contextCap: 1_000_000 })
    const first = render(<TokenSavingsSettings />)
    expect(optionValues(await select())).toEqual([0, 1_000_000, 500_000, 400_000, 300_000, 200_000])
    first.unmount()
    serve({ contextCap: 100_000 })
    render(<TokenSavingsSettings />)
    expect(optionValues(await select())).toEqual([0, 500_000, 400_000, 300_000, 200_000, 100_000])
  })

  // The longest option is about 70 characters, which measured 513 px: wider than the pane at the narrowest window the app
  // allows (600 px with the sidebar open leaves 360), so the tab got a horizontal scrollbar. A select that may not be wider
  // than the label it sits in shrinks to the pane and shows the chosen option cut off; the list it opens is not narrowed.
  // jsdom lays nothing out, so what is held is the class that carries the limit.
  it('cannot be wider than the pane it sits in', async () => {
    serve()
    render(<TokenSavingsSettings />)
    expect(((await select()).className).split(/\s+/)).toContain('max-w-full')
  })

  it('sends the choice alone, as a one-key patch, and as a NUMBER', async () => {
    const { patches } = serve()
    render(<TokenSavingsSettings />)
    fireEvent.change(await select(), { target: { value: '300000' } })
    await waitFor(() => expect(tp().tokenSavingsSetSettings).toHaveBeenCalledTimes(1))
    expect(patches).toEqual([{ contextCap: 300_000 }])
    expect(typeof patches[0].contextCap).toBe('number')
    await waitFor(() => expect(((screen.getByTestId('hr-context-cap-select')) as HTMLSelectElement).value).toBe('300000'))
  })

  it('turns Off by sending 0', async () => {
    const { patches } = serve({ contextCap: 400_000 })
    render(<TokenSavingsSettings />)
    expect((await select()).value).toBe('400000')
    fireEvent.change(await select(), { target: { value: '0' } })
    await waitFor(() => expect(patches).toEqual([{ contextCap: 0 }]))
    await waitFor(() => expect(((screen.getByTestId('hr-context-cap-select')) as HTMLSelectElement).value).toBe('0'))
  })

  it('has a name a screen reader can read and the same dark control as the others', async () => {
    serve()
    render(<TokenSavingsSettings />)
    const sel = await select()
    // The wrapping label names it: a separate aria-label would hide the words the user can see.
    expect(sel.getAttribute('aria-label')).toBeNull()
    expect(screen.getByLabelText(/Compact long Claude Code conversations at/)).toBe(sel)
    expect(sel.className).toContain('bg-[#2d2d2d]')
    expect(sel.className).toContain('text-[#d4d4d4]')
    for (const o of sel.querySelectorAll('option')) expect(o.className).toContain('bg-[#2d2d2d]')
  })

  it('is there, and usable, whatever the proxy and the tool-output compression are set to: it depends on neither', async () => {
    const { patches } = serve({ enabled: false, wireProxy: false })
    tp().tokenSavingsGetProxyStatus = vi.fn().mockResolvedValue({ success: true, data: { enabled: false, running: false, healthy: false, bypassVar: null, selectedMode: 'aggressive', effectiveMode: 'aggressive' } })
    render(<TokenSavingsSettings />)
    const sel = await select()
    expect(sel.disabled).toBe(false)
    fireEvent.change(sel, { target: { value: '200000' } })
    await waitFor(() => expect(patches).toEqual([{ contextCap: 200_000 }]))
  })

  it('is not in the way of the other controls: changing it does not touch them', async () => {
    const { patches } = serve({ thinkingCap: 8000 })
    render(<TokenSavingsSettings />)
    fireEvent.change(await select(), { target: { value: '500000' } })
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).not.toHaveProperty('thinkingCap')
    expect(((await screen.findByTestId('hr-thinking-cap')) as HTMLSelectElement).value).toBe('8000')
  })
})

describe('what the control says', () => {
  it('puts a modelled saving on each window, labelled as modelled, and none on Off', async () => {
    serve()
    render(<TokenSavingsSettings />)
    const sel = await select()
    const text = (v: number): string => sel.querySelector(`option[value="${v}"]`)?.textContent ?? ''
    expect(text(0)).toContain('Off')
    expect(text(0)).not.toMatch(/\d%/)
    expect(text(500_000)).toContain('500,000 tokens')
    expect(text(500_000)).toContain('estimated saving about 5 to 7%')
    expect(text(500_000)).not.toContain('modeled saving')
    expect(text(400_000)).toContain('modeled saving about 10 to 13%, for a 1M-window model')
    expect(text(300_000)).toContain('modeled saving about 16 to 21%, for a 1M-window model')
    expect(text(200_000)).toContain('modeled saving about 20 to 29%, for a 1M-window model')
  })

  it('says it is Off by default and a choice, and what Off means', async () => {
    serve()
    render(<TokenSavingsSettings />)
    const status = await screen.findByTestId('hr-context-cap-status')
    expect(status).toHaveTextContent('Off')
    expect(status).toHaveTextContent('Claude Code decides when to compact')
    expect(screen.getByTestId('hr-context-cap-note')).toHaveTextContent('off until you choose it')
  })

  it('says, once a window is chosen, that it reaches new Claude Code terminals only', async () => {
    serve({ contextCap: 300_000 })
    render(<TokenSavingsSettings />)
    const status = await screen.findByTestId('hr-context-cap-status')
    expect(status).toHaveTextContent('Set to 300,000 tokens for new Claude Code terminals, unless you already have a window of your own')
    expect(status.getAttribute('role')).toBe('status')
    expect(status).toHaveTextContent('new Claude Code terminals')
    expect(status).toHaveTextContent('already open')
    // The note says it again, for someone who has not chosen yet.
    expect(screen.getByTestId('hr-context-cap-note')).toHaveTextContent('new Claude Code terminals only')
  })

  it('follows a change at once', async () => {
    serve()
    render(<TokenSavingsSettings />)
    expect(await screen.findByTestId('hr-context-cap-status')).toHaveTextContent('Off')
    fireEvent.change(await select(), { target: { value: '200000' } })
    await waitFor(() => expect(screen.getByTestId('hr-context-cap-status')).toHaveTextContent('Set to 200,000 tokens'))
  })

  it('says what it does and what it costs', async () => {
    serve()
    render(<TokenSavingsSettings />)
    const note = await screen.findByTestId('hr-context-cap-note')
    expect(note).toHaveTextContent('compacts a long conversation into a summary')
    expect(note).toHaveTextContent('re-reads the whole history')
    expect(note).toHaveTextContent('A smaller window makes it compact sooner')
    expect(note).toHaveTextContent('works from the summary instead')
  })

  it('says Termpolis cannot measure the effect on answers, and that the saving is modelled from one person\'s history, not promised', async () => {
    serve()
    render(<TokenSavingsSettings />)
    const note = await screen.findByTestId('hr-context-cap-note')
    expect(note).toHaveTextContent('Termpolis cannot measure what that does to the quality of answers on your work')
    expect(note).toHaveTextContent('modeled, not measured')
    expect(note).toHaveTextContent('one person’s October Claude Code history')
    expect(note).toHaveTextContent('15,000 to 80,000 tokens lost to each one')
    expect(note).toHaveTextContent('not a promise')
  })

  it('says exactly what it reads, what an unreadable file means, and which other terminals get the variable', async () => {
    serve()
    render(<TokenSavingsSettings />)
    const note = await screen.findByTestId('hr-context-cap-note')
    expect(note).toHaveTextContent('reads the window variable in the env block, and any saved window, of your Claude Code settings files')
    expect(note).toHaveTextContent('A file it cannot read for a moment is tried once more, and if it still cannot be read the window is left unset, because Termpolis cannot tell')
    expect(note).toHaveTextContent('Terminals that swarm workers, agents and a paired phone open through Termpolis get the variable too')
    expect(note).toHaveTextContent('Codex and Gemini CLI ignore it')
    expect(note).not.toHaveTextContent('reads the env and window keys')
  })

  it('says a smaller window and Late overlap, so the two savings are not added', async () => {
    serve()
    render(<TokenSavingsSettings />)
    expect(await screen.findByTestId('hr-context-cap-note')).toHaveTextContent('Late and a smaller window overlap, so together they save less than the two figures added')
  })

  it('names the places a window lives that this variable also beats and Termpolis cannot read', async () => {
    serve()
    render(<TokenSavingsSettings />)
    const note = await screen.findByTestId('hr-context-cap-note')
    expect(note).toHaveTextContent('It also wins over a window saved in a subagent’s definition, in a --settings argument, or in your organization’s managed settings (the managed-settings file included), none of which Termpolis reads')
    expect(note).not.toHaveTextContent('wins over a window set in a subagent’s definition')
    // "does not read", not "cannot read": a managed-settings FILE in a system folder is one an app could read.
    expect(note).not.toHaveTextContent('Termpolis can read')
    expect(note).not.toHaveTextContent('none of which Termpolis cannot')
  })

  // What a person who turns the window on is told about its reach, read against Anthropic's own pages: subagents compact
  // at the variable's window too (sub-agents page), /autocompact typed in a session is reported as overridden and not
  // saved (model-config page), and what a resumed conversation already longer than the window does is not documented
  // anywhere, so the pane says that instead of guessing.
  it('says Claude Code\'s subagents compact at it too, that /autocompact is overridden while it is on, and that nothing is known about a resumed long conversation', async () => {
    serve()
    render(<TokenSavingsSettings />)
    const note = await screen.findByTestId('hr-context-cap-note')
    expect(note).toHaveTextContent('Claude Code’s subagents use the variable’s window too, so they compact sooner as well')
    expect(note).toHaveTextContent('While it is on, /autocompact typed inside a session is reported as overridden and not saved')
    expect(note).toHaveTextContent('Anthropic does not say what a resumed conversation that is already longer than the window does')
    expect(note).not.toHaveTextContent('subagents of a Workflow')
  })

  // The note is long (three paragraphs). What a person decides on and what Termpolis reads stay in view; the limits
  // (where it does not look, and what else the window touches) are folded under a summary that says what is inside,
  // CLOSED until opened, and the text is still in the page for a screen reader and for a search.
  it('folds the limits under a labelled summary, closed by default, and keeps what the person decides on outside it', async () => {
    serve()
    render(<TokenSavingsSettings />)
    const note = await screen.findByTestId('hr-context-cap-note')
    const folded = within(note).getByTestId('hr-context-cap-limits') as HTMLDetailsElement
    expect(folded.tagName).toBe('DETAILS')
    expect(folded.open).toBe(false)
    expect(folded.querySelector('summary')).toHaveTextContent('Where it does not look, and what else it affects')
    // Inside the fold: the places it cannot see and what else it touches.
    for (const s of ['--autocompact', '/autocompact typed inside a session', 'managed-settings file', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'Workflow Orchestrator']) expect(folded, s).toHaveTextContent(s)
    // Outside it, in plain view: what it sets, for whom, what it never overrides, and what is read.
    const outside = (note.cloneNode(true) as HTMLElement)
    outside.querySelector('[data-testid="hr-context-cap-limits"]')?.remove()
    for (const s of ['applies to new Claude Code terminals only', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'never overrides a window you set yourself', 'when a terminal opens', 'Codex and Gemini CLI ignore it']) expect(outside.textContent, s).toContain(s)
    expect(outside.textContent).not.toContain('--autocompact')
    // Opening it shows the same text without any change to what is said.
    fireEvent.click(folded.querySelector('summary') as HTMLElement)
    expect(folded.open).toBe(true)
  })

  // The variable beats a saved autoCompactWindow wherever it lives, but Claude Code writes an env entry of a
  // --settings argument or of managed settings over the value Termpolis passed, so that one wins over this setting.
  it('says an env entry in a --settings argument or managed settings that sets the variable itself wins over this setting', async () => {
    serve()
    render(<TokenSavingsSettings />)
    const note = await screen.findByTestId('hr-context-cap-note')
    expect(note).toHaveTextContent('an env entry in the last two that sets the variable itself is different, and wins over this setting')
  })

  it('says CLAUDE_AUTOCOMPACT_PCT_OVERRIDE is a percentage of the window in force, so a smaller window compacts sooner than that person chose', async () => {
    serve()
    render(<TokenSavingsSettings />)
    const note = await screen.findByTestId('hr-context-cap-note')
    expect(note).toHaveTextContent('If you also set CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, it is a percentage of the window in force, so with a smaller window compaction comes sooner than you chose')
  })

  it('says a Claude session the Workflow Orchestrator starts itself gets neither the variable nor the proxy route', async () => {
    serve()
    render(<TokenSavingsSettings />)
    const note = await screen.findByTestId('hr-context-cap-note')
    expect(note).toHaveTextContent('A Claude session the Workflow Orchestrator’s agent steps start themselves gets neither this variable nor the proxy route')
  })

  it('says where the figures stop being true: a model whose own window is smaller, the exact point, the interpolated 500,000', async () => {
    serve()
    render(<TokenSavingsSettings />)
    const note = await screen.findByTestId('hr-context-cap-note')
    expect(note).toHaveTextContent('Claude Code never uses a window larger than the model’s')
    expect(note).toHaveTextContent('zero on a model whose own window is already this size or smaller')
    expect(note).toHaveTextContent('Anthropic does not say how close to the window a conversation compacts')
    expect(note).toHaveTextContent('500,000 figure is estimated between two modeled windows')
  })

  it('says the context meters do not show the smaller window', async () => {
    serve()
    render(<TokenSavingsSettings />)
    const note = await screen.findByTestId('hr-context-cap-note')
    expect(note).toHaveTextContent('Context meters, in Claude Code’s status line and in Termpolis, keep measuring against the model’s full window')
    expect(note).toHaveTextContent('so they do not show how near the smaller one is')
  })

  it('says what Termpolis sets, that it works without the proxy, and what it never overrides', async () => {
    serve()
    render(<TokenSavingsSettings />)
    const note = await screen.findByTestId('hr-context-cap-note')
    expect(note).toHaveTextContent('CLAUDE_CODE_AUTO_COMPACT_WINDOW')
    expect(note).toHaveTextContent('with or without the compression proxy')
    expect(note).toHaveTextContent('never overrides a window you set yourself')
    expect(note).toHaveTextContent('in your environment')
    expect(note).toHaveTextContent('env block of your Claude Code settings.json')
    expect(note).toHaveTextContent('/autocompact')
    expect(note).toHaveTextContent('It cannot see a --autocompact flag typed on a command line')
    expect(note).toHaveTextContent('Claude Code lets this variable win over that flag, so to use the flag turn this Off first')
    expect(note).toHaveTextContent('reads the window variable in the env block, and any saved window, of your Claude Code settings files')
    expect(note).toHaveTextContent('the project’s in the folder a terminal opens in')
    expect(note).toHaveTextContent('when a terminal opens, and nothing else in them')
  })

  it('has its own heading, apart from the output-token controls it follows', async () => {
    serve()
    render(<TokenSavingsSettings />)
    const group = await screen.findByTestId('hr-context-cap')
    expect(within(group).getByRole('heading', { level: 4 })).toHaveTextContent('Long conversations')
    expect(group).toContainElement(await select())
  })
})

describe('the line the control sits above', () => {
  it('reads as a sentence: a figure is never run into the word before it', async () => {
    serve()
    tp().tokenSavingsGetReceipt = vi.fn().mockResolvedValue({ success: true, data: { session: { netSaved: 12_345, events: 3, byTool: {} }, cumulative: { netSaved: 99_999, events: 40, byTool: {} } } })
    render(<TokenSavingsSettings />)
    await waitFor(() => expect(screen.getByTestId('hr-session-saved')).toHaveTextContent('12,345'))
    const line = screen.getByTestId('hr-session-saved').parentElement as HTMLElement
    // A space lost in the markup shows as "session12,345", which no assertion on the figure's own element can see.
    expect(line.textContent).toBe('Tool-output savings — session 12,345 · all-time 99,999 tokens')
  })
})

describe('the control when the main process is old or fails', () => {
  it('does not render before the settings have loaded, and survives a failed load', async () => {
    tp().tokenSavingsGetSettings = vi.fn().mockResolvedValue({ success: false, error: 'boom' })
    render(<TokenSavingsSettings />)
    await waitFor(() => expect(tp().tokenSavingsGetSettings).toHaveBeenCalled())
    expect(screen.queryByTestId('hr-context-cap')).toBeNull()
  })

  it('keeps what it showed when a save fails', async () => {
    serve({ contextCap: 400_000 })
    tp().tokenSavingsSetSettings = vi.fn().mockResolvedValue({ success: false, error: 'nope' })
    render(<TokenSavingsSettings />)
    fireEvent.change(await select(), { target: { value: '200000' } })
    await waitFor(() => expect(tp().tokenSavingsSetSettings).toHaveBeenCalledTimes(1))
    expect(((await screen.findByTestId('hr-context-cap-select')) as HTMLSelectElement).value).toBe('400000')
  })
})
