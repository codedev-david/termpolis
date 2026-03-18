import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { SessionData } from './types'

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
    return { ...DEFAULT_SESSION, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_SESSION }
  }
}

export function saveSession(data: SessionData): void {
  writeFileSync(getSessionPath(), JSON.stringify(data, null, 2), 'utf-8')
}
