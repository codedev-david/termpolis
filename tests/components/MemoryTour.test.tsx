import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import {
  MemoryTour,
  hasSeenMemoryTour,
  markMemoryTourSeen,
  TOUR_AGENT,
  TOUR_FACT,
  TOUR_QUESTION,
} from '../../src/renderer/src/components/Memory/MemoryTour'

type Api = Record<string, ReturnType<typeof vi.fn>>
let api: Api

const saved = (over: Record<string, unknown> = {}) => ({ id: 'demo1', ts: Date.now(), agentId: TOUR_AGENT, kind: 'fact', content: TOUR_FACT, ...over })

beforeEach(() => {
  localStorage.clear()
  api = {
    memoryWrite: vi.fn().mockImplementation(async () => ({ success: true, data: saved() })),
    memorySearch: vi.fn().mockResolvedValue({ success: true, data: [{ ...saved(), score: 0.8 }] }),
    memoryDelete: vi.fn().mockResolvedValue({ success: true }),
  }
  ;(window as unknown as { termpolis: Api }).termpolis = api
})

async function toStep2(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Save to memory' }))
  expect(await screen.findByText('Ask in different words')).toBeInTheDocument()
}

describe('memory tour seen flag', () => {
  it('starts unseen, and marking it sticks', () => {
    expect(hasSeenMemoryTour()).toBe(false)
    markMemoryTourSeen()
    expect(hasSeenMemoryTour()).toBe(true)
  })

  it('treats storage that throws as unseen and never throws itself', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(hasSeenMemoryTour()).toBe(false)
    expect(() => markMemoryTourSeen()).not.toThrow()
    get.mockRestore()
    set.mockRestore()
  })
})

