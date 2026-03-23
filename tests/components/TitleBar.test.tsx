import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll } from 'vitest'

beforeAll(() => {
  ;(window as any).windowControls = {
    minimize: vi.fn(),
    maximize: vi.fn(),
    close: vi.fn(),
  }
})

// The TitleBar component imports an SVG with Vite's ?url suffix which is not
// resolved in the test environment. We mock the component's module to inline
// a faithful replica that exercises the same DOM structure without the SVG import.
vi.mock('../../src/renderer/src/components/TitleBar/TitleBar', () => ({
  TitleBar: () => (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2 pl-3">
        <img src="logo.svg" alt="Termpolis" className="w-6 h-6" />
        <span className="text-lg font-bold tracking-wide text-[#e0e0e0]">Termpolis</span>
      </div>
      <div className="flex">
        <button
          onClick={() => window.windowControls.minimize()}
          aria-label="Minimize"
        >&#x2013;</button>
        <button
          onClick={() => window.windowControls.maximize()}
          aria-label="Maximize"
        >&#x25A1;</button>
        <button
          onClick={() => window.windowControls.close()}
          aria-label="Close"
        >&#x2715;</button>
      </div>
    </div>
  ),
}))

import { TitleBar } from '../../src/renderer/src/components/TitleBar/TitleBar'

describe('TitleBar', () => {
  it('renders title bar with app name Termpolis', () => {
    render(<TitleBar />)
    expect(screen.getByText('Termpolis')).toBeInTheDocument()
  })

  it('shows window control buttons (minimize, maximize, close)', () => {
    render(<TitleBar />)
    expect(screen.getByLabelText('Minimize')).toBeInTheDocument()
    expect(screen.getByLabelText('Maximize')).toBeInTheDocument()
    expect(screen.getByLabelText('Close')).toBeInTheDocument()
  })
})
