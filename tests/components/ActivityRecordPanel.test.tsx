import React from 'react'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ActivityRecordPanel } from '../../src/renderer/src/components/SettingsPane/ActivityRecordPanel'

// Settings > Memory & Learning > Activity record: how much of "what memory did" this computer holds, and clearing it. The panel
// only asks main for a size and for the clear; it never sees a line of the record.

type Size = { files: number; bytes: number }

let record: Size
let sizeCall: ReturnType<typeof vi.fn>
let clearCall: ReturnType<typeof vi.fn>

function mockApi(initial: Size = { files: 2, bytes: 1_572_864 }, clear: () => { removed: number; failed: number } = () => ({ removed: 2, failed: 0 })) {
  record = initial
  sizeCall = vi.fn(async () => ({ success: true, data: record }))
  clearCall = vi.fn(async () => {
    const res = clear()
    if (res.failed === 0) record = { files: 0, bytes: 0 }
    return { success: true, data: res }
  })
  ;(window as any).termpolis = { memoryAuditSize: sizeCall, memoryClearAudit: clearCall }
}

beforeEach(() => { mockApi() })
afterEach(() => { cleanup(); delete (window as any).termpolis; vi.restoreAllMocks() })

const flush = () => act(async () => { await Promise.resolve() })
const open = async (props: { refreshToken?: number } = {}) => {
  render(<ActivityRecordPanel {...props} />)
  await flush(); await flush()
}
const status = () => screen.getByTestId('activity-record-status').textContent ?? ''
const text = () => (screen.getByTestId('activity-record-panel').textContent ?? '').replace(/\s+/g, ' ')

