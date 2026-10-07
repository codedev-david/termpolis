import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ASKPASS_DIR,
  ASKPASS_FILE,
  ASKPASS_SCRIPT,
  SUDO_AGENT_HINT,
  installSudoAskpass,
  sudoAskpassEnv,
  sudoAskpassPath,
  type AskpassFs,
} from '../../src/main/sudoAskpass'
import { isShellSafeInstruction } from '../../src/shared/agentIntegration'

const fakeFs = (): AskpassFs & { calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    mkdir: vi.fn((d: string) => { calls.push(`mkdir ${d}`) }),
    write: vi.fn((f: string) => { calls.push(`write ${f}`) }),
    chmod: vi.fn((f: string, m: number) => { calls.push(`chmod ${f} ${m.toString(8)}`) }),
    rename: vi.fn((a: string, b: string) => { calls.push(`rename ${a} ${b}`) }),
  }
}

afterEach(() => {
  installSudoAskpass('/unused', 'win32') // back to "no helper" for the next file
})

describe('installSudoAskpass', () => {
  it('installs nothing on Windows, which has no sudo -A', () => {
    const fs = fakeFs()
    expect(installSudoAskpass('/data', 'win32', fs)).toBeNull()
    expect(fs.calls).toEqual([])
    expect(sudoAskpassPath()).toBeNull()
  })

  it.each(['linux', 'darwin'] as const)('writes the helper into userData on %s, replacing it whole', (platform) => {
    const fs = fakeFs()
    const file = join('/data', ASKPASS_DIR, ASKPASS_FILE)
    expect(installSudoAskpass('/data', platform, fs)).toBe(file)
    expect(fs.calls).toEqual([
      `mkdir ${join('/data', ASKPASS_DIR)}`,
      `write ${file}.tmp`,
      `chmod ${file}.tmp 700`,
      `rename ${file}.tmp ${file}`,
    ])
    expect(vi.mocked(fs.write).mock.calls[0][1]).toBe(ASKPASS_SCRIPT)
    expect(sudoAskpassPath()).toBe(file)
  })

  it('reports no helper when it cannot be written, so agents are not told about one', () => {
    installSudoAskpass('/data', 'linux', fakeFs())
    const fs = { ...fakeFs(), write: () => { throw new Error('EROFS') } }
    expect(installSudoAskpass('/data', 'linux', fs)).toBeNull()
    expect(sudoAskpassPath()).toBeNull()
  })

  it('writes an executable only its owner can touch, with the real file system', () => {
    const dir = mkdtempSync(join(tmpdir(), 'askpass-'))
    // The real calls run everywhere; Windows has no POSIX modes to check.
    const posix = process.platform !== 'win32'
    try {
      const file = installSudoAskpass(dir, 'linux')
      expect(file).toBe(join(dir, ASKPASS_DIR, ASKPASS_FILE))
      expect(readFileSync(file!, 'utf8')).toBe(ASKPASS_SCRIPT)
      if (posix) expect(statSync(file!).mode & 0o777).toBe(0o700)
      // A later launch replaces an edited copy.
      writeFileSync(file!, '#!/bin/sh\necho stolen\n')
      chmodSync(file!, 0o755)
      installSudoAskpass(dir, 'linux')
      expect(readFileSync(file!, 'utf8')).toBe(ASKPASS_SCRIPT)
      if (posix) expect(statSync(file!).mode & 0o777).toBe(0o700)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('sudoAskpassEnv', () => {
  it('points SUDO_ASKPASS at the helper', () => {
    expect(sudoAskpassEnv('/data/askpass/sudo-askpass', {})).toEqual({ SUDO_ASKPASS: '/data/askpass/sudo-askpass' })
  })

  it("keeps a helper the user set up themselves", () => {
    expect(sudoAskpassEnv('/data/askpass/sudo-askpass', { SUDO_ASKPASS: '/usr/bin/ssh-askpass' })).toEqual({})
  })

  it('adds nothing where there is no helper', () => {
    expect(sudoAskpassEnv(null, {})).toEqual({})
  })

  it("uses this session's helper and environment by default", () => {
    const fs = fakeFs()
    const file = installSudoAskpass('/data', 'linux', fs)
    const own = process.env.SUDO_ASKPASS
    delete process.env.SUDO_ASKPASS
    try {
      expect(sudoAskpassEnv()).toEqual({ SUDO_ASKPASS: file })
    } finally {
      if (own !== undefined) process.env.SUDO_ASKPASS = own
    }
  })
})

describe('the agent hint', () => {
  it('tells agents to use sudo -A, in words that survive the Codex command line', () => {
    expect(SUDO_AGENT_HINT).toContain('sudo -A')
    expect(isShellSafeInstruction(SUDO_AGENT_HINT)).toBe(true)
  })
})

describe('ASKPASS_SCRIPT', () => {
  it('refuses unless its parent is sudo running as root', () => {
    expect(ASKPASS_SCRIPT).toContain('sudo|sudo-rs) ;;')
    expect(ASKPASS_SCRIPT).toContain('[ "$euid" = 0 ] || refuse')
    // Effective uid is the third field of the Uid: line (real, effective, saved, fs).
    expect(ASKPASS_SCRIPT).toContain("awk '/^Uid:/ { print $3 }'")
  })

  it('ignores the prompt sudo passes, so the caller cannot put words in the dialog', () => {
    expect(ASKPASS_SCRIPT).not.toMatch(/\$1|\$\{1/)
  })

  it('never cuts the command: one too long to show is refused instead', () => {
    expect(ASKPASS_SCRIPT).not.toMatch(/\|\s*(?:cut|head)\b/)
    expect(ASKPASS_SCRIPT).toContain('if [ "${#cmdline}" -gt 1000 ]; then')
  })

  it('kept every shell expansion through the template literal', () => {
    expect(ASKPASS_SCRIPT).toContain('parent=${parent##*/}')
    expect(ASKPASS_SCRIPT).toContain("tr '\\000' ' '")
    expect(ASKPASS_SCRIPT).toContain("sed -e 's/&/\\&amp;/g'")
    expect(ASKPASS_SCRIPT.startsWith('#!/bin/sh\n')).toBe(true)
  })

  describe.runIf(process.platform !== 'win32')('run by a real shell', () => {
    let dir: string
    let file: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'askpass-run-'))
      file = installSudoAskpass(dir)!
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it('parses', () => {
      expect(spawnSync('/bin/sh', ['-n', file]).status).toBe(0)
    })

    it.runIf(process.platform === 'darwin')('has a macOS dialog that compiles', () => {
      // Compiled, not run: running it would put a password dialog on the CI runner's screen.
      const block = ASKPASS_SCRIPT.slice(ASKPASS_SCRIPT.indexOf('exec osascript'), ASKPASS_SCRIPT.indexOf('"$text" "$title"'))
      const lines = [...block.matchAll(/-e '([^']*)'/g)].map((m) => m[1])
      expect(lines.at(-1)).toBe('end run')
      expect(lines[0]).toBe('on run argv')
      const r = spawnSync('osacompile', ['-o', join(dir, 'dialog.scpt'), ...lines.flatMap((l) => ['-e', l])], { encoding: 'utf8' })
      expect(r.stderr).toBe('')
      expect(r.status).toBe(0)
    })

    // The script's own lines, run by a real shell: what the dialog will show for a given command.
    const shown = (cmd: string) => {
      const start = ASKPASS_SCRIPT.indexOf('cmdline=$(printf')
      const snippet = ASKPASS_SCRIPT.slice(start, ASKPASS_SCRIPT.indexOf('\nfi\n', start) + 4)
      return spawnSync('/bin/sh', ['-c', `${snippet}printf '%s' "$cmdline"`], {
        env: { ...process.env, cmdline: cmd },
        encoding: 'utf8',
      })
    }

    it("shows control characters as spaces, so a command can't lay out the dialog", () => {
      const r = shown('sudo -A rm -rf /srv\n\nEnter your password only if you expected this.\n\napt update')
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('sudo -A rm -rf /srv  Enter your password only if you expected this.  apt update')
      expect(shown('a\tb\x1b[2Jc').stdout).toBe('a b [2Jc')
    })

    it("shows non-ASCII bytes as spaces, so a right-to-left override can't reorder it", () => {
      expect(shown('sudo -A cat ‮txt.exe').stdout).toBe('sudo -A cat    txt.exe')
    })

    it('shows a command in full, and refuses one too long to show whole', () => {
      const full = `sudo -A ${'x'.repeat(992)}`
      expect(full).toHaveLength(1000)
      expect(shown(full).stdout).toBe(full)
      const r = shown(`${full}y`)
      expect(r.status).toBe(1)
      expect(r.stdout).toBe('')
      expect(r.stderr).toContain('too long to show in full')
    })

    it('prints nothing and fails when anything but sudo runs it', () => {
      // The parent here is this test runner: not sudo, not root. An agent calling the helper
      // directly is in exactly this position.
      const r = spawnSync(file, ['[sudo] password for x:'], { encoding: 'utf8', timeout: 10_000 })
      expect(r.status).toBe(1)
      expect(r.stdout).toBe('')
      expect(r.stderr).toContain('only sudo may ask for your password here')
    })
  })
})
