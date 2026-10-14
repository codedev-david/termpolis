/**
 * The unit suite has to run on a machine that cannot build the renderer: one whose node_modules
 * predates Tailwind 4, so it has no @tailwindcss/postcss. Vitest empties every stylesheet a test
 * imports, but Vite still loads a PostCSS config to process the empty file, and postcss.config.js
 * names @tailwindcss/postcss. vitest.config.ts therefore gives tests an inline PostCSS config.
 * Without it, every import below fails on such a machine with "Failed to load PostCSS config".
 * Where the package is installed (CI) they pass either way, so this guards the local run.
 */
import { describe, it, expect } from 'vitest'

describe('stylesheets imported by a test', () => {
  it('load as empty modules, from the renderer and its packages alike', async () => {
    // What src/renderer/src/main.tsx and TerminalPane.tsx import.
    const sheets = await Promise.all([
      import('../../src/renderer/src/index.css'),
      import('../../src/renderer/src/assets/fonts/fonts.css'),
      import('@fortawesome/fontawesome-free/css/all.min.css'),
      import('@xterm/xterm/css/xterm.css'),
    ])
    for (const sheet of sheets) expect(sheet.default).toBe('')
  })

  it('do not stop a monaco module that imports its own stylesheet from loading', async () => {
    // aria.js has `import './aria.css'`; most of monaco's UI modules import a stylesheet that way.
    const aria = await import('monaco-editor/base/browser/ui/aria/aria.js')
    expect(typeof aria.alert).toBe('function')
  })
})
