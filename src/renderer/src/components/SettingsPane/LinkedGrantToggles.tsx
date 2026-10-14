import type { LinkedGrants } from '../../types'
import { codexEditAccess, type GrantKey } from '../../lib/linkedMachines'
import { hostPlatform } from '../../lib/platform'

interface GrantRow {
  key: GrantKey
  label: string
  hint: string
  /** Rendered in amber. Reserved for the grant that lets another computer
   *  change this one. */
  risk?: boolean
}

/** Least to most powerful, as on the Remote pane: the grant a user ticks
 *  without thinking is the harmless one, and the risky one is read last.
 *  The copy says plainly what each grant hands over (spec §4.1, §4.6), per
 *  agent where they differ: Termpolis can switch Codex's network off for a
 *  job, and has nothing like it for Claude or Gemini. Codex's own sentence
 *  depends on this computer's OS (codexEditAccess), so it is added as it renders. */
const GRANTS: GrantRow[] = [
  {
    key: 'run',
    label: 'Run agents here (read-only)',
    hint: 'Its agents can ask an agent on this computer to read files and answer. That agent can read anything you can.',
  },
  {
    key: 'write',
    label: 'Let agents edit files and run commands here',
    hint:
      'Its agents can start an agent here that edits files and runs commands without asking you. Claude and Gemini run ' +
      'with full access as you: they can change any file you can, use your Termpolis terminals and reach your other ' +
      'linked computers. Codex runs in its own sandbox: it changes files only in its folder and temporary folders.',
    risk: true,
  },
]

const TRUST = 'Allow this only for a computer you trust as much as this one.'

export interface LinkedGrantTogglesProps {
  grants: LinkedGrants
  onToggle(key: GrantKey): void
  /** Yields `<prefix>-run`, `<prefix>-write` and `<prefix>-write-risk`. */
  testIdPrefix: string
  disabled?: boolean
  /** The grants offered, both by default. Before a link exists only `run` is:
   *  edit waits until the other computer's words are confirmed. */
  keys?: readonly GrantKey[]
  /** Grants shown but not changeable, beside `disabled` for all of them. */
  disabledKeys?: readonly GrantKey[]
}

/** The grant checkboxes, used wherever a grant is chosen: before a code is
 *  made, before a code is entered, and on each linked computer's row. One
 *  component, so the risk copy cannot drift between them. */
export function LinkedGrantToggles({
  grants,
  onToggle,
  testIdPrefix,
  disabled = false,
  keys,
  disabledKeys = [],
}: LinkedGrantTogglesProps): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      {GRANTS.filter((grant) => !keys || keys.includes(grant.key)).map((grant) => {
        const off = disabled || disabledKeys.includes(grant.key)
        return (
          <label
            key={grant.key}
            className={`flex items-start gap-2 text-xs text-[#d4d4d4] ${off ? 'opacity-60' : ''}`}
          >
            <input
              type="checkbox"
              data-testid={`${testIdPrefix}-${grant.key}`}
              checked={grants[grant.key]}
              disabled={off}
              onChange={() => onToggle(grant.key)}
              className="mt-0.5"
            />
            <span>
              <span>{grant.label}</span>
              <span
                data-testid={grant.risk ? `${testIdPrefix}-${grant.key}-risk` : undefined}
                className={`block ${grant.risk ? 'text-[#e5c07b]' : 'text-[#6b7280]'}`}
              >
                {grant.key === 'write' ? `${grant.hint} ${codexEditAccess(hostPlatform()).sentence} ${TRUST}` : grant.hint}
              </span>
            </span>
          </label>
        )
      })}
    </div>
  )
}
