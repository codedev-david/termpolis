// The focus trap every account sheet holds the keyboard with (src/renderer/src/hooks/useFocusTrap.ts):
// Tab goes round the controls a browser can reach (a closed <details> hides its contents but not its
// <summary>), never stalls on one that won't take the focus, comes back to the sheet when the focused
// control goes away at a step change (so Esc keeps working), and gives the focus back on close, to the
// terminal when the control that opened the sheet is gone.
import React, { useState } from 'react'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Sheet } from '../../src/renderer/src/components/Accounts/Sheet'
import { focusables } from '../../src/renderer/src/hooks/useFocusTrap'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'

afterEach(() => {
  cleanup()
  useTerminalStore.setState({ activeTerminalId: null })
  document.body.innerHTML = ''
})

/** What a browser does: it does not focus anything inside a closed <details> but its summary
 *  (the contents are not rendered); jsdom has no layout and does. */
function browserFocus(): () => void {
  const original = HTMLElement.prototype.focus
  HTMLElement.prototype.focus = function (this: HTMLElement, ...args: []) {
    const details = this.closest('details')
    if (details && !details.open && !(this.tagName === 'SUMMARY' && this.parentElement === details)) return
    return original.apply(this, args)
  }
  return () => { HTMLElement.prototype.focus = original }
}

const name = (el: Element | null): string => (el ? (el as HTMLElement).getAttribute('data-testid') ?? el.tagName.toLowerCase() : 'null')
const tab = (shift = false): string => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', shiftKey: shift })
  return name(document.activeElement)
}

function Form({ open = false }: { open?: boolean }) {
  return (
    <Sheet title="Add" icon="fa-user" testId="sheet" onClose={() => undefined}>
      <input data-testid="first" />
      <details data-testid="adv" open={open}>
        <summary data-testid="sum">Advanced</summary>
        <input data-testid="inner-a" />
        <details data-testid="inner-details">
          <summary data-testid="inner-sum">More</summary>
          <button type="button" data-testid="deep">deep</button>
        </details>
      </details>
      <button type="button" data-testid="submit">Add</button>
    </Sheet>
  )
}

describe('Tab with the focus on the sheet itself, no control in it having it', () => {
  it('goes to the first control, and Shift+Tab to the last', () => {
    render(<Form />)
    const sheet = screen.getByTestId('sheet')
    sheet.focus()
    expect(document.activeElement).toBe(sheet)
    expect(tab()).toBe('sheet-close')
    sheet.focus()
    expect(tab(true)).toBe('submit')
  })
})

