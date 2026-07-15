#!/usr/bin/env node

// Commit Shield — the STANDALONE scanner a git pre-commit / pre-push hook invokes.
//
// WHY THIS FILE EXISTS, AND WHY IT IS .cjs
// git runs hooks in a plain `node` process, from the repo root, with Termpolis very
// possibly CLOSED. So this cannot import the Electron main process, cannot go through
// the bundler, cannot call the app's HTTP control server, and cannot reach MCP. A hook
// that only works while the app happens to be running silently stops protecting you the
// moment you quit — which is worse than no hook, because you would still believe you
// had one. Everything here is zero-dependency CommonJS, sync, and self-contained.
//
// The rule table is the app's, loaded from ./secretRules.cjs (electron-builder already
// ships src/mcp-adapter/**/*.cjs into resources/mcp-adapter/), and
// tests/electron/secretRulesSync.test.ts fails CI if it ever drifts from the RULES in
// the app's scanner. The git commands mirror src/main/commitScan.ts exactly, so the
// hook and the in-app gate return the same verdict on the same repo.
//
// TWO FAILURE AXES, AND THEY POINT OPPOSITE WAYS — get this right:
//   ERRORS FAIL OPEN.  Not a repo, git not on PATH, git exploded, diff over maxBuffer,
//                      unreadable settings, any thrown exception, a nonsense argv: exit
//                      0. Only a POSITIVE secret match may ever exit 1. A security net
//                      that wedges commits for reasons unrelated to secrets gets ripped
//                      out within a day, and then you have no net at all.
//   THE TOGGLE FAILS SECURE.  A missing or corrupt settings file, or an absent
//                      `commitShield` key, means ON (matches initAiSecurity's default-ON
//                      gates). Only an explicit `false` — the user reaching for the
//                      switch — opts out.
//
// CLI:  node termpolis-githook.cjs pre-commit    # scans the staged diff
//       node termpolis-githook.cjs pre-push      # scans every unpushed commit's patch
//       exit 1 = secret found, git aborts.  exit 0 = allow.

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const RULES = require('./secretRules.cjs')

const SETTINGS_FILE = 'ai-security-settings.json'
// 32 MB. A monorepo's staged diff can be enormous and ENOBUFS must not become a failed
// commit; past that size we fail open like any other error (see the doctrine above).
const MAX_BUFFER = 32 * 1024 * 1024
// Cap the per-hit list: a committed .env can carry hundreds of keys, and a wall of
// output buries the one line that tells the user what to do about it.
const MAX_LISTED_HITS = 8

// Mirrored EXACTLY from src/main/commitScan.ts — the hook and the in-app gate must scan
// the same bytes. `log -p --not --remotes` (not `@{u}..HEAD`) is deliberate: it handles
// brand-new branches and root commits, where a naive upstream range errors out.
const GIT_ARGS = {
  'pre-commit': ['diff', '--cached', '--no-color', '--no-ext-diff'],
  'pre-push': ['log', '-p', '--no-color', '--not', '--remotes'],
}

// Electron's app.getPath('userData') without Electron — SHARED so it can't drift from the app.
// This file used to hardcode capital-T "Termpolis"; the app calls app.setName('termpolis'), so on
// case-sensitive Linux the hook read a settings file that did not exist and Commit Shield could not
// be turned off. dataDir.cjs is the single source of truth (lowercase name, XDG on Linux).
const { termpolisDataDir: userDataDir } = require('./dataDir.cjs')

function settingsPath() {
  return path.join(userDataDir(), SETTINGS_FILE)
}

// Read the user's toggle without Electron. Anything other than an explicit `false`
// leaves the shield ON, so a truncated write or a hand-edited file cannot quietly
// disarm it. This is the fail-SECURE axis.
function readSettings(file) {
  const target = file || settingsPath()
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { commitShield: parsed.commitShield !== false }
    }
  } catch {
    // missing / unreadable / not JSON -> keep the shield on
  }
  return { commitShield: true }
}

// Never a shell. Hook argv is attacker-adjacent (branch and file names land in it), and
// a shell would turn a crafted name into command injection on `git commit`.
function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
    shell: false,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    // Swallow git's own stderr: on this path ours is the only voice the user should hear.
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

// Same shape the app shows: enough to recognise your own key, useless to anyone reading
// a CI log over your shoulder.
function redactSample(matched) {
  const s = matched == null ? '' : String(matched)
  return s.length <= 8 ? '****' : s.slice(0, 4) + '…' + s.slice(-2)
}

// Map every byte offset in the diff back to (file, new-file line number), so a block
// message can say `.env:12` instead of "somewhere in your commit". Best-effort by
// design: attribution failing must never suppress a hit.
function buildLineMap(text) {
  const map = []
  const lines = text.split('\n')
  let file = ''
  let newLine = 0
  let pos = 0
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.charCodeAt(raw.length - 1) === 13 ? raw.slice(0, -1) : raw // tolerate CRLF
    let attributed = 0
    if (line.indexOf('+++ ') === 0) {
      const p = headerPath(line.slice(4))
      if (p) file = p
    } else if (line.indexOf('diff --git ') === 0) {
      // Fallback for hunks that never emit a `+++` line (mode changes, binaries).
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
      if (m) file = m[2]
      newLine = 0
    } else if (line.indexOf('@@') === 0) {
      const m = /^@@+ -\d+(?:,\d+)? \+(\d+)/.exec(line)
      if (m) newLine = parseInt(m[1], 10)
    } else if (line.charCodeAt(0) === 43 /* + */) {
      attributed = newLine
      if (newLine > 0) newLine++
    } else if (line.charCodeAt(0) === 32 /* context */) {
      if (newLine > 0) newLine++
    }
    map.push({ start: pos, end: pos + raw.length, file: file, line: attributed })
    pos += raw.length + 1 // the '\n' split() consumed
  }
  return map
}

