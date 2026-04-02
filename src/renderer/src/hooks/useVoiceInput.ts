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

  const SpeechRecognition =
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition

  const supported = !!SpeechRecognition

  const stop = useCallback(() => {
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

    setError(null)
    setTranscript('')

    const recognition = new SpeechRecognition()
    recognition.lang = options.language ?? 'en-US'
    recognition.interimResults = true
    recognition.continuous = options.continuous ?? false
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

      if (final && onResult) {
        onResult(final)
      }
    }

    recognition.onerror = (event: any) => {
      if (event.error === 'aborted') return // user stopped, not an error
      setError(event.error === 'not-allowed'
        ? 'Microphone access denied — check browser permissions'
        : `Speech error: ${event.error}`)
      setIsListening(false)
      recognitionRef.current = null
    }

    recognition.onend = () => {
      setIsListening(false)
      recognitionRef.current = null
    }

    recognitionRef.current = recognition
    recognition.start()
  }, [SpeechRecognition, onResult, options.continuous, options.language])

  const toggle = useCallback(() => {
    if (isListening) {
      stop()
    } else {
      start()
    }
  }, [isListening, start, stop])

  return { isListening, transcript, error, start, stop, toggle, supported }
}
