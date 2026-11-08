/**
 * The usage-limit chooser and the in-place account switch, for the three agents Termpolis runs
 * (design section 14.2): Claude Code, Codex, and the Antigravity CLI (agy, Termpolis's Gemini CLI).
 *
 * Never a real agent. e2e/mocks/mock-agents.cjs stands in for all three, first on PATH through
 * e2e/test-shims-chooser. It draws the layouts the real captures show, hits a usage limit when a
 * prompt asks it to, prints its exit hint as it goes, resumes the session it is told to, and logs
 * everything it is given to <home>/.mock-log.jsonl, which the cases read. The same mock runs on a
 * real PTY in each real shell this machine has in tests/electron/accountsChooserE2eMock.test.ts,
 * under the REAL switch engine and the REAL usage-limit look, so what these cases rely on is
 * proven where an Electron app can't run (local Electron is stale; this spec runs in CI only).
 *
 * Everything lives in a scratch home (TERMPOLIS_TEST_AGENT_HOME, MOCK_AGENTS_HOME): a default
 * profile and a second one for each agent, each signed in by the email its `.claude.json` or
 * `.mock-login` names, never by a sign-in file, and the registry Termpolis starts with. The mock
 * acts only in a folder holding a `.mock-agent-home` marker. Each group below opens its own app on
 * its own scratch home, so the usage limits one group records never reach another.
 *
 * Not here: policy "next" (design case 6) is not in this release, and the account UI's own
 * sign-in is e2e/accounts-ui.spec.ts's.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import fs from 'fs'
import http from 'http'
import path from 'path'
import { dismissOnboarding, e2eLaunchArgs, e2eUserDataDir, ensureE2eBuild, quitApp } from './helpers/launch'
import {
  ACCOUNT_IDS, EMAILS, chooserShimEnv, makeChooserHome, readMockLog, readRegistry, removeChooserHome, seedRegistry, setClaudeSignIn, setMockControl, unlinkDir,
} from './helpers/chooserFixture'
import type { ChooserHome, MockEvent } from './helpers/chooserFixture'

type Agent = 'claude' | 'codex' | 'agy'

interface World {
  app: ElectronApplication
  page: Page
  home: ChooserHome
  userData: string
}

const LAUNCH_TITLE: Record<Agent, string> = { claude: 'Launch Claude Code', codex: 'Launch OpenAI Codex', agy: 'Launch Gemini' }
/** A row of each mock's box footer: the agent has drawn its box and can be typed to. */
const BOX_FOOTER: Record<Agent, string> = { claude: 'bypass permissions on', codex: 'gpt-5.6-sol medium', agy: '? for shortcuts' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** What a held terminal says to an MCP client (src/shared/accountSwitch.ts RELAUNCH_HELD.account). */
const HELD_WORDS = 'Termpolis is switching this agent\'s account'

test.beforeAll(() => {
  ensureE2eBuild()
})

// ── The app and its scratch world ─────────────────────────────────────────────────────────

/** The app on a fresh scratch home and registry. `prepare` changes the world before it opens. */
async function openWorld(label: string, prepare: (home: ChooserHome) => void = () => undefined): Promise<World> {
  const home = makeChooserHome()
  prepare(home)
  const userData = e2eUserDataDir(label)
  seedRegistry(userData, home)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    // A developer's own profile variables must not reach the app or its terminals.
    if (typeof v === 'string' && !/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|AGY|TERMPOLIS_LIMIT)/i.test(k)) env[k] = v
  }
  const app = await electron.launch({
    args: e2eLaunchArgs(label),
    env: {
      ...env,
      NODE_ENV: 'test',
      TERMPOLIS_TEST_AGENT_HOME: home.home,
      TERMPOLIS_TEST_PROJECT_CWD: home.project,
      // The hidden sign-in session drops every TERMPOLIS_ variable: the mock finds its home here.
      MOCK_AGENTS_HOME: home.home,
      MOCK_AGY_NEW_EMAIL: EMAILS.agyTwo,
      ...chooserShimEnv(),
    },
  })
  const page = await app.firstWindow()
  await dismissOnboarding(page)
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator(`button[title^="${LAUNCH_TITLE.claude}"]`).first()).toBeVisible({ timeout: 30_000 })
  return { app, page, home, userData }
}

