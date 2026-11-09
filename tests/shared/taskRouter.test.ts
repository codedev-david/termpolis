import { describe, it, expect } from 'vitest'
import {
  routeTask, recordMisroute, isClaudeModelWord, DEFAULT_ROUTER_TUNING, MISROUTE_LIMIT, taskPromptArg, TASK_ARG_MAX,
  type ClaudeModelWord, type RouterTuning,
} from '../../src/shared/taskRouter'

const table: Array<[string, ClaudeModelWord, string, string]> = [
  // prompt, model, effort, rule
  ['', 'opusplan', 'high', 'no-task'],
  ['   ', 'opusplan', 'high', 'no-task'],
  ['\n\t', 'opusplan', 'high', 'no-task'],
  ['Design the sync protocol for linked machines', 'opus', 'high', 'deep'],
  ['why does the proxy drop the cache prefix after a resume?', 'opus', 'high', 'deep'],
  ['there is a race between pty exit and the teardown in e2e', 'opus', 'high', 'deep'],
  ['migrate the store from zustand 4 to 5', 'opus', 'high', 'deep'],
  ['do a security review of the remote bridge', 'opus', 'high', 'deep'],
  ['implement the relay handoff in relaySession.ts', 'sonnet', 'medium', 'build'],
  ['fix the failing terminalManager test', 'sonnet', 'medium', 'build'],
  ['refactor modelBroker into smaller helpers', 'sonnet', 'medium', 'build'],
  ['add a unit test for the hook timeout', 'sonnet', 'medium', 'build'],
  ['do task 7 per the plan', 'sonnet', 'medium', 'build'],
  ['rename sessionArm to primerArm across the codebase', 'sonnet', 'medium', 'build'],
  ['explain what primerSessionGuard does', 'haiku', 'low', 'lookup'],
  ['what is the coverage gate?', 'haiku', 'low', 'lookup'],
  ['find where the release workflow signs the installer', 'haiku', 'low', 'lookup'],
  ['write a commit message for the staged diff', 'haiku', 'low', 'lookup'],
  ['summarize the last three releases', 'haiku', 'low', 'lookup'],
  ['the settings pane looks cramped on small screens', 'sonnet', 'high', 'default'],
  ['make the status bar show the model chip', 'sonnet', 'high', 'default'],
]

describe('routeTask', () => {
  it.each(table)('%j → %s/%s (%s)', (prompt, model, effort, rule) => {
    expect(routeTask({ prompt })).toMatchObject({ model, effort, rule })
  })

  it('a long lookup is not short enough for Haiku', () => {
    const long = `explain ${'the long way round '.repeat(8)}`
    expect(routeTask({ prompt: long }).rule).toBe('default')
    expect(routeTask({ prompt: long }, { ...DEFAULT_ROUTER_TUNING, haikuMaxWords: 60 }).rule).toBe('lookup')
  })

  it('more than eight files named is deep work', () => {
    expect(routeTask({ prompt: 'update the headers', mentionsFiles: 9 }).rule).toBe('deep')
    expect(routeTask({ prompt: 'update the headers', mentionsFiles: 8 }).rule).toBe('default')
  })

  it('a relay with no new task keeps the earlier model', () => {
    expect(routeTask({ isRelay: true, lastModel: 'haiku' })).toMatchObject({ model: 'haiku', rule: 'relay' })
    expect(routeTask({ isRelay: true })).toMatchObject({ model: 'opusplan', rule: 'no-task' })
  })

  it('misroutes move lookup up to sonnet after 3', () => {
    let tune: RouterTuning = DEFAULT_ROUTER_TUNING
    const q = { prompt: 'what is the coverage gate?' }
    for (let i = 0; i < MISROUTE_LIMIT - 1; i++) tune = recordMisroute('lookup', tune)
    expect(routeTask(q, tune).model).toBe('haiku')
    tune = recordMisroute('lookup', tune)
    expect(routeTask(q, tune)).toMatchObject({ model: 'sonnet', effort: 'medium', rule: 'lookup' })
    expect(DEFAULT_ROUTER_TUNING.misroutes).toEqual({}) // never mutated
    const deep = { prompt: 'design it' }
    for (let i = 0; i < MISROUTE_LIMIT; i++) tune = recordMisroute('deep', tune)
    expect(routeTask(deep, tune).model).toBe('opus') // nothing above opus
  })

  it('never returns a word outside ClaudeModelWord', () => {
    const prompts = [...table.map((r) => r[0]), 'x', 'plan', '???', 'a '.repeat(500)]
    let tune: RouterTuning = DEFAULT_ROUTER_TUNING
    for (const rule of ['no-task', 'relay', 'deep', 'build', 'lookup', 'default']) {
      for (let i = 0; i < MISROUTE_LIMIT; i++) tune = recordMisroute(rule, tune)
    }
    for (const t of [DEFAULT_ROUTER_TUNING, tune]) {
      for (const prompt of prompts) expect(isClaudeModelWord(routeTask({ prompt }, t).model)).toBe(true)
    }
    expect(isClaudeModelWord('fable')).toBe(false)
    expect(isClaudeModelWord(7)).toBe(false)
  })
})

describe('taskPromptArg', () => {
  it('quotes the task as one argument no shell reads anything in', () => {
    expect(taskPromptArg('find where X is defined')).toBe(' "find where X is defined"')
    expect(taskPromptArg('a "b" $HOME `id` 100% !! c:\\x \u201csmart\u201d')).toBe(' "a b HOME id 100 c:x smart"')
    expect(taskPromptArg('line one\r\nline two\ttab\u2028sep')).toBe(' "line one line two tab sep"')
    expect(taskPromptArg('-- --resume abc')).toBe(' "resume abc"')
    // A leading slash would make the first prompt a slash command; parentheses go too (the
    // unavailable-model watcher needs them to tell Claude's message from the echoed task).
    expect(taskPromptArg('/clear then fix (x)')).toBe(' "clear then fix x"')
    expect(taskPromptArg(' / -/login')).toBe(' "login"')
  })

  it('nothing left, or not a string, is no argument', () => {
    expect(taskPromptArg('   ')).toBe('')
    expect(taskPromptArg('"$`')).toBe('')
    expect(taskPromptArg(undefined)).toBe('')
    expect(taskPromptArg(42)).toBe('')
  })

  it('is capped', () => {
    expect(taskPromptArg('x'.repeat(TASK_ARG_MAX + 50))).toBe(` "${'x'.repeat(TASK_ARG_MAX)}"`)
  })
})
