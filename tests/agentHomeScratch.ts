// The scratch agent home both test runners point TERMPOLIS_TEST_AGENT_HOME at (tests/setup.ts for vitest,
// e2e/global-setup.ts for Playwright). Before 1.54.5 each run made one under the OS temp folder and never removed it,
// so every vitest file left a termpolis-agent-home-* folder behind. remove() deletes only the folder make() created,
// and only when it still sits directly in the temp folder under that prefix: it can never delete anything else.
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join, resolve } from 'path'

export const AGENT_HOME_PREFIX = 'termpolis-agent-home-'

export interface ScratchAgentHome {
  readonly dir: string
  /** Delete the folder and everything in it. Safe to call twice; never throws. Returns whether it is gone. */
  remove(): boolean
}

export function isScratchAgentHome(dir: string, tmp: string = tmpdir()): boolean {
  const abs = resolve(dir)
  return dirname(abs) === resolve(tmp) && basename(abs).startsWith(AGENT_HOME_PREFIX) && basename(abs).length > AGENT_HOME_PREFIX.length
}

export function makeScratchAgentHome(tmp: string = tmpdir()): ScratchAgentHome {
  const dir = mkdtempSync(join(tmp, AGENT_HOME_PREFIX))
  return {
    dir,
    remove(): boolean {
      if (!isScratchAgentHome(dir, tmp)) return false
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
        return true
      } catch {
        return false
      }
    },
  }
}
