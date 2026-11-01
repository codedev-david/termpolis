// The mock agents of e2e/account-chooser.spec.ts (e2e/mocks/mock-agents.cjs), proven against the
// real thing they stand in for: on a real PTY, in each real shell this machine has (Git Bash,
// PowerShell, cmd on Windows; bash elsewhere), through the e2e shims first on PATH, the REAL
// usage-limit look (limitLook.ts) reads their screens as a limit, and the REAL switch engine
// (accountSwitch.ts, agySwitch.ts) moves them to the second account: its own exit command, the
// account line built by the real accountLine, the exact session resumed, the transcript carried.
// The spec can't run here (Electron 43 and Playwright run in CI only); this is what stands in for
// running it against the mocks.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { spawnSync } from 'child_process'
import { ACCOUNT_IDS, EMAILS, chooserShimEnv, makeChooserHome, readMockLog, removeChooserHome, seedRegistry, setClaudeSignIn, setCodexSignIn, setMockControl } from '../../e2e/helpers/chooserFixture'
import { claudeSignedInNow, codexSignedInNow } from '../../src/main/accountIdentity'
import type { ChooserHome, MockEvent } from '../../e2e/helpers/chooserFixture'
import { RealTerminal, cleanEnv, loadPty, prependPath, shellsHere, sleep } from './_realPty'
import type { PtyModule, ShellSpec } from './_realPty'
import { accountEnv, accountLine } from '../../src/shared/agentAccounts'
import type { AgentAccount } from '../../src/shared/agentAccounts'
import { atIdleBox, relaunchLockReason, runAccountSwitch } from '../../src/main/accountSwitch'
import { RELAUNCH_HELD } from '../../src/shared/accountSwitch'
import type { AgentStartRecord } from '../../src/main/accountSwitch'
import { lookForLimit, noteEnteredLine } from '../../src/main/limitLook'
import type { LiveStart } from '../../src/main/limitLook'
import { runAgyStep } from '../../src/main/agySwitch'
import { carryTranscript, findTranscript } from '../../src/main/accountCarry'
import { parseAccountsDoc } from '../../src/main/agentAccounts'
import { stopKind } from '../../src/shared/agentStatusDetector'
import { _resetSignInSessionsForTest, endSignIns, signInInput, startSignInSession } from '../../src/main/signInSession'
import type { PtyLike, SessionDeps } from '../../src/main/signInSession'
import { killProcessTree } from '../../src/main/processTree'
import type { SignInPhase, SignInState } from '../../src/shared/signInScreens'

const pty = loadPty()
const shells = pty ? shellsHere() : []
const homes: ChooserHome[] = []
const terminals: RealTerminal[] = []
const scratch: string[] = []

afterEach(() => {
  for (const t of terminals.splice(0)) t.kill()
  for (const h of homes.splice(0)) removeChooserHome(h)
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true })
})

const SESSION = '3f2a9c1e-5b7d-4e8f-a012-3456789abcde'
const ID = 'T'

function world(): { h: ChooserHome; accounts: Record<keyof typeof ACCOUNT_IDS, AgentAccount> } {
  const h = makeChooserHome()
  homes.push(h)
  const userData = mkdtempSync(join(tmpdir(), 'termpolis-chooser-userdata-'))
  scratch.push(userData)
  seedRegistry(userData, h)
  const doc = parseAccountsDoc(JSON.parse(readFileSync(join(userData, 'agent-accounts.json'), 'utf8')))
  const byId = (id: string): AgentAccount => {
    const a = doc.file.accounts.find((x) => x.id === id)
    if (!a) throw new Error(`the seeded registry lost ${id}`)
    return a
  }
  return { h, accounts: Object.fromEntries(Object.entries(ACCOUNT_IDS).map(([k, id]) => [k, byId(id)])) as Record<keyof typeof ACCOUNT_IDS, AgentAccount> }
}

