// Relaunches a terminal's agent process on a different model instead of
// hot-swapping in place. Claude Code (v2.1.153+) treats `/model <alias>` typed
// directly as "switch AND save as my new global default", rewriting
// ~/.claude/settings.json — so a per-terminal picker that types that command
// corrupts every other terminal's next launch. `--model` at launch is
// documented session-only, and each agent has its own "resume the previous
// conversation" flag, so this achieves a real per-terminal switch instead.
//
// The exit sequence (Ctrl+C, then Ctrl+D) is Claude Code's own documented
// keyboard-shortcut behavior (see interactive-mode docs): Ctrl+C normalizes to
// an idle, empty prompt (clears input, or interrupts a running turn); Ctrl+D's
// first press shows an exit confirmation hint, and a second press within its
// documented 800ms window exits. Codex and the Antigravity CLI exit on a single
// Ctrl+D, so the count is per-provider (see EXIT_CONFIRMS) — and it is biased
// LOW on purpose: one press too few leaves the relaunch command sitting visibly
// in the agent's own input box, while one press too many reaches the SHELL and
// closes the terminal. Only call this for a terminal AUTHORITATIVELY known to be
// running that agent (Termpolis itself launched it) — a heuristically
// output-detected "Claude-like" terminal might be a different program that would
// just exit on the first Ctrl+D instead of consuming it.

import { claudeModelArg } from './modelBroker'
import { EXIT_CONFIRMS, relaunchCommandFor, type ModelCatalog, type ModelProvider } from './modelCatalog'

const CTRL_C = '\x03'
const CTRL_D = '\x04'
const NORMALIZE_DELAY_MS = 150
const CONFIRM_DELAY_MS = 150 // stays well under Claude Code's documented 800ms Ctrl+D exit window
const EXIT_SETTLE_MS = 1500

export interface RelaunchIO {
  write: (data: string) => void
  sleep: (ms: number) => Promise<void>
}

/** Ctrl+C to idle the prompt, then the agent's exit chord, then let the shell settle. */
async function exitAgent(confirms: number, io: RelaunchIO): Promise<void> {
  io.write(CTRL_C)
  await io.sleep(NORMALIZE_DELAY_MS)
  for (let i = 0; i < confirms; i++) {
    // The gap goes BETWEEN presses, never after the last one — the settle below already
    // covers that, and a trailing gap would just push the retype further out.
    if (i > 0) await io.sleep(CONFIRM_DELAY_MS)
    io.write(CTRL_D)
  }
  await io.sleep(EXIT_SETTLE_MS)
}

/**
 * Relaunch any supported agent on `modelId`, resuming its previous conversation.
 * No-ops when the model isn't one the catalog actually offers for that provider,
 * so nothing unvalidated can reach the PTY.
 */
export async function relaunchAgentWithModel(
  provider: ModelProvider,
  modelId: string,
  catalog: ModelCatalog | null | undefined,
  io: RelaunchIO,
): Promise<void> {
  const command = relaunchCommandFor(provider, modelId, catalog)
  if (!command) return
  await exitAgent(EXIT_CONFIRMS[provider], io)
  io.write(`${command}\r`)
}

/** Claude-specific entry point, kept for the callers and tests that predate the
 *  multi-provider catalog. Validates against Claude's own alias enum. */
export async function relaunchClaudeWithModel(alias: string, io: RelaunchIO): Promise<void> {
  const modelArg = claudeModelArg(alias)
  if (!modelArg) return
  await exitAgent(EXIT_CONFIRMS.claude, io)
  io.write(`claude${modelArg} --continue\r`)
}