describe('ActivityRecordPanel: what is shown', () => {
  it('says what the record holds, what it never holds, and that it stays on this computer', async () => {
    await open()
    const t = text()
    expect(t).toContain('Activity record')
    expect(t).toContain('what memory did')
    expect(t).toContain('counts, ids, kinds and the name of the agent')
    expect(t).toContain('never what was asked')
    expect(t).toContain('stays on this computer')
    expect(t).toContain('about 2 MB')
  })

  it('says how much of it there is', async () => {
    await open()
    expect(status()).toContain('2 files')
    expect(status()).toContain('1.5 MB')
  })

  it.each([
    [{ files: 1, bytes: 0 }, '1 file', '0 bytes'],
    [{ files: 1, bytes: 1 }, '1 file', '1 byte'],
    [{ files: 1, bytes: 1023 }, '1 file', '1023 bytes'],
    [{ files: 3, bytes: 1024 }, '3 files', '1.0 KB'],
    [{ files: 3, bytes: 1024 * 1023 }, '3 files', '1023.0 KB'],
    [{ files: 4, bytes: 1024 * 1024 - 1 }, '4 files', '1.0 MB'], // not "1024.0 KB"
    [{ files: 4, bytes: 1024 * 1024 }, '4 files', '1.0 MB'],
  ])('writes %j as "%s, %s"', async (size, files, amount) => {
    mockApi(size)
    await open()
    expect(status()).toContain(files)
    expect(status()).toContain(amount)
  })

  it('says plainly that nothing is recorded, and offers nothing to clear', async () => {
    mockApi({ files: 0, bytes: 0 })
    await open()
    expect(status()).toContain('Nothing recorded')
    expect(screen.getByTestId('activity-record-clear').getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(screen.getByTestId('activity-record-clear'))
    expect(screen.queryByTestId('activity-record-confirm')).toBeNull() // a click on it is ignored
  })

  it('reads on open and on Refresh, never on a timer', async () => {
    vi.useFakeTimers()
    try {
      const view = render(<ActivityRecordPanel refreshToken={0} />)
      await flush(); await flush()
      expect(sizeCall).toHaveBeenCalledTimes(1)
      await act(async () => { vi.advanceTimersByTime(10 * 60_000) })
      expect(sizeCall).toHaveBeenCalledTimes(1)
      view.rerender(<ActivityRecordPanel refreshToken={1} />)
      await flush(); await flush()
      expect(sizeCall).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ActivityRecordPanel: clearing it', () => {
  it('asks first, says what it does and does not do, and puts focus on the safe choice', async () => {
    await open()
    fireEvent.click(screen.getByTestId('activity-record-clear'))
    const confirm = screen.getByTestId('activity-record-confirm')
    expect(confirm.textContent).toContain('Forget what memory has recorded about its own work?')
    expect(confirm.textContent).toContain('No memory is removed')
    expect(clearCall).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByTestId('activity-record-cancel'))
  })

  it('Cancel changes nothing and gives focus back to the button that opened it', async () => {
    await open()
    fireEvent.click(screen.getByTestId('activity-record-clear'))
    fireEvent.click(screen.getByTestId('activity-record-cancel'))
    expect(screen.queryByTestId('activity-record-confirm')).toBeNull()
    expect(clearCall).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByTestId('activity-record-clear'))
  })

  it('Escape closes the question without clearing', async () => {
    await open()
    fireEvent.click(screen.getByTestId('activity-record-clear'))
    fireEvent.keyDown(screen.getByTestId('activity-record-cancel'), { key: 'Escape' })
    expect(screen.queryByTestId('activity-record-confirm')).toBeNull()
    expect(clearCall).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByTestId('activity-record-clear'))
  })

  it('any other key leaves the question open', async () => {
    await open()
    fireEvent.click(screen.getByTestId('activity-record-clear'))
    fireEvent.keyDown(screen.getByTestId('activity-record-cancel'), { key: 'a' })
    expect(screen.getByTestId('activity-record-confirm')).toBeTruthy()
  })

  it('clears, says so, reads the size again and keeps focus on the button', async () => {
    await open()
    fireEvent.click(screen.getByTestId('activity-record-clear'))
    await act(async () => { fireEvent.click(screen.getByTestId('activity-record-confirm-yes')) })
    await flush(); await flush()
    expect(clearCall).toHaveBeenCalledTimes(1)
    const notice = screen.getByTestId('activity-record-notice')
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toContain('Cleared')
    expect(notice.textContent).toContain('Memory itself is untouched')
    expect(status()).toContain('Nothing recorded')
    expect(sizeCall).toHaveBeenCalledTimes(2)
    expect(document.activeElement).toBe(screen.getByTestId('activity-record-clear'))
  })

  it('says when a file could not be removed, and that trying again is all it takes', async () => {
    mockApi({ files: 2, bytes: 4096 }, () => ({ removed: 1, failed: 1 }))
    await open()
    fireEvent.click(screen.getByTestId('activity-record-clear'))
    await act(async () => { fireEvent.click(screen.getByTestId('activity-record-confirm-yes')) })
    await flush(); await flush()
    const notice = screen.getByTestId('activity-record-notice').textContent ?? ''
    expect(notice).toContain('1 file could not be removed')
    expect(notice).toContain('try again')
    expect(status()).toContain('2 files') // the size was read again, and the file is still there
  })

  it('disables its buttons while the clear runs, so that a second click cannot arrive', async () => {
    let release: () => void = () => {}
    clearCall.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ success: true, data: { removed: 2, failed: 0 } }) }))
    await open()
    fireEvent.click(screen.getByTestId('activity-record-clear'))
    fireEvent.click(screen.getByTestId('activity-record-confirm-yes'))
    await flush()
    expect(screen.getByTestId('activity-record-clear').getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(screen.getByTestId('activity-record-clear'))
    expect(screen.queryByTestId('activity-record-confirm')).toBeNull()
    await act(async () => { release() })
    await flush(); await flush()
    expect(clearCall).toHaveBeenCalledTimes(1)
  })

  it('shows an error that main sent, and leaves the size as it was', async () => {
    clearCall.mockResolvedValueOnce({ success: false, error: 'no userData' })
    await open()
    fireEvent.click(screen.getByTestId('activity-record-clear'))
    await act(async () => { fireEvent.click(screen.getByTestId('activity-record-confirm-yes')) })
    await flush()
    const alert = screen.getByTestId('activity-record-action-error')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toBe('no userData')
    expect(status()).toContain('2 files')
  })

  it('shows a message of its own when main sends none, or the call throws', async () => {
    clearCall.mockResolvedValueOnce({ success: false })
    await open()
    fireEvent.click(screen.getByTestId('activity-record-clear'))
    await act(async () => { fireEvent.click(screen.getByTestId('activity-record-confirm-yes')) })
    await flush()
    expect(screen.getByTestId('activity-record-action-error').textContent).toBe('Could not clear the activity record')
    clearCall.mockRejectedValueOnce(new Error('ipc closed'))
    fireEvent.click(screen.getByTestId('activity-record-clear'))
    await act(async () => { fireEvent.click(screen.getByTestId('activity-record-confirm-yes')) })
    await flush()
    expect(screen.getByTestId('activity-record-action-error').textContent).toBe('ipc closed')
    clearCall.mockRejectedValueOnce(new Error(''))
    fireEvent.click(screen.getByTestId('activity-record-clear'))
    await act(async () => { fireEvent.click(screen.getByTestId('activity-record-confirm-yes')) })
    await flush()
    expect(screen.getByTestId('activity-record-action-error').textContent).toBe('Could not clear the activity record')
  })

  it('a later clear wipes the earlier message', async () => {
    clearCall.mockResolvedValueOnce({ success: false, error: 'first' })
    await open()
    fireEvent.click(screen.getByTestId('activity-record-clear'))
    await act(async () => { fireEvent.click(screen.getByTestId('activity-record-confirm-yes')) })
    await flush()
    expect(screen.getByTestId('activity-record-action-error').textContent).toBe('first')
    fireEvent.click(screen.getByTestId('activity-record-clear'))
    await act(async () => { fireEvent.click(screen.getByTestId('activity-record-confirm-yes')) })
    await flush(); await flush()
    expect(screen.queryByTestId('activity-record-action-error')).toBeNull()
    expect(screen.getByTestId('activity-record-notice').textContent).toContain('Cleared')
  })

  it('does nothing to a panel that has gone away before the answer came', async () => {
    let release: () => void = () => {}
    clearCall.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ success: true, data: { removed: 2, failed: 0 } }) }))
    const view = render(<ActivityRecordPanel />)
    await flush(); await flush()
    fireEvent.click(screen.getByTestId('activity-record-clear'))
    fireEvent.click(screen.getByTestId('activity-record-confirm-yes'))
    await flush()
    view.unmount()
    await act(async () => { release() })
    await flush()
    expect(sizeCall).toHaveBeenCalledTimes(1) // it did not read the size again for a panel nobody sees
  })
})

