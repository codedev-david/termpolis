import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync,
  statSync, symlinkSync, truncateSync, writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  MAX_CONFIG_BYTES, atomicWriteText, editJsonObject, errorText, formatJsonLike, readJsonObject,
  readTextFile, renameWithRetry,
} from '../../src/main/agentConfigIO'

// Every file here lives in a fresh temp folder. fs is never mocked: each failure below is a real
// one (a folder where a file should be, a missing parent, a read-only file) or an injected
// rename/sleep, which renameWithRetry takes as parameters.

const BOM = '﻿'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termpolis-agentcfg-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Write `text` to `name` in the temp folder and return its path. */
function file(name: string, text: string): string {
  const p = join(dir, name)
  writeFileSync(p, text, 'utf-8')
  return p
}

/** Whatever `fn` throws. Fails the test when it returns normally. */
function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error('expected a throw')
}

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: simulated`), { code })

/** The temp file atomicWriteText puts beside `name`. */
const tmpName = (name: string): string => `${name}.termpolis-${process.pid}.tmp`

describe('errorText', () => {
  const CASES: Array<[string, unknown, string]> = [
    ['an Error', new Error('EACCES: permission denied'), 'EACCES: permission denied'],
    ['an Error with an empty message', new Error(''), 'Error'],
    ['an object with a message', { message: 'boom' }, 'boom'],
    ['a string', 'disk full', 'disk full'],
    ['a number', 42, '42'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
  ]

  it.each(CASES)('describes %s', (_name, e, text) => {
    expect(errorText(e)).toBe(text)
  })
})

describe('readJsonObject', () => {
  it('reports a file that does not exist as missing', () => {
    expect(readJsonObject(join(dir, 'settings.json'))).toEqual({ kind: 'missing' })
  })

  it('parses an object and hands back the exact text it read, BOM included', () => {
    const text = `${BOM}{\r\n  "model": "opus",\r\n  "permissions": { "allow": ["mcp__termpolis__memory_search"] }\r\n}\r\n`
    expect(readJsonObject(file('settings.json', text))).toEqual({
      kind: 'ok',
      value: { model: 'opus', permissions: { allow: ['mcp__termpolis__memory_search'] } },
      text,
    })
  })

  it.each([['an empty', ''], ['a blank', ' \r\n\t\n'], ['a BOM-only', BOM]])('reads %s file as an empty object', (_name, text) => {
    expect(readJsonObject(file('settings.json', text))).toEqual({ kind: 'ok', value: {}, text })
  })

  it('reports JSON it cannot parse, with the parser\'s reason', () => {
    const text = '{\n  "model": "opus",\n}\n'
    let reason = ''
    try { JSON.parse(text) } catch (e) { reason = (e as Error).message }
    expect(reason).not.toBe('')
    expect(readJsonObject(file('settings.json', text))).toEqual({ kind: 'error', error: `not valid JSON (${reason})` })
  })

  it.each([['null', 'null'], ['false', 'false'], ['a number', '42'], ['a string', '"opus"'], ['an array', '[{ "model": "opus" }]']])(
    'refuses a top level that is %s', (_name, text) => {
      expect(readJsonObject(file('settings.json', text))).toEqual({ kind: 'error', error: 'top level is not a JSON object' })
    },
  )

  it('refuses a file over the cap, counting bytes rather than characters', () => {
    const p = file('settings.json', '{"a":"é"}') // 9 characters, 10 bytes
    expect(readJsonObject(p, 10)).toEqual({ kind: 'ok', value: { a: 'é' }, text: '{"a":"é"}' })
    expect(readJsonObject(p, 9)).toEqual({ kind: 'error', error: 'larger than 9 bytes' })
  })

  it('caps a file at MAX_CONFIG_BYTES by default', () => {
    expect(MAX_CONFIG_BYTES).toBe(32 * 1024 * 1024)
    const p = file('settings.json', '{}')
    truncateSync(p, MAX_CONFIG_BYTES + 1)
    expect(readJsonObject(p)).toEqual({ kind: 'error', error: `larger than ${MAX_CONFIG_BYTES} bytes` })
  })

  it('reports a read failure instead of throwing', () => {
    mkdirSync(join(dir, 'settings.json'))
    const r = readJsonObject(join(dir, 'settings.json'))
    expect(r).toMatchObject({ kind: 'error', error: expect.stringMatching(/EISDIR/) })
  })
})

describe('formatJsonLike', () => {
  const value = { model: 'opus', permissions: { allow: ['mcp__termpolis__memory_search'] } }
  const twoSpaces = JSON.stringify(value, null, 2)

  it('writes a new file with a two-space indent, LF and a final newline', () => {
    expect(formatJsonLike(value, null)).toBe(`${twoSpaces}\n`)
  })

  it.each([['an empty', ''], ['a blank', '  \n']])('treats %s original like a new file', (_name, original) => {
    expect(formatJsonLike(value, original)).toBe(`${twoSpaces}\n`)
  })

  it('keeps a four-space indent', () => {
    expect(formatJsonLike(value, '{\n    "model": "sonnet"\n}\n')).toBe(`${JSON.stringify(value, null, 4)}\n`)
  })

  it('takes the indent from the first line with content, not from a line of stray spaces', () => {
    expect(formatJsonLike(value, '{\n  \n    "model": "sonnet"\n}\n')).toBe(`${JSON.stringify(value, null, 4)}\n`)
    expect(formatJsonLike(value, '{\r\n\t\r\n    "model": "sonnet"\r\n}\r\n')).toBe(`${JSON.stringify(value, null, 4)}\n`.replace(/\n/g, '\r\n'))
  })

  it('keeps a tab indent', () => {
    expect(formatJsonLike(value, '{\n\t"model": "sonnet"\n}\n')).toBe(`${JSON.stringify(value, null, '\t')}\n`)
  })

  it('keeps CRLF line endings, a BOM and a missing final newline', () => {
    expect(formatJsonLike(value, `${BOM}{\r\n  "model": "sonnet"\r\n}`)).toBe(BOM + twoSpaces.replace(/\n/g, '\r\n'))
  })

  it('switches every line to CRLF when the original has any', () => {
    expect(formatJsonLike(value, '{\n  "model": "sonnet"\r\n}\n')).toBe(`${twoSpaces}\n`.replace(/\n/g, '\r\n'))
  })

  it('pretty-prints a minified original with two spaces and adds no final newline it lacked', () => {
    expect(formatJsonLike(value, '{"model":"sonnet"}')).toBe(twoSpaces)
  })

  it('leaves a newline inside a string escaped when converting to CRLF', () => {
    expect(formatJsonLike({ note: 'line 1\nline 2' }, '{\r\n  "note": ""\r\n}\r\n')).toBe('{\r\n  "note": "line 1\\nline 2"\r\n}\r\n')
  })
})

describe('renameWithRetry', () => {
  const mocks = (fail: (call: number) => unknown) => {
    let call = 0
    const rename = vi.fn((_from: string, _to: string): void => {
      const e = fail(++call)
      if (e !== undefined) throw e
    })
    return { rename, sleep: vi.fn((_ms: number): void => {}) }
  }

  it('renames once when the first attempt works', () => {
    const { rename, sleep } = mocks(() => undefined)
    renameWithRetry('settings.json.tmp', 'settings.json', rename, sleep)
    expect(rename.mock.calls).toEqual([['settings.json.tmp', 'settings.json']])
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries sharing violations with a growing pause until the rename goes through', () => {
    const failures = [errno('EBUSY'), errno('EPERM'), errno('EACCES')]
    const { rename, sleep } = mocks((call) => failures[call - 1])
    renameWithRetry('settings.json.tmp', 'settings.json', rename, sleep)
    expect(rename.mock.calls).toEqual(Array(4).fill(['settings.json.tmp', 'settings.json']))
    expect(sleep.mock.calls).toEqual([[15], [30], [45]])
  })

  it('gives up after five attempts and throws the last error', () => {
    const errors = [1, 2, 3, 4, 5].map(() => errno('EBUSY'))
    const { rename, sleep } = mocks((call) => errors[call - 1])
    expect(thrown(() => renameWithRetry('settings.json.tmp', 'settings.json', rename, sleep))).toBe(errors[4])
    expect(rename).toHaveBeenCalledTimes(5)
    expect(sleep.mock.calls).toEqual([[15], [30], [45], [60]])
  })

  it('honours a smaller attempt count', () => {
    const { rename, sleep } = mocks(() => errno('EPERM'))
    expect(thrown(() => renameWithRetry('settings.json.tmp', 'settings.json', rename, sleep, 2))).toMatchObject({ code: 'EPERM' })
    expect(rename).toHaveBeenCalledTimes(2)
    expect(sleep.mock.calls).toEqual([[15]])
  })

  const FATAL: Array<[string, unknown]> = [
    ['a missing source (ENOENT)', errno('ENOENT')],
    ['a folder in the way (EISDIR)', errno('EISDIR')],
    ['an error with no code', new Error('rename failed')],
    ['a thrown string', 'rename failed'],
    ['a thrown null', null],
  ]

  it.each(FATAL)('fails at once on %s', (_name, failure) => {
    const { rename, sleep } = mocks(() => failure)
    expect(thrown(() => renameWithRetry('settings.json.tmp', 'settings.json', rename, sleep))).toBe(failure)
    expect(rename).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('really pauses between attempts by default', () => {
    const { rename } = mocks((call) => (call <= 2 ? errno('EBUSY') : undefined))
    const started = performance.now()
    renameWithRetry('settings.json.tmp', 'settings.json', rename)
    // 15 ms after the first failure, 30 ms after the second.
    expect(performance.now() - started).toBeGreaterThanOrEqual(40)
    expect(rename).toHaveBeenCalledTimes(3)
  })

  it('renames with fs by default', () => {
    const from = file('settings.json.tmp', '{"a":1}')
    const to = join(dir, 'settings.json')
    renameWithRetry(from, to)
    expect(readFileSync(to, 'utf-8')).toBe('{"a":1}')
    expect(existsSync(from)).toBe(false)
  })
})

describe('atomicWriteText', () => {
  it('creates a new file and leaves no temp file behind', () => {
    const p = join(dir, 'settings.json')
    atomicWriteText(p, '{\n  "a": 1\n}\n')
    expect(readFileSync(p, 'utf-8')).toBe('{\n  "a": 1\n}\n')
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('replaces an existing file whole', () => {
    const p = file('settings.json', '{\n  "a": 1,\n  "b": "a value much longer than the new text"\n}\n')
    atomicWriteText(p, '{}\n')
    expect(readFileSync(p, 'utf-8')).toBe('{}\n')
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('writes the text as UTF-8', () => {
    const p = join(dir, 'settings.json')
    atomicWriteText(p, `${BOM}{"name":"café 😀"}`)
    expect(readFileSync(p)).toEqual(Buffer.from(`${BOM}{"name":"café 😀"}`, 'utf-8'))
  })

  it('never writes the target directly: when the temp file cannot be made, the original stays whole', () => {
    const original = '{\n  "keep": true\n}\n'
    const p = file('settings.json', original)
    mkdirSync(join(dir, tmpName('settings.json'))) // something already occupies the temp file's name
    expect(() => atomicWriteText(p, '{}\n')).toThrow()
    expect(readFileSync(p, 'utf-8')).toBe(original)
  })

  it.skipIf(process.platform === 'win32')('keeps the permissions of the file it replaces, beyond what the umask allows', () => {
    for (const mode of [0o600, 0o640, 0o666, 0o444]) {
      const p = file(`settings-${mode.toString(8)}.json`, '{}\n')
      chmodSync(p, mode)
      atomicWriteText(p, '{"a":1}\n')
      expect(statSync(p).mode & 0o777, mode.toString(8)).toBe(mode)
      expect(readFileSync(p, 'utf-8')).toBe('{"a":1}\n')
    }
  })

  it.skipIf(process.platform === 'win32')('gives a new file the permissions any new file gets, not private ones', () => {
    const reference = file('reference.json', '') // 0o666 less whatever umask this machine has
    const p = join(dir, 'settings.json')
    atomicWriteText(p, '{}\n')
    expect(statSync(p).mode & 0o777).toBe(statSync(reference).mode & 0o777)
  })

  it.runIf(process.platform === 'win32')('fails on a read-only file on Windows only after riding out the retries, leaving it and no temp file behind', () => {
    const p = file('settings.json', '{"a":1}\n')
    chmodSync(p, 0o444)
    try {
      const started = performance.now()
      expect(thrown(() => atomicWriteText(p, '{"a":2}\n'))).toMatchObject({ code: 'EPERM' })
      // Windows reports a read-only target with the same EPERM as a passing sharing violation,
      // so the final rename goes through renameWithRetry: 15 + 30 + 45 + 60 ms of pauses.
      expect(performance.now() - started).toBeGreaterThanOrEqual(140)
      expect(readFileSync(p, 'utf-8')).toBe('{"a":1}\n')
      expect(readdirSync(dir)).toEqual(['settings.json'])
    } finally {
      chmodSync(p, 0o666)
    }
  })

  it('writes through a symlink to the real file and keeps the link', (ctx) => {
    const realDir = join(dir, 'dotfiles')
    const linkDir = join(dir, 'home')
    mkdirSync(realDir)
    mkdirSync(linkDir)
    const real = join(realDir, 'settings.json')
    const link = join(linkDir, 'settings.json')
    writeFileSync(real, '{}\n')
    try {
      symlinkSync(real, link, 'file')
    } catch {
      ctx.skip() // Windows without Developer Mode or admin rights can't make symlinks
      return
    }
    atomicWriteText(link, '{"a":1}\n')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf-8')).toBe('{"a":1}\n')
    // The temp file went beside the real file, and neither folder keeps one.
    expect(readdirSync(realDir)).toEqual(['settings.json'])
    expect(readdirSync(linkDir)).toEqual(['settings.json'])
  })

  it('writes through a symlink whose file does not exist yet, keeping the link', (ctx) => {
    // A dotfiles link made before the agent ever wrote its config.
    const realDir = join(dir, 'dotfiles')
    const linkDir = join(dir, 'home')
    mkdirSync(realDir)
    mkdirSync(linkDir)
    const real = join(realDir, 'settings.json')
    const link = join(linkDir, 'settings.json')
    try {
      symlinkSync(real, link, 'file')
    } catch {
      ctx.skip() // Windows without Developer Mode or admin rights can't make symlinks
      return
    }
    atomicWriteText(link, '{"a":1}\n')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf-8')).toBe('{"a":1}\n')
    expect(readdirSync(realDir)).toEqual(['settings.json'])
    expect(readdirSync(linkDir)).toEqual(['settings.json'])
  })

  it('follows a relative link, and a chain of links, to the missing file', (ctx) => {
    const realDir = join(dir, 'dotfiles')
    mkdirSync(realDir)
    const first = join(dir, 'settings.json')
    const second = join(dir, 'hop.json')
    try {
      symlinkSync('hop.json', first, 'file')
      symlinkSync(join('dotfiles', 'settings.json'), second, 'file')
    } catch {
      ctx.skip()
      return
    }
    atomicWriteText(first, '{}\n')
    expect(readFileSync(join(realDir, 'settings.json'), 'utf-8')).toBe('{}\n')
    expect(lstatSync(first).isSymbolicLink()).toBe(true)
    expect(lstatSync(second).isSymbolicLink()).toBe(true)
  })

  it('refuses a symlink loop instead of replacing a link in it', (ctx) => {
    const a = join(dir, 'a.json')
    const b = join(dir, 'b.json')
    try {
      symlinkSync(b, a, 'file')
      symlinkSync(a, b, 'file')
    } catch {
      ctx.skip()
      return
    }
    expect(thrown(() => atomicWriteText(a, '{}\n'))).toMatchObject({ message: expect.stringMatching(/too many levels of symbolic links/) })
    expect(lstatSync(a).isSymbolicLink()).toBe(true)
    expect(lstatSync(b).isSymbolicLink()).toBe(true)
    expect(readdirSync(dir).sort()).toEqual(['a.json', 'b.json'])
  })

  it('throws when the folder does not exist, creating nothing', () => {
    expect(thrown(() => atomicWriteText(join(dir, 'missing', 'settings.json'), '{}\n'))).toMatchObject({ code: 'ENOENT' })
    expect(readdirSync(dir)).toEqual([])
  })

  it('throws when a folder sits where the file should be, and removes its temp file', () => {
    const p = join(dir, 'settings.json')
    mkdirSync(p)
    expect(() => atomicWriteText(p, '{}\n')).toThrow()
    expect(statSync(p).isDirectory()).toBe(true)
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })
})

describe('editJsonObject', () => {
  it('writes a change in the file\'s own style', () => {
    const p = file('settings.json', `${BOM}{\r\n\t"model": "opus"\r\n}`)
    expect(editJsonObject(p, (o) => { o.permissions = { allow: ['mcp__termpolis__memory_search'] } })).toEqual({ status: 'written' })
    expect(readFileSync(p, 'utf-8')).toBe(
      `${BOM}{\r\n\t"model": "opus",\r\n\t"permissions": {\r\n\t\t"allow": [\r\n\t\t\t"mcp__termpolis__memory_search"\r\n\t\t]\r\n\t}\r\n}`,
    )
  })

  it('leaves the bytes alone when the content did not change', () => {
    const text = '{"model":"opus",   "permissions":{"allow":[]}}'
    const p = file('settings.json', text)
    const mutate = vi.fn((o: Record<string, any>) => { o.model = 'opus' })
    expect(editJsonObject(p, mutate)).toEqual({ status: 'unchanged' })
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(readFileSync(p, 'utf-8')).toBe(text)
  })

  it('never touches a file it cannot parse', () => {
    const text = '{\n  // my settings\n  "model": "opus"\n}\n'
    const p = file('settings.json', text)
    const mutate = vi.fn()
    expect(editJsonObject(p, mutate, { create: true })).toEqual({ status: 'error', error: expect.stringMatching(/^not valid JSON \(/) })
    expect(mutate).not.toHaveBeenCalled()
    expect(readFileSync(p, 'utf-8')).toBe(text)
  })

  it('does not create a missing file unless asked', () => {
    const p = join(dir, 'settings.json')
    const mutate = vi.fn((o: Record<string, any>) => { o.a = 1 })
    expect(editJsonObject(p, mutate)).toEqual({ status: 'missing' })
    expect(mutate).not.toHaveBeenCalled()
    expect(existsSync(p)).toBe(false)
  })

  it('creates a missing file when asked, in the new-file style', () => {
    const p = join(dir, 'settings.json')
    expect(editJsonObject(p, (o) => { o.mcpServers = { termpolis: { command: 'node' } } }, { create: true })).toEqual({ status: 'written' })
    expect(readFileSync(p, 'utf-8')).toBe('{\n  "mcpServers": {\n    "termpolis": {\n      "command": "node"\n    }\n  }\n}\n')
  })

  it('does not create a file when there is nothing to put in it', () => {
    const p = join(dir, 'settings.json')
    expect(editJsonObject(p, () => {}, { create: true })).toEqual({ status: 'unchanged' })
    expect(existsSync(p)).toBe(false)
  })

  it('fills an empty file in the new-file style', () => {
    const p = file('settings.json', '')
    expect(editJsonObject(p, (o) => { o.a = 1 })).toEqual({ status: 'written' })
    expect(readFileSync(p, 'utf-8')).toBe('{\n  "a": 1\n}\n')
  })

  it('reports a mutate that throws and writes nothing', () => {
    const text = '{"a":1}'
    const p = file('settings.json', text)
    expect(editJsonObject(p, (o) => { o.a = 2; throw new Error('unexpected hooks shape') }))
      .toEqual({ status: 'error', error: 'unexpected hooks shape' })
    expect(readFileSync(p, 'utf-8')).toBe(text)
  })

  it('reports a write that fails', () => {
    const p = join(dir, 'missing', 'settings.json')
    expect(editJsonObject(p, (o) => { o.a = 1 }, { create: true })).toEqual({ status: 'error', error: expect.stringMatching(/ENOENT/) })
    expect(existsSync(join(dir, 'missing'))).toBe(false)
  })
})

describe('readTextFile', () => {
  it('returns null for a file that does not exist', () => {
    expect(readTextFile(join(dir, 'config.toml'))).toBeNull()
  })

  it('returns the text as UTF-8, BOM and line endings untouched', () => {
    const text = `${BOM}model = "o3" # café\r\n`
    expect(readTextFile(file('config.toml', text))).toBe(text)
  })

  it('throws past the cap, counting bytes rather than characters', () => {
    const p = file('config.toml', 'é') // 1 character, 2 bytes
    expect(readTextFile(p, 2)).toBe('é')
    expect(() => readTextFile(p, 1)).toThrow('larger than 1 bytes')
  })

  it('caps a file at MAX_CONFIG_BYTES by default', () => {
    const p = file('config.toml', '')
    truncateSync(p, MAX_CONFIG_BYTES + 1)
    expect(() => readTextFile(p)).toThrow(`larger than ${MAX_CONFIG_BYTES} bytes`)
  })

  it('throws a read failure', () => {
    mkdirSync(join(dir, 'config.toml'))
    expect(() => readTextFile(join(dir, 'config.toml'))).toThrow(/EISDIR/)
  })
})
