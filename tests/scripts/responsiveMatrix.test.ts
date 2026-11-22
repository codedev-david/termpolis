import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as nodePath from 'node:path'
import { paneWidths, responsiveViewports, VIEWPORTS } from '../../e2e/helpers/layoutAudit'

// The sizes and pane widths world-responsive checks in each run. The macOS job runs the reduced form, as its
// software-rendered 4K would not fit the job's time: a MacBook's two common screens at DPR 2, one of them also with
// the pane dragged to its narrowest (M6).

const at = (env: Record<string, string>): string[] =>
  responsiveViewports(env).flatMap((v) => paneWidths(v, env).map((w) => `${v.name}@${w ?? 'default'}`))

describe('the responsive matrix', () => {
  it('the reduced run (the macOS job) checks 1280x800 and 1440x900 at DPR 2, the larger also with the pane at 480', () => {
    expect(at({ RESPONSIVE_REDUCED: '1' })).toEqual(['1280x800@2x@default', '1440x900@2x@default', '1440x900@2x@480'])
  })

  it('the blocking run checks four sizes at their default width, and 4K dragged to 640 and 480 as well', () => {
    expect(at({})).toEqual(['768x1024@default', '1366x768@default', '1920x1080@default', '3840x2160@default', '3840x2160@640', '3840x2160@480'])
  })

  it('the full run checks every size at all three widths; a named size at the widths of the run it is in', () => {
    expect(at({ RESPONSIVE_FULL: '1' })).toHaveLength(VIEWPORTS.length * 3)
    expect(at({ RESPONSIVE_FULL: '1', RESPONSIVE_REDUCED: '1' })).toHaveLength(VIEWPORTS.length * 3)
    expect(at({ RESPONSIVE_ONLY: '1366x768, 3840x2160' })).toEqual(['1366x768@default', '3840x2160@default', '3840x2160@640', '3840x2160@480'])
  })

  it("the macOS job's comment says what that job leaves to Linux and Windows", () => {
    const yml = fs.readFileSync(nodePath.join(process.cwd(), '.github/workflows/test.yml'), 'utf8')
    const at = yml.indexOf('- name: Lumopolis world specs (macOS)')
    const comment = yml.slice(yml.lastIndexOf('- name:', at - 1), at)
    expect(comment).toMatch(/1280x800/)
    expect(comment).toMatch(/768x1024/)
    expect(comment).toMatch(/not on macOS/i)
  })
})
