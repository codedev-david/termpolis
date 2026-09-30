import { describe, it, expect } from 'vitest'
import {
  HOME_TOKEN,
  USER_TOKEN,
  makeScrubber,
  scrubText,
  stripQuery,
  toAppPath,
  scrubEvent,
  scrubBreadcrumb,
  normalizeUpdaterSignature,
} from '../../src/shared/sentryScrub'

describe('scrubText — every user-path form, any case', () => {
  const cases: Array<[string, string]> = [
    ['open C:\\Users\\jdoe\\AppData\\x.json', 'open <home>\\AppData\\x.json'],
    ['{"p":"C:\\\\Users\\\\jdoe\\\\AppData"}', '{"p":"<home>\\\\AppData"}'],
    ['at C:/Users/jdoe/repos/a.ts', 'at <home>/repos/a.ts'],
    ['at /C:/Users/jdoe/repos/a.ts', 'at <home>/repos/a.ts'],
    ['file:///C:/Users/jdoe/AppData/index.html', '<home>/AppData/index.html'],
    ['file:///Users/jdoe/Library/x', '<home>/Library/x'],
    ['cd /Users/jdoe/code', 'cd <home>/code'],
    ['open /home/jdoe/.config/x', 'open <home>/.config/x'],
    ['c:\\USERS\\JDoe\\x', '<home>\\x'],
    ['FILE:///c:/users/jdoe/x', '<home>/x'],
    ['/USERS/jdoe', '<home>'],
    ['/HOME/jdoe', '<home>'],
    ['git bash /c/Users/jdoe/x', 'git bash <home>/x'],
    ['wsl /mnt/c/Users/jdoe/x', 'wsl <home>/x'],
    ['C:\\Documents and Settings\\jdoe\\x', '<home>\\x'],
    ["C:\\Users\\o'brien\\x", '<home>\\x'],
  ]
  for (const [input, expected] of cases) {
    it(`scrubs ${JSON.stringify(input)}`, () => {
      expect(scrubText(input)).toBe(expected)
    })
  }

  it('keeps a name with spaces whole when a separator follows, and prose when none does', () => {
    expect(scrubText('C:\\Users\\Jane Doe\\AppData')).toBe('<home>\\AppData')
    expect(scrubText('C:\\Users\\jane is read-only')).toBe('<home> is read-only')
  })

  it('leaves look-alikes alone: mid-word drives, URL paths, other roots', () => {
    expect(scrubText('xC:\\Users\\y')).toBe('xC:\\Users\\y')
    expect(scrubText('https://example.com/home/page')).toBe('https://example.com/home/page')
    expect(scrubText('/usr/local/bin')).toBe('/usr/local/bin')
    expect(scrubText('D:\\Projects\\x')).toBe('D:\\Projects\\x')
  })

  it('returns text with no separator untouched, and tolerates non-strings', () => {
    expect(scrubText('plain message')).toBe('plain message')
    expect(scrubText('')).toBe('')
    expect(makeScrubber()(undefined as unknown as string)).toBeUndefined()
  })

  it('exports stable tokens', () => {
    expect(HOME_TOKEN).toBe('<home>')
    expect(USER_TOKEN).toBe('<user>')
  })
})

describe('scrubText — main-process home directory and user name', () => {
  it('replaces a literal home the shapes miss, in either separator and any case', () => {
    const opts = { homeDir: 'D:\\Profiles\\jdoe\\' }
    expect(scrubText('D:\\Profiles\\jdoe\\x', opts)).toBe('<home>\\x')
    expect(scrubText('d:/profiles/JDOE/x', opts)).toBe('<home>/x')
    expect(scrubText('"D:\\\\Profiles\\\\jdoe\\\\x"', opts)).toBe('"<home>\\\\x"')
  })

  it('never takes the prefix of a longer name', () => {
    expect(scrubText('D:\\Profiles\\jdoex\\y', { homeDir: 'D:\\Profiles\\jdoe' })).toBe('D:\\Profiles\\jdoex\\y')
  })

  it('keeps the scheme slashes of a file URL to a POSIX home', () => {
    const opts = { homeDir: '/var/home/jdoe' }
    expect(scrubText('file:///var/home/jdoe/x', opts)).toBe('file://<home>/x')
    expect(scrubText('/var/home/jdoe', opts)).toBe('<home>')
  })

  it('ignores a home too short to be real', () => {
    expect(scrubText('/x/y', { homeDir: '/' })).toBe('/x/y')
    expect(scrubText('C:\\x', { homeDir: 'C:\\' })).toBe('C:\\x')
  })

  it('replaces the user name only as a path segment', () => {
    const opts = { userName: 'jdoe' }
    expect(scrubText('/tmp/jdoe/x', opts)).toBe('/tmp/<user>/x')
    expect(scrubText('E:\\JDOE', opts)).toBe('E:\\<user>')
    expect(scrubText('hello jdoe /x', opts)).toBe('hello jdoe /x')
    expect(scrubText('/tmp/jdoe2/x', opts)).toBe('/tmp/jdoe2/x')
  })

  it('ignores a one-letter user name', () => {
    expect(scrubText('/a/j/x', { userName: 'j' })).toBe('/a/j/x')
  })
})

