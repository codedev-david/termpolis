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
    // Of the env block, which can hold keys of the user's own, only the window variable's value.
    expect(privacySection).toContain('the value of the window variable in the `env` block (no other entry of that block')
    expect(privacySection).toContain('`autoCompactWindow`')
    expect(privacySection).toContain('`/autocompact`')
    expect(privacySection).toContain('permissions, hooks, helpers')
    expect(privacySection).toContain('not kept, not logged and not sent anywhere')
    expect(docsSection).toContain('Of the `env` block only the window variable\'s value is kept, nothing else in those files is kept, nothing is written')
  })

  it('says it writes nothing to those files, and sends nothing anywhere', () => {
    expect(privacySection).toContain('writes nothing to them')
    expect(privacySection).toContain('Nothing about it is sent to Termpolis or to anyone else')
  })

  it('says when it reads: only while the choice is on, and only when it opens a terminal it sets the variable for', () => {
    expect(privacySection).toContain('only while this choice is on and only when it opens a terminal it sets the variable for')
    expect(privacySection).toContain('Nothing is read while it is Off')
    expect(docsSection).toContain('while this is on and when it opens a Claude terminal')
  })

  it('says what a file it cannot read means: tried once more, and then counted as a window it cannot see', () => {
    expect(privacySection).toContain('A file that is not there, or is not valid JSON, counts as holding nothing, as it does for Claude Code')
    expect(privacySection).toContain('is tried once more; if it still cannot be read Termpolis sets none, since it cannot tell')
    expect(docsSection).toContain('a file that is missing or is not valid JSON counts as not set (as it does for Claude Code)')
    expect(docsSection).toContain('is tried once more and, if it still cannot be read, counts as set, because Termpolis cannot tell')
  })

  it('says which terminals get it: those opened for Claude Code and every terminal the MCP create_terminal tool makes, new ones only, never your other shells', () => {
    // The command is not known when a swarm worker, an agent-made terminal or the phone's shell is created, so
    // every one of them has the variable in its environment. Saying Codex "does not get it" would be false of
    // a worker; what is true is that Codex and Gemini CLI never read it.
    for (const text of [privacySection, docsSection]) {
      expect(text).toContain('swarm')
      expect(text).toContain('`create_terminal`')
      expect(text).toContain('paired phone')
      expect(text).toContain('Codex and Gemini CLI never read it')
      expect(text).toContain('the other shells you open yourself')
      expect(text).not.toContain('every worker gets it')
      expect(text).not.toMatch(/not (to )?Codex/i)
    }
    expect(privacySection).toContain('not to a terminal that is already open')
    expect(docsSection).toContain('**new** terminals only')
  })

  it('names the places a window can live that Termpolis cannot see and the variable still beats', () => {
    for (const text of [privacySection, docsSection]) {
      expect(text).toContain('a subagent\'s definition')
      expect(text).toContain('`--settings` argument')
      expect(text).toContain('organization\'s managed settings')
    }
    expect(docsSection).toContain('**Places it cannot see.**')
    expect(privacySection).toContain('names a folder Termpolis did not check')
  })

  it('lists the limits of what it can check, one of them the config folder a script picks inside the terminal', () => {
    expect(docsSection).toContain('**Four limits.**')
    expect(docsSection).toContain('the repository\'s root, which is not read')
    expect(docsSection).toContain('a `CLAUDE_CONFIG_DIR` that a script sets inside the terminal (to switch accounts, say) names a folder that is not the one checked')
    expect(docsSection).toContain('A `--autocompact` flag typed on a command line cannot be seen')
    expect(docsSection).toContain('a plain shell terminal in which you type `claude` by hand')
  })

  it('says what it cannot see and what it does not change: a flag on a command line, and the meters', () => {
    expect(docsSection).toContain('A `--autocompact` flag typed on a command line cannot be seen when the terminal opens')
    expect(docsSection).toContain('Claude Code lets the variable win over the flag')
    expect(docsSection).toContain('turn the window Off first')
    expect(docsSection).toContain('Context meters, in Claude Code\'s status line and in Termpolis, keep measuring against the model\'s full window')
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

/**
 * The first-sight policy and the comparison behind it are disclosed too: v1.55 changed what the proxy does by
 * default and keeps a local record of it, which the privacy policy and the guide must say, and say with the
 * numbers the code uses.
 */
describe('the first-sight policy, the holdout and what is kept about them are disclosed', () => {
  const privacyProxy = flat(section(privacy, '### The Claude Code compression proxy'))
  const privacyStored = flat(section(privacy, '## Data Stored Locally'))
  const docsProxy = flat(section(docs, '### Token Savings — the Claude Code compression proxy'))

  it('says Late is the default, from how many characters, that Legacy is v1.54, and that a change applies at the next start', () => {
    for (const text of [privacyProxy, docsProxy]) {
      expect(text).toContain('40,000 characters')
      expect(text).toContain('Shorten tool results')
      expect(text).toContain('Late')
      expect(text).toContain('Legacy')
      expect(text).toContain('the next time Termpolis starts')
    }
    expect(privacyProxy).toContain('as v1.54 did')
    expect(docsProxy).toContain('as v1.54 did')
  })

  it('says about one distinct opening message in ten always runs Legacy, chosen on the machine, and that nothing about it is sent', () => {
    expect(privacyProxy).toContain('About one distinct opening message in ten')
    expect(privacyProxy).toContain('chosen by a hash of the conversation\'s first message, computed on your machine')
    expect(privacyProxy).toContain('always runs the Legacy behaviour whichever setting is on')
    expect(privacyProxy).toContain('nothing about it is sent anywhere')
    expect(docsProxy).toContain('About one *distinct opening message* in ten')
    expect(docsProxy).toContain('always lands in the same group')
  })

  it('names what is kept beside each original and the two local files, and that it is counts, sizes and names only', () => {
    expect(privacyStored).toContain('the name of the tool whose result it was, the model\'s name, the two sizes')
    expect(privacyStored).toContain('which first-sight setting the request ran under')
    expect(privacyStored).toContain('`userData/headroom/elision-ledger.json`')
    expect(privacyStored).toContain('`userData/headroom/proxy-totals.json`')
    expect(privacyStored).toContain('Counts, sizes and names only, never the content of a conversation')
    expect(docsProxy).toContain('`headroom/elision-ledger.json`')
    expect(docsProxy).toContain('`headroom/proxy-totals.json`')
    expect(docsProxy).toContain('Counts, sizes and names only')
  })

  it('describes the Elision health card and the headline as the code computes them', () => {
    expect(docsProxy).toContain('**Elision health.**')
    expect(docsProxy).toContain('billed units avoided, net of the turns that fetched elided text and of text asked back')
    expect(docsProxy).toContain('Retrieval turns are counted from v1.55 on')
    expect(docsProxy).toContain('including the turn that first had to load `retrieve_full` through ToolSearch')
  })

  it('holds the numbers the documents quote to the numbers the code uses', async () => {
    const { LATE_FLOOR_CHARS, ELISION_HOLDOUT_RATE } = await import('../../src/main/headroom/elisionPolicy')
    expect(LATE_FLOOR_CHARS.toLocaleString('en-US')).toBe('40,000')
    expect(ELISION_HOLDOUT_RATE).toBe(0.1) // "one in ten"
  })
})
