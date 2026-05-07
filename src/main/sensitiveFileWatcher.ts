// Sensitive-file-read watcher — observes the AI agent's transcript stream
// (via agentEventBus tool_call events) and flags any time the agent has
// just read a file that we consider high-risk (.env, *.pem, ~/.aws/credentials, …).
//
// Why this exists:
//   The terminal-side secret scanner can only see what the *user* types into
//   the prompt. When Claude Code (or any other agent) autonomously decides to
//   `Read('.env')`, the file's contents are quietly added to its prompt and
//   transmitted to the provider on the next API turn. Nothing in the user's
//   typing path catches that — it's an agent-internal action.
//
//   Provider commercial-tier ToS exclude API traffic from training, so the
//   bytes don't end up in a future model. But the bytes WERE transmitted, the
//   user usually didn't realise it would happen, and a security-conscious team
//   wants a record + a nudge ("add this to .claudeignore next time").
//
// Design choices:
//   - Pure pattern-match on the absolute file path. We don't read the file
//     contents — we already know the agent did, and we don't want to read
//     a 50 MB key file ourselves.
//   - Glob matching, not regex, because the rules are list-shaped ("any
//     file under ~/.ssh except *.pub and 'config'"). minimatch isn't a
//     dependency, so we hand-roll a small matcher; the patterns are
//     conservative and the match list is short.
//   - Subscribes to agentEventBus, not the transcript files directly —
//     keeps a single source of truth for parse errors and event ordering.
//   - Per-terminal counter so the Security panel can show "3 sensitive
//     reads this session"; reset on terminal close.
//   - Detects both Read tool calls (file_path argument) and Bash tool
//     calls (cat/head/tail/grep/Get-Content of a sensitive path).
//
// What it does NOT do:
//   - Block the read. The file has already been read by the time we see the
//     event — the JSONL transcript is downstream of the agent's tool runtime.
//   - Catch reads done via shell commands the agent piped through other
//     processes (e.g. `python -c 'open(".env").read()'`). The Bash detector
//     only trims the obvious cases.
//   - Reverse-DNS or otherwise enrich the path. We just record the basename.

import * as path from 'path'
import * as os from 'os'
import { subscribe, type AgentEvent } from './agentEventBus'

export interface SensitiveMatch {
  /** Original path the agent reported reading */
  filePath: string
  /** Which rule matched (e.g. 'dotenv', 'aws-credentials') */
  rule: string
  /** Human-readable label (e.g. '.env file', 'AWS credentials') */
  label: string
  /** Tool name that triggered (Read, Bash, Edit, …) */
  tool: string
  /** Source heuristic: 'path' (direct file_path argument) or 'command' (parsed from shell command) */
  source: 'path' | 'command'
}

export interface SensitiveReadEvent extends SensitiveMatch {
  ts: number
  terminalId: string
  agent: string
}

interface RuleDef {
  id: string
  label: string
  /** test the basename / full path; return true if it matches */
  match: (basename: string, fullPath: string) => boolean
}

// We test against the BASENAME first (cheap), then the FULL PATH (for
// rules anchored to ~/.ssh, ~/.aws, ~/.config, etc). Both tests get
// normalised to lower-case on Windows because filesystems there are
// case-insensitive — agents will sometimes report "C:\Users\…\.AWS\credentials"
// with mixed case.

const HOME = (() => {
  try { return os.homedir() } catch { return '' }
})()

function norm(p: string): string {
  if (!p) return ''
  let q = p.trim()
  // strip surrounding quotes the agent may have included
  if ((q.startsWith('"') && q.endsWith('"')) || (q.startsWith("'") && q.endsWith("'"))) {
    q = q.slice(1, -1)
  }
  // expand ~ and ~/ to homedir for matching purposes
  if (q === '~' || q.startsWith('~/') || q.startsWith('~\\')) {
    q = path.join(HOME, q.slice(2))
  }
  // unify path sep on Windows for full-path checks
  return q.replace(/\\/g, '/')
}

