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

describe('the fixtures', () => {
  const dir = path.join(__dirname, 'fixtures')
  const files = fs.readdirSync(dir).filter((file) => file.endsWith('.json'))

  // A user's folder, as Windows names it (C:\Users\<name>) and as Claude Code names its project
  // folder for it (C--Users-<name>-repos-app).
  it.each(files)('%s shows no user name in a path but one put in its place', (file) => {
    const left: string[] = []
    for (const text of stringsIn(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))).map(shown)) {
      for (const m of text.matchAll(/Users(?:\\+|-)/g)) {
        if (!namePutInPlace(text.slice(m.index + m[0].length))) left.push(text.slice(m.index, m.index + m[0].length + 16))
      }
    }
    expect(left).toEqual([])
  })
})
