import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { secondOpinionSpawnPlan, positionalPrompt, PROMPT_TOKEN } from '../../src/main/secondOpinion'

// The Windows spawn plan promises that the agent receives the prompt EXACTLY, whatever it
// contains. That rests on PowerShell 5.1's native-argument rules, which no string assertion
// can prove, so this runs the real powershell.exe against a node child that records its argv.
describe.runIf(process.platform === 'win32')('secondOpinionSpawnPlan on real Windows PowerShell', () => {
  let dir = ''
  let printer = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tp-so-plan-'))
    printer = join(dir, 'argv.cjs')
    // Written to a file rather than stdout so the check can't depend on console code pages.
    writeFileSync(printer, "require('fs').writeFileSync(process.env.TP_ARGV_OUT, JSON.stringify(process.argv.slice(2)))\n")
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  function run(name: string, bin: string, args: string[], prompt: string, env: NodeJS.ProcessEnv = {}): { status: number | null; stderr: string; argv: string[] | null } {
    const promptFile = join(dir, `${name}.prompt.txt`)
    const out = join(dir, `${name}.argv.json`)
    writeFileSync(promptFile, prompt, 'utf8') // BOM-less, as the main process writes it
    const { cmd, cmdArgs } = secondOpinionSpawnPlan(true, bin, args, PROMPT_TOKEN, prompt)
    const r = spawnSync(cmd, cmdArgs, {
      // In the temp folder, so anything a broken plan lets a test's payload create lands there.
      cwd: dir,
      env: { ...process.env, ...env, TP_SO_FILE: promptFile, TP_ARGV_OUT: out },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      windowsHide: true,
    })
    return { status: r.status, stderr: r.stderr ?? '', argv: existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as string[]) : null }
  }

  it('delivers a hostile prompt to the agent byte for byte', () => {
    const prompt = [
      'Review this: "quoted \\" part" and \\\\"doubled\\\\" C:\\dir\\ $(Get-Date) $env:PATH %PATH% & echo hi | more',
      "\t'single' `tick` ; rm -rf / é ☃ 🚀",
      'ends with a backslash\\',
    ].join('\n')
    const r = run('hostile', process.execPath, [printer, PROMPT_TOKEN, '--after'], prompt)
    expect(r.argv, r.stderr).toEqual([prompt, '--after'])
  }, 60_000)

  it('pads only a prompt whose first quote comes before any whitespace, so it still arrives whole', () => {
    const prompt = '"quoted-first" then text'
    const r = run('pad', process.execPath, [printer, PROMPT_TOKEN], prompt)
    expect(r.argv, r.stderr).toEqual([` ${prompt}`])
  }, 60_000)

  it('keeps the leading space that stops a dash-led prompt being parsed as a flag', () => {
    // The pad above only fires when no whitespace precedes the first quote, so a prompt like
    // this one relies on positionalPrompt's space alone. It must survive PowerShell.
    const prompt = positionalPrompt('--settings= {"hooks": {}} and more')
    const r = run('dash', process.execPath, [printer, PROMPT_TOKEN], prompt)
    expect(r.argv, r.stderr).toEqual([' --settings= {"hooks": {}} and more'])
  }, 60_000)

  it('keeps an empty argv entry and an empty prompt as real arguments', () => {
    const r = run('empty', process.execPath, [printer, '', PROMPT_TOKEN, '--after'], '')
    expect(r.argv, r.stderr).toEqual(['', ' ', '--after'])
  }, 60_000)

  it('keeps a folder with a space and a trailing backslash one argument, and the prompt whole', () => {
    // `codex exec -C <cwd>` puts a caller's folder on the command line. Unshaped, this one reached
    // the child as `"C:\Program Files\"`, ran on into the prompt, and split the prompt's words
    // into separate arguments, a flag among them.
    const folder = 'C:\\Program Files\\'
    const prompt = 'review this --dangerously-bypass-approvals-and-sandbox please'
    const direct = run('folder', process.execPath, [printer, '-C', folder, 'a b\\\\', PROMPT_TOKEN], prompt)
    expect(direct.argv, direct.stderr).toEqual(['-C', folder, 'a b\\\\', prompt])
    // The same entries cross a second native hop inside an npm PowerShell shim.
    const bin = join(dir, 'shim-bin-folder')
    mkdirSync(bin, { recursive: true })
    const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
    writeFileSync(join(bin, 'tp-so-folder.ps1'), `& ${q(process.execPath)} ${q(printer)} $args\r\nexit $LASTEXITCODE\r\n`)
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
    const shim = run('folder-shim', 'tp-so-folder', ['-C', folder, PROMPT_TOKEN], prompt, {
      [pathKey]: `${bin};${process.env[pathKey] ?? ''}`,
      PSExecutionPolicyPreference: 'Bypass',
    })
    expect(shim.argv, shim.stderr).toEqual(['-C', folder, prompt])
  }, 60_000)

  it('keeps a folder name with a typographic quote inside its literal, where it cannot run as script', () => {
    // PowerShell reads U+2018 to U+201B as single quotes too. When only the ASCII one was doubled,
    // this name (every character legal on NTFS) closed the literal, and New-Item ran.
    for (const [i, q] of ['\u2018', '\u2019', '\u201a', '\u201b'].entries()) {
      const marker = `tp-pwned-${i}.txt`
      const folder = `x${q}; New-Item -ItemType File -Path ${marker}; #`
      const r = run(`quote-${i}`, process.execPath, [printer, '-C', folder, PROMPT_TOKEN], 'the prompt')
      expect(existsSync(join(dir, marker)), folder).toBe(false)
      expect(r.argv, r.stderr).toEqual(['-C', folder, 'the prompt'])
    }
  }, 60_000)

  it('doubles a trailing backslash exactly when 5.1 adds quotes, by its own idea of whitespace', () => {
    // 5.1 wraps an entry that holds any char.IsWhiteSpace character. That set is not JS's \s: it
    // has NEL (U+0085), which \s lacks, and lacks the BOM (U+FEFF), which \s has. A miss either way
    // corrupts the entry, and a missed wrap splits the prompt into separate arguments.
    const entries = ['a\u0085b\\', 'a\ufeffb\\', 'a\u00a0b\\', 'a\u3000b\\', 'a\u2028b\\', 'a\tb\\', 'a\u201cb\u201d c']
    const r = run('whitespace', process.execPath, [printer, ...entries, PROMPT_TOKEN], 'the prompt here')
    expect(r.argv, r.stderr).toEqual([...entries, 'the prompt here'])
  }, 60_000)

  it('refuses a batch-file shim rather than hand the prompt to cmd.exe', () => {
    const shim = join(dir, 'agent.cmd')
    writeFileSync(shim, '@echo off\r\necho ran> "%~dp0ran.txt"\r\n')
    const r = run('batch', shim, [PROMPT_TOKEN], 'x')
    expect(r.status).not.toBe(0)
    // PowerShell wraps an error at the console width, which can split the message anywhere.
    expect(r.stderr.replace(/\s+/g, '')).toContain('isabatch-fileshim')
    expect(existsSync(join(dir, 'ran.txt'))).toBe(false)
  }, 60_000)

  it('picks the npm PowerShell shim over its .cmd twin and forwards the prompt through it intact', () => {
    // npm installs codex and gemini as `<name>.ps1` + `<name>.cmd` side by side. The .ps1 must
    // win, and the prompt then crosses a second native hop inside it, so prove that hop too.
    const bin = join(dir, 'shim-bin')
    mkdirSync(bin, { recursive: true })
    const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
    writeFileSync(join(bin, 'tp-so-agent.ps1'), `& ${q(process.execPath)} ${q(printer)} $args\r\nexit $LASTEXITCODE\r\n`)
    writeFileSync(join(bin, 'tp-so-agent.cmd'), '@echo off\r\necho ran> "%~dp0ran.txt"\r\n')
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
    const prompt = 'say "hi \\" there" C:\\dir\\ $(Get-Date) & echo x\n\'quoted\' `tick` ends\\'
    const r = run('ps1', 'tp-so-agent', ['', PROMPT_TOKEN, '--after'], prompt, {
      [pathKey]: `${bin};${process.env[pathKey] ?? ''}`,
      // Execution policy is not what this checks, and a locked-down runner would block the shim.
      PSExecutionPolicyPreference: 'Bypass',
    })
    expect(r.argv, r.stderr).toEqual(['', prompt, '--after'])
    expect(existsSync(join(bin, 'ran.txt'))).toBe(false)
  }, 60_000)
})
