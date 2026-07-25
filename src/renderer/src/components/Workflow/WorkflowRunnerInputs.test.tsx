import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WorkflowRunner, initialInputValues, missingRequired } from './WorkflowRunner'
import { useTerminalStore } from '../../store/terminalStore'

// ---------------------------------------------------------------------------
// v1.32.1 — the run-time half of reusable workflows. The same definition is
// pointed at a different target each run, so the values collected here are what
// reach `${inputs.NAME}` in every command line. A required input left blank must
// stop the run in the UI: the main process refuses it anyway, but by then the
// user has already watched a run "start" and fail for no visible reason.
// ---------------------------------------------------------------------------

const wf = (over: any = {}) => ({
  id: 'x',
  name: 'X',
  version: 1 as const,
  trigger: { type: 'manual' as const },
  steps: [{ id: 'a', type: 'command', name: 'Build', source: 'inline', command: '' }],
  ...over,
})

let run: ReturnType<typeof vi.fn>
beforeEach(() => {
  useTerminalStore.setState({ activeRuns: {}, workflows: [] })
  run = vi.fn().mockResolvedValue({ success: true, data: { runId: 'r' } })
  ;(window as any).termpolis = {
    runWorkflow: run,
    cancelWorkflow: vi.fn().mockResolvedValue({ success: true }),
    onWorkflowRunEvent: vi.fn(() => vi.fn()),
  }
})

const clickRun = () => fireEvent.click(screen.getByText('Run'))
const sentValues = () => run.mock.calls[0][3]

describe('initialInputValues', () => {
  it('is empty when a workflow declares no inputs', () => {
    expect(initialInputValues(undefined)).toEqual({})
    expect(initialInputValues([])).toEqual({})
  })

  it('seeds each input from its default', () => {
    expect(initialInputValues([{ name: 'a', default: 'x' }, { name: 'b', default: 'y' }] as never)).toEqual({ a: 'x', b: 'y' })
  })

  it('an input with no default starts blank rather than undefined', () => {
    expect(initialInputValues([{ name: 'a' }] as never)).toEqual({ a: '' })
  })

  it('keys by input name so the engine sees ${inputs.NAME}', () => {
    expect(Object.keys(initialInputValues([{ name: 'target' }] as never))).toEqual(['target'])
  })
})

describe('missingRequired', () => {
  it('is empty with no inputs', () => {
    expect(missingRequired(undefined, {})).toEqual([])
    expect(missingRequired([], {})).toEqual([])
  })

  it('ignores optional inputs however empty they are', () => {
    expect(missingRequired([{ name: 'a' }] as never, { a: '' })).toEqual([])
  })

  it('reports a required input with no value', () => {
    expect(missingRequired([{ name: 'a', required: true }] as never, { a: '' })).toEqual(['a'])
  })

  it('treats whitespace as missing — a stray space must not smuggle a blank into a command line', () => {
    expect(missingRequired([{ name: 'a', required: true }] as never, { a: '   ' })).toEqual(['a'])
  })

  it('accepts a value with meaningful surrounding whitespace', () => {
    expect(missingRequired([{ name: 'a', required: true }] as never, { a: ' x ' })).toEqual([])
  })

  it('reports every missing name, in declaration order', () => {
    const inputs = [{ name: 'a', required: true }, { name: 'b' }, { name: 'c', required: true }] as never
    expect(missingRequired(inputs, { a: '', b: '', c: '' })).toEqual(['a', 'c'])
  })

  it('a value that was never collected counts as missing, not a crash', () => {
    expect(missingRequired([{ name: 'a', required: true }] as never, {})).toEqual(['a'])
  })
})

