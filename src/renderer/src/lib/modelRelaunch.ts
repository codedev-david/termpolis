// Relaunches a terminal's agent process on a different model instead of
// hot-swapping in place. Claude Code (v2.1.153+) treats `/model <alias>` typed
// directly as "switch AND save as my new global default", rewriting
// ~/.claude/settings.json — so a per-terminal picker that types that command
// corrupts every other terminal's next launch. `--model` at launch is
// documented session-only, and each agent has its own "resume the previous
// conversation" flag, so this achieves a real per-terminal switch instead.
//
// Claude Code's exit sequence (Ctrl+C, then Ctrl+D) is its own documented
// keyboard-shortcut behavior (see interactive-mode docs): Ctrl+C normalizes to
// an idle, empty prompt (clears input, or interrupts a running turn); Ctrl+D's
// first press shows an exit confirmation hint, and a second press within its
// documented 800ms window exits. Codex and the Antigravity CLI get no Ctrl+C or
// Ctrl+D at all (§7.5): a single Ctrl+C already exits Codex 0.153.4 at an idle
// composer, which left the Ctrl+D after it for the SHELL, where it closes a bash
// terminal, and agy's Ctrl+C stops it outright. They are exited with their own
// command instead (EXIT_COMMAND), typed into a box an Esc and Ctrl+U emptied: Esc
// stops a turn at work and closes a suggestions list, and typed at a shell by
// mistake the command is a harmless "not found". Only call this for a terminal
// AUTHORITATIVELY known to be running that agent (Termpolis itself launched it) —
// a heuristically output-detected "Claude-like" terminal might be a different
// program that would just exit on the first Ctrl+D instead of consuming it.
//
// While it types, the picker holds the terminal's relaunch lock (relaunchHeld): the
// store's half, so the pane takes no keys, the pollers answer nothing and an account
// switch waits, and main's, so MCP clients and the phone are refused and every write
// but the picker's own is dropped.

import { CLEAR_BOX_KEYS, EXIT_COMMAND, MODEL_HELD } from '../../../shared/accountSwitch'
import type { ModelHold, ModelHoldRequest } from '../../../shared/accountSwitch'
import type { AccountAgent } from '../../../shared/agentAccounts'
import type { IpcResponse } from '../types'
import { claudeModelArg } from './modelBroker'
import { EXIT_CONFIRMS, relaunchCommandFor, type ModelCatalog, type ModelProvider } from './modelCatalog'

const CTRL_C = '\x03'
const CTRL_D = '\x04'
const ESC = '\x1b'
const NORMALIZE_DELAY_MS = 150
const CONFIRM_DELAY_MS = 150 // stays well under Claude Code's documented 800ms Ctrl+D exit window
const EXIT_SETTLE_MS = 1500

/** The agent each provider's terminal runs, as the account switch names it. */
const PROVIDER_AGENT: Readonly<Record<ModelProvider, AccountAgent>> = { claude: 'claude', codex: 'codex', gemini: 'agy' }

export interface RelaunchIO {
  write: (data: string) => void
  sleep: (ms: number) => Promise<void>
}

/** The agent's exit, then let the shell settle: Claude Code's keys (Ctrl+C to idle the prompt,
 *  then its exit chord), or the agent's own exit command. */
async function exitAgent(provider: ModelProvider, io: RelaunchIO): Promise<void> {
  const confirms = EXIT_CONFIRMS[provider]
  if (confirms > 0) {
    io.write(CTRL_C)
    await io.sleep(NORMALIZE_DELAY_MS)
    for (let i = 0; i < confirms; i++) {
      // The gap goes BETWEEN presses, never after the last one — the settle below already
      // covers that, and a trailing gap would just push the retype further out.
      if (i > 0) await io.sleep(CONFIRM_DELAY_MS)
      io.write(CTRL_D)
    }
  } else {
    io.write(ESC)
    await io.sleep(NORMALIZE_DELAY_MS)
    io.write(CLEAR_BOX_KEYS)
    await io.sleep(NORMALIZE_DELAY_MS)
    io.write(EXIT_COMMAND[PROVIDER_AGENT[provider]])
    await io.sleep(NORMALIZE_DELAY_MS)
    io.write('\r')
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
  sessionId?: string,
): Promise<void> {
  const command = relaunchCommandFor(provider, modelId, catalog, sessionId)
  if (!command) return
  await exitAgent(provider, io)
  io.write(`${command}\r`)
}

/** Claude-specific entry point, kept for the callers and tests that predate the
 *  multi-provider catalog. Validates against Claude's own alias enum. */
export async function relaunchClaudeWithModel(alias: string, io: RelaunchIO): Promise<void> {
  const modelArg = claudeModelArg(alias)
  if (!modelArg) return
  await exitAgent('claude', io)
  io.write(`claude${modelArg} --continue\r`)
}

/** Main's half of the terminal's relaunch lock, where this preload has it. */
export interface ModelHoldBridge {
  modelHold: (req: ModelHoldRequest) => Promise<IpcResponse<ModelHold>>
  modelRelease: (terminalId: string, key: string) => Promise<unknown>
}

export interface HeldRelaunch {
  terminalId: string
  provider: ModelProvider
  modelId: string
  catalog: ModelCatalog | null | undefined
  /** The store's half of the lock: true once this relaunch holds the terminal there. */
  begin: () => boolean
  end: () => void
  main: ModelHoldBridge | null
  /** Claude Code: the exact session to resume (the usage-limit chooser's model row), not the
   *  newest in the folder. */
  sessionId?: string
  /** The terminal's writes (window.termpolis.writeToTerminal): each carries the key of main's
   *  hold, while there is one. */
  write: (id: string, data: string, key?: string) => void
  sleep: (ms: number) => Promise<void>
}

/**
 * The model picker's relaunch (relaunchAgentWithModel), holding the terminal's relaunch lock while
 * it types (§7.5, R7). Nothing is typed unless both halves are this relaunch's. Returns why it
 * typed nothing, or null.
 */
export async function relaunchHeld(r: HeldRelaunch): Promise<string | null> {
  const command = relaunchCommandFor(r.provider, r.modelId, r.catalog, r.sessionId)
  if (!command) return null
  if (!r.begin()) return MODEL_HELD
  let key: string | null = null
  try {
    if (r.main) {
      const res = await r.main.modelHold({ terminalId: r.terminalId, line: command })
      if (!res.success) return res.error
      key = res.data.key
    }
    const held = key
    const write = held ? (data: string) => r.write(r.terminalId, data, held) : (data: string) => r.write(r.terminalId, data)
    await relaunchAgentWithModel(r.provider, r.modelId, r.catalog, { write, sleep: r.sleep }, r.sessionId)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  } finally {
    if (r.main && key) r.main.modelRelease(r.terminalId, key).catch(() => { /* it lapses by itself (MODEL_HOLD_MS) */ })
    r.end()
  }
}

/** Main's hold for the picker, when this preload has one. */
export function modelHoldBridge(): ModelHoldBridge | null {
  const api = window.accounts
  return api && typeof api.modelHold === 'function' && typeof api.modelRelease === 'function' ? api : null
}
