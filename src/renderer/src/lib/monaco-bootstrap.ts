// Side-effect bootstrap: wires the real monaco-editor module + Vite-bundled
// worker into configureMonaco. Imported once from main.tsx at app boot,
// before any <Editor> renders. Kept separate from monaco-setup.ts so the
// pure configure function can be unit-tested under jsdom without dragging in
// editor.main.js (which calls document.queryCommandSupported, navigator.clipboard,
// etc. — APIs jsdom doesn't implement).

import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
// Vite-specific `?worker` suffix — bundles editor.worker.js into a CSP-safe
// blob: worker. Type comes from vite/client.
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import { configureMonaco } from './monaco-setup'

configureMonaco({ loader, monaco, WorkerCtor: EditorWorker as unknown as new () => Worker })
