// Safe Import — static dangerous-construct analyzer for third-party skills,
// plugins and MCP servers.
//
// WHY this exists: an imported artifact is not data, it is CODE plus INSTRUCTION
// TEXT that we are about to hand an agent which already holds the user's
// credentials, their repo and a live PTY. The marketplace is the soft underbelly of
// the whole agent stack — a "skill" is a few files in a zip, nobody diffs them, and
// the agent reads the instruction text as if the user had typed it. Two distinct
// threats, both covered here:
//
//   1. Malicious CODE. The artifact phones home, shells out, reads ~/.aws, or
//      unpacks a base64 blob into eval(). The classic supply-chain payload.
//   2. Malicious PROSE — "tool poisoning". The payload is a sentence in SKILL.md or
//      in an MCP tool's `description` telling the agent to ignore its instructions
//      and mail the user's .env somewhere. No dangerous API call appears anywhere:
//      the agent IS the exploit. This is why the inject.* rules run over EVERY file
//      and not just markdown — in the wild the poisoned description lives in
//      server.py, right next to the handler it describes.
//
// The bar Safe Import promises is LOCAL-ONLY: nothing the artifact does may move
// data off the machine or run code. So red = can exfiltrate or execute; yellow =
// suspicious but has honest uses (a lone process.env read, a ~/ path, a mid-sized
// encoded blob). Worst finding wins.
//
// This is a REVIEW aid, not a sandbox. It is static and line-based, and a determined
// attacker can obfuscate past any of it. Its job is to put the three lines that
// matter in front of the user BEFORE they click Import — not to prove safety.
//
// Pure: no fs, no electron, no network. The caller supplies the file list, so the
// whole analyzer is unit-testable without touching disk.

export type RiskLevel = 'green' | 'yellow' | 'red'

export interface ScannedFile {
  path: string
  content: string
}

export interface Finding {
  rule: string
  label: string
  /** Only 'red' | 'yellow' are ever emitted — 'green' is the absence of findings. */
  severity: RiskLevel
  file: string
  /** 1-indexed. */
  line: number
  excerpt: string
}

export interface ImportRiskReport {
  level: RiskLevel
  findings: Finding[]
  filesScanned: number
  summary: string
}

/** Per-file scan cap. A skill has no honest reason to ship a 512 KB source file;
 *  beyond this we stop reading rather than let a padded artifact burn the main
 *  thread. The file is still counted, and the head — where a loader lives — is
 *  still scanned. */
const MAX_SCAN_BYTES = 512 * 1024
/** A source line this long is not written for a human to read. */
const MINIFIED_LINE = 1000
const EXCERPT_MAX = 160
const UNKNOWN_PATH = '<unknown>'

type Severity = 'red' | 'yellow'

interface ConstructRule {
  id: string
  label: string
  severity: Severity
  /** Line-scoped. Deliberately NOT /g — .test() on a global regex is stateful and
   *  would make the scanner return different answers on a second run. */
  patterns: RegExp[]
}

