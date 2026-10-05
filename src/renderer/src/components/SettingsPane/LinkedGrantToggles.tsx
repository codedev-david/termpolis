import type { LinkedGrants } from '../../types'
import type { GrantKey } from '../../lib/linkedMachines'

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
 *  The copy says plainly what each grant hands over (spec §4.1, §4.6). */
const GRANTS: GrantRow[] = [
  {
    key: 'run',
    label: 'Run agents here (read-only)',
    hint: 'Its agents can ask an agent on this computer to read files and answer. That agent can read anything you can.',
  },
  {
    key: 'write',
    label: 'Let agents edit files and run commands here',
    hint: 'Its agents can start an agent here that changes files and runs commands without asking you first. Only allow this for a computer you control.',
    risk: true,
  },
]

export interface LinkedGrantTogglesProps {
  grants: LinkedGrants
  onToggle(key: GrantKey): void
  /** Yields `<prefix>-run`, `<prefix>-write` and `<prefix>-write-risk`. */
  testIdPrefix: string
  disabled?: boolean
}

/** The two grant checkboxes, used wherever a grant is chosen: before a code is
 *  made, before a code is entered, and on each linked computer's row. One
 *  component, so the risk copy cannot drift between the three. */
export function LinkedGrantToggles({
  grants,
  onToggle,
  testIdPrefix,
  disabled = false,
}: LinkedGrantTogglesProps): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      {GRANTS.map((grant) => (
        <label
          key={grant.key}
          className={`flex items-start gap-2 text-xs text-[#d4d4d4] ${disabled ? 'opacity-60' : ''}`}
        >
          <input
            type="checkbox"
            data-testid={`${testIdPrefix}-${grant.key}`}
            checked={grants[grant.key]}
            disabled={disabled}
            onChange={() => onToggle(grant.key)}
            className="mt-0.5"
          />
          <span>
            <span>{grant.label}</span>
            <span
              data-testid={grant.risk ? `${testIdPrefix}-${grant.key}-risk` : undefined}
              className={`block ${grant.risk ? 'text-[#e5c07b]' : 'text-[#6b7280]'}`}
            >
              {grant.hint}
            </span>
          </span>
        </label>
      ))}
    </div>
  )
}
