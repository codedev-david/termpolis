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
import { quitApp } from './helpers/launch'

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
      args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${ud}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
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
    await quitApp(app)
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

    // The app's own read-only hook. It reads xterm's buffer, scrollback included, so it works
    // whichever renderer paints.
    const screenText = async (): Promise<string> =>
      await page.evaluate(() => {
        const read = (window as unknown as { __termpolis_terminal_text?: (id?: string) => string })
          .__termpolis_terminal_text
        return read ? read() : ''
      })

    // What the drag was aimed at, for a failure message: where the terminal sits, what its last
    // rows hold, and how big the window and the desktop are. GitHub's Windows runners have a
    // 1024x768 desktop, which clamps the window to a 98-column pane — that is what once wrapped
    // every 100-character line and scrolled the marker off row 0.
    const diagnostics = async (): Promise<string> => {
      const sizes = await app.evaluate(({ BrowserWindow, screen }) => ({
        window: BrowserWindow.getAllWindows()[0]?.getContentBounds(),
        workArea: screen.getPrimaryDisplay().workAreaSize,
      }))
      return JSON.stringify({ xtermBox: box, ...sizes, screenTail: (await screenText()).split('\n').slice(-8) }, null, 2)
    }

    // Behave like Claude Code: mouse tracking on, repaint IN PLACE, forever. Each frame is sized
    // from the terminal's LIVE size, re-read every frame: lines two columns short of the width so
    // none wraps, and at most rows-3 of them (marker + lines + the cursor's line, with a row to
    // spare) so the frame never scrolls. That keeps the marker on row 0 at any window size.
    //
    // Each frame homes the cursor and OVERWRITES (erasing each line's tail, then everything below),
    // never clearing the screen first. Under ConPTY a clear-then-draw frame reaches the renderer in
    // two pieces about a paint apart, the clear and an erase of every row, then the text, and a drag
    // freezes xterm in whichever piece it lands on: replayed through a real ConPTY at the runner's
    // 98x36, row 0 was blank 43% of the time, so the drag copied nothing. Overwritten, row 0 only
    // ever holds the marker (0% blank in the same replay). The filler alternates x and y so every
    // frame differs: ConPTY sends only what changed, and an unchanging frame would send nothing.
    await term.click()
    // The shell is powershell on Windows and bash everywhere else (see session.json above) — this
    // used to type PowerShell unconditionally, so on Linux CI `Write-Host` was just an unknown
    // command, no repaint loop ever started, and the drag below selected the bash prompt instead of
    // the marker. Same frame, written twice. Both shells report the pty's size: PowerShell through
    // $Host.UI.RawUI.WindowSize, interactive bash through COLUMNS/LINES, which checkwinsize
    // refreshes after every external command (the loop's own `sleep`).
    if (process.platform === 'win32') {
      const esc = '$([char]27)'
      await page.keyboard.type(
        `Write-Host -NoNewline "${esc}[?1002h${esc}[?1006h"; $c='x'; ` +
        `while($true){ $s=$Host.UI.RawUI.WindowSize; $w=[Math]::Max(20,$s.Width-2); ` +
        `$n=[Math]::Max(1,[Math]::Min(25,$s.Height-3)); ` +
        `if ($c -eq 'x') { $c='y' } else { $c='x' }; ` +
        `Write-Host -NoNewline "${esc}[H"; Write-Host "${MARKER} keep me${esc}[K"; ` +
        `1..$n | %{ Write-Host (($c * $w) + "${esc}[K") }; ` +
        `Write-Host -NoNewline "${esc}[J"; Start-Sleep -Milliseconds 25 }`,
      )
    } else {
      const esc = '\\033'
      await page.keyboard.type(
        `printf '${esc}[?1002h${esc}[?1006h'; c=x; ` +
        `while :; do w=$(( \${COLUMNS:-80} - 2 )); n=$(( \${LINES:-24} - 3 )); ` +
        `[ $n -gt 25 ] && n=25; [ $n -lt 1 ] && n=1; ` +
        `[ $c = x ] && c=y || c=x; ` +
        `printf '${esc}[H%s${esc}[K\\n' "${MARKER} keep me"; ` +
        `for i in $(seq $n); do printf "$c%.0s" $(seq $w); printf '${esc}[K\\n'; done; ` +
        `printf '${esc}[J'; sleep 0.025; done`,
      )
    }
    await page.keyboard.press('Enter')

    // Premise: the loop is really painting. Only its OUTPUT can satisfy this — the marker alone on
    // a line. The command just typed contains the marker too, but never as a whole line, so this
    // cannot pass on the echo of the typing (a drag then would select the prompt).
    const frameMarker = new RegExp(`^${MARKER} keep me\\s*$`, 'm')
    try {
      await expect.poll(async () => frameMarker.test(await screenText()), { timeout: 20000 }).toBe(true)
    } catch (e) {
      throw new Error(`${(e as Error).message}\n\nthe repaint loop never drew a frame:\n${await diagnostics()}`)
    }
    // Then let several frames paint before the button goes down. A left mousedown holds output
    // back from xterm while the selection is made, so row 0 keeps whatever it held at that moment.
    await page.waitForTimeout(500)

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
    expect(
      viaKeyboard,
      'the drag did not land on the marker row — fix the test, not the app' +
        (viaKeyboard.includes(MARKER) ? '' : `\n${await diagnostics()}`),
    ).toContain(MARKER)

    // --- the real scenario: select, let the repaint bury it, THEN right-click ---
    await app.evaluate(async ({ clipboard }) => clipboard.writeText('__NOTHING__'))
    await drag()

    // Sit on it, with the loop still painting. Writes into xterm are frozen while a selection is
    // active, up to PENDING_WRITE_CAP (1,000,000 characters) of held-back output. This loop emits
    // about 45 KB/s through a real ConPTY at the runner's 98x36, so the valve needs ~20 s of frozen
    // output to open: on most machines it stays shut for this whole sit and the copy below reads the
    // frame frozen at the drag. Where it does open, the flush repaints row 0 with the same marker,
    // since a frame never blanks it, so the selection holds the marker either way.
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
