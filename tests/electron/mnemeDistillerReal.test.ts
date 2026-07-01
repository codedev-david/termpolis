import { describe, it, expect } from 'vitest'
import { makeHeadlessDistiller, defaultExec, type ExecFn } from '../../src/main/mnemeDistiller'

// Integration counterpart to mnemeDistiller.test.ts. Those tests drive the
// distiller through a vi.fn() fake and never touch a process; this file proves
// the OTHER half of the seam: the REAL exported `defaultExec` (the
// child_process.execFile wrapper) actually spawns, captures stdout, maps exit
// codes, and survives a timeout kill - all WITHOUT invoking any real LLM.
//
// The subprocess is always a harmless, deterministic `node` one-liner. We use
// process.execPath (the very node binary running vitest) so this is portable:
// the dev box and CI are Windows, but it is equally valid on Linux/macOS. No
// shell is involved (execFile spawns the binary directly) and no bash-isms are
// used, so there is nothing platform-specific to break.

const NODE = process.execPath

describe('mnemeDistiller - REAL defaultExec (spawns a real node subprocess)', () => {
  it('captures child stdout and reports code 0 on a successful exit', async () => {
    const { stdout, code } = await defaultExec(
      NODE,
      ['-e', 'process.stdout.write("HELLO_SUBPROCESS")'],
      { timeoutMs: 10000 },
    )
    expect(stdout).toContain('HELLO_SUBPROCESS')
    expect(code).toBe(0)
  }, 20000)

  it('resolves (never rejects) with the real exit code when the child exits non-zero', async () => {
    // A non-zero exit is how a "no lesson" outcome reaches the distiller. It must
    // surface as a resolved code, not a rejected promise.
    const result = await defaultExec(NODE, ['-e', 'process.exit(3)'], { timeoutMs: 10000 })
    expect(result.code).toBe(3)
    expect(result.stdout).toBe('')
  }, 20000)

  it('resolves with a non-zero code when the timeout kills a slow child (never hangs or rejects)', async () => {
    // The child would sleep for 10s; the 300ms timeout kills it (execFile sends
    // SIGTERM). defaultExec must still RESOLVE with a non-zero code rather than
    // reject or hang - a slow/stuck model must never break reflection. The 20s
    // test budget is the hang guard: if this rejected or blocked, it would fail.
    const result = await defaultExec(NODE, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 300 })
    expect(result.code).not.toBe(0)
  }, 20000)

  it('full seam: makeHeadlessDistiller runs a real subprocess and returns the TRIMMED stdout', async () => {
    // makeHeadlessDistiller hard-codes the args as
    // ['-p', prompt, '--model', ...], which `node` cannot run, so we inject the
    // REAL defaultExec behind a thin adapter that rewrites the command to a
    // runnable node one-liner. That one-liner echoes the forwarded prompt back
    // wrapped in whitespace, proving the real
    // spawn -> capture-stdout -> trim -> return path end to end. The prompt is
    // passed as its own argv element (process.argv[1]) so there is no shell and
    // no string interpolation to escape.
    const echoViaRealExec: ExecFn = (_cmd, args, opts) => {
      const prompt = args[1] // makeHeadlessDistiller places the prompt at index 1
      return defaultExec(
        NODE,
        ['-e', 'process.stdout.write("  " + process.argv[1] + "  \\n")', prompt],
        opts,
      )
    }
    const distiller = makeHeadlessDistiller({ exec: echoViaRealExec })
    const lesson = await distiller('Prefer execFile over a shell for untrusted args')
    // The leading/trailing spaces and newline the child emitted were trimmed away.
    expect(lesson).toBe('Prefer execFile over a shell for untrusted args')
  }, 20000)

  it('full seam (nothing mocked): makeHeadlessDistiller over the real defaultExec returns null on a failing child', async () => {
    // No exec is injected at all - the completely un-mocked path. Pointing `bin`
    // at node makes it run
    // `node -p <prompt> --model haiku --dangerously-skip-permissions`; node
    // rejects the unknown `--model` option and exits non-zero, so the real
    // subprocess path must degrade to null. This proves a broken/absent model
    // spawned for real never breaks reflection.
    const distiller = makeHeadlessDistiller({ bin: NODE, timeoutMs: 10000 })
    const lesson = await distiller('distill the reusable lesson from this episode')
    expect(lesson).toBeNull()
  }, 20000)
})
