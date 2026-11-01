#!/usr/bin/env node
// A mock of the three coding agents Termpolis moves between accounts: Claude Code, Codex and agy
// (Termpolis's Gemini CLI). e2e/account-chooser.spec.ts runs it through e2e/test-shims-chooser, and
// tests/electron/accountsChooserE2eMock.test.ts proves, on a real PTY and a real shell, that the
// real switch engine and the real usage-limit look read its screens the way they read the CLIs'.
//
//   node mock-agents.cjs <claude|codex|agy> [the CLI's own arguments]
//   node mock-agents.cjs --print-screen <claude|codex|agy>   prints a usage-limit screen and ends
//
// It acts only inside a test home: the folder MOCK_AGENTS_HOME names, else TERMPOLIS_TEST_AGENT_HOME,
// HOME or USERPROFILE (Termpolis's identity checks and its hidden sign-in session run a CLI with
// HOME and USERPROFILE set to the test home and none of its own TERMPOLIS_ variables), and only when
// that folder holds a `.mock-agent-home` marker. Anywhere else it refuses, so it can never reach a
// real profile.
//
// What it draws are the layouts the real captures show (tests/fixtures, tests/electron/_switchTerminal.ts):
// each frame is a cleared screen with every row at its place, as ConPTY paints one. What it keeps:
//   <home>/.mock-control.json   knobs the spec changes between tests, read again at every Enter:
//        turnMs        how long a prompt takes (1200)
//        limitOn       a prompt matching this regexp source hits the usage limit ("limit")
//        menu          Claude Code's limit ends on its rate-limit menu, not on its reply (false)
//        ignoreExit    the exit command is taken and ignored: the agent stays up (false)
//        exitDelayMs   how long the agent takes to go after its exit command (300)
//        redrawLimit   a resumed Claude Code session draws the limit it stopped at again (false)
//   <home>/.mock-log.jsonl      one JSON line per event (start, line, key, exit, resume), for the spec
//   <home>/.mock-limited-<id>   the sessions that hit the limit: the prompt it stopped on (the transcript's last message)
//   <profile>/projects/mock-project/<id>.jsonl           Claude Code's transcript of a session
//   <profile>/sessions/2026/10/31/rollout-…-<id>.jsonl   Codex's rollout of a session
//   <profile>/.mock-login       the email a Codex profile is signed in to (`codex login status`)
//   <home>/.mock-agy.json       agy's ONE Google sign-in for the computer user: { signedIn, email }
'use strict'

const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')

const E = '\u001b'
const first = process.argv[2]
const printOnly = first === '--print-screen'
const agent = printOnly ? process.argv[3] : first
const argv = process.argv.slice(printOnly ? 4 : 3)

const VERSION = { claude: '2.1.309 (Claude Code)', codex: 'codex-cli 0.164.0', agy: '1.4.8' }
if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write(`${VERSION[agent] || 'mock'}\n`)
  process.exit(0)
}

// ---- The test home: this acts nowhere else ----------------------------------------------------
const HOME = (process.env.MOCK_AGENTS_HOME || process.env.TERMPOLIS_TEST_AGENT_HOME || process.env.HOME || process.env.USERPROFILE || '').trim()
if (!VERSION[agent] || !HOME || !fs.existsSync(path.join(HOME, '.mock-agent-home'))) {
  process.stderr.write('mock agent: not a test home (no .mock-agent-home there), so it refuses to run\n')
  process.exit(2)
}

const CONTROL = path.join(HOME, '.mock-control.json')
const LOG = path.join(HOME, '.mock-log.jsonl')

function control() {
  try { return JSON.parse(fs.readFileSync(CONTROL, 'utf8')) } catch { return {} }
}

function log(ev) {
  try { fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), agent, ...ev }) + '\n') } catch { /* the spec reads what got there */ }
}

// ---- Profiles ---------------------------------------------------------------------------------
const VARIABLE = agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : agent === 'codex' ? 'CODEX_HOME' : null
/** The profile as launched (CLAUDE_CONFIG_DIR / CODEX_HOME), or null: the default profile. */
const profile = VARIABLE ? process.env[VARIABLE] || null : null
const profileDir = VARIABLE ? profile || path.join(HOME, agent === 'claude' ? '.claude' : '.codex') : null
const profileName = profile ? path.basename(profile) : '(default)'