describe('WorkflowRunner — inputs form', () => {
  it('shows no inputs card when the workflow declares none', () => {
    render(<WorkflowRunner workflow={wf()} runId={null} cwd="/r" />)
    expect(screen.queryByText('Inputs')).toBeNull()
  })

  it('renders a field per declared input, labelled by its label', () => {
    render(<WorkflowRunner workflow={wf({ inputs: [{ name: 'target', label: 'Environment' }] })} runId={null} cwd="/r" />)
    expect(screen.getByLabelText('Environment')).toBeTruthy()
  })

  it('falls back to the input name when there is no label', () => {
    render(<WorkflowRunner workflow={wf({ inputs: [{ name: 'target' }] })} runId={null} cwd="/r" />)
    expect(screen.getByLabelText('target')).toBeTruthy()
  })

  it('pre-fills the declared default', () => {
    render(<WorkflowRunner workflow={wf({ inputs: [{ name: 'target', default: 'dev' }] })} runId={null} cwd="/r" />)
    expect((screen.getByLabelText('target') as HTMLInputElement).value).toBe('dev')
  })

  it('sends the collected values with the run', () => {
    render(<WorkflowRunner workflow={wf({ inputs: [{ name: 'target', default: 'dev' }] })} runId={null} cwd="/r" />)
    fireEvent.change(screen.getByLabelText('target'), { target: { value: 'prod' } })
    clickRun()
    expect(sentValues()).toEqual({ target: 'prod' })
  })

  it('sends the defaults untouched when the user changes nothing', () => {
    render(<WorkflowRunner workflow={wf({ inputs: [{ name: 'a', default: '1' }, { name: 'b', default: '2' }] })} runId={null} cwd="/r" />)
    clickRun()
    expect(sentValues()).toEqual({ a: '1', b: '2' })
  })

  it('sends an empty map for a workflow with no inputs, never undefined', () => {
    render(<WorkflowRunner workflow={wf()} runId={null} cwd="/r" />)
    clickRun()
    expect(sentValues()).toEqual({})
  })

  it('runs against the scope the workflow came from', () => {
    render(<WorkflowRunner workflow={wf({ scope: 'global' })} runId={null} cwd="/r" />)
    clickRun()
    expect(run).toHaveBeenCalledWith('/r', 'x', 'global', {})
  })

  it('runs a global workflow in the CURRENT project directory', () => {
    render(<WorkflowRunner workflow={wf({ scope: 'global' })} runId={null} cwd="/repos/beta" />)
    clickRun()
    expect(run.mock.calls[0][0]).toBe('/repos/beta')
  })

  it('editing one input leaves the others alone', () => {
    render(<WorkflowRunner workflow={wf({ inputs: [{ name: 'a', default: '1' }, { name: 'b', default: '2' }] })} runId={null} cwd="/r" />)
    fireEvent.change(screen.getByLabelText('a'), { target: { value: '9' } })
    clickRun()
    expect(sentValues()).toEqual({ a: '9', b: '2' })
  })
})

describe('WorkflowRunner — required inputs gate the Run button', () => {
  const required = wf({ inputs: [{ name: 'target', label: 'Environment', required: true }] })

  it('disables Run while a required input is blank', () => {
    render(<WorkflowRunner workflow={required} runId={null} cwd="/r" />)
    expect((screen.getByText('Run').closest('button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('says which input is missing, both inline and on the button', () => {
    render(<WorkflowRunner workflow={required} runId={null} cwd="/r" />)
    expect(screen.getByTestId('workflow-missing-inputs').textContent).toContain('target')
    expect((screen.getByText('Run').closest('button') as HTMLButtonElement).title).toContain('target')
  })

  it('does not start a run that the main process would refuse', () => {
    render(<WorkflowRunner workflow={required} runId={null} cwd="/r" />)
    clickRun()
    expect(run).not.toHaveBeenCalled()
  })

  it('enables Run once the value is typed', () => {
    render(<WorkflowRunner workflow={required} runId={null} cwd="/r" />)
    fireEvent.change(screen.getByLabelText('Environment'), { target: { value: 'prod' } })
    const btn = screen.getByText('Run').closest('button') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(btn.title).toBe('Run this workflow')
    expect(screen.queryByTestId('workflow-missing-inputs')).toBeNull()
  })

  it('goes back to disabled if the value is cleared again', () => {
    render(<WorkflowRunner workflow={required} runId={null} cwd="/r" />)
    fireEvent.change(screen.getByLabelText('Environment'), { target: { value: 'prod' } })
    fireEvent.change(screen.getByLabelText('Environment'), { target: { value: '' } })
    expect((screen.getByText('Run').closest('button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('whitespace does not satisfy a required input', () => {
    render(<WorkflowRunner workflow={required} runId={null} cwd="/r" />)
    fireEvent.change(screen.getByLabelText('Environment'), { target: { value: '   ' } })
    expect((screen.getByText('Run').closest('button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('a required input with a default is satisfied from the start', () => {
    render(<WorkflowRunner workflow={wf({ inputs: [{ name: 'target', required: true, default: 'dev' }] })} runId={null} cwd="/r" />)
    expect((screen.getByText('Run').closest('button') as HTMLButtonElement).disabled).toBe(false)
  })

  it('lists every missing required input', () => {
    const two = wf({ inputs: [{ name: 'a', required: true }, { name: 'b', required: true }] })
    render(<WorkflowRunner workflow={two} runId={null} cwd="/r" />)
    expect(screen.getByTestId('workflow-missing-inputs').textContent).toContain('a')
    expect(screen.getByTestId('workflow-missing-inputs').textContent).toContain('b')
  })

  it('an optional input never blocks the run', () => {
    render(<WorkflowRunner workflow={wf({ inputs: [{ name: 'note' }] })} runId={null} cwd="/r" />)
    expect((screen.getByText('Run').closest('button') as HTMLButtonElement).disabled).toBe(false)
    clickRun()
    expect(sentValues()).toEqual({ note: '' })
  })
})
