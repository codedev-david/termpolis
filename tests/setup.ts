import '@testing-library/jest-dom'
import { vi } from 'vitest'
import { ensureGitOnPath } from './gitPath'

// Several tests spawn a real `git`. Whether they could find one used to depend
// on the PATH of whatever shell launched vitest — green under Git Bash, twelve
// `spawnSync git ENOENT` failures under a PowerShell session that starts
// without the User PATH entries. Same code, same git install, different
// launcher. See tests/gitPath.ts for why the fix lives here and not in a shell
// profile. No-ops when git is already resolvable.
const git = ensureGitOnPath()
if (git.status === 'unresolved') {
  // Loud on purpose: the tests that need git are about to fail, and "ENOENT"
  // on its own sends people looking for a bug in the code under test.
  console.warn(
    '[tests] No git executable found on PATH or in any known install location. ' +
      'Tests that shell out to git will fail. Install Git, or add it to PATH.',
  )
}

// jsdom does not implement IntersectionObserver — provide a no-op stub
if (typeof IntersectionObserver === 'undefined') {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
}