async function closeWorld(w: World | undefined): Promise<void> {
  if (!w) return
  await quitApp(w.app)
  removeChooserHome(w.home)
}

// ── Reading the app ───────────────────────────────────────────────────────────────────────

interface TermInfo { id: string; name: string; agentCommand: string; agentAccountId: string }

async function terminalsOf(page: Page): Promise<TermInfo[]> {
  return await page.evaluate(() => {
    const hook = (window as unknown as { __termpolis_test_state?: () => { terminals: Array<Record<string, unknown>> } }).__termpolis_test_state
    return (hook?.().terminals ?? []).map((t) => ({
      id: String(t.id), name: String(t.name ?? ''), agentCommand: String(t.agentCommand ?? ''), agentAccountId: String(t.agentAccountId ?? ''),
    }))
  })
}

/** Out of xterm's own buffer, for any terminal, shown or not. */
async function screenOf(page: Page, id: string): Promise<string> {
  return await page.evaluate(
    (terminalId) => (window as unknown as { __termpolis_terminal_text?: (id?: string) => string }).__termpolis_terminal_text?.(terminalId) ?? '',
    id,
  )
}

function eventsOf(w: World, agent: Agent, event?: string): MockEvent[] {
  return readMockLog(w.home).filter((e) => e.agent === agent && (event === undefined || e.event === event))
}

/** The pane of one terminal: its card, overlay and toast are inside it. */
const paneOf = (w: World, id: string) => w.page.locator(`[data-terminal-id="${id}"]`)

// ── Doing things in the app ───────────────────────────────────────────────────────────────

/** Launches an agent from the sidebar (the folder picker answers itself) and waits for its box. */
async function launchAgent(w: World, agent: Agent): Promise<string> {
  const before = new Set((await terminalsOf(w.page)).map((t) => t.id))
  const starts = eventsOf(w, agent, 'start').length
  await w.page.locator(`button[title^="${LAUNCH_TITLE[agent]}"]`).first().click()
  let id = ''
  await expect.poll(async () => {
    // A preferred account that ran out of usage is asked about before the terminal opens (the launch ask).
    // These cases launch on the default account whatever its state, so the answer is "anyway".
    const anyway = w.page.locator('[data-testid="launch-ask-anyway"]')
    if (await anyway.count() > 0) await anyway.first().click({ timeout: 5_000 }).catch(() => undefined)
    id = (await terminalsOf(w.page)).find((t) => !before.has(t.id) && t.agentCommand !== '')?.id ?? ''
    return id
  }, { timeout: 60_000, message: `a new ${agent} terminal` }).not.toBe('')
  await expect.poll(() => eventsOf(w, agent, 'start').length, { timeout: 60_000, message: `the mock ${agent} to start` }).toBe(starts + 1)
  await expect.poll(() => screenOf(w.page, id), { timeout: 30_000, message: `the mock ${agent}'s box` }).toContain(BOX_FOOTER[agent])
  return id
}

/** What the terminal is given, as a key press gives it (the IPC an xterm's keys end in). */
async function writeTo(w: World, id: string, data: string): Promise<void> {
  await w.page.evaluate(
    ({ terminalId, d }) => { (window as unknown as { termpolis: { writeToTerminal: (id: string, data: string) => void } }).termpolis.writeToTerminal(terminalId, d) },
    { terminalId: id, d: data },
  )
}

/** A prompt typed into the agent's box and entered, the way a user does: the text, a moment for
 *  the box to draw it, then Enter. */
async function say(w: World, id: string, text: string): Promise<void> {
  await writeTo(w, id, text)
  await w.page.waitForTimeout(600)
  await writeTo(w, id, '\r')
}

/** The chip's menu, and a row of it picked by the account's name. */
async function pickFromChip(w: World, id: string, label: string): Promise<void> {
  await w.page.locator(`[data-account-chip="${id}"]`).click()
  const menu = w.page.locator('[data-testid="account-menu"]')
  await expect(menu).toBeVisible({ timeout: 15_000 })
  await menu.locator('[data-testid="account-menu-row"]').filter({ hasText: label }).first().click()
}

