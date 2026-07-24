import { describe, it, expect } from 'vitest'
import { join, dirname } from 'path'
import { fingerprint, cleanupDemoWorkflows, oncePerVersion, DEMO_FINGERPRINTS } from '../../src/main/workflow/demoCleanup'
import { workflowsDir, runsDir, serializeWorkflow, listWorkflows } from '../../src/main/workflow/workflowStore'
import type { Workflow } from '../../src/renderer/src/types'

const HOME = join('/home/dave')

/** A demo workflow shaped exactly like the ones the screenshot tooling makes. */
function demo(id: string, name = 'Nightly build & notify'): Workflow {
  return {
    id,
    name,
    version: 1,
    trigger: { type: 'manual' },
    steps: [
      { id: `${id}-1`, type: 'control', name: 'Wait', action: 'notify', config: { waitMs: 1000, message: 'Build started' } },
      { id: `${id}-2`, type: 'control', name: 'Wait', action: 'notify', config: { waitMs: 1000, message: 'Build finished' } },
    ],
  } as Workflow
}

function makeFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed))
  const dirs = new Set<string>()
  const addDirs = (p: string) => {
    let d = dirname(p)
    while (d && d !== dirname(d)) {
      dirs.add(d)
      d = dirname(d)
    }
  }
  for (const p of files.keys()) addDirs(p)
  return {
    files,
    dirs,
    existsSync: (p: string) => files.has(p) || dirs.has(p),
    mkdirSync: (p: string) => {
      dirs.add(p)
      addDirs(p)
    },
    readdirSync: (d: string) => [...files.keys()].filter(k => dirname(k) === d).map(k => k.slice(d.length + 1)),
    readFileSync: (p: string) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
      return files.get(p)!
    },
    writeFileSync: (p: string, data: string) => {
      files.set(p, data)
      addDirs(p)
    },
    appendFileSync: (p: string, data: string) => {
      files.set(p, (files.get(p) ?? '') + data)
      addDirs(p)
    },
    rmSync: (p: string) => {
      files.delete(p)
    },
    put(p: string, c: string) {
      files.set(p, c)
      addDirs(p)
    },
  }
}
type FakeFs = ReturnType<typeof makeFs>

const install = (fs: FakeFs, wf: Workflow): void => {
  fs.put(join(workflowsDir(HOME), `${wf.id}.yml`), serializeWorkflow(wf))
}

