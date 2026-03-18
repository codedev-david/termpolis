import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { HistoryEntry } from './types'

const MAX_PER_TERMINAL = 1000
type HistoryFile = Record<string, HistoryEntry[]>

function getHistoryPath(): string {
  return join(app.getPath('userData'), 'history.json')
}

function loadHistory(): HistoryFile {
  const path = getHistoryPath()
  if (!existsSync(path)) return {}
  try { return JSON.parse(readFileSync(path, 'utf-8')) }
  catch { return {} }
}

function saveHistory(data: HistoryFile): void {
  writeFileSync(getHistoryPath(), JSON.stringify(data, null, 2), 'utf-8')
}

export function appendCommand(terminalId: string, terminalName: string, command: string): void {
  const trimmed = command.trim()
  if (!trimmed) return
  const history = loadHistory()
  if (!history[terminalId]) history[terminalId] = []
  history[terminalId].push({ terminalId, terminalName, command: trimmed, timestamp: Date.now() })
  if (history[terminalId].length > MAX_PER_TERMINAL) {
    history[terminalId] = history[terminalId].slice(-MAX_PER_TERMINAL)
  }
  saveHistory(history)
}

export function searchHistory(query: string): HistoryEntry[] {
  const history = loadHistory()
  const lower = query.toLowerCase()
  return Object.values(history).flat()
    .filter(e => e.command.toLowerCase().includes(lower))
    .sort((a, b) => b.timestamp - a.timestamp)
}