describe('stripQuery', () => {
  it('drops the query string and fragment', () => {
    expect(stripQuery('https://a.test/b?token=1#frag')).toBe('https://a.test/b')
    expect(stripQuery('https://a.test/b#frag')).toBe('https://a.test/b')
    expect(stripQuery('https://a.test/b')).toBe('https://a.test/b')
  })
})

describe('toAppPath', () => {
  const scrub = makeScrubber()

  it('keeps paths that already name nothing on disk', () => {
    for (const p of ['app:///out/main/index.js', 'node:internal/x', 'internal/modules/cjs/loader.js', 'native', '<anonymous>']) {
      expect(toAppPath(p, scrub)).toBe(p)
    }
  })

  it('rewrites packaged and dev builds to the path inside the app', () => {
    expect(toAppPath('C:\\Users\\jdoe\\AppData\\Local\\Programs\\termpolis\\resources\\app.asar\\out\\main\\index.js', scrub))
      .toBe('app:///out/main/index.js')
    expect(toAppPath('/Applications/Termpolis.app/Contents/Resources/app.asar.unpacked/node_modules/x.node', scrub))
      .toBe('app:///node_modules/x.node')
    expect(toAppPath('file:///C:/Users/jdoe/repos/termpolis/out/renderer/assets/index.js', scrub))
      .toBe('app:///out/renderer/assets/index.js')
    expect(toAppPath('/home/jdoe/termpolis/out/preload/index.js', scrub)).toBe('app:///out/preload/index.js')
  })

  it('scrubs anything else outside the app', () => {
    expect(toAppPath('/home/jdoe/.nvm/lib/x.js', scrub)).toBe('<home>/.nvm/lib/x.js')
  })
})

