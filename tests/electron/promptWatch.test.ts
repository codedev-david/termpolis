// WATCH, BUT DO NOT TOUCH — the two guarantees, pinned.
//
// 1. THE TEXT IS NEVER TOUCHED. Every byte the user types is forwarded to the PTY
//    immediately and unmodified. The old design withheld keystrokes so it could redact
//    before the PTY, and the handler then never wrote them back — typing "hello<CR>"
//    delivered only "\r". Your text was silently eaten. That must never be possible again.
//
// 2. THE SECRET VALUE NEVER REACHES THE LOG. An audit log full of secret fragments is just
//    a second place the secret leaked to. We record the NAME (DB_PASSWORD) and the rule id,
//    which is what tells you what to rotate — never the value, and not even a slice of it.
//
// Secret samples use repeated characters: they satisfy the rule regexes while failing entropy
// heuristics, so GitHub push protection will not block this file.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { processOutboundChunk, scanText, RULES } from '../../src/main/aiSecurity'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

const AI = { isAiTerminal: true }

/** Exactly how src/main/index.ts builds the audit note for a `prompt_secret_sent` event. */
function auditNoteFor(text: string): string {
  const r = scanText(text)
  return [...new Set(r.hits.map((h) => (h.name ? `${h.name} (${h.rule})` : h.rule)))].join(', ')
}

/** Replay the terminal:write handler: it always ends in writeToTerminal(id, data). */
function ptyReceives(keys: string[]): string {
  let staging = ''
  let pty = ''
  for (const data of keys) {
    const d = processOutboundChunk(staging, data, AI)
    staging = d.newStaging
    pty += d.writeChunk // the handler writes `data` unconditionally
  }
  return pty
}

describe('watch but do not touch — the text is never modified or withheld', () => {
  it('typing "hello" then Enter delivers "hello\\r" to the PTY (this used to deliver just "\\r")', () => {
    expect(ptyReceives(['h', 'e', 'l', 'l', 'o', '\r'])).toBe('hello\r')
  })

  it('writeChunk is ALWAYS exactly the data — even when a secret is found', () => {
    const secret = `AWS_SECRET_KEY=${'A'.repeat(24)}\r`
    const d = processOutboundChunk('', secret, AI)
    expect(d.action).toBe('observed') // we saw it…
    expect(d.writeChunk).toBe(secret) // …and forwarded it byte-for-byte anyway
  })

  it('a secret pasted mid-session is still delivered verbatim', () => {
    const paste = `{"apiKey": "${'b'.repeat(20)}"}`
    const d = processOutboundChunk('', paste, AI)
    expect(d.isPaste).toBe(true)
    expect(d.action).toBe('observed')
    expect(d.writeChunk).toBe(paste)
  })

  it('never withholds: no decision may return an empty writeChunk for non-empty data', () => {
    for (const data of ['a', 'x'.repeat(64), 'q\r', `TOKEN=${'z'.repeat(20)}\n`]) {
      expect(processOutboundChunk('', data, AI).writeChunk).toBe(data)
    }
  })

  it('does not scan mid-typing — only on submit or paste', () => {
    const d = processOutboundChunk('', 'h', AI)
    expect(d.action).toBe('pass')
    expect(d.scan).toBeUndefined() // no scan cost per keystroke
    expect(d.writeChunk).toBe('h')
  })

  it('a non-AI terminal is passed through untouched and unscanned', () => {
    const d = processOutboundChunk('', `AWS_SECRET_KEY=${'A'.repeat(24)}\r`, { isAiTerminal: false })
    expect(d.action).toBe('pass')
    expect(d.scan).toBeUndefined()
  })
})

