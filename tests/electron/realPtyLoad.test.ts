// The real-PTY harness's wait scale (tests/electron/_realPty.ts): an idle machine keeps its waits, a busy one gets longer ones,
// and none gets more than four times (MODELS-R2-6).
import { describe, it, expect } from 'vitest'
import { loadScale, machineScale } from './_realPty'

describe('loadScale', () => {
  it('keeps the wait on an idle machine, and grows it with how late a timer fires, to four times at most', () => {
    expect(loadScale(0)).toBe(1)
    expect(loadScale(-5)).toBe(1)
    expect(loadScale(5)).toBe(1.5)
    expect(loadScale(10)).toBe(2)
    expect(loadScale(30)).toBe(4)
    expect(loadScale(5000)).toBe(4)
  })

  it('measures this machine once, between one and four', async () => {
    const first = await machineScale()
    expect(first).toBeGreaterThanOrEqual(1)
    expect(first).toBeLessThanOrEqual(4)
    expect(await machineScale()).toBe(first)
  })
})

// MODELS-R3-6: the harness's bash terminals report each prompt as Termpolis's own do (OSC 7 from PROMPT_COMMAND), so the switch waits for the
// report instead of reading a quiet spell on a loaded machine as "the prompt is back". The line is the one shellIntegration.ts types.
import { cleanEnv, loadPty, RealTerminal, shellsHere, POSIX_PROMPT_REPORT } from './_realPty'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('the harness\'s posix shells report their prompts', () => {
  it('is the line Termpolis\'s own bash terminals run before each prompt', () => {
    expect(POSIX_PROMPT_REPORT).toBe(String.raw`printf '\033]7;file://%s%s\007' "${'$'}{HOSTNAME:-}" "$PWD"`)
  })

  const pty = loadPty()
  const posix = shellsHere().filter((s) => s.family === 'posix')
  it.skipIf(!pty || posix.length === 0)('a real bash writes OSC 7 before its first prompt, whatever PROMPT_COMMAND the host has', async () => {
    const shell = posix[0]
    const home = mkdtempSync(join(tmpdir(), 'termpolis-harness-'))
    const t = new RealTerminal(pty!, shell, { cwd: home, env: cleanEnv({ HOME: home, USERPROFILE: home, PROMPT_COMMAND: 'echo the-host-prompt-command' }) })
    try {
      await t.until(() => t.raw.includes('\x1b]7;file://'), 30_000, 'the shell\'s prompt report')
      expect(t.raw).not.toContain('the-host-prompt-command')
    } finally {
      t.kill()
    }
  }, 60_000)
})
