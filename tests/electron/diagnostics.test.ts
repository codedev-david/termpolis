import { describe, it, expect, vi, beforeEach } from 'vitest'
import os from 'os'

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '9.9.9'),
  },
}))

// We don't mock `os` — vitest's mock of a Node builtin is unreliable
// across platforms (on macOS CI the real `release()` leaked through),
// so instead we assert against the real os values and valid shapes.
const { collectDiagnostics, formatDiagnosticsMarkdown } = await import('../../src/main/diagnostics')

describe('collectDiagnostics', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns a populated Diagnostics object with all required fields', () => {
    const d = collectDiagnostics()
    expect(d.appVersion).toBe('9.9.9')
    expect(d.platform).toBe(process.platform)
    expect(d.osRelease).toBe(os.release())
    expect(d.arch).toBe(os.arch())
    expect(typeof d.osRelease).toBe('string')
    expect(d.osRelease.length).toBeGreaterThan(0)
    expect(typeof d.arch).toBe('string')
    expect(d.arch.length).toBeGreaterThan(0)
    expect(typeof d.electronVersion).toBe('string')
    expect(typeof d.nodeVersion).toBe('string')
    expect(typeof d.chromeVersion).toBe('string')
  })

  it('falls back to 0.0.0 when app.getVersion throws (not-yet-ready)', async () => {
    const { app } = await import('electron')
    vi.mocked(app.getVersion).mockImplementationOnce(() => { throw new Error('not ready') })
    const d = collectDiagnostics()
    expect(d.appVersion).toBe('0.0.0')
  })
})

describe('formatDiagnosticsMarkdown', () => {
  it('produces a fenced code block with stable key order', () => {
    const out = formatDiagnosticsMarkdown({
      appVersion: '1.11.15',
      platform: 'win32',
      osRelease: '10.0.22631',
      arch: 'x64',
      electronVersion: '34.0.0',
      nodeVersion: '22.12.0',
      chromeVersion: '132.0.0',
    })
    expect(out.startsWith('```\n')).toBe(true)
    expect(out.endsWith('\n```')).toBe(true)
    // Keys appear in deterministic order
    const body = out.replace(/^```\n|\n```$/g, '')
    const firstLineIdx = body.indexOf('App version')
    const archIdx = body.indexOf('Architecture')
    const electronIdx = body.indexOf('Electron')
    expect(firstLineIdx).toBeLessThan(archIdx)
    expect(archIdx).toBeLessThan(electronIdx)
  })

  it('does not inject hostnames, paths, or other identifying info', () => {
    const out = formatDiagnosticsMarkdown({
      appVersion: '1.11.15',
      platform: 'darwin',
      osRelease: '24.0.0',
      arch: 'arm64',
      electronVersion: '34.0.0',
      nodeVersion: '22.12.0',
      chromeVersion: '132.0.0',
    })
    expect(out).not.toMatch(/\/Users\//)
    expect(out).not.toMatch(/C:\\Users/)
    expect(out).not.toMatch(/@[\w.-]+\.[a-z]{2,}/i) // no email-like
  })
})
