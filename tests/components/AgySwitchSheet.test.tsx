// agy's switch-all, in a sheet (src/renderer/src/components/Accounts/AgySwitchSheet.tsx, the
// in-app account UI §2.4): one confirmation that names what moves (and the work account's second,
// D14), each agy terminal ended by main's rules (a turn at work waited for, an exit it can't tell
// asked about), the sign-in in the sheet (SignInFlow, here a stand-in), then each conversation
// resumed by its id; a stop before the sign-out puts the ended ones back. Main is the preload's mock.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import type { AccountRowView, AccountsView } from '../../src/shared/agentAccounts'
import type { AgyStepOutcome, AgyStepRequest } from '../../src/shared/accountSwitch'
import type { TerminalSession } from '../../src/renderer/src/types'

vi.mock('../../src/renderer/src/components/Accounts/SignInFlow', () => ({
  SignInFlow: (p: { mode?: string; doneLabel?: string; autoDone?: boolean; account: { id: string }; onDone: (email: string | null) => void; onCancel: () => void }) => (
    <div data-testid="flow" data-mode={p.mode} data-account={p.account.id} data-auto={String(!!p.autoDone)}>
      <button type="button" onClick={() => p.onDone('new@example.test')}>flow-done</button>
      <button type="button" onClick={() => p.onCancel()}>flow-cancel</button>
    </div>
  ),
}))

import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { AgySwitchSheet } from '../../src/renderer/src/components/Accounts/AgySwitchSheet'

function row(over: Partial<AccountRowView>): AccountRowView {
  return {
    id: 'g1', agent: 'agy', label: 'me', email: 'me@example.test', profile: null, folder: null, isDefault: true, autoOffer: true,
    order: 0, connect: false, origin: 'manual', folderExists: false, shares: [], lastEmail: null, connection: null, bypassReady: false,
    terminals: 0, recopyAvailable: false, ...over,
  }
}

function view(accounts: AccountRowView[]): AccountsView {
  return {
    accounts, preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [],
    advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h',
  }
}

const G1 = row({ id: 'g1', label: 'me' })
const G2 = row({ id: 'g2', label: 'other', email: 'other@example.test', isDefault: false, order: 1 })
const GW = row({ id: 'gw', label: 'work', email: 'w@corp.test', isDefault: false, autoOffer: false, order: 2 })
const term = (id: string, name: string, over: Partial<TerminalSession> = {}): TerminalSession => ({
  id, name, color: '#4285F4', shellType: 'powershell', cwd: '/repo', fontSize: 13, theme: 'dark', fontFamily: 'mono', agentCommand: 'agy', agentAccountId: 'g1', ...over,
})
const T1 = term('t1', 'Gemini 1')
const T2 = term('t2', 'Gemini 2')
const st = useTerminalStore.getState

let answers: Record<string, AgyStepOutcome[]>
let held: Array<string | undefined>
const agySwitch = vi.fn(async (req: AgyStepRequest) => {
  held.push(st().relaunching[req.terminalId])
  const queue = answers[`${req.terminalId}:${req.step}`] ?? []
  const next = queue.length > 1 ? queue.shift()! : queue[0]
  return { success: true as const, data: next ?? { kind: 'refused' as const, why: 'no answer' } }
})
const limitLook = vi.fn(async (_id: string) => ({ success: true as const, data: { live: true, status: { status: 'idle' } } }))
const list = vi.fn(async () => ({ success: true as const, data: st().accountsView! }))

function open(targetId: string, terminals: TerminalSession[] = [T1, T2], accounts: AccountRowView[] = [G1, G2, GW]) {
  useTerminalStore.setState({ terminals, accountsView: view(accounts), agySwitchSheet: { targetId }, relaunching: {} })
  return render(<AgySwitchSheet />)
}
const click = (id: string) => fireEvent.click(screen.getByTestId(id))
const mark = (name: string) => screen.getByText(name).closest('li')!.getAttribute('data-mark')

beforeEach(() => {
  answers = {}
  held = []
  agySwitch.mockClear()
  limitLook.mockClear()
  list.mockClear()
  ;(window as unknown as { accounts: unknown }).accounts = { agySwitch, limitLook, list }
})

