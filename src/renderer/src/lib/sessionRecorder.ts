import { stripAnsi } from './exportTerminal'

export interface RecordingEntry {
  timestamp: number
  type: 'input' | 'output'
  data: string
}

export interface SessionRecording {
  entries: RecordingEntry[]
  startTime: number
  terminalName: string
  shellLabel: string
}

export function createSessionRecorder(terminalName: string, shellLabel: string): SessionRecording {
  return {
    entries: [],
    startTime: Date.now(),
    terminalName,
    shellLabel,
  }
}

export function appendEntry(recording: SessionRecording, type: 'input' | 'output', data: string): void {
  recording.entries.push({
    timestamp: Date.now(),
    type,
    data,
  })
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDateTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleString('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).replace(',', '')
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function formatRecording(recording: SessionRecording): string {
  const endTime = recording.entries.length > 0
    ? recording.entries[recording.entries.length - 1].timestamp
    : recording.startTime
  const duration = endTime - recording.startTime

  const header = [
    '=== Termpolis Session Recording ===',
    `Terminal: ${recording.terminalName}`,
    `Shell: ${recording.shellLabel}`,
    `Started: ${formatDateTime(recording.startTime)}`,
    `Duration: ${formatDuration(duration)}`,
    '',
  ].join('\n')

  // Merge entries into a readable log
  // Group consecutive output entries together and prefix with timestamps
  const lines: string[] = []
  let currentLine = ''

  for (const entry of recording.entries) {
    const time = formatTime(entry.timestamp)
    const clean = stripAnsi(entry.data)

    if (entry.type === 'input') {
      // Input is usually single characters; accumulate until \r
      if (clean === '\r' || clean === '\n') {
        if (currentLine) {
          lines.push(`[${time}] $ ${currentLine}`)
          currentLine = ''
        }
      } else if (clean === '\u007f') {
        // Backspace
        currentLine = currentLine.slice(0, -1)
      } else if (!clean.startsWith('\x1b')) {
        currentLine += clean
      }
    } else {
      // Output lines
      const outputLines = clean.split('\n')
      for (const ol of outputLines) {
        const trimmed = ol.replace(/\r/g, '').trimEnd()
        if (trimmed) {
          lines.push(`[${time}] ${trimmed}`)
        }
      }
    }
  }

  // Flush any remaining input
  if (currentLine) {
    const time = formatTime(Date.now())
    lines.push(`[${time}] $ ${currentLine}`)
  }

  return header + lines.join('\n') + '\n'
}

export function generateRecordingFilename(terminalName: string): string {
  const date = new Date()
  const ts = date.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const safe = terminalName.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `${safe}_recording_${ts}.txt`
}
