import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'

// v1.49.1 shipped an unsigned Termpolis.exe. Both eSigner steps failed (the JDK
// bundled inside CodeSignTool couldn't validate login.ssl.com's certificate),
// both were continue-on-error, and the build packed and published the
// unsigned bytes anyway. Defender quarantined the exe on install as
// Trojan:Win32/Cinjo.O!cl. These pin both halves of the fix.

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, string>; 'continue-on-error'?: unknown }

describe('release.yml never publishes an unsigned Windows build', () => {
  const yaml = require('js-yaml')
  const wf = yaml.load(
    fs.readFileSync(nodePath.join(process.cwd(), '.github/workflows/release.yml'), 'utf8'),
  ) as { jobs: Record<string, { steps?: Step[] }> }
  const steps = wf.jobs.build.steps ?? []

  const indexOf = (name: string) => {
    const i = steps.findIndex(s => s.name === name)
    expect(i, `step "${name}" exists`).toBeGreaterThanOrEqual(0)
    return i
  }
  const signSteps = steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => String(s.uses ?? '').startsWith('sslcom/esigner-codesign'))

  it('signs both the inner exe and the installer', () => {
    expect(signSteps).toHaveLength(2)
  })

  it('checks the signature on the very file each eSigner step signed, straight after it', () => {
    for (const { s, i } of signSteps) {
      const verify = String(steps[i + 1]?.run ?? '')
      expect(verify).toContain('scripts/verify-windows-signature.ps1')
      expect(verify).toContain(String(s.with?.file_path).replace('${{ github.workspace }}/', ''))
    }
  })

  it('lets the signature check fail the build, not continue-on-error swallow it', () => {
    for (const { i } of signSteps) {
      expect(steps[i + 1]['continue-on-error']).toBeUndefined()
    }
  })

  it('checks before anything is packed into the installer or uploaded', () => {
    expect(indexOf('Verify inner Termpolis.exe is signed (Windows)'))
      .toBeLessThan(indexOf('Package — NSIS installer from signed dir (Windows)'))
    expect(indexOf('Verify Windows installer is signed')).toBeLessThan(indexOf('Upload artifacts'))
  })

  it("hands eSigner's bundled JDK a current trust store before the first signing", () => {
    const i = indexOf("Give eSigner's bundled JDK a current trust store (Windows)")
    expect(i).toBeLessThan(signSteps[0].i)
    const run = String(steps[i].run)
    expect(run).toContain('JAVA_TOOL_OPTIONS=-Djavax.net.ssl.trustStore=$store ')
    expect(run).toContain('$env:GITHUB_ENV')
    // The root the 2019 JDK lacks; the step refuses a store without it.
    expect(run).toContain('SSL.com TLS RSA Root CA 2022')
  })
})

describe.skipIf(process.platform !== 'win32')('verify-windows-signature.ps1', () => {
  const script = nodePath.join(process.cwd(), 'scripts', 'verify-windows-signature.ps1')
  const verify = (file: string) =>
    spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', file, '-Label', 'Test binary'],
      { encoding: 'utf8' },
    )

  it('passes a binary with an embedded Authenticode signature', () => {
    // Official Node builds are signed the same way eSigner signs Termpolis.exe.
    const r = verify(process.execPath)
    expect(r.stdout, r.stderr).toContain('Test binary is signed by')
    expect(r.status).toBe(0)
  })

  it('fails a file that carries no signature', () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'verify-sig-'))
    const unsigned = nodePath.join(dir, 'Termpolis.exe')
    fs.writeFileSync(unsigned, Buffer.alloc(64, 1))
    try {
      const r = verify(unsigned)
      expect(r.stdout, r.stderr).toContain('::error::Test binary is NOT signed')
      expect(r.status).toBe(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails when the file is missing rather than passing vacuously', () => {
    const r = verify(nodePath.join(os.tmpdir(), 'verify-sig-missing', 'Termpolis.exe'))
    expect(r.stdout, r.stderr).toContain('::error::Test binary not found')
    expect(r.status).toBe(1)
  })
})
