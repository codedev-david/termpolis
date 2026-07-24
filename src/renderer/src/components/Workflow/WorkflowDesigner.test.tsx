import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkflowDesigner, insertStep, defaultStep } from './WorkflowDesigner'

const cmd = (over: any = {}) => ({ id: 'a', type: 'command', name: 'A', source: 'inline', command: '', ...over })
const baseWf = (steps: any[] = []) => ({ id: 'x', name: 'X', version: 1 as const, trigger: { type: 'manual' as const }, steps })

beforeEach(() => {
  ;(window as any).termpolis = { saveWorkflow: vi.fn().mockResolvedValue({ success: true }) }
})

describe('insertStep', () => {
  it('inserts a new step of the chosen type at the given gap index', () => {
    const steps = [cmd({ id: 'a', name: 'A' }), cmd({ id: 'b', name: 'B' })] as any
    const out = insertStep(steps, 1, 'agent') // gap between A and B
    expect(out.map((s: any) => s.type)).toEqual(['command', 'agent', 'command'])
    expect(out[1].id).not.toBe('a')
  })

  it('appends at the tail gap', () => {
    const out = insertStep([cmd()] as any, 1, 'control')
    expect(out[1].type).toBe('control')
  })

  it('does not mutate the input array', () => {
    const steps = [cmd()] as any
    insertStep(steps, 0, 'skill')
    expect(steps).toHaveLength(1)
  })
})

describe('defaultStep', () => {
  it('returns a valid minimal step for each type', () => {
    expect(defaultStep('command')).toMatchObject({ type: 'command', source: 'inline', command: '', shell: 'bash', visible: false })
    expect(defaultStep('agent')).toMatchObject({ type: 'agent', agent: 'claude', prompt: '' })
    expect(defaultStep('skill')).toMatchObject({ type: 'skill', tool: '', args: {} })
    // waitMs (not ms) is the key the control executor actually reads.
    expect(defaultStep('control')).toMatchObject({ type: 'control', action: 'wait', config: { waitMs: 1000 } })
  })

  it('gives each created step a unique id', () => {
    expect(defaultStep('command').id).not.toBe(defaultStep('command').id)
  })
})

describe('WorkflowDesigner', () => {
  it('clicking the gap "+" inserts a card at that position', () => {
    render(<WorkflowDesigner workflow={baseWf([cmd()]) as any} cwd="/r" onSaved={() => {}} />)
    fireEvent.click(screen.getAllByTitle('Insert a step')[0]) // the head gap
    fireEvent.click(screen.getByText('Command'))
    expect(screen.getAllByTestId('step-card').length).toBe(2)
  })

  it('renders the manual trigger card with future triggers disabled', () => {
    render(<WorkflowDesigner workflow={baseWf()} cwd="/r" onSaved={() => {}} />)
    expect(screen.getByText('Manual')).toBeTruthy()
    expect((screen.getByTitle('Schedule (coming soon)') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTitle('On git push (coming soon)') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTitle('On file change (coming soon)') as HTMLButtonElement).disabled).toBe(true)
  })

  it('inserts each of the four step types from the gap picker', () => {
    render(<WorkflowDesigner workflow={baseWf()} cwd="/r" onSaved={() => {}} />)
    fireEvent.click(screen.getByTitle('Insert a step'))
    fireEvent.click(screen.getByText('Agent'))
    expect(screen.getByDisplayValue('Ask agent')).toBeTruthy()

    fireEvent.click(screen.getAllByTitle('Insert a step')[0])
    fireEvent.click(screen.getByText('Skill'))
    expect(screen.getByDisplayValue('Run skill')).toBeTruthy()

    fireEvent.click(screen.getAllByTitle('Insert a step')[0])
    fireEvent.click(screen.getByText('Control'))
    expect(screen.getByDisplayValue('Wait')).toBeTruthy()
  })

  it('opens and toggles the picker closed without inserting', () => {
    render(<WorkflowDesigner workflow={baseWf()} cwd="/r" onSaved={() => {}} />)
    fireEvent.click(screen.getByTitle('Insert a step'))
    expect(screen.getByText('Command')).toBeTruthy()
    fireEvent.click(screen.getByTitle('Insert a step')) // toggle same gap closed
    expect(screen.queryByText('Command')).toBeNull()
  })

  it('removes a step card', () => {
    render(<WorkflowDesigner workflow={baseWf([cmd()]) as any} cwd="/r" onSaved={() => {}} />)
    expect(screen.getAllByTestId('step-card').length).toBe(1)
    fireEvent.click(screen.getByTitle('Remove step'))
    expect(screen.queryAllByTestId('step-card').length).toBe(0)
  })

  it('collapses and expands a step card body', () => {
    render(<WorkflowDesigner workflow={baseWf([cmd()]) as any} cwd="/r" onSaved={() => {}} />)
    expect(screen.getByLabelText('Inline command')).toBeTruthy()
    fireEvent.click(screen.getByTitle('Collapse step'))
    expect(screen.queryByLabelText('Inline command')).toBeNull()
    fireEvent.click(screen.getByTitle('Expand step'))
    expect(screen.getByLabelText('Inline command')).toBeTruthy()
  })

  it('edits the workflow name and a step field, then Save persists and calls onSaved', async () => {
    const onSaved = vi.fn()
    render(<WorkflowDesigner workflow={baseWf([cmd()]) as any} cwd="/r" onSaved={onSaved} />)
    fireEvent.change(screen.getByLabelText('Workflow name'), { target: { value: 'Deploy' } })
    fireEvent.change(screen.getByLabelText('Step name'), { target: { value: 'Build' } })
    fireEvent.change(screen.getByLabelText('Inline command'), { target: { value: 'npm run build' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect((window as any).termpolis.saveWorkflow).toHaveBeenCalled())
    const [cwdArg, wfArg] = (window as any).termpolis.saveWorkflow.mock.calls[0]
    expect(cwdArg).toBe('/r')
    expect(wfArg.name).toBe('Deploy')
    expect(wfArg.steps[0].name).toBe('Build')
    expect(wfArg.steps[0].command).toBe('npm run build')
    expect(wfArg.version).toBe(1)
    expect(onSaved).toHaveBeenCalled()
  })

  it('shows a Save error and does not call onSaved when persistence fails', async () => {
    ;(window as any).termpolis.saveWorkflow = vi.fn().mockResolvedValue({ success: false, error: 'disk full' })
    const onSaved = vi.fn()
    render(<WorkflowDesigner workflow={baseWf([cmd()]) as any} cwd="/r" onSaved={onSaved} />)
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(screen.getByText(/disk full/)).toBeTruthy())
    expect(onSaved).not.toHaveBeenCalled()
  })
})
