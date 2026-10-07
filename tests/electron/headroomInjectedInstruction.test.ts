import { describe, it, expect } from 'vitest'
const { buildInjectedInstruction } = await import('../../src/main/headroom/injectedInstruction')

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const CWD = 'C:/Users/x/repos/termpolis'

describe('buildInjectedInstruction — cache-stable system-prompt bytes', () => {
  it('is byte-identical for identical inputs (prompt-cache invariant)', () => {
    const a = buildInjectedInstruction({ cwd: CWD, steering: true, mode: 'balanced' })
    const b = buildInjectedInstruction({ cwd: CWD, steering: true, mode: 'balanced' })
    expect(a).toBe(b)
  })

  it('carries no nondeterministic content (no uuid / ISO timestamp / clock)', () => {
    const s = buildInjectedInstruction({ cwd: CWD, steering: true, mode: 'aggressive' })
    expect(s).not.toMatch(UUID)
    expect(s).not.toMatch(ISO)
    expect(s).not.toContain('Date.now')
  })

  it('embeds the cwd verbatim when given, omits it otherwise', () => {
    expect(buildInjectedInstruction({ cwd: CWD, steering: false })).toContain(`(cwd "${CWD}")`)
    expect(buildInjectedInstruction({ steering: false })).not.toContain('(cwd')
  })

  it('appends steering only when enabled, graded by mode', () => {
    const off = buildInjectedInstruction({ cwd: CWD, steering: false })
    const bal = buildInjectedInstruction({ cwd: CWD, steering: true, mode: 'balanced' })
    const agg = buildInjectedInstruction({ cwd: CWD, steering: true, mode: 'aggressive' })
    const con = buildInjectedInstruction({ cwd: CWD, steering: true, mode: 'conservative' })
    expect(off).not.toContain('Output style')
    expect(bal).toContain('Output style')
    expect(agg.length).toBeGreaterThan(bal.length)
    expect(con.length).toBeLessThan(bal.length)
  })

  it('always routes the agent to memory_primer / memory_search regardless of steering', () => {
    const s = buildInjectedInstruction({ cwd: CWD, steering: false })
    expect(s).toContain('memory_primer')
    expect(s).toContain('memory_search')
  })
})

describe('buildInjectedInstruction — sudo -A', () => {
  it('tells the agent how to run as administrator only where the helper is installed', async () => {
    const { SUDO_AGENT_HINT } = await import('../../src/main/sudoAskpass')
    const on = buildInjectedInstruction({ cwd: CWD, steering: false, sudoAskpass: true })
    expect(on).toContain(SUDO_AGENT_HINT)
    expect(buildInjectedInstruction({ cwd: CWD, steering: false, sudoAskpass: false })).not.toContain('sudo')
    expect(buildInjectedInstruction({ cwd: CWD, steering: false })).not.toContain('sudo')
    // Same bytes every launch: it is part of the cached system prompt.
    expect(buildInjectedInstruction({ cwd: CWD, steering: true, mode: 'balanced', sudoAskpass: true }))
      .toBe(buildInjectedInstruction({ cwd: CWD, steering: true, mode: 'balanced', sudoAskpass: true }))
  })

  it('keeps the steering directive last', async () => {
    const { SUDO_AGENT_HINT } = await import('../../src/main/sudoAskpass')
    const s = buildInjectedInstruction({ cwd: CWD, steering: true, mode: 'balanced', sudoAskpass: true })
    expect(s.indexOf(SUDO_AGENT_HINT)).toBeGreaterThan(s.indexOf('memory_search'))
    expect(s.endsWith(SUDO_AGENT_HINT)).toBe(false)
  })
})
