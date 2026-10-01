/**
 * `Termpolis --disconnect-agents` against the REAL built main bundle, the way the Windows
 * uninstaller runs it (build/installer.nsh, customUnInit): the Termpolis entries come out of the
 * agent configs, the user's own entries stay, and the app exits 0 by itself, well inside the
 * 30 seconds the uninstaller gives it, leaving nothing open in its profile folder.
 *
 * The flag is handled in index.ts before anything platform-specific, so this works on every OS;
 * CI runs it with the rest of e2e/ in the Linux e2e-full shards. The Windows-only half, the
 * uninstaller macro itself, is pinned by tests/electron/installerUninstallDisconnect.test.ts.
 *
 * Spawned directly, not with Playwright's electron.launch(): the app is meant to exit before
 * `ready`, which launch() would report as a failure to start. The agent configs live in a
 * scratch home passed as TERMPOLIS_TEST_AGENT_HOME, which resolveAgentIntegrationPaths()
 * honours over the real home, so this can never touch a developer's ~/.claude.json.
 */
import { test, expect } from '@playwright/test'
import { spawnSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { e2eLaunchArgs, e2eUserDataDir } from './helpers/launch'

const LABEL = 'uninstall-disconnect'
/** The uninstaller's limit (nsExec /TIMEOUT in build/installer.nsh). */
const UNINSTALLER_LIMIT_MS = 30_000

/** The Electron binary, found the way the `electron` package's own index.js finds it. */
function electronBinary(): string {
  const pkg = path.resolve('node_modules', 'electron')
  return path.join(pkg, 'dist', fs.readFileSync(path.join(pkg, 'path.txt'), 'utf8').trim())
}

test('--disconnect-agents takes Termpolis out of the agent configs and exits 0 on its own', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-uninstall-home-'))
  const userData = e2eUserDataDir(LABEL)
  try {
    // What Termpolis writes (the adapter script is how an entry is recognised as its own) next
    // to a server the user added, which must survive.
    const adapter = path.join(os.tmpdir(), 'Termpolis', 'resources', 'mcp-adapter', 'stdio-adapter.cjs')
    const mine = { command: 'npx', args: ['-y', 'my-own-mcp-server'] }
    const claudeJson = path.join(home, '.claude.json')
    const geminiSettings = path.join(home, '.gemini', 'settings.json')
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true })
    fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { termpolis: { type: 'stdio', command: 'node', args: [adapter] }, mine } }, null, 2))
    fs.writeFileSync(geminiSettings, JSON.stringify({ mcpServers: { termpolis: { command: 'node', args: [adapter] }, mine } }, null, 2))

    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', TERMPOLIS_TEST_AGENT_HOME: home }
    // Electron would start as plain Node, with no `app`, if the runner had this set.
    delete env.ELECTRON_RUN_AS_NODE
    // On Windows os.homedir() reads USERPROFILE, so a run on a developer machine cannot reach
    // the real configs even if the override above ever stopped working. Not HOME elsewhere:
    // Chromium reads it before `ready` for its own folders.
    if (process.platform === 'win32') env.USERPROFILE = home

    const started = Date.now()
    const run = spawnSync(electronBinary(), [...e2eLaunchArgs(LABEL), '--disconnect-agents'], {
      env,
      encoding: 'utf8',
      timeout: 2 * UNINSTALLER_LIMIT_MS,
      windowsHide: true,
    })
    const took = Date.now() - started
    const output = `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`

    // It ended by itself: not killed by the timeout above, and no error dialog left waiting.
    expect(run.error, output).toBeUndefined()
    expect(run.signal, output).toBeNull()
    expect(run.status, output).toBe(0)
    expect(took, output).toBeLessThan(UNINSTALLER_LIMIT_MS)

    expect(JSON.parse(fs.readFileSync(claudeJson, 'utf8')).mcpServers).toEqual({ mine })
    expect(JSON.parse(fs.readFileSync(geminiSettings, 'utf8')).mcpServers).toEqual({ mine })

    // Nothing it started is still holding files in its profile folder: on Windows an open
    // handle makes this throw EBUSY/EPERM, which is exactly what would stop an uninstall.
    expect(() => fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })).not.toThrow()
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
