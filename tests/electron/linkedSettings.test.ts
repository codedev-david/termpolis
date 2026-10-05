import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  LINKED_SETTINGS_FILE,
  loadLinkedSettings,
  saveLinkedSettings,
  type LinkedSettings,
} from '../../src/main/linkedSettings'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-settings-'))
})
afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

const file = (): string => path.join(dir, LINKED_SETTINGS_FILE)

describe('linkedSettings', () => {
  it('is off when nothing has been saved', () => {
    // Off by default: a channel that lets another computer start agents here is
    // not something an upgrade may switch on by itself.
    expect(loadLinkedSettings(dir)).toEqual({ enabled: false })
  })

  it('round-trips the switch through linked-settings.json', () => {
    saveLinkedSettings(dir, { enabled: true })
    expect(LINKED_SETTINGS_FILE).toBe('linked-settings.json')
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ enabled: true })
    expect(loadLinkedSettings(dir)).toEqual({ enabled: true })

    saveLinkedSettings(dir, { enabled: false })
    expect(loadLinkedSettings(dir)).toEqual({ enabled: false })
  })

  it('enables only on an explicit true', () => {
    // 'true', 1 and {} are all truthy; a check written `if (s.enabled)` would
    // honour every one of them.
    for (const value of ['true', 1, {}, [], null, 'yes']) {
      fs.writeFileSync(file(), JSON.stringify({ enabled: value }))
      expect(loadLinkedSettings(dir)).toEqual({ enabled: false })
    }
  })

  it('reads a corrupt or wrong-shaped file as off', () => {
    for (const raw of ['{ not json', 'null', '[true]', '"enabled"', '42', '']) {
      fs.writeFileSync(file(), raw)
      expect(loadLinkedSettings(dir)).toEqual({ enabled: false })
    }
  })

  it('writes the one known field, and only an explicit true as on', () => {
    saveLinkedSettings(dir, { enabled: 'yes', extra: 'dropped' } as unknown as LinkedSettings)
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ enabled: false })
  })

  it('does not throw when the settings cannot be written', () => {
    // The toggle it describes must not be aborted halfway by an unwritable
    // userData directory; the switch just forgets on restart.
    expect(() => saveLinkedSettings(path.join(dir, 'missing', 'dir'), { enabled: true })).not.toThrow()
    expect(() => saveLinkedSettings(dir, null as unknown as LinkedSettings)).not.toThrow()
    expect(loadLinkedSettings(dir)).toEqual({ enabled: false })
  })
})
