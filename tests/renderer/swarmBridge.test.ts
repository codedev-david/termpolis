import { describe, it, expect } from 'vitest'
import { WorkerFeed, readWorkerScreen, statusText, formatIncomingMessage, DONE_HINT } from '../../src/renderer/src/lib/swarmBridge'
import { screenOf } from '../../src/shared/terminalScreen'
import fixtures from '../fixtures/agentScreens.json'

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

  it('starts over after output it missed, posting nothing for that read', () => {
    const feed = new WorkerFeed('Codex')
    feed.update({ output: screen([]) })
    expect(feed.update({ output: screen(['before the gap']), missed: 900 })).toBeNull()
    expect(feed.update({ output: screen(['before the gap']) })).toBeNull() // set aside, not news
    expect(feed.update({ output: screen(['before the gap', 'after']) })).toBe('[Codex] after')
  })

  it('knows when output draws past its screen: the terminal was resized larger', () => {
    const feed = new WorkerFeed('Codex')
    expect(feed.outgrows(`${E}[40;1Hx`)).toBe(false) // no screen yet: nothing to outgrow
    feed.update({ output: screen([]) })
    expect(feed.outgrows(`${E}[24;80Hx`)).toBe(false)
    expect(feed.outgrows(`${E}[40;1Hx`)).toBe(true)
    expect(feed.outgrows(`${E}[1;81Hx`)).toBe(true)
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
    expect(view).toEqual({ transcript: ['● Done that'], prompts: ['❯ Do it'], status: 'Wrapping up…', agent: 'working' })
  })

  it('reads a screen with no input box as all transcript', () => {
    const view = readWorkerScreen(screenOf('first\r\nsecond\r\n'), 'Codex', 'working')
    expect(view.transcript).toEqual(['first', 'second'])
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
