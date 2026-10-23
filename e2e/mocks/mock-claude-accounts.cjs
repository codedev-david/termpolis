#!/usr/bin/env node
// A mock `claude` for the account UI's e2e spec (accounts-ui.spec.ts): never the real CLI, which
// would sign an account in. `auth login` is the sign-in session's own mock (its first screen word
// for word, a pasted code, success or failure as MOCK_LOGIN_MODE says), and leaves
// `.mock-signed-in` in the profile folder; `auth status --json` reads that back, as Claude Code's
// own status command answers; `--version` names a version. Anything else prints one line and ends.
'use strict'

const fs = require('fs')
const path = require('path')
const { createMockLogin } = require('../../tests/electron/mocks/mockLogin.cjs')

const args = process.argv.slice(2)

/** The profile folder this run is on: CLAUDE_CONFIG_DIR, else the default one under HOME. */
function profileDir() {
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR
  return path.join(process.env.HOME || process.env.USERPROFILE || '.', '.claude')
}

if (args[0] === '--version') {
  process.stdout.write('2.1.309 (Claude Code)\n')
  process.exit(0)
}

if (args[0] === 'auth' && args[1] === 'status') {
  let email = ''
  try { email = fs.readFileSync(path.join(profileDir(), '.mock-signed-in'), 'utf8').trim() } catch { /* signed out */ }
  if (email) {
    process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email, subscriptionType: 'max' }) + '\n')
    process.exit(0)
  }
  process.stdout.write(JSON.stringify({ loggedIn: false }) + '\n')
  process.exit(1)
}

if (args[0] === 'auth' && args[1] === 'login') {
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  const login = createMockLogin({ write: (s) => process.stdout.write(s), exit: (code) => setTimeout(() => process.exit(code), 20), env: process.env, args })
  process.stdin.on('data', (d) => login.input(String(d)))
} else {
  process.stdout.write('mock claude for the account UI spec: nothing to do for ' + JSON.stringify(args) + '\n')
  process.exit(0)
}
