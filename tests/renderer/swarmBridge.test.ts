import { describe, it, expect } from 'vitest'
import { detectSwarmSignals, formatIncomingMessage } from '../../src/renderer/src/lib/swarmBridge'

describe('swarmBridge', () => {
  describe('detectSwarmSignals', () => {
    it('detects a result signal from completion keywords', () => {
      const output = 'x'.repeat(30) + 'Task is done and complete.'
      const result = detectSwarmSignals(output, 0)
      expect(result.type).toBe('result')
    })

    it('detects a question signal from trailing question mark', () => {
      const output = 'x'.repeat(30) + 'Should I proceed with the refactor?'
      const result = detectSwarmSignals(output, 0)
      expect(result.type).toBe('question')
    })

    it('detects an error signal from error keywords', () => {
      const output = 'x'.repeat(30) + 'Build failed with 3 errors'
      const result = detectSwarmSignals(output, 0)
      expect(result.type).toBe('error')
    })

    it('returns null type for short new content (<20 chars)', () => {
      const result = detectSwarmSignals('short', 0)
      expect(result.type).toBeNull()
    })

    it('returns null type when no patterns match', () => {
      // Content >= 20 chars but no keywords and < 200 chars for info
      const output = 'just some normal logging output here with nothing special'
      const result = detectSwarmSignals(output, 0)
      expect(result.type).toBeNull()
    })

    it('advances the offset past consumed content', () => {
      const output = 'first part' + 'x'.repeat(30) + ' all done successfully'
      const result = detectSwarmSignals(output, 0)
      expect(result.newOffset).toBe(output.length)
    })

    it('only reads from the lastOffset position', () => {
      // Put "error" in the already-read portion, clean text in the new portion
      const alreadyRead = 'error happened here before'
      const newContent = 'x'.repeat(30) + ' everything is fine now, no issues'
      const output = alreadyRead + newContent
      const result = detectSwarmSignals(output, alreadyRead.length)
      // Should not detect error since it's before the offset
      expect(result.type).not.toBe('error')
    })

    it('returns content snippet from the detected portion', () => {
      const output = 'x'.repeat(30) + ' all tests pass'
      const result = detectSwarmSignals(output, 0)
      expect(result.content.length).toBeGreaterThan(0)
      expect(result.content).toContain('all tests pass')
    })

    it('returns info type for substantial output with no specific signals', () => {
      const output = 'a'.repeat(250) // 250 chars of content, no keywords
      const result = detectSwarmSignals(output, 0)
      expect(result.type).toBe('info')
    })
  })

  describe('formatIncomingMessage', () => {
    it('formats a message with sender name and content', () => {
      const msg = formatIncomingMessage('Claude', 'Task is complete')
      expect(msg).toContain('Message from Claude')
      expect(msg).toContain('Task is complete')
      expect(msg).toContain('End message')
    })
  })
})
