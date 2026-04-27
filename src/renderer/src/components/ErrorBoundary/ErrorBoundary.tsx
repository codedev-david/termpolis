import { Component, type ErrorInfo, type ReactNode } from 'react'
import * as Sentry from '@sentry/react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Termpolis ErrorBoundary caught:', error, info.componentStack)
    // Forward to Sentry if DSN is configured; no-op otherwise.
    try {
      Sentry.captureException(error, {
        contexts: { react: { componentStack: info.componentStack } },
      })
    } catch {
      // Sentry not initialized or offline — already logged to console above.
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen bg-[#1e1e1e] text-[#d4d4d4] p-8">
          <div className="bg-[#252526] rounded-lg p-8 max-w-lg w-full border border-[#3c3c3c] flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <i className="fa-solid fa-triangle-exclamation text-2xl text-[#EF9A9A]"></i>
              <h1 className="text-lg font-semibold">Something went wrong</h1>
            </div>
            <p className="text-sm text-[#999]">
              Termpolis encountered an unexpected error. Your terminals are still running
              in the background — no data has been lost.
            </p>
            <details className="text-xs text-[#999]">
              <summary className="cursor-pointer text-[#999] hover:text-white">Error details</summary>
              <pre className="mt-2 p-3 bg-[#1e1e1e] rounded overflow-auto max-h-40 border border-[#3c3c3c]">
                {this.state.error?.message}
                {'\n\n'}
                {this.state.error?.stack}
              </pre>
            </details>
            <div className="flex gap-3 mt-2">
              <button
                onClick={() => this.setState({ hasError: false, error: null })}
                className="px-4 py-2 text-sm rounded bg-[#0078d4] hover:bg-[#106ebe] text-white"
              >
                Try to recover
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 text-sm rounded bg-[#3c3c3c] hover:bg-[#4c4c4c] text-[#d4d4d4]"
              >
                Reload app
              </button>
            </div>
            <p className="text-xs text-[#888]">
              If this keeps happening, please report it at{' '}
              <a
                href="https://github.com/codedev-david/termpolis/issues"
                onClick={e => { e.preventDefault(); window.open('https://github.com/codedev-david/termpolis/issues', '_blank') }}
                className="text-[#22D3EE] hover:underline"
              >
                GitHub Issues
              </a>
            </p>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
