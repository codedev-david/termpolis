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

// The bottom of each agent's screen, as the real sessions in tests/fixtures/agentScreens.json show it.
const CODEX_IDLE = ['', '› Ask Codex to do anything', '', '  gpt-5.6-sol medium · ~\\repos\\app']
const CODEX_BUSY = ['', '• Working (12s • esc to interrupt)', '', '', ...CODEX_IDLE.slice(1)]
const CLAUDE_IDLE = ['', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)']
const AGY_IDLE = ['', RULE, '> ', RULE, '  ? for shortcuts                                    Gemini 4 Argon · medium']

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
    // Gemini CLI names no Pro model: its message says "all Pro models" for any of them.
    ['Gemini CLI, a Pro model', 'Gemini', 'Usage limit reached for all Pro models.\nAccess resets at 5:00 PM.\n/stats model for usage details', 'usage limit reached (resets 5:00 PM)'],
    ['Gemini CLI, another model', 'Gemini', 'Usage limit reached for gemini-2.5-flash.\n/stats model for usage details', 'usage limit reached'],
    ['Claude Code, out of a model it has credits for', 'Claude', 'You\'ve reached your Fable limit. Switch to another model to continue.', 'usage limit reached'],
    ['Claude Code, a model that needs usage credits', 'Claude', 'Opus 5.5 requires usage credits. /model to switch models.', 'usage limit reached'],
    ['Claude Code, its spend limit, what to do on the row under it', 'Claude', 'You\'ve hit your monthly spend limit.\n/usage-credits to adjust your monthly spend limit.', 'usage limit reached'],
    ['Codex, a plan with nothing to upgrade to', 'Codex', 'You\'ve hit your usage limit. Try again at 3:04 PM.', 'usage limit reached (resets 3:04 PM)'],
    ['Codex, a business plan', 'Codex', 'You\'ve hit your usage limit. To get more access now, send a request to your admin or try again later.', 'usage limit reached'],
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

  it.each([
    ["Claude Code's plain limit, under the prompt it stopped", 'Claude', ['❯ Build the page', '  ⎿  You\'ve hit your limit · resets 3pm (America/New_York)', ...CLAUDE_IDLE], 'usage limit reached (resets 3pm (America/New_York))'],
    ["Codex's, on a row of its own", 'Codex', ['› Fix the login test', '', '■ You\'ve hit your usage limit for gpt-5.6-sol. Switch to another model now, or', 'try again at 4:15 PM.', ...CODEX_IDLE], 'usage limit reached (resets 4:15 PM)'],
    ["agy's quota", 'Gemini', ['> Write the docs', '', '✕ You have exhausted your quota on this model.', ...AGY_IDLE], 'usage limit reached'],
    // Gemini CLI's dialog (bundle/interactiveCli-*.js, ProQuotaDialog), in its round frame.
    ["Gemini CLI's dialog", 'Gemini', [
      '╭──────────────────────────────────────────────╮',
      '│                                              │',
      '│ Usage limit reached for gemini-2.5-pro.      │',
      '│ Access resets at 5:00 PM.                    │',
      '│ /stats model for usage details               │',
      '│ /model to switch models.                     │',
      '╰──────────────────────────────────────────────╯',
    ], 'usage limit reached (resets 5:00 PM)'],
    // Claude Code 2.1.302 (claude.exe, VWo): a model the account has run out of, under the answer it stopped.
    ['Claude Code\'s Fable limit', 'Claude', ['● I will start on the dashboard now.', '', '  ⎿  You\'ve reached your Fable limit. Switch to another model to continue.', ...CLAUDE_IDLE], 'usage limit reached'],
    ['Claude Code\'s model that needs usage credits', 'Claude', ['● I will start on the dashboard now.', '', '  ⎿  Opus requires usage credits. Switch to another model to continue.', ...CLAUDE_IDLE], 'usage limit reached'],
  ])('reads %s on its screen', (_name, agent, rows, summary) => {
    expect(onScreen(rows, agent)).toEqual({ status: 'blocked', summary })
  })

  // Gemini CLI 0.59.0's ProQuotaDialog as its bundle lays it out (interactiveCli-*.js): a round
  // frame with a padding of one, the message, a margin of one each side of the options. A Google
  // login gets a line and an option more: 15 rows, the limit line 14 rows up from its footer.
  function quotaDialog(model: string, googleLogin: boolean): string[] {
    const message = [`Usage limit reached for ${model}.`, 'Access resets at 5:00 PM.', '/stats model for usage details', '/model to switch models.', ...(googleLogin ? ['/auth to switch to API key.'] : [])]
    const options = ['● 1. Switch to gemini-2.5-flash', ...(googleLogin ? ['  2. Upgrade for higher limits'] : []), `  ${googleLogin ? 3 : 2}. Stop`]
    const inner = ['', ...message, '', '', ...options, '', '']
    return ['╭' + '─'.repeat(78) + '╮', ...inner.map((r) => '│ ' + r.padEnd(76) + ' │'), '╰' + '─'.repeat(78) + '╯']
  }
  it.each([
    ['an API key, a Flash model', 'gemini-2.5-flash', false, 13],
    ['an API key, a Pro model', 'all Pro models', false, 13],
    ['a Google login, a Flash model', 'gemini-2.5-flash', true, 15],
    ['a Google login, a Pro model', 'all Pro models', true, 15],
  ])("reads Gemini CLI's quota dialog for %s, however tall it is", (_name, model, googleLogin, height) => {
    const dialog = quotaDialog(model, googleLogin)
    expect(dialog).toHaveLength(height)
    const rows = [...dialog, '~\\repos\\app   no sandbox (see /docs)   gemini-2.5-pro (98% context left)']
    const screen = [...Array<string>(24 - rows.length).fill('some earlier output'), ...rows]
    expect(onScreen(screen, 'Gemini')).toEqual({ status: 'blocked', summary: 'usage limit reached (resets 5:00 PM)' })
  })

  it("reads Gemini CLI's dialog when it spans a wide screen", () => {
    const row = (s: string) => `│ ${s.padEnd(156)} │`
    const frame = ['╭' + '─'.repeat(158) + '╮', row(''), row('Usage limit reached for gemini-2.5-pro.'), row('Access resets at 5:00 PM.'),
      row('/stats model for usage details'), row('/model to switch models.'), '╰' + '─'.repeat(158) + '╯']
    const screen = screenOf(frame.map((r, i) => `${E}[${i + 1};1H${r}`).join(''), { cols: 160, rows: 40 })
    expect(detectAgentStatus(screen.lines().join('\n'), 'Gemini', 'working', { screen: true })).toEqual({ status: 'blocked', summary: 'usage limit reached (resets 5:00 PM)' })
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
    ['a sentence that starts like one and goes on', '  You\'ve hit your rate limit at 5,000 requests an hour; it now backs off.'],
    ['a log line that starts like Gemini CLI\'s', '    Usage limit reached for org-42.'],
  ])('%s', (_name, text) => {
    expect(isLimitOrMenu(detectAgentStatus(filler + text + '\n', 'Codex', 'working'))).toBe(false)
  })

  // What a worker shows while it works on a user's repo, above its input box (GitHub #36): its own
  // words, a diff, docs, a log, grep hits, a message bridged from another worker. None of it is the
  // CLI stopping, and each read as blocked, which told the conductor to give a healthy worker's
  // task away, and kept write_to_terminal's submit from typing into it.
  it.each([
    ['Codex describing its work', 'Codex', ['• I added the banner. It now reads You\'ve hit your monthly limit when the', '  account is over quota, and links to the billing page.'], CODEX_IDLE],
    ['a diff of JSX while Codex works', 'Codex', ['• Edited src/components/QuotaBanner.tsx (+3 -1)', '    12 -      <p>Limit reached</p>', '    12 +      <p>You\'ve hit your monthly limit</p>'], CODEX_BUSY],
    ['the same diff, the turn done', 'Codex', ['• Edited src/components/QuotaBanner.tsx (+3 -1)', '    12 +      <p>You\'ve hit your monthly limit</p>', '', '• Done: the banner shows when the account is over quota.'], CODEX_IDLE],
    ['markdown docs', 'Codex', ['• Updated docs/billing.md:', '  ## Limits', '  - Free plan: You\'ve hit your free plan limit after 100 requests.'], CODEX_IDLE],
    ['YAML strings', 'Codex', ['• Added locales/en.yml:', '    limit_reached: You\'ve hit your daily budget', '    limit_reset: Your limit resets at midnight'], CODEX_IDLE],
    ['a log tail', 'Codex', ['• Ran tail -n 3 logs/api.log', '  └ 2026-10-16T12:00:01Z WARN Usage limit reached for org-42.', '    2026-10-16T12:00:02Z INFO retry scheduled'], CODEX_IDLE],
    ['grep output', 'Codex', ['• Ran rg -n "hit your" src', '  └ src/quota.ts:12:   message: You\'ve hit your weekly limit · resets Monday'], CODEX_IDLE],
    ['Claude describing its work', 'Claude', ['● The banner component now tells the user You\'ve hit your monthly limit and', '  offers an upgrade link. Tests pass.'], CLAUDE_IDLE],
    ['a Claude worker reading a message bridged from Codex', 'Claude', ['● termpolis - swarm_read_messages (MCP)(terminalId: "t-9")', '  ⎿  [{"from":"Codex","content":"[Codex] You\'ve hit your usage limit. Upgrade', '     to Plus to continue using Codex"}]'], CLAUDE_IDLE],
    ['agy describing its work', 'Gemini', ['✦ The FAQ now answers: You have exhausted your quota on this model.'], AGY_IDLE],
    ['an answer about a rate limit', 'Claude', ['● The sync script stops because you\'ve hit your rate limit on the GitHub API.', '  You\'ve hit your rate limit at 5,000 requests an hour; it now backs off.'], CLAUDE_IDLE],
    ['a log line in tool output', 'Claude', ['● Bash(tail -1 logs/api.log)', '  ⎿  12:00:01 WARN You\'ve hit your usage limit for key ending 42a', '● The API key in the log is over its quota.'], CLAUDE_IDLE],
    ['an answer about an expired session', 'Claude', ['● The login fails because the session has expired before the refresh token', '  is used. I moved the refresh ahead of the request.'], CLAUDE_IDLE],
    ['an answer asking to authenticate', 'Claude', ['● The deploy step needs credentials. Please authenticate with the staging', '  registry first (docker login), then rerun npm run deploy.'], CLAUDE_IDLE],
    ['Codex history about a restart', 'Codex', ['• Updated README.md: after editing config.toml, restart the agent to apply it.'], CODEX_IDLE],
    // Claude Code 2.1.302: fast mode turns itself off and the session goes on.
    ["Claude Code's notice that fast mode ran out", 'Claude', ['● OK'], [...CLAUDE_IDLE, '  You\'ve hit your fast limit · resets in 4h 59m']],
    // A row a worker's answer or a file starts with a mark of its own: a list, a table.
    ['a markdown list in a file Codex shows', 'Codex', ['• Ran cat docs/errors.md', '  └ * You\'ve hit your usage limit. Upgrade to continue.', '    * Your workspace is out of credits.'], CODEX_IDLE],
    ['a list in an answer', 'Claude', ['● The messages it can show:', '', '  * You\'ve hit your usage limit. Wait for the reset.', '  · You have exhausted your quota on this model.'], CLAUDE_IDLE],
    ['a table in an answer', 'Claude', ['● The messages, by CLI:', '  │ You\'ve hit your usage limit. │ Codex │', '  │ You have exhausted your quota on this model. │ agy │'], CLAUDE_IDLE],
    // A row of an answer or a file that starts with a limit's own words, which the three agents
    // indent. Each closed a healthy worker: the conductor is told to close a blocked one.
    ['the copy a Claude worker wrote, quoted on a row of its own', 'Claude', ['● I changed the quota banner. It now reads:', '', '  You\'ve hit your monthly limit.', '', '  and links to the billing page. Tests pass.'], CLAUDE_IDLE],
    ['the copy a Codex worker wrote, quoted on a row of its own', 'Codex', ['• Updated the quota banner. It now reads:', '', '  You\'ve hit your monthly limit.', '', '  Tests pass.'], CODEX_IDLE],
    ['a Codex answer whose wrapped row starts with the words', 'Codex', ['• I added the banner for users on the free plan. When they run out it says', '  You\'ve hit your weekly limit. Upgrade to Plus, and the CTA opens billing.'], CODEX_IDLE],
    ['a doc Codex printed', 'Codex', ['• Ran sed -n 1,20p docs/LIMITS.md', '  └ ## When the quota runs out', '    You\'re out of usage credits. The app shows this when the org balance is 0.', '', '• Documented the behaviour.'], CODEX_IDLE],
    ['a file of copy Codex printed', 'Codex', ['• Ran cat src/copy/limits.txt', '  └ You\'ve hit your usage limit.', '    Upgrade to keep going.', '', '• The banner copy is in place and the test passes.'], CODEX_IDLE],
    ["a Claude answer quoting Codex's message whole", 'Claude', ['● The Codex worker stopped with this message:', '', '  You\'ve hit your usage limit. Upgrade to Plus to continue using Codex', '  (https://chatgpt.com/explore/plus), or try again at 3:04 PM.', '', '  I added a retry for it in src/quota.ts.'], CLAUDE_IDLE],
    ['a Claude answer listing the banner it wrote', 'Claude', ['● Done. The quota banner now shows, on its own line:', '', '  You\'ve hit your weekly limit · resets Monday 9:00', '', '  and the tests cover it.'], CLAUDE_IDLE],
    ["an agy answer quoting agy's message", 'Gemini', ['> Explain the quota error in the logs', '', '  The log shows the CLI stopped with:', '', '  You have exhausted your quota on this model.', '', '  It resets daily.'], AGY_IDLE],
    // Under Claude Code's own ⎿, a tool's output: what it showed is history once the answer follows.
    ['a file of copy Claude printed, its answer under it', 'Claude', ['● Bash(cat src/copy/limits.txt)', '  ⎿  You\'ve hit your usage limit.', '     Upgrade to keep going.', '', '● The banner copy is in place and the test passes.'], CLAUDE_IDLE],
    ["a log Claude printed, Codex's words exactly, its answer under it", 'Claude', ['● Bash(type logs\\codex-worker.log)', '  ⎿  You\'ve hit your usage limit. Upgrade to Plus to continue using Codex', '     (https://chatgpt.com/explore/plus), or try again at 3:04 PM.', '', '● The worker log shows a quota stop at 3:04 PM.'], CLAUDE_IDLE],
  ])('%s', (_name, agent, transcript, bottom) => {
    expect(onScreen([...transcript, ...bottom], agent).status).not.toBe('blocked')
  })

  it('the conductor\'s own prompt, rule on limits and all', () => {
    const prompt = buildConductorPrompt({ taskDescription: 'Ship it', installedAgents: { claude: true, codex: true, gemini: true }, projectCwd: '/p' })
    expect(prompt).toContain('blocked by a usage limit')
    expect(prompt).toContain('waiting on a menu')
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

// A CLI's limit message is the last thing it shows: its turn stops there. In the transcript, one
// with an answer, a tool call or a prompt after it is history, and one the agent works on past is
// a tool's output (GitHub #36).
describe('a limit is what the agent shows last', () => {
  it("reads a log with Codex's words that Claude works on past as work, not as a limit", () => {
    const rows = ['● Bash(type logs\\codex-worker.log)', '  ⎿  You\'ve hit your usage limit. Upgrade to Plus to continue using Codex', '', '✢ Thinking…', RULE, '❯ ', RULE, '  esc to interrupt']
    expect(onScreen(rows, 'Claude', '◐ Claude Code').status).toBe('working')
  })

  it('reads a limit the worker went on from as history: it switched model and carried on', () => {
    const rows = ['› Fix the login test', '', '■ You\'ve hit your usage limit for gpt-5.6-sol. Switch to another model now, or', 'try again at 4:15 PM.', '', '› Go on with gpt-5.6-luna', '', '• Fixed the test; it passes now.', ...CODEX_IDLE]
    expect(onScreen(rows).status).toBe('idle')
  })

  it('reads the same limit again under a prompt sent after it', () => {
    const rows = ['❯ Build the page', '  ⎿  You\'ve hit your session limit · resets 3pm (America/New_York)', '', '❯ Try again', '  ⎿  You\'ve hit your session limit · resets 3pm (America/New_York)', ...CLAUDE_IDLE]
    expect(onScreen(rows, 'Claude')).toEqual({ status: 'blocked', summary: 'usage limit reached (resets 3pm (America/New_York))' })
  })

  it("reads a limit under Claude Code's input box, where every row is the CLI's own, indent and all", () => {
    const rows = ['● OK', ...CLAUDE_IDLE, '          You\'ve hit your weekly limit · resets 4pm (America/New_York)']
    expect(onScreen(rows, 'Claude')).toEqual({ status: 'blocked', summary: 'usage limit reached (resets 4pm (America/New_York))' })
  })
})
