import React from 'react'

interface Task {
  id: string
  title: string
  status: string
  result?: string
}

interface SwarmCompleteDialogProps {
  message: string
  tasks: Task[]
  onViewDashboard: () => void
  onDismiss: () => void
}

export function SwarmCompleteDialog({ message, tasks, onViewDashboard, onDismiss }: SwarmCompleteDialogProps) {
  const completed = tasks.filter(t => t.status === 'completed')
  const failed = tasks.filter(t => t.status === 'failed')
  const hasTasks = tasks.length > 0

  // Strip "SWARM COMPLETE:" prefix if present for display
  const displayMessage = message.replace(/^SWARM COMPLETE:\s*/i, '').trim()

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70" onClick={onDismiss}>
      <div
        className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-xl shadow-2xl w-[560px] max-w-[90vw] max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-4 flex items-start gap-4">
          <div className="w-12 h-12 rounded-full bg-[#22c55e]/15 flex items-center justify-center shrink-0">
            <i className="fa-solid fa-circle-check text-[#22c55e] text-xl"></i>
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-[#d4d4d4] mb-1">Swarm Complete</h2>
            {hasTasks ? (
              <div className="flex items-center gap-3 text-xs">
                {completed.length > 0 && (
                  <span className="flex items-center gap-1 text-[#22c55e]">
                    <i className="fa-solid fa-check text-[10px]"></i>
                    {completed.length} task{completed.length !== 1 ? 's' : ''} completed
                  </span>
                )}
                {failed.length > 0 && (
                  <span className="flex items-center gap-1 text-[#f87171]">
                    <i className="fa-solid fa-xmark text-[10px]"></i>
                    {failed.length} failed
                  </span>
                )}
              </div>
            ) : (
              <p className="text-xs text-[#9ca3af]">The swarm has finished its work</p>
            )}
          </div>
          <button
            onClick={onDismiss}
            className="text-[#9ca3af] hover:text-white px-1.5 py-1 rounded hover:bg-[#37373d] shrink-0"
          >
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>

        {/* Summary message */}
        {displayMessage && (
          <div className="mx-6 mb-3 px-3 py-2.5 bg-[#252526] border border-[#3c3c3c] rounded-lg">
            <p className="text-xs text-[#d4d4d4] leading-relaxed">{displayMessage}</p>
          </div>
        )}

        {/* Task list */}
        {hasTasks && (
          <div className="flex-1 overflow-y-auto px-6 pb-2 space-y-1.5">
            {completed.map(task => (
              <div key={task.id} className="flex items-start gap-2.5 p-2.5 rounded-lg bg-[#1a2e1a] border border-[#2d5a2d]">
                <i className="fa-solid fa-check text-[#22c55e] text-[10px] mt-0.5 shrink-0"></i>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-[#d4d4d4] truncate">{task.title}</p>
                  {task.result && (
                    <p className="text-[11px] text-[#6b9e6b] mt-0.5 leading-relaxed line-clamp-2">{task.result}</p>
                  )}
                </div>
              </div>
            ))}
            {failed.map(task => (
              <div key={task.id} className="flex items-start gap-2.5 p-2.5 rounded-lg bg-[#2e1a1a] border border-[#5a2d2d]">
                <i className="fa-solid fa-xmark text-[#f87171] text-[10px] mt-0.5 shrink-0"></i>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-[#d4d4d4] truncate">{task.title}</p>
                  {task.result && (
                    <p className="text-[11px] text-[#e87070] mt-0.5 leading-relaxed line-clamp-2">{task.result}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Next steps tip */}
        <div className="mx-6 mb-2 px-3 py-2 bg-[#1a1a2e] border border-[#2d2d5a] rounded-lg">
          <p className="text-[11px] text-[#aaaadd] leading-relaxed">
            <i className="fa-solid fa-lightbulb text-[#bbbbed] mr-1"></i>
            <strong className="text-[#d4d4ee]">What next?</strong> Launch an individual AI agent terminal from the <strong className="text-[#d4d4ee]">AI Agents</strong> sidebar to refine the results, have a back-and-forth conversation about changes, or start a new swarm for the next task.
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-[#3c3c3c] mt-2">
          <button
            onClick={onDismiss}
            className="px-3 py-1.5 text-xs text-[#999] hover:text-white rounded hover:bg-[#37373d]"
          >
            Dismiss
          </button>
          <button
            onClick={onViewDashboard}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs rounded font-medium bg-[#22c55e]/15 text-[#22c55e] hover:bg-[#22c55e]/25 border border-[#22c55e]/30"
          >
            <i className="fa-solid fa-network-wired text-[10px]"></i>
            View Dashboard
          </button>
        </div>
      </div>
    </div>
  )
}
