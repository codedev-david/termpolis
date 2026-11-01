// The sheet a fresh launch opens when the agent's preferred account is out of usage and another is free
// (src/renderer/src/components/Accounts/LaunchAskSheet.tsx): what it says, each button's word back to the
// launch, Esc as Cancel, and nothing at all when nothing is asked.
import React from 'react'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LaunchAskSheet } from '../../src/renderer/src/components/Accounts/LaunchAskSheet'
import { _resetLaunchAskForTest, askInApp } from '../../src/renderer/src/lib/launchAsk'
import type { LaunchAskContext } from '../../src/renderer/src/lib/launchAsk'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'

const CTX: LaunchAskContext = {
  agent: 'claude', limited: { id: 'acc_a', label: 'personal' }, until: 'until 4:00 pm',
  options: [{ id: 'acc_b', label: 'codedev' }, { id: 'acc_c', label: 'spare' }],
}

beforeEach(() => {
  _resetLaunchAskForTest()
  useTerminalStore.setState({ launchAsk: null })
})
afterEach(() => cleanup())

describe('LaunchAskSheet', () => {
  it('shows nothing until a launch asks', () => {
    render(<LaunchAskSheet />)
    expect(screen.queryByTestId('launch-ask')).toBeNull()
  })

  it('says whose usage ran out and until when, and offers the first way out first', async () => {
    render(<LaunchAskSheet />)
    let answer!: Promise<unknown>
    act(() => { answer = askInApp(CTX) })
    // Said under the title, and announced politely.
    expect(screen.getAllByText('Claude Code: personal is out of usage until 4:00 pm. Launch on codedev?')).toHaveLength(2)
    expect(screen.getByRole('status')).toHaveTextContent('Claude Code: personal is out of usage until 4:00 pm. Launch on codedev?')
    expect(screen.getByTestId('launch-ask-text')).toHaveTextContent('personal will not answer until it is back. codedev is free now.')
    expect(screen.getByTestId('launch-ask-first')).toHaveTextContent('Launch on codedev')
    expect(screen.getAllByTestId('launch-ask-other').map((b) => b.textContent)).toEqual(['Launch on spare'])
    expect(screen.getByTestId('launch-ask-anyway')).toHaveTextContent('Launch on personal anyway')
    // The main button holds the focus: Enter launches on the first way out.
    expect(document.activeElement).toBe(screen.getByTestId('launch-ask-first'))
    act(() => { fireEvent.click(screen.getByTestId('launch-ask-first')) })
    expect(await answer).toEqual({ kind: 'on', accountId: 'acc_b' })
    expect(screen.queryByTestId('launch-ask')).toBeNull()
  })

  it.each([
    ['launch-ask-other', { kind: 'on', accountId: 'acc_c' }],
    ['launch-ask-anyway', { kind: 'anyway' }],
    ['launch-ask-cancel', { kind: 'cancel' }],
  ])('%s answers %j', async (testid, expected) => {
    render(<LaunchAskSheet />)
    let answer!: Promise<unknown>
    act(() => { answer = askInApp(CTX) })
    act(() => { fireEvent.click(screen.getByTestId(testid)) })
    expect(await answer).toEqual(expected)
  })

  it('treats Esc and the close button as Cancel', async () => {
    render(<LaunchAskSheet />)
    let answer!: Promise<unknown>
    act(() => { answer = askInApp(CTX) })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(await answer).toEqual({ kind: 'cancel' })
    act(() => { answer = askInApp(CTX) })
    fireEvent.click(screen.getByTestId('launch-ask-close'))
    expect(await answer).toEqual({ kind: 'cancel' })
  })

  it('has no other-ways row when there is only one way out, and no time when none is known', () => {
    render(<LaunchAskSheet />)
    act(() => { void askInApp({ ...CTX, until: '', options: [CTX.options[0]] }) })
    expect(screen.queryByTestId('launch-ask-other')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Claude Code: personal is out of usage. Launch on codedev?')
  })
})
