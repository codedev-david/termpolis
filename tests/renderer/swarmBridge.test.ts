import { describe, it, expect } from 'vitest'
import { WorkerFeed, readWorkerScreen, statusText, formatIncomingMessage, DONE_HINT } from '../../src/renderer/src/lib/swarmBridge'
import { screenOf } from '../../src/shared/terminalScreen'
import fixtures from '../fixtures/agentScreens.json'
import input from '../fixtures/agentScreensInput.json'

// GitHub #36 item 7: "Dashboard messages are raw screen snapshots, full of spinner frames"
// ("⣽ Reading fil⣾ Reading file..."), labelled by keyword guessing. The feed posts what a worker's
// screen settled on. The real sessions are tests/fixtures/agentScreens.json: each moment of one
// session is a longer prefix of the same output, so feeding the differences replays the reads.

const E = '\x1b'
const RULE = '─'.repeat(80)
const SPINNERS = /[\u2800-\u28ff✢✳✶✻✽◐◑◒◓]/

/** Feeds each moment's new output in turn and collects what the feed would post. */
function replay(agentName: string, moments: string[]): Array<string | null> {
  const feed = new WorkerFeed(agentName)
  let fed = 0
  return moments.map((raw) => {
    const out = feed.update({ output: raw.slice(fed) })
    fed = raw.length
    return out
  })
}

/** Codex 0.153.4's offer of a cheaper model near a limit, its strings from codex.exe. */
const SWITCH_POPUP = [
  '  Approaching rate limits',
  '  Switch to gpt-5.6-luna for lower credit usage?',
  '',
  '› 1. Switch to gpt-5.6-luna   Uses fewer credits for upcoming turns.',
  '  2. Keep current model',
  '  3. Keep current model (never show again)',
  '',
  '  Press enter to confirm or esc to go back',
]

/** An agent screen drawn at fixed rows, as ConPTY sends a repaint: its transcript, then its box. */
function screen(transcript: string[], opts: { status?: string; title?: string; footer?: string } = {}): string {
  const rows = [...transcript, ...(opts.status ? [opts.status] : []), RULE, '❯ ', RULE, opts.footer ?? '  ⏵⏵ bypass permissions on']
  return `${E}]0;${opts.title ?? '✳ Claude Code'}\x07${E}[H${E}[2J` + rows.map((r, i) => `${E}[${i + 1};1H${r}`).join('')
}

describe('WorkerFeed on real sessions', () => {
  it('agy: reports its reply and that it may be done, with no spinner frame in any message', () => {
    const { idle, typed, busy, doneIdle } = fixtures.agy
    const posts = replay('Gemini', [idle, typed, busy, doneIdle])
    expect(posts.slice(0, 3)).toEqual([null, null, null])
    expect(posts[3]).toBe(`[Gemini] ${DONE_HINT}\n  OK`)
  })

  it('Claude Code: its reply, once it is done, and none of its spinner glyphs', () => {
    const { startupIdle, busy, doneIdle } = fixtures.claude
    const posts = replay('Claude', [startupIdle, busy, doneIdle, doneIdle])
    expect(posts[0]).toBeNull()
    expect(posts[1]).toBeNull() // "✢ Doing…" is a status line, and it changed before it settled
    expect(posts[2]).toBe(`[Claude] ${DONE_HINT}\n● OK`)
    // The turn's summary line is a status line too: posted once it held, without its glyph.
    expect(posts[3]).toBe('[Claude] Status: Crunched for 1s · done 8:37 PM')
    for (const p of posts) expect(p ?? '').not.toMatch(SPINNERS)
  })

  it('Codex starting up: what went wrong, and no "may be done" before it was given a task', () => {
    const { loading, mcpStarting, ready } = fixtures.codex
    const posts = replay('Codex', [loading, mcpStarting, ready])
    expect(posts[0]).toBeNull()
    const said = posts.filter(Boolean).join('\n')
    expect(said).toContain('⚠ MCP startup incomplete (failed: codex_apps, termpolis)')
    expect(said).not.toContain(DONE_HINT)
    // Its header box, banner and tips are furniture, and its input box is not a prompt it was sent.
    expect(said).not.toMatch(/OpenAI Codex|Tip:|╭|Ask Codex to do anything/)
  })

  it('Codex queueing a prompt typed while it loaded: its notice, whole, as content', () => {
    const { loading, queued } = fixtures.codex
    // queued is another session (Codex with a slow MCP server); its start matches the first.
    const feed = new WorkerFeed('Codex')
    feed.update({ output: loading.slice(0, 1500) })
    expect(feed.update({ output: queued.slice(1500) })).toBeNull() // the queue appeared on this read
    expect(feed.update({ output: '' })).toBe('[Codex] • Queued follow-up inputs\n  ↳ Reply with only the word OK and nothing else.\n    alt + ↑ edit last queued message')
  })
})

