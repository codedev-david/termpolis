import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import './assets/fonts/fonts.css'
import '@fortawesome/fontawesome-free/css/all.min.css'
// monaco-bootstrap is NOT imported here any more — it pulled ~8.8 MB of monaco-editor into the eager
// entry chunk, blocking first paint, even though the only <Editor> lives in the lazy SettingsPane.
// It is now chained into that lazy import (see App.tsx), so monaco loads only when Settings opens.
import { initSentry } from './lib/sentry'
import { installRendererLogBridge, type ConsoleLike } from './lib/rendererLogBridge'
import { ErrorBoundary } from './components/ErrorBoundary/ErrorBoundary'
import App from './App'

// Mirror this side's console into the app log BEFORE anything else runs, so a failure
// during the very first render still ends up somewhere a user can read it (Ctrl+Shift+O).
// Sentry only sees crashes and only when a DSN is configured; this sees everything and
// never leaves the machine.
installRendererLogBridge(
  console as unknown as ConsoleLike,
  (level, message) => window.termpolis?.writeAppLog?.(level, message),
  { errorSource: window },
)

// Initialize crash reporting (requires VITE_SENTRY_DSN env var)
initSentry()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