const chipOf = (w: World, id: string) => w.page.locator(`[data-account-chip="${id}"]`)
const cardOf = (w: World, id: string) => paneOf(w, id).locator('[data-testid="limit-card"]')

/** Waits for the card that offers a way out of a usage limit. */
async function expectCard(w: World, id: string) {
  const card = cardOf(w, id)
  try {
    await expect(card).toBeVisible({ timeout: 60_000 })
  } catch (e) {
    // What main's look at the terminal says, a few times: which of live, turned and the status kept the card away.
    const looks: unknown[] = []
    for (let i = 0; i < 4; i++) {
      looks.push(await w.page.evaluate(async (terminalId) => {
        try { return await (window as unknown as { accounts: { limitLook: (id: string) => Promise<unknown> } }).accounts.limitLook(terminalId) } catch (err) { return String(err) }
      }, id))
      await w.page.waitForTimeout(2000)
    }
    const raw = await w.page.evaluate(async (terminalId) => {
      try { return await (window as unknown as { termpolis: { readTerminalBuffer: (id: string, from: number) => Promise<unknown> } }).termpolis.readTerminalBuffer(terminalId, 0) } catch (err) { return String(err) }
    }, id)
    throw new Error(`${(e as Error).message}\nLIMIT-LOOKS ${JSON.stringify(looks)}\nRAW-OUTPUT ${JSON.stringify(raw)}`)
  }
  return card
}

/** No card at all for a while: two and more looks of the 2 s loop at the terminal. */
async function expectNoCardFor(w: World, id: string, ms = 7000): Promise<void> {
  await w.page.waitForTimeout(ms)
  await expect(cardOf(w, id)).toHaveCount(0)
}

/** The conversation's transcript, wherever a profile keeps it. */
function findTranscript(profile: string, sessionId: string): string | null {
  const root = path.join(profile, 'projects')
  let dirs: string[] = []
  try { dirs = fs.readdirSync(root) } catch { return null }
  for (const d of dirs) {
    const f = path.join(root, d, `${sessionId}.jsonl`)
    if (fs.existsSync(f)) return f
  }
  return null
}

// ── The MCP server: what the conductor and every other client reaches a terminal through ──

function mcpPort(w: World): number {
  try {
    const n = parseInt(fs.readFileSync(path.join(w.userData, 'mcp-port'), 'utf-8').trim(), 10)
    return Number.isNaN(n) || n <= 0 ? 9315 : n
  } catch { return 9315 }
}

async function mcpCall(w: World, tool: string, args: Record<string, unknown>): Promise<string> {
  // The token is rewritten at every launch: read it when it is wanted.
  const token = fs.readFileSync(path.join(w.userData, 'mcp-token'), 'utf-8').trim()
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: tool, arguments: args } })
  return await new Promise<string>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: mcpPort(w), path: '/mcp', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), Authorization: `Bearer ${token}` },
    }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => resolve(d))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ── Claude Code, switched at its usage limit (cases 1-3, 11 and 14) ───────────────────────

