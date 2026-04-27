import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SwarmReviewPanel } from '../../src/renderer/src/components/SwarmReview/SwarmReviewPanel'

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
@@ -5 +5 @@
-drop
+insert
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
index 0000000..333
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,2 @@
+hello
+world
`

const termpolis = {
  gitDiffRange: vi.fn(),
  gitApplyPatch: vi.fn(),
  gitCheckoutFile: vi.fn(),
  gitResetHard: vi.fn(),
  gitCommitAll: vi.fn(),
  swarmRunCommand: vi.fn(),
  readConfigFile: vi.fn(),
}

beforeEach(() => {
  Object.values(termpolis).forEach(fn => fn.mockReset())
  ;(window as any).termpolis = termpolis
  termpolis.gitDiffRange.mockResolvedValue({ success: true, data: DIFF })
  termpolis.gitApplyPatch.mockResolvedValue({ success: true })
  termpolis.gitCheckoutFile.mockResolvedValue({ success: true })
  termpolis.gitResetHard.mockResolvedValue({ success: true })
  termpolis.gitCommitAll.mockResolvedValue({ success: true })
  termpolis.swarmRunCommand.mockResolvedValue({ success: true, data: { output: 'passed', exitCode: 0 } })
  termpolis.readConfigFile.mockResolvedValue({ success: true, data: JSON.stringify({ scripts: { test: 'vitest' } }) })
})

async function renderPanel(overrides: Record<string, any> = {}) {
  const props = {
    preSwarmSha: 'abc1234567',
    cwd: '/repo',
    taskDescription: 'Add feature',
    onClose: vi.fn(),
    onCommitted: vi.fn(),
    ...overrides,
  }
  const utils = render(<SwarmReviewPanel {...props} />)
  await waitFor(() => expect(termpolis.gitDiffRange).toHaveBeenCalled())
  await waitFor(() => expect(screen.getByTestId('review-summary')).toHaveTextContent(/2 files/))
  return { ...utils, props }
}

describe('SwarmReviewPanel', () => {
  it('renders header with short SHA', async () => {
    await renderPanel()
    expect(screen.getByText('Swarm Review')).toBeInTheDocument()
    expect(screen.getByText('abc1234')).toBeInTheDocument()
  })

  it('loads the diff range with the preSwarmSha', async () => {
    await renderPanel()
    expect(termpolis.gitDiffRange).toHaveBeenCalledWith('/repo', 'abc1234567')
  })

  it('lists every changed file', async () => {
    await renderPanel()
    expect(screen.getByTestId('review-file-src/a.ts')).toBeInTheDocument()
    expect(screen.getByTestId('review-file-src/b.ts')).toBeInTheDocument()
  })

  it('shows the add/remove totals', async () => {
    await renderPanel()
    const summary = screen.getByTestId('review-summary')
    expect(summary).toHaveTextContent('+4')
    expect(summary).toHaveTextContent('-2')
    expect(summary).toHaveTextContent(/3 hunks/)
  })

  it('selects the first file by default', async () => {
    await renderPanel()
    expect(screen.getByTestId('review-diff-viewer')).toHaveTextContent('src/a.ts')
  })

  it('switches selected file when a tree entry is clicked', async () => {
    await renderPanel()
    fireEvent.click(screen.getByTestId('review-file-src/b.ts'))
    expect(screen.getByTestId('review-diff-viewer')).toHaveTextContent('src/b.ts')
  })

  it('marks all hunks accepted via Accept all', async () => {
    await renderPanel()
    fireEvent.click(screen.getByTestId('review-accept-all'))
    expect(screen.getByTestId('review-progress')).toHaveTextContent('3 accepted')
  })

  it('marks all hunks rejected via Reject all', async () => {
    await renderPanel()
    fireEvent.click(screen.getByTestId('review-reject-all'))
    expect(screen.getByTestId('review-progress')).toHaveTextContent('3 rejected')
  })

  it('runs the test command and shows passing status', async () => {
    await renderPanel()
    fireEvent.click(screen.getByTestId('review-run-tests'))
    await waitFor(() => expect(termpolis.swarmRunCommand).toHaveBeenCalled())
    expect(await screen.findByText('✓ passing')).toBeInTheDocument()
  })

  it('shows failing status when tests exit non-zero', async () => {
    termpolis.swarmRunCommand.mockResolvedValue({ success: true, data: { output: 'boom', exitCode: 1 } })
    await renderPanel()
    fireEvent.click(screen.getByTestId('review-run-tests'))
    expect(await screen.findByText('✗ failing')).toBeInTheDocument()
  })

  it('disables commit button after a failing test run', async () => {
    termpolis.swarmRunCommand.mockResolvedValue({ success: true, data: { output: 'boom', exitCode: 1 } })
    await renderPanel()
    fireEvent.click(screen.getByTestId('review-run-tests'))
    await screen.findByText('✗ failing')
    expect(screen.getByTestId('review-commit')).toBeDisabled()
  })

  it('commits accepted changes (no rejects means no apply calls)', async () => {
    await renderPanel()
    fireEvent.change(screen.getByTestId('review-commit-msg'), { target: { value: 'ship it' } })
    fireEvent.click(screen.getByTestId('review-commit'))
    await waitFor(() => expect(termpolis.gitCommitAll).toHaveBeenCalledWith('/repo', 'ship it'))
    expect(termpolis.gitApplyPatch).not.toHaveBeenCalled()
  })

  it('reverse-applies rejected hunks before committing', async () => {
    await renderPanel()
    fireEvent.click(screen.getByTestId('review-reject-all'))
    fireEvent.change(screen.getByTestId('review-commit-msg'), { target: { value: 'partial' } })
    fireEvent.click(screen.getByTestId('review-commit'))
    await waitFor(() => expect(termpolis.gitCommitAll).toHaveBeenCalled())
    expect(termpolis.gitApplyPatch).toHaveBeenCalled()
    // Should have been called once per rejected hunk (3 hunks total)
    expect(termpolis.gitApplyPatch.mock.calls.length).toBe(3)
    // Reverse flag must be true
    expect(termpolis.gitApplyPatch.mock.calls[0][2]).toBe(true)
  })

  it('surfaces commit failure', async () => {
    termpolis.gitCommitAll.mockResolvedValue({ success: false, error: 'nothing to commit' })
    await renderPanel()
    fireEvent.change(screen.getByTestId('review-commit-msg'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('review-commit'))
    expect(await screen.findByTestId('review-action-msg')).toHaveTextContent(/nothing to commit/)
  })

  it('requires a commit message', async () => {
    await renderPanel()
    fireEvent.change(screen.getByTestId('review-commit-msg'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('review-commit'))
    expect(await screen.findByTestId('review-action-msg')).toHaveTextContent(/required/)
    expect(termpolis.gitCommitAll).not.toHaveBeenCalled()
  })

  it('Revert all requires confirmation and then hard-resets', async () => {
    await renderPanel()
    fireEvent.click(screen.getByTestId('review-revert-all'))
    fireEvent.click(screen.getByTestId('review-revert-all-confirm'))
    await waitFor(() => expect(termpolis.gitResetHard).toHaveBeenCalledWith('/repo', 'abc1234567'))
  })

  it('Revert all surfaces errors', async () => {
    termpolis.gitResetHard.mockResolvedValue({ success: false, error: 'dirty tree' })
    await renderPanel()
    fireEvent.click(screen.getByTestId('review-revert-all'))
    fireEvent.click(screen.getByTestId('review-revert-all-confirm'))
    expect(await screen.findByTestId('review-action-msg')).toHaveTextContent(/dirty tree/)
  })

  it('Reject entire file calls gitCheckoutFile', async () => {
    await renderPanel()
    fireEvent.click(screen.getByText('Reject entire file'))
    await waitFor(() => expect(termpolis.gitCheckoutFile).toHaveBeenCalledWith('/repo', 'abc1234567', ['src/a.ts']))
  })

  it('surfaces IPC error on reject-file', async () => {
    termpolis.gitCheckoutFile.mockResolvedValue({ success: false, error: 'merge conflict' })
    await renderPanel()
    fireEvent.click(screen.getByText('Reject entire file'))
    expect(await screen.findByTestId('review-action-msg')).toHaveTextContent(/merge conflict/)
  })

  it('reports hunk apply failure', async () => {
    termpolis.gitApplyPatch.mockResolvedValue({ success: false, error: 'does not apply' })
    await renderPanel()
    fireEvent.click(screen.getByTestId('review-reject-all'))
    fireEvent.change(screen.getByTestId('review-commit-msg'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('review-commit'))
    expect(await screen.findByTestId('review-action-msg')).toHaveTextContent(/does not apply/)
    expect(termpolis.gitCommitAll).not.toHaveBeenCalled()
  })

  it('handles empty diff gracefully', async () => {
    termpolis.gitDiffRange.mockResolvedValue({ success: true, data: '' })
    const props = {
      preSwarmSha: 'abc1234567', cwd: '/repo', onClose: vi.fn(),
    }
    render(<SwarmReviewPanel {...props} />)
    await waitFor(() => expect(screen.getByText(/No changes detected/)).toBeInTheDocument())
    expect(screen.getByTestId('review-commit')).toBeDisabled()
  })

  it('surfaces load error', async () => {
    termpolis.gitDiffRange.mockResolvedValue({ success: false, error: 'not a repo' })
    const props = { preSwarmSha: 'abc1234567', cwd: '/repo', onClose: vi.fn() }
    render(<SwarmReviewPanel {...props} />)
    await waitFor(() => expect(screen.getByText(/not a repo/)).toBeInTheDocument())
  })

  it('refuses to run tests with empty command', async () => {
    await renderPanel()
    fireEvent.change(screen.getByTestId('review-test-cmd'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('review-run-tests'))
    expect(await screen.findByTestId('review-action-msg')).toHaveTextContent(/Enter a test command/)
  })

  it('calls onClose on backdrop click', async () => {
    const { props } = await renderPanel()
    const backdrop = screen.getByTestId('swarm-review-panel')
    fireEvent.click(backdrop)
    expect(props.onClose).toHaveBeenCalled()
  })

  it('fires onCommitted after successful commit', async () => {
    const { props } = await renderPanel()
    fireEvent.change(screen.getByTestId('review-commit-msg'), { target: { value: 'final' } })
    fireEvent.click(screen.getByTestId('review-commit'))
    await waitFor(() => expect(props.onCommitted).toHaveBeenCalledWith('final'))
  })

  // -- Refine-with-new-swarm flow --

  it('hides the refine input when no onRefineWithSwarm handler is provided', async () => {
    await renderPanel()
    expect(screen.queryByTestId('review-refine-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('review-refine-btn')).not.toBeInTheDocument()
  })

  it('shows the refine input when onRefineWithSwarm is provided', async () => {
    await renderPanel({ onRefineWithSwarm: vi.fn() })
    expect(screen.getByTestId('review-refine-input')).toBeInTheDocument()
    expect(screen.getByTestId('review-refine-btn')).toBeInTheDocument()
  })

  it('disables the refine button until the user types something', async () => {
    await renderPanel({ onRefineWithSwarm: vi.fn() })
    expect(screen.getByTestId('review-refine-btn')).toBeDisabled()
    fireEvent.change(screen.getByTestId('review-refine-input'), { target: { value: 'tighten the prompt' } })
    expect(screen.getByTestId('review-refine-btn')).toBeEnabled()
  })

  it('does not fire onRefineWithSwarm for whitespace-only input', async () => {
    const onRefine = vi.fn()
    await renderPanel({ onRefineWithSwarm: onRefine })
    fireEvent.change(screen.getByTestId('review-refine-input'), { target: { value: '   \n  ' } })
    fireEvent.click(screen.getByTestId('review-refine-btn'))
    expect(onRefine).not.toHaveBeenCalled()
  })

  it('fires onRefineWithSwarm with the trimmed refinement text on click', async () => {
    const onRefine = vi.fn()
    await renderPanel({ onRefineWithSwarm: onRefine })
    fireEvent.change(screen.getByTestId('review-refine-input'), { target: { value: '  fix the type errors  ' } })
    fireEvent.click(screen.getByTestId('review-refine-btn'))
    expect(onRefine).toHaveBeenCalledWith('fix the type errors')
  })
})
