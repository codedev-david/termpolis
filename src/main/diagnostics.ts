// Lightweight diagnostics payload for bug reports — collects ONLY
// non-identifying environment info the user can inspect before sending.
// Called from the Report-a-Problem flow, inlined into the GitHub
// new-issue URL's body template so maintainers have a starting point
// without demanding a separate round-trip for "what version are you on".

import { app } from 'electron'
import { getGovernorSnapshot, type GovernorSnapshot } from './loopGovernor'
import { arch, release } from 'os'
import { getTypingTraceSnapshot, type TypingTraceSnapshot } from './typingTrace'

export interface Diagnostics {
  appVersion: string
  platform: NodeJS.Platform
  osRelease: string
  /** The event-loop governor's state (SHED or not, how often, the last p99): plain numbers, not in the issue text. */
  governor?: GovernorSnapshot
  arch: string
  electronVersion: string
  nodeVersion: string
  chromeVersion: string
  /** The typing trace (loop delay, echo latency, handler timings, memory): numbers only. Not part of
   *  the Report-a-Problem text, which prints the seven fields above. */
  typing?: TypingTraceSnapshot
}

export function collectDiagnostics(): Diagnostics {
  let appVersion = '0.0.0'
  try { appVersion = app.getVersion() } catch { /* app not ready (tests) */ }
  return {
    appVersion,
    platform: process.platform,
    osRelease: release(),
    governor: getGovernorSnapshot(),
    arch: arch(),
    electronVersion: process.versions.electron || 'n/a',
    nodeVersion: process.versions.node || 'n/a',
    chromeVersion: process.versions.chrome || 'n/a',
    typing: getTypingTraceSnapshot(),
  }
}

// Renders the diagnostics block as a markdown-friendly fenced code
// block for inclusion in a GitHub issue body. Deterministic key order
// so diffs and snapshot tests stay stable across runs.
export function formatDiagnosticsMarkdown(d: Diagnostics): string {
  const lines = [
    `App version:     ${d.appVersion}`,
    `Platform:        ${d.platform}`,
    `OS release:      ${d.osRelease}`,
    `Architecture:    ${d.arch}`,
    `Electron:        ${d.electronVersion}`,
    `Node:            ${d.nodeVersion}`,
    `Chrome:          ${d.chromeVersion}`,
  ]
  return '```\n' + lines.join('\n') + '\n```'
}