describe('WorkerFeed', () => {
  it('while the worker is busy, posts a line once it reads the same on two reads in a row, never the half-drawn version', () => {
    const busy = (rows: string[]) => screen(rows, { title: '⠙ my-project' })
    const feed = new WorkerFeed('Codex')
    expect(feed.update({ output: busy([]) })).toBeNull()
    expect(feed.update({ output: busy(['• Explored', '  └ Read src/app.ts', '• Readi']) })).toBeNull()
    expect(feed.update({ output: busy(['• Explored', '  └ Read src/app.ts', '• Reading file...']) })).toBe('[Codex] • Explored\n  └ Read src/app.ts')
    expect(feed.update({ output: busy(['• Explored', '  └ Read src/app.ts', '• Reading file...']) })).toBe('[Codex] • Reading file...')
    expect(feed.update({ output: busy(['• Explored', '  └ Read src/app.ts', '• Reading file...']) })).toBeNull()
  })

  it('posts what a worker at rest shows at once: it draws nothing more', () => {
    const feed = new WorkerFeed('Codex')
    feed.update({ output: screen([]) })
    expect(feed.update({ output: screen(['• Edited src/app.ts (+3 -1)']) })).toBe('[Codex] • Edited src/app.ts (+3 -1)')
  })

  it('reads Gemini CLI\'s braille spinner as one status line, posted once, without its frame or timer', () => {
    const feed = new WorkerFeed('Gemini')
    feed.update({ output: screen([]) })
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'].map((f, i) => `${f} Reading file... (esc to cancel, ${i + 3}s)`)
    const posts = frames.map((f) => feed.update({ output: screen(['✦ Let me read it.'], { status: f, title: '' }) }))
    expect(posts.filter(Boolean)).toEqual(['[Gemini] ✦ Let me read it.\nStatus: Reading file...'])
    // The output as it streams in, spinner frame by spinner frame on one row: never a frame posted.
    const stream = new WorkerFeed('Gemini')
    stream.update({ output: screen([]) })
    for (const f of ['⣽', '⣾', '⣷', '⣯']) {
      const p = stream.update({ output: `${E}[5;1H${E}[2K${f} Reading fil` }) ?? ''
      expect(p).not.toMatch(SPINNERS)
    }
  })

  it('reads Claude Code\'s cycling glyphs and Codex\'s ticking status line as the status they are', () => {
    const claude = new WorkerFeed('Claude')
    claude.update({ output: screen([]) })
    const posts = ['✢', '✳', '✶', '✻', '✽', '*', '·'].map((g) => claude.update({ output: screen(['● Working on it'], { status: `${g} Doing…`, title: '◐ Claude Code' }) }))
    expect(posts.filter(Boolean)).toEqual(['[Claude] ● Working on it\nStatus: Doing…'])

    const codex = new WorkerFeed('Codex')
    codex.update({ output: screen([]) })
    const ticks = ['• Working (12s • esc to interrupt)', '◦ Working (17s • esc to interrupt)', '• Working (1m 02s • esc to interrupt)']
    expect(ticks.map((s) => codex.update({ output: screen([], { status: s }) })).filter(Boolean)).toEqual(['[Codex] Status: Working'])
  })

  it('posts a status again on a later turn, after it went away', () => {
    const feed = new WorkerFeed('Codex')
    feed.update({ output: screen([]) })
    const busy = screen([], { status: '• Working (2s • esc to interrupt)' })
    feed.update({ output: busy })
    expect(feed.update({ output: busy })).toBe('[Codex] Status: Working')
    feed.update({ output: screen([]) })
    feed.update({ output: busy })
    expect(feed.update({ output: busy })).toBe('[Codex] Status: Working')
  })

  it('hints a worker may be done only after it was sent a prompt, worked on it, and is back at its prompt', () => {
    const feed = new WorkerFeed('Codex')
    feed.update({ output: screen(['❯ an old prompt from before the bridge']) })
    // Busy and back again with no prompt sent: Codex starting up.
    feed.update({ output: screen([], { status: '• Starting MCP servers (0s • esc to interrupt)' }) })
    expect(feed.update({ output: screen([]) })).toBeNull()
    // A prompt, a turn, its end.
    feed.update({ output: screen(['❯ Build the page. Task ID: t1'], { status: '• Working (1s • esc to interrupt)' }) })
    expect(feed.update({ output: screen(['❯ Build the page. Task ID: t1', '• Edited src/page.tsx (+40 -0)']) })).toBe(`[Codex] ${DONE_HINT}\n• Edited src/page.tsx (+40 -0)`)
    // Once per prompt.
    expect(feed.update({ output: screen(['❯ Build the page. Task ID: t1', '• Edited src/page.tsx (+40 -0)']) })).toBeNull()
  })

  it('posts rows that scrolled off the top at once, they are final, and the rest once they settle', () => {
    const feed = new WorkerFeed('Codex')
    feed.update({ output: 'starting\r\n' })
    // 31 rows into a 24-row screen still printing (a 'starting' screen counts as busy): 8 rows are gone.
    const lines = ['› Run the tests. Task ID: t2', ...Array.from({ length: 30 }, (_, i) => `line ${i}`)]
    // The prompt that scrolled off isn't posted (the conductor sent it); the lines under it are.
    expect(feed.update({ output: lines.join('\r\n') + '\r\n' })).toBe('[Codex] ' + Array.from({ length: 7 }, (_, i) => `line ${i}`).join('\n'))
    // The 23 still on screen held for a read: posted, clipped to the last 20.
    expect(feed.update({ output: '' })?.split('\n')).toEqual(['[Codex] …', ...Array.from({ length: 20 }, (_, i) => `line ${i + 10}`)])
    expect(feed.update({ output: '' })).toBeNull()
  })

  it('keeps a message to its last 20 lines and 2,000 characters, marked as cut', () => {
    // At rest (an input box at the bottom), so all it shows is posted at once.
    const atRest = (rows: string[]) => `${E}[2J${E}[1;1H${rows.join('\r\n')}\r\n${RULE}\r\n❯ \r\n${RULE}`
    const tall = new WorkerFeed('Codex')
    tall.update({ output: screen([]), cols: 80, rows: 30 })
    const rows = Array.from({ length: 24 }, (_, i) => `row ${i}`)
    expect(tall.update({ output: atRest(rows) })?.split('\n')).toEqual(['[Codex] …', ...rows.slice(-20)])
    // 20 rows of 80 never reach 2,000 characters; on a 200-column screen 12 rows of 190 do.
    const wide = new WorkerFeed('Codex')
    wide.update({ output: screen([]), cols: 200, rows: 30 })
    const long = Array.from({ length: 12 }, (_, i) => `${String(i).padStart(2, '0')} ${'z'.repeat(187)}`)
    const out = wide.update({ output: atRest(long) }) ?? ''
    expect(out.split('\n')).toEqual(['[Codex] …', ...long.slice(-10)])
  })

  it('leaves out furniture: logos, boxes, rules, shell prompts, tips and blank rows', () => {
    const feed = new WorkerFeed('Gemini')
    feed.update({ output: screen([]) })
    const view = [' ▐▛███▛█   Claude Code', '╭────╮', '│ >_ OpenAI Codex │', '═'.repeat(30), 'PS C:\\project> agy', 'dev@box:~/p$', 'dev@box:~/p$ codex', '$', '$ npm test', '  Tip: Use /fast', '', 'kept']
    expect(feed.update({ output: screen(view) })).toBe('[Gemini] kept')
  })

  it('leaves out the rest of a launch line that wrapped past the prompt\'s row, on screen and scrolled off', () => {
    const launch = `PS C:\\Users\\TermpolisUser\\repos\\proj> & 'C:\\Users\\TermpolisUser\\AppData\\Local\\agy\\bin\\agy.exe' --dangerously-skip-permissions`
    const feed = new WorkerFeed('Gemini')
    feed.update({ output: `${E}[?1049hdialog` }) // the trust dialog, on the alternate screen
    expect(feed.update({ output: `${E}[?1049l${launch}\r\nagy says hello${E}[10;1H${RULE}${E}[11;1H> ${E}[12;1H${RULE}` })).toBe('[Gemini] agy says hello')
    const scrolled = new WorkerFeed('Gemini')
    scrolled.update({ output: 'x\r\n' })
    expect(scrolled.update({ output: `${launch}\r\n${Array.from({ length: 30 }, (_, i) => `r${i}`).join('\r\n')}` })?.split('\n')[0]).toBe('[Gemini] r0')
  })

  // GitHub #36 item 7. The rest of a typed line, or of a prompt the conductor sent, posted back as
  // if the worker had printed it.
  const BANNER = 'Windows PowerShell\r\nCopyright (C) Microsoft Corporation. All rights reserved.\r\n\r\n'
  const CODEX_BOX = '╭──────────────────────────────────────────────────╮\r\n│ >_ OpenAI Codex (v0.162.1)                       │\r\n╰──────────────────────────────────────────────────╯\r\n\r\n'
  const CODEX_IDLE = '› Ask Codex to do anything\r\n\r\n  gpt-5.6-sol medium · ~\\customer-portal'

  it("leaves out the launch line typed at a prompt too long for the screen's first row", () => {
    // 83 characters: the prompt's own '>' wraps onto the second row with the command after it.
    const cwd = 'C:\\Users\\jared.roberts\\OneDrive - Contoso Ltd\\Documents\\GitHub\\customer-portal'
    const feed = new WorkerFeed('Codex')
    const posted = [
      feed.update({ output: `${BANNER}PS ${cwd}> `, cols: 80, rows: 24 }),
      feed.update({ output: `codex -a never -s workspace-write\r\n${CODEX_BOX}${CODEX_IDLE}` }),
      feed.update({ output: '' }),
    ].filter(Boolean)
    expect(posted).toEqual([])
  })

  it('leaves out the rest of a launch line whose prompt row scrolled off before a later read', () => {
    // The launch line wraps onto a second row, and agy's banner fills the screen under it. However
    // much it prints next: with 4 lines only the prompt's row scrolls off, and the rest of the line
    // is left at the top of the screen.
    const cmd = "& 'C:\\Users\\Jared Roberts\\AppData\\Local\\agy\\bin\\agy.exe' --dangerously-skip-permissions"
    const banner = Array.from({ length: 16 }, (_, i) => `  banner ${i + 1}`).join('\r\n')
    for (let n = 1; n <= 8; n++) {
      const feed = new WorkerFeed('Gemini')
      const more = Array.from({ length: n }, (_, i) => `✓ Loaded extension ${i + 1}`).join('\r\n')
      const posted = [
        feed.update({ output: `${BANNER}PS C:\\work\\customer-portal> `, cols: 80, rows: 24 }),
        feed.update({ output: `${cmd}\r\n\r\n  agy 1.4.0\r\n${banner}\r\n` }),
        feed.update({ output: `${more}\r\n` }),
        feed.update({ output: '' }),
      ].filter(Boolean).join('\n')
      expect(posted, `${n} lines`).not.toMatch(/dangerously-skip-permissions|agy\.exe/)
      expect(posted, `${n} lines`).toContain('✓ Loaded extension 1')
    }
  })

  it('leaves out the rows a prompt the conductor sent wraps onto, as the worker echoes it', () => {
    const frame = (rows: string[]): string => `${E}[H${E}[2J` + rows.map((r, i) => `${E}[${i + 1};1H${r}`).join('')
    const header = ['╭────────╮', '│ >_ OpenAI Codex │', '╰────────╯', '']
    const idle = ['› Ask Codex to do anything', '', '  gpt-5.6-sol medium · ~\\customer-portal']
    const echo = [
      '› You are working in C:\\work\\customer-portal. Add the over-quota banner to the',
      '  dashboard and a test for it. Write the files; do not just print them. Task ID:',
      '  task-7f3c2a',
    ]
    const feed = new WorkerFeed('Codex')
    const posted = [
      feed.update({ output: frame([...header, ...idle]), cols: 80, rows: 24 }),
      feed.update({ output: frame([...header, ...echo, '', '• Working (2s • esc to interrupt)', '', ...idle]) }),
      feed.update({ output: frame([...header, ...echo, '', '• Edited src/Banner.tsx (+12 -0)', '', '• Working (9s • esc to interrupt)', '', ...idle]) }),
      feed.update({ output: frame([...header, ...echo, '', '• Edited src/Banner.tsx (+12 -0)', '', '• Added the banner and its test.', '', ...idle]) }),
    ].filter(Boolean).join('\n')
    expect(posted).not.toMatch(/task-7f3c2a|dashboard and a test/)
    expect(posted).toContain('• Added the banner and its test.')
    expect(posted).toContain(DONE_HINT)
  })

  it('starts over after output it missed, posting nothing for that read', () => {
    const feed = new WorkerFeed('Codex')
    feed.update({ output: screen([]) })
    expect(feed.update({ output: screen(['before the gap']), missed: 900 })).toBeNull()
    expect(feed.update({ output: screen(['before the gap']) })).toBeNull() // set aside, not news
    expect(feed.update({ output: screen(['before the gap', 'after']) })).toBe('[Codex] after')
  })

  it('knows when output draws past its screen: the terminal was resized larger', () => {
    const feed = new WorkerFeed('Codex')
    expect(feed.resized(`${E}[40;1Hx`)).toBe(false) // no screen yet: nothing to outgrow
    feed.update({ output: screen([]) })
    expect(feed.resized(`${E}[24;80Hx`)).toBe(false)
    expect(feed.resized(`${E}[40;1Hx`)).toBe(true)
    expect(feed.resized(`${E}[1;81Hx`)).toBe(true)
  })

  it("knows from ConPTY's report that the terminal was resized, larger or smaller", () => {
    const feed = new WorkerFeed('Codex')
    feed.update({ output: screen([]), cols: 80, rows: 24 })
    expect(feed.resized(`${E}[8;40;160tx`)).toBe(true)
    expect(feed.resized(`${E}[8;20;60tx`)).toBe(true)
    expect(feed.resized(`${E}[8;20;60t${E}[8;24;80tx`)).toBe(false) // and back, in one read
    // Starting over without main's size, at the size reported: at 80 columns "near" would wrap.
    const box = `${E}[5;1H${'─'.repeat(100)}${E}[6;1H❯ ${E}[7;1H${'─'.repeat(100)}`
    expect(feed.update({ output: `${E}[8;30;100t${E}[2J${box}` })).toBeNull()
    expect(feed.update({ output: `${E}[2;1Hcol 1${E}[2;90Hnear` })).toBe(`[Codex] col 1${' '.repeat(84)}near`)
  })

  it('reads a worker narrower or shorter than 80x24 on, read after read, and posts what it shows', () => {
    // Every read of a 60x20 screen used to count as drawn past it, against the 80x24 floor of the
    // size guess, and start the screen over: such a worker posted nothing.
    const narrow = (rows: string[]): string => `${E}[H${E}[2J` + [...rows, '─'.repeat(60), '❯ ', '─'.repeat(60)].map((r, i) => `${E}[${i + 1};1H${r}`).join('')
    const feed = new WorkerFeed('Codex')
    expect(feed.update({ output: narrow([]), cols: 60, rows: 20 })).toBeNull()
    expect(feed.resized(narrow(['x']))).toBe(false)
    expect(feed.update({ output: narrow(['• Edited src/app.ts (+3 -1)']) })).toBe('[Codex] • Edited src/app.ts (+3 -1)')
    expect(feed.resized(`${E}[20;60Hx`)).toBe(false)
    expect(feed.resized(`${E}[21;1Hx`)).toBe(true)
  })

  it('starts over at the size a replay read gives, and reads what follows at it', () => {
    const feed = new WorkerFeed('Codex')
    feed.update({ output: screen([]) })
    // The whole window after a resize to 120x40, read from its start: set aside like a first read.
    expect(feed.update({ output: `${E}[H${E}[2J${E}[40;1H${'w'.repeat(10)}`, cols: 120, rows: 40 })).toBeNull()
    // At 80 columns "past 80" would wrap onto a row of its own; at 120 it stays on row 2.
    expect(feed.update({ output: `${E}[2;1Hcol 1${E}[2;90Hpast 80` })).toBe(`[Codex] col 1${' '.repeat(84)}past 80`)
  })

  it('starts over when a replay read gives another height, the width the same', () => {
    const feed = new WorkerFeed('Codex')
    feed.update({ output: screen(['old']), cols: 80, rows: 24 })
    expect(feed.update({ output: screen(['old', 'new']), cols: 80, rows: 30 })).toBeNull()
    expect(feed.update({ output: screen(['old', 'new']), cols: 80, rows: 30 })).toBeNull()
  })

  it('remembers the last 2,000 rows it posted: one older than that, shown again, is news again', () => {
    const feed = new WorkerFeed('Codex')
    feed.update({ output: 'start\r\n' })
    // A screen hands over at most its last 1,000 scrolled-off rows a read, so three reads of 900.
    for (let r = 0; r < 3; r++) {
      feed.update({ output: Array.from({ length: 900 }, (_, i) => `l${r * 900 + i}`).join('\r\n') + '\r\n' })
    }
    const atRest = `${E}[2J${E}[1;1Hl0\r\n${RULE}\r\n❯ \r\n${RULE}`
    expect(feed.update({ output: atRest })).toBe('[Codex] l0')
  })

  it('without a size, starts over at the size the output reaches', () => {
    const feed = new WorkerFeed('Codex')
    feed.update({ output: screen([]) })
    expect(feed.update({ output: `${E}[H${E}[2J${E}[40;1H${'w'.repeat(10)}${E}[1;100Hedge` })).toBeNull()
    expect(feed.update({ output: `${E}[2;1Hcol 1${E}[2;90Hnear` })).toBe(`[Codex] col 1${' '.repeat(84)}near`)
  })

  it('replays a window the way main says to: past the end of a sequence it cut, then on with what follows', () => {
    // The window starts with the rest of a cut sequence ("5;1H"): not text.
    const box = `${E}[5;1H${RULE}${E}[6;1H❯ ${E}[7;1H${RULE}`
    const feed = new WorkerFeed('Codex')
    expect(feed.update({ output: '5;1Hstale', skip: 4, cols: 80, rows: 24 })).toBeNull()
    expect(feed.update({ output: `${E}[1;7Hmore${box}` })).toBe('[Codex] stale more')
  })

  it('replays a window the way main says to: in the modes the output before it left', () => {
    // The window opens on the alternate screen; the preamble says so. Leaving it shows a main
    // screen that never had "on alt" on it.
    const box = `${E}[5;1H${RULE}${E}[6;1H❯ ${E}[7;1H${RULE}`
    const feed = new WorkerFeed('Codex')
    expect(feed.update({ output: 'on alt', preamble: `${E}[?1049h`, cols: 80, rows: 24 })).toBeNull()
    expect(feed.update({ output: `${E}[?1049l${E}[1;8Hmore${box}` })).toBe(`[Codex] ${' '.repeat(7)}more`)
  })
})

