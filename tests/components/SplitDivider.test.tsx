import React, { createRef } from 'react'
import { render } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SplitDivider } from '../../src/renderer/src/components/SplitView/SplitDivider'

describe('SplitDivider', () => {
  it('renders divider element', () => {
    const parentRef = createRef<HTMLDivElement>()
    const { container } = render(
      <div ref={parentRef}>
        <SplitDivider direction="vertical" onDrag={vi.fn()} parentRef={parentRef} />
      </div>
    )
    // The divider is a child div with shrink-0 class
    const divider = container.querySelector('.shrink-0')
    expect(divider).toBeInTheDocument()
  })

  it('has correct cursor class for horizontal vs vertical', () => {
    const parentRef = createRef<HTMLDivElement>()

    const { container: hContainer } = render(
      <div ref={parentRef}>
        <SplitDivider direction="horizontal" onDrag={vi.fn()} parentRef={parentRef} />
      </div>
    )
    const hDivider = hContainer.querySelector('.cursor-row-resize')
    expect(hDivider).toBeInTheDocument()

    const { container: vContainer } = render(
      <div ref={parentRef}>
        <SplitDivider direction="vertical" onDrag={vi.fn()} parentRef={parentRef} />
      </div>
    )
    const vDivider = vContainer.querySelector('.cursor-col-resize')
    expect(vDivider).toBeInTheDocument()
  })
})
