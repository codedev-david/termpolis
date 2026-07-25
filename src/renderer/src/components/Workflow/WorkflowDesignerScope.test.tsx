import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkflowDesigner, INPUT_NAME_RE, nextInput } from './WorkflowDesigner'

// ---------------------------------------------------------------------------
// v1.32.1 — the reusable half of the designer: WHERE a workflow is saved
// (project vs global), the folder it appears under, and the inputs that let one
// definition serve every repo. The save call is what these controls exist for,
// so most assertions land on the exact arguments handed to the main process.
// ---------------------------------------------------------------------------

const baseWf = (over: any = {}) => ({
  id: 'x', name: 'X', version: 1 as const, trigger: { type: 'manual' as const }, steps: [], ...over,
})

let save: ReturnType<typeof vi.fn>
beforeEach(() => {
  save = vi.fn().mockResolvedValue({ success: true })
  ;(window as any).termpolis = { saveWorkflow: save }
})

const savedWorkflow = () => save.mock.calls[0][1]
const savedFromScope = () => save.mock.calls[0][2]
const clickSave = () => fireEvent.click(screen.getByText('Save'))

describe('INPUT_NAME_RE', () => {
  it('accepts a plain identifier', () => {
    for (const n of ['target', '_x', 'a1', 'Deploy_Env']) expect(INPUT_NAME_RE.test(n)).toBe(true)
  })

  it('rejects anything that could smuggle syntax into ${inputs.NAME}', () => {
    for (const n of ['a-b', '1a', 'a.b', 'a b', '', 'a}', '${x}', 'a/b']) expect(INPUT_NAME_RE.test(n)).toBe(false)
  })

  it('matches the main-process validator, so the UI never green-lights a save that will be refused', async () => {
    const { INPUT_NAME } = await import('../../../../main/workflow/workflowStore')
    expect(INPUT_NAME_RE.source).toBe(INPUT_NAME.source)
  })
})

describe('nextInput', () => {
  it('names the first input input1', () => {
    expect(nextInput([]).name).toBe('input1')
  })

  it('never collides with a name already taken', () => {
    const existing = [{ name: 'input1' }, { name: 'input2' }] as any
    expect(nextInput(existing).name).toBe('input3')
  })

  it('skips past a hand-typed name that already occupies the next slot', () => {
    const existing = [{ name: 'foo' }, { name: 'input2' }] as any
    // length+1 === 3 is free, so it takes that rather than clobbering input2.
    expect(nextInput(existing).name).toBe('input3')
  })

  it('keeps searching when several candidates are taken', () => {
    const existing = [{ name: 'input1' }, { name: 'input2' }, { name: 'input3' }, { name: 'input4' }] as any
    expect(nextInput(existing).name).toBe('input5')
  })

  it('produces a valid, optional, empty input', () => {
    const i = nextInput([])
    expect(INPUT_NAME_RE.test(i.name)).toBe(true)
    expect(i.required).toBe(false)
    expect(i.default).toBe('')
  })
})

