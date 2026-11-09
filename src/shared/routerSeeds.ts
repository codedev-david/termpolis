// v1.56.0 per-message routing: the labelled examples the local classifier starts from. Each message a
// user types into a Claude session is embedded on this machine (bge-small, the model memory search
// already runs) and compared with these; the nearest ones vote. The user's own picks are added on top
// and weigh double (routerModel.ts), so the router learns what this user means by a quick question.
//
// 'keep' is its own class: "yes", "go ahead", "option 2" confirm work the session already proposed, and
// the size of that work is whatever came before. Routing them anywhere would guess; they stay put.
//
// Editing this list re-embeds it once on the next start (the cache is keyed by a hash of the texts).

export type SeedLabel = 'keep' | 'haiku' | 'sonnet' | 'opus'

export const ROUTER_SEEDS: Readonly<Record<SeedLabel, readonly string[]>> = {
  keep: [
    'yes', 'yes please', 'go ahead', 'continue', 'do it', 'ok', 'sounds good', 'proceed', 'keep going',
    'sure', 'yep do that', 'lets do it', 'approved', 'go', 'that works, carry on', 'option 2',
    'the first one', 'y', 'please continue where you left off', 'sure lets push this', 'yes to all of those',
    'do the rest', 'agreed, implement it', 'finish it',
  ],
  haiku: [
    "what's the git status", 'commit this with a good message', 'push to main', 'run the tests',
    'run npm run lint', 'what does this function return', 'where is handleLaunch defined',
    'list the files in src/main', 'show me the last 5 commits', 'format this json',
    'rename the variable foo to bar in this file', 'fix the typo in the readme', 'summarize this error message',
    'explain this regex', 'what version is in package.json', 'delete the temp file', 'did the CI run pass?',
    "what's the difference between let and const", 'write a commit message', 'add a comment above this function',
    'convert this to a one-liner', 'show the diff', 'how many lines is this file', 'grep for TODO in src',
    'bump the version to 1.2.3', 'translate this error to plain english', 'is the build green?', 'thanks',
    'check the release workflow status', 'what branch am I on', 'where are we at', 'so we are just waiting?',
    'what port does the dev server use', 'print the env var PATH',
  ],
  sonnet: [
    'implement the settings toggle we discussed', 'fix the failing test in terminalManager.test.ts',
    'add unit tests for the router', 'refactor this function to use async/await',
    'write a script that renames all the files', 'add a dark mode toggle to the settings page',
    'the build fails with this error, fix it', 'update the API client to the new endpoint',
    'add input validation to the form', 'write the migration for the new column',
    'make the button disabled while loading', 'port this python script to typescript',
    'add pagination to the list endpoint', 'wire the new IPC handler into the renderer',
    'write e2e tests for the login flow', 'fix the lint errors', 'add error handling to the download function',
    'create a react component for the account chip', 'update the docs for the new flag',
    'add a retry with backoff to the http client', 'convert this class component to hooks',
    'implement the CSV export', 'fix this null pointer exception', 'add logging around the proxy requests',
    'increase coverage on memoryClient to the gate', 'resolve the merge conflicts',
    'write a github action that runs the tests on push', 'add a cli flag for verbose output',
    'make the sidebar resizable', 'change the default timeout to 10 seconds and update the tests',
    'cut the release and watch the pipelines', 'the tests failed on macOS, fix them and push',
  ],
  opus: [
    'design the architecture for per-message model routing',
    'why does the app freeze when a terminal closes? find the root cause',
    'plan the migration from electron 42 to 43',
    "there's a race condition between the proxy and the hook, figure it out",
    'review this PR for security issues',
    'we keep getting intermittent test failures on macOS only, investigate',
    'design a sync protocol for memory across machines with end to end encryption',
    'figure out why token usage doubled after the last release',
    'audit the codebase for credential leaks',
    'how should we structure the plugin system so third parties can extend it safely',
    'debug this deadlock in the worker pool',
    'the app uses 4GB of memory after a day, find the leak',
    'propose a plan to cut startup time in half',
    'think through the tradeoffs of moving the pty host out of process',
    'rewrite the scheduler to be lock-free',
    'design the database schema for multi-tenant billing',
    'evaluate whether we should replace the HNSW index',
    'find the root cause of the corrupted ledger file',
    'plan the whole next release',
    'the auto updater sometimes installs the wrong version, investigate end to end',
    'design an algorithm to pick the cheapest model per message',
    'do a deep review of the threat model for linked machines',
    'why is the cache hit rate so low? dig into the request shapes',
    'untangle the circular dependency between the store and the IPC layer',
    'come up with a strategy to make the e2e suite deterministic',
    'explain the full lifecycle of a request through the proxy and where it can fail',
    'ultrathink about how to restructure the memory host',
    'redesign the swarm conductor to handle failures',
    'investigate the flaky crash on quit and fix it properly',
    'i want something very smart here, think hard about the best approach',
  ],
}

/** The seeds as one flat list, in a stable order. */
export function flatSeeds(): Array<{ label: SeedLabel; text: string }> {
  const out: Array<{ label: SeedLabel; text: string }> = []
  for (const label of ['keep', 'haiku', 'sonnet', 'opus'] as const) {
    for (const text of ROUTER_SEEDS[label]) out.push({ label, text })
  }
  return out
}
