/**
 * Smart Ask that cannot start (spec 5.3): in a browser where the ORT wasm cannot be instantiated, the Ask box says
 * exactly that it is using keyword search, and keyword search still answers. Every browser, Electron included.
 */
import { ASK_FAILED, ask, askReady, expect, test } from './helpers'
import { SMART_HTML } from './paths'

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