describe('WorkflowDesigner — availability', () => {
  it('defaults a new workflow to this project', () => {
    render(<WorkflowDesigner workflow={baseWf()} cwd="/r" onSaved={() => {}} />)
    expect(screen.getByTitle(/Saved in this repo/).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTitle(/offered in every project/).getAttribute('aria-pressed')).toBe('false')
  })

  it('shows an existing global workflow as global', () => {
    render(<WorkflowDesigner workflow={baseWf({ scope: 'global' })} cwd="/r" onSaved={() => {}} />)
    expect(screen.getByTitle(/offered in every project/).getAttribute('aria-pressed')).toBe('true')
  })

  it('switching to Global saves into the global store', async () => {
    render(<WorkflowDesigner workflow={baseWf()} cwd="/r" onSaved={() => {}} />)
    fireEvent.click(screen.getByTitle(/offered in every project/))
    clickSave()
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(savedWorkflow().scope).toBe('global')
  })

  it('reports the scope the workflow STARTED in, so the old file can be removed', async () => {
    render(<WorkflowDesigner workflow={baseWf({ scope: 'global' })} cwd="/r" onSaved={() => {}} />)
    fireEvent.click(screen.getByTitle(/Saved in this repo/))
    clickSave()
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(savedWorkflow().scope).toBe('project')
    expect(savedFromScope()).toBe('global')
  })

  it('a workflow that never moved reports the same fromScope', async () => {
    render(<WorkflowDesigner workflow={baseWf({ scope: 'global' })} cwd="/r" onSaved={() => {}} />)
    clickSave()
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(savedFromScope()).toBe('global')
  })

  it('hands the persisted workflow back to the caller so it can re-read the right store', async () => {
    const onSaved = vi.fn()
    render(<WorkflowDesigner workflow={baseWf()} cwd="/r" onSaved={onSaved} />)
    fireEvent.click(screen.getByTitle(/offered in every project/))
    clickSave()
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(onSaved.mock.calls[0][0]).toEqual(expect.objectContaining({ id: 'x', scope: 'global' }))
  })

  it('does not report a save the main process refused', async () => {
    save.mockResolvedValue({ success: false, error: 'nope' })
    const onSaved = vi.fn()
    render(<WorkflowDesigner workflow={baseWf()} cwd="/r" onSaved={onSaved} />)
    clickSave()
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('flipping back and forth ends on the last choice', async () => {
    render(<WorkflowDesigner workflow={baseWf()} cwd="/r" onSaved={() => {}} />)
    fireEvent.click(screen.getByTitle(/offered in every project/))
    fireEvent.click(screen.getByTitle(/Saved in this repo/))
    clickSave()
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(savedWorkflow().scope).toBe('project')
  })
})

describe('WorkflowDesigner — category', () => {
  it('starts empty', () => {
    render(<WorkflowDesigner workflow={baseWf()} cwd="/r" onSaved={() => {}} />)
    expect((screen.getByLabelText('Category') as HTMLInputElement).value).toBe('')
  })

  it('round-trips an existing category', () => {
    render(<WorkflowDesigner workflow={baseWf({ category: 'Release' })} cwd="/r" onSaved={() => {}} />)
    expect((screen.getByLabelText('Category') as HTMLInputElement).value).toBe('Release')
  })

  it('saves what was typed', async () => {
    render(<WorkflowDesigner workflow={baseWf()} cwd="/r" onSaved={() => {}} />)
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'CI' } })
    clickSave()
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(savedWorkflow().category).toBe('CI')
  })

  it('is independent of scope — a project workflow can be foldered too', async () => {
    render(<WorkflowDesigner workflow={baseWf({ scope: 'project' })} cwd="/r" onSaved={() => {}} />)
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Local' } })
    clickSave()
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(savedWorkflow()).toEqual(expect.objectContaining({ scope: 'project', category: 'Local' }))
  })

  it('a workflow carrying no scope at all still saves, and the main process defaults it to the project store', async () => {
    render(<WorkflowDesigner workflow={baseWf()} cwd="/r" onSaved={() => {}} />)
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Local' } })
    clickSave()
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(savedWorkflow().scope).toBeUndefined()
    expect(savedFromScope()).toBe('project')
  })
})

