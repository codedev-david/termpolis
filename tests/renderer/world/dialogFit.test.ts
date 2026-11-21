import { describe, expect, it } from 'vitest'
import { dialogCls } from '../../../src/renderer/src/components/World/worldTargets'

describe('Lumopolis dialogs in a narrow pane', () => {
  it('are capped to the pane they sit in (percent of the pane), not the window, so no button is clipped', () => {
    expect(dialogCls).toContain('max-w-[calc(100%-24px)]')
    expect(dialogCls).not.toContain('92vw')
  })
})

describe('Lumopolis dialogs in a short pane', () => {
  it('are held to the pane height below their top-24 offset and scroll inside, so Cancel and the main button stay reachable', () => {
    expect(dialogCls).toContain('top-24')
    // top-24 is 96px; 12px more leaves a margin under the dialog.
    expect(dialogCls).toContain('max-h-[calc(100%-108px)]')
    expect(dialogCls).toContain('overflow-y-auto')
  })
})
