import { describe, it, expect } from 'vitest'
import { carryLaunchArgs, commandPicksModelOrSession, freshCommand, providerForCommand } from '../../src/shared/launchCarry'

// launchCarry.ts is shared by main (the switch engine), the renderer (model switcher, New terminal on) and
// the agy sheet. Most of it is walked through those callers' tests; this file holds what only a direct call
// reaches: lines that are not there, and the corners of the quote-aware split.

describe('providerForCommand: which agent a launch line starts', () => {
  it('is the first word, whatever its path, extension or case, and the line break after it counts as a space', () => {
    expect(providerForCommand('claude --resume abc')).toBe('claude')
    expect(providerForCommand('C:/tools/Codex.EXE exec')).toBe('codex')
    expect(providerForCommand('agy')).toBe('gemini')
    expect(providerForCommand('  claude\n--model opus')).toBe('claude')
    expect(providerForCommand('claude\t--model opus')).toBe('claude')
  })

  it('is none for another program, for a name that only starts like an agent, and for a line with no word', () => {
    expect(providerForCommand('node mock-claude.js')).toBeNull()
    expect(providerForCommand('claudex --x')).toBeNull()
    for (const none of [null, undefined, '', '   ', '\n']) expect(providerForCommand(none)).toBeNull()
  })
})

describe('commandPicksModelOrSession', () => {
  it('is false for no line, or a line with no flag of the agent, and true for one that names a model or a conversation', () => {
    for (const none of [null, undefined, '', 'claude', 'claude --verbose']) expect(commandPicksModelOrSession('claude', none)).toBe(false)
    expect(commandPicksModelOrSession('claude', 'claude --model opus')).toBe(true)
    expect(commandPicksModelOrSession('claude', 'claude --resume abc')).toBe(true)
    expect(commandPicksModelOrSession('codex', 'codex -m gpt-5')).toBe(true)
  })
})

describe('the quote-aware split behind carryLaunchArgs and freshCommand', () => {
  it('reads a trailing space as no more than the end of the last word', () => {
    expect(carryLaunchArgs('claude', 'claude --permission-mode plan   ')).toEqual({ args: ['--permission-mode', 'plan'], complete: true })
    expect(carryLaunchArgs('claude', 'claude --model opus  ')).toEqual({ args: [], complete: true })
  })

  it('will not take apart a line with a quote left open, trailing space or not: nothing is carried and the line says so', () => {
    expect(carryLaunchArgs('claude', "claude --permission-mode 'plan")).toEqual({ args: [], complete: false })
    expect(carryLaunchArgs('claude', 'claude --permission-mode "plan ')).toEqual({ args: [], complete: false })
    expect(freshCommand('claude --resume abc --add-dir "C:/my projects')).toBeNull()
  })

  it('will not take apart a line with a line break in it: two commands are not one command\'s flags', () => {
    expect(freshCommand('claude --resume abc\nrm -rf x')).toBeNull()
    expect(carryLaunchArgs('claude', 'claude --verbose\nrm -rf x')).toEqual({ args: [], complete: false })
  })

  it('takes a conversation out of a line it can read, and leaves a line with none as it is', () => {
    expect(freshCommand('claude --resume abc --verbose')).toBe('claude --verbose')
    expect(freshCommand('claude --verbose  ')).toBe('claude --verbose  ')
  })
})
