/**
 * Smart Ask on the exported page (spec 5.3): ORT starts from the page's own bytes and is ready within 6 s, and
 * questions asked in plain words find the part they are about. Electron and Edge must reach 'smart'; Firefox and
 * WebKit may report 'failed' instead, as long as the page says so and keyword search still answers.
 *
 * The CSP: the one grant beyond 'none' that smart Ask needs ('wasm-unsafe-eval') is proven needed by a copy of
 * smart.html without it (Chromium: Electron and Edge, where smart Ask must work).
 *
 * No retries in this file: the 6 s readiness budget must hold on the first run.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ASK_FAILED, ask, askReady, expect, phaseReport, questions, test } from './helpers'
import { FIXTURE_DIR, FIXTURE_JSON, SMART_HTML } from './paths'

// A retry must not hide a readiness time over budget (a slow first run passing on its second): no retries here.
test.describe.configure({ retries: 0 })

const SMART_BROWSERS = new Set(['electron', 'msedge'])
const READY_BUDGET_MS = 6000
const edges = new Map((JSON.parse(fs.readFileSync(FIXTURE_JSON, 'utf8')) as { edges: Array<{ id: string; from: string; to: string }> }).edges.map((e) => [e.id, e]))

/** A hit is an accepted id, or a line whose two ends are both accepted (as tests/electron/worldAskQuality.test.ts). */
const accepted = (labelled: string[], ids: string[]): boolean => ids.some((id) => {
  const e = edges.get(id)
  return labelled.includes(id) || (e !== undefined && labelled.includes(e.from) && labelled.includes(e.to))
})

test('smart Ask is ready within 6 s and finds the right part for plain questions', async ({ open }, info) => {
  const o = await open(SMART_HTML, { phases: true })
  const ready = await askReady(o.page)
  // Printed, so a run's log shows where the time to ready went whether or not it is over budget.
  const phases = await phaseReport(o.page, ready.at)
  console.log(`ask-ready ${info.project.name}: ${ready.state} at ${Math.round(ready.at)} ms | ${phases}`)
  info.annotations.push({ type: 'ask-ready', description: `${info.project.name}: ${ready.state} at ${Math.round(ready.at)} ms | ${phases}` })
  if (SMART_BROWSERS.has(info.project.name)) {
    expect(ready.state).toBe('smart')
    expect(ready.at).toBeLessThan(READY_BUDGET_MS)
  } else {
    expect(['smart', 'failed']).toContain(ready.state)
  }
  if (ready.state === 'failed') {
    await expect(o.page.locator('.wx-ask-status')).toHaveText(ASK_FAILED)
    expect((await ask(o.page, 'how does the phone connect to my desktop')).length).toBeGreaterThan(0)
  } else {
    // The phone and the keys questions, and one more from the labelled set.
    const asked = questions().filter((x) => ['how does the phone connect to my desktop', 'where are passwords and API keys kept safe', 'what handles typing lag'].includes(x.q))
    expect(asked).toHaveLength(3)
    for (const { q, labelled } of asked) {
      const top3 = (await ask(o.page, q)).slice(0, 3)
      expect(accepted(labelled, top3), `"${q}" top 3 ${JSON.stringify(top3)} names one of ${JSON.stringify(labelled)}`).toBe(true)
    }
  }
  expect(await o.violations(), 'CSP violations').toEqual([])
  expect(o.foreign(), 'requests other than the page itself').toEqual([])
  expect(o.errors).toEqual([])
})

/** The policy the export wrote into smart.html. */
const pagePolicy = (html: string): string => {
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)
  if (!m) throw new Error('smart.html has no CSP meta tag')
  return m[1]
}

/**
 * The CSP grants only what smart Ask needs. Each grant the spec first listed was tested by a copy of smart.html
 * without it: smart Ask failed without 'wasm-unsafe-eval', and still started without `worker-src blob:` and without
 * `img-src data: blob:` (ORT runs on one thread with no proxy worker, and the page loads no image), so those two
 * were dropped. The first test below keeps the one grant proven; the second keeps the dropped ones out, and the
 * smart test above (and every page test) proves the page runs under the result with no CSP violation.
 */
test("smart Ask fails without 'wasm-unsafe-eval' in script-src", async ({ open }, info) => {
  test.skip(!SMART_BROWSERS.has(info.project.name), 'smart Ask is only required to work in Chromium (Electron and Edge)')
  const html = fs.readFileSync(SMART_HTML, 'utf8')
  const csp = pagePolicy(html)
  const stripped = csp.replace(" 'wasm-unsafe-eval'", '')
  expect(stripped, "the page's CSP grants 'wasm-unsafe-eval'").not.toBe(csp)
  const copy = path.join(FIXTURE_DIR, 'csp-no-wasm-eval.html')
  fs.writeFileSync(copy, html.replace(csp, stripped))
  const o = await open(copy)
  const ready = await askReady(o.page)
  const violations = await o.violations()
  info.annotations.push({ type: 'csp', description: `without 'wasm-unsafe-eval': ${ready.state}; violations ${JSON.stringify(violations)}` })
  expect(ready.state).toBe('failed')
  await expect(o.page.locator('.wx-ask-status')).toHaveText(ASK_FAILED)
  // It failed because the CSP refused the wasm compile, not for some other reason.
  expect(violations.some((v) => v.startsWith('script-src') && v.includes('wasm-eval')), `a script-src wasm-eval violation in ${JSON.stringify(violations)}`).toBe(true)
  expect(o.foreign()).toEqual([])
})

test("the CSP names no worker or image source: worker-src falls back through child-src to script-src, img-src to default-src 'none'", () => {
  test.skip(test.info().project.name !== 'electron', 'a check of the file, once')
  expect(pagePolicy(fs.readFileSync(SMART_HTML, 'utf8'))).toBe("default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; connect-src 'none'")
})
