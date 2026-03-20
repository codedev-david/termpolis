import React from 'react'

interface Props {
  previousAgent: string
  onSwitchTo: (agent: string) => void
  onDismiss: () => void
}

const SWITCH_TARGETS = [
  { name: 'Codex', icon: 'fa-solid fa-microchip', command: 'codex' },
  { name: 'Gemini', icon: 'fa-brands fa-google', command: 'gemini' },
  { name: 'Claude Code', icon: 'fa-solid fa-robot', command: 'claude' },
  { name: 'Aider', icon: 'fa-solid fa-code', command: 'aider' },
]

export const AgentHandoffBanner = React.memo(function AgentHandoffBanner({ previousAgent, onSwitchTo, onDismiss }: Props) {
  // Filter out the agent that just hit its limit
  const targets = SWITCH_TARGETS.filter(
    t => t.name.toLowerCase() !== previousAgent.toLowerCase()
  )

  return (
    <div
      className="absolute bottom-0 left-0 right-0 z-40 flex items-center justify-between px-3 py-2 text-xs"
      style={{
        backgroundColor: '#78350f',
        borderTop: '1px solid #a16207',
      }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <i className="fa-solid fa-triangle-exclamation shrink-0" style={{ color: '#fbbf24' }}></i>
        <span style={{ color: '#fde68a' }}>
          {previousAgent} context limit reached
        </span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0 ml-3">
        {targets.map(target => (
          <button
            key={target.name}
            className="px-2 py-0.5 rounded text-[11px] cursor-pointer border-none"
            style={{
              backgroundColor: '#92400e',
              color: '#fde68a',
            }}
            onMouseEnter={e => { (e.target as HTMLElement).style.backgroundColor = '#b45309' }}
            onMouseLeave={e => { (e.target as HTMLElement).style.backgroundColor = '#92400e' }}
            onClick={() => onSwitchTo(target.command)}
          >
            <i className={`${target.icon} mr-1`}></i>
            {target.name}
          </button>
        ))}
        <button
          className="px-2 py-0.5 rounded text-[11px] cursor-pointer border-none"
          style={{
            backgroundColor: 'transparent',
            color: '#d97706',
          }}
          onMouseEnter={e => { (e.target as HTMLElement).style.color = '#fbbf24' }}
          onMouseLeave={e => { (e.target as HTMLElement).style.color = '#d97706' }}
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  )
})
