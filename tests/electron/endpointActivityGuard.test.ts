/**
 * What Termpolis's own code may do on a monitored work computer (v1.54.3).
 *
 * Termpolis runs on laptops watched by endpoint security (Microsoft Defender for Endpoint, often
 * with an MDR service on top), and everything the app runs is logged under Termpolis.exe. A fact
 * sheet given to IT makes these claims about the app's own code, and this file keeps them true:
 *
 *  1. Nothing reads an OS secret store or another program's saved sign-in: no cmdkey or vaultcmd,
 *     no Credential Manager or DPAPI-unprotect calls, no keytar, no Python keyring, no macOS
 *     `security` or `secret-tool` lookups. Termpolis protects its own keys only through Electron's
 *     safeStorage.
 *  2. Listing processes with their command lines, or the network-connection table, happens only in
 *     the modules allowed below, each reached only from an explicit action.
 *  3. Termpolis's own PowerShell never bypasses the execution policy or hides what it runs.
 *
 * Related guards: the Processes panel scans only on Scan or Refresh
 * (tests/renderer/processesSettings.test.tsx), no agent CLI starts at launch
 * (tests/electron/mainIpcRemaining.test.ts), PowerShell's integration script is never run from
 * the temp dir (tests/electron/terminalManager.test.ts), and the Windows installer closes a running
 * Termpolis without a process query (tests/electron/installerNsh.test.ts, and the Tests workflow's
 * installer-update job).
 *
 * Only string and template literals are read, with TypeScript's own parser: a command Termpolis can
 * run is built from strings, while a comment, or UI prose that names a tool, is not.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative, sep } from 'path'
import ts from 'typescript'

const ROOT = join(__dirname, '..', '..')
const SRC = join(ROOT, 'src')

interface Literal { file: string; line: number; text: string }

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(ts|tsx|js|cjs|mjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** Every string and template literal in a file, with the array it sits in when it is one element
 *  of an argv-like list, so `['-ExecutionPolicy', 'Bypass']` reads as one flag. */
function literalsOf(file: string): { literals: Literal[]; arrays: Literal[][] } {
  const text = readFileSync(file, 'utf8')
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const rel = relative(ROOT, file).split(sep).join('/')
  const lit = (n: ts.Node, s: string): Literal => ({ file: rel, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text: s })
  const literals: Literal[] = []
  const arrays: Literal[][] = []
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) literals.push(lit(n, n.text))
    else if (ts.isTemplateExpression(n)) {
      literals.push(lit(n.head, n.head.text))
      for (const span of n.templateSpans) literals.push(lit(span.literal, span.literal.text))
    }
    if (ts.isArrayLiteralExpression(n)) {
      arrays.push(n.elements.filter((e) => ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)).map((e) => lit(e, (e as ts.StringLiteral).text)))
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return { literals, arrays }
}

const FILES = sourceFiles(SRC).map((f) => ({ path: f, ...literalsOf(f) }))

type Rule = [label: string, pattern: RegExp]

/** Hits of `rules` across src, as "file:line label: text", grouped by file. */
function hits(rules: Rule[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const f of FILES) {
    for (const l of f.literals) {
      for (const [label, re] of rules) {
        if (!re.test(l.text)) continue
        const list = out.get(l.file) ?? []
        list.push(`${l.file}:${l.line} ${label}: ${l.text.slice(0, 120)}`)
        out.set(l.file, list)
      }
    }
  }
  return out
}

/** Files allowed to hold the strings, each with the reason. A stale entry fails too, so the list
 *  stays exactly as wide as the code. */
function expectOnly(found: Map<string, string[]>, allowed: Record<string, string>): void {
  const unexpected = [...found].filter(([file]) => !(file in allowed)).flatMap(([, lines]) => lines)
  expect(unexpected, 'new code reaches for something endpoint security flags (see this file\'s header)').toEqual([])
  const stale = Object.keys(allowed).filter((file) => !found.has(file))
  expect(stale, 'allowed file no longer needs its exemption: remove it from the list').toEqual([])
}