const KEY_BASENAMES_CASE_SENSITIVE = new Set([
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', 'identity', 'authorized_keys',
])

export const RULES: RuleDef[] = [
  // --- .env family ---
  // Match .env, .env.local, .env.production, etc.
  // EXCLUDE .env.example, .env.sample, .env.template
  {
    id: 'dotenv',
    label: '.env file',
    match: (base) => {
      const b = base.toLowerCase()
      if (b === '.env') return true
      if (!b.startsWith('.env.')) return false
      const tail = b.slice(5)
      if (!tail) return false
      // Common safe-to-share suffixes
      if (['example', 'sample', 'template', 'dist', 'tpl'].includes(tail)) return false
      return true
    },
  },

  // --- Private keys (OpenSSH, OpenSSL, PGP) ---
  {
    id: 'private-key-pem',
    label: 'PEM-format private key',
    match: (base) => /\.(pem|key)$/i.test(base) && !/\.pub$/i.test(base),
  },
  {
    id: 'pkcs12',
    label: 'PKCS#12 keystore',
    match: (base) => /\.(p12|pfx)$/i.test(base),
  },
  {
    id: 'jks',
    label: 'Java keystore',
    match: (base) => /\.(jks|keystore)$/i.test(base),
  },
  {
    id: 'ssh-private-key',
    label: 'SSH private key',
    match: (base) => {
      // explicit names — id_rsa, id_ed25519, etc — but NOT *.pub
      if (/\.pub$/i.test(base)) return false
      const b = base
      if (KEY_BASENAMES_CASE_SENSITIVE.has(b)) return true
      // id_<algo>(_xxx) without .pub
      if (/^id_[a-z0-9]+(?:_[a-z0-9]+)*$/i.test(b) && !/\.pub$/i.test(b)) return true
      return false
    },
  },

  // --- Cloud provider creds ---
  {
    id: 'aws-credentials',
    label: 'AWS credentials file',
    match: (base, full) => {
      const b = base.toLowerCase()
      if (b !== 'credentials' && b !== 'config') return false
      // Only flag when path includes `.aws`
      return /\/\.aws\//i.test(full) || /\\\.aws\\/i.test(full) || full.toLowerCase().includes('/.aws/')
    },
  },
  {
    id: 'gcp-service-account',
    label: 'GCP service-account key',
    match: (base) => {
      const b = base.toLowerCase()
      if (!b.endsWith('.json')) return false
      return (
        b === 'credentials.json' ||
        b === 'service-account.json' ||
        b === 'gcp-key.json' ||
        b.startsWith('service-account-') ||
        b.startsWith('gcp-key-') ||
        b.startsWith('google-credentials')
      )
    },
  },
  {
    id: 'azure-credentials',
    label: 'Azure credentials file',
    match: (base) => /^azure[-_]?(credentials|profile)\.(json|txt)$/i.test(base),
  },

  // --- SSH directory contents (anything under ~/.ssh except .pub and 'config' alone) ---
  {
    id: 'ssh-dir-content',
    label: 'file inside ~/.ssh',
    match: (base, full) => {
      if (!/\/\.ssh\//i.test(full) && !/\\\.ssh\\/i.test(full)) return false
      const b = base.toLowerCase()
      if (b === 'known_hosts' || b === 'known_hosts.old') return false
      if (b === 'config') return false
      if (b.endsWith('.pub')) return false
      // Avoid double-flagging items already caught by ssh-private-key
      return true
    },
  },

  // --- Auth tokens / configs in dotfiles ---
  { id: 'netrc',  label: '.netrc',  match: (base) => /^_?\.?netrc(\.gpg)?$/i.test(base) },
  { id: 'npmrc',  label: '.npmrc',  match: (base) => /^_?\.?npmrc$/i.test(base) },
  { id: 'pypirc', label: '.pypirc', match: (base) => /^_?\.?pypirc$/i.test(base) },
  {
    id: 'docker-config',
    label: 'docker config (registry creds)',
    match: (base, full) => base.toLowerCase() === 'config.json' && /\/\.docker\//i.test(full),
  },
  {
    id: 'kube-config',
    label: 'kubeconfig',
    match: (base, full) => {
      const b = base.toLowerCase()
      if (b === 'config' && /\/\.kube\//i.test(full)) return true
      if (b === 'kubeconfig' || b.endsWith('.kubeconfig')) return true
      return false
    },
  },

  // --- Generic secret-named files ---
  {
    id: 'secrets-file',
    label: 'secrets configuration file',
    match: (base) => /^secrets?\.(ya?ml|json|env|toml|ini)$/i.test(base),
  },
  {
    id: 'credentials-file',
    label: 'credentials configuration file',
    match: (base) => /^credentials?\.(ya?ml|json|env|toml|ini)$/i.test(base),
  },
  {
    id: 'database-url',
    label: 'database URL config',
    match: (base) => /^database(?:_|-)?(?:url|password)\.(?:env|txt|json)$/i.test(base),
  },

  // --- GnuPG / KeePass ---
  {
    id: 'gpg-private',
    label: 'GnuPG private key store',
    match: (base, full) => {
      const b = base.toLowerCase()
      if (b === 'secring.gpg' || b === 'pubring.kbx') return false
      if (b === 'pubring.gpg') return false
      if (/\.gnupg\//i.test(full) && (b === 'secring.gpg' || b.endsWith('.key'))) return true
      return false
    },
  },
  {
    id: 'keepass-db',
    label: 'KeePass database',
    match: (base) => /\.(kdbx|kdb)$/i.test(base),
  },

  // --- Browser cookies / session stores ---
  {
    id: 'browser-cookies',
    label: 'browser cookies database',
    match: (base, full) => {
      const b = base.toLowerCase()
      if (b !== 'cookies' && b !== 'cookies.sqlite' && b !== 'cookies.db') return false
      const f = full.toLowerCase()
      return /chrome|firefox|edge|safari|brave|chromium/.test(f)
    },
  },
]

export function matchSensitiveFile(filePath: string): SensitiveMatch | null {
  if (!filePath || typeof filePath !== 'string') return null
  const normalized = norm(filePath)
  if (!normalized) return null
  const base = path.basename(normalized)
  if (!base) return null
  // Skip URL-shaped strings (http://, file://, …) — agents sometimes pass URLs
  if (/^[a-z]+:\/\//i.test(filePath)) return null

  for (const rule of RULES) {
    try {
      if (rule.match(base, normalized)) {
        return {
          filePath,
          rule: rule.id,
          label: rule.label,
          tool: 'Read',
          source: 'path',
        }
      }
    } catch {
      // a rule throwing must never crash the watcher
    }
  }
  return null
}

const FS_TOOLS = new Set([
  'Read', 'read_file', 'view', 'open_file', 'fs_read', 'fs.read',
  'Edit', 'Write', 'NotebookEdit', 'edit_file', 'write_file',
  'MultiEdit', 'str_replace_editor',
])

const SHELL_TOOLS = new Set([
  'Bash', 'bash', 'shell', 'run_shell_command', 'execute_command',
  'shell.exec', 'container.exec', 'terminal',
])

// Conservative shell command parser: pulls out the first non-flag positional
// after a known reader command. Only flags an obvious cat/head/tail/grep/etc.
// of a sensitive file. We don't try to handle pipes or quoting edge cases —
// false negatives are acceptable, false positives on this path would noise the UI.
const READER_CMDS = new Set([
  'cat', 'tac', 'head', 'tail', 'less', 'more', 'bat',
  'grep', 'rg', 'fgrep', 'egrep', 'sed', 'awk', 'cut',
  'xxd', 'od', 'hexdump', 'strings', 'file',
  'cp', 'mv', 'rsync',  // copying off-host is also leak-shaped
  'get-content', 'gc', 'select-string', 'sls', 'type',  // PowerShell + cmd
  'curl', 'wget',  // upload via @-syntax: curl -F file=@.env
])

// Short flags whose value is the NEXT positional argument. Without this
// "head -n 5 file" would treat "5" as a path. We don't try to be perfect —
// covering the common cases for our reader command set is enough.
const FLAGS_TAKING_VALUE = new Set([
  '-n', '-c', '-A', '-B', '-C', '-m', '-o', '-O',
  '--bytes', '--lines', '--after-context', '--before-context', '--context',
  '--exclude', '--include', '--regexp', '--max-count', '--output',
])

export function extractPathsFromCommand(cmd: string): string[] {
  if (!cmd || typeof cmd !== 'string') return []
  const out: string[] = []
  // Split on common subcommand boundaries — `;`, `&&`, `||`, `|`
  const segments = cmd.split(/(?:&&|\|\||;|\|)/)
  for (const seg of segments) {
    const trimmed = seg.trim()
    if (!trimmed) continue
    const tokens = tokenizeShellLine(trimmed)
    if (tokens.length < 2) continue
    let cmdToken = tokens[0].toLowerCase()
    // Strip leading `sudo`/`time`/path prefixes
    let i = 0
    while (i < tokens.length && (cmdToken === 'sudo' || cmdToken === 'time' || cmdToken === 'env')) {
      i++
      cmdToken = (tokens[i] || '').toLowerCase()
    }
    const baseCmd = path.basename(cmdToken).toLowerCase()
    if (!READER_CMDS.has(baseCmd)) continue
    // walk remaining args, take non-flag positionals.
    // Flags-with-value consume the next token (e.g. `head -n 5 file` → skip "5").
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j]
      if (!t) continue
      if (t.startsWith('-')) {
        // `--foo=bar` is self-contained; `--foo bar` consumes next token
        if (!t.includes('=') && FLAGS_TAKING_VALUE.has(t)) {
          j++ // skip flag value
        }
        continue
      }
      // curl -F file=@.env style — extract after the `@`
      const atIdx = t.indexOf('@')
      if (baseCmd === 'curl' && atIdx >= 0) {
        out.push(t.slice(atIdx + 1))
        continue
      }
      out.push(t)
    }
  }
  return out
}

function tokenizeShellLine(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === quote) {
        quote = null
      } else {
        cur += c
      }
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (/\s/.test(c)) {
      if (cur) { out.push(cur); cur = '' }
      continue
    }
    cur += c
  }
  if (cur) out.push(cur)
  return out
}

