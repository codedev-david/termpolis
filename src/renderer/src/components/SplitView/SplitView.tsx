import { useCallback } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import { PaneRenderer } from './PaneRenderer'
import type { PaneNode } from '../../types'

function updateRatioAtPath(node: PaneNode, path: number[], ratio: number): PaneNode {
  if (path.length === 0 && node.type === 'split') {
    return { ...node, ratio }
  }
  if (node.type !== 'split') return node
  const [head, ...rest] = path
  const newChildren: [PaneNode, PaneNode] = [...node.children]
  newChildren[head] = updateRatioAtPath(node.children[head], rest, ratio)
  return { ...node, children: newChildren }
}

export function SplitView() {
  const paneTree = useTerminalStore(s => s.paneTree)
  const setPaneTree = useTerminalStore(s => s.setPaneTree)

  const handleSplitRatioChange = useCallback(
    (path: number[], ratio: number) => {
      if (!paneTree) return
      const updated = updateRatioAtPath(paneTree, path, ratio)
      setPaneTree(updated)
    },
    [paneTree, setPaneTree]
  )

  if (!paneTree) {
    return (
      <div className="flex items-center justify-center h-full text-[#9ca3af]">
        <p>No terminals open. Click <strong className="text-[#d4d4d4]">+ Add Terminal</strong> to get started.</p>
      </div>
    )
  }

  return (
    <div className="w-full h-full bg-[#252526] p-1">
      <PaneRenderer
        node={paneTree}
        onSplitRatioChange={handleSplitRatioChange}
      />
    </div>
  )
}