describe('MemoryTour', () => {
  it('walks the three steps with real memory calls and removes the demo fact on Finish', async () => {
    const onClose = vi.fn()
    render(<MemoryTour onClose={onClose} />)
    expect(screen.getByText('Tell Termpolis something')).toBeInTheDocument()
    expect(screen.getByLabelText('Fact to remember')).toHaveValue(TOUR_FACT)
    await toStep2()
    expect(api.memoryWrite).toHaveBeenCalledWith({ agentId: TOUR_AGENT, kind: 'fact', content: TOUR_FACT, tags: [TOUR_AGENT] })

    expect(screen.getByLabelText('Question for memory')).toHaveValue(TOUR_QUESTION)
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(await screen.findByTestId('memory-tour-found')).toHaveTextContent(TOUR_FACT)
    expect(api.memorySearch).toHaveBeenCalledWith({ query: TOUR_QUESTION, limit: 10 })

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText(/Claude Code, Codex and Antigravity read and write this same memory/)).toBeInTheDocument()
    expect(screen.getByText(/open Memory ▸ This week/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(undefined))
    expect(api.memoryDelete).toHaveBeenCalledWith('demo1')
    expect(hasSeenMemoryTour()).toBe(true)
  })

  it('keeps the demo fact when "Keep it" is ticked, and Open This week asks for the week view', async () => {
    const onClose = vi.fn()
    render(<MemoryTour onClose={onClose} />)
    fireEvent.change(screen.getByLabelText('Fact to remember'), { target: { value: 'My editor is Vim' } })
    await toStep2()
    expect(api.memoryWrite).toHaveBeenCalledWith(expect.objectContaining({ content: 'My editor is Vim' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Open This week' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledWith({ openWeek: true }))
    expect(api.memoryDelete).not.toHaveBeenCalled()
  })

  it('never removes a memory it did not create (the same text was already saved)', async () => {
    api.memoryWrite.mockResolvedValueOnce({ success: true, data: saved({ ts: Date.now() - 86400000 }) })
    const onClose = vi.fn()
    render(<MemoryTour onClose={onClose} />)
    await toStep2()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('That fact was already in memory, so the tour leaves it there.')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(api.memoryDelete).not.toHaveBeenCalled()
  })

  it('an existing memory written by another agent is not the tour\'s either', async () => {
    api.memoryWrite.mockResolvedValueOnce({ success: true, data: saved({ agentId: 'claude' }) })
    render(<MemoryTour onClose={vi.fn()} />)
    await toStep2()
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }))
    await waitFor(() => expect(hasSeenMemoryTour()).toBe(true))
    expect(api.memoryDelete).not.toHaveBeenCalled()
  })

  it('is honest when the search does not bring the fact back', async () => {
    render(<MemoryTour onClose={vi.fn()} />)
    await toStep2()
    api.memorySearch.mockResolvedValueOnce({ success: true, data: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(await screen.findByTestId('memory-tour-missed')).toHaveTextContent(/Nothing came back for those words/)

    api.memorySearch.mockResolvedValueOnce({ success: true, data: [{ ...saved({ id: 'other' }), score: 0.4 }, { ...saved({ id: 'other2' }), score: 0.3 }] })
    fireEvent.keyDown(screen.getByLabelText('Question for memory'), { key: 'Enter' })
    expect(await screen.findByText(/2 other memories came back, but not this one/)).toBeInTheDocument()
  })

  it('shows a failed search or save, and ignores keys other than Enter', async () => {
    api.memoryWrite.mockResolvedValueOnce({ success: false, error: 'Memory is locked' })
    render(<MemoryTour onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save to memory' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Memory is locked')
    expect(screen.getByText('Tell Termpolis something')).toBeInTheDocument()

    api.memoryWrite.mockResolvedValueOnce({ success: false })
    fireEvent.click(screen.getByRole('button', { name: 'Save to memory' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Couldn't save that to memory."))

    api.memoryWrite.mockRejectedValueOnce(new Error('ipc'))
    fireEvent.click(screen.getByRole('button', { name: 'Save to memory' }))
    await waitFor(() => expect(api.memoryWrite).toHaveBeenCalledTimes(3))
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't save that to memory.")

    await toStep2()
    fireEvent.keyDown(screen.getByLabelText('Question for memory'), { key: 'a' })
    expect(api.memorySearch).not.toHaveBeenCalled()

    api.memorySearch.mockResolvedValueOnce({ success: false, error: 'Search broke' })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Search broke')
    expect(screen.getByTestId('memory-tour-missed')).toBeInTheDocument()

    api.memorySearch.mockResolvedValueOnce({ success: false })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Search failed.'))

    api.memorySearch.mockRejectedValueOnce(new Error('ipc'))
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(api.memorySearch).toHaveBeenCalledTimes(3))
    expect(screen.getByRole('alert')).toHaveTextContent('Search failed.')
  })

  it('does nothing for an empty fact or question', async () => {
    render(<MemoryTour onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Fact to remember'), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: 'Save to memory' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Fact to remember'), { target: { value: TOUR_FACT } })
    await toStep2()
    fireEvent.change(screen.getByLabelText('Question for memory'), { target: { value: ' ' } })
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled()
    fireEvent.keyDown(screen.getByLabelText('Question for memory'), { key: 'Enter' })
    expect(api.memorySearch).not.toHaveBeenCalled()
  })

  it('Skip tour on the first step closes without touching memory; Escape closes once', async () => {
    const onClose = vi.fn()
    const { unmount } = render(<MemoryTour onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(api.memoryWrite).not.toHaveBeenCalled()
    expect(api.memoryDelete).not.toHaveBeenCalled()
    unmount()

    const onClose2 = vi.fn()
    render(<MemoryTour onClose={onClose2} />)
    await toStep2()
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onClose2).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(onClose2).toHaveBeenCalledTimes(1))
    expect(api.memoryDelete).toHaveBeenCalledTimes(1) // skipping after a save still cleans up
  })

  it('still closes when removing the demo fact fails', async () => {
    api.memoryDelete.mockRejectedValueOnce(new Error('locked'))
    const onClose = vi.fn()
    render(<MemoryTour onClose={onClose} />)
    await toStep2()
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('Escape while the save is still in flight waits for it, then removes the fact', async () => {
    let finish: (v: unknown) => void = () => {}
    api.memoryWrite.mockImplementationOnce(() => new Promise((r) => { finish = r }))
    const onClose = vi.fn()
    render(<MemoryTour onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save to memory' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    finish({ success: true, data: saved() })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(api.memoryDelete).toHaveBeenCalledWith('demo1')
  })

  it('a save that fails while closing removes nothing', async () => {
    let fail: (e: unknown) => void = () => {}
    api.memoryWrite.mockImplementationOnce(() => new Promise((_r, j) => { fail = j }))
    const onClose = vi.fn()
    render(<MemoryTour onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save to memory' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    fail(new Error('locked'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(api.memoryDelete).not.toHaveBeenCalled()
  })

  it('unmounting mid-tour removes the demo fact, but not a kept one', async () => {
    const { unmount } = render(<MemoryTour onClose={vi.fn()} />)
    await toStep2()
    unmount()
    await waitFor(() => expect(api.memoryDelete).toHaveBeenCalledWith('demo1'))

    api.memoryDelete.mockClear()
    const second = render(<MemoryTour onClose={vi.fn()} />)
    await toStep2()
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await screen.findByTestId('memory-tour-found')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('checkbox'))
    second.unmount()
    await new Promise((r) => setTimeout(r, 20))
    expect(api.memoryDelete).not.toHaveBeenCalled()
  })
})
