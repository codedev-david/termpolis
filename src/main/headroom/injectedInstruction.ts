import { steeringDirective, type SteeringMode } from './outputSteering'
import { SUDO_AGENT_HINT } from '../sudoAskpass'

export interface InjectedInstructionOpts {
  /** The launch cwd — embedded verbatim so the agent scopes memory to this repo. */
  cwd?: string
  /** Whether output-token steering is enabled (settings.steering). */
  steering: boolean
  /** Steering intensity (settings.mode); ignored when steering is off. */
  mode?: SteeringMode
  /** Whether `sudo -A` reaches Termpolis's password dialog in this session (sudoAskpass.ts). */
  sudoAskpass?: boolean
  /**
   * Whether Termpolis's SessionStart memory hook is installed for Claude Code (v1.55.0). The hook
   * loads the digest at session start and after a compaction, so the agent is told to call
   * memory_primer only when no digest is in its context, not every time it begins.
   */
  hookInstalled?: boolean
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
  const asIs = 'read it as background reference only — do NOT resume past work from it or summarize it unprompted; just hold it as context.'
  if (opts.hookInstalled) {
    const parts = [
      'Termpolis project memory: a memory digest for this project is loaded into your context at session start and again after a compaction.',
      `Call the termpolis MCP tool memory_primer${cwdArg} only if no memory digest is in your context, and ${asIs}`,
      'Before re-deriving any fix or solution that may already be stored, call the termpolis memory_search tool first.',
      'For code questions use the termpolis code_locate / code_explore tools before reading whole files.',
      'If the termpolis memory tools are unavailable, ignore this and proceed normally.',
    ]
    return withTail(parts, opts)
  }
  const parts = [
    'Termpolis project memory: saved background context exists for this project.',
    `When you begin working, call the termpolis MCP tool memory_primer${cwdArg} and read it as background reference only — do NOT resume past work from it or summarize it unprompted; just hold it as context.`,
    'Before re-deriving any fix or solution that may already be stored, call the termpolis memory_search tool first.',
    'For code questions use the termpolis code_locate / code_explore tools before reading whole files.',
    // Compaction self-reprime: the system prompt survives a conversation compaction
    // while the loaded digest (which lived in the conversation) does not — so tell the
    // agent to re-fetch it itself. Writing "call memory_primer" into the terminal
    // instead would append at the cursor onto the user's own draft (v1.25.2 lesson).
    'If your context is compacted or summarized during this session, the memory digest you loaded will have been summarized away with it — call memory_primer once more, silently, before continuing, then carry on with the task in hand.',
    'If the termpolis memory tools are unavailable, ignore this and proceed normally.',
  ]
  return withTail(parts, opts)
}

function withTail(parts: string[], opts: InjectedInstructionOpts): string {
  // Without it an agent's sudo has no terminal to ask for the password on, and fails.
  if (opts.sudoAskpass) parts.push(SUDO_AGENT_HINT)
  // Output-token steering (Token Headroom): trims what the model writes back.
  if (opts.steering) parts.push(steeringDirective(opts.mode))
  return parts.join(' ')
}