/** A shell with the mock agents first on PATH and a test home, ready at its prompt. */
async function openShell(shell: ShellSpec, h: ChooserHome): Promise<RealTerminal> {
  const shim = chooserShimEnv()
  const env = prependPath(shim.TERMPOLIS_TEST_SHIM_DIR, cleanEnv({ TERMPOLIS_TEST_AGENT_HOME: h.home, HOME: h.home, USERPROFILE: h.home, TERMPOLIS_LIMIT_CHOOSER: '1' }))
  const t = new RealTerminal(pty as PtyModule, shell, { cwd: h.project, env })
  terminals.push(t)
  // Ready: it has drawn something and has been quiet for a moment.
  await t.until(() => t.total > 0, 30_000, 'the shell to start')
  let last = -1
  while (last !== t.total) {
    last = t.total
    await sleep(700)
  }
  return t
}

/** Types a launch line the way Termpolis does, and records the start as main would. */
function launch(t: RealTerminal, line: string, agent: 'claude' | 'codex' | 'agy'): LiveStart {
  const at = t.total
  t.write(line + '\r')
  return { at, commands: [line], agent, time: Date.now() }
}

async function untilBox(t: RealTerminal, what: string): Promise<void> {
  await t.until(() => atIdleBox(t.io(), ID) !== null, 30_000, what)
}

/** Types a prompt and notes it as main's terminal:write watch does. */
function prompt(t: RealTerminal, start: LiveStart, text: string): void {
  noteEnteredLine(t.io(), ID, start, text, t.total, Date.now())
  t.write(text + '\r')
}

async function untilLimit(t: RealTerminal, start: LiveStart): Promise<ReturnType<typeof lookForLimit>> {
  let seen = lookForLimit(t.io(), ID, start, Date.now())
  const end = Date.now() + 30_000
  while (stopKind(seen.status) !== 'limit' && Date.now() < end) {
    await sleep(250)
    seen = lookForLimit(t.io(), ID, start, Date.now())
  }
  return seen
}

/** What a failed assertion shows: the screen and the raw tail of the terminal. */
const debug = (t: RealTerminal): string => `${t.screen()}\n---- raw tail ----\n${JSON.stringify(t.raw.slice(-600))}\n---- trace ----\n${t.trace.slice(-40).join('\n')}`

const eventsOf = (h: ChooserHome, agent: MockEvent['agent']): MockEvent[] => readMockLog(h).filter((e) => e.agent === agent)