export function matchToolEvent(event: AgentEvent): SensitiveMatch[] {
  if (!event || event.kind !== 'tool_call') return []
  const payload = event.payload as Record<string, unknown> | undefined
  if (!payload || typeof payload !== 'object') return []
  const tool = String(payload.tool || '')
  const input = payload.input as Record<string, unknown> | string | undefined

  const out: SensitiveMatch[] = []

  // 1) Direct file-path tools (Read, Edit, etc) → input.file_path / input.path
  if (FS_TOOLS.has(tool)) {
    const candidate =
      (typeof input === 'object' && input && (input.file_path as string)) ||
      (typeof input === 'object' && input && (input.path as string)) ||
      (typeof input === 'object' && input && (input.filename as string)) ||
      (typeof input === 'string' ? input : '')
    if (candidate && typeof candidate === 'string') {
      const m = matchSensitiveFile(candidate)
      if (m) out.push({ ...m, tool, source: 'path' })
    }
    // Codex/Gemini may stringify the input as JSON
    if (typeof input === 'string') {
      try {
        const parsed = JSON.parse(input)
        if (parsed && typeof parsed === 'object') {
          const p = (parsed.file_path || parsed.path || parsed.filename) as string | undefined
          if (typeof p === 'string') {
            const m = matchSensitiveFile(p)
            if (m) out.push({ ...m, tool, source: 'path' })
          }
        }
      } catch { /* not JSON, ignore */ }
    }
  }

  // 2) Shell tools (Bash, run_shell_command, container.exec)
  if (SHELL_TOOLS.has(tool)) {
    let cmd: string | undefined
    if (typeof input === 'string') cmd = input
    else if (typeof input === 'object' && input) {
      const rawCmd = (input as Record<string, unknown>).command
      const rawCmdAlt = (input as Record<string, unknown>).cmd ?? (input as Record<string, unknown>).script
      if (Array.isArray(rawCmd)) {
        // Codex container.exec is array-shaped: ['cat', '.env']
        cmd = (rawCmd as unknown[]).map(String).join(' ')
      } else if (typeof rawCmd === 'string') {
        cmd = rawCmd
      } else if (typeof rawCmdAlt === 'string') {
        cmd = rawCmdAlt
      } else if (Array.isArray(rawCmdAlt)) {
        cmd = (rawCmdAlt as unknown[]).map(String).join(' ')
      }
    }
    if (cmd && typeof cmd === 'string') {
      const paths = extractPathsFromCommand(cmd)
      for (const p of paths) {
        const m = matchSensitiveFile(p)
        if (m) out.push({ ...m, tool, source: 'command' })
      }
    }
  }

  return out
}