describe('the audit note names the secret — and never contains its value', () => {
  const cases: [string, string, string, string][] = [
    // [what the user sent, the VALUE that must never leak, expected NAME, rule]
    ['DB_PASSWORD=' + 'h'.repeat(14), 'h'.repeat(14), 'DB_PASSWORD', 'env_secret'],
    ['{"apiKey": "' + 'k'.repeat(20) + '"}', 'k'.repeat(20), 'apiKey', 'json_secret'],
    ['const password = "' + 'p'.repeat(12) + '"', 'p'.repeat(12), 'password', 'password_literal'],
    ['Password=' + 'c'.repeat(12) + ';Server=db', 'c'.repeat(12), 'Password', 'conn_string_password'],
  ]

  it.each(cases)('%s -> logs the NAME, never the value', (text, value, name, rule) => {
    const note = auditNoteFor(text)
    expect(note).toContain(name) // actionable: you know what to rotate
    expect(note).toContain(rule)
    expect(note).not.toContain(value) // THE INVARIANT: the value never reaches disk
  })

  it('does not leak even a FRAGMENT of the value (no hit.sample in the note)', () => {
    // `hit.sample` is `first4…last2` of the whole match — and for a named rule the match spans
    // the entire assignment, so its tail characters come out of the secret itself. The note
    // must never be built from it.
    const value = 'q'.repeat(16)
    const note = auditNoteFor(`API_TOKEN=${value}`)
    expect(note).not.toContain(value.slice(-2))
    expect(note).not.toContain('…')
    expect(note).toBe('API_TOKEN (env_secret)')
  })

  it('credentials embedded in a URL are named by their user, not their password', () => {
    const note = auditNoteFor(`git clone https://deploybot:${'s'.repeat(12)}@github.com/x/y.git`)
    expect(note).toContain('deploybot')
    expect(note).toContain('basic_auth_url')
    expect(note).not.toContain('s'.repeat(12))
  })

  it('a clean prompt produces no note at all', () => {
    expect(scanText('please refactor the auth middleware').hitCount).toBe(0)
  })
})

describe('what the user actually asked to catch', () => {
  it('a password in an appsettings.json pasted into the prompt', () => {
    const r = scanText(`{"ConnectionStrings": {"Default": "x"}, "AdminPassword": "${'z'.repeat(14)}"}`)
    expect(r.hitCount).toBeGreaterThan(0)
    expect(r.hits.some((h) => h.name === 'AdminPassword')).toBe(true)
  })

  it('a .env file pasted into the prompt names every variable that leaked', () => {
    const r = scanText(
      `STRIPE_SECRET_KEY=${'a'.repeat(20)}\nDB_PASSWORD=${'b'.repeat(14)}\nDEBUG=true\n`,
    )
    const names = r.hits.map((h) => h.name)
    expect(names).toContain('STRIPE_SECRET_KEY')
    expect(names).toContain('DB_PASSWORD')
    expect(names).not.toContain('DEBUG') // not a secret — do not cry wolf
  })

  it('an API key injected directly into the prompt is caught even with no name', () => {
    const r = scanText(`use this key: AKIA${'A'.repeat(16)} to list the buckets`)
    expect(r.hits.some((h) => h.rule === 'aws_access_key')).toBe(true)
  })
})