afterEach(() => {
  useTerminalStore.setState({ agySwitchSheet: null, terminals: [], relaunching: {} })
})

// UI R3-6: the focus starts on Cancel, so a screen reader landed there without hearing that the switch moves every Gemini terminal on this
// computer; the dialog is described by the text of its confirmation.
describe('the confirmation is described to a screen reader (R3-6)', () => {
  const described = (): string => {
    const id = screen.getByRole('dialog').getAttribute('aria-describedby')
    return id ? (document.getElementById(id)?.textContent ?? '') : ''
  }

  it('names the every-terminal move as the dialog\'s description, at the first confirmation', () => {
    open('g2')
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-describedby', 'agy-switch-question')
    expect(described()).toMatch(/moves all 2 Gemini terminals/)
  })

  it('names the work account\'s question as its description at the second one', () => {
    open('gw')
    click('agy-switch-go')
    expect(screen.getByTestId('agy-switch-confirm-work')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-describedby', 'agy-switch-question')
    expect(described()).toBe(screen.getByTestId('agy-switch-confirm-work').querySelector('p')?.textContent)
    expect(described()).toMatch(/isn't offered automatically/)
  })

  it('has no description at the steps after it, whose live region says them', async () => {
    open('g2')
    click('agy-switch-go')
    await waitFor(() => expect(screen.getByTestId('agy-switch-live')).not.toHaveTextContent(/^$/))
    expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-describedby')
  })
})

describe('AgySwitchSheet', () => {
  it('shows nothing until a switch opens it', () => {
    useTerminalStore.setState({ agySwitchSheet: null, accountsView: view([G1]) })
    render(<AgySwitchSheet />)
    expect(screen.queryByTestId('agy-switch')).toBeNull()
  })

  it('says so for an account that is no longer registered, and closes', () => {
    const { unmount } = open('gone')
    expect(screen.getByTestId('agy-switch-gone')).toHaveTextContent('That account isn\'t registered any more.')
    fireEvent.click(screen.getByText('Close'))
    expect(st().agySwitchSheet).toBeNull()
    unmount()
    useTerminalStore.setState({ agySwitchSheet: { targetId: 'g2' }, accountsView: null })
    render(<AgySwitchSheet />)
    expect(screen.getByTestId('agy-switch-gone')).toBeInTheDocument()
  })

  it('names what moves: every Gemini terminal, one, or none open now', async () => {
    const { unmount } = open('g2')
    expect(screen.getByTestId('agy-switch-confirm')).toHaveTextContent('Gemini CLI has one Google sign-in for this whole computer. Switching to other@example.test moves all 2 Gemini terminals; each one resumes its conversation.')
    expect(screen.getByTestId('agy-switch-go')).toHaveTextContent('Switch all Gemini terminals')
    expect(document.getElementById('agy-switch-title')).toHaveTextContent('Switch Gemini CLI to other')
    unmount()
    const one = open('g2', [T1])
    expect(screen.getByTestId('agy-switch-confirm')).toHaveTextContent('moves your Gemini terminal; it resumes its conversation.')
    expect(screen.getByTestId('agy-switch-go')).toHaveTextContent('Switch Gemini CLI')
    one.unmount()
    open('g2', [], [G1, { ...G2, email: undefined }])
    // No email registered: the label.
    expect(screen.getByTestId('agy-switch-confirm')).toHaveTextContent('Switching to other moves new Gemini terminals.')
    expect(screen.queryByTestId('agy-switch-terminals')).toBeNull()
    await act(async () => undefined)
  })

  it('says which terminal is at work now, that it waits for its turn to end', async () => {
    limitLook.mockImplementation(async (id: string) => ({ success: true as const, data: { live: true, status: { status: id === 't2' ? 'working' : 'idle' } } }))
    open('g2')
    await waitFor(() => expect(screen.getByTestId('agy-switch-busy')).toBeInTheDocument())
    expect(screen.getByTestId('agy-switch-busy').closest('li')).toHaveTextContent('Gemini 2working: Termpolis waits for its turn to end first')
    expect(screen.getAllByTestId('agy-switch-busy')).toHaveLength(1)
  })

  it('names none at work when it can\'t look, or before main answers', async () => {
    limitLook.mockRejectedValueOnce(new Error('gone')).mockResolvedValueOnce({ success: false, error: 'x' } as never)
    const { unmount } = open('g2')
    await act(async () => undefined)
    expect(screen.queryByTestId('agy-switch-busy')).toBeNull()
    // An answer after the sheet closed is dropped.
    let late!: (v: unknown) => void
    limitLook.mockImplementationOnce(() => new Promise((resolve) => { late = resolve }) as never)
    unmount()
    const again = open('g2', [T1])
    again.unmount()
    late({ success: true, data: { live: true, status: { status: 'working' } } })
    await act(async () => undefined)
    // With no bridge at all, it just doesn't look.
    ;(window as unknown as { accounts: unknown }).accounts = undefined
    open('g2', [T1])
    expect(screen.getByTestId('agy-switch-confirm')).toBeInTheDocument()
  })

  it('cancels from its confirmation, by its button or Esc', () => {
    const { unmount } = open('g2')
    click('agy-switch-cancel')
    expect(st().agySwitchSheet).toBeNull()
    unmount()
    open('g2')
    fireEvent.keyDown(screen.getByTestId('agy-switch'), { key: 'Escape' })
    expect(st().agySwitchSheet).toBeNull()
    expect(agySwitch).not.toHaveBeenCalled()
  })

  it('ends each terminal holding it, signs agy in inside the sheet, and resumes each conversation by its id', async () => {
    answers = {
      't1:exit': [{ kind: 'exited', conversationId: 'conv-1' }],
      't2:exit': [{ kind: 'exited', conversationId: null }],
      't1:resume': [{ kind: 'resumed', fresh: false, conversationId: 'conv-1' }],
      't2:resume': [{ kind: 'resumed', fresh: true, conversationId: null }],
    }
    open('g2')
    click('agy-switch-go')
    const flow = await screen.findByTestId('flow')
    expect(flow).toHaveAttribute('data-mode', 'agy-switch')
    expect(flow).toHaveAttribute('data-account', 'g2')
    expect(flow).toHaveAttribute('data-auto', 'true')
    expect(agySwitch.mock.calls.map((c) => [c[0].terminalId, c[0].step, c[0].targetId, c[0].shellType])).toEqual([['t1', 'exit', 'g2', 'powershell'], ['t2', 'exit', 'g2', 'powershell']])
    // Each step held its terminal (keys held, no model change meanwhile), and let go after.
    expect(held).toEqual(['account', 'account'])
    expect(st().relaunching).toEqual({})
    fireEvent.click(screen.getByText('flow-done'))
    await waitFor(() => expect(screen.getByTestId('agy-switch-done')).toBeInTheDocument())
    expect(agySwitch.mock.calls.slice(2).map((c) => [c[0].terminalId, c[0].step, c[0].conversationId])).toEqual([['t1', 'resume', 'conv-1'], ['t2', 'resume', null]])
    expect(screen.getByTestId('agy-switch-done')).toHaveTextContent('Gemini CLI is on new@example.test now. 2 of 2 conversations resumed.')
    expect(mark('Gemini 1')).toBe('resumed')
    expect(mark('Gemini 2')).toBe('fresh')
    expect(screen.getByText('Gemini 2').closest('li')).toHaveTextContent('A new conversation: agy couldn\'t find this one')
    expect(screen.getByTestId('agy-switch-live')).toHaveTextContent('Gemini CLI switched.')
    expect(list).toHaveBeenCalled()
    click('agy-switch-done-close')
    expect(st().agySwitchSheet).toBeNull()
  })

  // SW2-9: a Gemini terminal whose user had quit agy by hand has no agy to move: it is left as it is, never started again
  // (a plain `agy` there is a new conversation nobody asked for), and the others go on as before.
  it('leaves a terminal where agy was not running as it is, and resumes the others', async () => {
    answers = {
      't1:exit': [{ kind: 'exited', conversationId: 'conv-1' }],
      't2:exit': [{ kind: 'exited', conversationId: 'conv-gone', alreadyGone: true }],
      't1:resume': [{ kind: 'resumed', fresh: false, conversationId: 'conv-1' }],
    }
    open('g2')
    click('agy-switch-go')
    await screen.findByTestId('flow')
    fireEvent.click(screen.getByText('flow-done'))
    await waitFor(() => expect(screen.getByTestId('agy-switch-done')).toBeInTheDocument())
    expect(agySwitch.mock.calls.filter((c) => c[0].step === 'resume').map((c) => c[0].terminalId)).toEqual(['t1'])
    expect(mark('Gemini 1')).toBe('resumed')
    expect(mark('Gemini 2')).toBe('left')
    expect(screen.getByText('Gemini 2').closest('li')).toHaveTextContent('agy wasn\'t running here: left as it is')
    expect(screen.getByTestId('agy-switch-done')).toHaveTextContent('Gemini CLI is on new@example.test now. 1 of 1 conversation resumed.')
  })

  it('does not start agy in a terminal it left, when the switch stops before the sign-out either', async () => {
    answers = {
      't1:exit': [{ kind: 'exited', conversationId: 'conv-1', alreadyGone: true }],
      't2:exit': [{ kind: 'not-exited', why: 'its box never came back' }],
    }
    open('g2')
    click('agy-switch-go')
    expect(await screen.findByTestId('agy-switch-stopped')).toBeInTheDocument()
    expect(agySwitch.mock.calls.filter((c) => c[0].step === 'resume')).toEqual([])
    expect(mark('Gemini 1')).toBe('left')
  })

  it('offers no close while it ends or resumes terminals, only Stop', async () => {
    let release!: () => void
    agySwitch.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ success: true, data: { kind: 'exited', conversationId: 'c' } }) }) as never)
    open('g2', [T1])
    click('agy-switch-go')
    expect(screen.getByTestId('agy-switch-exiting')).toHaveTextContent('Ending agy in your Gemini terminal…')
    expect(screen.queryByTestId('agy-switch-close')).toBeNull()
    expect(screen.getByTestId('agy-switch-live')).toHaveTextContent('Ending agy in the Gemini terminals.')
    await act(async () => { release() })
    await screen.findByTestId('flow')
  })

  it('waits for a terminal at work to end its turn, and stops on the user\'s word, putting the ended ones back', async () => {
    answers = {
      't1:exit': [{ kind: 'exited', conversationId: 'conv-1' }],
      't2:exit': [{ kind: 'busy' }],
      't1:resume': [{ kind: 'resumed', fresh: false, conversationId: 'conv-1' }],
    }
    open('g2')
    click('agy-switch-go')
    await waitFor(() => expect(mark('Gemini 2')).toBe('waiting'))
    expect(screen.getByText('Gemini 2').closest('li')).toHaveTextContent('agy is working: waiting for its turn to end')
    click('agy-switch-stop-exiting')
    expect(screen.getByTestId('agy-switch-stop-exiting')).toHaveTextContent('Stopping…')
    expect(screen.getByTestId('agy-switch-stop-exiting')).toBeDisabled()
    await waitFor(() => expect(screen.getByTestId('agy-switch-stopped')).toBeInTheDocument(), { timeout: 5000 })
    expect(screen.getByTestId('agy-switch-stopped')).toHaveTextContent('Termpolis stopped before signing agy out: you asked it to.')
    await waitFor(() => expect(mark('Gemini 1')).toBe('resumed'))
    expect(agySwitch.mock.calls.filter((c) => c[0].step === 'resume').map((c) => [c[0].terminalId, c[0].conversationId])).toEqual([['t1', 'conv-1']])
    expect(screen.queryByTestId('flow')).toBeNull()
    click('agy-switch-stopped-close')
    expect(st().agySwitchSheet).toBeNull()
  }, 10_000)

  it('goes on after a turn at work ends', async () => {
    answers = { 't1:exit': [{ kind: 'busy' }, { kind: 'exited', conversationId: 'c1' }] }
    open('g2', [T1])
    click('agy-switch-go')
    await waitFor(() => expect(screen.getByTestId('flow')).toBeInTheDocument(), { timeout: 5000 })
    expect(agySwitch).toHaveBeenCalledTimes(2)
  }, 10_000)

  it('asks when it can\'t tell whether agy exited, and goes on with the user\'s word', async () => {
    answers = { 't1:exit': [{ kind: 'unknown-exit' }, { kind: 'exited', conversationId: 'c1' }] }
    open('g2', [T1])
    click('agy-switch-go')
    expect(await screen.findByTestId('agy-switch-ask')).toHaveTextContent('Termpolis can\'t tell whether agy still runs in Gemini 1, so it typed nothing there.')
    expect(screen.getByTestId('agy-switch-live')).toHaveTextContent('Termpolis can\'t tell whether agy still runs in a terminal.')
    click('agy-switch-exited')
    await screen.findByTestId('flow')
    expect(agySwitch.mock.calls[1][0]).toMatchObject({ terminalId: 't1', step: 'exit', assumeExited: true })
  })

  it('stops when the user says agy may still run there, and puts the ended ones back', async () => {
    answers = {
      't1:exit': [{ kind: 'exited', conversationId: 'conv-1' }],
      't2:exit': [{ kind: 'unknown-exit' }],
      't1:resume': [{ kind: 'not-resumed', why: 'its prompt never came back' }],
    }
    open('g2')
    click('agy-switch-go')
    await screen.findByTestId('agy-switch-ask')
    click('agy-switch-stop')
    expect(await screen.findByTestId('agy-switch-stopped')).toHaveTextContent('Termpolis stopped before signing agy out: agy may still be running in Gemini 2.')
    await waitFor(() => expect(mark('Gemini 1')).toBe('failed'))
    expect(screen.getByText('Gemini 1').closest('li')).toHaveTextContent('Couldn\'t switch here: its prompt never came back')
    expect(screen.getByTestId('agy-switch-live')).toHaveTextContent('The switch stopped before signing agy out.')
  })

  it('closing while it asks stops the switch, and still puts the ended ones back', async () => {
    answers = {
      't1:exit': [{ kind: 'exited', conversationId: 'conv-1' }],
      't2:exit': [{ kind: 'unknown-exit' }],
      't1:resume': [{ kind: 'resumed', fresh: false, conversationId: 'conv-1' }],
    }
    open('g2')
    click('agy-switch-go')
    await screen.findByTestId('agy-switch-ask')
    click('agy-switch-close')
    expect(st().agySwitchSheet).toBeNull()
    await waitFor(() => expect(agySwitch.mock.calls.some((c) => c[0].step === 'resume')).toBe(true))
  })

  it('stops at a terminal it can\'t end, saying why, and puts the ended ones back', async () => {
    answers = {
      // agy named no conversation as it ended: it is resumed as agy starts.
      't1:exit': [{ kind: 'exited', conversationId: null }],
      't2:exit': [{ kind: 'not-exited', why: 'its box never came back' }],
      't1:resume': [{ kind: 'resumed', fresh: true, conversationId: null }],
    }
    open('g2')
    click('agy-switch-go')
    expect(await screen.findByTestId('agy-switch-stopped')).toHaveTextContent('Termpolis stopped before signing agy out: Gemini 2: its box never came back.')
    await waitFor(() => expect(mark('Gemini 1')).toBe('fresh'))
    expect(mark('Gemini 2')).toBe('failed')
    expect(agySwitch.mock.calls.filter((c) => c[0].step === 'resume').map((c) => c[0].conversationId)).toEqual([null])
  })

  it('says main\'s refusal, a failed call, a terminal another switch holds, or an answer it didn\'t expect', async () => {
    const cases: Array<[() => void, string]> = [
      [() => agySwitch.mockResolvedValueOnce({ success: false, error: 'GEMINI_API_KEY is set' } as never), 'Gemini 1: GEMINI_API_KEY is set.'],
      [() => agySwitch.mockRejectedValueOnce(new Error('ipc gone')), 'Gemini 1: ipc gone.'],
      [() => agySwitch.mockRejectedValueOnce('odd'), 'Gemini 1: odd.'],
      [() => useTerminalStore.setState({ relaunching: { t1: 'model' } }), 'Gemini 1: a model change or another switch is running there.'],
      [() => { answers = { 't1:exit': [{ kind: 'resumed', fresh: false, conversationId: null }] } }, 'Gemini 1 couldn\'t be switched.'],
    ]
    for (const [setup, words] of cases) {
      answers = {}
      useTerminalStore.setState({ terminals: [T1], accountsView: view([G1, G2]), agySwitchSheet: { targetId: 'g2' }, relaunching: {} })
      setup()
      const { unmount } = render(<AgySwitchSheet />)
      click('agy-switch-go')
      expect(await screen.findByTestId('agy-switch-stopped')).toHaveTextContent(`Termpolis stopped before signing agy out: ${words}`)
      unmount()
    }
  })

  it('when the sign-in doesn\'t finish: tries it again, or resumes them on the sign-in agy has', async () => {
    answers = {
      't1:exit': [{ kind: 'exited', conversationId: 'conv-1' }],
      't1:resume': [{ kind: 'resumed', fresh: false, conversationId: 'conv-1' }],
    }
    open('g2', [T1])
    click('agy-switch-go')
    fireEvent.click(await screen.findByText('flow-cancel'))
    expect(screen.getByTestId('agy-switch-interrupted')).toHaveTextContent('The sign-in didn\'t finish. Your Gemini terminal is waiting.')
    expect(screen.getByTestId('agy-switch-live')).toHaveTextContent('The sign-in didn\'t finish.')
    click('agy-switch-retry')
    fireEvent.click(await screen.findByText('flow-cancel'))
    click('agy-switch-resume-now')
    await waitFor(() => expect(screen.getByTestId('agy-switch-done')).toBeInTheDocument())
    expect(screen.getByTestId('agy-switch-done')).toHaveTextContent('Gemini CLI is back on its sign-in. 1 of 1 conversation resumed.')
    expect(agySwitch.mock.calls.filter((c) => c[0].step === 'resume')).toHaveLength(1)
  })

  it('has nothing to resume when no terminal was open', async () => {
    open('g2', [])
    click('agy-switch-go')
    fireEvent.click(await screen.findByText('flow-cancel'))
    expect(screen.getByTestId('agy-switch-interrupted').querySelector('p')?.textContent).toBe('The sign-in didn\'t finish.')
    expect(screen.queryByTestId('agy-switch-resume-now')).toBeNull()
    click('agy-switch-retry')
    fireEvent.click(await screen.findByText('flow-done'))
    await waitFor(() => expect(screen.getByTestId('agy-switch-done')).toHaveTextContent('Gemini CLI is on new@example.test now. New Gemini terminals start on it.'))
    expect(agySwitch).not.toHaveBeenCalled()
  })

  it('counts a conversation that didn\'t come back, and two terminals waiting after an unfinished sign-in', async () => {
    answers = {
      't1:exit': [{ kind: 'exited', conversationId: 'a' }],
      't2:exit': [{ kind: 'exited', conversationId: 'b' }],
      't1:resume': [{ kind: 'resumed', fresh: false, conversationId: 'a' }],
      't2:resume': [{ kind: 'not-resumed', why: 'agy never started' }],
    }
    open('g2')
    click('agy-switch-go')
    fireEvent.click(await screen.findByText('flow-cancel'))
    expect(screen.getByTestId('agy-switch-interrupted')).toHaveTextContent('Your 2 Gemini terminals are waiting.')
    click('agy-switch-resume-now')
    await waitFor(() => expect(screen.getByTestId('agy-switch-done')).toHaveTextContent('1 of 2 conversations resumed.'))
    expect(screen.getByText('Gemini 2').closest('li')).toHaveTextContent('Couldn\'t switch here: agy never started')
  })

  it('says resuming one conversation in the singular', async () => {
    let release!: () => void
    answers = { 't1:exit': [{ kind: 'exited', conversationId: 'a' }] }
    open('g2', [T1])
    click('agy-switch-go')
    await screen.findByTestId('flow')
    agySwitch.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ success: true, data: { kind: 'resumed', fresh: false, conversationId: 'a' } }) }) as never)
    fireEvent.click(screen.getByText('flow-done'))
    expect(await screen.findByTestId('agy-switch-resuming')).toHaveTextContent('Resuming the conversation…')
    expect(screen.getByTestId('agy-switch-live')).toHaveTextContent('Resuming the conversations.')
    await act(async () => { release() })
    await waitFor(() => expect(screen.getByTestId('agy-switch-done')).toHaveTextContent('1 of 1 conversation resumed.'))
  })

  it('asks the work account\'s second confirmation before anything is typed (D14), onto it or off it', async () => {
    answers = { 't1:exit': [{ kind: 'exited', conversationId: 'a' }] }
    const { unmount } = open('gw', [T1])
    click('agy-switch-go')
    expect(screen.getByTestId('agy-switch-confirm-work')).toHaveTextContent('work isn\'t offered automatically. Switch Gemini CLI to work?')
    expect(agySwitch).not.toHaveBeenCalled()
    click('agy-switch-confirm-work-no')
    expect(st().agySwitchSheet).toBeNull()
    unmount()
    open('g2', [term('t1', 'Gemini 1', { agentAccountId: 'gw' }), T2])
    click('agy-switch-go')
    expect(screen.getByTestId('agy-switch-confirm-work')).toHaveTextContent('2 Gemini conversations are on work, which isn\'t offered automatically. Carry them to other?')
    expect(screen.getByTestId('agy-switch-confirm-work-yes')).toHaveTextContent('Carry them to other')
    answers = { 't1:exit': [{ kind: 'exited', conversationId: 'a' }], 't2:exit': [{ kind: 'exited', conversationId: 'b' }] }
    click('agy-switch-confirm-work-yes')
    await screen.findByTestId('flow')
    expect(agySwitch).toHaveBeenCalledTimes(2)
  })

  // UI2-2: signing agy out of every terminal on the computer, and carrying a work conversation off its account, are asked
  // with the focus on the safe answer, so the Enter that opened the sheet, pressed again or held, ends it with no switch.
  it('starts its focus on the safe answer in each question, so an extra Enter signs nothing out (UI2-2)', async () => {
    const { unmount } = open('g2', [T1])
    expect(screen.getByTestId('agy-switch-cancel')).toHaveFocus()
    expect(screen.getByTestId('agy-switch-go')).not.toHaveFocus()
    expect(agySwitch).not.toHaveBeenCalled()
    unmount()
    const work = open('gw', [T1])
    click('agy-switch-go')
    expect(screen.getByTestId('agy-switch-confirm-work')).toBeInTheDocument()
    // The control that was clicked went with its step: the trap gives the focus back to the step's own safe control.
    await waitFor(() => expect(screen.getByTestId('agy-switch-confirm-work-no')).toHaveFocus())
    expect(screen.getByTestId('agy-switch-confirm-work-yes')).not.toHaveFocus()
    expect(agySwitch).not.toHaveBeenCalled()
    work.unmount()
    answers = { 't1:exit': [{ kind: 'unknown-exit' }] }
    open('g2', [T1])
    click('agy-switch-go')
    await screen.findByTestId('agy-switch-ask')
    await waitFor(() => expect(screen.getByTestId('agy-switch-stop')).toHaveFocus())
    expect(screen.getByTestId('agy-switch-exited')).not.toHaveFocus()
    expect(agySwitch.mock.calls.filter((c) => c[0].assumeExited)).toEqual([])
  })
})