function claudeEmail() {
  const file = profile ? path.join(profile, '.claude.json') : path.join(HOME, '.claude.json')
  try {
    const email = JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount?.emailAddress
    return typeof email === 'string' ? email : ''
  } catch { return '' }
}

function codexEmail() {
  try { return fs.readFileSync(path.join(profileDir, '.mock-login'), 'utf8').trim() } catch { return '' }
}

function agyState() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, '.mock-agy.json'), 'utf8')) } catch {
    return { signedIn: true, email: process.env.MOCK_AGY_EMAIL || 'g1@example.test' }
  }
}

function saveAgyState(s) {
  try { fs.writeFileSync(path.join(HOME, '.mock-agy.json'), JSON.stringify(s)) } catch { /* the spec reads what got there */ }
}

function findTranscript(id) {
  if (!profileDir) return null
  if (agent === 'claude') {
    const root = path.join(profileDir, 'projects')
    try {
      for (const d of fs.readdirSync(root)) {
        const f = path.join(root, d, `${id}.jsonl`)
        if (fs.existsSync(f)) return f
      }
    } catch { /* no projects folder */ }
    return null
  }
  const walk = (dir, depth) => {
    let names = []
    try { names = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
    for (const n of names) {
      const p = path.join(dir, n.name)
      if (n.isDirectory() && depth < 5) {
        const r = walk(p, depth + 1)
        if (r) return r
      } else if (n.name.endsWith(`-${id}.jsonl`)) return p
    }
    return null
  }
  return walk(path.join(profileDir, 'sessions'), 0)
}

function appendTranscript(id, text) {
  if (!profileDir) return
  const file = agent === 'claude'
    ? path.join(profileDir, 'projects', 'mock-project', `${id}.jsonl`)
    : path.join(profileDir, 'sessions', '2026', '10', '31', `rollout-2026-10-31T00-00-00-${id}.jsonl`)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify({ role: 'user', text }) + '\n')
  } catch { /* the resume will say it found nothing */ }
}

// ---- One-shot commands: what Termpolis asks a CLI about itself ---------------------------------
if (agent === 'claude' && argv[0] === 'auth' && argv[1] === 'status') {
  const email = claudeEmail()
  if (email) {
    process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email, subscriptionType: 'max' }) + '\n')
    process.exit(0)
  }
  process.stdout.write(JSON.stringify({ loggedIn: false }) + '\n')
  process.exit(1)
}

if (agent === 'codex' && argv[0] === 'login' && argv[1] === 'status') {
  if (codexEmail()) {
    process.stderr.write('Logged in using ChatGPT\n')
    process.exit(0)
  }
  process.stderr.write('Not logged in\n')
  process.exit(1)
}

if (agent === 'codex' && argv[0] === 'app-server') {
  // initialize, then account/read: the two requests Termpolis sends (accountIdentity.ts).
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id === 1) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { userAgent: 'termpolis/0.164.0 (mock)' } }) + '\n')
      if (msg.id === 2) {
        const email = codexEmail()
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { account: email ? { type: 'chatgpt', email, planType: 'plus' } : null } }) + '\n')
      }
    }
  })
  process.stdin.on('end', () => process.exit(0))
  return
}

// ---- What each agent draws ---------------------------------------------------------------------
const WIDTH = 56
const RULE = '─'.repeat(WIDTH)
const GLYPH = { claude: '❯', codex: '›', agy: '>' }
const FOOTER = {
  claude: '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  codex: '  gpt-5.6-sol medium · ~/repo',
  agy: '? for shortcuts                                          Gemini 4 Argon · medium',
}
const EXIT_COMMANDS = ['/exit', '/quit']
const RESET = '3pm (America/New_York)'

/** The rows a usage limit leaves in the transcript, as each CLI prints them. */
function limitRows() {
  if (agent === 'claude') {
    return [
      `  ⎿  You've hit your session limit · resets ${RESET}`,
      "     /upgrade or /usage-credits to finish what you're working on.",
      '',
      '✻ Crunched for 0s · done 1:21 AM',
      '',
    ]
  }
  if (agent === 'codex') {
    return ["■ You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:04 PM.", '']
  }
  return ['✕ You have exhausted your quota on this model.', '']
}