// Guarantee 2 above is enforced through `auditNoteFor`, which MIRRORS how src/main/index.ts builds
// the note. A mirror is only as good as its fidelity: someone could change index.ts to log
// `h.sample` and every test in this file would still pass, because none of them read index.ts.
//
// `hit.sample` is the dangerous field. For the named rules the match spans the whole assignment
// (`DB_PASSWORD=hunter2xyz`), so the sample's tail characters come out of the secret itself. It
// exists for the manual scanner, where the user is looking at text they pasted themselves. It must
// never reach a log file or cross the process boundary. So this reads the actual source.
describe('source guard: no secret value can reach the audit log or the renderer', () => {
  const mainSrc = readFileSync(resolve(__dirname, '../../src/main/index.ts'), 'utf8')

  /** Text of every aiSecurityAppend({...}) call in main, with parens balanced. */
  function appendCalls(): string[] {
    const out: string[] = []
    const marker = 'aiSecurityAppend('
    let i = mainSrc.indexOf(marker)
    while (i !== -1) {
      let depth = 0
      let j = i + marker.length - 1
      for (; j < mainSrc.length; j++) {
        if (mainSrc[j] === '(') depth++
        else if (mainSrc[j] === ')') {
          depth--
          if (depth === 0) break
        }
      }
      out.push(mainSrc.slice(i, j + 1))
      i = mainSrc.indexOf(marker, j)
    }
    return out
  }

  it('extracted the append call sites (the guard is actually guarding something)', () => {
    expect(appendCalls().length).toBeGreaterThan(5)
  })

  /** Strip `//` comments. The call sites are *documented* as never logging `hit.sample`, so a
   *  naive scan matches the prose that promises the thing and reports the promise as the crime. */
  const codeOnly = (s: string) => s.replace(/\/\/[^\n]*/g, '')

  it('no audit-log write references hit.sample', () => {
    const offenders = appendCalls()
      .filter((c) => /\.sample\b/.test(codeOnly(c)))
      .map((c) => c.slice(0, 120))
    expect(offenders).toEqual([])
  })

  it('...and that check is not vacuous — it catches a sample smuggled into a note', () => {
    // Guards that cannot fail are decoration. Prove this one bites, using the exact mutation a
    // future maintainer would make: reach for the sample because it is right there on the hit.
    const mutated = `aiSecurityAppend({ event: 'prompt_secret_sent', notes: r.hits.map((h) => h.sample).join(',') })`
    expect(/\.sample\b/.test(codeOnly(mutated))).toBe(true)
    // ...and that stripping comments does not make it blind to real code on the same line.
    expect(/\.sample\b/.test(codeOnly(`notes: h.sample, // never log the value`))).toBe(true)
  })

  it('the secret-observed IPC strips sample before it crosses into the renderer', () => {
    // A live credential in the renderer is a credential in a devtools console and in a heap
    // snapshot. main must project the hits down to rule/label/name before sending.
    const send = mainSrc.match(/webContents\.send\(\s*'terminal:secret-observed'[\s\S]{0,400}?\n\s*\}\)/)
    expect(send).not.toBeNull()
    expect(send![0]).not.toMatch(/hits:\s*r\.hits\s*,/) // the raw pass-through that used to be here
    expect(send![0]).toMatch(/\.map\(/)
    expect(send![0]).not.toMatch(/sample/)
  })
})

// A rule count typed into copy is a fact with no owner. It goes stale the moment someone adds a
// rule, and NOTHING fails — which is exactly what happened: the Settings UI shipped "91-rule
// engine", the README said "~70-rule", and the table held 97. Three numbers, none of them right,
// in security copy people are meant to trust. So the number is derived at runtime, and these
// guards make a hardcoded one fail loudly.
describe('the secret-rule count is derived, never written down', () => {
  const RULE_COUNT = RULES.length
  const read = (rel: string) => readFileSync(resolve(__dirname, '../../', rel), 'utf8')

  it('main ships the live count over aiSecurity:get-status', () => {
    const src = read('src/main/index.ts')
    expect(src).toMatch(/ruleCount:\s*SECRET_RULES\.length/)
  })

  it('the Settings UI renders the live count, not a literal', () => {
    const ui = read('src/renderer/src/components/SettingsPane/SecuritySettings.tsx')
    // A bare "91-rule"/"70-rule" literal in the JSX is the bug. `{ruleCount ?? 97}` is fine.
    const literals = ui.match(/(?<!\{ruleCount \?\? )\d{2,3}-rule/g) ?? []
    expect(literals).toEqual([])
    expect(ui).toMatch(/\{ruleCount \?\? \d+\}-rule/)
  })

  it('the README cites the real secret-rule count, and no stale one', () => {
    // Careful: the README ALSO cites Safe Import's 41-rule scanner — a DIFFERENT table with its
    // own count. A guard asserting "every number here equals 97" would happily "correct" the 41s
    // and be confidently wrong. Pin the secret engine's number; name the stale ones directly.
    const md = read('README.md')
    expect(md).toContain(`${RULE_COUNT}-rule`)
    for (const stale of ['~70-rule', '91-rule', '70+ rule']) expect(md).not.toContain(stale)
  })
})