describe('readWorkerScreen', () => {
  it('splits a screen into transcript, prompts sent, status and the agent\'s state', () => {
    const view = readWorkerScreen(screenOf(screen(['❯ Do it', '● Done that'], { status: '✢ Wrapping up…', title: '◐ Claude Code' })), 'Claude', 'idle')
    expect(view).toEqual({ transcript: ['● Done that'], prompts: ['❯ Do it'], status: 'Wrapping up…', shell: [], agent: 'working' })
  })

  it('reads the rows a screen\'s top row continues from the rows that scrolled off above it', () => {
    // The prompt's own row went off the top: its echo and its wrapped rest, a launch line's too.
    const s = screenOf(`  the rest of the task\r\n  and its last row\r\n\r\n● Done that\r\n`)
    expect(readWorkerScreen(s, 'Claude', 'idle', ['❯ Do the first part of the task,']).prompts).toEqual(['  the rest of the task', '  and its last row'])
    const launch = `PS C:\\pr> & 'C:\\Users\\Jared Roberts\\AppData\\Local\\agy\\bin\\agy.exe' --dangerously`
    expect(launch).toHaveLength(80)
    expect(readWorkerScreen(screenOf('-skip-permissions\r\nhello\r\n'), 'Gemini', 'idle', [launch])).toMatchObject({ shell: ['-skip-permissions'], transcript: ['hello'] })
  })

  it("keeps Claude Code's notice that it was interrupted, which it puts right under the prompt", () => {
    const view = readWorkerScreen(screenOf('❯ Build the page\r\n  ⎿  Interrupted · What should Claude do instead?\r\n'), 'Claude', 'idle')
    expect(view.prompts).toEqual(['❯ Build the page'])
    expect(view.transcript).toEqual(['  ⎿  Interrupted · What should Claude do instead?'])
  })

  it('reads a screen with no input box as all transcript', () => {
    const view = readWorkerScreen(screenOf('first\r\nsecond\r\n'), 'Codex', 'working')
    expect(view.transcript).toEqual(['first', 'second'])
  })

  // A menu's highlighted option looks like a prompt the worker echoes, and the options under it like
  // the rows it wraps onto: the menu was filed as prompts sent, and left out of what the conductor
  // read, which needs the options to answer it (GitHub #36).
  it("reads a menu's options as transcript, not as prompts it was sent: Codex's update offer, agy's trust prompt", () => {
    const codex = readWorkerScreen(screenOf(fixtures.codex.updateMenu), 'Codex', 'starting')
    expect(codex.prompts).toEqual([])
    expect(codex.transcript).toEqual(expect.arrayContaining(['› 1. Update now (runs `npm install -g @openai/codex`)', '  2. Skip', '  3. Skip until next version', '  Press enter to continue']))
    const agy = readWorkerScreen(screenOf(fixtures.agy.trust), 'Gemini', 'starting')
    expect(agy.prompts).toEqual([])
    expect(agy.transcript).toEqual(expect.arrayContaining(['> Yes, I trust this folder', '  No, exit', '  ↑/↓ Navigate · enter Confirm']))
  })

  it('still reads a prompt it was sent, with a blank row and its answer under it, as one', () => {
    const view = readWorkerScreen(screenOf('> Write the docs\r\n  for the API\r\n\r\n  Done: docs/api.md\r\n'), 'Gemini', 'idle')
    expect(view.prompts).toEqual(['> Write the docs', '  for the API'])
    expect(view.transcript).toEqual(['  Done: docs/api.md'])
  })

  it('reads a prompt whose answer mentions a menu\'s words as the prompt it is', () => {
    const view = readWorkerScreen(screenOf('> Explain the update offer\r\n\r\n  Codex says: Press enter to continue\r\n'), 'Gemini', 'idle')
    expect(view.prompts).toEqual(['> Explain the update offer'])
    expect(view.transcript).toEqual(['  Codex says: Press enter to continue'])
  })

  // A prompt that starts "1. " was read as a menu's cursor: the conductor's own task came back to it
  // as if the worker had printed it (GitHub #36, R2-1). A menu has its keys under its options.
  it("reads a numbered prompt it was sent as a prompt: no menu's keys are under it", () => {
    const rows = ['› 1. Reply with the single word ONE.', '  2. Run no tools.', '', '• ONE', '', '› Ask Codex to do anything', '', '  gpt-5.6-sol medium · ~']
    const view = readWorkerScreen(screenOf(rows.join('\r\n') + '\r\n'), 'Codex', 'idle')
    expect(view.prompts).toEqual(['› 1. Reply with the single word ONE.', '  2. Run no tools.'])
    expect(view.transcript).toEqual(['• ONE'])
  })

  it("reads a numbered prompt with an answer under it as a prompt, though a row further down starts like a menu's keys", () => {
    // A menu's options run down to its keys, indented: an answer at the start of a row ends it.
    const rows = ['› 1. Run the installer.', '', '• Ran it. It printed:', '  Press enter to continue', '', '› Ask Codex to do anything', '', '  gpt-5.6-sol medium · ~']
    const view = readWorkerScreen(screenOf(rows.join('\r\n') + '\r\n'), 'Codex', 'idle')
    expect(view.prompts).toEqual(['› 1. Run the installer.'])
    expect(view.transcript).toEqual(['• Ran it. It printed:', '  Press enter to continue'])
  })

  it("leaves a numbered task still in Codex's composer out: the worker was never sent it", () => {
    const s = input.screens['codex-80x24-numbered']
    const view = readWorkerScreen(screenOf(s.raw, s), 'Codex', 'idle')
    const all = [...view.transcript, ...view.prompts].join('\n')
    expect(all).not.toContain('Reply with the single word ONE')
    expect(all).not.toContain('gpt-5.6-sol medium')
  })

  // R2-4: Codex's popups end in "Press enter to confirm or esc to go back", which the row the menu
  // was found by missed: its options were filed as a prompt's rows and left out of the message.
  it("reads Codex's offer of a cheaper model as a menu: its options are transcript, for the conductor to answer", () => {
    const view = readWorkerScreen(screenOf(SWITCH_POPUP.join('\r\n') + '\r\n'), 'Codex', 'idle')
    expect(view.prompts).toEqual([])
    expect(view.transcript).toEqual(expect.arrayContaining([
      '› 1. Switch to gpt-5.6-luna   Uses fewer credits for upcoming turns.',
      '  2. Keep current model',
      '  Press enter to confirm or esc to go back',
    ]))
  })
})

