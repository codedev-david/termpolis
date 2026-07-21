import { steeringDirective, type SteeringMode } from './outputSteering'

export interface InjectedInstructionOpts {
  /** The launch cwd — embedded verbatim so the agent scopes memory to this repo. */
  cwd?: string
  /** Whether output-token steering is enabled (settings.steering). */
  steering: boolean
  /** Steering intensity (settings.mode); ignored when steering is off. */
  mode?: SteeringMode
}

/**
 * Build the EXACT bytes written to Claude Code's `--append-system-prompt-file`.
 *
 * PURE + DETERMINISTIC: same (cwd, steering, mode) → byte-identical output. This is
 * a cache-safety invariant, not a nicety — the system prompt is re-sent on every
 * request, so a single nondeterministic byte here (a timestamp, a uuid, a random id)
 * would bust Anthropic's prompt cache on every turn of every session. The relevance
 * DIGEST is deliberately NOT included (the agent fetches it via the memory_primer
 * tool) precisely because it carries wall-clock "· 3d ago" age markers that vary.
 *
 * Locked by headroomInjectedInstruction.test.ts (determinism + no nondeterministic
 * content). If you add a line here, keep it a constant — no clock, no randomness.
 */
export function buildInjectedInstruction(opts: InjectedInstructionOpts): string {
  const cwdArg = opts.cwd ? ` (cwd "${opts.cwd}")` : ''
  const parts = [
    'Termpolis project memory: saved background context exists for this project.',
    `When you begin working, call the termpolis MCP tool memory_primer${cwdArg} and read it as background reference only — do NOT resume past work from it or summarize it unprompted; just hold it as context.`,
    'Before re-deriving any fix or solution that may already be stored, call the termpolis memory_search tool first.',
    // Compaction self-reprime: the system prompt survives a conversation compaction
    // while the loaded digest (which lived in the conversation) does not — so tell the
    // agent to re-fetch it itself. Writing "call memory_primer" into the terminal
    // instead would append at the cursor onto the user's own draft (v1.25.2 lesson).
    'If your context is compacted or summarized during this session, the memory digest you loaded will have been summarized away with it — call memory_primer once more, silently, before continuing, then carry on with the task in hand.',
    'If the termpolis memory tools are unavailable, ignore this and proceed normally.',
  ]
  // Output-token steering (Token Headroom): trims what the model writes back.
  if (opts.steering) parts.push(steeringDirective(opts.mode))
  return parts.join(' ')
}
