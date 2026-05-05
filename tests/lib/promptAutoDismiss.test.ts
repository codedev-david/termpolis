import { describe, it, expect } from 'vitest'
import { detectDismissChar, tailSlice } from '../../src/renderer/src/lib/promptAutoDismiss'

describe('promptAutoDismiss.detectDismissChar', () => {
  describe('folder trust', () => {
    it('dismisses Claude folder-trust with Enter', () => {
      const tail = 'Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('dismisses Codex folder-trust with "1" (Codex uses 1 = yes)', () => {
      const tail = 'Do you trust the files in this folder? Type 1 to trust'
      expect(detectDismissChar(tail, { agentName: 'OpenAI Codex' })).toBe('1\r')
    })

    it('catches "trust this folder" variant', () => {
      const tail = 'Trust this folder and its dependencies?'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('catches "do you trust the authors"', () => {
      const tail = 'Do you trust the authors of this workspace?'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })
  })

  describe('MCP server trust', () => {
    it('dismisses "enable these MCP servers" with Enter', () => {
      const tail = 'Do you want to enable these MCP servers for this session?\n1. Yes'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('dismisses "MCP servers are configured but not trusted"', () => {
      const tail = 'The following MCP servers are configured but not trusted:\n  termpolis'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('dismisses "Approve MCP server" variant', () => {
      const tail = 'Approve MCP server "termpolis"?'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('dismisses "Trust the MCP server" variant', () => {
      const tail = 'Trust the MCP server termpolis to execute tools?'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('dismisses "Enable MCP server" variant', () => {
      const tail = 'Enable MCP server termpolis for this session?'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })
  })

  describe('onboarding / "press enter to continue" splash', () => {
    it('dismisses "Press Enter to continue"', () => {
      const tail = 'Claude Code may make mistakes. Press Enter to continue.'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('dismisses "Press Return to proceed"', () => {
      const tail = 'Welcome! Press Return to proceed.'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('dismisses "press any key to continue"', () => {
      const tail = 'Setup complete. press any key to continue'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })
  })

  describe('generic Y/n prompts', () => {
    it('answers [Y/n] with y', () => {
      const tail = 'Install additional tools? [Y/n]'
      expect(detectDismissChar(tail, { agentName: 'Qwen Code' })).toBe('y\r')
    })

    it('answers (Y/n) with y', () => {
      const tail = 'Continue? (Y/n)'
      expect(detectDismissChar(tail, { agentName: 'Qwen Code' })).toBe('y\r')
    })
  })

  describe('Codex-specific', () => {
    it('answers "select an option" with 1', () => {
      const tail = 'Please select an option:\n1) Continue\n2) Exit'
      expect(detectDismissChar(tail, { agentName: 'OpenAI Codex' })).toBe('1\r')
    })

    it('answers "type 1 to" prompt with 1', () => {
      const tail = 'Type 1 to approve, 2 to deny'
      expect(detectDismissChar(tail, { agentName: 'OpenAI Codex' })).toBe('1\r')
    })

    it('does NOT apply Codex-only "select option" pattern to Claude', () => {
      const tail = 'Please select an option for exporting'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBeNull()
    })
  })

  describe('Gemini-specific', () => {
    it('answers "accept the terms" with Enter', () => {
      const tail = 'Please accept the terms of service to continue'
      expect(detectDismissChar(tail, { agentName: 'Gemini CLI' })).toBe('\r')
    })

    it('answers "authenticate with" prompt', () => {
      const tail = 'How would you like to authenticate with Google?'
      expect(detectDismissChar(tail, { agentName: 'Gemini CLI' })).toBe('\r')
    })
  })

  describe('no-match behavior', () => {
    it('returns null for empty tail', () => {
      expect(detectDismissChar('', { agentName: 'Claude Code' })).toBeNull()
    })

    it('returns null for random agent output', () => {
      const tail = 'Reading file src/main/index.ts...\nRunning tests...'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBeNull()
    })

    it('returns null for partial match that looks like a prompt but is not', () => {
      const tail = 'The user said "do you trust me" earlier, but...'
      // "do you trust the files" requires the specific suffix, this should miss
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBeNull()
    })
  })

  describe('priority / short-circuit', () => {
    it('folder-trust regex takes priority over later patterns', () => {
      const tail = 'Do you trust the files in this folder? Press Enter to continue.'
      // Both match, but folder-trust returns first
      expect(detectDismissChar(tail, { agentName: 'OpenAI Codex' })).toBe('1\r')
    })
  })

  describe('CRLF + ANSI normalization', () => {
    it('matches folder-trust through Windows CRLF line endings', () => {
      const tail = 'Do you trust the files in this folder?\r\n❯ 1. Yes, proceed\r\n  2. No, exit'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('matches folder-trust through ANSI color codes', () => {
      // Real Claude Code wraps the prompt in SGR escapes — without stripping
      // these, the regex misses the question entirely.
      const tail = '\x1b[33mDo you trust the files in this folder?\x1b[0m\n\x1b[32m❯ 1. Yes\x1b[0m'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('matches MCP trust through cursor-position escape sequences', () => {
      const tail = '\x1b[2J\x1b[H\x1b[1mEnable MCP server termpolis?\x1b[0m'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('matches "Use this MCP server" newer Claude Code wording', () => {
      const tail = 'Use this MCP server (termpolis) for the session?'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })
  })

  describe('newer Claude Code onboarding (fresh-install variants)', () => {
    it('matches "Would you like to trust"', () => {
      const tail = 'Would you like to trust this folder?'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('matches "Trust this workspace"', () => {
      const tail = 'Trust this workspace and run on it?'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('matches theme picker on fresh install', () => {
      const tail = 'Choose a color theme:\n❯ 1. Dark\n  2. Light'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('matches "select your style" theme picker', () => {
      const tail = 'Select your style:\n❯ Default'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('matches "How would you like to login"', () => {
      const tail = 'How would you like to login?\n❯ 1. Anthropic Console'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('matches arrow-indicator numbered menu via Claude-only fallback', () => {
      const tail = 'Pick an option below\n❯ 1. Continue\n  2. Exit'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('matches "press Enter to begin"', () => {
      const tail = 'All set! Press Enter to begin.'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })
  })
})

describe('promptAutoDismiss.tailSlice', () => {
  it('returns empty string for empty input', () => {
    expect(tailSlice('')).toBe('')
  })

  it('returns the whole string when shorter than the slice size', () => {
    expect(tailSlice('hello', 1500)).toBe('hello')
  })

  it('returns the last N chars when longer than size', () => {
    const big = 'x'.repeat(3000)
    expect(tailSlice(big, 500).length).toBe(500)
  })

  it('uses default size of 1500 when not provided', () => {
    const big = 'x'.repeat(2000)
    expect(tailSlice(big).length).toBe(1500)
  })
})
