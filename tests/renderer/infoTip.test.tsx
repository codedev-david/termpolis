// @vitest-environment jsdom
import React from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, afterEach } from 'vitest'
import { InfoTip } from '../../src/renderer/src/components/SettingsPane/InfoTip'

// The tip is the only place long explanations live in Settings, so the thing worth pinning is
// that every way a person can ask for one works — pointer, keyboard, and touch, which has no
// hover at all and would leave the copy unreachable if the click toggle ever regressed.

describe('InfoTip', () => {
  afterEach(cleanup)

  it('keeps the explanation out of the layout until asked for', () => {
    render(<InfoTip testId="tip">Upstream servers are separate programs.</InfoTip>)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseEnter(screen.getByTestId('tip'))
    expect(screen.getByRole('tooltip').textContent).toContain('Upstream servers are separate programs.')
    fireEvent.mouseLeave(screen.getByTestId('tip'))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('opens on keyboard focus and closes on blur', () => {
    render(<InfoTip testId="tip">keyboard reachable</InfoTip>)
    fireEvent.focus(screen.getByTestId('tip'))
    expect(screen.getByTestId('tip-text')).toBeTruthy()
    fireEvent.blur(screen.getByTestId('tip'))
    expect(screen.queryByTestId('tip-text')).toBeNull()
  })

  it('toggles on click, which is the only affordance a touch screen has', () => {
    render(<InfoTip testId="tip">tap target</InfoTip>)
    fireEvent.click(screen.getByTestId('tip'))
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.click(screen.getByTestId('tip'))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('does not let the click reach a parent that would act on it', () => {
    let outer = 0
    render(
      <button type="button" onClick={() => { outer += 1 }}>
        <InfoTip testId="tip">nested in something clickable</InfoTip>
      </button>,
    )
    fireEvent.click(screen.getByTestId('tip'))
    expect(outer).toBe(0)
    expect(screen.getByRole('tooltip')).toBeTruthy()
  })

  it('anchors right when asked, so a right-hand panel does not push the tip off-screen', () => {
    render(<InfoTip testId="tip" align="right">edge case</InfoTip>)
    fireEvent.click(screen.getByTestId('tip'))
    expect(screen.getByRole('tooltip').className).toContain('right-0')
  })

  it('anchors left by default', () => {
    render(<InfoTip testId="tip">ordinary case</InfoTip>)
    fireEvent.click(screen.getByTestId('tip'))
    expect(screen.getByRole('tooltip').className).toContain('left-0')
  })

  it('names what it explains for a screen reader, and falls back when nothing is named', () => {
    // Several tips on one pane all reading "What this means" tells a screen-reader user nothing.
    const { unmount } = render(<InfoTip label="What upstream MCP servers are">named</InfoTip>)
    expect(screen.getByLabelText('What upstream MCP servers are')).toBeTruthy()
    unmount()
    render(<InfoTip>unnamed</InfoTip>)
    expect(screen.getByLabelText('What this means')).toBeTruthy()
  })

  it('leaves the test hook off entirely when none was given', () => {
    const { container } = render(<InfoTip>no hook</InfoTip>)
    fireEvent.click(container.querySelector('button') as HTMLButtonElement)
    expect(container.querySelector('[data-testid]')).toBeNull()
  })
})
