import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { SessionData } from './types'

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

    // If the app version changed (new install/upgrade), don't restore terminals —
    // old shell processes no longer exist. Keep settings (viewMode, keybindings, etc.).
    const currentVersion = getAppVersion()
    if (parsed.appVersion !== currentVersion) {
      console.log(`App version changed (${parsed.appVersion ?? 'none'} → ${currentVersion}), skipping terminal restore`)
      parsed.terminals = []
      parsed.workspaces = parsed.workspaces.map((w: any) => ({ ...w, terminals: [] }))
    } else {
      parsed.terminals = parsed.terminals.map((t: any) => ({ ...TERMINAL_DEFAULTS, ...t }))
      parsed.workspaces = parsed.workspaces.map((w: any) => ({
        ...w,
        terminals: w.terminals.map((t: any) => ({ ...TERMINAL_DEFAULTS, ...t }))
      }))
    }
    return parsed
  } catch {
    return { ...DEFAULT_SESSION }
  }
}

export function saveSession(data: SessionData): void {
  const withVersion = { ...data, appVersion: getAppVersion() }
  writeFileSync(getSessionPath(), JSON.stringify(withVersion, null, 2), 'utf-8')
}