describe('AgySwitchSheet: leaving mid-switch never strands a terminal (round 1)', () => {
  /** One Gemini terminal, exited, with the sign-in step showing. */
  async function signingIn(terminals: TerminalSession[] = [T1]): Promise<void> {
    answers = {
      't1:exit': [{ kind: 'exited', conversationId: 'conv-1' }],
      't2:exit': [{ kind: 'exited', conversationId: 'conv-2' }],
      't1:resume': [{ kind: 'resumed', fresh: false, conversationId: 'conv-1' }],
      't2:resume': [{ kind: 'resumed', fresh: false, conversationId: 'conv-2' }],
    }
    open('g2', terminals)
    click('agy-switch-go')
    await screen.findByTestId('flow')
  }
  const resumes = (): string[] => agySwitch.mock.calls.filter((c) => c[0].step === 'resume').map((c) => c[0].terminalId)

  it('Stop pressed while the last terminal is being ended stops before agy is signed out', async () => {
    let release: (v: unknown) => void = () => undefined
    agySwitch.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }) as never)
    answers = { 't1:resume': [{ kind: 'resumed', fresh: false, conversationId: 'conv-1' }] }
    open('g2', [T1])
    click('agy-switch-go')
    await screen.findByTestId('agy-switch-exiting')
    // The only terminal is the one being ended: Stop is pressed in that very step.
    fireEvent.click(screen.getByTestId('agy-switch-stop-exiting'))
    await act(async () => { release({ success: true, data: { kind: 'exited', conversationId: 'conv-1' } }) })
    expect(await screen.findByTestId('agy-switch-stopped')).toHaveTextContent('you asked it to')
    expect(screen.queryByTestId('flow')).toBeNull()
    // Nothing signed agy out; the terminal it had ended goes back to its conversation.
    await waitFor(() => expect(resumes()).toEqual(['t1']))
  })

  it('Esc mid sign-in does what the flow\'s own Cancel does: the choices to try again or resume, nothing stranded', async () => {
    await signingIn()
    fireEvent.keyDown(screen.getByTestId('agy-switch'), { key: 'Escape' })
    expect(await screen.findByTestId('agy-switch-interrupted')).toBeInTheDocument()
    expect(screen.queryByTestId('flow')).toBeNull()
    expect(st().agySwitchSheet).not.toBeNull()
    expect(resumes()).toEqual([])
    // Its X is the same.
    click('agy-switch-retry')
    await screen.findByTestId('flow')
    click('agy-switch-close')
    expect(await screen.findByTestId('agy-switch-interrupted')).toBeInTheDocument()
  })

  it('Esc or the X in the interrupted choices resumes what was ended before it closes', async () => {
    await signingIn([T1, T2])
    click('agy-switch-close')
    await screen.findByTestId('agy-switch-interrupted')
    expect(screen.getByTestId('agy-switch-interrupted')).toHaveTextContent('Closing this resumes them now')
    fireEvent.keyDown(screen.getByTestId('agy-switch'), { key: 'Escape' })
    expect(await screen.findByTestId('agy-switch-done')).toBeInTheDocument()
    expect(resumes()).toEqual(['t1', 't2'])
    expect(mark('Gemini 1')).toBe('resumed')
    expect(mark('Gemini 2')).toBe('resumed')
    click('agy-switch-done-close')
    expect(st().agySwitchSheet).toBeNull()
  })

  it('with nothing ended, Esc mid sign-in shows the interrupted view, which has a Close and no resume', async () => {
    answers = {}
    open('g2', [])
    click('agy-switch-go')
    await screen.findByTestId('flow')
    fireEvent.keyDown(screen.getByTestId('agy-switch'), { key: 'Escape' })
    expect(await screen.findByTestId('agy-switch-interrupted')).toHaveTextContent("The sign-in didn't finish.")
    expect(screen.queryByTestId('agy-switch-resume-now')).toBeNull()
    click('agy-switch-interrupted-close')
    expect(st().agySwitchSheet).toBeNull()
    expect(resumes()).toEqual([])
  })
})

describe('AgySwitchSheet: the confirmation says what else a sign-out moves (round 1)', () => {
  it('names the agy that Termpolis does not resume: a swarm worker, another window', () => {
    open('g2', [T1])
    expect(screen.getByTestId('agy-switch-confirm')).toHaveTextContent(
      'An agy running anywhere else on this computer (a swarm worker, another window) moves to the new sign-in too, and Termpolis does not resume it.',
    )
  })
})
