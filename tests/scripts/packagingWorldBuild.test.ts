import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as nodePath from 'node:path'

// The afterPack verifier (scripts/verifyPackagedResources.cjs) requires world-export/world-export.js, which
// electron-builder copies from dist-world. dist-world is a build output: only `npm run build:world-viewer` (which
// `npm run build` runs) writes it. A job that packages after `npx electron-vite build` alone has no dist-world, so
// the verifier throws and the job, or the release, fails. These read the workflows CI and release really run.

type Step = { name?: string; run?: string }
type Workflow = { jobs: Record<string, { steps?: Step[] }> }

const yaml = require('js-yaml')
const load = (file: string): Workflow =>
  yaml.load(fs.readFileSync(nodePath.join(process.cwd(), '.github/workflows', file), 'utf8')) as Workflow

/** Does this step build dist-world? `npm run build` (the whole build) or `npm run build:world-viewer`. */
const buildsWorld = (s: Step): boolean => /(^|\n|&&\s*)\s*npm run build(:world-viewer)?\s*($|\n|&&)/.test(String(s.run ?? ''))
const packages = (s: Step): boolean => /npx electron-builder\b/.test(String(s.run ?? ''))

describe('every job that packages the app builds dist-world first', () => {
  const workflows = fs.readdirSync(nodePath.join(process.cwd(), '.github/workflows')).filter((f) => /\.ya?ml$/.test(f))

  for (const file of workflows) {
    for (const [job, { steps = [] }] of Object.entries(load(file).jobs)) {
      const firstPack = steps.findIndex(packages)
      if (firstPack < 0) continue
      it(`${file} ${job}: a step running npm run build or npm run build:world-viewer comes before electron-builder`, () => {
        const world = steps.findIndex(buildsWorld)
        expect(world, `${file} ${job} never builds dist-world`).toBeGreaterThanOrEqual(0)
        expect(world).toBeLessThan(firstPack)
      })
    }
  }

  it('covers the two packaging jobs that build with electron-vite alone: test.yml package-verify and release.yml build', () => {
    for (const [file, job] of [['test.yml', 'package-verify'], ['release.yml', 'build']]) {
      const steps = load(file).jobs[job].steps ?? []
      const vite = steps.findIndex((s) => /npx electron-vite build/.test(String(s.run ?? '')))
      expect(vite, `${file} ${job} builds with electron-vite`).toBeGreaterThanOrEqual(0)
      const world = steps.findIndex(buildsWorld)
      expect(world, `${file} ${job} builds dist-world`).toBeGreaterThanOrEqual(0)
      expect(world, `${file} ${job} builds dist-world before electron-vite`).toBeLessThan(vite)
    }
  })

  it('reads a world build only from a real command, not from a longer script name', () => {
    expect(buildsWorld({ run: 'npm run build' })).toBe(true)
    expect(buildsWorld({ run: 'npm run build:world-viewer' })).toBe(true)
    expect(buildsWorld({ run: 'node a.cjs && npm run build:world-viewer' })).toBe(true)
    expect(buildsWorld({ run: 'npm run build:mac' })).toBe(false)
    expect(buildsWorld({ run: 'npx electron-vite build' })).toBe(false)
  })
})
