/**
 * The launch variable that makes Claude Code compact a long conversation earlier (R3 of the 1.55.0
 * compression work), and the rules for when Termpolis may set it.
 *
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW is Anthropic's own and documented (env-vars and model-config pages):
 * "how full the context gets before compaction", from 100000 to 1000000 tokens. Four things those pages
 * say decide the shape of this file:
 *
 *  - Claude Code caps the window at the model's own context window. A value above it changes nothing, so
 *    a smaller window is the only thing this can do, and only on a model whose window is larger.
 *  - The variable takes precedence over /autocompact, over --autocompact and over the autoCompactWindow
 *    setting. A window the user saved there on purpose is therefore a value we must not override, as much
 *    as the variable itself is, and it is checked the same way.
 *  - A suffixed value (200k) needs Claude Code 2.1.304. Plain digits work on every version that reads the
 *    variable, so only plain digits are ever written.
 *  - Below 100000 or above 1000000 Claude Code warns and clamps, and a bare 200 means 200 tokens. So only
 *    an integer inside the range is ever written, whatever the setting holds.
 *
 * It is NOT a compression setting and shares nothing with the proxy: it is read from Settings when a
 * Claude terminal is created, so it is neither frozen for a run nor pushed to the proxy child, a change
 * reaches the next terminal and no running one, and it is set whether or not the proxy is healthy.
 *
 * Pure on purpose: what the settings files hold arrives through functions the caller passes in
 * (shapingEnvReader.ts reads them), so every rule below is a test without a file system.
 */

/** Claude Code's name for the window. */
export const CONTEXT_WINDOW_VAR = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
/** Anthropic's documented range for the window, in tokens. */
export const CONTEXT_CAP_MIN = 100_000
export const CONTEXT_CAP_MAX = 1_000_000
/** What Settings offers: 0 is Off, then the largest window down. */
export const CONTEXT_CAP_CHOICES: readonly number[] = [0, 500_000, 400_000, 300_000, 200_000]
/** A read of the settings files that takes longer than this is treated as not having happened. */
export const SETTINGS_READ_DEADLINE_MS = 1_500

type Env = Readonly<Record<string, string | undefined>>

/** An integer inside the documented range: a window Claude Code would use as written. */
export function isContextCap(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= CONTEXT_CAP_MIN && v <= CONTEXT_CAP_MAX
}

