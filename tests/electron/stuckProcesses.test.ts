/**
 * The stuck-process engine behind Settings ▸ Processes. Everything here runs on built snapshots
 * and fake runners, and nothing is ever signalled for real: the kill tests inject `kill`, or
 * stub `process.kill`. The last two tests scan this machine read-only.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  classifyProcesses,
  displayCommand,
  killStuckProcesses,
  normalizeKillTargets,
  parseClock,
  parseLsof,
  parseMsysPs,
  parseNetstat,
  parsePosixProcesses,
  parseSs,
  parseWindowsProcesses,
  scanStuckProcesses,
  takeProcessSnapshot,
  tokenizeCommand,
  type ProcRecord,
  type ProcSnapshot,
  type StuckClassification,
  type StuckRow,
  type StuckRunner,
} from '../../src/main/stuckProcesses'
import type { ProcOutcome } from '../../src/main/procClient'
import type { ProcOptions } from '../../src/main/procHost'

const NOW = Date.UTC(2026, 8, 25, 12)
const MIN = 60_000
const SELF = 100
const SELF_MISSING = 'Termpolis could not find itself in the process list, so nothing was flagged.'
const PORTS_UNKNOWN = 'Could not read which processes are listening on ports, so nothing was marked stuck.'
const MSYS_UNKNOWN = 'Could not confirm which Git Bash processes lost their parent, so none of those were marked orphaned.'
const MANAGED_UNKNOWN = 'Could not confirm which processes launchd or systemd started, so none of those were marked orphaned.'

function proc(pid: number, over: Partial<ProcRecord> = {}): ProcRecord {
  return { pid, ppid: 0, name: 'x', cmd: '', created: NOW - 60 * MIN, cpuSec: 0, memBytes: 0, suspended: false, scope: 1, ...over }
}

/** Explorer → Termpolis → its renderer: the part of the tree that is never listed. */
function base(): ProcRecord[] {
  return [
    proc(10, { name: 'explorer', ppid: 5, cmd: 'C:\\Windows\\Explorer.EXE', created: NOW - 600 * MIN }),
    proc(SELF, { name: 'termpolis', ppid: 10, cmd: '"C:\\Program Files\\Termpolis\\Termpolis.exe"', created: NOW - 120 * MIN }),
    proc(101, { name: 'termpolis', ppid: SELF, cmd: '"C:\\Program Files\\Termpolis\\Termpolis.exe" --type=renderer', created: NOW - 119 * MIN }),
  ]
}

/** An unrelated app the user started: a live, valid parent that is not Termpolis. */
function code(): ProcRecord {
  return proc(20, { name: 'code', ppid: 10, cmd: '"C:\\Users\\Dev\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"', created: NOW - 300 * MIN })
}

const GB = String.raw`C:\Program Files\Git\usr\bin`

/** A live `bash -c "sleep 999 | cat"` under VS Code whose `sleep` has lost its Windows parent. */
function pipeline(): ProcRecord[] {
  return [
    code(),
    proc(300, { name: 'bash', ppid: 20, cmd: `"${GB}\\bash.exe" -c "sleep 999 | cat"`, created: NOW - 20 * MIN }),
    // MSYS runs a program with a new Windows process; the one that started sleep (301) has exited.
    proc(302, { name: 'sleep', ppid: 301, cmd: `"${GB}\\sleep.exe" 999`, created: NOW - 20 * MIN + 500 }),
  ]
}

function snap(procs: ProcRecord[], over: Partial<ProcSnapshot> = {}): ProcSnapshot {
  return { procs, listening: new Map(), takenAt: NOW, platform: 'win32', warnings: [], ...over }
}

function classify(procs: ProcRecord[], over: Partial<ProcSnapshot> = {}, homeDir?: string): StuckClassification {
  return classifyProcesses(snap(procs, over), homeDir === undefined ? { selfPid: SELF } : { selfPid: SELF, homeDir })
}

const pids = (cls: StuckClassification): number[] => cls.rows.map((r) => r.pid)

function row(cls: StuckClassification, pid: number): StuckRow {
  const r = cls.rows.find((x) => x.pid === pid)
  if (!r) throw new Error(`no row for pid ${pid}; rows: ${pids(cls).join(', ')}`)
  return r
}

/** Claude Code's Bash tool on Windows, as the OS reports the command line. */
const BASH_TOOL = String.raw`"C:\Program Files\Git\bin\bash.exe" -c -l "source C:/Users/Dev/.claude/shell-snapshots/snapshot-bash-1.sh && eval 'sleep 999 && echo \"done\"' < /dev/null && pwd -P >| /tmp/claude-ab12-cwd"`

afterEach(() => {
  vi.restoreAllMocks()
})

describe('tokenizeCommand', () => {
  it('splits a command line the way CreateProcess would', () => {
    expect(tokenizeCommand('')).toEqual([])
    expect(tokenizeCommand('  git \t status  ')).toEqual(['git', 'status'])
    expect(tokenizeCommand('"C:\\Program Files\\Git\\bin\\git.exe" status')).toEqual(['C:\\Program Files\\Git\\bin\\git.exe', 'status'])
    expect(tokenizeCommand('a "" b')).toEqual(['a', '', 'b'])
    expect(tokenizeCommand('x "a b"c')).toEqual(['x', 'a bc'])
    // An escaped quote is a literal quote: it neither opens nor closes a quoted run.
    expect(tokenizeCommand('bash -c \\"echo hi\\"')).toEqual(['bash', '-c', '"echo', 'hi"'])
    expect(tokenizeCommand('a\\b')).toEqual(['a\\b'])
  })
})

