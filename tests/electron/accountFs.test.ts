// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CREDENTIAL_BASENAMES, CredentialPathError, MAX_READ_BYTES, accountFs, accountFsAsync, assertNotCredential, isCredentialPath,
  isSameOrInside, readClaudeJsonFields,
} from '../../src/main/accountFs'

let root: string
const links: string[] = []

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tp-acctfs-')))
})

afterEach(() => {
  for (const l of links.splice(0)) {
    try { unlinkSync(l) } catch { try { rmdirSync(l) } catch { /* gone */ } }
  }
  rmSync(root, { recursive: true, force: true })
})

describe('the credential tripwire', () => {
  it('names the sign-in files of every agent and the credential folders', () => {
    expect([...CREDENTIAL_BASENAMES].sort()).toEqual(['.credentials.json', '.git-credentials', 'auth.json', 'mcp-oauth-tokens.json', 'oauth_creds.json'])
    for (const n of CREDENTIAL_BASENAMES) {
      expect(isCredentialPath(join(root, 'profile', n))).toBe(true)
      expect(isCredentialPath(join(root, 'profile', n.toUpperCase()))).toBe(process.platform === 'win32' || process.platform === 'darwin')
    }
    expect(isCredentialPath(join(root, '.ssh', 'id_ed25519'))).toBe(true)
    expect(isCredentialPath(join(root, '.aws', 'credentials'))).toBe(true)
    expect(isCredentialPath(join(root, '.ssh'))).toBe(true)
    expect(isCredentialPath(join(root, 'profile', 'settings.json'))).toBe(false)
    expect(isCredentialPath(join(root, 'my.sshfile'))).toBe(false)
  })

  it('refuses every operation on a sign-in file or a credential folder, before touching the disk', () => {
    const bad = [
      ...CREDENTIAL_BASENAMES.map((n) => join(root, 'p', n)),
      join(root, '.ssh', 'config'),
      join(root, '.aws'),
    ]
    for (const p of bad) {
      expect(() => assertNotCredential(p)).toThrow(CredentialPathError)
      expect(() => accountFs.exists(p)).toThrow(CredentialPathError)
      expect(() => accountFs.lstat(p)).toThrow(CredentialPathError)
      expect(() => accountFs.stat(p)).toThrow(CredentialPathError)
      expect(() => accountFs.readText(p)).toThrow(CredentialPathError)
      expect(() => accountFs.readDir(p)).toThrow(CredentialPathError)
      expect(() => accountFs.readLink(p)).toThrow(CredentialPathError)
      expect(() => accountFs.realpath(p)).toThrow(CredentialPathError)
      expect(() => accountFs.mkdir(p)).toThrow(CredentialPathError)
      expect(() => accountFs.link(p, join(root, 'l'))).toThrow(CredentialPathError)
      expect(() => accountFs.link(join(root, 't'), p)).toThrow(CredentialPathError)
      expect(() => accountFs.unlinkLink(p)).toThrow(CredentialPathError)
      expect(() => accountFs.removeFile(p)).toThrow(CredentialPathError)
      expect(() => accountFs.removeEmptyDir(p)).toThrow(CredentialPathError)
      expect(() => accountFs.rename(p, join(root, 'x'))).toThrow(CredentialPathError)
      expect(() => accountFs.rename(join(root, 'x'), p)).toThrow(CredentialPathError)
      expect(() => accountFs.writePrivate(p, 'x')).toThrow(CredentialPathError)
      expect(() => accountFs.copyFile(p, join(root, 'x'))).toThrow(CredentialPathError)
      expect(() => accountFs.copyFile(join(root, 'x'), p)).toThrow(CredentialPathError)
      expect(readClaudeJsonFields(p, ['a'])).toEqual({ kind: 'unreadable' })
    }
    // Nothing was created by any of those calls.
    expect(readdirSync(root)).toEqual([])
  })

  // SAFETY-M1: the ingest timer's async seam (loadAccountsAsync, liveProfileDirAsync, profileTranscriptRootsAsync) is a door
  // of its own, and refuses the same paths. The files exist, so a seam that stopped refusing would find or read them.
  it('the async seam refuses a sign-in file or a credential folder that exists, and reads nothing of it', async () => {
    const planted = 'planted-' + 'a'.repeat(30)
    mkdirSync(join(root, 'p'))
    mkdirSync(join(root, '.ssh'))
    mkdirSync(join(root, '.aws'))
    const bad = [
      ...CREDENTIAL_BASENAMES.map((n) => join(root, 'p', n)),
      join(root, '.ssh', 'config'),
      join(root, '.aws', 'credentials'),
    ]
    for (const p of bad) writeFileSync(p, planted)
    for (const p of [...bad, join(root, '.ssh'), join(root, '.aws')]) {
      await expect(accountFsAsync.exists(p)).rejects.toThrow(CredentialPathError)
      await expect(accountFsAsync.readText(p)).rejects.toThrow(CredentialPathError)
    }
  })

  it('the async seam reads .claude.json only through readClaudeJsonFields', async () => {
    const file = join(root, '.claude.json')
    writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' } }))
    await expect(accountFsAsync.readText(file)).rejects.toThrow(/\.claude\.json/)
    // Telling whether it is there is no read of it.
    await expect(accountFsAsync.exists(file)).resolves.toBe(true)
  })

  it('the async seam reads a plain file up to its cap, and answers null for a missing one', async () => {
    const file = join(root, 'agent-accounts.json')
    writeFileSync(file, '{"accounts":[]}')
    await expect(accountFsAsync.exists(file)).resolves.toBe(true)
    await expect(accountFsAsync.readText(file)).resolves.toBe('{"accounts":[]}')
    await expect(accountFsAsync.readText(file, 4)).rejects.toThrow('larger than 4 bytes')
    expect(MAX_READ_BYTES).toBe(4 * 1024 * 1024)
    await expect(accountFsAsync.exists(join(root, 'none.json'))).resolves.toBe(false)
    await expect(accountFsAsync.readText(join(root, 'none.json'))).resolves.toBeNull()
  })

  // SAFETY-R2-3 (b): the source of a copy is guarded on its own. The carry stats each source first, so no live path reaches
  // it with a sign-in file, but the seam must not depend on that: a sign-in file that EXISTS is not copied, whatever the
  // destination, and the destination is not created.
  it('refuses to copy a sign-in file that exists, or .claude.json, and creates nothing', () => {
    mkdirSync(join(root, 'p'))
    const planted = 'planted-' + 'a'.repeat(30)
    for (const n of CREDENTIAL_BASENAMES) {
      const from = join(root, 'p', n)
      writeFileSync(from, planted)
      expect(() => accountFs.copyFile(from, join(root, 'copy'))).toThrow(CredentialPathError)
      expect(existsSync(join(root, 'copy'))).toBe(false)
      expect(() => accountFs.copyFile(join(root, 'p', 'plain.json'), join(root, 'p', n))).toThrow(CredentialPathError)
    }
    const json = join(root, 'p', '.claude.json')
    writeFileSync(json, '{"a":1}')
    expect(() => accountFs.copyFile(json, join(root, 'copy'))).toThrow(/named fields/)
    expect(existsSync(join(root, 'copy'))).toBe(false)
    writeFileSync(join(root, 'p', 'plain.json'), '{}')
    expect(() => accountFs.copyFile(join(root, 'p', 'plain.json'), join(root, 'q', '.claude.json'))).toThrow(/never copied/)
    // A plain file still copies, so the refusals above are the guard's and not a broken copy.
    accountFs.copyFile(join(root, 'p', 'plain.json'), join(root, 'copy'))
    expect(readFileSync(join(root, 'copy'), 'utf8')).toBe('{}')
  })

  it('refuses an empty or non-string path', () => {
    expect(() => assertNotCredential('')).toThrow(CredentialPathError)
    expect(() => assertNotCredential(undefined as unknown as string)).toThrow(CredentialPathError)
  })

  it('never reads .claude.json whole, and never writes it', () => {
    const f = join(root, '.claude.json')
    writeFileSync(f, '{}')
    expect(() => accountFs.readText(f)).toThrow(/named fields/)
    expect(() => accountFs.writePrivate(f, '{}')).toThrow(/agent integration/)
    expect(readFileSync(f, 'utf8')).toBe('{}')
  })
})