test.describe.serial('Claude Code at its usage limit', () => {
  let w: World
  let term = ''
  let session = ''

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    w = await openWorld('account-chooser-claude')
  })

  test.afterAll(async () => {
    await closeWorld(w)
  })

  test('1. a Claude Code launched from the sidebar runs on the default account, is watched for limits, and wears the chip', async () => {
    term = await launchAgent(w, 'claude')
    const start = eventsOf(w, 'claude', 'start')[0]
    expect(start.profile).toBe('(default)')
    // R6: Termpolis marks the terminals it watches, for the agent's own hooks.
    expect(start.limitChooser).toBe('1')
    session = String(start.session)
    expect(session).toMatch(UUID)
    await expect(chipOf(w, term)).toBeVisible({ timeout: 30_000 })
    await expect(chipOf(w, term)).toContainText('main')
    expect((await terminalsOf(w.page)).find((t) => t.id === term)?.agentAccountId).toBe(ACCOUNT_IDS.claudeMain)
  })

  test('2. at its usage limit the chooser opens by itself, with the other account a click away', async () => {
    await say(w, term, 'please hit the limit')
    const card = await expectCard(w, term)
    await expect(card.locator('[data-testid="limit-card-headline"]')).toContainText('Claude Code is out of usage on main')
    await expect(card.locator('[data-testid="limit-card-words"]')).toContainText('You\'ve hit your session limit')
    await expect(card.locator('[data-testid="limit-card-continue"]')).toContainText('Continue on side')
    // The limit is recorded against the account it hit, and no other.
    await expect.poll(() => Object.keys(readRegistry(w.userData).limits), { timeout: 30_000 }).toEqual([ACCOUNT_IDS.claudeMain])
  })

  test('3. Continue moves the conversation in place: its own /exit, no key, the exact session on the other profile', async () => {
    // R4: the resumed session draws the limit it stopped at again.
    setMockControl(w.home, { redrawLimit: true })
    const card = cardOf(w, term)
    await card.locator('[data-testid="limit-card-continue"]').click()
    const toast = paneOf(w, term).locator('[data-testid="switch-toast"]')
    await expect(toast).toBeVisible({ timeout: 90_000 })
    await expect(toast).toContainText('Claude Code is on side now. Conversation resumed.')
    await expect(chipOf(w, term)).toContainText('side')
    // What the agent was given: its exit command in its box, never a Ctrl+C or Ctrl+D...
    const claude = eventsOf(w, 'claude')
    expect(claude.filter((e) => e.event === 'key')).toEqual([])
    expect(claude.filter((e) => e.event === 'line').map((e) => e.text)).toEqual(['please hit the limit', '/exit'])
    // ...and then a second process on the other account's profile that resumed the same session.
    const starts = claude.filter((e) => e.event === 'start')
    expect(starts.map((e) => e.profile)).toEqual(['(default)', '.claude-b'])
    expect(starts[1].resume).toBe(session)
    expect(starts[1].limitChooser).toBe('1')
    expect(claude.find((e) => e.event === 'resume')).toMatchObject({ session, profile: '.claude-b' })
    await expect.poll(() => screenOf(w.page, term), { timeout: 30_000 }).toContain(`resumed ${session.slice(0, 8)} on .claude-b`)
    // R25: the profile had no link to the conversation, so Termpolis copied that one transcript.
    expect(findTranscript(w.home.claudeSide, session)).not.toBeNull()
    expect((await terminalsOf(w.page)).find((t) => t.id === term)?.agentAccountId).toBe(ACCOUNT_IDS.claudeSide)
  })

  test('4. R4: the old limit the resumed session draws again opens no chooser and is recorded against nobody', async () => {
    // The mock drew it under the resumed prompt: it is on screen now.
    await expect.poll(() => screenOf(w.page, term), { timeout: 15_000 }).toContain('hit your session limit')
    await expectNoCardFor(w, term)
    expect(Object.keys(readRegistry(w.userData).limits)).toEqual([ACCOUNT_IDS.claudeMain])
  })

  test('5. a new stop opens the chooser again, and the same stop does not open it twice', async () => {
    await say(w, term, 'hit the limit once more')
    const card = await expectCard(w, term)
    await expect(card.locator('[data-testid="limit-card-headline"]')).toContainText('Claude Code is out of usage on side')
    // The first account is still cooling down: no way out, and it says so.
    await expect(card.locator('[data-testid="limit-card-none"]')).toBeVisible()
    await expect(card.locator('[data-testid="limit-card-continue"]')).toHaveCount(0)
    await card.locator('[data-testid="limit-card-not-now"]').click()
    await expectNoCardFor(w, term)
  })

  test('6. R7: while a switch runs its terminal takes no keys, and an MCP client is refused', async () => {
    // A slow goodbye keeps the switch going long enough to try both.
    setMockControl(w.home, { exitDelayMs: 4000 })
    await pickFromChip(w, term, 'main')
    const pane = paneOf(w, term)
    await expect(pane.locator('[data-testid="switch-steps"]')).toBeVisible({ timeout: 30_000 })
    // The user types: the keys are held, and the pane says so.
    await w.page.evaluate((id) => {
      (document.querySelector(`[data-terminal-id="${id}"] .xterm-helper-textarea`) as HTMLTextAreaElement | null)?.focus()
    }, term)
    await w.page.keyboard.type('zzkeyheld')
    await expect(pane.locator('[data-testid="switch-keys-held"]')).toBeVisible({ timeout: 15_000 })
    // The conductor, or any other MCP client, is refused with the lock's words.
    const refused = await mcpCall(w, 'write_to_terminal', { terminalId: term, text: 'zzmcpwrite' })
    expect(refused).toContain(HELD_WORDS)
    const toast = pane.locator('[data-testid="switch-toast"]')
    await expect(toast).toBeVisible({ timeout: 90_000 })
    await expect(toast).toContainText('Claude Code is on main now')
    // Neither reached the agent.
    const screen = await screenOf(w.page, term)
    expect(screen).not.toContain('zzkeyheld')
    expect(screen).not.toContain('zzmcpwrite')
    expect(eventsOf(w, 'claude', 'line').map((e) => e.text).join(' ')).not.toMatch(/zz/)
    await expect(chipOf(w, term)).toContainText('main')
  })
})

