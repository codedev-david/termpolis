// The Lumopolis scenario fixtures (tests/e2e/fixtures/worldScenarios.ts) for the vitest suites: each scenario in its
// own temp folder, removed again by cleanup().
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeScenario, type ScenarioName, type ScenarioOptions } from '../e2e/fixtures/worldScenarios'

export { SCENARIO_NAMES, type ScenarioName, type ScenarioOptions } from '../e2e/fixtures/worldScenarios'

export interface MadeScenario {
  /** The scenario's project folder. */
  dir: string
  /** Removes the scenario and everything made beside it (a submodule's library, a link's outside folder). */
  cleanup: () => Promise<void>
}

export async function withScenario(name: ScenarioName, opts: ScenarioOptions = {}): Promise<MadeScenario> {
  const base = await mkdtemp(join(tmpdir(), 'world-scenario-'))
  const cleanup = (): Promise<void> => rm(base, { recursive: true, force: true, maxRetries: 3 })
  try {
    return { dir: await makeScenario(name, base, opts), cleanup }
  } catch (e) {
    await cleanup()
    throw e
  }
}