const RULES: ConstructRule[] = [
  // === Outbound network — the exfiltration channel itself. ===
  { id: 'net.fetch', label: 'Outbound network call (fetch)', severity: 'red', patterns: [/\bfetch\s*\(/] },
  { id: 'net.axios', label: 'Outbound network call (axios)', severity: 'red', patterns: [/\baxios\b/i] },
  { id: 'net.xhr', label: 'Outbound network call (XMLHttpRequest)', severity: 'red', patterns: [/\bXMLHttpRequest\b/] },
  { id: 'net.websocket', label: 'Outbound WebSocket connection', severity: 'red', patterns: [/\bWebSocket\b/, /\bwebsockets?\.(?:connect|create_connection)\s*\(/i] },
  {
    id: 'net.node_module',
    label: 'Node network module (http/https/net/dgram/dns/tls)',
    severity: 'red',
    patterns: [/(?:require\s*\(\s*|from\s+|import\s+)['"](?:node:)?(?:http|https|net|dgram|dns|tls)['"]/],
  },
  { id: 'net.node_fetch', label: 'node-fetch dependency', severity: 'red', patterns: [/['"]node-fetch['"]/] },
  {
    id: 'net.python',
    label: 'Python HTTP client (requests/urllib)',
    severity: 'red',
    patterns: [/\brequests\.(?:get|post|put|patch|delete|head|request|Session)\b/, /\burllib3?\b/, /\bhttp\.client\b/],
  },
  {
    id: 'net.shell',
    label: 'Shell network transfer (curl/wget/nc/Invoke-WebRequest)',
    severity: 'red',
    // `nc` is required to look like netcat (host + port), otherwise every `.sync(`
    // and every two-letter variable in the artifact would light up red.
    patterns: [/\bcurl\s/i, /\bwget\s/i, /\bnc\s+(?:-[a-zA-Z]+\s+)*[\w.-]+\s+\d{1,5}\b/, /\bInvoke-(?:WebRequest|RestMethod)\b/i],
  },

  // === Code execution — the other half of "can it hurt me". ===
  { id: 'exec.child_process', label: 'Node child_process (arbitrary command execution)', severity: 'red', patterns: [/\bchild_process\b/] },
  { id: 'exec.sync', label: 'Synchronous command execution (execSync/spawnSync)', severity: 'red', patterns: [/\b(?:execSync|spawnSync|execFileSync)\s*\(/] },
  { id: 'exec.spawn', label: 'Process spawn', severity: 'red', patterns: [/\bspawn\s*\(/] },
  // Bare `exec(` only. `.exec(` is excluded on purpose: RegExp.prototype.exec owns
  // that shape in real code, and the dangerous `child_process.exec` is already red
  // via exec.child_process on the import line.
  { id: 'exec.exec', label: 'Bare exec() call', severity: 'red', patterns: [/(?<![$\w.])exec\s*\(/] },
  { id: 'exec.eval', label: 'eval() — arbitrary code execution', severity: 'red', patterns: [/\beval\s*\(/] },
  { id: 'exec.new_function', label: 'new Function() — arbitrary code execution', severity: 'red', patterns: [/\bnew\s+Function\s*\(/] },
  { id: 'exec.os_system', label: 'Python os.system/os.popen', severity: 'red', patterns: [/\bos\.(?:system|popen)\s*\(/] },
  { id: 'exec.subprocess', label: 'Python subprocess', severity: 'red', patterns: [/\bsubprocess\.\w+/] },
  { id: 'exec.java_runtime', label: 'Java Runtime.getRuntime()', severity: 'red', patterns: [/\bRuntime\.getRuntime\s*\(/] },

  // === Credentials / environment. ===
  // A lone env read is yellow: half the honest plugins on earth read process.env.
  // Reaching for a credential FILE or the OS keychain is not ambiguous — that's red.
  { id: 'cred.process_env', label: 'Reads the process environment (process.env)', severity: 'yellow', patterns: [/\bprocess\.env\b/] },
  { id: 'cred.os_environ', label: 'Reads the process environment (os.environ/getenv)', severity: 'yellow', patterns: [/\bos\.environ\b/, /\bgetenv\s*\(/] },
  { id: 'cred.keytar', label: 'OS keychain access (keytar)', severity: 'red', patterns: [/\bkeytar\b/i] },
  { id: 'cred.keychain', label: 'OS keychain / credential manager access', severity: 'red', patterns: [/keychain/i, /\bsecurity\s+find-generic-password\b/i, /\bcmdkey\b/i] },
  { id: 'cred.aws', label: 'AWS credentials directory (~/.aws)', severity: 'red', patterns: [/~[\\/]\.aws\b/, /\.aws[\\/]credentials\b/] },
  { id: 'cred.ssh_key', label: 'SSH private key material (~/.ssh, id_rsa)', severity: 'red', patterns: [/~[\\/]\.ssh\b/, /\bid_rsa\b/, /\bid_ed25519\b/] },
  // `.env` as a FILE. The lookbehind keeps process.env / import.meta.env out of it.
  { id: 'cred.dotenv', label: '.env secrets file', severity: 'red', patterns: [/(?<![\w.$])\.env\b/] },
  { id: 'cred.credentials_file', label: 'Cloud credentials file (credentials.json)', severity: 'red', patterns: [/credentials\.json\b/i, /\bservice[_-]account\.json\b/i] },

  // === Filesystem reach outside the workspace. ===
  { id: 'fs.system_path', label: 'Absolute system path outside the workspace', severity: 'red', patterns: [/\/etc\//, /\/root\//, /\/proc\/self\b/, /[A-Za-z]:[\\/]+Windows\b/i] },
  {
    id: 'fs.homedir',
    label: 'Home-directory lookup (os.homedir/expanduser/$HOME)',
    severity: 'yellow',
    patterns: [/\bos\.homedir\s*\(/, /\bos\.path\.expanduser\b/, /\bPath\.home\s*\(/, /\$HOME\b/, /%USERPROFILE%/i],
  },
  // A bare `~/` is yellow on its own. `~/.aws` and `~/.ssh` are already red above —
  // the lookahead stops us reporting the same characters twice.
  { id: 'fs.tilde_path', label: 'Home-directory (~/) path reference', severity: 'yellow', patterns: [/~[\\/](?!\.aws\b|\.ssh\b)/] },

  // === Obfuscation. What you can't read, you can't review. ===
  // Hex is a subset of the base64 alphabet, so one char class covers both blobs.
  { id: 'obf.blob_long', label: 'Long encoded blob (200+ base64/hex chars)', severity: 'red', patterns: [/(?<![A-Za-z0-9+/=])[A-Za-z0-9+/=]{200,}(?![A-Za-z0-9+/=])/] },
  { id: 'obf.blob_moderate', label: 'Moderate encoded blob (80+ base64/hex chars)', severity: 'yellow', patterns: [/(?<![A-Za-z0-9+/=])[A-Za-z0-9+/=]{80,199}(?![A-Za-z0-9+/=])/] },
  { id: 'obf.atob', label: 'atob() base64 decode', severity: 'red', patterns: [/\batob\s*\(/] },

  // === Prompt injection / tool poisoning. The agent is the attack surface. ===
  {
    id: 'inject.ignore_instructions',
    label: 'Prompt injection: overrides the agent’s instructions',
    severity: 'red',
    patterns: [
      /\bignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier|preceding)\b/i,
      /\bdisregard\s+(?:all\s+)?(?:the\s+|your\s+|any\s+)?(?:previous|prior|earlier|above|instructions?|rules?)\b/i,
      /\bforget\s+(?:all\s+)?(?:your\s+)?(?:previous|prior)\b/i,
    ],
  },
  {
    id: 'inject.hide_from_user',
    label: 'Prompt injection: tells the agent to hide activity from the user',
    severity: 'red',
    patterns: [
      /\b(?:do\s+not|don['’]?t|never)\s+(?:tell|inform|notify|alert|show|warn)\s+(?:the\s+)?user\b/i,
      /\bwithout\s+(?:telling|informing|notifying|alerting)\s+(?:the\s+)?user\b/i,
      /\bhide\s+(?:this|it|that)?\s*from\s+the\s+user\b/i,
      /\bdo\s+not\s+mention\s+(?:this|it)\b/i,
    ],
  },
  {
    id: 'inject.exfiltrate',
    label: 'Prompt injection: data exfiltration instruction',
    severity: 'red',
    patterns: [
      /\bexfiltrat/i,
      /\b(?:send|upload|post|email|transmit|forward)\s+(?:me\s+)?(?:the\s+)?(?:contents?|files?|data|output|results?)\s+of\b/i,
      /\b(?:curl|wget|post|upload|send)\s+the\s+\w+\s+to\b/i,
      /\b(?:send|post|upload)\b[^\n]{0,40}\bto\s+https?:\/\//i,
    ],
  },
  {
    id: 'inject.system_prompt',
    label: 'Prompt injection: system-prompt disclosure',
    severity: 'red',
    patterns: [
      /\b(?:print|reveal|repeat|output|show|display|dump|share|echo)\s+(?:me\s+)?(?:your|the)\s+(?:full\s+|entire\s+|complete\s+)?(?:system\s+(?:prompt|message)|initial\s+(?:prompt|instructions?)|original\s+(?:prompt|instructions?)|instructions?)\b/i,
    ],
  },
  {
    id: 'inject.encode_payload',
    label: 'Prompt injection: encode-then-send payload',
    severity: 'red',
    patterns: [
      /\bbase64[\s-]?(?:encode\s+)?the\b/i,
      /\bencode\s+(?:the\s+)?(?:file|contents?|output|data)\s+(?:in|as|to|with)\s+base64\b/i,
    ],
  },
]

// --- Context-sensitive rules ------------------------------------------------
// Three constructs can't be judged from the token alone, so they get a second
// signal before we decide red vs yellow.

/** Destructive filesystem ops. On their own these are ordinary (a skill writes its
 *  output somewhere) — what makes them red is WHERE they point. */
const DESTRUCTIVE: RegExp[] = [
  /\bfs\.(?:writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync)\b/,
  /\b(?:writeFileSync|unlinkSync|rmSync)\s*\(/,
  /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\b/,
  /\bshutil\.rmtree\s*\(/,
  /\bos\.remove\s*\(/,
  /\bRemove-Item\b/i,
]

/** "This path leaves the workspace." Only ever consulted on a line that already
 *  carries a destructive op, which is what makes the loose alternatives safe:
 *  a bare " /" is meaningless in general but damning in `rm -rf /`. */
const ESCAPE_HINT =
  /~[\\/]|\.\.[\\/]|\$HOME\b|%USERPROFILE%|%APPDATA%|\bos\.homedir\s*\(|\bos\.path\.expanduser\b|['"`]\s*\/[A-Za-z]|[A-Za-z]:[\\/]|\s\/(?=\s|$)/

/** A base64 decode. Benign by itself (images, fixtures) — lethal next to a sink. */
const B64_DECODE: RegExp[] = [
  /Buffer\.from\s*\([^)]*['"]base64['"]/,
  /\bbase64\.b64decode\s*\(/,
  /\bbase64\.decodestring\s*\(/,
]

/** File-level: does anything here EXECUTE what a decode produces? Kept deliberately
 *  narrow (no `.exec(`) so a regex in the same file can't force a red. */
const EXEC_SINK =
  /(?<![$\w.])eval\s*\(|\bnew\s+Function\s*\(|(?<![$\w.])exec\s*\(|\bexecSync\s*\(|\bspawnSync\s*\(|\bspawn\s*\(|\bchild_process\b|\bvm\.runIn\w*\s*\(|\bsubprocess\.\w+|\bos\.(?:system|popen)\s*\(/

/** Binary-ish content is skipped: a NUL byte or a control-char soup is a compiled
 *  blob, not source, and running 40 regexes over it only produces noise. */
function looksBinary(content: string): boolean {
  const sample = content.length > 4096 ? content.slice(0, 4096) : content
  let control = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i)
    if (c === 0) return true
    if (c === 9 || c === 10 || c === 13) continue
    if (c < 32 || c === 127) control++
  }
  return sample.length > 0 && control / sample.length > 0.1
}

function excerpt(line: string): string {
  const trimmed = line.trim()
  return trimmed.length > EXCERPT_MAX ? trimmed.slice(0, EXCERPT_MAX) : trimmed
}

function fileWord(n: number): string {
  return n === 1 ? '1 file' : n + ' files'
}

function summarize(red: number, yellow: number, files: number): string {
  const scope = ' across ' + fileWord(files)
  if (red === 0 && yellow === 0) return 'No dangerous constructs found' + scope
  const parts: string[] = []
  if (red > 0) parts.push(red + ' red')
  if (yellow > 0) parts.push(yellow + ' yellow')
  return parts.join(', ') + scope
}

/** Static risk report for an artifact the user is about to import. Every file is
 *  counted; unreadable ones (binary, oversized tail) are counted but not scanned. */
export function scanImportArtifact(files: ScannedFile[]): ImportRiskReport {
  const list = Array.isArray(files) ? files : []
  const findings: Finding[] = []
  const seen = new Set<string>()

  const add = (rule: string, label: string, severity: Severity, file: string, line: number, text: string): void => {
    // `line` is digits and `rule` is [a-z._] — putting the free-form path LAST
    // means no separator collision is possible.
    const key = line + '|' + rule + '|' + file
    if (seen.has(key)) return
    seen.add(key)
    findings.push({ rule, label, severity, file, line, excerpt: excerpt(text) })
  }

  for (const entry of list) {
    const raw: Partial<ScannedFile> = entry || {}
    const content = typeof raw.content === 'string' ? raw.content : ''
    const file = typeof raw.path === 'string' && raw.path ? raw.path : UNKNOWN_PATH
    if (!content || looksBinary(content)) continue

    const body = content.length > MAX_SCAN_BYTES ? content.slice(0, MAX_SCAN_BYTES) : content
    const hasExecSink = EXEC_SINK.test(body)
    const lines = body.split(/\r?\n/)

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      const n = i + 1

      for (const rule of RULES) {
        if (rule.patterns.some((p) => p.test(line))) add(rule.id, rule.label, rule.severity, file, n, line)
      }

      if (DESTRUCTIVE.some((p) => p.test(line))) {
        if (ESCAPE_HINT.test(line)) add('fs.write_outside', 'Destructive filesystem write outside the workspace', 'red', file, n, line)
        else add('fs.destructive', 'Destructive filesystem operation', 'yellow', file, n, line)
      }

      if (B64_DECODE.some((p) => p.test(line))) {
        if (hasExecSink) add('obf.b64_exec', 'base64 decode feeding an execution sink', 'red', file, n, line)
        else add('obf.b64_decode', 'base64 decode (Buffer.from / b64decode)', 'yellow', file, n, line)
      }

      if (line.length > MINIFIED_LINE) add('obf.minified', 'Minified single-line payload (1000+ chars)', 'red', file, n, line)
    }
  }

  const red = findings.filter((x) => x.severity === 'red').length
  const yellow = findings.length - red
  const level: RiskLevel = red > 0 ? 'red' : yellow > 0 ? 'yellow' : 'green'
  return { level, findings, filesScanned: list.length, summary: summarize(red, yellow, list.length) }
}
