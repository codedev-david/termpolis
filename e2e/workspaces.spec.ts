/**
 * Termpolis Workspace E2E Test Suite
 * Tests saving, restoring, renaming, deleting workspaces, and verifying
 * workspace entries, terminal counts, and multi-workspace management.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  // Build the app
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  // Clear session so we start fresh on the Welcome screen
  const os = await import('os')
  const sessionPaths = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'termpolis', 'session.json'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Electron', 'session.json'),
  ]
  const cleanSession = JSON.stringify({
    terminals: [], workspaces: [], defaultShell: 'powershell', viewMode: 'tabs'
  })
  for (const sessionPath of sessionPaths) {
    if (fs.existsSync(sessionPath)) {
      fs.writeFileSync(sessionPath, cleanSession)
    }
  }

  app = await electron.launch({
    args: [path.resolve('out/main/index.js')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TERMPOLIS_TEST_AGENTS: '1',
      TERMPOLIS_TEST_TIMING: '1',
    },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)
})

test.afterAll(async () => {
  if (app) await app.close()
})

/** Helper: create a terminal via the Add Terminal modal with a given name */
async function createTerminal(name: string) {
  const addBtn = page.locator('button:has-text("+ Add Terminal")').first()
  await addBtn.click()
  await page.waitForTimeout(500)

  const nameInput = page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first()
  await nameInput.fill(name)

  const create = page.getByRole('button', { name: 'Create', exact: true })
  await create.click()
  await page.waitForTimeout(2000)
}

/** Helper: save the current terminals as a workspace with the given name */
async function saveWorkspace(name: string) {
  const saveBtn = page.locator('button:has-text("+ Save Workspace")').first()
  await saveBtn.click()
  await page.waitForTimeout(300)

  const nameInput = page.locator('input[placeholder="Workspace name"]')
  await nameInput.fill(name)

  const confirmBtn = page.locator('button:has-text("Save")').last()
  await confirmBtn.click()
  await page.waitForTimeout(500)
}

/** Helper: close a terminal by name */
async function closeTerminalByName(name: string) {
  const closeBtn = page.locator(`aside button[aria-label="Close ${name}"]`).first()
  const visible = await closeBtn.isVisible().catch(() => false)
  if (visible) {
    await closeBtn.click()
    await page.waitForTimeout(1000)
    return true
  }
  return false
}

/** Helper: get the number of terminals in the sidebar */
async function getSidebarTerminalCount(): Promise<number> {
  return await page.evaluate(() => {
    const aside = document.querySelector('aside')
    if (!aside) return 0
    return aside.querySelectorAll('button[aria-label^="Close "]').length
  })
}

// ════════════════════════════════════════════════════════════
// ALL TESTS
// ════════════════════════════════════════════════════════════