describe('endpoint activity guard', () => {
  it('reads the whole source tree', () => {
    expect(FILES.length).toBeGreaterThan(300)
    expect(FILES.some((f) => f.path.endsWith(join('main', 'index.ts')))).toBe(true)
  })

  it('1. reads no OS secret store and no other program\'s saved sign-in', () => {
    const SECRET_STORE: Rule[] = [
      ['cmdkey', /\bcmdkey(\.exe)?\b/i],
      ['vaultcmd', /\bvaultcmd\b/i],
      ['Credential Manager API', /\bCred(Read|Enumerate|Write|Delete|Find)\w*/],
      ['DPAPI unprotect', /CryptUnprotectData|ProtectedData\]?::Unprotect/i],
      ['keytar', /\bkeytar\b/i],
      ['Python keyring', /\bimport\s+keyring\b|\bfrom\s+keyring\b|\bkeyring\.(get|set|delete)_/],
      ['Windows vault', /Get-StoredCredential|Windows\.Security\.Credentials|PasswordVault/i],
      ['macOS keychain', /\bsecurity\s+(find|dump|export|delete)-(generic|internet)-password|\bdump-keychain\b/i],
      ['libsecret CLI', /\bsecret-tool\b/],
      ['LSASS / dumpers', /\blsass\b|MiniDumpWriteDump|\bprocdump\b|\bmimikatz\b|\bcomsvcs\b/i],
      ['another program\'s sign-in file', /\.credentials\.json|oauth_creds\.json|\.git-credentials|\bLogin Data\b|\bkey4\.db\b|\blogins\.json\b|\bauth\.json\b/i],
    ]
    expectOnly(hits(SECRET_STORE), {
      'src/main/importScanner.ts':
        'Safe Import detection rules: what it flags inside third-party skills and plugins. Nothing runs them.',
    })
  })

  it('2. lists processes or network connections only from the allowed modules', () => {
    const DISCOVERY: Rule[] = [
      ['WMI process list', /Win32_Process\b|Get-CimInstance|Get-WmiObject|\bgwmi\b|\bwmic(\.exe)?\b/i],
      ['PowerShell process list', /\bGet-Process\b(?!\s+-Id\s+\$PID\b)/i],
      ['tasklist', /\btasklist(\.exe)?\b/i],
      ['connection table', /\bnetstat(\.exe)?\b|Get-NetTCPConnection|Get-NetUDPEndpoint/i],
      // Case-sensitive: the program names are lowercase, and the sidebar labels PowerShell "PS".
      ['process or socket lister', /^(ps|pgrep|ss|lsof)(\.exe)?$/],
      // With arguments, inside a command line: `ps -ef`, BSD-style `ps aux`, `pgrep node`, `lsof -i`, `ss -tlnp`.
      ['process or socket lister, with arguments', /(^|[\s'"`|;&(])(ps\s+(-|[auxefwlj]+\b)|(pgrep|lsof)\s+\S|ss\s+-)/],
    ]
    expectOnly(hits(DISCOVERY), {
      'src/main/stuckProcesses.ts':
        'Settings › Processes: runs only when someone presses Scan or Refresh, or kills a listed process.',
      'src/main/egressAudit.ts':
        'Per-agent egress audit: nothing calls it (asserted below).',
      'src/main/shellAlone.ts':
        'macOS/Linux: the terminal\'s own shell and process group (ps -p, pgrep -g), before typing into an agent.',
      'src/main/terminalManager.ts':
        'macOS: the working directory of the terminal\'s own shell (lsof -p <pid>), so the git badge follows cd.',
      'src/main/sudoAskpass.ts':
        'macOS/Linux: the one process that asked for the sudo password dialog (ps -p <its parent>).',
      'src/main/noNewPrivs.ts':
        'Linux: whether Termpolis\'s own old process has exited before it relaunches (ps -p <its pid>).',
    })
  })

  it('2a. nothing in the UI calls the egress poll', () => {
    const callers = FILES.filter((f) => f.path.includes(join('src', 'renderer')))
      .filter((f) => /\.egress\b/.test(readFileSync(f.path, 'utf8')))
      .map((f) => relative(ROOT, f.path))
    expect(callers).toEqual([])
  })

  it('3. never bypasses PowerShell\'s execution policy or hides what it runs', () => {
    const FLAGS: Rule[] = [
      ['execution policy bypass', /-(ExecutionPolicy|ep|exec)\s+(Bypass|Unrestricted)\b/i],
      ['encoded command', /(^|\s)-(EncodedCommand|enc|ec)(\s|$)/i],
      ['hidden window', /-(WindowStyle|w)\s+Hidden\b/i],
    ]
    const inStrings = [...hits(FLAGS).values()].flat()
    const inArgv = FILES.flatMap((f) => f.arrays).flatMap((arr) =>
      arr.slice(0, -1).flatMap((l, i) => {
        const next = arr[i + 1].text
        const flagged =
          (/^-(ExecutionPolicy|ep|exec)$/i.test(l.text) && /^(Bypass|Unrestricted)$/i.test(next)) ||
          (/^-(WindowStyle|w)$/i.test(l.text) && /^Hidden$/i.test(next)) ||
          /^-(EncodedCommand|enc|ec)$/i.test(l.text)
        return flagged ? [`${l.file}:${l.line} ${l.text} ${next}`] : []
      }),
    )
    expect([...inStrings, ...inArgv]).toEqual([])
  })
})
