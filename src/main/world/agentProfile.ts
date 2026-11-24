// agentProfile.ts
//
// The one launch profile every Lumopolis agent run uses: Ask, the Designer and labelling. Each of them
// spreads this into its runHeadless request, so the agents can't drift apart. A Lumopolis run reads the
// project and answers; it never edits, never runs a command, never reaches the person's MCP servers and
// never writes its output to the brain:
//   - write: false — each CLI's own read-only launch (headlessExec.execCommand);
//   - isolated: true — no MCP server of the person's, no command, no file write, per agent
//     (readOnlyIsolation.ts), and a run that can't be isolated doesn't start;
//   - noRemember: true — an answer about a map is not a fact for the next run's primer.

import type { ExecRequest } from '../headlessExec'

export const LUMOPOLIS_RUN = { write: false, isolated: true, noRemember: true } as const satisfies Partial<ExecRequest>