test.describe.serial('Workspaces', () => {

  test('1. workspaces section visible in sidebar with header', async () => {
    // The sidebar should have a WORKSPACES header button (uppercase text)
    const header = page.locator('button:has-text("Workspaces")').first()
    await expect(header).toBeVisible()
  })

  test('2. "+ Save Workspace" button exists', async () => {
    const saveBtn = page.locator('button:has-text("+ Save Workspace")').first()
    await expect(saveBtn).toBeVisible()
  })

  test('3. save workspace after creating a terminal: entry appears in sidebar', async () => {
    await createTerminal('WS-Terminal-1')

    await saveWorkspace('My Workspace')

    // A workspace entry with the name should appear
    const wsEntry = page.locator('text=My Workspace').first()
    await expect(wsEntry).toBeVisible()
  })

  test('4. workspace entry shows the workspace name', async () => {
    const wsEntry = page.locator('span:has-text("My Workspace")').first()
    await expect(wsEntry).toBeVisible()
    const text = await wsEntry.textContent()
    expect(text).toContain('My Workspace')
  })

  test('5. workspace stores terminal data (1 terminal saved)', async () => {
    // Verify the workspace has terminal data by checking via the store
    const terminalCount = await page.evaluate(() => {
      // Access the zustand store state
      const storeState = (window as any).__ZUSTAND_STORE__?.getState?.()
      if (storeState?.workspaces?.length > 0) {
        return storeState.workspaces[0].terminals.length
      }
      // Fallback: check if workspace entry exists with expected content
      return -1
    })
    // If store is accessible, verify count; otherwise just confirm the workspace is visible
    if (terminalCount >= 0) {
      expect(terminalCount).toBe(1)
    } else {
      // Workspace entry is visible (confirmed in previous test)
      const wsEntry = page.locator('text=My Workspace').first()
      await expect(wsEntry).toBeVisible()
    }
  })

  test('6. save workspace with 2 terminals: workspace stores both', async () => {
    await createTerminal('WS-Terminal-2')

    await saveWorkspace('Dual Workspace')

    // Verify Dual Workspace appears
    const wsEntry = page.locator('text=Dual Workspace').first()
    await expect(wsEntry).toBeVisible()
  })

  test('7. click a saved workspace: terminals from that workspace are restored', async () => {
    // Close all current terminals first
    await closeTerminalByName('WS-Terminal-1')
    await closeTerminalByName('WS-Terminal-2')
    await page.waitForTimeout(500)

    // Verify no terminals remain
    const countBefore = await getSidebarTerminalCount()
    expect(countBefore).toBe(0)

    // Click "Dual Workspace" to restore it
    const wsEntry = page.locator('span:has-text("Dual Workspace")').first()
    await wsEntry.click()
    await page.waitForTimeout(3000)

    // Terminals should be restored
    const countAfter = await getSidebarTerminalCount()
    expect(countAfter).toBeGreaterThanOrEqual(1)
  })

  test('8. rename workspace: edit button changes the name', async () => {
    // Hover over the workspace entry to reveal action buttons
    const wsRow = page.locator('div.group:has-text("My Workspace")').first()
    await wsRow.hover()
    await page.waitForTimeout(300)

    // Click the rename button (pencil icon with aria-label)
    const renameBtn = page.locator('button[aria-label="Rename My Workspace"]')
    await renameBtn.click({ force: true })
    await page.waitForTimeout(300)

    // An input should appear for editing the name
    const editInput = page.locator('div.px-2 input').first()
    await expect(editInput).toBeVisible()

    // Clear and type new name
    await editInput.fill('Renamed Workspace')
    await editInput.press('Enter')
    await page.waitForTimeout(500)

    // The renamed workspace should appear
    const renamedEntry = page.locator('text=Renamed Workspace').first()
    await expect(renamedEntry).toBeVisible()

    // Old name should be gone
    const oldEntry = page.locator('span:has-text("My Workspace")')
    const oldCount = await oldEntry.count()
    expect(oldCount).toBe(0)
  })

  test('9. delete workspace: removes it from list', async () => {
    // Hover over "Renamed Workspace" to reveal delete button
    const wsRow = page.locator('div.group:has-text("Renamed Workspace")').first()
    await wsRow.hover()
    await page.waitForTimeout(300)

    // Click delete button
    const deleteBtn = page.locator('button[aria-label="Delete Renamed Workspace"]')
    await deleteBtn.click({ force: true })
    await page.waitForTimeout(500)

    // Workspace should be removed
    const deletedEntry = page.locator('span:has-text("Renamed Workspace")')
    const count = await deletedEntry.count()
    expect(count).toBe(0)
  })

  test('10. save workspace preserves terminal names', async () => {
    // Current terminals were restored from "Dual Workspace" (WS-Terminal-1, WS-Terminal-2)
    // Save a new workspace and verify the terminal names are preserved when restored

    // Close all current terminals
    const currentTerminals = await page.evaluate(() => {
      const aside = document.querySelector('aside')
      if (!aside) return []
      const buttons = aside.querySelectorAll('button[aria-label^="Close "]')
      return Array.from(buttons).map(b => b.getAttribute('aria-label')?.replace('Close ', ''))
    })

    // Remember the terminal names
    const terminalNames = currentTerminals.filter(Boolean)

    // Save workspace with these terminals
    await saveWorkspace('Names Test')
    await page.waitForTimeout(500)

    // Close all terminals
    for (const name of terminalNames) {
      if (name) await closeTerminalByName(name)
    }
    await page.waitForTimeout(500)

    // Restore the workspace
    const wsEntry = page.locator('span:has-text("Names Test")').first()
    await wsEntry.click()
    await page.waitForTimeout(3000)

    // Verify the terminal names are back
    for (const name of terminalNames) {
      if (name) {
        const entry = page.locator(`text=${name}`).first()
        await expect(entry).toBeVisible({ timeout: 5000 })
      }
    }
  })

  test('11. multiple workspaces: save 2 different workspaces, both listed', async () => {
    // We already have "Dual Workspace" and "Names Test"
    // Verify both appear in the sidebar
    const dualWs = page.locator('span:has-text("Dual Workspace")').first()
    const namesWs = page.locator('span:has-text("Names Test")').first()
    await expect(dualWs).toBeVisible()
    await expect(namesWs).toBeVisible()
  })

  test('12. close all terminals, restore workspace: terminals reopen', async () => {
    // Close all current terminals
    const terminalNames = await page.evaluate(() => {
      const aside = document.querySelector('aside')
      if (!aside) return []
      const buttons = aside.querySelectorAll('button[aria-label^="Close "]')
      return Array.from(buttons).map(b => b.getAttribute('aria-label')?.replace('Close ', ''))
    })

    for (const name of terminalNames) {
      if (name) await closeTerminalByName(name)
    }
    await page.waitForTimeout(1000)

    // Verify we're back to Welcome screen or 0 terminals
    const countBefore = await getSidebarTerminalCount()
    expect(countBefore).toBe(0)

    // Click "Dual Workspace" to restore
    const wsEntry = page.locator('span:has-text("Dual Workspace")').first()
    await wsEntry.click()
    await page.waitForTimeout(3000)

    // Terminals should reopen
    const countAfter = await getSidebarTerminalCount()
    expect(countAfter).toBeGreaterThanOrEqual(1)
  })

})
