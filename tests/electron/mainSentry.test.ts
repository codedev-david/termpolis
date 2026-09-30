// Main-process Sentry (src/main/sentry.ts): the crash-tier gate, the live toggle, what init turns
// off, and the scrub every event and breadcrumb goes through before it can leave the machine.
// The SDK is injected (__setMainSentrySdkForTests): vi.mock can't intercept the lazy require().

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { homedir, tmpdir, userInfo } from 'os'
import { join, sep } from 'path'

const nodeRequire = createRequire(import.meta.url)
const DSN = 'https://fake@sentry.io/1'
const pkgVersion: string = nodeRequire('../../package.json').version

let tmpDir = ''

function makeSdk() {
  const options: Record<string, any> = {}
  const client = { getOptions: () => options }
  const sdk = {
    IPCMode: { Classic: 1, Protocol: 2, Both: 3 },
    makeElectronTransport: vi.fn(),
    init: vi.fn((opts: Record<string, any>) => {
      Object.assign(options, opts)
      sdk.initialised = true
    }),
    getClient: vi.fn(() => (sdk.initialised ? client : undefined)),
    initialised: false,
    options,
  }
  return sdk
}

type Choice = { crash?: boolean; usage?: boolean } | null

// Fresh telemetry + sentry modules (one registry, so sentry sees this telemetry), consent on file.
async function load(choice: Choice, sdk: any = makeSdk()) {
  vi.resetModules()
  const telemetry = await import('../../src/main/telemetry')
  const sentry = await import('../../src/main/sentry')
  telemetry.__resetTelemetryForTests()
  sentry.__resetMainSentryForTests()
  sentry.__setMainSentrySdkForTests(() => sdk)
  telemetry.initTelemetry(tmpDir, '1.48.0')
  if (choice) telemetry.setConsent(choice)
  return { telemetry, sentry, sdk }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'termpolis-main-sentry-'))
  process.env.SENTRY_DSN = DSN
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  delete process.env.SENTRY_DSN
  vi.restoreAllMocks()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('initMainSentry — the crash-tier gate', () => {
  it('does not start without a DSN, even with crash reports on', async () => {
    delete process.env.SENTRY_DSN
    const { sentry, sdk } = await load({ crash: true, usage: true })
    expect(sentry.initMainSentry()).toBe(false)
    expect(sdk.init).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('Sentry (main): no DSN configured (set SENTRY_DSN to enable)')
  })

  it('does not start when the user was never asked', async () => {
    const { sentry, sdk } = await load(null)
    expect(sentry.initMainSentry()).toBe(false)
    expect(sdk.init).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('Sentry (main): crash reports are off')
  })

  it('does not start on a pre-consent-v2 opt-in (the old pre-ticked checkbox)', async () => {
    writeFileSync(join(tmpDir, 'telemetry.json'), JSON.stringify({ optIn: true }))
    const { sentry, sdk } = await load(null)
    expect(sentry.initMainSentry()).toBe(false)
    expect(sdk.init).not.toHaveBeenCalled()
  })

  it('does not start with only usage statistics on', async () => {
    const { sentry, sdk } = await load({ crash: false, usage: true })
    expect(sentry.initMainSentry()).toBe(false)
    expect(sdk.init).not.toHaveBeenCalled()
  })

  it('starts with crash reports on, with everything beyond the error turned off', async () => {
    const { sentry, sdk } = await load({ crash: true })
    expect(sentry.initMainSentry()).toBe(true)
    expect(sdk.init).toHaveBeenCalledTimes(1)
    const opts = sdk.init.mock.calls[0][0]
    expect(opts).toMatchObject({
      dsn: DSN,
      release: `termpolis@${pkgVersion}`,
      sendDefaultPii: false,
      sendClientReports: false,
      attachScreenshot: false,
      includeLocalVariables: false,
      tracePropagationTargets: [],
      ipcMode: sdk.IPCMode.Classic,
    })
    // The plain transport, not the offline one that re-sends stored reports later.
    expect(opts.transport).toBe(sdk.makeElectronTransport)
    expect(opts.beforeSend).toBe(sentry.mainBeforeSend)
    expect(opts.beforeBreadcrumb).toBe(sentry.mainBeforeBreadcrumb)
    expect(opts.integrations).toBe(sentry.keepIntegrations)
    expect(console.log).toHaveBeenCalledWith('Sentry (main) initialized')
  })

  it('reports the environment from NODE_ENV, production when unset', async () => {
    const saved = process.env.NODE_ENV
    try {
      delete process.env.NODE_ENV
      const { sentry, sdk } = await load({ crash: true })
      sentry.initMainSentry()
      expect(sdk.init.mock.calls[0][0].environment).toBe('production')
    } finally {
      process.env.NODE_ENV = saved
    }
  })

  it('initialises at most once', async () => {
    const { sentry, sdk } = await load({ crash: true })
    expect(sentry.initMainSentry()).toBe(true)
    expect(sentry.initMainSentry()).toBe(true)
    expect(sdk.init).toHaveBeenCalledTimes(1)
  })

  it('an init that throws is non-fatal, and is not attempted again', async () => {
    const sdk = makeSdk()
    sdk.init.mockImplementation(() => {
      throw new Error('native binding missing')
    })
    const { sentry, telemetry } = await load({ crash: true }, sdk)
    expect(sentry.initMainSentry()).toBe(false)
    expect(console.log).toHaveBeenCalledWith('Sentry (main) init failed (non-fatal):', 'native binding missing')
    expect(sentry.initMainSentry()).toBe(false)
    telemetry.setConsent({ crash: false })
    telemetry.setConsent({ crash: true })
    expect(sdk.init).toHaveBeenCalledTimes(1)
  })

  it('an SDK that will not load is non-fatal, and is tried again when crash reports are turned on', async () => {
    const provider = vi.fn(() => {
      throw new Error('Cannot find module')
    })
    vi.resetModules()
    const telemetry = await import('../../src/main/telemetry')
    const sentry = await import('../../src/main/sentry')
    telemetry.__resetTelemetryForTests()
    sentry.__resetMainSentryForTests()
    sentry.__setMainSentrySdkForTests(provider)
    telemetry.initTelemetry(tmpDir, '1.48.0')
    telemetry.setConsent({ crash: true })
    expect(sentry.initMainSentry()).toBe(false)
    telemetry.setConsent({ crash: true })
    expect(provider).toHaveBeenCalledTimes(2)
  })

  it('uses the real lazy require() when no SDK was injected, and never throws out of it', async () => {
    // Outside Electron the real SDK's init() refuses to run (it needs process.versions.electron):
    // initMainSentry must report that as a failed start, never throw into the boot path.
    vi.resetModules()
    const telemetry = await import('../../src/main/telemetry')
    const sentry = await import('../../src/main/sentry')
    telemetry.__resetTelemetryForTests()
    sentry.__resetMainSentryForTests()
    telemetry.initTelemetry(tmpDir, '1.48.0')
    telemetry.setConsent({ crash: true })
    let started: boolean | undefined
    expect(() => {
      started = sentry.initMainSentry()
    }).not.toThrow()
    expect(started).toBe(false)
  }, 180_000)
})