describe('ActivityRecordPanel: when it cannot read the record', () => {
  it('says so with an alert when main sends an error', async () => {
    sizeCall.mockResolvedValue({ success: false, error: 'no userData' })
    await open()
    const alert = screen.getByTestId('activity-record-error')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toBe('no userData')
  })

  it('has a message of its own when main sends none, when the call throws, or when the bridge is not there', async () => {
    sizeCall.mockResolvedValue({ success: false })
    await open()
    expect(screen.getByTestId('activity-record-error').textContent).toBe('Could not read the activity record')
    cleanup()
    sizeCall.mockRejectedValue(new Error('ipc closed'))
    await open()
    expect(screen.getByTestId('activity-record-error').textContent).toBe('ipc closed')
    cleanup()
    sizeCall.mockRejectedValue(new Error(''))
    await open()
    expect(screen.getByTestId('activity-record-error').textContent).toBe('Could not read the activity record')
    cleanup()
    delete (window as any).termpolis
    await open()
    expect(screen.getByTestId('activity-record-error').textContent).toBe('Could not read the activity record')
  })

  it('does not set state for a panel that has gone away before the answer came', async () => {
    let release: () => void = () => {}
    sizeCall.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ success: true, data: { files: 1, bytes: 10 } }) }))
    const view = render(<ActivityRecordPanel />)
    await flush()
    view.unmount()
    await act(async () => { release() })
    sizeCall.mockImplementationOnce(() => new Promise((_resolve, reject) => { release = () => reject(new Error('late')) }))
    const second = render(<ActivityRecordPanel />)
    await flush()
    second.unmount()
    await act(async () => { release() })
    expect(document.body.textContent).toBe('')
  })

  it('shows a loading line until the first answer', async () => {
    sizeCall.mockImplementationOnce(() => new Promise(() => {}))
    render(<ActivityRecordPanel />)
    await flush()
    expect(screen.getByTestId('activity-record-loading').textContent).toContain('Reading')
  })
})