// ── Claude Code, the variants of a switch (cases 4, 5, 9, 10, 12, 13) ─────────────────────

test.describe.serial('Claude Code: what the switch does at each state of the agent', () => {
  let w: World
  let term = ''

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    w = await openWorld('account-chooser-claude-states')
  })

  test.afterAll(async () => {
    await closeWorld(w)
  })

  test('1. R3, R10: an agent that ignores its exit command stays up, nothing more is typed, and the card says so', async () => {
    term = await launchAgent(w, 'claude')
    setMockControl(w.home, { ignoreExit: true })
    await pickFromChip(w, term, 'side')
    const card = paneOf(w, term).locator('[data-testid="switch-error"]')
    await expect(card).toBeVisible({ timeout: 90_000 })
    await expect.poll(() => eventsOf(w, 'claude', 'exit-ignored').length, { timeout: 15_000 }).toBe(1)
    // The agent was never exited and no account line was typed at it: one process, still on main.
    expect(eventsOf(w, 'claude', 'start')).toHaveLength(1)
    expect(eventsOf(w, 'claude').filter((e) => e.event === 'key')).toEqual([])
    expect(await screenOf(w.page, term)).not.toContain('.claude-b')
    await expect(chipOf(w, term)).toContainText('main')
    await card.locator('[data-testid="switch-action-close"]').click()
    await expect(card).toHaveCount(0)
  })

  test('2. R2: an agent that has already exited gets no key at all, and the shell goes straight to the resume', async () => {
    setMockControl(w.home, {})
    // A turn first: a session with no turns has no transcript (and real Claude Code prints no resume
    // hint for it), so the other profile could not see it and the resume ends in "No conversation
    // found". The unit counterpart in accountsChooserE2eMock.test.ts takes the same first turn.
    await say(w, term, 'a first turn')
    await expect.poll(() => screenOf(w.page, term), { timeout: 30_000 }).toContain('Done.')
    // The user ends it by hand: its hint is printed and the shell is at its prompt.
    await say(w, term, '/exit')
    await expect.poll(() => eventsOf(w, 'claude', 'exit').length, { timeout: 30_000 }).toBe(1)
    await expect.poll(() => screenOf(w.page, term), { timeout: 30_000 }).toContain('Resume this session with:')
    const linesBefore = eventsOf(w, 'claude', 'line').length
    await pickFromChip(w, term, 'side')
    const toast = paneOf(w, term).locator('[data-testid="switch-toast"]')
    await expect(toast).toBeVisible({ timeout: 90_000 })
    await expect(toast).toContainText('Claude Code is on side now')
    // Not one more line or key reached an agent that was gone; the second process resumed.
    expect(eventsOf(w, 'claude', 'line')).toHaveLength(linesBefore)
    expect(eventsOf(w, 'claude').filter((e) => e.event === 'key')).toEqual([])
    const starts = eventsOf(w, 'claude', 'start')
    expect(starts.map((e) => e.profile)).toEqual(['(default)', '.claude-b'])
    expect(starts[1].resume).toBe(starts[0].session)
    await expect(chipOf(w, term)).toContainText('side')
  })

  test('3. R5: a limit screen printed in the shell after the agent exited opens no chooser', async () => {
    // End it again, then print a limit screen in the shell with `cat`-like output.
    await say(w, term, '/exit')
    await expect.poll(() => eventsOf(w, 'claude', 'exit').length, { timeout: 30_000 }).toBe(2)
    await expect.poll(() => screenOf(w.page, term), { timeout: 30_000 }).toContain('Resume this session with:')
    const mock = path.resolve('e2e', 'mocks', 'mock-agents.cjs').split('\\').join('/')
    await writeTo(w, term, `node ${mock} --print-screen claude\r`)
    await expect.poll(() => screenOf(w.page, term), { timeout: 30_000 }).toMatch(/hit the limit[\s\S]*hit your session limit/)
    await expectNoCardFor(w, term)
  })

  test('4. R6: an agent typed by hand in a plain terminal is not watched, and carries no marker', async () => {
    const before = new Set((await terminalsOf(w.page)).map((t) => t.id))
    await w.page.locator('button:has-text("+ Add Terminal")').first().click()
    const name = w.page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first()
    await name.fill('plain')
    await w.page.getByRole('button', { name: 'Create', exact: true }).click()
    let plain = ''
    await expect.poll(async () => {
      plain = (await terminalsOf(w.page)).find((t) => !before.has(t.id))?.id ?? ''
      return plain
    }, { timeout: 30_000 }).not.toBe('')
    const starts = eventsOf(w, 'claude', 'start').length
    await w.page.waitForTimeout(1500)
    await writeTo(w, plain, 'claude\r')
    await expect.poll(() => eventsOf(w, 'claude', 'start').length, { timeout: 30_000 }).toBe(starts + 1)
    const last = eventsOf(w, 'claude', 'start').pop() as MockEvent
    expect(last.limitChooser).toBeNull()
    // A terminal Termpolis didn't launch has no chip either: it doesn't know its account.
    expect((await terminalsOf(w.page)).find((t) => t.id === plain)?.agentAccountId).toBe('')
  })

  test('5. its rate-limit menu is a usage limit too, and the switch closes the menu with Esc before it exits the agent', async () => {
    setMockControl(w.home, { menu: true })
    const menuTerm = await launchAgent(w, 'claude')
    await say(w, menuTerm, 'please hit the limit')
    const card = await expectCard(w, menuTerm)
    await expect(card.locator('[data-testid="limit-card-continue"]')).toContainText('Continue on side')
    const mark = readMockLog(w.home).length
    await card.locator('[data-testid="limit-card-continue"]').click()
    const toast = paneOf(w, menuTerm).locator('[data-testid="switch-toast"]')
    await expect(toast).toBeVisible({ timeout: 90_000 })
    await expect(toast).toContainText('Claude Code is on side now')
    // The menu got Esc first; then the exit command. Never a Ctrl+C or a Ctrl+D.
    const since = readMockLog(w.home).slice(mark).filter((e) => e.agent === 'claude' && (e.event === 'key' || e.event === 'line'))
    expect(since.map((e) => (e.event === 'key' ? `key ${String(e.key)}` : `line ${String(e.text)}`))).toEqual(['key Esc', 'line /exit'])
  })
})

