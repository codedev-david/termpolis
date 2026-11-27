// The local https git server's tool check (tests/fixtures/gitHttps/server.ts), with no tool run at all:
// child_process is mocked so openssl or git "is missing". Locally that skips the fixture's tests; on CI
// (CI=true) it must fail them with a message naming the tool, so a runner that lost a tool cannot turn
// the private-repository proof into a silent skip.
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnSync = vi.fn()
vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:child_process')>()), spawnSync }))

const { execFileSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process')
const { fakeHelperConfig, fixtureSkipReason, fixtureToolsMissing, startGitHttps } = await import('../fixtures/gitHttps/server')

describe('the local https git server tool check', () => {
  const ci = process.env.CI
  afterEach(() => {
    if (ci === undefined) delete process.env.CI
    else process.env.CI = ci
    spawnSync.mockReset()
  })

  it('a missing openssl skips locally and fails on CI', () => {
    spawnSync.mockReturnValue({ status: null, error: new Error('ENOENT'), stdout: '' })
    delete process.env.CI
    expect(fixtureSkipReason()).toMatch(/openssl was not found/)
    process.env.CI = 'true'
    expect(() => fixtureSkipReason()).toThrow(/CI runner lacks: openssl was not found.*fails instead of skipping/)
  })

  it('a git without http-backend skips locally and fails on CI', () => {
    spawnSync.mockImplementation((cmd: string) =>
      /openssl/i.test(cmd) ? { status: 0, stdout: 'OpenSSL 3' } : { status: 0, stdout: '/no/such/git-core\n' }
    )
    delete process.env.CI
    expect(fixtureToolsMissing()).toMatch(/has no http-backend/)
    expect(fixtureSkipReason()).toMatch(/has no http-backend/)
    process.env.CI = 'true'
    expect(() => fixtureSkipReason()).toThrow(/has no http-backend/)
  })

  it('CI set to anything but "true" still skips', () => {
    spawnSync.mockReturnValue({ status: null, error: new Error('ENOENT'), stdout: '' })
    process.env.CI = 'false'
    expect(fixtureSkipReason()).toMatch(/openssl was not found/)
  })

  // Only openssl runs here (through execFile, which is not mocked): the start fails at the first mkdir,
  // before any git, because `dir` is a file.
  it('a start that fails after the certificate is made leaves no certificate folder behind', async () => {
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR }
    const scratch = fs.mkdtempSync(join(tmpdir(), 'lumopolis-fixture-start-'))
    const blocker = join(scratch, 'not-a-folder')
    fs.writeFileSync(blocker, '')
    const temp = join(scratch, 'tmp')
    fs.mkdirSync(temp)
    process.env.TEMP = process.env.TMP = process.env.TMPDIR = temp
    try {
      await expect(startGitHttps({ user: 'u', reply: 'r', dir: join(blocker, 'server') })).rejects.toThrow()
      expect(fs.readdirSync(temp)).toEqual([])
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  }, 60_000)

  // The config's helper line, run by git as git runs a `!` helper (through sh, the operation after it), from a folder whose
  // path holds a single quote, as a temporary folder's can: quoted as it was, the quote ended sh's string (holdb-review M10).
  it('names a helper script whose path holds a single quote', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "lumopolis-it's-"))
    try {
      const script = join(dir, 'say.sh')
      fs.writeFileSync(script, 'echo "sourced $1"\n')
      const config = join(dir, 'config')
      fs.writeFileSync(config, fakeHelperConfig(script))
      const line = execFileSync('git', ['config', '--file', config, '--list'], { encoding: 'utf8' }).trim()
      const run = line.slice(line.indexOf('=') + 1)
      expect(run.startsWith('!')).toBe(true)
      const said = execFileSync('git', ['-c', `alias.probe=${run}`, 'probe', 'get'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      expect(said.trim()).toBe('sourced get')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
