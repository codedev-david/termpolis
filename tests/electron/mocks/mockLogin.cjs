// Mock `claude auth login` and `codex login` for the hidden sign-in session's tests: never the real
// CLIs, which would sign an account in. Each prints its CLI's own first screen, word for word (Claude
// Code 2.1.309's, as captured; Codex 0.153.4's, from its program file), takes a pasted code where its
// CLI does, and succeeds or fails as MOCK_LOGIN_MODE says:
//   code        waits for a code: MOCK_GOOD_CODE ('good-code') signs in, anything else fails
//   callback    the browser hands the sign-in back by itself after MOCK_CALLBACK_MS (300)
//   nocallback  Claude Code's no-listener variant: the code is wanted
//   fail        the CLI's failure words, exit 1
//   silent      prints nothing, until it is ended
//   garbage     prints something no CLI prints
//   echo        a wrong code fails with an error line that repeats the code and holds a key-shaped string
// A sign-in that succeeds leaves `.mock-signed-in` in the profile folder (CLAUDE_CONFIG_DIR or
// CODEX_HOME) with the email, for a mock status command to read.
'use strict'

const fs = require('fs')
const path = require('path')

const CLAUDE_URL = (method, email) => (method === '--console' ? 'https://platform.claude.com/oauth/authorize' : 'https://claude.com/cai/oauth/authorize')
  + '?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback'
  + '&scope=user%3Aprofile+user%3Ainference&code_challenge=' + 'a'.repeat(43) + '&code_challenge_method=S256&state=' + 'b'.repeat(43)
  + (email ? '&login_hint=' + encodeURIComponent(email) : '') + (method === '--sso' ? '&login_method=sso' : '')
const CODEX_URL = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_' + 'c'.repeat(24)
  + '&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&code_challenge=' + 'a'.repeat(43) + '&state=' + 'b'.repeat(43)

/**
 * @param {{ write: (s: string) => void, exit: (code: number) => void, env: Record<string, string | undefined>, args: string[] }} io
 */
function createMockLogin(io) {
  const env = io.env
  const mode = env.MOCK_LOGIN_MODE || 'code'
  const codex = io.args[0] === 'login'
  const profile = codex ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR
  const signIn = () => {
    const email = env.MOCK_SIGNED_IN_EMAIL || 'person@example.test'
    if (profile) fs.writeFileSync(path.join(profile, '.mock-signed-in'), email)
    io.write(codex ? 'Successfully logged in\r\n' : '\r\nLogin successful\r\n')
    io.exit(0)
  }
  let line = ''
  const later = (fn) => setTimeout(fn, Number(env.MOCK_CALLBACK_MS || 300))
  if (mode === 'silent') return { input: () => undefined }
  if (mode === 'garbage') {
    io.write('Something no sign-in prints\r\n')
    return { input: () => undefined }
  }
  if (codex) {
    if (mode === 'fail') {
      io.write('Error logging in: Login was not completed\r\n')
      io.exit(1)
      return { input: () => undefined }
    }
    if (io.args.includes('--device-auth')) {
      io.write('\u001b[94mWelcome to Codex [v0.153.4]\u001b[0m\r\n\r\nFollow these steps to sign in with ChatGPT using device code authorization:\r\n\r\n'
        + '1. Open this link in your browser and sign in to your account\r\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\r\n\r\n'
        + '2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\r\n   \u001b[94mWXYZ-2345\u001b[0m\r\n\r\n'
        + '\u001b[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\u001b[0m\r\n')
    } else {
      io.write('Starting local login server on http://localhost:1455.\r\nIf your browser did not open, navigate to this URL to authenticate:\r\n\r\n'
        + CODEX_URL + '\r\n\r\nOn a remote or headless machine? Use `codex login --device-auth` instead.\r\n')
    }
    if (mode === 'callback') later(signIn)
    return { input: () => undefined }
  }
  const method = io.args[2]
  const email = io.args[3] === '--email' ? io.args[4] : ''
  io.write('\u001b[?25l\u001b[2J\u001b[m\u001b[H\u001b]0;claude\u0007\u001b[?25h')
  if (mode === 'fail') {
    io.write('Login failed: the sign-in was refused\r\n')
    io.exit(1)
    return { input: () => undefined }
  }
  if (mode === 'nocallback') {
    io.write("The browser can't return the sign-in to Claude Code automatically. After you sign in, paste the code shown.\r\nSign in at: "
      + CLAUDE_URL(method, email) + '\r\nPaste code here > ')
  } else {
    const url = CLAUDE_URL(method, email)
    io.write('Opening browser to sign in…\r\nIf the browser didn\'t open, visit: \u001b[94m\u001b]8;id=1000-1;' + url + '\u001b\\' + url + '\u001b[m\u001b]8;;\u001b\\\r\nPaste code here if prompted > ')
  }
  if (mode === 'callback') later(signIn)
  return {
    input: (data) => {
      for (const c of data) {
        if (c === '\r') {
          if (line === (env.MOCK_GOOD_CODE || 'good-code')) return signIn()
          if (mode === 'echo') {
            io.write('\r\nOAuth login failed: the code ' + line + ' was refused (sk-ant-oat01-' + 'a'.repeat(40) + ')\r\n')
            return io.exit(1)
          }
          io.write('\r\nOAuth login failed: Invalid code. Please make sure the full code was copied. Run with --debug for the underlying error\r\n')
          return io.exit(1)
        }
        line += c
        io.write(c)
      }
    },
  }
}

module.exports = { createMockLogin, CLAUDE_URL, CODEX_URL }

if (require.main === module) {
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  const login = createMockLogin({ write: (s) => process.stdout.write(s), exit: (code) => setTimeout(() => process.exit(code), 20), env: process.env, args: process.argv.slice(2) })
  process.stdin.on('data', (d) => login.input(String(d)))
}