/** What the setting may hold: a window, or 0 for Off. */
export function isContextCapSetting(v: unknown): v is number {
  return v === 0 || isContextCap(v)
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isHeld = (v: unknown): boolean => v !== undefined && v !== null

/** Whether a block of variables holds the window. The name is read in any case, because Windows does. */
function holdsWindow(block: unknown): boolean {
  if (!isRecord(block)) return false
  return Object.keys(block).some((key) => key.toUpperCase() === CONTEXT_WINDOW_VAR && isHeld(block[key]))
}

/** Call a reader that may throw: a read that fails counts as nothing found. */
function attempt<T>(read: (() => T) | undefined): T | null {
  try { return read ? read() : null } catch { return null }
}

export type WindowOwner = 'environment' | 'settings-env' | 'saved-window'

/**
 * Whose window it already is: the environment Termpolis passes on, the env block of a Claude Code
 * settings file, or a window saved there with /autocompact or autoCompactWindow. Null when nobody's.
 * The readers are asked only as far as they are needed, and a reader that throws holds nothing.
 */
export function windowOwner(env: Env, readSettingsEnv?: () => unknown, readSavedWindow?: () => boolean): WindowOwner | null {
  if (holdsWindow(env)) return 'environment'
  if (holdsWindow(attempt(readSettingsEnv))) return 'settings-env'
  if (attempt(readSavedWindow) === true) return 'saved-window'
  return null
}

/**
 * The variable to add to a Claude launch, or nothing: `{ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' }` for a
 * valid cap that nobody has already set, `{}` otherwise.
 *
 * `env` is the environment the launch inherits. `readSettingsEnv` returns the `env` block of the Claude Code
 * settings in force (or null), and `readSavedWindow` says whether those files save a window of their own;
 * a failure to read either counts as not set.
 */
export function buildShapingEnv(
  settings: { contextCap?: unknown } | null | undefined,
  env: Env,
  readSettingsEnv?: () => Record<string, unknown> | null,
  readSavedWindow?: () => boolean,
): Record<string, string> {
  const cap = settings?.contextCap
  if (!isContextCap(cap) || windowOwner(env, readSettingsEnv, readSavedWindow) !== null) return {}
  return { [CONTEXT_WINDOW_VAR]: String(cap) }
}

/** What a Claude Code settings file says about the window, reduced to what the decision above needs. */
export interface ClaudeWindowSettings {
  /** The file's `env` block. */
  env: Record<string, unknown> | null
  /** Whether it saves a window of its own: autoCompactWindow, or one per model from /autocompact. */
  savedWindow: boolean
}

/**
 * Reduce a parsed settings file to the two things that matter. Everything else in it (permissions, hooks,
 * helpers, the model) is looked at by nothing and not kept.
 */
export function pickWindowSettings(parsed: unknown): ClaudeWindowSettings {
  if (!isRecord(parsed)) return { env: null, savedWindow: false }
  const perModel = isRecord(parsed.modelSettings) ? Object.values(parsed.modelSettings) : []
  return {
    env: isRecord(parsed.env) ? parsed.env : null,
    savedWindow: isHeld(parsed.autoCompactWindow) || perModel.some((m) => isRecord(m) && isHeld(m.autoCompactWindow)),
  }
}

/** Put several files together the way Claude Code reads them: a later env block over an earlier one. */
export function mergeWindowSettings(parts: readonly ClaudeWindowSettings[]): ClaudeWindowSettings {
  let env: Record<string, unknown> | null = null
  let savedWindow = false
  for (const part of parts) {
    if (part.env) env = { ...(env ?? {}), ...part.env }
    if (part.savedWindow) savedWindow = true
  }
  return { env, savedWindow }
}

/** Run a read, but not past the deadline: a settings file on a share that has gone away must not stop a terminal opening. */
async function settle(read: () => Promise<ClaudeWindowSettings | null | undefined>, deadlineMs: number): Promise<ClaudeWindowSettings | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), deadlineMs) })
    return (await Promise.race([read(), late])) ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * buildShapingEnv for a launch: the settings files are read only when there is something to protect (a
 * valid cap that the environment has not already set), so a user who never turned the cap on costs the
 * launch nothing. Never rejects, and never waits past the deadline.
 */
export async function resolveShapingEnv(
  settings: { contextCap?: unknown } | null | undefined,
  env: Env,
  read?: () => Promise<ClaudeWindowSettings | null | undefined>,
  deadlineMs: number = SETTINGS_READ_DEADLINE_MS,
): Promise<Record<string, string>> {
  const first = buildShapingEnv(settings, env)
  if (!read || !(CONTEXT_WINDOW_VAR in first)) return first
  const seen = await settle(read, deadlineMs)
  return buildShapingEnv(settings, env, () => seen?.env ?? null, () => seen?.savedWindow === true)
}

/**
 * The env a Claude launch gets beyond the shell's own: the proxy route, which is null whenever the proxy
 * is off, stepping aside or unhealthy, and the window, which has nothing to do with the proxy and so is
 * there either way. Nothing at all (not an empty object) when there is neither, which is what a launch
 * without either has always been handed.
 */
export function composeLaunchEnv(
  proxyEnv: Record<string, string> | null | undefined,
  shaping: Record<string, string>,
): Record<string, string> | undefined {
  const merged = { ...(proxyEnv ?? {}), ...shaping }
  return Object.keys(merged).length > 0 ? merged : undefined
}
