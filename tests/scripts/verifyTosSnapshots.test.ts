import { describe, it, expect } from 'vitest'
// CommonJS interop — verifyTosSnapshots.cjs exports normalizeHtml/hash/PROVIDERS.
// We pull the live module so this test fails the second the snapshot script
// regresses on the rules below.
const { normalizeHtml, hash, PROVIDERS } = require('../../scripts/verifyTosSnapshots.cjs') as {
  normalizeHtml: (s: string) => string
  hash: (s: string) => string
  PROVIDERS: Array<{ id: string; label: string; url: string; expectKeywords: string[] }>
}

describe('verifyTosSnapshots — normalizeHtml', () => {
  it('strips <script>, <style>, <noscript>, <svg>, <head> blocks completely', () => {
    const html = `<head><meta name="x"/></head><body><script>alert("hi")</script><style>body{}</style><noscript>no js</noscript><svg><path/></svg><p>real text</p></body>`
    expect(normalizeHtml(html)).toBe('real text')
  })

  it('drops HTML comments — common churn source on enterprise CMSes', () => {
    const html = `<p>visible<!-- build:abc123 --> text</p>`
    expect(normalizeHtml(html)).toBe('visible text')
  })

  it('replaces tags with spaces so <span>foo</span><span>bar</span> does not fuse to "foobar"', () => {
    const html = `<span>foo</span><span>bar</span>`
    expect(normalizeHtml(html)).toBe('foo bar')
  })

  it('decodes the HTML entities that show up in real ToS text', () => {
    const html = `<p>AT&amp;T &lt;input&gt; &quot;a&quot; &#39;b&#39; &nbsp; &apos;c&apos;</p>`
    expect(normalizeHtml(html)).toBe('AT&T <input> "a" \'b\' \'c\'')
  })

  it('collapses runs of whitespace to a single space', () => {
    const html = `<p>line one\n\n\n\tline   two</p>`
    expect(normalizeHtml(html)).toBe('line one line two')
  })

  it('is stable across whitespace-only churn (so a CDN re-deploy with reflowed HTML does not flap drift)', () => {
    const a = `<body><p>Data is not used to train models.</p></body>`
    const b = `<body>\n  <p>\n    Data is not used to train models.\n  </p>\n</body>`
    expect(normalizeHtml(a)).toBe(normalizeHtml(b))
    expect(hash(normalizeHtml(a))).toBe(hash(normalizeHtml(b)))
  })

  it('changes hash when the actual prose changes', () => {
    const before = `<p>Inputs are not used to train our models.</p>`
    const after = `<p>Inputs may be used to train our models.</p>`
    expect(hash(normalizeHtml(before))).not.toBe(hash(normalizeHtml(after)))
  })

  it('returns empty string for an empty body — script will flag this as drift', () => {
    expect(normalizeHtml('<html><body></body></html>')).toBe('')
  })

  it('strips script content even when it includes < and > inside string literals', () => {
    const html = `<script>const x = "<p>injected</p>"; if (a < b && c > d) {}</script><p>visible</p>`
    expect(normalizeHtml(html)).toBe('visible')
  })
})

describe('verifyTosSnapshots — hash', () => {
  it('produces a stable sha256 hex string', () => {
    expect(hash('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  it('different content produces different hash', () => {
    expect(hash('a')).not.toBe(hash('b'))
  })
})

describe('verifyTosSnapshots — PROVIDERS config', () => {
  it('has one entry per AI agent that AGENT_FACTS in src/main/aiSecurity.ts ships', () => {
    const ids = PROVIDERS.map(p => p.id).sort()
    // If you add or remove an agent in AGENT_FACTS, mirror it here so the
    // weekly drift watcher actually covers the agent.
    expect(ids).toEqual(['anthropic', 'google-gemini', 'openai'])
  })

  it('every provider has an https URL and at least one expected keyword', () => {
    for (const p of PROVIDERS) {
      expect(p.url.startsWith('https://')).toBe(true)
      expect(p.expectKeywords.length).toBeGreaterThan(0)
    }
  })
})

describe('verifyTosSnapshots — site chrome is not part of the terms', () => {
  // Anthropic added a "Leadership" link to its top nav on 2026-08-24 and the watcher
  // called it a terms change: `status: drift`, `missingKeywords: []`, not one word of
  // prose different. That was the fourth such refresh in the git log. A security alarm
  // that cries wolf on marketing copy stops being read, so nav and footer are stripped.
  it('strips <nav> — a masthead menu cannot state a term of service', () => {
    const before = `<nav>Research Policy Learn News</nav><p>may not train models</p>`
    const after = `<nav>Research Policy Leadership Learn News</nav><p>may not train models</p>`
    expect(normalizeHtml(before)).toBe('may not train models')
    expect(hash(normalizeHtml(before))).toBe(hash(normalizeHtml(after)))
  })

  it('strips <footer> — whose copyright year is guaranteed to churn every January', () => {
    const y2026 = `<p>Inputs are not used to train.</p><footer>Privacy policy © 2026 Anthropic PBC</footer>`
    const y2027 = `<p>Inputs are not used to train.</p><footer>Privacy policy © 2027 Anthropic PBC</footer>`
    expect(normalizeHtml(y2026)).toBe('Inputs are not used to train.')
    expect(hash(normalizeHtml(y2026))).toBe(hash(normalizeHtml(y2027)))
  })

  it('KEEPS <header> — it carries the effective date, the most valuable line to watch', () => {
    const html = `<header>Commercial Terms of Service Effective June 17, 2025</header><p>body</p>`
    expect(normalizeHtml(html)).toBe('Commercial Terms of Service Effective June 17, 2025 body')
  })

  it('a new effective date still drifts the hash even though chrome no longer does', () => {
    const jun = `<nav>a</nav><header>Effective June 17, 2025</header><p>x</p><footer>c</footer>`
    const sep = `<nav>b</nav><header>Effective September 1, 2026</header><p>x</p><footer>d</footer>`
    expect(hash(normalizeHtml(jun))).not.toBe(hash(normalizeHtml(sep)))
  })

  it('drops a <nav> nested inside <header> without taking the header prose with it', () => {
    // anthropic.com nests its menu inside the masthead; the effective date sits in a
    // second <header>. Stripping must reach the inner nav and stop there.
    const html = `<header><nav>Research Leadership</nav>Skip to main content</header><p>prose</p>`
    const out = normalizeHtml(html)
    expect(out).not.toContain('Leadership')
    expect(out).toContain('Skip to main content')
    expect(out).toContain('prose')
  })

  it('still fails loudly when real prose changes — chrome stripping is not a mute button', () => {
    const ok = `<nav>x</nav><p>Anthropic may not train models on Customer Content.</p>`
    const bad = `<nav>x</nav><p>Anthropic may train models on Customer Content.</p>`
    expect(hash(normalizeHtml(ok))).not.toBe(hash(normalizeHtml(bad)))
  })
})
