import { describe, it, expect } from 'vitest'
const { compactWeb, looksLikeHtml } = await import('../../src/main/headroom/compactWeb')

const HTML = [
  '<!doctype html>',
  '<html><head><title>PageTitleInHead</title>',
  '<style>.a{color:red}</style>',
  '<script>var a=1; doTrack();</script>',
  '</head>',
  '<body>',
  '<script>track();</script>',
  '<nav><a href="/">Home</a> <a href="/about">About</a></nav>',
  '<h1>Main Heading</h1>',
  '<p>Rain &amp; wind today. Temp &lt; 10 &#8451;.</p>',
  '<p>Tomorrow: sunny.</p>',
  '<!-- ad slot: buy now -->',
  '<footer>Copyright 2026</footer>',
  '</body></html>',
].join('\n')

describe('compactWeb', () => {
  it('strips scripts, styles, head, and comments; keeps body text', () => {
    const out = compactWeb(HTML)
    expect(out).not.toMatch(/PageTitleInHead|color:red|doTrack|track\(\)|ad slot/)
    expect(out).not.toMatch(/<(?:p|h1|nav|div|script|style|footer)\b/i) // no structural tags survive
    expect(out).toContain('Home')
    expect(out).toContain('Main Heading')
    expect(out).toContain('Tomorrow: sunny.')
    expect(out).toContain('Copyright 2026')
  })

  it('decodes common named and numeric entities', () => {
    const out = compactWeb(HTML)
    expect(out).toContain('Rain & wind today') // &amp;
    expect(out).toContain('Temp < 10') // &lt;
    expect(out).toContain('℃') // &#8451; -> ℃
  })

  it('only ever shrinks', () => {
    expect(compactWeb(HTML).length).toBeLessThan(HTML.length)
    const plain = 'a\n\n\n\n\nb   c'
    expect(compactWeb(plain).length).toBeLessThanOrEqual(plain.length)
  })

  it('is deterministic — identical bytes across runs (cache-safety prerequisite)', () => {
    expect(compactWeb(HTML)).toBe(compactWeb(HTML))
  })

  it('drops an out-of-range numeric entity without throwing', () => {
    const out = compactWeb('<p>keep&#1114112;this</p>') // 0x110000 > U+10FFFF -> space
    expect(out).toContain('keep')
    expect(out).toContain('this')
    expect(out).not.toContain('1114112')
  })
})

describe('looksLikeHtml', () => {
  it('fires on a document marker', () => {
    expect(looksLikeHtml(HTML)).toBe(true)
    expect(looksLikeHtml('<body><p>hi</p></body>')).toBe(true)
  })

  it('fires on a dense fragment (>= 8 structural tags)', () => {
    expect(
      looksLikeHtml('<div><span>a</span></div><ul><li>x</li><li>y</li></ul><table><tr><td>1</td></tr></table>'),
    ).toBe(true)
  })

  it('does NOT fire on code with generics or sparse angle brackets', () => {
    expect(looksLikeHtml('const m = new Map<string, Array<number>>(); function f<T>(x: T): T { return x }')).toBe(false)
    expect(looksLikeHtml('<p>hi</p>')).toBe(false) // single tag, no doc marker
    expect(looksLikeHtml('just prose with a < sign and a > sign, nothing structural.')).toBe(false)
  })
})
