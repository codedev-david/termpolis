import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// A11Y Y6: where the keyboard is in the Lumopolis pane can be seen. The map's host, the Ask row and the Export menu's
// items draw a ring (#4fc1ff, 7.6:1 on the pane's dialogs, so above the 3:1 a focus ring needs) when the keyboard
// reaches them. jsdom applies no Tailwind, so the classes are what is checked here; the e2e checks the drawn outline.

const read = (f: string): string => fs.readFileSync(path.resolve(__dirname, '../../../src/renderer/src', f), 'utf8')

describe('Lumopolis focus rings (A11Y Y6)', () => {
  it('the map host, the Ask row and the Export menu items show the keyboard where it is', () => {
    expect(read('components/World/WorldView.tsx')).toMatch(/data-testid="world-canvas-host"[\s\S]{0,200}className="[^"]*focus-visible:outline-\[#4fc1ff\]/)
    expect(read('components/World/WorldAsk.tsx')).toMatch(/className="[^"]*focus-within:border-\[#4fc1ff\][^"]*" data-testid="world-ask-row"/)
    expect(read('components/World/ExportMenu.tsx')).toMatch(/const itemCls = '[^']*focus-visible:outline-\[#4fc1ff\]/)
  })
  it('the viewer leaves its host\'s ring alone', () => {
    expect(read('world/engine/createWorldViewer.ts')).not.toMatch(/style\.outline\s*=/)
  })
})
