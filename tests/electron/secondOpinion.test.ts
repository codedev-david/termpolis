import { describe, it, expect, vi } from 'vitest'
import {
  buildReviewPrompt,
  modelArgs,
  claudeReadOnlyArgs,
  agyReadOnlyArgs,
  secondOpinionCommand,
  secondOpinionSpawnPlan,
  deliverWithDeadline,
  positionalPrompt,
  cleanReviewText,
  runSecondOpinion,
  reviewCommand,
  powershellPath,
  CODEX_ISOLATE_MCP_ARGS,
  CLAUDE_MUTATING_TOOLS,
  DELIVER_GRACE_MS,
  PROMPT_TOKEN,
  SECOND_OPINION_TIMEOUT_MS,
  type DeliverFn,
  type SecondOpinionAgent,
} from '../../src/main/secondOpinion'

const AGENTS: SecondOpinionAgent[] = ['claude', 'codex', 'gemini']
// Every way the three CLIs spell "don't ask, just do it" — none may reach a reviewer. Codex's
// --approve-for-me hands approvals to a model that may grant workspace-write, so it counts.
const BYPASS = /dangerously|yolo|bypass|skip-permissions|full-auto|approve-for-me|danger-full-access|workspace-write|accept-?edits|auto[-_]?edit|dont-?ask/i
const DENY = 'Bash,PowerShell,Edit,Write,NotebookEdit'
const never = (): Promise<never> => new Promise<never>(() => {})

/** Every value given to any of `flags`, in both the `--flag value` and `--flag=value`
 *  spellings. All of them, not the first: a CLI keeps the LAST value of a repeated flag. */
function valuesOf(args: string[], ...flags: string[]): string[] {
  const out: string[] = []
  args.forEach((a, i) => {
    for (const f of flags) {
      if (a === f) out.push(args[i + 1])
      else if (a.startsWith(`${f}=`)) out.push(a.slice(f.length + 1))
    }
  })
  return out
}

/** The argv must not grant an approval-free mode by any flag, and every mode it does set
 *  must be the provider's read-only one. */
