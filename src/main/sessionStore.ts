import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { SessionData, CustomKeybinding } from './types'

const MAX_KB_FIELD = 4096

// Custom keybindings type a snippet straight into the active terminal, so a
// restored/shared session.json must not be trusted blindly. Drop entries that
// aren't well-formed, cap field lengths, and coerce runOnSend to a strict
// boolean (so a tampered truthy value can't silently auto-run a command).
function sanitizeCustomKeybindings(raw: unknown): CustomKeybinding[] {
  if (!Array.isArray(raw)) return []
  const out: CustomKeybinding[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.id !== 'string' || !e.id) continue
    if (typeof e.label !== 'string') continue
    if (typeof e.combo !== 'string' || !e.combo) continue
    if (typeof e.text !== 'string') continue
    out.push({
      id: e.id.slice(0, 128),
      label: e.label.slice(0, MAX_KB_FIELD),
      combo: e.combo.slice(0, 64),
      text: e.text.slice(0, MAX_KB_FIELD),
      runOnSend: e.runOnSend === true,
    })
  }
  return out
}

// Keep in sync with src/renderer/src/lib/terminalDefaults.ts
const TERMINAL_DEFAULTS = {
  fontSize: 14,
  theme: 'dark',
  fontFamily: 'Consolas, "Courier New", monospace',
}

const DEFAULT_SESSION: SessionData = {
  terminals: [],
  workspaces: [],
  defaultShell: 'bash',
  viewMode: 'tabs',
}

function getSessionPath(): string {
  return join(app.getPath('userData'), 'session.json')
}

function getAppVersion(): string {
  try { return app.getVersion() } catch { return '0.0.0' }
}

export function loadSession(): SessionData {
  const path = getSessionPath()
  if (!existsSync(path)) return { ...DEFAULT_SESSION }
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = { ...DEFAULT_SESSION, ...JSON.parse(raw) }
    // Migrate old 'grid' viewMode to 'split'
    if (parsed.viewMode === 'grid') parsed.viewMode = 'split'

    // The stored terminal list is returned FAITHFULLY here. It is not "what to
    // reopen" — it's the record of what the last session had, and non-UI callers
    // depend on it: the MCP `list_terminals`/`swarm_list_agents` tools read it to
    // answer what is open right now, and the workflow trigger supervisor arms a
    // project from each terminal's cwd at boot. Dropping terminals in this reader
    // silently blanked all three. The boot restore path calls
    // `loadRestoreSession()` instead — that is where "start clean" belongs.
    parsed.terminals = (parsed.terminals ?? []).map((t: any) => ({ ...TERMINAL_DEFAULTS, ...t }))

    // Workspaces keep their terminals — that is the entire point of a workspace.
    // This used to be wiped whenever the app version changed, which silently emptied
    // every saved workspace on each auto-update.
    parsed.workspaces = (parsed.workspaces ?? []).map((w: any) => ({
      ...w,
      terminals: (w.terminals ?? []).map((t: any) => ({ ...TERMINAL_DEFAULTS, ...t })),
    }))
    // Always normalize custom keybindings to a clean, bounded array.
    parsed.customKeybindings = sanitizeCustomKeybindings(parsed.customKeybindings)
    return parsed
  } catch {
    return { ...DEFAULT_SESSION }
  }
}

/**
 * The session the RENDERER restores at boot: everything `loadSession()` returns,
 * minus the loose terminals.
 *
 * Auto-restore resurrected shells whose processes were long gone, and it competed
 * with WORKSPACES for ownership of "which terminals are open". Saving a group of
 * terminals for a project is a workspace's job, and a workspace is restored
 * explicitly by the user — never silently at boot. So every launch starts with an
 * empty terminal list while settings and saved workspaces survive intact.
 */
export function loadRestoreSession(): SessionData {
  return { ...loadSession(), terminals: [] }
}

export function saveSession(data: SessionData): void {
  const withVersion = { ...data, appVersion: getAppVersion() }
  writeFileSync(getSessionPath(), JSON.stringify(withVersion, null, 2), 'utf-8')
}
