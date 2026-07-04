import { describe, it, expect, vi } from 'vitest'
import { buildReviewPrompt, secondOpinionCommand, secondOpinionSpawnPlan, runSecondOpinion, PROMPT_TOKEN, type DeliverFn } from '../../src/main/secondOpinion'

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

describe('secondOpinionCommand', () => {
  it('claude: -p <prompt> + validated --model + skip-permissions', () => {
    const { bin, args } = secondOpinionCommand('claude', 'fable')
    expect(bin).toBe('claude')
    expect(args).toEqual(['-p', PROMPT_TOKEN, '--model', 'fable', '--dangerously-skip-permissions'])
  })
  it('claude: drops an invalid model alias (injection guard)', () => {
    expect(secondOpinionCommand('claude', 'evil; rm -rf /').args).toEqual(['-p', PROMPT_TOKEN, '--dangerously-skip-permissions'])
  })
  it('codex: uses `exec` (its -p is --profile), read-only, prompt as trailing positional', () => {
    const { bin, args } = secondOpinionCommand('codex')
    expect(bin).toBe('codex')
    expect(args).toEqual(['exec', '--sandbox', 'read-only', '--skip-git-repo-check', PROMPT_TOKEN])
    expect(args[args.length - 1]).toBe(PROMPT_TOKEN) // codex takes the prompt as a trailing positional
  })
  it('gemini: routed through the Antigravity CLI (agy) headless, not the deprecated gemini binary', () => {
    const { bin, args } = secondOpinionCommand('gemini')
    expect(bin).toBe('agy')
    expect(args).toEqual(['-p', PROMPT_TOKEN, '--dangerously-skip-permissions'])
  })
  it('qwen: -p <prompt> (Gemini-CLI fork)', () => {
    const { bin, args } = secondOpinionCommand('qwen')
    expect(bin).toBe('qwen')
    expect(args).toEqual(['-p', PROMPT_TOKEN])
  })
})

describe('secondOpinionSpawnPlan', () => {
  const args = ['exec', '--sandbox', 'read-only', PROMPT_TOKEN]
  it('unix: spawns the binary directly with the prompt substituted for the token (no shell)', () => {
    const { cmd, cmdArgs } = secondOpinionSpawnPlan(false, 'codex', args, PROMPT_TOKEN, 'REVIEW THIS')
    expect(cmd).toBe('codex')
    expect(cmdArgs).toEqual(['exec', '--sandbox', 'read-only', 'REVIEW THIS'])
  })
  it('windows: runs via PowerShell with the prompt read from a file into $p — never on the command line', () => {
    const { cmd, cmdArgs } = secondOpinionSpawnPlan(true, 'codex', args, PROMPT_TOKEN, 'REVIEW THIS; rm -rf /')
    expect(cmd).toBe('powershell.exe')
    const script = cmdArgs[cmdArgs.length - 1]
    expect(cmdArgs.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(script).toContain('$p = Get-Content -Raw -LiteralPath $env:TP_SO_FILE')
    expect(script).toContain("& 'codex' 'exec' '--sandbox' 'read-only' $p") // token → $p, flags quoted
    expect(script).not.toContain('REVIEW THIS') // the untrusted prompt is out-of-band, not interpolated
  })
  it('windows: escapes single quotes in the binary name (defensive)', () => {
    const { cmdArgs } = secondOpinionSpawnPlan(true, "ev'il", [PROMPT_TOKEN], PROMPT_TOKEN, 'x')
    expect(cmdArgs[cmdArgs.length - 1]).toContain("& 'ev''il' $p")
  })
})

describe('runSecondOpinion', () => {
  it('delivers the prompt out-of-band (argv carries only the placeholder) and returns feedback', async () => {
    const deliver: DeliverFn = vi.fn(async () => ({ stdout: '  Looks good, but check the edge case.  ', code: 0 }))
    const r = await runSecondOpinion({ agent: 'codex', content: 'the answer' }, deliver)
    expect(r.ok).toBe(true)
    expect(r.feedback).toBe('Looks good, but check the edge case.')
    const [bin, args, prompt, token] = (deliver as any).mock.calls[0]
    expect(bin).toBe('codex')
    expect(args).toContain(token) // argv carries the placeholder…
    expect(args).not.toContain(prompt) // …never the raw prompt
    expect(prompt).toContain('the answer') // prompt is delivered separately
    expect(token).toBe(PROMPT_TOKEN)
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
  it("surfaces the agent's stderr in the error (so an auth failure is legible)", async () => {
    const deliver: DeliverFn = async () => ({ stdout: '', stderr: 'Error authenticating: IneligibleTierError', code: 1 })
    const r = await runSecondOpinion({ agent: 'gemini', content: 'x' }, deliver)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/IneligibleTierError/)
  })
  it('falls back to a generic message when the thrown value has no .message', async () => {
    const deliver = (async () => { throw 'boom' }) as unknown as DeliverFn // non-Error throw
    const r = await runSecondOpinion({ agent: 'codex', content: 'x' }, deliver)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('second opinion failed') // the `|| 'second opinion failed'` fallback
  })
})
