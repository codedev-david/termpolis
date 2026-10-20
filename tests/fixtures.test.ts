import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// The fixtures hold real output, real CLIs captured in real folders, so each was made with the user's
// name replaced, letter for letter, by a name of its own, and its rows lay out as they did. A screen
// draws a name across two rows when a narrow one breaks it, an escape sequence between its halves: a
// scrub run on the raw bytes left half of one in a fixture (MW1-1). Read as the screen shows it.
const NAMES_PUT_IN_PLACE = ['TermpolisUser1', 'TermpolisUserx', 'ExampleUserNam']

const ESC = '\x1b'
const BEL = '\x07'
/** The text as a screen shows it, its escape sequences, control characters and whitespace taken out:
 *  a name a row break or an escape sequence splits is read whole. */
function shown(text: string): string {
  return text
    .replace(new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g'), '')
    .replace(new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g'), '')
    .replace(new RegExp(`${ESC}[()][A-Z0-9]`, 'g'), '')
    .replace(new RegExp(`${ESC}.`, 'g'), '')
    .replace(/[\x00-\x1f\x7f\s\u00a0]/g, '')
}

/** Whether `after`, what follows a user's folder in a path, starts with a name put in place, or with
 *  the start of one that Claude Code cut short to fit its header ("C--Users-Termpo…"). */
function namePutInPlace(after: string): boolean {
  const cut = after.indexOf('…')
  return NAMES_PUT_IN_PLACE.some((name) => after.startsWith(name) || (cut >= 0 && name.startsWith(after.slice(0, cut))))
}

/** Every string in a parsed JSON value. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(stringsIn)
  return []
}

/** What follows each user's folder in a path in `strings` that names anyone but a name put in place:
 *  the folder as Windows names it (C:\Users\<name>, or C:/Users/<name> as Claude Code and Git Bash
 *  write it) and as Claude Code names its project folder for it (C--Users-<name>-repos-app). Read in
 *  the text a screen shows, and in the text of every OSC sequence, which shown() takes out with the
 *  sequence: it says what the screen doesn't show, the folder a shell reports (ESC ] 9;9;<folder>
 *  BEL), a link's target, a window's title (MR2-1). Not in the raw string: there, a name put in place
 *  that a row break and an escape sequence split would read as another name. */
function namesLeft(strings: readonly string[]): string[] {
  const said = strings.flatMap((s) => [...s.matchAll(new RegExp(`${ESC}\\]([^${BEL}${ESC}]*)`, 'g'))].map((m) => m[1]))
  const left: string[] = []
  for (const text of [...strings.map(shown), ...said]) {
    for (const m of text.matchAll(/Users(?:\\+|\/+|-)/g)) {
      if (!namePutInPlace(text.slice(m.index + m[0].length))) left.push(text.slice(m.index, m.index + m[0].length + 16))
    }
  }
  return left
}

describe('the fixtures', () => {
  const dir = path.join(__dirname, 'fixtures')
  const files = fs.readdirSync(dir).filter((file) => file.endsWith('.json'))

  it.each(files)('%s shows no user name in a path but one put in its place', (file) => {
    expect(namesLeft(stringsIn(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))))).toEqual([])
  })

  // The check itself (MR2-1): a name in a path the screen shows, in one only an escape sequence
  // says, and in one written with forward slashes.
  it.each([
    ['in the prompt the screen shows', 'PS C:\\Users\\SomeoneElse\\app> '],
    ["in Claude Code's folder for the project", 'C--Users-SomeoneElse-app'],
    ['in the folder PowerShell reports', `${ESC}]9;9;C:\\Users\\SomeoneElse\\app${BEL}PS > `],
    ["in a link's target", `${ESC}]8;;file:///C:/Users/SomeoneElse/app/a.ts${ESC}\\a.ts${ESC}]8;;${ESC}\\`],
    ['in a path with forward slashes', 'Read C:/Users/SomeoneElse/app/a.ts'],
  ])('finds a user name %s', (_name, text) => {
    expect(namesLeft([text])).toEqual([expect.stringContaining('SomeoneElse')])
  })

  it('finds none where a name put in place is, a row break and an escape sequence splitting it on the screen', () => {
    expect(namesLeft([`PS C:\\Users\\TermpolisUse${ESC}[m\r\nr1\\app> `, `${ESC}]9;9;C:\\Users\\TermpolisUser1\\app${BEL}`, 'Read C:/Users/TermpolisUserx/app/a.ts'])).toEqual([])
  })

  // A path printed as JSON doubles its backslashes, and one joined from two parts can double a slash.
  it('finds none where a name put in place follows a doubled backslash or slash', () => {
    expect(namesLeft(['"cwd": "C:\\\\Users\\\\TermpolisUser1\\\\app"', 'C:/Users//TermpolisUser1/app'])).toEqual([])
  })
})