describe('scrubEvent', () => {
  function sampleEvent(): Record<string, any> {
    return {
      message: 'failed to open C:\\Users\\jdoe\\secret.txt',
      server_name: 'JDOE-LAPTOP',
      user: { id: 'u', ip_address: '1.2.3.4' },
      exception: {
        values: [
          {
            type: 'Error',
            value: 'ENOENT /Users/jdoe/x',
            stacktrace: {
              frames: [
                {
                  filename: 'C:\\Users\\jdoe\\AppData\\Local\\Programs\\termpolis\\resources\\app.asar\\out\\main\\index.js',
                  abs_path: 'file:///C:/Users/jdoe/AppData/Local/Programs/termpolis/resources/app.asar/out/main/index.js',
                  vars: { secret: 'x' },
                  pre_context: ['a'],
                  context_line: 'b',
                  post_context: ['c'],
                },
                null,
              ],
            },
          },
          { type: 'NoStack' },
        ],
      },
      threads: { values: [{ stacktrace: { frames: [{ filename: '/home/jdoe/lib/t.js' }] } }] },
      stacktrace: { frames: [{ abs_path: '/Users/jdoe/top.js' }] },
      request: {
        url: 'file:///C:/Users/jdoe/AppData/Local/Programs/termpolis/resources/app.asar/out/renderer/index.html?x=1#/settings',
        cookies: { a: 'b' },
        query_string: 'x=1',
        data: 'body',
        headers: { Referer: 'file:///Users/jdoe/x.html' },
      },
      breadcrumbs: [
        { category: 'console', message: 'user typed a secret' },
        { category: 'fetch', data: { url: 'https://api.test/x?token=abc' } },
        { category: 'navigation', data: { from: 'file:///home/jdoe/a.html#x', to: '/b?y=1' } },
        { category: 'ui.click', message: 'div > span' },
      ],
      extra: { 'C:\\Users\\jdoe\\key': 'value at /home/jdoe/v', list: ['/Users/jdoe/a', 3] },
      contexts: { app: { cwd: '/home/jdoe/proj' } },
      tags: { path: 'C:/Users/jdoe/x' },
      sdkProcessingMetadata: { raw: 'C:\\Users\\jdoe\\keep-internal' },
    }
  }

  it('rewrites frames and drops locals and source lines', () => {
    const e = scrubEvent(sampleEvent())
    const frame = e.exception.values[0].stacktrace.frames[0]
    expect(frame.filename).toBe('app:///out/main/index.js')
    expect(frame.abs_path).toBe('app:///out/main/index.js')
    expect(frame).not.toHaveProperty('vars')
    expect(frame).not.toHaveProperty('pre_context')
    expect(frame).not.toHaveProperty('context_line')
    expect(frame).not.toHaveProperty('post_context')
    expect(e.threads.values[0].stacktrace.frames[0].filename).toBe('<home>/lib/t.js')
    expect(e.stacktrace.frames[0].abs_path).toBe('<home>/top.js')
    expect(e.exception.values[0].value).toBe('ENOENT <home>/x')
  })

  it('reduces the request to a query-less app URL and drops identifying fields', () => {
    const e = scrubEvent(sampleEvent())
    expect(e.request.url).toBe('app:///out/renderer/index.html')
    expect(e.request).not.toHaveProperty('cookies')
    expect(e.request).not.toHaveProperty('query_string')
    expect(e.request).not.toHaveProperty('data')
    expect(e.request.headers.Referer).toBe('<home>/x.html')
    expect(e).not.toHaveProperty('server_name')
    expect(e).not.toHaveProperty('user')
  })

  it('drops console breadcrumbs and strips URLs from request and navigation crumbs', () => {
    const e = scrubEvent(sampleEvent())
    expect(e.breadcrumbs.map((b: any) => b.category)).toEqual(['fetch', 'navigation', 'ui.click'])
    expect(e.breadcrumbs[0].data.url).toBe('https://api.test/x')
    expect(e.breadcrumbs[1].data.from).toBe('<home>/a.html')
    expect(e.breadcrumbs[1].data.to).toBe('/b')
  })

  it('scrubs message, extra (keys too), contexts and tags, but not SDK-internal metadata', () => {
    const e = scrubEvent(sampleEvent())
    expect(e.message).toBe('failed to open <home>\\secret.txt')
    expect(e.extra).toEqual({ '<home>\\key': 'value at <home>/v', list: ['<home>/a', 3] })
    expect(e.contexts.app.cwd).toBe('<home>/proj')
    expect(e.tags.path).toBe('<home>/x')
    expect(e.sdkProcessingMetadata.raw).toBe('C:\\Users\\jdoe\\keep-internal')
  })

  it('applies the main-process home and user name', () => {
    const e = scrubEvent(
      { message: 'D:\\Profiles\\jdoe\\x and /srv/jdoe/y' },
      { homeDir: 'D:\\Profiles\\jdoe', userName: 'jdoe' },
    )
    expect(e.message).toBe('<home>\\x and /srv/<user>/y')
  })

  it('survives cycles, shared references and very deep nesting', () => {
    const shared = { p: '/home/jdoe/s' }
    const cyclic: Record<string, any> = { p: '/Users/jdoe/c' }
    cyclic.self = cyclic
    let deep: Record<string, any> = { leaf: '/home/jdoe/deep' }
    for (let i = 0; i < 50; i++) deep = { next: deep }
    const e = scrubEvent({ extra: { a: shared, b: shared, cyclic, deep } })
    expect(e.extra.a.p).toBe('<home>/s')
    expect(e.extra.b).toBe(e.extra.a)
    expect(e.extra.cyclic.p).toBe('<home>/c')
    expect(e.extra.cyclic.self).toBe(e.extra.cyclic)
    let node = e.extra.deep
    let truncated = false
    for (let i = 0; i < 60 && node && typeof node === 'object'; i++) node = node.next
    if (node === '[Truncated]') truncated = true
    expect(truncated).toBe(true)
  })

  it('returns non-objects unchanged', () => {
    expect(scrubEvent(null)).toBeNull()
    expect(scrubEvent('x' as unknown as object)).toBe('x')
  })

  it('tolerates a request without a URL', () => {
    const e = scrubEvent({ request: { cookies: 'c' } } as Record<string, any>)
    expect(e.request).toEqual({})
  })
})