describe('WorkflowDesigner — inputs', () => {
  it('explains what inputs are for when there are none', () => {
    render(<WorkflowDesigner workflow={baseWf()} cwd="/r" onSaved={() => {}} />)
    expect(screen.getByText(/No inputs/)).toBeTruthy()
  })

  it('adds an input row', () => {
    render(<WorkflowDesigner workflow={baseWf()} cwd="/r" onSaved={() => {}} />)
    fireEvent.click(screen.getByText(/Add input/))
    expect((screen.getByLabelText('Input 1 name') as HTMLInputElement).value).toBe('input1')
  })

  it('adds a second input without renaming the first', () => {
    render(<WorkflowDesigner workflow={baseWf()} cwd="/r" onSaved={() => {}} />)
    fireEvent.click(screen.getByText(/Add input/))
    fireEvent.click(screen.getByText(/Add input/))
    expect((screen.getByLabelText('Input 1 name') as HTMLInputElement).value).toBe('input1')
    expect((screen.getByLabelText('Input 2 name') as HTMLInputElement).value).toBe('input2')
  })

  it('renders inputs the workflow already had', () => {
    render(<WorkflowDesigner workflow={baseWf({ inputs: [{ name: 'target', label: 'Env', default: 'dev', required: true }] })} cwd="/r" onSaved={() => {}} />)
    expect((screen.getByLabelText('Input 1 name') as HTMLInputElement).value).toBe('target')
    expect((screen.getByLabelText('Input 1 label') as HTMLInputElement).value).toBe('Env')
    expect((screen.getByLabelText('Input 1 default') as HTMLInputElement).value).toBe('dev')
    expect((screen.getByLabelText('Input 1 required') as HTMLInputElement).checked).toBe(true)
  })

  it('saves an edited name, label, default and required flag', async () => {
    render(<WorkflowDesigner workflow={baseWf()} cwd="/r" onSaved={() => {}} />)
    fireEvent.click(screen.getByText(/Add input/))
    fireEvent.change(screen.getByLabelText('Input 1 name'), { target: { value: 'target' } })
    fireEvent.change(screen.getByLabelText('Input 1 label'), { target: { value: 'Environment' } })
    fireEvent.change(screen.getByLabelText('Input 1 default'), { target: { value: 'staging' } })
    fireEvent.click(screen.getByLabelText('Input 1 required'))
    clickSave()
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(savedWorkflow().inputs).toEqual([
      { name: 'target', label: 'Environment', default: 'staging', required: true },
    ])
  })

  it('removes the right row', () => {
    render(<WorkflowDesigner workflow={baseWf({ inputs: [{ name: 'a' }, { name: 'b' }] })} cwd="/r" onSaved={() => {}} />)
    fireEvent.click(screen.getByLabelText('Remove input 1'))
    expect((screen.getByLabelText('Input 1 name') as HTMLInputElement).value).toBe('b')
    expect(screen.queryByLabelText('Input 2 name')).toBeNull()
  })

  it('removing the last input brings the explanation back', () => {
    render(<WorkflowDesigner workflow={baseWf({ inputs: [{ name: 'a' }] })} cwd="/r" onSaved={() => {}} />)
    fireEvent.click(screen.getByLabelText('Remove input 1'))
    expect(screen.getByText(/No inputs/)).toBeTruthy()
  })

  it('flags an invalid name in the UI before the main process rejects it', () => {
    render(<WorkflowDesigner workflow={baseWf()} cwd="/r" onSaved={() => {}} />)
    fireEvent.click(screen.getByText(/Add input/))
    const name = screen.getByLabelText('Input 1 name') as HTMLInputElement
    expect(name.className).toContain('#3c3c3c')
    fireEvent.change(name, { target: { value: 'not a name' } })
    expect((screen.getByLabelText('Input 1 name') as HTMLInputElement).className).toContain('#ef4444')
  })

  it('clears the warning once the name is valid again', () => {
    render(<WorkflowDesigner workflow={baseWf({ inputs: [{ name: 'a-b' }] })} cwd="/r" onSaved={() => {}} />)
    expect((screen.getByLabelText('Input 1 name') as HTMLInputElement).className).toContain('#ef4444')
    fireEvent.change(screen.getByLabelText('Input 1 name'), { target: { value: 'ab' } })
    expect((screen.getByLabelText('Input 1 name') as HTMLInputElement).className).toContain('#3c3c3c')
  })

  it('leaves a workflow with no inputs alone rather than saving an empty array', async () => {
    render(<WorkflowDesigner workflow={baseWf()} cwd="/r" onSaved={() => {}} />)
    clickSave()
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(savedWorkflow().inputs).toBeUndefined()
  })

  it('keeps inputs and steps independent — adding an input does not touch the steps', async () => {
    const steps = [{ id: 'a', type: 'command', name: 'A', source: 'inline', command: 'x' }]
    render(<WorkflowDesigner workflow={baseWf({ steps })} cwd="/r" onSaved={() => {}} />)
    fireEvent.click(screen.getByText(/Add input/))
    clickSave()
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(savedWorkflow().steps).toEqual(steps)
  })
})

// ---------------------------------------------------------------------------
// Trigger configuration. Each trigger type shows a different set of fields, and
// what those fields write into `trigger.config` is exactly what the supervisor
// arms off — a key typo here silently produces a workflow that never fires.
// ---------------------------------------------------------------------------

const trig = (type: string, config: any = {}) => baseWf({ trigger: { type, config } })
const pickTrigger = (label: string) => fireEvent.click(screen.getByText(label))

