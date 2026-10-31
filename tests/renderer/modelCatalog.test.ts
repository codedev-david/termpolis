import { describe, it, expect } from 'vitest'
import {
  PROVIDER_BIN,
  PROVIDER_INSTALL_KEY,
  PROVIDER_LABEL,
  REFRESH_MODELS_VALUE,
  isOfferedModel,
  modelOptionsFor,
  providerForAgent,
  relaunchCommandFor,
  carriedLaunchArgs,
  carryLaunchArgs,
  launchFlag,
  commandPicksModelOrSession,
  providerForCommand,
  type CatalogModel,
  type ModelCatalog,
  type ModelProvider,
} from '../../src/renderer/src/lib/modelCatalog'
import { CLAUDE_MODEL_OPTIONS } from '../../src/renderer/src/lib/modelBroker'
import { isSafeModelId } from '../../src/main/modelCatalog'

function catalog(over: Partial<Record<ModelProvider, CatalogModel[]>> = {}): ModelCatalog {
  const one = (provider: ModelProvider): ModelCatalog[ModelProvider] => ({
    provider, models: over[provider] ?? [], source: 'cli', fetchedAt: 1,
  })
  return { claude: one('claude'), codex: one('codex'), gemini: one('gemini') }
}

const CAT = catalog({
  codex: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
  gemini: [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', note: 'fastest' }],
})

describe('providerForAgent', () => {
  it('resolves BOTH detector vocabularies for Codex', () => {
    // agentDetector's launch-command path says 'OpenAI Codex'; its output-scrape path
    // says plain 'Codex'. Miss either and a Codex terminal silently loses its picker.
    expect(providerForAgent('OpenAI Codex')).toBe('codex')
    expect(providerForAgent('Codex')).toBe('codex')
  })

  it('resolves Claude and both Gemini names', () => {
    expect(providerForAgent('Claude Code')).toBe('claude')
    expect(providerForAgent('Gemini CLI')).toBe('gemini')
    expect(providerForAgent('Antigravity')).toBe('gemini')
  })

  it('is case-insensitive', () => {
    expect(providerForAgent('claude code')).toBe('claude')
    expect(providerForAgent('ANTIGRAVITY')).toBe('gemini')
  })

  it('returns null for an unknown, empty or absent name', () => {
    expect(providerForAgent('Aider')).toBeNull()
    expect(providerForAgent('')).toBeNull()
    expect(providerForAgent(null)).toBeNull()
    expect(providerForAgent(undefined)).toBeNull()
  })
})

describe('modelOptionsFor', () => {
  it('returns the broker\'s hand-authored rows for Claude, catalog or not', () => {
    expect(modelOptionsFor('claude', CAT)).toBe(CLAUDE_MODEL_OPTIONS)
    expect(modelOptionsFor('claude', null)).toBe(CLAUDE_MODEL_OPTIONS)
  })

  it('maps discovered rows for the other providers, carrying any note', () => {
    expect(modelOptionsFor('codex', CAT)).toEqual([{ alias: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', savingsPct: 0 }])
    expect(modelOptionsFor('gemini', CAT)[0].note).toBe('fastest')
  })

  it('is empty when nothing was discovered or no provider applies', () => {
    expect(modelOptionsFor('codex', catalog())).toEqual([])
    expect(modelOptionsFor('codex', null)).toEqual([])
    expect(modelOptionsFor(null, CAT)).toEqual([])
  })
})

describe('isOfferedModel', () => {
  it('accepts an offered id and rejects everything else', () => {
    expect(isOfferedModel('claude', 'opus', null)).toBe(true)
    expect(isOfferedModel('codex', 'gpt-5.6-sol', CAT)).toBe(true)
    expect(isOfferedModel('codex', 'gpt-9-imaginary', CAT)).toBe(false)
    expect(isOfferedModel('codex', 'opus', CAT)).toBe(false)
    expect(isOfferedModel(null, 'opus', CAT)).toBe(false)
    expect(isOfferedModel('codex', '', CAT)).toBe(false)
  })
})

describe('relaunchCommandFor', () => {
  it('uses each CLI\'s own resume flag', () => {
    expect(relaunchCommandFor('claude', 'opus', CAT)).toBe('claude --model opus --continue')
    expect(relaunchCommandFor('codex', 'gpt-5.6-sol', CAT)).toBe('codex --model gpt-5.6-sol resume --last')
    expect(relaunchCommandFor('gemini', 'gemini-3.8-flash-high', CAT)).toBe('agy --model gemini-3.8-flash-high --continue')
  })

  it('returns an empty command for anything not offered, so nothing reaches the PTY', () => {
    expect(relaunchCommandFor('codex', 'gpt-9-imaginary', CAT)).toBe('')
    expect(relaunchCommandFor('codex', 'gpt-5.6-sol', null)).toBe('')
    expect(relaunchCommandFor('claude', 'claude-opus-5-5', CAT)).toBe('')
    expect(relaunchCommandFor(null, 'opus', CAT)).toBe('')
  })
})

const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

describe('providerForCommand', () => {
  it.each([
    ['claude', 'claude'],
    ['claude --dangerously-skip-permissions', 'claude'],
    ['codex --yolo', 'codex'],
    ['agy', 'gemini'],
    ['AGY', 'gemini'],
    ['claude.exe --foo', 'claude'],
    ['C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd', 'codex'],
    ['/usr/local/bin/claude -c', 'claude'],
  ])('%s -> %s', (command, provider) => {
    expect(providerForCommand(command)).toBe(provider)
  })

  it.each(['', '   ', 'bash', 'gemini', 'node mock-claude.js', 'npx claude', 'echo claude'])('%j is not an agent launch', (command) => {
    expect(providerForCommand(command)).toBeNull()
  })
})

describe('launchFlag: one rule for what a token does to the model or the conversation', () => {
  it('knows the model flags in every spelling', () => {
    for (const t of ['--model', '--model=opus']) expect(launchFlag('claude', t)?.kind).toBe('model')
    for (const t of ['--model', '-m', '--model=gpt-5.5', '-m=gpt-5.5', '-mgpt-5.5']) expect(launchFlag('codex', t)?.kind).toBe('model')
    for (const t of ['--model', '--model=x']) expect(launchFlag('gemini', t)?.kind).toBe('model')
  })

  it('knows what picks, continues or branches a conversation', () => {
    for (const t of ['--resume', '--resume=abc', '-r', '-rabc', '--from-pr', '--from-pr=12', '--session-id', '--continue', '-c', '--fork-session']) {
      expect(launchFlag('claude', t)?.kind, t).toBe('resume')
    }
    for (const t of ['--conversation', '--conversation=abc', '--continue', '-c']) expect(launchFlag('gemini', t)?.kind, t).toBe('resume')
    for (const t of ['resume', '--last', '--all']) expect(launchFlag('codex', t)?.kind, t).toBe('resume')
  })

  it('says whether the value is the next token', () => {
    expect(launchFlag('claude', '--model')?.takesValue).toBe(true)
    expect(launchFlag('claude', '--model=opus')?.takesValue).toBe(false)
    expect(launchFlag('codex', '-mgpt-5')?.takesValue).toBe(false)
    expect(launchFlag('claude', '--continue')?.takesValue).toBe(false)
    expect(launchFlag('codex', 'resume')?.takesValue).toBe(true)
  })

  it('leaves everything else alone, including Codex\'s -c (a config override)', () => {
    for (const t of ['--dangerously-skip-permissions', '--effort', '--yolo', '-p', '--verbose', 'plan', 'foo=bar']) {
      expect(launchFlag('claude', t), t).toBeNull()
    }
    expect(launchFlag('codex', '-c')).toBeNull()
    expect(launchFlag('codex', '-c=model_reasoning_effort=high')).toBeNull()
    expect(launchFlag('claude', '-c')?.kind).toBe('resume')
    expect(launchFlag('gemini', '-c')?.kind).toBe('resume')
  })

  it('is exact: a flag that merely starts like another is not that flag', () => {
    expect(launchFlag('claude', '--models')).toBeNull()
    expect(launchFlag('claude', '--resumed')).toBeNull()
    expect(launchFlag('claude', '--continued')).toBeNull()
    expect(launchFlag('codex', '--modelx')).toBeNull()
  })
})

describe('commandPicksModelOrSession', () => {
  it('sees a model or a conversation anywhere in the command, whatever the spelling', () => {
    for (const [p, c] of [
      ['claude', 'claude --model opus'], ['claude', 'claude --model=opus'], ['claude', 'claude --resume abc'], ['claude', 'claude -r'],
      ['claude', 'claude --continue'], ['claude', 'claude -c'], ['claude', 'claude --from-pr=12'],
      ['codex', 'codex -m gpt-5.5'], ['codex', 'codex -m=gpt-5.5'], ['codex', 'codex -mgpt-5.5'], ['codex', 'codex resume --last'],
      ['gemini', 'agy --conversation=abc'], ['gemini', 'agy --conversation abc'], ['gemini', 'agy -c'], ['gemini', 'agy --continue'],
    ] as const) {
      expect(commandPicksModelOrSession(p, c), c).toBe(true)
    }
  })

  it('is false for plain flags, and for a command that is not that agent\'s', () => {
    expect(commandPicksModelOrSession('claude', 'claude --dangerously-skip-permissions --effort max')).toBe(false)
    expect(commandPicksModelOrSession('codex', 'codex -c model_reasoning_effort=high --yolo')).toBe(false)
    expect(commandPicksModelOrSession('claude', 'claude')).toBe(false)
  })

  it('agrees with what carriedLaunchArgs drops (one rule, two uses)', () => {
    for (const [p, tokens] of [
      ['claude', ['--model', 'opus']], ['claude', ['--resume=abc']], ['codex', ['-mgpt-5.5']], ['codex', ['-m=gpt-5']],
      ['gemini', ['--conversation=abc']], ['gemini', ['-c']], ['codex', ['resume', '--last']],
    ] as const) {
      const bin = p === 'gemini' ? 'agy' : p
      const command = `${bin} --verbose ${tokens.join(' ')}`
      expect(commandPicksModelOrSession(p, command), command).toBe(true)
      expect(carriedLaunchArgs(p, command), command).toEqual(['--verbose'])
    }
  })
})

describe('carriedLaunchArgs', () => {
  it('keeps the flags the terminal was launched with (permission mode, approvals, effort)', () => {
    expect(carriedLaunchArgs('claude', 'claude --dangerously-skip-permissions')).toEqual(['--dangerously-skip-permissions'])
    expect(carriedLaunchArgs('claude', 'claude --permission-mode plan --effort max')).toEqual(['--permission-mode', 'plan', '--effort', 'max'])
    expect(carriedLaunchArgs('codex', 'codex --yolo')).toEqual(['--yolo'])
    expect(carriedLaunchArgs('codex', 'codex -c model_reasoning_effort=high')).toEqual(['-c', 'model_reasoning_effort=high'])
    expect(carriedLaunchArgs('gemini', 'agy --dangerously-skip-permissions --effort high')).toEqual(['--dangerously-skip-permissions', '--effort', 'high'])
  })

  it('carries nothing for a bare command, no command, or a command that is not that agent\'s', () => {
    expect(carriedLaunchArgs('claude', 'claude')).toEqual([])
    expect(carriedLaunchArgs('claude', '')).toEqual([])
    expect(carriedLaunchArgs('claude', undefined)).toEqual([])
    expect(carriedLaunchArgs('claude', null)).toEqual([])
    expect(carriedLaunchArgs('claude', 'codex --yolo')).toEqual([])
    expect(carriedLaunchArgs('codex', 'claude --dangerously-skip-permissions')).toEqual([])
    expect(carriedLaunchArgs('claude', 'node mock-claude.js --flag')).toEqual([])
  })

  it('reads the agent through a path or an extension', () => {
    expect(carriedLaunchArgs('codex', 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd --yolo')).toEqual(['--yolo'])
    expect(carriedLaunchArgs('claude', '/usr/local/bin/claude --verbose')).toEqual(['--verbose'])
    expect(carriedLaunchArgs('claude', 'CLAUDE.EXE --verbose')).toEqual(['--verbose'])
  })

  it('drops the model: the relaunch names its own', () => {
    expect(carriedLaunchArgs('claude', 'claude --model opus --dangerously-skip-permissions')).toEqual(['--dangerously-skip-permissions'])
    expect(carriedLaunchArgs('claude', 'claude --model=opus --verbose')).toEqual(['--verbose'])
    expect(carriedLaunchArgs('codex', 'codex -m gpt-5.5 --yolo')).toEqual(['--yolo'])
    expect(carriedLaunchArgs('codex', 'codex -mgpt-5.5 --yolo')).toEqual(['--yolo'])
    expect(carriedLaunchArgs('codex', 'codex -m=gpt-5.5 --yolo')).toEqual(['--yolo'])
    expect(carriedLaunchArgs('codex', 'codex --model gpt-5.5')).toEqual([])
    expect(carriedLaunchArgs('gemini', 'agy --model gemini-3.8-flash-high --verbose')).toEqual(['--verbose'])
  })

  it('drops whatever picks a conversation: the relaunch decides that itself', () => {
    expect(carriedLaunchArgs('claude', 'claude --resume 3f9c1a --verbose')).toEqual(['--verbose'])
    expect(carriedLaunchArgs('claude', 'claude --resume=3f9c1a')).toEqual([])
    expect(carriedLaunchArgs('claude', 'claude -r 3f9c1a --verbose')).toEqual(['--verbose'])
    expect(carriedLaunchArgs('claude', 'claude --continue --verbose')).toEqual(['--verbose'])
    expect(carriedLaunchArgs('claude', 'claude -c --verbose')).toEqual(['--verbose'])
    expect(carriedLaunchArgs('claude', 'claude --from-pr 12 --verbose')).toEqual(['--verbose'])
    expect(carriedLaunchArgs('claude', 'claude --session-id 3f9c1a --fork-session --verbose')).toEqual(['--verbose'])
    expect(carriedLaunchArgs('gemini', 'agy --conversation 7f2 --verbose')).toEqual(['--verbose'])
    expect(carriedLaunchArgs('gemini', 'agy --conversation=7f2 --verbose')).toEqual(['--verbose'])
    expect(carriedLaunchArgs('gemini', 'agy -c --verbose')).toEqual(['--verbose'])
    expect(carriedLaunchArgs('codex', 'codex resume --last --yolo')).toEqual(['--yolo'])
    expect(carriedLaunchArgs('codex', 'codex resume 0192-abc --yolo')).toEqual(['--yolo'])
    expect(carriedLaunchArgs('codex', 'codex --yolo resume --last')).toEqual(['--yolo'])
  })

  it('does not swallow the next flag when a resume flag has no value', () => {
    expect(carriedLaunchArgs('claude', 'claude --resume --verbose')).toEqual(['--verbose'])
    expect(carriedLaunchArgs('claude', 'claude -r')).toEqual([])
    expect(carriedLaunchArgs('claude', 'claude --model')).toEqual([])
  })

  it("keeps Codex's -c (a config override) but drops Claude's and the Antigravity CLI's (continue)", () => {
    expect(carriedLaunchArgs('codex', 'codex -c foo=bar')).toEqual(['-c', 'foo=bar'])
    expect(carriedLaunchArgs('claude', 'claude -c')).toEqual([])
    expect(carriedLaunchArgs('gemini', 'agy -c')).toEqual([])
  })

  // Rebuilding a command from words is only faithful when the words are plain. A quote, an
  // operator or a variable means this is not "the agent and its flags" (a wrapper, a compound
  // command, a flag whose value holds spaces), and re-joining the pieces could change what it does:
  // `claude --append-system-prompt "a -r b"` came back as `... "a --model opus --continue`, an
  // unclosed quote. Those relaunch the bare agent instead.
  it.each([
    ['a double-quoted value', 'claude --append-system-prompt "a -r b" --verbose'],
    ['a single-quoted value', "claude --append-system-prompt 'two  words' --verbose"],
    ['quotes with the spaces collapsed', 'claude --append-system-prompt "keep  two  spaces"'],
    ['a quoted Codex config value', "codex -c \"developer_instructions='Always resume from the last checkpoint'\" --yolo"],
    ['a semicolon', 'claude --dangerously-skip-permissions; echo done'],
    ['an ampersand', 'claude --verbose && echo done'],
    ['a pipe', 'claude --verbose | tee log.txt'],
    ['a redirect', 'claude --verbose > out.txt'],
    ['a command substitution', 'claude --append-system-prompt $(cat prompt.txt)'],
    ['a variable', 'claude --add-dir $HOME/work'],
    ['a backtick', 'claude --verbose `date`'],
    ['a comment', 'claude --verbose # keep it simple'],
    ['a glob', 'claude --add-dir ./pkg/*'],
    ['a newline', 'claude --verbose\necho hi'],
  ])('carries nothing from %s: the bare agent is the only safe relaunch', (_label, command) => {
    expect(carriedLaunchArgs('claude', command)).toEqual([])
    expect(carriedLaunchArgs('codex', command.replace(/^claude/, 'codex'))).toEqual([])
  })

  it('does not mistake the dash in a value or a Windows path for a problem', () => {
    expect(carriedLaunchArgs('claude', 'claude --add-dir C:\\Users\\me\\my-repo --verbose')).toEqual(['--add-dir', 'C:\\Users\\me\\my-repo', '--verbose'])
    expect(carriedLaunchArgs('claude', 'claude --settings ./cfg/a.b-c_d.json')).toEqual(['--settings', './cfg/a.b-c_d.json'])
  })
})

describe('carryLaunchArgs: what it can and cannot repeat', () => {
  it('reports a complete carry for plain flags, a bare agent, and a command that is not the agent', () => {
    expect(carryLaunchArgs('claude', 'claude --dangerously-skip-permissions')).toEqual({ args: ['--dangerously-skip-permissions'], complete: true })
    expect(carryLaunchArgs('claude', 'claude')).toEqual({ args: [], complete: true })
    expect(carryLaunchArgs('claude', 'node mock-claude.js --flag')).toEqual({ args: [], complete: true })
    expect(carryLaunchArgs('claude', undefined)).toEqual({ args: [], complete: true })
  })

  it('reports an INCOMPLETE carry, so the caller can say so, when options could not be repeated', () => {
    for (const command of [
      'claude --permission-mode plan --append-system-prompt "be careful"',
      "codex -s read-only -c \"model_reasoning_effort='high'\"",
      'claude --dangerously-skip-permissions; echo done',
      'claude --add-dir $HOME/work',
    ]) {
      const provider = command.startsWith('codex') ? 'codex' : 'claude'
      expect(carryLaunchArgs(provider, command), command).toEqual({ args: [], complete: false })
    }
  })

  it('does not call a bare agent incomplete just because nothing was carried', () => {
    expect(carryLaunchArgs('codex', 'codex').complete).toBe(true)
    expect(carryLaunchArgs('codex', '   codex  ').complete).toBe(true)
  })

  // The reviewer's examples: a bracket in a model name, and non-ASCII in a path, used to reject the
  // WHOLE command and silently drop every flag, restrictive ones included.
  it('keeps the flags of a command that holds a bracketed model name', () => {
    expect(carryLaunchArgs('claude', 'claude --dangerously-skip-permissions --model opus[1m]')).toEqual({ args: ['--dangerously-skip-permissions'], complete: true })
    expect(carryLaunchArgs('claude', 'claude --model=opus[1m] --permission-mode plan')).toEqual({ args: ['--permission-mode', 'plan'], complete: true })
  })

  it('keeps the flags of a command that holds a non-ASCII path', () => {
    expect(carryLaunchArgs('claude', 'claude --add-dir C:\\Users\\José\\projets --verbose')).toEqual({ args: ['--add-dir', 'C:\\Users\\José\\projets', '--verbose'], complete: true })
    expect(carryLaunchArgs('claude', 'claude --add-dir /home/zoë/код')).toEqual({ args: ['--add-dir', '/home/zoë/код'], complete: true })
  })

  // A prompt in the launch command would be submitted AGAIN at every switch, and the second value of a
  // flag that takes several would be misread as a prompt: neither can be told apart from a bare word,
  // so a word that is not a flag's value means "not repeatable".
  it.each([
    ['a slash command', 'claude /review'],
    ['a bare prompt word', 'claude hello'],
    ['a prompt after a boolean flag', 'claude --dangerously-skip-permissions /review'],
    ['a prompt after a value', 'claude --effort max /review'],
    ['the second value of a flag that takes several', 'claude --add-dir ./a ./b'],
    ['a word after a dropped flag and its value', 'claude --model opus plan'],
  ])('repeats nothing, and says so, for %s', (_label, command) => {
    expect(carryLaunchArgs('claude', command)).toEqual({ args: [], complete: false })
  })

  it('knows the permission flags people put in profiles never take a value', () => {
    for (const [p, command] of [
      ['claude', 'claude --dangerously-skip-permissions hello'],
      ['claude', 'claude --verbose hello'],
      ['codex', 'codex --yolo hello'],
      ['codex', 'codex --full-auto hello'],
      ['codex', 'codex --dangerously-bypass-approvals-and-sandbox hello'],
    ] as const) {
      expect(carryLaunchArgs(p, command).complete, command).toBe(false)
    }
  })

  it('still reads the word after an ordinary flag as its value', () => {
    expect(carryLaunchArgs('claude', 'claude --permission-mode plan --effort max')).toEqual({ args: ['--permission-mode', 'plan', '--effort', 'max'], complete: true })
    expect(carryLaunchArgs('codex', 'codex -c foo=bar --yolo')).toEqual({ args: ['-c', 'foo=bar', '--yolo'], complete: true })
    expect(carryLaunchArgs('codex', 'codex --yolo resume --last')).toEqual({ args: ['--yolo'], complete: true })
  })
})

describe('carryLaunchArgs: quoted values it is about to drop, and prompts after "--" or an unlisted flag', () => {
  // zsh needs the quotes around a bracketed model name, so `--model 'opus[1m]'` is a realistic profile.
  // The quoted value is dropped anyway, so it must not stop the REST of the command being carried (it
  // used to drop `--dangerously-skip-permissions` and then claim nothing was lost).
  it('carries the rest of the command when the only quoted word is a model or session value that is dropped', () => {
    for (const command of [
      "claude --dangerously-skip-permissions --model 'opus[1m]'",
      "claude --model 'opus[1m]' --dangerously-skip-permissions",
      'claude --dangerously-skip-permissions --model "opus"',
      "claude --dangerously-skip-permissions --model='opus[1m]'",
      'claude --dangerously-skip-permissions --resume "my feature work"',
    ]) {
      expect(carryLaunchArgs('claude', command), command).toEqual({ args: ['--dangerously-skip-permissions'], complete: true })
    }
    expect(carryLaunchArgs('codex', "codex --yolo -m 'o3'")).toEqual({ args: ['--yolo'], complete: true })
  })

  it('still refuses a quoted word that would be KEPT', () => {
    for (const command of [
      'claude --append-system-prompt "be careful" --model opus',
      "claude --model 'opus[1m]' --append-system-prompt 'two  words'",
      "codex -c \"model_reasoning_effort='high'\" --yolo",
    ]) {
      const provider = command.startsWith('codex') ? 'codex' : 'claude'
      expect(carryLaunchArgs(provider, command), command).toEqual({ args: [], complete: false })
    }
  })

  it('refuses a command it cannot take apart: an unclosed quote, or an escape or expansion inside double quotes', () => {
    for (const command of [
      "claude --model 'opus",
      'claude --model "opus',
      'claude --model "a\\b" --verbose',
      'claude --model "$MODEL" --verbose',
      'claude --model "`echo opus`" --verbose',
    ]) {
      expect(carryLaunchArgs('claude', command), command).toEqual({ args: [], complete: false })
    }
  })

  // `--` ends the options: everything after it is a prompt. Carried, the model and resume flags would
  // land AFTER it (so the model would not change) and the prompt would be sent again.
  it('treats a lone "--" as the start of a prompt: nothing is repeated', () => {
    expect(carryLaunchArgs('claude', 'claude --verbose -- hello')).toEqual({ args: [], complete: false })
    expect(carryLaunchArgs('claude', 'claude --dangerously-skip-permissions --')).toEqual({ args: [], complete: false })
  })

  it('knows the other boolean flags people put in profiles', () => {
    for (const [p, command] of [
      ['claude', 'claude --ide /review'],
      ['claude', 'claude --strict-mcp-config hello'],
      ['codex', 'codex --oss hello'],
      ['codex', 'codex --skip-git-repo-check hello'],
    ] as const) {
      expect(carryLaunchArgs(p, command), command).toEqual({ args: [], complete: false })
    }
  })

  it('does not confuse a quoted word with a flag: a quoted "--model" is just a word', () => {
    expect(carryLaunchArgs('claude', 'claude "--model" opus')).toEqual({ args: [], complete: false })
  })

  it('splits on any whitespace between words, and a quoted run holds its spaces', () => {
    expect(carryLaunchArgs('claude', "claude   --dangerously-skip-permissions\t--model   'opus  x'")).toEqual({ args: ['--dangerously-skip-permissions'], complete: true })
  })
})

describe('relaunchCommandFor with a resume target and launch flags', () => {
  it('uses each CLI\'s own "most recent" flag when asked for the latest', () => {
    expect(relaunchCommandFor('claude', 'opus', CAT, undefined, { kind: 'latest' })).toBe('claude --model opus --continue')
    expect(relaunchCommandFor('codex', 'gpt-5.6-sol', CAT, undefined, { kind: 'latest' })).toBe('codex --model gpt-5.6-sol resume --last')
    expect(relaunchCommandFor('gemini', 'gemini-3.8-flash-high', CAT, undefined, { kind: 'latest' })).toBe('agy --model gemini-3.8-flash-high --continue')
  })

  it('latest is the default, as it always was', () => {
    expect(relaunchCommandFor('claude', 'opus', CAT)).toBe('claude --model opus --continue')
  })

  it('resumes exactly the conversation it is given, in each CLI\'s own spelling', () => {
    expect(relaunchCommandFor('claude', 'opus', CAT, undefined, { kind: 'id', id: ID })).toBe(`claude --model opus --resume ${ID}`)
    expect(relaunchCommandFor('codex', 'gpt-5.6-sol', CAT, undefined, { kind: 'id', id: ID })).toBe(`codex --model gpt-5.6-sol resume ${ID}`)
    expect(relaunchCommandFor('gemini', 'gemini-3.8-flash-high', CAT, undefined, { kind: 'id', id: ID })).toBe(`agy --model gemini-3.8-flash-high --conversation=${ID}`)
  })

  it('starts a new session when there is nothing to resume', () => {
    expect(relaunchCommandFor('claude', 'opus', CAT, undefined, { kind: 'none' })).toBe('claude --model opus')
    expect(relaunchCommandFor('codex', 'gpt-5.6-sol', CAT, undefined, { kind: 'none' })).toBe('codex --model gpt-5.6-sol')
    expect(relaunchCommandFor('gemini', 'gemini-3.8-flash-high', CAT, undefined, { kind: 'none' })).toBe('agy --model gemini-3.8-flash-high')
  })

  it('puts the carried flags before the model, so a switch does not change how the agent runs', () => {
    expect(relaunchCommandFor('claude', 'opus', CAT, 'claude --dangerously-skip-permissions')).toBe('claude --dangerously-skip-permissions --model opus --continue')
    expect(relaunchCommandFor('codex', 'gpt-5.6-sol', CAT, 'codex --yolo', { kind: 'id', id: ID })).toBe(`codex --yolo --model gpt-5.6-sol resume ${ID}`)
    expect(relaunchCommandFor('gemini', 'gemini-3.8-flash-high', CAT, 'agy --effort high', { kind: 'none' })).toBe('agy --effort high --model gemini-3.8-flash-high')
  })

  it('swaps a pinned model and a resumed session for the new model and the chosen resume', () => {
    expect(relaunchCommandFor('claude', 'sonnet', CAT, 'claude --model opus --resume 3f9c1a')).toBe('claude --model sonnet --continue')
    expect(relaunchCommandFor('claude', 'sonnet', CAT, 'claude --model opus --resume 3f9c1a', { kind: 'id', id: ID })).toBe(`claude --model sonnet --resume ${ID}`)
  })

  it('refuses a resume id that is not a UUID: it reaches a command line', () => {
    for (const id of ['abc', `${ID}; rm -rf /`, '$(x)', '', `${ID}\n`, 'a b']) {
      for (const p of ['claude', 'codex', 'gemini'] as const) {
        const model = p === 'claude' ? 'opus' : p === 'codex' ? 'gpt-5.6-sol' : 'gemini-3.8-flash-high'
        expect(relaunchCommandFor(p, model, CAT, undefined, { kind: 'id', id }), `${p} ${id}`).toBe('')
      }
    }
  })

  it('still returns nothing for a model that is not offered, whatever the flags or the resume', () => {
    expect(relaunchCommandFor('claude', 'rm -rf', CAT, 'claude --dangerously-skip-permissions')).toBe('')
    expect(relaunchCommandFor('claude', 'rm -rf', CAT, undefined, { kind: 'none' })).toBe('')
    expect(relaunchCommandFor('claude', 'rm -rf', CAT, undefined, { kind: 'id', id: ID })).toBe('')
  })
})

describe('provider tables', () => {
  it('name the binary, label and install key for every provider', () => {
    const providers: ModelProvider[] = ['claude', 'codex', 'gemini']
    for (const p of providers) {
      expect(PROVIDER_BIN[p]).toBeTruthy()
      expect(PROVIDER_LABEL[p]).toBeTruthy()
      expect(PROVIDER_INSTALL_KEY[p]).toBeTruthy()
    }
    // Gemini ships as the Antigravity CLI — both the binary and the detect-map key.
    expect(PROVIDER_BIN.gemini).toBe('agy')
    expect(PROVIDER_INSTALL_KEY.gemini).toBe('agy')
  })
})

describe('REFRESH_MODELS_VALUE', () => {
  it('can never be mistaken for a model id, at either gate', () => {
    // The picker's retry row rides in the same <select> as real ids, so the sentinel has
    // to be unrepresentable as one — belt (shape rule) and braces (catalog membership).
    expect(isSafeModelId(REFRESH_MODELS_VALUE)).toBe(false)
    expect(isOfferedModel('codex', REFRESH_MODELS_VALUE, CAT)).toBe(false)
    expect(relaunchCommandFor('codex', REFRESH_MODELS_VALUE, CAT)).toBe('')
  })
})
