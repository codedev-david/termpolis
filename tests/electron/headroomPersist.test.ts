import { describe, it, expect, beforeEach } from 'vitest'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
const { loadSettingsFromDisk, saveSettingsToDisk, loadLedgerBaseFromDisk, saveLedgerToDisk } =
  await import('../../src/main/headroom/persist')
import { getSettings, setSettings, resetSettings } from '../../src/main/headroom/config'
import { recordEvent, summarizeSavings, resetLedger } from '../../src/main/headroom/savingsLedger'

describe('headroom persist', () => {
  beforeEach(() => { resetSettings(); resetLedger() })

  it('round-trips settings through disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-'))
    setSettings({ mode: 'aggressive', steering: false })
    saveSettingsToDisk(dir)
    resetSettings()
    loadSettingsFromDisk(dir)
    expect(getSettings()).toEqual({ enabled: true, mode: 'aggressive', steering: false })
  })

  it('round-trips the cumulative ledger baseline through disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-'))
    recordEvent({ tool: 'code_search', kind: 'compress', savedTokens: 4321 })
    saveLedgerToDisk(dir)
    resetLedger()
    loadLedgerBaseFromDisk(dir)
    expect(summarizeSavings().cumulative.netSaved).toBe(4321)
  })

  it('load is a no-op (defaults kept) when the file is missing', () => {
    loadSettingsFromDisk(path.join(os.tmpdir(), 'does-not-exist-hr', 'x'))
    expect(getSettings().mode).toBe('aggressive')
  })

  it('save never throws when the target path is unusable', () => {
    const f = path.join(os.tmpdir(), `hr-file-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`)
    fs.writeFileSync(f, 'x') // a FILE — using it as a parent dir must fail mkdir, guarded
    expect(() => saveSettingsToDisk(path.join(f, 'cannot-be-dir'))).not.toThrow()
  })
})
