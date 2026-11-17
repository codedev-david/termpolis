import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WorldPaneDivider } from '../../../src/renderer/src/components/World/WorldPaneDivider'

describe('WorldPaneDivider', () => {
  it('is a 4 px vertical separator', () => {
    render(<WorldPaneDivider onDrag={vi.fn()} width={500} min={360} max={700} />)
    const sep = screen.getByRole('separator')
    expect(sep).toHaveAttribute('aria-orientation', 'vertical')
    expect(sep).toHaveStyle({ width: '4px' })
    expect(sep).toHaveAttribute('aria-valuenow', '500')
    expect(sep).toHaveAttribute('aria-valuemin', '360')
    expect(sep).toHaveAttribute('aria-valuemax', '700')
  })

  it('removes its window listeners when it unmounts mid-drag, and not twice after a release', () => {
    const onDrag = vi.fn()
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = render(<WorldPaneDivider onDrag={onDrag} width={500} min={360} max={700} />)
    fireEvent.mouseDown(screen.getByRole('separator'), { clientX: 500 })
    unmount()
    expect(remove).toHaveBeenCalledWith('mousemove', expect.anything())
    expect(remove).toHaveBeenCalledWith('mouseup', expect.anything())
    fireEvent.mouseMove(window, { clientX: 100 })
    expect(onDrag).not.toHaveBeenCalled()
    remove.mockClear()
    const again = render(<WorldPaneDivider onDrag={onDrag} width={500} min={360} max={700} />)
    fireEvent.mouseDown(screen.getAllByRole('separator')[0], { clientX: 500 })
    fireEvent.mouseUp(window)
    remove.mockClear()
    again.unmount()
    expect(remove).not.toHaveBeenCalled()
    remove.mockRestore()
  })

  it('reports each mouse move as the distance since the last, until the button is released', () => {
    const onDrag = vi.fn()
    render(<WorldPaneDivider onDrag={onDrag} width={500} min={360} max={700} />)
    fireEvent.mouseDown(screen.getByRole('separator'), { clientX: 500 })
    fireEvent.mouseMove(window, { clientX: 450 })
    fireEvent.mouseMove(window, { clientX: 460 })
    expect(onDrag.mock.calls).toEqual([[-50], [10]])
    fireEvent.mouseUp(window)
    fireEvent.mouseMove(window, { clientX: 300 })
    expect(onDrag).toHaveBeenCalledTimes(2)
  })

  it('moves 24 px per ArrowLeft and ArrowRight, and ignores other keys', () => {
    const onDrag = vi.fn()
    render(<WorldPaneDivider onDrag={onDrag} width={500} min={360} max={700} />)
    const sep = screen.getByRole('separator')
    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    fireEvent.keyDown(sep, { key: 'ArrowUp' })
    expect(onDrag.mock.calls).toEqual([[-24], [24]])
  })
})