// ── Claude Code, a target that is signed out (case 7) ─────────────────────────────────────

test.describe.serial('Claude Code: an account that is signed out', () => {
  let w: World
  let term = ''

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    w = await openWorld('account-chooser-signed-out', (home) => {
      // The second profile's sign-in is gone: the CLI's own status says so.
      setClaudeSignIn(path.join(home.claudeSide, '.claude.json'), null)
    })
  })

  test.afterAll(async () => {
    await closeWorld(w)
  })

  test('7. a way out that is signed out is offered only as Sign in, never as a switch', async () => {
    term = await launchAgent(w, 'claude')
    await say(w, term, 'please hit the limit')
    const card = await expectCard(w, term)
    await expect(card.locator('[data-testid="limit-card-headline"]')).toContainText('out of usage on main')
    // Asked at once whether it is signed in: it is not, so Continue goes.
    await expect(card.locator('[data-testid="limit-card-continue"]')).toHaveCount(0, { timeout: 30_000 })
    await expect(card.locator('[data-testid="limit-card-none"]')).toBeVisible()
    await card.locator('[data-testid="limit-card-more"]').click()
    const other = card.locator('[data-testid="limit-card-other"]').filter({ hasText: 'side' })
    await expect(other).toHaveAttribute('data-state', 'signed-out')
    await expect(other.locator('[data-testid="limit-card-sign-in"]')).toBeVisible()
    await expect(other.locator('[data-testid="limit-card-switch"]')).toHaveCount(0)
    // Nothing was typed at the agent meanwhile.
    expect(eventsOf(w, 'claude', 'line').map((e) => e.text)).toEqual(['please hit the limit'])
    expect(eventsOf(w, 'claude', 'start')).toHaveLength(1)
  })
})

