import { describe, it, expect, vi } from 'vitest'
import { executeTool, type McpToolHandlers } from '../../src/main/mcpServer'

/**
 * run_and_wait closes the gap run_command leaves open: run_command types keystrokes and returns
 * `{success:true}` the instant they are sent, so an agent can never learn whether the build it
 * just started actually passed. These cover the dispatch wiring — that every argument reaches
 * the handler and the result comes back whole.
 */
describe('run_and_wait dispatch', () => {
  function withHandler(result: { exitCode: number; output: string; timedOut?: boolean }) {
    const runAndWait = vi.fn().mockResolvedValue(result)
    return { runAndWait, handlers: { runAndWait } as unknown as McpToolHandlers }
  }

  it('passes the command through and returns the exit code and output', async () => {
    const { runAndWait, handlers } = withHandler({ exitCode: 0, output: 'ok' })
    const res = await executeTool('run_and_wait', { command: 'npm test' }, handlers)
    expect(runAndWait).toHaveBeenCalledWith({
      command: 'npm test', cwd: undefined, shell: undefined, timeoutMs: undefined,
    })
    expect(res).toEqual({ exitCode: 0, output: 'ok' })
  })

  it('forwards cwd, shell and timeoutMs', async () => {
    const { runAndWait, handlers } = withHandler({ exitCode: 0, output: '' })
    await executeTool(
      'run_and_wait',
      { command: 'dotnet build', cwd: '/repo', shell: 'pwsh', timeoutMs: 5000 },
      handlers,
    )
    expect(runAndWait).toHaveBeenCalledWith({
      command: 'dotnet build', cwd: '/repo', shell: 'pwsh', timeoutMs: 5000,
    })
  })

  it('reports a non-zero exit rather than swallowing it', async () => {
    const { handlers } = withHandler({ exitCode: 1, output: 'AssertionError: nope' })
    expect(await executeTool('run_and_wait', { command: 'npm test' }, handlers))
      .toEqual({ exitCode: 1, output: 'AssertionError: nope' })
  })

  it('surfaces a timeout as such, not as a plain failure', async () => {
    const { handlers } = withHandler({ exitCode: 124, output: 'partial', timedOut: true })
    const res = await executeTool('run_and_wait', { command: 'sleep 999' }, handlers) as {
      exitCode: number; timedOut?: boolean
    }
    expect(res.exitCode).toBe(124)
    expect(res.timedOut).toBe(true)
  })
})