describe('a press on the dark backdrop behind a sheet (UI-R1-C)', () => {
  const sheet = (onClose?: () => void) => render(
    <Sheet title="Title" icon="fa-x" testId="s" onClose={onClose}>
      <button type="button" data-testid="inner">Inside</button>
    </Sheet>,
  )

  it('keeps the keyboard in the sheet, so Esc still closes it', () => {
    const onClose = vi.fn()
    sheet(onClose)
    screen.getByTestId('inner').focus()
    const press = fireEvent.mouseDown(screen.getByTestId('s-overlay'))
    // The browser would have moved the focus to the page: the default is prevented, and the sheet holds it.
    expect(press).toBe(false)
    expect(document.activeElement).toBe(screen.getByTestId('s'))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('leaves a press inside the sheet alone', () => {
    sheet(vi.fn())
    screen.getByTestId('inner').focus()
    expect(fireEvent.mouseDown(screen.getByTestId('inner'))).toBe(true)
    expect(fireEvent.mouseDown(screen.getByTestId('s'))).toBe(true)
    expect(document.activeElement).toBe(screen.getByTestId('inner'))
  })
})

describe('keys in a sheet (UI-R1-I)', () => {
  it('takes Tab and Shift+Tab from the browser: its default is prevented, so only the sheet\'s own controls get the focus', () => {
    render(<Form />)
    screen.getByTestId('first').focus()
    expect(fireEvent.keyDown(document.activeElement!, { key: 'Tab' })).toBe(false)
    expect(fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })).toBe(false)
  })

  it('keeps Esc from reaching a listener above the sheet, so the swarm dashboard under it stays open', () => {
    const onClose = vi.fn()
    const above = vi.fn()
    document.addEventListener('keydown', above)
    try {
      render(<Sheet title="T" icon="fa-x" testId="s" onClose={onClose}><button type="button">x</button></Sheet>)
      fireEvent.keyDown(screen.getByTestId('s'), { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(above).not.toHaveBeenCalled()
      // Any other key goes on up as it did.
      fireEvent.keyDown(screen.getByTestId('s'), { key: 'a' })
      expect(above).toHaveBeenCalledTimes(1)
    } finally {
      document.removeEventListener('keydown', above)
    }
  })

  it('does nothing about Esc for a sheet that cannot be closed (a step that must finish)', () => {
    const above = vi.fn()
    document.addEventListener('keydown', above)
    try {
      render(<Sheet title="T" icon="fa-x" testId="s"><button type="button">x</button></Sheet>)
      fireEvent.keyDown(screen.getByTestId('s'), { key: 'Escape' })
      expect(above).toHaveBeenCalledTimes(1)
    } finally {
      document.removeEventListener('keydown', above)
    }
  })
})

describe('focusables: the controls a keyboard can reach', () => {
  it('includes a <summary>, and leaves out what a closed <details> hides', () => {
    const { container } = render(<Form />)
    const seen = focusables(container.querySelector('[data-testid="sheet"]') as HTMLElement).map(name)
    expect(seen).toEqual(['sheet-close', 'first', 'sum', 'submit'])
  })

  it('takes in an open <details>, and the summary of one nested in it', () => {
    const { container } = render(<Form open />)
    const seen = focusables(container.querySelector('[data-testid="sheet"]') as HTMLElement).map(name)
    expect(seen).toEqual(['sheet-close', 'first', 'sum', 'inner-a', 'inner-sum', 'submit'])
  })
})

describe('Tab and Shift+Tab never stall, in a browser that cannot focus what a closed <details> hides', () => {
  it('goes round every reachable control, forward and back', () => {
    const restore = browserFocus()
    try {
      render(<Form />)
      screen.getByTestId('first').focus()
      const forward = Array.from({ length: 5 }, () => tab())
      expect(forward).toEqual(['sum', 'submit', 'sheet-close', 'first', 'sum'])
      const back = Array.from({ length: 5 }, () => tab(true))
      expect(back).toEqual(['first', 'sheet-close', 'submit', 'sum', 'first'])
    } finally {
      restore()
    }
  })

  it('moves on when a control will not take the focus (a list of candidates it can try)', () => {
    const restore = browserFocus()
    try {
      render(
        <Sheet title="Add" icon="fa-user" testId="sheet" onClose={() => undefined}>
          <button type="button" data-testid="a">a</button>
          <button type="button" data-testid="stuck">stuck</button>
          <button type="button" data-testid="b">b</button>
        </Sheet>,
      )
      const stuck = screen.getByTestId('stuck')
      const takes = stuck.focus
      stuck.focus = () => undefined
      screen.getByTestId('a').focus()
      expect(tab()).toBe('b')
      expect(tab(true)).toBe('a')
      stuck.focus = takes
    } finally {
      restore()
    }
  })

  it('does not loop for ever when nothing will take the focus', () => {
    render(
      <Sheet title="Add" icon="fa-user" testId="sheet" onClose={() => undefined}>
        <button type="button" data-testid="a">a</button>
      </Sheet>,
    )
    const sheet = screen.getByTestId('sheet')
    for (const el of Array.from(sheet.querySelectorAll<HTMLElement>('button'))) el.focus = () => undefined
    expect(() => fireEvent.keyDown(sheet, { key: 'Tab' })).not.toThrow()
  })
})

describe('a sheet whose focused control goes away at a step change', () => {
  function Steps({ onClose }: { onClose: () => void }) {
    const [step, setStep] = useState(0)
    return (
      <Sheet title="Sign in" icon="fa-user" testId="sheet" onClose={onClose}>
        {step === 0 && <button type="button" data-autofocus="" data-testid="pick" onClick={() => setStep(1)}>Pick</button>}
        {step === 1 && <p data-testid="working">Working…</p>}
        {step === 2 && <button type="button" data-autofocus="" data-testid="again" onClick={() => setStep(0)}>Again</button>}
        <button type="button" data-testid="to-two" onClick={() => setStep(2)}>two</button>
      </Sheet>
    )
  }

  it('keeps the keyboard in the sheet, so Esc still closes it', async () => {
    let closed = 0
    render(<Steps onClose={() => { closed++ }} />)
    expect(document.activeElement).toBe(screen.getByTestId('pick'))
    await act(async () => { fireEvent.click(screen.getByTestId('pick')) })
    // The button that had the focus is gone; the focus is in the sheet, not on <body>.
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' })
    expect(closed).toBe(1)
  })

  it('puts the focus on the new step\'s own control when it has one', async () => {
    render(<Steps onClose={() => undefined} />)
    await act(async () => { fireEvent.click(screen.getByTestId('pick')) })
    await act(async () => { fireEvent.click(screen.getByTestId('to-two')) })
    expect(document.activeElement).toBe(screen.getByTestId('again'))
  })

  it('leaves the focus alone while it is on a control that stays', async () => {
    render(<Steps onClose={() => undefined} />)
    screen.getByTestId('to-two').focus()
    await act(async () => { fireEvent.click(screen.getByTestId('to-two')) })
    expect(document.activeElement).toBe(screen.getByTestId('to-two'))
  })
})

describe('where the focus goes when a sheet closes', () => {
  function Opener() {
    const [phase, setPhase] = useState<'button' | 'sheet' | 'closed'>('button')
    return (
      <>
        <div data-terminal-id="t1"><textarea data-testid="term" /></div>
        {phase === 'button' && <button type="button" data-testid="opener" onClick={() => setPhase('sheet')}>Open</button>}
        {phase === 'sheet' && <Sheet title="S" icon="fa-user" testId="sheet" onClose={() => setPhase('closed')}><button type="button" data-testid="in">in</button></Sheet>}
      </>
    )
  }

  it('is back on the control that opened it, when that is still there', () => {
    function Stays() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" data-testid="opener" onClick={() => setOpen(true)}>Open</button>
          {open && <Sheet title="S" icon="fa-user" testId="sheet" onClose={() => setOpen(false)}><button type="button">in</button></Sheet>}
        </>
      )
    }
    render(<Stays />)
    screen.getByTestId('opener').focus()
    fireEvent.click(screen.getByTestId('opener'))
    fireEvent.keyDown(screen.getByTestId('sheet'), { key: 'Escape' })
    expect(document.activeElement).toBe(screen.getByTestId('opener'))
  })

  it('is the terminal, when the control that opened the sheet went with it (a menu item)', () => {
    useTerminalStore.setState({ activeTerminalId: 't1' })
    render(<Opener />)
    screen.getByTestId('opener').focus()
    // The opener unmounts in the very commit the sheet mounts in, as an account menu's item does.
    fireEvent.click(screen.getByTestId('opener'))
    expect(screen.queryByTestId('opener')).toBeNull()
    fireEvent.keyDown(screen.getByTestId('sheet'), { key: 'Escape' })
    expect(document.activeElement).toBe(screen.getByTestId('term'))
  })

  it('is left where it falls when there is no terminal to give it to', () => {
    render(<Opener />)
    screen.getByTestId('opener').focus()
    fireEvent.click(screen.getByTestId('opener'))
    expect(() => fireEvent.keyDown(screen.getByTestId('sheet'), { key: 'Escape' })).not.toThrow()
  })
})
