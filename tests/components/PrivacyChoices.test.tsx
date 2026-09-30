import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  PrivacyChoices,
  readWireProxy,
  writeWireProxy,
} from '../../src/renderer/src/components/Onboarding/PrivacyChoices'

function bridge(over: Record<string, unknown> = {}) {
  const api = {
    tokenSavingsGetSettings: vi.fn(async () => ({ success: true, data: { wireProxy: true } })),
    tokenSavingsSetSettings: vi.fn(async (p: { wireProxy: boolean }) => ({ success: true, data: { wireProxy: p.wireProxy } })),
    ...over,
  }
  ;(window as any).termpolis = api
  return api
}

function renderChoices(over: Partial<React.ComponentProps<typeof PrivacyChoices>> = {}) {
  const props = {
    crash: false,
    usage: false,
    onCrashChange: vi.fn(),
    onUsageChange: vi.fn(),
    slotTestId: 'test-slot',
    ...over,
  }
  render(<PrivacyChoices {...props} />)
  return props
}

const proxySwitch = () => screen.getByTestId('privacy-proxy-toggle') as HTMLInputElement

beforeEach(() => { delete (window as any).termpolis })
afterEach(() => { delete (window as any).termpolis })

describe('readWireProxy', () => {
  it('returns the setting main holds', async () => {
    bridge()
    expect(await readWireProxy()).toBe(true)
    bridge({ tokenSavingsGetSettings: vi.fn(async () => ({ success: true, data: { wireProxy: false } })) })
    expect(await readWireProxy()).toBe(false)
  })

  it('returns null when main refuses or the bridge is missing', async () => {
    bridge({ tokenSavingsGetSettings: vi.fn(async () => ({ success: false, error: 'nope' })) })
    expect(await readWireProxy()).toBeNull()
    delete (window as any).termpolis
    expect(await readWireProxy()).toBeNull()
  })
})

describe('writeWireProxy', () => {
  it('sends only wireProxy and returns what main now holds', async () => {
    const api = bridge()
    expect(await writeWireProxy(false)).toBe(false)
    expect(api.tokenSavingsSetSettings).toHaveBeenCalledWith({ wireProxy: false })
    expect(await writeWireProxy(true)).toBe(true)
  })

  it('returns null when main refuses or the bridge is missing', async () => {
    bridge({ tokenSavingsSetSettings: vi.fn(async () => ({ success: false, error: 'nope' })) })
    expect(await writeWireProxy(true)).toBeNull()
    delete (window as any).termpolis
    expect(await writeWireProxy(true)).toBeNull()
  })
})

describe('PrivacyChoices', () => {
  it('shows both tiers as the caller holds them, with their plain-language copy', () => {
    renderChoices({ crash: true, usage: false })
    const crash = screen.getByRole('checkbox', { name: 'Send crash reports' }) as HTMLInputElement
    const usage = screen.getByRole('checkbox', { name: 'Send anonymous usage statistics' }) as HTMLInputElement
    expect(crash.checked).toBe(true)
    expect(usage.checked).toBe(false)
    expect(screen.getByText(/stack trace/)).toBeInTheDocument()
    expect(screen.getByText(/user name and home-folder paths removed/)).toBeInTheDocument()
    expect(screen.getByText(/Once a day.*only the Termpolis version/)).toBeInTheDocument()
  })

  it('reports each tick to the caller', () => {
    const props = renderChoices()
    fireEvent.click(screen.getByTestId('privacy-crash-toggle'))
    expect(props.onCrashChange).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByTestId('privacy-usage-toggle'))
    expect(props.onUsageChange).toHaveBeenCalledWith(true)
  })

  it('discloses the proxy: local, what it trims, where it forwards, when it steps aside', () => {
    renderChoices()
    const text = screen.getByTestId('privacy-proxy').textContent ?? ''
    expect(text).toMatch(/on by default/)
    expect(text).toMatch(/127\.0\.0\.1/)
    expect(text).toMatch(/tool-result text/)
    expect(text).toMatch(/pasted images/)
    expect(text).toMatch(/api\.anthropic\.com and nowhere else/)
    expect(text).toMatch(/ANTHROPIC_BASE_URL/)
    expect(text).toMatch(/HTTP\(S\) proxy/)
    expect(text).toMatch(/Bedrock, Vertex or Foundry/)
    expect(text).toMatch(/Settings → Token Savings/)
  })

  it('renders the slot under the caller’s test id, with any children', () => {
    render(
      <PrivacyChoices crash={false} usage={false} onCrashChange={() => {}} onUsageChange={() => {}} slotTestId="my-slot">
        <span>inside</span>
      </PrivacyChoices>,
    )
    expect(screen.getByTestId('my-slot')).toHaveTextContent('inside')
  })

  it('keeps the proxy switch disabled until main answers, then shows its setting', async () => {
    let answer!: (v: unknown) => void
    bridge({ tokenSavingsGetSettings: vi.fn(() => new Promise(r => { answer = r })) })
    renderChoices()
    expect(proxySwitch().disabled).toBe(true)
    expect(proxySwitch().checked).toBe(true)
    await act(async () => { answer({ success: true, data: { wireProxy: false } }) })
    expect(proxySwitch().disabled).toBe(false)
    expect(proxySwitch().checked).toBe(false)
    expect(proxySwitch()).toHaveAttribute('aria-checked', 'false')
  })

  it('stays disabled when main can’t be asked', async () => {
    renderChoices()
    await act(async () => {})
    expect(proxySwitch().disabled).toBe(true)
  })

  it('applies a flip at once and shows what main now holds', async () => {
    const api = bridge()
    renderChoices()
    await waitFor(() => expect(proxySwitch().disabled).toBe(false))
    expect(proxySwitch().checked).toBe(true)
    fireEvent.click(proxySwitch())
    await waitFor(() => expect(proxySwitch().checked).toBe(false))
    expect(api.tokenSavingsSetSettings).toHaveBeenCalledWith({ wireProxy: false })
    fireEvent.click(proxySwitch())
    await waitFor(() => expect(proxySwitch().checked).toBe(true))
    expect(api.tokenSavingsSetSettings).toHaveBeenLastCalledWith({ wireProxy: true })
  })

  it('leaves the switch where it was when main refuses the flip', async () => {
    const api = bridge({ tokenSavingsSetSettings: vi.fn(async () => ({ success: false, error: 'nope' })) })
    renderChoices()
    await waitFor(() => expect(proxySwitch().disabled).toBe(false))
    await act(async () => { fireEvent.click(proxySwitch()) })
    expect(api.tokenSavingsSetSettings).toHaveBeenCalledTimes(1)
    expect(proxySwitch().checked).toBe(true)
  })
})