// ── Codex (cases 1-3, with the resume path) ───────────────────────────────────────────────

test.describe.serial('Codex at its usage limit', () => {
  let w: World
  let term = ''

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    w = await openWorld('account-chooser-codex')
  })

  test.afterAll(async () => {
    await closeWorld(w)
  })

  test('1. a Codex launched from the sidebar runs on the default account and wears the chip', async () => {
    term = await launchAgent(w, 'codex')
    const start = eventsOf(w, 'codex', 'start')[0]
    expect(start.profile).toBe('(default)')
    expect(start.limitChooser).toBe('1')
    await expect(chipOf(w, term)).toContainText('codex-main')
  })

  test('2. at its limit the chooser opens, and Continue ends Codex with /quit and resumes the rollout through the shared sessions folder', async () => {
    await say(w, term, 'please hit the limit')
    const card = await expectCard(w, term)
    await expect(card.locator('[data-testid="limit-card-headline"]')).toContainText('Codex is out of usage on codex-main')
    await expect(card.locator('[data-testid="limit-card-words"]')).toContainText('You\'ve hit your usage limit')
    await card.locator('[data-testid="limit-card-continue"]').click()
    const toast = paneOf(w, term).locator('[data-testid="switch-toast"]')
    await expect(toast).toBeVisible({ timeout: 90_000 })
    await expect(toast).toContainText('Codex is on codex-side now. Conversation resumed.')
    const codex = eventsOf(w, 'codex')
    expect(codex.filter((e) => e.event === 'key')).toEqual([])
    expect(codex.filter((e) => e.event === 'line').map((e) => e.text)).toEqual(['please hit the limit', '/quit'])
    const starts = codex.filter((e) => e.event === 'start')
    expect(starts.map((e) => e.profile)).toEqual(['(default)', '.codex-b'])
    expect(starts[1].resume).toMatch(UUID)
    // Path (a): the second profile found the rollout through its linked sessions folder.
    expect(codex.find((e) => e.event === 'resume')).toMatchObject({ profile: '.codex-b', session: starts[1].resume })
    await expect(chipOf(w, term)).toContainText('codex-side')
  })

  test('3. where the other account cannot see the conversation, Codex starts a new session in place, and says so', async () => {
    // The shared folder is gone: codex-side can no longer find a rollout of codex-main's.
    for (const link of w.home.links) unlinkDir(link)
    const second = await launchAgent(w, 'codex')
    await say(w, second, 'a first turn')
    await expect.poll(() => eventsOf(w, 'codex', 'line').filter((e) => e.text === 'a first turn').length, { timeout: 15_000 }).toBe(1)
    await w.page.waitForTimeout(2500)
    await pickFromChip(w, second, 'codex-side')
    const toast = paneOf(w, second).locator('[data-testid="switch-toast"]')
    await expect(toast).toBeVisible({ timeout: 90_000 })
    await expect(toast).toContainText('in a new session')
    await expect(toast).toContainText('can\'t see this conversation')
    expect(eventsOf(w, 'codex', 'resume-missing')).toHaveLength(1)
    // The same terminal went on: a new process on codex-side's profile, with nothing to resume.
    const last = eventsOf(w, 'codex', 'start').pop() as MockEvent
    expect(last.profile).toBe('.codex-b')
    expect(last.resume).toBeNull()
    await expect(chipOf(w, second)).toContainText('codex-side')
  })
})

// ── Gemini CLI (agy): one Google sign-in for the computer, moved for every terminal ───────

