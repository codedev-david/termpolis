import { describe, expect, it } from 'vitest'
import { dialogCls } from '../../../src/renderer/src/components/World/worldTargets'

describe('Lumopolis dialogs in a narrow pane', () => {
  it('are capped to the pane they sit in (percent of the pane), not the window, so no button is clipped', () => {
    expect(dialogCls).toContain('max-w-[calc(100%-24px)]')
    expect(dialogCls).not.toContain('92vw')
  })
})