describe('initMainSentry — consent changes apply at once', () => {
  it('turning crash reports off disables the running client; on enables it again', async () => {
    const { sentry, sdk, telemetry } = await load({ crash: true })
    sentry.initMainSentry()
    telemetry.setConsent({ crash: false })
    expect(sdk.options.enabled).toBe(false)
    telemetry.setConsent({ crash: true })
    expect(sdk.options.enabled).toBe(true)
    // Never a second init: the SDK sets OpenTelemetry up once per process.
    expect(sdk.init).toHaveBeenCalledTimes(1)
  })

  it('turning crash reports on starts Sentry when it was off at launch', async () => {
    const { sentry, sdk, telemetry } = await load(null)
    expect(sentry.initMainSentry()).toBe(false)
    telemetry.setConsent({ crash: true, usage: false })
    expect(sdk.init).toHaveBeenCalledTimes(1)
    telemetry.setConsent({ crash: false })
    expect(sdk.options.enabled).toBe(false)
  })

  it('a change to usage alone does not start crash reporting', async () => {
    const { sentry, sdk, telemetry } = await load(null)
    sentry.initMainSentry()
    telemetry.setConsent({ usage: true })
    expect(sdk.init).not.toHaveBeenCalled()
  })

  it('turning crash reports on without a DSN still sends nothing', async () => {
    delete process.env.SENTRY_DSN
    const { sentry, sdk, telemetry } = await load(null)
    sentry.initMainSentry()
    telemetry.setConsent({ crash: true })
    expect(sdk.init).not.toHaveBeenCalled()
  })

  it('subscribes to consent changes once, however often it is called', async () => {
    const { sentry, sdk, telemetry } = await load(null)
    sentry.initMainSentry()
    sentry.initMainSentry()
    telemetry.setConsent({ crash: true })
    expect(sdk.init).toHaveBeenCalledTimes(1)
  })

  it('tolerates an SDK that has no client to switch', async () => {
    const sdk = makeSdk()
    sdk.getClient.mockReturnValue(undefined)
    const { sentry, telemetry } = await load({ crash: true }, sdk)
    sentry.initMainSentry()
    expect(() => telemetry.setConsent({ crash: false })).not.toThrow()
    const bare = { ...makeSdk(), getClient: undefined }
    const second = await load({ crash: true }, bare)
    second.sentry.initMainSentry()
    expect(() => second.telemetry.setConsent({ crash: false })).not.toThrow()
  })
})

