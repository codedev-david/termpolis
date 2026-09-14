import { describe, it, expect } from 'vitest'
import { resolveNewTerminalCwd } from '../../src/renderer/src/lib/newTerminalCwd'

// The regression this pins: every "+ Add Terminal" terminal used to launch in the home
// directory unconditionally, so its git dot and Changes rail — both of which read only
// the launch directory — were blank forever on Windows, where nothing can follow a `cd`.
describe('resolveNewTerminalCwd', () => {
  it('prefers the folder chosen in the modal', () => {
    expect(resolveNewTerminalCwd('/picked', '/active', '/home')).toBe('/picked')
  })

  it('inherits the active terminal directory when no folder was chosen', () => {
    expect(resolveNewTerminalCwd(undefined, '/active', '/home')).toBe('/active')
    expect(resolveNewTerminalCwd('', '/active', '/home')).toBe('/active')
  })

  it('ignores a whitespace-only folder rather than launching in nowhere', () => {
    expect(resolveNewTerminalCwd('   ', '/active', '/home')).toBe('/active')
  })

  it('falls back to the home directory only when nothing else is known', () => {
    expect(resolveNewTerminalCwd(undefined, undefined, '/home')).toBe('/home')
    expect(resolveNewTerminalCwd('', '', '/home')).toBe('/home')
    expect(resolveNewTerminalCwd('  ', '   ', '/home')).toBe('/home')
  })

  it('trims the chosen and inherited paths', () => {
    expect(resolveNewTerminalCwd('  /picked  ', undefined, '/home')).toBe('/picked')
    expect(resolveNewTerminalCwd(undefined, '  /active  ', '/home')).toBe('/active')
  })
})
