import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// This config is used for standalone vite builds (not electron-vite).
// The electron-vite config is in electron.vite.config.ts
export default defineConfig({
  plugins: [react()]
})
