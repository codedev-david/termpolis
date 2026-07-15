import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import './assets/fonts/fonts.css'
import '@fortawesome/fontawesome-free/css/all.min.css'
// monaco-bootstrap is NOT imported here any more — it pulled ~8.8 MB of monaco-editor into the eager
// entry chunk, blocking first paint, even though the only <Editor> lives in the lazy SettingsPane.
// It is now chained into that lazy import (see App.tsx), so monaco loads only when Settings opens.
import { initSentry } from './lib/sentry'
import { ErrorBoundary } from './components/ErrorBoundary/ErrorBoundary'
import App from './App'

// Initialize crash reporting (requires VITE_SENTRY_DSN env var)
initSentry()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
