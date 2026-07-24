// Right-click Copy in a repainting TUI.
//
// HONESTY NOTE, because a misleading test is worse than none: this does NOT reproduce the bug
// David reported ("in Claude Code the selection vanishes on right-click and Copy does nothing").
// I tried six ways -- plain shell, mouse tracking (DECSET ?1002h/?1006h), a continuous ESC[2J
// repaint loop, the REAL Claude Code TUI, a high-volume repaint, and a loop tuned to blow past
// PENDING_WRITE_CAP -- and Copy worked in every one. Removing the `lastGoodSnapRef` fallback this
// file was written to guard leaves it GREEN, which means it does not exercise that path.
//
// It is kept as a SMOKE TEST: right-click Copy must keep working in a terminal that is being
// repainted in place by a mouse-tracking TUI, which is the shape of every agent session. It is not
// evidence that the reported bug is fixed. The thing that will actually diagnose that is the
// context menu's new DISABLED state -- Copy can no longer look clickable and silently do nothing,
// so the next time it happens the greyed-out item says plainly whether the selection reached the
// menu at all.
//
// UPDATE (v1.30.1): the diagnostic fired for real (David: "the selection goes away on right-click
// and every Copy is greyed out"). Root cause found without needing this e2e to reproduce it: the
// greyed state means ALL THREE copy sources were null -- `live` (getSelection at the menu), `fresh`
// (the right-mousedown sample), and `remembered` (lastGoodSnapRef). `remembered` used to be banked
// at exactly ONE moment, the document mouseup, guarded by a single hasSelection() sample. xterm's
// onSelectionChange -- its authoritative, synchronous "a selection exists NOW" signal, decoupled
// from the rAF visual redraw -- is a far more reliable capture point, so the snapshot is now banked
// there too (throttled). The gap that lone mouseup sample leaves is exercised deterministically by
// the unit test "banks the selection at xterm onSelectionChange" in
// tests/components/TerminalPaneCoverage.test.tsx (RED without the bank, GREEN with it).
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

let app: ElectronApplication
let page: Page
let ud: string
const MARKER = 'COPYSURVIVESQQ'

// UPDATE (v1.30.3): the right-click Copy item in the greyed selection area was REMOVED at David's
// request ("just remove the right click feature in the greyed out area, just put the hotkeys").
// Copy is now hotkey-only (Ctrl+Shift+C), which reads the LIVE xterm selection — so this test now
// drives that hotkey instead of a menu button. The buried-selection assertion still holds:
// getSelection() survives the repaint (see the honesty note above; Copy worked in every repro), so
// the live read still finds the marker even after the redraw visually buries it.
test.describe.serial('reserved Copy hotkey keeps working in a repainting mouse-tracking TUI', () => {
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    ud = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-cs-'))
    fs.writeFileSync(path.join(ud, 'session.json'), JSON.stringify({
      terminals: [], workspaces: [],
      defaultShell: process.platform === 'win32' ? 'powershell' : 'bash',
      viewMode: 'tabs',
    }))
    app = await electron.launch({
      args: [path.resolve('out/main/index.js'), `--user-data-dir=${ud}`],
      env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_TEST_AGENTS: '1' },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(1500)
    await page.evaluate(() => { try { localStorage.setItem('termpolis.onboarding.seen.v1', '1') } catch { /* ignore */ } })
    for (const l of ['Skip tour', 'Skip', 'Got it']) {
      await page.locator(`button:has-text("${l}")`).first().click({ timeout: 700, force: true }).catch(() => {})
    }
  })

  test.afterAll(async () => {
    if (app) await app.close()
    try { fs.rmSync(ud, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  test('smoke: select + Ctrl+Shift+C still reaches the clipboard after a repaint', async () => {
    await page.locator('button:has-text("+ Add Terminal")').first().click()
    await page.waitForTimeout(500)
    await page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first().fill('RepaintCopy')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.waitForTimeout(2500)

    const term = page.locator('.xterm').first()
    await expect(term).toBeVisible({ timeout: 15000 })
    const box = (await term.boundingBox())!

    // Behave like Claude Code: mouse tracking on, clear + repaint IN PLACE, forever. The frame is
    // deliberately short enough to fit the viewport (marker + 25 lines) so the marker stays on
    // row 0 and never scrolls — while the rate of rewriting still buries the selection.
    await term.click()
    const esc = '$([char]27)'
    await page.keyboard.type(
      `Write-Host -NoNewline "${esc}[?1002h${esc}[?1006h"; ` +
      `while($true){ Write-Host -NoNewline "${esc}[2J${esc}[H"; Write-Host "${MARKER} keep me"; ` +
      `1..25 | %{ Write-Host ("x" * 100) }; Start-Sleep -Milliseconds 25 }`,
    )
    await page.keyboard.press('Enter')
    await page.waitForTimeout(2500)

    const y = box.y + 12 // row 0 — the marker line of every repainted frame
    const x0 = box.x + 4
    const x1 = box.x + 190

    const drag = async (): Promise<void> => {
      await page.mouse.move(x0, y)
      await page.mouse.down()
      await page.mouse.move(x1, y, { steps: 12 })
      await page.mouse.up()
      await page.waitForTimeout(250)
    }

    // --- sanity: the drag really does select the marker (the keyboard path reads it LIVE) ---
    await app.evaluate(async ({ clipboard }) => clipboard.writeText('__NOTHING__'))
    await drag()
    await page.keyboard.press('Control+Shift+C')
    await page.waitForTimeout(400)
    const viaKeyboard = await app.evaluate(async ({ clipboard }) => clipboard.readText())
    expect(viaKeyboard, 'the drag did not land on the marker row — fix the test, not the app').toContain(MARKER)

    // --- the real scenario: select, let the repaint bury it, THEN right-click ---
    await app.evaluate(async ({ clipboard }) => clipboard.writeText('__NOTHING__'))
    await drag()

    // Sit on it. Writes are frozen while a selection is active, but only up to PENDING_WRITE_CAP
    // (1 MB) — this loop emits ~2.6 KB per frame at ~30 fps, so the valve opens within seconds and
    // the repaint lands squarely on the selection. This is the state a Claude Code user is in.
    await page.waitForTimeout(12000)

    // THE POINT: xterm's selection may be visually buried by the repaint by now, but the live
    // buffer selection survives it. The reserved Copy hotkey reads that live selection, so the
    // user's INTENT to copy still lands on the clipboard even after 12s of in-place rewriting —
    // a hotkey must never be less capable than the keyboard shortcut printed next to it.
    await page.keyboard.press('Control+Shift+C')

    await expect.poll(
      async () => app.evaluate(async ({ clipboard }) => clipboard.readText()),
      { timeout: 10000, message: 'right-click Copy put nothing on the clipboard — the repaint ate the selection' },
    ).toContain(MARKER)

    await page.keyboard.press('Control+C').catch(() => {})
  })
})
