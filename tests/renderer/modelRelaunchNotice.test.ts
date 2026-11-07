// What a model change tells the user once it has run (lib/modelRelaunchNotice.ts), for the header's
// Model… menu and the usage-limit card's model row alike: one line, and whether the menu has to go
// back to the model that is still running.
import { describe, it, expect } from 'vitest'
import { relaunchNotice } from '../../src/renderer/src/lib/modelRelaunchNotice'
import type { RelaunchOutcome } from '../../src/renderer/src/lib/modelRelaunch'

const CLAUDE = { provider: 'claude' as const, label: 'Claude', target: 'Sonnet', agentCommand: 'claude --dangerously-skip-permissions' }
const LOST = /It was started with options Termpolis cannot repeat safely \(quotes, operators or a prompt\), so it came back with its defaults\.$/

describe('relaunchNotice', () => {
  it('says nothing about a clean relaunch, and leaves the menu on the new model', () => {
    expect(relaunchNotice('relaunched', CLAUDE)).toEqual({ text: null, reverted: false })
  })

  it('warns when the relaunch had to leave an option out, and still leaves the menu on the new model', () => {
    const r = relaunchNotice('relaunched', { ...CLAUDE, agentCommand: 'claude --append-system-prompt "be brief"' })
    expect(r.text).toMatch(/^⚠️ Claude restarted on Sonnet\./)
    expect(r.text).toMatch(LOST)
    expect(r.reverted).toBe(false)
  })

  it('says a session that had nothing to resume started a new one', () => {
    expect(relaunchNotice('started-new', CLAUDE)).toEqual({ text: 'ℹ️ Claude had nothing to resume, so it started a new session on Sonnet.', reverted: false })
    expect(relaunchNotice('started-new', { ...CLAUDE, agentCommand: 'claude /review' }).text).toMatch(LOST)
  })

  it('says it could not tell which conversation to resume, and that the earlier one is still saved', () => {
    const r = relaunchNotice('started-unsure', { provider: 'gemini', label: 'Gemini', target: 'Gemini 3.8 Flash (High)', agentCommand: 'agy' })
    expect(r.text).toBe('ℹ️ Termpolis could not tell which Gemini conversation to resume, so it started a new session on Gemini 3.8 Flash (High). If there was an earlier conversation, it is still saved.')
    expect(r.reverted).toBe(false)
    expect(relaunchNotice('started-unsure', { ...CLAUDE, agentCommand: 'claude "hi"' }).text).toMatch(LOST)
  })

  it('says only what it knows when a resume left nothing running', () => {
    expect(relaunchNotice('started-fresh', CLAUDE)).toEqual({ text: 'ℹ️ Claude was not running after the resume, so Termpolis started a new session on Sonnet.', reverted: false })
    expect(relaunchNotice('started-fresh', { ...CLAUDE, agentCommand: 'claude $(date)' }).text).toMatch(LOST)
  })

  it('names the wrapper that was not restarted, and puts the menu back', () => {
    const r = relaunchNotice('unsupported', { ...CLAUDE, agentCommand: 'claude-sandbox --strict' })
    expect(r.text).toBe('⚠️ This Claude terminal was started with "claude-sandbox", not plain claude, so Termpolis did not restart it: the bare agent would not run the way "claude-sandbox" does. Open a new terminal on Sonnet instead.')
    expect(r.reverted).toBe(true)
    // With no command to name, the agent's own name stands in, and the bare binary is Codex's.
    expect(relaunchNotice('unsupported', { provider: 'codex', label: 'OpenAI Codex', target: 'GPT-5.6 Sol', agentCommand: undefined }).text)
      .toMatch(/This OpenAI Codex terminal was started with "OpenAI Codex", not plain codex/)
  })

  it('says the agent would not quit in time, that nothing more was typed, and puts the menu back', () => {
    const r = relaunchNotice('still-running', CLAUDE)
    expect(r.text).toMatch(/^⚠️ Claude had not quit after 30 s, so Termpolis left it alone: it pressed Ctrl\+C three times and typed nothing else\./)
    expect(r.text).toMatch(/If it is still running, it is on its previous model; if it is at a prompt, start Claude again\.$/)
    expect(r.reverted).toBe(true)
  })

  it('says so for a model the agent does not offer (nothing was sent), and puts the menu back', () => {
    expect(relaunchNotice('invalid', CLAUDE)).toEqual({ text: '⚠️ Claude does not offer Sonnet, so Termpolis changed nothing.', reverted: true })
  })

  it('always says why when it puts the menu back', () => {
    for (const outcome of ['unsupported', 'still-running', 'invalid'] as const) {
      const r = relaunchNotice(outcome, CLAUDE)
      expect(r.reverted).toBe(true)
      expect(typeof r.text).toBe('string')
    }
  })

  it('has a verdict for every outcome there is', () => {
    const all: RelaunchOutcome[] = ['relaunched', 'started-new', 'started-unsure', 'started-fresh', 'invalid', 'unsupported', 'still-running']
    for (const outcome of all) expect(typeof relaunchNotice(outcome, CLAUDE).reverted).toBe('boolean')
  })
})