describe('readClaudeJsonFields (R12)', () => {
  const KEY = 'sk-ant-' + 'a'.repeat(40)

  it('returns the named scalar fields only, never the key a Console sign-in keeps there', () => {
    const f = join(root, '.claude.json')
    writeFileSync(f, '\uFEFF' + JSON.stringify({ primaryApiKey: KEY, oauthAccount: { emailAddress: 'me@example.test', n: 3, ok: true, obj: {} }, userID: 'u' }))
    const r = readClaudeJsonFields(f, ['oauthAccount.emailAddress', 'oauthAccount.n', 'oauthAccount.ok', 'oauthAccount.obj', 'missing.deep'])
    expect(r).toEqual({
      kind: 'ok',
      values: { 'oauthAccount.emailAddress': 'me@example.test', 'oauthAccount.n': 3, 'oauthAccount.ok': true, 'oauthAccount.obj': undefined, 'missing.deep': undefined },
    })
    expect(JSON.stringify(r)).not.toContain(KEY)
    expect(JSON.stringify(r)).not.toContain('userID')
  })

  it('says missing, or unreadable with no content, for a file it cannot use', () => {
    expect(readClaudeJsonFields(join(root, '.claude.json'), ['a'])).toEqual({ kind: 'missing' })
    const bad = join(root, 'p', '.claude.json')
    mkdirSync(join(root, 'p'))
    writeFileSync(bad, `{"primaryApiKey":"${KEY}", oops`)
    const r = readClaudeJsonFields(bad, ['primaryApiKey'])
    expect(r).toEqual({ kind: 'unreadable' })
    expect(JSON.stringify(r)).not.toContain(KEY)
    writeFileSync(bad, '[1,2]')
    expect(readClaudeJsonFields(bad, ['0'])).toEqual({ kind: 'ok', values: { 0: undefined } })
    writeFileSync(bad, '   ')
    expect(readClaudeJsonFields(bad, ['a'])).toEqual({ kind: 'ok', values: { a: undefined } })
  })

  it('reads only a file named .claude.json', () => {
    const f = join(root, 'settings.json')
    writeFileSync(f, '{"a":"b"}')
    expect(readClaudeJsonFields(f, ['a'])).toEqual({ kind: 'unreadable' })
  })

  it('refuses a .claude.json larger than any real one', () => {
    const f = join(root, '.claude.json')
    writeFileSync(f, '{"a":"' + 'x'.repeat(32 * 1024 * 1024) + '"}')
    expect(readClaudeJsonFields(f, ['a'])).toEqual({ kind: 'unreadable' })
  })
})

