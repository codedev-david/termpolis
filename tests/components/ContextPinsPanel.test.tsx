import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ContextPinsPanel } from '../../src/renderer/src/components/ContextPins/ContextPinsPanel'
import type { ContextPin } from '../../src/renderer/src/types'

type PinsAPI = {
  list: ReturnType<typeof vi.fn>
  add: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  clear: ReturnType<typeof vi.fn>
}

const samplePin = (over: Partial<ContextPin> = {}): ContextPin => ({
  id: over.id ?? 'p1',
  createdAt: over.createdAt ?? 1,
  label: over.label ?? 'Label',
  body: over.body ?? 'Body',
  source: over.source,
  tags: over.tags,
})

let api: PinsAPI

beforeEach(() => {
  api = {
    list: vi.fn().mockResolvedValue({ success: true, data: [] }),
    add: vi.fn().mockResolvedValue({ success: true, data: samplePin() }),
    update: vi.fn(),
    remove: vi.fn().mockResolvedValue({ success: true, data: { removed: true } }),
    clear: vi.fn(),
  }
  ;(window as any).contextPins = api
  // clipboard stub
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  })
})

describe('ContextPinsPanel', () => {
  it('renders empty state when no pins', async () => {
    render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)
    await waitFor(() => expect(api.list).toHaveBeenCalledWith('/cwd'))
    expect(screen.getByText(/no pins yet/i)).toBeInTheDocument()
  })

  it('lists existing pins', async () => {
    api.list.mockResolvedValueOnce({
      success: true,
      data: [samplePin({ label: 'alpha', body: 'beta', tags: ['x'] })],
    })
    render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument())
    expect(screen.getByText('beta')).toBeInTheDocument()
    expect(screen.getByText('x')).toBeInTheDocument()
  })

  it('requires label + body before add', async () => {
    render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    fireEvent.click(screen.getByText(/pin it/i))
    await waitFor(() =>
      expect(screen.getByText(/Label and body are required/i)).toBeInTheDocument(),
    )
    expect(api.add).not.toHaveBeenCalled()
  })

  it('adds a pin and refreshes', async () => {
    render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText(/pin label/i), { target: { value: 'newlabel' } })
    fireEvent.change(screen.getByLabelText(/pin body/i), { target: { value: 'newbody' } })
    fireEvent.change(screen.getByLabelText(/pin tags/i), { target: { value: 'a, b' } })
    fireEvent.click(screen.getByText(/pin it/i))
    await waitFor(() =>
      expect(api.add).toHaveBeenCalledWith(
        '/cwd',
        expect.objectContaining({ label: 'newlabel', body: 'newbody', tags: ['a', 'b'] }),
      ),
    )
  })

  it('surfaces add error', async () => {
    api.add.mockResolvedValueOnce({ success: false, error: 'limit reached' })
    render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText(/pin label/i), { target: { value: 'x' } })
    fireEvent.change(screen.getByLabelText(/pin body/i), { target: { value: 'y' } })
    fireEvent.click(screen.getByText(/pin it/i))
    await waitFor(() => expect(screen.getByText(/limit reached/i)).toBeInTheDocument())
  })

  it('removes a pin', async () => {
    api.list.mockResolvedValueOnce({
      success: true,
      data: [samplePin({ id: 'p1', label: 'gone' })],
    })
    render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('gone')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText(/remove pin gone/i))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('/cwd', 'p1'))
  })

  it('invokes onClose', () => {
    const onClose = vi.fn()
    render(<ContextPinsPanel cwd="/cwd" onClose={onClose} />)
    fireEvent.click(screen.getByLabelText(/close pinned context panel/i))
    expect(onClose).toHaveBeenCalled()
  })

  it('builds a re-injection prompt when pins exist', async () => {
    api.list.mockResolvedValueOnce({
      success: true,
      data: [samplePin({ label: 'lbl', body: 'the body' })],
    })
    render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('lbl')).toBeInTheDocument())
    fireEvent.click(screen.getByText(/build re-injection prompt/i))
    await waitFor(() => expect(screen.getByTestId('built-prompt')).toBeInTheDocument())
    expect(screen.getByTestId('built-prompt')).toHaveTextContent('the body')
  })

  it('build button disabled when no pins', async () => {
    render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    const btn = screen.getByText(/build re-injection prompt/i)
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })

  it('copies built prompt', async () => {
    api.list.mockResolvedValueOnce({
      success: true,
      data: [samplePin({ label: 'lbl', body: 'xbody' })],
    })
    render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('lbl')).toBeInTheDocument())
    fireEvent.click(screen.getByText(/build re-injection prompt/i))
    await waitFor(() => expect(screen.getByTestId('built-prompt')).toBeInTheDocument())
    fireEvent.click(screen.getByText('copy'))
    await waitFor(() =>
      expect((navigator.clipboard as any).writeText).toHaveBeenCalled(),
    )
  })

  it('tolerates missing contextPins api', () => {
    ;(window as any).contextPins = undefined
    expect(() => render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)).not.toThrow()
  })
})