describe('the e2e fixture', () => {
  it('seeds a registry the real parser reads whole, and every profile it names exists', () => {
    const { h, accounts } = world()
    expect(Object.keys(accounts)).toHaveLength(6)
    expect(accounts.claudeMain.profile).toBeNull()
    expect(accounts.claudeSide.profile).toBe(h.claudeSide)
    expect(accounts.codexSide.profile).toBe(h.codexSide)
    expect(accounts.agyTwo.email).toBe(EMAILS.agyTwo)
    expect(accounts.agyOne.profile).toBeNull()
  })

  it('is read by the real identity checks as signed in to the email each profile names, and as signed out where it has none', async () => {
    const { h } = world()
    // What main hands the checks: the shim folder first on PATH, and the test home.
    const sep = process.platform === 'win32' ? ';' : ':'
    const deps = {
      cwd: h.project,
      env: { PATH: `${chooserShimEnv().TERMPOLIS_TEST_SHIM_DIR}${sep}${process.env.PATH ?? ''}`, TERMPOLIS_TEST_AGENT_HOME: h.home, SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC, PATHEXT: process.env.PATHEXT },
    }
    expect(await claudeSignedInNow(null, deps)).toMatchObject({ identity: { signedIn: true, email: EMAILS.claudeMain } })
    expect(await claudeSignedInNow(h.claudeSide, deps)).toMatchObject({ identity: { signedIn: true, email: EMAILS.claudeSide } })
    setClaudeSignIn(join(h.claudeSide, '.claude.json'), null)
    expect(await claudeSignedInNow(h.claudeSide, deps)).toMatchObject({ identity: { signedIn: false, email: null } })
    expect(await codexSignedInNow(null, deps)).toMatchObject({ identity: { signedIn: true, email: EMAILS.codexMain, plan: 'plus' } })
    expect(await codexSignedInNow(h.codexSide, deps)).toMatchObject({ identity: { signedIn: true, email: EMAILS.codexSide } })
    setCodexSignIn(h.codexSide, null)
    expect(await codexSignedInNow(h.codexSide, deps)).toMatchObject({ identity: { signedIn: false } })
  })

  it('refuses to run a mock agent anywhere but in a test home', () => {
    const empty = mkdtempSync(join(tmpdir(), 'termpolis-notahome-'))
    scratch.push(empty)
    const r = spawnSync(process.execPath, [join('e2e', 'mocks', 'mock-agents.cjs'), 'claude', 'auth', 'status'], { env: { PATH: process.env.PATH ?? '', TERMPOLIS_TEST_AGENT_HOME: empty }, encoding: 'utf8' })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/not a test home/)
  })

  it('answers the identity checks the way main asks (auth status, login status, app-server)', () => {
    const { h } = world()
    const env = { PATH: process.env.PATH ?? '', TERMPOLIS_TEST_AGENT_HOME: h.home, HOME: h.home, USERPROFILE: h.home }
    const mock = join('e2e', 'mocks', 'mock-agents.cjs')
    const main = spawnSync(process.execPath, [mock, 'claude', 'auth', 'status', '--json'], { env, encoding: 'utf8' })
    expect(JSON.parse(main.stdout)).toMatchObject({ loggedIn: true, email: EMAILS.claudeMain })
    const side = spawnSync(process.execPath, [mock, 'claude', 'auth', 'status', '--json'], { env: { ...env, CLAUDE_CONFIG_DIR: h.claudeSide }, encoding: 'utf8' })
    expect(JSON.parse(side.stdout)).toMatchObject({ loggedIn: true, email: EMAILS.claudeSide })
    const codex = spawnSync(process.execPath, [mock, 'codex', 'login', 'status'], { env: { ...env, CODEX_HOME: h.codexSide }, encoding: 'utf8' })
    expect(codex.status).toBe(0)
    expect(codex.stderr).toMatch(/^Logged in using ChatGPT/m)
    setCodexSignIn(h.codexSide, null)
    const out = spawnSync(process.execPath, [mock, 'codex', 'login', 'status'], { env: { ...env, CODEX_HOME: h.codexSide }, encoding: 'utf8' })
    expect(out.status).toBe(1)
    expect(out.stderr).toMatch(/^Not logged in/m)
    const app = spawnSync(process.execPath, [mock, 'codex', 'app-server'], {
      env: { ...env, CODEX_HOME: h.codexSide },
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/read' }) + '\n',
      encoding: 'utf8',
      timeout: 3000,
    })
    expect(app.stdout).toMatch(/"userAgent":"termpolis\/0\.164\.0/)
    expect(app.stdout).toMatch(/"account":null/)
  })
})

