import { join } from 'path'

/** File in userData that remembers which version last ran, so an update restart can skip the intro. */
export const LAST_RUN_FILE = 'last-run-version'

const VERSION_RE = /^\d+\.\d+\.\d+([-.+][\w.]+)?$/

export interface IntroGateDeps {
  userData: string
  version: string
  env: NodeJS.ProcessEnv
  readFile(p: string): string
  writeFile(p: string, text: string): void
}

/**
 * Decides once per process whether the launch intro may play. Never throws: an unreadable,
 * garbage or unwritable last-run file counts as "no previous version".
 */
export function createIntroGate(deps: IntroGateDeps): { claim(): boolean } {
  let claimed = false
  return {
    claim(): boolean {
      if (claimed) return false
      claimed = true
      const file = join(deps.userData, LAST_RUN_FILE)
      let previous: string | null = null
      try {
        const text = deps.readFile(file).trim()
        if (VERSION_RE.test(text)) previous = text
      } catch {
        previous = null
      }
      try {
        deps.writeFile(file, deps.version)
      } catch {
        // A read-only userData must not stop the start; the answer below still stands.
      }
      if (deps.env.NODE_ENV === 'test' && deps.env.TERMPOLIS_TEST_LAUNCH_INTRO !== '1') return false
      return previous === null || previous === deps.version
    },
  }
}
