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
  // Native clipboard (Electron IPC) — copy goes through lib/clipboard → window.termpolis,
  // NOT navigator.clipboard (which is focus-gated and silently fails from a button click).
  ;(window as any).termpolis = { ...(window as any).termpolis, clipboardWriteText: vi.fn().mockResolvedValue({ success: true }) }
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
      expect((window as any).termpolis.clipboardWriteText).toHaveBeenCalled(),
    )
  })

  it('tolerates missing contextPins api', () => {
    ;(window as any).contextPins = undefined
    expect(() => render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)).not.toThrow()
  })

  it('never touches the store, and disables pinning, when there is no project cwd', async () => {
    render(<ContextPinsPanel cwd="" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/no pins yet/i)).toBeInTheDocument())
    expect(api.list).not.toHaveBeenCalled() // refresh() bails before the IPC call
    expect((screen.getByText(/pin it/i) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps the empty state when listing rejects', async () => {
    api.list.mockRejectedValueOnce(new Error('ipc bridge down'))
    render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    expect(screen.getByText(/no pins yet/i)).toBeInTheDocument()
  })

  it('ignores a nullish list result', async () => {
    api.list.mockResolvedValueOnce(undefined)
    render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    expect(screen.getByText(/no pins yet/i)).toBeInTheDocument()
  })

  it('ignores a success result whose data is not an array', async () => {
    api.list.mockResolvedValueOnce({ success: true, data: 'nope' as unknown as ContextPin[] })
    render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    expect(screen.getByText(/no pins yet/i)).toBeInTheDocument()
    expect(screen.queryAllByTestId('pin-item')).toHaveLength(0)
  })

  it('requires a body even when a label is present', async () => {
    render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText(/pin label/i), { target: { value: 'only a label' } })
    fireEvent.change(screen.getByLabelText(/pin body/i), { target: { value: '   ' } }) // whitespace is not a body
    fireEvent.click(screen.getByText(/pin it/i))
    await waitFor(() =>
      expect(screen.getByText(/Label and body are required/i)).toBeInTheDocument(),
    )
    expect(api.add).not.toHaveBeenCalled()
  })

  it('reports a generic failure when the add bridge is missing entirely', async () => {
    ;(window as any).contextPins = undefined
    render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText(/pin label/i), { target: { value: 'l' } })
    fireEvent.change(screen.getByLabelText(/pin body/i), { target: { value: 'b' } })
    fireEvent.click(screen.getByText(/pin it/i))
    await waitFor(() => expect(screen.getByText('failed to add pin')).toBeInTheDocument())
  })

  it('reports a generic failure when add returns success=false with no error string', async () => {
    api.add.mockResolvedValueOnce({ success: false })
    render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText(/pin label/i), { target: { value: 'l' } })
    fireEvent.change(screen.getByLabelText(/pin body/i), { target: { value: 'b' } })
    fireEvent.click(screen.getByText(/pin it/i))
    await waitFor(() => expect(screen.getByText('failed to add pin')).toBeInTheDocument())
  })

  it('surfaces a thrown add failure by its message, and keeps the typed form intact', async () => {
    api.add.mockRejectedValueOnce(new Error('disk full'))
    render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText(/pin label/i), { target: { value: 'keepme' } })
    fireEvent.change(screen.getByLabelText(/pin body/i), { target: { value: 'bodytext' } })
    fireEvent.click(screen.getByText(/pin it/i))
    await waitFor(() => expect(screen.getByText('disk full')).toBeInTheDocument())
    // The form is only cleared on success, so a failed add must not eat the user's input.
    expect((screen.getByLabelText(/pin label/i) as HTMLInputElement).value).toBe('keepme')
    expect((screen.getByLabelText(/pin body/i) as HTMLTextAreaElement).value).toBe('bodytext')
  })

  it('falls back to a generic message when the add rejection carries none', async () => {
    api.add.mockRejectedValueOnce(undefined)
    render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText(/pin label/i), { target: { value: 'l' } })
    fireEvent.change(screen.getByLabelText(/pin body/i), { target: { value: 'b' } })
    fireEvent.click(screen.getByText(/pin it/i))
    await waitFor(() => expect(screen.getByText('failed to add pin')).toBeInTheDocument())
  })

  it('keeps the pin listed when removal throws', async () => {
    api.list.mockResolvedValue({ success: true, data: [samplePin({ id: 'p1', label: 'sticky' })] })
    api.remove.mockRejectedValueOnce(new Error('store locked'))
    render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('sticky')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText(/remove pin sticky/i))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('/cwd', 'p1'))
    expect(screen.getByText('sticky')).toBeInTheDocument()
  })

  it('tolerates the bridge disappearing between render and remove', async () => {
    api.list.mockResolvedValueOnce({ success: true, data: [samplePin({ id: 'p1', label: 'orphan' })] })
    render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('orphan')).toBeInTheDocument())
    ;(window as any).contextPins = undefined // preload bridge torn down mid-session
    fireEvent.click(screen.getByLabelText(/remove pin orphan/i))
    await waitFor(() => expect(screen.getByText('orphan')).toBeInTheDocument())
    expect(api.remove).not.toHaveBeenCalled()
  })

  it('renders a tag row only for pins that actually carry tags', async () => {
    api.list.mockResolvedValueOnce({
      success: true,
      data: [
        samplePin({ id: 'p1', label: 'tagged', body: 'b1', tags: ['alpha', 'beta'] }),
        samplePin({ id: 'p2', label: 'untagged', body: 'b2', tags: [] }), // defined but EMPTY
      ],
    })
    render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('untagged')).toBeInTheDocument())
    const [tagged, untagged] = screen.getAllByTestId('pin-item')
    expect(tagged.children).toHaveLength(3) // header row + tag row + body
    expect(untagged.children).toHaveLength(2) // header row + body — no tag row for []
    expect(screen.getByText('alpha · beta')).toBeInTheDocument()
  })

  it('truncates an oversized pin body in the list preview', async () => {
    api.list.mockResolvedValueOnce({
      success: true,
      data: [samplePin({ id: 'p1', label: 'big', body: 'x'.repeat(500) })],
    })
    render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('big')).toBeInTheDocument())
    const pre = screen.getByTestId('pin-item').querySelector('pre') as HTMLElement
    expect(pre.textContent).toBe('x'.repeat(400) + '…') // 400 chars kept + ellipsis
  })

  it('renders a body of exactly the 400-char limit untouched', async () => {
    api.list.mockResolvedValueOnce({
      success: true,
      data: [samplePin({ id: 'p1', label: 'edge', body: 'y'.repeat(400) })],
    })
    render(<ContextPinsPanel cwd="/cwd" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('edge')).toBeInTheDocument())
    const pre = screen.getByTestId('pin-item').querySelector('pre') as HTMLElement
    expect(pre.textContent).toBe('y'.repeat(400)) // boundary is exclusive — no ellipsis
  })
})
