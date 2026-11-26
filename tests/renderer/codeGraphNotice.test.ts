import { describe, it, expect } from 'vitest'
import { codeGraphNotice, isCodeGraphNotice } from '../../src/renderer/src/lib/codeGraphNotice'

// HOLD-B #27: App tells the code graph banner from the others to put it away while the Lumopolis pane is open.
describe('codeGraphNotice', () => {
  it('words the banner and knows it again', () => {
    expect(codeGraphNotice(6, 'My Project')).toBe('🧭 Code graph: 6 symbols indexed in "My Project"')
    expect(isCodeGraphNotice(codeGraphNotice(1, 'x'))).toBe(true)
  })
  it('no other banner is one', () => {
    expect(isCodeGraphNotice('🧠 Loaded 3 memories for "app"')).toBe(false)
    expect(isCodeGraphNotice(null)).toBe(false)
    expect(isCodeGraphNotice(undefined)).toBe(false)
  })
})
