// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, dirname, join } from 'path'
import {
  ACCOUNT_AGENTS, ACCOUNTS_IPC, PROFILE_AGENTS, PROFILE_VARIABLE, SHAREABLE_FOLDERS, accountEnv, accountLine,
  cleanLabel, familyOf, hasControlChars, isPlainEmail, isProfileAgent, signInArgs, slugOf, tildifyPath,
} from '../../src/shared/agentAccounts'
import type { AccountEnv, ShellFamily } from '../../src/shared/agentAccounts'

describe('agents and their profiles', () => {
  it('knows the three agents, and that only Claude Code and Codex have profile folders', () => {
    expect(ACCOUNT_AGENTS).toEqual(['claude', 'codex', 'agy'])
    expect(PROFILE_AGENTS).toEqual(['claude', 'codex'])
    expect(isProfileAgent('claude')).toBe(true)
    expect(isProfileAgent('codex')).toBe(true)
    expect(isProfileAgent('agy')).toBe(false)
    expect(PROFILE_VARIABLE).toEqual({ claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' })
  })

  it('shares projects, commands, skills and agents by default, plugins and hooks only when asked, and Codex sessions', () => {
    const on = (a: 'claude' | 'codex') => SHAREABLE_FOLDERS[a].filter((f) => f.on).map((f) => f.name)
    expect(on('claude')).toEqual(['projects', 'commands', 'skills', 'agents'])
    expect(SHAREABLE_FOLDERS.claude.filter((f) => !f.on).map((f) => f.name)).toEqual(['plugins', 'hooks'])
    expect(on('codex')).toEqual(['sessions'])
  })

  it('names every IPC channel under accounts:', () => {
    for (const ch of Object.values(ACCOUNTS_IPC)) expect(ch).toMatch(/^accounts:[a-z-]+$/)
    expect(new Set(Object.values(ACCOUNTS_IPC)).size).toBe(Object.values(ACCOUNTS_IPC).length)
  })
})

describe('isPlainEmail', () => {
  it('takes plain addresses', () => {
    for (const e of ['a@b.co', 'first.last+tag@example.test', 'x_y%z@sub.example.org']) expect(isPlainEmail(e)).toBe(true)
  })

  it('refuses anything a shell or a page could read as more than an address', () => {
    for (const e of ['', 'no-at', 'a@b', 'a b@c.de', 'a@b.c', "o'x@y.zz", 'a@b.co\n', '$(id)@x.yy', 'a@b.co; rm', 42, null, undefined, 'a'.repeat(250) + '@x.yy']) {
      expect(isPlainEmail(e)).toBe(false)
    }
  })
})

describe('labels and slugs', () => {
  it('trims a label and refuses an empty, overlong or control-character one', () => {
    expect(cleanLabel('  codedev ')).toBe('codedev')
    expect(cleanLabel('')).toBeNull()
    expect(cleanLabel('   ')).toBeNull()
    expect(cleanLabel('x'.repeat(41))).toBeNull()
    expect(cleanLabel('a\u0007b')).toBeNull()
    expect(cleanLabel(7)).toBeNull()
  })

  it('makes a folder-name part of [a-z0-9-]{1,32} from a label', () => {
    expect(slugOf('codedev')).toBe('codedev')
    expect(slugOf('My Work Account')).toBe('my-work-account')
    expect(slugOf('José & Co')).toBe('jose-co')
    expect(slugOf('Café')).toBe('cafe')
    expect(slugOf('a'.repeat(40))).toBe('a'.repeat(32))
    expect(slugOf('x'.repeat(31) + ' y')).toBe('x'.repeat(31))
    expect(slugOf('日本')).toBeNull()
    expect(slugOf('---')).toBeNull()
  })

  it('finds control characters, C0, DEL and C1', () => {
    expect(hasControlChars('ok')).toBe(false)
    for (const c of ['\u0000', '\n', '\r', '\u001b', '\u007f', '\u0085', '\u009b']) expect(hasControlChars(`a${c}b`)).toBe(true)
  })
})

describe('familyOf', () => {
  it('maps Termpolis shell types to the three families', () => {
    expect(familyOf('bash')).toBe('posix')
    expect(familyOf('zsh')).toBe('posix')
    expect(familyOf('gitbash')).toBe('posix')
    expect(familyOf('powershell')).toBe('powershell')
    expect(familyOf('cmd')).toBe('cmd')
  })

  it('knows no family for a shell type it has never seen', () => {
    expect(familyOf('fish')).toBeNull()
    expect(familyOf('')).toBeNull()
  })
})

describe('accountEnv', () => {
  it('sets the variable for an account with a profile folder', () => {
    expect(accountEnv({ agent: 'claude', profile: 'C:\\Users\\me\\.claude-codedev' }, 'claude'))
      .toEqual({ set: { CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude-codedev' }, unset: [] })
    expect(accountEnv({ agent: 'codex', profile: '/home/me/.codex-work' }, 'codex'))
      .toEqual({ set: { CODEX_HOME: '/home/me/.codex-work' }, unset: [] })
  })

  it('UNSETS the variable for the default profile and for no account at all: never an empty value', () => {
    expect(accountEnv({ agent: 'claude', profile: null }, 'claude')).toEqual({ set: {}, unset: ['CLAUDE_CONFIG_DIR'] })
    expect(accountEnv(null, 'codex')).toEqual({ set: {}, unset: ['CODEX_HOME'] })
    // An empty string is not a profile: it unsets too.
    expect(accountEnv({ agent: 'claude', profile: '' }, 'claude')).toEqual({ set: {}, unset: ['CLAUDE_CONFIG_DIR'] })
    for (const e of [accountEnv(null, 'claude'), accountEnv({ agent: 'claude', profile: '' }, 'claude')]) {
      expect(Object.values(e.set)).not.toContain('')
    }
  })

  it('gives agy nothing, and adds extra variables to unset once each', () => {
    expect(accountEnv({ agent: 'agy', profile: null }, 'agy')).toEqual({ set: {}, unset: [] })
    expect(accountEnv({ agent: 'claude', profile: '/p' }, 'claude', ['ANTHROPIC_BASE_URL', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR']))
      .toEqual({ set: { CLAUDE_CONFIG_DIR: '/p' }, unset: ['ANTHROPIC_BASE_URL'] })
    expect(accountEnv(null, 'claude', ['CLAUDE_CONFIG_DIR', 'TERMPOLIS_HEADROOM_PROXY']))
      .toEqual({ set: {}, unset: ['CLAUDE_CONFIG_DIR', 'TERMPOLIS_HEADROOM_PROXY'] })
  })
})

const set = (p: string): AccountEnv => ({ set: { CLAUDE_CONFIG_DIR: p }, unset: [] })
const unset: AccountEnv = { set: {}, unset: ['CLAUDE_CONFIG_DIR'] }
const lineOf = (family: ShellFamily, env: AccountEnv, cmd = 'claude'): string => {
  const r = accountLine(family, env, cmd)
  if ('refused' in r) throw new Error(`refused: ${r.refused}`)
  return r.line
}

describe('accountLine: the exact fail-closed forms (R1)', () => {
  it('posix: export … && <cmd>, and unset … && <cmd> for the default profile', () => {
    expect(lineOf('posix', set('/home/me/.claude-codedev'))).toBe("export CLAUDE_CONFIG_DIR='/home/me/.claude-codedev' && claude")
    expect(lineOf('posix', unset)).toBe('unset CLAUDE_CONFIG_DIR && claude')
  })

  it('PowerShell: & { $env:… = …; <cmd> }, and Remove-Item Env:… for the default profile', () => {
    expect(lineOf('powershell', set('C:\\Users\\me\\.claude-codedev'))).toBe("& { $env:CLAUDE_CONFIG_DIR = 'C:\\Users\\me\\.claude-codedev'; claude }")
    expect(lineOf('powershell', unset)).toBe('& { Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; claude }')
  })

  it('cmd: set "…" && call <cmd>, and set "X=" for the default profile', () => {
    expect(lineOf('cmd', set('C:\\Users\\me\\.claude-codedev'))).toBe('set "CLAUDE_CONFIG_DIR=C:\\Users\\me\\.claude-codedev" && call claude')
    expect(lineOf('cmd', unset)).toBe('set "CLAUDE_CONFIG_DIR=" && call claude')
  })

  it('chains several assignments in each family, sets first', () => {
    const env: AccountEnv = { set: { CODEX_HOME: '/h' }, unset: ['A_VAR', 'B_VAR'] }
    expect(lineOf('posix', env, 'codex')).toBe("export CODEX_HOME='/h' && unset A_VAR B_VAR && codex")
    expect(lineOf('powershell', env, 'codex')).toBe("& { $env:CODEX_HOME = '/h'; Remove-Item Env:A_VAR -ErrorAction SilentlyContinue; Remove-Item Env:B_VAR -ErrorAction SilentlyContinue; codex }")
    expect(lineOf('cmd', env, 'codex')).toBe('set "CODEX_HOME=/h" && set "A_VAR=" && set "B_VAR=" && call codex')
  })

  it('quotes a hostile path so each shell takes it as it is', () => {
    const p = "C:\\Users\\O'Brien José & Co\\$x `y` ‘z’\\.claude"
    expect(lineOf('posix', set(p))).toBe(`export CLAUDE_CONFIG_DIR='C:\\Users\\O'\\''Brien José & Co\\$x \`y\` ‘z’\\.claude' && claude`)
    expect(lineOf('powershell', set(p))).toBe("& { $env:CLAUDE_CONFIG_DIR = 'C:\\Users\\O''Brien José & Co\\$x `y` ‘‘z’’\\.claude'; claude }")
    // cmd takes everything inside set "…" literally, & included.
    expect(lineOf('cmd', set("C:\\Users\\O'Brien & Co\\.claude"))).toBe('set "CLAUDE_CONFIG_DIR=C:\\Users\\O\'Brien & Co\\.claude" && call claude')
  })

  it('keeps an accented letter in whichever form it was given (the profile string is stored NFC)', () => {
    const nfc = '/home/jos\u00e9/.claude-x'
    const nfd = '/home/jose\u0301/.claude-x'
    expect(lineOf('posix', set(nfc))).toContain(nfc)
    expect(lineOf('posix', set(nfd))).toContain(nfd)
  })

  it('refuses a control character anywhere, and types nothing', () => {
    for (const fam of ['posix', 'powershell', 'cmd'] as const) {
      expect(accountLine(fam, set('/a\nb'), 'claude')).toEqual({ refused: 'the line would hold a control character' })
      expect(accountLine(fam, set('/a'), 'claude\r--x')).toEqual({ refused: 'the line would hold a control character' })
      expect(accountLine(fam, set('/a\u001b[2J'), 'claude')).toHaveProperty('refused')
    }
  })

  it('refuses for cmd a double quote in a value, and a % or ! anywhere, which cmd would expand', () => {
    expect(accountLine('cmd', set('C:\\a"b'), 'claude')).toEqual({ refused: 'cmd can\'t take a folder whose name holds a double quote' })
    expect(accountLine('cmd', set('C:\\%USERPROFILE%'), 'claude')).toEqual({ refused: 'cmd would expand a % or ! in the line' })
    expect(accountLine('cmd', set('C:\\a!b'), 'claude')).toEqual({ refused: 'cmd would expand a % or ! in the line' })
    expect(accountLine('cmd', set('C:\\a'), 'claude --x %PATH%')).toEqual({ refused: 'cmd would expand a % or ! in the line' })
    // The other families take them, quoted.
    expect(lineOf('posix', set('C:\\a"b%c!d'))).toBe("export CLAUDE_CONFIG_DIR='C:\\a\"b%c!d' && claude")
    expect(lineOf('powershell', set('C:\\a"b%c!d'))).toBe("& { $env:CLAUDE_CONFIG_DIR = 'C:\\a\"b%c!d'; claude }")
  })

  it('refuses an empty command and a variable name that is not a plain name', () => {
    expect(accountLine('posix', set('/a'), '  ')).toEqual({ refused: 'there is no command to run' })
    expect(accountLine('posix', { set: { 'A B': '/x' }, unset: [] }, 'claude')).toEqual({ refused: 'a variable name is not a plain name' })
    expect(accountLine('powershell', { set: {}, unset: ['X;rm'] }, 'claude')).toEqual({ refused: 'a variable name is not a plain name' })
  })
})

describe('signInArgs', () => {
  it("is the CLI's own sign-in as arguments, claude.ai by default, with the email when it is plainly an address", () => {
    expect(signInArgs('claude')).toEqual(['auth', 'login', '--claudeai'])
    expect(signInArgs('claude', 'claudeai', 'me@example.test')).toEqual(['auth', 'login', '--claudeai', '--email', 'me@example.test'])
    expect(signInArgs('claude', 'console', 'me@example.test')).toEqual(['auth', 'login', '--console', '--email', 'me@example.test'])
    expect(signInArgs('claude', 'sso')).toEqual(['auth', 'login', '--sso'])
    // An email that isn't plainly an address is left off: no shell reads these, but the CLI does.
    expect(signInArgs('claude', undefined, "x'; id; '@a.bc")).toEqual(['auth', 'login', '--claudeai'])
    expect(signInArgs('claude', undefined, 'a%b@c.de')).toEqual(['auth', 'login', '--claudeai', '--email', 'a%b@c.de'])
  })

  it('is codex login, with --device-auth for a device code, and never a credential flag', () => {
    expect(signInArgs('codex')).toEqual(['login'])
    expect(signInArgs('codex', 'browser', 'x@y.zz')).toEqual(['login'])
    expect(signInArgs('codex', 'device')).toEqual(['login', '--device-auth'])
    for (const m of ['claudeai', 'console', 'sso', 'browser', 'device'] as const) {
      for (const a of ['claude', 'codex'] as const) {
        expect(signInArgs(a, m, 'x@y.zz').join(' ')).not.toMatch(/setup-token|with-api-key|with-access-token/)
      }
    }
  })
})
describe('tildifyPath', () => {
  it('writes the home folder as ~, case-insensitively on Windows', () => {
    expect(tildifyPath('C:\\Users\\Me\\.claude-x', 'C:\\Users\\me')).toBe('~\\.claude-x')
    expect(tildifyPath('C:\\Users\\me', 'C:\\Users\\me\\')).toBe('~')
    expect(tildifyPath('/home/me/.codex-w', '/home/me')).toBe('~/.codex-w')
    expect(tildifyPath('/home/meme/x', '/home/me')).toBe('/home/meme/x')
    expect(tildifyPath('/Home/me/x', '/home/me')).toBe('/Home/me/x')
    expect(tildifyPath('/x', '')).toBe('/x')
    expect(tildifyPath('', '/home/me')).toBe('')
  })
})

// The review probe's matrix (review-cross-shell-probe.cjs), on the real accountLine: each family's
// line, fed to each shell that exists here as typed input would be, with a neutral variable and a
// marker script instead of an agent. In its own shell the line runs the marker with the variable
// set (or unset) and the setting persists; in the other two families nothing runs at all.
const VALUE = "C:\\Users\\x\\O'Brien & Co\\.claude-fresh"
const VAR = 'TP_PROBE_DIR'

interface Shell { name: string; family: ShellFamily; exe: string; args: string[] }

function findShells(): Shell[] {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows'
  const candidates: Shell[] = process.platform === 'win32'
    ? [
        { name: 'git-bash', family: 'posix', exe: ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find((p) => existsSync(p)) ?? '', args: ['--noprofile', '--norc', '-i'] },
        { name: 'powershell-5.1', family: 'powershell', exe: join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoProfile', '-NonInteractive', '-Command', '-'] },
        { name: 'cmd', family: 'cmd', exe: join(sysRoot, 'System32', 'cmd.exe'), args: ['/d', '/q'] },
      ]
    : [
        { name: 'bash', family: 'posix', exe: ['/bin/bash', '/usr/bin/bash'].find((p) => existsSync(p)) ?? '', args: ['--noprofile', '--norc', '-i'] },
        { name: 'zsh', family: 'posix', exe: ['/bin/zsh', '/usr/bin/zsh'].find((p) => existsSync(p)) ?? '', args: ['-f', '-i'] },
        { name: 'pwsh', family: 'powershell', exe: ['/usr/bin/pwsh', '/usr/local/bin/pwsh', '/opt/homebrew/bin/pwsh'].find((p) => existsSync(p)) ?? '', args: ['-NoProfile', '-NonInteractive', '-Command', '-'] },
      ]
  return candidates.filter((s) => s.exe && existsSync(s.exe))
}

describe('accountLine in real shells: a foreign line runs nothing (R1)', () => {
  let work = ''
  let mark = ''
  const shells = findShells()
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'tp-acct-xshell-'))
    mark = join(work, 'mark.cjs')
    writeFileSync(mark, `require('fs').writeFileSync(process.argv[2], JSON.stringify({ value: process.env.${VAR} === undefined ? '(unset)' : process.env.${VAR} }))\n`)
  })
  afterAll(() => { rmSync(work, { recursive: true, force: true }) })

  const fwd = (p: string): string => p.replace(/\\/g, '/')
  const markCmd = (out: string): string => `node "${fwd(mark)}" "${fwd(out)}"`
  const read = (f: string): string | null => {
    try { return JSON.parse(readFileSync(f, 'utf8')).value } catch { return null }
  }
  const env = (): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env, [VAR]: 'old-account', PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` }
    delete e.PROMPT_COMMAND
    delete e.BASH_ENV
    delete e.ENV
    return e
  }
  let n = 0
  const run = (shell: Shell, line: string): { ran: string | null; after: string | null } => {
    const out1 = join(work, `o${++n}a.json`)
    const out2 = join(work, `o${n}b.json`)
    // The blank line ends the line as a statement in every shell. pwsh 7 reading `-Command -` takes
    // input the way its console does: a line it can't finish parsing (the posix line's '\'' leaves
    // a quote open there) waits for more, and only a blank line hands it over, where it fails to
    // parse and runs nothing. Without it the marker line after it is swallowed into that string,
    // and "is the old value still the shell's" can't be asked. Bash, zsh, cmd and PowerShell 5.1
    // read a blank line as nothing.
    const input = `${line.replace('MARK', markCmd(out1))}\n\n${shell.family === 'cmd' ? 'call ' : ''}${markCmd(out2)}\nexit\n`
    spawnSync(shell.exe, shell.args, { input, env: env(), cwd: work, timeout: 60000, windowsHide: true, encoding: 'utf8' })
    return { ran: read(out1), after: read(out2) }
  }

  it.runIf(shells.length > 0)('runs the marker on the account, and keeps it, only in the line\'s own family', () => {
    for (const shell of shells) {
      for (const family of ['posix', 'powershell', 'cmd'] as const) {
        const line = lineOf(family, { set: { [VAR]: VALUE }, unset: [] }, 'MARK')
        const { ran, after } = run(shell, line)
        if (family === shell.family) {
          expect({ shell: shell.name, family, ran, after }).toEqual({ shell: shell.name, family, ran: VALUE, after: VALUE })
        } else if (shell.name === 'pwsh' && family === 'posix') {
          // pwsh 7 reading `-Command -` keeps the posix line's open '\'' quote going to the end of the
          // input, blank lines included, so the second marker is swallowed into that string too: the
          // old value can't be asked there. What matters holds: nothing ran, and nothing was set.
          expect({ shell: shell.name, family, ran }).toEqual({ shell: shell.name, family, ran: null })
          expect([null, 'old-account']).toContain(after)
        } else {
          // Nothing ran: the marker never wrote, and the old value is still the shell's.
          expect({ shell: shell.name, family, ran, after }).toEqual({ shell: shell.name, family, ran: null, after: 'old-account' })
        }
      }
    }
  }, 120_000)

  it.runIf(shells.length > 0)('the default profile\'s line unsets the variable in its own family, and runs nothing elsewhere', () => {
    for (const shell of shells) {
      for (const family of ['posix', 'powershell', 'cmd'] as const) {
        const { ran, after } = run(shell, lineOf(family, { set: {}, unset: [VAR] }, 'MARK'))
        if (family === shell.family) expect({ shell: shell.name, family, ran, after }).toEqual({ shell: shell.name, family, ran: '(unset)', after: '(unset)' })
        else expect({ shell: shell.name, family, ran, after }).toEqual({ shell: shell.name, family, ran: null, after: 'old-account' })
      }
    }
  }, 120_000)
})
