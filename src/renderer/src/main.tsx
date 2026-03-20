import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import './assets/fonts/fonts.css'
import '@fortawesome/fontawesome-free/css/all.min.css'
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