describe('keepIntegrations', () => {
  it('drops every default integration that gathers more than the error', () => {
    return import('../../src/main/sentry').then(({ keepIntegrations, DROPPED_INTEGRATIONS }) => {
      const defaults = [
        'SentryMinidump', 'ElectronBreadcrumbs', 'ElectronNet', 'ElectronContext', 'ChildProcess',
        'OnUncaughtException', 'PreloadInjection', 'AdditionalContext', 'Screenshots', 'GpuContext',
        'RendererEventLoopBlock', 'MainProcessSession', 'EventFilters', 'FunctionToString',
        'LinkedErrors', 'Console', 'NodeFetch', 'OnUnhandledRejection', 'ContextLines',
        'LocalVariables', 'Context', 'NormalizePaths',
      ].map((name) => ({ name }))
      expect(keepIntegrations(defaults).map((i) => i.name)).toEqual([
        'ElectronBreadcrumbs', 'ElectronContext', 'ChildProcess', 'OnUncaughtException',
        'PreloadInjection', 'AdditionalContext', 'GpuContext', 'RendererEventLoopBlock',
        'EventFilters', 'FunctionToString', 'LinkedErrors', 'OnUnhandledRejection', 'Context',
        'NormalizePaths',
      ])
      expect(DROPPED_INTEGRATIONS.has('ElectronMinidump')).toBe(true)
      expect(DROPPED_INTEGRATIONS.has('BrowserWindowSession')).toBe(true)
    })
  })

  it('the names it drops are names the installed SDK really uses', async () => {
    // A rename in an SDK upgrade would make the drop list silently drop nothing. The SDK can't be
    // loaded outside Electron (it reads electron.app at require time), so look for each name as a
    // string literal in its build instead.
    const { DROPPED_INTEGRATIONS } = await import('../../src/main/sentry')
    const roots = ['@sentry/electron/main', '@sentry/node/build/cjs', '@sentry/node-core/build/cjs', '@sentry/core/build/cjs']
      .map((pkg) => join(process.cwd(), 'node_modules', ...pkg.split('/')))
    const sources: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.js')) sources.push(readFileSync(full, 'utf8'))
      }
    }
    roots.forEach(walk)
    const sdkSource = sources.join('\n')
    const missing = [...DROPPED_INTEGRATIONS].filter((name) => !sdkSource.includes(`'${name}'`) && !sdkSource.includes(`"${name}"`))
    expect(missing).toEqual([])
  })
})

