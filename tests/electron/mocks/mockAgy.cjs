// A mock agy for the hidden sign-in session's tests: never the real agy, whose sign-in signs the
// computer user's one Google sign-in out and in. It draws what agy's program file and its real
// trust menu show (tests/fixtures/signInScreens.json's _about): its header with the signed-in email,
// its input box between two rules, its sign-in screens with "> " on the highlighted option and
// "↑/↓ Navigate · enter Confirm" under them, its paste field, "Authentication successful!", and its
// exit hint. It runs in-process behind a fake PTY (createMockAgy) or as a script behind node-pty.
'use strict'

const RULE = '─'.repeat(80)
const UUID = '0b7a3c1e-5d2f-4e8a-9c6b-1f2e3d4c5b6a'

/**
 * @param {{ write: (s: string) => void, exit: (code: number) => void, env?: Record<string, string | undefined> }} io
 */
function createMockAgy(io) {
  const env = io.env || {}
  const st = {
    signedIn: env.MOCK_AGY_SIGNED_IN !== '0',
    email: env.MOCK_AGY_EMAIL || 'old.person@example.test',
    newEmail: env.MOCK_AGY_NEW_EMAIL || 'new.person@example.test',
    goodCode: env.MOCK_AGY_GOOD_CODE || 'good-code',
    // Where agy goes after /logout: its sign-in screen, or ('box') back to its box.
    afterLogout: env.MOCK_AGY_AFTER_LOGOUT || 'sign-in',
    ignoreArrows: env.MOCK_AGY_IGNORE_ARROWS === '1',
    screen: env.MOCK_AGY_TRUST === '1' ? 'trust' : 'main',
    sel: 0,
    text: '',
    error: '',
  }
  const menus = {
    trust: { q: 'Do you trust the contents of this project?', detail: 'Antigravity CLI requires permission to read, edit, and execute files here.', options: ['Yes, I trust this folder', 'No, exit'] },
    login: { q: 'Select login method:', options: ['Continue with Google', 'Use a Google Cloud project', 'Other sign-in options'] },
    gcp: { q: 'Select Google Cloud sign-in method:', options: ['Continue with Google Cloud', 'Continue with Advanced SSO'] },
    license: { q: 'Select available license:', options: ['Gemini Code Assist Standard', 'Gemini Code Assist Enterprise'] },
  }
  const frame = (body) => io.write('\u001b[2J\u001b[3J\u001b[H' + body)
  const header = () => '      ▄▀▀▄        Antigravity CLI 1.4.3\r\n'
    + (st.signedIn ? `     ▀▀▀▀▀▀       ${st.email} (Google AI Pro)\r\n` : '\r\n')
    + '    ▀▀▀▀▀▀▀▀      Gemini 4 Argon (Medium)\r\n\r\n'
  const menu = (m) => {
    const rows = [m.q, '']
    if (m.detail) rows.push(m.detail, '')
    m.options.forEach((o, i) => rows.push((i === st.sel ? '> ' : '  ') + o))
    rows.push('', '  ↑/↓ Navigate · enter Confirm')
    return rows.join('\r\n') + '\r\n'
  }
  const draw = () => {
    const err = st.error ? `${st.error}\r\n\r\n` : ''
    switch (st.screen) {
      case 'main':
        return frame(header() + RULE + '\r\n> ' + st.text + '\r\n' + RULE + '\r\n? for shortcuts                                          Gemini 4 Argon · medium\r\n')
      case 'signedOut':
        return frame(err + 'Welcome back! You are currently not signed in.\r\n\r\n' + menu(menus.login))
      case 'trust': case 'gcp': case 'license':
        return frame(menu(menus[st.screen]))
      case 'project':
        return frame('Use a Google Cloud project\r\n\r\n> ' + (st.text || 'project id...') + '\r\n\r\n  enter Confirm · esc Back\r\n')
      case 'paste':
        return frame(err + 'Signing in...\r\n\r\nOpen the following URL in your local browser to authenticate:\r\n\r\n'
          + 'https://accounts.google.com/o/oauth2/auth?client_id=1&response_type=code&scope=openid&state=' + 'b'.repeat(43) + '\r\n\r\n'
          + 'Or, paste the authorization code here and press Enter:\r\n> ' + st.text + '\r\n')
      default:
        return frame('Signing in...\r\n')
    }
  }
  const go = (screen) => {
    st.screen = screen
    st.sel = 0
    st.text = ''
    draw()
  }
  const signedInNow = () => {
    io.write('Authentication successful!\r\n')
    st.signedIn = true
    st.email = st.newEmail
    setTimeout(() => go('main'), 50)
  }
  const choose = () => {
    const option = (st.screen === 'trust' ? menus.trust : st.screen === 'signedOut' ? menus.login : menus[st.screen]).options[st.sel]
    if (st.screen === 'trust') return option.startsWith('Yes') ? go('main') : io.exit(1)
    if (option === 'Continue with Google') {
      go('signing')
      return setTimeout(() => go('paste'), 50)
    }
    if (option === 'Use a Google Cloud project') return go('project')
    if (option === 'Other sign-in options') return go('gcp')
    if (st.screen === 'gcp') return go('paste')
    return signedInNow()
  }
  const enter = () => {
    if (st.screen === 'main') {
      const cmd = st.text.trim()
      st.text = ''
      if (cmd === '/exit') {
        io.write(`\r\nResume with -c (or command below):\r\n  agy --conversation=${UUID}\r\n`)
        return io.exit(0)
      }
      if (cmd === '/logout') {
        st.signedIn = false
        return st.afterLogout === 'box' ? draw() : go('signedOut')
      }
      if (cmd === '/login') return go('signedOut')
      return draw()
    }
    if (st.screen === 'paste') {
      if (st.text === st.goodCode) return signedInNow()
      st.error = 'Error: authentication interrupted.'
      st.text = ''
      return draw()
    }
    if (st.screen === 'project') return st.text ? go('license') : draw()
    return choose()
  }
  const onInput = (data) => {
    for (let i = 0; i < data.length; i++) {
      const rest = data.slice(i)
      const arrow = /^\u001b(?:\[|O)([AB])/.exec(rest)
      if (arrow) {
        i += arrow[0].length - 1
        const m = st.screen === 'trust' ? menus.trust : st.screen === 'signedOut' ? menus.login : menus[st.screen]
        if (!m || st.ignoreArrows) continue
        st.sel = Math.max(0, Math.min(m.options.length - 1, st.sel + (arrow[1] === 'B' ? 1 : -1)))
        draw()
        continue
      }
      const c = data[i]
      if (c === '\r') enter()
      else if (c === '\u0015') { st.text = ''; draw() }
      else if (c === '\u001b') { /* Esc: nothing */ }
      else if (c >= ' ' && (st.screen === 'main' || st.screen === 'paste' || st.screen === 'project')) { st.text += c; draw() }
    }
  }
  if (st.screen === 'main' && !st.signedIn) st.screen = 'signedOut'
  setTimeout(draw, 20)
  return { input: onInput, state: st }
}

module.exports = { createMockAgy, MOCK_AGY_CONVERSATION: UUID }

if (require.main === module) {
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  const agy = createMockAgy({ write: (s) => process.stdout.write(s), exit: (code) => setTimeout(() => process.exit(code), 20), env: process.env })
  process.stdin.on('data', (d) => agy.input(String(d)))
}
