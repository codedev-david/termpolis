import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import {
  beginModelSwitch,
  endModelSwitch,
  modelSwitchTarget,
  useModelSwitch,
  resetModelSwitches,
} from '../../src/renderer/src/lib/modelSwitchState'

beforeEach(() => { resetModelSwitches() })

describe('modelSwitchState', () => {
  it('claims a terminal once: a second claim, while the first is in flight, is refused', () => {
    expect(beginModelSwitch('t1', 'opus')).toBe(true)
    expect(beginModelSwitch('t1', 'sonnet')).toBe(false)
    expect(modelSwitchTarget('t1')).toBe('opus') // the refused claim changed nothing
  })

  it('keeps terminals apart', () => {
    expect(beginModelSwitch('t1', 'opus')).toBe(true)
    expect(beginModelSwitch('t2', 'haiku')).toBe(true)
    expect(modelSwitchTarget('t1')).toBe('opus')
    expect(modelSwitchTarget('t2')).toBe('haiku')
    expect(modelSwitchTarget('t3')).toBeUndefined()
  })

  it('lets the terminal be switched again once the first switch ends', () => {
    beginModelSwitch('t1', 'opus')
    endModelSwitch('t1')
    expect(modelSwitchTarget('t1')).toBeUndefined()
    expect(beginModelSwitch('t1', 'sonnet')).toBe(true)
  })

  it('ending a switch that was never begun is harmless', () => {
    expect(() => endModelSwitch('nope')).not.toThrow()
    expect(modelSwitchTarget('nope')).toBeUndefined()
  })

  it('reset forgets everything', () => {
    beginModelSwitch('t1', 'opus')
    beginModelSwitch('t2', 'haiku')
    resetModelSwitches()
    expect(modelSwitchTarget('t1')).toBeUndefined()
    expect(modelSwitchTarget('t2')).toBeUndefined()
  })
})

describe('useModelSwitch', () => {
  function Probe({ id }: { id: string }) {
    const target = useModelSwitch(id)
    return <span data-testid="probe">{target ?? 'idle'}</span>
  }

  it('follows the switch live', () => {
    render(<Probe id="t1" />)
    expect(screen.getByTestId('probe')).toHaveTextContent('idle')
    act(() => { beginModelSwitch('t1', 'opus') })
    expect(screen.getByTestId('probe')).toHaveTextContent('opus')
    act(() => { endModelSwitch('t1') })
    expect(screen.getByTestId('probe')).toHaveTextContent('idle')
  })

  it('ignores a switch on another terminal', () => {
    render(<Probe id="t1" />)
    act(() => { beginModelSwitch('t2', 'opus') })
    expect(screen.getByTestId('probe')).toHaveTextContent('idle')
  })

  it('a pane that mounts DURING a switch sees it: the guard survives a remount', () => {
    // The first pane started the switch and was then unmounted (Settings opened, view toggled);
    // the sequence is still running when the next pane for the same terminal mounts.
    const first = render(<Probe id="t1" />)
    act(() => { beginModelSwitch('t1', 'opus') })
    first.unmount()
    render(<Probe id="t1" />)
    expect(screen.getByTestId('probe')).toHaveTextContent('opus')
    // ...and a second pick from it is refused.
    expect(beginModelSwitch('t1', 'haiku')).toBe(false)
  })

  it('an unmounted pane is not notified (the listener is released)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = render(<Probe id="t1" />)
    unmount()
    act(() => { beginModelSwitch('t1', 'opus') })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('starts idle for a terminal nobody has touched', () => {
    // Nothing is switching before anything has run.
    const { container } = render(<Probe id="never-seen" />)
    expect(container.textContent).toBe('idle')
  })
})
