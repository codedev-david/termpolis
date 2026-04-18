import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ErrorBoundary } from '../../src/renderer/src/components/ErrorBoundary/ErrorBoundary'

// Suppress React error boundary console output during tests
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

let throwOnNext = true
function ThrowingChild({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow && throwOnNext) throw new Error('Test explosion')
  return <div>Child rendered OK</div>
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    throwOnNext = true
  })

  it('renders children when no error occurs', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={false} />
      </ErrorBoundary>
    )
    expect(screen.getByText('Child rendered OK')).toBeInTheDocument()
  })

  it('shows fallback UI when a child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    )
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(screen.queryByText('Child rendered OK')).not.toBeInTheDocument()
  })

  it('shows recovery buttons in error state', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    )
    expect(screen.getByText('Try to recover')).toBeInTheDocument()
    expect(screen.getByText('Reload app')).toBeInTheDocument()
  })

  it('shows error message in details', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    )
    expect(screen.getByText('Error details')).toBeInTheDocument()
    expect(screen.getByText(/Test explosion/)).toBeInTheDocument()
  })

  it('recovers when Try to recover button is clicked', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    )
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()

    // Stop throwing so recovery succeeds
    throwOnNext = false
    fireEvent.click(screen.getByText('Try to recover'))
    expect(screen.getByText('Child rendered OK')).toBeInTheDocument()
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument()
  })

  it('calls window.location.reload when Reload app is clicked', () => {
    // Mock window.location.reload
    const reloadMock = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadMock },
      writable: true,
    })

    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    )
    fireEvent.click(screen.getByText('Reload app'))
    expect(reloadMock).toHaveBeenCalled()
  })

  it('shows GitHub Issues link in error state', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    )
    expect(screen.getByText('GitHub Issues')).toBeInTheDocument()
  })

  it('opens GitHub Issues URL in new window when clicked', () => {
    window.open = vi.fn()
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    )
    fireEvent.click(screen.getByText('GitHub Issues'))
    expect(window.open).toHaveBeenCalledWith('https://github.com/codedev-david/termpolis/issues', '_blank')
  })

  it('displays reassuring message about running terminals', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    )
    expect(screen.getByText(/terminals are still running/)).toBeInTheDocument()
  })
})
