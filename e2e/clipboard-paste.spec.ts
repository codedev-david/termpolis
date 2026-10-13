/**
 * Clipboard E2E — proves the terminal right-click menu's clipboard path works
 * END-TO-END in the real Electron app, against the REAL OS clipboard. The unit
 * suite mocks the clipboard, so it can prove the wiring but not that a real
 * right-click → menu click actually reads the OS clipboard and injects it — the
 * exact "copy/paste does nothing" failure mode that keeps getting reported.
 *
 * This test:
 *   1. puts a known marker on the OS clipboard via Electron's native `clipboard`
 *      module (main process),
 *   2. right-clicks the terminal to open the context menu,
 *   3. clicks "Paste",
 *   4. asserts the marker lands in the terminal.
 *
 * That exercises the real chain: menu button onClick → window.termpolis
 * clipboardReadText IPC → main `clipboard.readText()` → writeToTerminal → PTY
 * echo. The menu's Copy items use the identical IPC mechanism (clipboardWriteText),
 * so a working Paste proves the menu → native-clipboard bridge end-to-end.
 *
 * Isolated --user-data-dir gives it its own single-instance lock so it coexists
 * with a developer's running app.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'

let app: ElectronApplication
let page: Page
let isolatedUserData: string

const MARKER = 'termpolis_paste_e2e_marker_42'

/** Read the visible terminal's text out of xterm's own buffer via the renderer's read-only
 *  test hook.
 *
 *  NOT `.xterm-rows`: that element is created by xterm's DOM renderer, which only runs when
 *  there is no hardware WebGL — i.e. on CI's GPU-less runners. On a real GPU the WebGL addon
 *  paints to a canvas, `.xterm-rows` does not exist at all, and these assertions failed with
 *  "element(s) not found" on every developer machine while passing in CI. The buffer is
 *  identical under both renderers — and it is the same model `term.getSelection()` reads, so
 *  asserting against it is closer to what Copy actually copies. */
async function terminalText(): Promise<string> {
  return await page.evaluate(
    () =>
      (window as unknown as { __termpolis_terminal_text?: (id?: string) => string })
        .__termpolis_terminal_text?.() ?? '',
  )
}

