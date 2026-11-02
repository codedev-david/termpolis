// @vitest-environment node
//
// The account UI's motion respects reduced-motion (account-switcher-ui.md section 4, UI addendum): every animation in
// its components is Tailwind's `motion-safe:` variant, which the browser drops when the user asked for less motion.
// A static scan, so a later edit that adds a bare animate-* class (or a CSS animation) fails here, not in a review.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { SPINNER } from '../../src/renderer/src/components/Accounts/ui'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const ACCOUNTS = join(ROOT, 'src/renderer/src/components/Accounts')

function accountUiFiles(): string[] {
  const own = readdirSync(ACCOUNTS).filter((f) => /\.(tsx?|css)$/.test(f)).map((f) => join(ACCOUNTS, f))
  return [...own, join(ROOT, 'src/renderer/src/components/SettingsPane/AccountsSettings.tsx')]
}

describe('motion in the account UI (account-switcher-ui.md section 4)', () => {
  it('has the spinner behind motion-safe', () => {
    expect(SPINNER).toContain('motion-safe:animate-spin')
    expect(SPINNER.replace('motion-safe:animate-spin', '')).not.toMatch(/animate-/)
  })

  it('has no animation class in any account component that is not behind motion-safe:', () => {
    const bare: string[] = []
    for (const file of accountUiFiles()) {
      const text = readFileSync(file, 'utf-8')
      for (const m of text.matchAll(/(?<![\w:-])animate-[a-z0-9-]+/g)) bare.push(`${file.slice(ROOT.length + 1)}: ${m[0]}`)
    }
    expect(bare).toEqual([])
  })

  it('has no CSS animation or keyframes of its own in them', () => {
    const own: string[] = []
    for (const file of accountUiFiles()) {
      const text = readFileSync(file, 'utf-8')
      if (/@keyframes|animation\s*:|animationName/.test(text)) own.push(file.slice(ROOT.length + 1))
    }
    expect(own).toEqual([])
  })

  it('sees the files it scans: the sheet, the menu, the chip and the settings pane', () => {
    const names = accountUiFiles().map((f) => f.split(/[\\/]/).pop())
    expect(names).toEqual(expect.arrayContaining(['Sheet.tsx', 'AccountMenu.tsx', 'AccountChip.tsx', 'AccountsSettings.tsx', 'ui.ts']))
  })

  it('would catch a bare class (the scan\'s own check)', () => {
    const bare = [...'<i className="fa-solid fa-spinner animate-spin" /> <i className="motion-safe:animate-spin" />'.matchAll(/(?<![\w:-])animate-[a-z0-9-]+/g)].map((m) => m[0])
    expect(bare).toEqual(['animate-spin'])
  })
})
