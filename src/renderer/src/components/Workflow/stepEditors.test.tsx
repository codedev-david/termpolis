import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StepEditor } from './stepEditors'

const renderEditor = (step: any) => {
  const onChange = vi.fn()
  render(<StepEditor step={step} onChange={onChange} />)
  return { onChange }
}

describe('StepEditor — command', () => {
  const base = { id: 'a', type: 'command', name: 'A', source: 'inline', command: '' }

  it('edits the inline command', () => {
    const { onChange } = renderEditor(base)
    fireEvent.change(screen.getByLabelText('Inline command'), { target: { value: 'ls' } })
    expect(onChange).toHaveBeenCalledWith({ command: 'ls' })
  })

  it('switches source to file', () => {
    const { onChange } = renderEditor(base)
    fireEvent.change(screen.getByLabelText('Command source'), { target: { value: 'file' } })
    expect(onChange).toHaveBeenCalledWith({ source: 'file' })
  })

  it('shows the script path (not the inline field) when source is file', () => {
    const { onChange } = renderEditor({ ...base, source: 'file', scriptPath: '' })
    expect(screen.queryByLabelText('Inline command')).toBeNull()
    fireEvent.change(screen.getByLabelText('Script path'), { target: { value: './build.sh' } })
    expect(onChange).toHaveBeenCalledWith({ scriptPath: './build.sh' })
  })

  it('edits shell, cwd, timeout, visible, continueOnError and gate', () => {
    const { onChange } = renderEditor(base)
    fireEvent.change(screen.getByLabelText('Shell'), { target: { value: 'powershell' } })
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/w' } })
    fireEvent.change(screen.getByLabelText('Timeout (ms)'), { target: { value: '5000' } })
    fireEvent.click(screen.getByLabelText('Run visibly'))
    fireEvent.click(screen.getByLabelText('Continue on error'))
    fireEvent.change(screen.getByLabelText('Run when (gate)'), { target: { value: 'steps.a.exitCode == 0' } })
    expect(onChange).toHaveBeenCalledWith({ shell: 'powershell' })
    expect(onChange).toHaveBeenCalledWith({ cwd: '/w' })
    expect(onChange).toHaveBeenCalledWith({ timeoutMs: 5000 })
    expect(onChange).toHaveBeenCalledWith({ visible: true })
    expect(onChange).toHaveBeenCalledWith({ continueOnError: true })
    expect(onChange).toHaveBeenCalledWith({ when: 'steps.a.exitCode == 0' })
  })

  it('clears timeout to undefined when emptied, and gate to undefined when blanked', () => {
    const { onChange } = renderEditor({ ...base, timeoutMs: 5000, when: 'x' })
    fireEvent.change(screen.getByLabelText('Timeout (ms)'), { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith({ timeoutMs: undefined })
    fireEvent.change(screen.getByLabelText('Run when (gate)'), { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith({ when: undefined })
  })
})

describe('StepEditor — agent', () => {
  const base = { id: 'a', type: 'agent', name: 'A', agent: 'claude', prompt: '' }
  it('edits agent, prompt, done marker and timings', () => {
    const { onChange } = renderEditor(base)
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'codex' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'do it' } })
    fireEvent.change(screen.getByLabelText('Done marker'), { target: { value: 'DONE' } })
    fireEvent.change(screen.getByLabelText('Idle (ms)'), { target: { value: '3000' } })
    fireEvent.change(screen.getByLabelText('Timeout (ms)'), { target: { value: '60000' } })
    fireEvent.click(screen.getByLabelText('Continue on error'))
    fireEvent.change(screen.getByLabelText('Run when (gate)'), { target: { value: 'true' } })
    expect(onChange).toHaveBeenCalledWith({ agent: 'codex' })
    expect(onChange).toHaveBeenCalledWith({ prompt: 'do it' })
    expect(onChange).toHaveBeenCalledWith({ doneMarker: 'DONE' })
    expect(onChange).toHaveBeenCalledWith({ idleMs: 3000 })
    expect(onChange).toHaveBeenCalledWith({ timeoutMs: 60000 })
    expect(onChange).toHaveBeenCalledWith({ continueOnError: true })
    expect(onChange).toHaveBeenCalledWith({ when: 'true' })
  })
})

describe('StepEditor — skill', () => {
  const base = { id: 'a', type: 'skill', name: 'A', tool: '', args: {} }
  it('edits the tool and valid JSON args', () => {
    const { onChange } = renderEditor(base)
    fireEvent.change(screen.getByLabelText('Tool'), { target: { value: 'code_search' } })
    expect(onChange).toHaveBeenCalledWith({ tool: 'code_search' })
    fireEvent.change(screen.getByLabelText('Arguments (JSON)'), { target: { value: '{"q":"foo"}' } })
    expect(onChange).toHaveBeenCalledWith({ args: { q: 'foo' } })
  })
  it('shows an error and does not emit args on invalid JSON', () => {
    const { onChange } = renderEditor(base)
    fireEvent.change(screen.getByLabelText('Arguments (JSON)'), { target: { value: '{bad' } })
    expect(screen.getByText(/invalid json/i)).toBeTruthy()
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ args: expect.anything() }))
  })
})

describe('StepEditor — control', () => {
  it('wait: edits waitMs', () => {
    const { onChange } = renderEditor({ id: 'a', type: 'control', name: 'W', action: 'wait', config: { waitMs: 1000 } })
    fireEvent.change(screen.getByLabelText('Wait (ms)'), { target: { value: '250' } })
    expect(onChange).toHaveBeenCalledWith({ config: { waitMs: 250 } })
  })
  it('changes the action', () => {
    const { onChange } = renderEditor({ id: 'a', type: 'control', name: 'W', action: 'wait', config: { waitMs: 1000 } })
    fireEvent.change(screen.getByLabelText('Control action'), { target: { value: 'branch' } })
    expect(onChange).toHaveBeenCalledWith({ action: 'branch' })
  })
  it('branch: edits condition and goto', () => {
    const { onChange } = renderEditor({ id: 'a', type: 'control', name: 'B', action: 'branch', config: {} })
    fireEvent.change(screen.getByLabelText('Branch condition'), { target: { value: 'steps.a.exitCode == 0' } })
    fireEvent.change(screen.getByLabelText('Go to step (id)'), { target: { value: 'deploy' } })
    expect(onChange).toHaveBeenCalledWith({ config: { condition: 'steps.a.exitCode == 0' } })
    expect(onChange).toHaveBeenCalledWith({ config: { goto: 'deploy' } })
  })
  it('loop: edits maxIterations and until', () => {
    const { onChange } = renderEditor({ id: 'a', type: 'control', name: 'L', action: 'loop', config: {} })
    fireEvent.change(screen.getByLabelText('Max iterations'), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText('Until (condition)'), { target: { value: 'steps.a.output' } })
    expect(onChange).toHaveBeenCalledWith({ config: { maxIterations: 5 } })
    expect(onChange).toHaveBeenCalledWith({ config: { until: 'steps.a.output' } })
  })
  it('notify: edits the message', () => {
    const { onChange } = renderEditor({ id: 'a', type: 'control', name: 'N', action: 'notify', config: {} })
    fireEvent.change(screen.getByLabelText('Notify message'), { target: { value: 'done!' } })
    expect(onChange).toHaveBeenCalledWith({ config: { message: 'done!' } })
  })
})
