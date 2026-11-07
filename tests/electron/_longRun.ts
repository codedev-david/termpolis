// A Claude Code 2.1.316 session as its bytes show it after a minute of work (accounts154 F-R2-2).
//
// The CLI paints its input box once, two rule rows and a footer, and every frame after that updates a
// row above them in place. It repaints the box only when the window is resized. So once the work has
// printed more than the 32 KB main keeps per terminal (MAX_TERMINAL_BUFFER_CHARS), a replay of that
// window holds no box at all, though the box is on the screen the user sees. Older 2.1.30x versions
// repainted it every frame, which is why no earlier capture showed it. The real streams this is built
// from: 61 KB of a fake-API turn with the rules painted at offsets 645 and 784 only.
import { MAX_TERMINAL_BUFFER_CHARS } from '../../src/main/terminalOutputBuffer'

const E = '\x1b'
export const COLS = 100
export const ROWS = 28
const RULE = '─'.repeat(COLS)

/** The row the box's top rule is on, counting from 1. */
export const BOX_TOP_ROW = 25

/** A conversation's first rows, then the box at the foot, every row addressed (a ConPTY-style paint). */
export function paintClaude(conversation: string[]): string {
  return `${E}[?25l${E}[2J${E}[H`
    + conversation.map((row, i) => `${E}[${i + 1};1H${row}`).join('')
    + `${E}[${BOX_TOP_ROW};1H${RULE}${E}[${BOX_TOP_ROW + 1};1H> ${E}[7m ${E}[27m${E}[${BOX_TOP_ROW + 2};1H${RULE}`
    + `${E}[${BOX_TOP_ROW + 3};1H  ⏵⏵ bypass permissions on (shift+tab to cycle)${E}[?25h`
}

/** At least `chars` characters of a turn at work: a spinner row updated in place, each time with the cursor
 *  put back in the box. It ends with the spinner row cleared (the turn finished). Nothing here touches the
 *  box's rows. */
export function working(chars: number, spinnerRow = 3): string {
  let out = ''
  for (let n = 1; out.length < chars; n++) {
    out += `${E}[${spinnerRow};1H${E}[38;2;255;107;128m✻${E}[1CThinking…${E}[1C(${n}s${E}[1C·${E}[1C↓${E}[1C${n * 37}${E}[1Ctokens${E}[1C·${E}[1Cesc${E}[1Cto${E}[1Cinterrupt)${E}[K${E}[${BOX_TOP_ROW + 1};3H`
  }
  return out + `${E}[${spinnerRow};1H${E}[K${E}[${BOX_TOP_ROW + 1};3H`
}

/** The reply a turn that hit the usage limit ends in, drawn where the spinner was. */
export function limitReply(row = 2): string {
  return `${E}[${row};1H${E}[m  ⎿${E}[1C\u00a0You've${E}[1Chit${E}[1Cyour${E}[1Csession${E}[1Climit${E}[1C·${E}[1Cresets${E}[1C8:10pm${E}[1C(America/New_York)${E}[${BOX_TOP_ROW + 1};3H`
}

/** More than the window holds: the output that follows a one-time paint, after which a replay of the
 *  window has no box in it. */
export const PAST_THE_WINDOW = MAX_TERMINAL_BUFFER_CHARS + 2000

/** A turn's whole stream: the paint, `chars` of work, then `ending`. */
export function claudeTurn(chars: number, ending = ''): string {
  return paintClaude(['❯ Build the login page.', '']) + working(chars) + ending
}
