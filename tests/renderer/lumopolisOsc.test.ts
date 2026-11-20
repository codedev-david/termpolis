// The renderer's half of the `lumopolis` command: every sequence is swallowed; only a live one asks main.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { lumopolisOscHandler } from '../../src/renderer/src/lib/lumopolisOsc'
import { LUMOPOLIS_MAX_PAYLOAD } from '../../src/shared/world/lumopolisCommand'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let ask: ReturnType<typeof vi.fn>
beforeEach(() => {
  ask = vi.fn(async () => ({ success: true, data: '/repo/app' }))
  ;(window as unknown as { termpolis: unknown }).termpolis = { worldTerminalOpen: ask }
})

const make = (over: Partial<Parameters<typeof lumopolisOscHandler>[0]> = {}) => {
  const open = vi.fn()
  const handler = lumopolisOscHandler({ terminalId: 't1', replaying: () => false, cwd: () => '/repo', open, ...over })
  return { handler, open }
}

describe('lumopolisOscHandler', () => {
  it('asks main with the terminal, the payload and its folder, and opens the folder main answers', async () => {
    const { handler, open } = make()
    expect(handler('lumopolis;abc;app')).toBe(true)
    expect(ask).toHaveBeenCalledWith({ terminalId: 't1', payload: 'lumopolis;abc;app', cwd: '/repo' })
    await flush()
    expect(open).toHaveBeenCalledWith('/repo/app')
  })

  it('sends no folder when the terminal has none yet', () => {
    const { handler } = make({ cwd: () => undefined })
    handler('lumopolis;abc;/x')
    expect(ask).toHaveBeenCalledWith({ terminalId: 't1', payload: 'lumopolis;abc;/x' })
  })

  it('swallows a sequence in replayed history without asking', () => {
    const { handler } = make({ replaying: () => true })
    expect(handler('lumopolis;abc;/x')).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('swallows an over-long payload without asking', () => {
    const { handler } = make()
    expect(handler('x'.repeat(LUMOPOLIS_MAX_PAYLOAD + 1))).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('opens nothing when main refuses, or the call fails', async () => {
    const { handler, open } = make()
    ask.mockResolvedValueOnce({ success: false, error: 'no' })
    handler('lumopolis;bad;/x')
    ask.mockRejectedValueOnce(new Error('gone'))
    handler('lumopolis;abc;/x')
    await flush()
    expect(open).not.toHaveBeenCalled()
  })
})
