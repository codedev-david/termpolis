import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useVoiceInput } from '../../src/renderer/src/hooks/useVoiceInput'

// Mock SpeechRecognition
class MockSpeechRecognition {
  lang = ''
  interimResults = false
  continuous = false
  maxAlternatives = 1
  onstart: (() => void) | null = null
  onresult: ((e: any) => void) | null = null
  onerror: ((e: any) => void) | null = null
  onend: (() => void) | null = null

  start() {
    this.onstart?.()
  }
  stop() {
    this.onend?.()
  }
  abort() {
    this.onend?.()
  }
}

describe('useVoiceInput', () => {
  beforeEach(() => {
    ;(window as any).webkitSpeechRecognition = MockSpeechRecognition
  })

  afterEach(() => {
    delete (window as any).webkitSpeechRecognition
    delete (window as any).SpeechRecognition
  })

  it('reports supported when SpeechRecognition is available', () => {
    const { result } = renderHook(() => useVoiceInput())
    expect(result.current.supported).toBe(true)
  })

  it('reports not supported when SpeechRecognition is missing', () => {
    delete (window as any).webkitSpeechRecognition
    const { result } = renderHook(() => useVoiceInput())
    expect(result.current.supported).toBe(false)
  })

  it('starts not listening', () => {
    const { result } = renderHook(() => useVoiceInput())
    expect(result.current.isListening).toBe(false)
    expect(result.current.transcript).toBe('')
    expect(result.current.error).toBeNull()
  })

  it('sets isListening to true when started', () => {
    const { result } = renderHook(() => useVoiceInput())
    act(() => result.current.start())
    expect(result.current.isListening).toBe(true)
  })

  it('sets isListening to false when stopped', () => {
    const { result } = renderHook(() => useVoiceInput())
    act(() => result.current.start())
    expect(result.current.isListening).toBe(true)
    act(() => result.current.stop())
    expect(result.current.isListening).toBe(false)
  })

  it('toggle starts and stops', () => {
    const { result } = renderHook(() => useVoiceInput())
    act(() => result.current.toggle())
    expect(result.current.isListening).toBe(true)
    act(() => result.current.toggle())
    expect(result.current.isListening).toBe(false)
  })

  it('sets error when not supported and start is called', () => {
    delete (window as any).webkitSpeechRecognition
    const { result } = renderHook(() => useVoiceInput())
    act(() => result.current.start())
    expect(result.current.error).toContain('not supported')
    expect(result.current.isListening).toBe(false)
  })

  it('sets error message on recognition error', () => {
    let instance: MockSpeechRecognition | null = null
    ;(window as any).webkitSpeechRecognition = class extends MockSpeechRecognition {
      constructor() {
        super()
        instance = this
      }
    }

    const { result } = renderHook(() => useVoiceInput())
    act(() => result.current.start())

    act(() => {
      instance!.onerror?.({ error: 'network' })
    })

    expect(result.current.error).toContain('network')
    expect(result.current.isListening).toBe(false)
  })

  it('sets friendly error for denied mic access', () => {
    let instance: MockSpeechRecognition | null = null
    ;(window as any).webkitSpeechRecognition = class extends MockSpeechRecognition {
      constructor() {
        super()
        instance = this
      }
    }

    const { result } = renderHook(() => useVoiceInput())
    act(() => result.current.start())

    act(() => {
      instance!.onerror?.({ error: 'not-allowed' })
    })

    expect(result.current.error).toContain('Microphone access denied')
  })

  it('calls onResult with final transcript', () => {
    let instance: MockSpeechRecognition | null = null
    ;(window as any).webkitSpeechRecognition = class extends MockSpeechRecognition {
      constructor() {
        super()
        instance = this
      }
    }

    const onResult = vi.fn()
    const { result } = renderHook(() => useVoiceInput(onResult))
    act(() => result.current.start())

    act(() => {
      instance!.onresult?.({
        results: [{ 0: { transcript: 'hello world' }, isFinal: true, length: 1 }],
        length: 1,
      })
    })

    expect(onResult).toHaveBeenCalledWith('hello world')
    expect(result.current.transcript).toBe('hello world')
  })

  it('shows interim transcript without calling onResult', () => {
    let instance: MockSpeechRecognition | null = null
    ;(window as any).webkitSpeechRecognition = class extends MockSpeechRecognition {
      constructor() {
        super()
        instance = this
      }
    }

    const onResult = vi.fn()
    const { result } = renderHook(() => useVoiceInput(onResult))
    act(() => result.current.start())

    act(() => {
      instance!.onresult?.({
        results: [{ 0: { transcript: 'hel' }, isFinal: false, length: 1 }],
        length: 1,
      })
    })

    expect(result.current.transcript).toBe('hel')
    expect(onResult).not.toHaveBeenCalled()
  })
})

// Store tests
vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-uuid-voice') }))

import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'

describe('terminalStore voiceEnabled', () => {
  const initialState = useTerminalStore.getState()

  beforeEach(() => {
    useTerminalStore.setState({ ...initialState }, true)
  })

  it('defaults to false', () => {
    expect(useTerminalStore.getState().voiceEnabled).toBe(false)
  })

  it('setVoiceEnabled toggles the value', () => {
    useTerminalStore.getState().setVoiceEnabled(true)
    expect(useTerminalStore.getState().voiceEnabled).toBe(true)
    useTerminalStore.getState().setVoiceEnabled(false)
    expect(useTerminalStore.getState().voiceEnabled).toBe(false)
  })
})
