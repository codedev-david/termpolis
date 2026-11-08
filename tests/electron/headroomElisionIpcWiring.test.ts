import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The Elision health card reaches the main process through one invoke channel. ipcChannelSync holds
 * the send/listen direction; nothing held this one, and a card that renders "unavailable" because a
 * name drifted in one of three files looks exactly like a card with nothing to show.
 */

const ROOT = join(__dirname, '..', '..', 'src')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const CHANNEL = 'tokenSavings:get-elision-health'

describe('the elision health IPC pair', () => {
  it('has a main handler on the channel', () => {
    expect(read('main/index.ts')).toContain(`ipcMain.handle('${CHANNEL}'`)
  })

  it('has a preload bridge that invokes the same channel', () => {
    expect(read('preload/index.ts')).toContain(`tokenSavingsGetElisionHealth: () => ipcRenderer.invoke('${CHANNEL}')`)
  })

  it('is declared on the renderer\'s TermpolisAPI with the view type', () => {
    expect(read('renderer/src/types/index.ts')).toContain('tokenSavingsGetElisionHealth: () => Promise<IpcResponse<ElisionHealthView>>')
  })

  it('is called by the card through that bridge, tolerating a main process that lacks it', () => {
    expect(read('renderer/src/components/SettingsPane/ElisionHealthCard.tsx')).toContain('window.termpolis.tokenSavingsGetElisionHealth?.()')
  })

  it('is registered once, in the block that registers the other receipts', () => {
    const main = read('main/index.ts')
    expect(main.split(`'${CHANNEL}'`).length - 1).toBe(1)
    expect(main.indexOf(CHANNEL)).toBeGreaterThan(main.indexOf("'tokenSavings:get-unified-receipt'"))
  })
})