// ---- Per-terminal counters ----
const counters = new Map<string, number>()
const recent = new Map<string, SensitiveReadEvent[]>()
const MAX_RECENT_PER_TERMINAL = 64

export function getReadCount(terminalId: string): number {
  return counters.get(terminalId) || 0
}

export function getRecentReads(terminalId: string): SensitiveReadEvent[] {
  return recent.get(terminalId) || []
}

export function clearReadCount(terminalId?: string): void {
  if (terminalId) {
    counters.delete(terminalId)
    recent.delete(terminalId)
  } else {
    counters.clear()
    recent.clear()
  }
}

function recordHit(ev: SensitiveReadEvent): void {
  counters.set(ev.terminalId, (counters.get(ev.terminalId) || 0) + 1)
  let list = recent.get(ev.terminalId)
  if (!list) {
    list = []
    recent.set(ev.terminalId, list)
  }
  list.push(ev)
  if (list.length > MAX_RECENT_PER_TERMINAL) {
    list.splice(0, list.length - MAX_RECENT_PER_TERMINAL)
  }
}

export type SensitiveReadHandler = (ev: SensitiveReadEvent) => void

let unsub: (() => void) | null = null

export function subscribeSensitiveReads(handler: SensitiveReadHandler): () => void {
  // Idempotent: re-subscribing replaces the prior subscription.
  if (unsub) {
    try { unsub() } catch {}
    unsub = null
  }

  unsub = subscribe((event) => {
    try {
      const matches = matchToolEvent(event)
      if (!matches.length) return
      const seen = new Set<string>()
      for (const m of matches) {
        const key = m.rule + '|' + m.filePath
        if (seen.has(key)) continue
        seen.add(key)
        const ev: SensitiveReadEvent = {
          ...m,
          ts: event.ts,
          terminalId: event.terminalId,
          agent: event.agentType,
        }
        recordHit(ev)
        try { handler(ev) } catch { /* never let a handler kill the bus */ }
      }
    } catch { /* swallow — never break agentEventBus subscribers */ }
  })

  return () => {
    if (unsub) {
      try { unsub() } catch {}
      unsub = null
    }
  }
}

/** Test-only: reset all in-memory state. */
export function _resetForTests(): void {
  if (unsub) {
    try { unsub() } catch {}
    unsub = null
  }
  counters.clear()
  recent.clear()
}