describe('mainBeforeSend — the gate', () => {
  it('sends nothing with crash reports off', async () => {
    const { sentry, telemetry } = await load({ crash: true })
    telemetry.setConsent({ crash: false })
    expect(sentry.mainBeforeSend({ message: 'boom' }, {})).toBeNull()
  })

  it('sends nothing when the user was never asked', async () => {
    const { sentry } = await load(null)
    expect(sentry.mainBeforeSend({ message: 'boom' }, {})).toBeNull()
  })

  it('drops benign updater noise', async () => {
    const { sentry } = await load({ crash: true })
    expect(sentry.mainBeforeSend({ message: 'updater error: net::ERR_INTERNET_DISCONNECTED' }, {})).toBeNull()
  })

  it('keeps a genuine error', async () => {
    const { sentry } = await load({ crash: true })
    const event = sentry.mainBeforeSend({ message: 'TypeError: x is undefined' }, {})
    expect(event.message).toBe('TypeError: x is undefined')
  })

  it('an updater filter that throws never swallows a real crash report', async () => {
    const { sentry } = await load({ crash: true })
    let tripped = false
    let message = 'real crash'
    const event: any = {}
    Object.defineProperty(event, 'message', {
      enumerable: true,
      configurable: true,
      get() {
        if (!tripped) {
          tripped = true
          throw new Error('filter tripped')
        }
        return message
      },
      set(value) {
        message = value
      },
    })
    expect(sentry.mainBeforeSend(event, {})?.message).toBe('real crash')
  })

  it('an event it cannot scrub is not sent', async () => {
    const { sentry } = await load({ crash: true })
    const event: any = { message: 'boom' }
    Object.defineProperty(event, 'extra', {
      enumerable: true,
      get() {
        throw new Error('unreadable')
      },
    })
    expect(sentry.mainBeforeSend(event, {})).toBeNull()
  })

  it('never sends an attachment', async () => {
    const { sentry } = await load({ crash: true })
    const hint = { attachments: [{ filename: 'screenshot.png', data: 'x' }] }
    sentry.mainBeforeSend({ message: 'boom' }, hint)
    expect(hint.attachments).toEqual([])
    expect(sentry.mainBeforeSend({ message: 'no hint' })?.message).toBe('no hint')
  })

  it('usage breadcrumbs ride along only while usage statistics are on', async () => {
    const crumbs = () => [
      { category: 'event', message: 'swarm.start' },
      { category: 'updater', message: 'updater: checking' },
    ]
    const off = await load({ crash: true, usage: false })
    const withoutUsage = off.sentry.mainBeforeSend({ message: 'boom', breadcrumbs: crumbs() }, {})
    expect(withoutUsage.breadcrumbs.map((c: any) => c.category)).toEqual(['updater'])
    const on = await load({ crash: true, usage: true })
    const withUsage = on.sentry.mainBeforeSend({ message: 'boom', breadcrumbs: crumbs() }, {})
    expect(withUsage.breadcrumbs.map((c: any) => c.category)).toEqual(['event', 'updater'])
  })

  it('removes locale, time zone and boot time, and keeps the rest of the device context', async () => {
    const { sentry } = await load({ crash: true })
    const event = sentry.mainBeforeSend({
      message: 'boom',
      contexts: {
        culture: { locale: 'de-DE', timezone: 'Europe/Berlin' },
        device: { boot_time: '2026-09-28T06:12:03.000Z', arch: 'x64', memory_size: 34359738368 },
        os: { name: 'Windows', version: '10.0.26200' },
      },
    }, {})
    expect(event.contexts.culture).toBeUndefined()
    expect(event.contexts.device).toEqual({ arch: 'x64', memory_size: 34359738368 })
    expect(event.contexts.os).toEqual({ name: 'Windows', version: '10.0.26200' })
    const noDevice = sentry.mainBeforeSend({ message: 'boom', contexts: { os: { name: 'Linux' } } }, {})
    expect(noDevice.contexts).toEqual({ os: { name: 'Linux' } })
  })

  it('drops the machine name and the user', async () => {
    const { sentry } = await load({ crash: true })
    const event = sentry.mainBeforeSend({
      message: 'boom',
      server_name: 'DESKTOP-JDOE',
      user: { id: '42', ip_address: '10.0.0.7', username: 'jdoe' },
    }, {})
    expect(event).not.toHaveProperty('server_name')
    expect(event).not.toHaveProperty('user')
  })
})

