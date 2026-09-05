import { describe, expect, it } from 'vitest'
// Read at transform time by Vite, not at run time by the Worker: workerd has no
// filesystem, and `nodejs_compat` does not give it one. `?raw` hands the file's
// text to the bundle, which is all this suite needs.
import wranglerToml from '../wrangler.toml?raw'

// Everything asserted here is a decision made once, in a file nothing else
// reads, whose consequences show up only on a deploy -- or, in the case of the
// storage backend, on the FIRST deploy and never again. The rest of the suite
// runs against whatever wrangler.toml says; this is the part that says whether
// wrangler.toml still says the right thing.
describe('wrangler.toml', () => {
  it('backs the Durable Object with SQLite, not KV', () => {
    // The one irreversible line in this repository. A class deployed under
    // `new_classes` cannot be migrated to SQLite afterwards, and `new_classes`
    // requires Workers Paid -- so the KV form would quietly make the free plan
    // impossible forever, on the strength of one word nobody would reread.
    expect(wranglerToml).toMatch(/new_sqlite_classes\s*=\s*\[\s*"PairingRoom"\s*\]/)
    expect(wranglerToml).not.toMatch(/^\s*new_classes\s*=/m)
  })

  it('binds exactly the Durable Object class the Worker exports', () => {
    // A binding whose class_name does not match an export fails at deploy time
    // with a message about the class, not about this file.
    expect(wranglerToml).toMatch(/name\s*=\s*"PAIRING_ROOM"/)
    expect(wranglerToml).toMatch(/class_name\s*=\s*"PairingRoom"/)
  })

  it('keeps the registration rate limit at 30 a minute', () => {
    // Room creation is limited at the edge because a per-room quota cannot stop
    // someone opening a million rooms. Far above any real pairing rate, far
    // below what makes room creation a useful amplifier.
    expect(wranglerToml).toMatch(/type\s*=\s*"ratelimit"/)
    expect(wranglerToml).toMatch(/name\s*=\s*"REGISTRATIONS"/)
    expect(wranglerToml).toMatch(/limit\s*=\s*30/)
    expect(wranglerToml).toMatch(/period\s*=\s*60/)
  })

  it('declares no secrets, no vars and no KV', () => {
    // The relay holds no keys and reads no payload. Nothing it needs is secret,
    // so anything that looks like configuration arriving from outside the code
    // is a change of character worth noticing here.
    expect(wranglerToml).not.toMatch(/^\s*\[vars\]/m)
    expect(wranglerToml).not.toMatch(/kv_namespaces/)
    expect(wranglerToml).not.toMatch(/\bsecret\b/i)
  })

  it('names the Worker what DEPLOY.md and the deploy workflow name it', () => {
    expect(wranglerToml).toMatch(/^name\s*=\s*"termpolis-relay"/m)
    expect(wranglerToml).toMatch(/^main\s*=\s*"src\/index\.ts"/m)
  })
})
