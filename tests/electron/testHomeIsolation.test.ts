// 1.54.5 test hygiene: a test run never reads or writes the developer's real home, and leaves no scratch home behind.
//
// os.homedir() reads HOME on POSIX and USERPROFILE on Windows, so a test that fakes only HOME still reads the real
// home on Windows (mainIngestMcpCoverage and claudeCodeWatcher both did once). The scan below fails on any test file
// that sets HOME without also setting USERPROFILE. The scratch agent home (tests/agentHomeScratch.ts) that
// tests/setup.ts and e2e/global-setup.ts create is removed when the file or the run ends; these tests pin that.

import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AGENT_HOME_PREFIX, isScratchAgentHome, makeScratchAgentHome } from '../agentHomeScratch'

const ROOT = path.resolve(__dirname, '..', '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

function testFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...testFiles(full)) }
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full)
  }
  return out
}

const SETS_HOME = /process\.env\.HOME\s*=(?!=)/
const SETS_PROFILE = /process\.env\.USERPROFILE\s*=(?!=)|process\.env\[k\]\s*=|TERMPOLIS_TEST_AGENT_HOME/
/** A file that assigns HOME must also assign USERPROFILE (or hand the code a scratch home another way). */
function fakesOnlyHome(src: string): boolean {
  return SETS_HOME.test(src) && !SETS_PROFILE.test(src)
}

describe('no test fakes HOME alone', () => {
  it('control: the check flags a file that sets HOME only, and passes one that sets both', () => {
    expect(fakesOnlyHome("process.env.HOME = dir\n")).toBe(true)
    expect(fakesOnlyHome("process.env.HOME = dir\nprocess.env.USERPROFILE = dir\n")).toBe(false)
    expect(fakesOnlyHome("if (process.env.HOME === x) {}\n")).toBe(false)
  })

  it('every test file under tests/ that sets HOME also sets USERPROFILE', () => {
    const files = testFiles(path.join(ROOT, 'tests'))
    expect(files.length).toBeGreaterThan(100)
    const offenders = files.filter((f) => fakesOnlyHome(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f))
    expect(offenders).toEqual([])
  })

  it('why both: with HOME and USERPROFILE pointed at a scratch folder, os.homedir() is that folder on this platform', () => {
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-home-check-'))
    try {
      process.env.HOME = fake
      process.env.USERPROFILE = fake
      expect(os.homedir()).toBe(fake)
    } finally {
      for (const k of ['HOME', 'USERPROFILE'] as const) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
      fs.rmSync(fake, { recursive: true, force: true })
    }
  })
})

describe('the scratch agent home', () => {
  const made: string[] = []
  afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

  it('this file runs with one: TERMPOLIS_TEST_AGENT_HOME is a scratch agent home that exists', () => {
    const dir = process.env.TERMPOLIS_TEST_AGENT_HOME!
    expect(isScratchAgentHome(dir)).toBe(true)
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('remove() deletes the folder and everything an app boot wrote in it, and is safe to call twice', () => {
    const home = makeScratchAgentHome()
    fs.mkdirSync(path.join(home.dir, '.claude', 'projects'), { recursive: true })
    fs.writeFileSync(path.join(home.dir, '.claude.json'), '{}')
    fs.writeFileSync(path.join(home.dir, '.claude', 'settings.json'), '{}')
    expect(home.remove()).toBe(true)
    expect(fs.existsSync(home.dir)).toBe(false)
    expect(home.remove()).toBe(true)
  })

  it('never deletes a folder that is not a scratch agent home directly in the temp folder', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-scratch-root-'))
    made.push(tmp)
    expect(isScratchAgentHome(path.join(tmp, `${AGENT_HOME_PREFIX}x`), os.tmpdir())).toBe(false)
    expect(isScratchAgentHome(path.join(os.tmpdir(), 'something-else'))).toBe(false)
    expect(isScratchAgentHome(path.join(os.tmpdir(), AGENT_HOME_PREFIX))).toBe(false)
    expect(isScratchAgentHome(os.homedir())).toBe(false)
    // A scratch home made under another root is judged against that root, and removed there.
    const nested = makeScratchAgentHome(tmp)
    expect(isScratchAgentHome(nested.dir, tmp)).toBe(true)
    expect(nested.remove()).toBe(true)
    expect(fs.existsSync(nested.dir)).toBe(false)
  })

  it('tests/setup.ts makes it through the helper and removes it in afterAll (once per test file)', () => {
    const src = read('tests/setup.ts')
    expect(src).toMatch(/const agentHome = makeScratchAgentHome\(\)/)
    expect(src).toMatch(/process\.env\.TERMPOLIS_TEST_AGENT_HOME = agentHome\.dir/)
    expect(src).toMatch(/afterAll\(\(\) => \{ agentHome\.remove\(\) \}\)/)
    expect(src).not.toMatch(/mkdtempSync/)
  })

  it('e2e/global-setup.ts makes it through the helper and returns the teardown that removes it', () => {
    const src = read('e2e/global-setup.ts')
    expect(src).toMatch(/const agentHome = makeScratchAgentHome\(\)/)
    expect(src).toMatch(/process\.env\.TERMPOLIS_TEST_AGENT_HOME = agentHome\.dir/)
    expect(src).toMatch(/return \(\) => \{ agentHome\.remove\(\) \}\s*\}\s*$/)
    expect(src).not.toMatch(/mkdtempSync/)
  })
})
