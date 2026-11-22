/**
 * The Lumopolis toolbar's secondary controls (the layers, Proposal, Theme, Tours, the 2D map, Reset view and
 * Re-layout) fold into its More menu when the pane is narrower than TOOLBAR_FOLD_PX of its own pixels, as the
 * default 1280x800 test window's pane is. These reach a control either way.
 */
import { expect, type Locator, type Page } from '@playwright/test'

/** The control `testid`, opening More first when the pane has folded it away. */
export async function toolbarControl(page: Page, testid: string): Promise<Locator> {
  const control = page.locator(`[data-testid="${testid}"]`)
  const more = page.locator('[data-testid="world-more"]')
  await expect(control.or(more).first()).toBeVisible({ timeout: 30_000 })
  if (!(await control.isVisible()) && (await more.isVisible())) {
    if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click()
    await expect(control).toBeVisible()
  }
  return control
}

/** Shuts the More menu if it is open (a layer toggle, the 2D map and Theme leave it open). */
export async function closeMore(page: Page): Promise<void> {
  const more = page.locator('[data-testid="world-more"]')
  if ((await more.count()) > 0 && (await more.getAttribute('aria-expanded')) === 'true') await more.click()
  await expect(page.locator('[data-testid="world-more-menu"]')).toHaveCount(0)
}