describe('displayCommand', () => {
  it("shows the command an agent's Bash tool ran, not the harness around it", () => {
    expect(displayCommand(BASH_TOOL)).toBe('sleep 999 && echo "done"')
    // Claude writes a single quote inside the eval word as '"'"' — on Windows as '\"'\"'.
    const quoted = String.raw`bash -c -l "eval 'echo '\"'\"'hi there'\"'\"'' < /dev/null && pwd -P"`
    expect(displayCommand(quoted)).toBe("echo 'hi there'")
  })

  it('reads the eval word with shell quoting rules', () => {
    // Inside double quotes a backslash only escapes " \ $ and `.
    expect(displayCommand('sh -c eval "echo \\$HOME \\\\ \\`x\\` \\n" && pwd -P')).toBe('echo $HOME \\ `x` \\n')
    // Unquoted, a backslash escapes the next character.
    expect(displayCommand(`bash -c "eval 'ls'\\ -la && pwd -P"`)).toBe('ls -la')
    // An operator ends the word, and the harness tail may follow it without a space.
    expect(displayCommand(`bash -c "eval 'a'&& pwd -P"`)).toBe('a')
    // The user's own eval, inside the harness's, is part of the command.
    expect(displayCommand(String.raw`bash -c -l "eval 'eval '\"'\"'x'\"'\"'' < /dev/null && pwd -P"`)).toBe("eval 'x'")
  })

  it("unwraps an eval only when the Bash tool's tail follows it, with or without the stdin redirect", () => {
    expect(displayCommand(`bash -c -l "eval 'git status' && pwd -P >| /tmp/claude-1-cwd"`)).toBe('git status')
    expect(displayCommand(String.raw`bash -c -l "eval 'git status' \< /dev/null && pwd -P"`)).toBe('git status')
    // The first eval is not the harness's; the one the tail follows is.
    expect(displayCommand(`bash -c "eval 'a'; x && eval 'b' && pwd -P"`)).toBe('b')
  })

  it('shows the whole command line for an eval the harness did not wrap', () => {
    for (const cmd of [
      // Showing only the eval would hide the rm.
      `bash -c "rm -rf ~/work; eval 'echo hi'"`,
      `node --eval "console.log(1)"`,
      `zsh -lc 'eval "$(/opt/homebrew/bin/brew shellenv)"; brew update'`,
      `git commit -m "docs: explain eval 'x' in the README"`,
      // An unterminated quote swallows the rest, so no tail can follow it.
      `bash -c "eval 'echo hi && pwd -P`,
    ]) {
      expect(displayCommand(cmd)).toBe(cmd)
    }
  })

  it('keeps the whole command line when there is no quoted eval word to show', () => {
    expect(displayCommand(`bash -c "eval '' && pwd -P"`)).toBe(`bash -c "eval '' && pwd -P"`)
    // Whitespace is still collapsed in the command line it falls back to.
    expect(displayCommand(`bash -c "eval '   ' && pwd -P"`)).toBe(`bash -c "eval ' ' && pwd -P"`)
    expect(displayCommand("bash -c 'eval x && pwd -P'")).toBe("bash -c 'eval x && pwd -P'")
    expect(displayCommand("evaluate 'x' && pwd -P")).toBe("evaluate 'x' && pwd -P")
  })

  it('masks secrets that command lines carry', () => {
    expect(displayCommand('git clone https://user:hunter2pass@github.com/org/repo.git')).toBe(
      'git clone https://user:<redacted>@github.com/org/repo.git',
    )
    expect(displayCommand('MY_API_KEY=abc123 node x.js')).toBe('MY_API_KEY=<redacted> node x.js')
    expect(displayCommand('gh auth login --token abc123')).toBe('gh auth login --token <redacted>')
    expect(displayCommand('tool --api-key=xyz')).toBe('tool --api-key=<redacted>')
    expect(displayCommand('app --github-token s3cr3tvalue')).toBe('app --github-token <redacted>')
    expect(displayCommand('curl -H "Authorization: Basic dXNlcjpwYXNz=="')).toBe('curl -H "Authorization: Basic <redacted>"')
  })

  it('masks a quoted secret whole, where the shared log redaction alone would stop at its first space', () => {
    for (const [input, expected] of [
      [`bash -c "export SECRET='correct horse battery staple' && ./deploy.sh"`, 'bash -c "export SECRET=<redacted> && ./deploy.sh"'],
      ["PASSWORD='hunter22 is my pw' ./run.sh", 'PASSWORD=<redacted> ./run.sh'],
      ["mysqldump --password='tangerine cat 42'", 'mysqldump --password=<redacted>'],
      ["export TOKEN='abcdefgh ijkl mnop'", 'export TOKEN=<redacted>'],
      ["API_KEY='abcdefgh ijkl mnop' node x.js", 'API_KEY=<redacted> node x.js'],
    ]) {
      expect(displayCommand(input), input).toBe(expected)
    }
  })

  // Values stay under the 8 characters the shared log redaction needs, so these prove the
  // command-line rules themselves. Token shapes are built, never written out: a literal
  // token-shaped string in a test trips push protection.
  it.each([
    // URL credentials: the password of user:password, or a token used as the whole user part.
    ['git clone https://user:hunter2@github.com/o/r.git', 'git clone https://user:<redacted>@github.com/o/r.git'],
    [`git clone https://${'a'.repeat(24)}@github.com/o/r.git`, 'git clone https://<redacted>@github.com/o/r.git'],
    // Secret-named variables, quoted or not.
    [
      'DB_PASS=hunter2 GIT_AUTH=x2 MYSQL_PWD=pw AWS_ACCESS_KEY_ID=id1 SSHPASS=pw ./run',
      'DB_PASS=<redacted> GIT_AUTH=<redacted> MYSQL_PWD=<redacted> AWS_ACCESS_KEY_ID=<redacted> SSHPASS=<redacted> ./run',
    ],
    [`MY_TOKEN="a b c" CLIENT_SECRET='x y' node x.js`, 'MY_TOKEN=<redacted> CLIENT_SECRET=<redacted> node x.js'],
    // Secret-named flags, quoted, and the \"…\" form inside a quoted Windows argument.
    [
      'tool --password "hunter 2" --db-password=pw --passphrase x --secret y',
      'tool --password <redacted> --db-password=<redacted> --passphrase <redacted> --secret <redacted>',
    ],
    [String.raw`bash -c "tool --password \"hunter 2\" -v"`, String.raw`bash -c "tool --password <redacted> -v"`],
    // A command line the scanner cut mid-quote still loses the secret.
    ['tool --password "hunter', 'tool --password <redacted>'],
    ["tool --password 'hunter", 'tool --password <redacted>'],
    [String.raw`bash -c "tool --password \"hunter`, String.raw`bash -c "tool --password <redacted>`],
    // Per-tool password flags: attached for mysql (a bare -p prompts), spaced or not for the rest.
    ['mysql -u root -phunter2 db', 'mysql -u root -p<redacted> db'],
    ['sshpass -p hunter2 ssh host', 'sshpass -p <redacted> ssh host'],
    ['docker login -u bob -p hunter2 ghcr.io', 'docker login -u bob -p <redacted> ghcr.io'],
    ['redis-cli -h h -a hunter2 ping', 'redis-cli -h h -a <redacted> ping'],
    ['curl -b "sid=abc; t=1" https://x.io', 'curl -b <redacted> https://x.io'],
    // curl -u user:password keeps the user, however it is quoted.
    ['curl -u admin:hunter2 https://x.io', 'curl -u admin:<redacted> https://x.io'],
    ['curl --user "admin:hunter 2" https://x.io', 'curl --user "admin:<redacted>" https://x.io'],
    [String.raw`bash -c "curl -U \"admin:pw\" x"`, String.raw`bash -c "curl -U \"admin:<redacted>\" x"`],
    // Auth headers and cookies, in a quoted header or bare.
    ['curl -H "Authorization: Bearer abc.def"', 'curl -H "Authorization: Bearer <redacted>"'],
    ['curl -H "Cookie: sid=abc; theme=dark" x', 'curl -H "Cookie: <redacted>" x'],
    ['http x Cookie:sid=abc;t=1 y', 'http x Cookie:<redacted> y'],
    ['aws configure set aws_secret_access_key abc123', 'aws configure set aws_secret_access_key <redacted>'],
    // Signed URLs and OAuth callbacks keep everything but the secret.
    ['curl "https://api.x.io/v1?access_token=abc123&page=2"', 'curl "https://api.x.io/v1?access_token=<redacted>&page=2"'],
    ['az x "https://a.blob.core.windows.net/c?sv=1&sig=abc%2F&se=2"', 'az x "https://a.blob.core.windows.net/c?sv=1&sig=<redacted>&se=2"'],
    ['open "http://localhost:1/cb?code=abc&state=s"', 'open "http://localhost:1/cb?code=<redacted>&state=s"'],
    // A webhook URL is the secret.
    ['curl -X POST https://hooks.slack.com/services/T0/B0/xyz', 'curl -X POST https://hooks.slack.com/services/<redacted>'],
    ['curl https://discord.com/api/webhooks/1/abc', 'curl https://discord.com/api/webhooks/<redacted>'],
    // Tokens recognisable by shape alone.
    [
      `t github_pat_${'a'.repeat(22)} glpat-${'a'.repeat(20)} xoxb-${'1'.repeat(10)} npm_${'a'.repeat(36)} pypi-${'a'.repeat(50)} hf_${'a'.repeat(30)}`,
      't <redacted-token> <redacted-token> <redacted-token> <redacted-token> <redacted-token> <redacted-token>',
    ],
    [
      `t eyJ${'a'.repeat(8)}.${'b'.repeat(8)}.${'c'.repeat(8)} AIza${'a'.repeat(35)} AKIA${'A'.repeat(16)}`,
      't <redacted-token> <redacted-key> <redacted-key>',
    ],
    // Secret fields in inline JSON, including the \"…\" form inside a quoted Windows argument.
    [`curl -d '{"user":"bob","password":"hunter2"}' x`, `curl -d '{"user":"bob","password":"<redacted>"}' x`],
    [String.raw`bash -c "curl -d {\"api_key\": \"k1\", \"n\": 1}"`, String.raw`bash -c "curl -d {\"api_key\": \"<redacted>\", \"n\": 1}"`],
  ])('masks %s', (input, expected) => {
    expect(displayCommand(input)).toBe(expected)
  })

  it('leaves what only looks like a secret alone', () => {
    for (const cmd of [
      'git commit --author="Jane Doe <jane@example.com>" -m wip',
      'OAUTH_DONE=1;rm -f x',
      'BYPASS_CACHE=1 PWD=/home/dev KEY=a npm test',
      'llm --max-tokens=4096 --max-tokens 10',
      'TOKENIZERS_PARALLELISM=false GIT_AUTHOR_NAME=x python train.py',
      'git checkout -b feature',
      'pg_dump --password-file x',
      'tool --no-password --verbose',
      'mysql -p db',
      'git clone https://bob@github.com/o/r.git',
    ]) {
      expect(displayCommand(cmd)).toBe(cmd)
    }
  })

  it('shortens the home directory to ~ in every spelling, and only at a path boundary', () => {
    const home = 'C:\\Users\\Dev'
    expect(displayCommand('"C:\\Users\\Dev\\AppData\\x.exe" --cfg C:/Users/Dev/.cfg /c/Users/Dev/bin/tool c:\\users\\dev\\lower', home)).toBe(
      '"~\\AppData\\x.exe" --cfg ~/.cfg ~/bin/tool ~\\lower',
    )
    expect(displayCommand('cd C:\\Users\\Dev', home)).toBe('cd ~')
    expect(displayCommand("type 'C:\\Users\\Dev'", home)).toBe("type '~'")
    expect(displayCommand('dir C:\\Users\\Developer\\x', home)).toBe('dir C:\\Users\\Developer\\x')
    // Characters that mean something in a regex are matched literally.
    expect(displayCommand('C:\\Users\\A.B (x)\\file C:\\Users\\AxB (x)\\file', 'C:\\Users\\A.B (x)')).toBe('~\\file C:\\Users\\AxB (x)\\file')
    expect(displayCommand('cat /home/dev/.bashrc /home/developer/x', '/home/dev')).toBe('cat ~/.bashrc /home/developer/x')
    expect(displayCommand('cat /home/dev/.bashrc', '/home/dev/')).toBe('cat ~/.bashrc')
    expect(displayCommand('ls /tmp', '/')).toBe('ls /tmp')
    expect(displayCommand('ls /tmp', '')).toBe('ls /tmp')
  })

  it('collapses whitespace and caps the length', () => {
    expect(displayCommand('  git \t status \n ')).toBe('git status')
    const long = displayCommand('word '.repeat(300))
    expect(long).toHaveLength(1001)
    expect(long.endsWith('…')).toBe(true)
    expect(displayCommand('x'.repeat(1000))).toBe('x'.repeat(1000))
    expect(displayCommand('x'.repeat(1001))).toBe(`${'x'.repeat(1000)}…`)
  })

  it('reads at most 4,000 characters of a command line, so masking stays cheap however long one gets', () => {
    expect(displayCommand(`echo${' '.repeat(5_000)}tail`)).toBe('echo')
    // Near the 32,767-character Windows limit, where open-ended gaps in a pattern backtrack for minutes.
    const started = performance.now()
    displayCommand('docker login '.repeat(2_500))
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('drops the word a 4,000-character cut splits, since part of a secret is too short for any pattern', () => {
    const token = `ghp_${'a'.repeat(36)}`
    // The cut keeps ghp_ and 12 more characters, under the 20 the GitHub-token pattern needs.
    const long = `echo${' '.repeat(3_980)}${token} done`
    expect(displayCommand(long)).toBe('echo')
    // The OS readers cut at the same length, so a command line exactly that long counts as cut.
    expect(displayCommand(long.slice(0, 4_000))).toBe('echo')
    // A word the cut does not split stays.
    expect(displayCommand(`echo${' '.repeat(3_980)}ok ${token}`)).toBe('echo ok')
  })

  // How Claude Code's Bash tool wraps a command: a version-dependent head, the eval word, a tail.
  const HEAD_WIN = String.raw`"C:\Program Files\Git\bin\bash.exe" -c -l "source C:/Users/Dev/.claude/shell-snapshots/snapshot-bash-1.sh && eval '`
  const HEAD_NEW = String.raw`"C:\Program Files\Git\bin\bash.exe" -c -l "{ \builtin unalias -- 'unsetenv'; } 2>/dev/null || true && eval '`
  const HEAD_LNX = `/bin/bash -c -l source /home/dev/.claude/shell-snapshots/snapshot-bash-1.sh && eval '`
  const TAIL_WIN = `' < /dev/null && pwd -P >| /tmp/claude-ab12-cwd"`
  const TAIL_LNX = `' < /dev/null && pwd -P >| /tmp/claude-1-cwd`
  // A single quote inside the eval word: '"'"' (on Windows '\"'\"'), or '\'' from older versions.
  const WQ = String.raw`'\"'\"'`
  const LQ = `'"'"'`
  const OQ = `'\\''`
  const LONG = ' -v x=1'.repeat(700)

  it('still shows the command of a Bash tool harness whose tail the 4,000-character cut removed', () => {
    for (const [cmd, shown] of [
      [`${HEAD_WIN}PGPASSWORD=${WQ}hunter 2 pg${WQ} psql -h db -f big.sql${LONG}${TAIL_WIN}`, 'PGPASSWORD=<redacted> psql -h db -f big.sql -v x=1 '],
      [`${HEAD_NEW}curl -u admin:${WQ}hunter 2 curl${WQ} https://x${LONG}${TAIL_WIN}`, 'curl -u admin:<redacted> https://x -v x=1 '],
      [`${HEAD_LNX}tool --api-key ${LQ}k3y value${LQ}${LONG}${TAIL_LNX}`, 'tool --api-key <redacted> -v x=1 '],
      [`${HEAD_LNX}PGPASSWORD=${OQ}hunter 2 pg${OQ} psql${LONG}${TAIL_LNX}`, 'PGPASSWORD=<redacted> psql -v x=1 '],
    ]) {
      const out = displayCommand(cmd)
      expect(out.startsWith(shown), out.slice(0, 80)).toBe(true)
      expect(out).not.toMatch(/hunter|k3y/)
    }
    // Exactly 4,000 characters counts as cut, since the OS readers stop there too.
    const cut = `${HEAD_WIN}PGPASSWORD=${WQ}hunter 2 pg${WQ} psql${LONG}${TAIL_WIN}`
    expect(displayCommand(cut.slice(0, 4_000)).startsWith('PGPASSWORD=<redacted> psql -v x=1 ')).toBe(true)
    // One shorter was not cut, and with its tail missing nothing says the harness wrapped it.
    const whole = displayCommand(cut.slice(0, 3_999))
    expect(whole.startsWith(String.raw`"C:\Program Files\Git\bin\bash.exe" -c -l "source `)).toBe(true)
    expect(whole).toContain("eval 'PGPASSWORD=<redacted> psql -v x=1 ")
  })

  it('shows the whole command line when nothing confirms a cut command is the harness', () => {
    for (const cmd of [
      // Short enough that the tail would have been read, and it is not there.
      `${HEAD_LNX.slice(0, -1)}'echo hi'`,
      // The eval word ended, and something other than the harness tail follows it.
      `${HEAD_LNX}a'; rm -rf ~/work${LONG}`,
      // No harness head before the eval.
      `bash -c "rm -rf ~/work; eval 'echo hi${LONG}`,
    ]) {
      expect(displayCommand(cmd).startsWith(cmd.slice(0, 80))).toBe(true)
    }
  })

  it('masks secret JSON fields at every level of quoting a Windows command line nests them in', () => {
    expect(
      displayCommand(`${HEAD_WIN}curl -d ${WQ}{\\"username\\":\\"deploy\\",\\"password\\":\\"Winter2026!Blue\\"}${WQ} https://x${TAIL_WIN}`),
    ).toBe(`curl -d '{"username":"deploy","password":"<redacted>"}' https://x`)
    // A backslash inside the value is still part of the secret.
    expect(displayCommand(String.raw`curl -d '{"password":"C:\vault\pw 2"}' https://x`)).toBe(`curl -d '{"password":"<redacted>"}' https://x`)
    expect(
      displayCommand(
        String.raw`${HEAD_WIN}powershell -Command \"Invoke-RestMethod -Body ${WQ}{\\\"password\\\":\\\"Winter2026!Blue\\\",\\\"client_secret\\\":\\\"s3cr3t-Value\\\"}${WQ}\"${TAIL_WIN}`,
      ),
    ).toBe(String.raw`powershell -Command "Invoke-RestMethod -Body '{\"password\":\"<redacted>\",\"client_secret\":\"<redacted>\"}'"`)
    // Outside the harness nothing is unwrapped, so the backslashes stay in what is shown.
    expect(
      displayCommand(String.raw`"C:\Program Files\Git\bin\bash.exe" -c "curl -d \"{\\\"username\\\":\\\"deploy\\\",\\\"password\\\":\\\"Winter2026!Blue\\\"}\" https://x"`),
    ).toBe(String.raw`"C:\Program Files\Git\bin\bash.exe" -c "curl -d \"{\\\"username\\\":\\\"deploy\\\",\\\"password\\\":\\\"<redacted>\\\"}\" https://x"`)
    expect(displayCommand(String.raw`"C:\Program Files\Git\bin\bash.exe" -c "curl -d \"{\\\"token\\\": \\\"abc def\\\", \\\"n\\\": 1}\" https://x"`)).toBe(
      String.raw`"C:\Program Files\Git\bin\bash.exe" -c "curl -d \"{\\\"token\\\": \\\"<redacted>\\\", \\\"n\\\": 1}\" https://x"`,
    )
  })

  it("masks a value quoted the way the harness quotes a quote, even where it is not unwrapped", () => {
    expect(displayCommand(`bash -c "eval 'PGPASSWORD=${WQ}hunter 2 pg${WQ} psql' ; echo"`)).toBe(`bash -c "eval 'PGPASSWORD=<redacted> psql' ; echo"`)
    expect(displayCommand(`bash -c "tool --password ${LQ}hunter 2 pw${LQ} -v"`)).toBe('bash -c "tool --password <redacted> -v"')
    expect(displayCommand(`bash -c 'tool --password ${OQ}hunter 2 pw${OQ} -v'`)).toBe("bash -c 'tool --password <redacted> -v'")
    const cut = displayCommand(`/bin/bash -c -l eval 'PGPASSWORD=${LQ}hunter 2 pg${LQ} psql${LONG}${TAIL_LNX}`)
    expect(cut.startsWith("/bin/bash -c -l eval 'PGPASSWORD=<redacted> psql -v x=1 ")).toBe(true)
  })

  // A quoted ; & or | before a password flag is part of an argument, not the end of the command.
  it.each([
    ['curl "https://api.example.com/items?page=1&limit=50" -b "sessionid=abc123def456ghi"', 'curl "https://api.example.com/items?page=1&limit=50" -b <redacted>'],
    ['mysql -h db -e "SELECT 1; SELECT 2" -phunter2mysql app', 'mysql -h db -e "SELECT 1; SELECT 2" -p<redacted> app'],
    ['mysqldump --where="a=1 && b=2" -phunter2mysql app', 'mysqldump --where="a=1 && b=2" -p<redacted> app'],
    ['redis-cli -h host --pattern "a|b" -a hunter2redis', 'redis-cli -h host --pattern "a|b" -a <redacted>'],
    ['sshpass -v -P "passphrase;" -p hunter2ssh ssh host', 'sshpass -v -P "passphrase;" -p <redacted> ssh host'],
    ['curl -H "Accept: text/html; q=0.9" -b "sid=abc123def456ghi" https://x', 'curl -H "Accept: text/html; q=0.9" -b <redacted> https://x'],
    ['docker login -u "bob; x" -p hunter2 ghcr.io', 'docker login -u "bob; x" -p <redacted> ghcr.io'],
    [`${HEAD_WIN}curl ${WQ}https://api.example.com/items?page=1&limit=50${WQ} -b ${WQ}sid=abc${WQ}${TAIL_WIN}`, "curl 'https://api.example.com/items?page=1&limit=50' -b <redacted>"],
    [
      String.raw`"C:\Program Files\Git\bin\bash.exe" -c "curl \"https://api.example.com/items?page=1&limit=50\" -b \"sid=abc\""`,
      String.raw`"C:\Program Files\Git\bin\bash.exe" -c "curl \"https://api.example.com/items?page=1&limit=50\" -b <redacted>"`,
    ],
  ])('masks a password flag after a quoted operator: %s', (input, expected) => {
    expect(displayCommand(input)).toBe(expected)
  })

  it('still ends the command at an operator that is not quoted', () => {
    expect(displayCommand('curl https://x && echo -b notacookie')).toBe('curl https://x && echo -b notacookie')
  })

  it.each([
    ['curl -u admin:"hunter2curl" https://x', 'curl -u admin:<redacted> https://x'],
    ["curl -u 'admin':hunter2curl https://x", "curl -u 'admin':<redacted> https://x"],
    [`curl -u "admin:pa'ssw0rdXYZ" https://x`, 'curl -u "admin:<redacted>" https://x'],
    [`curl -u "bob's:pw word" https://x`, `curl -u "bob's:<redacted>" https://x`],
    ['curl -u "admin":"x" https://x', 'curl -u "admin":<redacted> https://x'],
    [String.raw`bash -c "curl -u \"admin:x\" https://x"`, String.raw`bash -c "curl -u \"admin:<redacted>\" https://x"`],
    ['curl -u :token123 https://x', 'curl -u :<redacted> https://x'],
    ['curl -uadmin:x https://x', 'curl -uadmin:<redacted> https://x'],
    ['curl --user=admin:x https://x', 'curl --user=admin:<redacted> https://x'],
    ["curl --proxy-user 'bob:pw word' https://x", "curl --proxy-user 'bob:<redacted>' https://x"],
  ])('masks the password of curl -u however the user part is quoted: %s', (input, expected) => {
    expect(displayCommand(input)).toBe(expected)
  })

  it('leaves a -u that carries no password alone', () => {
    for (const cmd of ['git push -u origin main', 'curl -u admin https://x']) expect(displayCommand(cmd)).toBe(cmd)
  })

  it('stays fast on adversarial command lines just under the 4,000-character cut', () => {
    for (const cmd of [
      `curl -d ${'\\'.repeat(3_990)}`,
      `curl -d "${'\\\\"password\\\\":'.repeat(250)}`,
      `curl -d "${'token'.repeat(790)}`,
      `docker login ${'"'.repeat(3_980)} -p`,
      `mysql ${`-e "a" '`.repeat(495)} -p`,
      `curl -u ${`"a:\\"`.repeat(790)}`,
      `curl -b ${`'a'"b"`.repeat(600)}`,
      // Cut, with a head, so every eval is checked against it.
      `${HEAD_LNX}x' ${"eval 'x' ".repeat(440)}`,
    ]) {
      const started = performance.now()
      displayCommand(cmd)
      expect(performance.now() - started, cmd.slice(0, 40)).toBeLessThan(1_000)
    }
  })
})

describe('parseWindowsProcesses', () => {
  it('reads the JSON even with a BOM and a stray line around it', () => {
    const out = '\uFEFFWARNING: something\r\n[{"i":4,"p":0,"n":"System","c":null,"t":0,"u":0,"m":0,"x":0,"s":false}]\r\n'
    expect(parseWindowsProcesses(out)).toEqual([
      { pid: 4, ppid: 0, name: 'system', cmd: '', created: 0, cpuSec: 0, memBytes: 0, suspended: false, scope: 0 },
    ])
  })

  it('maps every field, and reads anything malformed as a safe default', () => {
    const out = JSON.stringify([
      { i: 1234, p: 5, n: 'GIT.EXE', c: 'git status', t: -5, u: 25_000_000, m: 1_048_576, x: 1, s: true },
      { i: 8 },
      { i: 9, p: '5', s: 1 },
    ])
    expect(parseWindowsProcesses(out)).toEqual([
      { pid: 1234, ppid: 5, name: 'git', cmd: 'git status', created: 0, cpuSec: 2.5, memBytes: 1_048_576, suspended: true, scope: 1 },
      { pid: 8, ppid: 0, name: '', cmd: '', created: 0, cpuSec: 0, memBytes: 0, suspended: false, scope: 0 },
      { pid: 9, ppid: 0, name: '', cmd: '', created: 0, cpuSec: 0, memBytes: 0, suspended: false, scope: 0 },
    ])
  })

  it('skips entries without a usable pid', () => {
    expect(parseWindowsProcesses('[null, 1, "x", [], {"i":"5"}, {"i":1.5}, {"i":-1}, {"i":7}]').map((p) => p.pid)).toEqual([7])
  })

  it('says what went wrong when there is no list to read', () => {
    expect(() => parseWindowsProcesses('')).toThrow('Could not list processes: PowerShell returned nothing')
    expect(() => parseWindowsProcesses('][')).toThrow('Could not list processes: PowerShell returned nothing')
    expect(() => parseWindowsProcesses('[{bad]')).toThrow('Could not list processes: PowerShell returned a list that could not be read')
  })
})

const NETSTAT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234',
  '  TCP    [::]:5055              [::]:0                 LISTENING       4321',
  '  TCP    127.0.0.1:8080         0.0.0.0:0              ABHÖREN         777',
  '  tcp    127.0.0.1:9090         0.0.0.0:0              LISTEN          777',
  '  TCP    10.0.0.5:50000         20.1.2.3:443           ESTABLISHED     999',
  '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       0',
  '  TCP    0.0.0.0:99             0.0.0.0:0              LISTENING       abc',
  '  TCP    nonsense               0.0.0.0:0              LISTENING       55',
  '  UDP    0.0.0.0:5353           *:*                                    888',
  '  UDP    0.0.0.0:500            0.0.0.0:0              X               888',
].join('\r\n')

describe('port tables', () => {
  it('reads listeners from netstat by their foreign address, whatever the state is called', () => {
    expect(parseNetstat(NETSTAT)).toEqual(
      new Map([
        [1234, [135]],
        [4321, [5055]],
        [777, [8080, 9090]],
      ]),
    )
  })

  it('reads every pid holding a socket from ss', () => {
    const out = [
      'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
      'LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*     users:(("systemd-resolve",pid=812,fd=14))',
      'LISTEN 0      128          0.0.0.0:22         0.0.0.0:*     users:(("sshd",pid=1001,fd=3),("sshd",pid=1002,fd=3))',
      'LISTEN 0      128             [::]:22            [::]:*     users:(("sshd",pid=1001,fd=4))',
      'LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*',
      'LISTEN 0      5      /run/x.sock',
      'LISTEN 0',
    ].join('\n')
    expect(parseSs(out)).toEqual(
      new Map([
        [812, [53]],
        [1001, [22]],
        [1002, [22]],
      ]),
    )
  })

  it('reads lsof field output', () => {
    const out = ['p123', 'f10', 'n*:8080', 'n127.0.0.1:9000', 'n*:8080', 'p456', 'n[::1]:5432', 'pjunk', 'n*:1111', 'p789', 'n/dev/null', ''].join('\n')
    expect(parseLsof(out)).toEqual(
      new Map([
        [123, [8080, 9000]],
        [456, [5432]],
      ]),
    )
  })
})

describe('parseClock', () => {
  it.each([
    ['05:07', 307],
    ['01:02:03', 3723],
    ['2-03:04:05', 183_845],
    ['00:01.50', 1.5],
    ['  12:34  ', 754],
    ['0:00.05', 0.05],
    ['123:45.67', 7425.67],
    ['garbage', 0],
    ['', 0],
  ])('%j → %d', (input, seconds) => {
    expect(parseClock(input)).toBeCloseTo(seconds, 6)
  })
})

describe('parsePosixProcesses', () => {
  it('joins the two ps passes, drops zombies and repairs names Linux cut at 15 characters', () => {
    const stat = [
      '    1     0     0 Ss   10-00:00:00 00:01:02  1200 systemd',
      ' 2000     1  1000 S       05:00 00:00:03  8000 git-remote-http',
      ' 2001     1  1000 Z       00:10 00:00:00     0 git',
      ' 2002     1  1000 T+   01:00:00 00:00:00  3000 -bash',
      ' 2003     1  1000 S       00:30 00:00:00   100 abcdefghijklmno',
      ' 2004     1  1000 t       00:30 00:00:00   100 fifteen-chars-x',
      'garbage line',
      '',
    ].join('\n')
    const args = [
      '    1 /sbin/init splash',
      ' 2000 /usr/lib/git-core/git-remote-https origin https://github.com/x/y.git',
      ' 2001 [git] <defunct>',
      ' 2002 -bash',
      ' 2003 /opt/bin/zzz --flag',
      '',
    ].join('\n')
    expect(parsePosixProcesses(stat, args, NOW, 'linux')).toEqual([
      { pid: 1, ppid: 0, name: 'systemd', cmd: '/sbin/init splash', created: NOW - 864_000_000, cpuSec: 62, memBytes: 1_228_800, suspended: false, scope: 0 },
      {
        pid: 2000,
        ppid: 1,
        name: 'git-remote-https',
        cmd: '/usr/lib/git-core/git-remote-https origin https://github.com/x/y.git',
        created: NOW - 300_000,
        cpuSec: 3,
        memBytes: 8_192_000,
        suspended: false,
        scope: 1000,
      },
      { pid: 2002, ppid: 1, name: 'bash', cmd: '-bash', created: NOW - 3_600_000, cpuSec: 0, memBytes: 3_072_000, suspended: true, scope: 1000 },
      { pid: 2003, ppid: 1, name: 'abcdefghijklmno', cmd: '/opt/bin/zzz --flag', created: NOW - 30_000, cpuSec: 0, memBytes: 102_400, suspended: false, scope: 1000 },
      { pid: 2004, ppid: 1, name: 'fifteen-chars-x', cmd: '', created: NOW - 30_000, cpuSec: 0, memBytes: 102_400, suspended: true, scope: 1000 },
    ])
  })

  it("takes the executable's basename on macOS, and leaves 15-character names alone there", () => {
    const stat = [
      '  300     1   501 S       01:00 00:00:01  2048 /Applications/Termpolis.app/Contents/Frameworks/Termpolis Helper (Renderer).app/Contents/MacOS/Termpolis Helper (Renderer)',
      '  301     1   501 S       01:00 00:00:00  1024 git-remote-http',
    ].join('\n')
    const out = parsePosixProcesses(stat, '  301 git-remote-https origin', NOW, 'darwin')
    expect(out.map((p) => [p.pid, p.name, p.cmd])).toEqual([
      [300, 'termpolis helper (renderer)', ''],
      [301, 'git-remote-http', 'git-remote-https origin'],
    ])
    expect(out[0]).toMatchObject({ created: NOW - 60_000, cpuSec: 1, memBytes: 2_097_152, scope: 501 })
  })

  it('never computes a start time before the epoch', () => {
    expect(parsePosixProcesses('  5 1 0 S 01:00 00:00 1 sh', '', 1000, 'linux')[0].created).toBe(0)
  })

  it('keeps at most 4,000 characters of a command line', () => {
    const [p] = parsePosixProcesses('  7 1 0 S 01:00 00:00 1 node', `  7 node ${'x'.repeat(5_000)}`, NOW, 'linux')
    expect(p.cmd).toHaveLength(4_000)
    expect(p.cmd.startsWith('node xx')).toBe(true)
  })
})

describe('parseMsysPs', () => {
  it('maps each Windows pid to the Windows pid of its POSIX parent, 0 when it has none', () => {
    const out = [
      '      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND',
      '      201       1     201       5001  ?         197609 12:00:00 /usr/bin/bash',
      'S     202     201     201       5002  pty0      197609 12:00:01 /usr/bin/sleep',
      'I     203     202     201       5003  pty0      197609 12:00:02 /usr/bin/cat',
      // A parent this ps did not list: gone, or another install's.
      '      204     999     204       5004  ?         197609 12:00:03 /usr/bin/tail',
      // Never its own parent, whatever the table says.
      '      205     205     205       5005  ?         197609 12:00:04 /usr/bin/jq',
      '',
      'ps: not a row',
      '     12 34 56',
    ].join('\r\n')
    expect(parseMsysPs(out)).toEqual(
      new Map([
        [5001, 0],
        [5002, 5001],
        [5003, 5002],
        [5004, 0],
      ]),
    )
    expect(parseMsysPs('')).toEqual(new Map())
  })
})

type Call = { bin: string; args: string[]; opts?: ProcOptions }

/** A runner that records every call and answers with `respond` (which may throw). */
function recorder(calls: Call[], respond: (bin: string, args: string[]) => ProcOutcome): StuckRunner {
  return async (bin, args, opts) => {
    calls.push({ bin, args, opts })
    return respond(bin, args)
  }
}

const LIST = JSON.stringify([{ i: 4, p: 0, n: 'System', t: 0, x: 0 }])
const SYSTEM: ProcRecord = { pid: 4, ppid: 0, name: 'system', cmd: '', created: 0, cpuSec: 0, memBytes: 0, suspended: false, scope: 0 }
const SCAN_OPTS = { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }
const isList = (bin: string): boolean => bin.toLowerCase().endsWith('powershell.exe')

describe('takeProcessSnapshot — Windows', () => {
  it('runs one PowerShell pass and netstat from System32, with the script as a plain argument', async () => {
    const calls: Call[] = []
    const out = await takeProcessSnapshot({
      platform: 'win32',
      env: { SystemRoot: 'D:\\Win' },
      now: () => 42,
      runner: recorder(calls, (bin) => ({ stdout: isList(bin) ? LIST : NETSTAT, stderr: '' })),
    })
    expect(calls.map((c) => c.bin)).toEqual(['D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'D:\\Win\\System32\\NETSTAT.EXE'])
    expect(calls[0].args).toHaveLength(4)
    expect(calls[0].args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    const script = calls[0].args[3]
    // One argv element, so no double quotes, and never -EncodedCommand (an AV heuristic).
    expect(script).not.toContain('"')
    expect(script).not.toMatch(/encodedcommand/i)
    expect(script).toContain('Get-CimInstance Win32_Process')
    // A command line is cut to 4,000 characters before it leaves PowerShell.
    expect(script).toContain('$c.Substring(0, 4000)')
    expect(calls[1].args).toEqual(['-ano'])
    for (const c of calls) expect(c.opts).toEqual(SCAN_OPTS)
    expect(out).toEqual({
      procs: [SYSTEM],
      listening: new Map([
        [1234, [135]],
        [4321, [5055]],
        [777, [8080, 9090]],
      ]),
      takenAt: 42,
      platform: 'win32',
      warnings: [],
      msysParents: new Map(),
    })
  })

  it('finds System32 from SystemRoot, then windir, then the default', async () => {
    const binFor = async (env: NodeJS.ProcessEnv | undefined): Promise<string> => {
      const calls: Call[] = []
      await takeProcessSnapshot({ platform: 'win32', ...(env ? { env } : {}), runner: recorder(calls, () => ({ stdout: LIST, stderr: '' })) })
      return calls[0].bin
    }
    expect(await binFor({ SystemRoot: '', windir: 'E:\\W' })).toBe('E:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(await binFor({})).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(await binFor(undefined)).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/)
  })

  it('stamps the snapshot with the current time by default', async () => {
    const before = Date.now()
    const out = await takeProcessSnapshot({ platform: 'win32', env: {}, runner: async () => ({ stdout: LIST, stderr: '' }) })
    expect(out.takenAt).toBeGreaterThanOrEqual(before)
    expect(out.takenAt).toBeLessThanOrEqual(Date.now())
  })

  it('refuses with the reason when the process list could not be read', async () => {
    const failWith = (list: () => ProcOutcome) =>
      takeProcessSnapshot({ platform: 'win32', env: {}, runner: async (bin) => (isList(bin) ? list() : { stdout: '', stderr: '' }) })
    await expect(failWith(() => ({ stdout: '', stderr: 'Access denied\r\n', error: { message: 'Command failed', code: 1 } }))).rejects.toThrow(
      'Could not list processes: Access denied',
    )
    await expect(failWith(() => ({ stdout: '', stderr: '  ', error: { message: 'spawn EACCES', code: 'EACCES' } }))).rejects.toThrow(
      'Could not list processes: spawn EACCES',
    )
    await expect(
      failWith(() => {
        throw new Error('proc host timed out')
      }),
    ).rejects.toThrow('Could not list processes: proc host timed out')
    await expect(
      failWith(() => {
        throw 'boom'
      }),
    ).rejects.toThrow('Could not list processes: boom')
    // No error, but nothing printed either.
    await expect(failWith(() => ({ stdout: '', stderr: '' }))).rejects.toThrow('Could not list processes: PowerShell returned nothing')
  })

  it('still reads a list that PowerShell printed before it failed', async () => {
    const out = await takeProcessSnapshot({
      platform: 'win32',
      env: {},
      runner: async (bin) => (isList(bin) ? { stdout: LIST, stderr: 'WARNING', error: { message: 'exit 1', code: 1 } } : { stdout: '', stderr: '' }),
    })
    expect(out.procs).toEqual([SYSTEM])
  })

  it('marks the port table unknown, rather than empty, when netstat fails outright', async () => {
    const net = (outcome: ProcOutcome) =>
      takeProcessSnapshot({ platform: 'win32', env: {}, runner: async (bin) => (isList(bin) ? { stdout: LIST, stderr: '' } : outcome) })
    const failed = await net({ stdout: ' \r\n', stderr: '', error: { message: 'spawn ENOENT', code: 'ENOENT' } })
    expect(failed.listening).toBeNull()
    expect(failed.warnings).toEqual([PORTS_UNKNOWN])
    const partial = await net({ stdout: NETSTAT, stderr: '', error: { message: 'exit 1', code: 1 } })
    expect(partial.listening?.get(1234)).toEqual([135])
    expect(partial.warnings).toEqual([])
  })

  it('marks the port table unknown when netstat timed out or was killed, since it printed only part of it', async () => {
    const net = (outcome: ProcOutcome) =>
      takeProcessSnapshot({ platform: 'win32', env: {}, runner: async (bin) => (isList(bin) ? { stdout: LIST, stderr: '' } : outcome) })
    for (const error of [
      { message: 'Command timed out', killed: true, signal: 'SIGTERM' },
      { message: 'terminated', signal: 'SIGKILL' },
      { message: 'killed', killed: true },
    ]) {
      const cut = await net({ stdout: NETSTAT, stderr: '', error })
      expect(cut.listening, error.message).toBeNull()
      expect(cut.warnings, error.message).toEqual([PORTS_UNKNOWN])
    }
  })
})

/** The PowerShell list for these processes, as the scan script prints it. */
function listOf(procs: ProcRecord[]): string {
  return JSON.stringify(
    procs.map((p) => ({ i: p.pid, p: p.ppid, n: p.name, c: p.cmd, t: p.created, u: p.cpuSec * 1e7, m: p.memBytes, x: p.scope, s: p.suspended })),
  )
}

const isPs = (bin: string): boolean => bin.toLowerCase().endsWith('\\ps.exe')
const GB_ENV = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', USERPROFILE: 'C:\\Users\\Dev' }
/** `ps -a` from the Git install for pipeline(): a Windows program started bash, and bash started sleep. */
const PS_A = [
  '      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND',
  '     1234       1    1234        300  ?         197609 12:00:00 /usr/bin/bash',
  '     1240    1234    1234        302  ?         197609 12:00:01 /usr/bin/sleep',
].join('\n')

async function gitBashSnapshot(
  procs: ProcRecord[],
  over: { env?: NodeJS.ProcessEnv; ps?: () => ProcOutcome } = {},
): Promise<{ snap: ProcSnapshot; ps: Call[] }> {
  const calls: Call[] = []
  const snap = await takeProcessSnapshot({
    platform: 'win32',
    selfPid: SELF,
    env: over.env ?? GB_ENV,
    runner: recorder(calls, (bin) => {
      if (isList(bin)) return { stdout: listOf(procs), stderr: '' }
      if (isPs(bin)) return over.ps ? over.ps() : { stdout: PS_A, stderr: '' }
      return { stdout: NETSTAT, stderr: '' }
    }),
  })
  return { snap, ps: calls.filter((c) => isPs(c.bin)) }
}

/** An MSYS program whose Windows parent is gone, started from `image`. */
const lostParent = (pid: number, image: string): ProcRecord =>
  proc(pid, { name: 'sleep', ppid: 999, cmd: `"${image}" 999`, created: NOW - 20 * MIN })

describe('takeProcessSnapshot — Git Bash parents', () => {
  it("asks the install's own ps.exe for the POSIX parent of a program whose Windows parent is gone", async () => {
    const { snap, ps } = await gitBashSnapshot([...base(), ...pipeline()])
    expect(ps).toEqual([{ bin: `${GB}\\ps.exe`, args: ['-a'], opts: SCAN_OPTS }])
    expect(snap.msysParents).toEqual(
      new Map([
        [300, 0],
        [302, 300],
      ]),
    )
    expect(snap.warnings).toEqual([])
    // So the running pipeline is nobody's orphan, and "Kill all stuck" leaves it alone.
    expect(classifyProcesses(snap, { selfPid: SELF }).rows).toEqual([])
  })

  it('asks nothing when every Git Bash program still has its Windows parent', async () => {
    const { snap, ps } = await gitBashSnapshot([
      ...base(),
      code(),
      proc(300, { name: 'bash', ppid: 20, cmd: `"${GB}\\bash.exe" -l`, created: NOW - 20 * MIN }),
      proc(302, { name: 'sleep', ppid: 300, cmd: `"${GB}\\sleep.exe" 999`, created: NOW - 19 * MIN }),
    ])
    expect(ps).toEqual([])
    expect(snap.msysParents).toEqual(new Map())
    expect(snap.warnings).toEqual([])
  })

  it('asks nothing when Termpolis is missing from the list, or about another session', async () => {
    // Nothing is listed without Termpolis itself, so there is nothing to ask about.
    expect((await gitBashSnapshot(pipeline())).ps).toEqual([])
    const elsewhere = pipeline().map((p) => (p.pid === 302 ? { ...p, scope: 2 } : p))
    const { snap, ps } = await gitBashSnapshot([...base(), ...elsewhere])
    expect(ps).toEqual([])
    expect(snap.warnings).toEqual([])
  })

  it('asks each install once, however its path is spelled, and at most three', async () => {
    const same = await gitBashSnapshot([
      ...base(),
      lostParent(300, `${GB}\\sleep.exe`),
      lostParent(301, String.raw`C:\PROGRAM FILES\GIT\USR\BIN\cat.exe`),
      lostParent(302, 'C:/Program Files/Git/usr/bin/tail.exe'),
    ])
    expect(same.ps.map((c) => c.bin)).toEqual([`${GB}\\ps.exe`])
    expect(same.snap.warnings).toEqual([])

    const many = await gitBashSnapshot([
      ...base(),
      lostParent(300, `${GB}\\sleep.exe`),
      lostParent(301, String.raw`C:\msys64\usr\bin\sleep.exe`),
      lostParent(302, String.raw`C:\cygwin64\bin\sleep.exe`),
      lostParent(303, String.raw`C:\Users\Dev\scoop\apps\git\current\usr\bin\sleep.exe`),
    ])
    expect(many.ps.map((c) => c.bin)).toEqual([
      `${GB}\\ps.exe`,
      String.raw`C:\msys64\usr\bin\ps.exe`,
      String.raw`C:\cygwin64\bin\ps.exe`,
    ])
    expect(many.snap.warnings).toEqual([MSYS_UNKNOWN])
  })

  it('never runs a ps.exe from outside a known install location', async () => {
    for (const image of [
      String.raw`\\server\share\usr\bin\sleep.exe`,
      String.raw`C:\Users\Dev\AppData\LocalLow\x\usr\bin\sleep.exe`,
      String.raw`C:\Users\Dev\AppData\Local\Temp\Low\x\usr\bin\sleep.exe`,
      String.raw`D:\stuff\usr\bin\sleep.exe`,
      String.raw`C:\Program Files\Git\..\..\evil\usr\bin\sleep.exe`,
      String.raw`C:\Program Files Evil\usr\bin\sleep.exe`,
      // Folders a sandboxed app, or anything at all, can write to.
      String.raw`C:\Users\Dev\AppData\Local\Packages\Contoso.App_8wekyb3d8bbwe\AC\usr\bin\sleep.exe`,
      String.raw`C:\Users\Dev\AppData\Local\Temp\x\usr\bin\sleep.exe`,
      String.raw`C:\Users\Dev\Documents\x\usr\bin\sleep.exe`,
      String.raw`C:\Users\Dev\Downloads\PortableGit\usr\bin\sleep.exe`,
    ]) {
      const { snap, ps } = await gitBashSnapshot([...base(), lostParent(300, image)])
      expect(ps, image).toEqual([])
      expect(snap.warnings, image).toEqual([MSYS_UNKNOWN])
    }
  })

  it('trusts Program Files, %LOCALAPPDATA%, Scoop and the usual MSYS2 and Cygwin roots, but never a whole drive', async () => {
    const asks = async (image: string, env: NodeJS.ProcessEnv): Promise<boolean> =>
      (await gitBashSnapshot([...base(), lostParent(300, image)], { env })).ps.length === 1
    expect(await asks(String.raw`C:\Program Files\Git\usr\bin\sleep.exe`, { ProgramW6432: 'C:\\Program Files' })).toBe(true)
    expect(await asks(String.raw`C:\Program Files (x86)\Git\usr\bin\sleep.exe`, { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' })).toBe(true)
    expect(await asks(String.raw`C:\Program Files\Git\usr\bin\sleep.exe`, { ProgramFiles: 'C:\\Program Files\\' })).toBe(true)
    expect(await asks(String.raw`C:\Users\Dev\scoop\apps\git\current\usr\bin\sleep.exe`, { USERPROFILE: 'C:\\Users\\Dev' })).toBe(true)
    expect(await asks(String.raw`D:\scoop\apps\git\current\usr\bin\sleep.exe`, { SCOOP: 'D:\\scoop' })).toBe(true)
    // A per-user Git lives in %LOCALAPPDATA%\Programs; its Packages folder belongs to sandboxed apps.
    expect(await asks(String.raw`C:\Users\Dev\AppData\Local\Programs\Git\usr\bin\sleep.exe`, { USERPROFILE: 'C:\\Users\\Dev' })).toBe(true)
    expect(await asks(String.raw`D:\Local\Programs\Git\usr\bin\sleep.exe`, { LOCALAPPDATA: 'D:\\Local' })).toBe(true)
    const local = { LOCALAPPDATA: 'C:\\Users\\Dev\\AppData\\Local\\' }
    expect(await asks(String.raw`C:\Users\Dev\AppData\Local\Programs\Git\usr\bin\sleep.exe`, local)).toBe(true)
    expect(await asks(String.raw`C:\Users\Dev\AppData\Local\Packages\App_1\AC\usr\bin\sleep.exe`, local)).toBe(false)
    expect(await asks(String.raw`C:\msys64\usr\bin\sleep.exe`, {})).toBe(true)
    expect(await asks(String.raw`C:\tools\msys64\usr\bin\sleep.exe`, {})).toBe(true)
    expect(await asks(String.raw`D:\msys64\usr\bin\sleep.exe`, { SystemDrive: 'D:' })).toBe(true)
    expect(await asks(String.raw`D:\msys64\usr\bin\sleep.exe`, {})).toBe(false)
    expect(await asks(String.raw`C:\Program Files\Git\usr\bin\sleep.exe`, {})).toBe(false)
    // A profile at the root of a drive would trust everything on it.
    expect(await asks(String.raw`C:\anything\usr\bin\sleep.exe`, { USERPROFILE: 'C:\\' })).toBe(false)
    expect(await asks(String.raw`C:\anything\usr\bin\sleep.exe`, { LOCALAPPDATA: 'C:\\' })).toBe(false)
  })

  it('leaves Git Bash programs unmarked when ps.exe fails, but reads what it printed before failing', async () => {
    const procs = [...base(), ...pipeline()]
    const failed = await gitBashSnapshot(procs, { ps: () => ({ stdout: ' \n', stderr: 'boom', error: { message: 'exit 1', code: 1 } }) })
    expect(failed.snap.msysParents).toEqual(new Map())
    expect(failed.snap.warnings).toEqual([MSYS_UNKNOWN])
    // Unconfirmed is not orphaned: the pipeline is not offered for killing.
    const cls = classifyProcesses(failed.snap, { selfPid: SELF })
    expect(cls.rows).toEqual([])
    expect(cls.warnings).toEqual([MSYS_UNKNOWN])

    const threw = await gitBashSnapshot(procs, {
      ps: () => {
        throw new Error('proc host timed out')
      },
    })
    expect(threw.snap.msysParents).toEqual(new Map())
    expect(threw.snap.warnings).toEqual([MSYS_UNKNOWN])

    const partial = await gitBashSnapshot(procs, { ps: () => ({ stdout: PS_A, stderr: '', error: { message: 'exit 1', code: 1 } }) })
    expect(partial.snap.msysParents).toEqual(
      new Map([
        [300, 0],
        [302, 300],
      ]),
    )
    expect(partial.snap.warnings).toEqual([])
  })
})

const PS_STAT = ['  1  0    0 Ss 10:00 00:00 100 systemd', ' 42  1 1000 S  05:00 00:01 200 git'].join('\n')
const PS_ARGS = ['  1 /sbin/init', ' 42 git fetch'].join('\n')
const SS_OUT = 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=42,fd=3))'

function posixRunner(calls: Call[], over: { stat?: ProcOutcome; args?: ProcOutcome; ports?: ProcOutcome; launchctl?: ProcOutcome } = {}): StuckRunner {
  return recorder(calls, (bin, args) => {
    if (bin === '/bin/launchctl') return over.launchctl ?? { stdout: '', stderr: '' }
    if (args.includes('pid=,args=')) return over.args ?? { stdout: PS_ARGS, stderr: '' }
    if (args.some((a) => a.startsWith('pid=,ppid='))) return over.stat ?? { stdout: PS_STAT, stderr: '' }
    return over.ports ?? { stdout: SS_OUT, stderr: '' }
  })
}

describe('takeProcessSnapshot — POSIX', () => {
  it('runs ps twice and ss on Linux', async () => {
    const calls: Call[] = []
    const out = await takeProcessSnapshot({ platform: 'linux', now: () => NOW, runner: posixRunner(calls) })
    expect(calls.map((c) => [c.bin, c.args])).toEqual([
      ['ps', ['-A', '-ww', '-o', 'pid=,ppid=,uid=,stat=,etime=,time=,rss=,comm=']],
      ['ps', ['-A', '-ww', '-o', 'pid=,args=']],
      ['ss', ['-ltnp']],
    ])
    for (const c of calls) expect(c.opts).toEqual(SCAN_OPTS)
    expect(out.procs.map((p) => [p.pid, p.name, p.cmd, p.created])).toEqual([
      [1, 'systemd', '/sbin/init', NOW - 600_000],
      [42, 'git', 'git fetch', NOW - 300_000],
    ])
    expect(out.listening).toEqual(new Map([[42, [22]]]))
    expect(out).toMatchObject({ takenAt: NOW, platform: 'linux', warnings: [] })
  })

  it('refuses without a process list or command lines, and warns without a port table', async () => {
    const calls: Call[] = []
    await expect(
      takeProcessSnapshot({ platform: 'linux', runner: posixRunner(calls, { stat: { stdout: '', stderr: 'ps: not found', error: { message: 'x', code: 127 } } }) }),
    ).rejects.toThrow('Could not list processes: ps: not found')
    await expect(
      takeProcessSnapshot({ platform: 'linux', runner: posixRunner(calls, { args: { stdout: '\n', stderr: '', error: { message: 'spawn EAGAIN', code: 'EAGAIN' } } }) }),
    ).rejects.toThrow('Could not read command lines: spawn EAGAIN')
    const noPorts = await takeProcessSnapshot({
      platform: 'linux',
      runner: posixRunner(calls, { ports: { stdout: '', stderr: 'ss: not found', error: { message: 'x', code: 127 } } }),
    })
    expect(noPorts.listening).toBeNull()
    expect(noPorts.warnings).toEqual([PORTS_UNKNOWN])
    // ps exits non-zero when one process vanished mid-listing; what it printed still counts.
    const partial = await takeProcessSnapshot({ platform: 'linux', runner: posixRunner(calls, { stat: { stdout: PS_STAT, stderr: '', error: { message: 'x', code: 1 } } }) })
    expect(partial.procs).toHaveLength(2)
  })

  it('uses /bin/ps and lsof on macOS, where lsof exiting 1 means nothing is listening', async () => {
    const calls: Call[] = []
    const lsof = 'p42\nn*:8080'
    const out = await takeProcessSnapshot({ platform: 'darwin', runner: posixRunner(calls, { ports: { stdout: lsof, stderr: '' } }) })
    expect(calls.map((c) => [c.bin, c.args])).toEqual([
      ['/bin/ps', ['-A', '-ww', '-o', 'pid=,ppid=,uid=,stat=,etime=,time=,rss=,comm=']],
      ['/bin/ps', ['-A', '-ww', '-o', 'pid=,args=']],
      ['/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']],
    ])
    expect(out.listening).toEqual(new Map([[42, [8080]]]))
    const none = await takeProcessSnapshot({ platform: 'darwin', runner: posixRunner([], { ports: { stdout: '', stderr: '', error: { message: 'x', code: 1 } } }) })
    expect(none.listening).toEqual(new Map())
    expect(none.warnings).toEqual([])
    const broken = await takeProcessSnapshot({ platform: 'darwin', runner: posixRunner([], { ports: { stdout: '', stderr: '', error: { message: 'x', code: 2 } } }) })
    expect(broken.listening).toBeNull()
    expect(broken.warnings).toEqual([PORTS_UNKNOWN])
  })

  /** `ps` output rows, as `pid ppid uid comm` plus a fixed state, clock and memory. */
  const psRows = (rows: [number, number, number, string][]): ProcOutcome => ({
    stdout: rows.map(([pid, ppid, uid, comm]) => `${pid} ${ppid} ${uid} S 01:00:00 00:00:01 1000 ${comm}`).join('\n'),
    stderr: '',
  })
  const psArgs = (rows: [number, number, number, string][]): ProcOutcome => ({
    stdout: rows.map(([pid, , , comm]) => `${pid} ${comm}`).join('\n'),
    stderr: '',
  })
  const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

  it('asks which orphan-looking processes of its own user systemd runs as a service, and only those', async () => {
    const rows: [number, number, number, string][] = [
      [1, 0, 0, 'systemd'],
      [50, 1, 1000, 'systemd'],
      [SELF, 50, 1000, 'termpolis'],
      [200, 50, 1000, 'nightly'],
      [201, 50, 1000, 'git'],
      [202, 1, 1000, 'git'],
      [203, 1, 1000, 'backup'],
      [204, 50, 1000, 'git'],
      [205, 1, 1000, 'git'],
      [206, 1, 1000, 'git'],
      [207, 1, 1000, 'git'],
      [208, 1, 1000, 'git'],
      [209, 1, 1000, 'git'],
      [210, 999, 1000, 'git'],
      [300, SELF, 1000, 'bash'],
      [301, 200, 1000, 'git'],
      [400, 1, 0, 'cron'],
    ]
    const cgroups = new Map<string, string | NodeJS.ErrnoException>([
      ['/proc/50/cgroup', '0::/user.slice/user-1000.slice/user@1000.service/init.scope\n'],
      // A user service: a job, even though its parent is the user's systemd.
      ['/proc/200/cgroup', '0::/user.slice/user-1000.slice/user@1000.service/app.slice/nightly.service\n'],
      // Left behind by a closed ssh session and adopted by the user's systemd.
      ['/proc/201/cgroup', '0::/user.slice/user-1000.slice/session-2.scope\n'],
      ['/proc/202/cgroup', '0::/init.scope\n'],
      // cgroup v1 (hybrid): the name=systemd line wins over the empty unified one.
      ['/proc/203/cgroup', '12:memory:/system.slice/cron.service\n1:name=systemd:/system.slice/cron.service\n0::/\n'],
      // Directly in the user instance, which holds every user unit: not a job of its own.
      ['/proc/204/cgroup', '0::/user.slice/user-1000.slice/user@1000.service\n'],
      // No systemd hierarchy at all, only a controller.
      ['/proc/205/cgroup', '12:memory:/system.slice/foo.service\n'],
      ['/proc/206/cgroup', '0::/\n'],
      ['/proc/207/cgroup', errno('EACCES')],
      ['/proc/208/cgroup', errno('EACCES')],
      // Exited since the listing.
      ['/proc/209/cgroup', errno('ENOENT')],
      ['/proc/210/cgroup', '0::/user.slice/user-1000.slice/session-3.scope\n'],
    ])
    const read: string[] = []
    const readFile = async (file: string): Promise<string> => {
      read.push(file)
      const v = cgroups.get(file)
      if (v === undefined) throw new Error(`unexpected read of ${file}`)
      if (typeof v !== 'string') throw v
      return v
    }
    const calls: Call[] = []
    const out = await takeProcessSnapshot({ platform: 'linux', selfPid: SELF, readFile, runner: posixRunner(calls, { stat: psRows(rows), args: psArgs(rows) }) })
    expect(out.managedPids).toEqual(new Set([200, 203, 207, 208]))
    expect(out.warnings).toEqual([MANAGED_UNKNOWN])
    // Not itself, not what it started, not what a live parent holds, not another user's.
    expect(read.sort()).toEqual([...cgroups.keys()].sort())
    expect(calls.map((c) => c.bin)).not.toContain('/bin/launchctl')
  })

  it('asks about what init adopted even when init is not systemd, as in a container', async () => {
    const rows: [number, number, number, string][] = [
      // Root, as init is, so only the adopted git is asked about.
      [1, 0, 0, 'tini'],
      [SELF, 1, 1000, 'termpolis'],
      [250, 1, 1000, 'git'],
    ]
    const read: string[] = []
    const readFile = async (file: string): Promise<string> => {
      read.push(file)
      return '0::/system.slice/git-sync.service\n'
    }
    const out = await takeProcessSnapshot({ platform: 'linux', selfPid: SELF, readFile, runner: posixRunner([], { stat: psRows(rows), args: psArgs(rows) }) })
    expect(read).toEqual(['/proc/250/cgroup'])
    expect(out.managedPids).toEqual(new Set([250]))
  })

  it('reads /proc itself by default, and says nothing about a process that has exited', async () => {
    // No pid reaches 99999999 on Linux, so its cgroup file is missing on every platform.
    const rows: [number, number, number, string][] = [
      [1, 0, 0, 'systemd'],
      [SELF, 1, 1000, 'termpolis'],
      [99_999_999, 1, 1000, 'git'],
    ]
    const out = await takeProcessSnapshot({ platform: 'linux', selfPid: SELF, runner: posixRunner([], { stat: psRows(rows), args: psArgs(rows) }) })
    expect(out.managedPids).toEqual(new Set())
    expect(out.warnings).toEqual([])
  })

  describe('launchd jobs on macOS', () => {
    const rows: [number, number, number, string][] = [
      [1, 0, 0, '/sbin/launchd'],
      [SELF, 1, 501, '/Applications/Termpolis.app/Contents/MacOS/Termpolis'],
      [200, 1, 501, '/usr/local/bin/claude'],
      [201, 1, 501, '/usr/bin/git'],
      [300, SELF, 501, '/bin/zsh'],
      [400, 1, 0, '/usr/sbin/cfprefsd'],
    ]
    // Termpolis is a job too, but it is not one of the processes that look orphaned.
    const LIST = `PID\tStatus\tLabel\n${SELF}\t0\tapplication.com.termpolis.app.1\n200\t0\tcom.example.nightly\n-\t0\tcom.apple.idle\n400\t0\tcom.apple.cfprefsd.xpc.agent\n`
    const scan = (calls: Call[], launchctl?: ProcOutcome, list = rows) =>
      takeProcessSnapshot({ platform: 'darwin', selfPid: SELF, runner: posixRunner(calls, { stat: psRows(list), args: psArgs(list), ...(launchctl ? { launchctl } : {}) }) })

    it('asks launchctl once, and keeps only the jobs among the processes that look orphaned', async () => {
      const calls: Call[] = []
      const out = await scan(calls, { stdout: LIST, stderr: '' })
      const asked = calls.filter((c) => c.bin === '/bin/launchctl')
      expect(asked.map((c) => c.args)).toEqual([['list']])
      expect(asked[0].opts).toEqual(SCAN_OPTS)
      expect(out.managedPids).toEqual(new Set([200]))
      expect(out.warnings).toEqual([])
    })

    it('still reads a list launchctl printed before failing', async () => {
      const out = await scan([], { stdout: LIST, stderr: '', error: { message: 'x', code: 1 } })
      expect(out.managedPids).toEqual(new Set([200]))
      expect(out.warnings).toEqual([])
    })

    it('counts every candidate as a job, and says so, when launchctl gives no answer', async () => {
      const out = await scan([], { stdout: ' \n', stderr: 'launchctl: not found', error: { message: 'x', code: 127 } })
      expect(out.managedPids).toEqual(new Set([200, 201]))
      expect(out.warnings).toEqual([MANAGED_UNKNOWN])
    })

    it('does not ask at all when nothing looks orphaned', async () => {
      const calls: Call[] = []
      const out = await scan(calls, undefined, rows.filter(([pid]) => pid !== 200 && pid !== 201))
      expect(calls.map((c) => c.bin)).not.toContain('/bin/launchctl')
      expect(out.managedPids).toEqual(new Set())
    })
  })
})

describe('classifyProcesses — Windows', () => {
  it('flags nothing, and says so, when it cannot find itself', () => {
    const s = snap([proc(1, { name: 'git', cmd: 'git status' })], { warnings: ['earlier'] })
    const cls = classifyProcesses(s, { selfPid: SELF })
    expect(cls.rows).toEqual([])
    expect(cls.protectedPids).toEqual(new Set([SELF]))
    expect(cls.selfPid).toBe(SELF)
    expect(cls.warnings).toEqual(['earlier', SELF_MISSING])
    expect(cls.created.get(1)).toBe(NOW - 60 * MIN)
    // The snapshot's own list is not touched.
    expect(s.warnings).toEqual(['earlier'])
  })

  it('never lists itself, its ancestors or the children it depends on', () => {
    const cls = classify(base())
    expect(cls.rows).toEqual([])
    expect(cls.protectedPids).toEqual(new Set([SELF, 10, 101]))
  })

  it('lists the git and jq a status line left frozen when its bash died, as stuck', () => {
    const git = proc(500, { name: 'git', ppid: 499, cmd: 'git --no-optional-locks status --porcelain', created: NOW - 10 * MIN, suspended: true, cpuSec: 0.01, memBytes: 4096 })
    const jq = proc(501, { name: 'jq', ppid: 498, cmd: 'jq -r .model.display_name', created: NOW - 10 * MIN + 1000, suspended: true })
    const cls = classify([...base(), git, jq])
    expect(cls.rows).toEqual([
      {
        pid: 500,
        created: NOW - 10 * MIN,
        name: 'git',
        category: 'git',
        reasons: ['orphaned', 'suspended'],
        owner: 'orphaned',
        stuck: true,
        serving: [],
        ageMs: 10 * MIN,
        cpuSec: 0.01,
        memBytes: 4096,
        command: 'git --no-optional-locks status --porcelain',
        treeSize: 1,
        tree: [500],
      },
      {
        pid: 501,
        created: NOW - 10 * MIN + 1000,
        name: 'jq',
        category: 'leftover',
        reasons: ['orphaned', 'suspended'],
        owner: 'orphaned',
        stuck: true,
        serving: [],
        ageMs: 10 * MIN - 1000,
        cpuSec: 0,
        memBytes: 0,
        command: 'jq -r .model.display_name',
        treeSize: 1,
        tree: [501],
      },
    ])
  })

  it("does not take a younger process that inherited a dead parent's pid for the parent", () => {
    const git = proc(600, { name: 'git', ppid: 601, cmd: 'git fetch', created: NOW - 40 * MIN })
    const reused = proc(601, { name: 'chrome', ppid: 10, created: NOW - 2 * MIN })
    const cls = classify([...base(), git, reused])
    expect(pids(cls)).toEqual([600])
    expect(row(cls, 600)).toMatchObject({ owner: 'orphaned', reasons: ['orphaned', 'long-running'], stuck: true, category: 'git' })
    expect(row(cls, 600).parentName).toBeUndefined()
    expect(cls.children.get(601)).toBeUndefined()
  })

  it('allows a parent up to two seconds younger than its child, and trusts an unknown start time', () => {
    const procs = [
      ...base(),
      proc(700, { ppid: 701, created: NOW - 10 * MIN }),
      proc(701, { created: NOW - 10 * MIN + 2000 }),
      proc(702, { ppid: 703, created: NOW - 10 * MIN }),
      proc(703, { created: NOW - 10 * MIN + 2001 }),
      proc(704, { ppid: 703, created: 0 }),
    ]
    const cls = classify(procs)
    expect(cls.children.get(701)).toEqual([700])
    expect(cls.children.get(703)).toEqual([704])
    // POSIX re-parents on death, so a live ppid is always the real parent.
    expect(classify(procs, { platform: 'linux' }).children.get(703)).toEqual([702, 704])
  })

  it('treats a process that names itself as its parent as parentless', () => {
    const cls = classify([...base(), proc(800, { name: 'git', ppid: 800, cmd: 'git gc --auto', created: NOW - 10 * MIN })])
    expect(row(cls, 800).owner).toBe('orphaned')
    expect(cls.children.get(800)).toBeUndefined()
  })

  it("lists the bash an agent's Bash tool left behind, showing the command instead of the harness", () => {
    const bash = proc(910, { name: 'bash', ppid: 909, cmd: BASH_TOOL, created: NOW - 10 * MIN, memBytes: 1000 })
    const sleep = proc(911, { name: 'sleep', ppid: 910, cmd: 'sleep 999', created: NOW - 10 * MIN + 100, memBytes: 500, cpuSec: 0.5 })
    const cls = classify([...base(), bash, sleep], {}, 'C:\\Users\\Dev')
    expect(pids(cls)).toEqual([910])
    expect(row(cls, 910)).toMatchObject({
      category: 'leftover',
      owner: 'orphaned',
      reasons: ['orphaned'],
      stuck: true,
      command: 'sleep 999 && echo "done"',
      treeSize: 2,
      tree: [910, 911],
      memBytes: 1500,
      cpuSec: 0.5,
    })
    expect(row(cls, 910).detail).toBeUndefined()
    expect(row(cls, 910).mcp).toBeUndefined()
  })

  it('leaves interactive and idle shells alone even when their parent is gone', () => {
    const at = { ppid: 919, created: NOW - 10 * MIN }
    const cls = classify([
      ...base(),
      proc(920, { ...at, name: 'bash', cmd: '"C:\\Program Files\\Git\\bin\\bash.exe" --login -i' }),
      proc(921, { ...at, name: 'bash', cmd: 'bash' }),
      proc(922, { ...at, name: 'bash', cmd: 'bash -l' }),
      proc(923, { ...at, name: 'node', cmd: 'node server.js' }),
    ])
    expect(cls.rows).toEqual([])
  })

  it('roots a row at the orphaned cmd /c that started a git, naming the git as the detail', () => {
    const cmd = proc(930, { name: 'cmd', ppid: 929, cmd: 'C:\\Windows\\system32\\cmd.exe /d /s /c "git pull"', created: NOW - 10 * MIN })
    const git = proc(931, { name: 'git', ppid: 930, cmd: 'git pull', created: NOW - 10 * MIN + 50 })
    const cls = classify([...base(), cmd, git])
    expect(pids(cls)).toEqual([930])
    expect(row(cls, 930)).toMatchObject({
      category: 'git',
      detail: 'git pull',
      command: 'C:\\Windows\\system32\\cmd.exe /d /s /c "git pull"',
      tree: [930, 931],
      treeSize: 2,
    })
  })

  it('leaves an orphaned wrapper alone unless something it started is worth ending', () => {
    const at = { ppid: 939, created: NOW - 10 * MIN }
    const cls = classify([
      ...base(),
      proc(940, { ...at, name: 'cmd', cmd: 'cmd.exe /k echo hi' }),
      proc(941, { ...at, name: 'powershell', cmd: 'powershell.exe -NoProfile -Command Get-Date' }),
      proc(942, { ...at, name: 'pwsh', cmd: 'pwsh -c "Get-Content log.txt -Wait"' }),
      proc(943, { name: 'tail', ppid: 942, cmd: 'tail -f log.txt', created: NOW - 10 * MIN + 10 }),
    ])
    expect(pids(cls)).toEqual([942])
    expect(row(cls, 942)).toMatchObject({ category: 'leftover', tree: [942, 943] })
  })

  it('shows the program name when the command line could not be read', () => {
    const cls = classify([
      ...base(),
      proc(960, { name: 'jq', ppid: 959, cmd: '', created: NOW - 10 * MIN }),
      proc(961, { name: 'bash', ppid: 959, cmd: 'bash -c run', created: NOW - 10 * MIN }),
      proc(962, { name: 'mcp-proxy', ppid: 961, cmd: '', created: NOW - 10 * MIN }),
    ])
    expect(row(cls, 960).command).toBe('jq')
    expect(row(cls, 961)).toMatchObject({ category: 'leftover', mcp: true, detail: 'mcp-proxy', tree: [961, 962] })
  })

  it('never marks a tree that is serving a port as stuck', () => {
    const bash = proc(950, { name: 'bash', ppid: 949, cmd: 'bash -c "python -m http.server 8000"', created: NOW - 10 * MIN })
    const py = proc(951, { name: 'python', ppid: 950, cmd: 'python -m http.server 8000', created: NOW - 10 * MIN + 10 })
    const listening = new Map([
      [951, [8000]],
      [950, [8000, 443]],
    ])
    const cls = classify([...base(), bash, py], { listening })
    expect(row(cls, 950)).toMatchObject({ stuck: false, serving: [443, 8000], reasons: ['orphaned'] })
  })

  it('marks nothing stuck when the port table could not be read, and passes the warning on', () => {
    const git = proc(500, { name: 'git', ppid: 499, cmd: 'git status', created: NOW - 10 * MIN, suspended: true })
    const cls = classify([...base(), git], { listening: null, warnings: [PORTS_UNKNOWN] })
    expect(row(cls, 500)).toMatchObject({ stuck: false, serving: [], reasons: ['orphaned', 'suspended'] })
    expect(cls.warnings).toEqual([PORTS_UNKNOWN])
  })

  it('does not call a git frozen for under a minute frozen', () => {
    const bash = proc(970, { name: 'bash', ppid: 969, cmd: 'bash -c "git status"', created: NOW - 10 * MIN })
    const git = proc(971, { name: 'git', ppid: 970, cmd: 'git status', created: NOW - 30_000, suspended: true })
    const cls = classify([...base(), bash, git])
    expect(pids(cls)).toEqual([970])
    // Not frozen, and a git that started half a minute ago may still be working: not stuck yet.
    expect(row(cls, 970)).toMatchObject({ category: 'git', reasons: ['orphaned'], stuck: false, detail: 'git status' })
  })

  it('lists a headless agent a scheduled job started, as external and not stuck', () => {
    const task = proc(1000, { name: 'taskhostw', ppid: 5, cmd: 'taskhostw.exe', created: NOW - 600 * MIN })
    const ps = proc(1001, { name: 'powershell', ppid: 1000, cmd: 'powershell.exe -NoProfile -File C:\\jobs\\daily.ps1', created: NOW - 21 * MIN })
    const claude = proc(1002, {
      name: 'claude',
      ppid: 1001,
      cmd: 'claude -p "triage ticket 73138" --output-format stream-json',
      created: NOW - 20 * MIN,
      cpuSec: 12,
      memBytes: 300,
    })
    const cls = classify([...base(), task, ps, claude])
    expect(cls.rows).toEqual([
      {
        pid: 1002,
        created: NOW - 20 * MIN,
        name: 'claude',
        category: 'agent',
        agent: 'claude',
        reasons: ['headless'],
        owner: 'external',
        parentName: 'powershell',
        stuck: false,
        serving: [],
        ageMs: 20 * MIN,
        cpuSec: 12,
        memBytes: 300,
        command: 'claude -p "triage ticket 73138" --output-format stream-json',
        treeSize: 1,
        tree: [1002],
      },
    ])
  })

  it('only calls an orphaned agent stuck after an hour, since it may be a deliberate nohup job', () => {
    const young = proc(1100, { name: 'claude', ppid: 1099, cmd: 'claude -p "x"', created: NOW - 30 * MIN })
    const old = proc(1101, { name: 'claude', ppid: 1099, cmd: 'claude -p "y"', created: NOW - 90 * MIN })
    const cls = classify([...base(), young, old])
    expect(pids(cls)).toEqual([1101, 1100])
    expect(row(cls, 1101)).toMatchObject({ stuck: true, reasons: ['headless', 'orphaned'], owner: 'orphaned', agent: 'claude' })
    expect(row(cls, 1100)).toMatchObject({ stuck: false, reasons: ['headless', 'orphaned'] })
  })

  it('lists a headless agent Termpolis launched itself, while every other child stays protected', () => {
    const claude = proc(1200, { name: 'claude', ppid: SELF, cmd: 'claude -p "second opinion"', created: NOW - 5 * MIN })
    const cls = classify([...base(), claude])
    expect(row(cls, 1200)).toMatchObject({ owner: 'termpolis', parentName: 'termpolis', reasons: ['headless'], stuck: false })
    expect(cls.protectedPids.has(1200)).toBe(false)
    expect(cls.protectedPids.has(101)).toBe(true)
  })

  it('lists a git that has run for half an hour in a Termpolis terminal as long-running', () => {
    const shell = proc(1300, { name: 'pwsh', ppid: SELF, cmd: 'pwsh.exe -NoLogo', created: NOW - 100 * MIN })
    const git = proc(1301, { name: 'git', ppid: 1300, cmd: 'git fetch --all', created: NOW - 45 * MIN })
    const fresh = proc(1302, { name: 'git', ppid: 1300, cmd: 'git fetch origin', created: NOW - 29 * MIN })
    const cls = classify([...base(), shell, git, fresh])
    expect(pids(cls)).toEqual([1301])
    expect(row(cls, 1301)).toMatchObject({ owner: 'termpolis', parentName: 'pwsh', reasons: ['long-running'], category: 'git', stuck: false })
  })

  it('lists nested agents once, rooted at the outermost', () => {
    const outer = proc(1401, { name: 'claude', ppid: 20, cmd: 'claude -p "review" --output-format stream-json', created: NOW - 20 * MIN })
    // A second older by the clock, so it is visited first and has to defer to its parent.
    const inner = proc(1402, { name: 'claude', ppid: 1401, cmd: 'claude -p "sub-task"', created: NOW - 20 * MIN - 1000 })
    const cls = classify([...base(), code(), outer, inner])
    expect(pids(cls)).toEqual([1401])
    expect(row(cls, 1401)).toMatchObject({ tree: [1401, 1402], owner: 'external', parentName: 'code' })
    expect(row(cls, 1401).detail).toBeUndefined()
  })

  it('keeps a frozen git its own row, even under an agent', () => {
    const agent = proc(1410, { name: 'codex', ppid: 20, cmd: 'codex exec "fix the build"', created: NOW - 20 * MIN })
    const git = proc(1411, { name: 'git', ppid: 1410, cmd: 'git status', created: NOW - 2 * MIN, suspended: true })
    const cls = classify([...base(), code(), agent, git])
    expect(pids(cls)).toEqual([1411, 1410])
    expect(row(cls, 1411)).toMatchObject({ stuck: true, reasons: ['suspended'], parentName: 'codex' })
    expect(row(cls, 1410)).toMatchObject({ agent: 'codex', tree: [1410], stuck: false })
  })

  it('roots an orphaned shell that ran an agent as an agent row, naming the agent as the detail', () => {
    const bash = proc(1450, { name: 'bash', ppid: 1449, cmd: 'bash -c "claude -p hi"', created: NOW - 71 * MIN })
    const claude = proc(1451, { name: 'claude', ppid: 1450, cmd: 'claude -p hi', created: NOW - 70 * MIN })
    const cls = classify([...base(), bash, claude])
    expect(pids(cls)).toEqual([1450])
    expect(row(cls, 1450)).toMatchObject({ category: 'agent', agent: 'claude', detail: 'claude -p hi', reasons: ['headless', 'orphaned'], stuck: true })
  })

  it('lists long-running git once per tree, and never a git waiting on a pager or an editor', () => {
    const fetch = proc(1500, { name: 'git', ppid: 20, cmd: 'git fetch origin', created: NOW - 40 * MIN })
    const remote = proc(1501, { name: 'git-remote-https', ppid: 1500, cmd: 'git-remote-https origin https://github.com/x/y.git', created: NOW - 40 * MIN - 500 })
    const log = proc(1600, { name: 'git', ppid: 20, cmd: 'git log', created: NOW - 40 * MIN })
    const less = proc(1601, { name: 'less', ppid: 1600, cmd: 'less', created: NOW - 40 * MIN + 10 })
    const rebase = proc(1700, { name: 'git', ppid: 20, cmd: 'git rebase -i HEAD~3', created: NOW - 40 * MIN })
    const sh = proc(1701, { name: 'sh', ppid: 1700, cmd: 'sh -c "vim .git/rebase-merge/git-rebase-todo"', created: NOW - 40 * MIN + 10 })
    const vim = proc(1702, { name: 'vim', ppid: 1701, cmd: 'vim .git/rebase-merge/git-rebase-todo', created: NOW - 40 * MIN + 20 })
    const cls = classify([...base(), code(), fetch, remote, log, less, rebase, sh, vim])
    expect(pids(cls)).toEqual([1500])
    expect(row(cls, 1500)).toMatchObject({
      tree: [1500, 1501],
      reasons: ['long-running'],
      category: 'git',
      owner: 'external',
      parentName: 'code',
      stuck: false,
    })
  })

  it('never lists git daemons, or a git whose command line it could not read', () => {
    const at = { ppid: 1799, created: NOW - 10 * MIN, name: 'git' }
    const cls = classify([
      ...base(),
      proc(1800, { ...at, cmd: 'git fsmonitor--daemon run' }),
      proc(1801, { ...at, cmd: 'git -C C:\\repo credential-cache--daemon C:\\sock' }),
      proc(1802, { ...at, cmd: 'git daemon --reuseaddr' }),
      proc(1803, { ...at, cmd: 'git cat-file --batch-check' }),
      proc(1804, { ...at, cmd: '' }),
      proc(1805, { ...at, cmd: 'git cat-file -p HEAD' }),
      proc(1806, { ...at, cmd: 'git --version' }),
    ])
    expect(pids(cls)).toEqual([1805, 1806])
  })

  it('lists a leftover MCP server, with the home directory shortened to ~', () => {
    const node = proc(1850, {
      name: 'node',
      ppid: 1849,
      cmd: '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\Dev\\.termpolis\\mcp-adapter.cjs --port 7777',
      created: NOW - 10 * MIN,
    })
    const cls = classify([...base(), node], {}, 'C:\\Users\\Dev')
    expect(row(cls, 1850)).toMatchObject({
      category: 'leftover',
      mcp: true,
      stuck: true,
      command: '"C:\\Program Files\\nodejs\\node.exe" ~\\.termpolis\\mcp-adapter.cjs --port 7777',
    })
    expect(row(cls, 1850).detail).toBeUndefined()
  })

  it('lists an orphaned helper of a crashed Termpolis, but never another Termpolis window', () => {
    const at = { name: 'termpolis', ppid: 1899, created: NOW - 30 * MIN }
    const helper = proc(1900, { ...at, cmd: '"C:\\Program Files\\Termpolis\\Termpolis.exe" --type=gpu-process --field-trial-handle=1' })
    const other = proc(1901, { ...at, cmd: '"C:\\Program Files\\Termpolis\\Termpolis.exe"' })
    const cls = classify([...base(), helper, other])
    expect(pids(cls)).toEqual([1900])
    expect(row(cls, 1900)).toMatchObject({ category: 'leftover', stuck: true, owner: 'orphaned' })
  })

  it('lists an orphaned console host on Windows only', () => {
    const host = proc(1950, { name: 'openconsole', ppid: 1949, cmd: 'OpenConsole.exe --headless', created: NOW - 10 * MIN })
    expect(pids(classify([...base(), host]))).toEqual([1950])
    expect(pids(classify([...base(), host], { platform: 'linux' }))).toEqual([])
  })

  it('lists only processes in its own Windows session', () => {
    const git = proc(1960, { name: 'git', ppid: 1959, cmd: 'git status', created: NOW - 10 * MIN, scope: 0 })
    expect(classify([...base(), git]).rows).toEqual([])
  })

  it('puts stuck rows first, then the oldest', () => {
    const frozen = proc(2100, { name: 'git', ppid: 2099, cmd: 'git status', created: NOW - 6 * MIN, suspended: true })
    const older = proc(2101, { name: 'claude', ppid: 20, cmd: 'claude -p a', created: NOW - 50 * MIN })
    const newer = proc(2102, { name: 'codex', ppid: 20, cmd: 'codex exec b', created: NOW - 40 * MIN })
    const unknown = proc(2103, { name: 'gemini', ppid: 20, cmd: 'gemini -p c', created: 0 })
    const cls = classify([...base(), code(), newer, unknown, frozen, older])
    expect(pids(cls)).toEqual([2100, 2101, 2102, 2103])
    expect(row(cls, 2103).ageMs).toBe(0)
  })

  it('never lists the agent that launched Termpolis', () => {
    const launcher = proc(2200, { name: 'claude', ppid: 2199, cmd: 'claude -p "run the e2e suite"', created: NOW - 200 * MIN })
    const self = proc(SELF, { name: 'termpolis', ppid: 2200, cmd: 'Termpolis.exe', created: NOW - 120 * MIN })
    const cls = classify([launcher, self])
    expect(cls.rows).toEqual([])
    expect(cls.protectedPids).toEqual(new Set([SELF, 2200]))
  })

  it('never lists an agent someone is using in a terminal, or the MCP servers it started', () => {
    // A terminal whose parent went away while the session inside it carries on.
    const wrapper = proc(3000, { name: 'cmd', ppid: 2999, cmd: 'C:\\Windows\\system32\\cmd.exe /d /s /c "claude"', created: NOW - 90 * MIN })
    const claude = proc(3001, { name: 'claude', ppid: 3000, cmd: 'claude', created: NOW - 90 * MIN + 50 })
    const mcp = proc(3002, { name: 'npx', ppid: 3001, cmd: 'npx -y @playwright/mcp@latest', created: NOW - 89 * MIN })
    // An agent started with --mcp-config is a client of MCP servers, not one itself.
    const viaNode = proc(3010, {
      name: 'node',
      ppid: 3009,
      cmd: String.raw`node C:\Users\Dev\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js --mcp-config C:\Users\Dev\mcp.json`,
      created: NOW - 90 * MIN,
    })
    expect(classify([...base(), wrapper, claude, mcp, viaNode]).rows).toEqual([])
  })

  it('lists an orphaned headless agent that is waiting on an editor window, but never calls it stuck', () => {
    const claude = proc(3100, { name: 'claude', ppid: 3099, cmd: 'claude -p "commit the fix"', created: NOW - 90 * MIN })
    const git = proc(3101, { name: 'git', ppid: 3100, cmd: 'git commit', created: NOW - 5 * MIN })
    const editor = proc(3102, { name: 'code', ppid: 3101, cmd: 'code --wait .git/COMMIT_EDITMSG', created: NOW - 5 * MIN + 10 })
    const cls = classify([...base(), claude, git, editor])
    expect(pids(cls)).toEqual([3100])
    expect(row(cls, 3100)).toMatchObject({
      category: 'agent',
      reasons: ['headless', 'orphaned'],
      owner: 'orphaned',
      stuck: false,
      tree: [3100, 3101, 3102],
    })
  })

  it('never lists an orphaned git that is waiting on an editor, however long it has waited', () => {
    const commit = (pid: number, created: number): ProcRecord[] => [
      proc(pid, { name: 'git', ppid: pid - 1, cmd: '"C:\\Program Files\\Git\\mingw64\\bin\\git.exe" commit', created }),
      proc(pid + 1, { name: 'vim', ppid: pid, cmd: 'vim .git/COMMIT_EDITMSG', created: created + 10 }),
    ]
    expect(classify([...base(), ...commit(3200, NOW - 10 * MIN), ...commit(3210, NOW - 45 * MIN)]).rows).toEqual([])
  })

  it('judges a tree by its root, so a frozen process inside never makes a healthy agent stuck', () => {
    const agent = proc(3300, { name: 'claude', ppid: 20, cmd: 'claude -p "build it"', created: NOW - 20 * MIN })
    const rustc = proc(3301, { name: 'rustc', ppid: 3300, cmd: 'rustc src/main.rs', created: NOW - 5 * MIN, suspended: true })
    const cls = classify([...base(), code(), agent, rustc])
    expect(pids(cls)).toEqual([3300])
    expect(row(cls, 3300)).toMatchObject({ reasons: ['headless'], owner: 'external', stuck: false, tree: [3300, 3301] })
  })

  it('gives a frozen git its own row before an orphaned agent can claim it, so only the git is stuck', () => {
    const agent = proc(3400, { name: 'claude', ppid: 3399, cmd: 'claude -p "x"', created: NOW - 10 * MIN })
    const git = proc(3401, { name: 'git', ppid: 3400, cmd: 'git status', created: NOW - 2 * MIN, suspended: true })
    const cls = classify([...base(), agent, git])
    expect(pids(cls)).toEqual([3401, 3400])
    expect(row(cls, 3401)).toMatchObject({ stuck: true, reasons: ['suspended'], owner: 'external', parentName: 'claude', tree: [3401] })
    expect(row(cls, 3400)).toMatchObject({ stuck: false, reasons: ['headless', 'orphaned'], owner: 'orphaned', tree: [3400] })
  })

  it('still lists a long-running git whose editor froze, since nobody can type into a frozen editor', () => {
    const git = proc(3500, { name: 'git', ppid: 20, cmd: 'git commit', created: NOW - 45 * MIN })
    const vim = proc(3501, { name: 'vim', ppid: 3500, cmd: 'vim .git/COMMIT_EDITMSG', created: NOW - 45 * MIN + 10, suspended: true })
    const cls = classify([...base(), code(), git, vim])
    expect(pids(cls)).toEqual([3500])
    expect(row(cls, 3500)).toMatchObject({ reasons: ['long-running'], stuck: false, tree: [3500, 3501] })
  })

  it('still ends a frozen git gc: frozen, it is not doing any maintenance', () => {
    const gc = proc(3600, { name: 'git', ppid: 3599, cmd: 'git gc --auto', created: NOW - 45 * MIN, suspended: true })
    const cls = classify([...base(), gc])
    expect(row(cls, 3600)).toMatchObject({ owner: 'orphaned', reasons: ['orphaned', 'suspended'], stuck: true })
  })

  it.each(['gui', 'citool', 'difftool --dir-diff', 'mergetool', '-c mergetool.keepBackup=false mergetool'])(
    'never lists git %s: someone is working in its window',
    (sub) => {
      const attached = proc(3700, { name: 'git', ppid: 20, cmd: `git ${sub}`, created: NOW - 45 * MIN })
      const orphaned = proc(3710, { name: 'git', ppid: 3709, cmd: `git ${sub}`, created: NOW - 45 * MIN })
      // What the merge tool opened is not a known editor, so only the subcommand says someone is there.
      const meld = proc(3711, { name: 'meld', ppid: 3710, cmd: 'meld LOCAL BASE REMOTE', created: NOW - 45 * MIN + 10 })
      expect(classify([...base(), code(), attached, orphaned, meld]).rows).toEqual([])
    },
  )

  it.each([
    'less', 'more', 'most', 'moar', 'ov', 'vim', 'vi', 'gvim', 'mvim', 'nvim', 'nvim-qt', 'neovide',
    'nano', 'pico', 'micro', 'joe', 'mcedit', 'hx', 'helix', 'kak', 'emacs', 'emacsclient', 'code',
    'code-insiders', 'code - insiders', 'codium', 'vscodium', 'cursor', 'windsurf', 'zed', 'zeditor',
    'subl', 'sublime_text', 'mate', 'bbedit', 'gedit', 'kate', 'notepad', 'notepad++', 'gitk', 'git-gui',
  ])('never lists a git waiting on %s', (name) => {
    const tree = (child: string): ProcRecord[] => [
      proc(3800, { name: 'bash', ppid: 20, cmd: 'bash', created: NOW - 50 * MIN }),
      proc(3801, { name: 'git', ppid: 3800, cmd: 'git commit', created: NOW - 45 * MIN }),
      proc(3802, { name: child, ppid: 3801, cmd: `${child} .git/COMMIT_EDITMSG`, created: NOW - 45 * MIN + 10 }),
    ]
    expect(classify([...base(), code(), ...tree(name)]).rows).toEqual([])
    // The control: a child nobody types into.
    expect(pids(classify([...base(), code(), ...tree('cat')]))).toEqual([3801])
  })
})

describe('frozen processes (Windows)', () => {
  const cases: { what: string; over: Partial<ProcRecord>; parent: 'app' | 'none' | Partial<ProcRecord>; listed: boolean }[] = [
    { what: 'git', over: { name: 'git', cmd: 'git status' }, parent: 'app', listed: true },
    { what: 'a shell running a command', over: { name: 'bash', cmd: 'bash -c x' }, parent: 'app', listed: true },
    { what: 'an idle shell', over: { name: 'bash', cmd: 'bash' }, parent: 'app', listed: false },
    { what: 'cmd /c', over: { name: 'cmd', cmd: 'cmd /c x' }, parent: 'app', listed: true },
    { what: 'a headless agent', over: { name: 'claude', cmd: 'claude -p x' }, parent: 'app', listed: true },
    { what: 'an MCP server', over: { name: 'node', cmd: 'node mcp-server.js' }, parent: 'app', listed: true },
    { what: 'an agent that is a client of MCP servers', over: { name: 'node', cmd: String.raw`node C:\npm\node_modules\@anthropic-ai\claude-code\cli.js --mcp-config mcp.json` }, parent: 'app', listed: false },
    { what: 'a script a shell started', over: { name: 'node', cmd: 'node build.js' }, parent: { name: 'bash', cmd: 'bash' }, listed: true },
    { what: 'a script a wrapper started', over: { name: 'python', cmd: 'python job.py' }, parent: { name: 'powershell', cmd: 'powershell' }, listed: true },
    { what: 'a script whose parent is gone', over: { name: 'node', cmd: 'node build.js' }, parent: 'none', listed: true },
    { what: 'a runtime an app started', over: { name: 'node', cmd: 'node build.js' }, parent: 'app', listed: false },
    { what: 'an app', over: { name: 'notepad', cmd: 'notepad.exe' }, parent: 'app', listed: false },
  ]
  it.each(cases)('$what → listed: $listed', ({ over, parent, listed }) => {
    const procs = [...base(), code()]
    let ppid = 20
    if (parent === 'none') ppid = 2999
    else if (parent !== 'app') {
      procs.push(proc(2001, { ppid: 20, created: NOW - 50 * MIN, ...parent }))
      ppid = 2001
    }
    procs.push(proc(2002, { ppid, created: NOW - 2 * MIN, suspended: true, ...over }))
    const cls = classify(procs)
    expect(pids(cls)).toEqual(listed ? [2002] : [])
    if (listed) expect(row(cls, 2002)).toMatchObject({ stuck: true, reasons: expect.arrayContaining(['suspended']) })
  })

  it('ignores a process frozen for less than a minute', () => {
    const git = proc(2002, { name: 'git', cmd: 'git status', ppid: 20, created: NOW - 30_000, suspended: true })
    expect(classify([...base(), code(), git]).rows).toEqual([])
  })
})

describe('Git Bash programs (Windows)', () => {
  it('hangs a Git Bash program whose Windows parent exited under its POSIX parent', () => {
    const cls = classify([...base(), ...pipeline()], { msysParents: new Map([[302, 300]]) })
    expect(cls.rows).toEqual([])
    expect(cls.children.get(300)).toEqual([302])
  })

  it('calls it orphaned once its own install says it has no parent', () => {
    const cls = classify([...base(), ...pipeline()], { msysParents: new Map([[302, 0]]) })
    expect(pids(cls)).toEqual([302])
    expect(row(cls, 302)).toMatchObject({ owner: 'orphaned', reasons: ['orphaned'], stuck: true, category: 'leftover' })
  })

  it('does not call it orphaned when its install was not asked, unlike a native program', () => {
    const jq = proc(303, { name: 'jq', ppid: 399, cmd: '"C:\\Tools\\jq.exe" .', created: NOW - 20 * MIN })
    const overs: Partial<ProcSnapshot>[] = [{}, { msysParents: new Map() }]
    for (const over of overs) expect(pids(classify([...base(), ...pipeline(), jq], over))).toEqual([303])
  })

  it('never hangs anything under the System Idle process, whose pid is 0', () => {
    const idle = proc(0, { name: 'system idle process', scope: 0, created: 0 })
    const cls = classify([idle, ...base(), ...pipeline()], { msysParents: new Map([[302, 0]]) })
    expect(row(cls, 302).owner).toBe('orphaned')
    expect(cls.children.get(0) ?? []).not.toContain(302)
  })

  it('offers a pipeline whose shell lost its parent as one row, stages included', () => {
    const procs = [...base(), ...pipeline()].map((p) => (p.pid === 300 ? { ...p, ppid: 299 } : p))
    const cls = classify(procs, {
      msysParents: new Map([
        [300, 0],
        [302, 300],
      ]),
    })
    expect(pids(cls)).toEqual([300])
    expect(row(cls, 300)).toMatchObject({ owner: 'orphaned', stuck: true, treeSize: 2, tree: [300, 302] })
  })
})

describe('which shells count as running a command', () => {
  it.each([
    ['bash', false],
    ['bash --login -i', false],
    ['bash script.sh', true],
    ['bash --', false],
    ['bash -- script.sh', true],
    ['fish --command=ls', true],
    ['fish --command ls', true],
    ['bash -o pipefail', false],
    ['bash -o pipefail s.sh', true],
    ['bash --rcfile x.rc', false],
    ['bash -lc x', true],
    ['bash -ic x', false],
    ['bash -e -x', false],
    ['bash +x s.sh', true],
  ])('%s → %s', (cmd, listed) => {
    const shell = proc(3000, { name: cmd.split(' ')[0], ppid: 10, cmd, created: NOW - 2 * MIN, suspended: true })
    expect(pids(classify([...base(), shell]))).toEqual(listed ? [3000] : [])
  })
})

describe('which wrappers count as running a command', () => {
  it.each([
    ['powershell -NoProfile -Command x', true],
    ['powershell -NoExit -Command x', false],
    ['pwsh script.ps1', true],
    ['pwsh -NoExit script.ps1', false],
    ['powershell -File x.ps1', true],
    ['pwsh -c x', true],
    ['powershell -ec ZQBjAGgAbwA=', true],
    ['powershell -ExecutionPolicy Bypass -File x.ps1', true],
    ['powershell -ep Bypass x.ps1', true],
    ['powershell -noe -c x', false],
    ['pwsh --Command x', true],
    ['powershell /Command x', true],
    ['powershell -com x', true],
    ['powershell -NoLogo', false],
    ['powershell -co', false],
    ['cmd /d /s /c "x"', true],
    ['cmd /R x', true],
    ['cmd /k x', false],
    ['cmd git status', false],
    ['cmd /q', false],
  ])('%s → %s', (cmd, listed) => {
    const wrapper = proc(3100, { name: cmd.split(' ')[0], ppid: 10, cmd, created: NOW - 2 * MIN, suspended: true })
    expect(pids(classify([...base(), wrapper]))).toEqual(listed ? [3100] : [])
  })
})

describe('which processes count as a headless agent', () => {
  it.each([
    ['claude', 'claude -p hi', 'claude'],
    ['claude', 'claude --print hi', 'claude'],
    ['claude', 'claude --output-format=stream-json', 'claude'],
    ['claude', 'claude --input-format stream-json', 'claude'],
    ['claude', 'claude mcp serve', 'claude'],
    ['claude', 'claude', null],
    ['claude', 'claude mcp list', null],
    ['claude', 'claude mcp', null],
    ['codex', 'codex exec "fix it"', 'codex'],
    ['codex', 'codex -m gpt-5 exec x', 'codex'],
    ['codex', 'codex --full-auto e x', 'codex'],
    ['codex', 'codex -m exec', null],
    ['codex', 'codex "fix"', null],
    ['codex-x86_64-pc-windows-msvc', 'codex-x86_64-pc-windows-msvc.exe app-server', 'codex'],
    ['gemini', 'gemini -p hi', 'gemini'],
    ['gemini', 'gemini --prompt=hi', 'gemini'],
    ['gemini', 'gemini --acp', 'gemini'],
    ['agy', 'agy -p hi', 'gemini'],
    ['gemini', 'gemini', null],
    ['node', '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\Dev\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js -p hi', 'claude'],
    ['node', 'node /usr/local/lib/node_modules/@google/gemini-cli/dist/index.js --prompt=x', 'gemini'],
    ['node', 'node /usr/local/bin/claude -p x', 'claude'],
    ['node', 'node --require x.js /opt/codex.js exec', 'codex'],
    ['node', 'node --inspect claude.mjs -p x', 'claude'],
    ['node', 'node -- claude -p', 'claude'],
    ['node', 'node -e "claude -p"', null],
    ['node', 'node --eval=x claude -p', null],
    ['node', 'node --', null],
    ['node', 'node --inspect', null],
    ['node', 'node server.js -p', null],
    ['python3.12', 'python3.12 /opt/claude -p x', 'claude'],
    ['pythonw', 'pythonw C:\\tools\\gemini -p x', 'gemini'],
    ['npm exec @openai/codex', 'npm exec @openai/codex exec x', 'codex'],
    // The wrapper is not the agent: the agent is the runtime it starts.
    ['cmd', 'cmd /c npx @anthropic-ai/claude-code -p x', null],
  ])('%s: %s → %s', (name, cmd, agent) => {
    const cls = classify([...base(), proc(3200, { name, ppid: 10, cmd, created: NOW - 2 * MIN })])
    expect(cls.rows.map((r) => r.agent)).toEqual(agent ? [agent] : [])
  })
})

describe('classifyProcesses — POSIX', () => {
  const linux = { platform: 'linux' as const }
  const u = { scope: 1000 }

  /** init → systemd --user → Termpolis → renderer. */
  function posixBase(): ProcRecord[] {
    return [
      proc(1, { name: 'systemd', ppid: 0, cmd: '/sbin/init', created: NOW - 900 * MIN, scope: 0 }),
      proc(50, { ...u, name: 'systemd', ppid: 1, cmd: '/lib/systemd/systemd --user', created: NOW - 800 * MIN }),
      proc(SELF, { ...u, name: 'termpolis', ppid: 50, cmd: '/opt/Termpolis/termpolis', created: NOW - 120 * MIN }),
      proc(101, { ...u, name: 'termpolis', ppid: SELF, cmd: '/opt/Termpolis/termpolis --type=renderer', created: NOW - 119 * MIN }),
    ]
  }

  it('treats a process adopted by init or by a systemd user instance as orphaned', () => {
    const cls = classify(
      [
        ...posixBase(),
        proc(300, { ...u, name: 'git', ppid: 1, cmd: 'git fetch', created: NOW - 40 * MIN }),
        proc(301, { ...u, name: 'git', ppid: 50, cmd: 'git pull', created: NOW - 40 * MIN }),
        // Orphaned too, but a clone may still be working ten minutes in.
        proc(302, { ...u, name: 'git', ppid: 1, cmd: 'git clone https://example.com/big.git', created: NOW - 10 * MIN }),
      ],
      linux,
    )
    expect(pids(cls)).toEqual([300, 301, 302])
    expect(row(cls, 300)).toMatchObject({ owner: 'orphaned', parentName: 'systemd', reasons: ['orphaned', 'long-running'], stuck: true })
    expect(row(cls, 301)).toMatchObject({ owner: 'orphaned', parentName: 'systemd', stuck: true })
    expect(row(cls, 302)).toMatchObject({ owner: 'orphaned', parentName: 'systemd', reasons: ['orphaned'], stuck: false })
    expect(cls.protectedPids).toEqual(new Set([SELF, 50, 1, 101]))
  })

  it('only lists an orphaned shell, wrapper or tool when it holds git, an agent or an MCP server', () => {
    const at = { ...u, created: NOW - 10 * MIN }
    const cls = classify(
      [
        ...posixBase(),
        proc(310, { ...at, name: 'bash', ppid: 1, cmd: 'bash -c "sleep 999"' }),
        proc(311, { ...at, name: 'sleep', ppid: 310, cmd: 'sleep 999' }),
        proc(312, { ...at, name: 'bash', ppid: 1, cmd: 'bash -c "git pull"' }),
        proc(313, { ...at, name: 'git', ppid: 312, cmd: 'git pull' }),
        proc(314, { ...at, name: 'tail', ppid: 1, cmd: 'tail -f /var/log/syslog' }),
        proc(315, { ...at, name: 'pwsh', ppid: 1, cmd: 'pwsh -c "git fetch"' }),
        proc(316, { ...at, name: 'git', ppid: 315, cmd: 'git fetch' }),
        proc(317, { ...at, name: 'gnome-terminal-server', ppid: 50, cmd: '/usr/libexec/gnome-terminal-server' }),
      ],
      linux,
    )
    expect(pids(cls)).toEqual([312, 315])
    expect(row(cls, 312)).toMatchObject({ category: 'git', detail: 'git pull', tree: [312, 313] })
    expect(row(cls, 315)).toMatchObject({ category: 'git', detail: 'git fetch', tree: [315, 316] })
  })

  it('does not call a stopped job stuck: on POSIX that is usually a Ctrl+Z', () => {
    const term = proc(320, { ...u, name: 'gnome-terminal-server', ppid: 50, cmd: '/usr/libexec/gnome-terminal-server', created: NOW - 100 * MIN })
    const shell = proc(321, { ...u, name: 'bash', ppid: 320, cmd: 'bash', created: NOW - 99 * MIN })
    const young = proc(322, { ...u, name: 'git', ppid: 321, cmd: 'git log -p', created: NOW - 10 * MIN, suspended: true })
    const old = proc(323, { ...u, name: 'git', ppid: 321, cmd: 'git bisect run make', created: NOW - 40 * MIN, suspended: true })
    const cls = classify([...posixBase(), term, shell, young, old], linux)
    expect(pids(cls)).toEqual([323])
    expect(row(cls, 323)).toMatchObject({ reasons: ['suspended'], stuck: false, owner: 'external', parentName: 'bash' })
  })

  it('never lists a git whose editor is stopped: on POSIX that is a Ctrl+Z someone can resume', () => {
    const term = proc(340, { ...u, name: 'gnome-terminal-server', ppid: 50, cmd: '/usr/libexec/gnome-terminal-server', created: NOW - 100 * MIN })
    const shell = proc(341, { ...u, name: 'bash', ppid: 340, cmd: 'bash', created: NOW - 99 * MIN })
    const git = proc(342, { ...u, name: 'git', ppid: 341, cmd: 'git commit', created: NOW - 45 * MIN })
    const vim = proc(343, { ...u, name: 'vim', ppid: 342, cmd: 'vim .git/COMMIT_EDITMSG', created: NOW - 45 * MIN + 10, suspended: true })
    expect(classify([...posixBase(), term, shell, git, vim], linux).rows).toEqual([])
  })

  it('lists every uid when it does not know its own, and only its own when it does', () => {
    const git = proc(330, { name: 'git', ppid: 1, cmd: 'git gc', created: NOW - 10 * MIN, scope: 0 })
    const unknownSelf = posixBase().map((p) => (p.pid === SELF ? { ...p, scope: undefined } : p))
    expect(pids(classify([...unknownSelf, git], linux))).toEqual([330])
    expect(pids(classify([...posixBase(), git], linux))).toEqual([])
  })

  it('survives cycles in the parent chain', () => {
    const cls = classify(
      [
        // Termpolis inside a loop of ancestors that are also its descendants.
        proc(SELF, { name: 'termpolis', ppid: 102, cmd: 'termpolis' }),
        proc(102, { name: 'a', ppid: 103 }),
        proc(103, { name: 'b', ppid: SELF }),
        // A git whose ancestors loop without ever reaching another git.
        proc(340, { name: 'git', ppid: 341, cmd: 'git fetch', created: NOW - 40 * MIN }),
        proc(341, { name: 'bash', ppid: 340, cmd: 'bash -c "git fetch"', created: NOW - 41 * MIN }),
      ],
      linux,
    )
    expect(cls.protectedPids).toEqual(new Set([SELF, 102, 103]))
    expect(pids(cls)).toEqual([340])
    expect(row(cls, 340)).toMatchObject({ tree: [340, 341], reasons: ['long-running'], owner: 'external', parentName: 'bash' })
  })

  it('lists an orphaned macOS helper of a crashed Termpolis', () => {
    const cls = classify(
      [
        proc(1, { name: 'launchd', ppid: 0, cmd: '/sbin/launchd', scope: 0 }),
        proc(SELF, { ...u, name: 'termpolis', ppid: 1, cmd: '/Applications/Termpolis.app/Contents/MacOS/Termpolis', created: NOW - 120 * MIN }),
        proc(400, {
          ...u,
          name: 'termpolis helper (gpu)',
          ppid: 1,
          cmd: '/Applications/Termpolis.app/Contents/Frameworks/Termpolis Helper (GPU).app/Contents/MacOS/Termpolis Helper (GPU) --type=gpu-process',
          created: NOW - 300 * MIN,
        }),
      ],
      { platform: 'darwin' },
    )
    expect(pids(cls)).toEqual([400])
    expect(row(cls, 400)).toMatchObject({ owner: 'orphaned', parentName: 'launchd', stuck: true, category: 'leftover' })
  })

  it('names the MCP server as the detail of the orphaned shell that started it', () => {
    const cls = classify(
      [
        ...posixBase(),
        proc(410, { ...u, name: 'bash', ppid: 1, cmd: 'bash -c "uvx mcp-server-fetch"', created: NOW - 10 * MIN }),
        proc(411, { ...u, name: 'uvx', ppid: 410, cmd: 'uvx mcp-server-fetch', created: NOW - 10 * MIN }),
      ],
      linux,
    )
    expect(row(cls, 410)).toMatchObject({ category: 'leftover', mcp: true, detail: 'uvx mcp-server-fetch', tree: [410, 411] })
  })

  it("gives an orphaned git half an hour, and never calls git's own gc or maintenance stuck", () => {
    const at = { ...u, name: 'git', ppid: 1, created: NOW - 45 * MIN }
    const cls = classify(
      [
        ...posixBase(),
        proc(600, { ...at, cmd: 'git gc --auto' }),
        proc(601, { ...at, cmd: 'git -C /home/dev/repo maintenance run --auto' }),
        proc(602, { ...at, cmd: 'git for-each-repo --config=maintenance.repo maintenance run --schedule=hourly' }),
        // A git whose subcommand cannot be read is not maintenance.
        proc(603, { ...at, cmd: 'git' }),
        proc(604, { ...at, cmd: 'git -c core.x=1' }),
        proc(605, { ...at, cmd: 'git push', created: NOW - 30 * MIN }),
        proc(606, { ...at, cmd: 'git push', created: NOW - 30 * MIN + 1 }),
      ],
      linux,
    )
    expect([...pids(cls)].sort((a, b) => a - b)).toEqual([600, 601, 602, 603, 604, 605, 606])
    for (const pid of [600, 601, 602]) expect(row(cls, pid)).toMatchObject({ owner: 'orphaned', reasons: ['orphaned', 'long-running'], stuck: false })
    for (const pid of [603, 604, 605]) expect(row(cls, pid)).toMatchObject({ owner: 'orphaned', reasons: ['orphaned', 'long-running'], stuck: true })
    expect(row(cls, 606)).toMatchObject({ owner: 'orphaned', reasons: ['orphaned'], stuck: false })
  })

  it('leaves a launchd job alone: its parent is launchd because that is where it belongs', () => {
    const mac = (over: Partial<ProcSnapshot>): StuckClassification =>
      classify(
        [
          proc(1, { name: 'launchd', ppid: 0, cmd: '/sbin/launchd', scope: 0 }),
          proc(SELF, { ...u, name: 'termpolis', ppid: 1, cmd: '/Applications/Termpolis.app/Contents/MacOS/Termpolis', created: NOW - 120 * MIN }),
          proc(500, { ...u, name: 'claude', ppid: 1, cmd: 'claude -p "summarize the nightly build"', created: NOW - 90 * MIN }),
        ],
        { platform: 'darwin', ...over },
      )
    expect(row(mac({ managedPids: new Set([500]) }), 500)).toMatchObject({ owner: 'external', parentName: 'launchd', reasons: ['headless'], stuck: false })
    expect(row(mac({}), 500)).toMatchObject({ owner: 'orphaned', parentName: 'launchd', reasons: ['headless', 'orphaned'], stuck: true })
  })

  it('treats a process adopted by a container init that is not systemd as orphaned', () => {
    const cls = classify(
      [
        proc(1, { ...u, name: 'tini', ppid: 0, cmd: '/sbin/tini -- /opt/Termpolis/termpolis', created: NOW - 900 * MIN }),
        proc(SELF, { ...u, name: 'termpolis', ppid: 1, cmd: '/opt/Termpolis/termpolis', created: NOW - 800 * MIN }),
        proc(700, { ...u, name: 'git', ppid: 1, cmd: 'git fetch', created: NOW - 40 * MIN }),
      ],
      linux,
    )
    expect(row(cls, 700)).toMatchObject({ owner: 'orphaned', parentName: 'tini', stuck: true })
  })
})

describe('scanStuckProcesses', () => {
  it('returns the rows without their kill trees', async () => {
    const list = JSON.stringify([
      { i: 10, p: 5, n: 'explorer.exe', c: 'C:\\Windows\\Explorer.EXE', t: NOW - 600 * MIN, x: 1, s: false },
      { i: SELF, p: 10, n: 'Termpolis.exe', c: 'Termpolis.exe', t: NOW - 120 * MIN, x: 1, s: false },
      { i: 500, p: 499, n: 'git.exe', c: 'git status', t: NOW - 10 * MIN, m: 4096, x: 1, s: true },
    ])
    const scan = await scanStuckProcesses({
      runner: async (bin) => ({ stdout: isList(bin) ? list : '', stderr: '' }),
      platform: 'win32',
      selfPid: SELF,
      now: () => NOW,
      homeDir: 'C:\\Users\\Dev',
      env: { SystemRoot: 'C:\\Windows' },
    })
    expect(scan).toEqual({
      processes: [
        {
          pid: 500,
          created: NOW - 10 * MIN,
          name: 'git',
          category: 'git',
          reasons: ['orphaned', 'suspended'],
          owner: 'orphaned',
          stuck: true,
          serving: [],
          ageMs: 10 * MIN,
          cpuSec: 0,
          memBytes: 4096,
          command: 'git status',
          treeSize: 1,
        },
      ],
      scannedAt: NOW,
      platform: 'win32',
      totalProcesses: 3,
      warnings: [],
    })
    expect(scan.processes[0]).not.toHaveProperty('tree')
  })
})

describe('normalizeKillTargets', () => {
  it('refuses anything that is not a short list of pid + start time pairs', () => {
    expect(() => normalizeKillTargets('all')).toThrow('A list of processes to end is required')
    expect(() => normalizeKillTargets({ pid: 1, created: 1 })).toThrow('A list of processes to end is required')
    expect(() => normalizeKillTargets(new Array(1001).fill({ pid: 1, created: 1 }))).toThrow('At most 1000 processes can be ended at once')
    for (const bad of [null, 5, [1, 2], {}, { pid: 0, created: 1 }, { pid: -1, created: 1 }, { pid: 1.5, created: 1 }, { pid: '1', created: 1 },
      { pid: 2 ** 53, created: 1 }, { pid: 1 }, { pid: 1, created: Infinity }, { pid: 1, created: Number.NaN }, { pid: 1, created: '5' }]) {
      expect(() => normalizeKillTargets([{ pid: 9, created: 9 }, bad])).toThrow('Each process to end needs a pid and a start time')
    }
  })

  it('accepts exactly the limit, keeps the first of a repeated pid and drops extra fields', () => {
    expect(normalizeKillTargets(Array.from({ length: 1000 }, (_, i) => ({ pid: i + 1, created: 0 })))).toHaveLength(1000)
    expect(
      normalizeKillTargets([
        { pid: 5, created: 1, extra: 'x' },
        { pid: 5, created: 2 },
        { pid: 6, created: -3 },
      ]),
    ).toEqual([
      { pid: 5, created: 1 },
      { pid: 6, created: -3 },
    ])
  })
})

function stuckRow(pid: number, tree: number[], created: number): StuckRow {
  return {
    pid,
    created,
    name: 'x',
    category: 'leftover',
    reasons: ['orphaned'],
    owner: 'orphaned',
    stuck: true,
    serving: [],
    ageMs: 0,
    cpuSec: 0,
    memBytes: 0,
    command: 'x',
    treeSize: tree.length,
    tree,
  }
}

/**
 * Row 10 owns 11 and — to prove the kill-time guard — also lists the protected 12 and this
 * process (1). 13 is a child of 10 that belongs to no row. Row 20 stands alone.
 */
function killCls(extra: StuckRow[] = []): StuckClassification {
  return {
    rows: [stuckRow(10, [10, 11, 12, 1], 1000), stuckRow(20, [20], 5000), ...extra],
    protectedPids: new Set([1, 12]),
    created: new Map([
      [1, 1],
      [10, 1000],
      [11, 1500],
      [12, 1600],
      [13, 1700],
      [20, 5000],
      [40, 7000],
    ]),
    children: new Map([
      [10, [11, 12, 13]],
      [11, [1]],
    ]),
    selfPid: 1,
    warnings: [],
  }
}

const sysErr = (code: string): Error => Object.assign(new Error(`kill ${code}`), { code })

describe('killStuckProcesses', () => {
  it('refuses a malformed request before scanning, and does nothing for an empty one', async () => {
    const classify = vi.fn(async () => killCls())
    await expect(killStuckProcesses('all', { classify })).rejects.toThrow('A list of processes to end is required')
    expect(await killStuckProcesses([], { classify })).toEqual({ killed: [], failed: [], skipped: [] })
    expect(classify).not.toHaveBeenCalled()
  })

  it('ends each target and its tree parent-first on Windows, skipping protected pids and stale targets', async () => {
    const kill = vi.fn((pid: number, _sig?: NodeJS.Signals) => {
      if (pid === 11) throw sysErr('ESRCH')
    })
    const classify = vi.fn(async () => killCls())
    const result = await killStuckProcesses(
      [
        { pid: 10, created: 1000 },
        { pid: 11, created: 1500 },
        { pid: 20, created: 1000 },
        { pid: 30, created: 1 },
        { pid: 13, created: 1700 },
        { pid: 40, created: 1 },
      ],
      { classify, kill, platform: 'win32' },
    )
    expect(result).toEqual({
      // 11 had already exited, which is what was asked for.
      killed: [10, 11],
      failed: [],
      skipped: [
        { pid: 20, reason: 'pid reused by a different process' },
        { pid: 30, reason: 'already exited' },
        { pid: 13, reason: 'still running but no longer listed' },
        { pid: 40, reason: 'pid reused by a different process' },
      ],
    })
    expect(kill.mock.calls).toEqual([
      [10, undefined],
      [11, undefined],
    ])
    expect(classify).toHaveBeenCalledTimes(1)
  })

  it('accepts a start time within the platform tolerance and refuses one outside it', async () => {
    const deps = { classify: async () => killCls(), kill: vi.fn(), alive: () => false }
    expect((await killStuckProcesses([{ pid: 20, created: 7000 }], { ...deps, platform: 'win32' })).killed).toEqual([20])
    expect((await killStuckProcesses([{ pid: 20, created: 7001 }], { ...deps, platform: 'win32' })).skipped).toHaveLength(1)
    expect((await killStuckProcesses([{ pid: 20, created: 10_000 }], { ...deps, platform: 'linux' })).killed).toEqual([20])
    expect((await killStuckProcesses([{ pid: 20, created: 10_001 }], { ...deps, platform: 'linux' })).skipped).toHaveLength(1)
  })

  it('with stuckOnly, skips a target that is still listed but no longer stuck', async () => {
    const kill = vi.fn()
    // 40 was resumed, re-adopted or started serving a port after the list was drawn.
    const classify = async (): Promise<StuckClassification> => killCls([{ ...stuckRow(40, [40], 7000), stuck: false }])
    const targets = [
      { pid: 40, created: 7000 },
      { pid: 20, created: 5000 },
    ]
    expect(await killStuckProcesses(targets, { classify, kill, platform: 'win32' }, { stuckOnly: true })).toEqual({
      killed: [20],
      failed: [],
      skipped: [{ pid: 40, reason: 'no longer stuck' }],
    })
    expect(kill.mock.calls).toEqual([[20, undefined]])

    // "Kill selected" names each process on purpose, stuck or not.
    kill.mockClear()
    expect(await killStuckProcesses(targets, { classify, kill, platform: 'win32' }, { stuckOnly: false })).toEqual({
      killed: [40, 20],
      failed: [],
      skipped: [],
    })
    expect(kill.mock.calls).toEqual([
      [40, undefined],
      [20, undefined],
    ])
  })

  it('sends SIGTERM, wakes stopped processes, waits, then SIGKILLs what is left', async () => {
    const calls: [number, NodeJS.Signals | undefined][] = []
    const kill = (pid: number, sig?: NodeJS.Signals): void => {
      calls.push([pid, sig])
      if (sig === 'SIGTERM' && pid === 11) throw sysErr('ESRCH')
      if (sig === 'SIGTERM' && pid === 40) throw sysErr('EPERM')
      // Exited between the two signals: not an error.
      if (sig === 'SIGCONT' && pid === 10) throw sysErr('ESRCH')
    }
    const wait = vi.fn(async (_ms: number) => {})
    const result = await killStuckProcesses(
      [
        { pid: 10, created: 1000 },
        { pid: 11, created: 1500 },
        { pid: 20, created: 1000 },
        { pid: 30, created: 1 },
        { pid: 40, created: 7000 },
      ],
      { classify: async () => killCls([stuckRow(40, [40], 7000)]), kill, alive: (pid) => pid === 20, wait, platform: 'linux' },
    )
    expect(result).toEqual({
      killed: [11, 10, 20],
      failed: [{ pid: 40, error: 'access denied — elevated or owned by another user' }],
      skipped: [{ pid: 30, reason: 'already exited' }],
    })
    expect(calls).toEqual([
      [10, 'SIGTERM'],
      [11, 'SIGTERM'],
      [20, 'SIGTERM'],
      [40, 'SIGTERM'],
      [10, 'SIGCONT'],
      [20, 'SIGCONT'],
      [20, 'SIGKILL'],
    ])
    expect(wait.mock.calls).toEqual(new Array(12).fill([250]))
  })

  it('stops waiting as soon as everything has exited', async () => {
    let checks = 0
    const kill = vi.fn()
    const wait = vi.fn(async (_ms: number) => {})
    const result = await killStuckProcesses([{ pid: 20, created: 5000 }], {
      classify: async () => killCls(),
      kill,
      wait,
      alive: () => ++checks <= 2,
      platform: 'darwin',
    })
    expect(result).toEqual({ killed: [20], failed: [], skipped: [] })
    expect(wait).toHaveBeenCalledTimes(2)
    expect(kill.mock.calls).toEqual([
      [20, 'SIGTERM'],
      [20, 'SIGCONT'],
    ])
  })

  it('counts a process that exits just before SIGKILL as killed, once', async () => {
    const kill = (_pid: number, sig?: NodeJS.Signals): void => {
      if (sig === 'SIGKILL') throw sysErr('ESRCH')
    }
    const result = await killStuckProcesses([{ pid: 20, created: 5000 }], {
      classify: async () => killCls(),
      kill,
      alive: () => true,
      wait: async () => {},
      platform: 'linux',
    })
    expect(result).toEqual({ killed: [20], failed: [], skipped: [] })
  })

  it('reports any other failure with its message', async () => {
    const kill = (pid: number): void => {
      if (pid === 10) throw new Error('weird')
      throw 'nope'
    }
    const result = await killStuckProcesses(
      [
        { pid: 10, created: 1000 },
        { pid: 20, created: 5000 },
      ],
      { classify: async () => killCls(), kill, platform: 'win32' },
    )
    expect(result).toEqual({
      killed: [],
      failed: [
        { pid: 10, error: 'weird' },
        { pid: 11, error: 'nope' },
        { pid: 20, error: 'nope' },
      ],
      skipped: [],
    })
  })

  it('signals with process.kill and polls with signal 0 by default', async () => {
    let n = 0
    const spy = vi.spyOn(process, 'kill').mockImplementation(((_pid: number, _sig?: string | number) => {
      n++
      // SIGTERM, SIGCONT, alive; then still there but not ours (EPERM), then gone.
      if (n === 4) throw sysErr('EPERM')
      if (n === 5) throw sysErr('ESRCH')
      return true
    }) as typeof process.kill)
    const result = await killStuckProcesses([{ pid: 20, created: 5000 }], { classify: async () => killCls(), platform: 'linux' })
    expect(result).toEqual({ killed: [20], failed: [], skipped: [] })
    expect(spy.mock.calls).toEqual([
      [20, 'SIGTERM'],
      [20, 'SIGCONT'],
      [20, 0],
      [20, 0],
      [20, 0],
    ])
  })

  it('terminates with process.kill and no signal on Windows by default', async () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill)
    const result = await killStuckProcesses([{ pid: 20, created: 5000 }], { classify: async () => killCls(), platform: 'win32' })
    expect(result.killed).toEqual([20])
    expect(spy.mock.calls).toEqual([[20, undefined]])
  })
})

describe('on this machine (read-only)', () => {
  it('scans the real process table and never lists itself', async () => {
    const scan = await scanStuckProcesses()
    expect(scan.totalProcesses).toBeGreaterThan(0)
    expect(scan.platform).toBe(process.platform)
    expect(scan.processes.some((p) => p.pid === process.pid)).toBe(false)
    expect(scan.warnings).not.toContain(SELF_MISSING)
  }, 90_000)

  it('refuses to end a pid that is not a listed row, without signalling anything', async () => {
    // Stubbed anyway, so a bug here can never end a real process.
    const spy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill)
    const target = 2 ** 30
    expect(await killStuckProcesses([{ pid: target, created: 0 }])).toEqual({
      killed: [],
      failed: [],
      skipped: [{ pid: target, reason: 'already exited' }],
    })
    expect(spy).not.toHaveBeenCalled()
  }, 90_000)
})