describe('the operations', () => {
  it('reads text up to a cap, and says null for a missing file', () => {
    const f = join(root, 'a.txt')
    writeFileSync(f, 'hello')
    expect(accountFs.readText(f)).toBe('hello')
    expect(accountFs.readText(join(root, 'none.txt'))).toBeNull()
    expect(() => accountFs.readText(f, 3)).toThrow(/larger than 3 bytes/)
  })

  it('answers exists, lstat, stat, realpath and readLink without throwing for a missing path', () => {
    const p = join(root, 'nope')
    expect(accountFs.exists(p)).toBe(false)
    expect(accountFs.lstat(p)).toBeNull()
    expect(accountFs.stat(p)).toBeNull()
    expect(accountFs.realpath(p)).toBeNull()
    expect(accountFs.readLink(p)).toBeNull()
    expect(accountFs.readDir(root)).toEqual([])
  })

  it('makes a folder, private on POSIX', () => {
    const d = join(root, 'd')
    accountFs.mkdir(d)
    expect(statSync(d).isDirectory()).toBe(true)
    if (process.platform !== 'win32') expect(statSync(d).mode & 0o777).toBe(0o700)
  })

  it('links a folder as a junction on Windows and a symlink elsewhere, and removes only the link', () => {
    const target = join(root, 'target')
    mkdirSync(target)
    writeFileSync(join(target, 'keep.txt'), 'x')
    const at = join(root, 'link')
    accountFs.link(target, at)
    links.push(at)
    expect(lstatSync(at).isSymbolicLink()).toBe(true)
    expect(accountFs.readLink(at)).toBeTruthy()
    expect(accountFs.realpath(at)).toBe(realpathSync.native(target))
    accountFs.unlinkLink(at)
    links.pop()
    expect(existsSync(at)).toBe(false)
    // The folder the link pointed at, and what is in it, are untouched.
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('x')
  })

  it('refuses to unlink anything that is not a link, so a real folder is never removed that way', () => {
    const d = join(root, 'real')
    mkdirSync(d)
    expect(() => accountFs.unlinkLink(d)).toThrow(/not a link/)
    expect(existsSync(d)).toBe(true)
  })

  it('removes files only, and folders only when empty', () => {
    const d = join(root, 'dir')
    mkdirSync(d)
    writeFileSync(join(d, 'f'), 'x')
    expect(() => accountFs.removeFile(d)).toThrow(/not a file/)
    expect(() => accountFs.removeEmptyDir(d)).toThrow()
    accountFs.removeFile(join(d, 'f'))
    accountFs.removeEmptyDir(d)
    expect(existsSync(d)).toBe(false)
  })

  it('renames, and writes a private file atomically with no temp file left behind', () => {
    const a = join(root, 'a')
    mkdirSync(a)
    accountFs.rename(a, join(root, 'b'))
    expect(existsSync(join(root, 'b'))).toBe(true)
    const f = join(root, 'agent-accounts.json')
    accountFs.writePrivate(f, '{"version":1}\n')
    accountFs.writePrivate(f, '{"version":1,"x":2}\n')
    expect(readFileSync(f, 'utf8')).toBe('{"version":1,"x":2}\n')
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o600)
    expect(readdirSync(root).filter((n) => n.includes('.tmp'))).toEqual([])
  })

  it('leaves no temp file when a private write fails', () => {
    const target = join(root, 'blocked')
    mkdirSync(target)
    // A folder where the file should go: the rename fails.
    expect(() => accountFs.writePrivate(target, 'x')).toThrow()
    expect(readdirSync(root).filter((n) => n.includes('.tmp'))).toEqual([])
    // And one whose temp file can't even be made.
    expect(() => accountFs.writePrivate(join(root, 'no', 'such', 'dir', 'f.json'), 'x')).toThrow()
  })
})

