import type { TerminalRunner, AgentRunner, ToolInvoker, Timer, CommandRunSpec, CommandRunResult } from './contracts'
import type { McpToolHandlers } from '../mcpServer'

type SpawnDeps = {
  spawnTerminal: (id: string, exe: string, cwd: string, onData: (s: string) => void, extraPaths?: string[], extraEnv?: Record<string, string>, onExit?: (code: number) => void) => void
  writeToTerminal: (id: string, data: string) => void
  killTerminal: (id: string) => void
  // OS default shell TYPE (e.g. 'zsh' on macOS, 'bash' on Linux). A Command
  // step whose chosen shell can't be spawned in this environment falls back to
  // it — a step should run on *some* working shell rather than hard-fail
  // because the requested one can't be posix_spawn'd here. Optional: without a
  // default, a spawn failure stays terminal (exit 127), preserving behavior for
  // callers (and unit tests) that don't supply one.
  defaultShell?: string
}

const CAP = 32_768

export function makeTerminalRunner(sp: SpawnDeps): TerminalRunner {
  const live = new Map<string, () => void>()
  return {
    run(spec: CommandRunSpec, onChunk?): Promise<CommandRunResult> {
      return new Promise((resolve) => {
        let buf = ''
        let done = false
        const finish = (r: CommandRunResult) => { if (done) return; done = true; clearTimeout(timer); live.delete(spec.stepId); resolve(r) }
        const timer = setTimeout(() => { try { sp.killTerminal(spec.stepId) } catch {} finish({ exitCode: 124, output: buf, timedOut: true }) }, spec.timeoutMs)
        live.set(spec.stepId, () => { try { sp.killTerminal(spec.stepId) } catch {} finish({ exitCode: 130, output: buf }) })
        const onData = (d: string) => { buf = (buf + d).slice(-CAP); onChunk?.(d) }
        // Spawn the command on a real PTY. node-pty throws synchronously when it
        // can't open the shell — a bad/absent executable, or an environment that
        // can't posix_spawn the requested shell. When that happens and a working
        // OS default shell is known, retry once on it: a Command step should run
        // on *some* shell rather than hard-fail because the chosen one can't be
        // spawned here. Only a spawn *throw* falls back — a shell that spawns and
        // exits non-zero is a real command failure and is reported as-is.
        const attempt = (shell: string, isFallback: boolean) => {
          try {
            sp.spawnTerminal(spec.stepId, shell, spec.cwd, onData,
              undefined, undefined,
              (code) => finish({ exitCode: code, output: buf }))
            // Non-interactive: write the command + newline, then signal EOF via `exit`.
            sp.writeToTerminal(spec.stepId, `${spec.command}\n`)
            if (!spec.visible) sp.writeToTerminal(spec.stepId, `exit $?\n`)
          } catch (e: any) {
            const note = `\n[spawn error] ${e?.message ?? e}`
            if (!isFallback && sp.defaultShell && sp.defaultShell !== shell) {
              buf = (buf + note + `\n[retry] falling back to default shell "${sp.defaultShell}"`).slice(-CAP)
              attempt(sp.defaultShell, true)
              return
            }
            // Terminal: turn the spawn failure into a failed step (exit 127 =
            // command not found) so the engine reports it — a leaked throw would
            // hang the run with the step stuck "running" forever.
            finish({ exitCode: 127, output: (buf + note).slice(-CAP) })
          }
        }
        attempt(spec.shell, false)
      })
    },
    cancel(stepId) { live.get(stepId)?.() },
  }
}

export function makeToolInvoker(handlers: McpToolHandlers, exec: (name: string, args: any, h: McpToolHandlers) => Promise<any>): ToolInvoker {
  return {
    async invoke(tool, args, _timeoutMs) {
      try {
        const res = await exec(tool, args, handlers)
        return { output: typeof res === 'string' ? res : JSON.stringify(res), ok: true }
      } catch (e: any) {
        return { output: '', ok: false, error: e.message }
      }
    },
  }
}

export const realTimer: Timer = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }

// Agent adapter: drive a pane, poll detectAgentStatus for `idle` held >= idleMs (or doneMarker), cap at timeoutMs.
export function makeAgentRunner(
  sp: SpawnDeps,
  detect: (output: string, agentName?: string, prev?: string) => { status: string; summary: string },
  launch: (agent: 'claude' | 'codex' | 'gemini') => string,
): AgentRunner {
  const live = new Map<string, () => void>()
  return {
    run(spec, onChunk): Promise<{ output: string; ok: boolean; error?: string }> {
      return new Promise((resolve) => {
        let buf = ''; let done = false; let idleSince = 0
        const finish = (r: { output: string; ok: boolean; error?: string }) => { if (done) return; done = true; clearInterval(poll); clearTimeout(hard); live.delete(spec.stepId); resolve(r) }
        const hard = setTimeout(() => { try { sp.killTerminal(spec.stepId) } catch {}; finish({ output: buf, ok: false, error: `agent timed out after ${spec.timeoutMs}ms` }) }, spec.timeoutMs)
        live.set(spec.stepId, () => finish({ output: buf, ok: false, error: 'cancelled' }))
        sp.spawnTerminal(spec.stepId, launch(spec.agent), spec.cwd,
          (d) => {
            buf = (buf + d).slice(-CAP); onChunk?.(d)
            if (spec.doneMarker && buf.includes(spec.doneMarker)) return finish({ output: buf, ok: true })
          })
        sp.writeToTerminal(spec.stepId, `${spec.prompt}\n`)
        const poll = setInterval(() => {
          const st = detect(buf, spec.agent).status
          if (st === 'errored' || st === 'blocked') return finish({ output: buf, ok: false, error: `agent ${st}` })
          const now = Date.now()
          if (st === 'idle' || st === 'completed' || st === 'waiting_for_input') {
            if (!idleSince) idleSince = now
            else if (now - idleSince >= spec.idleMs) return finish({ output: buf, ok: true })
          } else { idleSince = 0 }
        }, 500)
      })
    },
    cancel(stepId) { live.get(stepId)?.() },
  }
}
