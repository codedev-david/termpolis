import { useState, useRef, useCallback } from 'react'
import {
  createSessionRecorder,
  appendEntry,
  formatRecording,
  generateRecordingFilename,
  type SessionRecording,
} from '../lib/sessionRecorder'

interface SessionRecordingState {
  isRecording: boolean
  startRecording: () => void
  stopRecording: () => void
  appendRecordingEntry: (type: 'input' | 'output', data: string) => void
  /** Ref-based check for recording state (avoids stale closures in onData) */
  isRecordingRef: React.RefObject<boolean>
}

export function useSessionRecording(
  terminalName: string,
  shellType: string,
): SessionRecordingState {
  const [isRecording, setIsRecording] = useState(false)
  const isRecordingRef = useRef(false)
  const recordingRef = useRef<SessionRecording | null>(null)

  // Keep ref in sync
  isRecordingRef.current = isRecording

  const shellLabel: Record<string, string> = {
    bash: 'Bash', zsh: 'Zsh', cmd: 'CMD', powershell: 'PowerShell', gitbash: 'Git Bash',
  }

  const startRecording = useCallback(() => {
    const recording = createSessionRecorder(terminalName, shellLabel[shellType] ?? shellType)
    recordingRef.current = recording
    setIsRecording(true)
  }, [terminalName, shellType])

  const stopRecording = useCallback(() => {
    const recording = recordingRef.current
    if (!recording) return
    const content = formatRecording(recording)
    const defaultFilename = generateRecordingFilename(terminalName)
    window.termpolis.exportTerminal({ content, defaultFilename })
    recordingRef.current = null
    setIsRecording(false)
  }, [terminalName])

  const appendRecordingEntry = useCallback((type: 'input' | 'output', data: string) => {
    if (isRecordingRef.current && recordingRef.current) {
      appendEntry(recordingRef.current, type, data)
    }
  }, [])

  return {
    isRecording,
    startRecording,
    stopRecording,
    appendRecordingEntry,
    isRecordingRef,
  }
}
