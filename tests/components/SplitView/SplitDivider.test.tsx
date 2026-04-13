import React, { createRef } from 'react'
import { render, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SplitDivider } from '../../../src/renderer/src/components/SplitView/SplitDivider'

describe('SplitDivider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset body styles that may persist between tests
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  })

  // -- Rendering --

  it('renders divider element', () => {
    const parentRef = createRef<HTMLDivElement>()
    const { container } = render(
      <div ref={parentRef}>
        <SplitDivider direction="vertical" onDrag={vi.fn()} parentRef={parentRef} />
      </div>
    )
    const divider = container.querySelector('.shrink-0')
    expect(divider).toBeInTheDocument()
  })

  it('has cursor-row-resize class for horizontal direction', () => {
    const parentRef = createRef<HTMLDivElement>()
    const { container } = render(
      <div ref={parentRef}>
        <SplitDivider direction="horizontal" onDrag={vi.fn()} parentRef={parentRef} />
      </div>
    )
    const divider = container.querySelector('.cursor-row-resize')
    expect(divider).toBeInTheDocument()
  })

  it('has cursor-col-resize class for vertical direction', () => {
    const parentRef = createRef<HTMLDivElement>()
    const { container } = render(
      <div ref={parentRef}>
        <SplitDivider direction="vertical" onDrag={vi.fn()} parentRef={parentRef} />
      </div>
    )
    const divider = container.querySelector('.cursor-col-resize')
    expect(divider).toBeInTheDocument()
  })

  it('sets width 100% and height 4px for horizontal divider', () => {
    const parentRef = createRef<HTMLDivElement>()
    const { container } = render(
      <div ref={parentRef}>
        <SplitDivider direction="horizontal" onDrag={vi.fn()} parentRef={parentRef} />
      </div>
    )
    const divider = container.querySelector('.shrink-0') as HTMLElement
    expect(divider.style.width).toBe('100%')
    expect(divider.style.height).toBe('4px')
  })

  it('sets width 4px and height 100% for vertical divider', () => {
    const parentRef = createRef<HTMLDivElement>()
    const { container } = render(
      <div ref={parentRef}>
        <SplitDivider direction="vertical" onDrag={vi.fn()} parentRef={parentRef} />
      </div>
    )
    const divider = container.querySelector('.shrink-0') as HTMLElement
    expect(divider.style.width).toBe('4px')
    expect(divider.style.height).toBe('100%')
  })

  // -- Mouse drag --

  it('sets body cursor on mousedown for vertical direction', () => {
    const parentRef = createRef<HTMLDivElement>()
    const { container } = render(
      <div ref={parentRef} style={{ width: '400px', height: '400px' }}>
        <SplitDivider direction="vertical" onDrag={vi.fn()} parentRef={parentRef} />
      </div>
    )
    const divider = container.querySelector('.shrink-0') as HTMLElement
    fireEvent.mouseDown(divider)
    expect(document.body.style.cursor).toBe('col-resize')
    expect(document.body.style.userSelect).toBe('none')
    // Clean up
    fireEvent(document, new MouseEvent('mouseup', { bubbles: true }))
  })

  it('sets body cursor on mousedown for horizontal direction', () => {
    const parentRef = createRef<HTMLDivElement>()
    const { container } = render(
      <div ref={parentRef} style={{ width: '400px', height: '400px' }}>
        <SplitDivider direction="horizontal" onDrag={vi.fn()} parentRef={parentRef} />
      </div>
    )
    const divider = container.querySelector('.shrink-0') as HTMLElement
    fireEvent.mouseDown(divider)
    expect(document.body.style.cursor).toBe('row-resize')
    // Clean up
    fireEvent(document, new MouseEvent('mouseup', { bubbles: true }))
  })

  it('calls onDrag during mousemove after mousedown for vertical split', () => {
    const parentRef = createRef<HTMLDivElement>()
    const onDrag = vi.fn()
    const { container } = render(
      <div ref={parentRef} style={{ width: '400px', height: '400px' }}>
        <SplitDivider direction="vertical" onDrag={onDrag} parentRef={parentRef} />
      </div>
    )

    // Mock getBoundingClientRect on the parent
    const parentEl = container.firstChild as HTMLElement
    parentEl.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      width: 400,
      height: 400,
      right: 400,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON: () => {},
    }))

    const divider = container.querySelector('.shrink-0') as HTMLElement
    fireEvent.mouseDown(divider)

    // Simulate mousemove at x=200 (50% of 400px width)
    fireEvent(document, new MouseEvent('mousemove', { clientX: 200, clientY: 100, bubbles: true }))
    expect(onDrag).toHaveBeenCalledWith(0.5)

    // Clean up
    fireEvent(document, new MouseEvent('mouseup', { bubbles: true }))
  })

  it('calls onDrag during mousemove after mousedown for horizontal split', () => {
    const parentRef = createRef<HTMLDivElement>()
    const onDrag = vi.fn()
    const { container } = render(
      <div ref={parentRef} style={{ width: '400px', height: '400px' }}>
        <SplitDivider direction="horizontal" onDrag={onDrag} parentRef={parentRef} />
      </div>
    )

    const parentEl = container.firstChild as HTMLElement
    parentEl.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      width: 400,
      height: 400,
      right: 400,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON: () => {},
    }))

    const divider = container.querySelector('.shrink-0') as HTMLElement
    fireEvent.mouseDown(divider)

    // Simulate mousemove at y=200 (50% of 400px height)
    fireEvent(document, new MouseEvent('mousemove', { clientX: 100, clientY: 200, bubbles: true }))
    expect(onDrag).toHaveBeenCalledWith(0.5)

    // Clean up
    fireEvent(document, new MouseEvent('mouseup', { bubbles: true }))
  })

  it('clamps ratio to minimum 0.1', () => {
    const parentRef = createRef<HTMLDivElement>()
    const onDrag = vi.fn()
    const { container } = render(
      <div ref={parentRef} style={{ width: '400px', height: '400px' }}>
        <SplitDivider direction="vertical" onDrag={onDrag} parentRef={parentRef} />
      </div>
    )

    const parentEl = container.firstChild as HTMLElement
    parentEl.getBoundingClientRect = vi.fn(() => ({
      left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400, x: 0, y: 0, toJSON: () => {},
    }))

    const divider = container.querySelector('.shrink-0') as HTMLElement
    fireEvent.mouseDown(divider)

    // Move to x=0 (ratio would be 0, should clamp to 0.1)
    fireEvent(document, new MouseEvent('mousemove', { clientX: 0, clientY: 100, bubbles: true }))
    expect(onDrag).toHaveBeenCalledWith(0.1)

    fireEvent(document, new MouseEvent('mouseup', { bubbles: true }))
  })

  it('clamps ratio to maximum 0.9', () => {
    const parentRef = createRef<HTMLDivElement>()
    const onDrag = vi.fn()
    const { container } = render(
      <div ref={parentRef} style={{ width: '400px', height: '400px' }}>
        <SplitDivider direction="vertical" onDrag={onDrag} parentRef={parentRef} />
      </div>
    )

    const parentEl = container.firstChild as HTMLElement
    parentEl.getBoundingClientRect = vi.fn(() => ({
      left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400, x: 0, y: 0, toJSON: () => {},
    }))

    const divider = container.querySelector('.shrink-0') as HTMLElement
    fireEvent.mouseDown(divider)

    // Move to x=400 (ratio would be 1.0, should clamp to 0.9)
    fireEvent(document, new MouseEvent('mousemove', { clientX: 400, clientY: 100, bubbles: true }))
    expect(onDrag).toHaveBeenCalledWith(0.9)

    fireEvent(document, new MouseEvent('mouseup', { bubbles: true }))
  })

  it('resets body styles on mouseup', () => {
    const parentRef = createRef<HTMLDivElement>()
    const { container } = render(
      <div ref={parentRef} style={{ width: '400px', height: '400px' }}>
        <SplitDivider direction="vertical" onDrag={vi.fn()} parentRef={parentRef} />
      </div>
    )

    const divider = container.querySelector('.shrink-0') as HTMLElement
    fireEvent.mouseDown(divider)
    expect(document.body.style.cursor).toBe('col-resize')
    expect(document.body.style.userSelect).toBe('none')

    fireEvent(document, new MouseEvent('mouseup', { bubbles: true }))
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })

  it('stops calling onDrag after mouseup', () => {
    const parentRef = createRef<HTMLDivElement>()
    const onDrag = vi.fn()
    const { container } = render(
      <div ref={parentRef} style={{ width: '400px', height: '400px' }}>
        <SplitDivider direction="vertical" onDrag={onDrag} parentRef={parentRef} />
      </div>
    )

    const parentEl = container.firstChild as HTMLElement
    parentEl.getBoundingClientRect = vi.fn(() => ({
      left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400, x: 0, y: 0, toJSON: () => {},
    }))

    const divider = container.querySelector('.shrink-0') as HTMLElement
    fireEvent.mouseDown(divider)
    fireEvent(document, new MouseEvent('mousemove', { clientX: 200, clientY: 100, bubbles: true }))
    expect(onDrag).toHaveBeenCalledTimes(1)

    // Release
    fireEvent(document, new MouseEvent('mouseup', { bubbles: true }))
    onDrag.mockClear()

    // Additional mousemove should NOT trigger onDrag
    fireEvent(document, new MouseEvent('mousemove', { clientX: 300, clientY: 100, bubbles: true }))
    expect(onDrag).not.toHaveBeenCalled()
  })

  it('does not call onDrag on mousemove without prior mousedown', () => {
    const parentRef = createRef<HTMLDivElement>()
    const onDrag = vi.fn()
    render(
      <div ref={parentRef} style={{ width: '400px', height: '400px' }}>
        <SplitDivider direction="vertical" onDrag={onDrag} parentRef={parentRef} />
      </div>
    )

    // Move mouse without clicking first
    fireEvent(document, new MouseEvent('mousemove', { clientX: 200, clientY: 100, bubbles: true }))
    expect(onDrag).not.toHaveBeenCalled()
  })
})