describe('mainBeforeSend — every user-path form, everywhere an event carries one', () => {
  // The standard shapes, which need no knowledge of this machine.
  const FORMS: Array<[string, string]> = [
    ['C:\\Users\\jdoe\\repo\\a.ts', '<home>\\repo\\a.ts'],
    ['c:\\users\\jdoe\\repo', '<home>\\repo'],
    ['C:\\\\Users\\\\jdoe\\\\repo', '<home>\\\\repo'],
    ['C:/Users/jdoe/repo', '<home>/repo'],
    ['file:///C:/Users/jdoe/repo/a.html', '<home>/repo/a.html'],
    ['/C:/Users/jdoe/repo', '<home>/repo'],
    ['C:\\Users\\Jane Doe\\repo', '<home>\\repo'],
    ['C:\\Documents and Settings\\jdoe\\x', '<home>\\x'],
    ['/Users/jdoe/repo', '<home>/repo'],
    ['file:///Users/jdoe/repo', '<home>/repo'],
    ['/home/jdoe/repo', '<home>/repo'],
    ['/c/Users/jdoe/repo', '<home>/repo'],
    ['/mnt/c/Users/jdoe/repo', '<home>/repo'],
  ]

  it.each(FORMS)('%s', async (raw, clean) => {
    const { sentry } = await load({ crash: true })
    const event = sentry.mainBeforeSend({
      message: `open failed: ${raw}`,
      exception: { values: [{ type: 'Error', value: `ENOENT '${raw}'` }] },
      extra: { cwd: raw, nested: { list: [raw] } },
      tags: { cwd: raw },
      contexts: { shell: { cwd: raw } },
      breadcrumbs: [{ category: 'terminal', message: `cd ${raw}`, data: { path: raw } }],
    }, {})
    expect(event.message).toBe(`open failed: ${clean}`)
    expect(event.exception.values[0].value).toBe(`ENOENT '${clean}'`)
    expect(event.extra).toEqual({ cwd: clean, nested: { list: [clean] } })
    expect(event.tags).toEqual({ cwd: clean })
    expect(event.contexts.shell).toEqual({ cwd: clean })
    expect(event.breadcrumbs[0]).toMatchObject({ message: `cd ${clean}`, data: { path: clean } })
  })

  it('rewrites stack frames to app:/// paths, without locals or source lines', async () => {
    const { sentry } = await load({ crash: true })
    const frames = [
      {
        filename: 'C:\\Users\\jdoe\\AppData\\Local\\Programs\\Termpolis\\resources\\app.asar\\out\\main\\index.js',
        abs_path: 'C:\\Users\\jdoe\\AppData\\Local\\Programs\\Termpolis\\resources\\app.asar\\out\\main\\index.js',
        vars: { apiKey: 'sk-ant-xxxx' },
        pre_context: ['const secret = 1'],
        context_line: 'throw new Error(secret)',
        post_context: ['}'],
      },
      { filename: '/home/jdoe/src/termpolis/out/main/index.js' },
      { filename: '/Applications/Termpolis.app/Contents/Resources/app.asar/node_modules/node-pty/lib/index.js' },
      { filename: 'C:\\Users\\jdoe\\.npm\\_npx\\cli.js' },
      { filename: 'node:internal/process/task_queues' },
    ]
    const event = sentry.mainBeforeSend({ exception: { values: [{ type: 'Error', value: 'x', stacktrace: { frames } }] } }, {})
    const out = event.exception.values[0].stacktrace.frames
    expect(out[0]).toEqual({ filename: 'app:///out/main/index.js', abs_path: 'app:///out/main/index.js' })
    expect(out[1].filename).toBe('app:///out/main/index.js')
    expect(out[2].filename).toBe('app:///node_modules/node-pty/lib/index.js')
    expect(out[3].filename).toBe('<home>\\.npm\\_npx\\cli.js')
    expect(out[4].filename).toBe('node:internal/process/task_queues')
  })

  it('reduces the request to a query-less app URL', async () => {
    const { sentry } = await load({ crash: true })
    const event = sentry.mainBeforeSend({
      message: 'boom',
      request: {
        url: 'file:///C:/Users/jdoe/AppData/Local/Programs/Termpolis/resources/app.asar/out/renderer/index.html?token=abc#t',
        cookies: { session: 's' },
        query_string: 'token=abc',
        data: 'body',
      },
    }, {})
    expect(event.request).toEqual({ url: 'app:///out/renderer/index.html' })
  })

  it("replaces this machine's real home directory and user name", async () => {
    const { sentry } = await load({ crash: true })
    const home = homedir()
    const name = userInfo().username
    const event = sentry.mainBeforeSend({
      message: `cannot read ${home}${sep}notes${sep}todo.md`,
      extra: { elsewhere: `D:${sep}work${sep}${name}${sep}plan.txt` },
    }, {})
    expect(event.message).toBe(`cannot read <home>${sep}notes${sep}todo.md`)
    expect(event.message).not.toContain(home)
    expect(event.extra.elsewhere).toBe(`D:${sep}work${sep}<user>${sep}plan.txt`)
  })

  it('catches a home the standard shapes miss, from os.homedir()', async () => {
    const { sentry } = await load({ crash: true })
    sentry.__setOsIdentityForTests({ homedir: () => 'D:\\Profiles\\jdoe', userInfo: () => ({ username: 'jdoe' }) })
    const event = sentry.mainBeforeSend({
      message: 'EPERM D:\\Profiles\\jdoe\\AppData\\x and d:/profiles/jdoe/y and E:\\share\\jdoe\\z',
    }, {})
    expect(event.message).toBe('EPERM <home>\\AppData\\x and <home>/y and E:\\share\\<user>\\z')
  })

  it('still scrubs the standard shapes when the OS will not say who the user is', async () => {
    const { sentry } = await load({ crash: true })
    sentry.__setOsIdentityForTests({
      homedir: () => {
        throw new Error('no home')
      },
      userInfo: () => {
        throw new Error('ENOENT: uv_os_get_passwd')
      },
    })
    const event = sentry.mainBeforeSend({ message: 'open C:\\Users\\jdoe\\x' }, {})
    expect(event.message).toBe('open <home>\\x')
  })
})

