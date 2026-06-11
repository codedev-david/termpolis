// Terminal appearance defaults — factory values overlaid with the user's saved
// preferences (Settings → General → Terminal Defaults). Every terminal-creation
// path reads getTerminalDefaults() at create time, so the setting applies to AI
// agent terminals and regular shells alike; the New Terminal dialog and each
// terminal's edit menu still override these for individual terminals.

export interface TerminalDefaults {
  fontSize: number
  theme: string
  fontFamily: string
}

export const FACTORY_TERMINAL_DEFAULTS: TerminalDefaults = {
  fontSize: 14,
  theme: 'dark',
  fontFamily: 'Consolas, "Courier New", monospace',
}

// The font choices offered in Settings and the New Terminal dialog.
export const FONT_FAMILY_OPTIONS = [
  { label: 'Consolas', value: 'Consolas, "Courier New", monospace' },
  { label: 'JetBrains Mono', value: 'JetBrains Mono, monospace' },
]

export const MIN_FONT_SIZE = 8
export const MAX_FONT_SIZE = 32

const DEFAULTS_KEY = 'termpolis.terminal.defaults'

export function clampFontSize(value: number): number {
  if (!Number.isFinite(value)) return FACTORY_TERMINAL_DEFAULTS.fontSize
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value)))
}

/** The current defaults: factory values overlaid with whatever the user saved. */
export function getTerminalDefaults(): TerminalDefaults {
  try {
    const raw = localStorage.getItem(DEFAULTS_KEY)
    if (!raw) return { ...FACTORY_TERMINAL_DEFAULTS }
    const saved = JSON.parse(raw)
    return {
      fontSize: clampFontSize(Number(saved?.fontSize)),
      theme: typeof saved?.theme === 'string' && saved.theme ? saved.theme : FACTORY_TERMINAL_DEFAULTS.theme,
      fontFamily:
        typeof saved?.fontFamily === 'string' && saved.fontFamily
          ? saved.fontFamily
          : FACTORY_TERMINAL_DEFAULTS.fontFamily,
    }
  } catch {
    return { ...FACTORY_TERMINAL_DEFAULTS }
  }
}

/** Merge a partial update into the saved defaults; returns the result. */
export function setTerminalDefaults(patch: Partial<TerminalDefaults>): TerminalDefaults {
  const next = { ...getTerminalDefaults(), ...patch }
  next.fontSize = clampFontSize(next.fontSize)
  try {
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
  return next
}

export function resetTerminalDefaults(): void {
  try {
    localStorage.removeItem(DEFAULTS_KEY)
  } catch {
    /* ignore */
  }
}

// ---- Optional: name AI agent terminals after the folder they launch in ----

const NAME_FROM_FOLDER_KEY = 'termpolis.terminal.agentNameFromFolder'

/** OFF by default; opt-in via the checkbox in Settings → General → Terminal Defaults. */
export function isAgentNameFromFolderEnabled(): boolean {
  try {
    return localStorage.getItem(NAME_FROM_FOLDER_KEY) === '1'
  } catch {
    return false
  }
}

export function setAgentNameFromFolderEnabled(on: boolean): void {
  try {
    localStorage.setItem(NAME_FROM_FOLDER_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}

/**
 * Name for a freshly-launched AI agent terminal: the launch folder's name when
 * the user opted in (and one is derivable from the cwd), otherwise the agent
 * profile's name. Only fresh launches use this — resumed/handoff terminals keep
 * their descriptive names.
 */
export function agentTerminalName(profileName: string, cwd: string): string {
  if (!isAgentNameFromFolderEnabled()) return profileName
  const folder = (cwd || '').trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
  // A bare drive root ("C:") or empty path gives nothing useful — keep the profile name.
  if (!folder || /^[A-Za-z]:$/.test(folder)) return profileName
  return folder
}