test.describe.serial('Terminal clipboard (real OS clipboard)', () => {
  test.setTimeout(120_000)

  test.beforeAll(async () => {
    const { execSync } = await import('child_process')
    execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

    isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-clip-'))
    fs.writeFileSync(path.join(isolatedUserData, 'session.json'), JSON.stringify({
      terminals: [],
      workspaces: [],
      defaultShell: process.platform === 'win32' ? 'powershell' : 'bash',
      viewMode: 'tabs',
    }))

    app = await electron.launch({
      args: [
        path.resolve('out/main/index.js'),
        `--user-data-dir=${isolatedUserData}`,
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      ],
      env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_TEST_AGENTS: '1', TERMPOLIS_TEST_TIMING: '1' },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(1500)

    await page.evaluate(() => {
      try {
        localStorage.setItem('termpolis.onboarding.seen.v1', '1')
        localStorage.setItem('termpolis.telemetry.optIn', '0')
      } catch {}
    })
    const onboardDialog = page.locator('[aria-labelledby="onboarding-title"]')
    if (await onboardDialog.isVisible({ timeout: 5000 }).catch(() => false)) {
      await page.locator('button:has-text("Skip tour")').first().click({ force: true }).catch(() => {})
      await onboardDialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
    }
  })

  test.afterAll(async () => {
    if (app) await app.close()
    if (isolatedUserData) { try { fs.rmSync(isolatedUserData, { recursive: true, force: true }) } catch {} }
  })

  test('right-click Paste injects the real OS clipboard into the terminal', async () => {
    // Create a plain terminal.
    await page.locator('button:has-text("+ Add Terminal")').first().click()
    await page.waitForTimeout(400)
    const nameInput = page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first()
    await nameInput.fill('ClipTerm')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.waitForTimeout(1500)

    const term = page.locator('.xterm').first()
    await expect(term).toBeVisible({ timeout: 10000 })

    // Put a known marker on the REAL OS clipboard via Electron's native module.
    await app.evaluate(async ({ clipboard }, marker) => clipboard.writeText(marker), MARKER)

    // Right-click the terminal → the context menu opens.
    await term.click({ button: 'right' })
    const menu = page.locator('[data-testid="terminal-context-menu"]')
    await expect(menu).toBeVisible({ timeout: 5000 })

    // Click Paste → reads the OS clipboard via native IPC and writes to the PTY.
    await menu.locator('button:has-text("Paste")').click()

    // The marker is echoed by the shell on the input line.
    await expect.poll(terminalText, { timeout: 15000 }).toContain(MARKER)
  })

  // A long multi-line paste must reach the program as ONE bracketed paste with \r line breaks —
  // what xterm's own paste() sends, and what every agent TUI asks for. The raw clipboard text
  // used to go straight to the PTY instead. Delivered in ~1 KB reads with no markers, Claude
  // Code took it for several pastes and showed only the tail of it as typed text. The probe
  // stands in for the agent: it asks for bracketed paste, then reports what one paste delivered.
  test('Ctrl+V delivers a long multi-line paste as ONE bracketed paste', async () => {
    const probe = path.join(isolatedUserData, 'paste-probe.cjs')
    fs.writeFileSync(probe, [
      "const ESC = '\\x1b'",
      'process.stdin.setRawMode(true)',
      "process.stdin.setEncoding('utf8')",
      "process.stdout.write(ESC + '[?2004hPROBE_READY\\r\\n')",
      "let got = ''",
      "process.stdin.on('data', (d) => {",
      '  got += d',
      "  if (!got.includes(ESC + '[201~')) return",
      "  const body = got.slice(got.indexOf(ESC + '[200~') + 6, got.indexOf(ESC + '[201~'))",
      "  const pastes = got.split(ESC + '[200~').length - 1",
      "  process.stdout.write(ESC + '[?2004l\\r\\nPROBE_RESULT pastes=' + pastes + ' lines=' + body.split('\\r').length + ' lf=' + (body.split('\\n').length - 1) + '\\r\\n')",
      '  process.exit(0)',
      '})',
    ].join('\n'))

    const term = page.locator('.xterm').first()
    await term.click()
    // Drop the marker the previous test left on the input line WITHOUT running it. Run, it fails,
    // and Ubuntu's command-not-found handler can take seconds. The probe command typed meanwhile
    // became the "last command", so the fix banner offered to re-run it, and the next test's
    // first Enter accepted that offer, relaunching the probe to swallow the rest of its keys.
    await page.keyboard.press('Control+C')
    await page.waitForTimeout(500)
    await page.keyboard.type(`node "${probe}"`)
    await page.keyboard.press('Enter')
    await expect.poll(terminalText, { timeout: 20000 }).toContain('PROBE_READY')

    const lines = Array.from({ length: 200 }, (_, i) => `paste line ${i + 1} of 200 - the quick brown fox jumps over the lazy dog`)
    await app.evaluate(async ({ clipboard }, text) => clipboard.writeText(text), lines.join('\r\n'))
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')

    await expect.poll(terminalText, { timeout: 20000 }).toContain('PROBE_RESULT pastes=1 lines=200 lf=0')
  })

  // --- COPY: select terminal text, press a RESERVED Copy hotkey, read the REAL OS
  // clipboard. As of v1.30.3 the greyed-area right-click Copy items were removed and
  // copy is hotkey-only (Ctrl+Shift+C / +K / +Q), so these drive the keyboard. Copy
  // reads xterm's BUFFER model (term.getSelection()), so it works headlessly
  // regardless of the GPU/canvas renderer. (Copy as Image uses a WebGL canvas capture
  // that xvfb can't reliably produce, so it's exercised by the unit test for the
  // clipboard:write-image IPC, not here.) ---

  /** Put `marker` on a clean top line and triple-click to select it, leaving the
   *  xterm textarea focused so a reserved Copy hotkey acts on the live selection. */
  async function selectMarkerLine(marker: string): Promise<{ x: number; y: number }> {
    const term = page.locator('.xterm').first()
    await term.click() // focus xterm
    await page.keyboard.press('Enter')   // submit whatever is on the input line
    await page.waitForTimeout(250)
    await page.keyboard.type('clear')    // reset to a top-of-screen prompt
    await page.keyboard.press('Enter')
    await page.waitForTimeout(500)
    await page.keyboard.type(marker)     // lands on the (now top) input line
    await expect.poll(terminalText, { timeout: 8000 }).toContain(marker)
    const box = await page.locator('.xterm-screen').first().boundingBox()
    if (!box) throw new Error('no .xterm-screen bounding box')
    const pt = { x: box.x + 40, y: box.y + 8 } // first text row
    await page.mouse.click(pt.x, pt.y, { clickCount: 3 }) // xterm triple-click = select line
    return pt
  }

  const readClip = () => app.evaluate(async ({ clipboard }) => clipboard.readText())

  test('Ctrl+Shift+C copies the selected terminal text to the real clipboard', async () => {
    const marker = 'zz_copy_plain_71'
    await selectMarkerLine(marker)
    await app.evaluate(async ({ clipboard }) => clipboard.writeText('__cleared__')) // prove freshness
    await page.keyboard.press('Control+Shift+C') // reserved plain-Copy hotkey
    await expect.poll(readClip, { timeout: 10000 }).toContain(marker)
  })

  test('Ctrl+Shift+Q copies the selection as a markdown code block', async () => {
    const marker = 'zz_copy_codeblock_72'
    await selectMarkerLine(marker)
    await app.evaluate(async ({ clipboard }) => clipboard.writeText('__cleared__'))
    await page.keyboard.press('Control+Shift+Q') // reserved Copy-as-Code-Block hotkey
    // The text/plain flavor is a ```-fenced block that contains the selected line.
    await expect.poll(readClip, { timeout: 10000 }).toContain(marker)
  })

  test('Ctrl+Shift+K copies the selection as a Teams/Slack message', async () => {
    const marker = 'zz_copy_teams_73'
    await selectMarkerLine(marker)
    await app.evaluate(async ({ clipboard }) => clipboard.writeText('__cleared__'))
    await page.keyboard.press('Control+Shift+K') // reserved Copy-for-Teams/Slack hotkey
    // Message form reflows wrapped lines (no hard returns) but preserves the token.
    await expect.poll(readClip, { timeout: 10000 }).toContain(marker)
  })

  // Issue #35. A pane's xterm is rebuilt on every remount (here, a Settings round trip) from the
  // last 32 KB of output main keeps. A fullscreen agent turns on the alternate screen, mouse
  // tracking and bracketed paste ONCE, at startup, so in a long session those switches are gone
  // from that window: the rebuilt pane stopped sending the wheel to the agent ("can't scroll to
  // see the agent's full response") and pasted raw again. The mock stands in for the agent.
  test('a remount keeps a fullscreen agent getting the wheel and bracketed pastes', async () => {
    const mock = path.join(isolatedUserData, 'fullscreen-mock.cjs')
    fs.writeFileSync(mock, [
      "const ESC = '\\x1b'",
      'process.stdin.setRawMode(true)',
      'process.stdin.resume()',
      "process.stdout.write(ESC + '[?1049h' + ESC + '[?1000h' + ESC + '[?1002h' + ESC + '[?1003h' + ESC + '[?1006h' + ESC + '[?2004h')",
      // Far more than the 32 KB window, in batches, so a Windows ConPTY forwards each one.
      'let batch = 0',
      'const next = () => {',
      "  if (batch === 120) return process.stdout.write(ESC + '[2J' + ESC + '[HMOCK_FULLSCREEN_READY\\r\\n')",
      "  let out = ''",
      "  for (let i = 0; i < 20; i++) out += 'response line ' + (batch * 20 + i) + ' ' + 'abcdefghij'.repeat(8) + '\\r\\n'",
      '  process.stdout.write(out)',
      '  batch++',
      '  setTimeout(next, 15)',
      '}',
      'next()',
      "process.stdin.on('data', (d) => { if (String(d).includes('\\x03')) process.exit(0) })",
    ].join('\n'))

    const writes = async (): Promise<string[]> =>
      await page.evaluate(async () => {
        const res = await (window as unknown as { termpolis: { __testTerminalWrites: () => Promise<{ data: Array<{ data: string }> }> } })
          .termpolis.__testTerminalWrites()
        return res.data.map((w) => w.data)
      })
    const wheelReports = async (): Promise<number> =>
      (await writes()).filter((d) => d.includes('\x1b[<64;') || d.includes('\x1b[<65;')).length
    const wheelOverPane = async (): Promise<void> => {
      const box = await page.locator('.xterm-screen').first().boundingBox()
      if (!box) throw new Error('no .xterm-screen bounding box')
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, -240)
    }

    const term = page.locator('.xterm').first()
    await term.click()
    await page.keyboard.press('Control+C') // a clean input line
    await page.waitForTimeout(500)
    await page.keyboard.type(`node "${mock}"`)
    await page.keyboard.press('Enter')
    await expect.poll(terminalText, { timeout: 30000 }).toContain('MOCK_FULLSCREEN_READY')

    // The live pane sends the wheel to the agent -- the precondition for the rest to mean anything.
    let seen = await wheelReports()
    await wheelOverPane()
    await expect.poll(wheelReports, { timeout: 5000 }).toBeGreaterThan(seen)

    // Remount every pane with a Settings round trip.
    await page.locator('button[title="Settings"]').first().click()
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10000 })
    await page.locator('button[title="Settings"]').first().click()
    await expect(page.locator('h1:has-text("Settings")')).toBeHidden({ timeout: 10000 })
    await expect(term).toBeVisible({ timeout: 10000 })
    await expect.poll(terminalText, { timeout: 10000 }).toContain('MOCK_FULLSCREEN_READY')

    // The rebuilt pane still sends the wheel to the agent ...
    seen = await wheelReports()
    await wheelOverPane()
    await expect.poll(wheelReports, { timeout: 5000 }).toBeGreaterThan(seen)

    // ... and still brackets a paste.
    await app.evaluate(async ({ clipboard }) => clipboard.writeText('one\r\ntwo\r\nthree'))
    const before = (await writes()).length
    await term.click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')
    await expect
      .poll(async () => (await writes()).slice(before).find((d) => d.includes('three')) ?? '', { timeout: 5000 })
      .toBe('\x1b[200~one\rtwo\rthree\x1b[201~')

    // Clear terminal (Ctrl+Shift+X) wipes the pane with a full reset. It has to put the agent's
    // modes back, or pastes go in raw again until the agent happens to re-send them.
    await page.keyboard.press('Control+Shift+X')
    await page.waitForTimeout(500)
    await app.evaluate(async ({ clipboard }) => clipboard.writeText('four\r\nfive'))
    const beforeClearPaste = (await writes()).length
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')
    await expect
      .poll(async () => (await writes()).slice(beforeClearPaste).find((d) => d.includes('five')) ?? '', { timeout: 5000 })
      .toBe('\x1b[200~four\rfive\x1b[201~')
    seen = await wheelReports()
    await wheelOverPane()
    await expect.poll(wheelReports, { timeout: 5000 }).toBeGreaterThan(seen)

    await page.keyboard.press('Control+C') // the mock exits
  })

  // Dropping a file from disk types its quoted path. The drop handler read `File.path`, which
  // Electron 32 removed; it now asks the preload (webUtils.getPathForFile). Asserted on what reached
  // the PTY, so it also proves the sandboxed preload can reach webUtils at all.
  test('dropping a file from disk types its quoted path', async () => {
    const dropped = path.join(isolatedUserData, 'dropped file.txt')
    fs.writeFileSync(dropped, 'x')
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 10000 })

    // A File that really lives on disk is what an <input type=file> hands back.
    await page.evaluate(() => {
      const input = document.createElement('input')
      input.type = 'file'
      input.id = 'e2e-drop-source'
      input.style.display = 'none'
      document.body.appendChild(input)
    })
    await page.setInputFiles('#e2e-drop-source', dropped)

    const writes = async (): Promise<string[]> =>
      await page.evaluate(async () => {
        const res = await (window as unknown as { termpolis: { __testTerminalWrites: () => Promise<{ data: Array<{ data: string }> }> } })
          .termpolis.__testTerminalWrites()
        return res.data.map((w) => w.data)
      })
    const before = (await writes()).length
    await page.evaluate(() => {
      const input = document.getElementById('e2e-drop-source') as HTMLInputElement
      const dt = new DataTransfer()
      dt.items.add(input.files![0])
      const pane = document.querySelector('.xterm')!.closest('.flex-1.relative')!
      pane.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
      input.remove()
    })

    let typed = ''
    await expect
      .poll(async () => (typed = (await writes()).slice(before).find((d) => d.includes('dropped file.txt')) ?? ''), { timeout: 5000 })
      .toMatch(/^".+dropped file\.txt"$/)
    // The file's real location, not just its name (compared resolved: Windows temp paths can be 8.3).
    expect(fs.realpathSync.native(typed.slice(1, -1))).toBe(fs.realpathSync.native(dropped))
    await page.keyboard.press('Control+C') // leave the shell's input line empty
  })
})
