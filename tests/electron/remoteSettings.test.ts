import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  DEFAULT_RELAY_URL,
  loadRemoteSettings,
  remoteSettingsPath,
  saveRemoteSettings,
} from '../../src/main/remoteSettings'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-settings-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('remoteSettings', () => {
  it('defaults to disabled', () => {
    // Remote opens a network-facing channel into every terminal on this machine.
    // An upgrade that silently turned it on would be indistinguishable from a
    // compromise, so it stays off until the user asks for it.
    expect(loadRemoteSettings(dir)).toEqual({ enabled: false, relayUrl: DEFAULT_RELAY_URL })
  })

  it('falls back to defaults for a missing, corrupt or wrong-shaped file', () => {
    for (const raw of ['{ not json', '"a string"', '[]', 'null']) {
      fs.writeFileSync(remoteSettingsPath(dir), raw)
      expect(loadRemoteSettings(dir)).toEqual({ enabled: false, relayUrl: DEFAULT_RELAY_URL })
    }
  })

  it('round-trips a saved value', () => {
    const saved = saveRemoteSettings(dir, { enabled: true, relayUrl: 'wss://relay.example/ws' })
    expect(saved).toEqual({ enabled: true, relayUrl: 'wss://relay.example/ws' })
    expect(loadRemoteSettings(dir)).toEqual(saved)
  })

  it('merges a partial patch instead of replacing the whole record', () => {
    saveRemoteSettings(dir, { enabled: true, relayUrl: 'wss://relay.example/ws' })
    expect(saveRemoteSettings(dir, { enabled: false })).toEqual({
      enabled: false,
      relayUrl: 'wss://relay.example/ws',
    })
  })

  it('keeps the previous relay URL when the new one is not ws: or wss:', () => {
    // An http: URL fails at dial time with a message that names neither the
    // setting nor the reason. Reject it where the user can still see the field.
    saveRemoteSettings(dir, { relayUrl: 'wss://relay.example/ws' })
    for (const bad of ['', '   ', 'relay.example', 'https://relay.example', 'file:///etc', 'wss:']) {
      expect(saveRemoteSettings(dir, { relayUrl: bad }).relayUrl).toBe('wss://relay.example/ws')
    }
  })

  it('keeps the previous relay URL when the new one is plain ws:// to another computer', () => {
    // Sealed frames stay sealed over ws://, but the room ids do not: anyone on
    // the network learns when each device connects and can take its seat first.
    saveRemoteSettings(dir, { relayUrl: 'wss://relay.example/ws' })
    for (const bad of ['ws://relay.example/ws', 'ws://10.0.0.5', 'ws://192.168.1.20:8787', 'ws://localhost.example.com']) {
      expect(saveRemoteSettings(dir, { relayUrl: bad }).relayUrl).toBe('wss://relay.example/ws')
    }
    expect(loadRemoteSettings(dir).relayUrl).toBe('wss://relay.example/ws')
  })

  it('saves plain ws:// to this computer, for a relay run locally', () => {
    for (const local of ['ws://127.0.0.1:8787', 'ws://localhost', ' ws://localhost:8787/ws ']) {
      expect(saveRemoteSettings(dir, { relayUrl: local }).relayUrl).toBe(local.trim())
    }
  })

  it('refuses a relay URL that is not text at all', () => {
    saveRemoteSettings(dir, { relayUrl: 'wss://relay.example/ws' })
    // @ts-expect-error -- deliberately wrong: the IPC edge is not type-checked.
    expect(saveRemoteSettings(dir, { relayUrl: 42 }).relayUrl).toBe('wss://relay.example/ws')
  })

  it('keeps a plain ws:// relay an older version saved, rather than moving it to the default', () => {
    // Swapping in the public relay would quietly move someone who runs their
    // own onto ours. The address stays -- in memory and on disk, through an
    // unrelated save -- and is refused where it would be dialled instead.
    fs.writeFileSync(
      remoteSettingsPath(dir),
      JSON.stringify({ enabled: true, relayUrl: 'ws://relay.example/ws' }),
    )
    expect(loadRemoteSettings(dir)).toEqual({ enabled: true, relayUrl: 'ws://relay.example/ws' })
    saveRemoteSettings(dir, { enabled: false })
    expect(JSON.parse(fs.readFileSync(remoteSettingsPath(dir), 'utf8'))).toEqual({
      enabled: false,
      relayUrl: 'ws://relay.example/ws',
    })
  })

  it('rejects a non-boolean enabled flag', () => {
    // @ts-expect-error -- deliberately wrong: the IPC edge is not type-checked.
    expect(saveRemoteSettings(dir, { enabled: 'yes' }).enabled).toBe(false)
  })

  it('repairs a stored relay URL that is no longer valid', () => {
    fs.writeFileSync(
      remoteSettingsPath(dir),
      JSON.stringify({ enabled: true, relayUrl: 'https://relay.example' }),
    )
    const loaded = loadRemoteSettings(dir)
    expect(loaded.enabled).toBe(true)
    expect(loaded.relayUrl).toBe(DEFAULT_RELAY_URL)
  })

  it('repairs a stored relay URL that is not a URL, or not text, to the default', () => {
    for (const relayUrl of ['relay.example', '   ', 42, null]) {
      fs.writeFileSync(remoteSettingsPath(dir), JSON.stringify({ enabled: true, relayUrl }))
      expect(loadRemoteSettings(dir).relayUrl).toBe(DEFAULT_RELAY_URL)
    }
  })

  it('swallows a write error and still reports the merged value', () => {
    const unwritable = path.join(dir, 'no', 'such')
    expect(saveRemoteSettings(unwritable, { enabled: true })).toEqual({
      enabled: true,
      relayUrl: DEFAULT_RELAY_URL,
    })
  })

  it('defaults the relay to a wss: URL', () => {
    // Plain ws: would carry the sealed frames fine -- they are already encrypted
    // end to end -- but it also lets any middlebox see the room ids, and it makes
    // the app's default traffic look like something to strip.
    expect(DEFAULT_RELAY_URL.startsWith('wss://')).toBe(true)
  })
})
