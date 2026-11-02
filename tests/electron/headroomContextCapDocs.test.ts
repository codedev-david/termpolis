// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, relative, sep } from 'path'
import { claudeWindowSettingsFiles } from '../../src/main/headroom/shapingEnvReader'
import { CONTEXT_CAP_CHOICES, CONTEXT_CAP_MIN, CONTEXT_CAP_MAX } from '../../src/main/headroom/shapingEnv'
import { MIN_ARM_REQUESTS, MIN_ARM_GROUPS } from '../../src/main/headroom/armCompare'

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

  it('says a smaller window and Late overlap, so the two savings are not added', () => {
    expect(docsSection).toContain('Late and a smaller window overlap, so together they save less than the two figures added')
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
    // The date is read, not matched: it only ever moves forward, and it has moved off v1.54.4's October 14.
    const m = /Last updated: (\w+) (\d{1,2}), (\d{4}) \(an optional smaller context window for Claude Code/.exec(privacy)
    expect(m).not.toBeNull()
    expect(new Date(`${(m as RegExpExecArray)[1]} ${(m as RegExpExecArray)[2]}, ${(m as RegExpExecArray)[3]} 12:00 UTC`).getTime()).toBeGreaterThanOrEqual(Date.UTC(2026, 10, 1))
  })

  // The dated line is the summary of what changed in the policy, and each thing v1.55 changed is in it.
  it('names in the dated line each of the things the policy now says that v1.54.4 did not', () => {
    const line = (privacy.split('\n').find((l) => l.startsWith('Last updated:')) as string)
    expect(line).toContain('an optional smaller context window for Claude Code reads the env and window keys of your Claude Code settings when a Claude terminal opens')
    expect(line).toContain('the Claude Code compression proxy now shortens a tool result only from 40,000 characters by default and keeps a local comparison of that against the old behavior')
    expect(line).toContain('what it reads of each answer is described')
    expect(line).toContain("the Activity Feed's local event log is described")
    expect(line).toContain('Linked machines keeps a job history')
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
    expect(privacyProxy).toContain('always runs the Legacy behavior whichever setting is on')
    expect(privacyProxy).toContain('nothing about it is sent anywhere')
    expect(docsProxy).toContain('About one *distinct opening message* in ten')
    expect(docsProxy).toContain('always lands in the same group')
  })

  // The assignment follows the conversation's FIRST message, not the conversation: "kept for its whole length" was
  // wrong for a conversation whose start is rewritten (a compaction summarizes it). The same sentence in every place.
  it('says the group is kept for as long as the first message stays the same, and that a compacted conversation can be assigned again, everywhere it is described', () => {
    const readmeText = flat(readFileSync(join(ROOT, 'README.md'), 'utf8'))
    const card = flat(readFileSync(join(ROOT, 'src', 'renderer', 'src', 'components', 'SettingsPane', 'ElisionHealthCard.tsx'), 'utf8'))
    for (const [name, text] of [['PRIVACY.md', privacyProxy], ['the guide', docsProxy], ['README.md', readmeText], ['the card', card]] as const) {
      expect(text, name).toContain('kept for as long as ')
      expect(text, name).toContain('stays the same')
      expect(text.toLowerCase(), name).toContain('a compaction summarizes the start of a conversation')
      expect(text, name).toContain('a compacted one can be assigned again')
      expect(text, name).not.toContain('whole length')
    }
  })

  it('names what is kept beside each original and the two local files, and that it is counts, sizes and names only', () => {
    // How it was shortened is stored too (ElisionMeta.kind): the closed vocabulary compact, dedup, diff and decay.
    expect(privacyStored).toContain('the name of the tool whose result it was, the model\'s name, how it was shortened (a window of it, a reference to a repeat, a patch against a near-repeat, or aged out of a long conversation), the two sizes')
    expect(privacyStored).toContain('which first-sight setting the request ran under')
    expect(privacyStored).toContain('`userData/headroom/elision-ledger.json`')
    expect(privacyStored).toContain('`userData/headroom/proxy-totals.json`')
    expect(privacyStored).toContain('Counts, sizes and names only, never the content of a conversation')
    expect(docsProxy).toContain('the tool\'s name, the model\'s name, how it was shortened (a window of it, a reference to a repeat, a patch against a near-repeat, or aged out of a long conversation), the two sizes')
    expect(docsProxy).toContain('`headroom/elision-ledger.json`')
    expect(docsProxy).toContain('`headroom/proxy-totals.json`')
    expect(docsProxy).toContain('Counts, sizes and names only')
  })

  // The proxy has read the answer as it streams back since v1.29 (Anthropic's token counts), and since v1.55 it also
  // reads the names of the tools the model called, to charge the turns that only fetched shortened text. The consent
  // document says so in the same words as the guide, says it keeps counts only, and that the answer is forwarded as it came.
  it('says the proxy also reads the answer as it streams back, what for, that it keeps counts only, and forwards it unchanged', () => {
    for (const [name, text] of [['PRIVACY.md', privacyProxy], ['the guide', docsProxy]] as const) {
      expect(text, name).toContain('- **What it reads of the answer.** The proxy also reads each answer as it streams back')
      expect(text, name).toContain('for Anthropic\'s token counts and the names of the tools the model called')
      expect(text, name).toContain('the turns that only fetched shortened text')
      expect(text, name).toContain('the ToolSearch calls that led to them')
      expect(text, name).toContain('It keeps counts only, and forwards the answer to Claude Code unchanged')
    }
  })

  // The Activity Feed's event log is built from the transcripts of the agents a person runs and holds a compaction
  // event; v1.55 adds the size at which Claude Code compacted and whether it chose to. Local only, described once.
  it('names the Activity Feed event log, what a compaction event holds in it, and that it never leaves the machine', () => {
    expect(privacyStored).toContain('`userData/agent-events.jsonl`')
    expect(privacyStored).toContain('`agent-events.jsonl.old` once it passes 5 MB')
    expect(privacyStored).toContain('the transcripts that Claude Code, Codex and Gemini CLI write')
    expect(privacyStored).toContain('A compaction event also holds the size of the conversation when Claude Code compacted and whether it chose to')
    expect(privacyStored).toContain('It stays on your machine and is not sent anywhere')
  })

  // The list says what the watchers publish and nothing they do not: a tool RESULT is an id and an error flag
  // (never its content), and no watcher publishes an error or a status-change event (the kinds are declared in
  // agentEventBus.ts but nothing emits them). The file path and the rotation size are the code's own.
  it('lists only what the transcript watchers publish: tool calls with their input, message openings, a tool result\'s error flag, token counts and compactions', () => {
    expect(privacyStored).toContain('It holds the name and input of each tool call, the first 200 characters of each message, whether a tool result was an error (not the result itself), token counts and compactions')
    expect(privacyStored).not.toContain('status changes')
    const bus = readFileSync(join(ROOT, 'src', 'main', 'agentEventBus.ts'), 'utf8')
    expect(bus).toContain("path.join(resolved, 'agent-events.jsonl')")
    expect(bus).toContain("const backup = logPath + '.old'")
    expect(bus).toContain('const MAX_LOG_SIZE = 5 * 1024 * 1024')
    const watcher = readFileSync(join(ROOT, 'src', 'main', 'transcriptWatchers', 'claudeCodeWatcher.ts'), 'utf8')
    expect(watcher).toContain('payload: { toolUseId, isError }')
    expect(watcher).toContain('text.slice(0, 200)')
    for (const kind of ['status_change', 'mcp_audit']) {
      for (const w of ['claudeCodeWatcher.ts', 'codexWatcher.ts', 'geminiWatcher.ts']) {
        expect(readFileSync(join(ROOT, 'src', 'main', 'transcriptWatchers', w), 'utf8'), `${w} ${kind}`).not.toContain(`'${kind}'`)
      }
    }
  })

  it('describes the Elision health card and the headline as the code computes them', () => {
    expect(docsProxy).toContain('The first start after upgrading to v1.55 rebuilds the prompt cache once for a conversation you resume')
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

/**
 * What the README and the guide say about the smaller window, held to what the pane offers and what the code
 * does: the modeled ranges are read out of the pane's own option labels, so a figure changed in one place and
 * not the others fails here, and the sentences the choice rests on (it never overrides a window you set, it is
 * off until chosen, it can be turned off) cannot be reworded away unnoticed.
 */
describe('the smaller window: the README, the guide and the pane say the same thing', () => {
  const readme = flat(readFileSync(join(ROOT, 'README.md'), 'utf8'))
  const paneSource = readFileSync(join(ROOT, 'src', 'renderer', 'src', 'components', 'SettingsPane', 'TokenSavingsSettings.tsx'), 'utf8')
  // The note is JSX, wrapped across lines in the source; a wrap is not part of what is asserted.
  const pane = flat(paneSource)

  /** The range each option's label quotes, by window: "modeled saving about 16 to 21%" -> "16 to 21%". */
  const ranges = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const m of paneSource.matchAll(/value: (\d{6,7}), label: '[\d,]+ tokens — (?:modeled|estimated) saving about (\d+ to \d+%)/g)) out[m[1]] = m[2]
    return out
  }

  it('reads the four ranges out of the pane\'s labels', () => {
    expect(ranges()).toEqual({ '500000': '5 to 7%', '400000': '10 to 13%', '300000': '16 to 21%', '200000': '20 to 29%' })
  })

  it('has the README and the guide quote the three modeled ranges, and the guide the estimated one', () => {
    const r = ranges()
    expect(readme).toContain(`about ${r['400000']} of the bill at 400,000, ${r['300000']} at 300,000, ${r['200000']} at 200,000`)
    expect(docsSection).toContain(`about ${r['400000']} of the bill at 400,000, ${r['300000']} at 300,000 and ${r['200000']} at 200,000`)
    expect(docsSection).toContain(`The 500,000 figure (about ${r['500000']}) is estimated between two modeled windows`)
  })

  it('says the same things about a window the model cannot reach and about what each compaction loses', () => {
    expect(docsSection).toContain('15,000 to 80,000 tokens lost to each compaction')
    expect(pane).toContain('15,000 to 80,000 tokens lost to each one')
    expect(readme).toContain('it is zero on a model whose own window is already that size')
  })

  it('says in the README that it is off by default, opt-in, new terminals only, and never overrides a window the user can be seen to have set', () => {
    expect(readme).toContain('opt-in, off by default')
    expect(readme).toContain('(new ones only, with or without the proxy)')
    expect(readme).toContain('leaves alone a window it can see you set (in the environment, in the `env` block of your Claude Code settings, or with `/autocompact`)')
    expect(readme).toContain('lists where it does not look')
    expect(readme).not.toContain('never overrides a window you set yourself')
    expect(readme).toContain('cannot see what it does to the quality of an answer')
  })

  it('says in PRIVACY.md that it can be turned off, and where', () => {
    expect(privacySection).toContain('It is yours to turn off: choose Off, and new terminals go back to Claude Code\'s own behavior')
    expect(flat(privacy)).toContain('**Turn the smaller context window off** — Settings → Token Savings → Long conversations → Off')
    expect(flat(privacy)).toContain('**Switch tool-result shortening between Late and Legacy** — Settings → Token Savings → Shorten tool results')
    expect(flat(privacy)).toContain('cannot be switched off while Late is on')
  })

  it('names what wins over the variable and what does not, and the two things that surprise: an env entry and a percentage', () => {
    for (const text of [privacySection, docsSection]) {
      expect(text).toContain('An `env` entry that sets the variable itself')
      expect(text).toContain('`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`')
      expect(text).toContain('Workflow Orchestrator')
    }
    expect(pane).toContain('<code>CLAUDE_AUTOCOMPACT_PCT_OVERRIDE</code>')
    expect(pane).toContain('Workflow Orchestrator')
    // The wording the verifiers found too wide: the saved key wins, an env entry in those places does not.
    expect(docsSection).not.toContain('wins over a window set in a subagent\'s definition, in a `--settings` argument or by your organization\'s managed settings')
  })

  // The sentences above pin that a thing is MENTIONED. These pin what each one CONCLUDES, because a sentence flipped
  // to its opposite ("that one loses", "compaction comes later", "ships On") still names every keyword and is false.
  describe('the conclusions, not only the keywords', () => {
    it('the README says the saving is modeled, from one person\'s history, and that this is why it ships Off', () => {
      expect(readme).toContain('The savings beside each window are **modeled** from one person\'s October history')
      expect(readme).toContain('which is why it ships Off')
      expect(readme).not.toMatch(/savings beside each window are \*\*measured\*\*/)
    })

    it('the guide and PRIVACY.md say an env entry in a --settings argument or managed settings wins over this setting', () => {
      expect(docsSection).toContain('so that one wins over this setting')
      expect(privacySection).toContain('so that one wins')
      expect(privacySection).not.toContain('so that one loses')
      expect(docsSection).not.toContain('loses to this setting')
    })

    it('both say a percentage override makes compaction come SOONER than you chose, and PRIVACY.md names the three files it then reads', () => {
      for (const text of [docsSection, privacySection]) {
        expect(text).toContain('compaction comes sooner than you chose')
        expect(text).not.toContain('compaction comes later')
      }
      expect(privacySection).toContain('then reads three files if they exist')
    })

    it('the pane\'s first option is Off, and is the one marked as the default', () => {
      expect(pane).toContain("{ value: 0, label: 'Off — Claude Code decides (default)' }")
      expect(pane.match(/\(default\)/g)?.length).toBe(1) // no other option claims to be the default
      expect(CONTEXT_CAP_CHOICES[0]).toBe(0)
    })

    // What a person who turns the window on is told about its reach, found by reading the pane against Anthropic's
    // pages: subagents use the same window, /autocompact typed in a session is reported as overridden, and a
    // resumed conversation already longer than the window is not described anywhere, so we say that instead of guessing.
    it('the guide, PRIVACY.md and the pane say subagents compact at it too, /autocompact is overridden while it is on, and nothing is known about a resumed long conversation', () => {
      for (const [name, text] of [['the guide', docsSection], ['PRIVACY.md', privacySection], ['the pane', pane]] as const) {
        // Claude Code's subagents, not "a Workflow's": Termpolis's own Workflow Orchestrator is a different thing, and it gets no window.
        expect(text, name).toMatch(/Claude Code.s subagents use the variable.s window too, so they compact sooner as well/)
        expect(text, name).not.toMatch(/subagents of a Workflow/)
        expect(text, name).toContain('/autocompact')
        expect(text, name).toMatch(/reported as overridden and not saved/)
        expect(text, name).toContain('Anthropic does not say what a resumed')
      }
    })

    it('every one of them says Termpolis does not READ the managed-settings file, not that it cannot', () => {
      for (const [name, text] of [['the guide', docsSection], ['PRIVACY.md', privacySection], ['the pane', pane]] as const) {
        expect(text, name).toMatch(/managed[- ]settings file/)
        expect(text, name).not.toMatch(/Termpolis can read/)
      }
    })

    it('the README\'s link to the guide reaches the heading it means', () => {
      const m = /\[the guide\]\((docs\/DOCUMENTATION\.md)#([^)]+)\) lists where it does not look/.exec(readme)
      expect(m).not.toBeNull()
      // GitHub's slug: lower-cased, punctuation dropped, each space a hyphen (so the dash between two spaces leaves two).
      const slug = (h: string): string => h.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-')
      const heading = /^### (Long conversations — a smaller Claude Code context window \(opt-in\))$/m.exec(docs)
      expect(heading).not.toBeNull()
      expect(slug((heading as RegExpExecArray)[1])).toBe((m as RegExpExecArray)[2])
    })
  })
})

/**
 * The retrieval-turn figure has one known way to be low, which the card and the guide say: a ToolSearch turn is
 * paired with the retrieve_full turn after it by the conversation's opening message, so conversations that
 * open with the same message and run at the same time can leave one uncharged. It is an undercount only (a
 * hop is taken at most once), so the figure is stated as a lower bound there.
 */
describe('the retrieval-turn figure states its one known undercount', () => {
  const docsProxy = flat(section(docs, '### Token Savings — the Claude Code compression proxy'))

  it('says in the guide that the pairing is by the opening message and that the figure is then a lower bound', () => {
    expect(docsProxy).toContain('paired with the `retrieve_full` turn that follows it by the conversation\'s opening message')
    expect(docsProxy).toContain('a ToolSearch turn can be left uncharged and the retrieval-turn figure is a lower bound there')
  })
})

/**
 * The comparison's margin is stated as 99%, and is read from a wider interval so that the statement holds on
 * the holdout's skewed costs (armCompare.ts T999, held by the identical-arms test in headroomArmCompare). The
 * three places a person reads it say so, with the same two numbers: how often it is then wrong, and what it costs.
 */
describe('the comparison says its margin is wider than the 99% it states, and why', () => {
  const readmeFlat = flat(readFileSync(join(ROOT, 'README.md'), 'utf8'))
  const card = flat(readFileSync(join(ROOT, 'src', 'renderer', 'src', 'components', 'SettingsPane', 'ElisionHealthCard.tsx'), 'utf8'))
  const docsProxy = flat(section(docs, '### Token Savings — the Claude Code compression proxy'))

  it('has the README, the guide and the card quote the false-verdict rate and the data it costs', () => {
    expect(readmeFlat).toContain('read from a wider interval than a plain 99% one')
    expect(readmeFlat).toContain('names a difference falsely in under 1 read in 100')
    expect(readmeFlat).toContain('about 1.8 times the data to name a real one')
    expect(docsProxy).toContain('The margin is read from a wider interval than a plain 99% one')
    expect(docsProxy).toContain('named a difference falsely in under 1 read in 100')
    expect(docsProxy).toContain('The price is about 1.8 times the data to name a real difference')
    expect(card).toContain('named a difference falsely in fewer than 1 read in 100')
    expect(card).toContain('it takes about 1.8 times the data to name a real difference')
  })

  // The card says "not enough data yet" until BOTH floors are met: 500 requests in each arm AND at least five groups
  // of conversations in each. The README said only the first, so a person with 600 requests from three groups read
  // "not enough data yet" and had been told it needed 500. Each place says both, with the numbers the code uses.
  it('says the card needs 500 requests from at least five groups of conversations on each side, the numbers armCompare uses', () => {
    expect(MIN_ARM_REQUESTS).toBe(500)
    expect(MIN_ARM_GROUPS).toBe(5)
    expect(readmeFlat).toContain('until each side has 500 requests from at least five groups of conversations')
    expect(docsProxy).toContain('until each group has 500 requests from at least five groups of conversations')
    expect(card).toContain('at least ${fmt(a.minRequests)} requests in each arm, from at least ${MIN_ARM_GROUPS} different groups of conversations')
    expect(readmeFlat).not.toContain('until it has 500 requests on each side')
  })

  // What a plain 99% interval did on the same simulated identical arms, as a count of reads and not as a ratio:
  // "3 to 6 times as often" had no stated base, and a replication of the simulation read it as 2 to 6 times the
  // nominal half percent (1.1 to 3.1 false "costlier" reads in 100, against 0.1 to 0.8 for the shipped margin).
  it('says how often a plain 99% interval was wrong on the same arms as a count of reads, not as "times as often"', () => {
    const plain = 'where a plain 99% interval did so in about 1 to 3 reads in 100 when it said Late cost more'
    expect(docsProxy).toContain(plain)
    expect(card).toContain(plain)
    expect(docsProxy).not.toContain('times as often')
    expect(card).not.toContain('times as often')
  })

  it('keeps the 1.8 true to the table: the ratio of the two quantiles squared, at the degrees of freedom of twenty groups', async () => {
    const { tCritical } = await import('../../src/main/headroom/armCompare')
    // 99% two-sided at 19 degrees of freedom is 2.861; the quantile in use over it, squared, is the data factor.
    expect(((tCritical(19) / 2.861) ** 2).toFixed(1)).toBe('1.8')
  })
})

/** Small things a reader trusts: whose the asking-back rate is, and one spelling of "modeled". */
describe('the documents attribute the rate to the author\'s machine and spell modeled one way', () => {
  it('says in the guide that the rate is the author\'s, and the models it differs by', () => {
    const lateBullet = flat(docs.slice(docs.indexOf('**Shorten tool results: Late or Legacy.**'), docs.indexOf('**A holdout on your own work.**')))
    expect(lateBullet).toContain('on the author\'s machine, the model has recently asked for most of what is shortened early (about 69% on Opus 5.5 and 44% on Sonnet 5.5)')
    expect(lateBullet).not.toContain('the model now asks for most of what is shortened early')
  })

  it('has no "modelled" in the README, the guide or the privacy policy', () => {
    for (const name of ['README.md', 'PRIVACY.md', join('docs', 'DOCUMENTATION.md')]) {
      expect(readFileSync(join(ROOT, name), 'utf8'), name).not.toMatch(/modelled/i)
    }
  })
})

/** The way to check the window is in the app: the Activity Feed's compaction event carries the size (claudeCodeWatcher). */
describe('the guide says where to see the size at which Claude Code compacted', () => {
  it('names the Activity Feed, the form of the line, that it is read from a line the feed already reads, and what it is for', () => {
    expect(docsSection).toContain('**Checking where it compacts.**')
    expect(docsSection).toContain('The Activity Feed\'s compaction event shows the size of the conversation when Claude Code compacted and whether it chose to')
    expect(docsSection).toContain('`context compacted at 246,000 tokens (auto)`')
    expect(docsSection).toContain('read from the same transcript line the feed already reads and nothing else on it')
    expect(docsSection).toContain('Anthropic does not say how close to the window it does')
  })

})