describe("WorkerFeed and an agent's banner", () => {
  // R2-4: at 60 columns agy draws its banner again under its logo after its first answer, on rows
  // of their own with no logo on them, and they were posted to the swarm, the account's email too.
  it("leaves out agy's banner when it draws it again under its logo, account and all", () => {
    const { cols, rows, moments } = input.agyBanner
    const feed = new WorkerFeed('Gemini')
    expect(feed.update({ output: moments[0], cols, rows })).toBeNull()
    expect(feed.update({ output: moments[1] })).toBe('[Gemini]   OK')
  })

  it("leaves out a banner's rows down to the blank row under it, and posts what follows", () => {
    const view = readWorkerScreen(screenOf(['  Antigravity CLI 1.4.2', '  someone@example.com (Google AI Pro)', '  Gemini 4 Argon (Medium)', '', '  The tests pass.'].join('\r\n') + '\r\n'), 'Gemini', 'idle')
    expect(view.transcript).toEqual(['  The tests pass.'])
    const claude = readWorkerScreen(screenOf(['Claude Code v2.1.302', 'Opus 5.5 · Claude Max', '~\\repos\\app', '', '● Done.'].join('\r\n') + '\r\n'), 'Claude', 'idle')
    expect(claude.transcript).toEqual(['● Done.'])
  })

  it('posts an answer that starts with a version: a banner has its version alone on its row', () => {
    const view = readWorkerScreen(screenOf(['  Claude Code v2.1.302 is installed, and', '  Antigravity CLI 1.4.2 too.', '', '  Done.'].join('\r\n') + '\r\n'), 'Gemini', 'idle')
    expect(view.transcript).toEqual(['  Claude Code v2.1.302 is installed, and', '  Antigravity CLI 1.4.2 too.', '  Done.'])
  })
})