test.describe.serial('Gemini CLI at its usage limit', () => {
  let w: World
  let term = ''
  let conversation = ''

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    w = await openWorld('account-chooser-agy')
  })

  test.afterAll(async () => {
    await closeWorld(w)
  })

  test('1. an agy launched from the sidebar shows the Google account agy is signed in to, and wears the chip', async () => {
    term = await launchAgent(w, 'agy')
    const start = eventsOf(w, 'agy', 'start')[0]
    expect(start.limitChooser).toBe('1')
    conversation = String(start.session)
    expect(await screenOf(w.page, term)).toContain(`${EMAILS.agyOne} (Google AI Pro)`)
    await expect(chipOf(w, term)).toContainText('google-one')
  })

  test('2. at its quota stop the chooser offers the guided switch, and says every Gemini terminal moves', async () => {
    await say(w, term, 'please hit the limit')
    const card = await expectCard(w, term)
    await expect(card.locator('[data-testid="limit-card-headline"]')).toContainText('out of usage on google-one')
    await expect(card.locator('[data-testid="limit-card-words"]')).toContainText('exhausted your quota')
    await card.locator('[data-testid="limit-card-continue"]').click()
    const sheet = w.page.locator('[data-testid="agy-switch"]')
    await expect(sheet).toBeVisible({ timeout: 15_000 })
    const confirm = sheet.locator('[data-testid="agy-switch-confirm"]')
    await expect(confirm).toContainText('Gemini CLI has one Google sign-in for this whole computer')
    await expect(confirm).toContainText(`Switching to ${EMAILS.agyTwo} moves your Gemini terminal`)
    // Nothing has happened to agy yet: the user's click is the consent.
    expect(eventsOf(w, 'agy', 'line').map((e) => e.text)).toEqual(['please hit the limit'])
    expect(eventsOf(w, 'agy', 'logout')).toHaveLength(0)
  })

  test('3. after the confirmation agy is ended with /exit, signed out and in by Termpolis alone, and the conversation resumes by its id', async () => {
    const sheet = w.page.locator('[data-testid="agy-switch"]')
    await sheet.locator('[data-testid="agy-switch-go"]').click()
    // agy's own sign-in choices, as buttons; the user's click picks one.
    const choose = sheet.locator('[data-testid="sign-in-choose"]')
    await expect(choose).toBeVisible({ timeout: 90_000 })
    await choose.locator('[data-testid="sign-in-option-0"]').click()
    // The browser step, and the field for the code the page shows.
    await expect(sheet.locator('[data-testid="sign-in-browser"]')).toBeVisible({ timeout: 30_000 })
    await expect(sheet.locator('[data-testid="sign-in-input"]')).toBeVisible({ timeout: 30_000 })
    await sheet.locator('[data-testid="sign-in-input"]').fill('good-code')
    await sheet.locator('[data-testid="sign-in-submit"]').click()
    const done = sheet.locator('[data-testid="agy-switch-done"]')
    await expect(done).toBeVisible({ timeout: 90_000 })
    await expect(done).toContainText(`Gemini CLI is on ${EMAILS.agyTwo} now.`)
    await expect(done).toContainText('1 of 1 conversation resumed.')
    // What the terminal's agy was given: its own /exit, never Ctrl+C (which kills agy). The last line
    // is the hidden agy Termpolis runs for the sign-in: the mock logs its /logout like any line.
    const agy = eventsOf(w, 'agy')
    expect(agy.filter((e) => e.event === 'key')).toEqual([])
    expect(agy.filter((e) => e.event === 'line').map((e) => e.text)).toEqual(['please hit the limit', '/exit', '/logout'])
    // That hidden agy was signed out, once.
    expect(agy.filter((e) => e.event === 'logout')).toHaveLength(1)
    // The same conversation, by its exact id, on the new sign-in.
    const starts = agy.filter((e) => e.event === 'start')
    expect(starts.find((e) => e.resume === conversation)).toBeDefined()
    await expect.poll(() => screenOf(w.page, term), { timeout: 30_000 }).toContain(`${EMAILS.agyTwo} (Google AI Pro)`)
    await sheet.locator('[data-testid="agy-switch-done-close"]').click()
    await expect(sheet).toHaveCount(0)
    await expect(chipOf(w, term)).toContainText('google-two')
  })
})