/** Claude Code's rate-limit menu: it takes the place of the box (tests/fixtures rateLimitMenu). */
function menuRows() {
  return ['❯ hi', `  ⎿  You've hit your session limit · resets ${RESET}`, '', '❯ /rate-limit-options', '', RULE, '  What do you want to do?', '', '  ❯ 1. Stop and wait for limit to reset', '    2. Add funds to continue with usage credits', '', '  Enter to confirm · Esc to cancel']
}

if (printOnly) {
  process.stdout.write([`${GLYPH[agent]} hit the limit`, ...(agent === 'claude' ? [] : ['']), ...limitRows(), RULE, `${GLYPH[agent]} `, RULE, FOOTER[agent]].join('\r\n') + '\r\n')
  process.exit(0)
}

// ---- The session --------------------------------------------------------------------------------
const flag = (names) => {
  for (const n of names) {
    const i = argv.indexOf(n)
    if (i >= 0 && argv[i + 1]) return argv[i + 1]
  }
  return undefined
}
const resumeId = agent === 'claude' ? flag(['--resume', '-r'])
  : agent === 'codex' ? (argv.indexOf('resume') >= 0 ? argv[argv.indexOf('resume') + 1] : undefined)
    : (argv.find((a) => a.startsWith('--conversation=')) || '').slice('--conversation='.length) || undefined
const sessionId = resumeId || (agent === 'claude' ? flag(['--session-id']) : undefined) || randomUUID()

log({ event: 'start', profile: profileName, profileDir, args: argv, session: sessionId, resume: resumeId || null, limitChooser: process.env.TERMPOLIS_LIMIT_CHOOSER || null, cwd: process.cwd() })

// agy keeps ONE Google sign-in for the computer user. Signed out (or signing in, in Termpolis's
// hidden session), it is the sign-in mock the session tests drive.
const SIGN_IN_MOCK = path.join(__dirname, '..', '..', 'tests', 'electron', 'mocks', 'mockAgy.cjs')
let delegate = null

function startSignInMock(signedIn) {
  const { createMockAgy } = require(SIGN_IN_MOCK)
  const saved = agyState()
  const write = (s) => {
    process.stdout.write(s)
    // Its sign-in went through: the new account is the computer user's, for every agy that starts.
    if (s.includes('Authentication successful!')) setImmediate(() => saveAgyState({ signedIn: true, email: delegate.state.email }))
  }
  delegate = createMockAgy({
    write,
    exit: (code) => setTimeout(() => process.exit(code), 20),
    env: { ...process.env, MOCK_AGY_SIGNED_IN: signedIn ? '1' : '0', MOCK_AGY_EMAIL: saved.email },
  })
}

let resumed = false
let box = ''
let busy = false
let menuOpen = false
const history = []

if (resumeId) {
  if (agent !== 'agy' && !findTranscript(resumeId)) {
    log({ event: 'resume-missing', session: resumeId })
    process.stdout.write(agent === 'claude'
      ? `No conversation found with session ID: ${resumeId}\r\n`
      : `ERROR: No saved session found with ID ${resumeId}. Run \`codex resume\` without an ID to choose from existing sessions.\r\n`)
    process.exit(1)
  }
  resumed = true
  log({ event: 'resume', session: resumeId, profile: profileName })
  // Claude Code draws the limit its transcript ends with again, under the prompt it stopped (R4).
  if (agent === 'claude' && control().redrawLimit) {
    let stoppedOn = null
    try { stoppedOn = fs.readFileSync(path.join(HOME, `.mock-limited-${resumeId}`), 'utf8') } catch { /* it never hit one */ }
    if (stoppedOn !== null) history.push(`${GLYPH.claude} ${stoppedOn}`, ...limitRows())
  }
}

