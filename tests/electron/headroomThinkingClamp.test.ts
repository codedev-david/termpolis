import { describe, it, expect, beforeEach, afterEach } from 'vitest'
const { rewriteMessagesBody, setThinkingCap, getThinkingCap, clampThinkingBudget, THINKING_MIN_BUDGET } =
  await import('../../src/main/headroomProxy/wireCompress')

function bodyWithThinking(thinking: unknown): string {
  return JSON.stringify({
    model: 'claude-x',
    thinking,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
}

/**
 * Output was 38% of measured effective spend and the one slice nothing compressed. The clamp is
 * the only lever that reaches thinking tokens — but it trades reasoning depth, which retrieve_full
 * cannot give back, so it ships OFF and is opt-in per user.
 */
describe('thinking-budget clamp', () => {
  beforeEach(() => setThinkingCap(0))
  afterEach(() => setThinkingCap(0))

  it('is OFF by default — an untouched body round-trips byte-identically', () => {
    expect(getThinkingCap()).toBe(0)
    const raw = bodyWithThinking({ type: 'enabled', budget_tokens: 31999 })
    const r = rewriteMessagesBody(raw)
    expect(r.changed).toBe(false)
    expect(r.body).toBe(raw)
  })

  it('lowers a declared budget to the cap when one is set', () => {
    setThinkingCap(8000)
    const r = rewriteMessagesBody(bodyWithThinking({ type: 'enabled', budget_tokens: 31999 }))
    expect(r.changed).toBe(true)
    expect(JSON.parse(r.body).thinking).toEqual({ type: 'enabled', budget_tokens: 8000 })
  })

  it('only ever LOWERS — a budget already under the cap is left alone', () => {
    setThinkingCap(8000)
    const raw = bodyWithThinking({ type: 'enabled', budget_tokens: 4000 })
    const r = rewriteMessagesBody(raw)
    expect(r.changed).toBe(false)
    expect(r.body).toBe(raw)
  })

  it("never clamps below Anthropic's floor, which would make the request invalid", () => {
    setThinkingCap(10) // absurd, but a user can type it
    const out = { thinking: { type: 'enabled', budget_tokens: 31999 } }
    expect(clampThinkingBudget(out)).toBe(true)
    expect(out.thinking.budget_tokens).toBe(THINKING_MIN_BUDGET)
  })

  it('is a pure function of (declared budget, cap) — same session, same bytes (cache safety)', () => {
    // A per-request budget would invalidate the cached prefix EVERY turn and cost far more than
    // it saved, because the Anthropic prompt cache keys on the thinking parameters.
    setThinkingCap(8000)
    const raw = bodyWithThinking({ type: 'enabled', budget_tokens: 31999 })
    expect(rewriteMessagesBody(raw).body).toBe(rewriteMessagesBody(raw).body)
  })

  it('ignores bodies with no thinking block, or a malformed one', () => {
    setThinkingCap(8000)
    for (const t of [undefined, null, 'enabled', 42, {}, { type: 'enabled' }, { budget_tokens: 'lots' }]) {
      const raw = t === undefined
        ? JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }] })
        : bodyWithThinking(t)
      const r = rewriteMessagesBody(raw)
      expect(r.changed).toBe(false)
      expect(r.body).toBe(raw)
    }
  })

  it('rejects a garbage cap rather than adopting it', () => {
    setThinkingCap(8000)
    for (const bad of [undefined, null, 'lots', NaN, Infinity, -1, {}]) {
      setThinkingCap(bad)
      expect(getThinkingCap()).toBe(8000) // unchanged by every one of them
    }
    setThinkingCap(4000.9)
    expect(getThinkingCap()).toBe(4000) // valid, floored
  })

  it('turns fully off again when set back to 0', () => {
    setThinkingCap(8000)
    setThinkingCap(0)
    const raw = bodyWithThinking({ type: 'enabled', budget_tokens: 31999 })
    expect(rewriteMessagesBody(raw).body).toBe(raw)
  })
})
