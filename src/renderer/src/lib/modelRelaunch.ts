// Relaunches a terminal's Claude Code process on a different model instead of
// hot-swapping in place. Claude Code (v2.1.153+) treats `/model <alias>` typed
// directly as "switch AND save as my new global default", rewriting
// ~/.claude/settings.json — so a per-terminal picker that types that command
// corrupts every other terminal's next launch. `--model` at launch is
// documented session-only, and `--continue` resumes the prior conversation in
// the same directory, so this achieves a real per-terminal switch instead.
//
// The exit sequence (Ctrl+C, then Ctrl+D twice) is Claude Code's own documented
// keyboard-shortcut behavior (see interactive-mode docs): Ctrl+C normalizes to
// an idle, empty prompt (clears input, or interrupts a running turn); Ctrl+D's
// first press shows an exit confirmation hint, and a second press within its
// documented 800ms window exits. Only call this for a terminal AUTHORITATIVELY
// known to be running Claude Code (Termpolis itself launched it) — a
// heuristically output-detected "Claude-like" terminal might be a different
// program that would just exit on the first Ctrl+D instead of consuming it.

import { claudeModelArg } from './modelBroker'

const CTRL_C = '\x03'
const CTRL_D = '\x04'
const NORMALIZE_DELAY_MS = 150
const CONFIRM_DELAY_MS = 150 // stays well under Claude Code's documented 800ms Ctrl+D exit window
const EXIT_SETTLE_MS = 1500

export interface RelaunchIO {
  write: (data: string) => void
  sleep: (ms: number) => Promise<void>
}

export async function relaunchClaudeWithModel(alias: string, io: RelaunchIO): Promise<void> {
  const modelArg = claudeModelArg(alias)
  if (!modelArg) return
  io.write(CTRL_C)
  await io.sleep(NORMALIZE_DELAY_MS)
  io.write(CTRL_D)
  await io.sleep(CONFIRM_DELAY_MS)
  io.write(CTRL_D)
  await io.sleep(EXIT_SETTLE_MS)
  io.write(`claude${modelArg} --continue\r`)
}