describe('mainBeforeBreadcrumb', () => {
  it('records nothing with crash reports off', async () => {
    const { sentry } = await load({ crash: false, usage: true })
    expect(sentry.mainBeforeBreadcrumb({ category: 'updater', message: 'x' })).toBeNull()
  })

  it('records usage events only while usage statistics are on', async () => {
    const off = await load({ crash: true, usage: false })
    expect(off.sentry.mainBeforeBreadcrumb({ category: 'event', message: 'swarm.start' })).toBeNull()
    const on = await load({ crash: true, usage: true })
    expect(on.sentry.mainBeforeBreadcrumb({ category: 'event', message: 'swarm.start' })).toEqual({ category: 'event', message: 'swarm.start' })
  })

  it('never records console output', async () => {
    const { sentry } = await load({ crash: true })
    expect(sentry.mainBeforeBreadcrumb({ category: 'console', message: 'PS C:\\Users\\jdoe>' })).toBeNull()
  })

  it('scrubs paths and strips query strings from request URLs', async () => {
    const { sentry } = await load({ crash: true })
    expect(sentry.mainBeforeBreadcrumb({ category: 'swarm', message: 'persist C:\\Users\\jdoe\\m.json', data: { dir: '/home/jdoe/x' } }))
      .toEqual({ category: 'swarm', message: 'persist <home>\\m.json', data: { dir: '<home>/x' } })
    expect(sentry.mainBeforeBreadcrumb({ category: 'electron.net', data: { url: 'https://api.github.com/repos?access_token=abc' } }))
      .toEqual({ category: 'electron.net', data: { url: 'https://api.github.com/repos' } })
  })

  it('passes a crumb without a category through the scrub', async () => {
    const { sentry } = await load({ crash: true })
    expect(sentry.mainBeforeBreadcrumb({ message: '/Users/jdoe/x' })).toEqual({ message: '<home>/x' })
  })

  it('a breadcrumb it cannot scrub is not recorded', async () => {
    const { sentry } = await load({ crash: true })
    const crumb: any = { category: 'swarm' }
    Object.defineProperty(crumb, 'data', {
      enumerable: true,
      get() {
        throw new Error('unreadable')
      },
    })
    expect(sentry.mainBeforeBreadcrumb(crumb)).toBeNull()
  })
})
