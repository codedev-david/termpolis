import type { TerminalRunner, AgentRunner, ToolInvoker, Timer, CommandRunSpec, CommandRunResult } from './contracts'
import type { McpToolHandlers } from '../mcpServer'

type SpawnDeps = {
  spawnTerminal: (id: string, exe: string, cwd: string, onData: (s: string) => void, extraPaths?: string[], extraEnv?: Record<string, string>, onExit?: (code: number) => void) => void
  writeToTerminal: (id: string, data: string) => void
  killTerminal: (id: string) => void
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
        sp.spawnTerminal(spec.stepId, spec.shell, spec.cwd,
          (d) => { buf = (buf + d).slice(-CAP); onChunk?.(d) },
          undefined, undefined,
          (code) => finish({ exitCode: code, output: buf }))
        // Non-interactive: write the command + newline, then signal EOF via `exit`.
        sp.writeToTerminal(spec.stepId, `${spec.command}\n`)
        if (!spec.visible) sp.writeToTerminal(spec.stepId, `exit $?\n`)
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
