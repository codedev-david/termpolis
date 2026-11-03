// A grammar that is on disk is looked for once. treeSitterSupports() asks grammarAvailable() for every file a code index
// walks, and a re-index after a file change runs on the thread that echoes keystrokes: it was an existsSync per candidate
// folder per file. Counters only (existsSync calls made by src/main), no clock.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
// FIRST: it patches fs, and a module loaded before it keeps the original functions.
import { arm, disarm, uninstall } from '../helpers/mainThreadCounters'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { grammarAvailable, _resetGrammarCacheForTests } from '../../src/main/tsGrammars'

const proc = process as unknown as { resourcesPath?: string }
let dir: string
let saved: string | undefined

beforeEach(() => {
  saved = proc.resourcesPath
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsgram-memo-'))
  fs.mkdirSync(path.join(dir, 'grammars'))
  proc.resourcesPath = dir // where a packaged app keeps its grammars (absent under vitest)
  _resetGrammarCacheForTests()
})
afterAll(() => {
  uninstall()
})
function restore(): void {
  if (saved === undefined) delete proc.resourcesPath
  else proc.resourcesPath = saved
  fs.rmSync(dir, { recursive: true, force: true })
  _resetGrammarCacheForTests()
}

describe('tsGrammars: where a grammar file is', () => {
  it('a grammar on disk costs one existsSync, however many files ask for it', () => {
    try {
      fs.writeFileSync(path.join(dir, 'grammars', 'tree-sitter-memo.wasm'), 'not a real grammar: only its place is asked')
      arm()
      for (let i = 0; i < 500; i++) expect(grammarAvailable('memo')).toBe(true)
      const c = disarm()
      expect(c.sync.existsSync).toBe(1) // the first ask found it in the first folder; the other 499 asked no one
    } finally {
      restore()
    }
  })

  it('a grammar that is missing is looked for each time, so one planted later is seen at once', () => {
    try {
      arm()
      for (let i = 0; i < 3; i++) expect(grammarAvailable('latecomer-memo')).toBe(false)
      const c = disarm()
      expect(c.sync.existsSync).toBeGreaterThanOrEqual(3 * 3) // every candidate folder, every time (nothing remembered)
      fs.writeFileSync(path.join(dir, 'grammars', 'tree-sitter-latecomer-memo.wasm'), 'now it is there')
      expect(grammarAvailable('latecomer-memo')).toBe(true)
    } finally {
      restore()
    }
  })

  it('the reset the tests use forgets what was found', () => {
    try {
      fs.writeFileSync(path.join(dir, 'grammars', 'tree-sitter-forget.wasm'), 'x')
      expect(grammarAvailable('forget')).toBe(true)
      fs.rmSync(path.join(dir, 'grammars', 'tree-sitter-forget.wasm'))
      expect(grammarAvailable('forget')).toBe(true) // remembered: grammars ship with the app and do not vanish while it runs
      _resetGrammarCacheForTests()
      expect(grammarAvailable('forget')).toBe(false)
    } finally {
      restore()
    }
  })
})