describe('fingerprint', () => {
  it('ignores the workflow id and every step id', () => {
    expect(fingerprint(demo('aaa'))).toBe(fingerprint(demo('zzz')))
  })

  it('changes when any content changes', () => {
    const base = demo('a')
    const renamed = { ...base, name: 'Something else' } as Workflow
    const restepped = { ...base, steps: [base.steps[0]] } as Workflow
    const retriggered = { ...base, trigger: { type: 'schedule', config: { cron: '@daily' } } } as Workflow
    const fp = fingerprint(base)
    expect(fingerprint(renamed)).not.toBe(fp)
    expect(fingerprint(restepped)).not.toBe(fp)
    expect(fingerprint(retriggered)).not.toBe(fp)
  })

  it('does not depend on key order (a re-save must still match)', () => {
    const a = demo('a')
    const reordered = {
      steps: a.steps.map(s => ({ config: (s as any).config, name: s.name, action: (s as any).action, type: s.type, id: s.id })),
      trigger: a.trigger,
      version: a.version,
      name: a.name,
      id: a.id,
    } as unknown as Workflow
    expect(fingerprint(reordered)).toBe(fingerprint(a))
  })

  it('is stable across calls and 32 hex chars wide', () => {
    const fp = fingerprint(demo('a'))
    expect(fp).toBe(fingerprint(demo('a')))
    expect(fp).toMatch(/^[0-9a-f]{32}$/)
  })

  it('tolerates a workflow with no steps', () => {
    expect(() => fingerprint({ id: 'x', name: 'X', version: 1, trigger: { type: 'manual' } } as Workflow)).not.toThrow()
  })

  it('ships a non-empty, deduplicated fixture list', () => {
    expect(DEMO_FINGERPRINTS.size).toBeGreaterThan(0)
    for (const fp of DEMO_FINGERPRINTS) expect(fp).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('cleanupDemoWorkflows', () => {
  const fps = new Set([fingerprint(demo('any'))])

  it('removes a demo workflow and its run history', () => {
    const fs = makeFs()
    install(fs, demo('d1'))
    const runFile = join(runsDir(HOME), 'd1.jsonl')
    fs.put(runFile, '{"runId":"r"}\n')

    const res = cleanupDemoWorkflows(HOME, fs as never, fps)
    expect(res.removed).toEqual(['d1'])
    expect(listWorkflows(workflowsDir(HOME), fs as never)).toEqual([])
    expect(fs.files.has(runFile)).toBe(false)
  })

  it('keeps a workflow the user actually wrote, even with the same name', () => {
    const fs = makeFs()
    const mine = { ...demo('mine', 'Nightly build & notify'), steps: [demo('mine').steps[0]] } as Workflow
    install(fs, mine)
    const res = cleanupDemoWorkflows(HOME, fs as never, fps)
    expect(res.removed).toEqual([])
    expect(res.kept).toBe(1)
    expect(listWorkflows(workflowsDir(HOME), fs as never)).toHaveLength(1)
  })

  it('removes only the demos when a store holds both', () => {
    const fs = makeFs()
    install(fs, demo('d1'))
    install(fs, demo('d2'))
    install(fs, { ...demo('keep'), name: 'My real workflow' } as Workflow)
    const res = cleanupDemoWorkflows(HOME, fs as never, fps)
    expect(res.removed.sort()).toEqual(['d1', 'd2'])
    expect(listWorkflows(workflowsDir(HOME), fs as never).map(w => w.id)).toEqual(['keep'])
  })

  it('is a no-op on an empty or absent store', () => {
    const fs = makeFs()
    expect(cleanupDemoWorkflows(HOME, fs as never, fps)).toEqual({ removed: [], kept: 0 })
  })

  it('is idempotent — a second sweep finds nothing', () => {
    const fs = makeFs()
    install(fs, demo('d1'))
    cleanupDemoWorkflows(HOME, fs as never, fps)
    expect(cleanupDemoWorkflows(HOME, fs as never, fps).removed).toEqual([])
  })

  it('never throws when the store cannot be listed', () => {
    const fs = makeFs()
    install(fs, demo('d1'))
    fs.readdirSync = () => {
      throw new Error('EACCES')
    }
    expect(cleanupDemoWorkflows(HOME, fs as never, fps)).toEqual({ removed: [], kept: 0 })
  })

  it('counts an undeletable demo as kept and logs it', () => {
    const fs = makeFs()
    install(fs, demo('d1'))
    fs.rmSync = () => {
      throw new Error('EPERM')
    }
    const logs: string[] = []
    const res = cleanupDemoWorkflows(HOME, fs as never, fps, m => logs.push(m))
    expect(res).toEqual({ removed: [], kept: 1 })
    expect(logs.some(l => l.includes('could not remove'))).toBe(true)
  })

  it('survives a missing run-history file', () => {
    const fs = makeFs()
    install(fs, demo('d1'))
    expect(cleanupDemoWorkflows(HOME, fs as never, fps).removed).toEqual(['d1'])
  })

  it('logs a summary only when something was removed', () => {
    const fs = makeFs()
    const quiet: string[] = []
    cleanupDemoWorkflows(HOME, fs as never, fps, m => quiet.push(m))
    expect(quiet).toEqual([])

    install(fs, demo('d1'))
    const loud: string[] = []
    cleanupDemoWorkflows(HOME, fs as never, fps, m => loud.push(m))
    expect(loud.some(l => l.includes('removed 1 leftover demo workflow'))).toBe(true)
  })

  it('defaults to the shipped fixture list when none is passed', () => {
    const fs = makeFs()
    install(fs, { ...demo('mine'), name: 'Totally my own thing' } as Workflow)
    expect(cleanupDemoWorkflows(HOME, fs as never).removed).toEqual([])
  })
})

describe('oncePerVersion', () => {
  const UD = join('/userdata')

  it('runs on first launch and records the version', () => {
    const fs = makeFs()
    let ran = 0
    expect(oncePerVersion(UD, '1.32.0', fs as never, () => ran++)).toBe(true)
    expect(ran).toBe(1)
    expect(JSON.parse(fs.files.get(join(UD, 'workflow-demo-cleanup.json'))!).version).toBe('1.32.0')
  })

  it('does not run again on the same version', () => {
    const fs = makeFs()
    let ran = 0
    oncePerVersion(UD, '1.32.0', fs as never, () => ran++)
    expect(oncePerVersion(UD, '1.32.0', fs as never, () => ran++)).toBe(false)
    expect(ran).toBe(1)
  })

  it('runs again after an upgrade', () => {
    const fs = makeFs()
    let ran = 0
    oncePerVersion(UD, '1.32.0', fs as never, () => ran++)
    expect(oncePerVersion(UD, '1.33.0', fs as never, () => ran++)).toBe(true)
    expect(ran).toBe(2)
  })

  it('re-runs when the marker is corrupt rather than skipping forever', () => {
    const fs = makeFs()
    fs.put(join(UD, 'workflow-demo-cleanup.json'), 'not json{')
    let ran = 0
    expect(oncePerVersion(UD, '1.32.0', fs as never, () => ran++)).toBe(true)
    expect(ran).toBe(1)
  })

  it('re-runs when the marker holds a non-object', () => {
    const fs = makeFs()
    fs.put(join(UD, 'workflow-demo-cleanup.json'), '"1.32.0"')
    let ran = 0
    expect(oncePerVersion(UD, '1.32.0', fs as never, () => ran++)).toBe(true)
    expect(ran).toBe(1)
  })

  it('still runs the body when the marker cannot be written', () => {
    const fs = makeFs()
    fs.writeFileSync = () => {
      throw new Error('EROFS')
    }
    let ran = 0
    expect(oncePerVersion(UD, '1.32.0', fs as never, () => ran++)).toBe(true)
    expect(ran).toBe(1)
  })

  it('creates the userData directory when it is missing', () => {
    const fs = makeFs()
    oncePerVersion(UD, '1.32.0', fs as never, () => {})
    expect(fs.files.has(join(UD, 'workflow-demo-cleanup.json'))).toBe(true)
  })

  it('lets the body throw rather than swallowing a real failure', () => {
    const fs = makeFs()
    expect(() =>
      oncePerVersion(UD, '1.32.0', fs as never, () => {
        throw new Error('cleanup blew up')
      }),
    ).toThrow(/cleanup blew up/)
  })
})