describe('scrubBreadcrumb', () => {
  it('drops console breadcrumbs', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'x' })).toBeNull()
  })

  it('strips and scrubs URL fields of request crumbs', () => {
    const crumb = scrubBreadcrumb({ category: 'electron.net', data: { url: 'file:///Users/jdoe/x?q=1', method: 'GET' } })
    expect(crumb).toEqual({ category: 'electron.net', data: { url: '<home>/x', method: 'GET' } })
  })

  it('scrubs other crumbs in full, and leaves URL fields of non-request crumbs to the walk', () => {
    const crumb = scrubBreadcrumb(
      { category: 'updater', message: 'C:\\Users\\jdoe\\x', data: { url: 'https://a.test/?q=1' } },
      { userName: 'jdoe' },
    )
    expect(crumb).toEqual({ category: 'updater', message: '<home>\\x', data: { url: 'https://a.test/?q=1' } })
  })

  it('ignores request crumbs whose data is not an object, and non-object crumbs', () => {
    expect(scrubBreadcrumb({ category: 'http', data: 'x' })).toEqual({ category: 'http', data: 'x' })
    expect(scrubBreadcrumb({ category: 'http', data: { url: 42 } })).toEqual({ category: 'http', data: { url: 42 } })
    expect(scrubBreadcrumb(null)).toBeNull()
    expect(scrubBreadcrumb(7 as unknown as object)).toBe(7)
  })
})

describe('normalizeUpdaterSignature', () => {
  it('replaces URLs and numbers', () => {
    expect(normalizeUpdaterSignature(
      'Cannot download "https://github.com/o/r/releases/download/v1.48.0/Termpolis-Setup-1.48.0.exe", status 404',
    )).toBe('Cannot download "<url>", status <n>')
  })

  it('makes the same failure on two machines one signature', () => {
    const a = normalizeUpdaterSignature("ENOENT: no such file or directory, open 'C:\\Users\\alice\\AppData\\Local\\termpolis-updater\\pending\\x.json'")
    const b = normalizeUpdaterSignature("ENOENT: no such file or directory, open 'c:\\users\\bob\\AppData\\Local\\termpolis-updater\\pending\\y.json'")
    expect(a).toBe(b)
    expect(a).toBe("ENOENT: no such file or directory, open '<path>'")
  })

  it('replaces drive, UNC, POSIX and already-scrubbed ~ paths', () => {
    expect(normalizeUpdaterSignature('EPERM D:\\Apps\\x.exe')).toBe('EPERM <path>')
    expect(normalizeUpdaterSignature("EBUSY open '~\\AppData\\Local\\termpolis-updater\\pending\\Setup 1.2.exe'"))
      .toBe("EBUSY open '<path> <n>.exe'")
    expect(normalizeUpdaterSignature('ENOSPC ~/Library/Caches/com.termpolis.ShipIt/x')).toBe('ENOSPC <path>')
    expect(normalizeUpdaterSignature('EACCES \\\\server\\share\\x')).toBe('EACCES <path>')
    expect(normalizeUpdaterSignature('ditto: /private/var/folders/ab/T/x.zip: No space left')).toBe('ditto: <path>: No space left')
  })

  it('replaces base64 hashes, hex ids and 0x values', () => {
    expect(normalizeUpdaterSignature('sha512 checksum mismatch, expected LS7sJ2Q9aZk3xY0pQ1wE8r== got abc'))
      .toBe('sha<n> checksum mismatch, expected <hash> got abc')
    expect(normalizeUpdaterSignature('request id deadbeef12 failed code 0x80070005'))
      .toBe('request id <hex> failed code <hex>')
    expect(normalizeUpdaterSignature('AlphabetOnlyLongWordHere stays')).toBe('AlphabetOnlyLongWordHere stays')
  })

  it('keeps only the first line, collapses whitespace and caps the length', () => {
    expect(normalizeUpdaterSignature('boom   here\nHeaders: {"set-cookie":"x"}')).toBe('boom here')
    expect(normalizeUpdaterSignature('x'.repeat(500))).toHaveLength(200)
  })

  it('falls back to "unknown" for empty input', () => {
    expect(normalizeUpdaterSignature('')).toBe('unknown')
    expect(normalizeUpdaterSignature('   ')).toBe('unknown')
    expect(normalizeUpdaterSignature(undefined as unknown as string)).toBe('unknown')
  })
})