describe.skipIf(!pty || shells.length === 0)('the mock agents on a real PTY, read and switched by the real engine', () => {
  for (const shell of shells) {
    describe(shell.shellType, () => {
      it('Claude Code: a limit is read as one, and the switch exits it, resumes the exact session on the second account and carries the transcript', async () => {
        const { h, accounts } = world()
        const t = await openShell(shell, h)
        const A = accounts.claudeMain
        const B = accounts.claudeSide
        const built = accountLine(shell.family, accountEnv(A, 'claude'), `claude --session-id ${SESSION}`)
        if ('refused' in built) throw new Error(built.refused)
        const start = launch(t, built.line, 'claude')
        await untilBox(t, 'the mock Claude Code box')
        expect(t.screen()).toContain('profile: (default)')

        setMockControl(h, { redrawLimit: true })
        prompt(t, start, 'please hit the limit')
        const seen = await untilLimit(t, start)
        expect(stopKind(seen.status)).toBe('limit')
        expect(seen).toMatchObject({ agent: 'claude', live: true, turned: true })
        expect(seen.words).toMatch(/hit your session limit · resets 3pm \(America\/New_York\)/)

        const writes: string[] = []
        const projectsA = join(h.home, '.claude', 'projects')
        const projectsB = join(h.claudeSide, 'projects')
        let recorded: { accountId: string; start: AgentStartRecord; sessionId: string | null } | null = null
        const outcome = await runAccountSwitch({ terminalId: ID, targetId: B.id, shellType: shell.shellType }, {
          io: t.io(writes),
          target: B,
          agent: 'claude',
          source: A,
          start,
          sessionId: SESSION,
          hasTranscript: (id) => findTranscript([projectsA, projectsB], id) !== null,
          carry: (id) => {
            const r = carryTranscript([projectsA], projectsB, id, Date.now())
            return r.kind === 'carried' ? { carried: true, ...(r.kept ? { kept: r.kept } : {}) } : { carried: false }
          },
          newSessionId: () => randomUUID(),
          record: (r) => { recorded = r },
        })
        expect(outcome, debug(t)).toMatchObject({ kind: 'switched', resumed: true, sessionId: SESSION, carried: true })
        expect(recorded).toMatchObject({ accountId: B.id, sessionId: SESSION })

        // What the mock got: the exit command in its box, no key at all, then a second process on the
        // second account's profile that resumed the exact session.
        const log = eventsOf(h, 'claude')
        expect(log.filter((e) => e.event === 'key')).toEqual([])
        expect(log.filter((e) => e.event === 'line').map((e) => e.text)).toEqual(['please hit the limit', '/exit'])
        expect(log.filter((e) => e.event === 'start').map((e) => e.profile)).toEqual(['(default)', '.claude-b'])
        expect(log.find((e) => e.event === 'resume')).toMatchObject({ session: SESSION, profile: '.claude-b' })
        expect(t.screen()).toContain(`resumed ${SESSION.slice(0, 8)} on .claude-b`)
        // Keys the engine wrote: its clearing and the exit command, never a Ctrl+C or Ctrl+D.
        expect(writes.join('')).not.toMatch(/[\u0003\u0004]/)

        // R4: the resumed session draws the limit it stopped at again, and that is no new stop: the
        // agent it started has taken no turn.
        const again = lookForLimit(t.io(), ID, { ...recorded!.start, agent: 'claude', time: Date.now() }, Date.now())
        expect(again).toMatchObject({ live: true, turned: false })
        expect(stopKind(again.status)).toBe('limit')
      }, 120_000)

      it('Claude Code: its rate-limit menu is read as a limit, and the switch closes the menu with Esc before it types the exit command', async () => {
        const { h, accounts } = world()
        const t = await openShell(shell, h)
        const built = accountLine(shell.family, accountEnv(accounts.claudeMain, 'claude'), `claude --session-id ${SESSION}`)
        if ('refused' in built) throw new Error(built.refused)
        const start = launch(t, built.line, 'claude')
        await untilBox(t, 'the mock Claude Code box')
        setMockControl(h, { menu: true })
        prompt(t, start, 'please hit the limit')
        const seen = await untilLimit(t, start)
        expect(stopKind(seen.status), debug(t)).toBe('limit')
        expect(t.screen()).toContain('What do you want to do?')
        const projectsA = join(h.home, '.claude', 'projects')
        const projectsB = join(h.claudeSide, 'projects')
        const writes: string[] = []
        const outcome = await runAccountSwitch({ terminalId: ID, targetId: accounts.claudeSide.id, shellType: shell.shellType }, {
          io: t.io(writes), target: accounts.claudeSide, agent: 'claude', source: accounts.claudeMain, start, sessionId: SESSION, newSessionId: () => randomUUID(), record: () => undefined,
          hasTranscript: (id) => findTranscript([projectsA, projectsB], id) !== null,
          carry: (id) => ({ carried: carryTranscript([projectsA], projectsB, id, Date.now()).kind === 'carried' }),
        })
        expect(outcome, debug(t)).toMatchObject({ kind: 'switched', resumed: true })
        // The menu got Esc first; then the exit command, and not one Ctrl+C or Ctrl+D.
        const log = eventsOf(h, 'claude').filter((e) => e.event === 'key' || e.event === 'line')
        expect(log.map((e) => (e.event === 'key' ? `key ${e.key}` : `line ${e.text}`))).toEqual(['line please hit the limit', 'key Esc', 'line /exit'])
        expect(writes.join('')).not.toMatch(/[\u0003\u0004]/)
      }, 120_000)

      it('a swarm worker\'s restart: the flags run_command started it with come back, the exact session resumes, and the lock says it is a worker\'s', async () => {
        const { h, accounts } = world()
        const t = await openShell(shell, h)
        // The worker as the conductor starts it (run_command's line): bypass mode, no session id of its own.
        const built = accountLine(shell.family, accountEnv(accounts.claudeMain, 'claude'), 'claude --dangerously-skip-permissions')
        if ('refused' in built) throw new Error(built.refused)
        const start = launch(t, built.line, 'claude')
        await untilBox(t, 'the mock Claude Code box')
        prompt(t, start, 'a task from the conductor')
        await sleep(2500)
        const projectsA = join(h.home, '.claude', 'projects')
        const projectsB = join(h.claudeSide, 'projects')
        // The lock, sampled while the switch runs: a conductor's write is refused in a worker's words.
        const seen = new Set<string>()
        const sampler = setInterval(() => { const why = relaunchLockReason(ID); if (why) seen.add(why) }, 50)
        let outcome
        try {
          outcome = await runAccountSwitch({ terminalId: ID, targetId: accounts.claudeSide.id, shellType: shell.shellType }, {
            io: t.io(), target: accounts.claudeSide, agent: 'claude', source: accounts.claudeMain, start, lockKind: 'worker', newSessionId: () => randomUUID(), record: () => undefined,
            hasTranscript: (id) => findTranscript([projectsA, projectsB], id) !== null,
            carry: (id) => ({ carried: carryTranscript([projectsA], projectsB, id, Date.now()).kind === 'carried' }),
          })
        } finally {
          clearInterval(sampler)
        }
        expect(outcome, debug(t)).toMatchObject({ kind: 'switched', resumed: true })
        expect([...seen]).toEqual([RELAUNCH_HELD.worker])
        const starts = eventsOf(h, 'claude').filter((e) => e.event === 'start')
        const second = starts[1]
        expect(second).toMatchObject({ profile: '.claude-b' })
        expect(second.args).toEqual(['--dangerously-skip-permissions', '--resume', second.resume])
        expect(second.resume).toBe(starts[0].session)
        // Released at the end: the conductor can write again.
        expect(relaunchLockReason(ID)).toBeNull()
      }, 120_000)

      it('Claude Code: an agent that ignores its exit command stays up, and nothing more is typed', async () => {
        const { h, accounts } = world()
        const t = await openShell(shell, h)
        const built = accountLine(shell.family, accountEnv(accounts.claudeMain, 'claude'), `claude --session-id ${SESSION}`)
        if ('refused' in built) throw new Error(built.refused)
        const start = launch(t, built.line, 'claude')
        await untilBox(t, 'the mock Claude Code box')
        setMockControl(h, { ignoreExit: true })
        const writes: string[] = []
        const outcome = await runAccountSwitch({ terminalId: ID, targetId: accounts.claudeSide.id, shellType: shell.shellType }, {
          io: t.io(writes), target: accounts.claudeSide, agent: 'claude', source: accounts.claudeMain, start, sessionId: SESSION, newSessionId: () => randomUUID(), record: () => undefined,
        })
        expect(outcome.kind, debug(t)).toBe('exit-unconfirmed')
        const log = eventsOf(h, 'claude')
        expect(log.filter((e) => e.event === 'exit-ignored')).toHaveLength(1)
        expect(log.filter((e) => e.event === 'start')).toHaveLength(1)
        // The account line never reached its box: the second profile's name is nowhere on screen.
        expect(t.screen()).not.toContain('.claude-b')
        expect(writes.join('')).not.toMatch(/[\u0003\u0004]/)
      }, 120_000)

      it('Claude Code: an agent that already exited gets no key, and the shell goes on to the resume', async () => {
        const { h, accounts } = world()
        const t = await openShell(shell, h)
        const built = accountLine(shell.family, accountEnv(accounts.claudeMain, 'claude'), `claude --session-id ${SESSION}`)
        if ('refused' in built) throw new Error(built.refused)
        const start = launch(t, built.line, 'claude')
        await untilBox(t, 'the mock Claude Code box')
        prompt(t, start, 'a first turn')
        await sleep(2500)
        t.write('/exit\r')
        await t.until(() => /Resume this session with:/.test(t.screen()) && t.screen().trimEnd().split('\n').length > 3, 20_000, 'the exit hint')
        await sleep(1500)
        const writes: string[] = []
        const projectsA = join(h.home, '.claude', 'projects')
        const projectsB = join(h.claudeSide, 'projects')
        const outcome = await runAccountSwitch({ terminalId: ID, targetId: accounts.claudeSide.id, shellType: shell.shellType }, {
          io: t.io(writes), target: accounts.claudeSide, agent: 'claude', source: accounts.claudeMain, start, sessionId: SESSION, newSessionId: () => randomUUID(), record: () => undefined,
          hasTranscript: (id) => findTranscript([projectsA, projectsB], id) !== null,
          carry: (id) => ({ carried: carryTranscript([projectsA], projectsB, id, Date.now()).kind === 'carried' }),
        })
        expect(outcome, debug(t)).toMatchObject({ kind: 'switched', resumed: true })
        // Not one key to an agent that is gone: the shell's line is cleared, the account line typed.
        expect(writes.join('')).not.toContain('/exit')
        expect(writes.join('')).not.toMatch(/[\u0003\u0004]/)
        expect(eventsOf(h, 'claude').filter((e) => e.event === 'exit')).toHaveLength(1)
      }, 120_000)

      it('R5: a limit screen printed in the shell after the agent exited is no stop', async () => {
        const { h, accounts } = world()
        const t = await openShell(shell, h)
        const built = accountLine(shell.family, accountEnv(accounts.claudeMain, 'claude'), `claude --session-id ${SESSION}`)
        if ('refused' in built) throw new Error(built.refused)
        const start = launch(t, built.line, 'claude')
        await untilBox(t, 'the mock Claude Code box')
        prompt(t, start, 'a first turn')
        await sleep(2500)
        t.write('/exit\r')
        await t.until(() => /Resume this session with:/.test(t.screen()), 20_000, 'the exit hint')
        await sleep(1200)
        // The 2 s loop's look right after the exit latches the agent gone.
        expect(lookForLimit(t.io(), ID, start, Date.now()).live).toBe(false)
        // The mock by its full path, written with forward slashes so no shell reads a backslash.
        const mock = join(process.cwd(), 'e2e', 'mocks', 'mock-agents.cjs').split('\\').join('/')
        t.write(`node ${mock} --print-screen claude\r`)
        await t.until(() => /hit your session limit/.test(t.screen()), 15_000, 'the printed limit screen')
        const seen = lookForLimit(t.io(), ID, start, Date.now())
        expect(stopKind(seen.status)).toBe('limit')
        expect(seen.live).toBe(false)
      }, 120_000)

      it('Codex: a limit is read as one, and the switch exits it with /quit and resumes the rollout through the linked sessions folder', async () => {
        const { h, accounts } = world()
        const t = await openShell(shell, h)
        const X = accounts.codexMain
        const Y = accounts.codexSide
        const built = accountLine(shell.family, accountEnv(X, 'codex'), 'codex -m gpt-5.6-sol')
        if ('refused' in built) throw new Error(built.refused)
        const start = launch(t, built.line, 'codex')
        await untilBox(t, 'the mock Codex composer')
        expect(t.screen()).toContain('profile: (default)')
        prompt(t, start, 'please hit the limit')
        const seen = await untilLimit(t, start)
        expect(stopKind(seen.status)).toBe('limit')
        expect(seen).toMatchObject({ agent: 'codex', live: true, turned: true })
        expect(seen.words).toMatch(/hit your usage limit/)

        const writes: string[] = []
        const outcome = await runAccountSwitch({ terminalId: ID, targetId: Y.id, shellType: shell.shellType }, {
          io: t.io(writes), target: Y, agent: 'codex', source: X, start, newSessionId: () => randomUUID(), record: () => undefined,
        })
        expect(outcome, debug(t)).toMatchObject({ kind: 'switched', resumed: true })
        const log = eventsOf(h, 'codex')
        expect(log.filter((e) => e.event === 'key')).toEqual([])
        expect(log.filter((e) => e.event === 'line').map((e) => e.text)).toEqual(['please hit the limit', '/quit'])
        const second = log.filter((e) => e.event === 'start')[1]
        expect(second).toMatchObject({ profile: '.codex-b' })
        expect(second.resume).toMatch(/^[0-9a-f-]{36}$/)
        // Path (a): the second profile finds the rollout through its linked sessions folder.
        expect(log.find((e) => e.event === 'resume')).toMatchObject({ profile: '.codex-b' })
        expect(t.screen()).toMatch(/resumed [0-9a-f]{8} on \.codex-b/)
        expect(writes.join('')).not.toMatch(/[\u0003\u0004]/)
      }, 120_000)

      it('Codex: without the shared sessions folder the resume finds nothing, and the engine says so (path c)', async () => {
        const { h, accounts } = world()
        // The second profile has no link: it can't see the first one's rollouts.
        const { unlinkDir } = await import('../../e2e/helpers/chooserFixture')
        for (const l of h.links) unlinkDir(l)
        const t = await openShell(shell, h)
        const built = accountLine(shell.family, accountEnv(accounts.codexMain, 'codex'), 'codex')
        if ('refused' in built) throw new Error(built.refused)
        const start = launch(t, built.line, 'codex')
        await untilBox(t, 'the mock Codex composer')
        prompt(t, start, 'a first turn')
        await sleep(2500)
        const outcome = await runAccountSwitch({ terminalId: ID, targetId: accounts.codexSide.id, shellType: shell.shellType }, {
          io: t.io(), target: accounts.codexSide, agent: 'codex', source: accounts.codexMain, start, newSessionId: () => randomUUID(), record: () => undefined,
        })
        expect(outcome.kind, debug(t)).toBe('fresh')
        expect(eventsOf(h, 'codex').filter((e) => e.event === 'resume-missing')).toHaveLength(1)
      }, 120_000)

      it('agy: a quota stop is read as a limit, and its exit step names the conversation the resume step then types, on the new sign-in', async () => {
        const { h } = world()
        const t = await openShell(shell, h)
        const start = launch(t, 'agy', 'agy')
        await untilBox(t, 'the mock agy box')
        expect(t.screen()).toContain(`${EMAILS.agyOne} (Google AI Pro)`)
        prompt(t, start, 'please hit the limit')
        const seen = await untilLimit(t, start)
        expect(stopKind(seen.status)).toBe('limit')
        expect(seen).toMatchObject({ agent: 'agy', live: true, turned: true })
        expect(seen.words).toMatch(/exhausted your quota on this model/)

        const ctx = { io: t.io(), start, env: {}, record: () => undefined }
        const exited = await runAgyStep({ terminalId: ID, targetId: ACCOUNT_IDS.agyTwo, shellType: shell.shellType, step: 'exit' }, ctx)
        expect(exited).toMatchObject({ kind: 'exited' })
        const conversation = exited.kind === 'exited' ? exited.conversationId : null
        expect(conversation).toMatch(/^[0-9a-f-]{36}$/)
        // The sign-in moves (Termpolis's hidden session does it); then the conversation resumes.
        writeFileSync(join(h.home, '.mock-agy.json'), JSON.stringify({ signedIn: true, email: EMAILS.agyTwo }))
        const resumed = await runAgyStep({ terminalId: ID, targetId: ACCOUNT_IDS.agyTwo, shellType: shell.shellType, step: 'resume', conversationId: conversation }, ctx)
        expect(resumed).toMatchObject({ kind: 'resumed', conversationId: conversation, shownEmail: EMAILS.agyTwo })
        expect(eventsOf(h, 'agy').filter((e) => e.event === 'start')[1]).toMatchObject({ resume: conversation })
        expect(eventsOf(h, 'agy').filter((e) => e.event === 'key')).toEqual([])
      }, 120_000)
    })
  }

  it('agy: the real hidden sign-in session signs the one Google sign-in out and in, relaying a pick and a code, and every agy started after shows the new email', async () => {
    const { h } = world()
    const mock = join(process.cwd(), 'e2e', 'mocks', 'mock-agents.cjs')
    const env = cleanEnv({ MOCK_AGENTS_HOME: h.home, MOCK_AGY_NEW_EMAIL: EMAILS.agyTwo })
    const sent: SignInState[] = []
    let signedInAs: string | null = 'none'
    const sessionDeps: SessionDeps = {
      spawn: (file, args, opts) => (pty as PtyModule).spawn(file, args as string[], opts as unknown as Record<string, unknown>) as unknown as PtyLike,
      killTree: (pid) => { killProcessTree(pid) },
      send: (st) => { sent.push(st) },
      openExternal: () => undefined,
      now: () => Date.now(),
      sleep,
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    }
    const until = async (kind: SignInPhase['kind'], ms = 40_000): Promise<SignInPhase> => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        const last = sent[sent.length - 1]?.phase
        if (last?.kind === kind) return last
        await sleep(100)
      }
      throw new Error(`no ${kind}: ${sent.map((x) => x.phase.kind).join(',')}`)
    }
    try {
      const s = startSignInSession({
        accountId: ACCOUNT_IDS.agyTwo, agent: 'agy', key: 'agy', mode: 'agy-switch', label: 'google-two',
        file: process.execPath, args: [mock, 'agy'], env, cwd: h.project,
        onAgySignedIn: (email) => { signedInAs = email },
      }, sessionDeps)
      // The session types /logout into the mock's box itself; the mock draws agy's sign-in screen.
      const choose = await until('choose') as Extract<SignInPhase, { kind: 'choose' }>
      expect(choose.question).toBe('Select login method:')
      expect(JSON.parse(readFileSync(join(h.home, '.mock-agy.json'), 'utf8'))).toMatchObject({ signedIn: false })
      expect(await signInInput(s.sessionId, { kind: 'pick', index: 0, label: 'Continue with Google' })).toEqual({ ok: true })
      await until('browser')
      expect(await signInInput(s.sessionId, { kind: 'code', value: 'good-code' })).toEqual({ ok: true })
      expect(await until('success')).toEqual({ kind: 'success', email: EMAILS.agyTwo })
      expect(signedInAs).toBe(EMAILS.agyTwo)
    } finally {
      endSignIns()
      _resetSignInSessionsForTest()
    }
    // The one Google sign-in is the new account's now, for every agy that starts.
    expect(JSON.parse(readFileSync(join(h.home, '.mock-agy.json'), 'utf8'))).toEqual({ signedIn: true, email: EMAILS.agyTwo })
    const spec: ShellSpec = { shellType: 'bash', family: 'posix', file: process.execPath, args: [mock, 'agy'] }
    const next = new RealTerminal(pty as PtyModule, spec, { cwd: h.project, env })
    terminals.push(next)
    await next.until(() => next.screen().includes(`${EMAILS.agyTwo} (Google AI Pro)`), 30_000, 'the new email in agy\'s header')
  }, 120_000)
})
