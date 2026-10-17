import { describe, it, expect } from 'vitest'
import { detectAgentStatus, isLimitOrMenu } from '../../src/shared/agentStatusDetector'
import { screenOf } from '../../src/shared/terminalScreen'
import { buildConductorPrompt } from '../../src/renderer/src/lib/conductorPrompt'
import fixtures from '../fixtures/agentScreens.json'

// GitHub #36 item 5: a worker its plan's usage limit stopped, or one waiting on a menu, reads as
// blocked, with a summary. The phrases are the CLIs' own (sources in agentStatusDetector.ts).

const E = '\x1b'
const RULE = '─'.repeat(80)
const filler = 'some earlier output\n'.repeat(5)

/** A screen as the agent draws it at 80x24: rows at their positions, ConPTY style. */
function drawn(rows: string[]): string {
  return `${E}[H${E}[2J` + rows.map((r, i) => `${E}[${i + 1};1H${r.replace(/ /g, `${E}[1C`)}`).join('')
}
function onScreen(rows: string[], agent = 'Codex', title = '') {
  const screen = screenOf(drawn(rows))
  return detectAgentStatus(screen.lines().join('\n'), agent, 'working', { screen: true, title })
}

describe('usage limits, in the CLIs\' own words', () => {
  it.each([
    ['Claude Code, a session limit', 'Claude', '  ⎿  You\'ve hit your session limit · resets 3pm (America/New_York)', 'usage limit reached (resets 3pm (America/New_York))'],
    ['Claude Code, the weekly limit, with its progress note', 'Claude', 'You\'ve hit your weekly limit · resets Oct 20, 9am (Europe/Berlin) · progress saved', 'usage limit reached (resets Oct 20, 9am (Europe/Berlin))'],
    ['Claude Code, a model\'s limit', 'Claude', 'You\'ve hit your Opus limit · resets at 5pm (UTC)', 'usage limit reached (resets 5pm (UTC))'],
    ['Claude Code, a team budget', 'Claude', 'You\'ve hit your team\'s shared budget. /model to switch models.', 'usage limit reached'],
    ['Claude Code, its status line while it waits', 'Claude', '✻ Usage limit reached · continuing automatically at 3pm · esc to cancel', 'usage limit reached'],
    ['Claude Code, out of usage credits', 'Claude', 'You\'re out of usage credits. /model to switch models.', 'usage limit reached'],
    ['Claude Code, an organization out of usage', 'Claude', 'Your org is out of usage · contact your admin', 'usage limit reached'],
    ['Codex, its plan', 'Codex', '■ You\'ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:04 PM.', 'usage limit reached (resets 3:04 PM)'],
    ['Codex, a date later on', 'Codex', 'You\'ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 17th, 2026 3:04 PM.', 'usage limit reached (resets Oct 17th, 2026 3:04 PM)'],
    ['Codex, a model\'s limit', 'Codex', 'You\'ve hit your usage limit for gpt-5.6-sol. Switch to another model now, or try again at 4:15 PM.', 'usage limit reached (resets 4:15 PM)'],
    ['Codex, a workspace out of credits', 'Codex', 'Your workspace is out of credits. Ask your workspace owner to refill in order to continue.', 'usage limit reached'],
    ['Codex, a workspace spend cap', 'Codex', 'You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.', 'usage limit reached'],
    ['Codex, its owner nudge', 'Codex', 'Request a limit increase from your owner to continue using codex. Request increase?', 'usage limit reached'],
    ['agy, its quota', 'Gemini', 'You have exhausted your quota on this model.', 'usage limit reached'],
    ['agy, its AI credits', 'Gemini', 'Your AI credits balance is too low to continue.', 'usage limit reached'],
    ['Gemini CLI', 'Gemini', 'Usage limit reached for gemini-3-pro.\nAccess resets at 5:00 PM.\n/stats model for usage details', 'usage limit reached (resets 5:00 PM)'],
  ])('%s', (_name, agent, message, summary) => {
    const result = detectAgentStatus(filler + message + '\n', agent, 'working')
    expect(result).toEqual({ status: 'blocked', summary })
    expect(isLimitOrMenu(result)).toBe(true)
  })

  it('reads a limit on a screen, Codex\'s wrapped over two rows, and still finds when it resets', () => {
    const rows = [
      '› Build the page. Task ID: t1',
      '■ You\'ve hit your usage limit. Upgrade to Plus to continue using Codex',
      '(https://chatgpt.com/explore/plus), or try again at 3:04',
      'PM.',
      '',
      '› Ask Codex to do anything',
      '  gpt-5.6-sol medium · ~/project',
    ]
    expect(onScreen(rows)).toEqual({ status: 'blocked', summary: 'usage limit reached (resets 3:04 PM)' })
  })

  it('reads a limit as blocked though its line says "esc to cancel": a busy screen it is not', () => {
    const rows = ['● Working on it', '✻ Usage limit reached · continuing automatically at 3pm · esc to cancel', RULE, '❯ ', RULE]
    expect(onScreen(rows, 'Claude', '✳ Claude Code').status).toBe('blocked')
  })

  it('reports the latest limit when there are two', () => {
    const text = 'You\'ve hit your session limit · resets 3pm (America/New_York)\n...\nYou\'ve hit your usage limit. Upgrade to Plus to continue using Codex, or try again at 9:00 PM.\n'
    expect(detectAgentStatus(text, 'Codex').summary).toBe('usage limit reached (resets 9:00 PM)')
  })
})

describe('menus that hold a worker', () => {
  it('Codex asking whether to switch to a cheaper model', () => {
    const rows = [
      '  Approaching rate limits',
      '  Switch to gpt-5.6-luna for lower credit usage?',
      '',
      '› 1. Switch to gpt-5.6-luna   Uses fewer credits for upcoming turns.',
      '  2. Keep current model',
      '  3. Keep current model (never show again)   Hide future rate limit reminders about switching models.',
    ]
    const result = onScreen(rows)
    expect(result).toEqual({ status: 'blocked', summary: 'waiting on a menu: Codex asks whether to switch to a model that uses fewer credits' })
    expect(isLimitOrMenu(result)).toBe(true)
  })

  it('Codex offering to update itself, as a real session showed it', () => {
    const screen = screenOf(fixtures.codex.updateMenu)
    const result = detectAgentStatus(screen.lines().join('\n'), 'Codex', 'starting', { screen: true, title: screen.title })
    expect(result).toEqual({ status: 'blocked', summary: 'waiting on a menu: Codex offers to update itself' })
  })

  it('a blocked agent that needs a restart is blocked, but no limit or menu', () => {
    const result = detectAgentStatus(filler + 'Update ran successfully! Please restart Codex.\n', 'Codex')
    expect(result.status).toBe('blocked')
    expect(isLimitOrMenu(result)).toBe(false)
    expect(isLimitOrMenu({ status: 'idle', summary: 'usage limit reached' })).toBe(false)
  })
})

describe('what is no usage limit', () => {
  it.each([
    ['Claude Code\'s own warning that a limit is near', 'You\'ve used 82% of your weekly limit · resets 4pm (America/New_York)'],
    ['Codex\'s warning that a limit is near', 'Heads up, you have less than 10% of your 5h limit left. Run /status for a breakdown.'],
    ['Codex offering a cheaper model near a limit, as a hint, not its menu', 'Approaching rate limits: consider /model'],
    ['an HTTP 429 in a log', '[warn] 2026-10-16T21:04:11Z POST /v1/messages 429 rate_limit_error, retrying in 4s'],
    ['prose that mentions limits', 'If you\'ve hit your usage limit, wait for the reset. The rate limit is 50 req/min and the usage limit reached its peak.'],
    ['a phrase quoted in code', 'throw new Error("You\'ve hit your usage limit. Upgrade to Plus")'],
    ['a phrase quoted in a test', "expect(msg).toBe('You have exhausted your quota on this model.')"],
    ['a phrase in backticks', 'Codex prints `Your workspace is out of credits.` when that happens'],
    ['a sentence that only starts like one', 'You\'ve hit your stride. Usage limit reached? No, not yet.'],
    ['an agent describing the limits', 'The weekly limit resets on Monday; the session limit resets every 5 hours.'],
    ['code that counts usage', 'if (usage >= limit) { console.log("usage limit reached for", user) }'],
    ['the update notice once Codex updated', '🎉 Update ran successfully! Please restart Codex.'],
  ])('%s', (_name, text) => {
    expect(isLimitOrMenu(detectAgentStatus(filler + text + '\n', 'Codex', 'working'))).toBe(false)
  })

  it('the conductor\'s own prompt, rule on limits and all', () => {
    const prompt = buildConductorPrompt({ taskDescription: 'Ship it', installedAgents: { claude: true, codex: true, gemini: true }, projectCwd: '/p' })
    expect(prompt).toContain('usage limit reached, or waiting on a menu')
    for (let at = 0; at < prompt.length; at += 1000) {
      expect(isLimitOrMenu(detectAgentStatus(prompt.slice(at, at + 1500), 'Claude', 'working'))).toBe(false)
    }
  })

  it('a real Claude Code screen whose footer warns of the weekly limit: at its prompt, idle', () => {
    const screen = screenOf(fixtures.claude.usageWarning)
    expect(screen.lines().join('\n')).toContain('You\'ve used 82% of your weekly limit · resets 4pm (America/New_York)')
    expect(detectAgentStatus(screen.lines().join('\n'), 'Claude', 'working', { screen: true, title: screen.title }).status).toBe('idle')
  })

  it('a limit far up the screen, above the bottom rows, is history', () => {
    const rows = ['You\'ve hit your session limit · resets 3pm (America/New_York)', ...Array.from({ length: 14 }, (_, i) => `later line ${i}`), RULE, '❯ ', RULE]
    expect(onScreen(rows, 'Claude').status).toBe('idle')
  })
})