describe('isSameOrInside', () => {
  it('is the same folder or one inside it, never a sibling with a longer name', () => {
    const sep = process.platform === 'win32' ? '\\' : '/'
    const p = ['', 'home', 'me', '.claude'].join(sep)
    expect(isSameOrInside(p, p)).toBe(true)
    expect(isSameOrInside(p + sep, p)).toBe(true)
    expect(isSameOrInside(p + sep + 'projects', p)).toBe(true)
    expect(isSameOrInside(p + '/projects', p)).toBe(true)
    expect(isSameOrInside(p + '-codedev', p)).toBe(false)
    expect(isSameOrInside(['', 'home', 'me'].join(sep), p)).toBe(false)
  })

  it('folds case where the filesystem does', () => {
    expect(isSameOrInside('C:\\Users\\ME\\.claude\\x', 'c:\\users\\me\\.claude')).toBe(process.platform === 'win32' || process.platform === 'darwin')
  })
})

describe('symlinks made outside the seam', () => {
  it('readLink reads a plain symlink too', () => {
    const target = join(root, 't2')
    mkdirSync(target)
    const at = join(root, 'l2')
    symlinkSync(target, at, 'junction')
    links.push(at)
    expect(accountFs.readLink(at)).not.toBeNull()
  })
})

/** Run `fn` with `process.platform` reporting `platform`. */
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...original, value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

describe('on each platform', () => {
  it('folds case only where the filesystem does', () => {
    expect(withPlatform('linux', () => isCredentialPath('/p/AUTH.JSON'))).toBe(false)
    expect(withPlatform('linux', () => isCredentialPath('/p/auth.json'))).toBe(true)
    expect(withPlatform('darwin', () => isCredentialPath('/p/AUTH.JSON'))).toBe(true)
    expect(withPlatform('linux', () => isSameOrInside('/A/b', '/a'))).toBe(false)
  })

  it('removes a link with unlink where links are symlinks', () => {
    const target = join(root, 'target-posix')
    mkdirSync(target)
    const at = join(root, 'link-posix')
    symlinkSync(target, at, 'junction')
    links.push(at)
    withPlatform('linux', () => accountFs.unlinkLink(at))
    links.pop()
    expect(existsSync(at)).toBe(false)
    expect(existsSync(target)).toBe(true)
  })
})

describe('a link where links are symlinks', () => {
  it('asks for a directory symlink, which Windows grants only with developer mode', () => {
    const target = join(root, 'target-dir-link')
    mkdirSync(target)
    const at = join(root, 'dir-link')
    let made = false
    try {
      withPlatform('linux', () => accountFs.link(target, at))
      made = true
      links.push(at)
    } catch (e) {
      // No developer mode on this Windows box: a junction would have worked, so 'junction' was not asked for.
      expect((e as NodeJS.ErrnoException).code).toBe('EPERM')
    }
    if (made) expect(lstatSync(at).isSymbolicLink()).toBe(true)
  })
})
