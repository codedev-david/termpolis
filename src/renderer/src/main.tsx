import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import './assets/fonts/fonts.css'
import '@fortawesome/fontawesome-free/css/all.min.css'
// monaco-bootstrap is NOT imported here any more — it pulled ~8.8 MB of monaco-editor into the eager
// entry chunk, blocking first paint, even though the only <Editor> lives in the lazy SettingsPane.
// It is now chained into that lazy import (see App.tsx), so monaco loads only when Settings opens.
import { initSentry, syncConsentFromMain } from './lib/sentry'
import { installRendererLogBridge, type ConsoleLike } from './lib/rendererLogBridge'
import { ErrorBoundary } from './components/ErrorBoundary/ErrorBoundary'
import App from './App'
import { seedAutoDefault } from './lib/autoModel'
import { applyRouterSettings } from './lib/messageRoute'

// Mirror this side's console into the app log BEFORE anything else runs, so a failure
// during the very first render still ends up somewhere a user can read it (Ctrl+Shift+O).
// Sentry only sees crashes, and only with crash reports on and a DSN configured; this sees
// everything and never leaves the machine.
installRendererLogBridge(
  console as unknown as ConsoleLike,
  (level, message) => window.termpolis?.writeAppLog?.(level, message),
  { errorSource: window },
)

// Crash reporting starts from the consent last mirrored here, so the first render is covered;
// then main, which owns the consent, confirms it (and turns reporting off if it changed).
initSentry()
void syncConsentFromMain()
// v1.55.0: a fresh install starts Claude on Auto; an existing one is told once that Auto exists.
seedAutoDefault()
// v1.56.0: tell main which Claude terminals get a model per message (Settings › Default Models).
applyRouterSettings()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
