// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, relative, sep } from 'path'
import { claudeWindowSettingsFiles } from '../../src/main/headroom/shapingEnvReader'
import { CONTEXT_CAP_CHOICES, CONTEXT_CAP_MIN, CONTEXT_CAP_MAX } from '../../src/main/headroom/shapingEnv'

/**
 * The read of Claude Code's settings that the opt-in context window needs is disclosed in PRIVACY.md and
 * docs/DOCUMENTATION.md, under the consent model of v1.49: what is read, when, what is kept, and that the
 * choice is off until made. This keeps the two documents true to the reader: a file added to the reader
 * without a line in both fails here.
 */

const ROOT = join(__dirname, '..', '..')
const privacy = readFileSync(join(ROOT, 'PRIVACY.md'), 'utf8')
const docs = readFileSync(join(ROOT, 'docs', 'DOCUMENTATION.md'), 'utf8')

/** The text of one subsection: from its heading to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const level = heading.match(/^#+/)![0].length
  const start = text.indexOf(heading)
  expect(start, `heading "${heading}" is missing`).toBeGreaterThan(-1)
  const rest = text.slice(start + heading.length)
  const next = rest.search(new RegExp(`\\n#{1,${level}} `))
  return heading + (next === -1 ? rest : rest.slice(0, next))
}

/** A line wrap in the Markdown is not part of what is asserted. */
const flat = (s: string): string => s.replace(/\s+/g, ' ')
const privacySection = flat(section(privacy, '### A smaller Claude Code context window (opt-in)'))
const docsSection = flat(section(docs, '### Long conversations — a smaller Claude Code context window (opt-in)'))

// The three files the reader reads, as a person would name them.
const USER_DIR = join(ROOT, '__user__')
const PROJECT = join(ROOT, '__project__')
const FILES = claudeWindowSettingsFiles(USER_DIR, PROJECT).map((f) => {
  const rel = relative(f.startsWith(USER_DIR) ? USER_DIR : PROJECT, f).split(sep).join('/')
  return rel
})

describe('the context window is disclosed, and the disclosure matches what is read', () => {
  it('reads exactly three files, and they are the ones the documents name', () => {
    expect(FILES).toEqual(['settings.json', '.claude/settings.json', '.claude/settings.local.json'])
    for (const [name, text] of [['PRIVACY.md', privacySection], ['DOCUMENTATION.md', docsSection]] as const) {
      for (const file of FILES) expect(text, `${name} does not name ${file}`).toContain(`\`${file}\``)
    }
  })

  it('says where the user file lives, including when CLAUDE_CONFIG_DIR moves it', () => {
    for (const text of [privacySection, docsSection]) {
      expect(text).toContain('~/.claude')
      expect(text).toContain('CLAUDE_CONFIG_DIR')
    }
  })

  it('says what is kept, and that the rest of the files is not', () => {
    expect(privacySection).toContain('keeps two things and drops the rest on the spot')
    expect(privacySection).toContain('the `env` block')
    expect(privacySection).toContain('`autoCompactWindow`')
    expect(privacySection).toContain('`/autocompact`')
    expect(privacySection).toContain('permissions, hooks, helpers')
    expect(privacySection).toContain('not kept, not logged and not sent anywhere')
    expect(docsSection).toContain('Nothing else in them is kept, nothing is written')
  })

  it('says it writes nothing to those files, and sends nothing anywhere', () => {
    expect(privacySection).toContain('writes nothing to them')
    expect(privacySection).toContain('Nothing about it is sent to Termpolis or to anyone else')
  })

  it('says when it reads: only while the choice is on, and only when a Claude terminal opens', () => {
    expect(privacySection).toContain('only while this choice is on and only when it opens a Claude terminal')
    expect(privacySection).toContain('Nothing is read while it is Off')
    expect(docsSection).toContain('while this is on and when it opens a Claude terminal')
  })

  it('says which terminals get it: Claude Code ones that are new, not Codex, Gemini or a shell', () => {
    for (const text of [privacySection, docsSection]) {
      expect(text).toMatch(/not (to )?Codex/i)
      expect(text).toContain('Gemini CLI')
      expect(text).toContain('own shells')
    }
    expect(privacySection).toContain('not to a terminal that is already open')
    expect(docsSection).toContain('**new** terminals only')
  })

  it('says it is off by default, and what never gets overridden', () => {
    expect(privacySection).toContain('Off by default')
    expect(docsSection).toContain('**off by default**')
    expect(docsSection).toContain('What it never overrides')
    expect(docsSection).toContain('`/autocompact`')
    expect(privacySection).toContain('If a window is already set in any of those places, Termpolis sets none')
  })

  it('names the variable it sets, and the windows Settings offers', () => {
    for (const text of [privacySection, docsSection]) expect(text).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW')
    const offered = CONTEXT_CAP_CHOICES.filter((c) => c > 0).map((c) => c.toLocaleString('en-US'))
    for (const n of offered) {
      expect(privacySection, n).toContain(n)
      expect(docsSection, n).toContain(n)
    }
  })

  it('says the figures are modeled, and that Termpolis cannot measure the effect on answers', () => {
    expect(docsSection).toContain('modeled, not measured')
    expect(docsSection).toContain('a model, not a promise')
    expect(docsSection).toContain('cannot measure what that does to the quality of answers on your work')
  })

  it('states Anthropic\'s documented range and that Claude Code caps the window at the model\'s own', () => {
    expect(CONTEXT_CAP_MIN.toLocaleString('en-US')).toBe('100,000')
    expect(CONTEXT_CAP_MAX.toLocaleString('en-US')).toBe('1,000,000')
    expect(docsSection).toContain('100,000 to 1,000,000 tokens')
    expect(docsSection).toContain('never uses a window larger than the model\'s own')
  })

  it('is in the summary of the privacy policy, with a link to the section, and the policy\'s date moved', () => {
    expect(privacy).toContain('(#a-smaller-claude-code-context-window-opt-in)')
    expect(privacy).toMatch(/Last updated: November 1, 2026 \(an optional smaller context window for Claude Code/)
  })

  it('sits under the settings it is about, in both documents', () => {
    expect(privacy.indexOf('### A smaller Claude Code context window (opt-in)')).toBeGreaterThan(privacy.indexOf("## Your coding agents' settings"))
    expect(privacy.indexOf('### A smaller Claude Code context window (opt-in)')).toBeLessThan(privacy.indexOf('## Your Choices'))
    expect(docs.indexOf('### Long conversations')).toBeGreaterThan(docs.indexOf('### Token Savings — the Claude Code compression proxy'))
    expect(docs.indexOf('### Long conversations')).toBeLessThan(docs.indexOf('### Processes (stuck-process cleanup)'))
  })

  it('does not call the choice a compression setting or promise a saving', () => {
    for (const text of [privacySection, docsSection]) {
      expect(text).not.toMatch(/guarantee|will save|saves you|you will save/i)
    }
  })
})