function headerPath(rest) {
  let s = rest.trim()
  const tab = s.indexOf('\t')
  if (tab >= 0) s = s.slice(0, tab)
  if (s.length > 1 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') s = s.slice(1, -1)
  if (s === '/dev/null' || !s) return ''
  if (s.indexOf('b/') === 0) s = s.slice(2)
  return s
}

function locate(map, index) {
  let lo = 0
  let hi = map.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const e = map[mid]
    if (index < e.start) hi = mid - 1
    else if (index > e.end) lo = mid + 1
    else return e
  }
  return null
}

// Scan the WHOLE diff text — added lines, context lines and all — because that is
// exactly what the app's gate scans (commitScan feeds the raw diff to scanText), and a
// hook that disagreed with the app about the same repo would be worse than either.
function scanDiffText(input) {
  const text = typeof input === 'string' ? input : ''
  if (!text) return { hitCount: 0, hits: [], scannedBytes: 0 }
  const map = buildLineMap(text)
  const hits = []
  for (let i = 0; i < RULES.length; i++) {
    const rule = RULES[i]
    // Clone per scan. The rule table's regexes are /g, and a /g regex carries lastIndex
    // between calls — a leaked lastIndex makes the NEXT scan start mid-string and skip a
    // real secret. Same reason the app's scanText rebuilds the regex.
    const re = new RegExp(rule.pattern.source, rule.pattern.flags)
    let m
    while ((m = re.exec(text)) !== null) {
      const at = locate(map, m.index)
      hits.push({
        rule: rule.id,
        label: rule.label,
        sample: redactSample(m[0]),
        file: at ? at.file : '',
        line: at ? at.line : 0,
      })
      if (m.index === re.lastIndex) re.lastIndex++ // zero-width guard: a hung hook is a wedged commit
      if (re.flags.indexOf('g') === -1) break
    }
  }
  return { hitCount: hits.length, hits: hits, scannedBytes: text.length }
}

// The whole message the user gets. It has to answer three questions fast: what did you
// find, where is it, and how do I get out of here.
function formatBlock(res, mode) {
  const op = mode === 'pre-push' ? 'push' : 'commit'
  const surface = op === 'push' ? 'unpushed patch' : 'staged diff'
  const noun = res.hitCount === 1 ? 'secret' : 'secrets'
  const labels = []
  for (let i = 0; i < res.hits.length; i++) {
    if (labels.indexOf(res.hits[i].label) === -1) labels.push(res.hits[i].label)
  }
  const out = []
  out.push('')
  out.push('  TERMPOLIS COMMIT SHIELD: ' + op.toUpperCase() + ' BLOCKED')
  out.push('')
  out.push('  ' + res.hitCount + ' ' + noun + ' detected in the ' + surface + '.')
  out.push('  Rules fired: ' + labels.join(', '))
  out.push('')
  const shown = res.hits.slice(0, MAX_LISTED_HITS)
  for (let i = 0; i < shown.length; i++) {
    const h = shown[i]
    const where = h.file ? (h.line > 0 ? h.file + ':' + h.line : h.file) : '(unattributed)'
    out.push('    ' + where + '  ' + h.sample + '  [' + h.label + ']')
  }
  if (res.hits.length > shown.length) {
    out.push('    ... and ' + (res.hits.length - shown.length) + ' more')
  }
  out.push('')
  out.push('  Remove the ' + noun + ' and rotate anything already exposed, then ' + op + ' again.')
  out.push('  Not a secret? `git ' + op + ' --no-verify` skips this hook. It is your machine.')
  out.push('  Turn the shield off for good: Termpolis > Settings > AI Security > Commit Shield.')
  out.push('')
  return out.join('\n')
}

function main(argv, deps) {
  const d = deps || {}
  const emit = typeof d.stderr === 'function' ? d.stderr : (s) => { process.stderr.write(s) }
  try {
    const mode = argv && typeof argv[0] === 'string' ? argv[0] : ''
    // hasOwnProperty, not a bare lookup: `__proto__` / `constructor` must not resolve.
    if (!Object.prototype.hasOwnProperty.call(GIT_ARGS, mode)) return 0

    const settings = (typeof d.readSettings === 'function' ? d.readSettings : readSettings)() || {}
    if (settings.commitShield === false) return 0

    const git = typeof d.git === 'function' ? d.git : (args) => runGit(args, d.cwd)
    const raw = git(GIT_ARGS[mode])
    const res = scanDiffText(typeof raw === 'string' ? raw : String(raw || ''))
    if (res.hitCount === 0) return 0

    emit(formatBlock(res, mode) + '\n')
    return 1
  } catch {
    return 0 // FAIL OPEN. Only a positive match above may ever reach exit 1.
  }
}

module.exports = {
  main,
  scanDiffText,
  buildLineMap,
  readSettings,
  userDataDir,
  settingsPath,
  runGit,
  formatBlock,
  redactSample,
  GIT_ARGS,
  RULES,
}

if (require.main === module) {
  // process.exitCode, never process.exit(): exit() can truncate a pending stderr write
  // on a pipe, and a half-printed block message is a support ticket.
  process.exitCode = main(process.argv.slice(2))
}
