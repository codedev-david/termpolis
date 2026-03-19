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

export function loadSession(): SessionData {
  const path = getSessionPath()
  if (!existsSync(path)) return { ...DEFAULT_SESSION }
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = { ...DEFAULT_SESSION, ...JSON.parse(raw) }
    parsed.terminals = parsed.terminals.map((t: any) => ({ ...TERMINAL_DEFAULTS, ...t }))
    parsed.workspaces = parsed.workspaces.map((w: any) => ({
      ...w,
      terminals: w.terminals.map((t: any) => ({ ...TERMINAL_DEFAULTS, ...t }))
    }))
    return parsed
  } catch {
    return { ...DEFAULT_SESSION }
  }
}

export function saveSession(data: SessionData): void {
  writeFileSync(getSessionPath(), JSON.stringify(data, null, 2), 'utf-8')
}
