import { describe, it, expect, vi } from 'vitest'
import { makeHeadlessDistiller, defaultExec, type ExecFn } from '../../src/main/mnemeDistiller'

// A typed fake for the injectable subprocess seam. NEVER spawns a real process —
// every test drives the distiller through this vi.fn so the headless `claude`
// CLI is never actually invoked (mirrors tests/electron/contextPrimer.test.ts).
function fakeExec(result: { stdout: string; code: number }) {
  return vi.fn(async (_cmd: string, _args: string[], _opts: { timeoutMs: number }) => result)
}

describe('mnemeDistiller — makeHeadlessDistiller', () => {
  it('happy path: returns trimmed stdout and shells out to `claude -p … --model haiku --dangerously-skip-permissions`', async () => {
    const exec = fakeExec({ stdout: '  Always add the tsconfig path alias for module resolution.  \n', code: 0 })
    const distiller = makeHeadlessDistiller({ exec })

    const prompt = 'Distill the reusable lesson from this episode.'
    const out = await distiller(prompt)

    // Returned value is the TRIMMED stdout.
    expect(out).toBe('Always add the tsconfig path alias for module resolution.')

    // The subprocess was invoked exactly once with the expected command + args.
    expect(exec).toHaveBeenCalledTimes(1)
    const [cmd, args, callOpts] = exec.mock.calls[0]
    expect(cmd).toBe('claude')
    expect(args).toContain('-p')
    expect(args).toContain(prompt) // the exact prompt is forwarded verbatim
    expect(args).toContain('--model')
    expect(args).toContain('haiku')
    expect(args).toContain('--dangerously-skip-permissions')
    // Exact shape + order, and the default timeout.
    expect(args).toEqual(['-p', prompt, '--model', 'haiku', '--dangerously-skip-permissions'])
    expect(callOpts).toEqual({ timeoutMs: 60000 })
  })

  it('returns null on a non-zero exit code (child failed → no lesson)', async () => {
    const exec = fakeExec({ stdout: 'this output is ignored because the child failed', code: 1 })
    const distiller = makeHeadlessDistiller({ exec })
    expect(await distiller('prompt')).toBeNull()
  })

  it('returns null when stdout is empty', async () => {
    const exec = fakeExec({ stdout: '', code: 0 })
    const distiller = makeHeadlessDistiller({ exec })
    expect(await distiller('prompt')).toBeNull()
  })

  it('returns null when stdout is only whitespace', async () => {
    const exec = fakeExec({ stdout: '   \n\t  ', code: 0 })
    const distiller = makeHeadlessDistiller({ exec })
    expect(await distiller('prompt')).toBeNull()
  })

  it('returns null (never throws) when exec rejects — a flaky/absent model must not break reflection', async () => {
    const exec = vi.fn(async () => {
      throw new Error('spawn claude ENOENT')
    })
    const distiller = makeHeadlessDistiller({ exec: exec as unknown as ExecFn })
    await expect(distiller('prompt')).resolves.toBeNull()
  })

  it('passes custom bin, model, and timeoutMs through to exec', async () => {
    const exec = fakeExec({ stdout: 'ok', code: 0 })
    const distiller = makeHeadlessDistiller({
      exec,
      bin: '/usr/local/bin/claude',
      model: 'sonnet',
      timeoutMs: 5000,
    })

    const out = await distiller('hello')
    expect(out).toBe('ok')

    expect(exec).toHaveBeenCalledTimes(1)
    const [cmd, args, callOpts] = exec.mock.calls[0]
    expect(cmd).toBe('/usr/local/bin/claude')
    expect(args).toEqual(['-p', 'hello', '--model', 'sonnet', '--dangerously-skip-permissions'])
    expect(callOpts).toEqual({ timeoutMs: 5000 })
  })

  it('falls back to the real defaultExec when no exec is injected (constructs a distiller without spawning anything)', () => {
    // No opts → `opts.exec ?? defaultExec` selects the real wrapper and the
    // bin/model/timeout defaults are applied. We do NOT invoke the returned
    // function, so no real `claude` process is ever spawned.
    const distiller = makeHeadlessDistiller()
    expect(typeof distiller).toBe('function')
    // defaultExec is exported and is the real subprocess wrapper used as the fallback.
    expect(typeof defaultExec).toBe('function')
  })
})
