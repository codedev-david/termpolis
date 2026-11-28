import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { RemoveDistrictConfirm, removalQuestion } from '../../../src/renderer/src/components/World/RemoveDistrictConfirm'

// D3 (signoff-decisions.md row #12): a design change that removes a district with buildings in it asks first, in the
// words "Remove {name} and its {n} buildings? This can't be undone." with Remove and Cancel.
afterEach(cleanup)

describe('removalQuestion', () => {
  it('names the district and its buildings, one building in the singular', () => {
    expect(removalQuestion([{ id: 'a', name: 'Payments', buildings: 3 }])).toBe("Remove Payments and its 3 buildings? This can't be undone.")
    expect(removalQuestion([{ id: 'a', name: 'Payments', buildings: 1 }])).toBe("Remove Payments and its 1 building? This can't be undone.")
  })

  it('names every district a change removes, in one question', () => {
    expect(removalQuestion([{ id: 'a', name: 'A', buildings: 3 }, { id: 'b', name: 'B', buildings: 1 }]))
      .toBe("Remove A and its 3 buildings, and B and its 1 building? This can't be undone.")
    expect(removalQuestion([{ id: 'a', name: 'A', buildings: 3 }, { id: 'b', name: 'B', buildings: 1 }, { id: 'c', name: 'C', buildings: 2 }]))
      .toBe("Remove A and its 3 buildings, B and its 1 building, and C and its 2 buildings? This can't be undone.")
  })
})

describe('RemoveDistrictConfirm', () => {
  const removals = [{ id: 'core', name: 'Core', buildings: 2 }]

  it('is an alert dialog named by the question it shows, Cancel first and focused, then Remove', () => {
    render(<RemoveDistrictConfirm zoom={{ zoom: '1.5' } as never} removals={removals} onCancel={vi.fn()} onConfirm={vi.fn()} />)
    const box = screen.getByTestId('world-remove-district-confirm')
    const question = "Remove Core and its 2 buildings? This can't be undone."
    expect(box.getAttribute('role')).toBe('alertdialog')
    // The accessible name is the text on show, so it holds every word a speech user reads off the screen.
    expect(box.getAttribute('aria-label')).toBe(question)
    expect(box.textContent).toContain(question)
    expect(box.style.zoom).toBe('1.5')
    const buttons = Array.from(box.querySelectorAll('button')).map((b) => b.textContent)
    expect(buttons).toEqual(['Cancel', 'Remove'])
    expect(document.activeElement).toBe(screen.getByTestId('world-remove-district-cancel'))
  })

  it('Cancel cancels and Remove confirms', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(<RemoveDistrictConfirm zoom={{}} removals={removals} onCancel={onCancel} onConfirm={onConfirm} />)
    fireEvent.click(screen.getByTestId('world-remove-district-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('world-remove-district-go'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
