import { parseInput } from './inputParser'
import { loadSpec } from './specLoader'

export interface CompletionResult {
  text: string
  description: string
  source: 'spec' | 'shell' | 'history'
}

const MAX_RESULTS = 8

export async function getCompletions(input: string): Promise<CompletionResult[]> {
  const parsed = parseInput(input)
  if (!parsed.command && parsed.context === 'command') return []

  const results: CompletionResult[] = []
  const seen = new Set<string>()

  function add(text: string, description: string, source: CompletionResult['source']) {
    if (seen.has(text) || results.length >= MAX_RESULTS) return
    seen.add(text)
    results.push({ text, description, source })
  }

  if (parsed.context === 'command') {
    const res = await window.termpolis.completionPathCommands()
    if (res.success && res.data) {
      for (const cmd of res.data) {
        if (cmd.toLowerCase().startsWith(parsed.partial.toLowerCase())) {
          add(cmd, '', 'shell')
        }
      }
    }
  } else if (parsed.context === 'subcommand' || parsed.context === 'flag') {
    const spec = await loadSpec(parsed.command)
    if (spec) {
      if (parsed.context === 'subcommand' && spec.subcommands) {
        for (const sub of spec.subcommands) {
          if (sub.name.startsWith(parsed.partial)) {
            add(sub.name, sub.description, 'spec')
          }
        }
      }
      if (parsed.context === 'flag') {
        const target = parsed.subcommand
          ? spec.subcommands?.find(s => s.name === parsed.subcommand)
          : spec
        if (target?.options) {
          for (const opt of target.options) {
            for (const name of opt.name) {
              if (name.startsWith(parsed.partial)) {
                add(name, opt.description, 'spec')
              }
            }
          }
        }
      }
    }
  } else if (parsed.context === 'path') {
    const lastSlash = parsed.partial.lastIndexOf('/')
    const dir = lastSlash >= 0 ? parsed.partial.slice(0, lastSlash + 1) : './'
    const prefix = lastSlash >= 0 ? parsed.partial.slice(lastSlash + 1) : parsed.partial
    const res = await window.termpolis.completionPathEntries(dir)
    if (res.success && res.data) {
      for (const entry of res.data) {
        if (entry.name.toLowerCase().startsWith(prefix.toLowerCase())) {
          add(dir + entry.name + (entry.isDir ? '/' : ''), entry.isDir ? 'Directory' : 'File', 'shell')
        }
      }
    }
  }

  // History suggestions
  try {
    const histRes = await window.termpolis.searchHistory(parsed.command || '')
    if (histRes.success && histRes.data) {
      const freq = new Map<string, number>()
      for (const h of histRes.data) freq.set(h.command, (freq.get(h.command) || 0) + 1)
      const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1])
      for (const [cmd, count] of sorted) {
        if (cmd.startsWith(input.trim())) {
          add(cmd, `Used ${count} time${count > 1 ? 's' : ''}`, 'history')
        }
      }
    }
  } catch {}

  return results.slice(0, MAX_RESULTS)
}
