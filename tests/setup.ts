import '@testing-library/jest-dom'
import { vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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

// A developer running the suite from inside a Termpolis (or behind a corporate proxy) inherits
// ANTHROPIC_BASE_URL / HTTPS_PROXY, and the Headroom proxy deliberately steps aside when either is
// set. Clear them so the suite sees the same clean environment CI does; tests that exercise the
// step-aside pass their own env explicitly.
for (const k of ['ANTHROPIC_BASE_URL', 'TERMPOLIS_HEADROOM_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
  delete process.env[k]
}

// Nothing a test boots may touch the real agent configs. src/main/index.ts runs the
// agent-integration boot (one-time migrations, re-applying a connection) inside
// app.whenReady(), and most main-process specs resolve whenReady — so without this, a
// test run could rewrite the developer's own ~/.claude.json, ~/.claude/settings.json,
// ~/.codex/config.toml or ~/.gemini/settings.json. resolveAgentIntegrationPaths()
// honors this scratch home over homedir(), CLAUDE_CONFIG_DIR and CODEX_HOME.
process.env.TERMPOLIS_TEST_AGENT_HOME = mkdtempSync(join(tmpdir(), 'termpolis-agent-home-'))