function rows() {
  const sid = sessionId.slice(0, 8)
  const marker = resumed ? [`resumed ${sid} on ${profileName}`] : []
  if (agent === 'agy') {
    const email = agyState().email
    return ['      ▄▀▀▄        Antigravity CLI 1.4.3', `     ▀▀▀▀▀▀       ${email} (Google AI Pro)`, ...marker, '', ...history, RULE, `> ${box}`, RULE, FOOTER.agy]
  }
  const above = busy
    ? [agent === 'codex' ? '• Working (12s • esc to interrupt)' : '✻ Thinking… (2s · esc to interrupt)', '']
    : []
  if (agent === 'codex') {
    const popup = box.startsWith('/') ? ['  /quit   exit Codex'] : []
    return ['>_ OpenAI Codex (v0.164.0 mock)', `profile: ${profileName}`, ...marker, '', ...history, ...above, `› ${box || 'Ask Codex to do anything'}`, ...popup, '', FOOTER.codex]
  }
  const head = ['▐▛███▜▌ Claude Code v2.1.309 (mock)', `profile: ${profileName}`, ...marker, '']
  if (menuOpen) return [...head, ...history, ...menuRows()]
  return [...head, ...history, ...above, RULE, `❯ ${box}`, RULE, FOOTER.claude]
}

function paint() {
  process.stdout.write(`${E}[H${E}[2J` + rows().map((r, i) => `${E}[${i + 1};1H${r}`).join(''))
}

function hint() {
  if (agent === 'claude') return `\r\n${E}[2m\r\nResume this session with:\r\nclaude --resume ${sessionId}\r\n${E}[22m`
  if (agent === 'codex') return `\r\nTo continue this session, run:\r\ncodex resume ${sessionId}\r\n`
  return `\r\nResume with -c (or command below):\r\nagy --conversation=${sessionId}\r\n`
}

function turn(text) {
  const c = control()
  busy = true
  // Claude Code draws a reply right under the prompt's echo; Codex and agy put a blank row between
  // one cell of the transcript and the next.
  history.push(`${GLYPH[agent]} ${text}`, ...(agent === 'claude' ? [] : ['']))
  appendTranscript(sessionId, text)
  paint()
  setTimeout(() => {
    busy = false
    let hit = false
    try { hit = new RegExp(c.limitOn || 'limit', 'i').test(text) } catch { hit = /limit/i.test(text) }
    if (hit) {
      try { fs.writeFileSync(path.join(HOME, `.mock-limited-${sessionId}`), text) } catch { /* the redraw just won't happen */ }
      log({ event: 'limit', session: sessionId })
      if (agent === 'claude' && c.menu) menuOpen = true
      else history.push(...limitRows())
    } else history.push('● Done.', '')
    while (history.length > 12) history.shift()
    paint()
  }, typeof c.turnMs === 'number' ? c.turnMs : 1200)
}

function submit(raw) {
  const text = raw.trim()
  box = ''
  log({ event: 'line', text })
  if (EXIT_COMMANDS.includes(text)) {
    const c = control()
    if (c.ignoreExit) {
      log({ event: 'exit-ignored' })
      paint()
      return
    }
    log({ event: 'exit', session: sessionId, profile: profileName })
    paint()
    setTimeout(() => {
      process.stdout.write(hint())
      process.exit(0)
    }, typeof c.exitDelayMs === 'number' ? c.exitDelayMs : 300)
    return
  }
  if (agent === 'agy' && (text === '/logout' || text === '/login')) {
    // Termpolis's hidden agy: sign out, and the user signs in again.
    saveAgyState({ signedIn: false, email: agyState().email })
    log({ event: text.slice(1) })
    startSignInMock(false)
    return
  }
  if (text && !text.startsWith('/')) return turn(text)
  paint()
}

function onInput(data) {
  if (delegate) return delegate.input(data)
  for (const ch of data) {
    if (busy) {
      if (ch === E) log({ event: 'key', key: 'Esc' })
      continue
    }
    if (ch === '\r') submit(box)
    else if (ch === '\u007f' || ch === '\b') { box = box.slice(0, -1); paint() }
    else if (ch === '\u0015') { box = ''; paint() }
    else if (ch === '\u0003') log({ event: 'key', key: '^C' })
    else if (ch === '\u0004') log({ event: 'key', key: '^D' })
    else if (ch === E) {
      log({ event: 'key', key: 'Esc' })
      if (menuOpen) { menuOpen = false; paint() }
    } else if (ch >= ' ') { box += ch; paint() }
  }
}

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => onInput(String(d)))
process.stdin.on('end', () => process.exit(0))
process.stdout.on('resize', () => { if (!delegate) paint() })

if (agent === 'agy' && !agyState().signedIn) startSignInMock(false)
else paint()