function expectReadOnly(agent: SecondOpinionAgent, args: string[]): void {
  for (const a of args) expect(a).not.toMatch(BYPASS)
  expect(args).not.toContain('-y') // Gemini's short --yolo
  for (const v of valuesOf(args, '-a', '--ask-for-approval')) expect(v).not.toBe('never')
  expect(args.join(' ')).not.toMatch(/approval[\w-]*[\s="']+never/i)
  // Codex also takes its approval policy and sandbox as `-c key=value` config overrides.
  for (const v of valuesOf(args, '-c', '--config')) expect(v).not.toMatch(/approval|sandbox/i)
  if (agent === 'claude') {
    expect(valuesOf(args, '--permission-mode')).toEqual(['plan'])
    expect(valuesOf(args, '--disallowedTools', '--disallowed-tools')).toEqual([DENY])
    for (const v of valuesOf(args, '--tools', '--allowedTools', '--allowed-tools')) {
      for (const tool of v.split(',')) expect(['', 'Read', 'Grep', 'Glob']).toContain(tool)
    }
    expect(args).toContain('--strict-mcp-config')
    expect(valuesOf(args, '--mcp-config')).toEqual([])
  }
  if (agent === 'codex') expect(valuesOf(args, '--sandbox', '-s')).toEqual(['read-only'])
  if (agent === 'gemini') expect(valuesOf(args, '--mode')).toEqual(['plan'])
}

describe('buildReviewPrompt', () => {
  it('wraps content in a read-only review instruction', () => {
    const p = buildReviewPrompt('some recent output')
    expect(p).toMatch(/SECOND OPINION/)
    expect(p).toMatch(/most recent/i)
    expect(p).toContain('some recent output')
    expect(p).toMatch(/not run tools/i)
  })
  it('tail-trims very long content to maxChars (keeps the newest)', () => {
    const big = 'x'.repeat(20000) + 'TAIL_MARKER'
    const p = buildReviewPrompt(big, { maxChars: 500 })
    expect(p).toContain('TAIL_MARKER')
    expect(p.length).toBeLessThan(1200)
  })
  it('handles empty content gracefully', () => {
    expect(buildReviewPrompt('')).toContain('(the terminal output was empty)')
  })
})

describe('modelArgs', () => {
  it('claude: passes only a known alias', () => {
    expect(modelArgs('claude', 'fable')).toEqual(['--model', 'fable'])
    expect(modelArgs('claude', 'evil; rm -rf /')).toEqual([])
    expect(modelArgs('claude', 'claude-3-opus')).toEqual([]) // shape-safe, but not an alias
    expect(modelArgs('claude')).toEqual([])
  })
  it('codex: -m (its -p is --profile); gemini: --model; both shape-gated', () => {
    expect(modelArgs('codex', 'gpt-5.6-sol')).toEqual(['-m', 'gpt-5.6-sol'])
    expect(modelArgs('gemini', 'gemini-3.8-flash-high')).toEqual(['--model', 'gemini-3.8-flash-high'])
    expect(modelArgs('codex')).toEqual([])
    expect(modelArgs('gemini', '--yolo')).toEqual([])
  })
})

describe('claudeReadOnlyArgs', () => {
  it('locks the tool set twice over and never lets a variadic list swallow the prompt', () => {
    const args = claudeReadOnlyArgs(undefined, 'Read')
    expect(args).toEqual(['--permission-mode', 'plan', '--tools', 'Read', '--disallowedTools', DENY, '--strict-mcp-config', '-p', PROMPT_TOKEN])
    // --tools and --disallowedTools are variadic, so each must be followed by another flag.
    expect(args[args.indexOf('--tools') + 2]).toMatch(/^--/)
    expect(args[args.indexOf('--disallowedTools') + 2]).toMatch(/^--/)
  })
  it('denies exactly the built-ins that write, edit or run commands', () => {
    // Only tools the current CLI has: a rule naming a missing one (MultiEdit, as of 2.1.x)
    // makes claude warn on stderr, and that warning would lead every error shown to the user.
    // PowerShell is the Windows command runner, so a deny list without it only locks Unix.
    expect([...CLAUDE_MUTATING_TOOLS]).toEqual(['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit'])
    expect(CLAUDE_MUTATING_TOOLS.join(',')).toBe(DENY)
  })
})

describe('agyReadOnlyArgs', () => {
  it('puts every flag before -p, whose value is the prompt', () => {
    expect(agyReadOnlyArgs('gemini-3.8-flash-high', 30_000, ['--disable-slash-commands']))
      .toEqual(['--mode', 'plan', '--disable-slash-commands', '--print-timeout', '30s', '--model', 'gemini-3.8-flash-high', '-p', PROMPT_TOKEN])
  })
  it("rounds agy's own time limit up to whole seconds, and maps no timeout to agy's 0s (none)", () => {
    const limit = (ms: number): string => {
      const a = agyReadOnlyArgs(undefined, ms)
      return a[a.indexOf('--print-timeout') + 1]
    }
    expect(limit(1234)).toBe('2s')
    expect(limit(90_000)).toBe('90s')
    for (const none of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(limit(none)).toBe('0s')
  })
})

describe('secondOpinionCommand', () => {
  it('claude: plan mode, no tools at all, the mutating built-ins denied, no MCP servers', () => {
    const { bin, args } = secondOpinionCommand('claude')
    expect(bin).toBe('claude')
    expect(args).toEqual(['--permission-mode', 'plan', '--tools', '', '--disallowedTools', DENY, '--strict-mcp-config', '-p', PROMPT_TOKEN])
  })
  it('claude: a validated --model goes ahead of the prompt', () => {
    expect(secondOpinionCommand('claude', 'fable').args)
      .toEqual(['--permission-mode', 'plan', '--tools', '', '--disallowedTools', DENY, '--strict-mcp-config', '--model', 'fable', '-p', PROMPT_TOKEN])
  })
  it('claude: drops an invalid model alias (injection guard)', () => {
    expect(secondOpinionCommand('claude', 'evil; rm -rf /').args).toEqual(secondOpinionCommand('claude').args)
  })
  it('codex: uses `exec` (its -p is --profile), read-only, prompt as trailing positional', () => {
    const { bin, args } = secondOpinionCommand('codex')
    expect(bin).toBe('codex')
    expect(args).toEqual(['exec', '--sandbox', 'read-only', '--skip-git-repo-check', PROMPT_TOKEN])
    expect(args[args.length - 1]).toBe(PROMPT_TOKEN) // codex takes the prompt as a trailing positional
  })
  it('codex: passes a discovered model with -m, BEFORE the positional prompt', () => {
    const { args } = secondOpinionCommand('codex', 'gpt-5.6-sol')
    expect(args).toEqual(['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-m', 'gpt-5.6-sol', PROMPT_TOKEN])
  })
  it('gemini: routed through the Antigravity CLI (agy) in plan mode, bounded by the review timeout', () => {
    const { bin, args } = secondOpinionCommand('gemini')
    expect(bin).toBe('agy')
    expect(args).toEqual(['--mode', 'plan', '--disable-slash-commands', '--print-timeout', '90s', '-p', PROMPT_TOKEN])
  })
  it('gemini: passes a discovered model with --model, and its time limit follows the timeout', () => {
    expect(secondOpinionCommand('gemini', 'gemini-3.8-flash-high', 1234).args)
      .toEqual(['--mode', 'plan', '--disable-slash-commands', '--print-timeout', '2s', '--model', 'gemini-3.8-flash-high', '-p', PROMPT_TOKEN])
  })
  it('codex/gemini: drop a model that fails the shape gate rather than passing it through', () => {
    // These namespaces are discovered at runtime so there is no enum to match against —
    // isSafeModelId is the gate, and the caller has already checked catalog membership.
    for (const bad of ['--sandbox', 'a; rm -rf /', '-m', 'a b']) {
      expect(secondOpinionCommand('codex', bad).args).not.toContain('-m')
      expect(secondOpinionCommand('gemini', bad).args).not.toContain('--model')
    }
  })
  it('the prompt token is always the last argv entry, and appears exactly once', () => {
    for (const agent of AGENTS) {
      const { args } = secondOpinionCommand(agent, 'opus')
      expect(args[args.length - 1]).toBe(PROMPT_TOKEN)
      expect(args.filter((a) => a === PROMPT_TOKEN)).toHaveLength(1)
      if (agent !== 'codex') expect(args[args.length - 2]).toBe('-p')
    }
  })
  it('no provider is ever launched with a bypass/yolo flag, whatever model is asked for', () => {
    const models = [
      undefined, 'fable', 'haiku', 'gpt-5.6-sol', 'gemini-3.8-flash-high',
      '--dangerously-skip-permissions', '--yolo', '--full-auto', '--dangerously-bypass-approvals-and-sandbox',
      '--permission-mode=bypassPermissions', '--approval-mode=yolo',
      '-y', '--approve-for-me', '--sandbox=danger-full-access', '--mode=accept-edits', 'approval_policy=never',
    ]
    for (const agent of AGENTS) {
      for (const model of models) {
        for (const timeout of [SECOND_OPINION_TIMEOUT_MS, 0]) expectReadOnly(agent, secondOpinionCommand(agent, model, timeout).args)
      }
    }
  })
  it('the read-only guard itself fails an argv that sneaks any bypass back in', () => {
    // A guard that cannot fail proves nothing, so every spelling is run against it.
    const good = (agent: SecondOpinionAgent): string[] => secondOpinionCommand(agent, undefined).args
    const tampered: Array<[SecondOpinionAgent, string[]]> = [
      ['claude', [...good('claude'), '--permission-mode', 'acceptEdits']],
      ['claude', [...good('claude'), '--permission-mode=auto']],
      ['claude', [...good('claude'), '--allowedTools', 'Bash']],
      ['claude', [...good('claude'), '--tools', 'default']],
      ['claude', [...good('claude'), '--mcp-config', 'servers.json']],
      ['claude', good('claude').filter((a) => a !== '--strict-mcp-config')],
      ['codex', [...good('codex'), '-s', 'workspace-write']],
      ['codex', [...good('codex'), '--approve-for-me']],
      ['codex', [...good('codex'), '-a', 'never']],
      ['codex', [...good('codex'), '-c', 'approval_policy="never"']],
      ['codex', [...good('codex'), '--config=sandbox_permissions=["disk-full-write-access"]']],
      ['gemini', [...good('gemini'), '--mode', 'accept-edits']],
      ['gemini', [...good('gemini'), '-y']],
      ['gemini', [...good('gemini'), '--approval-mode', 'auto_edit']],
    ]
    for (const [agent, args] of tampered) expect(() => expectReadOnly(agent, args), args.join(' ')).toThrow()
    for (const agent of AGENTS) expect(() => expectReadOnly(agent, good(agent))).not.toThrow()
  })
})

describe('secondOpinionSpawnPlan', () => {
  const args = ['exec', '--sandbox', 'read-only', PROMPT_TOKEN]
  it('unix: spawns the binary directly with the prompt substituted for the token (no shell)', () => {
    const { cmd, cmdArgs } = secondOpinionSpawnPlan(false, 'codex', args, PROMPT_TOKEN, 'REVIEW THIS')
    expect(cmd).toBe('codex')
    expect(cmdArgs).toEqual(['exec', '--sandbox', 'read-only', 'REVIEW THIS'])
  })
  it('unix: passes an empty argv entry (claude `--tools ""`) through as an empty argument', () => {
    const { cmdArgs } = secondOpinionSpawnPlan(false, 'claude', secondOpinionCommand('claude').args, PROMPT_TOKEN, 'p')
    expect(cmdArgs[cmdArgs.indexOf('--tools') + 1]).toBe('')
    expect(cmdArgs[cmdArgs.length - 1]).toBe('p')
  })
  it('windows: runs via PowerShell with the prompt read from a file into $p — never on the command line', () => {
    const { cmd, cmdArgs } = secondOpinionSpawnPlan(true, 'codex', args, PROMPT_TOKEN, 'REVIEW THIS; rm -rf /')
    // By absolute path: the run's cwd may be a repo, and Windows looks there before PATH.
    expect(cmd).toBe(powershellPath())
    expect(cmdArgs.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    const script = cmdArgs[cmdArgs.length - 1]
    expect(script).toBe([
      "$ErrorActionPreference='Stop'",
      // [string] keeps an empty file an (empty) argument instead of no argument at all.
      '$p = [string](Get-Content -Raw -Encoding UTF8 -LiteralPath $env:TP_SO_FILE)',
      // PowerShell 5.1 only wraps an argument in quotes when it sees whitespace ahead of the
      // first quote, and never escapes inside — so guarantee the wrap, then pre-escape for it.
      String.raw`if ($p -notmatch '^[^"]*\s') { $p = ' ' + $p }`,
      String.raw`$p = ($p -replace '(\\*)"', '$1$1\"') -replace '(\\+)\z', '$1$1'`,
      "$c = Get-Command -Name 'codex' -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1",
      String.raw`if ($c.CommandType -eq 'Application' -and $c.Path -match '\.(bat|cmd)$') { throw ($c.Path + ' is a batch-file shim; Termpolis will not pass an untrusted prompt through cmd.exe') }`,
      "& $c 'exec' '--sandbox' 'read-only' $p", // token → $p, flags quoted
    ].join('; '))
    expect(script).not.toContain('REVIEW THIS') // the untrusted prompt is out-of-band, not interpolated
  })
  it('windows: keeps an empty argv entry as a real empty argument', () => {
    // PowerShell 5.1 drops a bare '' when calling a native command; '""' reaches it as "".
    const script = secondOpinionSpawnPlan(true, 'claude', secondOpinionCommand('claude').args, PROMPT_TOKEN, 'x').cmdArgs[3]
    expect(script).toContain(`& $c '--permission-mode' 'plan' '--tools' '""' '--disallowedTools' '${DENY}' '--strict-mcp-config' '-p' $p`)
  })
  it('windows: escapes single quotes in the binary name and in argv entries (defensive)', () => {
    const script = secondOpinionSpawnPlan(true, "ev'il", ["it's", PROMPT_TOKEN], PROMPT_TOKEN, 'x').cmdArgs[3]
    expect(script).toContain("Get-Command -Name 'ev''il' ")
    expect(script).toContain("& $c 'it''s' $p")
  })
  it('windows: doubles every character PowerShell reads as a single quote, not just the ASCII one', () => {
    // U+2018 to U+201B close a single-quoted literal too, so a folder name holding one would end
    // its literal early and run the rest as script.
    const script = secondOpinionSpawnPlan(true, 'x\u2019', ['-C', 'a\u2018b\u2019c\u201ad\u201be\'f', PROMPT_TOKEN], PROMPT_TOKEN, 'x').cmdArgs[3]
    expect(script).toContain("Get-Command -Name 'x\u2019\u2019' ")
    expect(script).toContain("& $c '-C' 'a\u2018\u2018b\u2019\u2019c\u201a\u201ad\u201b\u201be''f' $p")
  })
  it('windows: decides who gets wrapped by .NET\'s whitespace, which is not JS\'s \\s', () => {
    const literal = (a: string): string => {
      const script = secondOpinionSpawnPlan(true, 'codex', [a, PROMPT_TOKEN], PROMPT_TOKEN, 'x').cmdArgs[3]
      return script.slice(script.indexOf('& $c ') + 5, script.lastIndexOf(' $p'))
    }
    // NEL is .NET whitespace (5.1 wraps), and U+180E was before Unicode 6.3: doubling where 5.1
    // adds no quotes costs an extra separator, while missing a wrap would split the arguments.
    expect(literal('a\u0085b\\')).toBe("'a\u0085b\\\\'")
    expect(literal('a\u180eb\\')).toBe("'a\u180eb\\\\'")
    expect(literal('a\u3000b\\')).toBe("'a\u3000b\\\\'")
    // The BOM is \s to JS but never whitespace to .NET, so 5.1 passes it bare: nothing to double.
    expect(literal('a\ufeffb\\')).toBe("'a\ufeffb\\'")
  })
  it('windows: doubles the trailing backslashes of an argv entry that 5.1 will wrap in quotes', () => {
    // 5.1 wraps an entry with whitespace in quotes and escapes nothing, so `C:\Program Files\`
    // would reach the child as `"C:\Program Files\"`, whose `\"` is an escaped quote. The entry
    // would then run on into the prompt, and the prompt's words would become separate arguments.
    const script = secondOpinionSpawnPlan(true, 'codex', ['-C', 'C:\\Program Files\\', '--x', 'C:\\Win\\', 'a b\\c', 'a b\\\\', PROMPT_TOKEN], PROMPT_TOKEN, 'x').cmdArgs[3]
    expect(script).toContain(String.raw`& $c '-C' 'C:\Program Files\\' '--x' 'C:\Win\' 'a b\c' 'a b\\\\' $p`)
  })
  it('windows: refuses an argv entry with a double quote, which 5.1 cannot pass intact', () => {
    expect(() => secondOpinionSpawnPlan(true, 'codex', ['-c', 'model="o3"', PROMPT_TOKEN], PROMPT_TOKEN, 'x')).toThrow(/double quote/)
    // Only Windows needs it: elsewhere the entry is exec'd as it is.
    expect(secondOpinionSpawnPlan(false, 'codex', ['-c', 'model="o3"', PROMPT_TOKEN], PROMPT_TOKEN, 'x').cmdArgs).toEqual(['-c', 'model="o3"', 'x'])
  })
})

describe('powershellPath', () => {
  it('resolves Windows PowerShell 5.1 under SystemRoot, then windir, then C:\\Windows', () => {
    expect(powershellPath({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(powershellPath({ windir: 'E:\\W' })).toBe('E:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(powershellPath({})).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })
  it('reads this process\'s environment by default', () => {
    expect(powershellPath()).toBe(powershellPath(process.env))
  })
})

describe('positionalPrompt', () => {
  it('leaves an ordinary prompt alone', () => {
    expect(positionalPrompt('review this output')).toBe('review this output')
    expect(positionalPrompt(' already spaced')).toBe(' already spaced')
    expect(positionalPrompt('a-b c')).toBe('a-b c')
  })
  it('keeps a prompt that starts with a dash from being read as a flag', () => {
    expect(positionalPrompt('--dangerously-skip-permissions')).toBe(' --dangerously-skip-permissions')
    expect(positionalPrompt('--settings={ "hooks": {} } go')).toBe(' --settings={ "hooks": {} } go')
    expect(positionalPrompt('-')).toBe(' -') // codex exec would read `-` as "take the prompt from stdin"
  })
  it('keeps a one-word prompt from being read as a subcommand', () => {
    expect(positionalPrompt('update')).toBe(' update')
    expect(positionalPrompt('review')).toBe(' review')
    expect(positionalPrompt('')).toBe(' ')
  })
})

describe('deliverWithDeadline', () => {
  it('hands deliver the prompt as a positional, whatever the caller passed', async () => {
    const deliver = vi.fn(async () => ({ stdout: 'ok', code: 0 }))
    await deliverWithDeadline(deliver, 'claude', ['-p', PROMPT_TOKEN], '--permission-mode=bypassPermissions', 0)
    expect(deliver).toHaveBeenCalledWith('claude', ['-p', PROMPT_TOKEN], ' --permission-mode=bypassPermissions', PROMPT_TOKEN, { timeoutMs: 0 })
  })
  it("passes deliver's result straight through, with the token and the timeout, and clears its timer", async () => {
    vi.useFakeTimers()
    try {
      const deliver = vi.fn(async () => ({ stdout: 'ok', code: 0 }))
      await expect(deliverWithDeadline(deliver, 'codex', ['exec', PROMPT_TOKEN], 'the prompt', 1234)).resolves.toEqual({ stdout: 'ok', code: 0 })
      expect(deliver).toHaveBeenCalledWith('codex', ['exec', PROMPT_TOKEN], 'the prompt', PROMPT_TOKEN, { timeoutMs: 1234 })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it("propagates deliver's own rejection and clears its timer", async () => {
    vi.useFakeTimers()
    try {
      const deliver: DeliverFn = async () => { throw new Error('spawn ENOENT') }
      await expect(deliverWithDeadline(deliver, 'claude', [], 'p', 90_000)).rejects.toThrow('spawn ENOENT')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('abandons a call still running at timeout + grace, with a legible error — and not a moment before', async () => {
    vi.useFakeTimers()
    try {
      let settled = 'pending'
      const done = deliverWithDeadline(never, 'claude', [], 'p', 90_000).then(() => { settled = 'resolved' }, (e: Error) => { settled = e.message })
      await vi.advanceTimersByTimeAsync(90_000 + DELIVER_GRACE_MS - 1)
      expect(settled).toBe('pending')
      await vi.advanceTimersByTimeAsync(1)
      await done
      expect(settled).toBe('claude did not finish within 90s')
    } finally {
      vi.useRealTimers()
    }
  })
  it('forwards the working folder, extra environment and abort signal to deliver', async () => {
    const deliver = vi.fn(async () => ({ stdout: 'ok', code: 0 }))
    const signal = new AbortController().signal
    await deliverWithDeadline(deliver, 'codex', ['exec', PROMPT_TOKEN], 'the prompt', 0, 10, { cwd: '/repo', env: { TERMPOLIS_LINKED_JOB: 'abc' }, signal })
    expect(deliver).toHaveBeenCalledWith('codex', ['exec', PROMPT_TOKEN], 'the prompt', PROMPT_TOKEN, {
      timeoutMs: 0, cwd: '/repo', env: { TERMPOLIS_LINKED_JOB: 'abc' }, signal,
    })
  })
  it('keeps its own timeout over one smuggled into the extras', async () => {
    const deliver = vi.fn(async () => ({ stdout: 'ok', code: 0 }))
    await deliverWithDeadline(deliver, 'claude', [], 'the prompt', 0, 10, { timeoutMs: 1 } as never)
    expect(deliver).toHaveBeenCalledWith('claude', [], 'the prompt', PROMPT_TOKEN, { timeoutMs: 0 })
  })
  it('honours a custom grace period', async () => {
    vi.useFakeTimers()
    try {
      const done = expect(deliverWithDeadline(never, 'agy', [], 'p', 1000, 10)).rejects.toThrow('agy did not finish within 1s')
      await vi.advanceTimersByTimeAsync(1010)
      await done
    } finally {
      vi.useRealTimers()
    }
  })
  it('adds no deadline when there is no timeout (zero, negative or non-finite)', () => {
    vi.useFakeTimers()
    try {
      for (const t of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const run = Promise.resolve({ stdout: '', code: 0 })
        expect(deliverWithDeadline(() => run, 'claude', [], 'p', t)).toBe(run)
      }
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('caps the deadline at the largest delay a timer can hold, so a huge timeout never fires at once', () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(globalThis, 'setTimeout')
    try {
      void deliverWithDeadline(never, 'claude', [], 'p', 2 ** 31).catch(() => {})
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][1]).toBe(2_147_483_647)
    } finally {
      spy.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('cleanReviewText', () => {
  it('strips CSI sequences, including the bracketed-paste terminator', () => {
    expect(cleanReviewText('a\x1b[31mred\x1b[0m b')).toBe('ared b')
    expect(cleanReviewText('x\x1b[201~y\x1b[200~z')).toBe('xyz')
  })
  it('strips OSC strings ended by BEL or ST, keeping a hyperlink’s visible text', () => {
    expect(cleanReviewText('\x1b]0;title\x07after')).toBe('after')
    expect(cleanReviewText('\x1b]0;title\x1b\\after')).toBe('after')
    expect(cleanReviewText('\x1b]8;;https://example.com\x1b\\link text\x1b]8;;\x1b\\')).toBe('link text')
  })
  it('strips DCS strings and the short ESC forms', () => {
    expect(cleanReviewText('\x1bPq#0;2;0;0;0\x1b\\done')).toBe('done')
    expect(cleanReviewText('\x1b7a\x1b8\x1bc\x1b(Bb')).toBe('ab')
  })
  it('drops a stray or unterminated ESC rather than leaving it live', () => {
    expect(cleanReviewText('end\x1b')).toBe('end')
    expect(cleanReviewText('\x1b]0;title')).toBe('0;title')
  })
  it('does not let the removal of one sequence reassemble another', () => {
    expect(cleanReviewText('\x1b\x1b[0m[201~')).toBe('[201~')
  })
  it('strips C0, DEL and C1 controls (C1 CSI included) but keeps tabs and newlines', () => {
    expect(cleanReviewText('a\x00b\x07c\x08d\x7fe')).toBe('abcde')
    expect(cleanReviewText('\x9b201~')).toBe('201~')
    expect(cleanReviewText('a\tb\nc')).toBe('a\tb\nc')
  })
  it('normalises CRLF and a lone CR to LF', () => {
    expect(cleanReviewText('a\r\nb\rc')).toBe('a\nb\nc')
  })
  it('leaves no control character behind, whatever follows an ESC', () => {
    for (let c = 0; c <= 0x9f; c++) {
      const ch = String.fromCharCode(c)
      expect(cleanReviewText(`a${ch}b\x1b${ch}z\x1b[${ch}`)).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
    }
  })
  it('stays linear on a flood of unterminated strings', () => {
    const unit = '\x1b]0;' + 'x'.repeat(10)
    expect(cleanReviewText(unit.repeat(20_000))).toBe(('0;' + 'x'.repeat(10)).repeat(20_000))
  })
})

describe('runSecondOpinion', () => {
  it('delivers the prompt out-of-band (argv carries only the placeholder) and returns feedback', async () => {
    const deliver: DeliverFn = vi.fn(async () => ({ stdout: '  Looks good, but check the edge case.  ', code: 0 }))
    const r = await runSecondOpinion({ agent: 'codex', content: 'the answer' }, deliver)
    expect(r.ok).toBe(true)
    expect(r.feedback).toBe('Looks good, but check the edge case.')
    const [bin, args, prompt, token, opts] = (deliver as any).mock.calls[0]
    expect(bin).toBe('codex')
    expect(args).toContain(token) // argv carries the placeholder…
    expect(args).not.toContain(prompt) // …never the raw prompt
    expect(prompt).toContain('the answer') // prompt is delivered separately
    expect(token).toBe(PROMPT_TOKEN)
    // Marked read-only, so an agent that hands its environment to its MCP servers (agy) gets
    // Termpolis's read-only tools only while it reads untrusted terminal output.
    expect(opts).toEqual({ timeoutMs: SECOND_OPINION_TIMEOUT_MS, env: { TERMPOLIS_READ_ONLY_RUN: '1' } })
    expect(SECOND_OPINION_TIMEOUT_MS).toBe(90_000)
  })
  it('launches every provider read-only', async () => {
    for (const agent of AGENTS) {
      const deliver = vi.fn(async () => ({ stdout: 'ok', code: 0 }))
      await runSecondOpinion({ agent, content: 'x' }, deliver)
      const [bin, args] = deliver.mock.calls[0] as unknown as [string, string[]]
      expect(bin).toBe(secondOpinionCommand(agent).bin)
      expectReadOnly(agent, args)
    }
  })
  it('passes a custom timeout to deliver and to agy’s own time limit', async () => {
    const deliver = vi.fn(async () => ({ stdout: 'ok', code: 0 }))
    await runSecondOpinion({ agent: 'gemini', content: 'x', timeoutMs: 30_000 }, deliver)
    const [, args, , , opts] = deliver.mock.calls[0] as unknown as [string, string[], string, string, { timeoutMs: number }]
    expect(opts).toEqual({ timeoutMs: 30_000, env: { TERMPOLIS_READ_ONLY_RUN: '1' } })
    expect(args.slice(args.indexOf('--print-timeout'), args.indexOf('--print-timeout') + 2)).toEqual(['--print-timeout', '30s'])
  })
  it('strips terminal control sequences from the feedback, which is pasted into a terminal', async () => {
    const deliver: DeliverFn = async () => ({ stdout: '\x1b[1mBold\x1b[0m point\x1b[201~ echo pwned\r\n', code: 0 })
    const r = await runSecondOpinion({ agent: 'claude', content: 'x' }, deliver)
    expect(r).toEqual({ ok: true, feedback: 'Bold point echo pwned' })
  })
  it('treats output that is nothing but control sequences as no output', async () => {
    const deliver: DeliverFn = async () => ({ stdout: '\x1b[0m\x1b[?25h', code: 0 })
    const r = await runSecondOpinion({ agent: 'claude', content: 'x' }, deliver)
    expect(r).toEqual({ ok: false, error: 'claude exited with code 0 and produced no output' })
  })
  it('reports an error on a non-zero exit', async () => {
    const deliver: DeliverFn = async () => ({ stdout: '', code: 1 })
    const r = await runSecondOpinion({ agent: 'gemini', content: 'x' }, deliver)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/exited with code 1/)
  })
  it('reports an error (never throws) when deliver rejects', async () => {
    const deliver: DeliverFn = async () => { throw new Error('spawn ENOENT') }
    const r = await runSecondOpinion({ agent: 'claude', model: 'haiku', content: 'x' }, deliver)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/ENOENT/)
  })
  it("surfaces the agent's stderr in the error (so an auth failure is legible), cleaned", async () => {
    const deliver: DeliverFn = async () => ({ stdout: '', stderr: '\x1b[31mError authenticating: IneligibleTierError\x1b[0m', code: 1 })
    const r = await runSecondOpinion({ agent: 'gemini', content: 'x' }, deliver)
    expect(r).toEqual({ ok: false, error: 'Error authenticating: IneligibleTierError' })
  })
  it('falls back to a generic message when the thrown value has no .message', async () => {
    const deliver = (async () => { throw 'boom' }) as unknown as DeliverFn // non-Error throw
    const r = await runSecondOpinion({ agent: 'codex', content: 'x' }, deliver)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('second opinion failed') // the `|| 'second opinion failed'` fallback
  })
  it('gives up on a reviewer that never returns (e.g. stuck on an approval prompt) at the deadline', async () => {
    vi.useFakeTimers()
    try {
      const pending = runSecondOpinion({ agent: 'claude', content: 'x' }, never)
      await vi.advanceTimersByTimeAsync(SECOND_OPINION_TIMEOUT_MS + DELIVER_GRACE_MS)
      await expect(pending).resolves.toEqual({ ok: false, error: 'claude did not finish within 90s' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('reviewCommand: what a Second Opinion review runs', () => {
  it("switches Termpolis's MCP server off for a codex review, ahead of the prompt", () => {
    const { bin, args } = reviewCommand('codex', 'gpt-5.6-sol')
    expect(bin).toBe('codex')
    expect(args).toEqual(['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-m', 'gpt-5.6-sol', ...CODEX_ISOLATE_MCP_ARGS, PROMPT_TOKEN])
  })

  it('leaves claude (no MCP servers already) and agy (narrowed by the read-only marker) as they are', () => {
    for (const agent of ['claude', 'gemini'] as const) {
      expect(reviewCommand(agent, undefined, 30_000)).toEqual(secondOpinionCommand(agent, undefined, 30_000))
    }
  })

  it('runs every review through it, marked read-only', async () => {
    const deliver = vi.fn(async () => ({ stdout: 'ok', code: 0 }))
    await runSecondOpinion({ agent: 'codex', content: 'x' }, deliver)
    const [, args, , , opts] = deliver.mock.calls[0] as unknown as [string, string[], string, string, { env: Record<string, string> }]
    expect(args).toEqual(expect.arrayContaining([...CODEX_ISOLATE_MCP_ARGS]))
    expect(opts.env).toEqual({ TERMPOLIS_READ_ONLY_RUN: '1' })
  })
})
