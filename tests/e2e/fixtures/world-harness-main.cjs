// Electron main for e2e/world-engine.spec.ts: one window on world-harness.html, which drives the
// standalone dist-world/world-viewer.js bundle. Software GL (SwiftShader) so a CI runner with no
// GPU still gets a WebGL context.
const { app, BrowserWindow } = require('electron')
const path = require('path')

app.commandLine.appendSwitch('use-angle', 'swiftshader')
app.commandLine.appendSwitch('enable-unsafe-swiftshader')
app.commandLine.appendSwitch('ignore-gpu-blocklist')

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#010409',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  void win.loadFile(path.join(__dirname, 'world-harness.html'))
})

app.on('window-all-closed', () => app.quit())
