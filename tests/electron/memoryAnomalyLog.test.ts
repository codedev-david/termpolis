import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import { initAnomalyLog, recordAnomaly, getAnomalies, anomalyCount, _resetAnomalyLogForTests } from '../../src/main/memoryAnomalyLog'
import { initSwarmMemory, reloadMemoryFromSync, getSyncStatus, _resetForTests, _setEmbedFnForTests } from '../../src/main/swarmMemory'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anom-'))
  _resetAnomalyLogForTests()
})
afterEach(() => {
  _resetAnomalyLogForTests()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('memoryAnomalyLog', () => {
  it('recordAnomaly is a no-op before init (safe to sprinkle in callers)', () => {
    recordAnomaly('degraded-init', 'x')
    expect(getAnomalies()).toEqual([])
  })

  it('records and returns most-recent-first', () => {
    initAnomalyLog(dir)
    recordAnomaly('a', '1', 100)
    recordAnomaly('b', '2', 200)
    expect(getAnomalies().map((x) => x.kind)).toEqual(['b', 'a'])
  })

  it('caps the ring (keeps the newest)', () => {
    initAnomalyLog(dir)
    for (let i = 0; i < 600; i++) recordAnomaly('k', String(i), i)
    expect(anomalyCount()).toBe(500)
    expect(getAnomalies(1)[0].detail).toBe('599')
  })

  it('persists and reloads across sessions', () => {
    initAnomalyLog(dir)
    recordAnomaly('degraded-init', 'boom', 100)
    _resetAnomalyLogForTests()
    initAnomalyLog(dir)
    expect(getAnomalies().map((x) => x.kind)).toEqual(['degraded-init'])
  })

  it('counts by kind', () => {
    initAnomalyLog(dir)
    recordAnomaly('x')
    recordAnomaly('y')
    recordAnomaly('x')
    expect(anomalyCount('x')).toBe(2)
    expect(anomalyCount()).toBe(3)
  })
})

describe('anomaly wiring — swarmMemory records a corrupt-lines anomaly', () => {
  it('a torn peer shard line is logged as an anomaly on reload', () => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anom-u-'))
    const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anom-s-'))
    try {
      _resetForTests()
      _setEmbedFnForTests(async () => null)
      initAnomalyLog(userDir)
      initSwarmMemory(userDir, { syncDir })
      // A peer shard with a genuinely unparseable line.
      fs.writeFileSync(path.join(syncDir, 'peer-device.jsonl'), 'not valid json {{{\n')
      reloadMemoryFromSync()
      expect(getSyncStatus().corruptLinesSkipped).toBeGreaterThan(0)
      expect(anomalyCount('corrupt-lines')).toBeGreaterThan(0)
    } finally {
      _resetForTests()
      for (const d of [userDir, syncDir]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
    }
  })
})
