// mnemeDistiller.ts
//
// Mneme — the real, headless implementation of the `LlmDistiller` seam declared
// in mnemeReflect.ts (see docs/learning-architecture.md, constraint #3: "No
// in-process LLM"). Reflection distills an episode into a lesson by shelling out
// to the cheapest model tier via the `claude` CLI:
//
//     claude -p "<prompt>" --model haiku --dangerously-skip-permissions
//
// This runs only at task boundaries and is net-negative on tokens (the stored
// lesson prevents later re-derivation). It is OPTIONAL — mnemeReflect always has
// its zero-token deterministic extractor to fall back on, so a slow/absent/broken
// model must never break reflection. Hence: this distiller NEVER throws; it
// returns null on any non-zero exit, empty output, error, or timeout.
//
// Testability: the subprocess call sits behind an INJECTABLE `exec` seam so the
// distiller is fully unit-testable with a `vi.fn()` fake — no real process is
// ever spawned in tests. The real wrapper (`defaultExec`) mirrors the lazy
// `execFile` pattern in codeIngest.ts (referenced only when called, so tests that
// mock child_process can still import this module) and is deliberately minimal;
// exercising it requires a real subprocess, so it is integration-only.

import { execFile } from 'child_process'
import type { LlmDistiller } from './mnemeReflect'

/** Injectable subprocess seam. Resolves with the child's stdout and exit code; never rejects. */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<{ stdout: string; code: number }>

export interface DistillerOptions {
  /** Inject a fake in tests; defaults to the real `execFile` wrapper. */
  exec?: ExecFn
  /** Model tier alias passed to `--model` (default: the cheap `haiku`). */
  model?: string
  /** Kill the child after this many ms (default: 60_000). */
  timeoutMs?: number
  /** CLI binary to invoke (default: `claude`). */
  bin?: string
}

const DEFAULT_MODEL = 'haiku'
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_BIN = 'claude'

/**
 * Real subprocess wrapper over node's `execFile`. Promise-wrapped, killed after
 * `timeoutMs` (execFile's own `timeout` sends SIGTERM), and it always RESOLVES
 * with `{stdout, code}` rather than rejecting — a non-zero/killed child yields a
 * non-zero `code` which the distiller treats as "no lesson". Kept intentionally
 * minimal; this is the integration-only path (a real process, never hit by unit
 * tests, which inject a fake `exec`).
 */
export const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const errCode = (err as { code?: unknown } | null)?.code
      const code = err ? (typeof errCode === 'number' ? errCode : 1) : 0
      resolve({ stdout: String(stdout ?? ''), code })
    })
  })

/**
 * Build a headless `LlmDistiller` (the seam consumed by `distillEpisode`). The
 * returned function runs `claude -p <prompt> --model <model>
 * --dangerously-skip-permissions` through the (injectable) `exec`, returning the
 * trimmed stdout only when the child exited 0 AND produced non-empty output —
 * otherwise `null`. It NEVER throws: any error/timeout from `exec` is swallowed
 * and surfaced as `null` so reflection degrades to the deterministic extractor.
 */
export function makeHeadlessDistiller(opts: DistillerOptions = {}): LlmDistiller {
  const exec = opts.exec ?? defaultExec
  const bin = opts.bin ?? DEFAULT_BIN
  const model = opts.model ?? DEFAULT_MODEL
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return async (prompt: string): Promise<string | null> => {
    try {
      const { stdout, code } = await exec(
        bin,
        ['-p', prompt, '--model', model, '--dangerously-skip-permissions'],
        { timeoutMs },
      )
      const out = stdout.trim()
      return code === 0 && out.length > 0 ? out : null
    } catch {
      // A flaky/absent model must never break reflection — fall back to null so
      // the deterministic extractor path stands alone.
      return null
    }
  }
}
