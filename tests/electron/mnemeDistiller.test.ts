import { describe, it, expect, vi } from 'vitest'

// child_process is stubbed so defaultExec's stdin handling can be checked without a process (the real
// spawn is covered by mnemeDistillerReal.test.ts). Nothing else in this file reaches execFile.
const CP = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('child_process', () => ({ default: { execFile: CP.execFile }, execFile: CP.execFile }))

import { makeHeadlessDistiller, defaultExec, type ExecFn } from '../../src/main/mnemeDistiller'

// A typed fake for the injectable subprocess seam. NEVER spawns a real process —
// every test drives the distiller through this vi.fn so the headless `claude`
// CLI is never actually invoked (mirrors tests/electron/contextPrimer.test.ts).
function fakeExec(result: { stdout: string; code: number }) {
  return vi.fn(async (_cmd: string, _args: string[], _opts: { timeoutMs: number }) => result)
}

describe('mnemeDistiller — makeHeadlessDistiller', () => {
  it('happy path: returns trimmed stdout and shells out to `claude -p … --model haiku` with no tools', async () => {
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
    // Text in, text out: no built-in tools, no MCP servers, so nothing ever needs approving
    // and the permission bypass it once ran with is gone.
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args.some((a) => /dangerously|bypass|yolo|permission-mode/.test(a))).toBe(false)
    // Exact shape + order, and the default timeout.
    expect(args).toEqual(['-p', prompt, '--model', 'haiku', '--tools', '', '--strict-mcp-config'])
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
    expect(args).toEqual(['-p', 'hello', '--model', 'sonnet', '--tools', '', '--strict-mcp-config'])
    expect(callOpts).toEqual({ timeoutMs: 5000 })
  })

  it("promptVia 'stdin': argv carries no prompt text and the prompt reaches exec as input", async () => {
    const exec = vi.fn(async (_cmd: string, _args: string[], _opts: { timeoutMs: number; input?: string }) => ({ stdout: ' label \n', code: 0 }))
    const prompt = 'Label this region.\nconst apiKey = readSettings()\n'
    const out = await makeHeadlessDistiller({ exec, model: 'sonnet', timeoutMs: 5000, promptVia: 'stdin' })(prompt)
    expect(out).toBe('label')
    const [cmd, args, callOpts] = exec.mock.calls[0]
    expect(cmd).toBe('claude')
    expect(args).toEqual(['-p', '--model', 'sonnet', '--tools', '', '--strict-mcp-config'])
    expect(args.some((a) => a.includes('Label this region') || a.includes('apiKey'))).toBe(false)
    expect(callOpts).toEqual({ timeoutMs: 5000, input: prompt })
  })

  it("the default (and an explicit promptVia 'argv') is unchanged: prompt in argv, no input", async () => {
    for (const promptVia of [undefined, 'argv' as const]) {
      const exec = fakeExec({ stdout: 'x', code: 0 })
      await makeHeadlessDistiller({ exec, ...(promptVia ? { promptVia } : {}) })('the prompt')
      const [, args, callOpts] = exec.mock.calls[0]
      expect(args).toEqual(['-p', 'the prompt', '--model', 'haiku', '--tools', '', '--strict-mcp-config'])
      expect(callOpts).toEqual({ timeoutMs: 60000 })
      expect('input' in callOpts).toBe(false)
    }
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

describe('mnemeDistiller — defaultExec stdin (child_process stubbed)', () => {
  type Cb = (err: unknown, stdout: unknown) => void
  it('writes input to stdin, ends it, swallows a late EPIPE, and coerces a null stdout', async () => {
    const stdin = { on: vi.fn(), end: vi.fn() }
    CP.execFile.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: Cb) => {
      queueMicrotask(() => cb(null, null))
      return { stdin }
    })
    await expect(defaultExec('claude', ['-p'], { timeoutMs: 10, input: 'the prompt' })).resolves.toEqual({ stdout: '', code: 0 })
    expect(stdin.end).toHaveBeenCalledWith('the prompt')
    expect(stdin.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect((stdin.on.mock.calls[0][1] as () => unknown)()).toBeUndefined()
  })

  it('leaves stdin alone without input, and tolerates a child with no stdin pipe', async () => {
    const stdin = { on: vi.fn(), end: vi.fn() }
    CP.execFile.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: Cb) => {
      queueMicrotask(() => cb(Object.assign(new Error('x'), { code: 'ENOENT' }), 'o'))
      return { stdin }
    })
    await expect(defaultExec('claude', ['-p', 'x'], { timeoutMs: 10 })).resolves.toEqual({ stdout: 'o', code: 1 })
    expect(stdin.end).not.toHaveBeenCalled()
    CP.execFile.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: Cb) => {
      queueMicrotask(() => cb(null, 'ok'))
      return { stdin: null }
    })
    await expect(defaultExec('claude', ['-p'], { timeoutMs: 10, input: 'p' })).resolves.toEqual({ stdout: 'ok', code: 0 })
  })
})
