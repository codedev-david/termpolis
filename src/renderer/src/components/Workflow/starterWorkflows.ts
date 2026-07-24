import type { Workflow } from '../../types'

// Starter workflows offered under the sidebar's "New from template" menu.
// Each re-expresses a legacy launcher preset as a single visible Command step
// that opens a managed pane. `shell: 'bash'` is portable — the main-process
// adapter resolves the concrete executable per platform (git-bash on Windows).
// Selecting one seeds the Designer with a fresh copy (the overlay re-ids it),
// so these ids are template identities, not the saved workflow's id.
export const STARTER_WORKFLOWS: Workflow[] = [
  {
    id: 'claude-dev',
    name: 'Claude Code + Shell',
    description: 'Launch Claude Code in a managed pane, ready to pair on this repo.',
    version: 1,
    trigger: { type: 'manual' },
    steps: [
      { id: 'claude', type: 'command', name: 'Claude Code', source: 'inline', command: 'claude', shell: 'bash', visible: true },
    ],
  },
  {
    id: 'full-stack',
    name: 'Full Stack Dev',
    description: 'Bring up an AI agent to drive frontend, backend and tests.',
    version: 1,
    trigger: { type: 'manual' },
    steps: [
      { id: 'agent', type: 'command', name: 'AI Agent', source: 'inline', command: 'claude', shell: 'bash', visible: true },
    ],
  },
  {
    id: 'code-review',
    name: 'Code Review',
    description: 'Open recent history in a pane to review the latest changes.',
    version: 1,
    trigger: { type: 'manual' },
    steps: [
      { id: 'gitlog', type: 'command', name: 'Git log', source: 'inline', command: 'git log --oneline -20', shell: 'bash', visible: true },
    ],
  },
]
