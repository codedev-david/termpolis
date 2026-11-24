/**
 * Smart Ask that cannot start (spec 5.3): in a browser where the ORT wasm cannot be instantiated, the Ask box says
 * exactly that it is using keyword search, and keyword search still answers. And a browser too old to read the page's
 * data (no DecompressionStream) is told so, not that the data is damaged. Every browser, Electron included.
 */
import { ASK_FAILED, OLD_BROWSER, ask, askReady, expect, test } from './helpers'
import { KEYWORD_HTML, SMART_HTML } from './paths'

test("when WebAssembly can't start, the box says so and keyword Ask still answers", async ({ open }) => {
  const o = await open(SMART_HTML, { wasmFails: true })
  expect((await askReady(o.page)).state).toBe('failed')
  await expect(o.page.locator('.wx-ask')).toHaveAttribute('data-state', 'failed')
  await expect(o.page.locator('.wx-ask-status')).toHaveText(ASK_FAILED)
  expect(await ask(o.page, 'where do the terminal shells actually run')).toContain('b-pty')
  expect(o.foreign(), 'requests other than the page itself').toEqual([])
  expect(o.errors).toEqual([])
  expect(await o.violations(), 'CSP violations').toEqual([])
})

for (const [name, file] of [['smart', SMART_HTML], ['keyword', KEYWORD_HTML]] as const) {
  test(`a browser without DecompressionStream is told it is too old, not that the ${name} page is damaged`, async ({ open }) => {
    const o = await open(file, { noDecompression: true })
    expect((await askReady(o.page)).state).toBe('failed')
    await expect(o.page.locator('.wx-broken')).toHaveText(OLD_BROWSER)
    await expect(o.page.locator('.wx-broken')).toBeVisible()
    await expect(o.page.locator('.wx-page')).toHaveCount(0)
    await expect(o.page.locator('canvas')).toHaveCount(0)
    expect(o.foreign(), 'requests other than the page itself').toEqual([])
    expect(o.errors).toEqual([])
    expect(await o.violations(), 'CSP violations').toEqual([])
  })
}