describe('WorkerFeed and a menu', () => {
  it('posts a menu whole once it shows, so the conductor can answer it', () => {
    const raw = fixtures.codex.updateMenu
    const at = raw.indexOf('Update available')
    const feed = new WorkerFeed('Codex')
    expect(feed.update({ output: raw.slice(0, at), cols: 80, rows: 24 })).toBeNull()
    const message = feed.update({ output: raw.slice(at) })
    expect(message).toContain('› 1. Update now')
    expect(message).toContain('  2. Skip')
    expect(message).toContain('  3. Skip until next version')
    expect(message).toContain('  Press enter to continue')
  })

  it("posts Codex's offer of a cheaper model whole, its options and its keys", () => {
    const feed = new WorkerFeed('Codex')
    expect(feed.update({ output: '• Edited src/app.ts (+4 -1)\r\n', cols: 80, rows: 24 })).toBeNull()
    const message = feed.update({ output: '\r\n' + SWITCH_POPUP.join('\r\n') + '\r\n' })
    expect(message).toContain('› 1. Switch to gpt-5.6-luna')
    expect(message).toContain('  2. Keep current model')
    expect(message).toContain('  Press enter to confirm or esc to go back')
  })
})

describe('WorkerFeed and a usage limit', () => {
  // R3-1: a Codex or an agy at its limit was back at its prompt after a turn, which read as done: the
  // limit was posted under "screen suggests it may be done", which points the other way.
  const drawn = (rows: string[]): string => `${E}[H${E}[2J` + rows.map((r, i) => `${E}[${i + 1};1H${r}`).join('')
  const CODEX_IDLE = ['', '› Ask Codex to do anything', '', '  gpt-5.6-sol medium · ~\\repos\\app']
  const CODEX_BUSY = ['', '• Working (12s • esc to interrupt)', '', '› Ask Codex to do anything', '', '  gpt-5.6-sol medium · ~\\repos\\app']
  const AGY_IDLE = ['', RULE, '> ', RULE, '  ? for shortcuts                                    Gemini 4 Argon · medium']
  const AGY_BUSY = ['', '⡿ Generating... (esc to cancel, 4s)', RULE, '> ', RULE, '  esc to cancel                                       Gemini 4 Argon · medium']

  it.each([
    ['Codex', [
      ['• Ready.', ...CODEX_IDLE],
      ['• Ready.', '', '› Fix the login test', ...CODEX_BUSY],
      ['• Ready.', '', '› Fix the login test', '', '• I will fix the test.', ...CODEX_BUSY],
      ['• Ready.', '', '› Fix the login test', '', '• I will fix the test.', '', '■ You\'ve hit your usage limit. Upgrade to Plus to continue using Codex', '(https://chatgpt.com/explore/plus), or try again at 3:04 PM.', ...CODEX_IDLE],
    ], '■ You\'ve hit your usage limit.'],
    ['Gemini', [
      ['  Ready.', ...AGY_IDLE],
      ['  Ready.', '', '> Write the docs', ...AGY_BUSY],
      ['  Ready.', '', '> Write the docs', '', '✕ You have exhausted your quota on this model.', ...AGY_IDLE],
    ], '✕ You have exhausted your quota on this model.'],
  ])('posts %s\'s limit with no "may be done" hint', (agentName, frames, limit) => {
    const feed = new WorkerFeed(agentName)
    const posts = frames.map((f) => feed.update({ output: drawn(f), cols: 80, rows: 24 })).filter((p): p is string => p !== null)
    expect(posts.join('\n')).toContain(limit)
    expect(posts.join('\n')).not.toContain(DONE_HINT)
  })
})

describe('statusText', () => {
  it.each([
    ['⡿  Generating...', 'Generating...'],
    ['• Working (2m 09s • esc to interrupt)', 'Working'],
    ['◦ Reconnecting... 4/5 (3s • esc to interrupt)', 'Reconnecting... 4/5'],
    ['⠼ Reading files... (esc to cancel, 12s)', 'Reading files...'],
    ['✻ Crunched for 1s · done 8:37 PM', 'Crunched for 1s · done 8:37 PM'],
    ['* Thinking…', 'Thinking…'],
    ['• Ran tests (all 12 passed)', 'Ran tests (all 12 passed)'],
  ])('%s reads as %s', (row, text) => {
    expect(statusText(row)).toBe(text)
  })
})

describe('formatIncomingMessage', () => {
  it('formats a message with sender name and content', () => {
    const msg = formatIncomingMessage('Claude', 'Task is complete')
    expect(msg).toContain('Message from Claude')
    expect(msg).toContain('Task is complete')
    expect(msg).toContain('End message')
  })
})
