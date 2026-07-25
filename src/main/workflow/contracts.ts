// contracts.ts — WorkflowRunEvent lives in renderer/src/types (single source); re-export for main-side ergonomics.
import type { WorkflowRunEvent } from '../../renderer/src/types'
import type { ExprScope } from './workflowExpr'
export type { WorkflowRunEvent }
export type { ExprScope }

export interface CommandRunSpec { stepId: string; command: string; shell: string; cwd: string; timeoutMs: number; visible: boolean }
export interface CommandRunResult { exitCode: number; output: string; timedOut?: boolean }
export interface TerminalRunner { run(spec: CommandRunSpec, onChunk?: (s: string) => void): Promise<CommandRunResult>; cancel(stepId: string): void }

export interface AgentRunSpec { stepId: string; agent: 'claude' | 'codex' | 'gemini'; prompt: string; cwd: string; idleMs: number; timeoutMs: number; doneMarker?: string }
export interface AgentRunResult { output: string; ok: boolean; error?: string }
export interface AgentRunner { run(spec: AgentRunSpec, onChunk?: (s: string) => void): Promise<AgentRunResult>; cancel(stepId: string): void }

export interface ToolInvoker { invoke(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<{ output: string; ok: boolean; error?: string }> }
export interface Timer { sleep(ms: number): Promise<void> }

export interface EngineDeps {
  terminal: TerminalRunner; agent: AgentRunner; tools: ToolInvoker; timer: Timer
  now: () => number; newRunId: () => string; emit: (e: WorkflowRunEvent) => void
  /** Per-run `${inputs.*}` / `${project.*}` values. Lives on the deps rather than
   *  a threaded parameter because it is constant for the whole run, exactly like
   *  the runners and the clock. Absent = step results are the only references. */
  scope?: ExprScope
}