describe('WorkflowDesigner — trigger configuration', () => {
  it('shows no configuration for a manual workflow', () => {
    render(<WorkflowDesigner workflow={baseWf()} cwd="/r" onSaved={() => {}} />)
    expect(screen.queryByLabelText('Cron')).toBeNull()
    expect(screen.queryByLabelText('Branch')).toBeNull()
    expect(screen.queryByLabelText('Paths')).toBeNull()
  })

  it('offers every trigger type — a schedule, both git hooks and a file watch', () => {
    render(<WorkflowDesigner workflow={baseWf()} cwd="/r" onSaved={() => {}} />)
    for (const label of ['Manual', 'Schedule', 'Git commit', 'Git push', 'File change']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  it('marks the current trigger as pressed', () => {
    render(<WorkflowDesigner workflow={trig('gitCommit')} cwd="/r" onSaved={() => {}} />)
    expect(screen.getByText('Git commit').closest('button')!.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('Manual').closest('button')!.getAttribute('aria-pressed')).toBe('false')
  })

  it('gitCommit takes an optional branch, and says it cannot block the commit', async () => {
    render(<WorkflowDesigner workflow={trig('gitCommit')} cwd="/r" onSaved={() => {}} />)
    expect(screen.getByText(/post-commit/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'release' } })
    clickSave()
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(savedWorkflow().trigger).toEqual({ type: 'gitCommit', config: { branch: 'release' } })
  })

  it('gitCommit with no branch arms whatever is checked out', () => {
    render(<WorkflowDesigner workflow={trig('gitCommit')} cwd="/r" onSaved={() => {}} />)
    expect((screen.getByLabelText('Branch') as HTMLInputElement).value).toBe('')
    expect(screen.getByText(/whichever branch is checked out/)).toBeTruthy()
  })

  it('gitPush takes a remote as well as a branch', async () => {
    render(<WorkflowDesigner workflow={trig('gitPush')} cwd="/r" onSaved={() => {}} />)
    fireEvent.change(screen.getByLabelText('Remote'), { target: { value: 'upstream' } })
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'main' } })
    clickSave()
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(savedWorkflow().trigger.config).toEqual({ remote: 'upstream', branch: 'main' })
  })

  it('gitPush shows the existing remote and branch', () => {
    render(<WorkflowDesigner workflow={trig('gitPush', { remote: 'origin', branch: 'dev' })} cwd="/r" onSaved={() => {}} />)
    expect((screen.getByLabelText('Remote') as HTMLInputElement).value).toBe('origin')
    expect((screen.getByLabelText('Branch') as HTMLInputElement).value).toBe('dev')
  })

  it('fileWatch takes paths and a debounce', async () => {
    render(<WorkflowDesigner workflow={trig('fileWatch')} cwd="/r" onSaved={() => {}} />)
    fireEvent.change(screen.getByLabelText('Paths'), { target: { value: 'src/, docs/' } })
    fireEvent.change(screen.getByLabelText('Debounce (ms)'), { target: { value: '750' } })
    clickSave()
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(savedWorkflow().trigger.config).toEqual({ paths: 'src/, docs/', debounceMs: '750' })
  })

  it('a schedule defaults to catching up a run missed while the app was closed', async () => {
    render(<WorkflowDesigner workflow={trig('schedule', { cron: '0 9 * * 1-5' })} cwd="/r" onSaved={() => {}} />)
    const catchUp = screen.getByText(/was due while Termpolis was closed/).closest('label')!.querySelector('input')!
    expect((catchUp as HTMLInputElement).checked).toBe(true)
    fireEvent.click(catchUp)
    clickSave()
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(savedWorkflow().trigger.config.catchUp).toBe('0')
  })

  it('catch-up can be turned back on', () => {
    render(<WorkflowDesigner workflow={trig('schedule', { cron: '@daily', catchUp: '0' })} cwd="/r" onSaved={() => {}} />)
    const catchUp = screen.getByText(/was due while Termpolis was closed/).closest('label')!.querySelector('input')! as HTMLInputElement
    expect(catchUp.checked).toBe(false)
    fireEvent.click(catchUp)
    expect((screen.getByText(/was due while Termpolis was closed/).closest('label')!.querySelector('input') as HTMLInputElement).checked).toBe(true)
  })

  it('warns about a cron that can never fire, and stops warning once it is valid', () => {
    render(<WorkflowDesigner workflow={trig('schedule', { cron: 'nope' })} cwd="/r" onSaved={() => {}} />)
    expect(screen.getByText(/never fires/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Cron'), { target: { value: '0 9 * * 1-5' } })
    expect(screen.queryByText(/never fires/)).toBeNull()
  })

  it('switching trigger type swaps the configuration fields', () => {
    render(<WorkflowDesigner workflow={baseWf()} cwd="/r" onSaved={() => {}} />)
    pickTrigger('Schedule')
    expect(screen.getByLabelText('Cron')).toBeTruthy()
    pickTrigger('File change')
    expect(screen.queryByLabelText('Cron')).toBeNull()
    expect(screen.getByLabelText('Paths')).toBeTruthy()
    pickTrigger('Manual')
    expect(screen.queryByLabelText('Paths')).toBeNull()
  })

  it('a trigger works with an availability and inputs on the same workflow', async () => {
    render(<WorkflowDesigner workflow={baseWf()} cwd="/r" onSaved={() => {}} />)
    fireEvent.click(screen.getByTitle(/offered in every project/))
    pickTrigger('Git commit')
    fireEvent.click(screen.getByText(/Add input/))
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Hooks' } })
    clickSave()
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(savedWorkflow()).toEqual(
      expect.objectContaining({
        scope: 'global',
        category: 'Hooks',
        trigger: expect.objectContaining({ type: 'gitCommit' }),
        inputs: [expect.objectContaining({ name: 'input1' })],
      }),
    )
  })
})
