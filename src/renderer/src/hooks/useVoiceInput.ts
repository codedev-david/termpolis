import { useState, useRef, useCallback } from 'react'

export interface VoiceInputState {
  isListening: boolean
  transcript: string
  error: string | null
  start: () => void
  stop: () => void
  toggle: () => void
  supported: boolean
}

/**
 * Hook that wraps the Web Speech API (SpeechRecognition) for voice-to-text input.
 *
 * @param onResult - called with the final transcript when the user stops speaking
 * @param options.continuous - keep listening after each result (default: false)
 * @param options.language - BCP-47 language tag (default: 'en-US')
 */
export function useVoiceInput(
  onResult?: (transcript: string) => void,
  options: { continuous?: boolean; language?: string } = {},
): VoiceInputState {
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)
  const recognitionRef = useRef<any>(null)
  const stoppedByUserRef = useRef(false)
  const onResultRef = useRef(onResult)
  onResultRef.current = onResult

  const SpeechRecognition =
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition

  const supported = !!SpeechRecognition

  const stop = useCallback(() => {
    stoppedByUserRef.current = true
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      recognitionRef.current = null
    }
    setIsListening(false)
  }, [])

  const start = useCallback(() => {
    if (!SpeechRecognition) {
      setError('Speech recognition is not supported in this browser')
      return
    }

    // Stop any existing session
    if (recognitionRef.current) {
      recognitionRef.current.stop()
    }

    stoppedByUserRef.current = false
    setError(null)
    setTranscript('')

    const createRecognition = () => {
      const recognition = new SpeechRecognition()
      recognition.lang = options.language ?? 'en-US'
      recognition.interimResults = true
      recognition.continuous = true
      recognition.maxAlternatives = 1

      recognition.onstart = () => {
        setIsListening(true)
      }

      recognition.onresult = (event: any) => {
        let interim = ''
        let final = ''
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i]
          if (result.isFinal) {
            final += result[0].transcript
          } else {
            interim += result[0].transcript
          }
        }

        const current = final || interim
        setTranscript(current)

        if (final && onResultRef.current) {
          onResultRef.current(final)
        }
      }

      recognition.onerror = (event: any) => {
        if (event.error === 'aborted') return
        // "no-speech" is normal — just means silence, auto-restart will handle it
        if (event.error === 'no-speech') return
        setError(event.error === 'not-allowed'
          ? 'Microphone access denied — check browser permissions'
          : `Speech error: ${event.error}`)
        setIsListening(false)
        stoppedByUserRef.current = true
        recognitionRef.current = null
      }

      recognition.onend = () => {
        // Auto-restart if user didn't explicitly stop and we're in continuous mode
        if (!stoppedByUserRef.current && (options.continuous ?? false)) {
          try {
            const next = createRecognition()
            recognitionRef.current = next
            next.start()
            return
          } catch {
            // Failed to restart — fall through to stop
          }
        }
        setIsListening(false)
        recognitionRef.current = null
      }

      return recognition
    }

    const recognition = createRecognition()
    recognitionRef.current = recognition
    recognition.start()
  }, [SpeechRecognition, options.continuous, options.language])

  const toggle = useCallback(() => {
    if (isListening) {
      stop()
    } else {
      start()
    }
  }, [isListening, start, stop])

  return { isListening, transcript, error, start, stop, toggle, supported }
}
